import type { PickedPromptMaterial } from "../../lib/backend";
import type {
  MvAsrTranscript,
  MvLyricsAlignment,
  MvMediaAlignment,
  MvSongProbe,
} from "../../lib/mvMedia";
import type { AiFilmAsset } from "./aiFilmWorkflowModel";
import type { WorkflowRequirement, WorkflowRequirements } from "./workflowFieldRequirements";
import type { KnowledgeVideoWorkflowCheckpoint } from "./workspaceModel";
import { stableJsonSignature } from "../../lib/workflowSignatures";

export const MUSIC_VIDEO_STAGES = ["timeline", "style", "storyboard", "prompts"] as const;
export type MusicVideoStage = (typeof MUSIC_VIDEO_STAGES)[number];
export const MUSIC_VIDEO_STAGE_LABELS: Record<MusicVideoStage, string> = {
  timeline: "歌曲时间线",
  style: "视觉风格与人物",
  storyboard: "逐段分镜",
  prompts: "视频执行提示词",
};
export const MUSIC_VIDEO_APPROVAL = "确认通过，继续下一阶段";
export interface MusicVideoWorkflowOptions {
  readonly songPath: string;
  readonly songName: string;
  readonly officialLyrics: string;
  readonly lrc: string;
  /** Absent in older documents, which retain their manually reviewed timeline. */
  readonly speechAnalysisMode?: "automatic" | "manual";
  /** Dedicated Doubao Voice connection; Ark model credentials are not interchangeable. */
  readonly speechProviderConnectionId?: string;
  readonly visualStyle: string;
  readonly aspectRatio: string;
  readonly characterMode: "reference" | "generate" | "none";
  readonly characterReferences: readonly PickedPromptMaterial[];
  readonly syncRatio: number;
  readonly deliverable: "video" | "documents";
}
export interface MusicVideoTimelineSegment {
  readonly id: string;
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly kind: "vocal" | "instrumental";
  readonly text: string;
  readonly section: string;
}
export interface MusicVideoStyle {
  readonly description: string;
  readonly assets: readonly AiFilmAsset[];
}
export interface MusicVideoShot {
  readonly id: string;
  readonly segmentId: string;
  readonly title: string;
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly durationSeconds: number;
  readonly framing: "close" | "medium" | "wide";
  readonly lipSync: "sync" | "offscreen" | "none";
  readonly visual: string;
  readonly videoPrompt: string;
  readonly referenceAssetIds: readonly string[];
}
export interface MusicVideoReview {
  readonly result: "PASS" | "REVISE" | "NEEDS_DECISION";
  readonly report: string;
  readonly repairInstructions?: string;
  readonly question?: string;
  readonly recommendation?: string;
}
export interface MusicVideoArtifact {
  readonly version: number;
  readonly content: string;
  readonly inputSummary: string;
  readonly createdAt: number;
  readonly timeline?: readonly MusicVideoTimelineSegment[];
  readonly style?: MusicVideoStyle;
  readonly shots?: readonly MusicVideoShot[];
}
export interface MusicVideoStageRun {
  readonly artifact: MusicVideoArtifact | null;
  readonly review: MusicVideoReview | null;
  readonly approvedVersion?: number;
  readonly history: readonly MusicVideoArtifact[];
}
export interface MusicVideoWorkflowCheckpoint {
  readonly inputSignature?: string;
  readonly song: MvSongProbe | null;
  readonly stages: Partial<Record<MusicVideoStage, MusicVideoStageRun>>;
  readonly pending: {
    readonly stage: MusicVideoStage;
    readonly step: "approval" | "revision";
  } | null;
  readonly planningComplete: boolean;
  readonly speech?: {
    readonly asr?: MvAsrTranscript;
    readonly forcedAlignment?: MvLyricsAlignment;
    readonly alignedLyrics?: string;
    readonly lyricsSource?: "official" | "lrc" | "asr";
  };
  readonly alignment?: MvMediaAlignment;
  readonly lipReviews?: Readonly<Record<string, MusicVideoLipReview>>;
}
export interface MusicVideoLipReview {
  readonly decision: "approved" | "rejected";
  readonly signature: string;
  readonly clipSignature: string;
  readonly reviewedAt: number;
  readonly note: string;
}
export function musicVideoLipReviewSignature(
  checkpoint: KnowledgeVideoWorkflowCheckpoint,
  shotId: string,
  clipSignature: string,
): string {
  const state = checkpoint.musicVideo;
  const shot = state?.stages.prompts?.artifact?.shots?.find((item) => item.id === shotId);
  const clipPath = checkpoint.shotRuns[shotId]?.clipPath;
  if (!state?.song || !shot || shot.lipSync !== "sync" || !clipPath)
    throw new Error("口型审核缺少当前正面演唱镜头、片段或原曲身份。");
  if (!/^[a-f0-9]{64}$/.test(clipSignature))
    throw new Error("口型审核需要当前片段正文的 SHA-256。");
  return stableJsonSignature({
    runId: checkpoint.runId,
    songSignature: state.song.sourceSignature,
    shot,
    clipPath,
    clipSignature,
  });
}
export function setMusicVideoLipReview(
  checkpoint: KnowledgeVideoWorkflowCheckpoint,
  shotId: string,
  decision: MusicVideoLipReview["decision"],
  clipSignature: string,
  note = "",
  reviewedAt = Date.now(),
): KnowledgeVideoWorkflowCheckpoint {
  if (decision !== "approved" && decision !== "rejected") throw new Error("无效的口型审核决定。");
  const signature = musicVideoLipReviewSignature(checkpoint, shotId, clipSignature);
  return {
    ...checkpoint,
    musicVideo: {
      ...checkpoint.musicVideo!,
      lipReviews: {
        ...checkpoint.musicVideo?.lipReviews,
        [shotId]: { decision, signature, clipSignature, reviewedAt, note: note.trim() },
      },
    },
  };
}
export function musicVideoSpeechAnalysisMode(
  options: MusicVideoWorkflowOptions,
): "automatic" | "manual" {
  return options.deliverable === "video" ? "automatic" : (options.speechAnalysisMode ?? "manual");
}
export function createMusicVideoOptions(): MusicVideoWorkflowOptions {
  return {
    songPath: "",
    songName: "",
    officialLyrics: "",
    lrc: "",
    speechAnalysisMode: "automatic",
    speechProviderConnectionId: "",
    visualStyle: "",
    aspectRatio: "16:9",
    characterMode: "none",
    characterReferences: [],
    syncRatio: 0.45,
    deliverable: "video",
  };
}

