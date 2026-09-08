import { convertFileSrc } from "@tauri-apps/api/core";
import { isDesktopRuntime } from "./backend";

/** Must match the native media protocol. A proxy cannot refresh an expired signed URL. */
export const MEDIA_PROXY_SCHEME = "assetproxy";

/** Native HTTP loading avoids WebView CORS restrictions while preserving the source URL. */
export function toMediaProxyUrl(url: string | null | undefined): string | null {
  if (url == null || url === "") return null;
  if (!isDesktopRuntime()) return url;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.protocol === `${MEDIA_PROXY_SCHEME}:`) {
    const source = parsed.searchParams.get("src");
    return source
      ? `${convertFileSrc("video", MEDIA_PROXY_SCHEME)}?src=${encodeURIComponent(source)}`
      : url;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return url;
  // Tauri local-file URLs and URLs already converted for this platform stay local.
  if (
    parsed.hostname === "asset.localhost" ||
    parsed.hostname === `${MEDIA_PROXY_SCHEME}.localhost`
  ) {
    return url;
  }
  return `${convertFileSrc("video", MEDIA_PROXY_SCHEME)}?src=${encodeURIComponent(url)}`;
}
