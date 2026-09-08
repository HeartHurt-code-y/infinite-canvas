import { afterEach, describe, expect, it, vi } from "vitest";

import { BackendContractError, canvasDocumentClient } from "./backend";

afterEach(() => {
  delete (window as unknown as Record<string, unknown>)["__TAURI_INTERNALS__"];
});

describe("canvas document list IPC", () => {
  it("loads the desktop catalog with summary contract validation", async () => {
    const summaries = [
      { id: "canvas-scene-03", title: "画布 1", revision: 3, createdAt: 1, updatedAt: 2 },
      { id: "canvas-new", title: "广告", revision: 1, createdAt: 2, updatedAt: 2 },
    ];
    const invoke = vi.fn(() => Promise.resolve(summaries));
    (window as unknown as Record<string, unknown>)["__TAURI_INTERNALS__"] = { invoke };
    await expect(canvasDocumentClient.list()).resolves.toEqual(summaries);
    expect(invoke).toHaveBeenCalledWith("list_canvas_documents", {}, undefined);
  });

  it("rejects invalid catalog data without disguising invocation errors", async () => {
    const invoke = vi.fn<() => Promise<unknown>>();
    invoke.mockResolvedValueOnce([{ id: "a", title: "a", revision: "bad" }]);
    const databaseError = { kind: "database", message: "database unavailable" };
    invoke.mockRejectedValueOnce(databaseError);
    (window as unknown as Record<string, unknown>)["__TAURI_INTERNALS__"] = { invoke };
    await expect(canvasDocumentClient.list()).rejects.toBeInstanceOf(BackendContractError);
    await expect(canvasDocumentClient.list()).rejects.toBe(databaseError);
  });
});
