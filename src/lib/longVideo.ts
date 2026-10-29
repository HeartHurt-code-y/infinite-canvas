import * as v from "valibot";
import { invokeDesktop } from "./ipc";
import type { ProviderCatalogEntry, StartGenerationCommand } from "./backend";
import type { ModelParameterCapability } from "./modelCapabilities";

/**
 * 长视频任务状态：与后端 `LongVideoStatus` 一一对应。
 *
 * 这是**唯一一份**状态清单——校验用的 picklist、界面文案都从这里取，
 * 改后端枚举时只改这一处就够了。（后端是权威，前端手抄的那份曾经散在三个地方。）
 */
export const LONG_VIDEO_STATUSES = [
  "planning",
  "awaiting_approval",
  "generating",
  "composing",
  "paused",
  "awaiting_budget",
  "needs_attention",
  "completed",
  "cancelled",
] as const;
export type LongVideoStatus = (typeof LONG_VIDEO_STATUSES)[number];

/** 片段状态：中央任务状态 + 长视频自己的两个本地状态（等待提交 / 等待重试）。 */
export const LONG_VIDEO_SHOT_STATUSES = [
  "pending",
  "pending_retry",
  "created",
  "submitting",
  "retry_wait",
  "queued",
  "running",
  "succeeded",
  "failed",
  "unknown",
  "interrupted",
  "cancelled",
] as const;
export type LongVideoShotStatus = (typeof LONG_VIDEO_SHOT_STATUSES)[number];

export const LONG_VIDEO_STATUS: Readonly<Record<LongVideoStatus, string>> = {
  planning: "正在规划镜头",
  awaiting_approval: "等待确认镜头",
  generating: "正在生成片段",
  composing: "正在合成成片",
  paused: "已暂停",
  awaiting_budget: "等待增加任务额度",
  needs_attention: "需要处理",
  completed: "已完成",
  cancelled: "已结束",
};

export const LONG_VIDEO_SHOT_STATUS: Readonly<Record<LongVideoShotStatus, string>> = {
  pending: "等待生成",
  pending_retry: "等待重试",
  created: "已创建",
  submitting: "提交中",
  retry_wait: "退避等待中",
  queued: "排队中",
  running: "生成中",
  succeeded: "正在保存",
  failed: "失败",
  unknown: "回执待核对",
  interrupted: "已中断",
  cancelled: "已取消",
};

/*
 * 三组片段状态名单（语义不同，不能互相替代），集中在这里，
 * 免得同一套判定散在前端后端各写一份、改一处忘另一处。
 */

/** 终态且没落盘的片段：后端会拒绝「继续原任务」，该给的是重试或只用成功片段合成。 */
export const LONG_VIDEO_BLOCKED_SHOT_STATUSES: readonly string[] = [
  "succeeded",
  "failed",
  "unknown",
  "interrupted",
  "cancelled",
];

/** 用户可以重试的片段：后端会为它新建一个任务（并占用额度）。 */
export const LONG_VIDEO_RETRYABLE_SHOT_STATUSES: readonly string[] = [
  "failed",
  "interrupted",
  "unknown",
  "cancelled",
];

/** 原请求可能还在供应商那边跑的片段：重试可能产生重复费用，界面必须先说清楚。 */
export const LONG_VIDEO_UNCERTAIN_SHOT_STATUSES: readonly string[] = [
  "unknown",
  "interrupted",
  "cancelled",
];

const number = v.pipe(v.number(), v.finite());
const shotSchema = v.object({
  id: v.string(),
  title: v.string(),
  prompt: v.string(),
  durationSeconds: number,
  attempts: v.array(v.string()),
  status: v.string(),
  progress: v.nullable(number),
  resultIndex: v.nullable(number),
  finalPath: v.nullable(v.string()),
  error: v.nullable(v.unknown()),
});
const outputSchema = v.object({
  path: v.string(),
  name: v.string(),
  durationSeconds: number,
  width: number,
  height: number,
  byteSize: number,
  sha256: v.string(),
  partial: v.boolean(),
});
const jobSchema = v.object({
  id: v.string(),
  requestId: v.string(),
  canvasId: v.string(),
  sourceNodeId: v.string(),
  title: v.string(),
  status: v.picklist(LONG_VIDEO_STATUSES),
  revision: number,
  targetSeconds: number,
  segmentSeconds: number,
  compositionProgress: number,
  submissionBudget: number,
  reservedSubmissions: number,
  plannerTaskId: v.string(),
  continuity: v.string(),
  shots: v.array(shotSchema),
  output: v.nullable(outputSchema),
  error: v.nullable(v.unknown()),
  yieldReason: v.nullable(v.string()),
  createdAt: number,
  updatedAt: number,
  events: v.array(v.object({ at: number, message: v.string() })),
});
export type LongVideoJob = v.InferOutput<typeof jobSchema>;
export type LongVideoShot = v.InferOutput<typeof shotSchema>;
export interface LongVideoSettings {
  readonly targetSeconds: number;
  readonly segmentSeconds: number;
  readonly submissionBudget: number;
  readonly plannerProviderId: string;
  readonly plannerModelId: string;
  readonly linkPreviousFrame: boolean;
  readonly approveScript: boolean;
  /** 同时在途的片段任务上限。尾帧承接开启时后端恒按 1 执行。 */
  readonly maxConcurrentSegments: number;
}
export const DEFAULT_LONG_VIDEO: LongVideoSettings = {
  targetSeconds: 300,
  segmentSeconds: 5,
  submissionBudget: 65,
  plannerProviderId: "",
  plannerModelId: "",
  linkPreviousFrame: false,
  approveScript: true,
  maxConcurrentSegments: 3,
};
/**
 * 单片段时长要落在模型真正声明的档位上。
 *
 * 后端会把用户填的值夹到模型允许的档位（冻结档案里的 duration 枚举），前端用同一套规则
 * 提前夹一次：否则非法值会原样打给供应商，第一个片段就失败，整条长视频要重新规划。
 */
