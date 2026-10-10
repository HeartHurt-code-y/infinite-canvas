import type { PickedPromptMaterial } from "../../lib/backend";
import {
  requirementsMet,
  type WorkflowRequirement,
  type WorkflowRequirements,
} from "./workflowFieldRequirements";
import type { KnowledgeVideoWorkflowCheckpoint } from "./workspaceModel";

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

/**
 * 封面制作真正必填的只有「内容」：选题、文章，或一个固定标题。
 *
 * 为什么把人物参考图降级为选填
 * ----------------------------
 * 旧实现硬性要求 `portraits.length >= 1`，界面又把「人物参考图（必填）」写死成
 * 中文括号。想做纯产品图、纯文字或让工作流自动设计人物的封面（不出现真人）的
 * 用户，会在「查看执行计划」上被无声拦下，而交付要求里并没有「必须真人参考图」
 * 这一条。缺图时由工作流按选题编排人物，所以这里不再把参考图算作必填。
 *
 * 保留的只是「一旦提供就必须可用」：同一人物 1–3 张、全部图片合计不超 8 张、
 * 类型与字节有效、路径不重复。这些不满足时仍不可执行，但会作为具体条目说明
 * 缺的是什么、该怎么改，而不是只给一个布尔值。
 */
export function xhsCoverRequirements(
  brief: string,
  options: XhsCoverWorkflowOptions,
): WorkflowRequirements {
  return [
    brief.trim() || options.title.trim()
      ? null
      : {
          field: "封面内容或固定标题",
          hint: "粘贴选题、文章或产品资料；也可以只写一个固定标题。",
        },
    ...xhsCoverImageRequirements(options),
  ].filter((requirement): requirement is WorkflowRequirement => requirement !== null);
}

/**
 * 已选图片的可用性问题。与「封面内容」无关，因此界面在还没拿到主输入区内容时
 * 也能安全展示这一部分，不会把未知误报成缺失。
 */
export function xhsCoverImageRequirements(options: XhsCoverWorkflowOptions): WorkflowRequirements {
  const images = [...options.portraits, ...options.materials];
  const unusable = (image: PickedPromptMaterial) =>
    image.kind !== "image" ||
    !image.localPath.trim() ||
    !image.mimeType.startsWith("image/") ||
    !Number.isFinite(image.byteSize) ||
    image.byteSize <= 0;
  const duplicated =
    new Set(images.map((image) => image.localPath.toLowerCase())).size !== images.length;
  return [
    options.portraits.length > 3
      ? { field: "人物参考图数量", hint: "同一人物最多 3 张，请先移除多余的图片。" }
      : null,
    options.portraits.some(unusable)
      ? {
          field: "人物参考图（已选的图片不可用）",
          hint: "请移除后重新添加可读取的图片文件。",
        }
      : null,
    options.materials.length > 5
      ? { field: "补充素材数量", hint: "产品图、截图等最多 5 张。" }
      : null,
    options.materials.some(unusable)
      ? { field: "补充素材（已选的图片不可用）", hint: "请移除后重新添加可读取的图片文件。" }
      : null,
    images.length > 8 ? { field: "图片总数", hint: "人物参考图与补充素材合计不超过 8 张。" } : null,
    duplicated ? { field: "重复图片", hint: "同一张图片只需要添加一次。" } : null,
  ].filter((requirement): requirement is WorkflowRequirement => requirement !== null);
}

export function xhsCoverInputReady(brief: string, options: XhsCoverWorkflowOptions): boolean {
  return requirementsMet(xhsCoverRequirements(brief, options));
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
