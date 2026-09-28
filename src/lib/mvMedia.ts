import { invoke } from "@tauri-apps/api/core";
import * as v from "valibot";
import { isDesktopRuntime, type VideoCompositionJobRecord } from "./backend";
import { videoCompositionJobRecordSchema } from "./backendSchemas";

export interface MvMusicWindow {
  readonly id: string;
  readonly startSeconds: number;
  readonly endSeconds: number;
}

export interface MvSongProbe {
  readonly sourcePath: string;
  readonly durationSeconds: number;
  /** SHA-256 of the original file, not its path or display name. */
  readonly sourceSignature: string;
}

export interface MvAudioWindow {
  readonly path: string;
  readonly mimeType: "audio/wav";
  readonly durationSeconds: number;
  readonly sourceSignature: string;
  readonly window: MvMusicWindow;
}

export interface StartMvCompositionCommand {
  readonly songPath: string;
  readonly sourceSignature: string;
  readonly windows: readonly (MvMusicWindow & { readonly source: string })[];
  readonly outputName: string;
}

export interface MvMediaAlignment {
  readonly audioDurationSeconds: number;
  readonly videoDurationSeconds: number;
  readonly differenceSeconds: number;
  readonly toleranceSeconds: number;
  /** Measures stream duration alignment only; does not verify singing or lip synchronization. */
  readonly aligned: boolean;
}

export interface MvAsrTranscript {
  /** SHA-256 of the original song file bytes checked by the native command. */
  readonly sourceSignature: string;
  readonly engine: string;
  readonly modelVersion: string;
  readonly transcript: string;
  readonly segments: readonly {
    readonly startSeconds: number;
    readonly endSeconds: number;
    readonly text: string;
    readonly confidence?: number | undefined;
  }[];
}

export interface MvLyricsAlignment {
  readonly sourceSignature: string;
  readonly engine: string;
  readonly modelVersion: string;
  readonly lyrics: string;
  readonly lines: readonly {
    readonly text: string;
    readonly startSeconds: number;
    readonly endSeconds: number;
    readonly confidence?: number | undefined;
  }[];
  readonly unmatchedLyrics: readonly string[];
}

export interface MvMediaClient {
  probeSong(sourcePath: string): Promise<MvSongProbe>;
  prepareAudioWindow(
    sourcePath: string,
    sourceSignature: string,
    window: MvMusicWindow,
  ): Promise<MvAudioWindow>;
  startComposition(command: StartMvCompositionCommand): Promise<VideoCompositionJobRecord>;
  checkAlignment(finalPath: string, expectedDurationSeconds?: number): Promise<MvMediaAlignment>;
  clipSignature(path: string): Promise<string>;
  transcribeSong(
    sourcePath: string,
    sourceSignature: string,
    providerConnectionId: string,
  ): Promise<MvAsrTranscript>;
  alignLyrics(
    sourcePath: string,
    sourceSignature: string,
    lyrics: string,
    providerConnectionId: string,
  ): Promise<MvLyricsAlignment>;
}

const positive = v.pipe(v.number(), v.finite(), v.minValue(Number.MIN_VALUE));
const windowSchema = v.object({
  id: v.string(),
  startSeconds: v.pipe(v.number(), v.finite(), v.minValue(0)),
  endSeconds: positive,
});
const probeSchema = v.object({
  sourcePath: v.string(),
  durationSeconds: positive,
  sourceSignature: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
});
const audioWindowSchema = v.object({
  path: v.string(),
  mimeType: v.literal("audio/wav"),
  durationSeconds: positive,
  sourceSignature: v.string(),
  window: windowSchema,
});
const alignmentSchema = v.object({
  audioDurationSeconds: positive,
  videoDurationSeconds: positive,
  differenceSeconds: v.number(),
  toleranceSeconds: positive,
  aligned: v.boolean(),
});
const sha256Schema = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
const analysisIdentitySchema = {
  sourceSignature: sha256Schema,
  engine: v.pipe(v.string(), v.minLength(1)),
  modelVersion: v.pipe(v.string(), v.minLength(1)),
};
const analysisSegmentSchema = v.object({
  startSeconds: v.pipe(v.number(), v.finite(), v.minValue(0)),
  endSeconds: positive,
  text: v.string(),
  confidence: v.optional(v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(1))),
});
const asrSchema = v.object({
  ...analysisIdentitySchema,
  transcript: v.string(),
  segments: v.array(analysisSegmentSchema),
});
const lyricsAlignmentSchema = v.object({
  ...analysisIdentitySchema,
  lyrics: v.string(),
  lines: v.array(analysisSegmentSchema),
  unmatchedLyrics: v.array(v.string()),
});
async function call<T extends v.GenericSchema>(name: string, schema: T, command: unknown) {
  if (!isDesktopRuntime()) throw new Error("MV 音频处理和原曲合成需要在桌面应用中执行。");
  const result: unknown = await invoke(name, { command });
  const parsed = v.safeParse(schema, result);
  if (!parsed.success) throw new Error("MV 本地媒体处理返回了无效结果。");
  return parsed.output;
}

export const mvMediaClient: MvMediaClient = {
  probeSong: (sourcePath) => call("probe_mv_song", probeSchema, { sourcePath }),
  prepareAudioWindow: (sourcePath, sourceSignature, window) =>
    call("prepare_mv_audio_window", audioWindowSchema, { sourcePath, sourceSignature, window }),
  startComposition: (command) =>
    call("start_mv_composition", videoCompositionJobRecordSchema, command),
  checkAlignment: (finalPath, expectedDurationSeconds) =>
    call("check_mv_media_alignment", alignmentSchema, { finalPath, expectedDurationSeconds }),
  clipSignature: async (path) => {
    if (!isDesktopRuntime()) throw new Error("口型人工验收需要在桌面应用中读取实际片段。");
    const value: unknown = await invoke("mv_clip_signature", { path });
    const parsed = v.safeParse(sha256Schema, value);
    if (!parsed.success) throw new Error("片段 SHA-256 检查返回了无效结果。");
    return parsed.output;
  },
  transcribeSong: (sourcePath, sourceSignature, providerConnectionId) =>
    call("transcribe_mv_song", asrSchema, { sourcePath, sourceSignature, providerConnectionId }),
  alignLyrics: (sourcePath, sourceSignature, lyrics, providerConnectionId) =>
    call("align_mv_lyrics", lyricsAlignmentSchema, {
      sourcePath,
      sourceSignature,
      lyrics,
      providerConnectionId,
    }),
};
