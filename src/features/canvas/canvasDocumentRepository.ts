import * as v from "valibot";

import {
  canvasDocumentClient,
  isDesktopRuntime,
  type CanvasDocumentClient,
  type CanvasDocumentRecord,
  type CanvasDocumentSummary,
  type SaveCanvasDocumentCommand,
} from "../../lib/backend";
import {
  canvasDocumentRecordSchema,
  canvasDocumentSummariesSchema,
} from "../../lib/backendSchemas";

export const CANVAS_CATALOG_STORAGE_KEY = "infinite-canvas:documents:v1:catalog";
export const CANVAS_DOCUMENT_STORAGE_PREFIX = "infinite-canvas:documents:v1:document:";
export const ACTIVE_CANVAS_STORAGE_KEY = "infinite-canvas:active-canvas:v1";

const storedDocumentSchema = v.object({
  version: v.literal(1),
  record: canvasDocumentRecordSchema,
});
const storedCatalogSchema = v.object({
  version: v.literal(1),
  items: canvasDocumentSummariesSchema,
});

export interface CanvasDocumentRepository extends CanvasDocumentClient {
  rename(this: void, canvasId: string, title: string): Promise<CanvasDocumentRecord>;
}

interface CanvasRepositoryOptions {
  readonly desktopClient?: CanvasDocumentClient;
  readonly isDesktop?: () => boolean;
  readonly storage?: () => Storage;
  readonly now?: () => number;
}

class CanvasDocumentNotFoundError extends Error {
  readonly kind = "not_found";

  constructor(canvasId: string) {
    super(`找不到画布：${canvasId}`);
    this.name = "CanvasDocumentNotFoundError";
  }
}

export function isCanvasDocumentNotFound(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "kind" in error && error.kind === "not_found"
  );
}

export function readActiveCanvasId(): string | null {
  return window.localStorage.getItem(ACTIVE_CANVAS_STORAGE_KEY);
}

export function writeActiveCanvasId(canvasId: string): void {
  window.localStorage.setItem(ACTIVE_CANVAS_STORAGE_KEY, canvasId);
}

function documentKey(canvasId: string): string {
  return `${CANVAS_DOCUMENT_STORAGE_PREFIX}${encodeURIComponent(canvasId)}`;
}

