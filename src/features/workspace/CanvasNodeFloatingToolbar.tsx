import { CanvasChromeIcon, type CanvasChromeIconName } from "./CanvasChromeIcons";
import "./CanvasNodeFloatingToolbar.css";

/**
 * 节点浮动工具条：对齐 liblib.tv 画布「选中节点后浮在节点上方」的那一条。
 *
 * 逆向依据：docs/integrations/liblib-canvas-re.md 第 2.3 / 3.2 节。
 * 原站的容器类是
 *   `.node-floating-ui.transition-[transform,opacity].duration-150.ease-out
 *    .absolute.left-0.origin-bottom-left`
 * 实测高度 24px —— 它贴在节点**上沿外侧**，不是节点内部的一条工具行。
 *
 * 条目与原站一一对应（全景 / 多角度 / 打光 / 九宫格 / 高清 / 元素编辑 /
 * 图层分离 / 宫格切分）。原站这几项都是图像 AI 编辑能力，本项目后端尚未
 * 提供，按 AGENTS.md「后端暂未接入」的约定：结构定死、交互做全、点击给出
 * 明确说明，不静默失败。
 */
export interface CanvasNodeFloatingToolbarItem {
  readonly id: string;
  readonly label: string;
  readonly icon: CanvasChromeIconName;
  /** 带下拉箭头的项（原站的九宫格 / 高清 / 宫格切分）。 */
  readonly hasMenu?: boolean;
  /** 该项对应的能力是否已接入。 */
  readonly available?: boolean;
  readonly onSelect: (id: string) => void;
}

export interface CanvasNodeFloatingToolbarProps {
  readonly items: readonly CanvasNodeFloatingToolbarItem[];
  /** 工具条的无障碍名，例如「图片节点工具」。 */
  readonly label: string;
}

export function CanvasNodeFloatingToolbar({ items, label }: CanvasNodeFloatingToolbarProps) {
  return (
    <div className="node-floating-ui" role="toolbar" aria-label={label}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className="node-floating-ui__item"
          aria-label={item.label}
          data-tooltip={item.available === false ? `${item.label}（后端暂未接入）` : item.label}
          onClick={(event) => {
            event.stopPropagation();
            item.onSelect(item.id);
          }}
        >
          <CanvasChromeIcon name={item.icon} size={16} />
          <span className="node-floating-ui__label">{item.label}</span>
          {item.hasMenu ? (
            <CanvasChromeIcon name="angle" size={12} className="node-floating-ui__caret" />
          ) : null}
        </button>
      ))}
    </div>
  );
}
