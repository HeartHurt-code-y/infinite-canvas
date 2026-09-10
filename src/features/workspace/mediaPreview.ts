import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * 视口懒挂载：节点滚出画布视口（含 512px 余量）时卸载 `<video>` 释放解码器，
 * 滚回时重新挂载。React Flow 渲染所有节点，几十个视频节点常驻会让解码器与
 * 缓冲内存线性增长；IntersectionObserver（兼容 React Flow 的 transform 视口）按
 * 实际可见性驱动挂载。IO 不可用（测试环境）时视为可见，保持原行为。
 */
const LAZY_MOUNT_ROOT_MARGIN_PX = 512;

export function useNodeInView<T extends HTMLElement>(): {
  readonly containerRef: RefObject<T | null>;
  readonly inView: boolean;
} {
  const containerRef = useRef<T | null>(null);
  // IO 不可用（测试环境）时恒为可见，保持原行为；否则由 IO 按实际可见性驱动挂载。
  const [inView, setInView] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const element = containerRef.current;
    if (element == null || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) setInView(entry.isIntersecting);
      },
      { rootMargin: `${LAZY_MOUNT_ROOT_MARGIN_PX}px` },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
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
