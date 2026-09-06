import { promptNodeClient, type PromptNodeClient, type TextSkillMode } from "../../lib/backend";
import { remotionRendererClient, type RemotionRendererClient } from "../../lib/remotionRenderer";
import { formatWorkflowError } from "../../lib/workflowErrors";
import { sameWorkflowSignature, stableJsonSignature } from "../../lib/workflowSignatures";
import { parseComicDramaReview } from "./comicDramaWorkflowRunner";
import {
  validateWorkflowMaterials,
  validateWorkflowMaterialsResume,
  withWorkflowMaterials,
  workflowMaterialsSignature,
} from "./workflowMaterials";
import {
  ANIMATION_TEMPLATES,
  createRemotionCheckpoint,
  type AnimationElement,
  type AnimationPlan,
  type RemotionWorkflowCheckpoint,
} from "./remotionWorkflowModel";
import {
  CANVAS_ID,
  createKnowledgeVideoWorkflowConfig,
  isTextGenerationModel,
  type KnowledgeVideoWorkflowCheckpoint,
} from "./workspaceModel";
import type {
  KnowledgeVideoWorkflowRunRequest,
  KnowledgeVideoWorkflowRunner,
} from "./knowledgeVideoWorkflowRunner";

const record = (value: unknown): Record<string, unknown> => {
  if (value == null || typeof value !== "object" || Array.isArray(value))
    throw new Error("动画计划必须是 JSON 对象。");
  return value as Record<string, unknown>;
};
function text(value: unknown, field: string, maximum: number, optional = false): string {
  if (optional && value == null) return "";
  if (typeof value !== "string" || (!optional && !value.trim()) || [...value].length > maximum)
    throw new Error(`${field} 必须为${optional ? "不超过" : "非空且不超过"}${maximum}字的文本。`);
  return value.trim();
}
function number(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
  integer = false,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum ||
    (integer && !Number.isInteger(value))
  )
    throw new Error(`${field} 必须在 ${minimum}～${maximum} 范围内${integer ? "且为整数" : ""}。`);
  return value;
}
function array(value: unknown, field: string, minimum: number, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum)
    throw new Error(`${field} 必须包含 ${minimum}～${maximum} 项。`);
  return value;
}
function keys(item: Record<string, unknown>, allowed: readonly string[]) {
  const extra = Object.keys(item).filter((key) => !allowed.includes(key));
  if (extra.length)
    throw new Error(`动画计划包含未定义字段：${extra.join("、")}。只允许声明式数据。`);
}
export function parseAnimationPlan(value: unknown): AnimationPlan {
  const item = record(value);
  keys(item, [
    "schemaVersion",
    "template",
    "title",
    "subtitle",
    "width",
    "height",
    "fps",
    "durationInFrames",
    "background",
    "palette",
    "elements",
    "connections",
    "staggerFrames",
    "holdFrames",
    "springDamping",
  ]);
  if (
    item["schemaVersion"] !== "animation-plan.v1" ||
    typeof item["template"] !== "string" ||
    !Object.hasOwn(ANIMATION_TEMPLATES, item["template"])
  )
    throw new Error("动画计划版本或模板无效。");
  const template = item["template"] as AnimationPlan["template"];
  const width = number(item["width"], "width", 320, 1920, true),
    height = number(item["height"], "height", 320, 1920, true);
  if (width % 2 || height % 2 || item["fps"] !== 30)
    throw new Error("动画尺寸必须为偶数，fps 固定为 30。");
  const durationInFrames = number(item["durationInFrames"], "durationInFrames", 90, 900, true);
  const staggerFrames = number(item["staggerFrames"], "staggerFrames", 1, 60, true),
    holdFrames = number(item["holdFrames"], "holdFrames", 60, durationInFrames - 1, true);
  const color = (value: unknown) => {
    if (typeof value !== "string" || !/^#[\da-f]{6}$/i.test(value))
      throw new Error("动画色值必须为 #RRGGBB。");
    return value;
  };
  const elements: AnimationElement[] = array(item["elements"], "elements", 1, 12).map((value) => {
    const element = record(value);
    keys(element, ["id", "label", "detail", "value", "group", "x", "y", "width", "height"]);
    const id = text(element["id"], "id", 48);
    if (!/^[A-Za-z0-9_-]+$/.test(id))
      throw new Error("元素 ID 只允许英文字母、数字、下划线和连字符。");
    const coordinates: Partial<Pick<AnimationElement, "x" | "y" | "width" | "height">> = {};
    if (
      template === "custom" ||
      ["x", "y", "width", "height"].some((key) => element[key] != null)
    ) {
      const x = number(element["x"], "x", 0, width),
        y = number(element["y"], "y", 0, height);
      const boxWidth = number(element["width"], "element.width", 40, width),
        boxHeight = number(element["height"], "element.height", 40, height);
      if (x + boxWidth > width || y + boxHeight > height)
        throw new Error("自定义元素矩形超出画布。");
      Object.assign(coordinates, { x, y, width: boxWidth, height: boxHeight });
    }
    return {
      id,
      label: text(element["label"], "label", 40),
      ...(element["detail"] == null
        ? {}
        : { detail: text(element["detail"], "detail", 240, true) }),
      ...(element["group"] == null ? {} : { group: text(element["group"], "group", 40, true) }),
      ...(element["value"] == null
        ? {}
        : { value: number(element["value"], "value", 0, Number.MAX_VALUE) }),
      ...coordinates,
    };
  });
  if (new Set(elements.map((element) => element.id)).size !== elements.length)
    throw new Error("动画元素 ID 重复。");
  if ((elements.length - 1) * staggerFrames + 30 + holdFrames > durationInFrames)
    throw new Error("最后元素入场后必须保留至少 60 帧静止，请缩短入场间隔。");
  if (
    template === "pie-chart" &&
    (elements.some((element) => element.value == null) ||
      !Number.isFinite(elements.reduce((sum, element) => sum + (element.value ?? 0), 0)) ||
      elements.reduce((sum, element) => sum + (element.value ?? 0), 0) <= 0)
  )
    throw new Error("饼图需要真实非负数值且合计大于零。");
  const connections = array(item["connections"], "connections", 0, 24).map((value) => {
    const connection = record(value);
    keys(connection, ["from", "to", "label"]);
    const from = text(connection["from"], "from", 48),
      to = text(connection["to"], "to", 48);
    if (
      from === to ||
      !elements.some((element) => element.id === from) ||
      !elements.some((element) => element.id === to)
    )
      throw new Error("动画连接必须引用两个不同且已存在的元素。");
    return {
      from,
      to,
      ...(connection["label"] == null
        ? {}
        : { label: text(connection["label"], "connection.label", 40, true) }),
    };
  });
  if (new Set(connections.map(({ from, to }) => `${from}\0${to}`)).size !== connections.length)
    throw new Error("动画连接不能重复引用同一对起点与终点。");
  return {
    schemaVersion: "animation-plan.v1",
    template,
    title: text(item["title"], "title", 60),
    ...(item["subtitle"] == null
      ? {}
      : { subtitle: text(item["subtitle"], "subtitle", 160, true) }),
    width,
    height,
    fps: 30,
    durationInFrames,
    background: color(item["background"]),
    palette: array(item["palette"], "palette", 1, 8).map(color),
    elements,
    connections,
    staggerFrames,
    holdFrames,
    springDamping: number(item["springDamping"], "springDamping", 8, 200, true),
  };
}
export function parseRemotionResponse(raw: string): {
  readonly plan: AnimationPlan | null;
  readonly matchReason: string;
  readonly decision: KnowledgeVideoWorkflowCheckpoint["decision"];
} {
  const data = record(
    JSON.parse(
      raw
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, ""),
    ) as unknown,
  );
  keys(data, ["schemaVersion", "status", "matchReason", "decision", "plan"]);
  if (data["schemaVersion"] !== "remotion-workflow.v1") throw new Error("动画工作流协议无效。");
  const matchReason = text(data["matchReason"], "matchReason", 2000);
  if (data["status"] === "needs_confirmation") {
    if (data["plan"] != null) throw new Error("待确认计划不能同时标记为可渲染。");
    const decision = record(data["decision"]);
    return {
      plan: null,
      matchReason,
      decision: {
        kind: "planning",
        question: text(decision["question"], "question", 2000),
        recommendation: text(decision["recommendation"], "recommendation", 3000),
      },
    };
  }
  if (data["status"] !== "ready" || data["decision"] != null)
    throw new Error("ready 计划不能保留未确认决定。");
  return { plan: parseAnimationPlan(data["plan"]), matchReason, decision: null };
}

