import type { PickedPromptMaterial } from "../../lib/backend";
import type { AiFilmAsset } from "./aiFilmWorkflowModel";
import {
  requirementsMet,
  type WorkflowRequirement,
  type WorkflowRequirements,
} from "./workflowFieldRequirements";
import type {
  KnowledgeVideoWorkflowCheckpoint,
  KnowledgeVideoWorkflowShot,
} from "./workspaceModel";

export const COMMERCE_STAGES = ["research", "creative", "script", "storyboard", "assets"] as const;
export type CommerceStage = (typeof COMMERCE_STAGES)[number] | "quick";
export const COMMERCE_STAGE_LABELS: Record<CommerceStage, string> = {
  research: "产品研究",
  creative: "剧情创意",
  script: "带货剧本",
  storyboard: "分镜与视频提示词",
  assets: "一致性资产",
  quick: "15 秒四镜头剧情",
};
export const COMMERCE_STORY_TYPES = [
  "智能推荐",
  "现代闺蜜反差",
  "古装宫斗",
  "古装宅斗",
  "穿越反转",
  "魔幻漫剧",
  "国风仙侠",
  "职场救场",
  "情侣误会",
  "家庭轻喜剧",
  "宿舍日常",
  "悬疑揭秘",
  "挑战测评",
  "身份反转",
  "赛博未来",
  "无对白视觉流",
] as const;
export interface CommerceWorkflowOptions {
  readonly mode: "quick" | "full";
  readonly storyType: string;
  readonly productName: string;
  readonly productUrl: string;
  readonly productFacts: string;
  readonly audience: string;
  readonly materials: readonly PickedPromptMaterial[];
  readonly aspectRatio: string;
  readonly deliverable: "video" | "documents";
}
export interface CommerceSource {
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly status: "fetched" | "failed";
  readonly error?: string | null;
}
export interface CommerceFact {
  readonly id: string;
  readonly claim: string;
  readonly basis: "user" | "source" | "packaging" | "unverified";
  readonly sourceUrls: readonly string[];
}
export interface CommerceArtifact {
  readonly stage: CommerceStage;
  readonly content: string;
  readonly inputSummary: string;
  readonly version: number;
  readonly createdAt: number;
  readonly assets: readonly AiFilmAsset[];
  readonly shots: readonly KnowledgeVideoWorkflowShot[];
  readonly facts: readonly CommerceFact[];
}
export interface CommerceReview {
  readonly result: "PASS" | "REVISE" | "NEEDS_DECISION";
  readonly report: string;
  readonly repairInstructions?: string;
  readonly question?: string;
  readonly recommendation?: string;
}
export interface CommerceStageRun {
  readonly artifact: CommerceArtifact | null;
  readonly review: CommerceReview | null;
  readonly repairCount: number;
  readonly history: readonly CommerceArtifact[];
}
export interface CommerceWorkflowCheckpoint {
  readonly inputSignature?: string;
  readonly stages: Readonly<Partial<Record<CommerceStage, CommerceStageRun>>>;
  readonly sources: readonly CommerceSource[] | null;
  readonly sharedAssets: readonly AiFilmAsset[];
  readonly pending: CommerceStage | null;
  readonly planningComplete: boolean;
}
export function createCommerceOptions(): CommerceWorkflowOptions {
  return {
    mode: "quick",
    storyType: "智能推荐",
    productName: "",
    productUrl: "",
    productFacts: "",
    audience: "",
    materials: [],
    aspectRatio: "9:16",
    deliverable: "video",
  };
}
export function createCommerceCheckpoint(): CommerceWorkflowCheckpoint {
  return { stages: {}, sources: null, sharedAssets: [], pending: null, planningComplete: false };
}
/**
 * 剧情带货尚缺的必填项。
 *
 * 只有两件事真的做不出来：**一点商品信息都没有**（模型无从下笔），以及
 * **选了「制作完整成片」却没有真实商品图**（生成图不能凭空造商品外观，商品
 * 必须有实物依据）。名称、卖点、链接、图片/文档四选一即可，不必样样齐；
 * 选「仅制作文档与提示词」时只需要文字，不需要图。
 */
export function commerceRequirements(options: CommerceWorkflowOptions): WorkflowRequirements {
  const requirements: WorkflowRequirement[] = [];
  const hasProductInfo = Boolean(
    options.productName.trim() ||
    options.productFacts.trim() ||
    options.productUrl.trim() ||
    options.materials.length,
  );
  if (!hasProductInfo)
    requirements.push({
      field: "商品资料",
      hint: "填写商品名称、商品事实与卖点，或添加商品图片/资料文档，任选其一即可。",
    });
  if (
    options.deliverable !== "documents" &&
    !options.materials.some((item) => item.kind === "image")
  )
    requirements.push({
      field: "真实商品图",
      hint: "在下方「商品图片与文档」里添加一张真实商品图片；若只想先拿到脚本与提示词，可把交付方式改为「仅制作文档与提示词」。",
    });
  return requirements;
}
export function commerceInputReady(options: CommerceWorkflowOptions): boolean {
  return requirementsMet(commerceRequirements(options));
}
export function commerceDeliveryMarkdown(checkpoint: KnowledgeVideoWorkflowCheckpoint): string {
  const commerce = checkpoint.commerce;
  if (!commerce) return "";
  const sections = ["# 剧情带货制作交付物"];
  for (const stage of ["quick", ...COMMERCE_STAGES] as const) {
    const run = commerce.stages[stage];
    if (!run?.artifact) continue;
    const artifact = run.artifact;
    sections.push(
      `## ${COMMERCE_STAGE_LABELS[stage]} · v${artifact.version}\n\n依据：${artifact.inputSummary}\n\n${artifact.content}`,
    );
    if (artifact.facts.length)
      sections.push(
        `### 产品事实台账\n\n${artifact.facts.map((fact) => `- ${fact.id} [${fact.basis}] ${fact.claim}${fact.sourceUrls.length ? `（${fact.sourceUrls.join("，")}）` : ""}`).join("\n")}`,
      );
    if (run.review) sections.push(`### 检查：${run.review.result}\n\n${run.review.report}`);
    for (const old of run.history) sections.push(`### 历史版本 v${old.version}\n\n${old.content}`);
  }
  if (commerce.sources?.length)
    sections.push(
      `## 来源读取记录\n\n${commerce.sources.map((source) => `- ${source.url}：${source.status === "fetched" ? source.title || "已读取" : `读取失败，${source.error ?? "请补充资料"}`}`).join("\n")}`,
    );
  const assets = checkpoint.film?.assets.length ? checkpoint.film.assets : commerce.sharedAssets;
  if (assets.length)
    sections.push(
      `## 资产\n\n${assets.map((asset) => `### ${asset.id} · ${asset.name}\n\n${asset.prompt}\n\n${asset.path ?? "尚未生成"}`).join("\n\n")}`,
    );
  if (checkpoint.finalPath) sections.push(`## 完整成片\n\n${checkpoint.finalPath}`);
  for (const shot of checkpoint.shots) {
    const report = checkpoint.shotRuns[shot.id]?.qcReport;
    if (report) sections.push(`### ${shot.title} · 画面质检\n\n${report}`);
  }
  return sections.join("\n\n---\n\n") + "\n";
}
