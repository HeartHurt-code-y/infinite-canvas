/*
 * Escape 仲裁器：全应用**唯一**的 Escape 决策点。
 *
 * 真实故障（2026-11-02 实测）
 * --------------------------
 * 修复前全仓有二十多处 window / document 级 keydown 监听各自处理 Escape：
 * 捕获阶段的那些（`useModalFocusTrap`、`CanvasAssetDrawer`、`CanvasZoomMenu`…）
 * 会在 React 冒泡处理**之前**抢走按键；`useModalFocusTrap` 还调
 * `stopImmediatePropagation()`，把同一层别的捕获监听器一起掐掉。
 *
 * 于是同一个 Escape 归谁，只取决于「谁先注册 + 挂在哪个阶段」：
 *   · 创作台偏好面板里点开模型下拉，按 Esc → 面板整个消失（用户只想关下拉）；
 *   · 画布素材抽屉开着时按 Esc → 抽屉连同画布上的菜单一起没了；
 *   · 某些组合下 Escape 干脆没反应（被 `stopImmediatePropagation` 掐掉）。
 *
 * 仲裁规则
 * --------
 *   1. **只有一处监听**：window 的 keydown，**冒泡阶段**。
 *      元素级 React 处理器（`CanvasSelect` / `CreateSelect` /
 *      `SearchableMultiSelect` 的菜单）在 React 根容器上先跑，能用
 *      `preventDefault()` 认领这个键；捕获阶段做不到这一点——那时还没有人
 *      处理过，`defaultPrevented` 恒为 false，「谁抢到算谁的」。
 *   2. **已被认领就不动作**：`event.defaultPrevented` 为真 → 直接返回。
 *   3. **输入法组合期间不动作**：`isComposing` / `keyCode === 229`
 *      （组合期间的 Escape 归输入法，见 AGENTS.md）。
 *   4. **一次按键只有一个处理者**：按优先级 + 注册顺序（后注册 = 更内层）
 *      找第一个 `canHandle()` 为真的处理者，执行它就收工，后面的人不再动作。
 *   5. **消费与否由处理者决定**：默认 `preventDefault()`（把这个键吃掉，
 *      免得浏览器再做默认动作，比如关掉原生 `<dialog>`）；明确不消费的
 *      （说明气泡）传 `claim: false`。
 *
 * 用法
 * ----
 * ```ts
 * useEscapeHandler(
 *   {
 *     canHandle: () => open,
 *     handle: () => close(),
 *   },
 *   open,
 * );
 * ```
 *
 * **不要**再写 `window.addEventListener("keydown", …)` 处理 Escape：
 * 平行监听器彼此看不见，「一次按键关两层」就会复发。元素级 React 的
 * `onKeyDown` 不受此限——它在 React 根容器上跑，先于本仲裁器，能用
 * `preventDefault()` 明确认领。
 */
import { useEffect, useRef } from "react";

export interface EscapeHandlerOptions {
  /** 此刻是否愿意处理这次 Escape。 */
  readonly canHandle: (event: KeyboardEvent) => boolean;
  /** 处理这次 Escape。 */
  readonly handle: (event: KeyboardEvent) => void;
  /**
   * 是否消费这个键（`preventDefault`）。默认 true。
   *
   * 明确不消费的是「说明气泡」：Escape 在本项目里是关闭弹窗与菜单的通用键，
   * 气泡层不该抢掉那些行为。
   */
  readonly claim?: boolean;
  /**
   * 优先级，**大**的先处理。默认 0。
   *
   * 同一优先级内按注册顺序倒序（后注册 = 更内层 = 更晚打开，先处理）。
   * 优先级只用来表达「不属于同一层」的例外：说明气泡（最底层）与画布背景动作
   * （清选中 / 退出连线手势）都该排在浮层与弹窗之后。
   */
  readonly priority?: number;
}

