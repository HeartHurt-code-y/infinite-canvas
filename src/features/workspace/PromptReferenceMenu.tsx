import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { placeSideMenu } from "../../components/floatingLayer";
import { buildReferenceCatalog, type PromptReferenceCandidate } from "../../lib/promptReferences";
import type { PromptMarkReferenceInput } from "../../lib/promptContent";
import { toMediaProxyUrl } from "../../lib/mediaProxy";
import { LibTVMediaIcon } from "./LibTVMediaIcon";
import { PromptFloatingMenu } from "./promptFloatingMenu";
import { candidatePreview, useReferenceMediaPreview } from "./ReferenceMediaPreview";
import { useMediaByteSource } from "./mediaByteCache";
import { VideoMiddleFrame } from "./VideoMiddleFrame";
import "./PromptReferenceMenu.css";

type Kind = PromptReferenceCandidate["kind"];
const KINDS = ["image", "video", "audio"] as const;
const LABELS: Record<Kind, string> = { image: "图片", video: "视频", audio: "音频", text: "文本" };
const ICONS = { image: "library-q4-grid", video: "icon-video-gen", audio: "library-q4-voice", text: "file-text" } as const;
export type ReferenceMenuNavigation = (event: KeyboardEvent) => boolean;

function MenuThumb({ candidate }: { readonly candidate: PromptReferenceCandidate }) {
  const media = candidatePreview(candidate);
  const bytes = useMediaByteSource(candidate.assetId, candidate.kind, media.url);
  const source = bytes.url ?? media.url;
  const [failed, setFailed] = useState<string | null>(null);
  return <span className="prompt-reference-menu__thumb" aria-hidden="true">
    {source && failed !== source && candidate.kind === "image"
      ? <img src={toMediaProxyUrl(source) ?? source} alt="" draggable={false} onError={() => setFailed(source)} />
      : source && failed !== source && candidate.kind === "video"
        ? <VideoMiddleFrame src={source} onLoadError={() => setFailed(source)} />
        : <LibTVMediaIcon name={ICONS[candidate.kind]} size={14} />}
  </span>;
}

function SideMenu({ anchor, kind, children, menuId }: { readonly anchor: HTMLElement; readonly kind: Kind; readonly children: React.ReactNode; readonly menuId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const panel = ref.current;
    const parent = anchor.closest<HTMLElement>(".prompt-reference-menu");
    if (!panel || !parent) return;
    const place = () => {
      const position = placeSideMenu(parent, anchor, panel);
      panel.style.transform = `translate3d(${position.left}px, ${position.top}px, 0)`;
    };
    place(); const observer = new ResizeObserver(place); observer.observe(panel);
    const timer = window.setInterval(place, 150);
    return () => { observer.disconnect(); window.clearInterval(timer); };
  }, [anchor]);
  return createPortal(<div ref={ref} className="prompt-mention__menu prompt-reference-menu prompt-reference-menu--side nodrag nopan nowheel"
    role="listbox" aria-label={`${LABELS[kind]}素材引用`} data-reference-menu={menuId}
    onMouseDown={event => { event.preventDefault(); event.stopPropagation(); }} onPointerDown={event => event.stopPropagation()}
    onWheel={event => event.stopPropagation()}>{children}</div>, document.body);
}

