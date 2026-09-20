import type { AiFilmAsset } from "./aiFilmWorkflowModel";
import type {
  KnowledgeVideoWorkflowCheckpoint,
  KnowledgeVideoWorkflowShot,
} from "./workspaceModel";

export const COMIC_DRAMA_STAGES = ["screenplay", "style", "art", "director", "storyboard"] as const;
export type ComicDramaStage = (typeof COMIC_DRAMA_STAGES)[number];
export const COMIC_DRAMA_STAGE_LABELS: Record<ComicDramaStage, string> = {
  screenplay: "剧本共创",
  style: "风格锁定",
  director: "导演分镜",
  art: "服化道设计",
  storyboard: "执行提示词",
};
export function comicDramaStageDependencies(episodes: readonly ComicDramaEpisode[]) {
  return episodes.flatMap((episode, episodeIndex) =>
    COMIC_DRAMA_STAGES.map((stage, stageIndex) => ({
      id: `${episode.id}:${stage}`,
      episodeId: episode.id,
      episodeIndex,
      stage,
      stageIndex,
      dependsOn:
        stageIndex > 0
          ? [`${episode.id}:${COMIC_DRAMA_STAGES[stageIndex - 1]}`]
          : episodeIndex > 0
            ? [`${episodes[episodeIndex - 1]!.id}:storyboard`]
            : [],
    })),
  );
}
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
  readonly approvedVersion?: number;
  readonly approvals?: readonly {
    readonly version: number;
    readonly approvedAt: number;
    readonly note: string;
  }[];
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
    readonly step: "generation" | "review" | "approval";
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
      sections.push(
        `人工审核：${run.approvedVersion === run.artifact.version ? `已批准 v${run.approvedVersion}` : "当前版本待确认"}`,
      );
      for (const version of run.history)
        sections.push(
          `#### 历史 v${version.version}\n\n依据：${version.inputSummary}\n\n${version.content}`,
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

export interface ComicDramaDeliveryFile {
  readonly fileName: string;
  readonly content: string;
  readonly mediaType: "text/markdown" | "text/html";
}

/** Four self-contained, provider-neutral deliverables; every status comes from this run. */
export function comicDramaDeliveryBundle(
  checkpoint: KnowledgeVideoWorkflowCheckpoint,
): readonly ComicDramaDeliveryFile[] {
  const drama = checkpoint.comicDrama;
  if (!drama?.episodes.length) return [];
  const escape = (value: string) =>
    value.replace(
      /[&<>"']/g,
      (character) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
    );
  const title = drama.episodes.map((episode) => episode.title).join(" · ");
  const html = (label: string, body: string) =>
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · ${label}</title><style>body{max-width:1100px;margin:40px auto;padding:0 24px;font-family:system-ui;line-height:1.7;background:#151718;color:#e7e9e9}table{border-collapse:collapse;width:100%}th,td{padding:10px;border-bottom:1px solid #424648;text-align:left}pre{white-space:pre-wrap;overflow-wrap:anywhere}small{color:#adb5b8}section{margin:28px 0}h1,h2{line-height:1.35}</style><h1>${escape(title)} · ${label}</h1>${body}</html>`;
  const timeline = drama.episodes.flatMap((episode) =>
    COMIC_DRAMA_STAGES.map((stage) => {
      const run = episode.stages[stage];
      return { episode, stage, run };
    }),
  );
  const checks = timeline
    .map(
      ({ episode, stage, run }) =>
        `<section><h2>${escape(episode.title)} · ${COMIC_DRAMA_STAGE_LABELS[stage]}${run?.artifact ? ` v${run.artifact.version}` : ""}</h2><p>业务检查：${escape(run?.businessReview?.report ?? "未执行")}<br>内容检查：${escape(run?.contentReview?.report ?? "未执行")}<br>人工审核：${run?.artifact && run.approvedVersion === run.artifact.version ? "当前版本已批准" : "当前版本未批准"}</p><pre>${escape(run?.artifact?.content ?? "尚无成果")}</pre></section>`,
    )
    .join("");
  const rows = checkpoint.shots
    .map((shot) => {
      const run = checkpoint.shotRuns[shot.id];
      return `<tr><td>${escape(shot.id)}</td><td>${escape(shot.title)}</td><td>${shot.durationSeconds} 秒（计划）</td><td>${escape(run?.qcReport ?? "尚未检查")}</td><td>${escape(run?.clipPath ?? "未生成")}</td></tr>`;
    })
    .join("");
  const report = [
    `# ${title} · 成片报告`,
    `运行：${checkpoint.runId ?? "尚未建立"}`,
    `状态：${checkpoint.phase}`,
    `镜头数：${checkpoint.shots.length}`,
    `计划时长：${checkpoint.shots.reduce((sum, shot) => sum + shot.durationSeconds, 0)} 秒（计划值，非媒体实测）`,
    `完整成片：${checkpoint.finalPath ?? "尚未生成"}`,
    "音色：本工作流提供角色音色设计文档；未调用专用语音合成能力。",
    "费用与生成耗时：以项目生成任务历史的实际供应商记录为准，本报告不估算或套用来源平台价格。",
    ...checkpoint.shots.map(
      (shot) =>
        `## ${shot.id} · ${shot.title}\n\n${checkpoint.shotRuns[shot.id]?.qcReport ?? "尚未检查"}\n\n文件：${checkpoint.shotRuns[shot.id]?.clipPath ?? "未生成"}`,
    ),
  ].join("\n\n");
  const overview = `<p>运行：${escape(checkpoint.runId ?? "尚未建立")} · ${drama.episodes.length} 集 · ${checkpoint.shots.length} 镜头 · 状态：${escape(checkpoint.phase)}</p><table><thead><tr><th>剧集</th><th>阶段</th><th>版本</th><th>审核</th></tr></thead><tbody>${timeline.map(({ episode, stage, run }) => `<tr><td>${escape(episode.title)}</td><td>${COMIC_DRAMA_STAGE_LABELS[stage]}</td><td>${run?.artifact?.version ?? "未生成"}</td><td>${run?.artifact && run.approvedVersion === run.artifact.version ? "用户已批准" : "未批准"}</td></tr>`).join("")}</tbody></table><h2>媒体审核</h2><pre>${escape(JSON.stringify(checkpoint.mediaApprovals ?? {}, null, 2))}</pre><h2>逐镜总表</h2><table><thead><tr><th>镜头</th><th>标题</th><th>计划时长</th><th>质检</th><th>本地文件</th></tr></thead><tbody>${rows}</tbody></table><h2>成片</h2><pre>${escape(checkpoint.finalPath ?? "尚未生成")}</pre><p>费用、实际耗时与实测尺寸未随检查点提供时不推断。完整任务记录保存在项目工作流历史。</p>`;
  return [
    {
      fileName: "01-分镜与制作文档.md",
      mediaType: "text/markdown",
      content: comicDramaDeliveryMarkdown(checkpoint),
    },
    { fileName: "02-审核记录.html", mediaType: "text/html", content: html("审核记录", checks) },
    { fileName: "03-成片报告.md", mediaType: "text/markdown", content: report },
    { fileName: "04-全链总览.html", mediaType: "text/html", content: html("全链总览", overview) },
  ];
}
