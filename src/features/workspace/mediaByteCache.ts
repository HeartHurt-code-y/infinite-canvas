import { useEffect, useRef, useState } from "react";

import { toMediaProxyUrl, type MediaProxyIdentity } from "../../lib/mediaProxy";
import type { MediaType } from "../../lib/backend";

/**
 * 图片正文按素材身份走代理（长签名不进 WebView）。
 * 视频封面 / 视频正文与登记的 preview_url 不是同一条渲染路径：封面继续把地址放进 `src`。
 */
function proxyIdentity(assetId: string, kind: MediaType): MediaProxyIdentity | undefined {
  if (assetId === "" || kind === "video") return undefined;
  return { assetId };
}

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
 *
 * 大图（声明长度超过 `MAX_BLOB_BYTES`）同样不进本缓存：几十 MB 的原图整包读进内存
 * 只会与 `<img>` 抢带宽、多占一份内存，直连渲染反而更快。
 *
 * 缓存有**总量预算**（`MAX_TOTAL_CACHE_BYTES`）：卡片一挂载就把字节读进内存，
 * 翻页、关面板、滚出视口都不清理，没有上限时内存随「看过的素材数」线性增长
 * （素材库一页 40 张，单张上限 8MB，一页就上百 MB），WebView 最终会被系统杀掉。
 * 超预算时按 LRU 淘汰；淘汰必须保证「正在显示的画面不会裂掉」，靠两件事：
 * - **引用计数**：每个正在渲染这份字节的消费者（挂载中的 `<img>`）持有一份引用，
 *   卸载时归还；只有引用数为 0 的条目才允许被淘汰。
 * - **延迟回收**：被淘汰的条目不立刻 `URL.revokeObjectURL`，而是等一段宽限期 ——
 *   旧地址可能还挂在某个已渲染的 `<img>` 上（组件刚卸载，或「渲染 → effect」之间的
 *   一次淘汰），立刻 revoke 会让画面裂开；宽限期内若有人重新取用这份地址，回收取消。
 */

/** 一份素材预览内容的稳定身份：素材身份 + 用途（图片正文 / 视频封面）。 */
export interface AssetMediaIdentity {
  readonly assetId: string;
  readonly kind: MediaType;
}

/**
 * 整包读进内存的体积上限：超过它的响应不再读成 Blob。
 *
 * 手机原图可以到几十 MB（例如 5464×7285 的 36 MB JPEG）。这类图读成 Blob 要再占一份
 * 内存、再多搬一次，而 `<img>` 直接指向代理地址时本来就是边下边解码；更要紧的是
 * 字节缓存与 `<img>` 会同时各下一份，几十 MB 互相抢带宽，两边都更容易失败。
 * 超限的素材因此只走「直连渲染」：一条 `<img>` 请求，正文不进本缓存（跨次复用交给
 * 后端媒体代理的磁盘缓存）。
 */
const MAX_BLOB_BYTES = 8 * 1024 * 1024;

/**
 * 缓存总量预算：所有活跃条目（尚未被淘汰）的字节之和的上限。
 *
 * 口径与 `MAX_BLOB_BYTES` 一致（都是 MiB，记账用的都是 `blob.size` 的字节数）。
 * 128MB 大约放得下 16 张满尺寸的 8MB 原图，或者上千张常规缩略图。
 * 取这个量级是因为素材库一页 40 张、每张卡片都会把字节读进内存；
 * 不设上限时翻几页就能把 WebView 的内存推到系统杀进程。
 */
const MAX_TOTAL_CACHE_BYTES = 128 * 1024 * 1024;

/**
 * 淘汰后延迟回收 object URL 的宽限期（毫秒）。
 *
 * 取 5 秒：够覆盖「组件卸载 → `<img>` 真正从文档里摘掉」与「渲染完成 → effect
 * 取得引用」这两个窗口，又不至于让已淘汰的字节长时间占着内存。
 */
const REVOKE_GRACE_MS = 5_000;

/** 已判定「太大，只直连渲染」的素材身份：同一会话内不再重复探测体积。 */
const directOnlyIdentities = new Set<string>();

