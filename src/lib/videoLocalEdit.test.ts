import { describe, expect, it } from "vitest";
import { appendVideoLocalEditPrompt } from "./videoLocalEdit";
import {
  createPromptContentEditorSession,
  createPromptContentModule,
  type PromptContentDocumentV1,
} from "./promptContent";
import {
  candidateTarget,
  createPromptReference,
  type PromptReferenceCandidate,
} from "./promptReferences";
import { createCanvasState } from "../features/canvas/canvasStore";
import {
  createCanvasInputResolver,
  canvasNodesByKeyFromDocument,
} from "../features/workspace/canvasInputs";
import type { OutputNodeData } from "../features/workspace/workspaceModel";

const source = {
  key: "video-1",
  name: "同名视频",
  target: {
    kind: "local_file" as const,
    path: "C:/videos/source.mp4",
    mediaType: "video" as const,
    canvasNodeKey: "video-1",
  },
};
const frame = {
  key: "annotation-1",
  name: "同名视频 · 2.000s 标注",
  target: {
    kind: "local_file" as const,
    path: "C:/frames/annotation.png",
    mediaType: "image" as const,
    canvasNodeKey: "annotation-1",
  },
};

/** 编辑要求与画布提示词同构：正文 + @ 引用组成同一个文档。 */
function instructionDocument(...items: PromptContentDocumentV1["items"]): PromptContentDocumentV1 {
  return { schema: "prompt-content", version: 1, items };
}

