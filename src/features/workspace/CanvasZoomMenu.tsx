/*
 * 画布缩放菜单（对齐 liblib.tv 画布左下的「缩放百分比」菜单）。
 *
 * 实测（2026-10-22，原站 liblib.tv 画布，登录态）：
 *   - 形态：Mantine Menu 浮层，实测 218×277；
 *   - 菜单项自上而下：放大（⌘ +）· 缩小（⌘ -）· 适合屏幕（⌘ 0）
 *     · 缩放至50% · 缩放至100% · 缩放至800%；
 *   - 前三项是动作（改的是相对量），后三项是固定档位（改的是绝对值）。
 *   原始证据 → docs/integrations/liblib-canvas-re.md 第 3.5 节。
 *
 * 为什么菜单里有一条分隔线：
 *   原站的 277px 高度装不下「6 项 × 常规菜单项高」，除非动作组与档位组之间
 *   有一条分隔线（Mantine Menu.Divider：1px + 上下各 8px 外边距）。按本组件
 *   的行高反推：6×40 + 5×2 间距 + 上下各 4 内边距 + 分隔线 17 = 275px，
 *   与实测 277 差 2px。分隔线同时承担「动作 / 固定档位」的分段语义，不是装饰。
 *
 * 为什么 zoom 用「百分比整数」而不是 React Flow 的比例（0.72）：
 *   原站的菜单项直接写「缩放至100%」，顶栏的缩放按钮显示的也是百分比
 *   （实测 13px 字号）。本组件的契约因此是百分比（72 = 72%），调用方负责与
 *   viewport.zoom（0~1）互转——组件里不猜比例，否则调用方每次都要换算错位。
 *
 * 快捷键本身（⌘ + / ⌘ - / ⌘ 0）由画布的全局快捷键处理，本组件只负责**显示**
 * 它们：菜单开着的时候按键应该作用在菜单上，而不是同时触发画布的缩放。
 */
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";

import { useEscapeHandler } from "../../components/escapeArbiter";
import { useDismissOnOutside, useFloatingLayerAnchor } from "../create/useFloatingLayerAnchor";
import "./CanvasChromeMenus.css";

/** 一次放大/缩小跨过的百分点，与 React Flow 的 viewport 步进（0.1）一致。 */
const ZOOM_STEP = 10;
/** 缩放下限：再小就看不清节点内容了。 */
const MIN_ZOOM = 10;
/** 缩放上限：与菜单里的「缩放至800%」对齐。 */
const MAX_ZOOM = 800;
/** 原站实测的菜单宽（Mantine Menu dropdown 218×277）。 */
const MENU_WIDTH = 218;

