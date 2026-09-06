import type { TextSkillMode } from "../../lib/backend";
import { modelParameterCapabilities } from "../../lib/modelCapabilities";
import { formatWorkflowError } from "../../lib/workflowErrors";
import {
  AI_FILM_STAGES,
  AI_FILM_STAGE_LABELS,
  createAiFilmCheckpoint,
  currentAiFilmAssets,
  type AiFilmStage,
  type AiFilmAsset,
  type AiFilmRoute,
  type AiFilmWorkflowCheckpoint,
} from "./aiFilmWorkflowModel";
import {
  createKnowledgeVideoWorkflowRunner,
  type KnowledgeVideoWorkflowRunnerDependencies,
  type WorkflowPlan,
  type WorkflowPlanningContext,
} from "./knowledgeVideoWorkflowRunner";
import {
  CANVAS_ID,
  type KnowledgeVideoWorkflowCheckpoint,
  type KnowledgeVideoWorkflowShot,
} from "./workspaceModel";

const STAGE_MODES: Record<AiFilmStage, TextSkillMode> = {
  synopsis: "ai_film_synopsis",
  characters: "ai_film_characters",
  worldbuilding: "ai_film_worldbuilding",
  treatment: "ai_film_treatment",
  screenplay: "ai_film_screenplay",
  assets: "ai_film_assets",
  acting: "ai_film_acting",
  prompts: "ai_film_prompts",
};
const INPUT_STAGES: Record<AiFilmStage, readonly AiFilmStage[]> = {
  synopsis: [],
  characters: ["synopsis"],
  worldbuilding: ["synopsis", "characters"],
  treatment: ["synopsis", "characters", "worldbuilding"],
  screenplay: ["synopsis", "characters", "worldbuilding", "treatment"],
  assets: ["characters", "worldbuilding", "screenplay"],
  acting: ["characters", "screenplay", "assets"],
  prompts: ["characters", "screenplay", "assets", "acting"],
};

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value == null || Array.isArray(value))
    throw new Error("影视模型输出必须是 JSON 对象。");
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`影视模型输出缺少 ${field}。`);
  return value.trim();
}
function stage(value: unknown): AiFilmStage {
  if (typeof value !== "string" || !AI_FILM_STAGES.includes(value as AiFilmStage))
    throw new Error("影视制作阶段无效。");
  return value as AiFilmStage;
}
function json(raw: string): Record<string, unknown> {
  const clean = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  return record(JSON.parse(clean) as unknown);
}
function decision(data: Record<string, unknown>): KnowledgeVideoWorkflowCheckpoint["decision"] {
  if (data["status"] === "ready") {
    if (data["decision"] != null) throw new Error("ready 输出不能保留未解决的决定。");
    return null;
  }
  if (data["status"] !== "needs_confirmation") throw new Error("影视制作状态无效。");
  const item = record(data["decision"]);
  return {
    kind: "planning",
    question: text(item["question"], "decision.question"),
    recommendation: text(item["recommendation"], "decision.recommendation"),
  };
}
function aspectRatio(value: unknown): string {
  const result = text(value, "aspectRatio");
  if (
    !/^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(result) ||
    result.split(":").some((part) => Number(part) <= 0)
  )
    throw new Error("影视画幅必须为有效的 W:H 比例。");
  return result;
}

export function parseAiFilmRoute(raw: string): {
  route: AiFilmRoute;
  decision: KnowledgeVideoWorkflowCheckpoint["decision"];
} {
  const data = json(raw);
  if (data["schemaVersion"] !== "ai-film-route.v1") throw new Error("影视路由协议版本无效。");
  const pending = decision(data);
  const mode = data["mode"];
  if (mode !== "full" && mode !== "stage" && mode !== "handoff" && mode !== "revision")
    throw new Error("影视路由模式无效。");
  if (!Array.isArray(data["stages"]) || !data["stages"].length)
    throw new Error("影视路由没有指定执行阶段。");
  const stages = data["stages"].map(stage);
  if (
    new Set(stages).size !== stages.length ||
    stages.some(
      (item, index) =>
        index > 0 && AI_FILM_STAGES.indexOf(item) <= AI_FILM_STAGES.indexOf(stages[index - 1]!),
    )
  )
    throw new Error("影视阶段必须唯一且按依赖顺序排列。");
  if (mode === "stage" && stages.length !== 1) throw new Error("指定阶段模式只能执行一个阶段。");
  if (
    mode === "full" &&
    AI_FILM_STAGES.some((item) => item !== "worldbuilding" && !stages.includes(item))
  )
    throw new Error("全流程缺少必要制作阶段。");
  return {
    route: {
      mode,
      stages,
      title: text(data["title"], "title"),
      aspectRatio: aspectRatio(data["aspectRatio"]),
      reason: text(data["reason"], "reason"),
    },
    decision: pending,
  };
}

