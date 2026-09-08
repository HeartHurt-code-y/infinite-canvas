import { describe, expect, it } from "vitest";
import { createCanvasState, type CanvasNodeEntry } from "../canvas/canvasStore";
import {
  canvasNodeIndex,
  canvasNodesByKeyFromDocument,
  createCanvasInputResolver,
} from "./canvasInputs";
import {
  createKnowledgeVideoWorkflowConfig,
  createPromptNodeConfig,
  type AssetEdgeData,
  type AssetNodeData,
  type GenNodeData,
  type OutputNodeData,
  type ScreenplayNodeData,
} from "./workspaceModel";
import { createXhsCoverCheckpoint } from "./xhsCoverWorkflowModel";
import { createRemotionCheckpoint } from "./remotionWorkflowModel";

const model = { providerId: "provider", modelDefinitionId: "model" };
const material = (key: string): AssetNodeData => ({
  key,
  assetId: "same-library-asset",
  providerConnectionId: "provider",
  kind: "image",
  name: key,
  previewUrl: null,
  videoUrl: null,
  x: 0,
  y: 0,
});
const prompt = (key: string, text = ""): GenNodeData => ({
  key,
  kind: "prompt",
  x: 0,
  y: 0,
  config: { ...createPromptNodeConfig(model, true), generatedPrompt: text },
});
const documentNode = (key: string, text = ""): ScreenplayNodeData => ({
  key,
  kind: "screenplay",
  x: 0,
  y: 0,
  config: {
    modelSelection: model,
    composer: "",
    conversation: [],
    currentDocument: text,
    catalogResolved: true,
  },
});
const output = (key: string, sourceNodeId = "generator", taskId = "task"): OutputNodeData => ({
  key,
  sourceNodeId,
  taskId,
  resultKey: `${taskId}#0`,
  mediaType: "image",
  finalPath: `C:/${key}.png`,
  name: key,
  x: 0,
  y: 0,
});
const edge = (fromKey: string, toKey: string): AssetEdgeData => ({
  id: `${fromKey}->${toKey}`,
  fromKey,
  toKey,
});

