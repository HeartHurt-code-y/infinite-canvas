import type { TextSkillMode } from "../../lib/backend";
import { modelParameterCapabilities } from "../../lib/modelCapabilities";
import { formatWorkflowError } from "../../lib/workflowErrors";
import { sameWorkflowSignature, stableJsonSignature } from "../../lib/workflowSignatures";
import { createAiFilmCheckpoint, type AiFilmAsset } from "./aiFilmWorkflowModel";
import {
  COMIC_DRAMA_STAGES,
  COMIC_DRAMA_STAGE_LABELS,
  createComicDramaCheckpoint,
  type ComicDramaArtifact,
  type ComicDramaReview,
  type ComicDramaStage,
  type ComicDramaStageRun,
  type ComicDramaWorkflowCheckpoint,
} from "./comicDramaWorkflowModel";
import {
  createKnowledgeVideoWorkflowRunner,
  type KnowledgeVideoWorkflowRunnerDependencies,
  type KnowledgeVideoWorkflowRunRequest,
  type WorkflowPlan,
  type WorkflowPlanningContext,
} from "./knowledgeVideoWorkflowRunner";
import {
  CANVAS_ID,
  type KnowledgeVideoWorkflowCheckpoint,
  type KnowledgeVideoWorkflowShot,
} from "./workspaceModel";

const GENERATION_MODES: Record<ComicDramaStage, TextSkillMode> = {
  director: "comic_drama_director",
  art: "comic_drama_art",
  storyboard: "comic_drama_storyboard",
};
const REVIEW_MODES: Record<ComicDramaStage, TextSkillMode> = {
  director: "comic_drama_director_review",
  art: "comic_drama_art_review",
  storyboard: "comic_drama_storyboard_review",
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("漫剧模型输出必须是 JSON 对象。");
  return value as Record<string, unknown>;
}
function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`漫剧模型输出缺少 ${field}。`);
  return value.trim();
}
function parseJson(raw: string): Record<string, unknown> {
  return object(
    JSON.parse(
      raw
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, ""),
    ) as unknown,
  );
}
function sameAsset(left: AiFilmAsset, right: AiFilmAsset): boolean {
  return left.kind === right.kind && left.name === right.name && left.prompt === right.prompt;
}

function inputSignature(node: KnowledgeVideoWorkflowRunRequest["node"]): string {
  const options = node.config.comicDrama;
  return stableJsonSignature({
    brief: node.config.brief,
    episodes: options?.episodes,
    visualStyle: options?.visualStyle,
    aspectRatio: options?.aspectRatio,
  });
}

function stagePassed(run: ComicDramaStageRun | undefined): boolean {
  return (
    !!run?.passed &&
    !!run.artifact &&
    run.businessReview?.result === "PASS" &&
    run.contentReview?.result === "PASS"
  );
}

function validateResume(
  request: KnowledgeVideoWorkflowRunRequest,
  checkpoint: KnowledgeVideoWorkflowCheckpoint,
): void {
  const previous = checkpoint.comicDrama?.inputSignature;
  if (previous && !sameWorkflowSignature(previous, inputSignature(request.node)))
    throw new Error("剧集资料已修改，请重新执行以重建受影响的导演分析、服化道和分镜。");
}

interface ComicDramaStageResult {
  readonly content: string;
  readonly inputSummary: string;
  readonly assets: readonly AiFilmAsset[];
  readonly shots: readonly KnowledgeVideoWorkflowShot[];
  readonly decision: KnowledgeVideoWorkflowCheckpoint["decision"];
}

