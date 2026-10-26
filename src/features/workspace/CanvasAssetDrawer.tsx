import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";

import { ErrorAlert } from "../../components/ErrorAlert";
import { Icon, type IconName } from "../../components/Icon";

import "./CanvasAssetDrawer.css";

/*
 * 资产管理抽屉：对齐 liblib.tv 画布的左侧抽屉。
 *
 * 逆向规格见 docs/integrations/liblib-canvas-re.md 第 3.4 节：左侧 320px 全高，
 * 右侧 12px 调宽把手（可拖动），内容是「画布列表 → 分类 → 资产」两级树，
 * 底部计数「共 N 节点」。
 *
 * 为什么 portal 到 body：画布视口（React Flow）带 transform，会成为
 * `position: fixed` 的包含块 —— 抽屉若渲染在画布容器里就不是相对视口定位，
 * 「全高」与「贴左边缘」都会失真。挂到 body 上才能拿到真正的视口坐标系。
 */

/** 资产类型。决定条目图标与「视频节点 / 图片节点」分类的归属。 */
export type CanvasAssetKind = "image" | "video" | "audio" | "text";

/** 抽屉顶部的画布（一级树节点）。 */
export interface CanvasAssetDrawerCanvas {
  readonly id: string;
  readonly name: string;
}

/** 抽屉里的资产（二级树节点），对应当前画布里的一个节点。 */
export interface CanvasAssetDrawerAsset {
  readonly id: string;
  readonly name: string;
  readonly kind: CanvasAssetKind;
  readonly thumbnailUrl?: string | undefined;
  /** 「评级」分类：被用户打过分的节点。 */
  readonly rated?: boolean | undefined;
  /** 「高清」分类：经过放大/高清处理的节点。 */
  readonly hd?: boolean | undefined;
}

/** 资产分类页签。与原站一致：所有 / 评级 / 高清 / 视频节点 / 图片节点。 */
export type CanvasAssetCategory = "all" | "rated" | "hd" | "video" | "image";

export interface CanvasAssetDrawerProps {
  /** 是否展开。关闭时组件不渲染任何内容。 */
  readonly open: boolean;
  /** 关闭抽屉（关闭按钮、点外部、Esc 都走这里）。 */
  readonly onClose: () => void;
  /** 当前工作区里的画布列表，构成第一级树。 */
  readonly canvases: readonly CanvasAssetDrawerCanvas[];
  readonly activeCanvasId: string;
  readonly onSelectCanvas: (id: string) => void;
  /** 当前画布里的节点/资产，构成第二级树。 */
  readonly assets: readonly CanvasAssetDrawerAsset[];
  /** 点击资产条目时把它插入画布；不传表示暂不支持插入（条目置灰但仍可聚焦）。 */
  readonly onInsertAsset?: ((assetId: string) => void) | undefined;
  /** 调用方回传的插入失败等错误，组件只负责用统一的报错条呈现。 */
  readonly error?: string | null | undefined;
}

/** 抽屉宽度区间（原站默认 320px，可拖动把手在两个边界之间调整）。 */
const MIN_DRAWER_WIDTH = 240;
const MAX_DRAWER_WIDTH = 640;
const DEFAULT_DRAWER_WIDTH = 320;
/** 键盘调整宽度的步长，与原站把手的方向键手感一致。 */
const KEYBOARD_WIDTH_STEP = 16;

const CATEGORY_ORDER: readonly CanvasAssetCategory[] = ["all", "rated", "hd", "video", "image"];

const CATEGORY_LABELS: Record<CanvasAssetCategory, string> = {
  all: "所有",
  rated: "评级",
  hd: "高清",
  video: "视频节点",
  image: "图片节点",
};

const KIND_LABELS: Record<CanvasAssetKind, string> = {
  image: "图片",
  video: "视频",
  audio: "音频",
  text: "文本",
};

const KIND_ICONS: Record<CanvasAssetKind, IconName> = {
  image: "image",
  video: "video-camera",
  audio: "music-notes",
  text: "text-t",
};

/** 分类页签的过滤条件。写成表而不是 switch：新增分类时编译期就会暴露遗漏。 */
const CATEGORY_FILTERS: Record<CanvasAssetCategory, (asset: CanvasAssetDrawerAsset) => boolean> = {
  all: () => true,
  rated: (asset) => asset.rated === true,
  hd: (asset) => asset.hd === true,
  video: (asset) => asset.kind === "video",
  image: (asset) => asset.kind === "image",
};

function clampWidth(value: number): number {
  return Math.min(MAX_DRAWER_WIDTH, Math.max(MIN_DRAWER_WIDTH, Math.round(value)));
}

