import * as v from "valibot";

import { AI_FILM_STAGES, type AiFilmStage } from "./aiFilmWorkflowModel";
import { COMIC_DRAMA_STAGES, type ComicDramaStage } from "./comicDramaWorkflowModel";

/**
 * 工作流大模型结构化输出的统一 valibot schema。
 *
 * 设计原则：
 * - schema 只负责类型与结构校验（字段存在性、类型、枚举值、数组形态）；
 * - 业务规则（引用完整性、ID 唯一性、数值范围、阶段依赖顺序）保留在各 runner 的
 *   解析函数中，因为这些规则依赖上下文（knownAssets、expectedStage 等）。
 * - 所有 schema 使用 looseObject，允许模型输出额外字段（向前兼容）。
 */

// ---------- 通用子结构 ----------

/** 待用户确认的决定：所有工作流通用。 */
export const workflowDecisionSchema = v.looseObject({
  question: v.pipe(v.string(), v.nonEmpty("decision.question 不能为空")),
  recommendation: v.pipe(v.string(), v.nonEmpty("decision.recommendation 不能为空")),
});

/** 资产（角色/场景/道具）：影视与漫剧通用。 */
export const workflowAssetSchema = v.looseObject({
  id: v.pipe(v.string(), v.nonEmpty("asset.id 不能为空")),
  kind: v.picklist(["character", "scene", "prop"]),
  name: v.pipe(v.string(), v.nonEmpty("asset.name 不能为空")),
  prompt: v.pipe(v.string(), v.nonEmpty("asset.prompt 不能为空")),
});

/** 镜头基础结构：影视与漫剧通用，业务规则（时长范围、引用校验）在 runner 中补充。 */
export const workflowShotSchema = v.looseObject({
  id: v.pipe(v.string(), v.nonEmpty("shot.id 不能为空")),
  sceneId: v.pipe(v.string(), v.nonEmpty("shot.sceneId 不能为空")),
  title: v.pipe(v.string(), v.nonEmpty("shot.title 不能为空")),
  durationSeconds: v.number(),
  visual: v.pipe(v.string(), v.nonEmpty("shot.visual 不能为空")),
  dialogue: v.string(),
  videoPrompt: v.pipe(v.string(), v.nonEmpty("shot.videoPrompt 不能为空")),
  acceptance: v.array(v.pipe(v.string(), v.nonEmpty("shot.acceptance 不能为空"))),
  referenceAssetIds: v.array(v.string()),
});

/** 执行状态：ready = 直接产出，needs_confirmation = 需要用户确认。 */
export const workflowStatusSchema = v.picklist(["ready", "needs_confirmation"]);

// ---------- 影视工作流 ----------

export const aiFilmStageSchema = v.picklist(
  AI_FILM_STAGES as readonly [AiFilmStage, ...AiFilmStage[]],
);

/** 影视路由输出（parseAiFilmRoute）。 */
export const aiFilmRouteOutputSchema = v.looseObject({
  schemaVersion: v.literal("ai-film-route.v1"),
  status: workflowStatusSchema,
  decision: v.nullable(v.optional(workflowDecisionSchema)),
  mode: v.picklist(["full", "stage", "handoff", "revision"]),
  stages: v.array(aiFilmStageSchema),
  title: v.pipe(v.string(), v.nonEmpty("title 不能为空")),
  aspectRatio: v.pipe(v.string(), v.nonEmpty("aspectRatio 不能为空")),
  reason: v.pipe(v.string(), v.nonEmpty("reason 不能为空")),
});

/** 影视阶段输出（parseAiFilmStage）。assets/shots 仅在对应阶段出现，schema 不强制。 */
export const aiFilmStageOutputSchema = v.looseObject({
  schemaVersion: v.literal("ai-film-stage.v1"),
  stage: aiFilmStageSchema,
  status: workflowStatusSchema,
  decision: v.nullable(v.optional(workflowDecisionSchema)),
  content: v.string(),
  inputSummary: v.optional(v.string()),
  assets: v.optional(v.array(workflowAssetSchema)),
  shots: v.optional(v.array(workflowShotSchema)),
});

// ---------- 漫剧工作流 ----------

export const comicDramaStageSchema = v.picklist(
  COMIC_DRAMA_STAGES as readonly [ComicDramaStage, ...ComicDramaStage[]],
);

/** 漫剧阶段输出（parseComicDramaStage）。assets/shots 始终为数组，可能为空。 */
export const comicDramaStageOutputSchema = v.looseObject({
  schemaVersion: v.literal("comic-drama-stage.v1"),
  stage: comicDramaStageSchema,
  status: workflowStatusSchema,
  decision: v.nullable(v.optional(workflowDecisionSchema)),
  content: v.pipe(v.string(), v.nonEmpty("content 不能为空")),
  inputSummary: v.pipe(v.string(), v.nonEmpty("inputSummary 不能为空")),
  assets: v.array(workflowAssetSchema),
  shots: v.array(workflowShotSchema),
});

/** 漫剧审查输出（parseComicDramaReview）。 */
export const comicDramaReviewOutputSchema = v.looseObject({
  result: v.picklist(["PASS", "REVISE", "NEEDS_DECISION"]),
  report: v.pipe(v.string(), v.nonEmpty("report 不能为空")),
  repairInstructions: v.optional(v.string()),
  question: v.optional(v.string()),
  recommendation: v.optional(v.string()),
});

// ---------- 工具函数 ----------

/**
 * 从模型原始文本中解析 JSON：去除首尾 markdown 代码块标记后 JSON.parse。
 * 与各 runner 原有的 json()/parseJson() 逻辑一致，统一收敛到此处。
 */
export function parseModelJson(raw: string): unknown {
  const clean = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  return JSON.parse(clean) as unknown;
}

/**
 * valibot 校验失败时，将错误信息格式化为用户可读的中文消息。
 * 保留原始 issues 路径，便于定位模型输出的具体字段问题。
 */
export function formatValibotError(error: unknown): string {
  if (error instanceof Error && "issues" in error) {
    const issues = (error as { issues: Array<{ path?: Array<{ key: unknown }>; message: string }> })
      .issues;
    const messages = issues.map((issue) => {
      const path = issue.path?.map((p) => String(p.key)).join(".") ?? "(根)";
      return `${path}: ${issue.message}`;
    });
    return `模型输出结构校验失败：${messages.join("；")}`;
  }
  return `模型输出结构校验失败：${String(error)}`;
}
