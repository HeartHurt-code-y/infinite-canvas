import { useEffect, useRef, useState } from "react";

import { toMediaProxyUrl } from "../../lib/mediaProxy";
import type { AssetKind } from "./workspaceModel";

/**
 * 素材预览的会话内字节缓存。
 *
 * 预览地址（对象存储预签名地址、供应商签名地址）会随时间变化，但素材内容不会：
 * 缓存按「素材身份 + 用途」记账，同一份素材在一个会话里只下载一次，之后切换画布、
 * 重开素材库面板、节点滚出视口再滚回来都直接复用已下载的字节。
 *
 * 跨重启那一层由后端媒体代理的磁盘缓存承担（`assetproxy` 协议按同一身份复用本地副本），
 * 本模块只负责会话内的即时性与失败回落：远端暂时取不到（签名过期、断网、上游报错）时，
 * 已经缓存过的字节继续渲染，不再把素材显示成「预览不可用」。
 *
 * 视频正文不进本缓存：视频按 Range 分块播放，把整段视频读进内存换不来秒开，
 * 只会让内存随时长线性增长。视频的封面/关键帧是图片，照常走这里。
 */

/** 一份素材预览内容的稳定身份：素材身份 + 用途（图片正文 / 视频封面）。 */
export interface AssetMediaIdentity {
  readonly assetId: string;
  readonly kind: AssetKind;
}

interface CachedMediaBytes {
  readonly objectUrl: string;
  readonly byteSize: number;
}

/** 已下载字节：key = 素材身份+用途。 */
const cachedBytes = new Map<string, CachedMediaBytes>();
/** 在途下载：同一素材的并发请求共用同一个 Promise。 */
const inFlight = new Map<string, Promise<string | null>>();
/** 已签发的 object URL，仅在显式清空时回收。 */
const objectUrls = new Set<string>();

function keyOf(assetId: string, kind: AssetKind): string {
  return `${assetId}:${kind}`;
}

/** 从素材条目取缓存身份；缺 ID 的占位条目返回 null（调用方保持原样渲染）。 */
export function assetMediaByteIdentity(asset: {
  readonly id: string;
  readonly kind: AssetKind;
}): AssetMediaIdentity | null {
  return asset.id === "" ? null : { assetId: asset.id, kind: asset.kind };
}

/** 是否值得缓存：只有图片正文与视频封面这类图片内容；视频正文不缓存。 */
function isCacheableKind(kind: AssetKind): boolean {
  return kind === "image" || kind === "video";
}

