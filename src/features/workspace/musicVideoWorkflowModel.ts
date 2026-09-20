import type { PickedPromptMaterial } from "../../lib/backend";
import type { MvMediaAlignment, MvSongProbe } from "../../lib/mvMedia";
import type { AiFilmAsset } from "./aiFilmWorkflowModel";
import type { KnowledgeVideoWorkflowCheckpoint } from "./workspaceModel";

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
  readonly alignment?: MvMediaAlignment;
}
export function createMusicVideoOptions(): MusicVideoWorkflowOptions {
  return {
    songPath: "",
    songName: "",
    officialLyrics: "",
    lrc: "",
    visualStyle: "",
    aspectRatio: "16:9",
    characterMode: "none",
    characterReferences: [],
    syncRatio: 0.45,
    deliverable: "video",
  };
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
  sections.push(
    "## 验收边界\n\n音频参考仅引导项目视频模型，未执行专用口型同步；实际唱词、嘴型与节拍必须预览人审。最终音轨使用用户提供的原曲母带。",
  );
  if (state.alignment)
    sections.push(
      `音视频流时长检查：${state.alignment.aligned ? "通过" : "未通过"}；音频 ${state.alignment.audioDurationSeconds}s / 视频 ${state.alignment.videoDurationSeconds}s。该检查不证明嘴型同步。`,
    );
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
        `\n\n流时长检查：${JSON.stringify(checkpoint.musicVideo?.alignment ?? "尚未合成检查")}\n仅检查真实流时长，不提供自动口型同步证据。`,
      mediaType: "text/markdown",
    },
  ];
}
