import { invoke } from "@tauri-apps/api/core";
import * as v from "valibot";
import { isDesktopRuntime } from "./backend";

export interface SpeechVoice {
  readonly id: string;
  readonly name: string;
  readonly language: string;
  readonly engine: string;
}

export interface SynthesizeSpeechCommand {
  /** Stable identity for one workflow run and utterance. Reusing it with changed input fails. */
  readonly requestId: string;
  readonly providerConnectionId: string;
  readonly modelDefinitionId: string;
  readonly text: string;
  readonly voiceId: string;
}

export interface ListSpeechVoicesCommand {
  readonly providerConnectionId: string;
  readonly modelDefinitionId: string;
}

export interface SpeechRequestStatus {
  readonly status: "missing" | "outcome_unknown" | "recoverable" | "ready" | "invalid_output";
  readonly requestSignature: string | null;
  readonly path: string | null;
}

export interface SynthesizedSpeech {
  readonly path: string;
  readonly mimeType: "audio/wav";
  readonly durationSeconds: number;
  readonly voiceId: string;
  readonly requestSignature: string;
}

export interface ComposeDubbedVideoCommand {
  /** Stable identity for one workflow run and shot. Reusing it with changed media fails. */
  readonly requestId: string;
  readonly sourcePath: string;
  readonly segments: readonly {
    readonly audioPath: string;
    readonly startSeconds: number;
  }[];
  readonly outputName: string;
}

export interface DubbedVideo {
  readonly path: string;
  readonly durationSeconds: number;
  readonly requestSignature: string;
  readonly videoSignature: string;
}

const positive = v.pipe(v.number(), v.finite(), v.minValue(Number.MIN_VALUE));
const voiceSchema = v.object({
  id: v.string(), name: v.string(), language: v.string(), engine: v.string(),
});
const synthesizedSchema = v.object({
  path: v.string(), mimeType: v.literal("audio/wav"), durationSeconds: positive,
  voiceId: v.string(), requestSignature: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
});
const dubbedSchema = v.object({
  path: v.string(), durationSeconds: positive,
  requestSignature: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
  videoSignature: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
});
const requestStatusSchema = v.object({
  status: v.picklist(["missing", "outcome_unknown", "recoverable", "ready", "invalid_output"]),
  requestSignature: v.nullable(v.string()),
  path: v.nullable(v.string()),
});

async function call<T extends v.GenericSchema>(name: string, schema: T, command?: unknown) {
  if (!isDesktopRuntime()) throw new Error("自动配音需要在桌面应用中执行。");
  const result: unknown = await invoke(name, command === undefined ? undefined : { command });
  const parsed = v.safeParse(schema, result);
  if (!parsed.success) throw new Error("语音后端返回了无效结果。");
  return parsed.output;
}

export const speechClient = {
  listVoices: (command: ListSpeechVoicesCommand): Promise<readonly SpeechVoice[]> =>
    call("list_speech_voices", v.array(voiceSchema), command),
  getRequestStatus: (requestId: string): Promise<SpeechRequestStatus> =>
    call("get_speech_request_status", requestStatusSchema, { requestId }),
  synthesize: (command: SynthesizeSpeechCommand): Promise<SynthesizedSpeech> =>
    call("synthesize_speech", synthesizedSchema, command),
  composeDubbedVideo: (command: ComposeDubbedVideoCommand): Promise<DubbedVideo> =>
    call("compose_dubbed_video", dubbedSchema, command),
};
