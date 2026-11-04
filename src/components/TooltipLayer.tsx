/*
 * 说明气泡（tooltip）：把 `data-tooltip` 的说明渲染成一块**贴在触发器上**的浮层。
 *
 * ── 为什么不再用 CSS 伪元素 ────────────────────────────────────────────
 * 原实现是 `[data-tooltip]::after`（App.css），有三个硬伤：
 *
 *   1. **永远朝下展开**（`top: calc(100% + gap)`）。贴底的控件组
 *      （画布左下控件组 `.canvas-viewport-dock`、底部浮坞）下方没有空间，
 *      说明被视口下沿切掉——用户只看到半行字或干脆看不到。
 *   2. **挂在触发器内部**，会被祖先的 `overflow: hidden` 裁掉
 *      （`.canvas-stage` 就是 `overflow: hidden`），也会跟着画布缩放层
 *      一起被 React Flow 的 transform 缩放。
 *   3. **量不到自己的宽度**，长文案无法在视口右沿夹住。
 *
 * 现在统一渲染到 `document.body` 上（`position: fixed`），因此：
 *   - 不受任何祖先 `overflow` 裁剪，也不受画布缩放影响；
 *   - 下方空间不足时自动翻到上方（见 `placeTooltip`）；
 *   - 水平方向实测宽度后夹在视口内。
 *
 * ── 与既有浮层的关系 ────────────────────────────────────────────────────
 * 定位计算放在 `floatingLayer.ts`（共享模块），与画布节点菜单、创作台浮层
 * 共用同一套「实测尺寸 + 不越出视口」的规则，不另写一份。
 *
 * ── 无障碍 ─────────────────────────────────────────────────────────────
 * 说明气泡是**视觉补充**：触发器本身都带 `aria-label`，屏幕阅读器读的是
 * `aria-label`，所以气泡标 `aria-hidden="true"`，不让读屏重复朗读同一句话。
 * `role="tooltip"` 只是给它留个身份标记（便于在可访问性工具里辨认），
 * 真正给读屏用的描述是下面那个独立的 `sr-only` 元素。
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ESCAPE_PRIORITY_TOOLTIP, useEscapeHandler } from "./escapeArbiter";
import { createPortal } from "react-dom";

import { placeTooltip } from "./floatingLayer";
import "./TooltipLayer.css";

/** 气泡与触发器之间的缝隙。 */
const GAP = 8;

/**
 * 触发后多久显示。
 *
 * **与旧实现保持一致**：原伪元素用 `transition-delay: 800ms` 实现「悬停
 * 800ms 后才淡入」，键盘聚焦则是 `transition-delay: 0ms` 立即出现。
 *
 * 改这个数值属于**改交互节奏**而不是修 bug——本次只修「说明被视口下沿
 * 切掉」，不顺手改时长。
 */
const SHOW_DELAY_MS = 800;

/** 失去焦点/移开后多久隐藏，留出移动到气泡本身的时间。 */
const HIDE_DELAY_MS = 120;

/**
 * 跟随触发器的轮询间隔（ms）。
 *
 * 画布平移走 transform，没有对应事件，只能轮询。取 100ms 是权衡：
 * 每帧轮询会每帧强制同步布局（大画布上是明显的 layout thrash），
 * 而说明气泡是辅助信息，100ms 的跟随延迟人眼察觉不到。
 */
const FOLLOW_INTERVAL_MS = 100;

interface TooltipState {
  /** 说明文本。 */
  readonly text: string;
  /** 触发元素。 */
  readonly anchor: HTMLElement;
}

/**
 * 读屏描述的状态。
 *
 * 比视觉气泡多一个 `described`：`aria-describedby` 必须挂在**真正获得焦点
 * 的那个元素**上，不能挂在触发器上。
 *
 * 触发器与焦点元素今天是同一个（26 处触发器都是叶子 `button`，图标与
 * 文本都不可聚焦），但这属于「恰好成立」而不是「设计上成立」：一旦某个
 * 触发器包住了一个可聚焦的子元素，描述挂在触发器上就永远不会被朗读——
 * `aria-describedby` 不会向下继承给子元素。
 */
interface FocusedTooltipState extends TooltipState {
  /** 真正持有焦点的元素。 */
  readonly described: Element;
}

/**
 * 指针当前是否停在某个元素上。
 *
 * 用 `elementFromPoint` + 最后已知指针坐标判断，**不用 `:hover`**：
 * Chrome 里 `:hover` **不匹配 disabled 元素**（实测确认），而本项目恰好有
 * 不少置灰按钮（`disabled` + `data-tooltip`），用 `:hover` 会误判成
 * 「指针不在上面」，从而把还该显示的说明提前收掉。
 */
function isPointerOver(element: HTMLElement, x: number, y: number): boolean {
  if (x < 0 || y < 0) return false;
  const hit = document.elementFromPoint(x, y);
  return hit instanceof Node && element.contains(hit);
}

/**
 * 说明是否提供了可访问名之外的信息。
 *
 * 判据是「可访问名有没有把说明这句话说完整」：
 *
 *   - 完全相同（如「切换小地图」）→ 挂上去读屏会把同一句话念两遍，是噪声；
 *   - 可访问名**已经包含**说明的文案（如「打开素材库侧板」配「素材库」、
 *     「打开创作台」配「创作台」）→ 名字念完那句话也就说完了，同样是噪声；
 *   - 说明比名字更长（如「清空画布」配「清空画布上的节点与连线」、或
 *     「功能组件」配「功能组件（后端暂未接入）」）→ 说明确实补充了信息，
 *     必须挂上，否则读屏用户永远拿不到「后端暂未接入」这类关键说明。
 *
 * 可访问名优先取 `aria-label`（这些触发器都有），没有时退回元素文本。
 */
