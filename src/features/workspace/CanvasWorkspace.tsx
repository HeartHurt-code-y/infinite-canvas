import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "../../lib/toast";
import { ErrorAlert, type ErrorAlertNotice } from "../../components/ErrorAlert";
import {
  backendErrorMessage,
  formatRawBackendError,
  frontendLog,
  isDesktopRuntime,
} from "../../lib/backend";
import {
  registerAppUpdateBeforeInstallFlush,
  startAutomaticAppUpdateChecks,
} from "../../lib/appUpdate";
import {
  canvasDocumentRepository,
  readActiveCanvasId,
  writeActiveCanvasId,
} from "../canvas/canvasDocumentRepository";
import { CanvasStoreProvider, createCanvasState } from "../canvas/canvasStore";
import type {
  CanvasSessionHandle,
  CanvasSessionServices,
} from "../canvas/useCanvasDocumentPersistence";
import { CanvasTabs } from "./CanvasTabs";
import { CanvasDeleteDialog } from "./CanvasDeleteDialog";
import { openCreateStudio } from "../create/openCreateStudio";
import { WorkspaceApp } from "./WorkspaceApp";
import { CANVAS_ID, CANVAS_DOCUMENT_TITLE, DEFAULT_ZOOM } from "./workspaceModel";
import "./CanvasWorkspace.css";

interface CanvasTab {
  readonly id: string;
  readonly name: string;
}

