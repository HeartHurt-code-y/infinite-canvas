/*
 * 浮层锚定：把挂在 document.body 上的浮层贴到触发器上。
 *
 * 为什么抽成 hook：创作台有五块浮层（下拉、参数面板、生成偏好、技能、
 * 主体），画布节点的下拉也算一份。它们共用同一套锚定规则，各写一份
 * 迟早漂移——旧版本就因为五处各写各的，其中一处把高度上限当成了实际
 * 高度，浮层直接飘到了视口中间。
 *
 * ── 锚定契约（对齐即梦实测，2026-10-22 二次实测修正）──────────────
 * 即梦的浮层用 `lv-trigger-position-bl` 挂在触发器上：面板**底边**贴住
 * 触发器**顶边**，留 7～8px 缝隙。
 *
 * 左边缘不是对齐触发器，而是**左移 16px**。四处浮层实测一致：
 *   · 创作类型下拉：触发器左 476.33 → 浮层左 460.33（−16）
 *   · 技能下拉：    触发器左 661.38 → 浮层左 645.38（−16）
 *   · 主体选择器：  触发器左 725.38 → 浮层左 709.38（−16）
 *   · 生成偏好面板：触发器左 379.38 → 浮层左 363.38（−16）
 * 画布节点自己的菜单不走这条规则（保持左对齐），所以偏移放在创作台
 * 专用的包装 hook 里，而不是共享的 `useFloatingLayerAnchor`。
 *
 * ── 关键：必须用「实测高度」定位，不能用高度上限 ──────────────────
 * CSS 的 `top` 锚定的是面板**顶边**。如果拿 `max-height`（上限）当高度
 * 算顶边，面板就会多上浮 `上限 − 实际高度` px，与触发器之间裂开一条
 * 黑缝——参数面板上限 420、实际只有 120 时，面板会飘到触发器上方 300px，
 * 孤零零挂在视口中间。所以这里用 ResizeObserver 量面板自己的高度。
 */
import { useCallback, useLayoutEffect, useRef } from "react";
import { placeFloatingLayer, type FloatingLayerOptions } from "../../components/floatingLayer";

/**
 * 即梦创作台浮层相对触发器左边缘的左移量（px）。
 *
 * 2026-10-22 逐个点开四块浮层实测，四处完全一致：创作类型下拉、技能
 * 下拉、主体选择器、生成偏好面板都是 −16。
 */
export const CREATE_FLOATING_LAYER_LEFT_OFFSET = -16;

export interface UseFloatingLayerAnchorOptions extends Omit<
  FloatingLayerOptions,
  "measuredHeight"
> {
  /** 浮层是否打开。关闭时不测量也不定位。 */
  readonly open: boolean;
  /**
   * 触发器 ref。
   *
   * 由调用方提供：触发器通常还要被别的逻辑用（聚焦、读尺寸），
   * 同一个 DOM 节点只该有一个 ref 源头。
   */
  readonly anchorRef: React.RefObject<HTMLElement | null>;
  /** 画布通过 transform / 编辑层定位移动锚点时，低频跟随；仅在打开时启用。 */
  readonly followAnchor?: boolean;
}
export interface FloatingLayerAnchor<T extends HTMLElement = HTMLElement> {
  /** 挂到浮层根节点上的 ref。 */
  readonly ref: React.RefObject<T | null>;
}

/**
 * 让浮层贴着触发器。
 *
 * 返回浮层 ref：它要挂到 portal 出去的根节点上。
 */
