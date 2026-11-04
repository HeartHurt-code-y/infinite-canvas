/*
 * 浮层家族：portal 之后 DOM 祖先关系就没了，「内部点击 / 内部 Escape」
 * 只能靠猜——而猜错的后果是实打实的。
 *
 * 真实故障（2026-11-02 实测）：创作台「Agent 模式 → 生成偏好」面板里，
 * 点「其他设置 → 模型」下拉里的某个选项，**面板直接消失、选择没生效**。
 * 根因有两层：
 *
 *   ① 面板的「点外部关闭」在 window 的 **capture 阶段**听 mousedown，
 *      而下拉菜单是 portal 到 body 的另一个节点——DOM 上它不属于面板，
 *      于是被当成「外部点击」，在 mousedown 阶段就把面板关了；菜单随之
 *      卸载，选项的 click 永远轮不到。
 *   ② 面板自己在 window 的 capture 阶段处理 Escape，先于下拉自己的处理
 *      跑掉，还顺手 stopPropagation 掉下拉的——一次按键关掉两层
 *      （用户只想关下拉，面板却整个没了）。
 *
 * 这里显式记一份浮层的父子关系：「算不算内部」按这棵树判，不按 DOM 祖先判。
 * 父子关系靠 React context 传递——portal 只改 DOM 位置，**不改 React 树**，
 * 所以内层浮层在渲染时仍能拿到自己挂在哪个外层浮层下。
 */
import { createContext, useContext } from "react";

interface FloatingLayerEntry {
  /** 父浮层 id；顶层浮层为 null。 */
  readonly parentId: string | null;
  /** 浮层根节点（portal 出去的 div）。 */
  readonly root: HTMLElement;
}

/** 当前打开的浮层：id → 父子关系与根节点。 */
const layers = new Map<string, FloatingLayerEntry>();

/**
 * 当前渲染位置所属的父浮层 id。
 *
 * 内层浮层（面板里的下拉菜单）从这里拿到父层，外层浮层据此把
 * 「子浮层里的点击 / 按键」认成自己的内部行为。
 */
export const FloatingLayerParentContext = createContext<string | null>(null);

/** 登记一个打开中的浮层。 */
export function registerFloatingLayer(
  id: string,
  parentId: string | null,
  root: HTMLElement,
): void {
  layers.set(id, { parentId, root });
}

/** 注销一个浮层（关闭或卸载时）。 */
export function unregisterFloatingLayer(id: string): void {
  layers.delete(id);
}

/** candidateId 是否挂在 ancestorId 之下（含自己）。 */
function isLayerUnder(candidateId: string, ancestorId: string): boolean {
  const seen = new Set<string>();
  let cursor: string | null = candidateId;
  while (cursor !== null && !seen.has(cursor)) {
    if (cursor === ancestorId) return true;
    seen.add(cursor);
    cursor = layers.get(cursor)?.parentId ?? null;
  }
  return false;
}

/**
 * 目标是否落在该浮层的「内部」：自身根节点，或它的任意子孙浮层。
 *
 * 子孙浮层（如面板里的下拉菜单）是 portal 出去的独立 DOM 节点，
 * 但在「家族」关系上属于这个面板——点它不该把面板关掉。
 */
export function isInsideFloatingLayerFamily(target: Node, id: string): boolean {
  const entry = layers.get(id);
  if (entry?.root.contains(target)) return true;
  for (const [otherId, other] of layers) {
    if (otherId === id) continue;
    if (!other.root.contains(target)) continue;
    if (isLayerUnder(otherId, id)) return true;
  }
  return false;
}

/**
 * 该浮层下面是否还有打开的子浮层。
 *
 * Escape 归最内层：外层浮层看到子浮层开着就让给子层处理，
 * 免得一次按键把两层都关掉。
 */
export function hasOpenChildLayer(id: string): boolean {
  for (const otherId of layers.keys()) {
    if (otherId !== id && isLayerUnder(otherId, id)) return true;
  }
  return false;
}

/** 当前渲染位置所属的父浮层 id。 */
export function useFloatingLayerParentId(): string | null {
  return useContext(FloatingLayerParentContext);
}