export function parseComicDramaStage(
  raw: string,
  stage: ComicDramaStage,
  episodeId: string,
  knownAssets: readonly AiFilmAsset[],
): ComicDramaStageResult {
  const data = parseJson(raw);
  if (data["schemaVersion"] !== "comic-drama-stage.v1" || data["stage"] !== stage)
    throw new Error("漫剧模型越过当前阶段或返回了错误协议。");
  if (data["status"] === "needs_confirmation") {
    const pending = object(data["decision"]);
    return {
      content: "",
      inputSummary: "",
      assets: [],
      shots: [],
      decision: {
        kind: "planning",
        question: requiredText(pending["question"], "decision.question"),
        recommendation: requiredText(pending["recommendation"], "decision.recommendation"),
      },
    };
  }
  if (data["status"] !== "ready" || data["decision"] != null)
    throw new Error("漫剧 ready 成果不能保留待确认决定。");
  if (!Array.isArray(data["assets"]) || !Array.isArray(data["shots"]))
    throw new Error("每个漫剧阶段必须明确提供 assets 与 shots 数组。");
  if (
    (stage !== "art" && data["assets"].length) ||
    (stage !== "storyboard" && data["shots"].length)
  )
    throw new Error("当前阶段不能擅自生成下游资产或分镜。");
  const assets: AiFilmAsset[] = [];
  if (stage === "art") {
    if (!data["assets"].length || data["assets"].length > 64)
      throw new Error("服化道阶段必须列出本集使用的 1～64 个资产。");
    for (const value of data["assets"]) {
      const item = object(value);
      const id = requiredText(item["id"], "asset.id");
      const kind = item["kind"];
      if (kind !== "character" && kind !== "scene" && kind !== "prop")
        throw new Error("漫剧资产类型无效。");
      if (assets.some((asset) => asset.id === id)) throw new Error("本集资产 ID 重复。");
      const asset: AiFilmAsset = {
        id,
        kind,
        name: requiredText(item["name"], "asset.name"),
        prompt: requiredText(item["prompt"], "asset.prompt"),
      };
      const previous = knownAssets.find((entry) => entry.id === id);
      if (previous && !sameAsset(previous, asset))
        throw new Error(`共享资产 ${id} 的固定描述被改写；造型或状态变体必须使用新 ID。`);
      assets.push(previous ?? asset);
    }
  }
  const shots: KnowledgeVideoWorkflowShot[] = [];
  if (stage === "storyboard") {
    if (!data["shots"].length || data["shots"].length > 120)
      throw new Error("分镜阶段必须提供本集 1～120 个可执行镜头。");
    for (const value of data["shots"]) {
      const item = object(value);
      const id = `${episodeId}:${requiredText(item["id"], "shot.id")}`;
      if (shots.some((shot) => shot.id === id)) throw new Error("本集镜头 ID 重复。");
      const duration = item["durationSeconds"];
      if (
        typeof duration !== "number" ||
        !Number.isFinite(duration) ||
        duration < 1 ||
        duration > 30
      )
        throw new Error("漫剧单镜头时长必须为 1～30 秒。");
      if (!Array.isArray(item["referenceAssetIds"]))
        throw new Error("镜头缺少 referenceAssetIds。");
      const references = item["referenceAssetIds"].map((ref) =>
        requiredText(ref, "referenceAssetId"),
      );
      if (new Set(references).size !== references.length) throw new Error("镜头重复引用同一资产。");
      if (references.some((ref) => !knownAssets.some((asset) => asset.id === ref)))
        throw new Error(`镜头 ${id} 引用了本集服化道未确认的资产。`);
      if (typeof item["dialogue"] !== "string")
        throw new Error("镜头对白必须是字符串，无对白时填空字符串。");
      if (!Array.isArray(item["acceptance"]) || !item["acceptance"].length)
        throw new Error("镜头缺少验收标准。");
      const dialogue = item["dialogue"];
      shots.push({
        id,
        sequence: shots.length + 1,
        section: "FILM",
        track: "FILM",
        title: `${requiredText(item["sceneId"], "sceneId")} · ${requiredText(item["title"], "title")}`,
        durationSeconds: duration,
        visual: requiredText(item["visual"], "visual"),
        narration: dialogue,
        videoPrompt: `${requiredText(item["videoPrompt"], "videoPrompt")}${dialogue ? `\n【逐字对白】${dialogue}` : ""}`,
        referenceAssetIds: references,
        acceptance: item["acceptance"].map((value) => requiredText(value, "acceptance")).join("；"),
      });
    }
  }
  return {
    content: requiredText(data["content"], "content"),
    inputSummary: requiredText(data["inputSummary"], "inputSummary"),
    assets,
    shots,
    decision: null,
  };
}

