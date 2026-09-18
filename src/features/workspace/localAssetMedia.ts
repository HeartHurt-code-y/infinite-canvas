import { refreshAssetItemMediaUrl } from "../../lib/backend";
import type { AssetKind, AssetNodeData } from "./workspaceModel";

export { signedUrlExpired } from "../../lib/signedMediaUrl";

/**
 * 本地素材预览地址的运行时登记表。
 *
 * 本地素材的 `previewUrl` 是对象存储的短期预签名地址（后端 1 小时），而画布文档会把
 * 节点数据整体持久化，于是「重启后打开画布」必然拿到一批过期签名：节点先渲染失败，
 * 再靠 `onError` 逐节点续签，于是用户看到的是一屏「预览不可用」。
 *
 * 这里在画布文档水合后按素材身份批量续签，把新地址回写节点数据。因此画布文档不再
 * 依赖其中一份签名的存活期：过期地址在被使用前就被替换，续签失败时仍回落到
 * `CanvasAssetNode` 的 onError 自愈路径。云端素材（供应商签名地址）不由本模块接管。
 *
 * 已经下载过的素材由 `mediaByteCache` 直接命中本地字节，续签只负责让画布文档里的
 * 签名保持新鲜；两者互相独立，任一路径可用预览就不会失败。
 */

/** 同一素材的并发续签只发一次请求：同一次水合里多个节点常常引用同一素材。 */
const inFlight = new Map<string, Promise<string | null>>();
/** 已续签但尚未回写节点的地址，供渲染期先取用，避免回写前的空窗。 */
const resolved = new Map<string, string>();

function keyOf(assetId: string, kind: AssetKind): string {
  return `${assetId}:${kind}`;
}

/** 本地素材节点当前应使用的预览地址：`null` 表示已无可用地址，调用方保持占位。 */
export function localAssetNodeMediaUrl(
  node: Pick<AssetNodeData, "assetId" | "kind" | "previewUrl" | "videoUrl">,
): string | null {
  const fresh = resolved.get(keyOf(node.assetId, node.kind));
  if (fresh != null && fresh !== "") return fresh;
  return node.videoUrl ?? node.previewUrl ?? null;
}

/**
 * 按素材身份续签读取地址并把结果登记到内存（不写节点数据）。
 * 同一素材在途时复用同一个 Promise；失败的素材会立刻被再次尝试，不做负缓存。
 */
export function refreshLocalAssetPreviewUrl(
  assetId: string,
  kind: AssetKind,
): Promise<string | null> {
  if (assetId === "") return Promise.resolve(null);
  const key = keyOf(assetId, kind);
  const pending = inFlight.get(key);
  if (pending != null) return pending;
  const request = refreshAssetItemMediaUrl({ id: assetId, source: "local" }, kind)
    .then((freshUrl) => {
      inFlight.delete(key);
      if (freshUrl != null && freshUrl !== "") {
        resolved.set(key, freshUrl);
      }
      return freshUrl;
    })
    .catch(() => {
      inFlight.delete(key);
      return null;
    });
  inFlight.set(key, request);
  return request;
}

/**
 * 批量续签一批本地素材节点的预览地址，成功后按 `onResolved` 回写节点数据。
 *
 * 同一素材只请求一次；全部落定后调用一次回调，避免逐节点触发文档保存。
 * 返回取消函数，画布在续签期间被切换时丢弃迟到的回写。
 */
export function prefetchLocalAssetMedia(
  nodes: readonly Pick<AssetNodeData, "assetId" | "kind">[],
  onResolved: (fresh: ReadonlyMap<string, string>) => void,
): () => void {
  const wanted = new Map<string, { assetId: string; kind: AssetKind }>();
  for (const node of nodes) {
    if (node.assetId === "") continue;
    wanted.set(keyOf(node.assetId, node.kind), { assetId: node.assetId, kind: node.kind });
  }
  if (wanted.size === 0) return () => undefined;
  let cancelled = false;
  void Promise.all(
    [...wanted.values()].map(async (entry) => {
      const freshUrl = await refreshLocalAssetPreviewUrl(entry.assetId, entry.kind);
      return [keyOf(entry.assetId, entry.kind), freshUrl] as const;
    }),
  ).then((entries) => {
    if (cancelled) return;
    const fresh = new Map<string, string>();
    for (const [key, url] of entries) {
      if (url != null && url !== "") fresh.set(key, url);
    }
    if (fresh.size > 0) onResolved(fresh);
  });
  return () => {
    cancelled = true;
  };
}

/** 测试与文档切换时清空运行时登记表，避免上一条画布的新地址泄漏到下一条。 */
export function resetLocalAssetMediaRegistry(): void {
  inFlight.clear();
  resolved.clear();
}