/**
 * MV 的必填边界：只有「缺了就一定做不出结果、而且无法推断」的输入才算必填。
 *
 * - 原曲文件：时间线、分镜、成片全部以真实音频为准，歌词文本替代不了（运行器会直接拒绝）。
 * - 人物参考图：只在用户主动选择「使用人物参考图」时才成为硬输入；选「生成固定人物」
 *   或「无固定人物」都不需要，所以这里按模式条件判断。
 *
 * 其余参数（视觉风格、画幅、人物模式、交付方式、正面演唱占比、声学分析方式、豆包语音
 * 连接）都有推荐默认值或由工作流自动决定，一律选填，避免给小白用户增加负担。
 * 「豆包语音连接」在成片模式下是运行器的硬性依赖，但它是项目凭据配置而非内容输入，
 * 与模型槽位一样只标红、不进缺口清单，避免把「去别的页面配凭据」混进「还差几项内容」。
 */
export function musicVideoRequirements(options: MusicVideoWorkflowOptions): WorkflowRequirements {
  const requirements: WorkflowRequirement[] = [];
  if (!options.songPath.trim())
    requirements.push({
      field: "歌曲文件",
      hint: "点「选择歌曲」导入完整原曲音频；歌词文本不能代替歌曲，时间线与成片都以它为准。",
    });
  if (options.characterMode === "reference" && options.characterReferences.length === 0)
    requirements.push({
      field: "人物参考图",
      hint: "当前是「使用人物参考图」模式，添加至少一张人物图；也可把人物模式改为「生成固定人物」，由工作流自动设定人物。",
    });
  return requirements;
}

