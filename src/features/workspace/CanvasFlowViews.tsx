import { X } from "@phosphor-icons/react/X";
import {
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  Position,
  getBezierPath,
  type EdgeProps,
  type NodeProps,
} from "@xyflow/react";
import type { CanvasFlowEdge, CanvasFlowNode } from "./workspaceModel";

const CANVAS_NODE_INTERACTIVE_SELECTOR = [
  "button:not(.canvas-asset-node__preview-button)",
  "input",
  "textarea",
  "select",
  "option",
  "label",
  "a",
  "video[controls]",
  "audio[controls]",
  "[contenteditable='true']",
  "[role='button']:not(.canvas-asset-node__preview-button)",
  "[role='textbox']",
  "[role='slider']",
  "[role='combobox']",
  "[role='listbox']",
  "[role='option']",
  ".react-flow__handle",
].join(",");

/**
 * React Flow 在原生 mousedown 冒泡到节点包装层时检查 `.nodrag`。在捕获阶段给实际
 * 交互控件补上该标记，既能让卡片空白区整卡拖动，也不会抢走输入和按钮手势。
 */
function protectCanvasControlFromDrag(target: EventTarget | null, boundary: HTMLElement): void {
  if (!(target instanceof Element)) return;
  const control = target.closest<HTMLElement>(CANVAS_NODE_INTERACTIVE_SELECTOR);
  if (control != null && boundary.contains(control)) control.classList.add("nodrag");
}

export function CanvasFlowNodeView({ data }: NodeProps<CanvasFlowNode>) {
  return (
    <div
      className="canvas-flow-node"
      onMouseDownCapture={(event) =>
        protectCanvasControlFromDrag(event.target, event.currentTarget)
      }
      onPointerDownCapture={(event) =>
        protectCanvasControlFromDrag(event.target, event.currentTarget)
      }
      onTouchStartCapture={(event) =>
        protectCanvasControlFromDrag(event.target, event.currentTarget)
      }
    >
      {data.content}
      {data.inputSummary ? (
        <div className="canvas-flow-input-summary" role="status" title={data.inputDetails}>
          {data.inputSummary}
        </div>
      ) : null}
      {data.hasTargetHandle ? (
        <Handle
          id="target"
          type="target"
          position={Position.Left}
          className={`canvas-flow-handle canvas-flow-handle--target${data.highlightTarget ? " canvas-flow-handle--highlight" : ""}`}
          aria-label="节点输入端口"
        />
      ) : null}
      {data.hasSourceHandle ? (
        <Handle
          id="source"
          type="source"
          position={Position.Right}
          className="canvas-flow-handle canvas-flow-handle--source"
          aria-label="节点输出端口"
        />
      ) : null}
    </div>
  );
}

export function CanvasFlowEdgeView({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
  data,
}: EdgeProps<CanvasFlowEdge>) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  return (
    <>
      <BaseEdge id={id} path={path} className={data?.edgeClassName} />
      {data?.removable ? (
        <path
          d={path}
          className="canvas-flow-edge__hit"
          role="button"
          tabIndex={0}
          aria-label={`选择连线：${data.label}；按 Delete 删除`}
          onClick={(event) => {
            event.stopPropagation();
            event.currentTarget.focus();
            data.onSelect();
          }}
          onKeyDown={(event) => {
            if (event.key === "Delete" || event.key === "Backspace") {
              event.preventDefault();
              data.onRemove();
            } else if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              data.onSelect();
            }
          }}
        />
      ) : null}
      <EdgeLabelRenderer>
        {data?.order ? (
          <span
            className="canvas-flow-edge__order nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            aria-hidden="true"
          >
            {data.order}
          </span>
        ) : null}
        {selected && data ? (
          <button
            type="button"
            className="canvas-flow-edge__delete nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            aria-label={`删除连线：${data.label}`}
            onClick={(event) => {
              event.stopPropagation();
              data.onRemove();
            }}
          >
            <X size={12} weight="bold" aria-hidden="true" />
          </button>
        ) : null}
      </EdgeLabelRenderer>
    </>
  );
}