export function PromptReferenceMenu({ anchorRef, connected, canvasSources, annotations = [], replacing = false, query, navigationRef, onSelect, onAnnotation, onClose }: {
  readonly anchorRef: RefObject<HTMLElement | null>;
  readonly connected: readonly PromptReferenceCandidate[];
  readonly canvasSources: readonly PromptReferenceCandidate[];
  readonly annotations?: readonly PromptMarkReferenceInput[] | undefined;
  readonly replacing?: boolean;
  readonly query: string;
  readonly navigationRef: RefObject<ReferenceMenuNavigation | null>;
  readonly onSelect: (candidate: PromptReferenceCandidate) => void;
  readonly onAnnotation: (annotation: PromptMarkReferenceInput) => void;
  readonly onClose: (restoreFocus?: boolean) => void;
}) {
  const [search, setSearch] = useState(query);
  const [side, setSide] = useState<{ kind: Kind; anchor: HTMLElement } | null>(null);
  const [active, setActive] = useState(-1);
  const [expanded, setExpanded] = useState(false);
  const preview = useReferenceMediaPreview();
  const menuId = useId();
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || (!anchorRef.current?.contains(target) && target.closest<HTMLElement>("[data-reference-menu]")?.dataset["referenceMenu"] !== menuId)) onClose();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [anchorRef, menuId, onClose]);
  useEffect(() => { setSearch(query); setActive(-1); }, [query]);
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) { onClose(); return; }
    const check = () => {
      const rect = anchor.getBoundingClientRect();
      if (!anchor.isConnected || !rect.width || !rect.height || anchor.closest("[inert]") || getComputedStyle(anchor).visibility === "hidden") onClose();
    };
    const observer = new ResizeObserver(check); observer.observe(anchor);
    const timer = window.setInterval(check, 150);
    return () => { observer.disconnect(); window.clearInterval(timer); };
  }, [anchorRef, onClose]);
  const connectedKeys = useMemo(() => new Set(connected.map(item => item.canvasNodeKey)), [connected]);
  const all = useMemo(() => [...connected, ...canvasSources.filter(item => !connectedKeys.has(item.canvasNodeKey))], [connected, canvasSources, connectedKeys]);
  const catalog = useMemo(() => buildReferenceCatalog(connected), [connected]);
  const match = useCallback((item: PromptReferenceCandidate) => {
    const needle = search.trim().toLocaleLowerCase();
    return !needle || `${item.name} ${item.kind} ${LABELS[item.kind]}`.toLocaleLowerCase().includes(needle)
      || catalog.search(needle).some(candidate => candidate.canvasNodeKey === item.canvasNodeKey);
  }, [search, catalog]);
  const linked = connected.filter(match);
  const available = all.filter(item => !connectedKeys.has(item.canvasNodeKey) && match(item))
    .sort((left, right) => KINDS.indexOf(left.kind as typeof KINDS[number]) - KINDS.indexOf(right.kind as typeof KINDS[number]));
  const shown = search.trim() ? [...linked, ...available] : side ? all.filter(item => item.kind === side.kind) : linked.slice(0, expanded ? undefined : 12);
  const choose = useCallback((candidate: PromptReferenceCandidate) => { preview.hide(); onSelect(candidate); }, [onSelect, preview.hide]);
  const navigate = useCallback<ReferenceMenuNavigation>(event => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return false;
    if (event.key === "ArrowLeft" && side) { event.preventDefault(); event.stopPropagation(); setSide(null); setActive(-1); return true; }
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(true); return true; }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault(); event.stopPropagation();
      setActive(index => !shown.length ? -1 : index < 0 ? event.key === "ArrowDown" ? 0 : shown.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length);
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      if (!shown.length) return false;
      event.preventDefault(); event.stopPropagation(); choose(shown[active] ?? shown[0]!); return true;
    }
    return false;
  }, [side, shown, active, choose, onClose]);
  useLayoutEffect(() => { navigationRef.current = navigate; return () => { navigationRef.current = null; }; }, [navigate, navigationRef]);
  const renderOption = (candidate: PromptReferenceCandidate, index: number) => <button key={candidate.canvasNodeKey} type="button"
    className={`prompt-reference-menu__option${index >= 0 && active === index ? " is-active" : ""}`} role="option"
    aria-label={`${candidate.name}，${connectedKeys.has(candidate.canvasNodeKey) ? "已引用" : "选择后连接并引用"}`}
    aria-selected={index >= 0 && active === index}
    onMouseDown={event => event.preventDefault()} onClick={() => choose(candidate)}
    onPointerEnter={event => { if (event.pointerType !== "touch") preview.show(event.currentTarget, candidatePreview(candidate)); }}
    onPointerLeave={preview.hide} onFocus={event => preview.show(event.currentTarget, candidatePreview(candidate))} onBlur={preview.hide}>
    <MenuThumb candidate={candidate} /><span>{candidate.name}</span>
  </button>;
  return <>
    <PromptFloatingMenu anchorRef={anchorRef} width={200} className="prompt-mention__menu prompt-mention__menu--floating prompt-reference-menu nodrag nopan nowheel"
      role="dialog" aria-label={replacing ? "替换素材引用" : "素材引用"} data-reference-menu={menuId} onKeyDown={navigate}>
      <label className="prompt-reference-menu__search" onPointerEnter={() => setSide(null)}>
        <LibTVMediaIcon name="feature-search" size={14} />
        <input aria-label="搜索引用素材" placeholder="搜索" value={search} onChange={event => { setSearch(event.target.value); setSide(null); setActive(-1); }} />
      </label>
      <div className="prompt-reference-menu__scroll">
        {linked.length ? <div onPointerEnter={() => setSide(null)}><div className="prompt-reference-menu__heading">已引用</div>
          {linked.slice(0, search.trim() || expanded ? undefined : 12).map((candidate, index) => renderOption(candidate, index))}
          {!search.trim() && !expanded && linked.length > 12 ? <button type="button" className="prompt-reference-menu__option" onClick={() => setExpanded(true)}>更多</button> : null}
        </div> : null}
        {search.trim() ? <>
          {KINDS.map(kind => { const matches = available.filter(item => item.kind === kind); return matches.length ? <div key={kind}>
            <div className="prompt-reference-menu__heading">{LABELS[kind]}</div>{matches.map(candidate => renderOption(candidate, shown.indexOf(candidate)))}
          </div> : null; })}
          {!shown.length ? <div className="prompt-reference-menu__empty">暂无可引用资产，请连入后操作</div> : null}
        </> : <>
          <div className="prompt-reference-menu__heading">素材引用</div>
          {KINDS.map(kind => <button key={kind} type="button" className="prompt-reference-menu__option prompt-reference-menu__kind"
            aria-haspopup="listbox" aria-expanded={side?.kind === kind} onPointerEnter={event => { preview.hide(); setSide({ kind, anchor: event.currentTarget }); setActive(-1); }}
            onFocus={event => { setSide({ kind, anchor: event.currentTarget }); setActive(-1); }} onClick={event => setSide({ kind, anchor: event.currentTarget })}>
            <LibTVMediaIcon name={ICONS[kind]} size={20} /><span>{LABELS[kind]}</span><LibTVMediaIcon name="nt-chevron-right-small" size={14} />
          </button>)}
        </>}
        {annotations.length ? <><div className="prompt-reference-menu__heading">画面标注</div>{annotations.filter(item => !search || item.label.includes(search)).map(item =>
          <button key={item.markId} type="button" className="prompt-reference-menu__option" onClick={() => onAnnotation(item)}><span>{item.label}</span></button>)}</> : null}
      </div>
    </PromptFloatingMenu>
    {!search.trim() && side ? <SideMenu anchor={side.anchor} kind={side.kind} menuId={menuId}>
      {shown.length ? shown.map(renderOption) : <div className="prompt-reference-menu__empty">暂无可引用资产，请连入后操作</div>}
    </SideMenu> : null}
    {preview.layer}
  </>;
}
