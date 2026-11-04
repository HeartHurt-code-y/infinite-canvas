import { useId, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { Check, Minus, Navigation } from "lucide-react";
import { CanvasSelect } from "../../components/CanvasSelect";
import { Icon } from "../../components/Icon";
import type { CanvasGroups } from "../canvas/canvasGroups";
import { LibTVMediaIcon, type LibTVMediaIconName } from "./LibTVMediaIcon";
import "./CanvasAssetDrawer.css";

export type CanvasAssetDrawerTab = "canvas" | "assets";
export type CanvasDrawerNodeKind = "text" | "image" | "video" | "audio" | "screenplay" | "videoClip" | "director" | "style" | "effect";

export interface CanvasDrawerNode {
  readonly id: string;
  readonly name: string;
  readonly kind: CanvasDrawerNodeKind;
  readonly thumbnail: string | null;
  readonly groupId: string | undefined;
  readonly rating: number;
}

const TABS = [{ id: "canvas", label: "画布" }, { id: "assets", label: "资产" }] as const;
const NODE_KINDS = [
  { value: "all", label: "所有节点" },
  { value: "text", label: "文本" },
  { value: "screenplay", label: "脚本" },
  { value: "image", label: "图片" },
  { value: "video", label: "视频" },
  { value: "videoClip", label: "智能剪辑" },
  { value: "director", label: "导演台" },
  { value: "audio", label: "音频" },
  { value: "style", label: "风格" },
  { value: "effect", label: "特效" },
] as const;
const NODE_ICONS: Record<CanvasDrawerNodeKind, LibTVMediaIconName> = {
  text: "icon-text",
  image: "icon-image-filled",
  video: "icon-play-filled-small",
  audio: "thumbnail-audio",
  screenplay: "icon-script-ai",
  videoClip: "menu-q4-smart-clip",
  director: "menu-q4-director",
  style: "style-cube",
  effect: "lens-aperture",
};
const STAR_OPTIONS = [1, 2, 3, 4, 5].map((value) => ({
  value: String(value),
  label: value + " 星",
  icon: <LibTVMediaIcon name="star-filled" size={12} className="canvas-asset-drawer__star" />,
}));
const RATINGS = [{ value: "all", label: "所有评级" }, { value: "0", label: "未评级" }, ...STAR_OPTIONS];
const NODE_RATINGS = RATINGS.slice(1);
const WIDTH_MIN = 240;
const WIDTH_MAX = 480;

function panelWidth(width: number) {
  return Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, width));
}

function DrawerNodeRow({ node, selected, onLocate, onRate }: {
  readonly node: CanvasDrawerNode;
  readonly selected: boolean;
  readonly onLocate: (id: string) => void;
  readonly onRate: (id: string, rating: number) => void;
}) {
  return (
    <li className="canvas-asset-drawer__node" data-selected={selected || undefined}>
      <button type="button" className="canvas-asset-drawer__row"
        aria-current={selected ? "true" : undefined} onClick={() => onLocate(node.id)}>
        <span className="canvas-asset-drawer__thumbnail">
          <LibTVMediaIcon name={NODE_ICONS[node.kind]} size={16} />
          {node.thumbnail ? (
            <img key={node.thumbnail} src={node.thumbnail} alt="" loading="lazy" draggable={false}
              onError={(event) => { event.currentTarget.hidden = true; }} />
          ) : null}
        </span>
        <span className="canvas-asset-drawer__name" title={node.name}>{node.name}</span>
      </button>
      <CanvasSelect
        ariaLabel={node.name + "评级"}
        className="canvas-asset-drawer__rating"
        value={String(node.rating)}
        options={NODE_RATINGS}
        triggerValue={{ label: node.rating ? String(node.rating) : "", icon: STAR_OPTIONS[0]?.icon }}
        chevronIcon={<></>}
        onChange={(value) => onRate(node.id, Number(value))}
      />
    </li>
  );
}

