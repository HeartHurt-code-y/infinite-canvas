import { useState, type CSSProperties, type ReactNode } from "react";

import { toMediaProxyUrl } from "../../lib/mediaProxy";
import { useNodeInView } from "./mediaPreview";

/** 视频中间帧封面的公共样式类：帧就绪前保持透明，露出底下由调用方提供的占位内容。 */
const VIDEO_FRAME_CLASS = "media-frame-video";
const VIDEO_FRAME_READY_CLASS = "is-frame-ready";

/**
 * 视频中间帧封面：读取元数据后 seek 到中点并暂停，把中间帧当作静止缩略图。
 * - 不经过画布抽帧，因此不受 WebView 跨域限制（与素材卡片、画布素材节点同一做法）；
 * - 通过 `onAspectRatioChange` 上报原始宽高比，调用方据此按比例自适应宽度，完整显示不裁剪；
 * - 滚出视口时摘掉 `src` 释放解码器，滚回后重新抽帧。
 * - 可见性观察的是定尺寸外壳，而不是 `<video>` 本身：WebKit 上无 src 的 video 盒子经常是 0，
 *   观察它会形成「不相交 → 永不挂 src」的死锁。
 * - seek 可能永不回调（本地 asset 协议、缺索引的 mp4）：`loadeddata` 时揭开已有帧，
 *   与画布产物卡片同一兜底，避免封面永远透明。
 */
export function VideoMiddleFrame({
  src,
  placeholder,
  objectFit = "contain",
  eager = false,
  onAspectRatioChange,
  onLoadError,
}: {
  readonly src: string;
  /** 中间帧就绪前盖在视频上的占位内容（类型图标等）。 */
  readonly placeholder?: ReactNode;
  readonly objectFit?: CSSProperties["objectFit"];
  /**
   * 已脱离画布变换的浮层（@ 候选菜单等）必须紧急挂载：外壳不在 `.canvas-viewport` 内，
   * 按画布几何会永远判不可见。
   */
  readonly eager?: boolean;
  readonly onAspectRatioChange?: (aspectRatio: number) => void;
  /** 视频不可读（签名过期、编码不支持等）：调用方回退为类型图标。 */
  readonly onLoadError?: () => void;
}) {
  const { containerRef, inView } = useNodeInView<HTMLSpanElement>({
    eager,
  });
  const [readyKey, setReadyKey] = useState<string | null>(null);
  const proxiedSrc = toMediaProxyUrl(src) ?? src;
  // 换源或滚出视口都会丢失已定位的帧：把就绪标记绑定在“当前源 + 可见性”上自动失效。
  const frameKey = `${proxiedSrc}|${inView}`;
  const frameReady = readyKey === frameKey;

  return (
    <span ref={containerRef} className="media-frame-host">
      {frameReady ? null : placeholder}
      <video
        className={`${VIDEO_FRAME_CLASS}${frameReady ? ` ${VIDEO_FRAME_READY_CLASS}` : ""}`}
        style={{ objectFit }}
        src={inView ? proxiedSrc : undefined}
        muted
        playsInline
        preload="metadata"
        draggable={false}
        aria-hidden="true"
        tabIndex={-1}
        onLoadedMetadata={(event) => {
          const video = event.currentTarget;
          if (video.videoWidth > 0 && video.videoHeight > 0) {
            onAspectRatioChange?.(video.videoWidth / video.videoHeight);
          }
          if (Number.isFinite(video.duration) && video.duration > 0) {
            video.currentTime = video.duration / 2;
            return;
          }
          // 时长不可用时（直播流等）退回首帧，避免永久停留在占位态。
          setReadyKey(frameKey);
        }}
        onSeeked={() => setReadyKey(frameKey)}
        onLoadedData={() => setReadyKey(frameKey)}
        onError={() => onLoadError?.()}
      />
    </span>
  );
}
