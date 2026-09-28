import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isDesktopRuntime } from "./backend";

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

function desktopOnly(): void {
  if (!isDesktopRuntime()) {
    throw new Error("拉片分析与视频合成需要桌面应用。 ");
  }
}

export const reelbenchBackendClient = {
  async analyze(command: {
    videoPath: string;
    runId: string;
    sceneThreshold?: number;
    minShotSeconds?: number;
  }): Promise<ReelbenchShotDraft> {
    desktopOnly();
    return invoke<ReelbenchShotDraft>("analyze_reelbench_video", { command });
  },

  async recut(command: {
    draft: ReelbenchShotDraft;
    splitCuts: number[];
    mergeCuts: number[];
  }): Promise<ReelbenchShotDraft> {
    desktopOnly();
    return invoke<ReelbenchShotDraft>("recut_reelbench_video", { command });
  },

  async validate(command: { draft: ReelbenchShotDraft }): Promise<ReelbenchValidation> {
    desktopOnly();
    return invoke<ReelbenchValidation>("validate_reelbench_shots", command);
  },

  async exportVideo(command: {
    draft: ReelbenchShotDraft;
    scale?: number;
    lang?: "zh" | "en";
  }): Promise<ReelbenchVideoExport> {
    desktopOnly();
    return invoke<ReelbenchVideoExport>("export_reelbench_video", { command });
  },

  onProgress(listener: (progress: ReelbenchProgress) => void): Promise<() => void> {
    desktopOnly();
    return listen<ReelbenchProgress>("reelbench-progress", (event) => listener(event.payload));
  },
};
