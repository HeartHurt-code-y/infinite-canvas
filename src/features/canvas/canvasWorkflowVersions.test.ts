// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { createCanvasState, type CanvasStateModule } from "./canvasStore";
import { createCanvasDocumentRepository } from "./canvasDocumentRepository";
import {
  createKnowledgeVideoWorkflowConfig,
  type KnowledgeVideoWorkflowNodeData,
} from "../workspace/workspaceModel";
import {
  redoWorkflowVersion,
  restoreWorkflowVersion,
  undoWorkflowVersion,
} from "../workspace/workflowVersionHistory";
import {
  approveWorkflowExecutionPlan,
  createWorkflowExecutionPlan,
  isWorkflowExecutionPlanApproved,
} from "../workspace/workflowExecutionPlan";

const workflow = (key: string): KnowledgeVideoWorkflowNodeData => ({
  key,
  kind: "knowledge_video_workflow",
  x: 0,
  y: 0,
  config: {
    ...createKnowledgeVideoWorkflowConfig(
      {
        prompt: { providerId: "provider", modelDefinitionId: "text" },
        image: { providerId: "provider", modelDefinitionId: "image" },
        video: { providerId: "provider", modelDefinitionId: "video" },
      },
      true,
    ),
    brief: "原稿",
  },
});
const read = (canvas: CanvasStateModule, key = "one") =>
  canvas.getSnapshot().nodeByKey.knowledgeVideoWorkflow.get(key)!;
const edit = (canvas: CanvasStateModule, key: string, brief: string) =>
  canvas.commands.patchNode("knowledgeVideoWorkflow", key, (node) => ({
    ...node,
    config: { ...node.config, brief },
  }));
const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));
afterEach(() => localStorage.clear());

