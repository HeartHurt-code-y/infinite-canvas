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
import { Icon } from "./Icon";
import "./CanvasSelect.css";

const VIEWPORT_MARGIN = 8;
const VIEWPORT_SELECTOR = ".react-flow__viewport";

export interface CanvasSelectOption {
  readonly value: string;
  readonly label: string;
}

interface Placement {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly maxHeight: number;
}

function placeMenu(anchor: HTMLElement): Placement {
  const rect = anchor.getBoundingClientRect();
  const width = Math.max(rect.width, 200);
  const spaceBelow = window.innerHeight - rect.bottom - VIEWPORT_MARGIN;
  const spaceAbove = rect.top - VIEWPORT_MARGIN;
  const placeAbove = spaceBelow < 160 && spaceAbove > spaceBelow;
  const maxHeight = Math.max(140, Math.min(320, placeAbove ? spaceAbove : spaceBelow));
  const left = Math.min(
    Math.max(VIEWPORT_MARGIN, rect.left),
    Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN),
  );
  const top = placeAbove
    ? Math.max(VIEWPORT_MARGIN, rect.top - maxHeight - 6)
    : Math.min(rect.bottom + 6, window.innerHeight - VIEWPORT_MARGIN);
  return { top, left, width, maxHeight };
}

/**
 * 画布节点内的下拉选择：按钮 + portal 菜单，替代工作流卡片里的原生 `<select>`。
 *
 * 为什么不用原生 select：工作流卡片的参数区是用户切换最频繁的控件，而原生
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
}: {
  readonly ariaLabel: string;
  readonly value: string;
  readonly options: readonly CanvasSelectOption[];
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean;
  readonly required?: boolean;
  readonly id?: string;
  readonly className?: string;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
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
    const trigger = triggerRef.current;
    const list = listRef.current;
    if (trigger != null && list != null) {
      const box = placeMenu(trigger);
      list.style.top = `${box.top}px`;
      list.style.left = `${box.left}px`;
      list.style.width = `${box.width}px`;
      list.style.maxHeight = `${box.maxHeight}px`;
      list.focus();
    }
    const apply = () => {
      if (trigger == null || listRef.current == null) return;
      const box = placeMenu(trigger);
      const menu = listRef.current;
      menu.style.top = `${box.top}px`;
      menu.style.left = `${box.left}px`;
      menu.style.width = `${box.width}px`;
      menu.style.maxHeight = `${box.maxHeight}px`;
    };
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
  }, [open]);

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
            document.body,
          )
        : null}
    </>
  );
}
