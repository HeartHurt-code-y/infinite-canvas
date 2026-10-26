import { useEffect, useRef, type ReactNode } from "react";
import { ErrorAlert } from "../../components/ErrorAlert";
import { Icon, type IconName } from "../../components/Icon";
import { CanvasNodeEditorShell } from "./CanvasNodeEditor";
import type { CanvasNodeDimensions } from "./workspaceModel";

export interface NodeEditingProps {
  readonly presentation?: "card" | "editor";
  readonly editorOpen: boolean;
  readonly onEdit: (key: string) => void;
  readonly onCloseEditor: () => void;
}

export function CanvasContentNode({
  node,
  kindLabel,
  icon,
  summary,
  metadata,
  status,
  busy = false,
  error,
  selected,
  presentation = "card",
  editorOpen,
  onSelect,
  onEdit,
  onCloseEditor,
  onSizeChange,
  children,
}: NodeEditingProps & {
  readonly node: {
    readonly key: string;
    readonly kind: string;
    readonly x: number;
    readonly y: number;
    readonly measured?: CanvasNodeDimensions;
  };
  readonly kindLabel: string;
  readonly icon: IconName;
  readonly summary: string;
  readonly metadata: string;
  readonly status: string;
  readonly busy?: boolean;
  readonly error?: string | null | undefined;
  readonly selected: boolean;
  readonly onSelect?: ((key: string) => void) | undefined;
  /**
   * 删除节点：原站节点卡上没有叉号按钮，删除走「选中后按 Delete」。
   * 这里只保留 prop 形状以兼容父组件既有传参，卡片里不再渲染删除按钮。
   */
  readonly onRemove?: ((key: string) => void) | undefined;
  readonly onSizeChange?: ((key: string, size: CanvasNodeDimensions) => void) | undefined;
  readonly children: ReactNode;
}) {
  const elementRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = elementRef.current;
    if (!element || !onSizeChange || presentation !== "card") return;
    const report = () => {
      if (element.offsetWidth > 0 && element.offsetHeight > 0)
        onSizeChange(node.key, { width: element.offsetWidth, height: element.offsetHeight });
    };
    report();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => observer.disconnect();
  }, [node.key, onSizeChange, presentation]);

  if (presentation === "editor")
    return (
      <CanvasNodeEditorShell
        nodeKey={node.key}
        name={kindLabel}
        kindLabel={kindLabel}
        anchor={{
          x: node.x,
          y: node.y,
          width: node.measured?.width ?? 622,
          height: node.measured?.height ?? 400,
        }}
        open={editorOpen}
        onClose={onCloseEditor}
      >
        <div className="canvas-content-editor">{children}</div>
      </CanvasNodeEditorShell>
    );

  const errorId = `node-preview-error-${node.key}`;
  return (
    <div
      ref={elementRef}
      id={`node-preview-${node.key}`}
      className={`canvas-gen-node canvas-node-preview canvas-content-preview${selected ? " is-selected" : ""}`}
      data-connection-target={node.key}
      data-node-kind={node.kind}
      aria-busy={busy}
      onMouseDown={(event) => {
        if ((event.target as Element).closest("button, details, summary")) return;
        onSelect?.(node.key);
      }}
    >
      <div className="canvas-gen-node__header">
        <span className="canvas-gen-node__type">
          <span className="canvas-gen-node__type-icon" aria-hidden="true">
            <Icon name={icon} size="md" />
          </span>
          <span className="canvas-gen-node__type-copy">
            <strong>{kindLabel}</strong>
          </span>
        </span>
      </div>
      <div
        className="canvas-node-preview__media canvas-node-preview__document"
        aria-label={`${kindLabel}摘要`}
      >
        <div className="canvas-node-preview__document-heading">
          <Icon name={icon} size="lg" aria-hidden="true" />
          <span>{busy ? "正在更新" : summary.trim() ? "内容摘要" : "等待创作"}</span>
        </div>
        <p>{summary.trim().slice(0, 1400) || "选中节点，填写要求或连接上游内容开始创作。"}</p>
      </div>
      <div className="canvas-node-preview__meta">
        <div className="canvas-node-preview__summary">
          <span title={metadata}>{metadata}</span>
          <p role="status" aria-live="polite">
            {status}
          </p>
        </div>
        <button
          type="button"
          className="canvas-node-preview__edit"
          data-open-node-editor={node.key}
          aria-label={`编辑${kindLabel}：${kindLabel}`}
          aria-controls={`node-editor-${node.key}`}
          aria-expanded={editorOpen}
          aria-describedby={error ? errorId : undefined}
          onClick={() => onEdit(node.key)}
        >
          <Icon name="pencil-simple" aria-hidden="true" size="sm" />
          <span>{editorOpen ? "编辑中" : "编辑"}</span>
        </button>
      </div>
      {error ? (
        <ErrorAlert
          id={errorId}
          error={error}
          hint="打开编辑区查看当前内容、输入与模型设置，再按报错指引继续。"
        />
      ) : null}
    </div>
  );
}