function summaryOf(record: CanvasDocumentRecord): CanvasDocumentSummary {
  return {
    id: record.id,
    title: record.title,
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** Shared by mounted canvas sessions so each document's writes retain invocation order. */
export function createCanvasDocumentRepository(
  options: CanvasRepositoryOptions = {},
): CanvasDocumentRepository {
  const client = options.desktopClient ?? canvasDocumentClient;
  const desktop = options.isDesktop ?? isDesktopRuntime;
  const getStorage = options.storage ?? (() => window.localStorage);
  const now = options.now ?? Date.now;
  const pending = new Map<string, Promise<void>>();
  const deletions = new Map<string, Promise<void>>();

  function enqueue<T>(canvasId: string, operation: () => Promise<T> | T): Promise<T> {
    const result = (pending.get(canvasId) ?? Promise.resolve()).then(operation);
    // Recover only the queue tail. The returned operation promise keeps its exact error.
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    pending.set(canvasId, tail);
    void tail.then(() => {
      if (pending.get(canvasId) === tail) pending.delete(canvasId);
    });
    return result;
  }

  function browserList(storage: Storage): readonly CanvasDocumentSummary[] {
    const raw = storage.getItem(CANVAS_CATALOG_STORAGE_KEY);
    return raw === null ? [] : v.parse(storedCatalogSchema, JSON.parse(raw) as unknown).items;
  }

  function browserGet(storage: Storage, canvasId: string): CanvasDocumentRecord {
    const raw = storage.getItem(documentKey(canvasId));
    if (raw === null) throw new CanvasDocumentNotFoundError(canvasId);
    const { record } = v.parse(storedDocumentSchema, JSON.parse(raw) as unknown);
    if (record.id !== canvasId) throw new Error(`画布存档身份不一致：${canvasId}`);
    return record;
  }

  function getDirect(canvasId: string): Promise<CanvasDocumentRecord> | CanvasDocumentRecord {
    return desktop() ? client.get(canvasId) : browserGet(getStorage(), canvasId);
  }

  function saveDirect(
    command: SaveCanvasDocumentCommand,
  ): Promise<CanvasDocumentRecord> | CanvasDocumentRecord {
    if (desktop()) return client.save(command);
    const storage = getStorage();
    const key = documentKey(command.id);
    const previousRaw = storage.getItem(key);
    const previous = previousRaw === null ? null : browserGet(storage, command.id);
    const currentRevision = previous?.revision ?? 0;
    if (command.expectedRevision != null && command.expectedRevision !== currentRevision) {
      throw new Error(`画布保存版本冲突：${command.id}，当前版本 ${currentRevision}`);
    }
    const timestamp = now();
    const record: CanvasDocumentRecord = {
      id: command.id,
      title: command.title,
      document: command.document,
      revision: currentRevision + 1,
      createdAt: previous?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    const catalog = browserList(storage);
    const items = [...catalog.filter((item) => item.id !== command.id), summaryOf(record)].sort(
      (left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id),
    );
    storage.setItem(key, JSON.stringify({ version: 1, record }));
    try {
      storage.setItem(CANVAS_CATALOG_STORAGE_KEY, JSON.stringify({ version: 1, items }));
    } catch (error) {
      // Keep the prior document when the catalog cannot be committed (for example quota exceeded).
      try {
        if (previousRaw === null) storage.removeItem(key);
        else storage.setItem(key, previousRaw);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "画布目录保存失败，原存档恢复也失败。", {
          cause: rollbackError,
        });
      }
      throw error;
    }
    return record;
  }

  function deleteDirect(canvasId: string): Promise<void> | void {
    if (desktop()) return client.delete(canvasId);
    const storage = getStorage();
    const key = documentKey(canvasId);
    const previousRaw = storage.getItem(key);
    const catalog = browserList(storage);
    const items = catalog.filter((item) => item.id !== canvasId);
    // Read the raw record so a damaged document can still be explicitly removed.
    storage.removeItem(key);
    if (items.length === catalog.length) return;
    try {
      storage.setItem(CANVAS_CATALOG_STORAGE_KEY, JSON.stringify({ version: 1, items }));
    } catch (error) {
      try {
        if (previousRaw !== null) storage.setItem(key, previousRaw);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "画布删除失败，原存档恢复也失败。", {
          cause: rollbackError,
        });
      }
      throw error;
    }
  }

  function deletedError(canvasId: string): Error {
    return new Error(`画布正在删除或已删除，无法保存：${canvasId}`);
  }

  return {
    async list() {
      await Promise.all(pending.values());
      return desktop() ? client.list() : browserList(getStorage());
    },
    async get(canvasId) {
      await pending.get(canvasId);
      return getDirect(canvasId);
    },
    async save(command) {
      if (deletions.has(command.id)) throw deletedError(command.id);
      // Capture the JSON at call time; edits made while another write is pending belong to a later save.
      const snapshot = JSON.parse(JSON.stringify(command)) as SaveCanvasDocumentCommand;
      return await enqueue(command.id, () => saveDirect(snapshot));
    },
    rename(canvasId, title) {
      if (deletions.has(canvasId)) return Promise.reject(deletedError(canvasId));
      return enqueue(canvasId, async () => {
        const current = await getDirect(canvasId);
        return saveDirect({
          id: canvasId,
          title,
          document: current.document,
          expectedRevision: current.revision,
        });
      });
    },
    delete(canvasId) {
      const existing = deletions.get(canvasId);
      if (existing) return existing;
      const deletion = enqueue(canvasId, () => deleteDirect(canvasId)).catch((error: unknown) => {
        // A failed deletion retains the document and must allow saving and retrying it.
        if (deletions.get(canvasId) === deletion) deletions.delete(canvasId);
        throw error;
      });
      // Set before the queued operation starts, including while earlier saves are pending.
      deletions.set(canvasId, deletion);
      return deletion;
    },
  };
}

export const canvasDocumentRepository = createCanvasDocumentRepository();
