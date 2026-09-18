import { convertFileSrc } from "@tauri-apps/api/core";
import { isDesktopRuntime } from "./backend";

/** Must match the native media protocol. A proxy cannot refresh an expired signed URL. */
export const MEDIA_PROXY_SCHEME = "assetproxy";

/** Optional identity carried on proxy URLs so native fallback can use the imported file. */
export interface MediaProxyIdentity {
  readonly assetId?: string | null;
}

function normalizedAssetId(identity?: MediaProxyIdentity): string {
  const raw = identity?.assetId?.trim() ?? "";
  if (raw === "") return "";
  return raw.replace(/^asset:\/\//i, "").trim();
}

/** 短修订号：换签名后强制 WebView 重新请求，完整地址不进查询串。 */
function sourceRevision(src: string): string {
  let hash = 2166136261;
  for (let i = 0; i < src.length; i += 1) {
    hash ^= src.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${src.length.toString(36)}${(hash >>> 0).toString(36)}`;
}

function nativeProxyUrl(src: string | null, assetId: string): string {
  // 素材身份放进路径，不要放进查询串。Windows WebView 对自定义协议经常丢掉或截断
  // query：只带 `?assetId=` 时原生侧收不到身份，登记表形同虚设，整页预览 400。
  const path = assetId !== "" ? assetId : "video";
  const base = convertFileSrc(path, MEDIA_PROXY_SCHEME);
  const query: string[] = [];
  if (assetId === "") {
    if (src != null && src !== "") query.push(`src=${encodeURIComponent(src)}`);
  } else if (src != null && src !== "") {
    query.push(`v=${sourceRevision(src)}`);
  }
  return query.length > 0 ? `${base}?${query.join("&")}` : base;
}

function withAssetId(url: string, assetId: string): string {
  if (assetId === "" || /(?:\?|&)assetId=/.test(url)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}assetId=${encodeURIComponent(assetId)}`;
}

/**
 * Native HTTP loading avoids WebView CORS restrictions while preserving the source URL.
 *
 * `assetId` is attached so the protocol handler can serve the file that was imported for
 * that cloud asset when the supplier URL is missing, rewritten, or already deleted.
 */
export function toMediaProxyUrl(
  url: string | null | undefined,
  identity?: MediaProxyIdentity,
): string | null {
  const assetId = normalizedAssetId(identity);
  if (url == null || url === "") {
    if (!isDesktopRuntime() || assetId === "") return null;
    return nativeProxyUrl(null, assetId);
  }
  if (!isDesktopRuntime()) return url;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.protocol === `${MEDIA_PROXY_SCHEME}:`) {
    if (assetId !== "") return nativeProxyUrl(parsed.searchParams.get("src"), assetId);
    const source = parsed.searchParams.get("src");
    return source ? nativeProxyUrl(source, "") : url;
  }
  if (parsed.hostname === "asset.localhost") {
    return withAssetId(url, assetId);
  }
  if (parsed.hostname === `${MEDIA_PROXY_SCHEME}.localhost`) {
    if (assetId !== "") {
      return nativeProxyUrl(parsed.searchParams.get("src"), assetId);
    }
    return url;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return url;
  return nativeProxyUrl(url, assetId);
}