/**
 * 一份已下载的预览字节。
 *
 * `refCount` 是**活跃消费者数**：每个正在渲染这份地址的组件各持一份引用，
 * 卸载时归还。引用数为 0 的条目才允许被预算淘汰 —— 还在显示中的画面不能被淘汰掉。
 * `lastUsedAt` 是 LRU 依据（单调递增序号，不用挂钟时间，免得同毫秒并列）。
 */
interface CachedMediaBytes {
  /** 缓存身份：素材身份+用途。 */
  readonly key: string;
  readonly objectUrl: string;
  readonly byteSize: number;
  /** 活跃消费者数（挂载中的消费者各持一份）。 */
  refCount: number;
  /** 最近一次被取用的序号，用于 LRU 淘汰排序。 */
  lastUsedAt: number;
  /** 是否已被淘汰（已从活跃缓存摘除，等待回收）。 */
  retired: boolean;
  /** 宽限期是否已过（可以真正回收 object URL 了）。 */
  revokeReady: boolean;
  /** 延迟回收的计时器句柄。 */
  revokeTimer: ReturnType<typeof setTimeout> | null;
}

/** 已下载字节：key = 素材身份+用途。 */
const cachedBytes = new Map<string, CachedMediaBytes>();
/** 在途下载：同一素材的并发请求共用同一个 Promise。 */
const inFlight = new Map<string, Promise<string | null>>();
/**
 * 已签发的 object URL → 条目。包含「已淘汰但尚未回收」的条目：
 * 宽限期内还要靠它认出「谁重新取用了这份地址」，好取消回收。
 */
const entriesByObjectUrl = new Map<string, CachedMediaBytes>();
/** 活跃条目的字节总和（预算口径）。 */
let activeBytes = 0;
/** LRU 序号：单调递增即可，不依赖挂钟时间。 */
let lruStamp = 0;

/**
 * 预览字节预取的全局并发上限。
 *
 * 素材库一页默认 40 条（`ASSET_PAGE_SIZE`），卡片一挂载 `useCachedBytes` 的 effect 就会预取字节；
 * `<img loading="lazy">` 只推迟「可见性」，推不迟这里的 fetch，40 张卡片因此会变成
 * 40 条 `assetproxy`/`localbase64` 自定义协议请求同时压进 WebView 的 scheme handler。
 * macOS 崩溃报告里 30+ tokio worker 同时在途正对得上这个形态：原生协议线程被占满、
 * 主线程被图层提交拖住，最后 SIGABRT。几十 MB 的原图还会同时进内存/抢带宽。
 *
 * 取 4：一屏可见的卡片仍能近乎立刻出图，而后端协议线程（以及它要交回的主线程）
 * 始终有呼吸空间；剩下的卡片按 FIFO 排队，滚到哪就轮到哪。
 */
export const MAX_CONCURRENT_PREVIEW_FETCHES = 4;

/** 当前真正占用名额的「fetch + 读 body」数量（不含排队等待者）。 */
let activePreviewFetches = 0;
/**
 * 名额等待队列（FIFO）：每个元素是「名额已直接移交给你」的 resolve。
 *
 * 只 resolve 不 reject —— 即使发起方已经不再关心结果（卡片滚走/面板关闭），排到的请求
 * 也要能把字节下完写进缓存；没有 rejection 也就不会有未处理的 rejection。
 */
const previewFetchWaiters: Array<() => void> = [];

/** 取一个名额：未满立即占用；已满则排队，等 release 直接在队列头部唤醒。 */
function acquirePreviewFetchSlot(): Promise<void> {
  if (activePreviewFetches < MAX_CONCURRENT_PREVIEW_FETCHES) {
    activePreviewFetches += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    previewFetchWaiters.push(resolve);
  });
}

/**
 * 归还名额：有等待者就把名额**直接移交**给队首（`active` 不变），否则才 `active--`。
 *
 * 不能写成「先 `active--` 再唤醒等待者」：唤醒到等待者真正开始 fetch 之间隔着微任务，
 * 这期间其他 acquire 会看到空出的名额，于是多放进来一条请求，实际并发超限。
 */
