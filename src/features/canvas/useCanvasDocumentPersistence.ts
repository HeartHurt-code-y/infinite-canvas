import { useCallback, useEffect, useRef, useState } from "react";
import { backendErrorMessage, formatRawBackendError, frontendLog } from "../../lib/backend";
import { CANVAS_DRAFT_DEBOUNCE_MS, CANVAS_SAVE_DEBOUNCE_MS } from "../workspace/workspaceModel";
import {
  isDraftNewerThan,
  readCanvasDraft,
  removeCanvasDraft,
  writeCanvasDraft,
} from "./canvasDocumentDraft";
import { canvasDocumentRepository, isCanvasDocumentNotFound } from "./canvasDocumentRepository";
import type { CanvasDocumentV2 } from "./canvasStore";

export interface CanvasSessionHandle {
  flush(title?: string): Promise<void>;
  isReady(): boolean;
  prepareDelete(): Promise<void>;
  resumeAfterDeleteFailure(): void;
}

export interface CanvasSessionServices {
  readonly register: (id: string, handle: CanvasSessionHandle) => () => void;
  readonly getTitle: (id: string) => string;
  readonly titleLoaded: (id: string, title: string) => void;
}

/** A session keeps its own collector, load guard and save timer even while its UI is hidden. */
export function useCanvasDocumentPersistence({
  canvasId,
  collect,
  restore,
  services,
  validateDelete,
  active = true,
}: {
  readonly canvasId: string;
  readonly collect: () => CanvasDocumentV2;
  readonly restore: (document: unknown) => void;
  readonly services: CanvasSessionServices;
  readonly validateDelete?: () => Promise<void>;
  /** 非活跃画布的 saving/saved/pending 状态不可见，跳过以免后台保存触发无谓重渲染。 */
  readonly active?: boolean;
}) {
  const [hydrated, setHydrated] = useState(false);
  const [status, setStatus] = useState<"loading" | "pending" | "saving" | "saved" | "error">(
    "loading",
  );
  const [error, setError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  /*
   * 最近一次**成功落盘**的时刻（毫秒）。
   *
   * 为什么界面必须显示它：「已保存」这三个字只说明「上次保存成功了」，
   * 不说明「内容有多新」。崩溃会丢掉防抖窗口（1 秒）内的编辑，磁盘上是旧版本，
   * 而界面照样显示「已保存」—— 用户无从判断眼前这份画布是 3 秒前存的还是
   * 3 天前存的。把时间戳摆出来，用户一眼就能看出「这个时间点之后我改过东西、
   * 但它没存上」。
   */
  const [savedAt, setSavedAt] = useState<number | null>(null);
  /*
   * 从崩溃草稿恢复的时刻；非 null 表示「上次未保存的改动已恢复」。
   * 界面要明确告诉用户这件事发生过 —— 静默恢复会让用户以为那些改动
   * 一直好好地存在（其实它们差点就丢了）。
   */
  const [recoveredAt, setRecoveredAt] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * 草稿写入的独立定时器。
   *
   * 与自动保存的定时器分开：草稿要**更频繁**（崩溃兜底要短窗口），但每次写的
   * 代价也更高（整份画布序列化 + 同步写盘）。分开才能各自取合适的节奏。
   */
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * 草稿写入是否已经记过一次失败日志。
   *
   * 草稿每 0.3 秒写一次，持续失败（比如存储空间不足）会刷屏。只在**第一次**失败
   * 时记一条，写成功一次就复位。
   */
  const draftFailureLoggedRef = useRef(false);
  const collector = useRef(collect);
  const ready = useRef(false);
  const skipInitialSave = useRef(true);
  const request = useRef(0);
  const suspended = useRef(false);
  const deleteValidator = useRef(validateDelete);
  const activeRef = useRef(active);

  const updateStatus = useCallback((next: "loading" | "pending" | "saving" | "saved" | "error") => {
    // 错误必须照常记录：激活后用户要能看到失败原因与重试入口。
    if (!activeRef.current && (next === "pending" || next === "saving" || next === "saved")) return;
    setStatus(next);
  }, []);

  /*
   * 画布从后台切回前台时，把状态刷新成「当前真实情况」。
   *
   * 之前有个窗口：非活跃画布的 pending/saving 状态被 updateStatus 丢掉（为了不给
   * 后台画布白白触发重渲染），于是切回来时状态还停在陈旧的「已保存」—— 而实际
   * 上这个画布有未落盘的改动，磁盘上是旧版本，用户看到的界面在骗人。
   *
   * 修法：用 ref 记住「有没有待落盘的改动」，切回前台时若有待保存的改动就把
   * 状态摆回「待保存」。这不需要给后台画布做重渲染 —— 只有切回来的那一刻才更新。
   */
  const dirtyRef = useRef(false);
  const wasActiveRef = useRef(active);
  /** 本次水合是否从崩溃草稿恢复过（用于触发「立刻落盘」）。 */
  const recoveredRef = useRef(false);

  useEffect(() => {
    activeRef.current = active;
    if (active && !wasActiveRef.current) {
      // 刚切回前台：若期间攒下了未落盘的改动，界面不能还说「已保存」。
      if (dirtyRef.current) setStatus("pending");
    }
    wasActiveRef.current = active;
  }, [active]);

  useEffect(() => {
    collector.current = collect;
  }, [collect]);

  useEffect(() => {
    deleteValidator.current = validateDelete;
  }, [validateDelete]);

  useEffect(() => {
    let cancelled = false;
    void canvasDocumentRepository.get(canvasId).then(
      (record) => {
        if (cancelled || suspended.current) return;
        try {
          /*
           * 崩溃兜底：草稿比存档新 = 上次是**崩了**而不是正常关闭
           * （正常关闭会先 flush 存档、再删草稿）。
           *
           * 这时把草稿恢复出来 —— 用户那 1 秒防抖窗口里的编辑因此不会丢。
           * 恢复后立刻排一次保存：草稿已经在 localStorage 里了，但只有落进
           * 存档才算数（否则再崩一次，界面又要重新走一遍恢复流程）。
           */
          const draft = readCanvasDraft(canvasId);
          const recovered = draft != null && isDraftNewerThan(draft, record.updatedAt);
          restore(recovered ? draft.document : record.document);
          services.titleLoaded(canvasId, recovered ? draft.title : record.title);
          ready.current = true;
          setHydrated(true);
          setStatus("saved");
          // 存档里本来就带 updatedAt（水合路径此前把它丢了），这里取回来：
          // 用户一进来就能看到「这份画布是什么时候存的」。
          setSavedAt(record.updatedAt ?? null);
          setError(null);
          if (recovered) {
            // 恢复出来的内容比存档新：状态是「待保存」，且要立刻排一次落盘。
            dirtyRef.current = true;
            updateStatus("pending");
            recoveredRef.current = true;
            setRecoveredAt(Date.now());
            frontendLog(
              "info",
              `[canvas] ${canvasId} 从崩溃草稿恢复了未保存的改动（草稿时间 ${new Date(draft.writtenAt).toISOString()}）`,
            );
          }
        } catch (failure) {
          // 画布读取失败：状态栏给的是人话摘要，原始 payload 只进日志。
          frontendLog("error", `[canvas] ${canvasId} 读取失败: ${formatRawBackendError(failure)}`);
          setError(backendErrorMessage(failure));
          setStatus("error");
        }
      },
      (failure: unknown) => {
        if (cancelled || suspended.current) return;
        if (isCanvasDocumentNotFound(failure)) {
          ready.current = true;
          setHydrated(true);
          setStatus("saved");
          // 还没有过存档：没有「上次保存的时刻」可言，留空让界面只显示「已保存」。
          setSavedAt(null);
          setError(null);
        } else {
          frontendLog("error", `[canvas] ${canvasId} 读取失败: ${formatRawBackendError(failure)}`);
          setError(backendErrorMessage(failure));
          setStatus("error");
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [canvasId, restore, services, loadAttempt]);

  const flush = useCallback(
    async (title?: string) => {
      if (suspended.current) return;
      // An unhydrated canvas cannot be edited and must never overwrite its stored document.
      if (!ready.current) {
        if (title !== undefined) throw new Error("请等待画布读取完成后再重命名。");
        return;
      }
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      const currentRequest = ++request.current;
      const document = collector.current();
      updateStatus("saving");
      try {
        /*
         * 版本号由 canvasDocumentRepository 统一持有（knownRevisions）：重命名走同一条
         * saveDirect 路径、同样推进 revision，若这里各自记一份，重命名后的下一次保存
         * 会带着过期版本号而被后端判成冲突。桌面端与浏览器路径都在 repository 里
         * 带上 expectedRevision，桌面端后端的乐观并发检查因此才真正生效。
         */
        await canvasDocumentRepository.save({
          id: canvasId,
          title: title ?? services.getTitle(canvasId),
          document,
        });
        if (!suspended.current && request.current === currentRequest) {
          updateStatus("saved");
          // 记下这一刻：界面上「已保存 · 14:32:05」的时间戳来自这里。
          setSavedAt(Date.now());
          // 落盘成功：没有待保存的改动了。
          dirtyRef.current = false;
          /*
           * 草稿的作用到此为止（崩溃兜底已由存档接管），删掉免得下次启动误判。
           * 同时**取消还没到期的草稿定时器** —— 否则它会在存档写完之后又写一份
           * 同样内容的草稿，白占一份 localStorage 空间（而且下次启动会多一次
           * 「恢复草稿」，内容虽然相同、结果幂等，但没必要）。
           */
          if (draftTimer.current !== null) {
            clearTimeout(draftTimer.current);
            draftTimer.current = null;
          }
          removeCanvasDraft(canvasId);
          setError(null);
        }
      } catch (failure) {
        // 状态栏给的是人话摘要，原始 payload 只进日志。
        const message = backendErrorMessage(failure);
        if (!suspended.current && request.current === currentRequest) {
          setStatus("error");
          setError(message);
        }
        frontendLog(
          "error",
          `[canvas] ${canvasId} 保存失败: ${message}；原始报错：${formatRawBackendError(failure)}`,
        );
        throw failure;
      }
    },
    [canvasId, services, updateStatus],
  );

  const schedule = useCallback(() => {
    if (!ready.current || suspended.current) return;
    // A previous save must not announce "saved" over a newer unsaved edit.
    request.current += 1;
    if (timer.current !== null) clearTimeout(timer.current);
    // 记下「有未落盘的改动」：切回前台时要靠它把陈旧的「已保存」纠正过来。
    dirtyRef.current = true;
    /*
     * 崩溃兜底：把当前画布写一份草稿到 localStorage。
     *
     * 自动保存有 1 秒防抖窗口，这段时间里的编辑只在内存里。此刻进程被强杀
     * （OOM、系统 kill）就全丢了，界面上却还写着「已保存」—— 用户无从知晓。
     * `beforeunload` 兜不住：进程被 SIGKILL 时事件根本不触发；正常关窗时
     * 它里面的异步 IPC 也可能在往返完成前被销毁。
     *
     * localStorage.setItem 是**同步**的，写完即落盘 —— 这正是崩溃场景要的语义。
     * 草稿只是兜底，写不进去（配额满）也不影响正常保存。
     *
     * **为什么草稿用独立的、更短的防抖**，而不是每次编辑都写：
     * 写草稿要付一次「整份画布序列化 + 同步写盘」的代价（还要把每个提示词节点
     * 的编辑器 JSON 转成 canonical 文档）。每次击键都付一次，在大画布上就是
     * 每次击键都阻塞主线程几毫秒。
     *
     * 用独立的短防抖（`CANVAS_DRAFT_DEBOUNCE_MS`）两头都变好：
     *   - 崩溃丢失窗口从 1 秒缩到 0.3 秒（比自动保存的窗口还小）；
     *   - 序列化频率从「每次击键」降到「每 0.3 秒最多一次」，快速输入时省 90% 以上。
     */
    if (draftTimer.current !== null) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      draftTimer.current = null;
      /*
       * `writeCanvasDraft` 自己吞掉了异常（草稿是兜底，不能让它把正常保存带崩），
       * 只用返回值表示成功与否。所以这里必须**检查返回值** —— 忽略它的话，
       * 配额写满导致的失败就完全静默：崩溃兜底其实早就失效了，而用户以为它在生效。
       *
       * 只在**第一次**失败时记日志：草稿是每 0.3 秒写一次，持续失败会刷屏。
       */
      let written = false;
      try {
        written = writeCanvasDraft(canvasId, services.getTitle(canvasId), collector.current());
      } catch (failure) {
        frontendLog("warn", `[canvas] ${canvasId} 草稿写入失败：${formatRawBackendError(failure)}`);
      }
      if (!written && !draftFailureLoggedRef.current) {
        draftFailureLoggedRef.current = true;
        frontendLog(
          "warn",
          `[canvas] ${canvasId} 崩溃草稿写入失败（可能是存储空间不足）：崩溃兜底本次不生效`,
        );
      } else if (written) {
        draftFailureLoggedRef.current = false;
      }
    }, CANVAS_DRAFT_DEBOUNCE_MS);
    updateStatus("pending");
    timer.current = setTimeout(() => {
      timer.current = null;
      void flush().catch(() => undefined);
    }, CANVAS_SAVE_DEBOUNCE_MS);
  }, [canvasId, collector, flush, services, updateStatus]);

  const documentChanged = useCallback(() => {
    if (!ready.current || suspended.current) return;
    if (skipInitialSave.current) {
      skipInitialSave.current = false;
      return;
    }
    schedule();
  }, [schedule]);

  /*
   * 崩溃草稿恢复后**立刻**把它落进存档。
   *
   * 草稿只是兜底：它躺在 localStorage 里，只有落进存档才算数。否则再崩一次，
   * 界面又要重新走一遍恢复流程，而用户会以为「上次已经存好了」。
   *
   * 用 flush 而不是 schedule：这里要的是「马上存」，不是「1 秒后存」。
   */
  useEffect(() => {
    if (!recoveredRef.current) return;
    recoveredRef.current = false;
    void flush().catch(() => undefined);
  }, [flush, recoveredAt]);

  const prepareDelete = useCallback(async () => {
    await deleteValidator.current?.();
    // Validation must succeed first so a rejected deletion keeps normal autosaving.
    // Existing writes are already queued before the repository's delete operation.
    suspended.current = true;
    request.current += 1;
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    // 画布要被删了：草稿也一起清掉，否则它会一直占着 localStorage 的一份空间，
    // 而且下次启动时这个画布 id 会被读回来（草稿比存档新 → 误判成崩溃恢复）。
    if (draftTimer.current !== null) {
      clearTimeout(draftTimer.current);
      draftTimer.current = null;
    }
    removeCanvasDraft(canvasId);
  }, [canvasId]);

  const resumeAfterDeleteFailure = useCallback(() => {
    if (!suspended.current) return;
    suspended.current = false;
    if (ready.current) schedule();
    else setLoadAttempt((value) => value + 1);
  }, [schedule]);

  useEffect(() => {
    // Notify the workspace after the hydrated UI commits, when its controls can receive focus.
    return services.register(canvasId, {
      flush,
      isReady: () => hydrated && ready.current && !suspended.current,
      prepareDelete,
      resumeAfterDeleteFailure,
    });
  }, [canvasId, flush, hydrated, prepareDelete, resumeAfterDeleteFailure, services]);

  useEffect(
    () => () => {
      /*
       * 卸载时：**同步写一份草稿**，再触发落盘。
       *
       * 为什么要写草稿而不是只落盘：落盘是异步 IPC，卸载后 WebView 可能先被
       * 销毁（往返没完成）。此刻进程若被强杀，那批编辑就两头落空 —— 既没进
       * 存档，也没有草稿兜底。同步写草稿是最后一道保险。
       *
       * 草稿定时器也一并取消：它若在卸载后照常触发，会白写一份同样内容的草稿
       * （而且这个组件可能已经因为「切换画布」而卸载）。
       *
       * 读到的仍是**这张画布**的状态：`canvasStore` 是 Context 提供的每画布
       * 独立 store，不是全局单例，卸载时读到的还是本画布的最后一份内容。
       */
      if (draftTimer.current !== null) {
        clearTimeout(draftTimer.current);
        draftTimer.current = null;
      }
      /*
       * 只在「确实有未落盘改动」时才写草稿。
       *
       * 无条件写的话，**每次正常退出应用**都会留下一份草稿：卸载时同步写完草稿、
       * 紧接着的异步 flush 还没跑完 WebView 就被销毁 → `removeCanvasDraft` 没执行
       * → 草稿的 writtenAt 比存档新 → 下次启动判成「崩了」→ 弹出
       * 「上次未保存的改动已恢复」。
       *
       * 而这次退出其实什么都没丢 —— 提示是假的。这条提示的全部价值就是
       * 「告诉你上次真的丢了东西」，假阳性会迅速消耗用户对它的信任。
       */
      if (dirtyRef.current) {
        try {
          writeCanvasDraft(canvasId, services.getTitle(canvasId), collector.current());
        } catch (failure) {
          frontendLog(
            "warn",
            `[canvas] ${canvasId} 草稿写入失败：${formatRawBackendError(failure)}`,
          );
        }
      }
      if (timer.current !== null) void flush().catch(() => undefined);
    },
    [canvasId, collector, flush, services],
  );

  const retry = () => {
    if (suspended.current) return;
    if (hydrated) void flush().catch(() => undefined);
    else {
      setError(null);
      setStatus("loading");
      setLoadAttempt((value) => value + 1);
    }
  };

  return { hydrated, status, error, savedAt, recoveredAt, schedule, documentChanged, retry, flush };
}