export function resolveLongVideoSegmentSeconds(
  capability: ModelParameterCapability | undefined,
  requested: number,
): number {
  const fallback = Number.isFinite(requested) && requested > 0 ? Math.round(requested) : 1;
  if (!capability) return fallback;
  const numeric = capability.options
    .map((option) => option.value)
    .filter((value): value is number => typeof value === "number")
    .sort((left, right) => left - right);
  if (numeric.length > 0) {
    // 同距时取更小的那个：先升序排序，reduce 保留第一个最接近值即等于「同距取更小」，
    // 与后端 min_by_key((abs_diff, value)) 的规则一致，两边算出的镜头数才不会打架。
    return numeric.reduce((best, value) =>
      Math.abs(value - fallback) < Math.abs(best - fallback) ? value : best,
    );
  }
  const minimum = capability.minimum ?? 1;
  const maximum = capability.maximum ?? Number.MAX_SAFE_INTEGER;
  return Math.min(Math.max(fallback, minimum), maximum);
}
/** 目标时长按有效单片段时长拆成多少个镜头。 */
export function longVideoShotCount(targetSeconds: number, segmentSeconds: number): number {
  const segment = Math.max(1, Math.round(segmentSeconds));
  return Math.max(1, Math.ceil(Math.max(1, targetSeconds) / segment));
}
export type LongVideoAction =
  | "approve"
  | "pause"
  | "resume"
  | "cancel"
  | "set_budget"
  | "retry_failed"
  | "replan"
  | "compose_partial"
  | "query";
export function resolveLongVideoSettings(
  settings: LongVideoSettings | undefined,
  catalog: readonly ProviderCatalogEntry[],
): LongVideoSettings {
  const selected = { ...DEFAULT_LONG_VIDEO, ...settings };
  if (selected.plannerProviderId && selected.plannerModelId) return selected;
  for (const entry of catalog) {
    const model = entry.provider.enabled
      ? entry.models.find((item) => item.operations.includes("text_generation"))
      : undefined;
    if (model)
      return {
        ...selected,
        plannerProviderId: entry.provider.id,
        plannerModelId: model.definitionId,
      };
  }
  return selected;
}
export interface LongVideoControl {
  readonly jobId: string;
  readonly action: LongVideoAction;
  readonly revision?: number;
  readonly submissionBudget?: number;
  readonly continuity?: string;
  readonly shots?: readonly Pick<LongVideoShot, "id" | "title" | "prompt">[];
}
export const longVideoClient = {
  start: (
    command: LongVideoSettings & {
      readonly requestId: string;
      readonly generation: StartGenerationCommand;
      readonly durationParameter: string;
    },
  ) => invokeDesktop("start_long_video", jobSchema, { command }),
  list: (canvasId: string) =>
    invokeDesktop("list_long_video_jobs", v.array(jobSchema), { canvasId }),
  get: (jobId: string) => invokeDesktop("get_long_video_job", jobSchema, { jobId }),
  control: (command: LongVideoControl) =>
    invokeDesktop("control_long_video", jobSchema, { command }),
  /**
   * 节点被从画布上删掉时叫停它上面的长视频编排。
   *
   * 节点删除只是前端状态变化，后端不会自己知道；不叫停的话编排会继续按额度提交片段，
   * 而它的界面入口是按节点过滤的——节点没了，用户连暂停都点不到。
   */
  cancelForNode: (canvasId: string, nodeKey: string) =>
    invokeDesktop("cancel_long_video_for_node", v.number(), { canvasId, nodeKey }),
  /** 清空画布时叫停这张画布上的全部长视频编排（清空不走逐节点删除路径）。 */
  cancelForCanvas: (canvasId: string) =>
    invokeDesktop("cancel_long_video_for_canvas", v.number(), { canvasId }),
  /**
   * 所有画布上仍在进行的长视频编排。
   *
   * 界面入口是按画布的：切到别的画布后，另一张画布上的编排还在按额度提交片段，
   * 而「结束编排」按钮在另一张画布上——界面靠它提示「还有别处没停下的长视频」。
   */
  listActive: () => invokeDesktop("list_active_long_video_jobs", v.array(jobSchema)),
};
/** 后端在长视频状态变化时发出的事件：订阅后立即刷新任务列表，不靠固定间隔轮询等状态。 */
export const LONG_VIDEO_CHANGED_EVENT = "long-video:changed";
/** 画布内部通道：请求把长视频产物放回画布（不是后端事件，别与上面的名字混用）。 */
export const LONG_VIDEO_RESULTS_REQUEST_EVENT = "canvas:long-video-results";
export function longVideoRunning(job: LongVideoJob): boolean {
  return ["planning", "generating", "composing"].includes(job.status);
}
