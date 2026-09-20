import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./WorkflowVersionHistoryPanel.css";

interface VersionSummary {
  readonly id: string;
  readonly parentId: string | null;
  readonly createdAt: number;
  readonly label: string;
}

export function WorkflowVersionHistoryPanel({
  workflowTitle,
  versions,
  currentVersionId,
  redoVersionIds,
  busy,
  onRestore,
  onRedo,
  onClose,
}: {
  readonly workflowTitle: string;
  readonly versions: readonly VersionSummary[];
  readonly currentVersionId: string | null;
  readonly redoVersionIds: readonly string[];
  readonly busy: boolean;
  readonly onRestore: (id: string) => void;
  readonly onRedo: (id: string) => void;
  readonly onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [visibleCount, setVisibleCount] = useState(50);
  const numbers = new Map(versions.map((version, index) => [version.id, index + 1]));
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    return () => {
      if (dialog.open && typeof dialog.close === "function") dialog.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);
  return createPortal(
    <dialog
      ref={dialogRef}
      className="workflow-version-history"
      aria-modal="true"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <header>
        <h2 id={titleId}>{workflowTitle} · 版本历史</h2>
        <button type="button" onClick={onClose} aria-label="关闭工作流版本历史">
          关闭
        </button>
      </header>
      <p>当前工作流的每次编辑都保留新版本。回退后继续编辑会创建分支，原有历史始终保留。</p>
      {busy ? <p role="status">制作任务运行中，请先暂停或等待完成，再切换版本。</p> : null}
      <ol reversed start={versions.length}>
        {versions
          .slice(-visibleCount)
          .reverse()
          .map((version) => {
            const current = version.id === currentVersionId;
            return (
              <li key={version.id} aria-current={current ? "true" : undefined}>
                <div>
                  <strong>
                    版本 {numbers.get(version.id)} · {version.label}
                    {current ? " · 当前" : ""}
                  </strong>
                  <span>
                    {new Date(version.createdAt).toLocaleString("zh-CN")}
                    {version.parentId
                      ? ` · 源自版本 ${numbers.get(version.parentId) ?? "—"}`
                      : " · 初始版本"}
                  </span>
                </div>
                <button
                  type="button"
                  disabled={busy || current}
                  onClick={() => onRestore(version.id)}
                >
                  {current ? "当前版本" : `回到版本 ${numbers.get(version.id)}`}
                </button>
                {redoVersionIds.includes(version.id) ? (
                  <button type="button" disabled={busy} onClick={() => onRedo(version.id)}>
                    重做至此版本
                  </button>
                ) : null}
              </li>
            );
          })}
      </ol>
      {versions.length > visibleCount ? (
        <button type="button" onClick={() => setVisibleCount((count) => count + 50)}>
          显示更早的版本
        </button>
      ) : null}
    </dialog>,
    document.body,
  );
}
