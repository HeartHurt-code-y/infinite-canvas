import { invoke } from "@tauri-apps/api/core";
import * as v from "valibot";
import { isDesktopRuntime, type MediaReferenceTarget } from "./backend";

const text = v.pipe(v.string(), v.nonEmpty());
const nonNegative = v.pipe(v.number(), v.finite(), v.minValue(0));
const index = v.pipe(nonNegative, v.integer());
const sourceBase = { mediaType: v.literal("video"), canvasNodeKey: v.exactOptional(text) };
const sourceSchema = v.variant("kind", [
  v.object({ kind: v.literal("asset"), providerConnectionId: text, assetId: text, ...sourceBase }),
  v.object({ kind: v.literal("local_asset"), stagingJobId: text, ...sourceBase }),
  v.object({ kind: v.literal("local_base64_asset"), assetId: text, ...sourceBase }),
  v.object({
    kind: v.literal("local_result"),
    generationTaskId: text,
    resultIndex: index,
    ...sourceBase,
  }),
  v.object({ kind: v.literal("local_file"), path: text, ...sourceBase }),
]);
const operationSchema = v.picklist(["video_depth", "audio_separation"]);
const modeSchema = v.picklist(["lite", "quality"]);
const deviceSchema = v.picklist(["auto", "cpu", "cuda", "mps", "directml"]);
const depthMaxSideSchema = v.picklist([480, 720]);
const outputSchema = v.pipe(
  v.object({
    resultIndex: index,
    role: v.picklist(["depth_video", "depth_data", "manifest", "vocals", "accompaniment"]),
    kind: v.picklist(["video", "audio", "data"]),
    path: text,
    name: text,
    mimeType: text,
    durationSeconds: nonNegative,
    width: v.nullish(index),
    height: v.nullish(index),
  }),
  v.check((output) => {
    if (output.role === "depth_video") return output.kind === "video";
    if (output.role === "vocals" || output.role === "accompaniment") return output.kind === "audio";
    return output.kind === "data";
  }, "AI 媒体结果类型不匹配。"),
);
const jobSchema = v.pipe(
  v.object({
    jobId: text,
    source: sourceSchema,
    sourceIdentity: text,
    name: text,
    operation: operationSchema,
    // Records produced before the lightweight engine was introduced used the quality engine.
    mode: v.optional(modeSchema, "quality"),
    startSeconds: nonNegative,
    endSeconds: nonNegative,
    audioStreamIndex: v.nullish(index),
    depthMaxSide: depthMaxSideSchema,
    device: deviceSchema,
    status: v.picklist(["preparing", "processing", "paused", "completed", "failed", "cancelled"]),
    progress: v.nullish(v.pipe(nonNegative, v.maxValue(100))),
    message: v.nullish(v.string()),
    actualDevice: v.nullish(v.string()),
    outputs: v.array(outputSchema),
    error: v.nullish(v.string()),
    createdAt: nonNegative,
    updatedAt: nonNegative,
  }),
  v.check(
    (job) => new Set(job.outputs.map((output) => output.resultIndex)).size === job.outputs.length,
    "AI 媒体结果序号重复。",
  ),
  v.check((job) => job.endSeconds > job.startSeconds, "AI 媒体选区无效。"),
  v.check((job) => {
    const paths = job.outputs.map((output) => {
      const path = output.path.replace(/\\/g, "/");
      return /^(?:[a-z]:\/|\/\/)/i.test(path) ? path.toLowerCase() : path;
    });
    return new Set(paths).size === paths.length;
  }, "AI 媒体结果文件重复。"),
  v.check((job) => {
    const roles =
      job.operation === "video_depth"
        ? ["depth_video", "depth_data", "manifest"]
        : ["vocals", "accompaniment", "manifest"];
    return (
      job.outputs.every((output) => roles.includes(output.role)) &&
      (job.status !== "completed" ||
        (job.outputs.length === roles.length &&
          roles.every((role) => job.outputs.some((output) => output.role === role))))
    );
  }, "AI 媒体结果与处理方式不匹配或不完整。"),
);
const runtimeSchema = v.object({
  mode: v.optional(modeSchema),
  ready: v.boolean(),
  videoDepthReady: v.boolean(),
  audioSeparationReady: v.boolean(),
  rootPath: v.nullish(v.string()),
  error: v.nullish(v.string()),
  version: v.nullish(v.string()),
});
const commandSchema = v.object({
  source: sourceSchema,
  name: text,
  operation: operationSchema,
  mode: v.optional(modeSchema, "lite"),
  startSeconds: nonNegative,
  endSeconds: v.optional(nonNegative),
  audioStreamIndex: v.optional(index),
  depthMaxSide: depthMaxSideSchema,
  device: deviceSchema,
  sourceIdentity: v.optional(text),
});

