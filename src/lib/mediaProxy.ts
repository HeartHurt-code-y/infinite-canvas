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

function nativeProxyUrl(src: string | null, assetId: string): string {
  const base = convertFileSrc("video", MEDIA_PROXY_SCHEME);
  const query: string[] = [];
  if (src != null && src !== "") query.push(`src=${encodeURIComponent(src)}`);
  if (assetId !== "") query.push(`assetId=${encodeURIComponent(assetId)}`);
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
    const source = parsed.searchParams.get("src");
    return source ? nativeProxyUrl(source, assetId) : withAssetId(url, assetId);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return url;
  // Tauri local-file URLs and URLs already converted for this platform stay local.
  if (
    parsed.hostname === "asset.localhost" ||
    parsed.hostname === `${MEDIA_PROXY_SCHEME}.localhost`
  ) {
    return withAssetId(url, assetId);
  }
  return nativeProxyUrl(url, assetId);
}
