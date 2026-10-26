import { useCallback, useEffect, useId, useRef, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

import { useDismissOnOutside, useFloatingLayerAnchor } from "../create/useFloatingLayerAnchor";
import "./CanvasChromeOverlays.css";

export interface CanvasContextMenuItem {
  /** 动作 id，回传给 onSelect；与原站 context-menu 的 featureId 后缀同名。 */
  readonly id: string;
  /** 菜单文案（照抄原站 i18n）。 */
  readonly label: string;
  /** 补充说明（照抄原站 i18n 的提示文案），显示在文案下方。 */
  readonly hint?: string;
  /** 删除一类的高风险动作，用错误色区分。 */
  readonly danger?: boolean;
}

export interface CanvasContextMenuProps {
  readonly open: boolean;
  /** 右键坐标（视口坐标，通常是 event.clientX / clientY）。 */
  readonly position: { readonly x: number; readonly y: number } | null;
  readonly onClose: () => void;
  /** 选中某个动作时回调，参数是条目的 id。 */
  readonly onSelect?: (action: string) => void;
  /** 菜单条目；不传时用原站画布右键菜单的默认条目。 */
  readonly items?: readonly CanvasContextMenuItem[];
}

/*
 * 默认条目：文案照抄 liblib.tv 原站 i18n
 * （copyNode / copyNodeTip / copyImage / copyText / createCopy / createCopyTip /
 *   deleteOtherVideos / expandAllVideos / shortcutLabelGroup /
 *   shortcutLabelCopyExpanded / addToCanvas / openAiAssistant /
 *   shortcutLabelFormatLayout）。
 */
const DEFAULT_CONTEXT_MENU_ITEMS: readonly CanvasContextMenuItem[] = [
  { id: "copyNode", label: "复制节点", hint: "仅复制当前节点" },
  { id: "copyImage", label: "复制图片" },
  { id: "copyText", label: "复制文本" },
  {
    id: "duplicate",
    label: "创建副本",
    hint: "复制当前所有参数，方便你尝试不同提示词和参考内容；请注意仅支持复制上游连线，下游连线需根据新需求手动连接",
  },
  { id: "deleteOtherVideos", label: "删除其他视频", danger: true },
  { id: "expandAllVideos", label: "展开所有视频" },
  { id: "group", label: "成组" },
  { id: "copyExpanded", label: "复制整组" },
  { id: "addToCanvas", label: "添加到画布" },
  { id: "openAiAssistant", label: "打开 AI 助手" },
  { id: "formatLayout", label: "整理画布" },
];

interface CanvasContextMenuLayerProps {
  readonly position: { readonly x: number; readonly y: number } | null;
  readonly onClose: () => void;
  readonly onSelect?: ((action: string) => void) | undefined;
  readonly items: readonly CanvasContextMenuItem[];
}

/**
 * 菜单本体（挂在 document.body 上）。
 *
 * 定位：右键菜单没有触发元素，所以把一个零尺寸的虚拟锚点放到右键坐标上，
 * 再交给共享的 placeFloatingLayer（经 useFloatingLayerAnchor）算位置——
 * 靠近视口右/下边缘时自动向左/上翻转，且不会溢出视口。
 *
 * 为什么走共享浮层模块：浮层坐标各写一份迟早漂移，旧版本就因为五处各写各的，
 * 其中一处把高度上限当成了实际高度，浮层直接飘到了视口中间。
 */
function CanvasContextMenuLayer({
  position,
  onClose,
  onSelect,
  items,
}: CanvasContextMenuLayerProps) {
  const menuId = useId();
  const anchorRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const { ref: layerRef } = useFloatingLayerAnchor<HTMLDivElement>({
    open: true,
    anchorRef,
    minWidth: 196,
    // 右键菜单默认向下开；下方不够时共享模块自动翻到上方。
    preferAbove: false,
    maxHeight: 320,
  });

  useDismissOnOutside(true, layerRef, anchorRef, onClose);

  // 打开时把焦点落到第一项，键盘用户可以直接用方向键走菜单。
  useEffect(() => {
    itemRefs.current[0]?.focus();
  }, []);

  const handleSelect = useCallback(
    (id: string) => {
      onSelect?.(id);
      onClose();
    },
    [onClose, onSelect],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      const elements = itemRefs.current.filter((item): item is HTMLButtonElement => item !== null);
      if (elements.length === 0) return;
      const current = elements.findIndex((item) => item === document.activeElement);
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const next =
          event.key === "ArrowDown"
            ? (current + 1) % elements.length
            : current <= 0
              ? elements.length - 1
              : current - 1;
        elements[next]?.focus();
        return;
      }
      if (event.key === "Home") {
        event.preventDefault();
        elements[0]?.focus();
        return;
      }
      if (event.key === "End") {
        event.preventDefault();
        elements[elements.length - 1]?.focus();
      }
    },
    [onClose],
  );

  return createPortal(
    <>
      <div
        ref={anchorRef}
        className="canvas-context-menu__anchor"
        style={{ left: `${position?.x ?? 0}px`, top: `${position?.y ?? 0}px` }}
        aria-hidden="true"
      />
      <div
        ref={layerRef}
        id={menuId}
        role="menu"
        aria-label="画布右键菜单"
        className="canvas-context-menu"
        onKeyDown={handleKeyDown}
      >
        {items.map((item, index) => {
          const hintId = `${menuId}-hint-${item.id}`;
          return (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              ref={(element) => {
                itemRefs.current[index] = element;
              }}
              className={`canvas-context-menu__item${item.danger === true ? " is-danger" : ""}`}
              aria-label={item.label}
              aria-describedby={item.hint !== undefined ? hintId : undefined}
              title={item.hint}
              onClick={() => handleSelect(item.id)}
            >
              <span className="canvas-context-menu__item-label">{item.label}</span>
              {item.hint !== undefined ? (
                <span id={hintId} className="canvas-context-menu__item-hint">
                  {item.hint}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </>,
    document.body,
  );
}

/**
 * 画布右键上下文菜单。
 *
 * 坐标变化时整块菜单重新挂载：共享的 useFloatingLayerAnchor 只在挂载与
 * 「锚点 ref 变化」时重算位置，而右键菜单的锚点就是坐标本身——重新挂载
 * 能让浮层贴着新的右键位置重算一次，不用在渲染期重建 ref（React 编译器的
 * react-hooks/refs 规则不允许）。
 */
export function CanvasContextMenu({
  open,
  position,
  onClose,
  onSelect,
  items = DEFAULT_CONTEXT_MENU_ITEMS,
}: CanvasContextMenuProps) {
  if (!open) return null;

  return (
    <CanvasContextMenuLayer
      key={`${position?.x ?? 0}:${position?.y ?? 0}`}
      position={position}
      onClose={onClose}
      onSelect={onSelect}
      items={items}
    />
  );
}