export interface CanvasZoomMenuProps {
  /** 当前缩放百分比（如 72 表示 72%）。 */
  readonly zoom: number;
  /** 设定缩放百分比（调用方负责与 viewport.zoom 互转）。 */
  readonly onZoomChange: (next: number) => void;
  /** 「适合屏幕」：把全部节点框进视口，缩放值由调用方自己算。 */
  readonly onFitView: () => void;
  /**
   * 一次放大/缩小跨过的百分点。
   *
   * 原站菜单按 10 个百分点步进，但本项目画布的快捷键与滚轮用的是
   * `workspaceModel` 的 `ZOOM_STEP`（8），两处步进不一致会让「按 + 放大」
   * 和「从菜单放大」得到不同的读数。调用方应把同一个值传进来。
   */
  readonly step?: number | undefined;
  /** 缩放下限（百分比）。 */
  readonly minZoom?: number | undefined;
  /** 缩放上限（百分比）。 */
  readonly maxZoom?: number | undefined;
  /**
   * 触发器元素，浮层靠它贴位。
   *
   * 给了 `triggerRef`：组件**只**渲染浮层，触发器由调用方渲染（把同一个 ref
   * 挂到自己的按钮上）——画布左下控件组里的「缩放百分比」按钮属于那个控件组，
   * 由调用方渲染更合适。
   *
   * 不给：组件自渲染一个显示当前百分比的触发器，单独使用也能工作。
   */
  readonly triggerRef?: React.RefObject<HTMLElement | null> | undefined;
  /** 浮层是否打开（受控）。 */
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

interface ZoomMenuEntry {
  readonly id: string;
  readonly label: string;
  /** 右侧快捷键标记；原站只在动作项右侧显示 ⌘ 组合。 */
  readonly shortcut: string | undefined;
  /** 这一项是否代表当前缩放值（用于高亮）。 */
  readonly current: boolean;
  /** 这一项前面是否画一条分隔线（动作组与固定档位组的分界）。 */
  readonly dividerBefore: boolean;
  readonly run: () => void;
}

function clampZoom(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function CanvasZoomMenu({
  zoom,
  onZoomChange,
  onFitView,
  step = ZOOM_STEP,
  minZoom = MIN_ZOOM,
  maxZoom = MAX_ZOOM,
  triggerRef,
  open,
  onOpenChange,
}: CanvasZoomMenuProps) {
  const internalTriggerRef = useRef<HTMLButtonElement>(null);
  /* 触发器是谁的：外部给了就用外部的，浮层永远贴在真正的按钮上。 */
  const anchorRef: React.RefObject<HTMLElement | null> = triggerRef ?? internalTriggerRef;
  const ownsTrigger = triggerRef === undefined;
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const menuId = useId();

  const entries: ZoomMenuEntry[] = [
    {
      id: "zoom-in",
      label: "放大",
      shortcut: "⌘ +",
      current: false,
      dividerBefore: false,
      run: () => onZoomChange(clampZoom(zoom + step, minZoom, maxZoom)),
    },
    {
      id: "zoom-out",
      label: "缩小",
      shortcut: "⌘ -",
      current: false,
      dividerBefore: false,
      run: () => onZoomChange(clampZoom(zoom - step, minZoom, maxZoom)),
    },
    {
      id: "fit-view",
      label: "适合屏幕",
      shortcut: "⌘ 0",
      current: false,
      dividerBefore: false,
      run: onFitView,
    },
    {
      id: "zoom-50",
      label: "缩放至50%",
      shortcut: undefined,
      current: zoom === 50,
      dividerBefore: true,
      run: () => onZoomChange(50),
    },
    {
      id: "zoom-100",
      label: "缩放至100%",
      shortcut: undefined,
      current: zoom === 100,
      dividerBefore: false,
      run: () => onZoomChange(100),
    },
    {
      id: "zoom-800",
      label: "缩放至800%",
      shortcut: undefined,
      current: zoom === 800,
      dividerBefore: false,
      run: () => onZoomChange(800),
    },
  ];

  /*
   * 浮层贴位：宽度按原站实测 218，高度用**实测值**（ResizeObserver 量），
   * 不用 max-height 当高度——否则菜单会整体上浮「上限 − 实际高度」px，
   * 与触发器之间裂开一条黑缝。
   *
   * 方向用自动（preferAbove: false）：下方够就贴着触发器下方展开，不够才翻到
   * 上方并让底边贴住触发器顶边（留 8px 缝）。缩放菜单挂在画布左下控件组时
   * 正好走「翻到上方」这条路径，与本仓库其他浮层一致。
   */
  const { ref: panelRef, layerId } = useFloatingLayerAnchor<HTMLDivElement>({
    open,
    anchorRef,
    preferAbove: false,
    minWidth: MENU_WIDTH,
    maxHeight: 320,
  });
  useDismissOnOutside(open, panelRef, anchorRef, () => onOpenChange(false), layerId);

  /** 关闭并把焦点还给触发器（鼠标点菜单项后焦点不能丢在浮层上）。 */
  const close = useCallback(
    (refocus = true) => {
      onOpenChange(false);
      if (!refocus) return;
      const anchor = anchorRef.current;
      if (anchor instanceof HTMLElement) anchor.focus({ preventScroll: true });
    },
    [anchorRef, onOpenChange],
  );

  /*
   * 打开时把焦点交给第一项。
   *
   * 这里只做 DOM 副作用，不 setState：菜单项的 onFocus 会把高亮项同步到
   * activeIndex（那是事件回调，不是 effect），避免在 effect 里 setState 引发
   * 一次多余的级联渲染。
   */
  useEffect(() => {
    if (!open) return;
    itemRefs.current[0]?.focus({ preventScroll: true });
  }, [open]);

  /*
   * Esc 关闭菜单：交给全应用唯一的仲裁器（`escapeArbiter`）。
   *
   * 之前这段自己挂在 window 的**捕获阶段**：菜单里点到的可能不是可聚焦元素
   * （菜单项之间的空白、分隔线），焦点不在菜单内时菜单自己的 `onKeyDown`
   * 收不到 Esc——所以要挂在 window 上。仲裁器同样挂在 window（冒泡阶段），
   * 焦点在哪都能收到，但**不会**抢在内层浮层之前动手。
   */
  useEscapeHandler(
    {
      canHandle: () => open,
      handle: () => close(),
    },
    open,
  );

  const handlePanelKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const count = entries.length;
    let nextIndex: number;
    switch (event.key) {
      case "ArrowDown":
        nextIndex = (activeIndex + 1) % count;
        break;
      case "ArrowUp":
        nextIndex = (activeIndex - 1 + count) % count;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = count - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    setActiveIndex(nextIndex);
    itemRefs.current[nextIndex]?.focus();
  };

  return (
    <>
      {ownsTrigger ? (
        <button
          type="button"
          ref={internalTriggerRef}
          className="canvas-zoom-menu__trigger"
          aria-label={`缩放 ${zoom}%`}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          onClick={() => onOpenChange(!open)}
        >
          <span className="canvas-zoom-menu__trigger-value">{zoom}%</span>
        </button>
      ) : null}
      {open
        ? createPortal(
            <div
              ref={panelRef}
              id={menuId}
              role="menu"
              aria-label="缩放"
              className="canvas-zoom-menu__panel"
              onKeyDown={handlePanelKeyDown}
            >
              {entries.map((entry, index) => (
                <Fragment key={entry.id}>
                  {entry.dividerBefore ? (
                    <div className="canvas-zoom-menu__divider" role="separator" />
                  ) : null}
                  <button
                    type="button"
                    role="menuitem"
                    ref={(element) => {
                      itemRefs.current[index] = element;
                    }}
                    tabIndex={index === activeIndex ? 0 : -1}
                    aria-current={entry.current ? "true" : undefined}
                    className={`canvas-zoom-menu__item${entry.current ? " is-current" : ""}`}
                    onMouseEnter={() => setActiveIndex(index)}
                    onFocus={() => setActiveIndex(index)}
                    onClick={() => {
                      entry.run();
                      close();
                    }}
                  >
                    <span className="canvas-zoom-menu__label">{entry.label}</span>
                    {entry.shortcut ? (
                      <kbd className="canvas-zoom-menu__shortcut">{entry.shortcut}</kbd>
                    ) : null}
                  </button>
                </Fragment>
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
