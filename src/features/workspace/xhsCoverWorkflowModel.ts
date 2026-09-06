import type { PickedPromptMaterial } from "../../lib/backend";
import type { KnowledgeVideoWorkflowCheckpoint } from "./workspaceModel";

// Leave room for the normalized cover and Base64 expansion in visual review requests.
export const XHS_COVER_MAX_REFERENCE_BYTES = 8 * 1024 * 1024;

export const XHS_COVER_STYLES = {
  headline: "爆款大字压顶",
  split: "巨字拆分冲击",
  qa: "小白科普问答",
  checklist: "教程清单",
  ranking: "产品测评榜单",
  recommend: "种草推荐",
  collage: "贴纸拼贴入门",
  workflow: "黑底效率工作流",
} as const;

export interface XhsCoverWorkflowOptions {
  readonly title: string;
  readonly style: "auto" | keyof typeof XHS_COVER_STYLES;
  readonly expression:
    "auto" | "surprised" | "thumbs_up" | "pointing" | "thoughtful" | "confident" | "explaining";
  readonly background: "auto" | "warm" | "tech" | "tool_wall" | "interface" | "contrast";
  readonly font: "auto" | "bold" | "comic" | "rounded" | "tech" | "handwritten";
  readonly color: "yellow" | "white" | "mixed" | "highlight" | "dark";
  readonly portraits: readonly PickedPromptMaterial[];
  readonly materials: readonly PickedPromptMaterial[];
  readonly deliverable: "image" | "prompt";
}

export interface XhsCoverPlan {
  readonly schemaVersion: "xhs-cover-plan.v1";
  readonly style: keyof typeof XHS_COVER_STYLES;
  readonly title: string;
  readonly subtitle: string;
  readonly titleCandidates: readonly string[];
  readonly rationale: string;
  readonly prompt: string;
  readonly decision?: { readonly question: string; readonly recommendation: string } | null;
}

export interface XhsCoverReview {
  readonly result: "PASS" | "REVISE" | "NEEDS_DECISION";
  readonly report: string;
  readonly repairInstructions?: string;
  readonly question?: string;
  readonly recommendation?: string;
}

export interface XhsCoverWorkflowCheckpoint {
  readonly inputSignature?: string;
  readonly confirmedDecisions?: readonly string[];
  readonly plan: XhsCoverPlan | null;
  readonly review: XhsCoverReview | null;
  readonly taskId: string | null;
  readonly imagePath: string | null;
  readonly finalPath: string | null;
  readonly repairCount: number;
  readonly history: readonly {
    readonly plan: XhsCoverPlan;
    readonly review: XhsCoverReview | null;
    readonly imagePath: string | null;
    readonly finalPath: string | null;
  }[];
}

export function createXhsCoverOptions(): XhsCoverWorkflowOptions {
  return {
    title: "",
    style: "auto",
    expression: "auto",
    background: "auto",
    font: "bold",
    color: "yellow",
    portraits: [],
    materials: [],
    deliverable: "image",
  };
}

export function createXhsCoverCheckpoint(): XhsCoverWorkflowCheckpoint {
  return {
    plan: null,
    review: null,
    taskId: null,
    imagePath: null,
    finalPath: null,
    repairCount: 0,
    history: [],
  };
}

export function xhsCoverInputReady(brief: string, options: XhsCoverWorkflowOptions): boolean {
  const images = [...options.portraits, ...options.materials];
  return Boolean(
    (brief.trim() || options.title.trim()) &&
    options.portraits.length >= 1 &&
    options.portraits.length <= 3 &&
    options.materials.length <= 5 &&
    images.length <= 8 &&
    images.every(
      (image) =>
        image.kind === "image" &&
        image.localPath.trim() &&
        image.mimeType.startsWith("image/") &&
        Number.isFinite(image.byteSize) &&
        image.byteSize > 0,
    ) &&
    images.reduce((sum, image) => sum + image.byteSize, 0) <= XHS_COVER_MAX_REFERENCE_BYTES &&
    new Set(images.map((image) => image.localPath.toLowerCase())).size === images.length,
  );
}

export function xhsCoverDeliveryMarkdown(checkpoint: KnowledgeVideoWorkflowCheckpoint): string {
  const state = checkpoint.xhsCover;
  if (!state?.plan) return "";
  const { plan, review, finalPath } = state;
  return (
    [
      `# ${plan.title}`,
      `## 封面方案\n\n风格：${XHS_COVER_STYLES[plan.style]}\n\n选择依据：${plan.rationale}\n\n画幅：3:4 竖版，交付尺寸：1080×1440`,
      plan.subtitle ? `副标题：${plan.subtitle}` : "",
      `## 标题备选\n\n${plan.titleCandidates.map((title, index) => `${index + 1}. ${title}`).join("\n")}`,
      `## 完整图片提示词\n\n${plan.prompt}`,
      review ? `## 图片质检\n\n${review.result} · ${review.report}` : "",
      finalPath ? `## 封面文件\n\n${finalPath}` : "",
      state.history.length
        ? `## 修订记录\n\n${state.history.map((entry, index) => `${index + 1}. ${entry.review?.report ?? "已保存方案"}${entry.finalPath ? `\n   ${entry.finalPath}` : ""}`).join("\n")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n") + "\n"
  );
}
