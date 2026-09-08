import { describe, expect, it, vi } from "vitest";
import type { PromptNodeClient } from "../../lib/backend";
import { createCanvasState, type CanvasNodeEntry } from "../canvas/canvasStore";
import { node } from "../../test/videoWorkflowFixtures";
import { createPromptNodeConfig } from "./workspaceModel";
import { createCanvasInputResolver } from "./canvasInputs";
import {
  workflowCanvasInputsFromDocument,
  workflowCanvasInputsFromResolved,
  withCanvasWorkflowMaterials,
  withLiveWorkflowCanvasInputs,
} from "./workflowCanvasInputs";
import {
  validateWorkflowMaterialsResume,
  withWorkflowMaterials,
  workflowMaterialsSignature,
} from "./workflowMaterials";

const model = { providerId: "provider", modelDefinitionId: "model" };
const textNode = (key: string, generatedPrompt: string): CanvasNodeEntry => ({
  type: "gen",
  data: {
    key,
    kind: "prompt",
    x: 0,
    y: 0,
    config: { ...createPromptNodeConfig(model, true), generatedPrompt },
  },
});
const edge = (fromKey: string, toKey: string) => ({ id: `${fromKey}->${toKey}`, fromKey, toKey });

function fixture() {
  const source = node();
  const canvas = createCanvasState();
  canvas.commands.insertSubgraph(
    [
      { type: "knowledgeVideoWorkflow", data: source },
      {
        type: "knowledgeVideoWorkflow",
        data: {
          ...source,
          key: "upstream",
          config: {
            ...source.config,
            checkpoint: { ...source.config.checkpoint, script: "完整剧本", storyboard: "完整分镜" },
          },
        },
      },
      { type: "result", data: { key: "relay", x: 0, y: 0 } },
      textNode("prompt", "第一个提示文本"),
      ...Array.from({ length: 20 }, (_, index): CanvasNodeEntry => ({
        type: "asset",
        data: {
          key: `material-${index}`,
          assetId: `asset-${index}`,
          providerConnectionId: "source-provider",
          kind: "image",
          name: `素材 ${index}`,
          previewUrl: null,
          videoUrl: null,
          x: 0,
          y: 0,
        },
      })),
    ],
    [
      edge("prompt", "relay"),
      edge("upstream", "relay"),
      ...Array.from({ length: 20 }, (_, index) => edge(`material-${index}`, "relay")),
      edge("relay", source.key),
    ],
  );
  return { canvas, source };
}

