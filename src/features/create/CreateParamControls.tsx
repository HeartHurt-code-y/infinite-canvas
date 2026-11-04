import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useDismissOnOutside, useCreateFloatingLayerAnchor } from "./useFloatingLayerAnchor";
import { JimengIcon } from "./JimengIcon";
import type { ModelParameterCapability, ModelParameterValue } from "../../lib/modelCapabilities";
import type { ParameterGroup } from "./createModel";

/**
 * 创作台的浮层面板（参数面板 / 时长面板）。
 *
 * 挂在 document.body 上、按视口定位、朝触发器上方弹出——与即梦一致：
 * 浮坞贴底，参数面板必须向上开，否则会被视口底边切掉。
 *
 * 面板顶边由**实测高度**推出（面板底边贴触发器顶边上方 8px），
 * 不是拿高度上限顶上去——那样面板会飘离触发器。
 */
function CreatePopover({
  open,
  onClose,
  anchorRef,
  preferAbove = true,
  minWidth = 256,
  className,
  ariaLabel,
  children,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly anchorRef: React.RefObject<HTMLElement | null>;
  readonly preferAbove?: boolean;
  readonly minWidth?: number;
  readonly className?: string;
  readonly ariaLabel?: string;
  readonly children: ReactNode;
}) {
  const { ref: panelRef, layerId } = useCreateFloatingLayerAnchor<HTMLDivElement>({
    open,
    anchorRef,
    preferAbove,
    minWidth,
    maxHeight: 420,
  });
  useDismissOnOutside(open, panelRef, anchorRef, onClose, layerId);

  if (!open) return null;
  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={ariaLabel}
      className={className ?? "create-popover"}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

/**
 * 一组参数的单选组：与即梦参数面板一致，选项排成可换行的胶囊。
 *
 * **数量组例外（仅图片档）**：即梦图片档把「生成数量」做成工具条上**独立**的
 * 一个按钮（实测：触发器 55×32、文案「2张」，浮层 320×97 / 圆角 16 / 内边距 16，
 * 里面是一排 8 个 34×36 的数字磁贴，**没有分组标题**）。
 * 但视频档的「选择生成数量」仍是参数面板里的一个普通分组（胶囊排布）。
 * 所以磁贴排布只在「这一组就是数量、且独占一个面板」时启用。
 */
function ParameterGroupView({
  group,
  values,
  onChange,
  tiles = false,
}: {
  readonly group: ParameterGroup;
  readonly values: Readonly<Record<string, ModelParameterValue>>;
  readonly onChange: (key: string, value: ModelParameterValue) => void;
  readonly tiles?: boolean;
}) {
  if (tiles && group.id === "count") {
    return (
      <div className="create-popover__group create-popover__group--tiles">
        {group.capabilities.map((capability: ModelParameterCapability) => {
          const current = values[capability.key] ?? capability.defaultValue;
          return (
            <div key={capability.key} className="create-radio-group__row" role="radiogroup">
              {capability.options.map((option) => (
                <button
                  key={`${capability.key}-${String(option.value)}`}
                  type="button"
                  role="radio"
                  aria-checked={option.value === current}
                  className="create-radio create-radio--tile"
                  onClick={() => onChange(capability.key, option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          );
        })}
      </div>
    );
  }
  return (
    <div className="create-popover__group">
      <div className="create-popover__title">{group.title}</div>
      <div className="create-radio-group" role="radiogroup" aria-label={group.title}>
        {group.capabilities.map((capability: ModelParameterCapability) => {
          const current = values[capability.key] ?? capability.defaultValue;
          const known = capability.options.some((option) => option.value === current);
          return (
            <span key={capability.key} className="create-radio-group__row">
              {known ? null : (
                <button
                  type="button"
                  className="create-radio create-radio--current"
                  disabled
                  title="当前值不在该模型的可选范围内"
                >
                  {String(current)}（当前值）
                </button>
              )}
              {capability.options.map((option) => (
                <button
                  key={`${capability.key}-${String(option.value)}`}
                  type="button"
                  role="radio"
                  aria-checked={option.value === current}
                  className="create-radio"
                  onClick={() => onChange(capability.key, option.value)}
                >
                  {option.label}
                </button>
              ))}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 参数控件：触发按钮显示当前取值摘要，点开是分组参数面板。
 *
 * 摘要文案对应即梦的「16:9 480P 1」——比例、分辨率、数量依次排开；
 * 某项没有取值就不占位（换模型后旧的键会自然消失）。
 */
export function CreateParamControl({
  ariaLabel,
  summary,
  icon,
  aiMark = false,
  groups,
  values,
  onChange,
  emptyHint,
  panelMinWidth,
}: {
  readonly ariaLabel: string;
  /** 按钮文案；数组按段渲染，段与段之间插即梦那个 3×3 圆点分隔。 */
  readonly summary: string | readonly string[];
  /**
   * 前置图标。
   *
   * 即梦的参数/数量按钮都是「图标在前、文字在后」且**没有下拉箭头**：
   *   · 参数按钮：16×16 画框图标 + 「智能比例」+ 圆点 + 「2K」
   *   · 数量按钮：1em 叠图图标 + 「2张」
   * 所以这里不再渲染尾部的 caret。
   */
  readonly icon?: ReactNode;
  /**
   * 末尾挂即梦那枚蓝色 ✦。
   *
   * 即梦给「新模型 / 新能力」挂标记（截图里是「智能比例 · 2K ✦」）。
   */
  readonly aiMark?: boolean;
  readonly groups: readonly ParameterGroup[];
  readonly values: Readonly<Record<string, ModelParameterValue>>;
  readonly onChange: (key: string, value: ModelParameterValue) => void;
  readonly emptyHint?: string;
  /**
   * 面板最小宽度。
   *
   * 即梦实测：参数面板 336 宽（视频档 `16:9 480P 1` 那块），
   * 数量面板 320 宽（图片档「2张」那块）。
   */
  readonly panelMinWidth?: number;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  if (groups.length === 0 && !emptyHint) return null;

  const parts = typeof summary === "string" ? [summary] : summary;

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className="create-param-button"
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((previous) => !previous)}
      >
        {icon}
        {parts.map((part, index) => (
          <span key={`${part}-${index}`} className="create-param-button__part">
            {index > 0 ? (
              <span className="create-param-button__divider" aria-hidden="true" />
            ) : null}
            {part}
          </span>
        ))}
        {aiMark ? <JimengIcon name="toolAiMark" className="create-param-button__ai" /> : null}
      </button>
      <CreatePopover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={triggerRef}
        ariaLabel={ariaLabel}
        {...(panelMinWidth === undefined ? {} : { minWidth: panelMinWidth })}
      >
        {groups.length === 0 ? (
          <div className="create-popover__title">{emptyHint ?? "该模型没有可调参数"}</div>
        ) : (
          groups.map((group) => (
            <ParameterGroupView
              key={group.id}
              group={group}
              values={values}
              onChange={onChange}
              tiles={groups.length === 1}
            />
          ))
        )}
      </CreatePopover>
    </>
  );
}
