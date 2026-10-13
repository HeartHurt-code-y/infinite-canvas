import * as v from "valibot";
import { invokeDesktop, isDesktopRuntime, subscribeBackendEvent } from "./ipc";

export interface ReelbenchShot {
  id: string;
  start: number;
  end: number;
  seconds: number;
  motion: number | null;
  size: string;
  category: string;
  camera: string;
  transitionIn: string;
  subjects: string[];
  frame: string;
  onscreenText: string;
  audio: string;
  rhythm: string;
  rhythmNote: string;
  note: string;
  frameAPath: string;
  frameBPath: string;
}

export interface ReelbenchShotDraft {
  runId: string;
  videoPath: string;
  outputDir: string;
  sourceIdentity: { sizeBytes: number; modifiedUnixMs: number; sha256: string };
  meta: {
    durationSeconds: number;
    fps: number;
    width: number;
    height: number;
    hasAudio: boolean;
  };
  sceneThreshold: number;
  minShotSeconds: number;
  seedCuts: number[];
  manualCuts: number[];
  cast: Array<{ id: string; name: string; note: string }>;
  trackPath: string;
  sheets: Array<{
    fromId: string;
    toId: string;
    shotIds: string[];
    frameAPath: string;
    frameBPath: string;
  }>;
  shots: ReelbenchShot[];
}

export interface ReelbenchValidation {
  ok: boolean;
  gates: Array<{ id: string; ok: boolean; skipped: boolean; issues: string[] }>;
  hints: string[];
}

export interface ReelbenchProgress {
  runId: string;
  phase: "probe" | "cuts" | "motion" | "frames" | "sheets" | "export";
  current: number;
  total: number;
}

export interface ReelbenchVideoExport {
  videoPath: string;
  width: number;
  height: number;
  durationSeconds: number;
}

const reelbenchShotSchema = v.object({
  id: v.string(),
  start: v.number(),
  end: v.number(),
  seconds: v.number(),
  motion: v.nullable(v.number()),
  size: v.string(),
  category: v.string(),
  camera: v.string(),
  transitionIn: v.string(),
  subjects: v.array(v.string()),
  frame: v.string(),
  onscreenText: v.string(),
  audio: v.string(),
  rhythm: v.string(),
  rhythmNote: v.string(),
  note: v.string(),
  frameAPath: v.string(),
  frameBPath: v.string(),
});

const reelbenchShotDraftSchema = v.object({
  runId: v.string(),
  videoPath: v.string(),
  outputDir: v.string(),
  sourceIdentity: v.object({
    sizeBytes: v.number(),
    modifiedUnixMs: v.number(),
    sha256: v.string(),
  }),
  meta: v.object({
    durationSeconds: v.number(),
    fps: v.number(),
    width: v.number(),
    height: v.number(),
    hasAudio: v.boolean(),
  }),
  sceneThreshold: v.number(),
  minShotSeconds: v.number(),
  seedCuts: v.array(v.number()),
  manualCuts: v.array(v.number()),
  cast: v.array(v.object({ id: v.string(), name: v.string(), note: v.string() })),
  trackPath: v.string(),
  sheets: v.array(
    v.object({
      fromId: v.string(),
      toId: v.string(),
      shotIds: v.array(v.string()),
      frameAPath: v.string(),
      frameBPath: v.string(),
    }),
  ),
  shots: v.array(reelbenchShotSchema),
});

const reelbenchValidationSchema = v.object({
  ok: v.boolean(),
  gates: v.array(
    v.object({
      id: v.string(),
      ok: v.boolean(),
      skipped: v.boolean(),
      issues: v.array(v.string()),
    }),
  ),
  hints: v.array(v.string()),
});

const reelbenchVideoExportSchema = v.object({
  videoPath: v.string(),
  width: v.number(),
  height: v.number(),
  durationSeconds: v.number(),
});

const reelbenchProgressSchema = v.object({
  runId: v.string(),
  phase: v.picklist(["probe", "cuts", "motion", "frames", "sheets", "export"]),
  current: v.number(),
  total: v.number(),
});

export const reelbenchBackendClient = {
  async analyze(command: {
    videoPath: string;
    runId: string;
    sceneThreshold?: number;
    minShotSeconds?: number;
  }): Promise<ReelbenchShotDraft> {
    return invokeDesktop("analyze_reelbench_video", reelbenchShotDraftSchema, { command });
  },

  async recut(command: {
    draft: ReelbenchShotDraft;
    splitCuts: number[];
    mergeCuts: number[];
  }): Promise<ReelbenchShotDraft> {
    return invokeDesktop("recut_reelbench_video", reelbenchShotDraftSchema, { command });
  },

  async validate(command: { draft: ReelbenchShotDraft }): Promise<ReelbenchValidation> {
    return invokeDesktop("validate_reelbench_shots", reelbenchValidationSchema, command);
  },

  async exportVideo(command: {
    draft: ReelbenchShotDraft;
    scale?: number;
    lang?: "zh" | "en";
  }): Promise<ReelbenchVideoExport> {
    return invokeDesktop("export_reelbench_video", reelbenchVideoExportSchema, { command });
  },

  onProgress(listener: (progress: ReelbenchProgress) => void): Promise<() => void> {
    // 与其他客户端不同：拉片进度事件要区分「非桌面」与「订阅失败」，保持原有
    // desktopOnly 的人话报错，而不是静默拿到一个永远不触发的订阅。
    if (!isDesktopRuntime()) {
      return Promise.reject(new Error("拉片分析与视频合成需要桌面应用。 "));
    }
    return Promise.resolve(
      subscribeBackendEvent("reelbench-progress", reelbenchProgressSchema, listener),
    );
  },
};
