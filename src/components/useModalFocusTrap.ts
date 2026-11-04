import { useCallback, useEffect, useRef, type RefObject } from "react";
import { isInsideOpenPopup, registerEscapeHandler } from "./escapeArbiter";

/**
 * 模态焦点陷阱：`role="dialog" aria-modal="true"` 的弹窗统一挂这个 hook。
 *
 * 为什么需要它
 * ------------
 * `aria-modal="true"` 只会让读屏软件屏蔽背景，**不会**拦住键盘焦点。弹窗没做
 * 焦点循环时，键盘用户按 Tab 就能走出弹窗、落到被遮住的背景上；读屏那边背景
 * 又已经被屏蔽，于是出现「焦点在一个看不见的地方」的迷径。
 *
 * 这里一次性做对的四件事
 * ---------------------
 *   1. 打开时把焦点移进弹窗（优先指定元素，其次第一个可聚焦元素，再不行就聚焦
 *      容器本身——容器需要 `tabIndex={-1}`，否则不可聚焦）。
 *   2. Tab / Shift+Tab 在弹窗内循环，焦点跑出去也会被收回来。
 *   3. Esc 可选交给调用方（`onEscape`）；不传就不处理，免得和宿主自己的 Esc
 *      逻辑抢。
 *   4. 关闭时把焦点还给触发元素：调用方可以传 `returnFocusRef`，不传就记住打开
 *      前的 `document.activeElement`。
 *
 * 额外把背景置 `inert`
 * --------------------
 * 背景不可聚焦，鼠标也点不动，读屏与键盘用户看到的是同一个世界。但只置
 * `document.body` 的**其它**直接子节点：弹窗自己那条祖先链上的元素不能动，
 * 别的弹窗（自己带 `aria-modal`）也不连坐——否则「历史记录」里再开「重新生成」
 * 时，外层弹窗会先被置灰。
 *
 * 键盘事件的归属
 * --------------
 * Tab 监听在 `window` 的**捕获阶段**：焦点一旦被移出弹窗（点了遮罩、点了
 * 画布），挂在容器上的 `onKeyDown` 就收不到事件了，焦点陷阱必须最先跑。
 *
 * Esc **不再**自己监听：它交给 `escapeArbiter`（全应用唯一的 Escape 决策点）
 * 仲裁，并由模块级弹窗栈保证**只有最上层的弹窗**响应 Esc，嵌套弹窗不会互相抢。
 * 仲裁器排在冒泡阶段，元素级的 React 处理器（`CanvasSelect` / `CreateSelect`
 * 的菜单）能先用 `preventDefault()` 认领这个键——弹窗里打开了下拉时，
 * Esc 归下拉，不会把整个弹窗关掉。
 */

/** 可聚焦元素选择器：与浏览器自身的 Tab 顺序口径一致（跳过 disabled 与负 tabindex）。 */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  "object",
  "embed",
  "[contenteditable]:not([contenteditable='false'])",
  "[tabindex]:not([tabindex^='-'])",
].join(",");

/** 弹窗栈：只有栈顶那个弹窗响应键盘，嵌套弹窗按打开顺序接管 Esc。 */
interface TrapEntry {
  readonly container: () => HTMLElement | null;
}

const trapStack: TrapEntry[] = [];

/** 容器内当前真正可聚焦的元素：过滤掉隐藏的（display:none / aria-hidden）。 */
function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) =>
      element.getAttribute("aria-hidden") !== "true" && element.getClientRects().length > 0,
  );
}

export interface ModalFocusTrapOptions {
  /** 弹窗是否处于打开状态；关闭的那一刻把焦点还给触发元素。 */
  readonly active: boolean;
  /** Esc 回调；不传就不处理 Esc。 */
  readonly onEscape?: (() => void) | undefined;
  /** 关闭后归还焦点的元素；不传就记住打开前的 `document.activeElement`。 */
  readonly returnFocusRef?: RefObject<HTMLElement | null> | undefined;
  /** 打开后优先聚焦的元素；不传就聚焦容器内第一个可聚焦元素。 */
  readonly initialFocusRef?: RefObject<HTMLElement | null> | undefined;
  /** 是否把背景置 `inert`；默认 true。 */
  readonly inertBackground?: boolean;
}

