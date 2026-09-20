import * as v from "valibot";
import type { ExplicitMediaInput, TextSkillMode } from "../../lib/backend";
import {
  modelParameterCapabilities,
  type ModelParameterCapability,
} from "../../lib/modelCapabilities";
import { mvMediaClient, type MvMediaClient, type MvSongProbe } from "../../lib/mvMedia";
import { stableJsonSignature } from "../../lib/workflowSignatures";
import { createAiFilmCheckpoint, type AiFilmAsset } from "./aiFilmWorkflowModel";
import { parseComicDramaReview } from "./comicDramaWorkflowRunner";
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
import {
  musicVideoStageOutputSchema,
  parseModelJson,
  formatValibotError,
} from "./workflowOutputSchemas";
import {
  createMusicVideoCheckpoint,
  isMusicVideoStageApproved,
  MUSIC_VIDEO_APPROVAL,
  MUSIC_VIDEO_STAGES,
  MUSIC_VIDEO_STAGE_LABELS,
  musicVideoDeliveryMarkdown,
  type MusicVideoArtifact,
  type MusicVideoStage,
  type MusicVideoStageRun,
  type MusicVideoTimelineSegment,
  type MusicVideoWorkflowOptions,
  type MusicVideoWorkflowCheckpoint,
} from "./musicVideoWorkflowModel";

const EPSILON = 0.001;
const STAGE_MODES: Record<MusicVideoStage, TextSkillMode> = {
  timeline: "music_video_timeline",
  style: "music_video_style",
  storyboard: "music_video_storyboard",
  prompts: "music_video_prompts",
};
export interface MusicVideoParseContext {
  readonly options: MusicVideoWorkflowOptions;
  readonly song: MvSongProbe;
  readonly timeline?: readonly MusicVideoTimelineSegment[];
  readonly assets?: readonly AiFilmAsset[];
  readonly storyboard?: NonNullable<MusicVideoArtifact["shots"]>;
  readonly duration?: ModelParameterCapability;
}

