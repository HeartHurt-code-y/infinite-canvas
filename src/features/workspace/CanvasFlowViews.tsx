import { Handle, Position, getBezierPath, useStore, type EdgeProps, type NodeProps } from "@xyflow/react";
import { memo, useCallback, useState } from "react";
import type { CanvasFlowEdge, CanvasFlowNode } from "./workspaceModel";
import { LibTVMediaIcon } from "./LibTVMediaIcon";
import "./CanvasNodeCard.css";

const CANVAS_NODE_INTERACTIVE_SELECTOR = [
  "button:not(.canvas-asset-node__preview-button, .canvas-asset-group__chip, .canvas-node-toolbar__label--editable)",
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

function CanvasHandleKnob() {
  return (
    <span className="canvas-flow-handle__knob" aria-hidden="true">
      <span className="canvas-flow-handle__circle"><LibTVMediaIcon name="plus-s" size={14} /></span>
    </span>
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
  isConnectable,
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
          /*
           * 手柄进入 Tab 序列（仅节点被选中时），这样「引用该节点生成」不只有鼠标
           * 一条路：焦点落在手柄上按 Enter / Space 即弹出同一张「添加节点」菜单。
           * 每个节点都有两个手柄，全量可聚焦会让大画布上的 Tab 变得很长，所以
           * 只有选中节点的两个手柄参与 Tab 序列。
           *
           * 手柄现在**有动作**了（打开菜单），所以要按可交互控件报读：
           * role=button 让读屏说「按钮」，aria-haspopup=menu 说明它会弹出菜单，
           * aria-keyshortcuts 给出按键。缺了 role 的话，读屏只会报一个无名的分组，
           * 键盘用户根本不知道这里能按。
           */
          role="button"
          aria-haspopup="menu"
          aria-keyshortcuts="Enter Space"
          isConnectable={isConnectable}
          tabIndex={selected && isConnectable ? 0 : -1}
          onClick={(event) => event.stopPropagation()}
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
          role="button"
          aria-haspopup="menu"
          aria-keyshortcuts="Enter Space"
          isConnectable={isConnectable}
          tabIndex={selected && isConnectable ? 0 : -1}
          onClick={(event) => event.stopPropagation()}
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
  source,
  target,
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
  const endpointSelected = useStore(useCallback(
    (state) => Boolean(state.nodeLookup.get(source)?.selected || state.nodeLookup.get(target)?.selected),
    [source, target],
  ));
  const [path] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const flowing = selected === true || hovered || endpointSelected;
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
        data-highlight={hovered || endpointSelected || undefined}
        strokeWidth={hovered ? 4 : selected ? 3 : 2}
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
