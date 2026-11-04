import { useCallback, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useModalFocusTrap } from "../../components/useModalFocusTrap";
import { toMediaSrc } from "../../lib/backend";
import { useDismissOnOutside, useFloatingLayerAnchor } from "../create/useFloatingLayerAnchor";
import { CanvasFeatureAssetPicker, type ListFeatureAssets } from "./CanvasFeatureAssetPicker";
import {
  CANVAS_FEATURE_GROUPS,
  canvasFeatureMediaType,
  type CanvasFeatureAction,
  type CanvasFeatureTarget,
  type FeatureCard,
} from "./canvasFeatureCatalog";
import { LibTVMediaIcon } from "./LibTVMediaIcon";
import type { AssetItem } from "./workspaceModel";
import "./CanvasAllFeaturesDialog.css";

const RECENT_TOOLS_KEY = "canvas-all-features-recent";

interface CatalogItem extends FeatureCard {
  readonly key: string;
  readonly group: string;
  readonly context: string;
}

const SECTIONS = CANVAS_FEATURE_GROUPS.map(group => ({
  label: group.label,
  items: group.cards.map((card): CatalogItem => ({
    ...card, group: group.label, key: group.label + "/" + card.label, context: group.label,
  })),
}));

function featureLeaves(card: CatalogItem): readonly CatalogItem[] {
  if (!card.children) return [card];
  return card.children.map(child => ({
    ...child,
    icon: card.icon,
    ...(card.premium ? { premium: true } : {}),
    group: card.group,
    key: card.key + "/" + child.label,
    context: card.group + " · " + card.label,
  }));
}

const FEATURE_LEAVES = SECTIONS.flatMap(section => section.items.flatMap(featureLeaves));

function readRecentTools(): readonly string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(RECENT_TOOLS_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((key): key is string => typeof key === "string").slice(0, 3) : [];
  } catch {
    return [];
  }
}

