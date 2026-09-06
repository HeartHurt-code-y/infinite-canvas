import type { AiFilmAsset } from "./aiFilmWorkflowModel";
import type {
  KnowledgeVideoWorkflowCheckpoint,
  KnowledgeVideoWorkflowShot,
} from "./workspaceModel";

export const COMIC_DRAMA_STAGES = ["director", "art", "storyboard"] as const;
export type ComicDramaStage = (typeof COMIC_DRAMA_STAGES)[number];
export const COMIC_DRAMA_STAGE_LABELS: Record<ComicDramaStage, string> = {
  director: "导演分析",
  art: "服化道设计",
  storyboard: "分镜编写",
};
export interface ComicDramaEpisode {
  readonly id: string;
  readonly title: string;
  readonly script: string;
}
export interface ComicDramaWorkflowOptions {
  readonly episodes: readonly ComicDramaEpisode[];
  readonly visualStyle: string;
  readonly aspectRatio: string;
  readonly deliverable: "video" | "documents";
}
export interface ComicDramaReview {
  readonly result: "PASS" | "REVISE" | "NEEDS_DECISION";
  readonly report: string;
  readonly repairInstructions?: string;
  readonly question?: string;
  readonly recommendation?: string;
}
export interface ComicDramaArtifact {
  readonly content: string;
  readonly inputSummary: string;
  readonly version: number;
  readonly createdAt: number;
  readonly assets: readonly AiFilmAsset[];
  readonly shots: readonly KnowledgeVideoWorkflowShot[];
}
export interface ComicDramaStageRun {
  readonly artifact: ComicDramaArtifact | null;
  readonly businessReview: ComicDramaReview | null;
  readonly contentReview: ComicDramaReview | null;
  readonly passed: boolean;
  readonly repairCount: number;
  readonly history: readonly ComicDramaArtifact[];
}
export interface ComicDramaEpisodeRun {
  readonly id: string;
  readonly title: string;
  readonly script: string;
  readonly stages: Partial<Record<ComicDramaStage, ComicDramaStageRun>>;
}
export interface ComicDramaWorkflowCheckpoint {
  readonly inputSignature?: string;
  readonly episodes: readonly ComicDramaEpisodeRun[];
  readonly sharedAssets: readonly AiFilmAsset[];
  readonly pending: {
    readonly episodeId: string;
    readonly stage: ComicDramaStage;
    readonly step: "generation" | "review";
  } | null;
  readonly planningComplete: boolean;
}
export function createComicDramaOptions(): ComicDramaWorkflowOptions {
  return {
    episodes: [{ id: "ep01", title: "第 1 集", script: "" }],
    visualStyle: "国漫风格，角色造型稳定，电影感光影",
    aspectRatio: "9:16",
    deliverable: "video",
  };
}
export function createComicDramaCheckpoint(): ComicDramaWorkflowCheckpoint {
  return { episodes: [], sharedAssets: [], pending: null, planningComplete: false };
}
export function comicDramaDeliveryMarkdown(checkpoint: KnowledgeVideoWorkflowCheckpoint): string {
  const drama = checkpoint.comicDrama;
  if (!drama) return "";
  const sections = ["# 漫剧制作交付文档"];
  for (const episode of drama.episodes) {
    sections.push(`## ${episode.title}（${episode.id}）`);
    for (const stage of COMIC_DRAMA_STAGES) {
      const run = episode.stages[stage];
      if (!run?.artifact) continue;
      sections.push(
        `### ${COMIC_DRAMA_STAGE_LABELS[stage]} · v${run.artifact.version}${run.passed ? "" : "（待修订）"}\n\n依据：${run.artifact.inputSummary}\n\n${run.artifact.content}`,
      );
      sections.push(
        `业务检查：${run.businessReview?.report ?? "待检查"}\n\n内容检查：${run.contentReview?.report ?? "待检查"}`,
      );
    }
  }
  const assets = checkpoint.film?.assets.length ? checkpoint.film.assets : drama.sharedAssets;
  if (assets.length)
    sections.push(
      `## 跨集共享资产\n\n${assets.map((asset) => `### ${asset.id} · ${asset.name}\n\n${asset.prompt}${asset.path ? `\n\n本地文件：${asset.path}` : ""}`).join("\n\n")}`,
    );
  if (checkpoint.finalPath) sections.push(`## 完整成片\n\n${checkpoint.finalPath}`);
  return `${sections.join("\n\n---\n\n")}\n`;
}