function releasePreviewFetchSlot(): void {
  const next = previewFetchWaiters.shift();
  if (next != null) {
    next();
    return;
  }
  // 防御性夹到 0；正常情况下每个成功 acquire 只对应一次 release，不会为负。
  activePreviewFetches = Math.max(0, activePreviewFetches - 1);
}

/** 在并发闸门内执行一次真正的预览字节下载；成功/失败/取消都必须归还名额。 */
async function withPreviewFetchSlot<T>(task: () => Promise<T>): Promise<T> {
  await acquirePreviewFetchSlot();
  try {
    return await task();
  } finally {
    releasePreviewFetchSlot();
  }
}

function keyOf(assetId: string, kind: MediaType): string {
  return `${assetId}:${kind}`;
}

/** 下一个 LRU 序号。 */
function nextLruStamp(): number {
  lruStamp += 1;
  return lruStamp;
}

/**
 * 把条目从活跃缓存里摘掉（预算淘汰 / 丢弃坏副本），并安排延迟回收 object URL。
 *
 * 这里**不**立刻 revoke：旧地址可能还挂在某个已渲染的 `<img>` 上（组件刚卸载，
 * 或「渲染 → effect」之间的一次淘汰），立刻 revoke 会让画面裂开。真正的回收要等
 * 宽限期过、且最后一个消费者放手（见 `maybeRevokeEntry`）。
 */
function retireEntry(entry: CachedMediaBytes): void {
  if (entry.retired) return;
  entry.retired = true;
  // 只有当这个 key 现在仍指向这条目时才扣账：key 可能已经被一次重新下载换掉了。
  if (cachedBytes.get(entry.key) === entry) {
    cachedBytes.delete(entry.key);
    activeBytes -= entry.byteSize;
  }
  if (entry.revokeTimer != null) {
    clearTimeout(entry.revokeTimer);
    entry.revokeTimer = null;
  }
  entry.revokeTimer = setTimeout(() => {
    entry.revokeTimer = null;
    entry.revokeReady = true;
    maybeRevokeEntry(entry);
  }, REVOKE_GRACE_MS);
}

/** 宽限期已过、且没有消费者还在用时，才真正回收 object URL。 */
function maybeRevokeEntry(entry: CachedMediaBytes): void {
  if (!entry.retired || !entry.revokeReady) return;
  // 还有消费者在用这份地址：等最后一个放手再回收，避免正在显示的画面裂开。
  if (entry.refCount > 0) return;
  URL.revokeObjectURL(entry.objectUrl);
  entriesByObjectUrl.delete(entry.objectUrl);
}

/**
 * 消费者取用这份字节：登记引用，必要时把宽限期内被淘汰的条目捞回来。
 *
 * 捞回来（取消回收）是必须的：「渲染 → effect」之间条目可能被淘汰，
 * 组件随后取得引用时这份地址正要被 revoke；取消回收顺带让下一次渲染继续命中缓存，
 * 不必重复下载一次。
 */
function acquireMediaByteEntry(entry: CachedMediaBytes): void {
  if (entry.retired) {
    if (entry.revokeTimer != null) {
      clearTimeout(entry.revokeTimer);
      entry.revokeTimer = null;
    }
    entry.revokeReady = false;
    entry.retired = false;
    cachedBytes.set(entry.key, entry);
    activeBytes += entry.byteSize;
  }
  entry.refCount += 1;
  entry.lastUsedAt = nextLruStamp();
}

/** 消费者归还引用：最后一个放手时才允许真正回收，并顺手消化超预算的部分。 */
function releaseMediaByteEntry(entry: CachedMediaBytes): void {
  if (entry.refCount > 0) entry.refCount -= 1;
  if (entry.refCount > 0) return;
  maybeRevokeEntry(entry);
  enforceCacheBudget();
}

