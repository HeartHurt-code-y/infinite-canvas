import { describe, expect, it } from "vitest";
import type {
  AssetNodeData,
  GenNodeData,
  OutputNodeData,
  ScreenplayNodeData,
  StoryboardNodeData,
  VideoComposerNodeData,
  ViralRemixNodeData,
} from "../../App";
import { createCanvasState, type CanvasDocumentV1 } from "./canvasStore";

const assetNode: AssetNodeData = {
  key: "asset-1",
  assetId: "asset-source-1",
  providerConnectionId: "provider-1",
  kind: "image",
  name: "参考图",
  previewUrl: null,
  videoUrl: null,
  x: 10,
  y: 20,
};

const videoAssetNode: AssetNodeData = {
  ...assetNode,
  key: "asset-video",
  assetId: "asset-source-video",
  kind: "video",
  name: "参考视频",
  videoUrl: "https://example.com/reference.mp4",
};

const genNode: GenNodeData = {
  key: "gen-1",
  kind: "image",
  x: 30,
  y: 40,
  config: {
    modelSelection: { providerId: "provider-1", modelDefinitionId: "model-1" },
    generationCount: 1,
    parameterValues: {},
    catalogResolved: true,
    promptOptimization: null,
  },
};

const promptNode = (key: string): GenNodeData => ({
  key,
  kind: "prompt",
  x: 0,
  y: 0,
  config: {
    modelSelection: { providerId: "provider-1", modelDefinitionId: "model-1" },
    mode: "realistic_character",
    task: "generate",
    sourcePrompt: "",
    generatedPrompt: "",
    auditContextHistory: [],
    catalogResolved: true,
  },
});

const composerNode: VideoComposerNodeData = {
  key: "composer-1",
  kind: "video_composer",
  x: 100,
  y: 100,
  config: { outputName: "合成视频", inputOrder: [] },
};

const viralRemixNode: ViralRemixNodeData = {
  key: "viral-1",
  kind: "viral_remix",
  x: 120,
  y: 120,
  config: {
    modelSelection: { providerId: "provider-1", modelDefinitionId: "model-1" },
    instructions: "",
    currentDocument: "",
    catalogResolved: true,
  },
};

const screenplayNode = (key: string): ScreenplayNodeData => ({
  key,
  kind: "screenplay",
  x: 80,
  y: 80,
  config: {
    modelSelection: { providerId: "provider-1", modelDefinitionId: "model-1" },
    composer: "",
    conversation: [],
    currentDocument: "# 测试剧本",
    catalogResolved: true,
  },
});

const storyboardNode: StoryboardNodeData = {
  ...screenplayNode("storyboard-1"),
  kind: "storyboard",
};

const outputNode: OutputNodeData = {
  key: "output-1",
  resultKey: "task-1#0",
  sourceNodeId: "gen-1",
  taskId: "task-1",
  mediaType: "image",
  finalPath: "C:/results/output.png",
  previewSrc: "blob:session-preview",
  name: "output.png",
  x: 300,
  y: 40,
};

const flushHistoryBatch = async () => {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
};

