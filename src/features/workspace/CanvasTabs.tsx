import { Icon } from "../../components/Icon";
import { memo, useEffect, useRef, useState, type KeyboardEvent } from "react";

import "./CanvasTabs.css";

export interface CanvasTabsProps {
  readonly canvases: readonly { readonly id: string; readonly name: string }[];
  readonly activeCanvasId: string;
  readonly busy?: boolean;
  readonly onSelect: (id: string) => void;
  readonly onCreate: () => void;
  readonly onRename: (id: string, name: string) => void;
  readonly onDelete: (id: string) => void;
}

interface CanvasNameEdit {
  readonly id: string;
  readonly originalName: string;
  readonly name: string;
}

export const CanvasTabs = memo(function CanvasTabs({
  canvases,
  activeCanvasId,
  busy = false,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}: CanvasTabsProps) {
  const [editing, setEditing] = useState<CanvasNameEdit | null>(null);
  const editingRef = useRef<CanvasNameEdit | null>(null);
  const composingRef = useRef(false);
  const tabsRef = useRef(new Map<string, HTMLButtonElement>());
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    tabsRef.current.get(activeCanvasId)?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeCanvasId]);

  useEffect(() => {
    if (editing?.id) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing?.id]);

  function beginRename(canvas: CanvasTabsProps["canvases"][number]) {
    if (busy) return;
    const next = { id: canvas.id, originalName: canvas.name, name: canvas.name };
    composingRef.current = false;
    editingRef.current = next;
    setEditing(next);
  }

  function finishRename(save: boolean, restoreFocus = false) {
    const current = editingRef.current;
    if (!current) return;
    editingRef.current = null;
    composingRef.current = false;
    setEditing(null);
    const name = current.name.trim();
    if (save && name && name !== current.originalName) onRename(current.id, name);
    if (restoreFocus) tabsRef.current.get(current.id)?.focus();
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const current = canvases[index];
    if (!current) return;
    let nextIndex: number;
    switch (event.key) {
      case "ArrowLeft":
        nextIndex = (index + canvases.length - 1) % canvases.length;
        break;
      case "ArrowRight":
        nextIndex = (index + 1) % canvases.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = canvases.length - 1;
        break;
      case "F2":
        event.preventDefault();
        event.stopPropagation();
        beginRename(current);
        return;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (busy) return;
    const next = canvases[nextIndex];
    if (!next) return;
    tabsRef.current.get(next.id)?.focus();
    if (next.id !== activeCanvasId) onSelect(next.id);
  }

  return (
    <nav className="canvas-tabs" aria-label="画布管理" aria-busy={busy}>
      <div className="canvas-tabs__list" role="tablist" aria-label="创作画布">
        {canvases.map((canvas, index) => {
          const selected = canvas.id === activeCanvasId;
          const isEditing = editing?.id === canvas.id;
          return (
            <div
              className={`canvas-tabs__item${selected ? " canvas-tabs__item--active" : ""}`}
              key={canvas.id}
              role="presentation"
            >
              <button
                ref={(element) => {
                  if (element) tabsRef.current.set(canvas.id, element);
                  else tabsRef.current.delete(canvas.id);
                }}
                type="button"
                className="canvas-tabs__tab"
                role="tab"
                id={`canvas-tab-${canvas.id}`}
                aria-controls={`canvas-panel-${canvas.id}`}
                aria-selected={selected}
                tabIndex={selected && !isEditing ? 0 : -1}
                title={`${canvas.name} · 双击重命名`}
                aria-disabled={busy}
                onClick={() => {
                  if (!busy && !selected) onSelect(canvas.id);
                }}
                onDoubleClick={() => beginRename(canvas)}
                onKeyDown={(event) => handleTabKeyDown(event, index)}
              >
                <span className="canvas-tabs__name">{canvas.name}</span>
              </button>
              {selected && !isEditing && (
                <button
                  type="button"
                  className="canvas-tabs__rename"
                  aria-label={`重命名画布 ${canvas.name}`}
                  title="重命名画布（也可双击名称）"
                  onClick={() => beginRename(canvas)}
                  disabled={busy}
                >
                  <Icon name="pencil-simple" aria-hidden="true" size="sm" />
                </button>
              )}
              {selected && (
                <button
                  type="button"
                  className="canvas-tabs__delete"
                  aria-label={`删除画布 ${canvas.name}`}
                  title="删除画布"
                  onClick={() => onDelete(canvas.id)}
                  disabled={busy || editing !== null}
                >
                  <Icon name="trash" aria-hidden="true" size="sm" />
                </button>
              )}
              {isEditing && (
                <input
                  ref={inputRef}
                  className="canvas-tabs__name-input"
                  aria-label="画布名称"
                  value={editing.name}
                  disabled={busy}
                  onChange={(event) => {
                    const next = { ...editing, name: event.target.value };
                    editingRef.current = next;
                    setEditing(next);
                  }}
                  onBlur={() => finishRename(true)}
                  onCompositionStart={() => {
                    composingRef.current = true;
                  }}
                  onCompositionEnd={() => {
                    composingRef.current = false;
                  }}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (
                      composingRef.current ||
                      event.nativeEvent.isComposing ||
                      event.keyCode === 229
                    ) {
                      return;
                    }
                    if (event.key === "Enter" || event.key === "Escape") {
                      event.preventDefault();
                      finishRename(event.key === "Enter", true);
                    }
                  }}
                />
              )}
            </div>
          );
        })}
      </div>
      <button
        type="button"
        className="canvas-tabs__create"
        aria-label="新建画布"
        title="新建画布"
        disabled={busy}
        onClick={onCreate}
      >
        <Icon name="plus" aria-hidden="true" size="md" />
        <span>新建画布</span>
      </button>
    </nav>
  );
});