function isVideoMediaPath(mediaUrl: string): boolean {
  const withoutQuery = (mediaUrl.split(/[?#]/)[0] ?? "").toLowerCase();
  return /\.(mp4|m4v|mov|webm|mkv|avi|wmv|flv|m3u8)$/.test(withoutQuery);
}

/**
 * 读取素材预览字节。命中缓存时不再发起任何请求；失败返回 null 并保持无缓存状态
 * （不做负缓存：续签出的新地址必须还能重新下载）。
 */
export async function loadMediaBytes(
  assetId: string,
  kind: AssetKind,
  mediaUrl: string | null | undefined,
): Promise<string | null> {
  if (assetId === "" || mediaUrl == null || mediaUrl === "") return null;
  if (!isCacheableKind(kind)) return null;
  // 视频节点：地址指向视频本体时只服务播放，不进字节缓存。
  if (kind === "video" && isVideoMediaPath(mediaUrl)) return null;

  const key = keyOf(assetId, kind);
  const cached = cachedBytes.get(key);
  if (cached != null) return cached.objectUrl;

  const pending = inFlight.get(key);
  if (pending != null) return pending;

  const request = (async (): Promise<string | null> => {
    try {
      const response = await fetch(toMediaProxyUrl(mediaUrl) ?? mediaUrl, {
        // 素材身份已经决定复用，这里不再让 WebView 做二次校验；凭据绝不外发给对象存储。
        cache: "force-cache",
        credentials: "omit",
      });
      if (!response.ok) return null;
      const blob = await response.blob();
      if (blob.size === 0) return null;
      const objectUrl = URL.createObjectURL(blob);
      objectUrls.add(objectUrl);
      cachedBytes.set(key, { objectUrl, byteSize: blob.size });
      return objectUrl;
    } catch {
      return null;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, request);
  return request;
}

/** 缓存身份的同步查询：渲染期据此优先用本地字节，不发起任何请求。 */
export function getMediaByteUrl(assetId: string, kind: AssetKind): string | null {
  if (assetId === "") return null;
  return cachedBytes.get(keyOf(assetId, kind))?.objectUrl ?? null;
}

/**
 * 释放全部已缓存字节。生产只在应用卸载时调用；object URL 只在显式清空时回收，
 * 因为缓存条目被替换时旧地址可能仍挂在某个已渲染的 `<img>` 上。
 */
export function clearMediaByteCache(): void {
  for (const objectUrl of objectUrls) URL.revokeObjectURL(objectUrl);
  objectUrls.clear();
  cachedBytes.clear();
  inFlight.clear();
}

let unloadListenerBound = false;

/** 应用卸载时释放 object URL；只绑定一次，模块级副作用收敛在这里。 */
function watchMediaByteCacheLifecycle(): void {
  if (unloadListenerBound || typeof window === "undefined") return;
  unloadListenerBound = true;
  window.addEventListener("beforeunload", () => clearMediaByteCache());
}

watchMediaByteCacheLifecycle();

export interface MediaByteSource {
  /** 实际应渲染的地址：本地字节优先，未缓存时就是传入的远端地址。 */
  readonly url: string | null;
  /** 当前是否用的本地缓存字节。 */
  readonly fromCache: boolean;
  /**
   * 当前渲染的地址加载失败时调用，按来源决定重试方向：
   * - 用的本地字节（副本损坏、object URL 失效）→ 丢弃该副本并从远端重新下载一次；
   * - 用的远端地址（签名过期、网络不可达）→ 先在本地字节里找一次，命中即继续渲染。
   * 每个素材的每个来源最多重试一次，不会形成重试循环。
   */
  readonly retry: () => void;
}

/**
 * 把一个素材预览地址解析成本地可渲染地址：
 * - 已缓存过该素材时渲染期直接返回本地地址，不发请求，也不受签名过期影响；
 * - 未缓存时先渲染远端地址（画面不等人），后台下载字节，成功后换成稳定地址；
 * - 下载失败保持远端地址，调用方原有的续签自愈路径不受影响。
 */
export function useMediaByteSource(
  assetId: string,
  kind: AssetKind,
  mediaUrl: string | null | undefined,
): MediaByteSource {
  const { objectUrl, blockedObjectUrl, retryFromBytes, retryFromRemote } = useCachedBytes(
    assetId,
    kind,
    mediaUrl,
  );
  const remoteUrl = toMediaProxyUrl(mediaUrl) ?? mediaUrl ?? null;
  const usableObjectUrl = objectUrl != null && objectUrl !== blockedObjectUrl ? objectUrl : null;
  return {
    url: usableObjectUrl ?? remoteUrl,
    fromCache: usableObjectUrl != null,
    retry: usableObjectUrl != null ? retryFromRemote : retryFromBytes,
  };
}

/**
 * 缓存字节的取用与刷新。
 *
 * 下载落定（无论成功失败）都只写一次 `loadedUrl`：同值更新会被 React 跳过，因此失败路径
 * 不会形成循环，而成功路径会让组件立刻切到本地副本，不必等下一个不相干的 state 变化。
 */
function useCachedBytes(
  assetId: string,
  kind: AssetKind,
  mediaUrl: string | null | undefined,
): {
  readonly objectUrl: string | null;
  readonly blockedObjectUrl: string | null;
  readonly retryFromRemote: () => void;
  readonly retryFromBytes: () => void;
} {
  const [blockedObjectUrl, setBlockedObjectUrl] = useState<string | null>(null);
  // 下载落定后必须让组件重渲染一次，否则这一次渲染读到的仍是远端地址，
  // 本地副本要等到下一个不相干的 state 变化才生效（等价于白下载一次）。
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const retriedRef = useRef<Set<string>>(new Set());
  const objectUrl = getMediaByteUrl(assetId, kind);
  const requestedUrl = objectUrl ?? mediaUrl ?? null;

  useEffect(() => {
    if (assetId === "" || mediaUrl == null || mediaUrl === "") return;
    // 已经缓存过这份素材：不再请求，直接用本地字节。
    if (getMediaByteUrl(assetId, kind) != null) return;
    let cancelled = false;
    void loadMediaBytes(assetId, kind, mediaUrl).then((url) => {
      if (cancelled) return;
      // 同值时 React 会跳过更新，因此失败路径（url 为 null）不会形成循环。
      setLoadedUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [assetId, kind, mediaUrl, retryToken]);
  const retryOnce = (token: string, apply: () => void) => {
    if (retriedRef.current.has(token)) return;
    retriedRef.current.add(token);
    apply();
    setRetryToken((value) => value + 1);
  };

  return {
    objectUrl,
    blockedObjectUrl,
    // 本地副本渲染失败：屏蔽这份副本并重新触发一次下载。
    retryFromRemote: () =>
      retryOnce(`remote:${objectUrl ?? loadedUrl ?? "none"}`, () => setBlockedObjectUrl(objectUrl)),
    // 远端地址渲染失败：允许再从本地字节里取一次 —— 后端代理的磁盘缓存可能已经有
    // 这份素材（重启前下载过、或另一个渲染路径刚下载完），命中就继续渲染。
    retryFromBytes: () => retryOnce(`bytes:${requestedUrl ?? "none"}`, () => undefined),
  };
}