describe("canvas state interface", () => {
  it("exposes typed node views while keeping unrelated projections reference-stable", () => {
    const canvas = createCanvasState(74);
    canvas.commands.addNode("asset", assetNode);
    const first = canvas.getSnapshot();

    canvas.commands.addNode("gen", genNode);
    const second = canvas.getSnapshot();

    expect(second.nodes.asset).toBe(first.nodes.asset);
    expect(second.nodes.gen).toEqual([genNode]);
    expect(second.nodeByKey.asset.get("asset-1")).toBe(assetNode);
    expect(second.view.zoom).toBe(74);
    expect(second.hasNodes).toBe(true);
  });

  it("adds and patches one node without exposing collection replacement", () => {
    const canvas = createCanvasState();
    canvas.commands.addNode("asset", assetNode, { select: true });

    expect(
      canvas.commands.patchNode("asset", "asset-1", (node) => ({ ...node, name: "新参考图" })),
    ).toBe("applied");
    expect(canvas.commands.patchNode("asset", "missing", (node) => node)).toBe("missing");
    expect(canvas.getSnapshot().nodes.asset[0]?.name).toBe("新参考图");
    expect(canvas.getSnapshot().selection.nodeKey).toBe("asset-1");
  });

  it("rejects duplicate keys across node families", () => {
    const canvas = createCanvasState();
    canvas.commands.addNode("asset", assetNode);

    expect(() => canvas.commands.addNode("gen", { ...genNode, key: assetNode.key })).toThrow(
      "Canvas node key already exists",
    );
  });

  it("adds an output and its source edge atomically", () => {
    const canvas = createCanvasState();
    canvas.commands.addNode("gen", genNode);
    canvas.commands.addOutput(outputNode);

    const state = canvas.getSnapshot();
    expect(state.nodes.output).toEqual([outputNode]);
    expect(state.graph.edges).toEqual([
      { id: "gen-1->output-1", fromKey: "gen-1", toKey: "output-1" },
    ]);
    expect(state.graph.countByNode.get("gen-1")).toBe(1);
    expect(state.graph.byTarget.get("output-1")).toHaveLength(1);
  });

  it("owns connection validation and single-input replacement rules", () => {
    const canvas = createCanvasState();
    canvas.commands.addNode("gen", genNode);
    canvas.commands.addNode("gen", promptNode("prompt-1"));
    canvas.commands.addNode("gen", promptNode("prompt-2"));
    canvas.commands.addNode("asset", videoAssetNode);
    canvas.commands.addNode("viralRemix", viralRemixNode);
    canvas.commands.addNode("videoComposer", composerNode);
    canvas.commands.addNode("screenplay", screenplayNode("screenplay-1"));
    canvas.commands.addNode("screenplay", screenplayNode("screenplay-2"));
    canvas.commands.addNode("storyboard", storyboardNode);

    expect(canvas.commands.connect("prompt-1", "gen-1").status).toBe("connected");
    const promptReplacement = canvas.commands.connect("prompt-2", "gen-1");
    expect(promptReplacement).toMatchObject({
      status: "connected",
      replacedEdgeIds: ["prompt-1->gen-1"],
    });
    expect(canvas.commands.connect("asset-video", "viral-1").status).toBe("connected");
    expect(canvas.commands.connect("asset-video", "composer-1").status).toBe("connected");
    expect(canvas.commands.connect("screenplay-1", "storyboard-1").status).toBe("connected");
    expect(canvas.commands.connect("screenplay-2", "storyboard-1")).toMatchObject({
      status: "connected",
      replacedEdgeIds: ["screenplay-1->storyboard-1"],
    });
    expect(canvas.commands.connect("storyboard-1", "screenplay-1")).toMatchObject({
      status: "rejected",
      reason: "unsupported-connection",
    });
    expect(canvas.commands.connect("gen-1", "viral-1")).toMatchObject({
      status: "rejected",
      reason: "unsupported-connection",
    });
  });

  it("removes a node, incident edges, and invalid selections in one write", () => {
    const canvas = createCanvasState();
    canvas.commands.addNode("asset", assetNode);
    canvas.commands.addNode("gen", genNode);
    expect(canvas.commands.connect("asset-1", "gen-1").status).toBe("connected");
    canvas.commands.selectNode("asset-1");
    canvas.commands.selectEdge("asset-1->gen-1");

    const removed = canvas.commands.removeNode("asset-1");

    expect(removed).toMatchObject({ type: "asset", data: { key: "asset-1" } });
    expect(canvas.getSnapshot().nodes.asset).toEqual([]);
    expect(canvas.getSnapshot().graph.edges).toEqual([]);
    expect(canvas.getSnapshot().selection).toEqual({ nodeKey: null, edgeId: null });
  });

  it("keeps connection projections stable across layout-only changes", () => {
    const canvas = createCanvasState();
    canvas.commands.addNode("asset", assetNode);
    const connectionNodes = canvas.getSnapshot().nodeByKey.asset;

    canvas.commands.applyNodeChanges([
      { type: "position", key: "asset-1", position: { x: 80, y: 90 } },
      { type: "dimensions", key: "asset-1", measured: { width: 320, height: 180 } },
    ]);

    expect(canvas.getSnapshot().nodeByKey.asset).toBe(connectionNodes);
    expect(canvas.getSnapshot().nodes.asset[0]).toMatchObject({
      x: 80,
      y: 90,
      measured: { width: 320, height: 180 },
    });
  });

  it("refreshes the screenplay connection projection when its live document changes", () => {
    const canvas = createCanvasState();
    canvas.commands.addNode("screenplay", screenplayNode("screenplay-live"));
    const before = canvas.getSnapshot().nodeByKey.screenplay;

    canvas.commands.patchNode("screenplay", "screenplay-live", (node) => ({
      ...node,
      config: { ...node.config, currentDocument: "# 最新剧本" },
    }));

    const after = canvas.getSnapshot().nodeByKey.screenplay;
    expect(after).not.toBe(before);
    expect(after.get("screenplay-live")?.config.currentDocument).toBe("# 最新剧本");
  });
});

