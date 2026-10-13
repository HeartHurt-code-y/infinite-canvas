import { invokeDesktop } from "./ipc";
import * as v from "valibot";
import { isDesktopRuntime } from "./backend";

export interface ReverseVideoSheetMetadata {
  readonly displayName: string;
  readonly phase?: "overview" | "tail";
  readonly firstTime?: number;
  readonly lastTime?: number;
  readonly frameCount?: number;
}

export interface ReverseVideoEvidence {
  readonly duration: number;
  readonly width: number;
  readonly height: number;
  readonly overviewFrameCount: number;
  readonly tailFrameCount: number;
  readonly sheets: readonly (ReverseVideoSheetMetadata & { readonly localPath: string })[];
  readonly representativeFrames?: readonly {
    readonly localPath: string;
    readonly displayName: string;
    readonly time: number;
  }[];
}

export interface ReverseVideoLearning {
  readonly caseCount: number;
  readonly summary: string;
}

export interface ReverseVideoDelivery {
  readonly caseId: string;
  readonly directory: string;
  readonly videoPath: string;
  readonly markdownPath: string;
  readonly textPath: string;
  readonly casePath: string;
  readonly caseCount: number;
}

export interface ReverseVideoClient {
  saveEvidence(command: {
    readonly runId: string;
    readonly videoPath: string;
    readonly duration: number;
    readonly width: number;
    readonly height: number;
    readonly overviewFrameCount: number;
    readonly tailFrameCount: number;
    readonly sheets: readonly (ReverseVideoSheetMetadata & { readonly dataUrl: string })[];
    readonly representativeFrames?: readonly {
      readonly dataUrl: string;
      readonly displayName: string;
      readonly time: number;
    }[];
  }): Promise<ReverseVideoEvidence>;
  getLearning(): Promise<ReverseVideoLearning>;
  deliver(command: {
    readonly runId: string;
    readonly sourceUrl: string;
    readonly videoPath: string;
    readonly title: string;
    readonly markdown: string;
    readonly promptText: string;
    readonly tags: readonly string[];
    readonly analysis: Readonly<Record<string, string>>;
    readonly evidence?: ReverseVideoEvidence;
  }): Promise<ReverseVideoDelivery>;
}

const pathSchema = v.pipe(v.string(), v.nonEmpty());
const evidenceSchema = v.object({
  duration: v.number(),
  width: v.number(),
  height: v.number(),
  overviewFrameCount: v.number(),
  tailFrameCount: v.number(),
  sheets: v.array(
    v.object({
      displayName: v.string(),
      localPath: pathSchema,
      phase: v.exactOptional(v.picklist(["overview", "tail"])),
      firstTime: v.exactOptional(v.number()),
      lastTime: v.exactOptional(v.number()),
      frameCount: v.exactOptional(v.number()),
    }),
  ),
  representativeFrames: v.exactOptional(
    v.array(v.object({ localPath: pathSchema, displayName: v.string(), time: v.number() })),
  ),
});
const learningSchema = v.object({ caseCount: v.number(), summary: v.string() });
const deliverySchema = v.object({
  caseId: pathSchema,
  directory: pathSchema,
  videoPath: pathSchema,
  markdownPath: pathSchema,
  textPath: pathSchema,
  casePath: pathSchema,
  caseCount: v.number(),
});

function requireDesktop(): void {
  if (!isDesktopRuntime()) throw new Error("视频反推与案例保存需要在桌面应用中执行。");
}

export const reverseVideoClient: ReverseVideoClient = {
  async saveEvidence(command) {
    requireDesktop();
    return invokeDesktop("save_reverse_video_evidence", evidenceSchema, { command });
  },
  async getLearning() {
    requireDesktop();
    return invokeDesktop("get_reverse_video_learning", learningSchema);
  },
  async deliver(command) {
    requireDesktop();
    return invokeDesktop("deliver_reverse_video", deliverySchema, { command });
  },
};
