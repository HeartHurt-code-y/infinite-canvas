import * as v from "valibot";
import { invokeDesktop } from "./ipc";
import type { ExplicitMediaTarget, StartGenerationCommand } from "./backend";
import type { VideoClipParams } from "../features/workspace/videoClipModes";

const nodeKey = { canvasNodeKey: v.exactOptional(v.nullable(v.string())) };
const mediaType = v.picklist(["video", "image", "audio"]);
const targetSchema = v.variant("kind", [
  v.object({ kind: v.literal("local_file"), path: v.string(), mediaType, ...nodeKey }),
  v.object({ kind: v.literal("local_base64_asset"), assetId: v.string(), mediaType, ...nodeKey }),
  v.object({ kind: v.literal("local_asset"), stagingJobId: v.string(), mediaType, ...nodeKey }),
  v.object({ kind: v.literal("local_result"), generationTaskId: v.string(), resultIndex: v.number(), mediaType, ...nodeKey }),
  v.object({ kind: v.literal("asset"), providerConnectionId: v.string(), assetId: v.string(), mediaType, ...nodeKey }),
  v.object({ kind: v.literal("url"), url: v.string(), mediaType, ...nodeKey }),
]);
export interface ClipEdit {
  readonly target: ExplicitMediaTarget;
  readonly sourceIdentity?: string | null;
  readonly name: string;
  readonly start: number;
  readonly end: number;
  readonly volume: number;
  readonly fade: boolean;
  readonly caption: string;
}
const secondsSchema = v.pipe(v.number(), v.finite(), v.minValue(0));
const clipSchema = v.object({ target: targetSchema, sourceIdentity: v.exactOptional(v.nullable(v.string())), name: v.string(), start: secondsSchema, end: secondsSchema, volume: v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(2)), fade: v.boolean(), caption: v.pipe(v.string(), v.maxLength(2000)) });
const projectSchema = v.object({ version: v.literal(1), name: v.string(), params: v.object({
  aspectRatio: v.picklist(["21:9", "16:9", "9:16", "1:1", "4:3", "3:4"]),
  durationSeconds: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(300)), resolution: v.picklist(["480P", "720P", "1080P"]),
}), clips: v.pipe(v.array(clipSchema), v.minLength(1), v.maxLength(60)) });
export async function importClipProject() {
  const [{ open }, { readTextFile }] = await Promise.all([import("@tauri-apps/plugin-dialog"), import("@tauri-apps/plugin-fs")]);
  const path = await open({ title: "导入剪辑工程", multiple: false, filters: [{ name: "剪辑工程", extensions: ["json"] }] });
  if (typeof path !== "string") return null;
  const source = await readTextFile(path);
  let parsed: unknown;
  try { parsed = JSON.parse(source) as unknown; }
  catch { throw new Error("剪辑工程不是有效 JSON，请选择本应用导出的工程文件。"); }
  const result = v.safeParse(projectSchema, parsed);
  if (!result.success) throw new Error("剪辑工程的版本、素材或参数无效，请选择本应用导出的工程文件。");
  return result.output;
}
export const clipJobSchema = v.object({
  id: v.string(), canvasId: v.string(), sourceNodeId: v.string(), name: v.string(),
  status: v.picklist(["queued", "preparing", "planning", "rendering", "completed", "failed", "cancelled", "interrupted"]),
  progress: v.number(), plannerTaskId: v.nullable(v.string()), clips: v.array(clipSchema),
  outputPath: v.nullable(v.string()), projectPath: v.nullable(v.string()), subtitlePath: v.nullable(v.string()),
  durationSeconds: v.nullable(v.number()),
  error: v.nullable(v.string()), updatedAt: v.number(),
});
export type ClipRenderJob = v.InferOutput<typeof clipJobSchema>;
export interface StartClipRender {
  readonly requestId: string;
  readonly canvasId: string;
  readonly sourceNodeId: string;
  readonly name: string;
  readonly params: VideoClipParams;
  readonly clips: readonly ClipEdit[];
  readonly planner: StartGenerationCommand | null;
}
export const clipRenderClient = {
  start: (command: StartClipRender) => invokeDesktop("start_clip_render", clipJobSchema, { command }),
  list: (canvasId: string) => invokeDesktop("list_clip_renders", v.array(clipJobSchema), { canvasId }),
  cancel: (id: string) => invokeDesktop("cancel_clip_render", clipJobSchema, { id }),
};
export const clipJobActive = (job: ClipRenderJob) => ["queued", "preparing", "planning", "rendering"].includes(job.status);
export const CLIP_JOB_LABEL: Readonly<Record<ClipRenderJob["status"], string>> = {
  queued: "等待剪辑", preparing: "正在读取素材", planning: "正在规划剪辑", rendering: "正在导出成片", completed: "成片已保存",
  failed: "剪辑失败", cancelled: "已取消", interrupted: "上次剪辑已中断",
};
