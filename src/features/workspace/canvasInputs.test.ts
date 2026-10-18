import { describe, expect, it } from "vitest";
import { createCanvasState, type CanvasNodeEntry } from "../canvas/canvasStore";
import {
  canvasInputEdgeOrder,
  canvasNodeIndex,
  canvasNodesByKeyFromDocument,
  connectedCanvasPromptText,
  createCanvasInputResolver,
  createCanvasInputResolverCache,
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

describe("incremental canvas input cache", () => {
  it("updates slot ordering and missing source/type changes without invalidating disjoint inputs", () => {
    const cache = createCanvasInputResolverCache();
    const image: GenNodeData = {
      key: "image",
      kind: "image",
      x: 0,
      y: 0,
      config: {
        modelSelection: model,
        generationCount: 1,
        parameterValues: {},
        catalogResolved: true,
        inputSlots: ["a", "b"],
      },
    };
    const entries: CanvasNodeEntry[] = [
      { type: "asset", data: material("a") },
      { type: "asset", data: material("b") },
      { type: "gen", data: image },
      { type: "gen", data: prompt("other", "independent") },
      { type: "gen", data: prompt("target") },
    ];
    const edges = [edge("a", "image"), edge("b", "image"), edge("other", "target")];
    const initial = cache(canvasNodeIndex(entries), edges);
    initial("image");
    const unrelated = initial("target");
    const reordered: CanvasNodeEntry[] = entries.map((entry) =>
      entry.data.key === "image"
        ? { type: "gen", data: { ...image, config: { ...image.config, inputSlots: ["b", "a"] } } }
        : entry,
    );
    let resolver = cache(canvasNodeIndex(reordered), edges);
    expect(resolver("image").media.map((item) => [item.sourceKey, item.slotIndex])).toEqual([
      ["b", 0],
      ["a", 1],
    ]);
    expect(resolver("target")).toBe(unrelated);
    const missing = reordered.filter((entry) => entry.data.key !== "a");
    resolver = cache(canvasNodeIndex(missing), edges);
    expect(resolver("image").media.map((item) => item.sourceKey)).toEqual(["b"]);
    expect(resolver("target")).toBe(unrelated);
    const changedType: CanvasNodeEntry[] = missing.map((entry) =>
      entry.data.key === "other" ? { type: "asset", data: material("other") } : entry,
    );
    const index = canvasNodeIndex(changedType);
    resolver = cache(index, edges);
    expect(resolver("target")).toEqual(createCanvasInputResolver(index, edges)("target"));
    expect(resolver("target").texts).toHaveLength(0);
    expect(resolver("target").media).toHaveLength(1);
  });
  it("invalidates only successors and keeps old snapshots stable", () => {
    const cache = createCanvasInputResolverCache();
    const entries: CanvasNodeEntry[] = [
      { type: "asset", data: material("a") },
      { type: "asset", data: material("b") },
      { type: "result", data: { key: "relay", x: 0, y: 0 } },
      { type: "gen", data: prompt("left") },
      { type: "gen", data: prompt("right") },
    ];
    const edges = [edge("a", "relay"), edge("relay", "left"), edge("b", "right")];
    const initialIndex = canvasNodeIndex(entries);
    const initial = cache(initialIndex, edges);
    const left = initial("left"),
      right = initial("right");
    const nextEntries: CanvasNodeEntry[] = [
      { type: "asset", data: { ...material("a"), name: "edited" } },
      ...entries.slice(1),
    ];
    const index = canvasNodeIndex(nextEntries);
    const next = cache(index, edges);
    expect(next("left")).not.toBe(left);
    expect(next("right")).toBe(right);
    expect(next("left")).toEqual(createCanvasInputResolver(index, edges)("left"));
    expect(initial("left")).toBe(left);
    expect(initial("left").media[0]?.name).toBe("a");
    expect(cache(initialIndex, edges)).toBe(initial);
  });

  it("handles edge removal/reordering and leaves other components cached", () => {
    const cache = createCanvasInputResolverCache();
    const index = canvasNodeIndex([
      { type: "asset", data: material("a") },
      { type: "asset", data: material("b") },
      { type: "asset", data: material("c") },
      { type: "gen", data: prompt("left") },
      { type: "gen", data: prompt("right") },
    ]);
    const original = [edge("a", "left"), edge("b", "left"), edge("c", "right")];
    const before = cache(index, original);
    const right = before("right"),
      left = before("left");
    const reordered = [original[2]!, original[1]!, original[0]!];
    const after = cache(index, reordered);
    expect(after("right")).toBe(right);
    expect(after("left")).not.toBe(left);
    expect(after("left").media.map((input) => input.sourceKey)).toEqual(["b", "a"]);
    const removed = cache(index, [original[2]!, original[0]!]);
    expect(removed("right")).toBe(right);
    expect(removed("left").media.map((input) => input.sourceKey)).toEqual(["a"]);
  });

  it("tracks output-to-producer dependencies while provenance keeps selected outputs pinned", () => {
    const cache = createCanvasInputResolverCache();
    const selected = output("old", "producer", "old-task");
    let entries: CanvasNodeEntry[] = [
      { type: "gen", data: prompt("producer", "original") },
      { type: "output", data: selected },
      { type: "gen", data: prompt("live") },
      { type: "gen", data: prompt("pinned") },
      { type: "asset", data: material("other") },
      { type: "gen", data: prompt("unrelated") },
    ];
    const edges = [
      edge("producer", "live"),
      edge("producer", "old"),
      edge("old", "pinned"),
      edge("other", "unrelated"),
    ];
    const original = cache(canvasNodeIndex(entries), edges);
    const pinned = original("pinned"),
      unrelated = original("unrelated");
    original("live");
    entries = [{ type: "gen", data: prompt("producer", "edited") }, ...entries.slice(1)];
    let current = cache(canvasNodeIndex(entries), edges);
    expect(current("pinned")).toBe(pinned);
    expect(current("unrelated")).toBe(unrelated);
    expect(current("live").texts[0]?.text).toBe("edited");
    entries = [...entries, { type: "output", data: output("new", "producer", "new-task") }];
    const index = canvasNodeIndex(entries);
    current = cache(index, edges);
    expect(current("pinned")).toBe(pinned);
    expect(current("unrelated")).toBe(unrelated);
    expect(current("live").media.map((item) => item.sourceKey)).toEqual(["new"]);
    expect(current("live")).toEqual(createCanvasInputResolver(index, edges)("live"));
  });

  it("updates empty placeholders, late old layers and producer reassignment without staleness", () => {
    const cache = createCanvasInputResolverCache();
    const placeholder = { ...output("new", "p", "new-task"), finalPath: null };
    let entries: CanvasNodeEntry[] = [
      { type: "gen", data: prompt("p") },
      { type: "gen", data: prompt("q") },
      { type: "output", data: output("old", "p", "old-task") },
      { type: "output", data: placeholder },
      { type: "gen", data: prompt("left") },
      { type: "gen", data: prompt("right") },
    ];
    const edges = [edge("p", "left"), edge("q", "right")];
    let resolver = cache(canvasNodeIndex(entries), edges);
    expect(resolver("left").media.map((item) => item.sourceKey)).toEqual(["old"]);
    resolver("right");
    entries = entries.map((entry) =>
      entry.data.key === "new"
        ? { type: "output", data: { ...placeholder, finalPath: "C:/new.png" } }
        : entry,
    );
    entries.push({ type: "output", data: output("old-layer", "p", "old-task") });
    resolver = cache(canvasNodeIndex(entries), edges);
    expect(resolver("left").media.map((item) => item.sourceKey)).toEqual(["new"]);
    entries = entries.map((entry) =>
      entry.type === "output" && entry.data.key === "new"
        ? { ...entry, data: { ...entry.data, sourceNodeId: "q" } }
        : entry,
    );
    const index = canvasNodeIndex(entries);
    resolver = cache(index, edges);
    for (const key of ["left", "right"])
      expect(resolver(key)).toEqual(createCanvasInputResolver(index, edges)(key));
    expect(resolver("right").media.map((item) => item.sourceKey)).toEqual(["new"]);
  });

  it("shares inputs across real store layout writes and isolates semantic edits/undo between canvases", async () => {
    const first = createCanvasState(),
      second = createCanvasState();
    for (const canvas of [first, second])
      canvas.commands.insertSubgraph(
        [
          { type: "asset", data: material("a") },
          { type: "asset", data: material("b") },
          { type: "gen", data: prompt("left") },
          { type: "gen", data: prompt("right") },
        ],
        [edge("a", "left"), edge("b", "right")],
      );
    const original = first.getSnapshot();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    const right = original.resolveInputs("right");
    const isolated = second.getSnapshot().resolveInputs("left");
    first.commands.patchNode("asset", "a", (node) => ({ ...node, x: 100 }));
    expect(first.getSnapshot().resolveInputs).toBe(original.resolveInputs);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    first.commands.patchNode("asset", "a", (node) => ({ ...node, name: "edited" }));
    expect(first.getSnapshot().resolveInputs("right")).toBe(right);
    expect(first.getSnapshot().resolveInputs("left").media[0]?.name).toBe("edited");
    expect(second.getSnapshot().resolveInputs("left")).toBe(isolated);
    expect(isolated.media[0]?.name).toBe("a");
    first.commands.undo();
    expect(first.getSnapshot().resolveInputs("right")).toBe(right);
    expect(first.getSnapshot().resolveInputs("left").media[0]?.name).toBe("a");
  });

  it("evaluates deep ancestry without recursive stack growth", () => {
    const count = 12_000;
    const entries: CanvasNodeEntry[] = [
      { type: "asset", data: material("root") },
      { type: "asset", data: material("end") },
      { type: "gen", data: prompt("target") },
      ...Array.from({ length: count }, (_, i): CanvasNodeEntry => ({
        type: "result",
        data: { key: `relay${i}`, x: 0, y: 0 },
      })),
    ];
    const edges = [
      edge("root", "relay0"),
      ...Array.from({ length: count - 1 }, (_, i) => edge(`relay${i}`, `relay${i + 1}`)),
      edge(`relay${count - 1}`, "end"),
      edge("end", "target"),
    ];
    const resolved = createCanvasInputResolverCache()(canvasNodeIndex(entries), edges)("target");
    expect(resolved.media.map((item) => item.sourceKey)).toEqual(["end", "root"]);
  });

  it("matches fresh evaluation through deterministic node/edge mutations, cycles and diamonds", () => {
    const cache = createCanvasInputResolverCache();
    let seed = 8127;
    const random = (max: number) => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed % max;
    };
    let entries: CanvasNodeEntry[] = Array.from({ length: 24 }, (_, i) =>
      i % 3
        ? { type: "gen", data: prompt(`n${i}`, String(i)) }
        : { type: "asset", data: material(`n${i}`) },
    );
    let edges: AssetEdgeData[] = Array.from({ length: 24 }, (_, i) =>
      edge(`n${i}`, `n${(i + 1) % 24}`),
    );
    for (let iteration = 0; iteration < 60; iteration += 1) {
      if (iteration % 3 === 0) {
        const index = random(entries.length);
        const entry = entries[index]!;
        entries = entries.map((item, i) =>
          i !== index
            ? item
            : entry.type === "asset"
              ? { ...entry, data: { ...entry.data, name: `edit${iteration}` } }
              : { type: "gen", data: prompt(entry.data.key, `edit${iteration}`) },
        );
      } else if (iteration % 3 === 1) {
        const next = edge(`n${random(24)}`, `n${random(24)}`);
        edges = [...edges.filter((item) => item.id !== next.id), next];
      } else edges = edges.filter((_, index) => index !== random(edges.length)).reverse();
      const index = canvasNodeIndex(entries);
      const incremental = cache(index, edges),
        fresh = createCanvasInputResolver(index, edges);
      for (const entry of entries)
        expect(incremental(entry.data.key)).toEqual(fresh(entry.data.key));
    }
  });
});