describe("video local edit prompt and persistence", () => {
  it("preserves existing text and sends source video plus real frame with stable roles", () => {
    const module = createPromptContentModule();
    const session = createPromptContentEditorSession([]);
    module.adoptEditor("target", session);
    module.replaceText("target", "保持原声。", []);
    module.replaceText("other", "另一节点不能被改写。", []);
    const document = appendVideoLocalEditPrompt(module.snapshotAll()["target"], source, frame, {
      timeSeconds: 2,
      operation: "remove",
      instructionDocument: instructionDocument({ kind: "text", text: "消除右侧路人" }),
      timeRange: { startSeconds: 5, endSeconds: 8 },
    });
    module.restoreDocument("target", document);
    const prepared = module.prepareGeneration("target", {
      connections: [
        { ...frame, kind: "image", role: "reference_image" },
        { ...source, kind: "video", role: "reference_video" },
      ],
      allowMediaOnly: false,
    });
    expect(prepared?.ok).toBe(true);
    if (!prepared?.ok) throw new Error("Expected a valid local edit request");
    expect(prepared.frozen.explicitMedia).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: source.target, role: "reference_video" }),
        expect.objectContaining({ target: frame.target, role: "reference_image" }),
      ]),
    );
    expect(module.read("target")?.plainText).toContain("保持原声。");
    expect(module.read("target")?.plainText).toContain("2.000 秒处");
    expect(module.read("target")?.plainText).toContain("5.000–8.000 秒");
    expect(module.read("target")?.plainText).toContain("消除右侧路人");
    expect(module.read("other")?.plainText).toBe("另一节点不能被改写。");
    expect(JSON.stringify(document)).not.toContain("data:image");
  });

  it("keeps an @ referenced replacement material as a real input instead of plain text", () => {
    const candidate: PromptReferenceCandidate = {
      canvasNodeKey: "prop-image",
      assetId: "asset-rose",
      providerConnectionId: "project-provider",
      name: "红玫瑰.png",
      kind: "image",
    };
    const document = appendVideoLocalEditPrompt(undefined, source, frame, {
      timeSeconds: 1.5,
      operation: "replace",
      instructionDocument: instructionDocument(
        { kind: "text", text: "  去掉，改为" },
        createPromptReference(candidate),
        { kind: "text", text: "  " },
      ),
      timeRange: null,
    });
    const session = createPromptContentEditorSession([]);
    session.restore(document);
    expect(session.read().plainText).toContain("：去掉，改为@红玫瑰.png。保持区域外画面");
    const prepared = session.prepareGeneration({
      connections: [
        { ...source, kind: "video", role: "reference_video" },
        { ...frame, kind: "image", role: "reference_image" },
        {
          key: candidate.canvasNodeKey,
          name: candidate.name,
          kind: "image",
          target: candidateTarget(candidate),
        },
      ],
      allowMediaOnly: false,
    });
    expect(prepared?.ok).toBe(true);
    if (!prepared?.ok) throw new Error("Expected the referenced instruction to be submittable");
    expect(prepared.frozen.explicitMedia).toEqual([
      expect.objectContaining({ target: source.target, role: "reference_video" }),
      expect.objectContaining({ target: frame.target, role: "reference_image" }),
      expect.objectContaining({ displayNameSnapshot: "红玫瑰.png" }),
    ]);
  });

  it("reports a disconnected @ reference in the edit instruction instead of silently editing", () => {
    const candidate: PromptReferenceCandidate = {
      canvasNodeKey: "prop-image",
      assetId: "asset-rose",
      providerConnectionId: "project-provider",
      name: "红玫瑰.png",
      kind: "image",
    };
    const session = createPromptContentEditorSession([]);
    session.restore(
      appendVideoLocalEditPrompt(undefined, source, frame, {
        timeSeconds: 0,
        operation: "replace",
        instructionDocument: instructionDocument(
          { kind: "text", text: "改为" },
          createPromptReference(candidate),
        ),
      }),
    );
    expect(
      session.prepareGeneration({
        connections: [
          { ...source, kind: "video", role: "reference_video" },
          { ...frame, kind: "image", role: "reference_image" },
        ],
        allowMediaOnly: false,
      }),
    ).toMatchObject({
      ok: false,
      issues: [
        expect.objectContaining({ kind: "disconnected_reference", canvasNodeKey: "prop-image" }),
      ],
    });
  });

  it("blocks disconnected or replaced source identity instead of editing a same-name video", () => {
    const session = createPromptContentEditorSession([]);
    session.restore(
      appendVideoLocalEditPrompt(undefined, source, frame, {
        timeSeconds: 0,
        operation: "replace",
        instructionDocument: instructionDocument({ kind: "text", text: "把水杯换成花束" }),
      }),
    );
    const connections = [{ ...frame, kind: "image" as const, role: "reference_image" }];
    expect(session.prepareGeneration({ connections, allowMediaOnly: false })).toMatchObject({
      ok: false,
      issues: [
        expect.objectContaining({ kind: "disconnected_reference", canvasNodeKey: source.key }),
      ],
    });
    expect(
      session.prepareGeneration({
        connections: [
          ...connections,
          {
            ...source,
            kind: "video",
            role: "reference_video",
            target: { ...source.target, path: "C:/videos/replaced.mp4" },
          },
        ],
        allowMediaOnly: false,
      }),
    ).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ kind: "reference_identity_changed" })],
    });
  });

  it("restores annotated frames as local image inputs without replacing a generator's result", () => {
    const canvas = createCanvasState();
    const config = {
      modelSelection: { providerId: "provider", modelDefinitionId: "seedance-2-5" },
      generationCount: 1,
      parameterValues: {},
      catalogResolved: true,
    };
    canvas.commands.addNode("gen", { key: "producer", kind: "video", x: 0, y: 0, config });
    canvas.commands.addNode("gen", { key: "target", kind: "video", x: 500, y: 0, config });
    const original: OutputNodeData = {
      key: source.key,
      resultKey: null,
      sourceNodeId: "producer",
      taskId: "source-video",
      origin: "download",
      mediaType: "video",
      finalPath: source.target.path,
      name: source.name,
      x: 100,
      y: 0,
    };
    canvas.commands.addOutput(original);
    canvas.commands.connect(source.key, "target");
    canvas.commands.insertSubgraph(
      [
        {
          type: "output",
          data: {
            key: frame.key,
            resultKey: null,
            sourceNodeId: source.key,
            taskId: "annotation",
            origin: "video_edit",
            mediaType: "image",
            finalPath: frame.target.path,
            name: frame.name,
            x: 150,
            y: 150,
          },
        },
      ],
      [{ id: "annotation-edge", fromKey: frame.key, toKey: "target" }],
    );
    const document = canvas.commands.snapshotV2({});
    const restored = createCanvasState();
    expect(restored.commands.restoreDocument(document).ok).toBe(true);
    const resolver = createCanvasInputResolver(
      canvasNodesByKeyFromDocument(restored.commands.snapshotV2({})),
      document.assetEdges,
    );
    expect(resolver("target").media.map((input) => input.target)).toEqual([
      source.target,
      frame.target,
    ]);
    const downstream = createCanvasState();
    downstream.commands.restoreDocument(document);
    downstream.commands.addNode("gen", { key: "downstream", kind: "video", x: 900, y: 0, config });
    downstream.commands.connect("producer", "downstream");
    const next = downstream.commands.snapshotV2({});
    const downstreamInputs = createCanvasInputResolver(
      canvasNodesByKeyFromDocument(next),
      next.assetEdges,
    )("downstream");
    expect(downstreamInputs.media.map((input) => input.kind)).toEqual(["video"]);
  });
});
