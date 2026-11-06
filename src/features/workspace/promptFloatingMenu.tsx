import { type HTMLAttributes, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useFloatingLayerAnchor } from "../create/useFloatingLayerAnchor";

export interface PromptFloatingMenuProps extends HTMLAttributes<HTMLDivElement> {
  readonly anchorRef: RefObject<HTMLElement | null>;
  readonly children: ReactNode;
  readonly width?: number;
}

/** Shared measured placement keeps the real menu attached through canvas zoom and text edits. */
export function PromptFloatingMenu({ anchorRef, className, children, width = 280, ...rest }: PromptFloatingMenuProps) {
  const { ref } = useFloatingLayerAnchor<HTMLDivElement>({ open: true, anchorRef, minWidth: width,
    maxWidth: width, maxHeight: 420, preferAbove: true, gap: 8, followAnchor: true });
  return createPortal(<div {...rest} ref={ref} className={className} style={{ position: "fixed", width, ...rest.style }}
    onKeyDown={event => { event.stopPropagation(); rest.onKeyDown?.(event); }}
    onKeyUp={event => event.stopPropagation()}
    onPointerDown={event => event.stopPropagation()}
    onMouseDown={event => {
      if (!(event.target instanceof Element && event.target.closest("input, textarea"))) event.preventDefault();
      event.stopPropagation(); rest.onMouseDown?.(event);
    }}
    onWheel={event => event.stopPropagation()}>{children}</div>, document.body);
}