/** 节点与运行器共用的输入门槛，与界面缺口清单同源，避免「界面说齐了、点下去报无效」。 */
export function musicVideoInputReady(options: MusicVideoWorkflowOptions): boolean {
  return musicVideoRequirements(options).length === 0;
}

export function createMusicVideoCheckpoint(): MusicVideoWorkflowCheckpoint {
  return { song: null, stages: {}, pending: null, planningComplete: false };
}
export function isMusicVideoStageApproved(run: MusicVideoStageRun | undefined): boolean {
  return (
    !!run?.artifact && run.review?.result === "PASS" && run.approvedVersion === run.artifact.version
  );
}

/** Editing an upstream deliverable invalidates every dependent draft and approval. */
export function patchMusicVideoArtifact(
  checkpoint: KnowledgeVideoWorkflowCheckpoint,
  stage: MusicVideoStage,
  patch: Partial<MusicVideoArtifact>,
): KnowledgeVideoWorkflowCheckpoint {
  const state = checkpoint.musicVideo;
  const previous = state?.stages[stage];
  if (!state || !previous?.artifact) return checkpoint;
  const stages = { ...state.stages };
  stages[stage] = {
    artifact: {
      ...previous.artifact,
      ...patch,
      version: previous.artifact.version + 1,
      createdAt: Date.now(),
    },
    review: null,
    history: [...previous.history, previous.artifact],
  };
  for (const downstream of MUSIC_VIDEO_STAGES.slice(MUSIC_VIDEO_STAGES.indexOf(stage) + 1)) {
    const old = stages[downstream];
    if (old)
      stages[downstream] = {
        artifact: null,
        review: null,
        history: [...old.history, ...(old.artifact ? [old.artifact] : [])],
      };
  }
  const nextState = { ...state };
  delete nextState.alignment;
  delete nextState.lipReviews;
  return {
    ...checkpoint,
    phase: "paused",
    approvedPlanRevision: null,
    mediaApprovals: {},
    finalPath: null,
    activeCompositionJobId: null,
    ...(checkpoint.executionPlan
      ? { executionPlan: { ...checkpoint.executionPlan, approval: null } }
      : {}),
    musicVideo: {
      ...nextState,
      stages,
      pending: { stage, step: "approval" },
      planningComplete: false,
    },
    shotRuns: Object.fromEntries(
      Object.entries(checkpoint.shotRuns).map(([id, run]) => [id, { ...run, promptEdited: true }]),
    ),
  };
}

