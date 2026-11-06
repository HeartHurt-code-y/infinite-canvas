import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { placeSideMenu, placeTooltip } from "../../components/floatingLayer";
import { useFloatingLayerAnchor } from "../create/useFloatingLayerAnchor";
import { CANVAS_FEATURE_GROUPS, type CanvasFeatureAction, type FeatureCard, type FeatureEntry } from "./canvasFeatureCatalog";
import { LibTVMediaIcon, type LibTVMediaIconName } from "./LibTVMediaIcon";
import "./CanvasImageToolbar.css";

const cards = CANVAS_FEATURE_GROUPS.find(group => group.cards.some(card => card.action?.kind === "image-hd"))!.cards;
const primaryLabels = ["元素编辑", "高清", "多角度", "宫格切分", "图层分离", "720度全景图"];
const primary = primaryLabels.map(label => cards.find(card => card.label === label)!);
const more = cards.filter(card => !primary.includes(card) && card.label !== "旋转" && card.label !== "标注");
const moreCard: FeatureCard = { label: "更多", icon: "more-s", children: more };

function menuKeys(event: KeyboardEvent<HTMLElement>) {
  if (event.nativeEvent.isComposing || event.keyCode === 229) return;
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
  const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(":scope > button:not(:disabled)")];
  if (!items.length) return;
  const current = items.indexOf(document.activeElement as HTMLButtonElement);
  const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
    : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
  event.preventDefault(); event.stopPropagation(); items[next]?.focus();
}

function SidePanel({ anchor, children, onEnter, onLeave, onBack }: { readonly anchor: HTMLElement; readonly children: ReactNode;
  readonly onEnter: () => void; readonly onLeave: () => void; readonly onBack: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const layer = ref.current; const parent = anchor.closest<HTMLElement>(".canvas-image-tools__menu");
    if (!layer || !parent) return;
    const place = () => {
      const pos = placeSideMenu(parent, anchor, layer);
      layer.style.transform = `translate3d(${pos.left}px, ${pos.top}px, 0)`;
    };
    place(); const observer = new ResizeObserver(place); observer.observe(layer);
    const timer = window.setInterval(place, 150);
    return () => { observer.disconnect(); window.clearInterval(timer); };
  }, [anchor]);
  return createPortal(<div ref={ref} className="canvas-image-tools canvas-image-tools__menu canvas-image-tools__menu--side"
    role="menu" onPointerEnter={onEnter} onPointerLeave={onLeave}
    onKeyDown={event => { menuKeys(event); if (event.key === "ArrowLeft") { event.preventDefault(); onBack(); anchor.focus(); } }}
    onPointerDown={event => event.stopPropagation()}>{children}</div>, document.body);
}

function ActionMenu({ anchor, items, onAction, onClose, onEnter, onLeave }: {
  readonly anchor: HTMLElement;
  readonly items: readonly (FeatureEntry & { readonly icon?: LibTVMediaIconName; readonly children?: readonly FeatureEntry[] })[];
  readonly onAction: (action: CanvasFeatureAction, label: string) => void;
  readonly onClose: () => void;
  readonly onEnter: () => void;
  readonly onLeave: () => void;
}) {
  const anchorRef = useRef<HTMLElement>(anchor);
  const layer = useFloatingLayerAnchor<HTMLDivElement>({ open: true, anchorRef, minWidth: 170, maxWidth: 200,
    preferAbove: false, gap: 4, maxHeight: 420, followAnchor: true });
  const [side, setSide] = useState<{ anchor: HTMLElement; items: readonly FeatureEntry[] } | null>(null);
  const choose = (entry: FeatureEntry) => { if (entry.action) { onClose(); onAction(entry.action, entry.label); } };
  const option = (entry: FeatureEntry) => <button key={entry.label} type="button" role="menuitem" disabled={!entry.action}
    data-tooltip={entry.unavailable} onClick={() => choose(entry)}>{entry.label}</button>;
  return <>
    {createPortal(<div ref={layer.ref} className="canvas-image-tools canvas-image-tools__menu" role="menu" onKeyDown={menuKeys}
      onPointerEnter={onEnter} onPointerLeave={onLeave}
      onPointerDown={event => event.stopPropagation()}>
      {items.map(entry => <button key={entry.label} type="button" role="menuitem" disabled={!entry.action && !entry.children}
        aria-haspopup={entry.children ? "menu" : undefined} aria-expanded={entry.children ? side?.items === entry.children : undefined}
        data-tooltip={entry.unavailable}
        onPointerEnter={event => setSide(entry.children ? { anchor: event.currentTarget, items: entry.children } : null)}
        onKeyDown={event => { if (event.key === "ArrowRight" && entry.children) { event.preventDefault(); setSide({ anchor: event.currentTarget, items: entry.children }); } }}
        onClick={event => entry.children ? setSide({ anchor: event.currentTarget, items: entry.children }) : choose(entry)}>
        {entry.icon ? <LibTVMediaIcon name={entry.icon} size={18} /> : null}<span>{entry.label}</span>
        {entry.children ? <LibTVMediaIcon name="nt-chevron-right-small" size={14} /> : null}
      </button>)}
    </div>, document.body)}
    {side ? <SidePanel anchor={side.anchor} onEnter={onEnter} onLeave={onLeave} onBack={() => setSide(null)}>{side.items.map(option)}</SidePanel> : null}
  </>;
}