export function parseComicDramaReview(raw: string): ComicDramaReview {
  const data = parseJson(raw);
  const result = data["result"];
  const report = requiredText(data["report"], "report");
  if (result === "PASS") {
    if (
      data["repairInstructions"] != null ||
      data["question"] != null ||
      data["recommendation"] != null
    )
      throw new Error("PASS 审查不能同时保留修订或待确认决定。");
    return { result, report };
  }
  if (result === "REVISE")
    return {
      result,
      report,
      repairInstructions: requiredText(data["repairInstructions"], "repairInstructions"),
    };
  if (result === "NEEDS_DECISION")
    return {
      result,
      report,
      question: requiredText(data["question"], "question"),
      recommendation: requiredText(data["recommendation"], "recommendation"),
    };
  throw new Error("漫剧审查结果必须为 PASS、REVISE 或 NEEDS_DECISION。");
}

function emptyStage(history: readonly ComicDramaArtifact[] = []): ComicDramaStageRun {
  return {
    artifact: null,
    businessReview: null,
    contentReview: null,
    passed: false,
    repairCount: 0,
    history,
  };
}
function reviewFeedback(run: ComicDramaStageRun): string {
  return (
    [
      ["业务检查", run.businessReview],
      ["内容检查", run.contentReview],
    ] as const
  )
    .filter(([, review]) => review != null)
    .map(
      ([label, review]) =>
        `${label}：${review!.result}\n${review!.report}\n${review!.repairInstructions ?? ""}${review!.question ? `\n问题：${review!.question}\n建议：${review!.recommendation ?? ""}` : ""}`,
    )
    .join("\n\n");
}

