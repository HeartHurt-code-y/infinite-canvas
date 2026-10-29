import { useEffect, useRef, type ReactNode } from "react";
import { ErrorAlert } from "../../components/ErrorAlert";
import { Icon, type IconName } from "../../components/Icon";
import { CanvasNodeEditorShell } from "./CanvasNodeEditor";
import { CanvasNodeTitle } from "./VideoGenerationNode";
import { PROMPT_NODE_WIDTH, type CanvasNodeDimensions } from "./workspaceModel";

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
  onRename,
  children,
  cardBody,
  floatingPanel,
  expandEditorOnOpen = false,
}: NodeEditingProps & {
  readonly node: {
    readonly key: string;
    readonly kind: string;
    readonly name?: string | undefined;
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
  readonly onRename?: ((key: string, name: string) => void) | undefined;
  readonly children: ReactNode;
  /**
   * 卡片主体：给了就用它替换默认的「内容摘要」块。
   *
   * 文本节点的空态「尝试：」卡片走这条路径 —— 逆向规格见
   * `docs/integrations/liblib-text-node-re.md` 第 2 节。
   */
  readonly cardBody?: ReactNode | undefined;
  /**
   * 贴在卡片下沿的浮层（绝对定位在卡片根节点里，锚点是卡片自己）。
   *
   * 文本节点选中时出现的悬浮生成器面板走这条路径 —— 见
   * `docs/integrations/liblib-text-node-re.md` 第 4 节。
   */
  readonly floatingPanel?: ReactNode | undefined;
  readonly expandEditorOnOpen?: boolean;
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
        name={node.name?.trim() || kindLabel}
        kindLabel={kindLabel}
        anchor={{
          x: node.x,
          y: node.y,
          width: node.measured?.width ?? (node.kind === "prompt" ? PROMPT_NODE_WIDTH : 622),
          height: node.measured?.height ?? 400,
        }}
        open={editorOpen}
        expandOnOpen={expandEditorOnOpen}
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
      <div className="canvas-content-preview__surface">
        <div className="canvas-gen-node__header">
          <span className="canvas-gen-node__type">
            <span className="canvas-gen-node__type-icon" aria-hidden="true">
              <Icon name={icon} size="md" />
            </span>
            <span className="canvas-gen-node__type-copy">
              {onRename ? (
                <CanvasNodeTitle
                  title={node.name?.trim() || kindLabel}
                  onRename={(name) => onRename(node.key, name)}
                />
              ) : <strong>{kindLabel}</strong>}
            </span>
          </span>
        </div>
        {cardBody ?? (
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
        )}
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
        {floatingPanel}
      </div>
    </div>
  );
}
