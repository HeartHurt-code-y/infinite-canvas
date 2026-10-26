import { Handle, Position, getBezierPath, type EdgeProps, type NodeProps } from "@xyflow/react";
import { memo, useState } from "react";
import type { CanvasFlowEdge, CanvasFlowNode } from "./workspaceModel";
import "./CanvasNodeCard.css";

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

/**
 * 连接手柄的内容：原站 liblib 的手柄本体是 0×0 的不可见元素，里面套一个 80×80 的
 * 圆形命中区，命中区正中再放一枚 20×20 的可见旋钮（圆 + 描边 + 十字）。
 * 旋钮默认透明，节点悬停 / 选中时才显形。
 */
function CanvasHandleKnob() {
  return (
    <>
      <span className="canvas-flow-handle__hit" aria-hidden="true" />
      <span className="canvas-flow-handle__knob" aria-hidden="true">
        <svg width={20} height={20} viewBox="0 0 20 20" fill="none" focusable="false">
          <circle cx={10} cy={10} r={9.35} className="canvas-flow-handle__knob-fill" />
          <circle cx={10} cy={10} r={9.35} className="canvas-flow-handle__knob-ring" />
          <path d="M10 6.5v7M6.5 10h7" className="canvas-flow-handle__knob-plus" />
        </svg>
      </span>
    </>
  );
}

/**
 * 节点视图以 memo 包裹：上游（WorkspaceApp）用 per-node 输入浅比较保证 data 引用
 * 在节点内容未变化时保持稳定，因此这里按引用比较即可跳过整棵卡片子树的渲染。
 * 选中高亮由 React Flow 加在包装层的 `selected` 类驱动，不经过 data。
 */
export const CanvasFlowNodeView = memo(function CanvasFlowNodeView({
  data,
  selected,
}: NodeProps<CanvasFlowNode>) {
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
      {selected && data.floatingToolbar ? data.floatingToolbar : null}
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
        >
          <CanvasHandleKnob />
        </Handle>
      ) : null}
      {data.hasSourceHandle ? (
        <Handle
          id="source"
          type="source"
          position={Position.Right}
          className="canvas-flow-handle canvas-flow-handle--source"
          aria-label={data.sourceHandleLabel ?? "节点输出端口"}
        >
          <CanvasHandleKnob />
        </Handle>
      ) : null}
    </div>
  );
});

/**
 * 原站连线高亮的「流动段」（实测 DOM）：
 * 8 条同路径的描边叠加，dasharray 统一按 pathLength=300 归一化，
 * 12px / 7px / 4px 三层底纹 + 5 段透明度递增的彗头，整体 3s 线性循环。
 */
const EDGE_FLOW_SEGMENTS = [
  { dash: "36 64", width: 12, opacity: 0.06, cap: "round" },
  { dash: "36 64", width: 7, opacity: 0.12, cap: "round" },
  { dash: "36 64", width: 4, opacity: 0.15, cap: "butt" },
  { dash: "0 6 30 64", width: 4, opacity: 0.176, cap: "butt" },
  { dash: "0 12 24 64", width: 4, opacity: 0.214, cap: "butt" },
  { dash: "0 18 18 64", width: 4, opacity: 0.273, cap: "butt" },
  { dash: "0 24 12 64", width: 4, opacity: 0.375, cap: "butt" },
  { dash: "0 30 6 64", width: 4, opacity: 0.6, cap: "butt" },
] as const;

/**
 * 边视图同样以 memo 包裹：上游按 per-edge 输入浅比较保证 data 引用在连线内容
 * 未变化时稳定，这里按引用比较即可跳过重渲染；节点拖动只影响两端坐标 props。
 */
export const CanvasFlowEdgeView = memo(function CanvasFlowEdgeView({
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
  const [hovered, setHovered] = useState(false);
  const [path] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const flowing = selected === true || hovered;
  return (
    <>
      {/*
        可见连线：原站所有连线同色同宽（#86909c / 2px），不按来源类型分色，
        悬停与选中只换描边色。类名沿用上游给出的 edgeClassName（测试据此定位连线），
        但颜色与线型统一由 .canvas-flow-edge__line 接管。
      */}
      <path
        id={id}
        d={path}
        className={`canvas-flow-edge__line ${data?.edgeClassName ?? ""}`}
        fill="none"
        strokeWidth={2}
      />
      {data?.removable ? (
        <path
          d={path}
          className="canvas-flow-edge__hit"
          role="button"
          tabIndex={0}
          aria-label={`选择连线：${data.label}；按 Delete 删除`}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
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
      {flowing ? (
        <g className="canvas-flow-edge__flow">
          {EDGE_FLOW_SEGMENTS.map((segment) => (
            <path
              key={segment.dash}
              d={path}
              pathLength={300}
              strokeDasharray={segment.dash}
              strokeWidth={segment.width}
              strokeOpacity={segment.opacity}
              strokeLinecap={segment.cap}
            />
          ))}
        </g>
      ) : null}
    </>
  );
});
