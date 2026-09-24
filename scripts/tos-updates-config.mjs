// 应用内更新的公开分发位置：火山引擎 TOS 桶 sd20-zq。
// 只把 `infinite-canvas/updates/` 前缀做成匿名可读，避免误把桶里其它对象整桶公开。
export const TOS_UPDATES_BUCKET = "sd20-zq";
export const TOS_UPDATES_REGION = "cn-beijing";
export const TOS_UPDATES_ENDPOINT = "tos-cn-beijing.volces.com";
export const TOS_UPDATES_PREFIX = "infinite-canvas/updates";

export function tosUpdatesHost(bucket = TOS_UPDATES_BUCKET, endpoint = TOS_UPDATES_ENDPOINT) {
  return `${bucket}.${endpoint}`;
}

export function tosUpdatesPublicBaseUrl({
  bucket = TOS_UPDATES_BUCKET,
  endpoint = TOS_UPDATES_ENDPOINT,
  prefix = TOS_UPDATES_PREFIX,
} = {}) {
  return `https://${tosUpdatesHost(bucket, endpoint)}/${prefix.replace(/^\/+|\/+$/g, "")}`;
}

export function tosUpdatesLatestJsonUrl(options) {
  return `${tosUpdatesPublicBaseUrl(options)}/latest.json`;
}

export function tosPlatformLatestJsonUrl(platform = "{{target}}-{{arch}}", options) {
  return `${tosUpdatesPublicBaseUrl(options)}/${platform}/latest.json`;
}

export function tosUpdatesObjectKey(fileName, prefix = TOS_UPDATES_PREFIX) {
  return `${prefix.replace(/^\/+|\/+$/g, "")}/${fileName}`;
}
