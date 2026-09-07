import {
  validateWorkflowMaterials,
  validateWorkflowMaterialsResume,
  withWorkflowMaterials,
  workflowMaterialsSignature,
} from "./workflowMaterials";
import {
  generationClient,
  promptNodeClient,
  type ConfiguredModel,
  type GenerationResultRecord,
  type GenerationTaskClient,
  type PromptNodeClient,
  type TextSkillMode,
} from "../../lib/backend";
import { coverImageClient } from "../../lib/coverImages";
import { generationParameters, modelParameterCapabilities } from "../../lib/modelCapabilities";
import { formatWorkflowError } from "../../lib/workflowErrors";
import { sameWorkflowSignature, stableJsonSignature } from "../../lib/workflowSignatures";
import type {
  KnowledgeVideoWorkflowRunRequest,
  KnowledgeVideoWorkflowRunner,
} from "./knowledgeVideoWorkflowRunner";
import {
  CANVAS_ID,
  createKnowledgeVideoWorkflowConfig,
  isTextGenerationModel,
  type KnowledgeVideoWorkflowCheckpoint,
} from "./workspaceModel";
import {
  createXhsCoverCheckpoint,
  XHS_COVER_STYLES,
  xhsCoverInputReady,
  type XhsCoverPlan,
  type XhsCoverReview,
  type XhsCoverWorkflowCheckpoint,
} from "./xhsCoverWorkflowModel";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("封面模型输出必须是 JSON 对象。");
  return value as Record<string, unknown>;
}
function json(raw: string) {
  return object(
    JSON.parse(
      raw
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, ""),
    ) as unknown,
  );
}
function text(value: unknown, name: string, optional = false): string {
  if (optional && value == null) return "";
  if (typeof value !== "string" || (!optional && !value.trim()) || value.length > 30000)
    throw new Error(`封面输出字段 ${name} 必须是有效文本。`);
  return value;
}
export function parseXhsCoverPlan(raw: string): XhsCoverPlan {
  const data = json(raw);
  if (
    data["schemaVersion"] !== "xhs-cover-plan.v1" ||
    typeof data["style"] !== "string" ||
    !Object.hasOwn(XHS_COVER_STYLES, data["style"])
  )
    throw new Error("封面方案版本或风格无效。");
  const candidates = data["titleCandidates"];
  if (!Array.isArray(candidates) || candidates.length !== 3)
    throw new Error("封面方案必须保留三个标题候选，并自动选择最合适的一项。");
  const decision = data["decision"] == null ? null : object(data["decision"]);
  return {
    schemaVersion: "xhs-cover-plan.v1",
    style: data["style"] as XhsCoverPlan["style"],
    title: text(data["title"], "title"),
    subtitle: text(data["subtitle"], "subtitle", true),
    titleCandidates: candidates.map((title) => text(title, "titleCandidates")),
    rationale: text(data["rationale"], "rationale"),
    prompt: text(data["prompt"], "prompt"),
    decision: decision
      ? {
          question: text(decision["question"], "decision.question"),
          recommendation: text(decision["recommendation"], "decision.recommendation"),
        }
      : null,
  };
}
export function parseXhsCoverReview(raw: string): XhsCoverReview {
  const data = json(raw),
    result = data["result"];
  if (result !== "PASS" && result !== "REVISE" && result !== "NEEDS_DECISION")
    throw new Error("封面质检结果必须为 PASS、REVISE 或 NEEDS_DECISION。");
  const report = text(data["report"], "report");
  if (result === "PASS") return { result, report };
  if (result === "REVISE")
    return {
      result,
      report,
      repairInstructions: text(data["repairInstructions"], "repairInstructions"),
    };
  return {
    result,
    report,
    question: text(data["question"], "question"),
    recommendation: text(data["recommendation"], "recommendation"),
    ...(data["repairInstructions"] == null
      ? {}
      : { repairInstructions: text(data["repairInstructions"], "repairInstructions") }),
  };
}

