import * as v from "valibot";
import { invokeDesktop } from "./ipc";
import type { ExplicitMediaTarget, StartGenerationCommand, StartVideoClipCommand } from "./backend";
import type { VideoClipParams } from "../features/workspace/videoClipModes";
import { fontRefSchema, animationSchema, highlightSchema, type ClipFontRef, type ClipTextAnimation, type ClipWordHighlight } from "./clipTypography";

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
  readonly transition?: { readonly kind: "fade" | "black" | "white"; readonly seconds: number } | null;
}
export interface ClipOverlay {
  readonly id: string;
  readonly kind: "text" | "subtitle";
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly x: number;
  readonly y: number;
  /** Percentage of the output height. */
  readonly size: number;
  readonly color: string;
  readonly background: boolean;
  readonly bold: boolean;
  readonly font?: ClipFontRef | null;
  readonly weight?: number;
  readonly highlight?: ClipWordHighlight;
  readonly animation?: ClipTextAnimation;
}
export interface ClipTimelineSettings {
  readonly format: "mp4" | "webm";
  readonly subtitles: "soft" | "burn" | "hidden";
  readonly muted: boolean;
  readonly instructions: string;
  readonly overlays: readonly ClipOverlay[];
}
export const DEFAULT_CLIP_SETTINGS: ClipTimelineSettings = { format: "mp4", subtitles: "soft", muted: false, instructions: "", overlays: [] };
const secondsSchema = v.pipe(v.number(), v.finite(), v.minValue(0));
const percent = v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(100));
const overlaySchema = v.object({ id: v.string(), kind: v.picklist(["text", "subtitle"]), text: v.pipe(v.string(), v.maxLength(2000)), start: secondsSchema, end: secondsSchema, x: percent, y: percent, size: v.pipe(v.number(), v.finite(), v.minValue(1), v.maxValue(20)), color: v.pipe(v.string(), v.regex(/^#[0-9a-fA-F]{6}$/)), background: v.boolean(), bold: v.boolean(), font: v.exactOptional(v.nullable(fontRefSchema)), weight: v.exactOptional(v.pipe(v.number(), v.integer(), v.minValue(100), v.maxValue(900))), highlight: v.exactOptional(highlightSchema), animation: v.exactOptional(animationSchema) });
const settingsSchema = v.object({ format: v.picklist(["mp4", "webm"]), subtitles: v.picklist(["soft", "burn", "hidden"]), muted: v.optional(v.boolean(), false), instructions: v.optional(v.pipe(v.string(), v.maxLength(20000)), ""), overlays: v.pipe(v.array(overlaySchema), v.maxLength(200)) });
const clipSchema = v.object({ target: targetSchema, sourceIdentity: v.exactOptional(v.nullable(v.string())), name: v.string(), start: secondsSchema, end: secondsSchema, volume: v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(2)), fade: v.boolean(), caption: v.pipe(v.string(), v.maxLength(2000)), transition: v.exactOptional(v.nullable(v.object({ kind: v.picklist(["fade", "black", "white"]), seconds: v.pipe(v.number(), v.finite(), v.minValue(0.04), v.maxValue(2)) }))) });
const projectSchema = v.object({ version: v.literal(1), name: v.string(), params: v.object({
  aspectRatio: v.picklist(["21:9", "16:9", "9:16", "1:1", "4:3", "3:4"]),
  durationSeconds: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(300)), resolution: v.picklist(["480P", "720P", "1080P"]),
}), clips: v.pipe(v.array(clipSchema), v.minLength(1), v.maxLength(60)), settings: v.optional(settingsSchema, { format: "mp4", subtitles: "soft", muted: false, instructions: "", overlays: [] }) });
/** Used by history/output cards as well as the explicit import picker. Never submits a task. */
export async function readClipProject(path: string) {
  const { readTextFile } = await import("@tauri-apps/plugin-fs");
  const source = await readTextFile(path);
  let parsed: unknown;
  try { parsed = JSON.parse(source) as unknown; }
  catch { throw new Error("剪辑工程不是有效 JSON，请选择本应用导出的工程文件。"); }
  const result = v.safeParse(projectSchema, parsed);
  if (!result.success) throw new Error("剪辑工程的版本、素材或参数无效，请选择本应用导出的工程文件。");
  return result.output;
}
export async function importClipProject() {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const path = await open({ title: "导入剪辑工程", multiple: false, filters: [{ name: "剪辑工程", extensions: ["json"] }] });
  if (typeof path !== "string") return null;
  return readClipProject(path);
}
const agentStepSchema = v.object({ key: v.string(), tool: v.string(), label: v.string(), status: v.string(), taskId: v.nullable(v.string()), detail: v.nullable(v.string()) });
const agentOutputSchema = v.object({ id: v.string(), name: v.string(), path: v.string(), projectPath: v.string(), subtitlePath: v.string(), durationSeconds: v.number() });
const agentReceiptSchema = v.object({
  version: v.string(), mode: v.string(), summary: v.string(), steps: v.array(agentStepSchema), outputs: v.array(agentOutputSchema), modelCallLimit: v.number(), planningRoundLimit: v.number(),
});
export type ClipAgentRequest = {
  readonly mode: StartVideoClipCommand["mode"];
  readonly materials: StartVideoClipCommand["materials"];
  readonly video: { readonly providerId: string; readonly modelId: string } | null;
  readonly speech: { readonly providerId: string; readonly modelId: string } | null;
};
export interface ClipAgentModelChoice { readonly providerId: string; readonly modelDefinitionId: string }
export interface ClipAgentModelOption extends ClipAgentModelChoice { readonly label: string }
export interface ClipAgentModels { readonly text: ClipAgentModelChoice; readonly video: ClipAgentModelChoice; readonly speech: ClipAgentModelChoice }
export const clipJobSchema = v.object({
  id: v.string(), canvasId: v.string(), sourceNodeId: v.string(), name: v.string(),
  status: v.picklist(["queued", "preparing", "analyzing", "planning", "generating", "rendering", "verifying", "completed", "failed", "cancelled", "interrupted"]),
  progress: v.number(), plannerTaskId: v.nullable(v.string()), clips: v.array(clipSchema),
  outputPath: v.nullable(v.string()), projectPath: v.nullable(v.string()), subtitlePath: v.nullable(v.string()),
  durationSeconds: v.nullable(v.number()),
  error: v.nullable(v.string()), updatedAt: v.number(),
  agent: v.optional(v.nullable(agentReceiptSchema), null),
  settings: v.optional(settingsSchema, { format: "mp4", subtitles: "soft", muted: false, instructions: "", overlays: [] }),
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
  readonly agent?: ClipAgentRequest | null;
  readonly settings?: ClipTimelineSettings;
}
export const clipRenderClient = {
  start: (command: StartClipRender) => invokeDesktop("start_clip_render", clipJobSchema, { command }),
  list: (canvasId: string) => invokeDesktop("list_clip_renders", v.array(clipJobSchema), { canvasId }),
  cancel: (id: string) => invokeDesktop("cancel_clip_render", clipJobSchema, { id }),
  resume: (id: string) => invokeDesktop("resume_clip_render", clipJobSchema, { id }),
};
export const clipJobActive = (job: ClipRenderJob) => ["queued", "preparing", "analyzing", "planning", "generating", "rendering", "verifying"].includes(job.status);
export const CLIP_JOB_LABEL: Readonly<Record<ClipRenderJob["status"], string>> = {
  queued: "等待剪辑", preparing: "正在读取素材", planning: "正在规划剪辑", rendering: "正在导出成片", completed: "成片已保存",
  failed: "剪辑失败", cancelled: "已取消", interrupted: "上次剪辑已中断",
  analyzing: "Agent 正在分析素材", generating: "Agent 正在执行生成", verifying: "正在核对实际成片",
};
