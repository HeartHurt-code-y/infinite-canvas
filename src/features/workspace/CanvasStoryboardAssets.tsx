import { useEffect, useId, useMemo, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { useEscapeHandler } from "../../components/escapeArbiter";
import { backendErrorMessage } from "../../lib/backend";
import { toMediaProxyUrl } from "../../lib/mediaProxy";
import { canvasReadModelOfState, useCanvas, useCanvasStore, type CanvasReadModel } from "../canvas/canvasStore";
import { exportArtifactDeliveryToDesktop } from "./artifactDelivery";
import { CanvasFeatureAssetPicker, type ListFeatureAssets } from "./CanvasFeatureAssetPicker";
import { CanvasChromeIcon } from "./CanvasChromeIcons";
import type { CanvasFeatureTarget } from "./canvasFeatureCatalog";
import { copyTextToDesktopClipboard } from "./desktopActions";
import { LibTVMediaIcon, type LibTVMediaIconName } from "./LibTVMediaIcon";
import {
  STORYBOARD_ASSET_DRAG_TYPE, STORYBOARD_KINDS, storyboardFilmSource,
  type StoryboardAsset, type StoryboardAssetKind, type StoryboardFilmSource, type StoryboardImageCategory,
} from "./storyboardProject";
import type { AssetItem } from "./workspaceModel";
import "./CanvasStoryboard.css";

const kinds = {
  image: { name: "图片", icon: "icon-image-filled" },
  video: { name: "视频", icon: "icon-play-filled-small" },
  audio: { name: "音频", icon: "thumbnail-audio" },
  text: { name: "文本", icon: "icon-text" },
} as const;
const imageCategories = [
  ["character", "角色"], ["scene", "场景"], ["prop", "物品"], ["other", "其他"],
] as const;
const imageFilters = [["all", "全部"], ...imageCategories] as const;
const videoFilters = [["all", "全部"], ["clip", "视频片段"], ["film", "成片"]] as const;
const textFilters = [["all", "全部"], ["script", "剧本"], ["text", "文本"]] as const;

function AssetIconButton({ label, icon, onClick, disabled = false, pressed }: {
  readonly label: string;
  readonly icon: LibTVMediaIconName;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly pressed?: boolean;
}) {
  return <button type="button" className="storyboard-assets__icon" aria-label={label} data-tooltip={label}
    disabled={disabled} aria-pressed={pressed} onClick={onClick}><LibTVMediaIcon name={icon} size={17} /></button>;
}

export function StoryboardResizeHandle({ axis, label, value, min, max, onResize, onReset, onPreview, reverse = false, scale = 1 }: {
  readonly axis: "horizontal" | "vertical";
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly onResize: (value: number) => void;
  readonly onPreview?: (value: number) => void;
  readonly onReset: () => void;
  readonly reverse?: boolean;
  readonly scale?: number;
}) {
  const drag = useRef<{ pointer: number; start: number; value: number; latest: number } | null>(null);
  const position = (event: PointerEvent) => axis === "horizontal" ? event.clientX : event.clientY;
  const clamped = (next: number) => Math.round(Math.max(min, Math.min(max, next)));
  return <div role="separator" tabIndex={0} aria-label={label} data-tooltip={label + " · 双击恢复默认"}
    aria-orientation={axis === "horizontal" ? "vertical" : "horizontal"} aria-valuenow={Math.round(value)}
    aria-valuemin={min} aria-valuemax={max} className={"storyboard-resize storyboard-resize--" + axis}
    onPointerDown={event => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { pointer: event.pointerId, start: position(event), value, latest: value };
    }} onPointerMove={event => {
      const start = drag.current;
      if (start?.pointer !== event.pointerId) return;
      start.latest = clamped(start.value + (position(event) - start.start) * scale * (reverse ? -1 : 1));
      (onPreview ?? onResize)(start.latest);
    }} onLostPointerCapture={() => {
      const finished = drag.current;
      drag.current = null;
      if (finished && onPreview && finished.latest !== finished.value) onResize(finished.latest);
    }} onPointerCancel={() => {
      if (drag.current) onPreview?.(drag.current.value);
      drag.current = null;
    }} onDoubleClick={onReset}
    onKeyDown={event => {
      const previous = axis === "horizontal" ? "ArrowLeft" : "ArrowUp";
      const next = axis === "horizontal" ? "ArrowRight" : "ArrowDown";
      if (event.key !== previous && event.key !== next && event.key !== "Home") return;
      event.preventDefault();
      if (event.key === "Home") onReset();
      else onResize(clamped(value + (event.key === previous ? -16 : 16) * scale * (reverse ? -1 : 1)));
    }} />;
}

