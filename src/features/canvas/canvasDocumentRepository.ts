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
import { removeAllCanvasDrafts } from "./canvasDocumentDraft";

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

/**
 * 这个存储错误是不是「配额满了」。
 *
 * 各浏览器/WebView 的报错形态不完全一致：DOM 规范里是
 * `DOMException` 且 `name === "QuotaExceededError"`，但也有实现只给一个
 * message（老 IE 系的 "QuotaExceededError" 字符串）。两种都认。
 *
 * 认错的后果是「该清草稿时没清」（多一次失败）或「不该清时清了」
 * （丢掉崩溃兜底）—— 后者更可惜，所以判据要**宁可宽一点**：只要错误文本里
 * 提到 quota / 存储空间 / 配额，就按配额满处理。
 */
function isStorageQuotaError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const name = "name" in error ? String((error as { name?: unknown }).name ?? "") : "";
  if (name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED") return true;
  const message = "message" in error ? String((error as { message?: unknown }).message ?? "") : "";
  return /quota|配额|存储空间|storage (?:is )?full/i.test(message);
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
  /*
   * 本模块已知的画布存档版本号。
   *
   * 由这里统一持有、而不是让调用方各自记一份：重命名走的是同一条 saveDirect
   * 路径、同样会推进 revision，若调用方各记一份，重命名后的下一次保存就会
   * 带着过期的版本号 → 被后端判成版本冲突（正常编辑被误报冲突）。
   *
   * 多实例（同时跑打包版与 debug 版）是两个进程、两个进程各自的这份记录，
   * 因此真正的并发覆盖仍然能被检出。
   */
  const knownRevisions = new Map<string, number>();
  const deletions = new Map<string, Promise<void>>();
  /** 上一次保存撞上版本冲突的画布：下次提交前先读回远端当前版本号。 */
  const conflictRefreshNeeded = new Set<string>();

  /**
   * 判断一个报错是不是「版本冲突」。
   *
   * 桌面端后端用 `BackendError::Conflict`（kind = "conflict"），浏览器 fallback
   * 抛的是 `画布保存版本冲突：…`。两条都要认，否则桌面端会一直死锁在冲突里。
   */
  function isVersionConflict(error: unknown): boolean {
    const message =
      typeof error === "string"
        ? error
        : error != null && typeof error === "object"
          ? String((error as Record<string, unknown>)["message"] ?? "")
          : "";
    if (/版本冲突|已在别处被修改|changed since revision/i.test(message)) return true;
    const kind =
      error != null && typeof error === "object"
        ? (error as Record<string, unknown>)["kind"]
        : undefined;
    return kind === "conflict";
  }

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
    const runtimeDocument = command.document;
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
    /*
     * 写入画布存档与目录。
     *
     * `localStorage` 的配额是**同源共享**的，崩溃草稿也挤在同一个空间里。草稿占满
     * 配额 → 这里写不进去 → **整次画布保存失败**。一个只是兜底的草稿把「保存成功」
     * 这件最要紧的事挤掉，不能发生。
     *
     * 所以：配额错误时先把所有草稿清掉腾出空间，再重试一次。草稿是可丢弃的兜底，
     * 画布存档不是 —— 丢草稿永远比丢存档好。
     */
    const commit = () => {
      storage.setItem(key, JSON.stringify({ version: 1, record }));
      storage.setItem(CANVAS_CATALOG_STORAGE_KEY, JSON.stringify({ version: 1, items }));
    };
    try {
      commit();
    } catch (error) {
      if (!isStorageQuotaError(error)) {
        // Keep the prior document when the catalog cannot be committed.
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
      // 配额满：清掉所有崩溃草稿再试一次。
      removeAllCanvasDrafts();
      try {
        commit();
      } catch (retryError) {
        try {
          if (previousRaw === null) storage.removeItem(key);
          else storage.setItem(key, previousRaw);
        } catch (rollbackError) {
          throw new AggregateError(
            [error, retryError, rollbackError],
            "画布目录保存失败（存储空间不足），原存档恢复也失败。",
            { cause: rollbackError },
          );
        }
        throw retryError;
      }
    }
    return { ...record, document: runtimeDocument };
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
      const record = await getDirect(canvasId);
      /*
       * 版本号只**前进**，不回退。
       *
       * `get()` 只 await 了「调用时刻」的队列尾，随后读盘。若这期间有一次 save
       * 刚好把磁盘版本推进到 N+1（并已把 knownRevisions 更新为 N+1），这里再把
       * 读到的旧版本 N 写回去 → 下一次 save 带 expectedRevision=N 对上磁盘 N+1
       * → 后端判成冲突 → **正常编辑被误报「画布已在别处被修改」**，
       * 正是版本号机制要消灭的现象。
       */
      const known = knownRevisions.get(canvasId);
      if (known == null || record.revision > known) {
        knownRevisions.set(canvasId, record.revision);
      }
      return record;
    },
    async save(command) {
      if (deletions.has(command.id)) throw deletedError(command.id);
      // Capture the JSON at call time; edits made while another write is pending belong to a later save.
      // 文档是纯 JSON 数据，structuredClone 比 JSON 往返快数倍。
      const snapshot = structuredClone(command);
      return await enqueue(command.id, async () => {
        /*
         * 带版本号保存。桌面端后端本来就有 revision 的乐观并发检查
         * （expected_revision），浏览器 fallback 路径也有（saveDirect 里比对
         * expectedRevision）——只有桌面端的普通保存一直没传，于是同一张画布被
         * 两个实例同时打开时会**整份互相覆盖**，丢掉一整份节点、连线、提示词与
         * @引用绑定。
         */
        /*
         * 上一次保存撞上版本冲突后，knownRevisions 还是**过期**的那个版本号
         * → 再保存必然再冲突 → 用户永远存不进去（界面上只有「重试保存」，
         * 重试带同一个过期版本号 → 同样的冲突、白跑一趟）。
         *
         * 所以这里在冲突之后先把远端当前版本读回来：下一次提交就用**正确的**
         * 最新版本号，冲突自然解开（代价是以本窗口的内容为准覆盖远端 ——
         * 这件事必须由用户知情，界面上的错误提示会写明）。
         */
        if (conflictRefreshNeeded.has(command.id)) {
          // getDirect 在桌面端返回 Promise、浏览器路径返回同步值，await 两者都成立。
          const remote = await getDirect(command.id);
          knownRevisions.set(command.id, remote.revision);
          conflictRefreshNeeded.delete(command.id);
        }
        const known = knownRevisions.get(command.id);
        const withRevision: SaveCanvasDocumentCommand =
          snapshot.expectedRevision != null || known == null
            ? snapshot
            : { ...snapshot, expectedRevision: known };
        try {
          const record = await saveDirect(withRevision);
          knownRevisions.set(command.id, record.revision);
          return record;
        } catch (error) {
          if (isVersionConflict(error)) conflictRefreshNeeded.add(command.id);
          throw error;
        }
      });
    },
    rename(canvasId, title) {
      if (deletions.has(canvasId)) return Promise.reject(deletedError(canvasId));
      return enqueue(canvasId, async () => {
        const current = await getDirect(canvasId);
        const record = await saveDirect({
          id: canvasId,
          title,
          document: current.document,
          expectedRevision: current.revision,
        });
        knownRevisions.set(canvasId, record.revision);
        return record;
      });
    },
    delete(canvasId) {
      const existing = deletions.get(canvasId);
      if (existing) return existing;
      const deletion = enqueue(canvasId, async () => {
        await deleteDirect(canvasId);
        knownRevisions.delete(canvasId);
      }).catch((error: unknown) => {
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