export function CanvasAllFeaturesDialog({ onClose, getTargets, onChoose, listAssets, onChooseAsset, onChooseFile, hasCloud }: {
  readonly onClose: () => void;
  readonly getTargets: (action: CanvasFeatureAction) => readonly CanvasFeatureTarget[];
  readonly onChoose: (action: CanvasFeatureAction, targetKey: string, label: string) => boolean;
  readonly listAssets: ListFeatureAssets;
  readonly onChooseAsset: (action: CanvasFeatureAction, asset: AssetItem, label: string) => boolean;
  readonly onChooseFile: (kind: AssetItem["kind"], path: string | null, signal: AbortSignal) => Promise<AssetItem | null>;
  readonly hasCloud: boolean;
}) {
  const titleId = useId();
  const menuId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const scrollBeforePick = useRef(0);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<CatalogItem | null>(null);
  const [selection, setSelection] = useState<(CatalogItem & { action: CanvasFeatureAction }) | null>(null);
  const [recentKeys, setRecentKeys] = useState(readRecentTools);
  const { ref: menuRef, layerId } = useFloatingLayerAnchor<HTMLDivElement>({
    open: expanded != null, anchorRef, minWidth: 0, preferAbove: false, maxHeight: 412, gap: 3,
  });
  const closeMenu = useCallback(() => setExpanded(null), []);
  useDismissOnOutside(expanded != null, menuRef, anchorRef, closeMenu, layerId);
  const { ref, containerProps } = useModalFocusTrap({
    active: true,
    initialFocusRef: searchRef,
    onEscape: () => {
      if (selection) setSelection(null);
      else if (expanded) {
        closeMenu();
        anchorRef.current?.focus();
      } else onClose();
    },
  });

  useLayoutEffect(() => {
    if (selection) {
      document.querySelector<HTMLElement>(".canvas-feature-picker__sidebar button[aria-pressed='true']")?.focus();
    } else {
      bodyRef.current?.scrollTo(0, scrollBeforePick.current);
      searchRef.current?.focus({ preventScroll: true });
    }
  }, [selection]);
  useLayoutEffect(() => {
    if (expanded) menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
  }, [expanded, menuRef]);

  function complete(item: CatalogItem) {
    const next = [item.key, ...recentKeys.filter(key => key !== item.key)].slice(0, 3);
    setRecentKeys(next);
    try { localStorage.setItem(RECENT_TOOLS_KEY, JSON.stringify(next)); } catch { /* Storage can be disabled. */ }
    onClose();
  }

  function chooseFeature(item: CatalogItem) {
    const { action } = item;
    if (!action) return;
    closeMenu();
    const selected = getTargets(action).filter(target => target.selected);
    const target = selected.length === 1 ? selected[0] : undefined;
    if (target && onChoose(action, target.key, item.label)) {
      complete(item);
      return;
    }
    scrollBeforePick.current = bodyRef.current?.scrollTop ?? 0;
    setSelection({ ...item, action });
  }

  function updateQuery(value: string) {
    setQuery(value);
    closeMenu();
    bodyRef.current?.scrollTo(0, 0);
  }

  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const results = terms.length ? FEATURE_LEAVES.filter(item =>
    terms.every(term => (item.context + " " + item.label).toLocaleLowerCase().includes(term))) : null;
  const recent = recentKeys.flatMap(key => {
    const item = FEATURE_LEAVES.find(candidate => candidate.key === key);
    return item?.action ? [item] : [];
  });
  const groups = results ? [{ label: "搜索结果", items: results, withContext: true }]
    : [...(recent.length ? [{ label: "最近使用", items: recent }] : []), ...SECTIONS];

  function renderSection(group: { label: string; items: readonly CatalogItem[]; withContext?: boolean }) {
    return (
      <section key={group.label} className="canvas-all-features__group" aria-label={group.label}>
        <h3>{group.label}</h3>
        <div className="canvas-all-features__grid">
          {group.items.map(card => {
            const open = expanded?.key === card.key;
            const disabled = !card.action && !card.children?.some(child => child.action);
            return (
              <span key={card.key} data-tooltip={disabled ? card.unavailable ?? "暂未接入" : undefined}>
                <button type="button" className="canvas-all-features__card" disabled={disabled}
                  aria-haspopup={card.children ? "menu" : undefined} aria-expanded={card.children ? open : undefined}
                  aria-controls={open ? menuId : undefined} aria-description={disabled ? card.unavailable : undefined}
                  onClick={event => {
                    anchorRef.current = event.currentTarget;
                    if (card.children) setExpanded(open ? null : card);
                    else chooseFeature(card);
                  }}>
                  <span className="canvas-all-features__glyph"><LibTVMediaIcon name={card.icon} size={18} /></span>
                  <span className="canvas-all-features__tool-text">
                    <span className="canvas-all-features__tool-label">
                      <span>{card.label}</span>
                      {card.premium ? <LibTVMediaIcon name="vip-model" size={14} className="canvas-all-features__premium" /> : null}
                    </span>
                    {group.withContext ? <small>{card.context}</small> : null}
                  </span>
                  {card.children ? <span className="canvas-all-features__chevron"><LibTVMediaIcon name="feature-chevron" size={18} /></span> : null}
                </button>
              </span>
            );
          })}
        </div>
      </section>
    );
  }

  return createPortal(
    <div className="canvas-all-features-scrim" onClick={event => {
      if (event.target === event.currentTarget) {
        if (selection) setSelection(null);
        else onClose();
      }
    }}>
      <section ref={ref} {...containerProps} className={selection ? "canvas-all-features canvas-all-features--picker" : "canvas-all-features"}
        role="dialog" aria-modal="true" aria-labelledby={titleId}>
        {selection ? (
          <CanvasFeatureAssetPicker titleId={titleId} kind={canvasFeatureMediaType(selection.action)}
            targets={getTargets(selection.action)} listAssets={listAssets} hasCloud={hasCloud} onBack={() => setSelection(null)}
            onChoose={key => { if (onChoose(selection.action, key, selection.label)) complete(selection); }}
            onChooseAsset={asset => { if (onChooseAsset(selection.action, asset, selection.label)) complete(selection); }}
            onChooseFile={async (path, signal) => {
              if (path) {
                const src = toMediaSrc(path);
                const existing = getTargets(selection.action).find(target => target.previewSrc === src);
                if (existing) {
                  if (onChoose(selection.action, existing.key, selection.label)) complete(selection);
                  return;
                }
              }
              const asset = await onChooseFile(canvasFeatureMediaType(selection.action), path, signal);
              if (asset && !signal.aborted && onChooseAsset(selection.action, asset, selection.label)) complete(selection);
            }} />
        ) : (
          <>
            <header className="canvas-all-features__header">
              <h2 id={titleId}>全部功能</h2>
              <div className="canvas-all-features__search">
                <LibTVMediaIcon name="feature-search" size={16} />
                <input ref={searchRef} type="text" value={query} aria-label="搜索功能" placeholder="搜索功能"
                  onChange={event => updateQuery(event.target.value)} />
                {query ? <button type="button" aria-label="清空搜索" onClick={() => {
                  updateQuery("");
                  searchRef.current?.focus();
                }}><LibTVMediaIcon name="library-q4-close" size={14} /></button> : null}
              </div>
              <button type="button" className="canvas-all-features__close" aria-label="关闭全部功能" onClick={onClose}>
                <LibTVMediaIcon name="library-q4-close" size={16} />
              </button>
            </header>
            {results && !results.length ? (
              <div className="canvas-all-features__empty">
                <LibTVMediaIcon name="page-cross" size={32} />
                <p role="status">未找到相关功能</p>
                <button type="button" onClick={() => { updateQuery(""); searchRef.current?.focus(); }}>清空搜索</button>
              </div>
            ) : (
              <div ref={bodyRef} className="canvas-all-features__body" onScroll={closeMenu}>
                {groups.map(renderSection)}
              </div>
            )}
            {expanded ? (
              <div id={menuId} ref={menuRef} role="menu" aria-label={expanded.label} className="canvas-all-features__choices"
                onKeyDown={event => {
                  if (event.nativeEvent.isComposing || event.defaultPrevented) return;
                  const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
                  const index = items.indexOf(document.activeElement as HTMLButtonElement);
                  const next = event.key === "ArrowDown" ? (index + 1) % items.length
                    : event.key === "ArrowUp" ? (index - 1 + items.length) % items.length
                    : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : null;
                  if (next != null) { event.preventDefault(); items[next]?.focus(); }
                }}>
                {featureLeaves(expanded).map(child => (
                  <span key={child.key} data-tooltip={child.action ? undefined : child.unavailable ?? "暂未接入"}>
                    <button type="button" role="menuitem" disabled={!child.action} aria-description={child.unavailable}
                      onClick={() => chooseFeature(child)}>{child.label}</button>
                  </span>
                ))}
              </div>
            ) : null}
          </>
        )}
      </section>
    </div>, document.body,
  );
}
