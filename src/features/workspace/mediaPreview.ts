import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 视口懒挂载：节点滚出画布视口（含余量）时卸载 `<video>` 释放解码器。
 *
 * 不使用 IntersectionObserver 对照默认视口。React Flow 把节点放在
 * `transform: translate() scale()` 的视口层里，macOS WKWebView 对「变换祖先 + IO」
 * 会长期报不相交或来回翻转：素材封面空白，解码器反复创建则闪退。
 *
 * 改用 `getBoundingClientRect` 对照未变换的 `.canvas-viewport`：该 API 在 WebKit
 * 上会计入祖先 transform，和用户看见的位置一致。
 */
const LAZY_MOUNT_ROOT_MARGIN_PX = 512;
/** 离开视口后稍等再卸：避免平移/缩放过冲把正在看的视频摘掉。 */
const LEAVE_GRACE_MS = 420;
/** WKWebView 同时硬件解码的视频很少，超限会拖垮 GPU 进程（表现为画布闪退）。 */
const MAX_LIVE_MEDIA = 8;
const PANE_SELECTOR = ".canvas-viewport";
const VIEWPORT_SELECTOR = ".react-flow__viewport";

export interface NodeInViewOptions {
  /**
   * 候选菜单等已脱离画布变换的浮层：始终视为可见。
   * 它们的根不在 `.canvas-viewport` 内，不能拿画布几何去判相交。
   */
  readonly eager?: boolean;
  /**
   * 占用硬件视频解码器的观察者才计入并发上限；图片节点只按几何显隐，不占名额。
   */
  readonly heavy?: boolean;
}

interface VisibilityListener {
  readonly id: number;
  readonly element: HTMLElement;
  readonly eager: boolean;
  readonly heavy: boolean;
  readonly setInView: (value: boolean) => void;
}

const listeners = new Map<number, VisibilityListener>();
let nextListenerId = 1;
let debounceTimer: number | null = null;
let viewportObserver: MutationObserver | null = null;
let watchedViewport: Element | null = null;
let windowListening = false;

function paneElement(): Element | null {
  return document.querySelector(PANE_SELECTOR);
}

function zeroRect(rect: DOMRectReadOnly): boolean {
  return rect.width === 0 && rect.height === 0;
}

function nearPane(element: Element, pane: DOMRectReadOnly, margin: number): boolean {
  const box = element.getBoundingClientRect();
  // 尚未布局（0×0）时不要卸媒体：jsdom、首帧、以及无 src 的 video 都是这种情况。
  // 真正滚出视口的节点有 React Flow 给的非零盒子。
  if (zeroRect(box)) return true;
  return (
    box.right >= pane.left - margin &&
    box.left <= pane.right + margin &&
    box.bottom >= pane.top - margin &&
    box.top <= pane.bottom + margin
  );
}

function distanceToPaneCenter(element: Element, pane: DOMRectReadOnly): number {
  const box = element.getBoundingClientRect();
  const cx = (box.left + box.right) / 2;
  const cy = (box.top + box.bottom) / 2;
  const px = (pane.left + pane.right) / 2;
  const py = (pane.top + pane.bottom) / 2;
  const dx = cx - px;
  const dy = cy - py;
  return dx * dx + dy * dy;
}

function watchViewportTransform(): void {
  const viewport = document.querySelector(VIEWPORT_SELECTOR);
  if (viewport === watchedViewport) return;
  viewportObserver?.disconnect();
  viewportObserver = null;
  watchedViewport = viewport;
  if (viewport == null || typeof MutationObserver === "undefined") return;
  viewportObserver = new MutationObserver(scheduleVisibilityRecompute);
  viewportObserver.observe(viewport, { attributes: true, attributeFilter: ["style", "class"] });
}

function ensureWindowListening(): void {
  if (windowListening || typeof window === "undefined") return;
  windowListening = true;
  window.addEventListener("resize", scheduleVisibilityRecompute);
}

