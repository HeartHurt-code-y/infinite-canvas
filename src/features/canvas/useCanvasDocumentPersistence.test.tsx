import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CanvasDocumentRecord } from "../../lib/backend";
import { CANVAS_SAVE_DEBOUNCE_MS } from "../workspace/workspaceModel";
import { canvasDocumentRepository } from "./canvasDocumentRepository";
import { createCanvasState, type CanvasDocumentV2 } from "./canvasStore";
import {
  useCanvasDocumentPersistence,
  type CanvasSessionHandle,
  type CanvasSessionServices,
} from "./useCanvasDocumentPersistence";

function savedRecord(document: CanvasDocumentV2): CanvasDocumentRecord {
  return { id: "scene-a", title: "商品摄影", document, revision: 3, createdAt: 1, updatedAt: 3 };
}

function sessionServices() {
  const handles = new Map<string, CanvasSessionHandle>();
  const services: CanvasSessionServices = {
    register: (id, handle) => {
      handles.set(id, handle);
      return () => {
        handles.delete(id);
      };
    },
    getTitle: () => "商品摄影",
    titleLoaded: vi.fn(),
    recoverWorkflowHistory: () => Promise.resolve(0),
  };
  return { handles, services };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useCanvasDocumentPersistence save safety", () => {
  it("does not overwrite an unreadable document and allows the host to flush and leave it", async () => {
    vi.spyOn(canvasDocumentRepository, "get").mockRejectedValue(
      new Error("SQLite 读取失败：database locked"),
    );
    const save = vi.spyOn(canvasDocumentRepository, "save");
    const collect = vi.fn(() => createCanvasState(74).commands.snapshotV2({}));
    const restore = vi.fn();
    const { handles, services } = sessionServices();
    const { result, unmount } = renderHook(() =>
      useCanvasDocumentPersistence({
        canvasId: "scene-a",
        collect,
        restore,
        services,
      }),
    );
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error).toContain("database locked");
    expect(result.current.hydrated).toBe(false);
    const session = handles.get("scene-a")!;
    expect(session.isReady()).toBe(false);

    await act(async () => {
      result.current.schedule();
      result.current.documentChanged();
      await expect(session.flush()).resolves.toBeUndefined();
    });
    unmount();
    expect(save).not.toHaveBeenCalled();
    expect(collect).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
    expect(handles.has("scene-a")).toBe(false);
  });

  it("retries a failed read and restores the original document before permitting saves", async () => {
    const document = createCanvasState(91).commands.snapshotV2({});
    const get = vi
      .spyOn(canvasDocumentRepository, "get")
      .mockRejectedValueOnce(new Error("存档暂时无法读取"))
      .mockResolvedValueOnce(savedRecord(document));
    const save = vi.spyOn(canvasDocumentRepository, "save");
    const restore = vi.fn();
    const { handles, services } = sessionServices();
    const { result } = renderHook(() =>
      useCanvasDocumentPersistence({
        canvasId: "scene-a",
        collect: () => document,
        restore,
        services,
      }),
    );
    await waitFor(() => expect(result.current.status).toBe("error"));
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(get).toHaveBeenCalledTimes(2);
    expect(restore).toHaveBeenCalledExactlyOnceWith(document);
    expect(services.titleLoaded).toHaveBeenCalledExactlyOnceWith("scene-a", "商品摄影");
    expect(handles.get("scene-a")!.isReady()).toBe(true);
    expect(result.current.error).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  it("surfaces an autosave failure and retries using the latest document", async () => {
    let document = createCanvasState(74).commands.snapshotV2({});
    vi.spyOn(canvasDocumentRepository, "get").mockResolvedValue(savedRecord(document));
    const save = vi
      .spyOn(canvasDocumentRepository, "save")
      .mockRejectedValueOnce(new Error("磁盘空间不足，画布保存失败"))
      .mockImplementation((command) => Promise.resolve({ ...savedRecord(document), ...command }));
    const restore = vi.fn();
    const { services } = sessionServices();
    const { result } = renderHook(() =>
      useCanvasDocumentPersistence({
        canvasId: "scene-a",
        collect: () => document,
        restore,
        services,
      }),
    );
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    vi.useFakeTimers();
    act(() => result.current.schedule());
    expect(result.current.status).toBe("pending");
    await act(() => vi.advanceTimersByTimeAsync(CANVAS_SAVE_DEBOUNCE_MS));
    expect(result.current.status).toBe("error");
    expect(result.current.error).toContain("磁盘空间不足");
    expect(result.current.hydrated).toBe(true);

    document = { ...document, view: { zoom: 125, pan: { x: 420, y: -160 } } };
    await act(async () => {
      result.current.retry();
      await Promise.resolve();
    });
    expect(save).toHaveBeenLastCalledWith({ id: "scene-a", title: "商品摄影", document });
    expect(result.current.status).toBe("saved");
    expect(result.current.error).toBeNull();
  });

  it("rejects a failed explicit flush so the host can keep the current canvas open", async () => {
    const document = createCanvasState(74).commands.snapshotV2({});
    vi.spyOn(canvasDocumentRepository, "get").mockResolvedValue(savedRecord(document));
    const failure = new Error("磁盘拒绝写入");
    vi.spyOn(canvasDocumentRepository, "save").mockRejectedValue(failure);
    const restore = vi.fn();
    const { handles, services } = sessionServices();
    const { result } = renderHook(() =>
      useCanvasDocumentPersistence({
        canvasId: "scene-a",
        collect: () => document,
        restore,
        services,
      }),
    );
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    await act(async () => {
      await expect(handles.get("scene-a")!.flush()).rejects.toBe(failure);
    });
    expect(result.current.status).toBe("error");
    expect(result.current.error).toContain("磁盘拒绝写入");
  });
});
