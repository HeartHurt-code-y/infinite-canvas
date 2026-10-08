import { describe, expect, it } from "vitest";
import { createCanvasState } from "../canvas/canvasStore";
import type { PromptContentDocumentV1 } from "../../lib/promptContent";
import { createGreenScreenConfig } from "../../lib/greenScreen";
import { createWhiteModelStudioDraft } from "../../lib/whiteModelStudio";
import { createKnowledgeVideoWorkflowConfig } from "./workspaceModel";
import { captureCanvasNodes, pasteCanvasNodes } from "./canvasNodeClipboard";

const asset = (key: string) => ({
  key,
  assetId: `media-${key}`,
  providerConnectionId: "provider",
  kind: "image" as const,
  name: key,
  previewUrl: null,
  videoUrl: null,
  x: 10,
  y: 20,
});

describe("canvas node copy", () => {
  it("复制抽帧节点保留配置并清除原任务检查点", () => {
    const canvas = createCanvasState();
    canvas.commands.addNode("frameExtractor", {
      key: "original-frames",
      kind: "frame_extractor",
      x: 0,
      y: 0,
      config: {
        videoPath: "C:/media/source.mp4",
        timestamps: [1, 3],
        checkpoint: {
          batchId: "original-batch",
          activeJobId: "original-job",
          sources: ["C:/media/next.mp4"],
          timestamps: [1, 3],
        },
      },
    });
    const original = canvas.commands.snapshotV2({});
    const copied = pasteCanvasNodes(
      captureCanvasNodes(original, new Set(["original-frames"])),
      { x: 100, y: 100 },
      () => "copied-frames",
    );
    expect(copied.nodes[0]).toMatchObject({
      type: "frameExtractor",
      data: { config: { videoPath: "C:/media/source.mp4", timestamps: [1, 3] } },
    });
    const entry = copied.nodes[0];
    if (entry?.type !== "frameExtractor") throw new Error("copy kind changed");
    expect(entry.data.config.checkpoint).toBeUndefined();
    expect(original.frameExtractorNodes?.[0]?.config.checkpoint?.activeJobId).toBe("original-job");
  });
  it("copies only internal edges and remaps slots and explicit media references", () => {
    const canvas = createCanvasState();
    canvas.commands.addNode("asset", asset("selected-asset"));
    canvas.commands.addNode("asset", asset("outside-asset"));
    canvas.commands.addNode("gen", {
      key: "image-gen",
      kind: "image",
      x: 100,
      y: 200,
      config: {
        modelSelection: { providerId: "provider", modelDefinitionId: "image" },
        generationCount: 1,
        parameterValues: {},
        catalogResolved: true,
        inputSlots: ["selected-asset", "outside-asset", null],
      },
    });
    canvas.commands.connect("selected-asset", "image-gen");
    canvas.commands.connect("outside-asset", "image-gen");
    const prompt: PromptContentDocumentV1 = {
      schema: "prompt-content",
      version: 1,
      items: [
        { kind: "text", text: "use " },
        {
          kind: "media_reference",
          mentionId: "mention-1",
          canvasNodeKey: "selected-asset",
          target: {
            kind: "asset",
            canvasNodeKey: "selected-asset",
            mediaType: "image",
            providerConnectionId: "provider",
            assetId: "media-selected-asset",
          },
          displayNameSnapshot: "selected-asset",
        },
        {
          kind: "media_reference",
          mentionId: "mention-2",
          canvasNodeKey: "outside-asset",
          target: {
            kind: "asset",
            canvasNodeKey: "outside-asset",
            mediaType: "image",
            providerConnectionId: "provider",
            assetId: "media-outside-asset",
          },
          displayNameSnapshot: "outside-asset",
        },
      ],
    };
    const document = canvas.commands.snapshotV2({ "image-gen": prompt });
    const clipboard = captureCanvasNodes(document, new Set(["selected-asset", "image-gen"]));
    const pasted = pasteCanvasNodes(
      clipboard,
      { x: 40, y: 50 },
      (entry) => `copy-${entry.data.key}`,
    );

    expect(pasted.keys).toEqual(["copy-selected-asset", "copy-image-gen"]);
    expect(pasted.edges).toEqual([
      {
        id: "copy-selected-asset->copy-image-gen",
        fromKey: "copy-selected-asset",
        toKey: "copy-image-gen",
      },
    ]);
    const copiedGen = pasted.nodes.find((entry) => entry.data.key === "copy-image-gen");
    expect(copiedGen?.type).toBe("gen");
    if (copiedGen?.type !== "gen" || copiedGen.data.kind !== "image") return;
    expect(copiedGen.data.config.inputSlots).toEqual(["copy-selected-asset", null, null]);
    expect(copiedGen.data.x).toBe(140);
    const copiedPrompt = pasted.promptContents["copy-image-gen"]!;
    const references = copiedPrompt.items.filter((item) => item.kind === "media_reference");
    expect(references[0]).toMatchObject({
      canvasNodeKey: "copy-selected-asset",
      target: { canvasNodeKey: "copy-selected-asset", assetId: "media-selected-asset" },
    });
    expect(references[1]).toMatchObject({ canvasNodeKey: "outside-asset" });
    const original = document.genNodes[0];
    expect(original?.kind).toBe("image");
    if (original?.kind === "image")
      expect(original.config.inputSlots).toEqual(["selected-asset", "outside-asset", null]);
  });

  it("skips unsaved outputs and resets copied workflow execution state", () => {
    const canvas = createCanvasState();
    const base = createKnowledgeVideoWorkflowConfig(
      {
        prompt: { providerId: "provider", modelDefinitionId: "text" },
        image: { providerId: "provider", modelDefinitionId: "image" },
        video: { providerId: "provider", modelDefinitionId: "video" },
      },
      true,
    );
    canvas.commands.addNode("knowledgeVideoWorkflow", {
      key: "workflow",
      kind: "knowledge_video_workflow",
      x: 0,
      y: 0,
      config: {
        ...base,
        brief: "Make a short film",
        historyRunId: "old-run",
        checkpoint: { ...base.checkpoint, runId: "old-run", phase: "generating" },
      },
    });
    canvas.commands.addNode("output", {
      key: "pending",
      resultKey: null,
      sourceNodeId: "workflow",
      taskId: "old-run",
      mediaType: "image",
      finalPath: null,
      name: null,
      x: 20,
      y: 30,
    });
    const clipboard = captureCanvasNodes(
      canvas.commands.snapshotV2({}),
      new Set(["workflow", "pending"]),
    );
    expect(clipboard.skippedPendingOutputs).toBe(1);
    const pasted = pasteCanvasNodes(clipboard, { x: 40, y: 40 }, () => "new-workflow");
    expect(pasted.nodes).toHaveLength(1);
    const copied = pasted.nodes[0];
    expect(copied?.type).toBe("knowledgeVideoWorkflow");
    if (copied?.type !== "knowledgeVideoWorkflow") return;
    expect(copied.data.config.brief).toBe("Make a short film");
    expect(copied.data.config.historyRunId).toBeUndefined();
    expect(copied.data.config.checkpoint.phase).toBe("idle");
    expect(copied.data.config.checkpoint.runId).toBeNull();
  });

  it("keeps saved media provenance while giving the copied output a new canvas identity", () => {
    const canvas = createCanvasState();
    canvas.commands.addNode("output", {
      key: "output-original",
      resultKey: "task-1#0",
      sourceNodeId: "producer",
      taskId: "task-1",
      mediaType: "image",
      finalPath: "C:/results/final.png",
      name: "final.png",
      x: 300,
      y: 100,
    });
    const clipboard = captureCanvasNodes(
      canvas.commands.snapshotV2({}),
      new Set(["output-original"]),
    );
    const pasted = pasteCanvasNodes(clipboard, { x: 40, y: 40 }, () => "output-copy");
    expect(pasted.nodes).toHaveLength(1);
    expect(pasted.nodes[0]).toMatchObject({
      type: "output",
      data: {
        key: "output-copy",
        resultKey: "task-1#0",
        taskId: "task-1",
        finalPath: "C:/results/final.png",
        sourceNodeId: "producer",
        x: 340,
        y: 140,
      },
    });
    expect(pasted.edges).toEqual([]);
  });

  it("remaps video material bindings and discards execution jobs and approvals", () => {
    const canvas = createCanvasState();
    canvas.commands.addNode("asset", asset("reference"));
    canvas.commands.addNode("gen", {
      key: "video-gen",
      kind: "video",
      x: 100,
      y: 100,
      config: {
        modelSelection: { providerId: "provider", modelDefinitionId: "video" },
        generationCount: 1,
        parameterValues: {},
        catalogResolved: true,
        mediaRoles: { reference: "first_frame" },
        whiteModelStudio: {
          ...createWhiteModelStudioDraft(),
          jobId: "old-blender-job",
          jobInputSignature: "old-signature",
        },
        greenScreen: {
          ...createGreenScreenConfig(),
          enabled: true,
          phase: "composite",
          subjectReference: {
            key: "reference",
            name: "reference",
            target: {
              kind: "asset",
              canvasNodeKey: "reference",
              mediaType: "image",
              providerConnectionId: "provider",
              assetId: "media-reference",
            },
          },
          preparationTasks: [{ taskId: "old-task", signature: "old-signature" }],
        },
      },
    });
    canvas.commands.connect("reference", "video-gen");
    const clipboard = captureCanvasNodes(
      canvas.commands.snapshotV2({}),
      new Set(["reference", "video-gen"]),
    );
    const pasted = pasteCanvasNodes(
      clipboard,
      { x: 40, y: 40 },
      (entry) => `copy-${entry.data.key}`,
    );
    const copiedVideo = pasted.nodes.find((entry) => entry.data.key === "copy-video-gen");
    expect(copiedVideo?.type).toBe("gen");
    if (copiedVideo?.type !== "gen" || copiedVideo.data.kind !== "video") return;
    expect(copiedVideo.data.config.mediaRoles).toEqual({ "copy-reference": "first_frame" });
    expect(copiedVideo.data.config.whiteModelStudio?.jobId).toBeNull();
    expect(copiedVideo.data.config.whiteModelStudio?.jobInputSignature).toBeUndefined();
    expect(copiedVideo.data.config.greenScreen?.phase).toBe("prepare");
    expect(copiedVideo.data.config.greenScreen?.preparationTasks).toEqual([]);
    expect(copiedVideo.data.config.greenScreen?.subjectReference).toMatchObject({
      key: "copy-reference",
      target: { canvasNodeKey: "copy-reference" },
    });
  });
});