/**
 * 预算内消化：超预算时按 LRU 淘汰「当前没有消费者」的条目。
 *
 * 只动引用数为 0 的条目：还在被某个 `<img>` 用着的条目一旦淘汰，那个 `<img>` 会当场
 * 裂开。所有条目都被占用时宁可暂时超预算，也不破坏正在显示的画面 ——
 * 等消费者卸载（`releaseMediaByteEntry`）时再来一次。
 */
function enforceCacheBudget(): void {
  if (activeBytes <= MAX_TOTAL_CACHE_BYTES) return;
  const candidates: CachedMediaBytes[] = [];
  for (const entry of cachedBytes.values()) {
    if (entry.refCount === 0) candidates.push(entry);
  }
  candidates.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
  for (const entry of candidates) {
    if (activeBytes <= MAX_TOTAL_CACHE_BYTES) break;
    retireEntry(entry);
  }
}

/**
 * 丢弃指定的坏副本（本地字节渲染失败时调用）。
 *
 * 只丢弃「缓存里当前挂着的正是这份地址」的条目：别的消费者可能已经重新下载过一次，
 * 那时缓存里换成了新地址；把新地址淘汰掉反而让好副本也失效。
 */
function discardMediaByteEntry(assetId: string, kind: MediaType, objectUrl: string): void {
  if (assetId === "" || objectUrl === "") return;
  const entry = cachedBytes.get(keyOf(assetId, kind));
  if (entry == null || entry.objectUrl !== objectUrl) return;
  retireEntry(entry);
}

/** 从素材条目取缓存身份；缺 ID 的占位条目返回 null（调用方保持原样渲染）。 */
export function assetMediaByteIdentity(asset: {
  readonly id: string;
  readonly kind: MediaType;
}): AssetMediaIdentity | null {
  return asset.id === "" ? null : { assetId: asset.id, kind: asset.kind };
}