describe("canvas document interface", () => {
  it("restores legacy V1 prompt HTML atomically with a fresh history", async () => {
    const source = createCanvasState();
    source.commands.addNode("gen", genNode);
    source.commands.addOutput(outputNode);
    source.commands.setView({ zoom: 135, pan: { x: 12, y: 34 } });
    const v2 = source.commands.snapshotV2({});
    const document: CanvasDocumentV1 = {
      ...v2,
      version: 1,
      prompts: { "gen-1": "<p>提示内容</p>" },
    };

    expect(document.outputNodes?.[0]).not.toHaveProperty("previewSrc");

    const target = createCanvasState();
    target.commands.addNode("asset", assetNode);
    await flushHistoryBatch();
    const restored = target.commands.restoreDocument(document);

    expect(restored).toMatchObject({
      ok: true,
      promptContents: { "gen-1": "<p>提示内容</p>" },
      view: { zoom: 135, pan: { x: 12, y: 34 } },
    });
    expect(target.getSnapshot().nodes.asset).toEqual([]);
    expect(target.getSnapshot().nodes.output[0]?.previewSrc).toBeNull();
    expect(target.getHistory()).toMatchObject({ pastCount: 0, futureCount: 0 });
  });

  it("snapshots V2 with structured prompt content and restores it without DOM HTML", () => {
    const prompt = {
      schema: "prompt-content",
      version: 1,
      items: [{ kind: "text", text: "结构化提示内容" }],
    } as const;
    const source = createCanvasState();
    source.commands.addNode("gen", genNode);

    const document = source.commands.snapshotV2({ "gen-1": prompt });
    const target = createCanvasState();
    const restored = target.commands.restoreDocument(document);

    expect(document).toMatchObject({ version: 2, promptContents: { "gen-1": prompt } });
    expect(restored).toMatchObject({ ok: true, promptContents: { "gen-1": prompt } });
  });

  it("normalizes optional V1 arrays and ignores dangling legacy edges with a warning", () => {
    const canvas = createCanvasState();
    const document: CanvasDocumentV1 = {
      version: 1,
      assetNodes: [assetNode],
      genNodes: [],
      resultNodes: [],
      assetEdges: [{ id: "dangling", fromKey: "asset-1", toKey: "missing" }],
      view: { zoom: 100, pan: { x: 0, y: 0 } },
      prompts: {},
    };

    const restored = canvas.commands.restoreDocument(document);

    expect(restored).toMatchObject({ ok: true });
    expect(restored.ok && restored.warnings).toContain("已忽略端点缺失的连线: dangling");
    expect(canvas.getSnapshot().nodes.videoDownloader).toEqual([]);
    expect(canvas.getSnapshot().graph.edges).toEqual([]);
  });

  it("leaves the current canvas unchanged when a document is rejected", () => {
    const canvas = createCanvasState();
    canvas.commands.addNode("asset", assetNode);

    expect(canvas.commands.restoreDocument({ version: 3 })).toEqual({
      ok: false,
      reason: "unsupported-version",
      issues: ["仅支持画布文档 V1/V2"],
    });
    expect(canvas.getSnapshot().nodes.asset).toEqual([assetNode]);
  });
});

describe("canvas history interface", () => {
  it("undoes structural commands while preserving view, selection, and measurements", async () => {
    const canvas = createCanvasState();
    canvas.commands.addNode("asset", assetNode);
    await flushHistoryBatch();
    canvas.commands.applyNodeChanges([
      { type: "dimensions", key: "asset-1", measured: { width: 320, height: 180 } },
      { type: "select", key: "asset-1", selected: true },
    ]);
    canvas.commands.setView({ zoom: 150, pan: { x: 12, y: 34 } });
    await flushHistoryBatch();

    canvas.commands.applyNodeChanges([
      { type: "position", key: "asset-1", position: { x: 80, y: 90 } },
    ]);
    await flushHistoryBatch();
    expect(canvas.getHistory()).toMatchObject({ pastCount: 2, canUndo: true });

    expect(canvas.commands.undo()).toBe("applied");
    expect(canvas.getSnapshot().nodes.asset[0]).toMatchObject({
      x: 10,
      y: 20,
      measured: { width: 320, height: 180 },
    });
    expect(canvas.getSnapshot().view).toEqual({ zoom: 150, pan: { x: 12, y: 34 } });
    expect(canvas.getSnapshot().selection.nodeKey).toBe("asset-1");
    expect(canvas.commands.redo()).toBe("applied");
    expect(canvas.getSnapshot().nodes.asset[0]).toMatchObject({ x: 80, y: 90 });
  });

  it("clears the whole graph in one undoable command while retaining the view", async () => {
    const canvas = createCanvasState();
    canvas.commands.addNode("asset", assetNode);
    canvas.commands.addNode("gen", genNode);
    canvas.commands.connect("asset-1", "gen-1");
    canvas.commands.setView({ zoom: 125, pan: { x: 5, y: 6 } });
    await flushHistoryBatch();
    const historyBefore = canvas.getHistory().pastCount;

    const removed = canvas.commands.clear();
    await flushHistoryBatch();

    expect(removed).toHaveLength(2);
    expect(canvas.getSnapshot().hasNodes).toBe(false);
    expect(canvas.getSnapshot().graph.edges).toEqual([]);
    expect(canvas.getSnapshot().view).toEqual({ zoom: 125, pan: { x: 5, y: 6 } });
    expect(canvas.getHistory().pastCount).toBe(historyBefore + 1);
    canvas.commands.undo();
    expect(canvas.getSnapshot().nodes.asset).toHaveLength(1);
    expect(canvas.getSnapshot().graph.edges).toHaveLength(1);
  });
});
