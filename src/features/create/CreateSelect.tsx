import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Icon } from "../../components/Icon";
import { JimengIcon } from "./JimengIcon";
import { useDismissOnOutside, useCreateFloatingLayerAnchor } from "./useFloatingLayerAnchor";

export interface CreateSelectOption {
  readonly value: string;
  readonly label: string;
  /**
   * 次要说明行。
   *
   * 即梦的模型下拉每一项都是「名称 + 卖点」两行（实测：封面图 + 模式角标 +
   * 名称 + 一句能力描述）。这里保留同样的信息层级：名称决定「选哪个」，
   * 说明行决定「为什么选它」。
   */
  readonly description?: string;
  /**
   * 选项的 tooltip 文本。
   *
   * 即梦对「本地区不可用」的选项就是挂 tooltip（源码
   * `extra.tooltipProps.content`，zh-Hans 实际值「此功能在您所在的地区不可用」）。
   * 本项目用它放放不下的那句具体原因。
   */
  readonly title?: string;
  /**
   * 名称右侧的小角标。
   *
   * 即梦在技能下拉里给官方技能挂了一枚「官方」角标（实测 26×16、圆角 4、
   * 底 `rgba(255,255,255,.08)`、字 9/12 字重 500）。本项目用它标注
   * 「后端暂未接入」的创作类型——角标在**同一行**里，不额外占高度，
   * 所以选项行高仍是即梦那套 36px。
   */
  readonly badge?: string;
  /**
   * 选项左侧的图标。
   *
   * 即梦的「创作类型」下拉每一项都带一枚 16×16 的图标（Agent 模式是双斜杠、
   * 图片生成是图片、视频生成是镜头……），实测类名 `select-option-icon-*`。
   */
  readonly icon?: ReactNode;
}

export interface CreateSelectProps {
  readonly ariaLabel: string;
  readonly value: string | null;
  readonly options: readonly CreateSelectOption[];
  readonly onChange: (value: string) => void;
  /** 创作类型是这一排里唯一带品牌色的项。 */
  readonly primary?: boolean;
  readonly icon?: ReactNode;
  readonly className?: string;
  /**
   * 浮层顶部的小标题。
   *
   * 即梦的下拉分两种：带标题的（创作类型 → 标题「创作类型」）与不带标题的
   * （模型、参数）。实测标题为 12/12、色 rgba(255,255,255,.35)、
   * 内边距 12px 12px 8px。
   */
  readonly title?: string;
  /** 选中项右侧打勾。实测即梦的创作类型下拉有，模型下拉没有。 */
  readonly showCheck?: boolean;
  /** 浮层最小宽度；默认 200（实测即梦创作类型浮层就是 200）。 */
  readonly popoverWidth?: number;
  /**
   * 宽版浮层（即梦的**模型**下拉）。
   *
   * 源码口径（chunk `content-generator-feature-loader-7`）：
   *   `.trigger-wc2vGe.lv-trigger .lv-select-popup{ border-radius:16px }`
   *   `.trigger-wc2vGe.lv-trigger .lv-select-popup .lv-select-option{ border-radius:12px }`
   * 且模型下拉的触发器宽 440px → 浮层也是 440。
   * 创作类型下拉保持 200 / 圆角 12。
   */
  readonly wide?: boolean;
  /**
   * 「指定了但列表里没有」时的兜底文案（陈旧 id）。
   *
   * 必须由调用方按**这个下拉是什么**来给：写死「默认模型」会让创作类型下拉、
   * 能力模式下拉也显示「默认模型」——图标是音频波形、文案却是另一个类型，
   * 语义完全错位。模型下拉传「默认模型」，创作类型传「创作类型」，
   * 能力模式传「默认模式」。
   */
  readonly fallbackLabel?: string;
}