function StoryboardMedia({ asset, detail = false }: { readonly asset: StoryboardAsset; readonly detail?: boolean }) {
  const src = asset.src ? toMediaProxyUrl(asset.src) ?? asset.src : undefined;
  const poster = asset.poster ? toMediaProxyUrl(asset.poster) ?? asset.poster : undefined;
  const [failed, setFailed] = useState<string>();
  const [posterFailed, setPosterFailed] = useState<string>();
  const onFailure = () => setFailed(src);
  if (asset.kind === "text" && asset.text) return <div className="storyboard-assets__text-preview">{asset.text}</div>;
  if (asset.kind === "video" && poster && !detail && posterFailed !== poster) {
    return <img src={poster} alt="" loading="lazy" onError={() => setPosterFailed(poster)} />;
  }
  if (src && failed !== src) {
    if (asset.kind === "image") return <img src={src} alt={detail ? asset.label : ""} loading="lazy" onError={onFailure} />;
    if (asset.kind === "video") return <video src={src} poster={poster} muted={!detail} controls={detail}
      playsInline preload="metadata" aria-label={detail ? asset.label : undefined} onError={onFailure} />;
    if (asset.kind === "audio" && detail) return <audio src={src} controls preload="metadata" aria-label={asset.label} onError={onFailure} />;
  }
  return <div className="storyboard-assets__placeholder">
    <LibTVMediaIcon name={asset.script ? "icon-script-ai" : kinds[asset.kind].icon} size={detail ? 32 : 20} />
    {detail ? <small>{failed ? "素材加载失败" : "暂无可预览内容"}</small> : null}
  </div>;
}

interface AssetPreferences {
  readonly categories: Readonly<Record<string, StoryboardImageCategory>>;
  readonly collapsed: readonly StoryboardAssetKind[];
  readonly order: readonly StoryboardAssetKind[];
  readonly weights: Partial<Record<StoryboardAssetKind, number>>;
}

function assetPreferences(key: string): AssetPreferences {
  const initial: AssetPreferences = { categories: {}, collapsed: [], order: STORYBOARD_KINDS, weights: {} };
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null") as Partial<AssetPreferences> | null;
    if (!value) return initial;
    const knownKinds = new Set<StoryboardAssetKind>(STORYBOARD_KINDS);
    const order = Array.isArray(value.order) ? value.order.filter(kind => knownKinds.has(kind)) : [];
    return {
      categories: Object.fromEntries(Object.entries(value.categories ?? {}).filter(([, category]) =>
        imageFilters.some(([id]) => id !== "all" && id === category))),
      collapsed: Array.isArray(value.collapsed) ? value.collapsed.filter(kind => knownKinds.has(kind)) : [],
      order: [...new Set([...order, ...STORYBOARD_KINDS])],
      weights: Object.fromEntries(Object.entries(value.weights ?? {}).filter(([kind, weight]) =>
        knownKinds.has(kind as StoryboardAssetKind) && typeof weight === "number" && Number.isFinite(weight) && weight >= .1 && weight <= 10)),
    };
  } catch {
    return initial;
  }
}

const moduleDrag = "application/x-canvas-storyboard-module";

