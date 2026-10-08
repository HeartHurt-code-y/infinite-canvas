import type { ExplicitMediaInput, TextSkillMode } from "../../lib/backend";
import { modelParameterCapabilities } from "../../lib/modelCapabilities";
import { formatWorkflowError } from "../../lib/workflowErrors";
import { sameWorkflowSignature, stableJsonSignature } from "../../lib/workflowSignatures";
import { speechClient } from "../../lib/speech";
import { mvMediaClient } from "../../lib/mvMedia";
import { createAiFilmCheckpoint, type AiFilmAsset } from "./aiFilmWorkflowModel";
import {
  COMIC_DRAMA_STAGES,
  COMIC_DRAMA_STAGE_LABELS,
  comicDramaLipReviewComplete,
  comicDramaStageDependencies,
  comicDramaRequiredSpeakers,
  createComicDramaCheckpoint,
  type ComicDramaArtifact,
  type ComicDramaShot,
  type ComicDramaSpeechIntent,
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
import { CANVAS_ID, type KnowledgeVideoWorkflowCheckpoint } from "./workspaceModel";
import {
  comicDramaReviewOutputSchema,
  comicDramaStageOutputSchema,
  formatValibotError,
  parseModelJson,
} from "./workflowOutputSchemas";
import * as v from "valibot";
import { topologicallySortWorkflowSteps } from "./workflowExecutionPlan";
import { musicVideoSupportsAudioReference } from "./musicVideoWorkflowRunner";

const GENERATION_MODES: Record<ComicDramaStage, TextSkillMode> = {
  screenplay: "comic_drama_screenplay",
  style: "comic_drama_style",
  director: "comic_drama_director",
  art: "comic_drama_art",
  storyboard: "comic_drama_storyboard",
};
const REVIEW_MODES: Record<ComicDramaStage, TextSkillMode> = {
  screenplay: "comic_drama_screenplay_review",
  style: "comic_drama_style_review",
  director: "comic_drama_director_review",
  art: "comic_drama_art_review",
  storyboard: "comic_drama_storyboard_review",
};
export const COMIC_DRAMA_APPROVAL = "确认通过，继续下一阶段";

export function comicDramaDialogueCapacity(durationSeconds: number, dialogue: string): number {
  const budget = Math.max(0, Math.min(durationSeconds - 1.2, durationSeconds * 0.85));
  const english = !/[\u3040-\u30ff\u3400-\u9fff]/u.test(dialogue);
  const japanese = /[\u3040-\u30ff]/u.test(dialogue);
  return Math.floor(budget * (english ? 2.5 : japanese ? 7 : 4.5));
}

function closeDialogueLips(prompt: string): string {
  return prompt.replace(/<\/d>(?![^\n]*(?:嘴唇|双唇|抿住嘴|lips))/g, "</d> 说完嘴唇合上。");
}

function stageApproved(run: ComicDramaStageRun | undefined): boolean {
  return stagePassed(run) && run?.approvedVersion === run?.artifact?.version;
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

function voiceBindingsSignature(node: KnowledgeVideoWorkflowRunRequest["node"]): string {
  return stableJsonSignature(node.config.comicDrama?.speech ?? null);
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
  const speech = checkpoint.comicDrama?.speech;
  if (
    speech &&
    !sameWorkflowSignature(speech.voiceBindingsSignature, voiceBindingsSignature(request.node))
  )
    throw new Error("角色音色绑定已改变，请重新制作，不能复用旧配音和视频片段。");
}

interface ComicDramaStageResult {
  readonly content: string;
  readonly inputSummary: string;
  readonly assets: readonly AiFilmAsset[];
  readonly shots: readonly ComicDramaShot[];
  readonly decision: KnowledgeVideoWorkflowCheckpoint["decision"];
}

export function parseComicDramaStage(
  raw: string,
  stage: ComicDramaStage,
  episodeId: string,
  knownAssets: readonly AiFilmAsset[],
  options: { readonly requireSpeechLines?: boolean } = {},
): ComicDramaStageResult {
  let data: v.InferOutput<typeof comicDramaStageOutputSchema>;
  try {
    data = v.parse(comicDramaStageOutputSchema, parseModelJson(raw));
  } catch (error) {
    if (error instanceof v.ValiError) throw new Error(formatValibotError(error), { cause: error });
    throw error;
  }
  if (data.stage !== stage) throw new Error("漫剧模型越过当前阶段或返回了错误协议。");
  if (data.status === "needs_confirmation") {
    if (data.decision == null) throw new Error("needs_confirmation 状态必须提供 decision。");
    return {
      content: "",
      inputSummary: "",
      assets: [],
      shots: [],
      decision: {
        kind: "planning",
        question: data.decision.question,
        recommendation: data.decision.recommendation,
      },
    };
  }
  if (data.decision != null) throw new Error("漫剧 ready 成果不能保留待确认决定。");
  if (
    (stage !== "art" && data.assets.length > 0) ||
    (stage !== "storyboard" && data.shots.length > 0)
  )
    throw new Error("当前阶段不能擅自生成下游资产或分镜。");
  const assets: AiFilmAsset[] = [];
  if (stage === "art") {
    if (data.assets.length === 0 || data.assets.length > 64)
      throw new Error("服化道阶段必须列出本集使用的 1～64 个资产。");
    for (const item of data.assets) {
      if (assets.some((asset) => asset.id === item.id)) throw new Error("本集资产 ID 重复。");
      const asset: AiFilmAsset = {
        id: item.id,
        kind: item.kind,
        name: item.name,
        prompt: item.prompt,
      };
      const previous = knownAssets.find((entry) => entry.id === item.id);
      if (previous && !sameAsset(previous, asset))
        throw new Error(`共享资产 ${item.id} 的固定描述被改写；造型或状态变体必须使用新 ID。`);
      assets.push(previous ?? asset);
    }
  }
  const shots: ComicDramaShot[] = [];
  if (stage === "storyboard") {
    if (data.shots.length === 0 || data.shots.length > 120)
      throw new Error("分镜阶段必须提供本集 1～120 个可执行镜头。");
    for (const item of data.shots) {
      const id = `${episodeId}:${item.id}`;
      const qualifyShotId = (source: string) =>
        source.includes(":") ? source : `${episodeId}:${source}`;
      const dependsOn = (item.dependsOn ?? []).map(qualifyShotId);
      const continuationFromShotId = item.continuationFromShotId
        ? qualifyShotId(item.continuationFromShotId)
        : undefined;
      if (
        new Set(dependsOn).size !== dependsOn.length ||
        dependsOn.includes(id) ||
        continuationFromShotId === id
      )
        throw new Error(`镜头 ${id} 包含重复依赖或依赖自身。`);
      if (shots.some((shot) => shot.id === id)) throw new Error("本集镜头 ID 重复。");
      if (item.durationSeconds < 1 || item.durationSeconds > 30)
        throw new Error("漫剧单镜头时长必须为 1～30 秒。");
      const references = item.referenceAssetIds;
      if (new Set(references).size !== references.length) throw new Error("镜头重复引用同一资产。");
      if (references.some((ref) => !knownAssets.some((asset) => asset.id === ref)))
        throw new Error(`镜头 ${id} 引用了本集服化道未确认的资产。`);
      if (item.acceptance.length === 0) throw new Error("镜头缺少验收标准。");
      const dialogue = item.dialogue;
      const dialogueLines = item.dialogueLines ?? [];
      if (options.requireSpeechLines && Boolean(dialogue.trim()) !== dialogueLines.length > 0)
        throw new Error(`镜头 ${id} 的逐字对白与有序说话人台词不一致。`);
      if (
        dialogueLines.length &&
        dialogueLines
          .map((line) => line.text)
          .join("")
          .replace(/\s/gu, "") !== dialogue.replace(/\s/gu, "")
      )
        throw new Error(`镜头 ${id} 的有序说话人台词必须逐字覆盖原对白。`);
      for (const [lineIndex, line] of dialogueLines.entries()) {
        if (!knownAssets.some((asset) => asset.id === line.speakerId && asset.kind === "character"))
          throw new Error(
            `镜头 ${id} 第 ${lineIndex + 1} 句引用了未经确认的说话角色 ${line.speakerId}。`,
          );
        if (
          !Number.isFinite(line.startSeconds) ||
          line.startSeconds < 0 ||
          line.startSeconds >= item.durationSeconds
        )
          throw new Error(`镜头 ${id} 第 ${lineIndex + 1} 句的起始时间超出镜头。`);
        if (lineIndex > 0 && line.startSeconds < dialogueLines[lineIndex - 1]!.startSeconds)
          throw new Error(`镜头 ${id} 的逐句对白必须按镜头内时间排序。`);
      }
      const dialogueUnits = /[\u3040-\u30ff\u3400-\u9fff]/u.test(dialogue)
        ? [...dialogue.replace(/[\s\p{P}\p{S}]/gu, "")].length
        : dialogue.trim().split(/\s+/u).filter(Boolean).length;
      if (dialogueUnits > comicDramaDialogueCapacity(item.durationSeconds, dialogue))
        throw new Error(
          `镜头 ${id} 对白超过当前时长容量，请拆分连续镜头并保留完整对白与反应余量。`,
        );
      const videoPrompt = closeDialogueLips(item.videoPrompt);
      shots.push({
        id,
        sequence: shots.length + 1,
        section: "FILM",
        track: "FILM",
        title: `${item.sceneId} · ${item.title}`,
        durationSeconds: item.durationSeconds,
        visual: item.visual,
        narration: dialogue,
        dialogueLines,
        videoPrompt: `${videoPrompt}${dialogue && !videoPrompt.includes(dialogue) ? `\n【逐字对白】${dialogue}` : ""}`,
        referenceAssetIds: references,
        ...(dependsOn.length ? { dependsOn } : {}),
        ...(continuationFromShotId ? { continuationFromShotId } : {}),
        acceptance: item.acceptance.join("；"),
      });
    }
  }
  return {
    content: data.content,
    inputSummary: data.inputSummary,
    assets,
    shots,
    decision: null,
  };
}

export function parseComicDramaReview(raw: string): ComicDramaReview {
  let data: v.InferOutput<typeof comicDramaReviewOutputSchema>;
  try {
    data = v.parse(comicDramaReviewOutputSchema, parseModelJson(raw));
  } catch (error) {
    if (error instanceof v.ValiError) throw new Error(formatValibotError(error), { cause: error });
    throw error;
  }
  if (data.result === "PASS") {
    if (data.repairInstructions != null || data.question != null || data.recommendation != null)
      throw new Error("PASS 审查不能同时保留修订或待确认决定。");
    return { result: data.result, report: data.report };
  }
  if (data.result === "REVISE") {
    if (data.repairInstructions == null || !data.repairInstructions.trim())
      throw new Error("REVISE 审查必须提供 repairInstructions。");
    return {
      result: data.result,
      report: data.report,
      repairInstructions: data.repairInstructions,
    };
  }
  // NEEDS_DECISION
  if (data.question == null || !data.question.trim())
    throw new Error("NEEDS_DECISION 审查必须提供 question。");
  return {
    result: data.result,
    report: data.report,
    question: data.question,
    recommendation: data.recommendation ?? "",
  };
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

type ComicDramaSpeechClient = Pick<
  typeof speechClient,
  "getRequestStatus" | "synthesize" | "composeDubbedVideo"
>;

function speechLineKey(shotId: string, lineIndex: number): string {
  return `${shotId}#${lineIndex}`;
}

function speechLines(shot: KnowledgeVideoWorkflowCheckpoint["shots"][number]) {
  const lines = (shot as ComicDramaShot).dialogueLines ?? [];
  if (shot.narration.trim() && !lines.length)
    throw new Error(`镜头 ${shot.id} 有对白但缺少已确认的逐句说话人，不能自动配音。`);
  if (
    lines
      .map((line) => line.text)
      .join("")
      .replace(/\s/gu, "") !== shot.narration.replace(/\s/gu, "")
  )
    throw new Error(`镜头 ${shot.id} 的逐句说话人台词与当前对白不一致，请重新审核分镜。`);
  for (const [index, line] of lines.entries()) {
    if (
      !line.speakerId ||
      !line.text ||
      !Number.isFinite(line.startSeconds) ||
      line.startSeconds < 0 ||
      line.startSeconds >= shot.durationSeconds ||
      (index > 0 && line.startSeconds < lines[index - 1]!.startSeconds)
    )
      throw new Error(`镜头 ${shot.id} 第 ${index + 1} 句的角色、文本或时间无效。`);
  }
  return lines;
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
  // Resuming or restoring a checkpoint is not a user's approval. In particular,
  // the shared runner may provide a suggested answer as its planning fallback.
  let resolution = (
    originalPending?.step === "approval" ? request.decisionResolution : context.resolution
  )?.trim();
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
        videoPrompt: `${shot.videoPrompt}\n【目标画幅】${options.aspectRatio}${shot.referenceAssetIds?.length ? `\n【参考图映射】\n${shot.referenceAssetIds.map((id, referenceIndex) => `图片${referenceIndex + 1} 对应资产 ${id}（${drama.sharedAssets.find((asset) => asset.id === id)?.name ?? id}）。`).join("\n")}\n按以上对应关系保持人物身份、场景空间和道具一致。` : ""}${shot.dialogueLines?.length ? `\n【逐句角色对白与口型时间】\n${shot.dialogueLines.map((line, lineIndex) => `${line.startSeconds.toFixed(2)} 秒：${drama.sharedAssets.find((asset) => asset.id === line.speakerId)?.name ?? line.speakerId}（${line.speakerId}）说「${line.text}」${musicVideoSupportsAudioReference(request) ? `；参考音频${lineIndex + 1}为该句的真实配音` : ""}`).join("\n")}\n只让对应角色在该句时间张口，未说话角色闭口；最终成片会使用独立配音音轨。` : ""}`,
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
        .map(
          (episode) =>
            `# ${episode.title}\n\n${episode.stages.screenplay?.artifact?.content ?? episode.script}`,
        )
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

  const orderedStages = topologicallySortWorkflowSteps(
    comicDramaStageDependencies(getDrama().episodes),
  );
  for (const { episodeId, episodeIndex, stage, stageIndex, dependsOn } of orderedStages) {
    const episode = getDrama().episodes.find((entry) => entry.id === episodeId)!;
    for (const dependencyId of dependsOn) {
      const dependency = orderedStages.find((entry) => entry.id === dependencyId)!;
      const prerequisite = getDrama().episodes.find((entry) => entry.id === dependency.episodeId);
      if (!stageApproved(prerequisite?.stages[dependency.stage]))
        throw new Error(`阶段依赖 ${dependencyId} 尚未通过检查，不能执行 ${episodeId}:${stage}。`);
    }
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
    const pendingApproval =
      originalPending?.episodeId === episode.id &&
      originalPending.stage === stage &&
      originalPending.step === "approval";
    const requestApproval = () => {
      updateDrama((drama) => ({
        ...drama,
        pending: { episodeId: episode.id, stage, step: "approval" },
      }));
      return planResult({
        kind: "planning",
        question: `${episode.title} · ${COMIC_DRAMA_STAGE_LABELS[stage]} v${readStage(stage).artifact!.version} 已通过独立检查。请在阶段交付物中审阅完整内容；确认后才执行后续步骤，也可填写修改意见。`,
        recommendation: COMIC_DRAMA_APPROVAL,
      });
    };
    if (stageApproved(readStage(stage))) continue;
    if (stagePassed(readStage(stage))) {
      if (pendingApproval && resolution === COMIC_DRAMA_APPROVAL) {
        saveStage(stage, (run) => ({
          ...run,
          approvedVersion: run.artifact!.version,
          approvals: [
            ...(run.approvals ?? []),
            { version: run.artifact!.version, approvedAt: dependencies.now(), note: resolution! },
          ],
        }));
        updateDrama((drama) => ({ ...drama, pending: null }));
        resolution = undefined;
        continue;
      }
      if (pendingApproval && resolution) {
        saveStage(stage, (run) => ({
          ...run,
          passed: false,
          businessReview: {
            result: "REVISE",
            report: resolution!,
            repairInstructions: resolution!,
          },
          contentReview: null,
        }));
        updateDrama((drama) => ({
          ...drama,
          pending: { episodeId: episode.id, stage, step: "generation" },
        }));
      } else return requestApproval();
    }
    const hasConfirmed =
      originalPending?.episodeId === episode.id && originalPending.stage === stage && !!resolution;
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
      return `当前仅处理剧集：${episode.id}（${episode.title}），阶段：${stage}\n制作要求：${node.config.brief || "依据本集剧本完成制作"}\n视觉风格：${options.visualStyle}\n项目画幅：${options.aspectRatio}\n本集原始剧本（唯一剧情依据）：\n${episode.script || "本集剧本尚未提供；请根据制作要求判断是否需要确认。"}\n本集已确认上游成果：\n${inputs || "无"}\n可用资产（固定描述不得改写，变体用新 ID）：${JSON.stringify(assets.map(({ id, kind, name, prompt }) => ({ id, kind, name, prompt })))}\n当前项目图片模型参数：${describeCapabilities(imageCapabilities)}\n当前项目视频模型参数：${describeCapabilities(capabilities)}\n仅依据当前项目模型能力规划素材与镜头，不套用固定品牌的分辨率、参考图数量或时长限制；未声明的能力不能假定已支持。\n交付方式：${options.deliverable}。制作成片时单镜头时长必须匹配所选模型；需要时拆分连续镜头，逐字保留完整对白。${stage === "storyboard" ? "每镜必须输出 dialogue 原文字符串及同样内容的有序 dialogueLines 数组；每句含 speakerId（已确认角色资产 ID）、text（逐字台词）、startSeconds（镜头内起始秒），多人对白按实际开口先后排列，绝不猜测或省略说话人。无对白时两者都为空。" : ""}只处理本集当前阶段，不读取或编写其他集的剧情。`;
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
            Math.round(
              ((episodeIndex * COMIC_DRAMA_STAGES.length + stageIndex) /
                (options.episodes.length * COMIC_DRAMA_STAGES.length)) *
                16,
            ),
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
              { requireSpeechLines: stage === "storyboard" && options.deliverable === "video" },
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
    if (!stageApproved(readStage(stage))) return requestApproval();
  }
  if (options.deliverable === "video") {
    const required = comicDramaRequiredSpeakers(getDrama());
    if (required.length) {
      const speechModel = options.speech?.model;
      const selected = request.providerCatalog
        .find((entry) => entry.provider.enabled && entry.provider.id === speechModel?.providerId)
        ?.models.find(
          (entry) =>
            entry.definitionId === speechModel?.modelDefinitionId &&
            (entry.operations as readonly string[]).includes("speech_generation"),
        );
      const bindings = options.speech?.voiceBindings ?? {};
      const missing = required.filter((asset) => !bindings[asset.id]?.trim());
      const malformed = required.filter((asset) => {
        const voiceId = bindings[asset.id]?.trim() ?? "";
        return voiceId.length > 128 || /\s/u.test(voiceId);
      });
      const ids = required
        .map((asset) => bindings[asset.id]?.trim())
        .filter((id): id is string => Boolean(id));
      const duplicates = new Set(ids).size !== ids.length;
      if (!selected || missing.length || malformed.length || duplicates) {
        const target = getDrama().episodes.at(-1)!;
        updateDrama((drama) => ({
          ...drama,
          pending: { episodeId: target.id, stage: "storyboard", step: "voice_binding" },
        }));
        return planResult({
          kind: "planning",
          question: `${!selected ? "请先选择项目中已启用、支持语音合成的供应商模型。" : ""}${missing.length ? `请为说话角色填写控制台已开通的音色 ID：${missing.map((asset) => asset.name).join("、")}。` : ""}${malformed.length ? `这些角色的音色 ID 格式无效：${malformed.map((asset) => asset.name).join("、")}。` : ""}${duplicates ? "不同说话角色不能绑定同一个音色 ID。" : ""}完成绑定后重新确认执行计划，再继续生成资产与镜头。`,
          recommendation: "选择项目语音模型并填入每位说话角色在供应商控制台已开通的音色 ID",
        });
      }
    }
  }
  updateDrama((drama) => ({ ...drama, planningComplete: true, pending: null }));
  const plan = planResult(null);
  // A document-only delivery must obey the same dependency contract as media execution.
  topologicallySortWorkflowSteps(
    plan.shots.map((shot) => ({
      id: shot.id,
      dependsOn: [
        ...new Set([
          ...(shot.dependsOn ?? []),
          ...(shot.continuationFromShotId ? [shot.continuationFromShotId] : []),
        ]),
      ],
    })),
  );
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
  dependencies: Partial<KnowledgeVideoWorkflowRunnerDependencies> & {
    readonly speechClient?: ComicDramaSpeechClient;
    readonly clipSignature?: (path: string) => Promise<string>;
  } = {},
) {
  const {
    speechClient: voiceClient = speechClient,
    // 默认值包一层：`mvMediaClient.clipSignature` 是对象方法，直接解构会脱离接收者，
    // 后续实现若开始使用 `this` 就会静默丢上下文。
    clipSignature = (path: string) => mvMediaClient.clipSignature(path),
    ...baseDependencies
  } = dependencies;
  return createKnowledgeVideoWorkflowRunner(baseDependencies, {
    title: "漫剧作品",
    plan: planComicDrama,
    qcMode: "ai_film_qc",
    forceComposition: true,
    validateMedia: (context) => {
      const spoken = context.checkpoint().shots.flatMap((shot) => speechLines(shot));
      if (!spoken.length) return;
      const options = context.request.node.config.comicDrama;
      const model = options?.speech?.model;
      const selected = context.request.providerCatalog
        .find((entry) => entry.provider.enabled && entry.provider.id === model?.providerId)
        ?.models.find(
          (entry) =>
            entry.definitionId === model?.modelDefinitionId &&
            (entry.operations as readonly string[]).includes("speech_generation"),
        );
      if (!selected)
        throw new Error("漫剧成片需要项目中已启用的语音合成模型，不能沿用未配音的旧分镜。");
      const known = new Set(
        context
          .checkpoint()
          .comicDrama?.sharedAssets.filter((asset) => asset.kind === "character")
          .map((asset) => asset.id),
      );
      const boundVoices = new Map<string, string>();
      for (const line of spoken) {
        const voiceId = options?.speech?.voiceBindings[line.speakerId]?.trim() ?? "";
        if (!known.has(line.speakerId) || !voiceId)
          throw new Error(
            `说话角色 ${line.speakerId} 缺少已确认资产或控制台音色 ID，不能生成媒体。`,
          );
        if (voiceId.length > 128 || /\s/u.test(voiceId))
          throw new Error(`说话角色 ${line.speakerId} 的控制台音色 ID 格式无效。`);
        const otherSpeaker = boundVoices.get(voiceId);
        if (otherSpeaker && otherSpeaker !== line.speakerId)
          throw new Error(
            `说话角色 ${otherSpeaker} 与 ${line.speakerId} 绑定了同一个音色 ID，请分别指定。`,
          );
        boundVoices.set(voiceId, line.speakerId);
      }
    },
    prepareShotMedia: async (context, shot): Promise<readonly ExplicitMediaInput[]> => {
      const lines = speechLines(shot);
      if (!lines.length) return [];
      const options = context.request.node.config.comicDrama;
      const speech = options?.speech;
      const runId = context.checkpoint().runId;
      if (!speech?.model.providerId || !speech.model.modelDefinitionId || !runId)
        throw new Error("漫剧配音缺少项目语音模型或运行身份。");
      const bindingSignature = voiceBindingsSignature(context.request.node);
      const frozen = context.checkpoint().comicDrama?.speech?.voiceBindingsSignature;
      if (frozen && !sameWorkflowSignature(frozen, bindingSignature))
        throw new Error("角色音色绑定与已经提交的配音任务不一致，请重新制作。");
      for (const [lineIndex, line] of lines.entries()) {
        if (context.request.signal.aborted) throw new DOMException("已暂停", "AbortError");
        const voiceId = speech.voiceBindings[line.speakerId];
        if (!voiceId?.trim())
          throw new Error(`镜头 ${shot.id} 的角色 ${line.speakerId} 缺少控制台音色 ID。`);
        const key = speechLineKey(shot.id, lineIndex);
        const intent: ComicDramaSpeechIntent = {
          shotId: shot.id,
          lineIndex,
          speakerId: line.speakerId,
          text: line.text,
          startSeconds: line.startSeconds,
          voiceId,
          providerId: speech.model.providerId,
          modelDefinitionId: speech.model.modelDefinitionId,
          requestId: `${runId}:speech:${shot.id}:${lineIndex}`,
        };
        const prior = context.checkpoint().comicDrama?.speech?.lines[key];
        if (prior) {
          if (
            stableJsonSignature(intent) !==
            stableJsonSignature({
              shotId: prior.shotId,
              lineIndex: prior.lineIndex,
              speakerId: prior.speakerId,
              text: prior.text,
              startSeconds: prior.startSeconds,
              voiceId: prior.voiceId,
              providerId: prior.providerId,
              modelDefinitionId: prior.modelDefinitionId,
              requestId: prior.requestId,
            })
          )
            throw new Error(`镜头 ${shot.id} 的配音内容已改变，请重新制作。`);
          const status = await voiceClient.getRequestStatus(prior.requestId);
          if (status.status === "recoverable") {
            await context.request.beforeSideEffect?.();
            const recovered = await voiceClient.synthesize({
              requestId: intent.requestId,
              providerConnectionId: intent.providerId,
              modelDefinitionId: intent.modelDefinitionId,
              voiceId: intent.voiceId,
              text: intent.text,
            });
            if (
              recovered.path !== prior.path ||
              recovered.requestSignature !== prior.requestSignature ||
              recovered.voiceId !== prior.voiceId ||
              recovered.durationSeconds !== prior.durationSeconds
            )
              throw new Error(
                `镜头 ${shot.id} 第 ${lineIndex + 1} 句恢复后的配音与已审核版本不一致。`,
              );
          } else if (status.status !== "ready") {
            throw new Error(
              `镜头 ${shot.id} 第 ${lineIndex + 1} 句已保存配音文件状态为 ${status.status}，不能继续提交视频。`,
            );
          }
          if (
            status.status === "ready" &&
            (status.path !== prior.path || status.requestSignature !== prior.requestSignature)
          )
            throw new Error(`镜头 ${shot.id} 第 ${lineIndex + 1} 句已保存配音文件与原请求不一致。`);
          continue;
        }
        const pending = context.checkpoint().comicDrama?.speech?.pendingRequests?.[key];
        if (pending && stableJsonSignature(pending) !== stableJsonSignature(intent))
          throw new Error(`镜头 ${shot.id} 的待恢复配音请求与当前文本不一致，请重新制作。`);
        context.commit((current) => ({
          ...current,
          comicDrama: {
            ...current.comicDrama!,
            speech: {
              voiceBindingsSignature: bindingSignature,
              lines: current.comicDrama?.speech?.lines ?? {},
              dubbedClips: current.comicDrama?.speech?.dubbedClips ?? {},
              pendingRequests: {
                ...current.comicDrama?.speech?.pendingRequests,
                [key]: intent,
              },
              pendingDubRequests: current.comicDrama?.speech?.pendingDubRequests ?? {},
            },
          },
        }));
        await context.request.beforeSideEffect?.();
        const result = await voiceClient.synthesize({
          requestId: intent.requestId,
          providerConnectionId: intent.providerId,
          modelDefinitionId: intent.modelDefinitionId,
          voiceId: intent.voiceId,
          text: intent.text,
        });
        if (
          !result.path ||
          result.voiceId !== voiceId ||
          !Number.isFinite(result.durationSeconds) ||
          result.durationSeconds <= 0
        )
          throw new Error(`镜头 ${shot.id} 第 ${lineIndex + 1} 句没有得到有效的真实配音。`);
        context.commit((current) => {
          const saved = current.comicDrama?.speech;
          const pendingRequests = { ...saved?.pendingRequests };
          delete pendingRequests[key];
          return {
            ...current,
            comicDrama: {
              ...current.comicDrama!,
              speech: {
                voiceBindingsSignature: bindingSignature,
                lines: {
                  ...saved?.lines,
                  [key]: {
                    ...intent,
                    path: result.path,
                    durationSeconds: result.durationSeconds,
                    requestSignature: result.requestSignature,
                  },
                },
                pendingRequests,
                dubbedClips: saved?.dubbedClips ?? {},
                pendingDubRequests: saved?.pendingDubRequests ?? {},
              },
            },
          };
        });
      }
      const savedLines = lines.map(
        (_, index) => context.checkpoint().comicDrama?.speech?.lines[speechLineKey(shot.id, index)],
      );
      for (const [index, result] of savedLines.entries()) {
        if (!result) throw new Error(`镜头 ${shot.id} 第 ${index + 1} 句缺少已保存配音。`);
        const nextStart = lines[index + 1]?.startSeconds ?? shot.durationSeconds;
        if (result.startSeconds + result.durationSeconds > nextStart + 0.04)
          throw new Error(
            `镜头 ${shot.id} 第 ${index + 1} 句配音实测时长超过分镜时间窗口，请调整台词或镜头。`,
          );
      }
      if (!musicVideoSupportsAudioReference(context.request)) return [];
      return savedLines.map((result, index) => ({
        target: { kind: "local_file" as const, path: result!.path, mediaType: "audio" as const },
        role: "reference_audio" as const,
        displayNameSnapshot: `角色 ${result!.speakerId} 第 ${index + 1} 句真实配音`,
        typePosition: index + 1,
        contentIndex: (shot.referenceAssetIds?.length ?? 0) + index + 1,
      }));
    },
    prepareComposition: async (context, clips) => {
      const runId = context.checkpoint().runId;
      if (!runId) throw new Error("漫剧合成缺少运行身份。");
      for (const { shot, path } of clips) {
        const lines = speechLines(shot);
        if (!lines.length) continue;
        const speech = context.checkpoint().comicDrama?.speech;
        const segments = lines.map((line, lineIndex) => {
          const result = speech?.lines[speechLineKey(shot.id, lineIndex)];
          if (!result?.path)
            throw new Error(`镜头 ${shot.id} 缺少第 ${lineIndex + 1} 句真实配音。`);
          if (
            result.text !== line.text ||
            result.speakerId !== line.speakerId ||
            result.startSeconds !== line.startSeconds ||
            result.voiceId !==
              context.request.node.config.comicDrama?.speech?.voiceBindings[line.speakerId]
          )
            throw new Error(
              `镜头 ${shot.id} 第 ${lineIndex + 1} 句与已生成配音不一致，请重新制作。`,
            );
          return { audioPath: result.path, startSeconds: result.startSeconds };
        });
        const speechSignature = stableJsonSignature({
          lines: lines.map((line, lineIndex) => ({
            line,
            result: speech?.lines[speechLineKey(shot.id, lineIndex)],
          })),
          segments,
        });
        const taskId = context.checkpoint().shotRuns[shot.id]?.videoTaskId;
        if (!taskId) throw new Error(`镜头 ${shot.id} 缺少视频任务身份，不能配音合成。`);
        const requestId = `${runId}:dub:${shot.id}:${taskId}`;
        const prior = speech?.dubbedClips?.[shot.id];
        const command = {
          requestId,
          sourcePath: path,
          segments,
          outputName: `漫剧-${shot.id}-配音`,
        };
        if (!(
          prior?.path &&
          prior.sourcePath === path &&
          prior.sourceVideoTaskId === taskId &&
          prior.speechSignature === speechSignature
        )) {
          const priorIntent = speech?.pendingDubRequests?.[shot.id];
          if (
            priorIntent &&
            (priorIntent.requestId !== requestId ||
              priorIntent.sourcePath !== path ||
              priorIntent.speechSignature !== speechSignature)
          )
            throw new Error(`镜头 ${shot.id} 的待恢复配音合成与当前视频不一致，请重新制作。`);
          context.commit((current) => ({
            ...current,
            comicDrama: {
              ...current.comicDrama!,
              speech: {
                ...current.comicDrama!.speech!,
                pendingDubRequests: {
                  ...current.comicDrama!.speech?.pendingDubRequests,
                  [shot.id]: {
                    requestId,
                    sourcePath: path,
                    sourceVideoTaskId: taskId,
                    speechSignature,
                  },
                },
              },
            },
          }));
          await context.request.beforeSideEffect?.();
          const result = await voiceClient.composeDubbedVideo(command);
          if (
            !result.path ||
            !Number.isFinite(result.durationSeconds) ||
            result.durationSeconds <= 0
          )
            throw new Error(`镜头 ${shot.id} 未获得有效的配音视频。`);
          context.commit((current) => {
            const saved = current.comicDrama!.speech!;
            const pendingDubRequests = { ...saved.pendingDubRequests };
            delete pendingDubRequests[shot.id];
            return {
              ...current,
              comicDrama: {
                ...current.comicDrama!,
                speech: {
                  ...saved,
                  pendingDubRequests,
                  dubbedClips: {
                    ...saved.dubbedClips,
                    [shot.id]: {
                      sourcePath: path,
                      sourceVideoTaskId: taskId,
                      speechSignature,
                      requestId,
                      requestSignature: result.requestSignature,
                      videoSignature: result.videoSignature,
                      path: result.path,
                      durationSeconds: result.durationSeconds,
                    },
                  },
                },
              },
            };
          });
        } else {
          await context.request.beforeSideEffect?.();
          const verified = await voiceClient.composeDubbedVideo(command);
          if (
            verified.requestSignature !== prior.requestSignature ||
            verified.videoSignature !== prior.videoSignature ||
            verified.path !== prior.path
          )
            throw new Error(`镜头 ${shot.id} 的配音视频文件已改变，请重新验收当前版本。`);
        }
        const actualSignature = await clipSignature(
          context.checkpoint().comicDrama?.speech?.dubbedClips?.[shot.id]?.path ?? "",
        );
        if (
          actualSignature !==
          context.checkpoint().comicDrama?.speech?.dubbedClips?.[shot.id]?.videoSignature
        )
          throw new Error(`镜头 ${shot.id} 的配音视频正文已改变，请重新试听并人工验收。`);
      }
      if (!comicDramaLipReviewComplete(context.checkpoint())) {
        context.commit((current) => ({
          ...current,
          phase: "awaiting_approval",
          lastActivePhase: "composing",
          decision: null,
          error: null,
        }));
        context.progress({
          phase: "awaiting_approval",
          progress: 89,
          message: "请逐镜试听配音视频并人工确认口型；全部通过后才能合成成片。",
          error: null,
        });
        return false;
      }
      return true;
    },
    startComposition: async (context, clips) => {
      if (!comicDramaLipReviewComplete(context.checkpoint()))
        throw new Error("配音镜头尚未逐镜通过人工口型验收，不能合成成片。");
      const inputs = await Promise.all(
        clips.map(async ({ shot, path }, index) => {
          if (!speechLines(shot).length)
            return { key: shot.id, name: `镜头-${index + 1}`, source: path };
          const dubbed = context.checkpoint().comicDrama?.speech?.dubbedClips?.[shot.id];
          if (!dubbed?.path || dubbed.sourcePath !== path)
            throw new Error(`镜头 ${shot.id} 缺少当前版本的已审核配音片段。`);
          const actualSignature = await clipSignature(dubbed.path);
          if (actualSignature !== dubbed.videoSignature)
            throw new Error(`镜头 ${shot.id} 的配音视频正文已改变，原口型验收失效。`);
          return { key: shot.id, name: `镜头-${index + 1}-配音`, source: dubbed.path };
        }),
      );
      return context.dependencies.composerClient.startComposition(inputs, "漫剧-完整配音成片");
    },
    isPlanningComplete: (checkpoint) =>
      checkpoint.comicDrama?.planningComplete === true &&
      checkpoint.comicDrama.episodes.length > 0 &&
      checkpoint.comicDrama.episodes.every((episode) =>
        COMIC_DRAMA_STAGES.every((stage) => stageApproved(episode.stages[stage])),
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
