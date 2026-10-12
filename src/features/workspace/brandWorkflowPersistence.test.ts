import { describe, expect, it } from "vitest";
import { createCanvasState } from "../canvas/canvasStore";
import { node } from "../../test/videoWorkflowFixtures";
import { createBrandVideoCheckpoint, createBrandVideoOptions } from "./brandVideoWorkflowModel";
import { captureCanvasNodes, pasteCanvasNodes } from "./canvasNodeClipboard";
import type { BrandModelSelection } from "../../lib/brandModels";

const model: BrandModelSelection = {
  profileId: "long-term-model",
  versionId: "frozen-v1",
  signature: "a".repeat(64),
  name: "品牌模特",
  description: "原创成年模特",
  invariants: "五官比例与雀斑",
  references: [
    {
      id: "front",
      label: "正面",
      role: "front",
      path: "C:/managed/front.png",
      contentHash: "b".repeat(64),
      width: 1200,
      height: 1600,
      taskId: "identity-generation",
      resultIndex: 0,
    },
  ],
};

describe("brand workflow canvas lifetime", () => {
  it("restores frozen identity and paid task after JSON persistence, while copying starts fresh production", () => {
    const base = node();
    const source = createCanvasState();
    source.commands.addNode("knowledgeVideoWorkflow", {
      ...base,
      config: {
        ...base.config,
        historyRunId: "brand-history",
        brandVideo: { ...createBrandVideoOptions(), brandName: "杉间", model },
        checkpoint: {
          ...base.config.checkpoint,
          phase: "generating",
          runId: "brand-run",
          brandVideo: { ...createBrandVideoCheckpoint(), model },
          shotRuns: {
            "shot-1": {
              shotId: "shot-1",
              videoTaskId: "paid-video-task",
              qcStatus: "pending",
              retryCount: 0,
            },
          },
        },
      },
    });
    const serialized = JSON.stringify(source.commands.snapshotV2({}));
    expect(serialized).not.toContain("data:image");
    const restored = createCanvasState();
    expect(restored.commands.restoreDocument(JSON.parse(serialized))).toMatchObject({ ok: true });
    const current = restored.getSnapshot().nodes.knowledgeVideoWorkflow[0];
    expect(current?.config.brandVideo?.model).toEqual(model);
    expect(current?.config.checkpoint.phase).toBe("paused");
    expect(current?.config.checkpoint.shotRuns["shot-1"]?.videoTaskId).toBe("paid-video-task");
    const copied = pasteCanvasNodes(
      captureCanvasNodes(restored.commands.snapshotV2({}), new Set([base.key])),
      { x: 100, y: 100 },
      () => "new-project",
    );
    const copy = copied.nodes[0];
    if (copy?.type !== "knowledgeVideoWorkflow") throw new Error("Missing copied brand workflow");
    expect(copy.data.config.brandVideo?.model).toEqual(model);
    expect(copy.data.config.historyRunId).toBeUndefined();
    expect(copy.data.config.executionPlan).toBeUndefined();
    expect(copy.data.config.checkpoint.runId).toBeNull();
    expect(copy.data.config.checkpoint.shotRuns).toEqual({});
    expect(current?.config.checkpoint.shotRuns["shot-1"]?.videoTaskId).toBe("paid-video-task");
  });
});