function inputSignature(request: KnowledgeVideoWorkflowRunRequest) {
  return stableJsonSignature({
    brief: request.node.config.brief,
    options: request.node.config.remotion,
  });
}
interface Dependencies {
  readonly promptClient: PromptNodeClient;
  readonly renderer: RemotionRendererClient;
  readonly now: () => number;
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
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
  });
export function createRemotionWorkflowRunner(
  overrides: Partial<Dependencies> = {},
): KnowledgeVideoWorkflowRunner {
  const baseDependencies = {
    promptClient: promptNodeClient,
    renderer: remotionRendererClient,
    now: Date.now,
    sleep,
    ...overrides,
  };
  return {
    async run(request) {
      const dependencies = {
        ...baseDependencies,
        promptClient: withWorkflowMaterials(baseDependencies.promptClient, request.node.config),
      };
      const { node, signal, onCheckpoint, onProgress } = request;
      let checkpoint = node.config.checkpoint;
      const commit = (change: Partial<KnowledgeVideoWorkflowCheckpoint>) => {
        checkpoint = { ...checkpoint, ...change, updatedAt: dependencies.now() };
        onCheckpoint(checkpoint);
      };
      const state = () => checkpoint.remotion ?? createRemotionCheckpoint();
      const update = (change: Partial<RemotionWorkflowCheckpoint>) =>
        commit({ remotion: { ...state(), ...change } });
      const abort = () => {
        if (signal.aborted) throw new DOMException("已暂停", "AbortError");
      };
      const progress = (
        phase: KnowledgeVideoWorkflowCheckpoint["phase"],
        amount: number,
        message: string,
        error: string | null = null,
      ) => onProgress({ phase, progress: amount, message, error });
      try {
        abort();
        const options = node.config.remotion;
        if (!options || !node.config.brief.trim()) throw new Error("请填写动画描述或 ASCII 草图。");
        const model = request.providerCatalog
          .find(
            (entry) =>
              entry.provider.enabled && entry.provider.id === node.config.models.text.providerId,
          )
          ?.models.find(
            (entry) =>
              entry.definitionId === node.config.models.text.modelDefinitionId &&
              isTextGenerationModel(entry),
          );
        if (!model) throw new Error("请在节点内选择项目可用的文本模型。");
        number(options.durationSeconds, "时长", 3, 30, true);
        number(options.width, "宽度", 320, 1920, true);
        number(options.height, "高度", 320, 1920, true);
        if (
          options.width % 2 ||
          options.height % 2 ||
          !["morandi", "light", "dark"].includes(options.theme)
        )
          throw new Error("动画尺寸必须为偶数，主题必须是可用的内置主题。");
        number(node.config.maxAutomaticRetries, "自动修订次数", 0, 10, true);
        if (
          !["gif", "mp4", "both"].includes(options.format) ||
          (options.template !== "auto" && !Object.hasOwn(ANIMATION_TEMPLATES, options.template))
        )
          throw new Error("动画模板或导出格式无效。");
        const startsNew =
          !request.resume ||
          !checkpoint.runId ||
          checkpoint.phase === "idle" ||
          checkpoint.phase === "done";
        validateWorkflowMaterials(node.config);
        if (!startsNew) validateWorkflowMaterialsResume(node.config, checkpoint);
        if (!startsNew && !sameWorkflowSignature(state().inputSignature, inputSignature(request)))
          throw new Error("动画描述或设置已修改，请按当前资料重新制作。");
        if (startsNew) {
          if (state().renderJob?.status === "running")
            await dependencies.renderer.cancel(state().renderJob!.id);
          const history = [
            ...state().history,
            ...(state().plan ? [{ plan: state().plan!, review: state().review }] : []),
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
            runId: crypto.randomUUID(),
            materialsSignature: workflowMaterialsSignature(node.config),
            phase: "planning",
            lastActivePhase: "planning",
            remotion: {
              ...createRemotionCheckpoint(),
              inputSignature: inputSignature(request),
              history,
            },
          });
        }
        progress("planning", 3, "正在检查本地动画渲染环境…");
        const environment = await dependencies.renderer.preflight();
        abort();
        if (!environment.ready) throw new Error(environment.message);
        const call = async <T>(
          mode: TextSkillMode,
          prompt: string,
          parse: (raw: string) => T,
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
              userPrompt: `${prompt}${failure ? `\n上次返回无法执行：${failure}。请修正完整数据，不能让用户处理字段错误。` : ""}`,
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
        const suppliedResolution = request.decisionResolution?.trim();
        let resolution = checkpoint.decision
          ? suppliedResolution
            ? suppliedResolution
            : checkpoint.decision.recommendation
          : undefined;
        if (checkpoint.decision && resolution) {
          const decision = `${checkpoint.decision.question}\n用户决定：${resolution}`;
          update({
            confirmedDecisions: [...new Set([...(state().confirmedDecisions ?? []), decision])],
          });
        }
        const base = () =>
          `用户动画描述或 ASCII 草图：\n${node.config.brief}\n制作设置：${stableJsonSignature(options)}\n已确认的补充资料与决定（规划和检查都必须依据）：${JSON.stringify(state().confirmedDecisions ?? [])}\n可用模板：${JSON.stringify(ANIMATION_TEMPLATES)}\n必须保持width=${options.width},height=${options.height},fps=30,durationInFrames=${options.durationSeconds * 30}。默认模板优先，普通布局自行决定。只输出声明式计划，不执行代码。`;
        let generate = state().plan == null;
        while (!state().plan || state().review?.result !== "PASS") {
          abort();
          commit({ phase: "planning", lastActivePhase: "planning", error: null });
          if (generate) {
            progress(
              "planning",
              12,
              state().plan ? "正在按检查意见修订动画…" : "正在匹配模板并编排动画…",
            );
            const response = await call(
              "remotion_planner",
              `${base()}\n${state().plan ? `待修订方案：${stableJsonSignature(state().plan)}\n检查意见：${stableJsonSignature(state().review)}` : "首次制作。"}\n${resolution ? `用户已确认的决定，必须实际应用：${resolution}` : ""}`,
              (raw) => {
                const parsed = parseRemotionResponse(raw);
                if (
                  parsed.plan &&
                  (parsed.plan.width !== options.width ||
                    parsed.plan.height !== options.height ||
                    parsed.plan.durationInFrames !== options.durationSeconds * 30 ||
                    (options.template !== "auto" && parsed.plan.template !== options.template))
                )
                  throw new Error("计划必须保持用户选择的模板、尺寸和时长。");
                return parsed;
              },
            );
            if (response.decision) {
              update({ matchReason: response.matchReason });
              commit({ phase: "awaiting_approval", decision: response.decision });
              progress("awaiting_approval", 18, response.decision.question);
              return checkpoint;
            }
            update({
              plan: response.plan,
              matchReason: response.matchReason,
              review: null,
              history: [
                ...state().history,
                ...(state().plan ? [{ plan: state().plan!, review: state().review }] : []),
              ],
            });
            commit({
              decision: null,
              planRevision: checkpoint.planRevision + 1,
              manifest: JSON.stringify(response.plan),
              script: node.config.brief,
            });
            resolution = undefined;
          }
          if (!state().review) {
            progress("planning", 24, "正在检查内容、连接方向与动画时序…");
            const review = await call(
              "remotion_review",
              `${base()}\n模板选择理由：${state().matchReason}\n完整动画计划：${stableJsonSignature(state().plan)}`,
              parseComicDramaReview,
            );
            update({ review });
          }
          const review = state().review!;
          if (review.result === "PASS") break;
          if (
            !resolution &&
            (review.result === "NEEDS_DECISION" ||
              state().repairCount >= Math.max(0, node.config.maxAutomaticRetries))
          ) {
            const decision = {
              kind: "planning" as const,
              question: review.question ?? "动画方案达到自动修订上限，是否继续按检查意见修订？",
              recommendation: review.recommendation ?? review.repairInstructions ?? review.report,
            };
            commit({ phase: "awaiting_approval", decision });
            progress("awaiting_approval", 25, decision.question);
            return checkpoint;
          }
          update({ repairCount: resolution ? 0 : state().repairCount + 1 });
          generate = true;
        }
        const plan = parseAnimationPlan(state().plan);
        commit({
          phase: "generating",
          lastActivePhase: "generating",
          approvedPlanRevision: checkpoint.planRevision,
          decision: null,
          error: null,
        });
        const completeDelivery = (job: NonNullable<RemotionWorkflowCheckpoint["renderJob"]>) =>
          Boolean(
            job.projectPath &&
            job.previewPath &&
            (!(options.format === "gif" || options.format === "both") || job.gifPath) &&
            (!(options.format === "mp4" || options.format === "both") || job.videoPath),
          );
        let job = state().renderJob;
        let recoveringPreviousJob = Boolean(job);
        if (job) job = await dependencies.renderer.get(job.id);
        abort();
        while (true) {
          if (
            !job ||
            (recoveringPreviousJob &&
              (job.status === "failed" ||
                job.status === "cancelled" ||
                (job.status === "succeeded" && !completeDelivery(job))))
          ) {
            progress("generating", 30, "正在注册动画并启动本地渲染…");
            job = await dependencies.renderer.start({ plan, format: options.format });
            recoveringPreviousJob = false;
            update({ renderJob: job });
          }
          if (job.status !== "running") break;
          abort();
          progress(
            "generating",
            30 + Math.round(job.progress * 0.65),
            job.message || "正在本地渲染动画…",
          );
          await dependencies.sleep(700, signal);
          abort();
          job = await dependencies.renderer.get(job.id);
          update({ renderJob: job });
        }
        abort();
        if (job.status !== "succeeded")
          throw new Error(job.error ? job.error : job.message || "动画渲染未完成。");
        if (!completeDelivery(job)) throw new Error("本地渲染未返回完整交付物，请继续重试渲染。");
        update({ renderJob: job });
        commit({
          phase: "done",
          finalPath: job.gifPath ?? job.videoPath ?? null,
          coverImagePath: job.previewPath ?? null,
          error: null,
        });
        progress("done", 100, "动画、预览与可编辑工程已保存在节点中。");
        return checkpoint;
      } catch (error) {
        const paused = signal.aborted || (error instanceof Error && error.name === "AbortError");
        if (paused && state().renderJob?.status === "running") {
          try {
            await dependencies.renderer.cancel(state().renderJob!.id);
          } catch {
            /* 后端任务仍可用原身份查询与重试取消。 */
          }
        }
        const message = formatWorkflowError(error);
        commit({ phase: paused ? "paused" : "failed", error: paused ? null : message });
        progress(
          paused ? "paused" : "failed",
          0,
          paused ? "已暂停，可从保存的方案继续。" : "动画工作流需要处理。",
          paused ? null : message,
        );
        return checkpoint;
      }
    },
  };
}