/**
 * 说明气泡的优先级：全应用最外层的提示，但**排在画布背景动作之前**。
 *
 * 气泡不该抢在浮层 / 弹窗前面（用户在面板里按 Esc 想关的是面板）；但它该
 * 抢在画布背景动作前面——「Escape 关闭当前显示着的那一条说明」「Escape 也要
 * 记住『延迟中』的那个触发器」是仓库既有约定，气泡是此刻用户眼前的东西。
 */
export const ESCAPE_PRIORITY_TOOLTIP = -100;

/**
 * 画布背景动作的优先级：清选中、退出连线手势这类「什么都没开时才做」的动作。
 *
 * 压在所有浮层 / 弹窗之下：浮层开着时，Esc 归浮层，不该顺手把画布也清了。
 * 一次按键只做一件事——这正是「一次 Esc 关两层」的根因修复点。
 */
export const ESCAPE_PRIORITY_CANVAS = -500;

/**
 * 事件是否发生在表单控件里（输入框 / 文本域 / 下拉 / 可编辑区域）。
 *
 * 沿用 `react-hotkeys-hook` 的默认口径（`enableOnFormTags: false`）：
 * 在输入框里按 Esc 不该触发画布级动作，否则用户打字打到一半按 Esc
 * 会把画布选中清掉。
 */
export function isInsideFormField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * 注册表挂在 `globalThis` 上：**跨模块实例唯一**。
 *
 * 为什么不能放在模块作用域里：模块被重新求值（开发环境的 HMR、被打进两份的
 * 依赖）会得到**新的**处理者数组与**新的** window 监听器，而旧的监听器仍然
 * 挂在 window 上、旧的数组里仍然留着上一轮的处理者。旧处理者会**先**抢到
 * Escape：它调用的是已卸载组件的 `setState`（等于什么都没做），却已经把按键
 * 吃掉并 `preventDefault()`——表现就是「按 Esc 没反应」，而且没有任何异常。
 *
 * 挂到全局对象上，全局只有一份注册表、只挂一次监听器，监听器转调
 * `registry.dispatch`（始终是最新一版实现）。
 */
interface EscapeRegistry {
  /** 已注册的处理者；顺序即优先级。 */
  readonly handlers: EscapeHandlerOptions[];
  /** 真正处理按键的函数：模块重新求值时会被最新版覆盖。 */
  dispatch: (event: KeyboardEvent) => void;
  /** 监听器是否已挂上 window。 */
  installed: boolean;
  /** 模块版本号：只有最新一版模块允许覆盖 `dispatch`。 */
  version: number;
}

const REGISTRY_KEY = "__infiniteCanvasEscapeArbiter";
type GlobalWithRegistry = typeof globalThis & { [REGISTRY_KEY]?: EscapeRegistry };
const globalScope = globalThis as GlobalWithRegistry;
const registry: EscapeRegistry = (globalScope[REGISTRY_KEY] ??= {
  handlers: [],
  dispatch: () => {},
  installed: false,
  version: 0,
});
/* 本模块这一版实例的版本号（每次模块求值 +1）。 */
const moduleVersion = (registry.version += 1);

function handleKeyDown(event: KeyboardEvent): void {
  if (event.key !== "Escape") return;
  /* 已被内层认领（元素级 React 处理器 `preventDefault()`）→ 不再动作。 */
  if (event.defaultPrevented) return;
  /* 输入法组合期间的 Escape 归输入法（取消候选窗口）。 */
  if (event.isComposing || event.keyCode === 229) return;

  for (const handler of orderedHandlers()) {
    let canHandle = false;
    try {
      canHandle = handler.canHandle(event);
    } catch {
      canHandle = false;
    }
    if (!canHandle) continue;
    handler.handle(event);
    if (handler.claim !== false) {
      /* 吃掉这个键：免得浏览器再做默认动作（比如关掉原生 `<dialog>`）。 */
      event.preventDefault();
      event.stopPropagation();
    }
    /* 一次按键只有一个处理者——绝不叠加第二层。 */
    return;
  }
}

