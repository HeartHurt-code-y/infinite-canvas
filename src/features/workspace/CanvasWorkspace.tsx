import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { formatRawBackendError, isDesktopRuntime } from "../../lib/backend";
import { workflowHistoryClient } from "../../lib/workflowHistory";
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
  const canvasNames = useRef(new Map([[initialCanvasId, CANVAS_DOCUMENT_TITLE]]));
  const [activeCanvasId, setActiveCanvasId] = useState(initialCanvasId);
  const activeId = useRef(initialCanvasId);
  const [visited, setVisited] = useState<readonly string[]>([initialCanvasId]);
  const sessions = useRef(new Map<string, CanvasSessionHandle>());
  const [readyIds, setReadyIds] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const mutation = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CanvasTab | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const recovery = useRef<Promise<number> | null>(null);
  const focusActivatedTab = useRef(false);

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
      recoverWorkflowHistory: () => {
        if (!recovery.current) {
          const pending = workflowHistoryClient.recover();
          recovery.current = pending;
          void pending.catch(() => {
            if (recovery.current === pending) recovery.current = null;
          });
        }
        return recovery.current;
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
      setError(`读取画布列表失败：${formatRawBackendError(failure)}`);
    } finally {
      setLoading(false);
    }
  }, []);

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
            setError(`画布保存失败，窗口保持打开：${formatRawBackendError(failure)}`);
          }
        });
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch((failure: unknown) => {
        setError(`注册关闭保存失败：${formatRawBackendError(failure)}`);
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [flushAll]);

  const activate = (id: string) => {
    focusActivatedTab.current = true;
    activeId.current = id;
    setVisited((current) => (current.includes(id) ? current : [...current, id]));
    setActiveCanvasId(id);
    try {
      writeActiveCanvasId(id);
    } catch (failure) {
      toast.error("无法记住当前画布", { description: formatRawBackendError(failure) });
    }
  };

  const runMutation = (action: () => Promise<void>) => {
    if (mutation.current) return;
    mutation.current = true;
    setBusy(true);
    setError(null);
    void action()
      .catch((failure: unknown) => {
        setError(formatRawBackendError(failure));
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
        const messages = [`删除失败：${formatRawBackendError(failure)}`];
        let retainReplacement = false;
        if (preferenceChanged) {
          try {
            writeActiveCanvasId(activeId.current);
          } catch (restoreFailure) {
            retainReplacement = true;
            messages.push(`恢复当前画布记录失败：${formatRawBackendError(restoreFailure)}`);
          }
        }
        session?.resumeAfterDeleteFailure();
        if (replacement) {
          try {
            // The persisted active ID must never point at a replacement we also removed.
            if (!retainReplacement) await canvasDocumentRepository.delete(replacement.id);
          } catch (cleanupFailure) {
            retainReplacement = true;
            messages.push(`清理空白画布失败：${formatRawBackendError(cleanupFailure)}`);
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
                  />
                ) : null
              }
            />
          </CanvasStoreProvider>
        ))}
      </div>
      {error ? (
        <div className="canvas-session-error" role="alert">
          <span>{error}</span>
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