describe("unrestricted canvas payload graph", () => {
  it("connects every pair of node families in both directions and preserves all edges after restore", () => {
    const entries: CanvasNodeEntry[] = [
      { type: "asset", data: material("asset") },
      { type: "gen", data: prompt("prompt") },
      ...(["image", "video"] as const).map((kind): CanvasNodeEntry => ({
        type: "gen",
        data: {
          key: kind,
          kind,
          x: 0,
          y: 0,
          config: {
            modelSelection: model,
            generationCount: 1,
            parameterValues: {},
            catalogResolved: true,
          },
        },
      })),
      { type: "screenplay", data: documentNode("screenplay") },
      { type: "storyboard", data: { ...documentNode("storyboard"), kind: "storyboard" } },
      {
        type: "viralRemix",
        data: {
          key: "remix",
          kind: "viral_remix",
          x: 0,
          y: 0,
          config: {
            modelSelection: model,
            instructions: "",
            currentDocument: "",
            catalogResolved: true,
          },
        },
      },
      {
        type: "knowledgeVideoWorkflow",
        data: {
          key: "workflow",
          kind: "knowledge_video_workflow",
          x: 0,
          y: 0,
          config: createKnowledgeVideoWorkflowConfig(
            { prompt: model, image: model, video: model },
            true,
          ),
        },
      },
      {
        type: "videoComposer",
        data: {
          key: "composer",
          kind: "video_composer",
          x: 0,
          y: 0,
          config: { outputName: "", inputOrder: [] },
        },
      },
      {
        type: "videoDownloader",
        data: { key: "downloader", kind: "video_downloader", x: 0, y: 0, config: { url: "" } },
      },
      {
        type: "frameExtractor",
        data: {
          key: "extractor",
          kind: "frame_extractor",
          x: 0,
          y: 0,
          config: { videoPath: "", timestamps: [] },
        },
      },
      { type: "result", data: { key: "result", x: 0, y: 0 } },
      { type: "output", data: { ...output("output"), finalPath: null, resultKey: null } },
    ];
    const canvas = createCanvasState();
    canvas.commands.insertSubgraph(entries, []);
    for (const source of entries)
      for (const target of entries) {
        const result = canvas.commands.connect(source.data.key, target.data.key);
        if (source === target) expect(result).toEqual({ status: "rejected", reason: "same-node" });
        else expect(result).toMatchObject({ status: "connected", replacedEdgeIds: [] });
      }
    expect(canvas.getSnapshot().graph.edges).toHaveLength(entries.length * (entries.length - 1));
    const restored = createCanvasState();
    expect(restored.commands.restoreDocument(canvas.commands.snapshotV2({})).ok).toBe(true);
    expect(restored.getSnapshot().graph.edges).toEqual(canvas.getSnapshot().graph.edges);
    expect(canvas.commands.connect("missing", "asset")).toEqual({
      status: "rejected",
      reason: "missing-source",
    });
    expect(canvas.commands.connect("asset", "missing")).toEqual({
      status: "rejected",
      reason: "missing-target",
    });
  });

  it("resolves unlimited ordered media and text inputs without collapsing distinct material instances", () => {
    const entries: CanvasNodeEntry[] = [{ type: "gen", data: prompt("target") }];
    const edges: AssetEdgeData[] = [];
    for (let index = 0; index < 40; index++) {
      const key = `material-${index}`;
      const promptKey = `prompt-${index}`;
      entries.push(
        { type: "asset", data: material(key) },
        { type: "gen", data: prompt(promptKey, `text-${index}`) },
      );
      edges.push(edge(key, "target"), edge(promptKey, "target"));
    }
    const result = createCanvasInputResolver(canvasNodeIndex(entries), edges)("target");
    expect(result.media.map((m) => m.key)).toEqual(
      Array.from({ length: 40 }, (_, i) => `material-${i}`),
    );
    expect(result.texts.map((t) => t.text)).toEqual(
      Array.from({ length: 40 }, (_, i) => `text-${i}`),
    );
  });

  it("relays through materials and documents, deduplicates diamonds and excludes a cyclic target", () => {
    const entries: CanvasNodeEntry[] = [
      { type: "asset", data: material("source") },
      { type: "asset", data: material("relay") },
      { type: "screenplay", data: documentNode("doc", "# Current draft") },
      { type: "gen", data: prompt("target", "Never feed target back") },
    ];
    const edges = [
      edge("relay", "target"),
      edge("doc", "target"),
      edge("source", "relay"),
      edge("source", "doc"),
      edge("target", "source"),
    ];
    const result = createCanvasInputResolver(canvasNodeIndex(entries), edges)("target");
    expect(result.media.map((m) => [m.key, m.edgeId])).toEqual([
      ["relay", "relay->target"],
      ["source", "relay->target"],
    ]);
    expect(result.texts.map((t) => t.text)).toEqual(["# Current draft"]);
    expect(result.pending).toEqual([]);
  });

  it("does not overflow on a deep cyclic relay graph", () => {
    const entries: CanvasNodeEntry[] = [{ type: "asset", data: material("source") }];
    const edges: AssetEdgeData[] = [];
    for (let i = 0; i < 12000; i++) {
      entries.push({ type: "result", data: { key: `relay-${i}`, x: 0, y: 0 } });
      edges.push(edge(i === 0 ? "source" : `relay-${i - 1}`, `relay-${i}`));
    }
    edges.push(edge("relay-11999", "relay-200"));
    expect(
      createCanvasInputResolver(
        canvasNodeIndex(entries),
        edges,
      )("relay-11999").media.map((m) => m.key),
    ).toEqual(["source"]);
  });

  it("follows the latest saved producer task while explicit output references stay pinned", () => {
    const entries: CanvasNodeEntry[] = [
      { type: "gen", data: prompt("generator") },
      { type: "gen", data: prompt("target") },
      { type: "output", data: output("old", "generator", "old-task") },
      { type: "output", data: output("new-a", "generator", "new-task") },
      {
        type: "output",
        data: { ...output("new-b", "generator", "new-task"), resultKey: "new-task#1" },
      },
      {
        type: "output",
        data: { ...output("unfinished", "generator", "unfinished-task"), finalPath: null },
      },
      {
        type: "output",
        data: { ...output("late-old-layer", "generator", "old-task"), resultKey: "old-task#1" },
      },
    ];
    const index = canvasNodeIndex(entries);
    expect(
      createCanvasInputResolver(index, [edge("generator", "target")])("target").media.map(
        (m) => m.key,
      ),
    ).toEqual(["new-a", "new-b"]);
    expect(
      createCanvasInputResolver(index, [edge("generator", "old"), edge("old", "target")])(
        "target",
      ).media.map((m) => m.key),
    ).toEqual(["old"]);
    expect(
      createCanvasInputResolver(index, [edge("unfinished", "target")])("target").pending,
    ).toEqual([{ sourceKey: "unfinished", edgeId: "unfinished->target", name: "unfinished" }]);
  });

  it("shows the producer's pending output while its available incoming media can already relay", () => {
    const entries: CanvasNodeEntry[] = [
      { type: "asset", data: material("source") },
      { type: "gen", data: prompt("producer") },
      { type: "result", data: { key: "relay", x: 0, y: 0 } },
      { type: "gen", data: prompt("target") },
    ];
    const resolved = createCanvasInputResolver(canvasNodeIndex(entries), [
      edge("source", "producer"),
      edge("producer", "relay"),
      edge("relay", "target"),
    ])("target");
    expect(resolved.media.map((input) => input.key)).toEqual(["source"]);
    expect(resolved.pending).toEqual([
      { sourceKey: "producer", edgeId: "relay->target", name: "producer" },
    ]);
  });

  it("uses latest editable documents and saved text outputs after patches, disconnect and restore", () => {
    const canvas = createCanvasState();
    canvas.commands.insertSubgraph(
      [
        { type: "storyboard", data: { ...documentNode("doc", "old"), kind: "storyboard" } },
        {
          type: "output",
          data: { ...output("text-output"), mediaType: "text", textContent: "old text" },
        },
        { type: "gen", data: prompt("target") },
      ],
      [edge("doc", "target"), edge("text-output", "target")],
    );
    const before = canvas.getSnapshot();
    canvas.commands.patchNode("storyboard", "doc", (node) => ({
      ...node,
      config: { ...node.config, currentDocument: "new" },
    }));
    canvas.commands.patchNode("output", "text-output", (node) => ({
      ...node,
      textContent: "new text",
    }));
    const after = canvas.getSnapshot();
    expect(after.nodeByKey.storyboard).not.toBe(before.nodeByKey.storyboard);
    expect(after.nodeByKey.output).not.toBe(before.nodeByKey.output);
    expect(
      createCanvasInputResolver(
        after.nodeByKey,
        after.graph.edges,
      )("target").texts.map((t) => t.text),
    ).toEqual(["new", "new text"]);
    const saved = canvas.commands.snapshotV2({});
    expect(
      createCanvasInputResolver(
        canvasNodesByKeyFromDocument(saved),
        saved.assetEdges,
      )("target").texts.map((t) => t.text),
    ).toEqual(["new", "new text"]);
    canvas.commands.disconnect("doc->target");
    canvas.commands.removeNode("text-output");
    const removed = canvas.getSnapshot();
    expect(createCanvasInputResolver(removed.nodeByKey, removed.graph.edges)("target")).toEqual({
      media: [],
      texts: [],
      pending: [],
    });
  });

  it("reads workflow documents and delivered files live while excluding replaced shot clips", () => {
    const config = createKnowledgeVideoWorkflowConfig(
      { prompt: model, image: model, video: model },
      true,
    );
    const canvas = createCanvasState();
    canvas.commands.insertSubgraph(
      [
        {
          type: "knowledgeVideoWorkflow",
          data: { key: "workflow", kind: "knowledge_video_workflow", x: 0, y: 0, config },
        },
        { type: "gen", data: prompt("target") },
      ],
      [edge("workflow", "target")],
    );
    const old = canvas.getSnapshot();
    canvas.commands.patchNode("knowledgeVideoWorkflow", "workflow", (node) => ({
      ...node,
      config: {
        ...node.config,
        checkpoint: {
          ...node.config.checkpoint,
          script: "live script",
          storyboard: "live storyboard",
          coverImagePath: "C:/cover.png",
          finalPath: "C:/final.mp4",
        },
      },
    }));
    const current = canvas.getSnapshot();
    expect(current.nodeByKey.knowledgeVideoWorkflow).not.toBe(old.nodeByKey.knowledgeVideoWorkflow);
    const result = createCanvasInputResolver(current.nodeByKey, current.graph.edges)("target");
    expect(result.texts.map((t) => t.text)).toEqual(["live script", "live storyboard"]);
    expect(result.media.map((m) => m.finalPath)).toEqual(["C:/final.mp4", "C:/cover.png"]);
    expect(result.media.every((m) => m.target.kind === "local_file")).toBe(true);
  });

  it("preserves cover and animation image types when the shared finalPath points to an image", () => {
    const config = createKnowledgeVideoWorkflowConfig(
      { prompt: model, image: model, video: model },
      true,
    );
    const entries: CanvasNodeEntry[] = [
      { type: "gen", data: prompt("target") },
      {
        type: "knowledgeVideoWorkflow",
        data: {
          key: "cover",
          kind: "knowledge_video_workflow",
          x: 0,
          y: 0,
          config: {
            ...config,
            checkpoint: {
              ...config.checkpoint,
              finalPath: "C:/cover.png",
              coverImagePath: "C:/cover.png",
              xhsCover: { ...createXhsCoverCheckpoint(), finalPath: "C:/cover.png" },
            },
          },
        },
      },
      {
        type: "knowledgeVideoWorkflow",
        data: {
          key: "animation",
          kind: "knowledge_video_workflow",
          x: 0,
          y: 0,
          config: {
            ...config,
            checkpoint: {
              ...config.checkpoint,
              finalPath: "C:/animation.gif",
              remotion: {
                ...createRemotionCheckpoint(),
                renderJob: {
                  id: "animation",
                  status: "succeeded",
                  progress: 1,
                  message: "",
                  gifPath: "C:/animation.gif",
                  videoPath: "C:/animation.mp4",
                  createdAt: 0,
                  updatedAt: 0,
                },
              },
            },
          },
        },
      },
    ];
    const resolved = createCanvasInputResolver(canvasNodeIndex(entries), [
      edge("cover", "target"),
      edge("animation", "target"),
    ])("target");
    expect(resolved.media.map((m) => [m.finalPath, m.kind])).toEqual([
      ["C:/cover.png", "image"],
      ["C:/animation.gif", "image"],
      ["C:/animation.mp4", "video"],
    ]);
  });
});