/** One toolbar follows the selected image outside the React Flow scale layer. */
export function CanvasImageToolbar({ nodeKey, viewportRef, replaceable, busy, onAction, onDownload, onPreview, onReplace }: {
  readonly nodeKey: string;
  readonly viewportRef: RefObject<HTMLElement | null>;
  readonly replaceable: boolean;
  readonly busy: boolean;
  readonly onAction: (action: CanvasFeatureAction, label: string) => void;
  readonly onDownload: () => void;
  readonly onPreview: () => void;
  readonly onReplace: (mode: "local" | "history") => void;
}) {
  const toolbar = useRef<HTMLDivElement>(null);
  const replace = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ anchor: HTMLElement; card: FeatureCard } | null>(null);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const hoverOpen = useRef<number | null>(null);
  const hoverClose = useRef<number | null>(null);
  const cancelHover = () => {
    if (hoverOpen.current != null) window.clearTimeout(hoverOpen.current);
    if (hoverClose.current != null) window.clearTimeout(hoverClose.current);
    hoverOpen.current = null; hoverClose.current = null;
  };
  const leaveMenu = () => { cancelHover(); hoverClose.current = window.setTimeout(() => { hoverClose.current = null; setMenu(null); }, 120); };
  useEffect(() => () => { if (hoverOpen.current != null) window.clearTimeout(hoverOpen.current); if (hoverClose.current != null) window.clearTimeout(hoverClose.current); }, []);
  const replaceLayer = useFloatingLayerAnchor<HTMLDivElement>({ open: replaceOpen, anchorRef: replace, minWidth: 170, maxWidth: 170,
    align: "end", preferAbove: false, gap: 4, followAnchor: true });
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!(event.target instanceof Element) || !event.target.closest(".canvas-image-tools")) { cancelHover(); setMenu(null); setReplaceOpen(false); } };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.key !== "Escape") return;
      cancelHover();
      if (menu || replaceOpen) { event.preventDefault(); setMenu(null); setReplaceOpen(false); (replaceOpen ? replace.current : menu?.anchor)?.focus(); }
    };
    document.addEventListener("pointerdown", outside, true); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", escape); };
  }, [menu, replaceOpen]);
  useLayoutEffect(() => {
    const place = () => {
      const node = viewportRef.current?.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(nodeKey)}"]`);
      const anchor = node?.querySelector<HTMLElement>(".canvas-node-preview") ?? node;
      const bar = toolbar.current; if (!bar) return;
      const rect = anchor?.getBoundingClientRect();
      const visible = !!rect?.width && !!rect.height && !anchor?.closest("[inert], [hidden]")
        && rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < document.documentElement.clientWidth;
      bar.style.visibility = visible ? "visible" : "hidden";
      if (replace.current) replace.current.style.visibility = visible ? "visible" : "hidden";
      if (!visible || !anchor || !rect) return;
      const size = bar.getBoundingClientRect();
      const position = placeTooltip(anchor, { anchorRect: rect, measuredWidth: size.width, measuredHeight: size.height, preferAbove: true, gap: 10 });
      bar.style.transform = `translate3d(${position.left}px, ${position.top}px, 0)`;
      if (replace.current) replace.current.style.transform = `translate3d(${rect.right - 36}px, ${rect.top + 12}px, 0)`;
    };
    place(); const observer = new ResizeObserver(place); if (toolbar.current) observer.observe(toolbar.current);
    const timer = window.setInterval(place, 150); window.addEventListener("resize", place);
    return () => { observer.disconnect(); window.clearInterval(timer); window.removeEventListener("resize", place); };
  }, [nodeKey, viewportRef]);
  const button = (card: FeatureCard) => <button key={card.label} type="button" disabled={busy}
    aria-haspopup={card.children ? "menu" : undefined} aria-expanded={card.children ? menu?.card === card : undefined}
    onPointerEnter={event => {
      if (!card.children || event.pointerType === "touch" || busy) return;
      cancelHover(); const anchor = event.currentTarget;
      hoverOpen.current = window.setTimeout(() => { hoverOpen.current = null; if (anchor.isConnected) { setReplaceOpen(false); setMenu({ anchor, card }); } }, 100);
    }}
    onPointerLeave={card.children ? leaveMenu : undefined}
    onClick={event => { cancelHover(); setReplaceOpen(false); if (card.children) setMenu({ anchor: event.currentTarget, card });
      else if (card.action) { setMenu(null); onAction(card.action, card.label); } }}>
    <LibTVMediaIcon name={card.icon} size={18} /><span>{card.label}</span>{card.children ? <LibTVMediaIcon name="icon-chevron-down-small" size={12} /> : null}
  </button>;
  return createPortal(<>
    <div ref={toolbar} className="canvas-image-tools canvas-image-tools__bar" role="toolbar" aria-label="图片编辑工具"
      onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
      {primary.map(button)}{button(moreCard)}
      <span className="canvas-image-tools__divider" />
      <button type="button" aria-label="旋转" data-tooltip="旋转" disabled={busy} onClick={() => onAction({ kind: "image", mode: "rotate" }, "旋转")}><LibTVMediaIcon name="rotate" size={18} /></button>
      <button type="button" aria-label="标注" data-tooltip="标注" disabled={busy} onClick={() => onAction({ kind: "image-local", mode: "annotate" }, "标注")}><LibTVMediaIcon name="annotate" size={18} /></button>
      <button type="button" aria-label="下载图片" data-tooltip="下载图片" disabled={busy} onClick={onDownload}><LibTVMediaIcon name="download" size={18} /></button>
      <button type="button" aria-label="全屏预览" data-tooltip="全屏预览" onClick={onPreview}><LibTVMediaIcon name="fullscreen" size={18} /></button>
    </div>
    {replaceable ? <button ref={replace} type="button" className="canvas-image-tools canvas-image-tools__replace" aria-label="替换素材"
      data-tooltip="替换素材" aria-haspopup="menu" aria-expanded={replaceOpen} disabled={busy}
      onPointerDown={event => event.stopPropagation()} onClick={() => { setMenu(null); setReplaceOpen(value => !value); }}><LibTVMediaIcon name="swap" size={14} /></button> : null}
    {replaceOpen ? <div ref={replaceLayer.ref} className="canvas-image-tools canvas-image-tools__menu" role="menu" aria-label="替换素材" onKeyDown={menuKeys}
      onPointerDown={event => event.stopPropagation()}>
      <button type="button" role="menuitem" onClick={() => { setReplaceOpen(false); onReplace("local"); }}><LibTVMediaIcon name="upload" size={20} />本地上传</button>
      <button type="button" role="menuitem" onClick={() => { setReplaceOpen(false); onReplace("history"); }}><LibTVMediaIcon name="library-q4-history" size={20} />选择生成历史</button>
    </div> : null}
    {menu ? <ActionMenu key={menu.card.label} anchor={menu.anchor} items={menu.card.children ?? []} onAction={onAction}
      onEnter={cancelHover} onLeave={leaveMenu} onClose={() => { cancelHover(); setMenu(null); }} /> : null}
  </>, document.body);
}
