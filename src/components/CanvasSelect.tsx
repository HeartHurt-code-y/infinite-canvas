import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { placeFloatingLayer } from "./floatingLayer";
import { Icon } from "./Icon";
import "./CanvasSelect.css";

const VIEWPORT_SELECTOR = ".react-flow__viewport";

export interface CanvasSelectOption {
  readonly value: string;
  readonly label: string;
}

/**
 * 画布节点内的下拉选择：按钮 + portal 菜单，替代节点卡片里的原生 `<select>`。
 *
 * 为什么不用原生 select：节点卡片的参数区是用户切换最频繁的控件，而原生
 * 弹层由浏览器画在 React Flow 的缩放层之外，在 WebView2 / WKWebView 的非整数
 * 缩放下点击经常落空——用户要点好几次（甚至切不动）。自绘菜单与画布共用
 * 同一套事件与坐标，所见即所得；对话框、素材库面板等不在画布节点里的
 * select 不受影响，继续用原生控件。
 *
 * 可访问性沿用 WAI-ARIA combobox（listbox popup）模式：触发按钮保留
 * role="combobox" 与原 aria-label（测试与读屏的可访问名不变），展开后焦点
 * 移到 listbox，方向键移动 aria-activedescendant，Enter 确认、Escape 关闭。
 */
export function CanvasSelect({
  ariaLabel,
  value,
  options,
  onChange,
  disabled = false,
  required = false,
  id,
  className,
  title,
  ariaDescribedBy,
}: {
  readonly ariaLabel: string;
  readonly value: string;
  readonly options: readonly CanvasSelectOption[];
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean | undefined;
  readonly required?: boolean | undefined;
  readonly id?: string | undefined;
  readonly className?: string | undefined;
  /** 触发按钮的悬浮说明（原生 select 的 title）。 */
  readonly title?: string | undefined;
  /** 指向错误说明的 id：让读屏与视觉提示都能拿到「下一步怎么办」。 */
  readonly ariaDescribedBy?: string | undefined;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  /*
   * 菜单的实际高度。CSS 的 `top` 锚定的是**顶边**，拿高度上限当高度算，
   * 菜单会整体上浮「上限 − 实际高度」px，与触发器之间裂开一条缝。
   * 这里量菜单自己的高度，量到后再定位。
   */
  const [measuredHeight, setMeasuredHeight] = useState<number | null>(null);
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const selected = options[selectedIndex];
  const optionId = useCallback((index: number) => `${listId}-option-${index}`, [listId]);

  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  const commit = useCallback(
    (index: number) => {
      const option = options[index];
      if (option == null) return;
      if (option.value !== value) onChange(option.value);
      close();
    },
    [close, onChange, options, value],
  );

  useLayoutEffect(() => {
    if (!open) return;
    const layer = listRef.current;
    if (layer == null) return;
    const measure = (): void => {
      const height = layer.getBoundingClientRect().height;
      setMeasuredHeight((current) =>
        current === null || Math.abs(current - height) > 0.5 ? height : current,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(layer);
    return () => observer.disconnect();
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const apply = (): void => {
      const menu = listRef.current;
      const trigger = triggerRef.current;
      if (menu == null || trigger == null) return;
      const box = placeFloatingLayer(trigger, {
        minWidth: 200,
        maxHeight: 320,
        /*
         * 画布节点的菜单**自动**选方向：下方够就朝下（贴着节点卡片），
         * 不够才朝上。创作台的浮坞贴底，才需要强制向上。
         */
        preferAbove: false,
        measuredHeight,
      });
      menu.style.top = `${box.top}px`;
      menu.style.left = `${box.left}px`;
      menu.style.width = `${box.width}px`;
      menu.style.maxHeight = `${box.maxHeight}px`;
    };
    apply();
    listRef.current?.focus();
    window.addEventListener("resize", apply);
    // capture：卡片容器内部滚动也要跟随，否则菜单会停在旧位置。
    window.addEventListener("scroll", apply, true);
    const viewport = document.querySelector(VIEWPORT_SELECTOR);
    const observer =
      viewport != null && typeof MutationObserver !== "undefined"
        ? new MutationObserver(apply)
        : null;
    if (observer != null && viewport != null) {
      observer.observe(viewport, { attributes: true, attributeFilter: ["style", "class"] });
    }
    const handleMousedown = (event: MouseEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        (listRef.current?.contains(target) || triggerRef.current?.contains(target))
      ) {
        return;
      }
      // 点击菜单外：关闭但不抢回焦点，别打断用户对下一个控件的点击。
      setOpen(false);
    };
    window.addEventListener("mousedown", handleMousedown, true);
    return () => {
      window.removeEventListener("resize", apply);
      window.removeEventListener("scroll", apply, true);
      window.removeEventListener("mousedown", handleMousedown, true);
      observer?.disconnect();
    };
  }, [open, measuredHeight]);

  useEffect(() => {
    if (!open) return;
    const activeElement = listRef.current?.querySelector(`#${CSS.escape(optionId(active))}`);
    // jsdom 没有实现 scrollIntoView；守卫让单测也能走完整交互。
    if (
      activeElement instanceof HTMLElement &&
      typeof activeElement.scrollIntoView === "function"
    ) {
      activeElement.scrollIntoView({ block: "nearest" });
    }
  }, [active, open, optionId]);

  /** 打开那一刻的选中项决定高亮起点；此后 options/value 变化不重置浏览位置。 */
  const openMenu = useCallback(() => {
    setActive(selectedIndex);
    setOpen(true);
  }, [selectedIndex]);

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
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

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        id={id}
        role="combobox"
        aria-label={ariaLabel}
        aria-required={required || undefined}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listId : undefined}
        aria-describedby={ariaDescribedBy}
        title={title}
        // 当前值原样挂在 DOM 上：原生 select 的 value 语义在自绘按钮上没有对应物，
        // 测试与调试都需要它来确认「现在选的是哪个」。
        data-value={value}
        className={`canvas-select${className ? ` ${className}` : ""}`}
        disabled={disabled}
        onClick={() => {
          if (open) close();
          else openMenu();
        }}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className="canvas-select__value">{selected?.label ?? ""}</span>
        <Icon name="caret-down" aria-hidden="true" size="xs" />
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
              className="canvas-select__menu"
              onKeyDown={handleListKeyDown}
            >
              {options.length === 0 ? (
                <div className="canvas-select__empty">没有可选项</div>
              ) : (
                options.map((option, index) => (
                  <div
                    key={option.value}
                    role="option"
                    id={optionId(index)}
                    aria-selected={option.value === value}
                    // 选项值原样挂在 DOM 上：测试按值选项，不必把值翻译成展示文案。
                    data-value={option.value}
                    className={`canvas-select__option${index === active ? " is-active" : ""}${option.value === value ? " is-selected" : ""}`}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => commit(index)}
                  >
                    <span className="canvas-select__option-label">{option.label}</span>
                    {option.value === value ? (
                      <Icon name="check" aria-hidden="true" size="xs" />
                    ) : null}
                  </div>
                ))
              )}
            </div>,
            // 原生 modal dialog 外部会被浏览器置为 inert，菜单必须留在该对话框里。
            triggerRef.current?.closest("dialog") ?? document.body,
          )
        : null}
    </>
  );
}
