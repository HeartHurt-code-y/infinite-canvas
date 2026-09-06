import { describe, expect, it } from "vitest";
import type { PickedPromptMaterial } from "../../lib/backend";
import type { WorkflowHistoryRecord } from "../../lib/workflowHistory";
import { createKnowledgeVideoWorkflowConfig } from "./workspaceModel";
import { restoreWorkflowHistoryNode } from "./workflowHistoryRestore";

const config = createKnowledgeVideoWorkflowConfig(
  {
    prompt: { providerId: "provider", modelDefinitionId: "text" },
    image: { providerId: "provider", modelDefinitionId: "image" },
    video: { providerId: "provider", modelDefinitionId: "video" },
  },
  true,
);
const materials: readonly PickedPromptMaterial[] = [
  {
    localPath: "C:\\references\\original.png",
    displayName: "original.png",
    kind: "image",
    mimeType: "image/png",
    byteSize: 4096,
  },
  {
    localPath: "C:\\references\\brief.md",
    displayName: "brief.md",
    kind: "document",
    mimeType: "text/markdown",
    byteSize: 1024,
  },
];
const record: WorkflowHistoryRecord = {
  id: "history-run",
  canvasId: "canvas",
  sourceNodeId: "original",
  workflowKind: "knowledge",
  title: "知识视频工作流",
  status: "paused",
  progress: 50,
  message: "已暂停",
  error: null,
  models: [],
  attemptCount: 1,
  revision: 5,
  createdAt: 1,
  updatedAt: 2,
  nodeSnapshot: {
    key: "original",
    kind: "knowledge_video_workflow",
    x: 10,
    y: 20,
    config: {
      ...config,
      historyRunId: "history-run",
      brief: "解释复利",
      materials,
      checkpoint: {
        ...config.checkpoint,
        phase: "paused",
        runId: "internal-run",
        lastActivePhase: "generating",
        shotRuns: {
          "shot-1": {
            shotId: "shot-1",
            videoTaskId: "paid-task",
            qcStatus: "pending",
            retryCount: 0,
          },
        },
      },
    },
  },
};
const options = {
  restart: false,
  newKey: "restored-copy",
  position: { x: 300, y: 400 },
  occupiedKeys: new Set<string>(),
};

describe("restoring workflow history to the canvas", () => {
  it("restores a deleted node with its existing paid task and the same history identity", () => {
    const restored = restoreWorkflowHistoryNode(record, [], options);
    expect(restored.replace).toBe(false);
    expect(restored.node).toMatchObject({
      key: "original",
      x: 300,
      y: 400,
      config: {
        historyRunId: "history-run",
        materials,
        checkpoint: { runId: "internal-run", shotRuns: { "shot-1": { videoTaskId: "paid-task" } } },
      },
    });
  });
  it("updates matching input in place while preserving the node's current position", () => {
    const current = { ...record.nodeSnapshot, x: 99, y: 120 };
    const restored = restoreWorkflowHistoryNode(record, [current], {
      ...options,
      occupiedKeys: new Set([current.key]),
    });
    expect(restored).toMatchObject({ replace: true, node: { key: "original", x: 99, y: 120 } });
  });
  it.each([
    { brief: "已改成另一主题" },
    { historyRunId: "newer-run" },
    { materials: [] },
    { materials: [materials[1]!] },
    { materials: [...materials].reverse() },
    { materials: [{ ...materials[0]!, localPath: "C:\\references\\replacement.png" }] },
  ])(
    "preserves edited inputs and newer runs by creating a separate historical node: %j",
    (change) => {
      const current = {
        ...record.nodeSnapshot,
        config: { ...record.nodeSnapshot.config, ...change },
      };
      const restored = restoreWorkflowHistoryNode(record, [current], {
        ...options,
        occupiedKeys: new Set([current.key]),
      });
      expect(restored.replace).toBe(false);
      expect(restored.node.key).toBe("restored-copy");
      expect(restored.node.config.brief).toBe("解释复利");
      expect(restored.node.config.materials).toEqual(materials);
      expect(current.config).toMatchObject(change);
    },
  );
  it("starts a new run with archived inputs but no prior task identities", () => {
    const restored = restoreWorkflowHistoryNode(record, [record.nodeSnapshot], {
      ...options,
      restart: true,
    });
    expect(restored.replace).toBe(false);
    expect(restored.node.key).toBe("restored-copy");
    expect(restored.node.config.historyRunId).toBeUndefined();
    expect(restored.node.config.brief).toBe("解释复利");
    expect(restored.node.config.materials).toEqual(materials);
    expect(restored.node.config.checkpoint).toMatchObject({
      phase: "idle",
      runId: null,
      shotRuns: {},
    });
    expect(record.nodeSnapshot.config.checkpoint.shotRuns["shot-1"]?.videoTaskId).toBe("paid-task");
  });
});