function tearDownIfIdle(): void {
  if (listeners.size > 0) return;
  if (debounceTimer != null) {
    window.clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  viewportObserver?.disconnect();
  viewportObserver = null;
  watchedViewport = null;
  if (windowListening) {
    window.removeEventListener("resize", scheduleVisibilityRecompute);
    windowListening = false;
  }
}

function recomputeVisibility(): void {
  watchViewportTransform();
  const pane = paneElement();
  const paneBox = pane?.getBoundingClientRect() ?? null;
  const ranked: Array<{ listener: VisibilityListener; dist: number }> = [];

  for (const listener of listeners.values()) {
    if (listener.eager || paneBox == null) {
      listener.setInView(true);
      continue;
    }
    const live = nearPane(listener.element, paneBox, LAZY_MOUNT_ROOT_MARGIN_PX);
    if (!live) {
      listener.setInView(false);
      continue;
    }
    if (!listener.heavy) {
      listener.setInView(true);
      continue;
    }
    ranked.push({
      listener,
      dist: distanceToPaneCenter(listener.element, paneBox),
    });
  }

  ranked.sort((left, right) => left.dist - right.dist);
  ranked.forEach((item, index) => {
    item.listener.setInView(index < MAX_LIVE_MEDIA);
  });
}

function scheduleVisibilityRecompute(): void {
  if (typeof window === "undefined") {
    recomputeVisibility();
    return;
  }
  if (debounceTimer != null) return;
  debounceTimer = window.setTimeout(() => {
    debounceTimer = null;
    recomputeVisibility();
  }, 48);
}

function registerListener(listener: VisibilityListener): void {
  listeners.set(listener.id, listener);
  ensureWindowListening();
  recomputeVisibility();
}

function unregisterListener(id: number): void {
  listeners.delete(id);
  if (listeners.size === 0) tearDownIfIdle();
  else scheduleVisibilityRecompute();
}

/**
 * 节点是否落在画布可见区域（含余量）。回调 ref：媒体区可能晚于卡片出现。
 */
export function useNodeInView<T extends HTMLElement>(
  options?: NodeInViewOptions,
): {
  readonly containerRef: (element: T | null) => void;
  readonly inView: boolean;
} {
  const eager = options?.eager === true;
  const heavy = options?.heavy === true;
  const heavyRef = useRef(heavy);
  // 不在画布里（对话框、测试、浮层）时没有 `.canvas-viewport`，默认可见，避免首帧空白。
  const [inView, setInView] = useState(
    () => eager || document.querySelector(PANE_SELECTOR) == null,
  );
  const listenerIdRef = useRef<number | null>(null);
  const leaveTimerRef = useRef<number | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const eagerRef = useRef(eager);
  useEffect(() => {
    heavyRef.current = heavy;
    eagerRef.current = eager;
  }, [eager, heavy]);

  const publish = useCallback((next: boolean) => {
    if (eagerRef.current || next) {
      if (leaveTimerRef.current != null) {
        window.clearTimeout(leaveTimerRef.current);
        leaveTimerRef.current = null;
      }
      setInView(true);
      return;
    }
    if (leaveTimerRef.current != null) return;
    leaveTimerRef.current = window.setTimeout(() => {
      leaveTimerRef.current = null;
      setInView(false);
    }, LEAVE_GRACE_MS);
  }, []);

  const containerRef = useCallback(
    (element: T | null) => {
      if (listenerIdRef.current != null) {
        unregisterListener(listenerIdRef.current);
        listenerIdRef.current = null;
      }
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      if (leaveTimerRef.current != null) {
        window.clearTimeout(leaveTimerRef.current);
        leaveTimerRef.current = null;
      }
      if (element == null) {
        if (eagerRef.current) setInView(true);
        return;
      }
      const id = nextListenerId;
      nextListenerId += 1;
      listenerIdRef.current = id;
      registerListener({
        id,
        element,
        eager: eagerRef.current,
        heavy: heavyRef.current,
        setInView: publish,
      });
      if (typeof ResizeObserver !== "undefined") {
        const observer = new ResizeObserver(scheduleVisibilityRecompute);
        observer.observe(element);
        resizeObserverRef.current = observer;
      }
    },
    [publish],
  );

  useEffect(
    () => () => {
      if (listenerIdRef.current != null) unregisterListener(listenerIdRef.current);
      listenerIdRef.current = null;
      resizeObserverRef.current?.disconnect();
      if (leaveTimerRef.current != null) window.clearTimeout(leaveTimerRef.current);
    },
    [],
  );

  return { containerRef, inView };
}

/** 测试用：立刻重算可见性（跳过防抖）。 */
export function flushCanvasMediaVisibility(): void {
  if (debounceTimer != null) {
    window.clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  recomputeVisibility();
}

/** 按“视频”处理的后缀；媒体代理地址与本地 asset:// 路径都会先解出真实地址再判断。 */
const VIDEO_FILE_EXTENSIONS = [
  ".mp4",
  ".m4v",
  ".mov",
  ".webm",
  ".mkv",
  ".avi",
  ".wmv",
  ".flv",
  ".m3u8",
] as const;

function decodeOnce(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * 判断媒体地址是否指向视频本体。参考素材的预览地址既可能是视频（本地产物、云端视频、
 * 媒体代理 `?src=` 参数），也可能是封面图；缩略图据此决定取中间帧还是直接加载图片。
 */
export function isVideoSourceUrl(url: string | null | undefined): boolean {
  if (url == null || url === "") return false;
  let candidate = url;
  try {
    candidate = new URL(url).searchParams.get("src") ?? url;
  } catch {
    // 非绝对地址（浏览器预览下的相对路径）按原样判断。
  }
  const path = (decodeOnce(candidate).split(/[?#]/)[0] ?? "").toLowerCase();
  return VIDEO_FILE_EXTENSIONS.some((extension) => path.endsWith(extension));
}