export function CanvasWorkspace() {
  const [initialCanvasId] = useState(() => {
    try {
      return readActiveCanvasId() ?? CANVAS_ID;
    } catch {
      return CANVAS_ID;
    }
  });
  const [canvases, setCanvases] = useState<readonly CanvasTab[]>([
    { id: initialCanvasId, name: CANVAS_DOCUMENT_TITLE },
  ]);
  const canvasNames = useRef<Map<string, string>>(undefined!);
  canvasNames.current ??= new Map([[initialCanvasId, CANVAS_DOCUMENT_TITLE]]);
  const [activeCanvasId, setActiveCanvasId] = useState(initialCanvasId);
  const activeId = useRef(initialCanvasId);
  const [visited, setVisited] = useState<readonly string[]>([initialCanvasId]);
  const sessions = useRef<Map<string, CanvasSessionHandle>>(undefined!);
  sessions.current ??= new Map();
  const [readyIds, setReadyIds] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const mutation = useRef(false);
  // 存原始错误对象：摘要、展开与复制统一交给 ErrorAlert，界面不再自己拼 JSON。
  const [error, setError] = useState<ErrorAlertNotice | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CanvasTab | null>(null);
  // 删除确认弹窗只接受字符串（CanvasDeleteDialog 不在本轮改动范围内），
  // 因此这里存人话摘要，原始 payload 走日志。
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const focusActivatedTab = useRef(false);

  /**
   * 记录一次失败：原始 payload 只进日志，界面上交给 ErrorAlert 出人话摘要。
   *
   * 以前这里直接把 `formatRawBackendError` 的结果拼进文案，用户看到的是一坨
   * `{"details":null,"kind":"validation",…}`；现在调用点只负责递原始错误对象。
   */
  const showFailure = useCallback((failure: unknown, label?: string) => {
    frontendLog("error", `[canvas] ${label ?? "操作失败"}：${formatRawBackendError(failure)}`);
    setError({ label, error: failure });
  }, []);

  useEffect(() => {
    if (
      !focusActivatedTab.current ||
      !readyIds.has(activeCanvasId) ||
      loading ||
      busy ||
      deleteTarget !== null
    ) {
      return;
    }
    focusActivatedTab.current = false;
    document.getElementById(`canvas-tab-${activeCanvasId}`)?.focus();
  }, [activeCanvasId, readyIds, loading, busy, deleteTarget]);

  const services = useMemo<CanvasSessionServices>(
    () => ({
      register: (id, handle) => {
        sessions.current.set(id, handle);
        setReadyIds((current) => {
          const ready = handle.isReady();
          if (current.has(id) === ready) return current;
          const next = new Set(current);
          if (ready) next.add(id);
          else next.delete(id);
          return next;
        });
        return () => {
          sessions.current.delete(id);
        };
      },
      getTitle: (id) => canvasNames.current.get(id) ?? CANVAS_DOCUMENT_TITLE,
      titleLoaded: (id, title) => {
        canvasNames.current.set(id, title);
        setCanvases((current) =>
          current.map((canvas) => (canvas.id === id ? { id, name: title } : canvas)),
        );
      },
    }),
    [],
  );

  const loadCatalog = useCallback(async () => {
    try {
      const records = await canvasDocumentRepository.list();
      const tabs = [...records]
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
        .map((record) => ({ id: record.id, name: record.title }));
      const currentId = activeId.current;
      if (!tabs.some((canvas) => canvas.id === currentId)) {
        tabs.unshift({
          id: currentId,
          name: canvasNames.current.get(currentId) ?? CANVAS_DOCUMENT_TITLE,
        });
      }
      for (const canvas of tabs) canvasNames.current.set(canvas.id, canvas.name);
      setCanvases(tabs);
      setError(null);
    } catch (failure) {
      showFailure(failure, "读取画布列表失败");
    } finally {
      setLoading(false);
    }
  }, [showFailure]);

  useEffect(() => {
    // The catalog is external storage; results update the tab list after the read completes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadCatalog();
  }, [loadCatalog]);

  const flushAll = useCallback(async () => {
    const results = await Promise.allSettled(
      [...sessions.current.values()].map((session) => session.flush()),
    );
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }, []);

  useEffect(() => {
    const unregister = registerAppUpdateBeforeInstallFlush(async () => {
      const activeSession = sessions.current.get(activeId.current);
      if (!activeSession?.isReady()) throw new Error("当前画布尚未加载完成，已暂停安装更新。");
      await flushAll();
    });
    return () => {
      unregister();
    };
  }, [flushAll]);

  const activeCanvasReady = readyIds.has(activeCanvasId);
  useEffect(() => {
    if (!activeCanvasReady || !import.meta.env.PROD || !isDesktopRuntime()) return;
    return startAutomaticAppUpdateChecks();
  }, [activeCanvasReady]);

  useEffect(() => {
    const flush = () => {
      void flushAll().catch(() => undefined);
    };
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
    };
  }, [flushAll]);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let closing = false;
    void import("@tauri-apps/api/window")
      .then(async ({ getCurrentWindow }) => {
        if (disposed) return;
        const appWindow = getCurrentWindow();
        const stop = await appWindow.onCloseRequested(async (event) => {
          event.preventDefault();
          if (closing) return;
          closing = true;
          try {
            await flushAll();
            await appWindow.destroy();
          } catch (failure) {
            closing = false;
            showFailure(failure, "画布保存失败，窗口保持打开");
          }
        });
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch((failure: unknown) => {
        showFailure(failure, "注册关闭保存失败");
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [flushAll, showFailure]);

  const activate = (id: string) => {
    focusActivatedTab.current = true;
    activeId.current = id;
    setVisited((current) => (current.includes(id) ? current : [...current, id]));
    setActiveCanvasId(id);
    try {
      writeActiveCanvasId(id);
    } catch (failure) {
      // toast 的描述是人话摘要；原始 payload 只进日志。
      frontendLog("error", `[canvas] 无法记住当前画布：${formatRawBackendError(failure)}`);
      toast.error("无法记住当前画布", { description: backendErrorMessage(failure) });
    }
  };

  const runMutation = (action: () => Promise<void>) => {
    if (mutation.current) return;
    mutation.current = true;
    setBusy(true);
    setError(null);
    void action()
      .catch((failure: unknown) => {
        showFailure(failure);
      })
      .finally(() => {
        mutation.current = false;
        setBusy(false);
      });
  };

  const flushActive = async (title?: string) => {
    const session = sessions.current.get(activeCanvasId);
    if (!session) throw new Error("当前画布尚未加载完成。");
    await session.flush(title);
  };

  const selectCanvas = (id: string) => {
    if (id === activeCanvasId || !canvases.some((canvas) => canvas.id === id)) return;
    runMutation(async () => {
      await flushActive();
      activate(id);
    });
  };

  const createCanvas = () =>
    runMutation(async () => {
      await flushActive();
      let number = canvases.length + 1;
      while (canvases.some((canvas) => canvas.name === `画布 ${number}`)) number += 1;
      const canvas = { id: `canvas-${crypto.randomUUID()}`, name: `画布 ${number}` };
      const document = createCanvasState(DEFAULT_ZOOM).commands.snapshotV2({});
      await canvasDocumentRepository.save({ id: canvas.id, title: canvas.name, document });
      canvasNames.current.set(canvas.id, canvas.name);
      setCanvases((current) => [...current, canvas]);
      activate(canvas.id);
    });

  const renameCanvas = (id: string, title: string) => {
    const name = title.trim();
    if (!name || canvasNames.current.get(id) === name) return;
    runMutation(async () => {
      const session = sessions.current.get(id);
      if (session && !session.isReady()) throw new Error("请等待画布读取完成后再重命名。");
      // Keep the requested name authoritative while writes are in flight. Background
      // autosaves must use it too, including retries after a failed rename save.
      canvasNames.current.set(id, name);
      setCanvases((current) => current.map((canvas) => (canvas.id === id ? { id, name } : canvas)));
      if (session) await session.flush(name);
      else await canvasDocumentRepository.rename(id, name);
    });
  };

  const confirmDelete = () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    runMutation(async () => {
      setDeleteError(null);
      const session = sessions.current.get(target.id);
      let replacement: CanvasTab | undefined;
      let preferenceChanged = false;
      try {
        if (!session) throw new Error("当前画布尚未加载完成。");
        await session.prepareDelete();
        const index = canvases.findIndex((canvas) => canvas.id === target.id);
        let next = canvases[index + 1] ?? canvases[index - 1];
        if (!next) {
          replacement = {
            id: `canvas-${crypto.randomUUID()}`,
            name: CANVAS_DOCUMENT_TITLE,
          };
          await canvasDocumentRepository.save({
            id: replacement.id,
            title: replacement.name,
            document: createCanvasState(DEFAULT_ZOOM).commands.snapshotV2({}),
          });
          next = replacement;
        }
        // Remember the surviving canvas first so a restart cannot recreate the deleted ID.
        writeActiveCanvasId(next.id);
        preferenceChanged = true;
        await canvasDocumentRepository.delete(target.id);
        canvasNames.current.delete(target.id);
        if (replacement) canvasNames.current.set(replacement.id, replacement.name);
        sessions.current.delete(target.id);
        setReadyIds((current) => {
          const remaining = new Set(current);
          remaining.delete(target.id);
          return remaining;
        });
        setCanvases((current) => [
          ...current.filter((canvas) => canvas.id !== target.id),
          ...(replacement ? [replacement] : []),
        ]);
        setVisited((current) => current.filter((id) => id !== target.id));
        activate(next.id);
        setDeleteTarget(null);
      } catch (failure) {
        // 删除确认弹窗只接受字符串：这里存人话摘要，原始 payload 走日志。
        frontendLog("error", `[canvas] 删除画布失败：${formatRawBackendError(failure)}`);
        const messages = [`删除失败：${backendErrorMessage(failure)}`];
        let retainReplacement = false;
        if (preferenceChanged) {
          try {
            writeActiveCanvasId(activeId.current);
          } catch (restoreFailure) {
            retainReplacement = true;
            frontendLog(
              "error",
              `[canvas] 恢复当前画布记录失败：${formatRawBackendError(restoreFailure)}`,
            );
            messages.push(`恢复当前画布记录失败：${backendErrorMessage(restoreFailure)}`);
          }
        }
        session?.resumeAfterDeleteFailure();
        if (replacement) {
          try {
            // The persisted active ID must never point at a replacement we also removed.
            if (!retainReplacement) await canvasDocumentRepository.delete(replacement.id);
          } catch (cleanupFailure) {
            retainReplacement = true;
            frontendLog(
              "error",
              `[canvas] 清理空白画布失败：${formatRawBackendError(cleanupFailure)}`,
            );
            messages.push(`清理空白画布失败：${backendErrorMessage(cleanupFailure)}`);
          }
          if (retainReplacement) {
            const retained = replacement;
            canvasNames.current.set(retained.id, retained.name);
            setCanvases((current) => [...current, retained]);
            messages.push("新建的空白画布已保留。");
          }
        }
        setDeleteError(messages.join("\n"));
      }
    });
  };

  return (
    <div className="multi-canvas-workspace">
      <div
        className="canvas-session-panel"
        role="tabpanel"
        id={`canvas-panel-${activeCanvasId}`}
        aria-labelledby={`canvas-tab-${activeCanvasId}`}
        inert={deleteTarget !== null}
      >
        {visited.map((id) => (
          <CanvasStoreProvider key={id} initialZoom={DEFAULT_ZOOM}>
            <WorkspaceApp
              canvasId={id}
              active={id === activeCanvasId}
              services={services}
              canvasCatalog={canvases}
              onSelectCanvas={selectCanvas}
              canvasNavigation={
                id === activeCanvasId ? (
                  <CanvasTabs
                    canvases={canvases}
                    activeCanvasId={activeCanvasId}
                    busy={loading || busy || deleteTarget !== null || !readyIds.has(activeCanvasId)}
                    onSelect={selectCanvas}
                    onCreate={createCanvas}
                    onRename={renameCanvas}
                    onDelete={(canvasId) => {
                      const target = canvases.find((canvas) => canvas.id === canvasId);
                      if (!target || mutation.current) return;
                      setDeleteError(null);
                      setDeleteTarget(target);
                    }}
                    onOpenCreateStudio={() => {
                      void openCreateStudio().catch((failure: unknown) => {
                        // toast 的描述是人话摘要；原始 payload 只进日志。
                        frontendLog(
                          "error",
                          `[canvas] 无法打开创作台：${formatRawBackendError(failure)}`,
                        );
                        toast.error("无法打开创作台", {
                          description: backendErrorMessage(failure),
                        });
                      });
                    }}
                  />
                ) : null
              }
            />
          </CanvasStoreProvider>
        ))}
      </div>
      {error ? (
        <div className="canvas-session-error">
          <span>
            <ErrorAlert
              error={error.error}
              label={error.label}
              hint={
                /*
                 * 版本冲突的处置与普通失败不同：普通失败重试是安全的（写同样的内容），
                 * 版本冲突重试会用**本窗口的内容覆盖**画布（另一个窗口的改动会丢）。
                 * 用户必须知情，否则「重试」这个按钮名会让人以为只是重发一次。
                 */
                /版本冲突|已在别处被修改|changed since revision/i.test(String(error.error))
                  ? "这张画布在另一个窗口被改过了。本窗口的内容仍在本机：点「重试」会以本窗口的内容覆盖画布（另一个窗口的改动会丢失）；想保留对方改动，请关闭本窗口后重新打开画布。"
                  : "画布内容仍然保留在本机；可点「重试」重新保存，展开完整报错可把诊断文本贴给开发者。"
              }
            />
          </span>
          <button
            type="button"
            disabled={busy || loading || deleteTarget !== null}
            onClick={() => {
              runMutation(async () => {
                await flushAll();
                await loadCatalog();
              });
            }}
          >
            重试
          </button>
          <button type="button" onClick={() => setError(null)} aria-label="关闭画布错误提示">
            关闭
          </button>
        </div>
      ) : null}
      {deleteTarget ? (
        <CanvasDeleteDialog
          canvasName={deleteTarget.name}
          busy={busy}
          error={deleteError}
          onConfirm={confirmDelete}
          onClose={() => {
            if (!mutation.current) setDeleteTarget(null);
          }}
        />
      ) : null}
    </div>
  );
}
