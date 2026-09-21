import {
  useLayoutEffect,
  useRef,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

const VIEWPORT_MARGIN = 8;
const VIEWPORT_SELECTOR = ".react-flow__viewport";

export interface PromptFloatingMenuProps extends HTMLAttributes<HTMLDivElement> {
  readonly anchorRef: RefObject<HTMLElement | null>;
  readonly children: ReactNode;
}

interface MenuBox {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly maxHeight: number;
}

function readAnchorBox(anchor: HTMLElement): DOMRect {
  return anchor.getBoundingClientRect();
}

function placeMenu(anchor: HTMLElement, menu: HTMLElement | null): MenuBox {
  const rect = readAnchorBox(anchor);
  const measuredWidth = menu?.offsetWidth ?? 0;
  const width = Math.min(
    Math.max(measuredWidth, Math.min(rect.width, 280), 220),
    window.innerWidth - VIEWPORT_MARGIN * 2,
  );
  const spaceBelow = window.innerHeight - rect.bottom - VIEWPORT_MARGIN;
  const spaceAbove = rect.top - VIEWPORT_MARGIN;
  const placeAbove = spaceBelow < 132 && spaceAbove > spaceBelow;
  const maxHeight = Math.max(120, Math.min(280, placeAbove ? spaceAbove : spaceBelow));
  const left = Math.min(
    Math.max(VIEWPORT_MARGIN, rect.left),
    window.innerWidth - width - VIEWPORT_MARGIN,
  );
  const top = placeAbove
    ? Math.max(VIEWPORT_MARGIN, rect.top - maxHeight - 6)
    : Math.min(rect.bottom + 6, window.innerHeight - VIEWPORT_MARGIN - 80);
  return { top, left, width, maxHeight };
}

/**
 * 把提示词 @ 候选 / 同名消歧菜单浮到 `document.body`。
 * 画布节点在 React Flow 的 scale/translate 层里，菜单若留在节点内会随缩放变小、
 * 被 overflow 裁切，并在 WKWebView 里与硬件视频层叠导致闪退。
 */
export function PromptFloatingMenu({
  anchorRef,
  className,
  children,
  ...rest
}: PromptFloatingMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    const apply = () => {
      const anchor = anchorRef.current;
      if (anchor == null || menu == null) return;
      const box = placeMenu(anchor, menu);
      menu.style.top = `${box.top}px`;
      menu.style.left = `${box.left}px`;
      menu.style.width = `${box.width}px`;
      menu.style.maxHeight = `${box.maxHeight}px`;
    };
    apply();
    window.addEventListener("resize", apply);
    const viewport = document.querySelector(VIEWPORT_SELECTOR);
    const observer =
      viewport != null && typeof MutationObserver !== "undefined"
        ? new MutationObserver(apply)
        : null;
    if (observer != null && viewport != null) {
      observer.observe(viewport, { attributes: true, attributeFilter: ["style", "class"] });
    }
    return () => {
      window.removeEventListener("resize", apply);
      observer?.disconnect();
    };
  }, [anchorRef]);

  const initial = { top: 0, left: 0, width: 280, maxHeight: 180 };

  return createPortal(
    <div
      {...rest}
      ref={menuRef}
      className={className}
      style={{
        top: initial.top,
        left: initial.left,
        width: initial.width,
        maxHeight: initial.maxHeight,
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        rest.onKeyDown?.(event);
      }}
      onKeyUp={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => {
        // 保住编辑器选区：选项自己也会 preventDefault，这里覆盖菜单空白处。
        event.preventDefault();
        event.stopPropagation();
        rest.onMouseDown?.(event);
      }}
      onWheel={(event) => event.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}
