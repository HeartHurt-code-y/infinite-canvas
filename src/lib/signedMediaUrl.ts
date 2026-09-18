/**
 * 判断一份对象存储预签名地址是否已过期。
 *
 * 只识别火山 TOS 的 `X-Tos-Date` + `X-Tos-Expires`（秒为单位的有效期）；
 * 无法识别的地址返回 `false`（按未过期处理），交给原有自愈路径，
 * 不用猜测其他供应商的签名语义。
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
