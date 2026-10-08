import { describe, expect, it, vi } from "vitest";
import type { VideoDownloadJobRecord, VideoDownloaderClient } from "../../lib/backend";
import type { ReelbenchShotDraft, reelbenchBackendClient } from "../../lib/reelbenchBackend";
import { catalog, node } from "../../test/videoWorkflowFixtures";
import { approveWorkflowExecutionPlan, createWorkflowExecutionPlan } from "./workflowExecutionPlan";
import {
  createReelbenchCheckpoint,
  createReelbenchOptions,
  parseReelbenchAnnotationBatch,
  reelbenchDraftSignature,
  reelbenchInputSignature,
} from "./reelbenchWorkflowModel";
import { createReelbenchWorkflowRunner } from "./reelbenchWorkflowRunner";
import type { KnowledgeVideoWorkflowNodeData } from "./workspaceModel";

const draft: ReelbenchShotDraft = {
  runId: "19dd8970-95a0-402c-b49a-291e41642510",
  videoPath: "C:\\video\\source.mp4",
  outputDir: "C:\\app\\reelbench\\run",
  sourceIdentity: { sizeBytes: 12345, modifiedUnixMs: 100, sha256: "a".repeat(64) },
  meta: { durationSeconds: 3, fps: 30, width: 720, height: 1280, hasAudio: true },
  sceneThreshold: 0.3,
  minShotSeconds: 0.25,
  seedCuts: [],
  manualCuts: [],
  cast: [],
  trackPath: "C:\\app\\reelbench\\run\\track.json",
  sheets: [
    { fromId: "S01", toId: "S01", shotIds: ["S01"], frameAPath: "a.jpg", frameBPath: "b.jpg" },
  ],
  shots: [
    {
      id: "S01",
      start: 0,
      end: 3,
      seconds: 3,
      motion: 0.01,
      size: "medium",
      category: "subject",
      camera: "static",
      transitionIn: "cut",
      subjects: [],
      frame: "人物在右侧桌边拿起透明水杯，左侧窗光照在杯口。",
      onscreenText: "",
      audio: "",
      rhythm: "",
      rhythmNote: "",
      note: "",
      frameAPath: "S01a.jpg",
      frameBPath: "S01b.jpg",
    },
  ],
};
const validation = {
  ok: true,
  gates: [{ id: "time", ok: true, skipped: false, issues: [] }],
  hints: [],
};

function source(
  approvedDraftSignature: string | null,
  changedBrief = false,
  inputDraft = draft,
  pendingRecut: { splitCuts: number[]; mergeCuts: number[] } | null = null,
): KnowledgeVideoWorkflowNodeData {
  const base = node();
  const config = {
    ...base.config,
    reelbench: { ...createReelbenchOptions(), localVideoPath: draft.videoPath },
  };
  const current: KnowledgeVideoWorkflowNodeData = {
    ...base,
    config: {
      ...config,
      checkpoint: {
        ...config.checkpoint,
        runId: draft.runId,
        phase: "paused",
        reelbench: {
          ...createReelbenchCheckpoint(),
          inputSignature: reelbenchInputSignature(config),
          videoPath: draft.videoPath,
          draft: inputDraft,
          validation: inputDraft === draft ? validation : null,
          validatedDraftSignature: inputDraft === draft ? reelbenchDraftSignature(draft) : null,
          step: "review",
          approvedDraftSignature,
          pendingRecut,
        },
      },
    },
  };
  const executionPlan = approveWorkflowExecutionPlan(
    createWorkflowExecutionPlan(current, "resume"),
    current,
  );
  return {
    ...current,
    config: {
      ...current.config,
      ...(changedBrief ? { brief: "已改变的重点要求" } : {}),
      executionPlan,
      checkpoint: { ...current.config.checkpoint, executionPlan },
    },
  };
}

function setup(promptClient?: {
  run: () => Promise<{ optimizedPrompt: string; rawModelOutput: string }>;
}) {
  const writeReports = vi.fn(() =>
    Promise.resolve({
      reportJsonPath: "C:\\app\\reelbench\\run\\shots.json",
      reportMarkdownPath: "C:\\app\\reelbench\\run\\shots.md",
      reportHtmlPath: "C:\\app\\reelbench\\run\\shots-report.html",
    }),
  );
  const exportVideo = vi.fn(() =>
    Promise.resolve({
      videoPath: "sync.mp4",
      width: 720,
      height: 1280,
      durationSeconds: 3,
    }),
  );
  const backend = {
    analyze: vi.fn(),
    recut: vi.fn(),
    validate: vi.fn((command: { draft: ReelbenchShotDraft }) => {
      void command;
      return Promise.resolve(validation);
    }),
    exportVideo,
  };
  const runner = createReelbenchWorkflowRunner({
    backend: backend as unknown as typeof reelbenchBackendClient,
    ...(promptClient ? { promptClient } : {}),
    writeReports,
    now: () => 123,
  });
  const onCheckpoint = vi.fn();
  const beforeSideEffect = vi.fn(() => Promise.resolve());
  const run = (current: KnowledgeVideoWorkflowNodeData) =>
    runner.run({
      node: current,
      providerCatalog: catalog,
      resume: true,
      signal: new AbortController().signal,
      onCheckpoint,
      onProgress: vi.fn(),
      beforeSideEffect,
    });
  return { run, backend, writeReports, beforeSideEffect };
}