function hasExtraInformation(anchor: Element, text: string): boolean {
  const accessibleName = (anchor.getAttribute("aria-label") ?? anchor.textContent ?? "").trim();
  const description = text.trim();
  if (description === accessibleName) return false;
  /* 名字里已经逐字包含了这句说明 → 说明没有额外信息。 */
  if (accessibleName.includes(description)) return false;
  return true;
}

/**
 * 说明气泡层。
 *
 * 挂在应用根部，只渲染一块气泡。它通过**事件委托**监听
 * `document` 上的指针/焦点事件，因此不需要给每个触发器挂监听器——
 * 画布里的节点会被 React Flow 反复重渲染，逐个挂监听既啰嗦又容易漏。
 */
export function TooltipLayer() {
  /** 视觉气泡当前显示什么（由指针与焦点共同决定）。 */
  const [state, setState] = useState<TooltipState | null>(null);
  /**
   * 读屏描述当前指向谁。
   *
   * 与 `state` **分开**：视觉气泡会被 hover 改写，而 `aria-describedby`
   * 指向的必须是控件**稳定**的描述。焦点在 A、鼠标悬停到 B 时，A 的描述
   * 不能念出 B 的文案。详见下面 a11y 那段注释。
   */
  const [focused, setFocused] = useState<FocusedTooltipState | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const showTimerRef = useRef<number | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  /**
   * 「待显示」定时器对应的是哪个触发器。
   *
   * Escape 需要它：气泡**还没显示**（还在 800ms 延迟里）时按 Escape，
   * 光看 `anchorRef` 记不到被关掉的对象——那次「延迟中的说明」会在
   * Escape 之后照样冒出来，用户会以为 Escape 没用。
   */
  const pendingAnchorRef = useRef<HTMLElement | null>(null);
  /** 气泡实测宽度，用于把长文案夹在视口内。 */
  const widthRef = useRef(0);
  /** 气泡实测高度，用于判断下方空间是否装得下。 */
  const heightRef = useRef(0);
  /**
   * 当前**显示中**的文案。
   *
   * 用来发现「触发器自己改了 `data-tooltip`」：切换模式的按钮会在状态变化
   * 时改写自己的文案（如「移动 · 拖动画布」↔「框选 · 框选节点」），说明若
   * 停在旧文案上，读到的是一句已经失效的话。
   */
  const shownTextRef = useRef("");
  /** 最后已知的指针坐标，用于判断指针是否仍停在触发器上。 */
  const pointerRef = useRef({ x: -1, y: -1 });
  /**
   * 最近一次输入是不是**键盘**。
   *
   * 焦点来源不能靠 `:focus-visible` 判断：实测鼠标点击一个此前被键盘
   * 聚焦过的按钮后，`:focus-visible` 仍为 `true`——它反映的是「上一次
   * 交互方式」，不是「这一次」。
   *
   * 所以自己追踪：`keydown` 记为键盘，`pointerdown` 记为指针。
   * 只有**键盘来源**的焦点才立即弹说明并挂 `aria-describedby`——
   * 鼠标点击按钮时不该突然冒出一段说明（旧实现用 `:focus-visible` 就是
   * 为了避免这个）。这是 UI 库（Radix / React Aria）的标准做法。
   */
  const keyboardRef = useRef(false);
  /**
   * 被 Escape 关闭过的触发器。
   *
   * Escape 必须真的"关掉"：否则指针在同一个按钮上稍微一动，`pointerover`
   * 又会把它排上显示队列，800ms 后说明复活——用户会以为 Escape 没用。
   * 指针**真正离开**该触发器后才解除屏蔽。
   */
  const dismissedRef = useRef<HTMLElement | null>(null);
  /**
   * 当前持有 DOM 焦点的触发器，以及这个焦点是不是**键盘**带来的。
   *
   * 为什么不能只看「焦点是不是在触发器里」：鼠标点过按钮后焦点就落在按钮
   * 上，指针移开时按老写法（`contains(document.activeElement)`）说明会永远
   * 赖在屏幕上——粘住的气泡。只有**键盘来源**的焦点才代表「用户正在用
   * 键盘浏览这个控件」，说明才该继续留着。
   *
   * 焦点来源在**聚焦那一刻**定下来，不能等隐藏时再去看「最近一次输入
   * 设备」：用户 Tab 到按钮后又用鼠标点了别处，最近输入设备变成指针，
   * 但那个焦点确实还是键盘落在按钮上的。
   */
  const focusAnchorRef = useRef<HTMLElement | null>(null);
  const focusByKeyboardRef = useRef(false);
  /**
   * `focused` 的同步镜像。
   *
   * state 更新是异步的，事件回调里要立刻读到「当前描述指向谁」只能靠 ref。
   */
  const focusedRef = useRef<FocusedTooltipState | null>(null);
  /**
   * 读屏描述元素的 DOM id，供聚焦的触发器用 `aria-describedby` 引用。
   *
   * 用 `useId()` 而不是手写常量（与 `CanvasSelect`、`SearchableMultiSelect`
   * 一致）：`aria-describedby` 只要求 id 在当前文档内唯一且**渲染间稳定**，
   * `useId()` 两者都满足；而手写常量在将来挂了两个实例时会撞 id，
   * 读屏就会引用到错误的元素。
   *
   * 这个元素与**视觉气泡是两个东西**：描述是控件的稳定说明，不能被 hover
   * 改写；气泡只是视觉表现。理由见下面 a11y 那段注释。
   */
  const descriptionId = useId();

  const clearTimers = useCallback(() => {
    if (showTimerRef.current !== null) {
      window.clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
    }
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
    /* 待显示被取消时，它对应的触发器也一并作废，免得留下陈旧指向。 */
    pendingAnchorRef.current = null;
  }, []);

  /**
   * 取消「待隐藏」定时器。
   *
   * 与 `clearTimers` 分开是有原因的：`pointerout` 走到另一个触发器时，
   * 必须**只**取消隐藏，不能连带取消「待显示」——否则「从按钮 A 快速划到
   * 按钮 B」时，B 的显示定时器会被 A 的 pointerout 误杀，B 的说明永远不出现。
   */
  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  /** 取消「待显示」定时器（触发器换了，或用户已经离开）。 */
  const clearShowTimer = useCallback(() => {
    if (showTimerRef.current !== null) {
      window.clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
    }
    pendingAnchorRef.current = null;
  }, []);

  const hide = useCallback(() => {
    clearTimers();
    setState(null);
    anchorRef.current = null;
    /*
     * 这里**不**清零宽高缓存：气泡常驻 DOM，尺寸只随文案变化（由
     * `ResizeObserver` 维护），清零会让「同一元素同一文案再次显示」时
     * 量不到尺寸（`useLayoutEffect` 因 state 引用未变而不会重跑），
     * 气泡就永远摆不出来。
     */
  }, [clearTimers]);

  const show = useCallback(
    (anchor: HTMLElement, text: string) => {
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
      anchorRef.current = anchor;
      shownTextRef.current = text;
      setState((previous) =>
        previous?.anchor === anchor && previous.text === text ? previous : { anchor, text },
      );
    },
    [],
  );

  /**
   * 更新读屏描述指向的触发器。
   *
   * **幂等**：同一个锚点同一份文案时复用上一次的 state 对象。否则每次
   * focusin 都会让下面的 a11y effect 重跑一轮——cleanup 先摘掉
   * `aria-describedby`、再重新挂上，中间那个窗口里读屏查询描述会拿到空值。
   *
   * 同时维护 `focusedRef` 镜像：state 更新是异步的，事件回调里要立刻
   * 读到「当前描述指向谁」只能靠 ref。
   */
  const updateFocused = useCallback((next: FocusedTooltipState | null) => {
    focusedRef.current = next;
    setFocused((previous) => {
      if (next === null) return previous === null ? previous : null;
      /*
       * `described` 也要比：同一个触发器内部焦点可以落在不同子元素上，
       * 描述要跟着换宿主——只比 anchor/text 会让状态被误判成「没变」，
       * 关联就留在旧元素上了。
       */
      if (
        previous !== null &&
        previous.anchor === next.anchor &&
        previous.text === next.text &&
        previous.described === next.described
      ) {
        return previous;
      }
      return next;
    });
  }, []);

  /*
   * 事件委托：只在 `document` 上挂一组监听，靠 `event.target` 往上找
   * 最近的 `[data-tooltip]`。
   *
   * 用 `pointerover` 而不是 `mouseover`：前者同时覆盖鼠标与触控笔，
   * 且在触摸设备上不会因为「点击后保持 hover 态」而粘住气泡。
   */
  useEffect(() => {
    const findAnchor = (target: EventTarget | null): HTMLElement | null => {
      if (!(target instanceof Element)) return null;
      const anchor = target.closest<HTMLElement>("[data-tooltip]");
      if (!anchor) return null;
      /*
       * `disabled` 的按钮**照常派发** pointerover/mouseover（事件目标就是按钮
       * 本身），只是不匹配 `:hover`。所以旧实现（纯 CSS `:hover`）下，置灰
       * 按钮的说明永远看不到——「功能组件（后端暂未接入）」这类提示尤其需要
       * 看得见。改用事件驱动后，置灰按钮的说明照常显示。
       */
      return anchor;
    };

    /**
     * 安排隐藏。
     *
     * 「指针离开了所有触发器」有两条路径会走到这里：
     *   - `pointerover` 落到了不带说明的元素上（触发器被卸载时浏览器只派发
     *     这一条，**不会**派发 pointerout）；
     *   - `pointerout` 且 relatedTarget 不在任何触发器内。
     * 两条路径共用同一个收尾，避免两处实现漂移。
     */
    const scheduleHide = () => {
      /* 已经没有任何气泡在显示 → 无需再安排。 */
      const current = anchorRef.current;
      if (current === null) return;
      /*
       * **键盘来源**的焦点仍在这个触发器上 → 说明要留着。
       *
       * 这里不能用 `current.contains(document.activeElement)`：那只说明
       * 「焦点在里面」，不说明焦点是**键盘**来的。鼠标点过按钮后焦点就落在
       * 按钮上，指针移开时按老写法说明会永远赖在屏幕上（粘住的气泡）。
       * 只有键盘聚焦才代表「用户正在用键盘浏览这个控件」，说明该留着。
       */
      if (focusAnchorRef.current === current && focusByKeyboardRef.current) return;
      if (isPointerOver(current, pointerRef.current.x, pointerRef.current.y)) return;
      clearHideTimer();
      hideTimerRef.current = window.setTimeout(() => {
        hideTimerRef.current = null;
        hide();
        /*
         * 指针走了，但键盘焦点还持有一个触发器 → 把说明还给焦点控件。
         *
         * 否则键盘用户会因为鼠标碰了一下别处，就彻底丢掉当前控件的说明。
         */
        const focusAnchor = focusAnchorRef.current;
        if (focusAnchor === null || !focusByKeyboardRef.current) return;
        if (!focusAnchor.isConnected) return;
        const focusText = focusAnchor.getAttribute("data-tooltip");
        if (!focusText) return;
        show(focusAnchor, focusText);
      }, HIDE_DELAY_MS);
    };

    /**
     * 指针离开了**所有**触发器。
     *
     * 除了安排隐藏，还要**取消「待显示」**：说明有 800ms 的显示延迟，
     * 指针在延迟到期前就移开的话，那次延迟结束仍会把说明弹出来——指针
     * 明明不在按钮上，屏幕上却冒出一条说明。而且此时已经没有 pointerout
     * 可以收它了（气泡的锚点不是当前指针所在的那个触发器），它会一直
     * 挂在那儿。
     */
    const handlePointerLeftAll = () => {
      clearShowTimer();
      scheduleHide();
    };

    const handlePointerOver = (event: PointerEvent) => {
      /*
       * 只响应**鼠标/触控笔**的悬停。
       *
       * 触摸（`pointerType === "touch"`）没有真正的「悬停」：点一下会派发
       * pointerover，却**不会**派发 pointerout（除非点到别处），气泡会粘在
       * 屏幕上不消失。旧实现用 `@media (hover: hover) and (pointer: fine)`
       * 门控掉了触摸设备；这里用 `pointerType` 判断更精确——混合设备（触屏 +
       * 鼠标）上鼠标仍然能用，而触摸不会误触发。
       */
      if (event.pointerType === "touch") return;
      pointerRef.current = { x: event.clientX, y: event.clientY };
      const anchor = findAnchor(event.target);
      if (!anchor) {
        /*
         * 指针到了**不带说明**的元素上 → 它已经离开了所有触发器。
         *
         * 这条路径不能省：触发器从 DOM 消失时，浏览器**不派发 pointerout**，
         * 只派发一次 `pointerover`（落在 body 上）。若这里直接 return，
         * 气泡就会停在原地不消失——依赖定时器去检测卸载，时机不可靠
         * （机器繁忙时定时器会被推迟，检测就晚了）。
         */
        handlePointerLeftAll();
        return;
      }
      const text = anchor.getAttribute("data-tooltip");
      if (!text) {
        /* 说明是空的 → 等同于「这里没有说明」：收掉气泡与待显示。 */
        handlePointerLeftAll();
        return;
      }
      /*
       * 指针又回到**同一个**触发器上（例如刚移出去又立刻划回来）：
       * 必须取消「待隐藏」定时器，否则气泡会在指针明明停着的时候消失。
       */
      if (anchorRef.current === anchor) {
        clearHideTimer();
        return;
      }
      /*
       * 这个触发器刚被 Escape 关过：在指针真正离开它之前不再显示。
       * 否则 Escape 看起来"没生效"——指针在按钮上微动一下，说明就复活了。
       *
       * 被关掉的触发器可能已经从 DOM 消失（节点被删、面板关闭）→ 顺手
       * 解除屏蔽，免得一直持着一个游离节点。
       */
      const dismissed = dismissedRef.current;
      if (dismissed !== null && !dismissed.isConnected) {
        dismissedRef.current = null;
      } else if (dismissed === anchor) {
        return;
      }
      /*
       * 换了触发器：旧气泡若只是「指针悬停」留下的，就**先收掉**。
       *
       * 它描述的是上一个控件（箭头还指着上一个），留在屏幕上会误导；而旧
       * 实现（CSS 伪元素）本来就是指针移开时 120ms 淡出的，这里保持一致。
       *
       * 但旧气泡若是**键盘焦点**持有的（焦点还停在那个控件上），就留着：
       * 它描述的仍是当前焦点控件，等新气泡显示出来再替换；等新气泡也走了，
       * 「焦点持有」的恢复逻辑会把说明还给焦点控件。
       *
       * `hide()` 会连带清掉待显示定时器，所以必须排在重新计时**之前**。
       */
      const staleAnchor = anchorRef.current;
      if (
        staleAnchor !== null &&
        staleAnchor !== anchor &&
        !(focusAnchorRef.current === staleAnchor && focusByKeyboardRef.current)
      ) {
        hide();
      }
      /*
       * 换了触发器：先取消「待隐藏」（否则旧气泡会盖住新气泡），
       * 再取消「待显示」并重新计时。
       *
       * 注意这里**不能**用 `clearTimers()`：它会把待显示的定时器一起清掉，
       * 那样「从 A 快速划到 B」时 B 的说明永远不出现。
       */
      clearHideTimer();
      clearShowTimer();
      pendingAnchorRef.current = anchor;
      showTimerRef.current = window.setTimeout(() => {
        showTimerRef.current = null;
        pendingAnchorRef.current = null;
        /*
         * 再确认一次屏蔽状态：这段等待里可能发生了 Escape。
         * 目前靠 `hide()` → `clearTimers()` 清掉本定时器来保证，但那是**隐式**
         * 依赖——这里显式判断，意图清楚，也不怕将来改动清定时器的时机。
         */
        if (dismissedRef.current === anchor) return;
        show(anchor, text);
      }, SHOW_DELAY_MS);
    };

    const handlePointerOut = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      pointerRef.current = { x: event.clientX, y: event.clientY };
      /*
       * `pointerout` 的 target 是**指针离开的那个元素**，它可能是触发器的
       * 子元素（比如按钮里的图标）。所以要先用 `relatedTarget`（指针要去的地方）
       * 反推：若 relatedTarget 仍在同一个触发器内，说明只是在其内部移动，
       * 不算离开。
       *
       * 用 relatedTarget 反推比用 target 更稳：target 是子元素时，
       * `closest` 能找到触发器，但 target 根本不是触发器时（例如指针从触发器
       * 内部移到空白处）`closest` 返回 null，会漏掉隐藏。
       */
      const related = event.relatedTarget;
      const nextAnchor =
        related instanceof Element ? related.closest<HTMLElement>("[data-tooltip]") : null;
      const current = anchorRef.current;
      /*
       * 指针**真正离开**了被 Escape 关过的触发器 → 解除屏蔽，之后再悬停
       * 可以重新显示（Escape 只压住"指针没离开"这一段时间）。
       */
      const dismissed = dismissedRef.current;
      if (dismissed && nextAnchor !== dismissed) dismissedRef.current = null;
      /* 指针还停在同一个触发器里（或其子元素）→ 不隐藏。 */
      if (current && nextAnchor === current) return;
      /* 指针移到了另一个触发器 → 交给 pointerover 处理切换，不要在这里隐藏。 */
      if (nextAnchor) return;
      /* 「焦点是否仍在触发器上 / 指针是否仍指着它」的判断已收进 scheduleHide。 */
      handlePointerLeftAll();
    };

    const handleFocusIn = (event: FocusEvent) => {
      const anchor = findAnchor(event.target);
      if (!anchor) {
        /*
         * 焦点落到了**完全不是触发器**的元素上：焦点持有与描述一起撤掉，
         * 别让它们停在旧元素上。
         */
        focusAnchorRef.current = null;
        focusByKeyboardRef.current = false;
        updateFocused(null);
        return;
      }
      const text = anchor.getAttribute("data-tooltip");
      if (!text) {
        /* 焦点落到了没有说明的触发器上：描述要撤掉，别停在旧元素上。 */
        focusAnchorRef.current = null;
        focusByKeyboardRef.current = false;
        updateFocused(null);
        return;
      }
      /*
       * 记住「谁持有焦点」以及「这个焦点是不是键盘带来的」。
       *
       * 焦点来源在**聚焦那一刻**定下来，不能等隐藏时再去看「最近一次输入
       * 设备」：用户 Tab 到按钮后又用鼠标点了别处，最近输入设备变成指针，
       * 但那个焦点确实还是键盘落在按钮上的。
       */
      focusAnchorRef.current = anchor;
      focusByKeyboardRef.current = keyboardRef.current;
      /*
       * 读屏描述**始终**跟着实际焦点走，与焦点来源无关：元素确实是当前
       * 焦点，描述它就是对的（读屏 + 鼠标的用户同样需要这份信息）。
       *
       * 若这里按输入来源跳过，焦点从 A 移到 B（鼠标点击 B）时，`focused`
       * 会仍指向**已失焦的 A**，A 的 `aria-describedby` 残留——那是陈旧状态。
       *
       * 描述挂在**真正持有焦点**的元素上，而不是触发器上：
       * `aria-describedby` 不会向下继承，挂在外层触发器上、而焦点落在它内部
       * 的可聚焦子元素上时，读屏永远不会念这条说明。
       */
      const described = event.target instanceof Element ? event.target : anchor;
      updateFocused({ anchor, text, described });
      /*
       * 但**视觉气泡**只对键盘来源显示：鼠标点击按钮同样会派发 `focusin`，
       * 若一并响应，用户点一下按钮就冒出一段说明（旧实现用 `:focus-visible`
       * 正是为了避免这个；实测 `:focus-visible` 会受上一次交互方式影响，
       * 不能直接用）。
       */
      if (!keyboardRef.current) return;
      clearShowTimer();
      clearHideTimer();
      /* 键盘聚焦时立即给出说明（读屏与键盘用户不该等延迟）。 */
      show(anchor, text);
    };

    const handleFocusOut = (event: FocusEvent) => {
      /*
       * 焦点离开**不直接隐藏气泡**：指针可能仍停在同一个触发器上（例如用户
       * 用鼠标点过按钮后焦点落在按钮上，鼠标随后移开——这时焦点还在，气泡
       * 不该没）。
       *
       * 所以这里只清「待显示」定时器，把隐藏交给「指针与焦点都不在任何
       * 触发器上」的判定。
       */
      const related = event.relatedTarget;
      const nextAnchor =
        related instanceof Element ? related.closest<HTMLElement>("[data-tooltip]") : null;
      const leftAnchor =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>("[data-tooltip]")
          : null;
      /*
       * 焦点离开了原来那个触发器 → 键盘来源的「焦点持有」要一起解除。
       *
       * 不解除的话，说明会因为「焦点还在」而永远不消失（键盘聚焦过、之后
       * 又用鼠标点别的地方那种情况尤其明显）。
       */
      if (
        leftAnchor !== null &&
        focusAnchorRef.current === leftAnchor &&
        nextAnchor !== leftAnchor
      ) {
        focusAnchorRef.current = null;
        focusByKeyboardRef.current = false;
      }
      /*
       * 焦点到了**另一个有说明的触发器**上：读屏描述要跟着新焦点走，由紧随
       * 其后的 `focusin` 负责更新。这里不抢先清空——清空会让
       * `aria-describedby` 先被撤除再重新挂上，中间那个窗口里读屏查询
       * 描述会拿到空值。
       */
      if (nextAnchor && nextAnchor.getAttribute("data-tooltip")) return;
      /*
       * 焦点来源没了：读屏描述要跟着撤（否则会念一个已经失焦的控件的说明）。
       *
       * 注意新焦点可能是**没有说明的**触发器（`data-tooltip` 为空）——那种
       * 情况下紧随其后的 `focusin` 会提前返回，描述就永远停在旧元素上了。
       */
      updateFocused(null);
      /*
       * 交给 scheduleHide 统一判定：指针仍停在这个触发器上时不隐藏（说明还在
       * 被指着），否则安排隐藏。
       */
      scheduleHide();
    };

    /**
     * 记录输入来源。
     *
     * 必须挂在**捕获阶段**：有些控件会 `stopPropagation()` 掉 keydown
     * （`CanvasNodeEditor` 用 Escape 关闭编辑层时就会），冒泡阶段收不到 →
     * 焦点来源会被误判成指针，键盘聚焦的说明就不出来了。
     */
    const handleKeyDownCapture = () => {
      /* 键盘操作 → 后续的 focusin 视为键盘聚焦。 */
      keyboardRef.current = true;
    };

    /** 指针按下 → 焦点来源是指针，不该因聚焦而弹说明。 */
    const handlePointerDown = (event: PointerEvent) => {
      keyboardRef.current = false;
      /*
       * 用鼠标点了当前**键盘聚焦**的触发器 → 撤掉「键盘持有」。
       *
       * 等价于 `:focus-visible` 的行为：鼠标点过之后就不再算键盘导航。
       * 不撤的话，说明会因为「焦点还在」而在指针移开后赖着不走。
       */
      const focusAnchor = focusAnchorRef.current;
      if (focusAnchor === null) return;
      const target =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>("[data-tooltip]")
          : null;
      if (target !== focusAnchor) return;
      focusByKeyboardRef.current = false;
    };

    document.addEventListener("pointerover", handlePointerOver, true);
    document.addEventListener("pointerout", handlePointerOut, true);
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("focusin", handleFocusIn, true);
    document.addEventListener("focusout", handleFocusOut, true);
    document.addEventListener("keydown", handleKeyDownCapture, true);
    return () => {
      document.removeEventListener("pointerover", handlePointerOver, true);
      document.removeEventListener("pointerout", handlePointerOut, true);
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("focusin", handleFocusIn, true);
      document.removeEventListener("focusout", handleFocusOut, true);
      document.removeEventListener("keydown", handleKeyDownCapture, true);
    };
  }, [clearHideTimer, clearShowTimer, hide, show, updateFocused]);

  /*
   * Escape 关闭说明：交给全应用唯一的仲裁器（`escapeArbiter`）。
   *
   * 为什么不自己监听：自己挂一个 document 级监听 = 又一条与浮层 / 弹窗
   * **平行**的 Escape 通道，两者互相看不见——「关掉下拉菜单的 Escape」会
   * 顺手把画布上的说明也关掉（浮层先关、说明后关），或者说明先关、
   * 浮层没关（用户以为没生效）。仲裁器一次只让一个处理者动手。
   *
   * 优先级给到浮层之下、画布背景动作之上（`ESCAPE_PRIORITY_TOOLTIP`）：说明是
   * 全应用最外层的提示，不该抢在浮层 / 弹窗前面；但此刻用户眼前的就是它，
   * Esc 应当先关掉它（连「延迟中、还没显示」的那条也一并压住）。
   *
   * `claim: false`：不消费这个键。Escape 在本项目里是关闭弹窗与菜单的通用键
   * （`CanvasSelect`、`SearchableMultiSelect` 都监听它），本层不该抢掉那些
   * 行为。输入法组合（`isComposing` / `keyCode === 229`）与「已被内层认领」
   * （`defaultPrevented`）由仲裁器统一判断。
   */
  useEscapeHandler(
    {
      canHandle: () => anchorRef.current != null || pendingAnchorRef.current != null,
      handle: () => {
        /*
         * 记住被关掉的那个触发器：指针若**还停在**它上面，短时间内不该又冒
         * 出来（否则 Escape 看起来"没生效"——指针一动说明就复活）。
         * 指针真正离开该触发器后才解除屏蔽（见 `handlePointerOut`）。
         *
         * 顺序要紧：**先记再隐藏**。`hide()` 会把 `anchorRef.current` 置空，
         * 先隐藏再读就永远读到 null，屏蔽机制等于没写。
         *
         * `anchorRef` 为空说明气泡**还没显示**（还在 800ms 延迟里），这时要
         * 用 `pendingAnchorRef` 记——否则「延迟中的说明」会在 Escape 之后照样
         * 冒出来，Escape 看着像没生效。
         */
        dismissedRef.current = anchorRef.current ?? pendingAnchorRef.current;
        /*
         * 读屏描述**只在它属于同一个触发器**时一起关掉。
         *
         * 焦点在 B、鼠标悬停 A 时按 Escape：被关掉的是 A 的气泡，B 仍然聚焦
         * 着，把 B 的说明也抽走会让读屏用户丢掉当前控件的说明，而且焦点没变、
         * 不会再有 `focusin` 来刷新它。
         */
        const focusedAnchor = focusedRef.current?.anchor ?? null;
        if (focusedAnchor === null || focusedAnchor === dismissedRef.current) {
          updateFocused(null);
          focusAnchorRef.current = null;
          focusByKeyboardRef.current = false;
        }
        hide();
      },
      claim: false,
      priority: ESCAPE_PRIORITY_TOOLTIP,
    },
    true,
  );

  /*
   * 定位：量出气泡的**实测宽高**，再交给 `placeTooltip` 决定贴哪一侧。
   *
   * 高度必须实测：翻面判断（「下方装不装得下」）全靠它。用估算值偏小时，
   * 下方明明放不下却判定放得下，说明照样被视口下沿切掉——那正是本次要修的 bug。
   *
   * 定位用 `transform` 而不是 `top/left`：`transform` 走合成器，不触发重排；
   * 写 `top/left` 会让浏览器每帧重新布局整个气泡（在大画布上是明显的
   * layout thrash）。气泡尺寸只有文案变化时才会变，所以用 `ResizeObserver`
   * 重新测量，而不是每帧量一次。
   */
  const reposition = useCallback(() => {
    const bubble = bubbleRef.current;
    const anchor = anchorRef.current;
    if (!bubble || !anchor) return;
    /*
     * 触发器可能已经**不可用了**，有两种形态：
     *   - 从 DOM 里消失（画布节点被删、React 重渲染替换了按钮）→ `isConnected` 为 false；
     *   - 还在 DOM 里但被藏起来（`display: none` 的容器、响应式断点下隐藏的
     *     控件）→ `isConnected` 为 true，但矩形全为 0。
     * 两种情况下 `getBoundingClientRect()` 都拿不到有效位置，气泡会被摆到视口
     * 左上角并一直停在那儿——比不显示更糟。检测到就收掉。
     */
    const anchorRect = anchor.getBoundingClientRect();
    if (!anchor.isConnected || anchorRect.width === 0 || anchorRect.height === 0) {
      hide();
      return;
    }
    /*
     * 触发器可能**被别的东西盖住**了。
     *
     * 展开的提示词编辑器是全屏模态（`position: fixed; inset: 0` +
     * `z-index: var(--z-modal)`），它一打开就把整个 `.workspace-shell` 置为
     * `inert`；而气泡渲染在 body 上、层级比模态还高（`--z-tooltip`），于是
     * 会**浮在模态之上**，变成一条没人看得懂的残留说明。
     *
     * 事件驱动的路径救不了这一种：指针不动就不会再有 pointerover/pointerout，
     * 气泡会一直挂着（直到用户去动鼠标）。所以这里用命中测试兜底——触发器
     * 中心那个位置上若不是它自己、它的后代或它的祖先，就说明它被盖住了，
     * 收掉气泡。
     *
     * 气泡自己是 `pointer-events: none`，不会成为命中目标 ✓。
     */
    const centerX = anchorRect.left + anchorRect.width / 2;
    const centerY = anchorRect.top + anchorRect.height / 2;
    const hit = document.elementFromPoint(centerX, centerY);
    if (hit instanceof Node && !anchor.contains(hit) && !hit.contains(anchor)) {
      hide();
      return;
    }
    /*
     * 焦点控件的说明文案也可能**自己变了**（工具条项的「（后端暂未接入）」后缀
     * 会随能力状态出现或消失）：读屏描述要跟着换，否则屏幕上的说明与念出来
     * 的说明会不一致。
     *
     * 注意读的是**焦点那个控件**的属性，与当前气泡挂在谁身上无关——两者可以
     * 是不同的元素（焦点在 B、鼠标悬停 A）。
     */
    const focusedState = focusedRef.current;
    if (focusedState !== null) {
      const focusedLiveText = focusedState.anchor.getAttribute("data-tooltip");
      if (focusedLiveText !== null && focusedLiveText !== focusedState.text) {
        updateFocused({
          anchor: focusedState.anchor,
          text: focusedLiveText,
          described: focusedState.described,
        });
      }
    }
    /*
     * 文案可能**自己变了**：切换模式的按钮会在状态变化时改写自己的
     * `data-tooltip`（「移动 · 拖动画布」↔「框选 · 框选节点」）。说明若停在
     * 旧文案上，读到的是一句已经失效的话——比不显示更糟。
     */
    const liveText = anchor.getAttribute("data-tooltip");
    if (liveText === null || liveText === "") {
      /* 说明被撤掉了 → 没有可显示的内容，收掉。 */
      hide();
      return;
    }
    if (liveText !== shownTextRef.current) {
      /* 换文案：先换内容，位置等下一帧按新文案重算。 */
      show(anchor, liveText);
      return;
    }
    /*
     * 宽高还没实测到（气泡刚出现、文案刚换）就先不摆——用 0 宽高算出来的
     * 位置是错的（会贴到视口最左边），等 `useLayoutEffect` 量过再摆。
     */
    if (widthRef.current === 0 || heightRef.current === 0) return;
    const placement = placeTooltip(anchor, {
      gap: GAP,
      measuredWidth: widthRef.current,
      measuredHeight: heightRef.current,
      /* 上面刚量过，复用它，别再读一次（强制同步布局）。 */
      anchorRect,
    });
    const transform = `translate3d(${placement.left}px, ${placement.top}px, 0)`;
    /* 位置没变就不写样式：避免每帧产生无意义的样式失效。 */
    if (bubble.style.transform !== transform) bubble.style.transform = transform;
    if (bubble.dataset["side"] !== placement.side) bubble.dataset["side"] = placement.side;
    /* 箭头对准触发器（气泡被视口夹住时不能写死 50%）。 */
    const arrow = `${placement.arrowLeft}px`;
    if (bubble.style.getPropertyValue("--tooltip-arrow-left") !== arrow) {
      bubble.style.setProperty("--tooltip-arrow-left", arrow);
    }
  }, [hide, show, updateFocused]);

  /*
   * 首次定位用 `useLayoutEffect` 而不是 `useEffect`：定位必须在浏览器绘制
   * 之前完成，否则用户会先看到气泡停在 (0,0) 再跳到触发器旁边（闪一下）。
   *
   * 这里顺带完成**实测**：气泡的宽高要量过才知道怎么摆。
   *
   * 只在**已显示**时测量：气泡常驻 DOM（为了 `aria-describedby` 指向一个
   * 始终存在的元素），隐藏时它的宽高是 0，量了会污染缓存。
   */
  useLayoutEffect(() => {
    if (!state) return;
    const bubble = bubbleRef.current;
    const anchor = anchorRef.current;
    if (!bubble || !anchor) return;
    const box = bubble.getBoundingClientRect();
    widthRef.current = box.width;
    heightRef.current = box.height;
    reposition();
  }, [reposition, state]);

  /*
   * 无障碍：把说明与**获得焦点的那个元素**用 `aria-describedby` 关联。
   *
   * 触发器本身都有 `aria-label`（可访问名），说明是**补充信息**（如
   * 「整理画布 · Alt+Shift+F」里的快捷键、「功能组件（后端暂未接入）」的
   * 状态），所以挂 `aria-describedby` 而不是替换可访问名——读屏会先念名字
   * 再念说明。
   *
   * **只在说明提供了可访问名之外的信息时才关联**：有 7 处触发器的
   * `data-tooltip` 与 `aria-label` 完全相同（如「切换小地图」），无条件
   * 关联会让读屏把同一句话念两遍——那是噪声，不是信息。补充信息则必须
   * 关联，否则读屏用户永远拿不到「后端暂未接入」这类关键说明。
   *
   * 为什么描述元素必须**常驻 DOM**（而不是显示时才挂载）：`aria-describedby`
   * 指向的元素如果此刻不存在，读屏软件读不到。焦点路径是「先聚焦、再读」，
   * 描述元素若在聚焦后才异步出现，朗读就丢了。所以它一直在 DOM 里，只切换
   * 内容；焦点离开时清空内容，避免读屏念到已经失焦的控件的说明。
   *
   * 用 **`useLayoutEffect`** 而不是 `useEffect`：读屏通常在焦点事件的同一轮
   * 就去查询控件的描述，而 `useEffect` 的被动副作用要排到 paint 之后才跑——
   * 那一刻属性还没挂上，描述就漏掉了。布局副作用在提交阶段同步执行，
   * 浏览器绘制与读屏查询之前属性就已经就位。
   */
  useLayoutEffect(() => {
    /*
     * 用 state 里的元素而不是可变的 `anchorRef.current`：
     * ref 会在 `hide()` / `show()` 里被改写，而 effect 的清理函数捕获的是
     * **本轮**的元素。读 ref 会让「清理的是谁」变得依赖时序，读 state 则
     * 始终是本轮渲染的那一个。
     */
    if (!focused) return;
    /*
     * 挂在**真正持有焦点**的元素上（`described`），不是触发器上——
     * `aria-describedby` 不向下继承，挂在祖先上等于没挂。
     */
    const described = focused.described;
    if (!hasExtraInformation(described, focused.text)) return;
    const existing = described.getAttribute("aria-describedby");
    const ids = existing === null ? [] : existing.split(/\s+/).filter((id) => id.length > 0);
    /* 已经挂过就别重复挂：同一个 id 出现两次会被读屏念两遍。 */
    if (!ids.includes(descriptionId)) {
      described.setAttribute("aria-describedby", [...ids, descriptionId].join(" "));
    }
    return () => {
      /*
       * 失焦时**只摘掉自己挂的那个 id**。
       *
       * 不要整串还原成挂载前的快照：期间别人可能又加了引用（例如控件自己
       * 的错误提示在变），整串还原会把那一条一起抹掉。
       */
      const current = described.getAttribute("aria-describedby");
      if (current === null) return;
      const parts = current.split(/\s+/).filter((id) => id.length > 0);
      if (!parts.includes(descriptionId)) return;
      const rest = parts.filter((id) => id !== descriptionId);
      if (rest.length === 0) described.removeAttribute("aria-describedby");
      else described.setAttribute("aria-describedby", rest.join(" "));
    };
  }, [focused]);

  /*
   * 触发器移动（画布平移/缩放、窗口改大小、祖先滚动）时，气泡要跟着走。
   *
   * 画布平移走的是 transform，**不触发 scroll 事件**，所以光靠 scroll/resize
   * 监听跟不上。这里用低频定时器（`FOLLOW_INTERVAL_MS`）跟随：
   *
   *   - 为什么不是 rAF 每帧跟：每帧调 `getBoundingClientRect()` 会**强制同步
   *     布局**，在大画布（成百上千节点）上是每帧一次 layout thrash。
   *     跟随延迟 ~100ms 对说明气泡这种辅助信息完全够用。
   *   - 为什么不用纯事件驱动：transform 变化没有对应事件，只能轮询。
   *
   * 气泡自身的尺寸变化（文案变了、字体加载完成）由 `ResizeObserver` 负责，
   * 重新实测宽高——那才是必须精确的时刻（翻面判断依赖实测高度）。
   */
  useEffect(() => {
    if (!state) return;
    const bubble = bubbleRef.current;
    /* 气泡尺寸变化时重新实测：翻面判断依赖实测高度，字体加载完成也会改高度。 */
    const observer =
      bubble === null
        ? null
        : new ResizeObserver(() => {
            if (!bubbleRef.current) return;
            const box = bubbleRef.current.getBoundingClientRect();
            widthRef.current = box.width;
            heightRef.current = box.height;
            reposition();
          });
    observer?.observe(bubble ?? document.body);

    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    const timer = window.setInterval(reposition, FOLLOW_INTERVAL_MS);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      window.clearInterval(timer);
    };
  }, [reposition, state]);

  /* 组件卸载时清掉定时器，避免对已卸载组件 setState。 */
  useEffect(() => clearTimers, [clearTimers]);

  /*
   * 读屏描述只在**说明真的补充了信息**时才有内容。
   *
   * 若说明与可访问名重复（7 处完全相同、3 处是名字的子串），描述元素就该是
   * 空的：内容留在里面虽然没人引用，但读屏的**浏览模式**仍会把它当一段独立
   * 文本念出来——用户会听到同一句话出现两次（按钮的名字一次、这段散文本一次）。
   */
  const descriptionText =
    focused !== null && hasExtraInformation(focused.described, focused.text) ? focused.text : "";

  /*
   * 气泡**常驻 DOM**，只切换内容与可见性。
   *
   * 原因在上面的 a11y 注释里：`aria-describedby` 指向的描述元素必须始终存在，
   * 否则读屏在聚焦那一刻读不到说明。常驻还有一个附带好处：切换触发器时
   * 不用重新挂载 DOM，淡入动画不会重播。
   *
   * 隐藏时把**内容也清空**：`role="tooltip"` 的元素留在可访问性树里，
   * 读屏的浏览模式会遍历到它，留着旧文案会让人听到一条已经失效的说明。
   * （读屏路径不受影响：它指向的是下面那个独立的描述元素。）
   */
  return createPortal(
    <>
      <div
        ref={bubbleRef}
        className="tooltip-layer__bubble"
        role="tooltip"
        /*
         * 视觉气泡对读屏**隐藏**：它会被 hover 改写、内容会清空，
         * 拿它当描述来源会念出错误的文案。读屏要听的说明由下面那个
         * 独立的 `sr-only` 元素承载。
         */
        aria-hidden="true"
        data-open={state === null ? "false" : "true"}
      >
        {state?.text ?? ""}
      </div>
      {/*
       * 读屏描述：内容跟随**当前焦点**的触发器，是该控件的稳定说明。
       * 焦点离开时内容清空，避免读屏念到已经失焦的控件的说明。
       * 说明与可访问名重复时内容也清空（见上面 `descriptionText` 的注释）。
       */}
      <span id={descriptionId} className="sr-only tooltip-layer__description">
        {descriptionText}
      </span>
    </>,
    document.body,
  );
}
