import { useId } from "react";
import catalog from "../../../shared/libtv-media-icons.json";
import type { CanvasVideoMode } from "../../lib/canvasVideoMode";

export type LibTVMediaIconName = keyof typeof catalog.icons;

/** 原站 Iconify 的 libtv 图标数据与 viewBox；随应用内置，不加载账户或远程脚本。 */
export function LibTVMediaIcon({ name, size = 16, className }: {
  readonly name: LibTVMediaIconName;
  readonly size?: number;
  readonly className?: string;
}) {
  const icon = catalog.icons[name];
  return <svg aria-hidden="true" focusable="false" data-icon={"libtv:" + name}
    width={size} height={size} viewBox={`0 0 ${icon.width} ${icon.height}`}
    className={className} style={{ flexShrink: 0, pointerEvents: "none" }}
    dangerouslySetInnerHTML={{ __html: icon.body }} />;
}

/** 公开模块 469850 的模式 → 图标映射。 */
export function videoModeIcon(mode: CanvasVideoMode): LibTVMediaIconName {
  switch (mode) {
    case "first_frame": return "mode-single-image2video";
    case "first_last_frame": return "mode-frames2video";
    case "image_reference": return "mode-image2video";
    case "reference": return "mode-mixed2video";
    case "video_reference": case "extend": return "video-gen";
    case "audio_reference": return "audio";
    case "edit": return "mode-video-edit2video";
    case "longVideo2video": return "mode-long-video2video";
    default: return "mode-text2video";
  }
}

export function mediaAspectRatioIcon(summary: string, fallback: LibTVMediaIconName = "generation-setting-ratio-16-9"): LibTVMediaIconName {
  const ratio = summary.match(/\b(\d+):(\d+)\b/);
  const key = ratio ? "generation-setting-ratio-" + ratio[1] + "-" + ratio[2] : "generation-setting-ratio-16-9";
  return ratio && Object.hasOwn(catalog.icons, key) ? key as LibTVMediaIconName : fallback;
}

/** 原站 module 584835 的预览占位组件；每个实例独立引用遮罩和渐变。 */
export function LibTVCameraPreviewEmpty() {
  const id = useId();
  const maskId = id + "-mask";
  const gradientId = id + "-gradient";
  return <svg width="56" height="56" fill="none" viewBox="0 0 56 56" aria-hidden="true" focusable="false">
    <path fill="#525252" d="M12.923 9.692c0-1.19.964-2.154 2.154-2.154h20.377c.571 0 1.12.227 1.523.631l2.87 2.87 3.7 3.815c.389.402.607.94.607 1.5v20.8c0 1.19-.964 2.154-2.154 2.154H15.077a2.154 2.154 0 0 1-2.154-2.154z" />
    <mask id={maskId} width="33" height="33" x="12" y="7" maskUnits="userSpaceOnUse" style={{ maskType: "alpha" }}><path fill="#29313A" d="M12.923 9.692c0-1.19.964-2.154 2.154-2.154h20.377c.571 0 1.12.227 1.523.631l2.87 2.87 3.7 3.815c.389.402.607.94.607 1.5v20.8c0 1.19-.964 2.154-2.154 2.154H15.077a2.154 2.154 0 0 1-2.154-2.154z" /></mask>
    <g mask={"url(#" + maskId + ")"}><path fill="#363636" d="M35.539 14V5.923l9.961 10.23h-7.808A2.154 2.154 0 0 1 35.538 14" /></g>
    <path fill={"url(#" + gradientId + ")"} fillOpacity=".8" d="M6.588 20.581a2.154 2.154 0 0 1 2.15-2.273h13.264c.736 0 1.44.3 1.947.833l3.586 3.756a4.3 4.3 0 0 0 3.116 1.334h17.655a2.154 2.154 0 0 1 2.149 2.303L49.14 45.382a2.154 2.154 0 0 1-2.149 2.004H10.114a2.154 2.154 0 0 1-2.15-2.035z" />
    <path stroke="#C4C4C4" strokeWidth=".215" d="M8.738 18.415h13.264c.706 0 1.382.29 1.87.8l3.585 3.757a4.42 4.42 0 0 0 3.194 1.367h17.655a2.046 2.046 0 0 1 2.041 2.188l-1.314 18.846a2.047 2.047 0 0 1-2.042 1.903H10.115a2.046 2.046 0 0 1-2.043-1.932L6.695 20.575a2.047 2.047 0 0 1 2.043-2.16Z" />
    <rect width="5.385" height="2.154" x="41.462" y="28" fill="#fff" rx=".538" />
    <defs><radialGradient id={gradientId} cx="0" cy="0" r="1" gradientTransform="rotate(89.542 5.038 24.619)scale(33.6549 34.3164)" gradientUnits="userSpaceOnUse"><stop stopColor="#CDDAEB" /><stop offset="1" stopColor="#fff" /></radialGradient></defs>
  </svg>;
}