/**
 * 处理者的处理顺序：优先级高的先；同优先级内**后注册的先**（更内层）。
 */
function orderedHandlers(): EscapeHandlerOptions[] {
  return registry.handlers
    .map((handler, index) => ({ handler, index, priority: handler.priority ?? 0 }))
    .sort((a, b) => b.priority - a.priority || b.index - a.index)
    .map((item) => item.handler);
}

/**
 * 注册一个 Escape 处理者，返回注销函数。
 *
 * 注册顺序即优先级：**后注册的先处理**（更内层 / 更晚打开）。
 */
export function registerEscapeHandler(options: EscapeHandlerOptions): () => void {
  registry.handlers.push(options);
  if (!registry.installed) {
    registry.installed = true;
    /* 冒泡阶段：让元素级 React 处理器先跑，它们才能用 defaultPrevented 认领。 */
    window.addEventListener("keydown", (event) => registry.dispatch(event));
  }
  /* 模块重新求值时，让监听器转调最新一版实现。 */
  /* 只有最新一版模块能覆盖：旧实例（还活着的组件闭包）调用时不要把实现退回去。 */
  if (moduleVersion >= registry.version) registry.dispatch = handleKeyDown;
  return () => {
    const index = registry.handlers.indexOf(options);
    if (index >= 0) registry.handlers.splice(index, 1);
  };
}

/**
 * React 版本的注册：处理逻辑放在 `options` 里随渲染更新，但**注册顺序不变**
 * （只在 `active` 翻转时重新注册），否则每次重渲染都会把优先级重排一遍，
 * 「Escape 归最内层」就变成了「归最后渲染的那个」。
 */
export function useEscapeHandler(options: EscapeHandlerOptions, active = true): void {
  const latestRef = useRef(options);
  /** 组件是否已经卸载：卸载后的处理者不许再动手（否则会吃掉按键却不生效）。 */
  const disposedRef = useRef(false);
  useEffect(() => {
    latestRef.current = options;
  });
  useEffect(() => {
    disposedRef.current = false;
    if (!active) return;
    const unregister = registerEscapeHandler({
      canHandle: (event) => !disposedRef.current && latestRef.current.canHandle(event),
      handle: (event) => {
        if (disposedRef.current) return;
        latestRef.current.handle(event);
      },
      get claim(): boolean {
        return latestRef.current.claim !== false;
      },
      get priority(): number {
        return latestRef.current.priority ?? 0;
      },
    });
    return () => {
      /* 组件卸载了：这个处理者不许再动手——它会吃掉按键却什么都不做。 */
      disposedRef.current = true;
      unregister();
    };
  }, [active]);
}

/**
 * 判断事件是否落在**已打开的下拉浮层**里。
 *
 * 浮层一律 portal 到 body，并用 `role="listbox"` / `role="menu"` 标记自己
 * （`CanvasSelect` 的 `.canvas-select__menu`、`CreateSelect` 的
 * `.create-select__menu`、`CanvasContextMenu`）。按 ARIA 角色而不是类名判定，
 * 任何组件只要用标准角色暴露浮层，Escape 的归属就是对的，不必到处登记类名。
 *
 * 要覆盖**两种焦点位置**：
 *   1. 焦点在浮层内部——目标落在 listbox / menu 内部；
 *   2. 焦点在**展开状态的 combobox** 上（`SearchableMultiSelect` 的搜索框是
 *      `role="combobox"`，而 listbox 是它的**兄弟节点**而非祖先，`closest`
 *      找不到）——此时下拉同样是打开的，Esc 应当先关下拉。
 *
 * 触发器本身（未展开的 `role="combobox"`）不算，否则弹窗永远关不掉。
 */
export function isInsideOpenPopup(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const popup = target.closest('[role="listbox"], [role="menu"]');
  if (popup != null && popup.getClientRects().length > 0) return true;
  if (target.matches('[role="combobox"][aria-expanded="true"]')) return true;
  return false;
}
