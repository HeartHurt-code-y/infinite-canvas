import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useEscapeHandler } from "../../components/escapeArbiter";
import "./CanvasChromeOverlays.css";
import { Icon } from "../../components/Icon";
import { useFloatingLayerAnchor, useDismissOnOutside } from "../create/useFloatingLayerAnchor";
import "./CanvasNodeActionsMenu.css";

/** 节点操作统一收进按需展开的浮层，避免按钮压在图片和标题上。 */
export function CanvasNodeActionsMenu({ label, children, icon, tooltip = "更多操作", preferAbove = false, triggerClassName }: {
  readonly label: string;
  readonly children: ReactNode;
  readonly icon?: ReactNode;
  readonly tooltip?: string;
  readonly preferAbove?: boolean;
  readonly triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const { ref: layerRef, layerId } = useFloatingLayerAnchor<HTMLDivElement>({
    open, anchorRef, minWidth: 196, maxHeight: 320, preferAbove,
  });
  const close = useCallback(() => setOpen(false), []);
  useDismissOnOutside(open, layerRef, anchorRef, close, layerId);
  useEscapeHandler({ canHandle: () => open, handle: () => { close(); anchorRef.current?.focus(); } }, open);
  useEffect(() => {
    if (open) layerRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [open, layerRef]);
  return <>
    <button ref={anchorRef} type="button" className={`canvas-node-actions__trigger nodrag nopan${triggerClassName ? " " + triggerClassName : ""}`}
      aria-label={label} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? menuId : undefined}
      data-tooltip={open ? undefined : tooltip}
      onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()}
      onClick={event => { event.stopPropagation(); setOpen(value => !value); }}>
      {icon ?? <Icon name="dots-three-vertical" size="sm" aria-hidden="true" />}
    </button>
    {open ? createPortal(<div ref={layerRef} id={menuId} role="dialog" aria-label={label}
      className="canvas-context-menu canvas-node-actions__menu nodrag nopan nowheel"
      onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()}
      onClick={event => {
        event.stopPropagation();
        const target = event.target as Element;
        if (target.closest("button") && !target.closest(".node-name-editor")) {
          close();
          if (event.detail === 0) anchorRef.current?.focus({ preventScroll: true });
        }
      }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.keyCode === 229 || event.defaultPrevented) return;
        if (!(event.target instanceof HTMLButtonElement)) return;
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
        const current = buttons.indexOf(event.target);
        const next = event.key === "ArrowDown" ? (current + 1) % buttons.length
          : event.key === "ArrowUp" ? (current - 1 + buttons.length) % buttons.length
          : event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : null;
        if (next != null) { event.preventDefault(); event.stopPropagation(); buttons[next]?.focus(); }
      }}>
      {children}
    </div>, document.body) : null}
  </>;
}
