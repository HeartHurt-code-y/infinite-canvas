import { useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useEscapeHandler } from "../../components/escapeArbiter";
import { useModalFocusTrap } from "../../components/useModalFocusTrap";
import { registerFloatingLayer, unregisterFloatingLayer, useFloatingLayerParentId } from "../create/floatingLayerFamily";
import { useDismissOnOutside, useFloatingLayerAnchor } from "../create/useFloatingLayerAnchor";
import { CanvasReferenceAssetPicker } from "./CanvasFeatureAssetPicker";
import { CanvasReferenceLibraryContext } from "./canvasReferenceLibrary";
import type { AssetItem, AssetKind } from "./workspaceModel";
import "./CanvasAllFeaturesDialog.css";
import "./CanvasReferenceUpload.css";

export function CanvasReferenceUpload({
  active, disabled, busy, kinds, icon, onOpen, onLocalUpload, onChooseAsset,
}: {
  readonly active: boolean;
  readonly disabled: boolean;
  readonly busy: boolean;
  readonly kinds: readonly [AssetKind, ...AssetKind[]];
  readonly icon: ReactNode;
  readonly onOpen: () => void;
  readonly onLocalUpload: () => void;
  readonly onChooseAsset: (asset: AssetItem) => void;
}) {
  const library = useContext(CanvasReferenceLibraryContext);
  const trigger = useRef<HTMLButtonElement>(null);
  const scrim = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const titleId = useId();
  const parentLayerId = useFloatingLayerParentId();
  const [panel, setPanel] = useState<"menu" | "library" | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const menuOpen = active && !disabled && !busy && panel === "menu";
  const libraryOpen = active && !disabled && panel === "library" && library != null;
  const close = () => setPanel(null);
  const focusTrigger = () => trigger.current?.focus({ preventScroll: true });
  const { ref: menu, layerId } = useFloatingLayerAnchor<HTMLDivElement>({
    open: menuOpen, anchorRef: trigger, preferAbove: false, minWidth: 128, gap: 8, followAnchor: true,
  });
  useDismissOnOutside(menuOpen, menu, trigger, close, layerId);
  useEscapeHandler({
    canHandle: () => menuOpen,
    handle: () => { close(); focusTrigger(); },
  }, menuOpen);
  const modal = useModalFocusTrap({ active: libraryOpen, onEscape: close, returnFocusRef: trigger });

  useEffect(() => {
    if (!active || disabled) setPanel(null);
  }, [active, disabled]);
  useLayoutEffect(() => {
    if (menuOpen) menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true });
  }, [menu, menuOpen]);
  useLayoutEffect(() => {
    if (!libraryOpen || !parentLayerId || !scrim.current) return;
    registerFloatingLayer(titleId, parentLayerId, scrim.current);
    return () => unregisterFloatingLayer(titleId);
  }, [libraryOpen, parentLayerId, titleId]);

  return <>
    <button ref={trigger} type="button" className="canvas-gen-node__tool-chip canvas-reference-upload__trigger"
      aria-label={kinds.length === 1 && kinds[0] === "image" ? "上传参考图片" : "上传参考素材"}
      aria-haspopup="menu" aria-expanded={menuOpen} aria-controls={menuOpen ? menuId : undefined}
      disabled={disabled || busy}
      onClick={() => {
        onOpen();
        setPanel(menuOpen ? null : "menu");
      }}>
      {icon}
      <span>{busy ? "导入中…" : "上传"}</span>
    </button>
    {menuOpen ? createPortal(
      <div ref={menu} id={menuId} className="canvas-reference-upload__menu nodrag nopan" role="menu" aria-label="上传"
        onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()}
        onClick={event => event.stopPropagation()}
        onBlur={event => {
          const next = event.relatedTarget;
          if (next instanceof Node && !event.currentTarget.contains(next) && !trigger.current?.contains(next)) close();
        }}
        onKeyDown={event => {
          if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "Tab") {
            close();
            focusTrigger();
            event.stopPropagation();
          } else if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            event.stopPropagation();
            const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:enabled"));
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
            const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
              : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
            buttons[next]?.focus({ preventScroll: true });
          } else if (event.key === "Enter" || event.key === " ") {
            event.stopPropagation();
          }
        }}>
        <button type="button" role="menuitem" tabIndex={-1} onClick={() => {
          close();
          focusTrigger();
          onLocalUpload();
        }}>本地上传</button>
        <button type="button" role="menuitem" tabIndex={-1} aria-haspopup="dialog" disabled={!library} onClick={() => {
          setSelectionError(null);
          setPanel("library");
        }}>素材库上传</button>
      </div>, document.body,
    ) : null}
    {libraryOpen ? createPortal(
      <div ref={scrim} className="canvas-all-features-scrim canvas-reference-upload__scrim"
        onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()}
        onClick={event => {
          event.stopPropagation();
          if (event.target === event.currentTarget) close();
        }}
        onKeyDown={event => {
          // Leave Escape to the modal focus trap and the global Escape arbiter.
          if (event.key !== "Escape") event.stopPropagation();
        }}>
        <section ref={modal.ref} {...modal.containerProps} className="canvas-all-features canvas-all-features--picker"
          role="dialog" aria-modal="true" aria-labelledby={titleId}>
          <CanvasReferenceAssetPicker referenceKinds={kinds} selectionError={selectionError}
            listAssets={library.listAssets} hasCloud={library.hasCloud} titleId={titleId} onBack={close}
            onChooseAsset={asset => {
              try {
                onChooseAsset(asset);
                close();
              } catch (error) {
                setSelectionError(error instanceof Error ? error.message : String(error));
              }
            }} />
        </section>
      </div>, document.body,
    ) : null}
  </>;
}
