import { invoke } from "@tauri-apps/api/core";
import * as v from "valibot";
import { isDesktopRuntime, type MediaReferenceTarget } from "./backend";

const text = v.pipe(v.string(), v.nonEmpty());
const positive = v.pipe(v.number(), v.finite(), v.minValue(0));
const index = v.pipe(positive, v.integer());
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
const operationSchema = v.picklist(["extract_audio", "silent_video", "clip_video"]);
const formatSchema = v.picklist(["wav", "original"]);
const probeSchema = v.object({
  durationSeconds: v.pipe(positive, v.minValue(Number.EPSILON)),
  width: index,
  height: index,
  fps: positive,
  audioStreams: v.array(
    v.object({
      index,
      codec: text,
      language: v.nullish(v.string()),
      channels: index,
      sampleRate: positive,
    }),
  ),
  sourceIdentity: text,
});
const outputSchema = v.object({
  kind: v.picklist(["audio", "video"]),
  path: text,
  name: text,
  mimeType: text,
  durationSeconds: positive,
  width: v.nullish(index),
  height: v.nullish(index),
});
const jobSchema = v.object({
  jobId: text,
  source: sourceSchema,
  sourceIdentity: text,
  name: text,
  operation: operationSchema,
  startSeconds: positive,
  endSeconds: positive,
  audioStreamIndex: v.nullish(index),
  format: formatSchema,
  status: v.picklist(["preparing", "processing", "paused", "completed", "failed", "cancelled"]),
  progress: v.nullish(v.pipe(positive, v.maxValue(100))),
  output: v.nullish(outputSchema),
  createdAt: positive,
  updatedAt: positive,
  error: v.nullish(v.string()),
});

export type VideoPreparationOperation = v.InferOutput<typeof operationSchema>;
export type VideoPreparationAudioFormat = v.InferOutput<typeof formatSchema>;
export type VideoPreparationProbe = v.InferOutput<typeof probeSchema>;
export type VideoPreparationOutput = v.InferOutput<typeof outputSchema>;
export type VideoPreparationJob = v.InferOutput<typeof jobSchema>;

export interface StartVideoPreparationCommand {
  readonly source: MediaReferenceTarget;
  readonly name: string;
  readonly operation: VideoPreparationOperation;
  readonly startSeconds: number;
  readonly endSeconds?: number;
  readonly audioStreamIndex?: number;
  readonly format?: VideoPreparationAudioFormat;
  /** Bind the request to the exact source measured by probe, never a preview lease. */
  readonly sourceIdentity: string;
}

const commandSchema = v.object({
  source: sourceSchema,
  name: text,
  operation: operationSchema,
  startSeconds: positive,
  endSeconds: v.optional(positive),
  audioStreamIndex: v.optional(index),
  format: v.optional(formatSchema),
  sourceIdentity: text,
});

function requireDesktop() {
  if (!isDesktopRuntime()) throw new Error("视频准备需要在桌面应用中运行。");
}

/** Validate the measured range before starting any native side effect. */
export function validateVideoPreparationRange(
  startSeconds: number,
  endSeconds: number,
  durationSeconds: number,
): string | null {
  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds))
    return "请输入有效的起止时间。";
  if (startSeconds < 0 || endSeconds > durationSeconds) return "选区必须位于视频时长内。";
  if (endSeconds <= startSeconds) return "结束时间必须大于开始时间。";
  return null;
}

export function isVideoPreparationActive(job: VideoPreparationJob): boolean {
  return job.status === "preparing" || job.status === "processing";
}

/** Responses are untrusted IPC data; validate before rendering or using output paths. */
export const videoPreparationClient = {
  async probe(source: MediaReferenceTarget): Promise<VideoPreparationProbe> {
    requireDesktop();
    return v.parse(
      probeSchema,
      await invoke("probe_video_preparation", { source: v.parse(sourceSchema, source) }),
    );
  },
  async start(command: StartVideoPreparationCommand): Promise<VideoPreparationJob> {
    requireDesktop();
    const validated = v.parse(commandSchema, command);
    if (validated.endSeconds != null && validated.endSeconds <= validated.startSeconds) {
      throw new Error("结束时间必须大于开始时间。");
    }
    return v.parse(jobSchema, await invoke("start_video_preparation", { command: validated }));
  },
  async get(jobId: string): Promise<VideoPreparationJob> {
    requireDesktop();
    return v.parse(
      jobSchema,
      await invoke("get_video_preparation_job", { jobId: v.parse(text, jobId) }),
    );
  },
  async list(): Promise<VideoPreparationJob[]> {
    requireDesktop();
    return v.parse(v.array(jobSchema), await invoke("list_video_preparation_jobs"));
  },
  async retry(jobId: string): Promise<VideoPreparationJob> {
    requireDesktop();
    return v.parse(
      jobSchema,
      await invoke("retry_video_preparation_job", { jobId: v.parse(text, jobId) }),
    );
  },
  async cancel(jobId: string): Promise<VideoPreparationJob> {
    requireDesktop();
    return v.parse(
      jobSchema,
      await invoke("cancel_video_preparation_job", { jobId: v.parse(text, jobId) }),
    );
  },
  async rename(jobId: string, name: string): Promise<VideoPreparationJob> {
    requireDesktop();
    return v.parse(
      jobSchema,
      await invoke("rename_video_preparation_output", {
        jobId: v.parse(text, jobId),
        name: v.parse(text, name),
      }),
    );
  },
};
