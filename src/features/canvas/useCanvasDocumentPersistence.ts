import { useCallback, useEffect, useRef, useState } from "react";
import { formatRawBackendError, frontendLog } from "../../lib/backend";
import { CANVAS_SAVE_DEBOUNCE_MS } from "../workspace/workspaceModel";
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
  readonly recoverWorkflowHistory: () => Promise<number>;
}

/** A session keeps its own collector, load guard and save timer even while its UI is hidden. */
export function useCanvasDocumentPersistence({
  canvasId,
  collect,
  restore,
  services,
  validateDelete,
}: {
  readonly canvasId: string;
  readonly collect: () => CanvasDocumentV2;
  readonly restore: (document: unknown) => void;
  readonly services: CanvasSessionServices;
  readonly validateDelete?: () => Promise<void>;
}) {
  const [hydrated, setHydrated] = useState(false);
  const [status, setStatus] = useState<"loading" | "pending" | "saving" | "saved" | "error">(
    "loading",
  );
  const [error, setError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const collector = useRef(collect);
  const ready = useRef(false);
  const skipInitialSave = useRef(true);
  const request = useRef(0);
  const suspended = useRef(false);
  const deleteValidator = useRef(validateDelete);

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
          restore(record.document);
          services.titleLoaded(canvasId, record.title);
          ready.current = true;
          setHydrated(true);
          setStatus("saved");
          setError(null);
        } catch (failure) {
          setError(formatRawBackendError(failure));
          setStatus("error");
        }
      },
      (failure: unknown) => {
        if (cancelled || suspended.current) return;
        if (isCanvasDocumentNotFound(failure)) {
          ready.current = true;
          setHydrated(true);
          setStatus("saved");
          setError(null);
        } else {
          setError(formatRawBackendError(failure));
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
      setStatus("saving");
      try {
        await canvasDocumentRepository.save({
          id: canvasId,
          title: title ?? services.getTitle(canvasId),
          document,
        });
        if (!suspended.current && request.current === currentRequest) {
          setStatus("saved");
          setError(null);
        }
      } catch (failure) {
        const message = formatRawBackendError(failure);
        if (!suspended.current && request.current === currentRequest) {
          setStatus("error");
          setError(message);
        }
        frontendLog("error", `[canvas] ${canvasId} 保存失败: ${message}`);
        throw failure;
      }
    },
    [canvasId, services],
  );

  const schedule = useCallback(() => {
    if (!ready.current || suspended.current) return;
    // A previous save must not announce "saved" over a newer unsaved edit.
    request.current += 1;
    if (timer.current !== null) clearTimeout(timer.current);
    setStatus("pending");
    timer.current = setTimeout(() => {
      timer.current = null;
      void flush().catch(() => undefined);
    }, CANVAS_SAVE_DEBOUNCE_MS);
  }, [flush]);

  const documentChanged = useCallback(() => {
    if (!ready.current || suspended.current) return;
    if (skipInitialSave.current) {
      skipInitialSave.current = false;
      return;
    }
    schedule();
  }, [schedule]);

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
  }, []);

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
      if (timer.current !== null) void flush().catch(() => undefined);
    },
    [flush],
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

  return { hydrated, status, error, schedule, documentChanged, retry };
}