function DrawerReferenceRow({ node, checked, target, onPick, onLocate }: {
  readonly node: CanvasDrawerNode;
  readonly checked: boolean | undefined;
  readonly target: boolean;
  readonly onPick: () => void;
  readonly onLocate: () => void;
}) {
  return (
    <li className="canvas-asset-drawer__node" data-selected={target || undefined} data-reference-checked={checked || undefined}>
      <button type="button" className="canvas-asset-drawer__row canvas-asset-drawer__reference-row"
        role={target ? undefined : "checkbox"} aria-checked={target ? undefined : (checked ?? false)}
        aria-label={target ? `定位到节点 ${node.name}` : `选择 ${node.name}`}
        disabled={!target && checked === undefined} onClick={target ? onLocate : onPick}>
        <span className="canvas-asset-drawer__thumbnail">
          <LibTVMediaIcon name={NODE_ICONS[node.kind]} size={16} />
          {node.thumbnail ? <img key={node.thumbnail} src={node.thumbnail} alt="" loading="lazy" draggable={false}
            onError={event => { event.currentTarget.hidden = true; }} /> : null}
        </span>
        <span className="canvas-asset-drawer__name" title={node.name}>{node.name}</span>
        {target || checked ? <span aria-hidden="true" className="canvas-asset-drawer__reference-mark">
          {target ? <Navigation size={14} /> : <Check size={14} />}
        </span> : null}
      </button>
    </li>
  );
}