describe("workflow versions inside the ordinary canvas store", () => {
  it("protects active workflow inputs while canvas undo and redo still change layout and ordinary nodes", async () => {
    const canvas = createCanvasState();
    canvas.commands.addNode("knowledgeVideoWorkflow", workflow("one"));
    canvas.commands.addNode("gen", {
      key: "image",
      kind: "image",
      x: 0,
      y: 0,
      config: {
        modelSelection: { providerId: "provider", modelDefinitionId: "image" },
        generationCount: 1,
        parameterValues: {},
        catalogResolved: true,
      },
    });
    await flush();
    canvas.commands.patchNode("knowledgeVideoWorkflow", "one", (node) => ({
      ...node,
      x: 80,
      config: {
        ...node.config,
        brief: "当前执行稿",
        checkpoint: { ...node.config.checkpoint, phase: "awaiting_approval" },
      },
    }));
    canvas.commands.patchNode("gen", "image", (node) => ({ ...node, x: 100 }));
    await flush();
    const launchingConfig = read(canvas).config;
    const protectedKeys = new Set(["one"]);
    expect(canvas.commands.undo(protectedKeys)).toBe("applied");
    expect(read(canvas).config).toBe(launchingConfig);
    expect(read(canvas).x).toBe(0);
    expect(canvas.getSnapshot().nodes.gen.find((node) => node.key === "image")?.x).toBe(0);
    expect(canvas.commands.redo(protectedKeys)).toBe("applied");
    expect(read(canvas).config).toBe(launchingConfig);
    expect(read(canvas).x).toBe(80);
    expect(canvas.getSnapshot().nodes.gen.find((node) => node.key === "image")?.x).toBe(100);
    await flush();

    canvas.commands.patchNode("knowledgeVideoWorkflow", "one", (node) => ({
      ...node,
      config: {
        ...node.config,
        checkpoint: { ...node.config.checkpoint, phase: "generating", runId: "paid-run" },
      },
    }));
    await flush();
    const generatingConfig = read(canvas).config;
    // The phase fallback also protects zero-argument consumers and the original insertion.
    expect(canvas.commands.undo()).toBe("applied");
    expect(read(canvas).config).toBe(generatingConfig);
    expect(canvas.commands.undo()).toBe("applied");
    expect(canvas.commands.undo()).toBe("applied");
    expect(read(canvas).config).toBe(generatingConfig);
    expect(read(canvas).config.versionHistory?.versions).toHaveLength(2);
    expect(canvas.getSnapshot().nodeByKey.gen.has("image")).toBe(false);
  });

  it("keeps node histories independent and ignores normal canvas and runtime edits", () => {
    const canvas = createCanvasState();
    const first = workflow("one");
    const executionPlan = approveWorkflowExecutionPlan(createWorkflowExecutionPlan(first), first);
    canvas.commands.addNode("knowledgeVideoWorkflow", {
      ...first,
      config: { ...first.config, executionPlan },
    });
    canvas.commands.addNode("knowledgeVideoWorkflow", workflow("two"));
    expect(isWorkflowExecutionPlanApproved(executionPlan, read(canvas))).toBe(true);
    edit(canvas, "one", "第一工作流的新稿");
    expect(read(canvas).config.versionHistory?.versions).toHaveLength(2);
    expect(read(canvas, "two").config.versionHistory?.versions).toHaveLength(1);
    canvas.commands.applyNodeChanges([
      { type: "position", key: "one", position: { x: 90, y: 50 } },
    ]);
    canvas.commands.connect("one", "two");
    canvas.commands.setView({ zoom: 130, pan: { x: 10, y: 40 } });
    canvas.commands.patchNode("knowledgeVideoWorkflow", "two", (node) => ({
      ...node,
      config: {
        ...node.config,
        checkpoint: {
          ...node.config.checkpoint,
          phase: "generating",
          runId: "active-run",
          updatedAt: 42,
        },
      },
    }));
    expect(read(canvas).config.versionHistory?.versions).toHaveLength(2);
    expect(read(canvas, "two").config.versionHistory?.versions).toHaveLength(1);
    expect(canvas.commands.snapshotV2({})).not.toHaveProperty("versionHistory");
  });

  it("keeps both workflow branches through canvas undo, node deletion and repository reload", async () => {
    const canvas = createCanvasState();
    canvas.commands.addNode("knowledgeVideoWorkflow", workflow("one"));
    await flush();
    edit(canvas, "one", "第一稿");
    await flush();
    const branchRoot = read(canvas).config.versionHistory!.currentVersionId;
    edit(canvas, "one", "原来的第二稿");
    await flush();
    const oldTip = read(canvas).config.versionHistory!.currentVersionId;
    expect(canvas.commands.undo()).toBe("applied");
    expect(read(canvas).config.brief).toBe("第一稿");
    expect(read(canvas).config.versionHistory?.versions).toHaveLength(3);
    await flush();
    edit(canvas, "one", "另一条分支");
    await flush();
    const newTip = read(canvas).config.versionHistory!.currentVersionId;
    expect(read(canvas).config.versionHistory?.versions).toHaveLength(4);
    expect(
      read(canvas).config.versionHistory?.versions.find((version) => version.id === oldTip)
        ?.parentId,
    ).toBe(branchRoot);
    expect(
      read(canvas).config.versionHistory?.versions.find((version) => version.id === newTip)
        ?.parentId,
    ).toBe(branchRoot);
    canvas.commands.removeNode("one");
    await flush();
    canvas.commands.undo();
    expect(read(canvas).config.versionHistory?.versions).toHaveLength(4);
    const repository = createCanvasDocumentRepository({ isDesktop: () => false });
    await repository.save({
      id: "workflow-versions",
      title: "工作流版本",
      document: canvas.commands.snapshotV2({}),
    });
    const restored = createCanvasState();
    expect(
      restored.commands.restoreDocument((await repository.get("workflow-versions")).document).ok,
    ).toBe(true);
    expect(read(restored).config.versionHistory?.versions).toHaveLength(4);
    expect(read(restored).config.versionHistory?.currentVersionId).toBe(newTip);
    restored.commands.patchNode("knowledgeVideoWorkflow", "one", (node) => ({
      ...node,
      config: restoreWorkflowVersion(node.config, oldTip),
    }));
    expect(read(restored).config.brief).toBe("原来的第二稿");
    expect(read(restored).config.versionHistory?.versions).toHaveLength(4);
  });

  it("accepts workflow undo and redo navigation without appending duplicate versions or changing siblings", () => {
    const canvas = createCanvasState();
    canvas.commands.addNode("knowledgeVideoWorkflow", workflow("one"));
    canvas.commands.addNode("knowledgeVideoWorkflow", workflow("two"));
    edit(canvas, "one", "第一稿");
    edit(canvas, "one", "第二稿");
    const sibling = read(canvas, "two");
    canvas.commands.patchNode("knowledgeVideoWorkflow", "one", (node) => ({
      ...node,
      config: undoWorkflowVersion(node.config),
    }));
    expect(read(canvas).config.brief).toBe("第一稿");
    expect(read(canvas).config.versionHistory?.versions).toHaveLength(3);
    canvas.commands.patchNode("knowledgeVideoWorkflow", "one", (node) => ({
      ...node,
      config: redoWorkflowVersion(node.config),
    }));
    expect(read(canvas).config.brief).toBe("第二稿");
    expect(read(canvas).config.versionHistory?.versions).toHaveLength(3);
    expect(read(canvas, "two")).toBe(sibling);
  });
});
