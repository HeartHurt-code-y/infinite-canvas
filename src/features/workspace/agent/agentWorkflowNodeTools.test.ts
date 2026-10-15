import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  videoComposerClient,
  videoFrameExtractionClient,
  type VideoCompositionJobRecord,
  type VideoFrameExtractionJobRecord,
} from "../../../lib/backend";
import {
  createAgentWorkflowNodeTools,
  type AgentWorkflowNodeHost,
} from "./agentWorkflowNodeTools";
import type { AgentToolContext } from "./agentTypes";

function extractionRecord(patch: Partial<VideoFrameExtractionJobRecord> = {}): VideoFrameExtractionJobRecord {
  return {
    jobId: "extract-1",
    videoPath: "C:/Downloads/a.mp4",
    status: "processing",
    progress: 20,
    frames: [],
    error: null,
    createdAt: 1,
    updatedAt: 2,
    ...patch,
  };
}

function compositionRecord(patch: Partial<VideoCompositionJobRecord> = {}): VideoCompositionJobRecord {
  return {
    jobId: "compose-1",
    status: "processing",
    progress: 30,
    finalPath: null,
    fileName: null,
    width: null,
    height: null,
    durationSeconds: null,
    error: null,
    createdAt: 1,
    updatedAt: 2,
    ...patch,
  };
}

