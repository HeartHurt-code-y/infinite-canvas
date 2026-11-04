import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useEscapeHandler } from "../../components/escapeArbiter";
import { useDismissOnOutside, useFloatingLayerAnchor } from "../create/useFloatingLayerAnchor";
import { CanvasChromeIcon } from "./CanvasChromeIcons";
import { LibTVMediaIcon } from "./LibTVMediaIcon";
import type { CanvasLibraryKind } from "./canvasLibraryResources";
import "./CanvasDockLibrary.css";

const ENTRIES = [
  { kind: "style", title: "风格库", hint: "新增风格节点", icon: "style-cube" },
  { kind: "effect", title: "特效库", hint: "新增特效节点", icon: "lens-aperture" },
] as const;

export function CanvasDockLibrary({ onChoose }: { readonly onChoose: (kind: CanvasLibraryKind) => void }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const { ref, layerId } = useFloatingLayerAnchor<HTMLDivElement>({
    open, anchorRef: triggerRef, minWidth: 240, align: "center", preferAbove: true, gap: 20, followAnchor: true,
  });
  useDismissOnOutside(open, ref, triggerRef, () => setOpen(false), layerId);
  useEscapeHandler({
    canHandle: () => open,
    handle: () => {
      setOpen(false);
      triggerRef.current?.focus();
    },
  }, open);
  useEffect(() => {
    if (open) ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, [open, ref]);
  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    switch (event.key) {
      case "ArrowDown": next = (index + 1) % buttons.length; break;
      case "ArrowUp": next = (index - 1 + buttons.length) % buttons.length; break;
      case "Home": next = 0; break;
      case "End": next = buttons.length - 1; break;
      default: return;
    }
    event.preventDefault();
    event.stopPropagation();
    buttons[next]?.focus();
  };
  return (
    <>
      <button ref={triggerRef} type="button" className="canvas-bottom-dock__action"
        aria-label="素材库" data-tooltip={open ? undefined : "素材库"} aria-haspopup="menu" aria-expanded={open}
        aria-controls={open ? menuId : undefined} onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" || open) return;
          event.preventDefault();
          setOpen(true);
        }}>
        <CanvasChromeIcon name="grid2plus" size={20} />
      </button>
      {open ? createPortal(
        <div ref={ref} id={menuId} className="canvas-dock-library" role="menu" aria-label="素材库"
          onKeyDown={moveFocus} onBlur={(event) => {
            if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)
              && event.relatedTarget !== triggerRef.current) setOpen(false);
          }}>
          <div className="canvas-dock-library__title" role="presentation">素材库</div>
          {ENTRIES.map(({ kind, title, hint, icon }) => (
            <button key={kind} type="button" role="menuitem" aria-label={title} aria-haspopup="dialog"
              onClick={() => {
                setOpen(false);
                triggerRef.current?.focus();
                onChoose(kind);
              }}>
              <span className="canvas-dock-library__icon"><LibTVMediaIcon name={icon} size={20} /></span>
              <span className="canvas-dock-library__label"><strong>{title}</strong><small>{hint}</small></span>
              <span className="canvas-dock-library__new" aria-hidden="true">NEW</span>
            </button>
          ))}
        </div>, document.body,
      ) : null}
    </>
  );
}
