import { memo } from "react";
import { CanvasChromeIcon } from "./CanvasChromeIcons";
import {
  CANVAS_TEXT_TRY_ACTIONS,
  type CanvasTextTryActionKey,
} from "./canvasTextTryActionCatalog";
import "./CanvasTextGenerator.css";

/**
 * 文本节点空态的「尝试：」卡片。
 *
 * 逆向规格见 `docs/integrations/liblib-text-node-re.md` 第 2 节：
 * - 「尝试：」是 14px `#919191` 的小标题，下面一行纵向排列的按钮；
 * - 按钮 14px 字、内边距 8px 12px、圆角 8px、图标 14×14；
 * - 按钮右侧的补充说明（hint）默认透明，悬停时才显现。
 *
 * 按钮点击要**吃掉冒泡**：节点的 mousedown 会开始拖拽，点「尝试」不该把节点拖走。
 */
export const CanvasTextTryActions = memo(function CanvasTextTryActions({
  onAction,
  disabled = false,
  compact = false,
}: {
  readonly onAction: (key: CanvasTextTryActionKey) => void;
  /** 只读态（受限体验策略命中）下整个区块不渲染。 */
  readonly disabled?: boolean;
  /** 画布卡片显示方形底板；独立编辑区只显示动作内容。 */
  readonly compact?: boolean;
}) {
  if (disabled) {
    return null;
  }
  return (
    <div className={`canvas-text-try${compact ? " canvas-text-try--compact" : ""}`}>
      <CanvasChromeIcon
        name="text-lines"
        size={90}
        className="canvas-text-try__icon"
      />
      <div className="canvas-text-try__actions">
        <span className="canvas-text-try__label">尝试：</span>
        <div className="canvas-text-try__list">
          {CANVAS_TEXT_TRY_ACTIONS.map((action) => (
            <button
              key={action.key}
              type="button"
              className="canvas-text-try__item"
              data-tooltip={action.hint}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onAction(action.key);
              }}
            >
              <CanvasChromeIcon name={action.icon} size={14} />
              <span className="canvas-text-try__item-label">{action.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
});
