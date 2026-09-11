import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 视口懒挂载：节点滚出画布视口（含 512px 余量）时卸载 `<video>` 释放解码器，
 * 滚回时重新挂载。React Flow 渲染所有节点，几十个视频节点常驻会让解码器与
 * 缓冲内存线性增长；IntersectionObserver（兼容 React Flow 的 transform 视口）按
 * 实际可见性驱动挂载。IO 不可用（测试环境）时视为可见，保持原行为。
 */
const LAZY_MOUNT_ROOT_MARGIN_PX = 512;

export function useNodeInView<T extends HTMLElement>(): {
  /**
   * 回调 ref（不是 ref 对象）：被观察的元素可能晚于卡片首次挂载才出现 —— 生成产物卡片先以
   * 无媒体的占位形态落卡（任务进行中），结果返回后才在原地渲染媒体区。用 ref 对象配合
   * 空依赖 effect 时，effect 首轮读到的 `current` 是 null，observer 永远建不起来，
   * `inView` 卡在初始 false，卡片就只剩灰底懒挂载占位、没有任何预览。
   */
  readonly containerRef: (element: T | null) => void;
  readonly inView: boolean;
} {
  // IO 不可用（测试环境）时恒为可见，保持原行为；否则由 IO 按实际可见性驱动挂载。
  const [inView, setInView] = useState(() => typeof IntersectionObserver === "undefined");
  const observerRef = useRef<IntersectionObserver | null>(null);
  const containerRef = useCallback((element: T | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (element == null || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) setInView(entry.isIntersecting);
      },
      { rootMargin: `${LAZY_MOUNT_ROOT_MARGIN_PX}px` },
    );
    observer.observe(element);
    observerRef.current = observer;
  }, []);
  useEffect(() => () => observerRef.current?.disconnect(), []);
  return { containerRef, inView };
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