async function planComicDrama(context: WorkflowPlanningContext): Promise<WorkflowPlan> {
  const { request, dependencies } = context;
  const { node, signal } = request;
  const options = node.config.comicDrama;
  if (!options) throw new Error("漫剧工作流配置缺失。");
  if (!options.episodes.length || options.episodes.length > 10)
    throw new Error("漫剧工作流一次支持 1～10 集。");
  if (
    options.episodes.some((episode) => !episode.id.trim() || !episode.title.trim()) ||
    new Set(options.episodes.map((episode) => episode.id)).size !== options.episodes.length
  )
    throw new Error("每集必须具有唯一 ID 和非空标题。");
  if (
    !/^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(options.aspectRatio) ||
    options.aspectRatio.split(":").some((part) => Number(part) <= 0)
  )
    throw new Error("漫剧画幅必须是有效的 W:H 比例。");
  const signature = inputSignature(node);
  const getDrama = () => context.checkpoint().comicDrama ?? createComicDramaCheckpoint();
  const updateDrama = (
    update: (drama: ComicDramaWorkflowCheckpoint) => ComicDramaWorkflowCheckpoint,
  ) =>
    context.commit((current) => ({
      ...current,
      comicDrama: update(current.comicDrama ?? createComicDramaCheckpoint()),
    }));
  validateResume(request, context.checkpoint());
  if (!getDrama().inputSignature)
    updateDrama((drama) => ({
      ...drama,
      inputSignature: signature,
      episodes: options.episodes.map((episode) => ({
        ...episode,
        stages: Object.fromEntries(
          COMIC_DRAMA_STAGES.map((stage) => {
            const old = drama.episodes.find((entry) => entry.id === episode.id)?.stages[stage];
            return [stage, emptyStage(old?.history)];
          }),
        ),
      })),
    }));
  const model = request.providerCatalog
    .find((entry) => entry.provider.id === node.config.models.video.providerId)
    ?.models.find((entry) => entry.definitionId === node.config.models.video.modelDefinitionId);
  const capabilities = model
    ? modelParameterCapabilities(model.operationSchema, "video_generation", model.remoteModelId)
    : [];
  const imageModel = request.providerCatalog
    .find((entry) => entry.provider.id === node.config.models.image.providerId)
    ?.models.find((entry) => entry.definitionId === node.config.models.image.modelDefinitionId);
  const imageCapabilities = imageModel
    ? modelParameterCapabilities(
        imageModel.operationSchema,
        "text_to_image",
        imageModel.remoteModelId,
      )
    : [];
  const describeCapabilities = (entries: typeof capabilities) =>
    JSON.stringify(
      entries.map(({ key, options: values, minimum, maximum }) => ({
        key,
        values: values.map((entry) => entry.value),
        minimum,
        maximum,
      })),
    );
  const durationCapability = capabilities.find((entry) => entry.key === "duration");
  const durations =
    durationCapability?.options
      .map((entry) => entry.value)
      .filter((value): value is number => typeof value === "number" && value > 0) ?? [];
  if (!Number.isFinite(node.config.maxAutomaticRetries))
    throw new Error("自动修订次数必须是有限数字。");
  const originalPending = getDrama().pending;
  let resolution = context.resolution?.trim();
  const checkAbort = () => {
    if (signal.aborted) throw new DOMException("Workflow cancelled", "AbortError");
  };
  const callText = async <T>(
    mode: TextSkillMode,
    prompt: string,
    parse: (raw: string) => T,
  ): Promise<T> => {
    let failure = "";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      checkAbort();
      const response = await dependencies.promptClient.run({
        canvasId: CANVAS_ID,
        sourceNodeId: node.key,
        providerConnectionId: node.config.models.text.providerId,
        modelDefinitionId: node.config.models.text.modelDefinitionId,
        mode,
        task: "generate",
        userPrompt: `${prompt}${failure ? `\n上次输出无法执行：${failure}。请修正并输出完整 JSON。` : ""}`,
      });
      checkAbort();
      try {
        return parse(response.optimizedPrompt);
      } catch (error: unknown) {
        failure = formatWorkflowError(error);
      }
    }
    throw new Error(failure);
  };
  const planResult = (decision: KnowledgeVideoWorkflowCheckpoint["decision"]): WorkflowPlan => {
    const drama = getDrama();
    const shots = drama.episodes
      .flatMap((episode) =>
        stagePassed(episode.stages.storyboard)
          ? (episode.stages.storyboard?.artifact?.shots ?? []).map((shot) => ({
              ...shot,
              title: `${episode.title} · ${shot.title}`,
            }))
          : [],
      )
      .map((shot, index) => ({
        ...shot,
        sequence: index + 1,
        videoPrompt: `${shot.videoPrompt}\n【目标画幅】${options.aspectRatio}${shot.referenceAssetIds?.length ? `\n【参考图映射】\n${shot.referenceAssetIds.map((id, referenceIndex) => `图片${referenceIndex + 1} 对应资产 ${id}（${drama.sharedAssets.find((asset) => asset.id === id)?.name ?? id}）。`).join("\n")}\n按以上对应关系保持人物身份、场景空间和道具一致。` : ""}`,
      }));
    return {
      manifest: JSON.stringify({
        schemaVersion: "comic-drama-workflow.manifest.v1",
        project: { title: "漫剧作品", aspectRatio: options.aspectRatio },
        episodes: drama.episodes,
        assets: drama.sharedAssets,
        shots,
      }),
      aspectRatio: options.aspectRatio,
      script: drama.episodes
        .map((episode) => `# ${episode.title}\n\n${episode.script}`)
        .join("\n\n"),
      storyboard: drama.episodes
        .map(
          (episode) =>
            `# ${episode.title}\n\n${episode.stages.storyboard?.artifact?.content ?? ""}`,
        )
        .join("\n\n"),
      shots,
      decision,
      documentsOnly: options.deliverable === "documents",
    };
  };

  for (const [episodeIndex, episode] of getDrama().episodes.entries()) {
    const readStage = (stage: ComicDramaStage) =>
      getDrama().episodes.find((entry) => entry.id === episode.id)!.stages[stage] ?? emptyStage();
    const saveStage = (
      stage: ComicDramaStage,
      update: (run: ComicDramaStageRun) => ComicDramaStageRun,
    ) =>
      updateDrama((drama) => ({
        ...drama,
        episodes: drama.episodes.map((entry) =>
          entry.id === episode.id
            ? {
                ...entry,
                stages: { ...entry.stages, [stage]: update(entry.stages[stage] ?? emptyStage()) },
              }
            : entry,
        ),
      }));
    for (const [stageIndex, stage] of COMIC_DRAMA_STAGES.entries()) {
      if (stagePassed(readStage(stage))) continue;
      const hasConfirmed =
        originalPending?.episodeId === episode.id &&
        originalPending.stage === stage &&
        !!resolution;
      let confirmed = hasConfirmed ? resolution : undefined;
      const stageLabel = `${episode.title} · ${COMIC_DRAMA_STAGE_LABELS[stage]}`;
      const basePrompt = () => {
        const inputs = COMIC_DRAMA_STAGES.slice(0, stageIndex)
          .map((prior) => {
            const run = readStage(prior);
            if (!stagePassed(run) || !run.artifact)
              throw new Error(`当前阶段缺少已通过双重检查的${COMIC_DRAMA_STAGE_LABELS[prior]}。`);
            return `## ${COMIC_DRAMA_STAGE_LABELS[prior]}\n${run.artifact.content}`;
          })
          .join("\n\n");
        const assets =
          stage === "storyboard"
            ? (readStage("art").artifact?.assets ?? [])
            : getDrama().sharedAssets;
        return `当前仅处理剧集：${episode.id}（${episode.title}），阶段：${stage}\n制作要求：${node.config.brief || "依据本集剧本完成制作"}\n视觉风格：${options.visualStyle}\n项目画幅：${options.aspectRatio}\n本集原始剧本（唯一剧情依据）：\n${episode.script || "本集剧本尚未提供；请根据制作要求判断是否需要确认。"}\n本集已确认上游成果：\n${inputs || "无"}\n可用资产（固定描述不得改写，变体用新 ID）：${JSON.stringify(assets.map(({ id, kind, name, prompt }) => ({ id, kind, name, prompt })))}\n当前项目图片模型参数：${describeCapabilities(imageCapabilities)}\n当前项目视频模型参数：${describeCapabilities(capabilities)}\n仅依据当前项目模型能力规划素材与镜头，不套用固定品牌的分辨率、参考图数量或时长限制；未声明的能力不能假定已支持。\n交付方式：${options.deliverable}。制作成片时单镜头时长必须匹配所选模型；需要时拆分连续镜头，逐字保留完整对白。只处理本集当前阶段，不读取或编写其他集的剧情。`;
      };
      let generate =
        !readStage(stage).artifact ||
        (getDrama().pending?.episodeId === episode.id &&
          getDrama().pending?.stage === stage &&
          getDrama().pending?.step === "generation");
      while (!stagePassed(readStage(stage))) {
        checkAbort();
        if (generate) {
          const previous = readStage(stage);
          updateDrama((drama) => ({
            ...drama,
            pending: { episodeId: episode.id, stage, step: "generation" },
          }));
          context.progress({
            phase: "planning",
            progress:
              4 +
              Math.round(((episodeIndex * 3 + stageIndex) / (options.episodes.length * 3)) * 16),
            message: `正在${previous.artifact ? "修订" : "生成"}${stageLabel}…`,
            error: null,
          });
          const result = await callText(
            GENERATION_MODES[stage],
            `${basePrompt()}\n${previous.artifact ? `待修订的完整成果：\n${previous.artifact.content}\n合并修订意见（一次修订同时解决两路问题）：\n${reviewFeedback(previous)}` : "首次生成完整成果。"}\n${confirmed ? `用户已确认的决定，必须真正应用到成果：${confirmed}` : ""}\n只输出当前阶段协议 JSON，常规问题自行处理，仅无法推断的核心剧情选择请求确认。`,
            (raw) => {
              const parsed = parseComicDramaStage(
                raw,
                stage,
                episode.id,
                stage === "storyboard"
                  ? (readStage("art").artifact?.assets ?? [])
                  : getDrama().sharedAssets,
              );
              if (stage === "storyboard" && options.deliverable === "video")
                for (const shot of parsed.shots) {
                  if (
                    (durations.length && !durations.includes(shot.durationSeconds)) ||
                    (durationCapability?.minimum != null &&
                      shot.durationSeconds < durationCapability.minimum) ||
                    (durationCapability?.maximum != null &&
                      shot.durationSeconds > durationCapability.maximum)
                  )
                    throw new Error(
                      `镜头 ${shot.id} 时长不在当前视频模型支持范围内，请按供应商时长拆镜并保留完整对白。`,
                    );
                }
              return parsed;
            },
          );
          if (result.decision) return planResult(result.decision);
          saveStage(stage, (run) => ({
            ...run,
            artifact: {
              content: result.content,
              inputSummary: result.inputSummary,
              assets: result.assets,
              shots: result.shots,
              createdAt: dependencies.now(),
              version:
                Math.max(
                  0,
                  run.artifact?.version ?? 0,
                  ...run.history.map((entry) => entry.version),
                ) + 1,
            },
            history: run.artifact ? [...run.history, run.artifact] : run.history,
            businessReview: null,
            contentReview: null,
            passed: false,
          }));
          updateDrama((drama) => ({
            ...drama,
            pending: { episodeId: episode.id, stage, step: "review" },
          }));
          confirmed = undefined;
          if (hasConfirmed) resolution = undefined;
        }
        const reviewPrompt = () =>
          `${basePrompt()}\n本次需独立检查的完整成果：\n${readStage(stage).artifact!.content}\n结构化资产：${stableJsonSignature(readStage(stage).artifact!.assets)}\n结构化镜头：${stableJsonSignature(readStage(stage).artifact!.shots)}\n独立给出 PASS、REVISE 或 NEEDS_DECISION；不根据另一位检查者的结论投票，不修改成果。`;
        if (!readStage(stage).businessReview) {
          context.progress({
            phase: "planning",
            progress: 18,
            message: `正在检查${stageLabel}的业务要求…`,
            error: null,
          });
          const review = await callText(REVIEW_MODES[stage], reviewPrompt(), parseComicDramaReview);
          saveStage(stage, (run) => ({ ...run, businessReview: review }));
        }
        if (!readStage(stage).contentReview) {
          context.progress({
            phase: "planning",
            progress: 18,
            message: `正在独立检查${stageLabel}的内容质量…`,
            error: null,
          });
          const review = await callText(
            "comic_drama_content_review",
            reviewPrompt(),
            parseComicDramaReview,
          );
          saveStage(stage, (run) => ({ ...run, contentReview: review }));
        }
        const checked = readStage(stage);
        if (checked.businessReview?.result === "PASS" && checked.contentReview?.result === "PASS") {
          saveStage(stage, (run) => ({ ...run, passed: true }));
          updateDrama((drama) => ({
            ...drama,
            pending: null,
            sharedAssets:
              stage === "art"
                ? [
                    ...drama.sharedAssets,
                    ...checked.artifact!.assets.filter(
                      (asset) => !drama.sharedAssets.some((known) => known.id === asset.id),
                    ),
                  ]
                : drama.sharedAssets,
          }));
          break;
        }
        const decisions = [checked.businessReview, checked.contentReview].filter(
          (review) => review?.result === "NEEDS_DECISION",
        );
        // 审查不通过时自动返工不再受次数限制；只有必须由用户决策才暂停等待。
        if (!confirmed && decisions.length > 0) {
          updateDrama((drama) => ({
            ...drama,
            pending: { episodeId: episode.id, stage, step: "review" },
          }));
          return planResult({
            kind: "planning",
            question: decisions.map((review) => review!.question).join("\n"),
            recommendation: decisions.map((review) => review!.recommendation).join("\n"),
          });
        }
        saveStage(stage, (run) => ({ ...run, repairCount: confirmed ? 0 : run.repairCount + 1 }));
        generate = true;
      }
    }
  }
  updateDrama((drama) => ({ ...drama, planningComplete: true, pending: null }));
  const plan = planResult(null);
  context.commit((current) => ({
    ...current,
    film: {
      ...createAiFilmCheckpoint(),
      assets: getDrama().sharedAssets,
      shots: plan.shots,
      planningComplete: true,
    },
  }));
  return plan;
}

export function createComicDramaWorkflowRunner(
  dependencies: Partial<KnowledgeVideoWorkflowRunnerDependencies> = {},
) {
  return createKnowledgeVideoWorkflowRunner(dependencies, {
    title: "漫剧作品",
    plan: planComicDrama,
    qcMode: "ai_film_qc",
    isPlanningComplete: (checkpoint) =>
      checkpoint.comicDrama?.planningComplete === true &&
      checkpoint.comicDrama.episodes.length > 0 &&
      checkpoint.comicDrama.episodes.every((episode) =>
        COMIC_DRAMA_STAGES.every((stage) => stagePassed(episode.stages[stage])),
      ),
    validateResume,
    initialize: (previous) => ({
      comicDrama: {
        ...createComicDramaCheckpoint(),
        episodes: (previous.comicDrama?.episodes ?? []).map((episode) => ({
          ...episode,
          stages: Object.fromEntries(
            COMIC_DRAMA_STAGES.map((stage) => {
              const old = episode.stages[stage];
              return [
                stage,
                emptyStage(old?.artifact ? [...old.history, old.artifact] : old?.history),
              ];
            }),
          ),
        })),
      },
      film: createAiFilmCheckpoint(),
      documentsOnly: false,
    }),
  });
}
