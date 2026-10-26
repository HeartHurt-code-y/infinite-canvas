/**
 * 画布草稿：崩溃兜底。
 *
 * ## 要解决什么
 *
 * 自动保存有 1 秒防抖窗口（`CANVAS_SAVE_DEBOUNCE_MS`）。这 1 秒里用户敲的字
 * 只在内存里，**还没进 IPC**。此刻进程被杀掉（渲染进程 OOM、系统强杀、
 * 磁盘写满导致进程崩掉），这 1 秒的编辑就永远丢了 —— 而界面上还写着「已保存」，
 * 用户根本不知道自己丢了东西。
 *
 * `beforeunload` 兜不住这种场景：进程被 `SIGKILL` / OOM killer 带走时，
 * 页面根本来不及卸载，事件不会触发。即便是正常关窗，`beforeunload` 里的
 * `flushAll()` 也是 fire-and-forget 的异步 IPC，WebView 可能在往返完成前
 * 就被销毁了 —— 这条路本身也是不可靠的。
 *
 * ## 怎么做
 *
 * 每次编辑**同步**写一份草稿到 `localStorage`（同源、进程无关、崩溃后仍在）。
 * `localStorage.setItem` 是同步的，写完即落盘 —— 这正是崩溃场景需要的性质。
 * 正常保存成功后删掉草稿。
 *
 * 重启时：如果草稿比存档里的 `updatedAt` 更新，说明上次是**崩了**而不是
 * 正常关闭（正常关闭会先 flush 再删草稿），此时把草稿恢复出来，并明确告诉
 * 用户「上次未保存的改动已恢复」。
 *
 * ## 为什么不用 IndexedDB
 *
 * IndexedDB 是异步的，崩溃时正在进行的写入一样会丢；而我们要的恰恰是
 * 「写完即持久」。`localStorage` 的同步语义在这里是优点不是缺点。
 *
 * ## 容量
 *
 * `localStorage` 一般只有 5 MiB。画布文档可能很大（大量节点 + 提示词 + 素材引用），
 * 所以写之前先估大小：超限就**不写草稿**（退化成旧行为），并记一条日志 ——
 * 宁可少一层兜底，也不能因为草稿写不下而让正常保存失败。
 */

/** 草稿的存储键前缀；后跟画布 id。 */
const DRAFT_KEY_PREFIX = "infinite-canvas:documents:v1:draft:";

/**
 * 草稿的体积上限（字符数）。
 *
 * `localStorage` 通常按 UTF-16 字符串长度计（多数实现是 2 字节/字符），
 * 5 MiB 的配额大约对应 2.5M 字符。留一半余量给同源其它键（画布目录、活跃画布等）。
 */
const MAX_DRAFT_CHARS = 1_200_000;

export interface CanvasDraft {
  /** 草稿写入时刻（毫秒）。与存档的 `updatedAt` 比较即可判断谁更新。 */
  readonly writtenAt: number;
  /** 画布标题；崩溃后标题可能刚被改过，一并带上。 */
  readonly title: string;
  /** 画布文档快照（结构与存档里的 `document` 相同）。 */
  readonly document: unknown;
}

function draftKey(canvasId: string): string {
  return `${DRAFT_KEY_PREFIX}${canvasId}`;
}

/**
 * 写草稿。返回是否真的写进去了。
 *
 * 任何失败（配额满、序列化异常、隐私模式禁写）都**吞掉**：草稿是兜底，
 * 兜底失败绝不能影响正常保存。
 */
export function writeCanvasDraft(
  canvasId: string,
  title: string,
  document: unknown,
  now = Date.now(),
): boolean {
  try {
    const payload: CanvasDraft = { writtenAt: now, title, document };
    const serialized = JSON.stringify(payload);
    if (serialized.length > MAX_DRAFT_CHARS) {
      // 文档太大，localStorage 放不下：跳过草稿（正常保存照常）。
      removeCanvasDraft(canvasId);
      return false;
    }
    window.localStorage.setItem(draftKey(canvasId), serialized);
    return true;
  } catch {
    return false;
  }
}

/** 读草稿；没有、损坏或不是对象都当作「没有草稿」。 */
export function readCanvasDraft(canvasId: string): CanvasDraft | null {
  try {
    const raw = window.localStorage.getItem(draftKey(canvasId));
    if (raw == null) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const draft = parsed as Partial<CanvasDraft>;
    if (typeof draft.writtenAt !== "number" || !Number.isFinite(draft.writtenAt)) return null;
    if (typeof draft.title !== "string") return null;
    if (draft.document == null) return null;
    return { writtenAt: draft.writtenAt, title: draft.title, document: draft.document };
  } catch {
    return null;
  }
}

/** 删草稿（正常保存成功后调用）。 */
export function removeCanvasDraft(canvasId: string): void {
  try {
    window.localStorage.removeItem(draftKey(canvasId));
  } catch {
    // 删不掉就算了：草稿只是兜底，下次启动时若草稿比存档旧就不会被采用。
  }
}

/**
 * 删掉**所有**画布的草稿。
 *
 * ## 为什么要这个
 *
 * `localStorage` 的配额是**同源共享**的，而草稿与画布存档、画布目录挤在同一个
 * 存储空间里。浏览器 fallback 路径（`canvasDocumentRepository.saveDirect`）把
 * 画布文档与目录都写在 localStorage 里 —— 草稿占满配额，目录就写不进去，
 * 而那一步失败会**让整次画布保存失败**。
 *
 * 也就是说：一个本来只是「兜底」的草稿，能把「保存成功」这件最要紧的事挤掉。
 * 这不能发生。
 *
 * 所以在保存因配额失败时，先把草稿全清掉腾出空间再重试一次。草稿是可丢弃的
 * 兜底，画布存档不是 —— 丢草稿永远比丢存档好。
 */
export function removeAllCanvasDrafts(): void {
  try {
    const storage = window.localStorage;
    // 从后往前删：removeItem 会改变下标。
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key != null && key.startsWith(DRAFT_KEY_PREFIX)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    // 清不掉就只能靠保存失败时的提示了。
  }
}

/**
 * 草稿是否比存档更新 —— 即「上次是崩了而不是正常关闭」。
 *
 * 正常关闭的顺序是：flush（写存档）→ 删草稿。所以正常关闭后不该有草稿；
 * 有草稿说明 flush 没跑完（崩溃 / 强杀 / 磁盘写失败）。
 *
 * 另外要求草稿严格新于存档：万一存档比草稿还新（正常保存成功但删草稿失败），
 * 那份草稿是过期内容，不能拿来覆盖更新的存档。
 */
export function isDraftNewerThan(
  draft: CanvasDraft,
  storedUpdatedAt: number | null | undefined,
): boolean {
  if (storedUpdatedAt == null || !Number.isFinite(storedUpdatedAt)) return true;
  return draft.writtenAt > storedUpdatedAt;
}