export function useFloatingLayerAnchor<T extends HTMLElement = HTMLElement>(
  options: UseFloatingLayerAnchorOptions,
): FloatingLayerAnchor<T> {
  const { open, anchorRef, minWidth, preferAbove, maxHeight, margin, leftOffset, gap, align, followAnchor } = options;
  const layerRef = useRef<T | null>(null);
  /*
   * 面板实际高度。
   *
   * 存 ref 而不是 state：高度只是定位的输入，不需要触发渲染。
   * 放 state 里会让每次测量都引发一次级联渲染（effect 里 setState），
   * 面板开合时多渲染一轮。
   */
  const measuredHeightRef = useRef<number | null>(null);

  /** 把浮层贴到触发器上。用实测高度，不用高度上限。 */
  const applyPosition = useCallback((): void => {
    const layer = layerRef.current;
    const anchor = anchorRef.current;
    if (layer == null || anchor == null) return;
    if (followAnchor) {
      const bounds = anchor.getBoundingClientRect();
      const available = anchor.isConnected && bounds.width > 0 && bounds.height > 0
        && !anchor.closest("[inert]") && getComputedStyle(anchor).visibility !== "hidden";
      layer.style.visibility = available ? "" : "hidden";
      if (!available) return;
    }
    const box = placeFloatingLayer(anchor, {
      ...(align === undefined ? {} : { align }),
      ...(minWidth === undefined ? {} : { minWidth }),
      ...(preferAbove === undefined ? {} : { preferAbove }),
      ...(maxHeight === undefined ? {} : { maxHeight }),
      ...(margin === undefined ? {} : { margin }),
      ...(leftOffset === undefined ? {} : { leftOffset }),
      ...(gap === undefined ? {} : { gap }),
      measuredHeight: measuredHeightRef.current,
    });
    layer.style.top = `${box.top}px`;
    layer.style.left = `${box.left}px`;
    layer.style.width = `${box.width}px`;
    layer.style.maxHeight = `${box.maxHeight}px`;
  }, [anchorRef, gap, leftOffset, margin, maxHeight, minWidth, preferAbove, align, followAnchor]);

  useLayoutEffect(() => {
    if (!open) {
      measuredHeightRef.current = null;
      return;
    }
    const layer = layerRef.current;
    if (layer == null) return;
    const measure = (): void => {
      measuredHeightRef.current = layer.getBoundingClientRect().height;
    };
    measure();
    /*
     * 面板内容变了（换模型、选项增减）要重新贴合。
     * 尺寸变化时直接重新定位，不经过 React 渲染。
     */
    const observer = new ResizeObserver(() => {
      measure();
      applyPosition();
    });
    observer.observe(layer);
    return () => observer.disconnect();
  }, [open, applyPosition]);

  useLayoutEffect(() => {
    if (!open) return;
    applyPosition();
    window.addEventListener("resize", applyPosition);
    // capture：卡片容器内部滚动也要跟随，否则浮层会停在旧位置。
    window.addEventListener("scroll", applyPosition, true);
    return () => {
      window.removeEventListener("resize", applyPosition);
      window.removeEventListener("scroll", applyPosition, true);
    };
  }, [open, applyPosition]);

  useLayoutEffect(() => {
    if (!open || !followAnchor) return;
    // transform 不派发 scroll；避免逐帧读取布局，只跟随当前打开的画布浮层。
    const timer = window.setInterval(applyPosition, 150);
    return () => window.clearInterval(timer);
  }, [open, followAnchor, applyPosition]);

  return { ref: layerRef };
}

/**
 * 创作台浮层的锚定：即梦口径。
 *
 * 与通用 `useFloatingLayerAnchor` 的唯一差别是**左移 16px**（即梦四块浮层
 * 的实测一致值，见文件头）。创作台的五块浮层——创作类型下拉、生成偏好
 * 面板、技能下拉、主体选择器、参数面板——一律走这里，避免五处各写各的
 * 又各漂一档。
 *
 * 画布节点菜单不归这条管，继续用通用 hook（左对齐）。
 */
export function useCreateFloatingLayerAnchor<T extends HTMLElement = HTMLElement>(
  options: UseFloatingLayerAnchorOptions,
): FloatingLayerAnchor<T> {
  return useFloatingLayerAnchor<T>({
    ...options,
    leftOffset: options.leftOffset ?? CREATE_FLOATING_LAYER_LEFT_OFFSET,
  });
}

/**
 * 浮层点外部关闭。
 *
 * capture 阶段监听，这样容器内部的滚动也能关掉浮层。
 */
export function useDismissOnOutside(
  open: boolean,
  layerRef: React.RefObject<HTMLElement | null>,
  anchorRef: React.RefObject<HTMLElement | null>,
  onDismiss: () => void,
): void {
  const dismissRef = useRef(onDismiss);
  useLayoutEffect(() => {
    dismissRef.current = onDismiss;
  }, [onDismiss]);

  useLayoutEffect(() => {
    if (!open) return;
    const handleMousedown = (event: MouseEvent): void => {
      const target = event.target;
      if (
        target instanceof Node &&
        (layerRef.current?.contains(target) || anchorRef.current?.contains(target))
      ) {
        return;
      }
      dismissRef.current();
    };
    window.addEventListener("mousedown", handleMousedown, true);
    return () => window.removeEventListener("mousedown", handleMousedown, true);
  }, [open, layerRef, anchorRef]);
}