describe("workflow canvas input execution snapshots", () => {
  it("restores history progress without retaining snapshots of disconnected live text", () => {
    const { canvas, source } = fixture();
    const saved = withCanvasWorkflowMaterials(
      source,
      workflowCanvasInputsFromDocument(canvas.commands.snapshotV2({}), source.key),
    );
    const history = {
      ...saved,
      config: {
        ...saved.config,
        checkpoint: {
          ...saved.config.checkpoint,
          phase: "paused" as const,
          script: "已完成的制作稿",
        },
      },
    };
    const live = withLiveWorkflowCanvasInputs(history, source);
    expect(live.config.brief).toBe(source.config.brief);
    expect(live.config.connectedTexts).toEqual([]);
    expect(live.config.checkpoint.script).toBe("已完成的制作稿");
    canvas.commands.patchNode("knowledgeVideoWorkflow", source.key, () => live);
    canvas.commands.disconnect(`relay->${source.key}`);
    const restoredCanvas = createCanvasState();
    expect(restoredCanvas.commands.restoreDocument(canvas.commands.snapshotV2({})).ok).toBe(true);
    const afterDisconnect = withCanvasWorkflowMaterials(
      live,
      workflowCanvasInputsFromDocument(restoredCanvas.commands.snapshotV2({}), source.key),
    );
    expect(afterDisconnect.config.brief).not.toContain("第一个提示文本");
    expect(afterDisconnect.config.connectedTexts).toEqual([]);

    const historyOnlyCanvas = createCanvasState();
    historyOnlyCanvas.commands.insertSubgraph(
      [{ type: "knowledgeVideoWorkflow", data: history }],
      [],
    );
    const detached = createCanvasState();
    expect(detached.commands.restoreDocument(historyOnlyCanvas.commands.snapshotV2({})).ok).toBe(
      true,
    );
    expect(
      detached.getSnapshot().nodeByKey.knowledgeVideoWorkflow.get(source.key)?.config
        .connectedTexts,
    ).toEqual(saved.config.connectedTexts);
  });

  it("reads every relayed media identity and every text output in runtime and restored documents", () => {
    const { canvas, source } = fixture();
    const snapshot = canvas.getSnapshot();
    const runtime = workflowCanvasInputsFromResolved(
      createCanvasInputResolver(snapshot.nodeByKey, snapshot.graph.edges)(source.key),
    );
    const saved = workflowCanvasInputsFromDocument(canvas.commands.snapshotV2({}), source.key);
    expect(saved).toEqual(runtime);
    expect(saved.media).toHaveLength(20);
    expect(saved.media.every((input) => input.edgeId === `relay->${source.key}`)).toBe(true);
    expect(saved.texts.map((input) => input.text)).toEqual([
      "第一个提示文本",
      "完整剧本",
      "完整分镜",
    ]);
    const run = withCanvasWorkflowMaterials(source, saved);
    expect(run.config.connectedTexts).toHaveLength(3);
    expect(run.config.connectedMaterials).toHaveLength(20);
    expect(run.config.brief).toContain(source.config.brief);
    for (const input of saved.texts) expect(run.config.brief).toContain(input.text);
    expect(source.config.connectedTexts).toBeUndefined();
    expect(withCanvasWorkflowMaterials(run, saved).config.brief).toBe(run.config.brief);
  });

  it("forwards connected text to revision and review calls and invalidates changed or disconnected sources", async () => {
    const { canvas, source } = fixture();
    const before = withCanvasWorkflowMaterials(
      source,
      workflowCanvasInputsFromDocument(canvas.commands.snapshotV2({}), source.key),
    );
    const checkpoint = {
      ...source.config.checkpoint,
      materialsSignature: workflowMaterialsSignature(before.config),
    };
    const client = {
      run: vi
        .fn<PromptNodeClient["run"]>()
        .mockResolvedValue({ optimizedPrompt: "ok", rawModelOutput: "ok" }),
    };
    const wrapped = withWorkflowMaterials(client, before.config);
    for (const userPrompt of [before.config.brief, "检查当前修订结果"]) {
      await wrapped.run({
        providerConnectionId: "provider",
        modelDefinitionId: "model",
        mode: "knowledge_video_director",
        userPrompt,
      });
    }
    for (const [command] of client.run.mock.calls) {
      expect(command.referenceInputs).toHaveLength(20);
      for (const value of ["第一个提示文本", "完整剧本", "完整分镜"]) {
        expect(command.userPrompt.split(value)).toHaveLength(2);
      }
    }
    canvas.commands.patchNode("gen", "prompt", (entry) =>
      entry.kind === "prompt"
        ? { ...entry, config: { ...entry.config, generatedPrompt: "最新的完整文本" } }
        : entry,
    );
    const edited = withCanvasWorkflowMaterials(
      source,
      workflowCanvasInputsFromDocument(canvas.commands.snapshotV2({}), source.key),
    );
    expect(edited.config.brief).toContain("最新的完整文本");
    expect(edited.config.brief).not.toContain("第一个提示文本");
    expect(() => validateWorkflowMaterialsResume(edited.config, checkpoint)).toThrow(
      "参考素材已修改",
    );
    canvas.commands.disconnect(`relay->${source.key}`);
    const detached = withCanvasWorkflowMaterials(
      source,
      workflowCanvasInputsFromDocument(canvas.commands.snapshotV2({}), source.key),
    );
    expect(detached).toBe(source);
    expect(() => validateWorkflowMaterialsResume(detached.config, checkpoint)).toThrow(
      "参考素材已修改",
    );
  });
});
