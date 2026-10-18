// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { workflowHistoryClient } from "./workflowHistory";
import { initializeWorkflowVersions } from "../features/workspace/workflowVersionHistory";
import { createKnowledgeVideoWorkflowConfig } from "../features/workspace/workspaceModel";
import { encodeWorkflowVersionNode } from "./workflowVersionStorage";

afterEach(() => {
  delete (window as unknown as Record<string, unknown>)["__TAURI_INTERNALS__"];
});

const summary = {
  id: "history-run",
  canvasId: "canvas-1",
  sourceNodeId: "workflow-1",
  workflowKind: "knowledge",
  title: "已保存的知识视频",
  status: "paused",
  progress: 42,
  createdAt: 100,
  updatedAt: 200,
};

describe("workflow history list IPC", () => {
  it("accepts summaries without fetching or retaining recovery snapshots", async () => {
    const page = { items: [summary], nextCursor: "30" };
    const invoke = vi.fn(() => Promise.resolve(page));
    (window as unknown as Record<string, unknown>)["__TAURI_INTERNALS__"] = { invoke };

    await expect(workflowHistoryClient.list({ canvasId: "canvas-1", limit: 30 })).resolves.toEqual(
      page,
    );
    expect(invoke).toHaveBeenCalledExactlyOnceWith(
      "list_workflow_history",
      { query: { canvasId: "canvas-1", limit: 30 } },
      undefined,
    );
  });

  it("drops detail-only fields from a list response", async () => {
    const invoke = vi.fn(() =>
      Promise.resolve({
        items: [
          { ...summary, nodeSnapshot: { large: "snapshot" }, models: [], error: "raw error" },
        ],
        nextCursor: null,
      }),
    );
    (window as unknown as Record<string, unknown>)["__TAURI_INTERNALS__"] = { invoke };
    await expect(workflowHistoryClient.list({})).resolves.toEqual({
      items: [summary],
      nextCursor: null,
    });
  });

  it("validates summary fields and preserves database errors", async () => {
    const databaseError = { kind: "database", message: "database unavailable" };
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({ items: [{ ...summary, title: 123 }], nextCursor: null })
      .mockRejectedValueOnce(databaseError);
    (window as unknown as Record<string, unknown>)["__TAURI_INTERNALS__"] = { invoke };
    await expect(workflowHistoryClient.list({})).rejects.toThrow("工作流历史记录格式无效");
    await expect(workflowHistoryClient.list({})).rejects.toBe(databaseError);
  });

  it("loads the full snapshot through get and keeps it on save", async () => {
    const config = initializeWorkflowVersions({
      ...createKnowledgeVideoWorkflowConfig(
        {
          prompt: { providerId: "p", modelDefinitionId: "text" },
          image: { providerId: "p", modelDefinitionId: "image" },
          video: { providerId: "p", modelDefinitionId: "video" },
        },
        true,
      ),
      brief: "原始要求",
    });
    const record = {
      ...summary,
      message: "保留已提交任务",
      error: null,
      models: [],
      attemptCount: 2,
      revision: 7,
      nodeSnapshot: {
        key: summary.sourceNodeId,
        kind: "knowledge_video_workflow",
        x: 10,
        y: 20,
        config,
      },
    };
    const payload = { record, events: [], tasks: [] };
    const invoke = vi.fn().mockResolvedValueOnce(payload).mockResolvedValueOnce(record);
    (window as unknown as Record<string, unknown>)["__TAURI_INTERNALS__"] = { invoke };
    const detail = await workflowHistoryClient.get(summary.id);
    expect(detail).toEqual(payload);
    expect(invoke).toHaveBeenNthCalledWith(
      1,
      "get_workflow_history",
      { id: summary.id },
      undefined,
    );
    await expect(workflowHistoryClient.save({ record: detail.record })).resolves.toEqual(record);
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      "save_workflow_history",
      {
        command: {
          record: { ...record, nodeSnapshot: encodeWorkflowVersionNode(record.nodeSnapshot) },
        },
      },
      undefined,
    );
  });

  it("requires a recovery snapshot for details", async () => {
    const invoke = vi.fn(() => Promise.resolve({ record: summary, events: [], tasks: [] }));
    (window as unknown as Record<string, unknown>)["__TAURI_INTERNALS__"] = { invoke };
    await expect(workflowHistoryClient.get(summary.id)).rejects.toThrow("工作流历史记录格式无效");
  });
});