export interface ModalFocusTrap {
  /** 挂到对话框根元素上的 ref。 */
  readonly ref: (node: HTMLElement | null) => void;
  /** 挂到对话框根元素上的其余 props：`tabIndex={-1}` 让容器本身也能被聚焦。 */
  readonly containerProps: { readonly tabIndex: -1 };
}

export function useModalFocusTrap({
  active,
  onEscape,
  returnFocusRef,
  initialFocusRef,
  inertBackground = true,
}: ModalFocusTrapOptions): ModalFocusTrap {
  const containerRef = useRef<HTMLElement | null>(null);
  /** 打开前的焦点：关闭时还回去，键盘用户不会「掉」回页面顶部。 */
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  /** 打开前的焦点是否已经记下（容器与 effect 谁先谁后都能记一次）。 */
  const focusCapturedRef = useRef(false);
  /** 还没把焦点收进容器：容器是后挂上来时（媒体字节到位才渲染）靠它补一次。 */
  const pendingFocusRef = useRef(false);
  /** 本次置为 inert 的背景元素：关闭时按原样恢复。 */
  const inertedRef = useRef<HTMLElement[]>([]);

  // 事件回调要在触发时读到最新值，不能用注册那一刻的闭包。
  const latestRef = useRef<ModalFocusTrapOptions>({
    active,
    onEscape,
    returnFocusRef,
    initialFocusRef,
    inertBackground,
  });
  useEffect(() => {
    latestRef.current = {
      active,
      onEscape,
      returnFocusRef,
      initialFocusRef,
      inertBackground,
    };
  });

  const focusFirst = useCallback(() => {
    const container = containerRef.current;
    if (container == null) return;
    pendingFocusRef.current = false;
    const target =
      latestRef.current.initialFocusRef?.current ?? focusableElements(container)[0] ?? container;
    target.focus();
  }, []);

  const applyInert = useCallback(() => {
    if (!latestRef.current.inertBackground) return;
    const container = containerRef.current;
    if (container == null) return;
    /*
     * 背景 = body 的**直接子节点**（不含弹窗自己那条分支）。
     *
     * 这条规则成立的前提是：**模态一律 portal 到 body**。
     * 模态若留在 #root 内部，#root 就在「弹窗的祖先链」上 → 整棵 #root（含画布）
     * 被豁免 → 背景根本没被冻结，读屏与键盘仍能落到被遮住的画布上。
     *
     * 现在所有真模态（历史面板 / 全局设置 / 重新生成 / 加载占位 / 创作台详情）
     * 都用 createPortal 挂到 body，两个原生 <dialog> 本来就 portal；
     * 画布节点内的两个「编辑区」是**节点的一部分**、不是独立模态，已去掉
     * `aria-modal`（否则读屏会屏蔽整个画布，且同样会让 #root 免于冻结）。
     *
     * 另一个模态还开着时不连坐：置灰会把它一起废掉。
     */
    const keep = new Set<HTMLElement>();
    let node: HTMLElement | null = container;
    while (node != null && node !== document.body) {
      keep.add(node);
      node = node.parentElement;
    }
    for (const child of Array.from(document.body.children)) {
      if (!(child instanceof HTMLElement)) continue;
      if (keep.has(child)) continue;
      // script / style / link 之类不参与交互，冻结它们没有意义，
      // 反而让「内联弹窗找不到真正的背景」这件事变得难以察觉。
      if (child instanceof HTMLScriptElement || child instanceof HTMLStyleElement) continue;
      // 别的弹窗还开着时不连坐：置灰会把它一起废掉。
      if (child.matches('[aria-modal="true"]')) continue;
      if (child.querySelector('[aria-modal="true"]') != null) continue;
      // 已经是别人置的 inert 就不接管，关闭时也不动它。
      if (child.hasAttribute("inert")) continue;
      child.setAttribute("inert", "");
      inertedRef.current.push(child);
    }
  }, []);

  const clearInert = useCallback(() => {
    for (const element of inertedRef.current) element.removeAttribute("inert");
    inertedRef.current = [];
  }, []);

  /**
   * 记住打开前的焦点。
   *
   * 必须在置 `inert` **之前**记：背景一旦变成 inert，里面的元素会被浏览器
   * 强制失焦，这时再记就只剩 `document.body` 了。
   */
  const capturePreviousFocus = useCallback(() => {
    if (focusCapturedRef.current) return;
    focusCapturedRef.current = true;
    previouslyFocusedRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }, []);

  const setContainer = useCallback(
    (node: HTMLElement | null) => {
      if (node === containerRef.current) return;
      containerRef.current = node;
      if (node == null) return;
      // 顺序要紧：先记住触发元素（置 inert 会让背景失焦），再把焦点收进容器。
      capturePreviousFocus();
      // 容器是后挂上来的：这时才把焦点收进来，并补一次背景 inert。
      if (pendingFocusRef.current) focusFirst();
      applyInert();
    },
    [focusFirst, applyInert, capturePreviousFocus],
  );

  useEffect(() => {
    if (!active) return;
    // 顺序要紧：先记住触发元素（置 inert 会让背景失焦），再把焦点收进容器。
    capturePreviousFocus();
    pendingFocusRef.current = true;
    focusFirst();
    applyInert();

    const entry: TrapEntry = { container: () => containerRef.current };
    trapStack.push(entry);

    const handleKeyDown = (event: KeyboardEvent) => {
      /*
       * 这里只管 Tab（焦点陷阱）：焦点一旦被移出弹窗，挂在容器上的
       * `onKeyDown` 就收不到事件了，Tab 必须在**捕获阶段**兜住。
       *
       * Esc 交给 `escapeArbiter`：捕获阶段还没有人处理过 Escape，
       * `defaultPrevented` 恒为 false，弹窗就会抢在内层浮层之前把 Esc 吃掉
       *（用户只想关下拉，整个弹窗却没了）。仲裁器在冒泡阶段，内层先认领。
       */
      if (event.key !== "Tab") return;
      const container = entry.container();
      if (container == null) return;
      const focusable = focusableElements(container);
      if (focusable.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first == null || last == null) return;
      const current = document.activeElement;
      if (current == null || !container.contains(current)) {
        // 焦点已经跑到弹窗外面：把它收回来，别让用户掉进被遮住的背景。
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && current === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    /*
     * Esc：交给仲裁器，并保留「只有栈顶弹窗响应」的约定。
     *
     * 弹窗里打开了下拉（CanvasSelect / CreateSelect 等）时，Esc 应当**先关下拉**：
     * 内层浮层自己注册的处理者优先（后注册 = 更内层），本层主动让开。
     */
    const unregisterEscape = registerEscapeHandler({
      canHandle: (event) => {
        // 嵌套弹窗：只有栈顶那个响应，Esc 不会一次关掉两层。
        if (trapStack[trapStack.length - 1] !== entry) return false;
        if (latestRef.current.onEscape == null) return false;
        // 事件来自打开的下拉浮层 → 让给下拉去处理。
        if (isInsideOpenPopup(event.target)) return false;
        return true;
      },
      handle: () => {
        latestRef.current.onEscape?.();
      },
    });
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      unregisterEscape();
      const index = trapStack.indexOf(entry);
      if (index >= 0) trapStack.splice(index, 1);
      clearInert();
      // 关闭时把焦点还给触发元素。
      const target = latestRef.current.returnFocusRef?.current ?? previouslyFocusedRef.current;
      previouslyFocusedRef.current = null;
      focusCapturedRef.current = false;
      if (target != null && target.isConnected) target.focus();
    };
  }, [active, focusFirst, applyInert, clearInert, capturePreviousFocus]);

  return {
    ref: setContainer,
    containerProps: { tabIndex: -1 },
  };
}
