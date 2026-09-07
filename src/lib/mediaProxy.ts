/**
 * 媒体代理 URL 工具：把云端 TOS 临时签名 URL 转换为同源的 `assetproxy://` URL，
 * 避免签名过期（2 小时）导致视频预览不可用，同时规避跨域 canvas 污染问题。
 *
 * 仅用于前端 `<video>` / `<audio>` 标签的 src；后端下载、抽帧、合成等场景
 * 仍需使用原始 TOS 签名 URL（后端能直接访问公网 URL）。
 */

/** 自定义协议 scheme，与 Rust 端 `media_proxy::MEDIA_PROXY_SCHEME` 保持一致。 */
export const MEDIA_PROXY_SCHEME = "assetproxy";

/**
 * 判断 URL 是否需要走代理。
 * 仅对云端临时签名 URL 走代理（会过期，如火山引擎 TOS 签名 URL）；
 * 普通 CDN URL、API 代理 URL、本地 asset URL 保持原样。
 */
function needsProxy(url: string): boolean {
  if (url.startsWith(`${MEDIA_PROXY_SCHEME}://`)) return false;
  if (url.startsWith("asset://")) return false;
  if (!url.startsWith("http://") && !url.startsWith("https://")) return false;
  // 火山引擎 TOS 签名 URL 特征：域名含 tos-cn-，或查询参数含 X-Tos-Signature。
  if (url.includes("tos-cn-")) return true;
  if (url.includes("X-Tos-Signature")) return true;
  // konjac.ai 素材 content 代理 URL 不会过期，不需要走代理。
  if (url.includes("/assets/content/")) return false;
  return false;
}

/**
 * 把视频 URL 转换为媒体代理 URL。
 * - 已经是代理 URL / 本地 asset URL：原样返回
 * - http/https URL：编码为 `assetproxy://video?src=<encoded>`
 * - 其他（空值、data URL 等）：原样返回
 */
export function toMediaProxyUrl(url: string | null | undefined): string | null {
  if (url == null || url === "") return null;
  if (!needsProxy(url)) return url;
  const encoded = encodeURIComponent(url);
  return `${MEDIA_PROXY_SCHEME}://video?src=${encoded}`;
}