export function CanvasAssetDrawer({
  open,
  onClose,
  canvases,
  activeCanvasId,
  onSelectCanvas,
  assets,
  onInsertAsset,
  error = null,
}: CanvasAssetDrawerProps) {
  const [category, setCategory] = useState<CanvasAssetCategory>("all");
  const [width, setWidth] = useState(DEFAULT_DRAWER_WIDTH);
  const rootRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const tabRefs = useRef(new Map<CanvasAssetCategory, HTMLButtonElement>());
  const dragRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const titleId = useId();
  const panelId = useId();

  const filteredAssets = useMemo(
    () => assets.filter(CATEGORY_FILTERS[category]),
    [assets, category],
  );

  /*
   * 打开时把焦点收进抽屉、关闭时还回去：抽屉是覆盖在画布上的浮层，
   * 不接管焦点的话键盘用户 Tab 会跑到看不见的地方。
   */
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    closeRef.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [open]);

  /* 点外部关闭 + Esc 关闭。 */
  useEffect(() => {
    if (!open) return;
    const isFloatingLayer = (target: EventTarget | null): boolean =>
      target instanceof Element && target.closest(".canvas-select__menu") != null;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (rootRef.current?.contains(target)) return;
      // 画布下拉的菜单 portal 到 body，点它不等于点抽屉外部（见 AGENTS.md）。
      if (isFloatingLayer(target)) return;
      onClose();
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // 浮层自己要先处理 Esc（关菜单而不是关抽屉）。
      if (isFloatingLayer(event.target)) return;
      onClose();
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [open, onClose]);

  const selectCanvas = useCallback(
    (canvasId: string) => {
      if (canvasId !== activeCanvasId) onSelectCanvas(canvasId);
    },
    [activeCanvasId, onSelectCanvas],
  );

  const insertAsset = useCallback(
    (assetId: string) => {
      onInsertAsset?.(assetId);
    },
    [onInsertAsset],
  );

  /* ── 调宽把手 ─────────────────────────────────────────────────────── */

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      // 阻止默认行为，否则拖动会连带触发文本选择与指针捕获丢失。
      event.preventDefault();
      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidth: width,
      };
      // jsdom 等没有实现指针捕获的环境下会抛错，这里做可选调用。
      handleRef.current?.setPointerCapture?.(event.pointerId);
    },
    [width],
  );

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag == null || drag.pointerId !== event.pointerId) return;
    setWidth(clampWidth(drag.startWidth + (event.clientX - drag.startX)));
  }, []);

  const endDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag == null || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (handleRef.current?.hasPointerCapture?.(event.pointerId)) {
      handleRef.current.releasePointerCapture(event.pointerId);
    }
  }, []);

  const handleSeparatorKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case "ArrowLeft":
        event.preventDefault();
        setWidth((current) => clampWidth(current - KEYBOARD_WIDTH_STEP));
        break;
      case "ArrowRight":
        event.preventDefault();
        setWidth((current) => clampWidth(current + KEYBOARD_WIDTH_STEP));
        break;
      case "Home":
        event.preventDefault();
        setWidth(MIN_DRAWER_WIDTH);
        break;
      case "End":
        event.preventDefault();
        setWidth(MAX_DRAWER_WIDTH);
        break;
      default:
        break;
    }
  }, []);

  /* ── 键盘导航 ─────────────────────────────────────────────────────── */

  const handleTreeKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const tree = treeRef.current;
    if (tree == null) return;
    const items = Array.from(tree.querySelectorAll<HTMLElement>('[role="treeitem"]'));
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    const delta = event.key === "ArrowDown" ? 1 : -1;
    const nextIndex =
      current < 0
        ? delta > 0
          ? 0
          : items.length - 1
        : Math.min(items.length - 1, Math.max(0, current + delta));
    const next = items[nextIndex];
    if (next == null) return;
    event.preventDefault();
    next.focus();
  }, []);

  const handleCategoryKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      const index = CATEGORY_ORDER.indexOf(category);
      let nextIndex: number;
      switch (event.key) {
        case "ArrowLeft":
          nextIndex = (index - 1 + CATEGORY_ORDER.length) % CATEGORY_ORDER.length;
          break;
        case "ArrowRight":
          nextIndex = (index + 1) % CATEGORY_ORDER.length;
          break;
        case "Home":
          nextIndex = 0;
          break;
        case "End":
          nextIndex = CATEGORY_ORDER.length - 1;
          break;
        default:
          return;
      }
      event.preventDefault();
      event.stopPropagation();
      const next = CATEGORY_ORDER[nextIndex];
      if (next == null) return;
      setCategory(next);
      tabRefs.current.get(next)?.focus();
    },
    [category],
  );

  if (!open) return null;

  const drawerStyle = { "--canvas-asset-drawer-width": `${width}px` } as CSSProperties;

  return createPortal(
    <div ref={rootRef} className="canvas-asset-drawer-root" style={drawerStyle}>
      <aside
        className="canvas-asset-drawer"
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
      >
        <header className="canvas-asset-drawer__header">
          <h2 id={titleId} className="canvas-asset-drawer__title">
            资产管理
          </h2>
          <button
            ref={closeRef}
            type="button"
            className="canvas-asset-drawer__close"
            aria-label="关闭资产面板"
            title="关闭资产面板"
            onClick={onClose}
          >
            <Icon name="x" aria-hidden="true" size="sm" />
          </button>
        </header>

        {error ? (
          <div className="canvas-asset-drawer__error">
            <ErrorAlert error={error} hint="请检查画布状态后重试，或换一个资产再试。" />
          </div>
        ) : null}

        <div className="canvas-asset-drawer__body">
          <div
            ref={treeRef}
            className="canvas-asset-drawer__tree"
            role="tree"
            aria-label="画布与资产"
            onKeyDown={handleTreeKeyDown}
          >
            {canvases.map((canvas) => {
              const expanded = canvas.id === activeCanvasId;
              return (
                <div
                  key={canvas.id}
                  role="treeitem"
                  aria-level={1}
                  aria-expanded={expanded}
                  aria-selected={expanded}
                  /*
                   * 画布名必须显式给出：展开后这一项的子树里有分类页签与资产条目，
                   * 按内容算可访问名会把整棵子树读进名字里。
                   */
                  aria-label={canvas.name}
                  tabIndex={0}
                  className={`canvas-asset-drawer__canvas${expanded ? " is-expanded" : ""}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    selectCanvas(canvas.id);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    event.stopPropagation();
                    selectCanvas(canvas.id);
                  }}
                >
                  <span className="canvas-asset-drawer__row">
                    <Icon name="caret-right" aria-hidden="true" size="xs" />
                    <span className="canvas-asset-drawer__row-name">{canvas.name}</span>
                  </span>

                  {expanded ? (
                    <div role="group" className="canvas-asset-drawer__group">
                      <div
                        role="tablist"
                        aria-label="资产分类"
                        className="canvas-asset-drawer__tabs"
                      >
                        {CATEGORY_ORDER.map((item) => (
                          <button
                            key={item}
                            ref={(element) => {
                              if (element) tabRefs.current.set(item, element);
                              else tabRefs.current.delete(item);
                            }}
                            type="button"
                            role="tab"
                            id={`${panelId}-tab-${item}`}
                            aria-selected={item === category}
                            aria-controls={panelId}
                            tabIndex={item === category ? 0 : -1}
                            className="canvas-asset-drawer__tab"
                            onClick={() => {
                              setCategory(item);
                            }}
                            onKeyDown={handleCategoryKeyDown}
                          >
                            {CATEGORY_LABELS[item]}
                          </button>
                        ))}
                      </div>

                      <div
                        role="tabpanel"
                        id={panelId}
                        aria-labelledby={`${panelId}-tab-${category}`}
                        className="canvas-asset-drawer__panel"
                      >
                        {filteredAssets.length === 0 ? (
                          <p className="canvas-asset-drawer__empty">
                            当前画布没有{CATEGORY_LABELS[category]}节点
                          </p>
                        ) : (
                          <div
                            role="tree"
                            aria-label="资产列表"
                            className="canvas-asset-drawer__assets"
                          >
                            {filteredAssets.map((asset) => (
                              <button
                                key={asset.id}
                                type="button"
                                role="treeitem"
                                aria-level={1}
                                aria-selected={false}
                                aria-disabled={onInsertAsset == null}
                                className="canvas-asset-drawer__asset"
                                aria-label={`插入到画布：${asset.name}（${KIND_LABELS[asset.kind]}）`}
                                title={onInsertAsset == null ? "暂不支持插入" : "插入到画布"}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  insertAsset(asset.id);
                                }}
                              >
                                {asset.thumbnailUrl ? (
                                  <img
                                    className="canvas-asset-drawer__thumb"
                                    src={asset.thumbnailUrl}
                                    alt=""
                                    loading="lazy"
                                  />
                                ) : (
                                  <span className="canvas-asset-drawer__thumb" aria-hidden="true">
                                    <Icon name={KIND_ICONS[asset.kind]} size="xs" />
                                  </span>
                                )}
                                <span className="canvas-asset-drawer__row-name">{asset.name}</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>

        <footer className="canvas-asset-drawer__footer">共 {assets.length} 节点</footer>
      </aside>

      <div
        ref={handleRef}
        className="workspace-panel-drawer-resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整资产面板宽度"
        aria-valuenow={width}
        aria-valuemin={MIN_DRAWER_WIDTH}
        aria-valuemax={MAX_DRAWER_WIDTH}
        tabIndex={0}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={handleSeparatorKeyDown}
      />
    </div>,
    document.body,
  );
}
