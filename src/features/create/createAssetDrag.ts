/*
 * 创作台的素材拖拽会话。
 *
 * 资产抽屉（拖拽源）与底部浮坞（落点）是兄弟组件，中间隔着整页内容；
 * 拖拽期间两者要共享的只有「指针现在停在落点上没有」这一件事，
 * 所以这里放一个模块级 store：拖拽源写它，落点读它（用它高亮自己）。
 *
 * ── 为什么是指针事件，不是 HTML5 draggable ──────────────────────────
 * Tauri WebView 的系统拖放处理器会截走 dataTransfer 拖拽，所以本项目
 * 一律不依赖 draggable（画布素材卡也是指针拖拽，见 workspaceModel.ts
 * 里「素材卡片使用指针拖拽」那条注释）。落点判定因此走 `elementFromPoint`
 * 命中测试，而不是 dragover/drop 事件。
 */
import { useSyncExternalStore } from "react";
import type { AssetItem } from "../workspace/workspaceModel";

/**
 * 落点区标记属性。
 *
 * 浮坞（普通档与 Agent 档）把属性挂在自己的外壳上；拖拽源按这个属性
 * 找落点。属性而不是注册表：落点是 DOM 元素，用属性标记就不需要在两侧
 * 组件之间传任何东西。
 */
export const CREATE_DROP_ZONE_ATTRIBUTE = "data-create-drop-zone";

/** 拖拽会话状态。 */
export interface CreateAssetDragState {
  /** 正在拖动的素材；null 表示没有拖拽在进行。 */
  readonly asset: AssetItem | null;
  /** 指针当前是否停在落点区上。 */
  readonly overTarget: boolean;
}

const IDLE: CreateAssetDragState = { asset: null, overTarget: false };

let state: CreateAssetDragState = IDLE;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 快照。
 *
 * 返回的是模块级常量替换的引用，不是每次新建的对象——`useSyncExternalStore`
 * 要求快照在状态没变时保持同一个引用，否则会无限重渲染。
 */
function getSnapshot(): CreateAssetDragState {
  return state;
}

/** 拖拽开始。 */
export function beginCreateAssetDrag(asset: AssetItem): void {
  state = { asset, overTarget: false };
  emit();
}

/** 指针进出落点区。 */
export function setCreateAssetDragOverTarget(overTarget: boolean): void {
  if (state.asset === null || state.overTarget === overTarget) return;
  state = { asset: state.asset, overTarget };
  emit();
}

/** 拖拽结束（放下或取消）。 */
export function endCreateAssetDrag(): void {
  if (state.asset === null) return;
  state = IDLE;
  emit();
}

/** 订阅拖拽会话（落点用它决定要不要高亮）。 */
export function useCreateAssetDrag(): CreateAssetDragState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * 指针位置下的落点区；不在落点上返回 null。
 *
 * 命中测试从 `elementFromPoint` 的结果往上找祖先：指针停在参考条里的某张
 * 缩略图上时，命中的是缩略图本身，向上找才找得到挂着属性的落点外壳。
 */
export function findCreateDropZone(clientX: number, clientY: number): HTMLElement | null {
  const element = document.elementFromPoint(clientX, clientY);
  if (!(element instanceof HTMLElement)) return null;
  return element.closest<HTMLElement>(`[${CREATE_DROP_ZONE_ATTRIBUTE}]`);
}