function harness() {
  const setDocument = vi.fn();
  const setExtractorTimestamps = vi.fn();
  const extractionSource = vi.fn(() => ({
    videoPath: "C:/Downloads/a.mp4",
    timestamps: [1, 3],
  }));
  const attachFrames = vi.fn(() =>
    Promise.resolve({ outputNodeKeys: ["output-1", "output-2"] }),
  );
  const compositionInputs = vi.fn(() => ({
    inputs: [
      { key: "a", name: "第一段", source: "C:/Downloads/a.mp4" },
      { key: "b", name: "第二段", source: "C:/Downloads/b.mp4" },
    ],
    outputName: "合成视频",
  }));
  const attachComposition = vi.fn(() => Promise.resolve({ outputNodeKey: "output-9" }));
  const host: AgentWorkflowNodeHost = {
    setDocument,
    setExtractorTimestamps,
    extractionSource,
    attachFrames,
    compositionInputs,
    attachComposition,
  };
  const controller = new AbortController();
  const context: AgentToolContext = {
    signal: controller.signal,
    callId: "step-1",
    report: vi.fn(),
    resolveNodeKey: (key) => (key === "$doc" ? "screenplay-1" : key),
    assertCurrent: () => {},
    mutate: (change) => change(),
  };
  const tools = createAgentWorkflowNodeTools(host);
  return {
    host,
    tools,
    context,
    controller,
    setDocument,
    setExtractorTimestamps,
    extractionSource,
    attachFrames,
    compositionInputs,
    attachComposition,
    tool: (name: string) => {
      const found = tools.find((item) => item.name === name);
      if (!found) throw new Error(`工具未注册：${name}`);
      return found;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(videoFrameExtractionClient, "startExtraction");
  vi.spyOn(videoFrameExtractionClient, "getJob");
  vi.spyOn(videoFrameExtractionClient, "cancelJob");
  vi.spyOn(videoComposerClient, "startComposition");
  vi.spyOn(videoComposerClient, "getJob");
  vi.spyOn(videoComposerClient, "cancelJob");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("智能体剧本与分镜文档工具", () => {
  it("解析节点引用后整篇写入文档，回传字数", async () => {
    const view = harness();
    const result = await view
      .tool("canvas.set_document")
      .execute({ nodeKey: "$doc", text: "# 第一幕\n台词" }, view.context);

    expect(view.setDocument).toHaveBeenCalledWith("screenplay-1", "# 第一幕\n台词");
    expect(result).toEqual({ nodeKey: "screenplay-1", updated: true, characters: 8 });
  });

  it("拒绝其他节点承载文档", () => {
    const view = harness();
    view.setDocument.mockImplementation(() => {
      throw new Error("只有剧本或分镜节点有文档；请重新读取画布确认节点身份。");
    });
    // 宿主同步抛错与 canvas.set_prompt 同一语义：控制器在 await 处同样接得住。
    expect(() =>
      view.tool("canvas.set_document").execute({ nodeKey: "gen-1", text: "x" }, view.context),
    ).toThrow("只有剧本或分镜节点有文档");
  });
});

describe("智能体视频抽帧工具", () => {
  it("写入秒数、按来源启动抽帧并落卡；结果不携带本机路径", async () => {
    const view = harness();
    vi.mocked(videoFrameExtractionClient.startExtraction).mockResolvedValue(
      extractionRecord({ progress: null }),
    );
    vi.mocked(videoFrameExtractionClient.getJob)
      .mockResolvedValueOnce(extractionRecord({ progress: 50 }))
      .mockResolvedValueOnce(
        extractionRecord({
          status: "completed",
          progress: 100,
          frames: [
            { path: "C:/frames/a_1.jpg", timestampSeconds: 1, width: 1920, height: 1080 },
            { path: "C:/frames/a_3.jpg", timestampSeconds: 3, width: 1920, height: 1080 },
          ],
        }),
      );

    const run = view
      .tool("frame_extract.run")
      .execute({ nodeKey: "extract-1", timestamps: [2] }, view.context);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    const result = (await run) as Record<string, unknown>;

    expect(view.setExtractorTimestamps).toHaveBeenCalledWith("extract-1", [2]);
    expect(view.extractionSource).toHaveBeenCalledWith("extract-1");
    expect(videoFrameExtractionClient.startExtraction).toHaveBeenCalledWith("C:/Downloads/a.mp4", [
      1,
      3,
    ]);
    expect(view.attachFrames).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      nodeKey: "extract-1",
      jobId: "extract-1",
      frameCount: 2,
      timestamps: [1, 3],
      outputNodeKeys: ["output-1", "output-2"],
    });
    expect(JSON.stringify(result)).not.toContain("C:/");
  });

  it("不填 timestamps 时不改写节点配置", async () => {
    const view = harness();
    vi.mocked(videoFrameExtractionClient.startExtraction).mockResolvedValue(
      extractionRecord({ status: "completed", progress: 100 }),
    );
    const run = view.tool("frame_extract.run").execute({ nodeKey: "extract-1" }, view.context);
    await vi.advanceTimersByTimeAsync(1000);
    await run;

    expect(view.setExtractorTimestamps).not.toHaveBeenCalled();
  });

  it("失败原因原样返回给模型，终态失败不再取消", async () => {
    const view = harness();
    vi.mocked(videoFrameExtractionClient.startExtraction).mockResolvedValue(
      extractionRecord({ status: "failed", error: "视频文件无法读取" }),
    );
    const settled = expect(
      view.tool("frame_extract.run").execute({ nodeKey: "extract-1" }, view.context),
    ).rejects.toThrow("视频文件无法读取");
    await vi.advanceTimersByTimeAsync(1000);
    await settled;

    expect(view.attachFrames).not.toHaveBeenCalled();
    expect(videoFrameExtractionClient.cancelJob).not.toHaveBeenCalled();
  });

  it("停止后取消后端任务且不落卡", async () => {
    const view = harness();
    vi.mocked(videoFrameExtractionClient.startExtraction).mockResolvedValue(extractionRecord());
    vi.mocked(videoFrameExtractionClient.getJob).mockResolvedValue(extractionRecord());
    const run = view.tool("frame_extract.run").execute({ nodeKey: "extract-1" }, view.context);
    const settled = expect(run).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(100);
    view.controller.abort();
    await vi.advanceTimersByTimeAsync(1000);
    await settled;

    expect(videoFrameExtractionClient.cancelJob).toHaveBeenCalledWith("extract-1");
    expect(view.attachFrames).not.toHaveBeenCalled();
  });
});

describe("智能体视频合成工具", () => {
  it("按宿主解析的顺序提交合成并落卡；结果不携带本机路径", async () => {
    const view = harness();
    vi.mocked(videoComposerClient.startComposition).mockResolvedValue(compositionRecord());
    vi.mocked(videoComposerClient.getJob).mockResolvedValue(
      compositionRecord({
        status: "completed",
        progress: 100,
        finalPath: "C:/Users/me/合成视频.mp4",
        fileName: "合成视频.mp4",
        width: 1920,
        height: 1080,
        durationSeconds: 12.5,
      }),
    );

    const run = view.tool("video_compose.run").execute({ nodeKey: "compose-node" }, view.context);
    await vi.advanceTimersByTimeAsync(1000);
    const result = (await run) as Record<string, unknown>;

    expect(view.compositionInputs).toHaveBeenCalledWith("compose-node");
    expect(videoComposerClient.startComposition).toHaveBeenCalledWith(
      [
        { key: "a", name: "第一段", source: "C:/Downloads/a.mp4" },
        { key: "b", name: "第二段", source: "C:/Downloads/b.mp4" },
      ],
      "合成视频",
    );
    expect(view.attachComposition).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      nodeKey: "compose-node",
      jobId: "compose-1",
      inputCount: 2,
      fileName: "合成视频.mp4",
      durationSeconds: 12.5,
      outputNodeKey: "output-9",
    });
    expect(JSON.stringify(result)).not.toContain("C:/Users");
  });

  it("输入不足或来源缺失时宿主的拒绝原因原样返回，不提交任务", async () => {
    const view = harness();
    view.compositionInputs.mockImplementation(() => {
      throw new Error("至少连接 2 段视频后才能合成；请先用 canvas.connect 连接视频素材或视频产物。");
    });
    await expect(
      view.tool("video_compose.run").execute({ nodeKey: "compose-node" }, view.context),
    ).rejects.toThrow("至少连接 2 段视频");

    expect(videoComposerClient.startComposition).not.toHaveBeenCalled();
  });
});
