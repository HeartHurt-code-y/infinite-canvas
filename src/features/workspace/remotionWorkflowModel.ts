import { requirementsMet, type WorkflowRequirements } from "./workflowFieldRequirements";
import type { KnowledgeVideoWorkflowCheckpoint } from "./workspaceModel";

export const ANIMATION_TEMPLATES = {
  "cycle-flowchart": "循环流程图",
  "morandi-grid": "莫兰迪卡片网格",
  "cute-flowchart": "可爱流程图",
  "compare-flowchart": "对比流程图",
  "skills-flowchart": "技能流程图",
  "terminal-flowchart": "终端流程图",
  "person-card": "人物卡片",
  timeline: "时间线",
  "code-showcase": "代码展示",
  "pie-chart": "饼图",
  custom: "自定义逻辑布局",
} as const;
export type AnimationTemplate = keyof typeof ANIMATION_TEMPLATES;
export interface AnimationElement {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  readonly value?: number;
  readonly group?: string;
  readonly x?: number;
  readonly y?: number;
  readonly width?: number;
  readonly height?: number;
}
export interface AnimationPlan {
  readonly schemaVersion: "animation-plan.v1";
  readonly template: AnimationTemplate;
  readonly title: string;
  readonly subtitle?: string;
  readonly width: number;
  readonly height: number;
  readonly fps: 30;
  readonly durationInFrames: number;
  readonly background: string;
  readonly palette: readonly string[];
  readonly elements: readonly AnimationElement[];
  readonly connections: readonly {
    readonly from: string;
    readonly to: string;
    readonly label?: string;
  }[];
  readonly staggerFrames: number;
  readonly holdFrames: number;
  readonly springDamping: number;
}
export interface RemotionWorkflowOptions {
  readonly template: "auto" | AnimationTemplate;
  readonly width: number;
  readonly height: number;
  readonly durationSeconds: number;
  readonly theme: "morandi" | "light" | "dark";
  readonly format: "gif" | "mp4" | "both";
}
export interface AnimationRenderJob {
  readonly id: string;
  readonly status: "running" | "succeeded" | "failed" | "cancelled";
  readonly progress: number;
  readonly message: string;
  readonly error?: string | null;
  readonly gifPath?: string | null;
  readonly videoPath?: string | null;
  readonly previewPath?: string | null;
  readonly projectPath?: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}
export interface AnimationReview {
  readonly result: "PASS" | "REVISE" | "NEEDS_DECISION";
  readonly report: string;
  readonly repairInstructions?: string;
  readonly question?: string;
  readonly recommendation?: string;
}
export interface RemotionWorkflowCheckpoint {
  readonly inputSignature?: string;
  readonly confirmedDecisions?: readonly string[];
  readonly plan: AnimationPlan | null;
  readonly matchReason: string;
  readonly review: AnimationReview | null;
  readonly repairCount: number;
  readonly history: readonly {
    readonly plan: AnimationPlan;
    readonly review: AnimationReview | null;
  }[];
  readonly renderJob: AnimationRenderJob | null;
}
export function createRemotionOptions(): RemotionWorkflowOptions {
  return {
    template: "auto",
    width: 800,
    height: 600,
    durationSeconds: 8,
    theme: "morandi",
    format: "gif",
  };
}
export function createRemotionCheckpoint(): RemotionWorkflowCheckpoint {
  return {
    plan: null,
    matchReason: "",
    review: null,
    repairCount: 0,
    history: [],
    renderJob: null,
  };
}
/**
 * 动画逻辑图的必填项只有**动画描述**：模板、主题、尺寸、时长、导出格式都在
 * `createRemotionOptions()` 里预置了推荐值，自动匹配能直接开工。所以清单要么
 * 是空的，要么只差这一项——不需要用户先学会怎么选参数。
 */
export function remotionRequirements(brief: string): WorkflowRequirements {
  return brief.trim()
    ? []
    : [
        {
          field: "动画描述或草图",
          hint: "一句话说明要展示的流程或关系，例如「提出问题 → 尝试解决 → 收集反馈 → 改进」；也可以直接粘贴 ASCII 草图。",
        },
      ];
}

/** 运行器与节点按钮共用同一份清单，避免「能点却做不出来」。 */
export function remotionInputReady(brief: string): boolean {
  return requirementsMet(remotionRequirements(brief));
}
export function remotionDeliveryMarkdown(checkpoint: KnowledgeVideoWorkflowCheckpoint): string {
  const state = checkpoint.remotion;
  if (!state?.plan) return "";
  const { plan, review, renderJob } = state;
  return (
    [
      `# ${plan.title}`,
      `## 动画方案\n\n模板：${ANIMATION_TEMPLATES[plan.template]}\n\n选择依据：${state.matchReason}\n\n尺寸：${plan.width}×${plan.height}，时长：${plan.durationInFrames / plan.fps} 秒`,
      ...plan.elements.map(
        (element) =>
          `### ${element.label}\n\n${element.detail ?? ""}${element.value == null ? "" : `\n\n数值：${element.value}`}`,
      ),
      review ? `## 检查\n\n${review.result} · ${review.report}` : "",
      renderJob
        ? `## 导出文件\n\n${[renderJob.gifPath, renderJob.videoPath, renderJob.previewPath, renderJob.projectPath].filter(Boolean).join("\n\n")}`
        : "",
      `## 声明式工程数据\n\n\`\`\`json\n${JSON.stringify(plan, null, 2)}\n\`\`\``,
    ]
      .filter(Boolean)
      .join("\n\n") + "\n"
  );
}