export type AiMediaOperation = v.InferOutput<typeof operationSchema>;
export type AiMediaMode = v.InferOutput<typeof modeSchema>;
export type AiMediaDevice = v.InferOutput<typeof deviceSchema>;
export type AiMediaDepthMaxSide = v.InferOutput<typeof depthMaxSideSchema>;
export type AiMediaOutput = v.InferOutput<typeof outputSchema>;
export type AiMediaJob = v.InferOutput<typeof jobSchema>;
export type AiMediaRuntimeStatus = v.InferOutput<typeof runtimeSchema>;

export interface StartAiMediaCommand {
  readonly source: MediaReferenceTarget;
  readonly name: string;
  readonly operation: AiMediaOperation;
  readonly mode?: AiMediaMode;
  readonly startSeconds: number;
  readonly endSeconds?: number;
  readonly audioStreamIndex?: number;
  readonly depthMaxSide: AiMediaDepthMaxSide;
  readonly device: AiMediaDevice;
  readonly sourceIdentity?: string;
}

function requireDesktop() {
  if (!isDesktopRuntime()) throw new Error("AI 媒体处理需要在桌面应用中运行。");
}

export function isAiMediaActive(job: AiMediaJob): boolean {
  return job.status === "preparing" || job.status === "processing";
}

/** Keep native results and stable result indices validated before presenting or exporting files. */
export const aiMediaClient = {
  async runtimeStatus(mode: AiMediaMode = "lite"): Promise<AiMediaRuntimeStatus> {
    requireDesktop();
    const requestedMode = v.parse(modeSchema, mode);
    const status = v.parse(
      runtimeSchema,
      await invoke("get_ai_media_runtime_status", { mode: requestedMode }),
    );
    if (status.mode != null && status.mode !== requestedMode)
      throw new Error("返回的 AI 组件与所选处理引擎不匹配。");
    return status;
  },
  async importRuntime(rootPath: string, mode: AiMediaMode = "lite"): Promise<AiMediaRuntimeStatus> {
    requireDesktop();
    const requestedMode = v.parse(modeSchema, mode);
    const status = v.parse(
      runtimeSchema,
      await invoke("import_ai_media_runtime", {
        rootPath: v.parse(text, rootPath.trim()),
        mode: requestedMode,
      }),
    );
    if (status.mode != null && status.mode !== requestedMode)
      throw new Error("导入的 AI 组件与所选处理引擎不匹配。");
    return status;
  },
  async start(command: StartAiMediaCommand): Promise<AiMediaJob> {
    requireDesktop();
    const validated = v.parse(commandSchema, command);
    if (validated.endSeconds != null && validated.endSeconds <= validated.startSeconds)
      throw new Error("结束时间必须大于开始时间。");
    if (
      (validated.mode === "lite" && !["auto", "cpu", "directml"].includes(validated.device)) ||
      (validated.mode === "quality" && validated.device === "directml")
    )
      throw new Error("处理设备与所选引擎不兼容。");
    const job = v.parse(jobSchema, await invoke("start_ai_media_job", { command: validated }));
    if (job.mode !== validated.mode) throw new Error("创建的 AI 任务与所选处理引擎不匹配。");
    return job;
  },
  async list(): Promise<AiMediaJob[]> {
    requireDesktop();
    return v.parse(v.array(jobSchema), await invoke("list_ai_media_jobs"));
  },
  async get(jobId: string): Promise<AiMediaJob> {
    requireDesktop();
    return v.parse(jobSchema, await invoke("get_ai_media_job", { jobId: v.parse(text, jobId) }));
  },
  async retry(jobId: string): Promise<AiMediaJob> {
    requireDesktop();
    return v.parse(jobSchema, await invoke("retry_ai_media_job", { jobId: v.parse(text, jobId) }));
  },
  async cancel(jobId: string): Promise<AiMediaJob> {
    requireDesktop();
    return v.parse(jobSchema, await invoke("cancel_ai_media_job", { jobId: v.parse(text, jobId) }));
  },
  async rename(jobId: string, resultIndex: number, name: string): Promise<AiMediaJob> {
    requireDesktop();
    return v.parse(
      jobSchema,
      await invoke("rename_ai_media_output", {
        jobId: v.parse(text, jobId),
        resultIndex: v.parse(index, resultIndex),
        name: v.parse(text, name.trim()),
      }),
    );
  },
};