/** Choose only a declared project-model duration; never shorten an authored lyric window. */
export function musicVideoGenerationDuration(
  windowSeconds: number,
  capability?: ModelParameterCapability,
): number {
  if (!Number.isFinite(windowSeconds) || windowSeconds <= 0)
    throw new Error("音乐窗口时长必须为正数。");
  if (!capability)
    throw new Error(
      "当前视频模型未声明合法时长，无法制作 MV；请选择已配置时长能力的项目模型，或交付文档。",
    );
  const values = capability.options
    .map(({ value }) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
  let chosen: number | undefined;
  if (values.length) chosen = values.find((value) => value + EPSILON >= windowSeconds);
  else if (capability.maximum != null && Number.isFinite(capability.maximum)) {
    const minimum = Math.max(0, capability.minimum ?? 0);
    const step = capability.step ?? (capability.type === "integer" ? 1 : 0);
    const required = Math.max(minimum, windowSeconds);
    chosen = step > 0 ? minimum + Math.ceil((required - minimum - 1e-8) / step) * step : required;
    if (chosen > capability.maximum + 1e-8) chosen = undefined;
  }
  if (chosen == null)
    throw new Error(
      `完整歌词行或间奏窗口长 ${windowSeconds.toFixed(2)} 秒，超过当前视频模型可执行时长。请提供更细且经过人工核对的完整歌词行时间标记、调整间奏边界，或选择更长时长模型；系统不会乱拆歌词、压缩或伪造时间。`,
    );
  return chosen;
}

function lyricsText(text: string): string {
  return text.replace(/[\s\p{P}\p{S}]/gu, "");
}
export function validateMusicVideoTimeline(
  timeline: readonly MusicVideoTimelineSegment[],
  song: MvSongProbe,
  options?: MusicVideoWorkflowOptions,
  duration?: ModelParameterCapability,
): void {
  if (!timeline.length || !Number.isFinite(song.durationSeconds) || song.durationSeconds <= 0)
    throw new Error("歌曲时间线为空或真实歌曲时长无效。");
  const ids = new Set<string>();
  let end = 0;
  for (const segment of timeline) {
    if (!segment.id || ids.has(segment.id)) throw new Error("歌曲时间线 ID 重复或为空。");
    ids.add(segment.id);
    if (
      ![segment.startSeconds, segment.endSeconds].every(Number.isFinite) ||
      segment.startSeconds < 0 ||
      segment.endSeconds <= segment.startSeconds ||
      Math.abs(segment.startSeconds - end) > EPSILON
    )
      throw new Error(
        `音乐窗口 ${segment.id} 存在空隙、重叠或无效时间；必须从 0 秒连续覆盖原曲，包含前奏、间奏与尾奏。`,
      );
    if (segment.kind === "vocal" && !segment.text.trim())
      throw new Error(`歌词窗口 ${segment.id} 缺少完整歌词。`);
    if (Math.round(segment.endSeconds * 30) <= Math.round(segment.startSeconds * 30))
      throw new Error(
        `音乐窗口 ${segment.id} 不足一个 30fps 输出帧，请人工调整时间边界后再制作；不会为零帧窗口提交视频任务。`,
      );
    if (options?.deliverable === "video")
      musicVideoGenerationDuration(segment.endSeconds - segment.startSeconds, duration);
    end = segment.endSeconds;
  }
  if (Math.abs(end - song.durationSeconds) > EPSILON)
    throw new Error(
      `歌曲时间线必须覆盖真实全曲 ${song.durationSeconds.toFixed(2)} 秒，当前结束于 ${end.toFixed(2)} 秒；不可省略前奏、间奏或尾奏。`,
    );
  if (
    options?.officialLyrics.trim() &&
    lyricsText(
      timeline
        .filter((item) => item.kind === "vocal")
        .map((item) => item.text)
        .join("\n"),
    ) !== lyricsText(options.officialLyrics)
  )
    throw new Error(
      "时间线歌词与官方歌词不一致，请逐字核对并保留全部重复句；系统不会自动改词或拆字。",
    );
}

/** LRC boundaries are user supplied evidence, not automatically inferred vocal timing. */
export function parseMusicVideoLrc(
  raw: string,
  durationSeconds: number,
): readonly MusicVideoTimelineSegment[] {
  const rows: { time: number; text: string }[] = [];
  const offsets = [...raw.matchAll(/^\[offset:([+-]?\d+)\]\s*$/gim)].map((match) =>
    Number(match[1]),
  );
  if (offsets.length > 1 || offsets.some((value) => !Number.isFinite(value)))
    throw new Error("LRC offset 必须是唯一有效的毫秒数。");
  const offset = (offsets[0] ?? 0) / 1000;
  for (const line of raw
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)) {
    if (/^\[(?:ar|ti|al|by|re|ve|length):/i.test(line)) continue;
    if (/^\[offset:/i.test(line)) {
      if (!/^\[offset:[+-]?\d+\]$/i.test(line)) throw new Error("LRC offset 必须是有效毫秒数。");
      continue;
    }
    const timestamps = [...line.matchAll(/\[(\d+):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    if (!timestamps.length)
      throw new Error("LRC 每个歌词行都必须提供 [分:秒.毫秒] 时间标记；纯文本歌词请填写官方歌词。");
    const text = line.replace(/\[\d+:\d{2}(?:[.:]\d{1,3})?\]/g, "").trim();
    for (const stamp of timestamps) {
      const seconds = Number(stamp[2]);
      const time =
        Number(stamp[1]) * 60 + seconds + (stamp[3] ? Number(`0.${stamp[3]}`) : 0) + offset;
      if (seconds >= 60 || !Number.isFinite(time) || time < 0 || time > durationSeconds + EPSILON)
        throw new Error("LRC 时间超出真实歌曲长度或秒字段无效。");
      rows.push({ time, text });
    }
  }
  rows.sort((left, right) => left.time - right.time);
  if (!rows.length) throw new Error("LRC 没有有效歌词时间标记。");
  const grouped: typeof rows = [];
  for (const row of rows) {
    if (row.time >= durationSeconds - EPSILON) {
      if (row.text && !/^\[?(?:instrumental|间奏|尾奏|前奏)\]?$/i.test(row.text))
        throw new Error("LRC 在歌曲结束时仍有未覆盖歌词，请修正最后一行的起始时间。");
      continue;
    }
    const previous = grouped.at(-1);
    if (previous?.time === row.time) previous.text += `\n${row.text}`;
    else grouped.push({ ...row });
  }
  if (grouped[0]?.time !== 0) grouped.unshift({ time: 0, text: "[Instrumental]" });
  return grouped.map((row, index) => {
    const instrumental = !row.text || /^\[?(?:instrumental|间奏|尾奏|前奏)\]?$/i.test(row.text);
    return {
      id: `segment-${index + 1}`,
      startSeconds: row.time,
      endSeconds: grouped[index + 1]?.time ?? durationSeconds,
      kind: instrumental ? "instrumental" : "vocal",
      text: instrumental ? "" : row.text,
      section: instrumental ? "器乐段" : "歌词段",
    };
  });
}

export function parseMusicVideoStage(
  raw: string,
  stage: MusicVideoStage,
  context: MusicVideoParseContext,
): {
  artifact: Omit<MusicVideoArtifact, "version" | "createdAt"> | null;
  decision: WorkflowPlan["decision"];
} {
  let data: v.InferOutput<typeof musicVideoStageOutputSchema>;
  try {
    data = v.parse(musicVideoStageOutputSchema, parseModelJson(raw));
  } catch (error) {
    if (error instanceof v.ValiError) throw new Error(formatValibotError(error), { cause: error });
    throw error;
  }
  if (data.stage !== stage) throw new Error("MV 模型越过当前审核阶段。");
  if (data.status === "needs_confirmation") {
    if (!data.decision) throw new Error("待确认的 MV 阶段必须给出问题和建议。");
    return { artifact: null, decision: { kind: "planning" as const, ...data.decision } };
  }
  if (data.decision) throw new Error("MV ready 成果不能同时携带待确认问题。");
  if (
    (stage !== "timeline" && data.timeline.length) ||
    (stage !== "style" && data.style) ||
    (!["storyboard", "prompts"].includes(stage) && data.shots.length)
  )
    throw new Error("MV 当前阶段不得生成未审核的下游内容。");
  const artifact: Omit<MusicVideoArtifact, "version" | "createdAt"> = {
    content: data.content,
    inputSummary: data.inputSummary,
  };
  if (stage === "timeline") {
    validateMusicVideoTimeline(data.timeline, context.song, context.options, context.duration);
    return { artifact: { ...artifact, timeline: data.timeline }, decision: null };
  }
  if (stage === "style") {
    if (!data.style) throw new Error("MV 风格阶段缺少 style。");
    if (new Set(data.style.assets.map((item) => item.id)).size !== data.style.assets.length)
      throw new Error("MV 风格资产 ID 重复。");
    const characters = data.style.assets.filter((item) => item.kind === "character");
    if (context.options.characterMode === "none" && characters.length)
      throw new Error("无人物模式不得生成角色资产。");
    if (context.options.characterMode === "generate" && !characters.length)
      throw new Error("生成人物模式必须列出可确认的角色设计。");
    const referenceAssets: AiFilmAsset[] =
      context.options.characterMode === "reference"
        ? context.options.characterReferences.map((material, index) => ({
            id: `mv-character-${index + 1}`,
            kind: "character",
            name: material.displayName,
            prompt: "严格保持该参考人物的身份和外观",
            path: material.localPath,
          }))
        : [];
    if (
      context.options.characterMode === "reference" &&
      characters.some((item) => !referenceAssets.some((reference) => reference.id === item.id))
    )
      throw new Error("参考人物模式只能引用输入的 mv-character-N，不能生成替代人物。");
    return {
      artifact: {
        ...artifact,
        style: {
          description: data.style.description,
          assets: [
            ...data.style.assets
              .filter(
                (item) =>
                  context.options.characterMode !== "reference" || item.kind !== "character",
              )
              .map(({ id, kind, name, prompt }) => ({ id, kind, name, prompt })),
            ...referenceAssets,
          ],
        },
      },
      decision: null,
    };
  }
  const timeline = context.timeline ?? [];
  if (!timeline.length || data.shots.length !== timeline.length)
    throw new Error("MV 必须为每个已审核音乐窗口保留一个对应镜头，不得漏段或改切歌词。");
  const knownIds = new Set((context.assets ?? []).map((item) => item.id));
  const shotIds = new Set<string>();
  let syncStreak = 0;
  data.shots.forEach((shot, index) => {
    const segment = timeline[index]!;
    if (shotIds.has(shot.id)) throw new Error("MV 分镜 ID 重复。");
    shotIds.add(shot.id);
    if (
      shot.segmentId !== segment.id ||
      Math.abs(shot.startSeconds - segment.startSeconds) > EPSILON ||
      Math.abs(shot.endSeconds - segment.endSeconds) > EPSILON
    )
      throw new Error("MV 分镜音乐窗口必须逐项匹配已审核时间线，不能自动切分完整歌词。");
    if (
      ![shot.startSeconds, shot.endSeconds, shot.durationSeconds].every(Number.isFinite) ||
      shot.durationSeconds + EPSILON < segment.endSeconds - segment.startSeconds
    )
      throw new Error("MV 生成时长不能短于完整音乐窗口。");
    if (
      context.options.deliverable === "video" &&
      Math.abs(
        musicVideoGenerationDuration(shot.durationSeconds, context.duration) - shot.durationSeconds,
      ) > EPSILON
    )
      throw new Error("MV 分镜生成时长不是当前项目视频模型声明的合法时长。");
    if (
      shot.lipSync === "sync" &&
      (context.options.characterMode === "none" ||
        segment.kind !== "vocal" ||
        !["close", "medium"].includes(shot.framing))
    )
      throw new Error(
        "对口型镜头必须有人物、完整歌词且为近景或中景；无人物、器乐段及远景不可标记 sync。",
      );
    syncStreak = shot.lipSync === "sync" ? syncStreak + 1 : 0;
    if (syncStreak > 3) throw new Error("连续对口型镜头不得超过三段，请在人工分镜中调整节奏。");
    if (
      new Set(shot.referenceAssetIds).size !== shot.referenceAssetIds.length ||
      shot.referenceAssetIds.some((id) => !knownIds.has(id))
    )
      throw new Error("MV 镜头引用了重复或未审核的资产。");
    if (
      shot.lipSync === "sync" &&
      !(context.assets ?? []).some(
        (asset) => asset.kind === "character" && shot.referenceAssetIds.includes(asset.id),
      )
    )
      throw new Error("对口型镜头必须显式引用已审核的人物资产，不能只凭文字生成不同演唱者。");
    const previous = context.storyboard?.[index];
    if (
      stage === "prompts" &&
      previous &&
      stableJsonSignature({ ...shot, videoPrompt: "" }) !==
        stableJsonSignature({ ...previous, videoPrompt: "" })
    )
      throw new Error("执行提示词阶段不能改写已审核分镜、时间窗或人物策略；请回到分镜阶段修订。");
  });
  return { artifact: { ...artifact, shots: data.shots }, decision: null };
}

function signature(request: KnowledgeVideoWorkflowRunRequest): string {
  return stableJsonSignature({
    brief: request.node.config.brief,
    musicVideo: request.node.config.musicVideo,
  });
}
function durationCapability(
  request: KnowledgeVideoWorkflowRunRequest,
): ModelParameterCapability | undefined {
  const selection = request.node.config.models.video;
  const model = request.providerCatalog
    .find((entry) => entry.provider.id === selection.providerId && entry.provider.enabled)
    ?.models.find(
      (entry) =>
        entry.definitionId === selection.modelDefinitionId &&
        entry.operations.includes("video_generation"),
    );
  return model
    ? modelParameterCapabilities(
        model.operationSchema,
        "video_generation",
        model.remoteModelId,
      ).find((capability) => capability.key === "duration")
    : undefined;
}
/** The configured request adapter must encode audio; image-only video profiles cannot fake sync. */
export function musicVideoSupportsAudioReference(
  request: KnowledgeVideoWorkflowRunRequest,
): boolean {
  const selection = request.node.config.models.video;
  const model = request.providerCatalog
    .find((entry) => entry.provider.id === selection.providerId && entry.provider.enabled)
    ?.models.find(
      (entry) =>
        entry.definitionId === selection.modelDefinitionId &&
        entry.operations.includes("video_generation"),
    );
  if (!model) return false;
  const operation = model.operationSchema["video_generation"] as
    Record<string, unknown> | undefined;
  const profile = operation?.["request"] as Record<string, unknown> | undefined;
  const encoding = profile?.["mediaEncoding"];
  if (encoding === "wan_media_array" || encoding === "minimax_h3_media") return true;
  return (
    encoding == null &&
    operation?.["requestProfileId"] === "moyu_video_metadata_v1" &&
    /seedance-2[-.](?:0|5)/i.test(model.remoteModelId) &&
    !model.remoteModelId.toLowerCase().startsWith("pan-")
  );
}
function songInput(options: MusicVideoWorkflowOptions) {
  const ext = options.songPath.split(".").at(-1)?.toLowerCase();
  return {
    localPath: options.songPath,
    displayName: options.songName || "MV 原曲",
    kind: "audio" as const,
    mimeType:
      ext === "wav"
        ? "audio/wav"
        : ext === "flac"
          ? "audio/flac"
          : ext === "ogg"
            ? "audio/ogg"
            : ext === "m4a"
              ? "audio/mp4"
              : "audio/mpeg",
  };
}
function emptyStage(history: readonly MusicVideoArtifact[] = []): MusicVideoStageRun {
  return { artifact: null, review: null, history };
}
function timelineMarkdown(timeline: readonly MusicVideoTimelineSegment[]) {
  return timeline
    .map(
      (item) =>
        `- ${item.id} · ${item.startSeconds.toFixed(2)}–${item.endSeconds.toFixed(2)}s · ${item.kind === "vocal" ? item.text : "器乐（无歌词）"}`,
    )
    .join("\n");
}

function toPlan(
  state: MusicVideoWorkflowCheckpoint,
  options: MusicVideoWorkflowOptions,
  checkpoint: KnowledgeVideoWorkflowCheckpoint,
  decision: WorkflowPlan["decision"] = null,
): WorkflowPlan {
  const timeline = state.stages.timeline?.artifact?.timeline ?? [];
  const shots = (state.stages.prompts?.artifact?.shots ?? []).map(
    (shot, index): KnowledgeVideoWorkflowShot => {
      const segment = timeline.find((item) => item.id === shot.segmentId)!;
      return {
        id: shot.id,
        sequence: index + 1,
        section: "FILM",
        track: "FILM",
        title: shot.title,
        durationSeconds: shot.durationSeconds,
        visual: shot.visual,
        narration: segment?.text ?? "",
        referenceAssetIds: shot.referenceAssetIds,
        videoPrompt: `${shot.videoPrompt}\n【原曲音乐窗口】${shot.startSeconds.toFixed(3)}–${shot.endSeconds.toFixed(3)} 秒；所附音频从该窗口起点开始。画面覆盖完整窗口，额外生成尾部留给本地裁剪；禁止另换歌曲。\n【完整歌词】${segment?.text || "器乐段，不唱词"}\n【嘴型策略】${shot.lipSync === "sync" ? "在近景或中景中根据真实音频引导演唱；不承诺专用口型同步，交付前必须人工试听核对" : shot.lipSync === "offscreen" ? "歌词保留画外，不展示人物唱词嘴型" : "不安排唱词口型"}\n${options.characterMode === "none" ? "无人物模式，不生成人物面孔或演唱者。" : "保持已确认的人物身份。"}`,
        acceptance:
          "画面与已审核分镜一致；实际节拍、歌词与嘴型需要人工试听验收，静帧质检不能证明口型同步。",
      };
    },
  );
  return {
    documentsOnly: options.deliverable === "documents",
    manifest: JSON.stringify({
      schemaVersion: "music-video-plan.v1",
      project: { title: options.songName || "MV", aspectRatio: options.aspectRatio },
      song: state.song,
      timeline,
      shots: state.stages.prompts?.artifact?.shots ?? [],
    }),
    aspectRatio: options.aspectRatio,
    script: timelineMarkdown(timeline),
    storyboard: musicVideoDeliveryMarkdown(checkpoint),
    shots,
    decision,
  };
}

export interface MusicVideoWorkflowRunnerDependencies extends KnowledgeVideoWorkflowRunnerDependencies {
  readonly mvMediaClient: MvMediaClient;
}
export function createMusicVideoWorkflowRunner(
  overrides: Partial<MusicVideoWorkflowRunnerDependencies> = {},
) {
  const media = overrides.mvMediaClient ?? mvMediaClient;
  const plan = async (context: WorkflowPlanningContext): Promise<WorkflowPlan> => {
    const { request, dependencies } = context;
    const options = request.node.config.musicVideo;
    if (!options?.songPath.trim()) throw new Error("请先选择真实歌曲音频，歌词文本不能代替歌曲。");
    if (
      !/^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(options.aspectRatio) ||
      options.aspectRatio.split(":").some((part) => Number(part) <= 0)
    )
      throw new Error("MV 画幅必须是有效的宽高比。");
    if (!Number.isFinite(options.syncRatio) || options.syncRatio < 0 || options.syncRatio > 1)
      throw new Error("对口型建议比例必须为 0～1。");
    if (
      options.characterMode === "reference" &&
      (!options.characterReferences.length ||
        options.characterReferences.some((item) => item.kind !== "image" || !item.localPath.trim()))
    )
      throw new Error("参考人物模式必须选择真实人物参考图片。");
    const read = () => context.checkpoint().musicVideo ?? createMusicVideoCheckpoint();
    const update = (patch: Partial<MusicVideoWorkflowCheckpoint>) =>
      context.commit((current) => ({ ...current, musicVideo: { ...read(), ...patch } }));
    if (!read().song)
      update({ song: await media.probeSong(options.songPath), inputSignature: signature(request) });
    const song = read().song!;
    const duration = durationCapability(request);
    const args = (): MusicVideoParseContext => ({
      options,
      song,
      ...(duration ? { duration } : {}),
      ...(read().stages.timeline?.artifact?.timeline
        ? { timeline: read().stages.timeline!.artifact!.timeline! }
        : {}),
      ...(read().stages.style?.artifact?.style?.assets
        ? { assets: read().stages.style!.artifact!.style!.assets }
        : {}),
      ...(read().stages.storyboard?.artifact?.shots
        ? { storyboard: read().stages.storyboard!.artifact!.shots! }
        : {}),
    });
    let resolution = request.decisionResolution?.trim();
    const call = async <T>(
      mode: TextSkillMode,
      prompt: string,
      parse: (raw: string) => T,
      audioEvidence = false,
    ): Promise<T> => {
      let failure = "";
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (request.signal.aborted) throw new DOMException("已暂停", "AbortError");
        const result = await dependencies.promptClient.run({
          canvasId: CANVAS_ID,
          sourceNodeId: request.node.key,
          providerConnectionId: request.node.config.models.text.providerId,
          modelDefinitionId: request.node.config.models.text.modelDefinitionId,
          mode,
          task: "generate",
          userPrompt: `${prompt}${failure ? `\n上次输出无效：${failure}。不可通过切词、缩短歌词、虚构时间或跳过审核规避错误；无法解决请返回 needs_confirmation。` : ""}`,
          multimodalInputs: [
            ...(audioEvidence ? [songInput(options)] : []),
            ...options.characterReferences.map(({ localPath, displayName, kind, mimeType }) => ({
              localPath,
              displayName,
              kind,
              mimeType,
            })),
          ],
        });
        if (request.signal.aborted) throw new DOMException("已暂停", "AbortError");
        try {
          return parse(result.optimizedPrompt);
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
        }
      }
      throw new Error(failure);
    };
    for (const stage of MUSIC_VIDEO_STAGES) {
      const old = read().stages[stage] ?? emptyStage();
      if (isMusicVideoStageApproved(old)) continue;
      const save = (run: MusicVideoStageRun) =>
        update({ stages: { ...read().stages, [stage]: run } });
      if (
        old.artifact &&
        old.review?.result === "PASS" &&
        read().pending?.stage === stage &&
        resolution === MUSIC_VIDEO_APPROVAL
      ) {
        save({ ...old, approvedVersion: old.artifact.version });
        update({ pending: null });
        resolution = undefined;
        continue;
      }
      const feedback =
        read().pending?.stage === stage && resolution && resolution !== MUSIC_VIDEO_APPROVAL
          ? resolution
          : undefined;
      const prompt = `当前阶段：${stage}。真实歌曲：${JSON.stringify(song)}。用户要求：${request.node.config.brief}\n官方歌词（逐字保留重复句）：${options.officialLyrics || "未提供"}\n用户 LRC：${options.lrc || "未提供；必须读取所附真实歌曲，不得伪称已有 ASR 时间戳。产出的时间线需要用户试听审核。"}\n人物模式：${options.characterMode}；人物参考固定ID：${options.characterReferences.map((item, index) => `mv-character-${index + 1}=${item.displayName}`).join("；")}；建议对口型比例：${options.characterMode === "none" ? 0 : options.syncRatio}；视觉要求：${options.visualStyle}；画幅：${options.aspectRatio}。\n当前视频模型真实合法时长能力：${JSON.stringify(duration ?? "文档草案，不提交视频")}.\n已审核前序阶段：${JSON.stringify(read().stages)}\n${feedback ? `用户已确认的本阶段修改：${feedback}` : ""}\n仅输出当前阶段严格JSON。时间线从0完整覆盖${song.durationSeconds}秒，含前奏间奏尾奏。每项一个完整歌词行或多完整行的音乐窗口，禁止拆字和漏掉重复句。分镜和提示词窗口与已审核时间线逐项一致；视频生成时长选择项目合法时长且不少于窗口。过长完整歌词无法执行时明确要求修正时间标记或更换模型。无人物不得sync，sync只近中景且连续最多3段。音频参考仅引导，人工试听决定实际口型。`;
      if (!old.artifact || feedback) {
        let parsed: ReturnType<typeof parseMusicVideoStage>;
        if (stage === "timeline" && options.lrc.trim() && !feedback) {
          const timeline = parseMusicVideoLrc(options.lrc, song.durationSeconds);
          validateMusicVideoTimeline(timeline, song, options, duration);
          parsed = {
            artifact: {
              content: timelineMarkdown(timeline),
              inputSummary: "依据用户 LRC 边界与本地探测歌曲时长；仍需试听人工核对",
              timeline,
            },
            decision: null,
          };
        } else
          parsed = await call(
            STAGE_MODES[stage],
            prompt,
            (raw) => parseMusicVideoStage(raw, stage, args()),
            stage === "timeline" && !options.lrc.trim(),
          );
        if (parsed.decision) {
          update({ pending: { stage, step: "revision" } });
          return toPlan(read(), options, context.checkpoint(), parsed.decision);
        }
        const artifact: MusicVideoArtifact = {
          ...parsed.artifact!,
          version:
            Math.max(old.artifact?.version ?? 0, ...old.history.map((item) => item.version), 0) + 1,
          createdAt: dependencies.now(),
        };
        save({
          artifact,
          review: null,
          history: [...old.history, ...(old.artifact ? [old.artifact] : [])],
        });
      }
      let run = read().stages[stage]!;
      // Manual structural edits use the same constraints as model output before any new approval.
      parseMusicVideoStage(
        JSON.stringify({
          schemaVersion: "music-video-stage.v1",
          stage,
          status: "ready",
          decision: null,
          content: run.artifact!.content,
          inputSummary: run.artifact!.inputSummary,
          timeline: run.artifact!.timeline ?? [],
          style: run.artifact!.style ?? null,
          shots: run.artifact!.shots ?? [],
        }),
        stage,
        args(),
      );
      if (!run.review) {
        const review = await call(
          "music_video_review",
          `${prompt}\n待核对的当前产物：${JSON.stringify(run.artifact)}\n逐项检查原曲覆盖、歌词完整性、真实时窗、人物模式及项目模型能力。对无法从输入证明的实际口型标明需人工试听，不可据静帧宣称口型通过。`,
          parseComicDramaReview,
          stage === "timeline" && !options.lrc.trim(),
        );
        save({ ...run, review });
        run = read().stages[stage]!;
      }
      const passed = run.review!.result === "PASS";
      update({ pending: { stage, step: passed ? "approval" : "revision" } });
      return toPlan(read(), options, context.checkpoint(), {
        kind: "planning",
        question: `${MUSIC_VIDEO_STAGE_LABELS[stage]} v${run.artifact!.version}：${run.review!.report}\n请核对完整产物${stage === "timeline" ? "并试听每个歌词时间边界" : ""}，明确确认后才继续。`,
        recommendation: passed
          ? MUSIC_VIDEO_APPROVAL
          : (run.review!.repairInstructions ??
            run.review!.recommendation ??
            "请给出需要修改的具体内容"),
      });
    }
    update({ planningComplete: true, pending: null });
    const result = toPlan(read(), options, context.checkpoint());
    context.commit((current) => ({
      ...current,
      film: {
        ...createAiFilmCheckpoint(),
        assets: (read().stages.style?.artifact?.style?.assets ?? []).map((asset) => {
          const previous = current.film?.assets.find(
            (item) =>
              item.id === asset.id &&
              item.kind === asset.kind &&
              item.name === asset.name &&
              item.prompt === asset.prompt,
          );
          return previous ?? asset;
        }),
        shots: result.shots,
        planningComplete: true,
      },
    }));
    return result;
  };
  return createKnowledgeVideoWorkflowRunner(overrides, {
    title: "MV 音乐视频",
    plan,
    qcMode: "ai_film_qc",
    requiresMediaReview: true,
    forceComposition: true,
    validateMedia: (context) => {
      if (
        context
          .checkpoint()
          .musicVideo?.stages.prompts?.artifact?.shots?.some((shot) => shot.lipSync === "sync") &&
        !musicVideoSupportsAudioReference(context.request)
      )
        throw new Error(
          "所选项目视频模型的实际请求协议不支持参考音频，无法执行 sync 镜头。请改为画外歌词/无口型策略或选择支持音频参考的项目模型；不会提交资产或视频付费任务。",
        );
    },
    isPlanningComplete: (checkpoint) =>
      checkpoint.musicVideo?.planningComplete === true &&
      MUSIC_VIDEO_STAGES.every((stage) =>
        isMusicVideoStageApproved(checkpoint.musicVideo?.stages[stage]),
      ),
    initialize: (previous) => ({
      musicVideo: {
        ...createMusicVideoCheckpoint(),
        stages: Object.fromEntries(
          MUSIC_VIDEO_STAGES.map((stage) => {
            const run = previous.musicVideo?.stages[stage];
            return [
              stage,
              emptyStage([...(run?.history ?? []), ...(run?.artifact ? [run.artifact] : [])]),
            ];
          }),
        ),
      },
      film: createAiFilmCheckpoint(),
      documentsOnly: false,
    }),
    validateResume: async (request, checkpoint) => {
      const state = checkpoint.musicVideo;
      if (
        state &&
        !state.song &&
        !MUSIC_VIDEO_STAGES.some((stage) => state.stages[stage]?.artifact) &&
        !checkpoint.shots.length &&
        !Object.keys(checkpoint.shotRuns).length &&
        !checkpoint.film?.assets.length &&
        !checkpoint.coverImagePath &&
        !checkpoint.finalPath &&
        !checkpoint.activeCompositionJobId &&
        (!state.inputSignature || state.inputSignature === signature(request))
      ) {
        // The first local probe may fail or be interrupted before any authored or paid work exists.
        // Only this empty initialization is retryable without a frozen song identity.
        return;
      }
      if (!state?.song || state.inputSignature !== signature(request))
        throw new Error("MV 歌曲、歌词或制作设置已修改，请重新制作，避免复用旧内容。");
      const song = await media.probeSong(request.node.config.musicVideo!.songPath);
      if (
        song.sourceSignature !== state.song.sourceSignature ||
        Math.abs(song.durationSeconds - state.song.durationSeconds) > EPSILON
      )
        throw new Error("歌曲文件正文或时长已改变，请重新审核时间线，不能沿用同路径旧歌曲的任务。");
      const timeline = state.stages.timeline?.artifact?.timeline;
      if (timeline)
        validateMusicVideoTimeline(
          timeline,
          song,
          request.node.config.musicVideo,
          durationCapability(request),
        );
    },
    prepareShotMedia: async (context, shot): Promise<readonly ExplicitMediaInput[]> => {
      const state = context.checkpoint().musicVideo!;
      const window = state.stages.prompts?.artifact?.shots?.find((item) => item.id === shot.id);
      if (!window || !state.song) throw new Error("MV 镜头缺少已经审核的音乐窗口。");
      if (window.lipSync !== "sync") return [];
      const audio = await media.prepareAudioWindow(
        state.song.sourcePath,
        state.song.sourceSignature,
        { id: shot.id, startSeconds: window.startSeconds, endSeconds: window.endSeconds },
      );
      return [
        {
          target: { kind: "local_file", path: audio.path, mediaType: "audio" },
          role: "reference_audio",
          displayNameSnapshot: `原曲 ${window.startSeconds}–${window.endSeconds} 秒`,
          typePosition: 1,
          contentIndex: (shot.referenceAssetIds?.length ?? 0) + 1,
        },
      ];
    },
    startComposition: async (context, clips) => {
      const state = context.checkpoint().musicVideo!;
      if (!state.song) throw new Error("MV 缺少原曲身份。");
      const shots = state.stages.prompts?.artifact?.shots ?? [];
      const windows = clips.map(({ shot, path }) => {
        const source = shots.find((item) => item.id === shot.id);
        if (!source) throw new Error("MV 成片镜头与已审核音乐窗口不一致。");
        return {
          id: shot.id,
          source: path,
          startSeconds: source.startSeconds,
          endSeconds: source.endSeconds,
        };
      });
      return media.startComposition({
        songPath: state.song.sourcePath,
        sourceSignature: state.song.sourceSignature,
        windows,
        outputName: "MV-原曲完整交付",
      });
    },
    validateDelivery: async (context, finalPath) => {
      const alignment = await media.checkAlignment(
        finalPath,
        context.checkpoint().musicVideo?.song?.durationSeconds,
      );
      context.commit((current) => ({
        ...current,
        musicVideo: { ...current.musicVideo!, alignment },
      }));
      if (!alignment.aligned)
        throw new Error(
          "原曲与成片的真实音视频流时长不一致，请检查音乐窗口后重新合成；该检查不判断嘴型。",
        );
    },
  });
}