describe("unrestricted canvas payload graph", () => {
  it("cleans restored GPT Image 2 metadata while preserving all prompts through relays", () => {
    const fullDocument =
      "```text\n第一套完整图片提示词\n```\n\n说明：产品电商模板；保留包装。\n\n```text\n第二套完整图片提示词\n```\n\n注：不得新增产品功效。\n\n如果需要更换标题，请提供确认文案。";
    const cleanedDocument =
      "```text\n第一套完整图片提示词\n```\n\n\n```text\n第二套完整图片提示词\n```\n\n注：不得新增产品功效。\n\n如果需要更换标题，请提供确认文案。";
    const entries: CanvasNodeEntry[] = [
      {
        type: "gen",
        data: {
          key: "style",
          kind: "prompt",
          x: 0,
          y: 0,
          config: {
            ...createPromptNodeConfig(model, true),
            mode: "gpt_image_2_style",
            generatedPrompt: fullDocument,
          },
        },
      },
      { type: "gen", data: prompt("legacy", "```\n传统模式正文\n```\n\n旧模式说明") },
      { type: "result", data: { key: "relay", x: 0, y: 0 } },
      { type: "gen", data: prompt("target") },
    ];
    const sources = createCanvasInputResolver(canvasNodeIndex(entries), [
      edge("legacy", "target"),
      edge("style", "relay"),
      edge("relay", "target"),
    ])("target").texts;
    expect(sources.find((source) => source.sourceKey === "style")).toMatchObject({
      edgeId: "relay->target",
      preserveFullText: true,
      text: cleanedDocument,
    });
    expect(connectedCanvasPromptText(sources)).toBe(`传统模式正文\n\n${cleanedDocument}`);
    expect(connectedCanvasPromptText([...sources].reverse())).toBe(
      `${cleanedDocument}\n\n传统模式正文`,
    );
    expect(
      connectedCanvasPromptText(sources.filter((source) => source.sourceKey === "legacy")),
    ).toBe("传统模式正文");
  });

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
      mediaSlotCount: 0,
      mediaPosition: new Map(),
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

describe("画布连线序号", () => {
  const imageGenerator = (key: string): GenNodeData => ({
    key,
    kind: "image",
    x: 0,
    y: 0,
    config: {
      modelSelection: model,
      generationCount: 1,
      parameterValues: {},
      catalogResolved: true,
    },
  });

  it("删除后再重连的素材仍按清单顺序编号，不被追加到连线数组末尾", () => {
    const canvas = createCanvasState();
    canvas.commands.insertSubgraph(
      [
        { type: "gen", data: imageGenerator("gen") },
        { type: "asset", data: material("asset-a") },
        { type: "asset", data: material("asset-b") },
      ],
      [],
    );
    canvas.commands.connect("asset-a", "gen");
    canvas.commands.connect("asset-b", "gen");
    canvas.commands.disconnect("asset-a->gen");
    canvas.commands.connect("asset-a", "gen");

    const snapshot = canvas.getSnapshot();
    // 槽位账本把 asset-a 放回原位（第 1 个输入），连线数组却只能把新连线追加到末尾。
    expect(snapshot.nodeByKey.gen.get("gen")).toMatchObject({
      config: { inputSlots: ["asset-a", "asset-b"] },
    });
    expect(snapshot.graph.edges.map((item) => item.id)).toEqual(["asset-b->gen", "asset-a->gen"]);

    const resolved = createCanvasInputResolver(snapshot.nodeByKey, snapshot.graph.edges)("gen");
    expect(resolved.media.map((input) => input.key)).toEqual(["asset-a", "asset-b"]);
    // 序号按清单顺序读连线：asset-a 是第 1 个输入，asset-b 是第 2 个。
    // 旧实现直接取连线数组下标，徽标会与节点清单互相矛盾（asset-b=1、asset-a=2）。
    expect(
      canvasInputEdgeOrder(
        resolved,
        snapshot.graph.edges.map((item) => item.id),
      ),
    ).toEqual(["asset-a->gen", "asset-b->gen"]);
  });

  it("尚未产出结果的上游连线排在清单之后，解析不到的连线也不会漏号", () => {
    const entries: CanvasNodeEntry[] = [
      { type: "gen", data: imageGenerator("gen") },
      { type: "asset", data: material("asset-a") },
      // 尚未产出结果的节点：它不贡献媒体，只贡献一条等待中的输入和它自己的连线。
      { type: "result", data: { key: "empty-result", x: 0, y: 0 } },
    ];
    const edges: AssetEdgeData[] = [edge("empty-result", "gen"), edge("asset-a", "gen")];
    const resolved = createCanvasInputResolver(canvasNodeIndex(entries), edges)("gen");
    expect(resolved.media.map((input) => input.key)).toEqual(["asset-a"]);
    expect(resolved.pending.map((input) => input.sourceKey)).toEqual(["empty-result"]);
    expect(
      canvasInputEdgeOrder(
        resolved,
        edges.map((item) => item.id),
      ),
    ).toEqual(["asset-a->gen", "empty-result->gen"]);
    // 旧文档里解析不到任何输入的残留连线也按原始顺序接在末尾，不会与已有序号重号。
    expect(
      canvasInputEdgeOrder(resolved, ["asset-a->gen", "empty-result->gen", "stale->gen"]),
    ).toEqual(["asset-a->gen", "empty-result->gen", "stale->gen"]);
  });

  it("同一条连线承载多条输入（中转素材）时取首次出现的位置", () => {
    const entries: CanvasNodeEntry[] = [
      { type: "gen", data: imageGenerator("gen") },
      { type: "asset", data: material("source") },
      { type: "asset", data: material("relay") },
      { type: "asset", data: material("asset-c") },
    ];
    const incoming = [edge("relay", "gen"), edge("asset-c", "gen")];
    const resolved = createCanvasInputResolver(canvasNodeIndex(entries), [
      edge("source", "relay"),
      ...incoming,
    ])("gen");
    expect(resolved.media.map((input) => input.key)).toEqual(["relay", "source", "asset-c"]);
    expect(
      canvasInputEdgeOrder(
        resolved,
        incoming.map((item) => item.id),
      ),
    ).toEqual(["relay->gen", "asset-c->gen"]);
  });
});
