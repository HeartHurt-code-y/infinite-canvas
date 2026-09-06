import type {
  KnowledgeVideoWorkflowCheckpoint,
  KnowledgeVideoWorkflowShot,
} from "./workspaceModel";

export const AI_FILM_STAGES = [
  "synopsis",
  "characters",
  "worldbuilding",
  "treatment",
  "screenplay",
  "assets",
  "acting",
  "prompts",
] as const;

export type AiFilmStage = (typeof AI_FILM_STAGES)[number];
export const AI_FILM_STAGE_LABELS: Record<AiFilmStage, string> = {
  synopsis: "概念锚定",
  characters: "角色设定",
  worldbuilding: "世界观",
  treatment: "分场大纲",
  screenplay: "完整剧本",
  assets: "角色与场景资产",
  acting: "表演设计",
  prompts: "视频提示词",
};

export interface AiFilmWorkflowOptions {
  readonly entryStage: "auto" | AiFilmStage;
  readonly sourceText: string;
  readonly deliverable: "video" | "documents";
}

export interface AiFilmRoute {
  readonly mode: "full" | "stage" | "handoff" | "revision";
  readonly stages: readonly AiFilmStage[];
  readonly title: string;
  readonly aspectRatio: string;
  readonly reason: string;
}

export interface AiFilmArtifact {
  readonly stage: AiFilmStage;
  readonly version: number;
  readonly content: string;
  readonly inputSummary: string;
  readonly createdAt: number;
  readonly stale?: boolean;
}

export interface AiFilmAsset {
  readonly id: string;
  readonly kind: "character" | "scene" | "prop";
  readonly name: string;
  readonly prompt: string;
  readonly taskId?: string | null;
  readonly path?: string | null;
}

export interface AiFilmWorkflowCheckpoint {
  readonly route: AiFilmRoute | null;
  readonly artifacts: readonly AiFilmArtifact[];
  readonly history: readonly AiFilmArtifact[];
  readonly assets: readonly AiFilmAsset[];
  readonly completedStages: readonly AiFilmStage[];
  readonly pendingStage: AiFilmStage | "router" | null;
  readonly planningComplete: boolean;
  readonly shots?: readonly KnowledgeVideoWorkflowShot[];
}

export function createAiFilmWorkflowOptions(): AiFilmWorkflowOptions {
  return { entryStage: "auto", sourceText: "", deliverable: "video" };
}

export function createAiFilmCheckpoint(): AiFilmWorkflowCheckpoint {
  return {
    route: null,
    artifacts: [],
    history: [],
    assets: [],
    completedStages: [],
    pendingStage: null,
    planningComplete: false,
  };
}

export function currentAiFilmAssets(film?: AiFilmWorkflowCheckpoint): readonly AiFilmAsset[] {
  return film?.artifacts.find((artifact) => artifact.stage === "assets")?.stale
    ? []
    : (film?.assets ?? []);
}

export function aiFilmDeliveryMarkdown(checkpoint: KnowledgeVideoWorkflowCheckpoint): string {
  const film = checkpoint.film;
  if (!film) return "";
  const sections = [`# ${film.route?.title ?? "影视制作交付物"}`];
  for (const stage of AI_FILM_STAGES) {
    const artifact = film.artifacts.find((item) => item.stage === stage);
    if (!artifact) continue;
    sections.push(
      `## ${AI_FILM_STAGE_LABELS[stage]} · v${artifact.version}${artifact.stale ? "（待更新）" : ""}\n\n依据：${artifact.inputSummary}\n\n${artifact.content}`,
    );
  }
  const media = film.assets.filter((asset) => asset.path);
  if (media.length)
    sections.push(
      `## 本地资产\n\n${media.map((asset) => `- ${asset.name}：${asset.path}`).join("\n")}`,
    );
  if (checkpoint.finalPath) sections.push(`## 完整成片\n\n${checkpoint.finalPath}`);
  const reports = checkpoint.shots.flatMap((shot) => {
    const report = checkpoint.shotRuns[shot.id]?.qcReport;
    return report ? [`### ${shot.title}\n\n${report}`] : [];
  });
  if (reports.length) sections.push(`## 逐镜质检\n\n${reports.join("\n\n")}`);
  return `${sections.join("\n\n---\n\n")}\n`;
}