export function musicVideoDeliveryMarkdown(checkpoint: KnowledgeVideoWorkflowCheckpoint): string {
  const state = checkpoint.musicVideo;
  if (!state) return "";
  const sections = [
    "# MV 制作交付",
    `歌曲：${state.song?.sourcePath ?? "未读取"}\n时长：${state.song?.durationSeconds ?? "待核验"} 秒`,
  ];
  for (const stage of MUSIC_VIDEO_STAGES) {
    const run = state.stages[stage];
    if (!run?.artifact) continue;
    sections.push(
      `## ${MUSIC_VIDEO_STAGE_LABELS[stage]} · v${run.artifact.version}\n\n${run.artifact.content}\n\n审核：${run.review?.report ?? "待检查"}\n人审：${isMusicVideoStageApproved(run) ? "已确认当前稿" : "待确认"}`,
    );
  }
  const speech = state.speech;
  sections.push("## 歌曲声学分析");
  if (speech?.asr)
    sections.push(
      `专用 ASR：${speech.asr.engine} ${speech.asr.modelVersion}；歌曲 SHA-256：${speech.asr.sourceSignature}。\n识别正文：${speech.asr.transcript || "无可辨识唱词"}`,
    );
  else sections.push("未取得专用 ASR 结果；手工歌词或文本模型推测不算自动识别。");
  if (speech?.forcedAlignment)
    sections.push(
      `强制对齐：${speech.forcedAlignment.engine} ${speech.forcedAlignment.modelVersion}；歌词来源：${speech.lyricsSource ?? "未知"}；逐行时间：\n${speech.forcedAlignment.lines.map((line) => `- ${line.startSeconds.toFixed(3)}–${line.endSeconds.toFixed(3)}s ${line.text}`).join("\n")}`,
    );
  else sections.push("未取得声学强制对齐结果；时间线仍需人工试听核对。");
  if (state.alignment)
    sections.push(
      `音视频流时长检查：${state.alignment.aligned ? "通过" : "未通过"}；音频 ${state.alignment.audioDurationSeconds}s / 视频 ${state.alignment.videoDurationSeconds}s。`,
    );
  const syncShots =
    state.stages.prompts?.artifact?.shots?.filter((shot) => shot.lipSync === "sync") ?? [];
  if (syncShots.length) {
    sections.push("## 逐镜口型人工验收");
    sections.push("当前未接入可测量既有视频唇音偏移的自动检测服务；人工审核不等于自动口型验证。");
    sections.push(
      syncShots
        .map((shot) => {
          const review = state.lipReviews?.[shot.id];
          const decisionLabel =
            review?.decision === "approved"
              ? "人工选用"
              : review?.decision === "rejected"
                ? "人工驳回"
                : "待人工验收";
          // 空备注与缺备注都归一为「无备注」，因此需要真值判断而不是 ??（?? 会放行空串）。
          const noteLabel = review?.note ? review.note : "无备注";
          return `- ${shot.id} ${shot.startSeconds.toFixed(3)}–${shot.endSeconds.toFixed(3)}s：${decisionLabel}；${noteLabel}`;
        })
        .join("\n"),
    );
  } else sections.push("未安排正面演唱镜头，无口型验收目标。");
  sections.push("最终音轨使用用户提供的原曲母带；最终交付仍需用户预览确认。");
  if (checkpoint.finalPath) sections.push(`成片：${checkpoint.finalPath}`);
  return sections.join("\n\n");
}
export function musicVideoDeliveryBundle(
  checkpoint: KnowledgeVideoWorkflowCheckpoint,
): readonly { fileName: string; content: string; mediaType: string }[] {
  const timeline = checkpoint.musicVideo?.stages.timeline?.artifact?.timeline ?? [];
  const time = (seconds: number) => {
    const centiseconds = Math.round(seconds * 100);
    return `${String(Math.floor(centiseconds / 6000)).padStart(2, "0")}:${String(Math.floor(centiseconds / 100) % 60).padStart(2, "0")}.${String(centiseconds % 100).padStart(2, "0")}`;
  };
  return [
    {
      fileName: "歌曲时间线.json",
      content: JSON.stringify({ song: checkpoint.musicVideo?.song, timeline }, null, 2),
      mediaType: "application/json",
    },
    {
      fileName: "审核歌词.lrc",
      content: timeline
        .map(
          (segment) =>
            `[${time(segment.startSeconds)}]${segment.kind === "instrumental" ? "[Instrumental]" : segment.text}`,
        )
        .join("\n"),
      mediaType: "text/plain",
    },
    {
      fileName: "分镜与执行提示词.md",
      content: musicVideoDeliveryMarkdown(checkpoint),
      mediaType: "text/markdown",
    },
    {
      fileName: "审核与对齐报告.md",
      content:
        MUSIC_VIDEO_STAGES.map(
          (stage) =>
            `## ${MUSIC_VIDEO_STAGE_LABELS[stage]}\n\n${checkpoint.musicVideo?.stages[stage]?.review?.report ?? "待检查"}\n人审：${isMusicVideoStageApproved(checkpoint.musicVideo?.stages[stage]) ? "已确认" : "待确认"}`,
        ).join("\n\n") +
        `\n\n声学分析：${JSON.stringify(checkpoint.musicVideo?.speech ?? "未执行")}\n流时长检查：${JSON.stringify(checkpoint.musicVideo?.alignment ?? "尚未合成检查")}\n逐镜人工口型审核：${JSON.stringify(checkpoint.musicVideo?.lipReviews ?? "未审核")}\n自动口型检测：未接入，不能宣称自动通过。`,
      mediaType: "text/markdown",
    },
  ];
}