export function CanvasStoryboardAssets({ canvasId, project, listAssets, hasCloud, getTargets, onImport, onCreate, onChooseFile, onPlace,
  onReference, onLocate, onScript, onFilm, onEditFilm }: {
  readonly canvasId: string;
  readonly project: (state: CanvasReadModel) => readonly StoryboardAsset[];
  readonly listAssets: ListFeatureAssets;
  readonly hasCloud: boolean;
  readonly getTargets: (kind: AssetItem["kind"]) => readonly CanvasFeatureTarget[];
  readonly onImport: () => Promise<void>;
  readonly onCreate: (kind: AssetItem["kind"]) => void;
  readonly onChooseFile: (kind: AssetItem["kind"], path: string | null, signal: AbortSignal) => Promise<AssetItem | null>;
  readonly onPlace: (asset: AssetItem) => void;
  readonly onReference: (asset: StoryboardAsset) => void;
  readonly onLocate: (key: string) => void;
  readonly onScript: (sourceKey?: string) => void;
  readonly onFilm: (sources: readonly StoryboardFilmSource[]) => Promise<void>;
  readonly onEditFilm: (key: string) => void;
}) {
  // Subscribe to the creative graph, independently of changes to viewport and selection.
  const { nodes, groups } = useCanvas(useShallow(state => ({ nodes: state.nodes, groups: state.groups })));
  const store = useCanvasStore();
  const assets = useMemo(() => project(canvasReadModelOfState(store.getState())), [project, store, nodes, groups]);
  const key = "canvas-storyboard-assets:v1:" + canvasId;
  const [prefs, setPrefs] = useState(() => assetPreferences(key));
  const [searching, setSearching] = useState(false);
  const [search, setSearch] = useState("");
  const [menu, setMenu] = useState<"add" | "options" | null>(null);
  const [picker, setPicker] = useState<AssetItem["kind"] | null>(null);
  const [filters, setFilters] = useState<Partial<Record<StoryboardAssetKind, string>>>({});
  const [nav, setNav] = useState<{ keys: readonly (string | null)[]; index: number }>({ keys: [null], index: 0 });
  const [selection, setSelection] = useState<"export" | "film" | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const [working, setWorking] = useState(false);
  const [issue, setIssue] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLElement>(null);
  const modules = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const current = assets.find(asset => asset.key === nav.keys[nav.index]);
  const query = search.trim().toLocaleLowerCase();
  const visibleKinds = prefs.order.filter(kind => assets.some(asset => asset.kind === kind));
  const chosen = assets.flatMap(asset => asset.delivery && picked.has(asset.key) ? [asset.delivery] : []);
  const currentFilmSource = current ? storyboardFilmSource(current) : null;
  const chosenClips = selection === "film" ? [...picked].flatMap(key => {
    const asset = assets.find(item => item.key === key);
    const source = asset ? storyboardFilmSource(asset) : null;
    return source ? [source] : [];
  }) : [];
  const hasVideo = assets.some(asset => storyboardFilmSource(asset));

  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(prefs)); } catch { /* Keep the current view usable. */ }
  }, [key, prefs]);
  useEffect(() => { if (searching) searchInput.current?.focus(); }, [searching]);
  useEffect(() => {
    if (!menu) return;
    const dismiss = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && panel.current?.contains(target) &&
          target.closest(".storyboard-assets__header, .storyboard-assets__menu")) return;
      setMenu(null);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [menu]);
  useEscapeHandler({
    canHandle: event => event.target instanceof Node && !!panel.current?.contains(event.target) &&
      (menu != null || picker != null || searching || !!current || selection != null),
    handle: () => {
      if (menu) setMenu(null);
      else if (picker) setPicker(null);
      else if (searching) { setSearch(""); setSearching(false); }
      else if (current) visit(null);
      else if (!working) selectMode(null);
    },
  });

  function visit(target: string | null) {
    setMenu(null);
    setPicker(null);
    setIssue("");
    setNav(previous => {
      if (previous.keys[previous.index] === target) return previous;
      const keys = [...previous.keys.slice(0, previous.index + 1), target].slice(-80);
      return { keys, index: keys.length - 1 };
    });
  }

  function selectMode(mode: typeof selection) {
    visit(null);
    setPicked(new Set());
    setSelection(mode);
    if (mode === "film") setPrefs(previous => ({ ...previous,
      collapsed: previous.collapsed.filter(kind => kind !== "video"),
    }));
  }

  function switchModule(kind: StoryboardAssetKind) {
    setPrefs(previous => ({ ...previous, collapsed: previous.collapsed.includes(kind)
      ? previous.collapsed.filter(item => item !== kind) : [...previous.collapsed, kind] }));
  }

  function moveModule(kind: StoryboardAssetKind, target: StoryboardAssetKind, below = false) {
    setPrefs(previous => {
      if (kind === target) return previous;
      const order = previous.order.filter(item => item !== kind);
      order.splice(order.indexOf(target) + Number(below), 0, kind);
      return { ...previous, order };
    });
  }

  const moduleWeight = (kind: StoryboardAssetKind) => prefs.weights[kind] ?? (kind === "image" ? 1.42 : 1);

  async function run(action: () => Promise<void>) {
    if (working) return;
    setIssue("");
    setWorking(true);
    try { await action(); } catch (error) { setIssue(backendErrorMessage(error)); } finally { setWorking(false); }
  }

  function putAsset(asset: AssetItem) {
    try {
      onPlace(asset);
      setPicker(null);
    } catch (error) {
      setIssue(backendErrorMessage(error));
    }
  }

  function renderList(kind: StoryboardAssetKind, items: readonly StoryboardAsset[]): ReactNode {
    const order = selection === "film" ? new Map(chosenClips.map((clip, index) => [clip.key, index + 1])) : null;
    return <div className={"storyboard-assets__grid storyboard-assets__grid--" + kind}>
      {items.map(asset => <button key={asset.key} type="button" className="storyboard-assets__tile"
        data-tooltip={asset.label} aria-pressed={selection ? picked.has(asset.key) : undefined}
        disabled={working || (selection === "export" && !asset.delivery) || (selection === "film" && !storyboardFilmSource(asset))}
        draggable={!selection}
        onDragStart={event => {
          event.dataTransfer.setData(STORYBOARD_ASSET_DRAG_TYPE, asset.key);
          event.dataTransfer.effectAllowed = "copy";
        }}
        onClick={() => {
          if (!selection) visit(asset.key);
          else setPicked(previous => {
            const next = new Set(previous);
            if (next.has(asset.key)) next.delete(asset.key);
            else next.add(asset.key);
            return next;
          });
        }}>
        <span className="storyboard-assets__thumb">
          <StoryboardMedia asset={asset} />
          {order?.has(asset.key) ? <span className="storyboard-assets__clip-order" aria-label={`第 ${order.get(asset.key)} 段`}>{order.get(asset.key)}</span> : null}
        </span>
        <span>{asset.label}</span>
      </button>)}
    </div>;
  }

  return <aside ref={panel} className="storyboard-assets" aria-labelledby={titleId}>
    <header className="storyboard-assets__header">
      <AssetIconButton label="后退" icon="icon-chevron-left" disabled={nav.index <= 0}
        onClick={() => { setPicker(null); setNav({ ...nav, index: nav.index - 1 }); }} />
      <AssetIconButton label="前进" icon="icon-chevron-right-small" disabled={nav.index >= nav.keys.length - 1}
        onClick={() => { setPicker(null); setNav({ ...nav, index: nav.index + 1 }); }} />
      <h2 id={titleId}>项目素材</h2>
      <AssetIconButton label="搜索名称" icon="icon-search" pressed={searching} onClick={() => {
        setMenu(null);
        setSearching(!searching);
        if (searching) setSearch("");
      }} />
      <AssetIconButton label="添加素材" icon="plus-s" pressed={menu === "add"} onClick={() => setMenu(menu === "add" ? null : "add")} />
      <AssetIconButton label="项目素材设置" icon="list-filter" pressed={menu === "options"}
        onClick={() => setMenu(menu === "options" ? null : "options")} />
    </header>
    {searching ? <div className="storyboard-assets__search">
      <LibTVMediaIcon name="icon-search" size={16} />
      <input ref={searchInput} aria-label="搜索素材名称" placeholder="搜索名称" value={search}
        onChange={event => { setSearch(event.target.value); if (current) visit(null); }} />
      {search ? <AssetIconButton label="清空搜索" icon="close" onClick={() => { setSearch(""); searchInput.current?.focus(); }} /> : null}
    </div> : null}
    {menu ? <div className="storyboard-assets__menu" aria-label={menu === "add" ? "添加素材" : "项目素材设置"}>
      {menu === "add" ? <>
        <button type="button" disabled={working} onClick={() => { setMenu(null); void run(onImport); }}>
          <LibTVMediaIcon name="upload" size={16} />上传素材
        </button>
        {(["image", "video", "audio"] as const).map(kind => (
          <button type="button" key={kind} onClick={() => { setMenu(null); setPicker(kind); }}>
            <LibTVMediaIcon name={kind === "video" ? "menu-q4-video" : kinds[kind].icon} size={16} />从素材库选{kinds[kind].name}
          </button>
        ))}
        <hr />
        {(["image", "video", "audio"] as const).map(kind => (
          <button type="button" key={kind} onClick={() => { visit(null); onCreate(kind); }}>
            <LibTVMediaIcon name="plus-s" size={16} />新建{kinds[kind].name}节点
          </button>
        ))}
        <button type="button" onClick={() => { selectMode(null); void run(async () => onScript()); }}>
          <LibTVMediaIcon name="icon-storyboard-gen" size={16} />新建分镜脚本
        </button>
      </> : <>
        <button type="button" disabled={!hasVideo || working} onClick={() => selectMode(selection === "film" ? null : "film")}>
          <LibTVMediaIcon name="icon-storyboard-gen" size={16} />{selection === "film" ? "退出选片" : "选片制作成片"}
        </button>
        <button type="button" disabled={working} onClick={() => selectMode(selection === "export" ? null : "export")}>
          <LibTVMediaIcon name="download" size={16} />{selection === "export" ? "退出批量导出" : "批量导出"}
        </button>
        <button type="button" onClick={() => {
          setPrefs(previous => ({ ...previous, collapsed: previous.collapsed.length ? [] : [...visibleKinds] }));
          setMenu(null);
        }}><LibTVMediaIcon name="icon-list-collapse" size={16} />{prefs.collapsed.length ? "展开素材列表" : "收起素材列表"}</button>
        <button type="button" onClick={() => { setPrefs(previous => ({ ...previous, order: STORYBOARD_KINDS })); setMenu(null); }}>
          恢复默认排序
        </button>
      </>}
    </div> : null}
    {issue ? <p role="status" className="storyboard-assets__issue">{issue}</p> : null}
    {picker ? <CanvasFeatureAssetPicker kind={picker} titleId={titleId + "-library"} listAssets={listAssets}
      hasCloud={hasCloud} targets={getTargets(picker)} onChoose={visit} onChooseAsset={putAsset}
      onChooseFile={async (path, signal) => {
        const asset = await onChooseFile(picker, path, signal);
        if (asset && !signal.aborted) putAsset(asset);
      }} onBack={() => setPicker(null)} /> : current ? (
      <section className="storyboard-assets__detail" key={current.key} aria-label={current.label}>
        <div className="storyboard-assets__detail-title">
          <h3>{current.label}</h3>
          <AssetIconButton label="返回素材列表" icon="close" onClick={() => visit(null)} />
        </div>
        <div className={"storyboard-assets__detail-media storyboard-assets__detail-media--" + current.kind}>
          <StoryboardMedia asset={current} detail />
        </div>
        <div className="storyboard-assets__actions">
          <button type="button" onClick={() => onReference(current)}>添加到对话</button>
          <button type="button" onClick={() => onLocate(current.key)}>定位画布</button>
          {current.script ? <button type="button" disabled={working || (!current.text?.trim() && current.shots == null)}
            onClick={() => void run(async () => onScript(current.key))}>
            {current.shots != null ? "编辑分镜" : "制作分镜"}
          </button> : null}
          {current.clipEditorKey ? <button type="button" disabled={working}
            onClick={() => void run(async () => onEditFilm(current.clipEditorKey!))}>编辑成片</button> : null}
          {currentFilmSource && !current.clipEditorKey ? <button type="button" disabled={working} onClick={() => void run(() => onFilm([currentFilmSource]))}>
            打开剪辑时间轴
          </button> : null}
          {current.text ? <button type="button" onClick={() => void run(async () => {
            await copyTextToDesktopClipboard(current.text!);
            setIssue("已复制文本。");
          })}>复制文本</button> : null}
          {current.delivery ? <button type="button" disabled={working} onClick={() => void run(async () => {
            const saved = await exportArtifactDeliveryToDesktop([current.delivery!]);
            if (saved) setIssue("已导出到 " + saved);
          })}>导出</button> : null}
        </div>
        {current.kind === "image" ? <div className="storyboard-assets__filters" role="group" aria-label="设置关键元素">
          {imageCategories.map(([id, label]) => <button key={id} type="button"
            aria-pressed={(prefs.categories[current.key] ?? current.category ?? "other") === id}
            onClick={() => setPrefs(previous => ({ ...previous, categories: { ...previous.categories, [current.key]: id } }))}>{label}</button>)}
        </div> : null}
      </section>
    ) : <div className="storyboard-assets__modules" ref={modules}>
      {visibleKinds.length ? (selection === "film" ? visibleKinds.filter(kind => kind === "video") : visibleKinds).map((kind, index) => {
        const all = assets.filter(asset => asset.kind === kind);
        const activeFilter = selection === "film" ? "all" : filters[kind] ?? "all";
        const options = selection === "film" ? [] : kind === "image" ? imageFilters : kind === "video" ? videoFilters : kind === "text" ? textFilters : [];
        const items = all.filter(asset => {
          if (!asset.label.toLocaleLowerCase().includes(query)) return false;
          if (activeFilter === "all") return true;
          if (kind === "image") return (prefs.categories[asset.key] ?? asset.category ?? "other") === activeFilter;
          if (kind === "video") return (asset.finalFilm ? "film" : "clip") === activeFilter;
          return (asset.script ? "script" : "text") === activeFilter;
        });
        const collapsed = prefs.collapsed.includes(kind);
        const next = selection === "film" ? undefined : visibleKinds[index + 1];
        const totalWeight = next ? moduleWeight(kind) + moduleWeight(next) : 0;
        return <div key={kind} className="storyboard-assets__module-slot" data-collapsed={collapsed}
          style={{ flexGrow: collapsed ? 0 : moduleWeight(kind) }}>
        <section className="storyboard-assets__module" data-kind={kind} data-collapsed={collapsed}
          onDragOver={event => {
            if (!event.dataTransfer.types.includes(moduleDrag)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
          }} onDrop={event => {
            const from = event.dataTransfer.getData(moduleDrag);
            if (!STORYBOARD_KINDS.some(item => item === from)) return;
            event.preventDefault();
            const bounds = event.currentTarget.getBoundingClientRect();
            moveModule(from as StoryboardAssetKind, kind, event.clientY > bounds.top + bounds.height / 2);
          }}>
          <div className="storyboard-assets__module-header" draggable
            onKeyDown={event => {
              if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
              const after = event.key === "ArrowDown";
              const adjacent = visibleKinds[index + (after ? 1 : -1)];
              if (adjacent) { event.preventDefault(); moveModule(kind, adjacent, after); }
            }}
            onDragStart={event => { event.dataTransfer.setData(moduleDrag, kind); event.dataTransfer.effectAllowed = "move"; }}>
            <h3>{kinds[kind].name} <small>{all.length}</small></h3>
            <div className="storyboard-assets__filters" role="group" aria-label={kinds[kind].name + "分类"}>
              {options.map(([id, label]) => <button key={id} type="button" aria-pressed={activeFilter === id}
                onClick={() => setFilters(previous => ({ ...previous, [kind]: id }))}>{label}</button>)}
            </div>
            <AssetIconButton label={(collapsed ? "展开" : "收起") + kinds[kind].name} icon="icon-chevron-down-small"
              pressed={collapsed} onClick={() => switchModule(kind)} />
          </div>
          {!collapsed ? <div className="storyboard-assets__module-body">
            {items.length ? renderList(kind, items) : <p className="storyboard-assets__empty">{query ? "无匹配" : "暂无此分类素材"}</p>}
          </div> : null}
        </section>
        {next && !collapsed && !prefs.collapsed.includes(next) ? <StoryboardResizeHandle axis="vertical"
          label={`调整${kinds[kind].name}和${kinds[next].name}模块高度`} min={15} max={85}
          value={moduleWeight(kind) / totalWeight * 100} scale={100 / Math.max(180, (modules.current?.clientHeight ?? 500) * totalWeight /
            visibleKinds.filter(item => !prefs.collapsed.includes(item)).reduce((sum, item) => sum + moduleWeight(item), 0))}
          onResize={percent => setPrefs(previous => ({ ...previous, weights: { ...previous.weights,
            [kind]: totalWeight * percent / 100, [next]: totalWeight * (100 - percent) / 100,
          } }))}
          onReset={() => setPrefs(previous => {
            const weights = { ...previous.weights };
            delete weights[kind];
            delete weights[next];
            return { ...previous, weights };
          })} /> : null}
        </div>;
      }) : <p className="storyboard-assets__empty">当前画布暂无素材</p>}
    </div>}
    {selection && !picker && !current ? <footer className="storyboard-assets__export">
      <span>{selection === "film" ? `已选 ${chosenClips.length} 段，按点选顺序排列` : `已选 ${chosen.length} 项`}</span>
      <button type="button" disabled={working} onClick={() => selectMode(null)}>取消</button>
      {selection === "film" ? <button type="button" disabled={!chosenClips.length || chosenClips.length > 60 || working}
        onClick={() => void run(async () => { await onFilm(chosenClips); selectMode(null); })}>
        <LibTVMediaIcon name="icon-storyboard-gen" size={15} />{working ? "正在读取…" : "打开剪辑时间轴"}
      </button> : <button type="button" disabled={!chosen.length || working} onClick={() => void run(async () => {
        const saved = await exportArtifactDeliveryToDesktop(chosen);
        if (saved) { selectMode(null); setIssue("已导出到 " + saved); }
      })}><CanvasChromeIcon name="download" size={15} />导出</button>}
    </footer> : null}
  </aside>;
}