export function CanvasAssetDrawer({
  tab,
  onTabChange,
  onClose,
  canvases,
  activeCanvasId,
  onSelectCanvas,
  nodes,
  groups,
  selectedNodeKey,
  onLocateNode,
  onLocateGroup,
  onRateNode,
  referenceSelection,
  onPickReferences,
  children,
}: {
  readonly tab: CanvasAssetDrawerTab | null;
  readonly onTabChange: (tab: CanvasAssetDrawerTab) => void;
  readonly onClose: () => void;
  readonly canvases: readonly { readonly id: string; readonly name: string }[];
  readonly activeCanvasId: string;
  readonly onSelectCanvas: (id: string) => void;
  readonly nodes: readonly CanvasDrawerNode[];
  readonly groups: CanvasGroups;
  readonly selectedNodeKey: string | null;
  readonly onLocateNode: (id: string) => void;
  readonly onLocateGroup: (id: string) => void;
  readonly onRateNode: (id: string, rating: number) => void;
  readonly referenceSelection?: ReadonlyMap<string, boolean> | null;
  readonly onPickReferences?: (keys: readonly string[]) => void;
  readonly children: ReactNode;
}) {
  const [width, setWidth] = useState(320);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("all");
  const [rating, setRating] = useState("all");
  const [view, setView] = useState("list");
  const [foldedGroups, setFoldedGroups] = useState<ReadonlySet<string>>(() => new Set());
  const searchRef = useRef<HTMLInputElement>(null);
  const searchTrigger = useRef<HTMLButtonElement>(null);
  const drag = useRef<{ readonly x: number; readonly width: number } | null>(null);
  const id = useId();
  const needle = query.trim().toLocaleLowerCase();
  const byGroup = new Map<string, CanvasDrawerNode[]>();
  const roots: (CanvasDrawerNode | string)[] = [];
  const groupIds = new Set<string>();
  for (const node of nodes) {
    const groupId = node.groupId;
    const group = groupId ? groups[groupId] : undefined;
    if (group) groupIds.add(group.id);
    if (kind !== "all" && node.kind !== kind) continue;
    if (rating !== "all" && node.rating !== Number(rating)) continue;
    if (needle && !node.name.toLocaleLowerCase().includes(needle)
      && !group?.name.toLocaleLowerCase().includes(needle)) continue;
    if (!group) {
      roots.push(node);
      continue;
    }
    const members = byGroup.get(group.id);
    if (members) members.push(node);
    else {
      byGroup.set(group.id, [node]);
      roots.push(group.id);
    }
  }
  const renderNode = (node: CanvasDrawerNode) => referenceSelection ? (
    <DrawerReferenceRow key={node.id} node={node} checked={referenceSelection.get(node.id)}
      target={selectedNodeKey === node.id} onPick={() => onPickReferences?.([node.id])} onLocate={() => onLocateNode(node.id)} />
  ) : (
    <DrawerNodeRow key={node.id} node={node} selected={selectedNodeKey === node.id}
      onLocate={onLocateNode} onRate={onRateNode} />
  );
  const toggleGroup = (groupId: string) => {
    setFoldedGroups((previous) => {
      const next = new Set(previous);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };
  const startResize = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const panel = event.currentTarget.parentElement;
    drag.current = { x: event.clientX, width: panel?.getBoundingClientRect().width ?? width };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const changeSearch = (open: boolean) => {
    setSearchOpen(open);
    if (open) window.requestAnimationFrame(() => searchRef.current?.focus());
    else {
      setQuery("");
      window.requestAnimationFrame(() => searchTrigger.current?.focus());
    }
  };
  return (
    <aside id="canvas-asset-drawer" className="canvas-asset-drawer" aria-label="资产管理"
      hidden={tab == null} style={{ width }}>
      <div className="canvas-asset-drawer__header">
        <span className="canvas-asset-drawer__workspace-mark" aria-hidden="true">
          <Icon name="bounding-box" size="2xl" />
        </span>
        <div className="canvas-asset-drawer__project">
          <span>无限画布</span>
          <CanvasSelect
            ariaLabel="切换画布"
            className="canvas-asset-drawer__select"
            value={activeCanvasId}
            options={canvases.map((canvas) => ({ value: canvas.id, label: canvas.name }))}
            onChange={onSelectCanvas}
            chevronIcon={<LibTVMediaIcon name="icon-chevron-down-small" size={12} />}
          />
        </div>
      </div>
      <div className="canvas-asset-drawer__tabs" role="tablist" aria-label="资产管理视图">
        {TABS.map(({ id: item, label }) => (
          <button type="button" key={item} role="tab" aria-selected={tab === item}
            id={id + item + "-tab"} aria-controls={id + item} tabIndex={tab === item ? 0 : -1}
            onClick={() => onTabChange(item)}
            onKeyDown={(event) => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const next = event.key === "Home" ? "canvas" : event.key === "End" ? "assets"
                : item === "canvas" ? "assets" : "canvas";
              onTabChange(next);
              document.getElementById(id + next + "-tab")?.focus();
            }}>
            {label}
          </button>
        ))}
      </div>
      <div className="canvas-asset-drawer__canvas" role="tabpanel" id={id + "canvas"}
        aria-labelledby={id + "canvas-tab"} hidden={tab !== "canvas"}>
        <div className="canvas-asset-drawer__tools">
          {searchOpen ? (
            <div className="canvas-asset-drawer__search">
              <LibTVMediaIcon name="icon-search" size={18} />
              <input ref={searchRef} type="search" aria-label="搜索画布节点" placeholder="搜索节点"
                value={query} onChange={(event) => setQuery(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Escape" || event.nativeEvent.isComposing || event.keyCode === 229) return;
                  event.preventDefault();
                  event.stopPropagation();
                  changeSearch(false);
                }} />
              <button type="button" aria-label="关闭节点搜索" onClick={() => changeSearch(false)}>
                <LibTVMediaIcon name="icon-close-medium" size={14} />
              </button>
            </div>
          ) : (
            <button type="button" ref={searchTrigger} aria-label="搜索画布节点" data-tooltip="搜索画布节点"
              onClick={() => changeSearch(true)}>
              <LibTVMediaIcon name="icon-search" size={18} />
            </button>
          )}
          <CanvasSelect
            ariaLabel="筛选画布节点"
            className="canvas-asset-drawer__filter"
            value={kind} options={NODE_KINDS} onChange={setKind}
            triggerValue={{ label: "", icon: <LibTVMediaIcon name="list-filter" size={16} /> }}
            chevronIcon={<></>}
          />
          <CanvasSelect
            ariaLabel="按评级筛选"
            className="canvas-asset-drawer__select canvas-asset-drawer__rating-filter"
            value={rating} options={RATINGS} onChange={setRating}
            chevronIcon={<LibTVMediaIcon name="icon-chevron-down-small" size={12} />}
          />
          <CanvasSelect
            ariaLabel="节点显示方式"
            className="canvas-asset-drawer__view"
            value={view}
            options={[
              { value: "list", label: "列表视图", icon: <LibTVMediaIcon name="icon-list-bullets" size={16} /> },
              { value: "grid", label: "网格视图", icon: <LibTVMediaIcon name="layout-window" size={16} /> },
              { value: "expand", label: "展开所有分组", disabled: groupIds.size === 0,
                icon: <LibTVMediaIcon name="icon-list-expand" size={16} /> },
              { value: "collapse", label: "收起所有分组", disabled: groupIds.size === 0,
                icon: <LibTVMediaIcon name="icon-list-collapse" size={16} /> },
            ]}
            onChange={(value) => {
              if (value === "expand") setFoldedGroups(new Set());
              else if (value === "collapse") setFoldedGroups(groupIds);
              else setView(value);
            }}
            triggerValue={{
              label: "",
              icon: <LibTVMediaIcon name={view === "list" ? "icon-list-bullets" : "layout-window"} size={18} />,
            }}
            chevronIcon={<></>}
          />
        </div>
        <div className="canvas-asset-drawer__scroll">
          {roots.length === 0 ? (
            <p className="canvas-asset-drawer__empty">{nodes.length ? "没有匹配的节点" : "当前画布还没有节点"}</p>
          ) : (
            <ul className="canvas-asset-drawer__tree" data-view={view} aria-label="画布节点">
              {roots.map((item) => {
                if (typeof item !== "string") return renderNode(item);
                const group = groups[item]!;
                const expanded = !foldedGroups.has(item);
                const members = byGroup.get(item) ?? [];
                const candidates = referenceSelection ? members.filter(node => referenceSelection.has(node.id)) : [];
                const checkedCount = candidates.filter(node => referenceSelection?.get(node.id)).length;
                return (
                  <li key={item} className="canvas-asset-drawer__group">
                    <div className="canvas-asset-drawer__group-heading">
                      <button type="button" aria-label={(expanded ? "收起" : "展开") + group.name}
                        aria-expanded={expanded} onClick={() => toggleGroup(item)}>
                        <LibTVMediaIcon name={expanded ? "icon-chevron-down-small" : "icon-chevron-right-small"} size={12} />
                      </button>
                      <button type="button" className="canvas-asset-drawer__row"
                        role={referenceSelection ? "checkbox" : undefined}
                        aria-label={referenceSelection ? `选择整组 ${group.name}` : undefined}
                        aria-checked={referenceSelection ? checkedCount > 0 && checkedCount < candidates.length ? "mixed"
                          : checkedCount > 0 : undefined}
                        disabled={referenceSelection != null && candidates.length === 0}
                        onClick={() => referenceSelection ? onPickReferences?.(candidates.map(node => node.id)) : onLocateGroup(item)}>
                        <LibTVMediaIcon name="workspace-layer-group-thumb" size={32} className="canvas-asset-drawer__folder" />
                        <span className="canvas-asset-drawer__name" title={group.name}>{group.name}</span>
                        {checkedCount > 0 ? <span className="canvas-asset-drawer__reference-mark" aria-hidden="true">
                          {checkedCount === candidates.length ? <Check size={14} /> : <Minus size={14} />}
                        </span> : null}
                      </button>
                    </div>
                    {expanded ? <ul className="canvas-asset-drawer__members">{members.map(renderNode)}</ul> : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
      <div className="canvas-asset-drawer__assets" role="tabpanel" id={id + "assets"}
        aria-labelledby={id + "assets-tab"} hidden={tab !== "assets"}>
        {children}
      </div>
      <footer className="canvas-asset-drawer__footer">
        <button type="button" aria-label="收起资产管理" data-tooltip="收起资产管理" onClick={onClose}>
          <LibTVMediaIcon name="collapse-sidebar" size={16} />
        </button>
        <span>共 {nodes.length + groupIds.size} 节点</span>
      </footer>
      <div className="canvas-asset-drawer__resize" role="separator" aria-label="调整资产管理面板宽度"
        aria-orientation="vertical" aria-valuemin={WIDTH_MIN} aria-valuemax={WIDTH_MAX}
        aria-valuenow={width} tabIndex={0} onPointerDown={startResize}
        onPointerMove={(event) => {
          if (drag.current && event.currentTarget.hasPointerCapture(event.pointerId)) {
            setWidth(panelWidth(drag.current.width + event.clientX - drag.current.x));
          }
        }}
        onLostPointerCapture={() => { drag.current = null; }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          setWidth((value) => panelWidth(value + (event.key === "ArrowLeft" ? -16 : 16)));
        }} />
    </aside>
  );
}