interface Dependencies {
  readonly promptClient: PromptNodeClient;
  readonly generationClient: GenerationTaskClient;
  readonly resultRecovery: {
    resume(taskId: string, resultIndex: number): Promise<GenerationResultRecord>;
  };
  readonly normalizer: {
    normalize(command: {
      sourcePath: string;
      outputId: string;
    }): Promise<{ path: string; width: number; height: number }>;
  };
  readonly now: () => number;
  readonly createId: () => string;
  readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}
const sleep: Dependencies["sleep"] = (milliseconds, signal) =>
  new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException("已暂停", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });

function signature(request: KnowledgeVideoWorkflowRunRequest) {
  return stableJsonSignature({
    brief: request.node.config.brief,
    options: request.node.config.xhsCover,
  });
}

/** Pick the closest supported source geometry; local normalization enforces the final 3:4 size. */
function imageParameters(model: ConfiguredModel, request: KnowledgeVideoWorkflowRunRequest) {
  const capabilities = modelParameterCapabilities(
    model.operationSchema,
    "image_to_image",
    model.remoteModelId,
  );
  const parameters = generationParameters(
    capabilities,
    request.node.config.imageParameterValues,
    true,
  );
  for (const capability of capabilities) {
    const key = capability.key.toLowerCase().replaceAll(/[-_]/g, "");
    if (
      !["ratio", "aspectratio", "size", "imagesize"].includes(key) ||
      capability.type !== "string"
    )
      continue;
    const choices = capability.options.flatMap((option) => {
      if (typeof option.value !== "string") return [];
      const match = option.value.match(/^(\d+(?:\.\d+)?)[:x×](\d+(?:\.\d+)?)$/);
      if (!match || Number(match[1]) <= 0 || Number(match[2]) <= 0) return [];
      return [
        {
          value: option.value,
          difference: Math.abs(Math.log(Number(match[1]) / Number(match[2]) / 0.75)),
        },
      ];
    });
    if (choices.length)
      parameters[capability.key] = choices.reduce((best, value) =>
        value.difference < best.difference ? value : best,
      ).value;
    else if (!capability.options.length)
      parameters[capability.key] = key.includes("size") ? "1080x1440" : "3:4";
  }
  if (Object.hasOwn(parameters, "n")) parameters["n"] = 1;
  return parameters;
}

