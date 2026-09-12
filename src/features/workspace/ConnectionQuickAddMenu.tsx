import { Icon, type IconName } from "../../components/Icon";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

import { type CanvasGenNodeKind } from "./workspaceModel";
import "./ConnectionQuickAddMenu.css";

export interface ConnectionQuickAddMenuProps {
  readonly position: { readonly x: number; readonly y: number };
  readonly onSelect: (kind: CanvasGenNodeKind) => void;
  readonly onClose: () => void;
}

/* 数据里存图标名而不是组件，让这三个入口也走图标层的尺寸与字重规则。 */
const choices: readonly {
  readonly kind: CanvasGenNodeKind;
  readonly label: string;
  readonly icon: IconName;
}[] = [
  { kind: "image", label: "图片生成", icon: "image" },
  { kind: "video", label: "视频生成", icon: "video-camera" },
  { kind: "prompt", label: "提示词生成与优化", icon: "magic-wand" },
];

const VIEWPORT_MARGIN = 8;

export function ConnectionQuickAddMenu({
  position,
  onSelect,
  onClose,
}: ConnectionQuickAddMenuProps) {
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
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) onClose();
    }
    document.addEventListener("pointerdown", handleOutsidePointerDown, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("pointerdown", handleOutsidePointerDown, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

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
        nextIndex = (currentIndex + 1) % choices.length;
        break;
      case "ArrowUp":
        nextIndex = (currentIndex + choices.length - 1) % choices.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = choices.length - 1;
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
      aria-label="常用生成节点"
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
        <strong>常用生成节点</strong>
        <span>选择后创建并自动连线</span>
      </div>
      {choices.map(({ kind, label, icon }, index) => (
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
