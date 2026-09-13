import { Icon } from "../../components/Icon";
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

import { CANVAS_QUICK_ADD_CHOICES, type CanvasQuickAddKind } from "./canvasQuickAddCatalog";
import "./ConnectionQuickAddMenu.css";

export interface ConnectionQuickAddMenuProps {
  readonly position: { readonly x: number; readonly y: number };
  readonly connectionMode?: boolean;
  readonly triggerElement?: HTMLElement | null;
  readonly onSelect: (kind: CanvasQuickAddKind) => void;
  readonly onClose: () => void;
}

const VIEWPORT_MARGIN = 8;

export function ConnectionQuickAddMenu({
  position,
  connectionMode = false,
  triggerElement,
  onSelect,
  onClose,
}: ConnectionQuickAddMenuProps) {
  const descriptionId = useId();
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonsRef = useRef<(HTMLButtonElement | null)[]>([]);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const tabCloseTimerRef = useRef<number | undefined>(undefined);
  const [focusedIndex, setFocusedIndex] = useState(0);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const bounds = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(
      VIEWPORT_MARGIN,
      Math.min(position.x, window.innerWidth - bounds.width - VIEWPORT_MARGIN),
    )}px`;
    menu.style.top = `${Math.max(
      VIEWPORT_MARGIN,
      Math.min(position.y, window.innerHeight - bounds.height - VIEWPORT_MARGIN),
    )}px`;
  }, [position.x, position.y]);

  useLayoutEffect(() => {
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement && !menuRef.current?.contains(activeElement)) {
      previousFocusRef.current = activeElement;
    }
    buttonsRef.current[0]?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    function handleOutsidePointerDown(event: PointerEvent) {
      if (
        event.target instanceof Node &&
        !menuRef.current?.contains(event.target) &&
        !triggerElement?.contains(event.target)
      ) {
        onClose();
      }
    }
    document.addEventListener("pointerdown", handleOutsidePointerDown, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("pointerdown", handleOutsidePointerDown, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose, triggerElement]);

  useEffect(() => () => window.clearTimeout(tabCloseTimerRef.current), []);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      if (previousFocusRef.current?.isConnected) {
        previousFocusRef.current.focus({ preventScroll: true });
      }
      return;
    }
    if (event.key === "Tab") {
      // Let the browser move focus before removing the currently focused menu item.
      tabCloseTimerRef.current = window.setTimeout(onClose, 0);
      return;
    }
    const currentIndex = buttonsRef.current.findIndex(
      (button) => button === document.activeElement,
    );
    let nextIndex: number;
    switch (event.key) {
      case "ArrowDown":
        nextIndex = (currentIndex + 1) % CANVAS_QUICK_ADD_CHOICES.length;
        break;
      case "ArrowUp":
        nextIndex =
          (currentIndex + CANVAS_QUICK_ADD_CHOICES.length - 1) % CANVAS_QUICK_ADD_CHOICES.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = CANVAS_QUICK_ADD_CHOICES.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    buttonsRef.current[nextIndex]?.focus();
  }

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label="添加节点"
      aria-describedby={descriptionId}
      className="connection-quick-add-menu nodrag nopan nowheel"
      style={{ left: position.x, top: position.y }}
      onKeyDown={handleKeyDown}
      onKeyUp={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onTouchStart={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <div className="connection-quick-add-menu__heading" role="presentation">
        <strong>添加节点</strong>
        <span id={descriptionId}>
          {connectionMode ? "选择后创建并自动连线" : "选择后在画布创建节点"}
        </span>
      </div>
      {CANVAS_QUICK_ADD_CHOICES.map(({ kind, label, icon }, index) => (
        <button
          key={kind}
          ref={(button) => {
            buttonsRef.current[index] = button;
          }}
          type="button"
          role="menuitem"
          tabIndex={index === focusedIndex ? 0 : -1}
          className={`connection-quick-add-menu__item connection-quick-add-menu__item--${kind}`}
          onFocus={() => setFocusedIndex(index)}
          onClick={() => onSelect(kind)}
        >
          <Icon name={icon} size="xl" />
          <span>{label}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}