/**
 * 创作台的下拉选择：按钮触发 + portal 菜单。
 *
 * 为什么不用原生 `<select>`：
 *   - 原生下拉在桌面端无法定制触发区外观（模型名要带副标题，图标也放不下）；
 *   - 原生弹层由浏览器绘制，在 WebView2 / WKWebView 的非整数缩放下点击经常落空；
 *   - 创作台的参数工具条是横向滚动容器（`overflow-x: auto`），原生弹层会被裁。
 *
 * 与画布节点的 `CanvasSelect` 的分工：定位规则共用 `components/floatingLayer.ts`，
 * 外观各自一套——画布用节点卡片的纸面令牌，创作台用浮坞的深色令牌。
 *
 * 浮层挂在 document.body 上并按视口定位，因此既不会被工具条裁掉，
 * 也不会被画布缩放影响。
 */
export function CreateSelect({
  ariaLabel,
  value,
  options,
  onChange,
  primary = false,
  icon,
  className,
  title,
  showCheck = false,
  popoverWidth = 200,
  wide = false,
  fallbackLabel = "默认模型",
}: CreateSelectProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  /*
   * 选中项。
   *
   * 找不到匹配项时**不能**回落到第一项：下拉项的 id 体系与选中态不是同一套时
   * （创作类型就是这种情况：即梦的 option value 与本项目的 mode id 只重合一半），
   * 回落会把「音频生成」显示成「Agent 模式」——图标是音频波形、文案却是另一个
   * 类型，语义完全错位，而且用户一点就误切到 Agent 浮坞。
   *
   * 这里改为按当前 value 渲染兜底文案：宁可显示原始 id，也不冒充别的选项。
   */
  const matchedIndex = options.findIndex((option) => option.value === value);
  const selected = matchedIndex >= 0 ? options[matchedIndex] : undefined;
  /**
   * 兜底要分两种情况，之前的写法把两者混为一谈：
   *
   * 1. **没指定**（value 为 null）：实际生效的就是第一项，显示它才对。
   *    Agent 偏好面板的模型下拉默认就是 null（DEFAULT_AGENT_PREFERENCES），
   *    显示成空白会让「未指定模型时按目录里的默认模型提交」这句提示自相矛盾。
   * 2. **指定了但列表里没有**（陈旧 id，例如把产物类型从图片切到视频后模型列表变了）：
   *    显示占位文案，绝不显示裸 id——那是机器内部标识，对用户没有意义。
   */
  const fallbackText =
    value == null ? options[0]?.label : fallbackLabel;
  /** 没有候选项时把原因写在按钮上，而不是让按钮凭空消失。 */
  const emptyText = "暂无可选项";
  /** 打开菜单时的浏览起点：没有匹配项就从第一项开始。 */
  const selectedIndex = Math.max(0, matchedIndex);
  const optionId = useCallback((index: number) => `${listId}-option-${index}`, [listId]);
  /*
   * 带图标或带勾的选项要排成一行（图标 + 文字 + 右侧勾），
   * 没有的仍保持「名称 + 说明」两行的竖排。
   */
  const richOptions = showCheck || options.some((option) => option.icon !== undefined);

  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  const { ref: listRef } = useCreateFloatingLayerAnchor<HTMLDivElement>({
    open,
    anchorRef: triggerRef,
    minWidth: popoverWidth,
    maxHeight: 320,
  });
  useDismissOnOutside(open, listRef, triggerRef, () => setOpen(false));

  const commit = useCallback(
    (index: number) => {
      const option = options[index];
      if (option == null) return;
      if (option.value !== value) onChange(option.value);
      close();
    },
    [close, onChange, options, value],
  );

  useEffect(() => {
    if (!open) return;
    listRef.current?.focus();
  }, [open, listRef]);

  useEffect(() => {
    if (!open) return;
    const activeElement = listRef.current?.querySelector(`#${CSS.escape(optionId(active))}`);
    if (
      activeElement instanceof HTMLElement &&
      typeof activeElement.scrollIntoView === "function"
    ) {
      activeElement.scrollIntoView({ block: "nearest" });
    }
  }, [active, listRef, open, optionId]);

  /** 打开那一刻的选中项决定高亮起点；此后 options/value 变化不重置浏览位置。 */
  const openMenu = useCallback(() => {
    setActive(selectedIndex);
    setOpen(true);
  }, [selectedIndex]);

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      openMenu();
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open) close();
      else openMenu();
    }
  };

  const handleListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((current) => (options.length ? (current + 1) % options.length : 0));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((current) =>
        options.length ? (current - 1 + options.length) % options.length : 0,
      );
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setActive(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      setActive(Math.max(0, options.length - 1));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      commit(active);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };

  /*
   * 没有可选项时**不整个消失**。
   *
   * 之前直接 return null：能力目录还在加载（或该模型没有候选项）时，浮坞上的
   * 按钮凭空消失、整条工具条跟着跳动，用户既不知道按钮去哪了，也不知道为什么。
   * 现在渲染成一个禁用按钮并写明「暂无可选项」，位置不跳、原因可见。
   * （画布侧的 CanvasSelect 同样显示「没有可选项」，两处口径一致。）
   */
  const hasOptions = options.length > 0;

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        disabled={!hasOptions}
        className={[
          "create-select",
          primary ? "create-select--primary" : "",
          className ?? "",
          hasOptions ? "" : "create-select--empty",
        ]
          .filter(Boolean)
          .join(" ")}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => {
          if (!hasOptions) return;
          if (open) close();
          else openMenu();
        }}
        onKeyDown={handleTriggerKeyDown}
      >
        {icon}
        <span className="create-select__label">
          {hasOptions ? (selected?.label ?? fallbackText ?? "") : emptyText}
        </span>
        {/*
         * 下拉箭头用即梦原生的那枚（`.lv-select-arrow-icon`，1.2 半径的描边
         * 雪佛龙），不用项目通用图标库的 caret——形状不同一眼看得出来。
         */}
        <JimengIcon name="selectArrow" className="create-select__icon" />
      </button>
      {open
        ? createPortal(
            <div
              ref={listRef}
              id={listId}
              role="listbox"
              aria-label={ariaLabel}
              aria-activedescendant={optionId(active)}
              tabIndex={-1}
              className={`create-select__popover${wide ? " create-select__popover--wide" : ""}`}
              onKeyDown={handleListKeyDown}
            >
              {title ? <div className="create-select__title">{title}</div> : null}
              {options.map((option, index) => (
                /*
                 * 选项用 <div role="option">，不用 <button role="option">：
                 * 浮层走 aria-activedescendant 模式（焦点留在 listbox 上），
                 * 选项若可聚焦，Tab 会从 listbox 再钻进选项，形成双重焦点，
                 * 读屏也会把原生 button 语义和 role="option" 一起念。
                 * 与 CanvasSelect 的实现保持一致。
                 */
                <div
                  key={option.value}
                  role="option"
                  id={optionId(index)}
                  aria-selected={option.value === value}
                  className={`create-select__option${index === active ? " is-active" : ""}${
                    option.value === value ? " is-selected" : ""
                  }${richOptions ? " create-select__option--rich" : ""}`}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => commit(index)}
                  title={option.title}
                >
                  <span className="create-select__option-main">
                    {option.icon ? (
                      <span className="create-select__option-icon">{option.icon}</span>
                    ) : null}
                    <span className="create-select__option-label">{option.label}</span>
                    {option.badge ? (
                      <span className="create-select__option-badge">{option.badge}</span>
                    ) : null}
                    {option.description ? (
                      <span className="create-select__option-description">
                        {option.description}
                      </span>
                    ) : null}
                  </span>
                  {showCheck && option.value === value ? (
                    <Icon
                      name="check"
                      size="xs"
                      className="create-select__check"
                      aria-hidden="true"
                    />
                  ) : null}
                </div>
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