export function createXhsCoverWorkflowRunner(
  overrides: Partial<Dependencies> = {},
): KnowledgeVideoWorkflowRunner {
  const baseDependencies: Dependencies = {
    promptClient: promptNodeClient,
    generationClient,
    resultRecovery: {
      resume: (taskId, resultIndex) => coverImageClient.resumeResult({ taskId, resultIndex }),
    },
    normalizer: coverImageClient,
    now: Date.now,
    createId: () => crypto.randomUUID(),
    sleep,
    ...overrides,
  };
  return {
    async run(request) {
      const dependencies = {
        ...baseDependencies,
        promptClient: withWorkflowMaterials(baseDependencies.promptClient, request.node.config),
      };
      const { node, signal } = request;
      let checkpoint = node.config.checkpoint;
      const commit = (change: Partial<KnowledgeVideoWorkflowCheckpoint>) => {
        checkpoint = { ...checkpoint, ...change, updatedAt: dependencies.now() };
        request.onCheckpoint(checkpoint);
      };
      const state = () => checkpoint.xhsCover ?? createXhsCoverCheckpoint();
      const update = (change: Partial<XhsCoverWorkflowCheckpoint>) =>
        commit({ xhsCover: { ...state(), ...change } });
      const abort = () => {
        if (signal.aborted) throw new DOMException("已暂停", "AbortError");
      };
      const progress = (
        phase: KnowledgeVideoWorkflowCheckpoint["phase"],
        value: number,
        message: string,
        error: string | null = null,
      ) => request.onProgress({ phase, progress: value, message, error });
      try {
        abort();
        const options = node.config.xhsCover;
        if (!options || !xhsCoverInputReady(node.config.brief, options))
          throw new Error(
            "请填写封面主题或标题，并上传 1～3 张同一人物参考图；额外素材最多 5 张，图片合计不能超过 8 MiB，不能重复上传。局部出镜也需要真实参考图。",
          );
        if (
          (options.style !== "auto" && !Object.hasOwn(XHS_COVER_STYLES, options.style)) ||
          ![
            "auto",
            "surprised",
            "thumbs_up",
            "pointing",
            "thoughtful",
            "confident",
            "explaining",
          ].includes(options.expression) ||
          !["auto", "warm", "tech", "tool_wall", "interface", "contrast"].includes(
            options.background,
          ) ||
          !["auto", "bold", "comic", "rounded", "tech", "handwritten"].includes(options.font) ||
          !["yellow", "white", "mixed", "highlight", "dark"].includes(options.color) ||
          !["image", "prompt"].includes(options.deliverable)
        )
          throw new Error("封面制作设置无效，请重新选择。");
        if (
          !Number.isInteger(node.config.maxAutomaticRetries) ||
          node.config.maxAutomaticRetries < 0 ||
          node.config.maxAutomaticRetries > 10
        )
          throw new Error("自动修订次数必须为 0～10。");
        const selectedModel = (kind: "text" | "image") =>
          request.providerCatalog
            .find(
              (entry) =>
                entry.provider.enabled && entry.provider.id === node.config.models[kind].providerId,
            )
            ?.models.find(
              (model) => model.definitionId === node.config.models[kind].modelDefinitionId,
            );
        const textModel = selectedModel("text"),
          imageModel = selectedModel("image");
        if (!textModel || !isTextGenerationModel(textModel))
          throw new Error("请在节点中选择项目可用的策划与视觉审核模型。");
        if (options.deliverable === "image" && !imageModel?.operations.includes("image_to_image"))
          throw new Error(
            "请为封面选择项目内支持参考图的图片模型（图生图）；人物参考必须实际传入图片请求。",
          );
        const startsNew = !request.resume || !checkpoint.runId || checkpoint.phase === "idle";
        validateWorkflowMaterials(node.config);
        if (!startsNew) validateWorkflowMaterialsResume(node.config, checkpoint);
        if (!startsNew && !sameWorkflowSignature(state().inputSignature, signature(request)))
          throw new Error("封面主题、标题或参考图已修改，请按当前资料重新制作，避免沿用旧图。");
        if (startsNew) {
          const history = [
            ...state().history,
            ...(state().plan
              ? [
                  {
                    plan: state().plan!,
                    review: state().review,
                    imagePath: state().imagePath,
                    finalPath: state().finalPath,
                  },
                ]
              : []),
          ];
          commit({
            ...createKnowledgeVideoWorkflowConfig(
              {
                prompt: node.config.models.text,
                image: node.config.models.image,
                video: node.config.models.video,
              },
              node.config.catalogResolved,
            ).checkpoint,
            runId: dependencies.createId(),
            materialsSignature: workflowMaterialsSignature(node.config),
            phase: "planning",
            lastActivePhase: "planning",
            xhsCover: {
              ...createXhsCoverCheckpoint(),
              inputSignature: signature(request),
              history,
            },
          });
        }
        if (checkpoint.phase === "done") {
          progress("done", 100, "已保留完成的封面交付物。");
          return checkpoint;
        }
        const references = [...options.portraits, ...options.materials];
        const referenceMap = references
          .map(
            (reference, index) =>
              `参考图${index + 1}=${index < options.portraits.length ? "同一人物参考" : "额外素材"}（${reference.displayName}）`,
          )
          .join("；");
        const base = () =>
          `用户主题或正文：\n${node.config.brief}\n用户固定标题：${JSON.stringify(options.title)}（非空时逐字保留，空时自动从三个候选中择优）\n制作设置：${stableJsonSignature({ ...options, portraits: undefined, materials: undefined })}\n图片顺序：${referenceMap}\n已确认的决定：${JSON.stringify(state().confirmedDecisions ?? [])}\n风格库：${JSON.stringify(XHS_COVER_STYLES)}\n最终交付必须是3:4竖版小红书封面，1080×1440；人物占画面35%～55%，与真实参考保持一致，所有黄色统一#FDFFA7，中文主标题超粗、清晰并有粗黑描边，脸部与文字处于安全区。材料不可用或人物身份冲突时提出一个必要问题；普通构图和标题择优自行决定。`;
        const call = async <T>(
          mode: TextSkillMode,
          prompt: string,
          parse: (raw: string) => T,
          candidatePath?: string,
        ): Promise<T> => {
          let failure = "";
          for (let attempt = 0; attempt < 2; attempt++) {
            abort();
            const response = await dependencies.promptClient.run({
              canvasId: CANVAS_ID,
              sourceNodeId: node.key,
              providerConnectionId: node.config.models.text.providerId,
              modelDefinitionId: node.config.models.text.modelDefinitionId,
              mode,
              task: "generate",
              userPrompt: `${prompt}${failure ? `\n上次 JSON 无法执行：${failure}。只修正完整结构，不要让用户处理格式错误。` : ""}`,
              multimodalInputs: references,
              ...(candidatePath
                ? {
                    visionImages: [
                      {
                        target: {
                          kind: "local_file" as const,
                          path: candidatePath,
                          mediaType: "image" as const,
                        },
                        displayName: "待验收的最终封面（1080×1440）",
                      },
                    ],
                  }
                : {}),
            });
            abort();
            try {
              return parse(response.optimizedPrompt);
            } catch (error) {
              failure = formatWorkflowError(error);
            }
          }
          throw new Error(failure);
        };
        const pending = checkpoint.decision;
        const suppliedResolution = request.decisionResolution?.trim();
        let resolution = pending
          ? suppliedResolution
            ? suppliedResolution
            : pending.recommendation
          : undefined;
        if (pending && resolution) {
          update({
            confirmedDecisions: [
              ...new Set([
                ...(state().confirmedDecisions ?? []),
                `${pending.question}\n用户决定：${resolution}`,
              ]),
            ],
          });
          // Confirmation always triggers an actual revision and a new visual check; it cannot bypass QC.
          if (state().plan)
            update({
              history: [
                ...state().history,
                {
                  plan: state().plan!,
                  review: state().review,
                  imagePath: state().imagePath,
                  finalPath: state().finalPath,
                },
              ],
              plan: null,
              review: null,
              taskId: null,
              imagePath: null,
              finalPath: null,
              repairCount: 0,
            });
          commit({ decision: null, error: null });
        }
        while (true) {
          abort();
          if (!state().plan) {
            commit({ phase: "planning", lastActivePhase: "planning", error: null });
            progress("planning", 12, "正在选择封面风格、提炼标题并编排画面…");
            const previous = state().history.at(-1);
            const plan = await call(
              "xhs_cover_plan",
              `${base()}\n${previous ? `上一版方案与检查意见：${stableJsonSignature(previous)}` : "首次制作，请自动完成风格与标题选择。"}\n${resolution ? `必须实际应用用户决定：${resolution}` : ""}`,
              (raw) => {
                const parsed = parseXhsCoverPlan(raw);
                if (options.title.trim() && parsed.title !== options.title)
                  throw new Error("主标题必须逐字保留用户固定标题，不能改写或截短。");
                if (options.style !== "auto" && parsed.style !== options.style)
                  throw new Error("必须使用用户选择的封面风格。");
                if (!parsed.prompt.includes(parsed.title))
                  throw new Error("完整图片提示词必须包含逐字主标题。");
                return {
                  ...parsed,
                  prompt: `${parsed.prompt}\n\n【必须遵守】3:4竖版小红书封面，1080×1440。主标题逐字为「${parsed.title}」。所有黄色使用柔和浅黄色 #FDFFA7；粗黑描边，标题最醒目。${referenceMap}。真人身份以人物参考图为准，不凭空更换人物。所有重要文字、人物脸部和清单位于安全区，标题不遮挡眼睛和嘴巴。`,
                };
              },
            );
            update({ plan, review: null });
            commit({
              planRevision: checkpoint.planRevision + 1,
              manifest: JSON.stringify(plan),
              script: plan.prompt,
            });
            if (plan.decision) {
              commit({
                phase: "awaiting_approval",
                decision: { kind: "planning", ...plan.decision },
              });
              progress("awaiting_approval", 20, plan.decision.question);
              return checkpoint;
            }
            resolution = undefined;
          }
          if (options.deliverable === "prompt") {
            commit({
              phase: "done",
              documentsOnly: true,
              approvedPlanRevision: checkpoint.planRevision,
              decision: null,
              error: null,
            });
            progress("done", 100, "已交付封面方案、标题备选与完整提示词。");
            return checkpoint;
          }
          commit({
            phase: "generating",
            lastActivePhase: "generating",
            error: null,
            approvedPlanRevision: checkpoint.planRevision,
          });
          if (!state().imagePath) {
            progress(
              "generating",
              35,
              state().taskId
                ? "正在恢复已有封面生成任务…"
                : "正在将人物与素材参考传入项目图片模型…",
            );
            if (!state().taskId) {
              const taskId = await dependencies.generationClient.start({
                canvasId: CANVAS_ID,
                sourceNodeId: node.key,
                operation: "image_to_image",
                providerConnectionId: node.config.models.image.providerId,
                modelDefinitionId: node.config.models.image.modelDefinitionId,
                prompt: [
                  { kind: "text", text: state().plan!.prompt },
                  ...references.map((reference, index) => ({
                    kind: "media_reference" as const,
                    mentionId: `cover-reference-${index + 1}`,
                    target: {
                      kind: "local_file" as const,
                      path: reference.localPath,
                      mediaType: "image" as const,
                    },
                    displayNameSnapshot: `参考图${index + 1} · ${reference.displayName}`,
                    typePosition: index + 1,
                    contentIndex: index + 1,
                  })),
                ],
                parameters: imageParameters(imageModel!, request),
                generationCount: 1,
              });
              // Persist the remote task identity even if the user paused while submission completed.
              update({ taskId });
            }
            let attemptedSaveRecovery = false;
            for (let poll = 0; poll < 1800; poll++) {
              abort();
              const detail = await dependencies.generationClient.get(state().taskId!);
              const saved = detail.results.find(
                (result) =>
                  result.mediaType === "image" &&
                  result.saveStatus === "succeeded" &&
                  result.finalPath,
              );
              if (saved?.finalPath) {
                update({ imagePath: saved.finalPath });
                break;
              }
              const saveFailure = detail.results.find(
                (result) =>
                  result.mediaType === "image" &&
                  ["failed", "interrupted", "local_missing", "conflict"].includes(
                    result.saveStatus,
                  ),
              );
              if (saveFailure) {
                if (request.resume && !attemptedSaveRecovery) {
                  attemptedSaveRecovery = true;
                  progress("generating", 45, "正在恢复原封面的下载与本地保存…");
                  const recovered = await dependencies.resultRecovery.resume(
                    saveFailure.taskId,
                    saveFailure.resultIndex,
                  );
                  if (recovered.saveStatus === "succeeded" && recovered.finalPath) {
                    update({ imagePath: recovered.finalPath });
                    break;
                  }
                  throw new Error(
                    `封面本地保存恢复失败：${formatWorkflowError(recovered.error ?? recovered.saveStatus)}。原任务已保留，修复保存问题后可再次重试。`,
                  );
                }
                throw new Error(
                  `封面已生成但本地保存失败：${formatWorkflowError(saveFailure.error ?? saveFailure.saveStatus)}。原任务已保留，重试将恢复原图保存，不重新生成。`,
                );
              }
              if (detail.summary.status === "failed") {
                update({ taskId: null });
                throw new Error(
                  `封面生成失败：${formatWorkflowError(detail.finalError ?? detail.summary.status)}`,
                );
              }
              if (["unknown", "interrupted"].includes(detail.summary.status))
                throw new Error(
                  `封面任务状态待确认：${detail.summary.status}。该图片请求没有可恢复的远程查询接口；原任务身份已保留。请先在供应商确认是否已生成，需要重新提交时使用「重新制作」，可能再次计费。`,
                );
              await dependencies.sleep(1000, signal);
            }
            if (!state().imagePath) throw new Error("封面生成等待超时，已保留原任务，可继续查询。");
          }
          abort();
          if (!state().finalPath) {
            progress("generating", 60, "正在保留完整画面并规范为 1080×1440 竖版封面…");
            const normalized = await dependencies.normalizer.normalize({
              sourcePath: state().imagePath!,
              outputId: `${checkpoint.runId}-${checkpoint.planRevision}`,
            });
            if (!normalized.path || normalized.width !== 1080 || normalized.height !== 1440)
              throw new Error("封面尺寸规范化未返回严格 1080×1440 的图片。");
            update({ finalPath: normalized.path });
            commit({ coverImagePath: normalized.path });
          }
          abort();
          if (!state().review) {
            commit({ phase: "qc", lastActivePhase: "qc" });
            progress("qc", 80, "正在对照人物原图、素材与最终封面检查文字和构图…");
            const review = await call(
              "xhs_cover_qc",
              `${base()}\n视觉输入顺序：第1张为待验收的最终封面，之后${references.length}张为原始参考图片（编号仍按制作说明：${referenceMap}）。必须读取实际图片，逐项对照人物身份、所需原素材、主标题逐字正确性、可读性、布局安全区和黄色色号；不能只检查提示词。完整制作方案：${stableJsonSignature(state().plan)}`,
              parseXhsCoverReview,
              state().finalPath!,
            );
            update({ review });
          }
          const review = state().review!;
          if (review.result === "PASS") {
            commit({
              phase: "done",
              finalPath: state().finalPath,
              coverImagePath: state().finalPath,
              decision: null,
              error: null,
            });
            progress("done", 100, "封面图片、完整提示词与质检记录已交付。");
            return checkpoint;
          }
          // 审查不通过时自动返工不再受次数限制；只有必须由用户决策才暂停等待。
          if (review.result === "NEEDS_DECISION") {
            const decision = {
              kind: "qc" as const,
              question: review.question ?? review.report,
              recommendation: review.recommendation ?? review.repairInstructions ?? review.report,
            };
            commit({ phase: "awaiting_approval", lastActivePhase: "qc", decision });
            progress("awaiting_approval", 85, decision.question);
            return checkpoint;
          }
          update({
            history: [
              ...state().history,
              {
                plan: state().plan!,
                review,
                imagePath: state().imagePath,
                finalPath: state().finalPath,
              },
            ],
            repairCount: state().repairCount + 1,
            plan: null,
            review: null,
            taskId: null,
            imagePath: null,
            finalPath: null,
          });
        }
      } catch (error) {
        const paused = signal.aborted || (error instanceof Error && error.name === "AbortError");
        const message = formatWorkflowError(error);
        commit({ phase: paused ? "paused" : "failed", error: paused ? null : message });
        progress(
          paused ? "paused" : "failed",
          0,
          paused ? "已暂停，继续时复用已保存的方案与任务。" : "封面工作流需要处理。",
          paused ? null : message,
        );
        return checkpoint;
      }
    },
  };
}