describe("Reelbench workflow safeguards", () => {
  it("shows the actual download credential source and keeps the extractor error", async () => {
    const base = node();
    const original = {
      ...base,
      config: {
        ...base.config,
        reelbench: {
          ...createReelbenchOptions(),
          sourceUrl: "https://www.xiaohongshu.com/explore/example",
        },
      },
    };
    const plan = approveWorkflowExecutionPlan(createWorkflowExecutionPlan(original), original);
    const approved = {
      ...original,
      config: {
        ...original.config,
        executionPlan: plan,
        checkpoint: { ...original.config.checkpoint, executionPlan: plan },
      },
    };
    const failedJob: VideoDownloadJobRecord = {
      jobId: "download-1",
      url: original.config.reelbench.sourceUrl,
      status: "failed",
      progress: 0,
      finalPath: null,
      fileName: null,
      qualityMode: null,
      qualityHint: null,
      watermarkRemoved: false,
      credentialSource: "none",
      error: "requested format is not available",
      createdAt: 1,
      updatedAt: 2,
    };
    const downloader = {
      getEngine: vi.fn(() => Promise.resolve({ state: "ready", lastError: null })),
      startDownload: vi.fn(() => Promise.resolve(failedJob)),
    } as unknown as VideoDownloaderClient;
    const runner = createReelbenchWorkflowRunner({ downloader, now: () => 123 });
    const result = await runner.run({
      node: approved,
      providerCatalog: catalog,
      resume: false,
      signal: new AbortController().signal,
      onCheckpoint: vi.fn(),
      onProgress: vi.fn(),
      beforeSideEffect: vi.fn(async () => {}),
    });
    expect(result.phase).toBe("failed");
    expect(result.reelbench?.downloadJobId).toBe("download-1");
    expect(result.error).toContain("本次任务凭据来源：未使用 Cookies（不代表已登录）");
    expect(result.error).toContain("requested format is not available");
  });

  it("never exports a validated draft before its exact content is batch-approved", async () => {
    const test = setup();
    const result = await test.run(source(null));
    expect(result.phase).toBe("paused");
    expect(result.reelbench?.step).toBe("review");
    expect(test.writeReports).not.toHaveBeenCalled();
    expect(test.backend.exportVideo).not.toHaveBeenCalled();
  });

  it("blocks report side effects when the approved plan becomes stale", async () => {
    const test = setup();
    const result = await test.run(source(reelbenchDraftSignature(draft), true));
    expect(result.phase).toBe("failed");
    expect(result.error).toContain("已改变");
    expect(test.writeReports).not.toHaveBeenCalled();
  });

  it("revalidates source bytes on resume and rejects a same-path replacement before export", async () => {
    const test = setup();
    test.backend.validate.mockRejectedValueOnce(new Error("原片内容哈希已改变"));
    const result = await test.run(source(reelbenchDraftSignature(draft)));
    expect(test.backend.validate).toHaveBeenCalledTimes(1);
    expect(result.phase).toBe("failed");
    expect(result.error).toContain("哈希");
    expect(test.writeReports).not.toHaveBeenCalled();
    expect(test.backend.exportVideo).not.toHaveBeenCalled();
  });

  it("registers model-described subjects before the native subjects gate runs", async () => {
    const unannotated = {
      ...draft,
      shots: [{ ...draft.shots[0]!, size: "", category: "", camera: "", frame: "" }],
      cast: [{ id: "old", name: "旧主体", note: "保留备注" }],
    };
    const output = JSON.stringify({
      schemaVersion: "shot-analysis.v1",
      shots: [
        {
          id: "S01",
          size: "medium",
          category: "subject",
          camera: "static",
          frame: "人物甲在桌边举起玻璃杯，右后方有窗光。",
          transitionIn: "cut",
          subjects: ["人物甲"],
          onscreenText: "",
          audio: "",
          note: "",
        },
      ],
    });
    const test = setup({
      run: vi.fn(() => Promise.resolve({ optimizedPrompt: output, rawModelOutput: output })),
    });
    const result = await test.run(source(null, false, unannotated));
    expect(result.phase).toBe("paused");
    expect(test.backend.validate).toHaveBeenCalledTimes(1);
    const verifiedDraft = test.backend.validate.mock.lastCall?.[0].draft;
    expect(verifiedDraft?.cast).toEqual([
      { id: "old", name: "旧主体", note: "保留备注" },
      { id: "人物甲", name: "人物甲", note: "" },
    ]);
    expect(verifiedDraft?.shots[0]?.subjects).toEqual(["人物甲"]);
  });

  it("applies every queued split and merge in a single native recut", async () => {
    const test = setup();
    test.backend.recut.mockResolvedValueOnce(draft);
    const result = await test.run(
      source(null, false, draft, { splitCuts: [1, 2], mergeCuts: [0.5] }),
    );
    expect(test.backend.recut).toHaveBeenCalledWith({
      draft,
      splitCuts: [1, 2],
      mergeCuts: [0.5],
    });
    expect(result.phase).toBe("paused");
  });

  it("accepts only the requested shot IDs and ignores model-supplied timing", () => {
    const response = JSON.stringify({
      schemaVersion: "shot-analysis.v1",
      shots: [
        {
          id: "S01",
          start: 100,
          end: 200,
          size: "medium",
          category: "subject",
          camera: "static",
          frame: "人物在右侧桌边拿起透明水杯，左侧窗光照在杯口。",
          transitionIn: "cut",
          subjects: [],
          onscreenText: "",
          audio: "",
          note: "",
        },
      ],
    });
    const result = parseReelbenchAnnotationBatch(response, ["S01"]);
    expect(result[0]?.id).toBe("S01");
    expect(result[0]).not.toHaveProperty("start");
    expect(() => parseReelbenchAnnotationBatch(response, ["S02"])).toThrow("ID");
    expect(() =>
      parseReelbenchAnnotationBatch(
        response.replace("人物在右侧", "https://other.site/人物在右侧"),
        ["S01"],
      ),
    ).toThrow("第三方");
  });
});
