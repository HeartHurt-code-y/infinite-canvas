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
import {
  createKnowledgeVideoWorkflowConfig,
  createPromptNodeConfig,
  nextOutputSlot,
  type KnowledgeVideoWorkflowNodeData,
} from "../workspace/workspaceModel";
import { createCanvasState, type CanvasDocumentV1, type CanvasNodeEntry } from "./canvasStore";
import {
  createXhsCoverCheckpoint,
  createXhsCoverOptions,
} from "../workspace/xhsCoverWorkflowModel";

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
    conversation: [],
    generatedPrompt: "",
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

const knowledgeVideoWorkflowNode: KnowledgeVideoWorkflowNodeData = {
  key: "knowledge-video-1",
  kind: "knowledge_video_workflow",
  x: 160,
  y: 140,
  config: createKnowledgeVideoWorkflowConfig(
    {
      prompt: { providerId: "provider-1", modelDefinitionId: "text-model-1" },
      image: { providerId: "provider-1", modelDefinitionId: "image-model-1" },
      video: { providerId: "provider-1", modelDefinitionId: "video-model-1" },
    },
    true,
  ),
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

  it("exposes and patches the composite knowledge-video workflow as one node", () => {
    const canvas = createCanvasState();
    const added = canvas.commands.addNode("knowledgeVideoWorkflow", knowledgeVideoWorkflowNode, {
      select: true,
    });

    expect(canvas.getSnapshot().nodes.knowledgeVideoWorkflow).toEqual([added]);
    expect(canvas.getSnapshot().nodeByKey.knowledgeVideoWorkflow.get("knowledge-video-1")).toBe(
      added,
    );
    expect(
      canvas.commands.patchNode("knowledgeVideoWorkflow", "knowledge-video-1", (node) => ({
        ...node,
        config: { ...node.config, brief: "解释复利" },
      })),
    ).toBe("applied");
    expect(canvas.getSnapshot().nodes.knowledgeVideoWorkflow[0]?.config.brief).toBe("解释复利");
  });

  it("rejects duplicate keys across node families", () => {
    const canvas = createCanvasState();
    canvas.commands.addNode("asset", assetNode);

    expect(() => canvas.commands.addNode("gen", { ...genNode, key: assetNode.key })).toThrow(
      "Canvas node key already exists",
    );
  });

  it("inserts a validated subgraph in one undoable write", async () => {
    const canvas = createCanvasState();
    const nodes = [
      { type: "asset", data: assetNode },
      { type: "gen", data: genNode },
    ] as const satisfies readonly CanvasNodeEntry[];
    const edges = [{ id: "workflow-edge", fromKey: "asset-1", toKey: "gen-1" }];

    expect(canvas.commands.insertSubgraph(nodes, edges, { selectNodeKey: "gen-1" })).toBe(
      "applied",
    );
    await flushHistoryBatch();

    expect(canvas.getSnapshot().nodes.asset).toEqual([assetNode]);
    expect(canvas.getSnapshot().nodes.gen).toEqual([
      { ...genNode, config: { ...genNode.config, inputSlots: ["asset-1"] } },
    ]);
    expect(canvas.getSnapshot().graph.edges).toEqual(edges);
    expect(canvas.getSnapshot().selection.nodeKey).toBe("gen-1");
    expect(canvas.getHistory()).toMatchObject({ pastCount: 1, futureCount: 0 });

    expect(canvas.commands.undo()).toBe("applied");
    expect(canvas.getSnapshot().hasNodes).toBe(false);
    expect(canvas.getSnapshot().graph.edges).toEqual([]);
    expect(canvas.commands.redo()).toBe("applied");
    expect(canvas.getSnapshot().nodes.asset).toEqual([assetNode]);
    expect(canvas.getSnapshot().nodes.gen).toEqual([
      { ...genNode, config: { ...genNode.config, inputSlots: ["asset-1"] } },
    ]);
    expect(canvas.getSnapshot().graph.edges).toEqual(edges);
  });

  it("rejects an invalid subgraph atomically before mutating canvas state", async () => {
    const canvas = createCanvasState();
    canvas.commands.addNode("asset", assetNode);
    canvas.commands.addNode("gen", genNode);
    canvas.commands.connect("asset-1", "gen-1");
    canvas.commands.selectNode("asset-1");
    await flushHistoryBatch();

    const asset2 = { ...assetNode, key: "asset-2", assetId: "asset-source-2" };
    const gen2 = { ...genNode, key: "gen-2" };
    const assetEntry = { type: "asset", data: asset2 } as const;
    const genEntry = { type: "gen", data: gen2 } as const;
    const validEdge = { id: "asset-2->gen-2", fromKey: "asset-2", toKey: "gen-2" };

    const expectAtomicRejection = (insert: () => unknown, expectedMessage: string): void => {
      const snapshotBefore = canvas.getSnapshot();
      const historyBefore = canvas.getHistory();
      expect(insert).toThrow(expectedMessage);
      expect(canvas.getSnapshot()).toBe(snapshotBefore);
      expect(canvas.getHistory()).toEqual(historyBefore);
    };

    expectAtomicRejection(
      () => canvas.commands.insertSubgraph([assetEntry, assetEntry], []),
      "Canvas subgraph contains duplicate node key: asset-2",
    );
    expectAtomicRejection(
      () => canvas.commands.insertSubgraph([{ type: "asset", data: assetNode }], []),
      "Canvas node key already exists: asset-1",
    );
    expectAtomicRejection(
      () => canvas.commands.insertSubgraph([assetEntry, genEntry], [validEdge, validEdge]),
      "Canvas subgraph contains duplicate edge id: asset-2->gen-2",
    );
    expectAtomicRejection(
      () =>
        canvas.commands.insertSubgraph(
          [assetEntry, genEntry],
          [{ ...validEdge, id: "asset-1->gen-1" }],
        ),
      "Canvas edge id already exists: asset-1->gen-1",
    );
    expectAtomicRejection(
      () =>
        canvas.commands.insertSubgraph(
          [genEntry],
          [{ id: "missing->gen-2", fromKey: "missing", toKey: "gen-2" }],
        ),
      "Canvas subgraph edge endpoint is missing: missing->gen-2",
    );
    expectAtomicRejection(
      () =>
        canvas.commands.insertSubgraph(
          [assetEntry, genEntry],
          [{ id: "gen-2->gen-2", fromKey: "gen-2", toKey: "gen-2" }],
        ),
      "Canvas subgraph connection is unsupported: gen-2->gen-2",
    );
    expectAtomicRejection(
      () =>
        canvas.commands.insertSubgraph([assetEntry, genEntry], [validEdge], {
          selectNodeKey: "missing-selection",
        }),
      "Canvas selected node key is missing: missing-selection",
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

  it("places an output using the source's current canvas position", () => {
    const canvas = createCanvasState();
    canvas.commands.addNode("gen", genNode);
    const originalSource = canvas.getSnapshot().nodes.gen[0]!;
    canvas.commands.patchNode("gen", genNode.key, (source) => ({ ...source, x: 700 }));

    const added = canvas.commands.addOutput((outputs, nodesById) => {
      const source = nodesById[genNode.key];
      if (source?.type !== "gen") throw new Error("current generation source is missing");
      expect(outputs).toHaveLength(0);
      return {
        ...outputNode,
        ...nextOutputSlot(source.data, outputs),
      };
    });

    expect(added.x).toBeGreaterThan(700);
    expect(added.x).toBeGreaterThan(nextOutputSlot(originalSource, []).x);
    expect(canvas.getSnapshot().graph.byTarget.get(added.key)).toHaveLength(1);
  });

  it("retains every prompt, document and video connection without replacing previous inputs", () => {
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
      replacedEdgeIds: [],
    });
    expect(canvas.commands.connect("asset-video", "viral-1").status).toBe("connected");
    expect(canvas.commands.connect("asset-video", "composer-1").status).toBe("connected");
    expect(canvas.commands.connect("screenplay-1", "storyboard-1").status).toBe("connected");
    expect(canvas.commands.connect("screenplay-2", "storyboard-1")).toMatchObject({
      status: "connected",
      replacedEdgeIds: [],
    });
    expect(canvas.commands.connect("storyboard-1", "screenplay-1").status).toBe("connected");
    expect(canvas.commands.connect("gen-1", "viral-1").status).toBe("connected");
    expect(canvas.getSnapshot().graph.byTarget.get("gen-1")).toHaveLength(2);
    expect(canvas.getSnapshot().graph.byTarget.get("storyboard-1")).toHaveLength(2);
    expect(canvas.getSnapshot().graph.byTarget.get("viral-1")).toHaveLength(2);
  });

  it("accepts saved image/video artifacts as reference inputs to prompt nodes", () => {
    const canvas = createCanvasState();
    canvas.commands.addNode("gen", genNode);
    canvas.commands.addNode("gen", promptNode("prompt-1"));
    canvas.commands.addNode("gen", promptNode("prompt-2"));
    canvas.commands.addOutput(outputNode);
    canvas.commands.addOutput({ ...outputNode, key: "output-video", mediaType: "video" });
    canvas.commands.addOutput({
      ...outputNode,
      key: "output-composition",
      origin: "composition",
    });

    // 图片产物与视频产物均可连入提示词节点做多模态参考理解。
    expect(canvas.commands.connect("output-1", "prompt-1").status).toBe("connected");
    expect(canvas.commands.connect("output-video", "prompt-1").status).toBe("connected");
    expect(canvas.commands.connect("output-1", "prompt-2").status).toBe("connected");
    // 合成产物与下载产物同样可作为提示词节点的参考理解素材。
    expect(canvas.commands.connect("output-composition", "prompt-1").status).toBe("connected");
    // 产物连入图片/视频生成节点的既有能力保持可用。
    expect(canvas.commands.connect("output-1", "gen-1").status).toBe("connected");
  });

  it("keeps multiple workflow media inputs independent across reconnect, disconnect and removal", () => {
    const canvas = createCanvasState();
    canvas.commands.addNode("knowledgeVideoWorkflow", knowledgeVideoWorkflowNode);
    canvas.commands.addNode("asset", assetNode);
    canvas.commands.addNode("asset", videoAssetNode);
    canvas.commands.addNode("asset", { ...assetNode, key: "asset-audio", kind: "audio" });
    canvas.commands.addOutput(outputNode);

    const sourceKeys = ["asset-1", "asset-video", "asset-audio", "output-1"];
    for (const sourceKey of sourceKeys) {
      expect(canvas.commands.connect(sourceKey, "knowledge-video-1")).toMatchObject({
        status: "connected",
        replacedEdgeIds: [],
      });
    }
    const connected = canvas.getSnapshot();
    expect(connected.graph.byTarget.get("knowledge-video-1")).toHaveLength(4);
    expect(canvas.commands.connect("asset-1", "knowledge-video-1")).toEqual({
      status: "unchanged",
      edgeId: "asset-1->knowledge-video-1",
    });
    expect(canvas.getSnapshot()).toBe(connected);

    canvas.commands.selectEdge("asset-1->knowledge-video-1");
    expect(canvas.commands.disconnect("asset-1->knowledge-video-1")).toBe("applied");
    expect(canvas.getSnapshot().selection.edgeId).toBeNull();
    expect(canvas.getSnapshot().nodes.asset).toHaveLength(3);
    expect(canvas.getSnapshot().graph.byTarget.get("knowledge-video-1")).toHaveLength(3);

    canvas.commands.removeNode("asset-video");
    expect(
      canvas
        .getSnapshot()
        .graph.byTarget.get("knowledge-video-1")
        ?.map((edge) => edge.fromKey),
    ).toEqual(["asset-audio", "output-1"]);
    expect(canvas.getSnapshot().nodes.knowledgeVideoWorkflow).toHaveLength(1);
  });

  it.each<{
    name: string;
    patch: Partial<OutputNodeData>;
    accepted: boolean;
  }>([
    { name: "saved image", patch: {}, accepted: true },
    { name: "saved video", patch: { mediaType: "video" }, accepted: true },
    {
      name: "saved extracted frame without generation identity",
      patch: { origin: "frame_extract", resultKey: null },
      accepted: true,
    },
    { name: "preview-only generation", patch: { finalPath: null }, accepted: false },
    {
      name: "preview-only extracted frame",
      patch: { origin: "frame_extract", finalPath: null },
      accepted: false,
    },
    {
      name: "unfinished generation",
      patch: { finalPath: null, previewSrc: null, resultKey: null },
      accepted: false,
    },
    { name: "text output", patch: { mediaType: "text" }, accepted: false },
    { name: "composition output", patch: { origin: "composition" }, accepted: true },
    { name: "download output", patch: { origin: "download" }, accepted: true },
    {
      name: "mismatched generation identity",
      patch: { resultKey: "other-task#0" },
      accepted: false,
    },
  ])("allows connecting $name before its payload is available", ({ patch }) => {
    const canvas = createCanvasState();
    canvas.commands.addNode("knowledgeVideoWorkflow", knowledgeVideoWorkflowNode);
    canvas.commands.addOutput({ ...outputNode, ...patch });

    const connected = canvas.commands.connect("output-1", "knowledge-video-1");

    expect(connected.status).toBe("connected");
    expect(canvas.getSnapshot().graph.edges).toHaveLength(1);
  });

  it("accepts reverse workflow connections and non-media source nodes", () => {
    const canvas = createCanvasState();
    canvas.commands.addNode("knowledgeVideoWorkflow", knowledgeVideoWorkflowNode);
    canvas.commands.addNode("asset", assetNode);
    canvas.commands.addNode("gen", genNode);
    canvas.commands.addNode("gen", promptNode("prompt-1"));
    canvas.commands.addNode("screenplay", screenplayNode("screenplay-1"));
    canvas.commands.addNode("storyboard", storyboardNode);
    canvas.commands.addNode("videoComposer", composerNode);
    canvas.commands.addOutput(outputNode);

    for (const sourceKey of ["gen-1", "prompt-1", "screenplay-1", "storyboard-1", "composer-1"]) {
      expect(canvas.commands.connect(sourceKey, "knowledge-video-1").status).toBe("connected");
    }
    for (const targetKey of ["asset-1", "output-1", "gen-1"]) {
      expect(canvas.commands.connect("knowledge-video-1", targetKey).status).toBe("connected");
    }
    expect(canvas.getSnapshot().graph.byTarget.get("knowledge-video-1")).toHaveLength(5);
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

  it("removes a node that no generation slot references", () => {
    const canvas = createCanvasState();
    canvas.commands.addNode("asset", assetNode);
    canvas.commands.addNode("gen", genNode);

    /*
     * 未连线的素材不会被任何生成节点的 inputSlots 引用，槽位清理这一支不会发生。
     * 删除仍然必须把新的 nodesById 写回：漏写时节点留在图里，画布上表现为
     * 「点素材卡片的叉号没有反应」（只有恰好清到槽位时才生效）。
     */
    const removed = canvas.commands.removeNode("asset-1");

    expect(removed).toMatchObject({ type: "asset", data: { key: "asset-1" } });
    expect(canvas.getSnapshot().nodes.asset).toEqual([]);
    expect(canvas.getSnapshot().nodeByKey.asset.has("asset-1")).toBe(false);
    expect(canvas.getSnapshot().nodes.gen).toHaveLength(1);
  });

  it("keeps connection projections stable across layout-only changes", () => {
    const canvas = createCanvasState();
    canvas.commands.addNode("asset", assetNode);
    const connectionNodes = canvas.getSnapshot().nodeByKey;

    canvas.commands.applyNodeChanges([
      { type: "position", key: "asset-1", position: { x: 80, y: 90 } },
      { type: "dimensions", key: "asset-1", measured: { width: 320, height: 180 } },
    ]);

    expect(canvas.getSnapshot().nodeByKey).toBe(connectionNodes);
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

  it("refreshes connected workflow source media without replacing its edges", () => {
    const canvas = createCanvasState();
    canvas.commands.addNode("knowledgeVideoWorkflow", knowledgeVideoWorkflowNode);
    canvas.commands.addNode("asset", assetNode);
    canvas.commands.addOutput(outputNode);
    canvas.commands.connect("asset-1", "knowledge-video-1");
    canvas.commands.connect("output-1", "knowledge-video-1");
    const initial = canvas.getSnapshot();

    canvas.commands.patchNode("asset", "asset-1", (node) => ({
      ...node,
      previewUrl: "https://example.com/current-preview.png",
    }));
    const withPreview = canvas.getSnapshot();
    expect(withPreview.nodeByKey.asset).not.toBe(initial.nodeByKey.asset);
    expect(withPreview.nodeByKey.asset.get("asset-1")?.previewUrl).toBe(
      "https://example.com/current-preview.png",
    );

    canvas.commands.patchNode("asset", "asset-1", (node) => ({
      ...node,
      assetId: "local-upload-2",
      source: "local",
      name: "更新后的素材",
    }));
    canvas.commands.patchNode("output", "output-1", (node) => ({
      ...node,
      finalPath: "C:/results/new-output.png",
    }));
    const updated = canvas.getSnapshot();
    expect(updated.nodeByKey.asset.get("asset-1")).toMatchObject({
      assetId: "local-upload-2",
      source: "local",
      name: "更新后的素材",
    });
    expect(updated.nodeByKey.output).not.toBe(initial.nodeByKey.output);
    expect(updated.nodeByKey.output.get("output-1")?.finalPath).toBe("C:/results/new-output.png");
    expect(updated.graph.edges).toBe(initial.graph.edges);
  });
});

describe("canvas document interface", () => {
  it("restores workflow media connections by source identity after JSON serialization", () => {
    const source = createCanvasState();
    source.commands.addNode("knowledgeVideoWorkflow", knowledgeVideoWorkflowNode);
    source.commands.addNode("asset", assetNode);
    source.commands.addNode("asset", videoAssetNode);
    source.commands.addNode("asset", { ...assetNode, key: "asset-audio", kind: "audio" });
    source.commands.addOutput(outputNode);
    for (const sourceKey of ["asset-1", "asset-video", "asset-audio", "output-1"]) {
      source.commands.connect(sourceKey, "knowledge-video-1");
    }

    const serialized = JSON.stringify(source.commands.snapshotV2({}));
    const target = createCanvasState();

    expect(target.commands.restoreDocument(JSON.parse(serialized))).toMatchObject({ ok: true });
    expect(target.getSnapshot().graph.edges).toEqual(source.getSnapshot().graph.edges);
    expect(target.getSnapshot().graph.byTarget.get("knowledge-video-1")).toHaveLength(4);
    expect(target.getSnapshot().nodeByKey.asset.get("asset-1")?.assetId).toBe("asset-source-1");
    expect(target.getSnapshot().nodeByKey.output.get("output-1")?.finalPath).toBe(
      "C:/results/output.png",
    );
    expect(target.commands.disconnect("asset-video->knowledge-video-1")).toBe("applied");
    expect(target.getSnapshot().graph.byTarget.get("knowledge-video-1")).toHaveLength(3);
  });

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

  it.each([
    "fpv_path",
    "fight_prompt_master",
    "multi_grid_storyboard",
    "storyboard_prompt",
    "gpt_image_2_style",
  ] as const)(
    "retains %s mode, edited output, conversation and reference connections after JSON restore",
    (mode) => {
      const source = createCanvasState();
      const config = {
        ...createPromptNodeConfig({ providerId: "provider-1", modelDefinitionId: "text-1" }, true),
        mode,
        task: "optimize",
        sourcePrompt: "在立柱前减速",
        generatedPrompt: "FPV 穿越站台立柱，离地 1.5 米，在时钟前停下。",
        conversation: [
          { id: "turn-1", role: "user", content: "参考图片设计连续穿越站台的路径" },
          { id: "turn-2", role: "assistant", content: "FPV 从站台起飞，绕过立柱。" },
        ],
      } as const;
      source.commands.addNode("asset", assetNode);
      source.commands.addNode("gen", { key: "fpv-1", kind: "prompt", x: 0, y: 0, config });
      source.commands.addNode("gen", genNode);
      source.commands.connect("asset-1", "fpv-1");
      source.commands.connect("fpv-1", "gen-1");

      const serialized = JSON.stringify(source.commands.snapshotV2({}));
      const target = createCanvasState();
      expect(target.commands.restoreDocument(JSON.parse(serialized))).toMatchObject({ ok: true });
      expect(target.getSnapshot().nodes.gen.find((node) => node.key === "fpv-1")?.config).toEqual(
        config,
      );
      expect(target.getSnapshot().graph.edges).toEqual([
        { id: "asset-1->fpv-1", fromKey: "asset-1", toKey: "fpv-1" },
        { id: "fpv-1->gen-1", fromKey: "fpv-1", toKey: "gen-1" },
      ]);
    },
  );

  it("persists and restores the composite workflow checkpoint in V2", () => {
    const source = createCanvasState();
    source.commands.addNode("knowledgeVideoWorkflow", {
      ...knowledgeVideoWorkflowNode,
      config: {
        ...knowledgeVideoWorkflowNode.config,
        checkpoint: {
          ...knowledgeVideoWorkflowNode.config.checkpoint,
          runId: "run-1",
          phase: "awaiting_approval",
          planRevision: 2,
          decision: {
            kind: "planning",
            question: "是否保留公式？",
            recommendation: "保留并配图解释",
          },
        },
      },
    });

    const document = source.commands.snapshotV2({});
    expect(document.knowledgeVideoWorkflowNodes).toHaveLength(1);

    const target = createCanvasState();
    expect(target.commands.restoreDocument(document)).toMatchObject({ ok: true });
    expect(target.getSnapshot().nodes.knowledgeVideoWorkflow[0]?.config.checkpoint).toMatchObject({
      runId: "run-1",
      phase: "awaiting_approval",
      planRevision: 2,
      decision: { question: "是否保留公式？", recommendation: "保留并配图解释" },
    });
  });

  it("retains cover references and a submitted image task when restoring an interrupted canvas", () => {
    const source = createCanvasState();
    const options = {
      ...createXhsCoverOptions(),
      title: "三步学会排版",
      portraits: [
        {
          localPath: "C:/references/person.png",
          displayName: "人物.png",
          kind: "image" as const,
          mimeType: "image/png",
          byteSize: 1024,
        },
      ],
    };
    const coverCheckpoint = {
      ...createXhsCoverCheckpoint(),
      taskId: "submitted-cover-task",
      inputSignature: "saved-input",
    };
    source.commands.addNode("knowledgeVideoWorkflow", {
      ...knowledgeVideoWorkflowNode,
      config: {
        ...knowledgeVideoWorkflowNode.config,
        xhsCover: options,
        checkpoint: {
          ...knowledgeVideoWorkflowNode.config.checkpoint,
          phase: "generating",
          lastActivePhase: "generating",
          runId: "cover-run",
          xhsCover: coverCheckpoint,
        },
      },
    });
    const restored = createCanvasState();
    expect(restored.commands.restoreDocument(source.commands.snapshotV2({}))).toMatchObject({
      ok: true,
    });
    expect(restored.getSnapshot().nodes.knowledgeVideoWorkflow[0]?.config).toMatchObject({
      xhsCover: options,
      checkpoint: { phase: "paused", lastActivePhase: "generating", xhsCover: coverCheckpoint },
    });
  });

  it.each(["planning", "generating", "qc", "composing"] as const)(
    "restores an interrupted %s workflow as resumable without losing its checkpoint",
    (phase) => {
      const manifest = JSON.stringify({
        schemaVersion: "knowledge-video-director.manifest.v1",
        project: { aspectRatio: "9:16" },
      });
      const source = createCanvasState();
      source.commands.addNode("knowledgeVideoWorkflow", {
        ...knowledgeVideoWorkflowNode,
        config: {
          ...knowledgeVideoWorkflowNode.config,
          checkpoint: {
            ...knowledgeVideoWorkflowNode.config.checkpoint,
            runId: "run-restart",
            phase,
            lastActivePhase: phase,
            manifest,
            activeCompositionJobId: "composition-live",
            shotRuns: {
              "shot-01": {
                shotId: "shot-01",
                imageTaskId: "image-task-1",
                videoTaskId: "video-task-1",
                referenceImagePath: "C:\\output\\cover.png",
                clipPath: "C:\\output\\shot-01.mp4",
                qcStatus: "pending",
                qcReport: "等待恢复",
                repairPrompt: null,
                retryCount: 1,
              },
            },
          },
        },
      });

      const document = source.commands.snapshotV2({});
      expect(document.knowledgeVideoWorkflowNodes?.[0]?.config.checkpoint.phase).toBe(phase);

      const target = createCanvasState();
      expect(target.commands.restoreDocument(document)).toMatchObject({ ok: true });
      expect(target.getSnapshot().nodes.knowledgeVideoWorkflow[0]?.config.checkpoint).toMatchObject(
        {
          runId: "run-restart",
          phase: "paused",
          lastActivePhase: phase,
          manifest,
          activeCompositionJobId: "composition-live",
          shotRuns: {
            "shot-01": {
              imageTaskId: "image-task-1",
              videoTaskId: "video-task-1",
              clipPath: "C:\\output\\shot-01.mp4",
              retryCount: 1,
            },
          },
        },
      );
    },
  );

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
    expect(canvas.getSnapshot().nodes.knowledgeVideoWorkflow).toEqual([]);
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