interface StageResult {
  readonly content: string;
  readonly inputSummary: string;
  readonly decision: KnowledgeVideoWorkflowCheckpoint["decision"];
  readonly assets: readonly AiFilmAsset[];
  readonly shots: readonly KnowledgeVideoWorkflowShot[];
}

export function parseAiFilmStage(
  raw: string,
  expectedStage: AiFilmStage,
  knownAssets: readonly AiFilmAsset[],
): StageResult {
  const data = json(raw);
  if (data["schemaVersion"] !== "ai-film-stage.v1" || stage(data["stage"]) !== expectedStage)
    throw new Error("影视模型越过了当前阶段或返回了错误协议。");
  const pending = decision(data);
  if (pending)
    return {
      content: typeof data["content"] === "string" ? data["content"] : "",
      inputSummary: "",
      decision: pending,
      assets: [],
      shots: [],
    };
  const assets: AiFilmAsset[] = [];
  if (expectedStage === "assets") {
    if (!Array.isArray(data["assets"]) || !data["assets"].length || data["assets"].length > 48)
      throw new Error("资产阶段应提供 1～48 个角色、场景或道具资产。");
    for (const rawAsset of data["assets"]) {
      const item = record(rawAsset);
      const id = text(item["id"], "asset.id");
      if (assets.some((asset) => asset.id === id)) throw new Error("影视资产 ID 重复。");
      const kind = item["kind"];
      if (kind !== "character" && kind !== "scene" && kind !== "prop")
        throw new Error("影视资产类型无效。");
      const prompt = text(item["prompt"], "asset.prompt");
      const previous = knownAssets.find((asset) => asset.id === id && asset.prompt === prompt);
      assets.push({
        id,
        kind,
        name: text(item["name"], "asset.name"),
        prompt,
        taskId: previous?.taskId ?? null,
        path: previous?.path ?? null,
      });
    }
  }
  const shots: KnowledgeVideoWorkflowShot[] = [];
  if (expectedStage === "prompts") {
    if (!Array.isArray(data["shots"]) || !data["shots"].length || data["shots"].length > 60)
      throw new Error("提示词阶段应提供 1～60 个可执行镜头。");
    for (const rawShot of data["shots"]) {
      const item = record(rawShot);
      const id = text(item["id"], "shot.id");
      if (shots.some((shot) => shot.id === id)) throw new Error("影视镜头 ID 重复。");
      const durationSeconds = item["durationSeconds"];
      if (
        typeof durationSeconds !== "number" ||
        !Number.isFinite(durationSeconds) ||
        durationSeconds < 4 ||
        durationSeconds > 30
      )
        throw new Error("影视单段时长必须在 4～30 秒内。");
      if (!Array.isArray(item["referenceAssetIds"]))
        throw new Error("镜头必须明确列出 referenceAssetIds。");
      const references = item["referenceAssetIds"].map((value) => text(value, "referenceAssetId"));
      if (references.some((ref) => !knownAssets.some((asset) => asset.id === ref)))
        throw new Error(`镜头 ${id} 引用了不存在的资产。`);
      if (!Array.isArray(item["acceptance"]) || !item["acceptance"].length)
        throw new Error("镜头缺少验收标准。");
      if (typeof item["dialogue"] !== "string")
        throw new Error("镜头对白必须是字符串，没有对白时为空字符串。");
      const dialogue = item["dialogue"];
      shots.push({
        id,
        sequence: shots.length + 1,
        section: "FILM",
        track: "FILM",
        title: `${text(item["sceneId"], "sceneId")} · ${text(item["title"], "title")}`,
        durationSeconds,
        visual: text(item["visual"], "visual"),
        narration: dialogue,
        videoPrompt: `${text(item["videoPrompt"], "videoPrompt")}${dialogue ? `\n【逐字对白】${dialogue}` : ""}`,
        acceptance: item["acceptance"].map((value) => text(value, "acceptance")).join("；"),
        referenceAssetIds: references,
      });
    }
  }
  return {
    content: text(data["content"], "content"),
    inputSummary: text(data["inputSummary"], "inputSummary"),
    decision: null,
    assets,
    shots,
  };
}

