import { Trash } from "@phosphor-icons/react/Trash";
import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";

import "./CanvasDeleteDialog.css";

export interface CanvasDeleteDialogProps {
  readonly canvasName: string;
  readonly busy: boolean;
  readonly error?: string | null;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}

export function CanvasDeleteDialog({
  canvasName,
  busy,
  error,
  onConfirm,
  onClose,
}: CanvasDeleteDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement;
    if (typeof dialog.showModal === "function") {
      try {
        dialog.showModal();
      } catch {
        dialog.setAttribute("open", "");
      }
    } else {
      dialog.setAttribute("open", "");
    }
    cancelRef.current?.focus();
    return () => {
      if (dialog.open) {
        if (typeof dialog.close === "function") dialog.close();
        else dialog.removeAttribute("open");
      }
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  useEffect(() => {
    // Keep focus inside the dialog when the action buttons become disabled.
    if (busy) dialogRef.current?.focus();
    else cancelRef.current?.focus();
  }, [busy]);

  return createPortal(
    <dialog
      ref={dialogRef}
      className="canvas-delete-dialog"
      tabIndex={-1}
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      aria-busy={busy}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          if (!busy) onClose();
        }
        if (event.key === "Tab") {
          if (busy) {
            event.preventDefault();
            return;
          }
          if (event.shiftKey && document.activeElement === cancelRef.current) {
            event.preventDefault();
            confirmRef.current?.focus();
          } else if (!event.shiftKey && document.activeElement === confirmRef.current) {
            event.preventDefault();
            cancelRef.current?.focus();
          }
        }
      }}
    >
      <header className="canvas-delete-dialog__header">
        <span className="canvas-delete-dialog__icon" aria-hidden="true">
          <Trash size={22} weight="duotone" />
        </span>
        <h2 id={titleId}>删除画布？</h2>
      </header>
      <div className="canvas-delete-dialog__body" id={descriptionId}>
        <p>
          将删除画布“<strong>{canvasName}</strong>
          ”，以及其中的所有节点、连线和提示内容。此操作无法撤销。
        </p>
        <p className="canvas-delete-dialog__retained">已保存的媒体文件和任务历史会保留。</p>
      </div>
      {error && (
        <p className="canvas-delete-dialog__error" role="alert">
          {error}
        </p>
      )}
      <footer className="canvas-delete-dialog__actions">
        <button ref={cancelRef} type="button" onClick={onClose} disabled={busy}>
          取消
        </button>
        <button
          ref={confirmRef}
          type="button"
          className="canvas-delete-dialog__confirm"
          onClick={() => {
            if (!busy) onConfirm();
          }}
          disabled={busy}
        >
          {busy ? "正在删除…" : "确认删除"}
        </button>
      </footer>
    </dialog>,
    document.body,
  );
}
