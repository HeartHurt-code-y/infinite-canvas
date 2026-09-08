import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CanvasDocumentClient, CanvasDocumentRecord } from "../../lib/backend";
import {
  ACTIVE_CANVAS_STORAGE_KEY,
  CANVAS_CATALOG_STORAGE_KEY,
  CANVAS_DOCUMENT_STORAGE_PREFIX,
  createCanvasDocumentRepository,
  isCanvasDocumentNotFound,
  readActiveCanvasId,
  writeActiveCanvasId,
} from "./canvasDocumentRepository";

function document(prompt: string, x = 0) {
  return {
    version: 2,
    genNodes: [{ key: `node-${prompt}`, prompt }],
    assetEdges: [],
    view: { pan: { x, y: 0 }, zoom: 100 },
    promptContents: {
      [`node-${prompt}`]: { version: 1, content: [{ type: "text", text: prompt }] },
    },
  };
}

function record(id: string, revision: number): CanvasDocumentRecord {
  return { id, title: id, document: document(id), revision, createdAt: 1, updatedAt: revision };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("browser canvas document repository", () => {
  it("persists independent documents, prompts, viewports and names across repository instances", async () => {
    const repository = createCanvasDocumentRepository({ isDesktop: () => false, now: () => 10 });
    await expect(repository.list()).resolves.toEqual([]);
    await repository.save({ id: "scene-a", title: "广告", document: document("商品", 280) });
    await repository.save({ id: "scene-b", title: "短剧", document: document("剧本", -140) });
    await repository.save({ id: "scene-a", title: "广告", document: document("新商品", 420) });

    const reopened = createCanvasDocumentRepository({ isDesktop: () => false });
    await expect(reopened.get("scene-a")).resolves.toMatchObject({
      title: "广告",
      document: document("新商品", 420),
      revision: 2,
      createdAt: 10,
    });
    await expect(reopened.get("scene-b")).resolves.toMatchObject({
      title: "短剧",
      document: document("剧本", -140),
      revision: 1,
    });
    const summaries = await reopened.list();
    expect(summaries.map(({ id, title, revision }) => ({ id, title, revision }))).toEqual([
      { id: "scene-a", title: "广告", revision: 2 },
      { id: "scene-b", title: "短剧", revision: 1 },
    ]);
    expect(summaries.every((summary) => !("document" in summary))).toBe(true);
  });

  it("distinguishes absent documents from damaged JSON and unsupported catalog versions", async () => {
    const repository = createCanvasDocumentRepository({ isDesktop: () => false });
    await expect(repository.get("missing")).rejects.toMatchObject({ kind: "not_found" });
    expect(isCanvasDocumentNotFound({ kind: "not_found" })).toBe(true);
    expect(isCanvasDocumentNotFound(new Error("database is unavailable"))).toBe(false);
    localStorage.setItem(`${CANVAS_DOCUMENT_STORAGE_PREFIX}broken`, "{");
    await expect(repository.get("broken")).rejects.toBeInstanceOf(SyntaxError);
    localStorage.setItem(CANVAS_CATALOG_STORAGE_KEY, JSON.stringify({ version: 9, items: [] }));
    await expect(repository.list()).rejects.toThrow();
  });

  it("rejects documents stored under another canvas identity", async () => {
    const repository = createCanvasDocumentRepository({ isDesktop: () => false });
    localStorage.setItem(
      `${CANVAS_DOCUMENT_STORAGE_PREFIX}first`,
      JSON.stringify({ version: 1, record: record("second", 1) }),
    );
    await expect(repository.get("first")).rejects.toThrow("画布存档身份不一致");
  });

  it("renames the latest saved document while preserving all canvas content", async () => {
    const repository = createCanvasDocumentRepository({ isDesktop: () => false });
    const save = repository.save({ id: "a", title: "未命名", document: document("制作中", 90) });
    const rename = repository.rename("a", "产品宣传");
    await save;
    await expect(rename).resolves.toMatchObject({
      title: "产品宣传",
      document: document("制作中", 90),
      revision: 2,
    });
    await expect(repository.list()).resolves.toMatchObject([{ id: "a", title: "产品宣传" }]);
  });

  it("deletes only the chosen canvas and keeps it absent after reopening", async () => {
    const repository = createCanvasDocumentRepository({ isDesktop: () => false });
    await repository.save({ id: "a", title: "广告", document: document("产品") });
    await repository.save({ id: "b", title: "短剧", document: document("剧本", 120) });
    await repository.delete("a");
    await repository.delete("a");
    await repository.delete("missing");

    const reopened = createCanvasDocumentRepository({ isDesktop: () => false });
    await expect(reopened.get("a")).rejects.toMatchObject({ kind: "not_found" });
    await expect(reopened.list()).resolves.toMatchObject([{ id: "b", title: "短剧" }]);
    await expect(reopened.get("b")).resolves.toMatchObject({ document: document("剧本", 120) });
    expect(localStorage.getItem(`${CANVAS_DOCUMENT_STORAGE_PREFIX}a`)).toBeNull();
  });

  it("allows deleting a damaged document without changing another canvas", async () => {
    const repository = createCanvasDocumentRepository({ isDesktop: () => false });
    await repository.save({ id: "a", title: "广告", document: document("产品") });
    await repository.save({ id: "b", title: "短剧", document: document("剧本") });
    localStorage.setItem(`${CANVAS_DOCUMENT_STORAGE_PREFIX}a`, "{");
    await expect(repository.delete("a")).resolves.toBeUndefined();
    await expect(repository.list()).resolves.toMatchObject([{ id: "b" }]);
    await expect(repository.get("a")).rejects.toMatchObject({ kind: "not_found" });
  });

  it("restores the document when catalog deletion fails and allows a save and deletion retry", async () => {
    const repository = createCanvasDocumentRepository({ isDesktop: () => false });
    await repository.save({ id: "a", title: "广告", document: document("产品") });
    const previousRaw = localStorage.getItem(`${CANVAS_DOCUMENT_STORAGE_PREFIX}a`);
    const failure = new DOMException("Storage is denied", "SecurityError");
    const originalSetItem = localStorage.setItem.bind(localStorage);
    const setItem = vi.spyOn(localStorage, "setItem").mockImplementation((key, value) => {
      if (key === CANVAS_CATALOG_STORAGE_KEY) throw failure;
      originalSetItem(key, value);
    });

    await expect(repository.delete("a")).rejects.toBe(failure);
    expect(localStorage.getItem(`${CANVAS_DOCUMENT_STORAGE_PREFIX}a`)).toBe(previousRaw);
    await expect(repository.list()).resolves.toMatchObject([{ id: "a", title: "广告" }]);
    setItem.mockRestore();
    await expect(
      repository.save({ id: "a", title: "新广告", document: document("修订") }),
    ).resolves.toMatchObject({ title: "新广告", revision: 2 });
    await repository.delete("a");
    await expect(repository.list()).resolves.toEqual([]);
  });

  it("keeps the catalog and document when removing the document fails", async () => {
    const repository = createCanvasDocumentRepository({ isDesktop: () => false });
    await repository.save({ id: "a", title: "广告", document: document("产品") });
    const failure = new DOMException("Storage is denied", "SecurityError");
    vi.spyOn(localStorage, "removeItem").mockImplementation(() => {
      throw failure;
    });
    await expect(repository.delete("a")).rejects.toBe(failure);
    await expect(repository.get("a")).resolves.toMatchObject({ document: document("产品") });
    await expect(repository.list()).resolves.toMatchObject([{ id: "a", title: "广告" }]);
  });

  it("does not remove a document when its catalog cannot be read", async () => {
    const repository = createCanvasDocumentRepository({ isDesktop: () => false });
    await repository.save({ id: "a", title: "广告", document: document("产品") });
    const previousRaw = localStorage.getItem(`${CANVAS_DOCUMENT_STORAGE_PREFIX}a`);
    localStorage.setItem(CANVAS_CATALOG_STORAGE_KEY, "{");
    await expect(repository.delete("a")).rejects.toBeInstanceOf(SyntaxError);
    expect(localStorage.getItem(`${CANVAS_DOCUMENT_STORAGE_PREFIX}a`)).toBe(previousRaw);
  });

  it("keeps the previous document and surfaces the original quota error when catalog save fails", async () => {
    const repository = createCanvasDocumentRepository({ isDesktop: () => false });
    await repository.save({ id: "a", title: "旧标题", document: document("原稿") });
    const quotaError = new DOMException("Storage quota exceeded", "QuotaExceededError");
    const originalSetItem = localStorage.setItem.bind(localStorage);
    vi.spyOn(localStorage, "setItem").mockImplementation((key, value) => {
      if (key === CANVAS_CATALOG_STORAGE_KEY) throw quotaError;
      originalSetItem(key, value);
    });

    await expect(
      repository.save({ id: "a", title: "新标题", document: document("修订") }),
    ).rejects.toBe(quotaError);
    await expect(repository.get("a")).resolves.toMatchObject({ title: "旧标题", revision: 1 });
    await expect(repository.list()).resolves.toMatchObject([{ title: "旧标题", revision: 1 }]);
    await expect(
      repository.save({ id: "b", title: "新画布", document: document("新稿") }),
    ).rejects.toBe(quotaError);
    await expect(repository.get("b")).rejects.toMatchObject({ kind: "not_found" });
  });

  it("preserves storage access failures and rejects stale revision saves", async () => {
    const denied = new DOMException("Storage is denied", "SecurityError");
    const blockedRepository = createCanvasDocumentRepository({
      isDesktop: () => false,
      storage: () => {
        throw denied;
      },
    });
    await expect(blockedRepository.list()).rejects.toBe(denied);
    await expect(blockedRepository.get("a")).rejects.toBe(denied);
    await expect(
      blockedRepository.save({ id: "a", title: "a", document: document("a") }),
    ).rejects.toBe(denied);

    const repository = createCanvasDocumentRepository({ isDesktop: () => false });
    await repository.save({ id: "a", title: "a", document: document("原稿") });
    await expect(
      repository.save({ id: "a", title: "a", document: document("过期"), expectedRevision: 0 }),
    ).rejects.toThrow("画布保存版本冲突");
    await expect(repository.get("a")).resolves.toMatchObject({ document: document("原稿") });
  });

  it("remembers the chosen canvas without altering its document", () => {
    expect(readActiveCanvasId()).toBeNull();
    writeActiveCanvasId("scene-b");
    expect(readActiveCanvasId()).toBe("scene-b");
    expect(localStorage.getItem(ACTIVE_CANVAS_STORAGE_KEY)).toBe("scene-b");
  });
});

describe("desktop canvas document write ordering", () => {
  it("serializes one canvas, allows other canvases to save, and snapshots data before waiting", async () => {
    const firstWrite = deferred<CanvasDocumentRecord>();
    const client: CanvasDocumentClient = {
      list: vi.fn(() => Promise.resolve([])),
      delete: vi.fn(() => Promise.resolve()),
      get: vi.fn<CanvasDocumentClient["get"]>((id) => Promise.resolve(record(id, 2))),
      save: vi.fn<CanvasDocumentClient["save"]>((command) =>
        command.title === "first"
          ? firstWrite.promise
          : Promise.resolve({ ...record(command.id, 2), ...command }),
      ),
    };
    const repository = createCanvasDocumentRepository({
      isDesktop: () => true,
      desktopClient: client,
    });
    const first = repository.save({ id: "a", title: "first", document: document("first") });
    const mutableDocument = document("second");
    const second = repository.save({ id: "a", title: "second", document: mutableDocument });
    mutableDocument.view.pan.x = 900;
    const independent = repository.save({ id: "b", title: "other", document: document("other") });
    await independent;
    expect(client.save).toHaveBeenCalledTimes(2);
    expect(client.save).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: "b" }));
    firstWrite.resolve(record("a", 1));
    await Promise.all([first, second]);
    expect(client.save).toHaveBeenNthCalledWith(3, {
      id: "a",
      title: "second",
      document: document("second"),
    });
  });

  it("waits for pending writes before reading and listing", async () => {
    const write = deferred<CanvasDocumentRecord>();
    const saved = record("a", 1);
    const client: CanvasDocumentClient = {
      list: vi.fn(() => Promise.resolve([{ ...saved }])),
      delete: vi.fn(() => Promise.resolve()),
      get: vi.fn(() => Promise.resolve(saved)),
      save: vi.fn(() => write.promise),
    };
    const repository = createCanvasDocumentRepository({
      isDesktop: () => true,
      desktopClient: client,
    });
    const save = repository.save({ id: "a", title: "a", document: document("a") });
    const read = repository.get("a");
    const list = repository.list();
    await Promise.resolve();
    expect(client.get).not.toHaveBeenCalled();
    expect(client.list).not.toHaveBeenCalled();
    write.resolve(saved);
    await Promise.all([save, read, list]);
    expect(client.get).toHaveBeenCalledWith("a");
    expect(client.list).toHaveBeenCalledOnce();
  });

  it("surfaces a failed save and allows later saves to recover", async () => {
    const failure = new Error("database unavailable");
    const saveClient = vi.fn<CanvasDocumentClient["save"]>();
    saveClient.mockRejectedValueOnce(failure).mockResolvedValueOnce(record("a", 1));
    const repository = createCanvasDocumentRepository({
      isDesktop: () => true,
      desktopClient: {
        save: saveClient,
        delete: vi.fn(() => Promise.resolve()),
        get: vi.fn(() => Promise.resolve(record("a", 1))),
        list: vi.fn(() => Promise.resolve([])),
      },
    });
    const failed = repository.save({ id: "a", title: "a", document: document("旧") });
    const recovered = repository.save({ id: "a", title: "a", document: document("新") });
    await expect(failed).rejects.toBe(failure);
    await expect(recovered).resolves.toMatchObject({ id: "a", revision: 1 });
    expect(saveClient).toHaveBeenCalledTimes(2);
  });

  it("finishes previously queued saves and renames before deletion and blocks late writes", async () => {
    const firstWrite = deferred<CanvasDocumentRecord>();
    const deleteWrite = deferred<void>();
    const client: CanvasDocumentClient = {
      list: vi.fn(() => Promise.resolve([])),
      get: vi.fn(() => Promise.resolve(record("a", 2))),
      save: vi
        .fn<CanvasDocumentClient["save"]>()
        .mockReturnValueOnce(firstWrite.promise)
        .mockResolvedValue(record("a", 3)),
      delete: vi.fn(() => deleteWrite.promise),
    };
    const repository = createCanvasDocumentRepository({
      isDesktop: () => true,
      desktopClient: client,
    });
    const first = repository.save({ id: "a", title: "广告", document: document("产品") });
    const second = repository.save({ id: "a", title: "广告", document: document("修订") });
    const rename = repository.rename("a", "产品宣传");
    const deletion = repository.delete("a");
    expect(repository.delete("a")).toBe(deletion);
    await expect(
      repository.save({ id: "a", title: "过期", document: document("后台结果") }),
    ).rejects.toThrow("画布正在删除或已删除");
    await expect(repository.rename("a", "过期标题")).rejects.toThrow("画布正在删除或已删除");
    expect(client.delete).not.toHaveBeenCalled();
    firstWrite.resolve(record("a", 1));
    await Promise.all([first, second, rename]);
    expect(client.save).toHaveBeenCalledTimes(3);
    await vi.waitFor(() => expect(client.delete).toHaveBeenCalledWith("a"));
    await expect(
      repository.save({ id: "a", title: "过期", document: document("后台结果") }),
    ).rejects.toThrow("画布正在删除或已删除");
    deleteWrite.resolve();
    await deletion;
    await expect(repository.rename("a", "复活")).rejects.toThrow("画布正在删除或已删除");
    await expect(
      repository.save({ id: "a", title: "复活", document: document("后台结果") }),
    ).rejects.toThrow("画布正在删除或已删除");
    await repository.delete("a");
    expect(client.delete).toHaveBeenCalledOnce();
  });

  it("allows other canvases to save while deleting and permits retries after a deletion failure", async () => {
    const deleteWrite = deferred<void>();
    const failure = new Error("database unavailable");
    const client: CanvasDocumentClient = {
      list: vi.fn(() => Promise.resolve([])),
      get: vi.fn<CanvasDocumentClient["get"]>((id) => Promise.resolve(record(id, 1))),
      save: vi.fn<CanvasDocumentClient["save"]>((command) =>
        Promise.resolve(record(command.id, 2)),
      ),
      delete: vi
        .fn<CanvasDocumentClient["delete"]>()
        .mockReturnValueOnce(deleteWrite.promise)
        .mockResolvedValue(undefined),
    };
    const repository = createCanvasDocumentRepository({
      isDesktop: () => true,
      desktopClient: client,
    });
    const deletion = repository.delete("a");
    const rejected = expect(deletion).rejects.toBe(failure);
    await expect(
      repository.save({ id: "b", title: "短剧", document: document("剧本") }),
    ).resolves.toMatchObject({ id: "b" });
    deleteWrite.reject(failure);
    await rejected;
    await expect(repository.rename("a", "重命名")).resolves.toMatchObject({ id: "a" });
    await repository.delete("a");
    expect(client.delete).toHaveBeenCalledTimes(2);
  });
});