async function planFilm(context: WorkflowPlanningContext): Promise<WorkflowPlan> {
  const { request, dependencies } = context;
  const { node, signal } = request;
  const options = node.config.film;
  if (!options) throw new Error("影视工作流配置缺失。");
  const videoModel = request.providerCatalog
    .find((entry) => entry.provider.id === node.config.models.video.providerId)
    ?.models.find((model) => model.definitionId === node.config.models.video.modelDefinitionId);
  const videoCapabilities = videoModel
    ? modelParameterCapabilities(
        videoModel.operationSchema,
        "video_generation",
        videoModel.remoteModelId,
      )
    : [];
  const durationCapability = videoCapabilities.find((capability) => capability.key === "duration");
  const allowedDurations =
    durationCapability?.options
      .map((option) => option.value)
      .filter((value): value is number => typeof value === "number" && value > 0) ?? [];
  const getFilm = () => context.checkpoint().film ?? createAiFilmCheckpoint();
  const updateFilm = (update: (film: AiFilmWorkflowCheckpoint) => AiFilmWorkflowCheckpoint) =>
    context.commit((current) => ({
      ...current,
      film: update(current.film ?? createAiFilmCheckpoint()),
    }));
  const checkAbort = () => {
    if (signal.aborted) throw new DOMException("Workflow cancelled", "AbortError");
  };
  const runText = async <T>(
    mode: TextSkillMode,
    userPrompt: string,
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
        userPrompt:
          userPrompt +
          (failure ? `\n上一次输出未通过校验：${failure}。请只修正当前阶段并输出完整JSON。` : ""),
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
  const planResult = (pending: KnowledgeVideoWorkflowCheckpoint["decision"]): WorkflowPlan => {
    const film = getFilm();
    const route = film.route;
    const artifacts = film.artifacts.filter((artifact) => !artifact.stale);
    const currentAssets = currentAiFilmAssets(film);
    const shots = film.shots ?? [];
    const documentsOnly =
      options.deliverable === "documents" ||
      route?.mode === "stage" ||
      route?.mode === "revision" ||
      !route?.stages.includes("prompts");
    return {
      manifest: JSON.stringify({
        schemaVersion: "ai-film-workflow.manifest.v1",
        workflowVersion: "1.3",
        project: { title: route?.title ?? "影视项目", aspectRatio: route?.aspectRatio ?? "16:9" },
        route,
        assets: currentAssets,
        shots,
      }),
      aspectRatio: route?.aspectRatio ?? "16:9",
      script: artifacts.find((artifact) => artifact.stage === "screenplay")?.content ?? "",
      storyboard:
        artifacts.find((artifact) => artifact.stage === "prompts")?.content ??
        artifacts.find((artifact) => artifact.stage === "treatment")?.content ??
        "",
      shots: shots.map((shot, index) => ({
        ...shot,
        videoPrompt: `${shot.videoPrompt}\n【目标画幅】${route?.aspectRatio ?? "16:9"}`,
        ...(index === 0 && !currentAssets.length
          ? {
              imagePrompt: `${shot.visual}。电影主视觉，画幅${route?.aspectRatio ?? "16:9"}，不含文字。`,
            }
          : {}),
      })),
      documentsOnly,
      decision: pending,
    };
  };

  if (!getFilm().route) {
    updateFilm((film) => ({ ...film, pendingStage: "router" }));
    const { route, decision: pending } = await runText(
      "ai_film_router",
      `当前创作需求：\n${node.config.brief}\n用户指定入口：${options.entryStage}；交付：${options.deliverable}\n用户指定为本次依据的资料：\n${options.sourceText || "无"}\n已有阶段：${getFilm()
        .artifacts.map(
          (artifact) => `${artifact.stage} v${artifact.version}${artifact.stale ? "（过期）" : ""}`,
        )
        .join(
          "、",
        )}\n${context.resolution ? `用户已确认：${context.resolution}` : ""}\n只安排本次明确要求的阶段。全流程自动推进；已有资料直接接力；修订只改明确指定范围。`,
      parseAiFilmRoute,
    );
    if (pending) return planResult(pending);
    if (options.entryStage !== "auto" && route.stages[0] !== options.entryStage)
      throw new Error("路由没有遵守节点中指定的起始阶段。");
    updateFilm((film) => ({
      ...film,
      route,
      pendingStage: null,
      ...(route.mode === "full"
        ? { history: [...film.history, ...film.artifacts], artifacts: [], assets: [], shots: [] }
        : {}),
    }));
  }
  const route = getFilm().route!;
  for (const [index, currentStage] of route.stages.entries()) {
    if (getFilm().completedStages.includes(currentStage)) continue;
    checkAbort();
    const wasPending = getFilm().pendingStage === currentStage;
    updateFilm((film) => ({ ...film, pendingStage: currentStage }));
    context.progress({
      phase: "planning",
      progress: 4 + Math.round((index / route.stages.length) * 16),
      message: `正在完成${AI_FILM_STAGE_LABELS[currentStage]}（${index + 1}/${route.stages.length}）…`,
      error: null,
    });
    const film = getFilm();
    const usableAssets = currentAiFilmAssets(film);
    const inputs = film.artifacts.filter(
      (artifact) =>
        !artifact.stale &&
        (INPUT_STAGES[currentStage].includes(artifact.stage) ||
          (route.mode === "revision" && artifact.stage === currentStage)),
    );
    const result = await runText(
      STAGE_MODES[currentStage],
      `本轮只执行：${currentStage}（${AI_FILM_STAGE_LABELS[currentStage]}）\n创作需求：${node.config.brief}\n项目画幅：${route.aspectRatio}\n工作模式：${route.mode}\n本次权威资料：\n${options.sourceText || "无额外资料"}\n允许读取的当前阶段输入：\n${inputs.map((artifact) => `## ${AI_FILM_STAGE_LABELS[artifact.stage]} v${artifact.version}\n${artifact.content}`).join("\n\n")}\n可用资产ID与固定描述：${JSON.stringify(usableAssets.map(({ id, kind, name, prompt }) => ({ id, kind, name, prompt })))}\n${wasPending && context.resolution ? `本阶段用户已经确认：${context.resolution}，必须真正应用到成果中。` : ""}\n只输出当前阶段JSON。资料足够直接生成，不强制补做前序。常规问题自行审校修复，仅不可推断的关键选择请求一次确认。\n当前视频模型的可用参数：${JSON.stringify(videoCapabilities.map(({ key, type, options, minimum, maximum }) => ({ key, type, values: options.map((option) => option.value), minimum, maximum })))}。生成成片时，单段时长必须匹配这些参数；容纳不了的完整台词应拆成连续镜头，不得由生成时长截断。`,
      (raw) => {
        const parsed = parseAiFilmStage(raw, currentStage, usableAssets);
        if (
          options.deliverable === "video" &&
          route.mode !== "stage" &&
          route.mode !== "revision" &&
          currentStage === "prompts" &&
          !parsed.decision
        ) {
          for (const shot of parsed.shots) {
            if (
              (allowedDurations.length > 0 && !allowedDurations.includes(shot.durationSeconds)) ||
              (durationCapability?.maximum != null &&
                shot.durationSeconds > durationCapability.maximum) ||
              (durationCapability?.minimum != null &&
                shot.durationSeconds < durationCapability.minimum)
            ) {
              throw new Error(
                `镜头 ${shot.id} 时长不在所选视频模型支持范围内。请按供应商时长拆镜，保留全部台词，允许时长：${allowedDurations.join("、") || `${durationCapability?.minimum ?? 4}～${durationCapability?.maximum ?? 30}`}秒。`,
              );
            }
          }
        }
        return parsed;
      },
    );
    if (result.decision) return planResult(result.decision);
    updateFilm((current) => {
      const previous = current.artifacts.find((artifact) => artifact.stage === currentStage);
      const version =
        Math.max(
          0,
          ...current.history
            .filter((item) => item.stage === currentStage)
            .map((item) => item.version),
          previous?.version ?? 0,
        ) + 1;
      const remaining = current.artifacts
        .filter((artifact) => artifact.stage !== currentStage)
        .map((artifact) =>
          AI_FILM_STAGES.indexOf(artifact.stage) > AI_FILM_STAGES.indexOf(currentStage)
            ? { ...artifact, stale: true }
            : artifact,
        );
      return {
        ...current,
        artifacts: [
          ...remaining,
          {
            stage: currentStage,
            version,
            content: result.content,
            inputSummary: result.inputSummary,
            createdAt: dependencies.now(),
          },
        ],
        history: previous ? [...current.history, previous] : current.history,
        assets: currentStage === "assets" ? result.assets : current.assets,
        shots: currentStage === "prompts" ? result.shots : (current.shots ?? []),
        completedStages: [...current.completedStages, currentStage],
        pendingStage: null,
      };
    });
  }
  updateFilm((film) => ({ ...film, planningComplete: true }));
  return planResult(null);
}

export function createAiFilmWorkflowRunner(
  dependencies: Partial<KnowledgeVideoWorkflowRunnerDependencies> = {},
) {
  return createKnowledgeVideoWorkflowRunner(dependencies, {
    title: "AI影视作品",
    plan: planFilm,
    qcMode: "ai_film_qc",
    initialize: (previous) => ({
      film: {
        ...(previous.film ?? createAiFilmCheckpoint()),
        route: null,
        completedStages: [],
        pendingStage: null,
        planningComplete: false,
      },
      documentsOnly: false,
    }),
  });
}