/** 是否值得缓存：只有图片正文与视频封面这类图片内容；视频正文与文本产物不缓存。 */
function isCacheableKind(kind: MediaType): boolean {
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
  kind: MediaType,
  mediaUrl: string | null | undefined,
): Promise<string | null> {
  if (assetId === "") return null;
  if (!isCacheableKind(kind)) return null;
  // 视频节点：地址指向视频本体时只服务播放，不进字节缓存。
  if (kind === "video" && mediaUrl != null && mediaUrl !== "" && isVideoMediaPath(mediaUrl)) {
    return null;
  }

  const key = keyOf(assetId, kind);
  const cached = cachedBytes.get(key);
  if (cached != null) return cached.objectUrl;

  const pending = inFlight.get(key);
  if (pending != null) return pending;
  // 已知太大：保持直连渲染，不必再探一次体积。
  if (directOnlyIdentities.has(key)) return null;

  const requestUrl = toMediaProxyUrl(mediaUrl, proxyIdentity(assetId, kind)) ?? mediaUrl ?? null;
  if (requestUrl == null || requestUrl === "") return null;

  const request = (async (): Promise<string | null> => {
    // 响应头一到就能判定体积：超限时立刻取消，正文一个字节都不读。
    const controller = new AbortController();
    try {
      // 只有「真正的 fetch + 读 body」占用并发名额：缓存命中、同 key 合并、直连判定
      // 这些同步短路都在闸门之外，调用方拿到的行为与加闸门前一致。
      return await withPreviewFetchSlot(async () => {
        const response = await fetch(requestUrl, {
          // 自定义协议的 4xx 不能进 HTTP 缓存：身份查询串一旦被 WebView 丢掉，第一次
          // 400 会被 force-cache 钉死，续签/登记表就绪后同一地址也永远「预览不可用」。
          cache: "no-store",
          credentials: "omit",
          signal: controller.signal,
        });
        if (!response.ok) return null;
        const declaredBytes = Number(response.headers.get("content-length"));
        if (Number.isFinite(declaredBytes) && declaredBytes > MAX_BLOB_BYTES) {
          directOnlyIdentities.add(key);
          controller.abort();
          return null;
        }
        const blob = await response.blob();
        if (blob.size === 0) return null;
        const objectUrl = URL.createObjectURL(blob);
        const previous = cachedBytes.get(key);
        if (previous != null) {
          // 同一身份重新下载：旧副本走淘汰流程（记账与回收共用同一条路）。
          retireEntry(previous);
        }
        const entry: CachedMediaBytes = {
          key,
          objectUrl,
          byteSize: blob.size,
          refCount: 0,
          lastUsedAt: nextLruStamp(),
          retired: false,
          revokeReady: false,
          revokeTimer: null,
        };
        cachedBytes.set(key, entry);
        entriesByObjectUrl.set(objectUrl, entry);
        activeBytes += blob.size;
        // 新条目可能把总量顶过预算：立刻按 LRU 消化，最久未用的先走。
        enforceCacheBudget();
        return objectUrl;
      });
    } catch {
      return null;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, request);
  return request;
}

/**
 * 缓存身份的同步查询：渲染期据此优先用本地字节，不发起任何请求。
 *
 * 命中即视为「刚用过」：LRU 淘汰按真实展示热度排序，而不是下载先后。
 */
export function getMediaByteUrl(assetId: string, kind: MediaType): string | null {
  if (assetId === "") return null;
  const entry = cachedBytes.get(keyOf(assetId, kind));
  if (entry == null) return null;
  entry.lastUsedAt = nextLruStamp();
  return entry.objectUrl;
}

/**
 * 释放全部已缓存字节。生产只在应用卸载时调用。
 *
 * 这里是唯一「立即回收 object URL」的地方：卸载时已经没有任何 `<img>` 需要这些地址，
 * 没必要等宽限期。其余场合（预算淘汰、坏副本丢弃）都走延迟回收 ——
 * 旧地址可能仍挂在某个已渲染的 `<img>` 上。
 *
 * 注意：这里刻意不动并发闸门的 `active`/等待队列。已经在途的请求稍后仍会归还名额，
 * 清缓存时把计数归零会让两边都算错（新请求超发、旧请求归还后把计数减成负数），
 * 而闸门统计的是「真实在途的原生协议请求」，与缓存内容无关。
 */
export function clearMediaByteCache(): void {
  for (const entry of entriesByObjectUrl.values()) {
    if (entry.revokeTimer != null) clearTimeout(entry.revokeTimer);
    URL.revokeObjectURL(entry.objectUrl);
  }
  entriesByObjectUrl.clear();
  cachedBytes.clear();
  activeBytes = 0;
  inFlight.clear();
  // 体积判定同样清空：清缓存后重新探测一次，避免「曾经太大」的判断跨场景沿用。
  directOnlyIdentities.clear();
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
   * - 用的本地字节（副本损坏、object URL 失效）→ 真的把这份副本从缓存里丢弃，
   *   再从远端重新下载一次（重新下载每个素材身份只做一次，不会形成重试循环）；
   * - 用的远端地址（签名过期、网络不可达）→ 先在本地字节里找一次，命中即继续渲染。
   * 每个素材的每个来源最多重试一次，不会形成重试循环。
   */
  readonly retry: () => void;
  /**
   * 回读/续签已经把完整预览地址登记进原生代理后，再拉一次字节。
   * 与 `retry` 不同：不受「每个来源一次」限制，否则第一次失败会把这次机会用掉。
   */
  readonly reload: () => void;
}

/**
 * 把一个素材预览地址解析成本地可渲染地址：
 * - 已缓存过该素材时渲染期直接返回本地地址，不发请求，也不受签名过期影响；
 * - 未缓存时先渲染远端地址（画面不等人），后台下载字节，成功后换成稳定地址；
 * - 下载失败保持远端地址，调用方原有的续签自愈路径不受影响。
 *
 * 挂载期间本 hook 持有这份字节的引用（预算淘汰跳过还在显示的条目），
 * 卸载时归还 —— 引用归还后条目才可能按 LRU 被淘汰。
 */
export function useMediaByteSource(
  assetId: string,
  kind: MediaType,
  mediaUrl: string | null | undefined,
): MediaByteSource {
  const { objectUrl, blockedObjectUrl, retryFromBytes, retryFromRemote, reload } = useCachedBytes(
    assetId,
    kind,
    mediaUrl,
  );
  const remoteUrl = toMediaProxyUrl(mediaUrl, proxyIdentity(assetId, kind)) ?? mediaUrl ?? null;
  const usableObjectUrl = objectUrl != null && objectUrl !== blockedObjectUrl ? objectUrl : null;
  return {
    url: usableObjectUrl ?? remoteUrl,
    fromCache: usableObjectUrl != null,
    retry: usableObjectUrl != null ? retryFromRemote : retryFromBytes,
    reload,
  };
}

/**
 * 缓存字节的取用与刷新。
 *
 * 下载落定（无论成功失败）都只写一次那个「下载完成」state：同值更新会被 React 跳过，
 * 因此失败路径不会形成循环，而成功路径会让组件立刻切到本地副本，不必等下一个
 * 不相干的 state 变化。
 *
 * 挂载期间还持有一份这份字节的引用（`acquireMediaByteEntry`），卸载时归还：
 * 引用数是预算淘汰的准入条件 —— 还在显示中的条目不能被淘汰掉。
 */
function useCachedBytes(
  assetId: string,
  kind: MediaType,
  mediaUrl: string | null | undefined,
): {
  readonly objectUrl: string | null;
  readonly blockedObjectUrl: string | null;
  readonly retryFromRemote: () => void;
  readonly retryFromBytes: () => void;
  readonly reload: () => void;
} {
  const [blockedObjectUrl, setBlockedObjectUrl] = useState<string | null>(null);
  // 下载落定后必须让组件重渲染一次，否则这一次渲染读到的仍是远端地址，
  // 本地副本要等到下一个不相干的 state 变化才生效（等价于白下载一次）。
  // 只用到 setter：这个 state 的值没人读，它的作用就是「让组件重渲染」。
  const [, setLoadedUrl] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const retriedRef = useRef<Set<string>>(new Set());
  const objectUrl = getMediaByteUrl(assetId, kind);
  const requestedUrl = objectUrl ?? mediaUrl ?? null;

  /**
   * 持有这份字节的引用：挂载期间条目不会被预算淘汰，卸载时归还。
   *
   * 必须排在下面的下载 effect 之前：条目若在「渲染 → effect」之间被淘汰，
   * 这里先取得引用能把条目捞回来（取消待回收），后面的 effect 才会命中缓存、
   * 不会白下载一次。
   */
  useEffect(() => {
    if (objectUrl == null) return;
    const entry = entriesByObjectUrl.get(objectUrl);
    if (entry == null) return;
    acquireMediaByteEntry(entry);
    return () => {
      releaseMediaByteEntry(entry);
    };
  }, [objectUrl]);

  useEffect(() => {
    if (assetId === "") return;
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
    // 本地副本渲染失败：这份副本已知是坏的，必须真的从缓存里删掉。
    retryFromRemote: () => {
      // 只标记「本组件的局部 state」是不够的：坏条目还留在缓存里，下一次 effect
      // 会在缓存里命中它并直接返回 —— 永远不会重新下载，这份素材整个会话都只能
      // 显示「预览不可用」，而且坏副本会被所有消费者共用。
      if (objectUrl != null) discardMediaByteEntry(assetId, kind, objectUrl);
      // 屏蔽这份地址：即便不再重新下载，也立刻回落到远端地址渲染。
      if (objectUrl != null && objectUrl !== blockedObjectUrl) setBlockedObjectUrl(objectUrl);
      // 重新下载每个素材身份只做一次：token 按身份计而不是按地址计 ——
      // 按地址计的话，重新下载回来的坏副本（新地址）会再触发一轮，
      // 形成「下载 → 失败 → 再下载」的死循环。
      retryOnce(`remote:${assetId}:${kind}`, () => undefined);
    },
    // 远端地址渲染失败：允许再从本地字节里取一次 —— 后端代理的磁盘缓存可能已经有
    // 这份素材（重启前下载过、或另一个渲染路径刚下载完），命中就继续渲染。
    retryFromBytes: () => retryOnce(`bytes:${requestedUrl ?? "none"}`, () => undefined),
    reload: () => setRetryToken((value) => value + 1),
  };
}
