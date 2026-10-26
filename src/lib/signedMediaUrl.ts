/**
 * 判断一份对象存储预签名地址是否已过期。
 *
 * 只识别火山 TOS 的 `X-Tos-Date` + `X-Tos-Expires`（秒为单位的有效期）；
 * 无法识别的地址返回 `false`（按未过期处理），交给原有自愈路径，
 * 不用猜测其他供应商的签名语义。
 *
 * 用途：画布素材节点在**渲染前**先问一次「这个地址是不是已经过期」——
 * 过期就直接走既有的续签接口（`refreshAssetItemMediaUrl`），
 * 不让界面先坏成「预览不可用」再靠 onError 自愈。
 * 调用点在 `features/workspace/MediaNodeViews.tsx`，
 * 经 `features/workspace/localAssetMedia.ts` 再导出（该模块本来就管素材预览地址）。
 */
export function signedUrlExpired(url: string | null | undefined, now = Date.now()): boolean {
  if (url == null || url === "") return false;
  const date = /X-Tos-Date=(\d{8})T(\d{6})Z/.exec(url);
  const expires = /X-Tos-Expires=(\d+)/.exec(url);
  if (date == null || expires == null) return false;
  const stamp = Date.UTC(
    Number(date[1]!.slice(0, 4)),
    Number(date[1]!.slice(4, 6)) - 1,
    Number(date[1]!.slice(6, 8)),
    Number(date[2]!.slice(0, 2)),
    Number(date[2]!.slice(2, 4)),
    Number(date[2]!.slice(4, 6)),
  );
  const expiresSecs = Number(expires[1]);
  if (!Number.isFinite(stamp) || !Number.isFinite(expiresSecs)) return false;
  return stamp + expiresSecs * 1000 <= now;
}
