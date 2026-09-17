//! 云端素材库的供应商支持判定。
//!
//! 供应商连接并不都实现云端素材库：盘趣聚合网关（One API / new-api 内核）只开放
//! `/v1/models` 与 `/v1/video/generations*`，`/v1/assets/*` 全部 404
//! （实测见 `docs/integrations/panqu-video-api.md`）。这类连接只参与模型生成；
//! 一旦被当成素材库来源，面板只会把上游 404 原样展示成「云端素材库不可用」。
//! 所以在进入素材库的任何供应商选项之前，先按上游主机把它们过滤掉。

import type { ProviderConnection } from "./backend";
import { adapterSupportsAssetLibrary } from "./providerAdapters";

/**
 * 没有云端素材库的上游主机（小写、不含端口）。判定按主机而不是连接 ID：
 * 用户照着同一个地址新建的连接同样没有素材库，而改名后的连接仍应被排除。
 */
const HOSTS_WITHOUT_ASSET_LIBRARY: readonly string[] = [
  "115.191.2.88",
  "panqu.com",
  "maas.aliyuncs.com",
];

/** 取 Base URL 的主机名；地址无法解析时退回原始字符串（用户可能只填了主机）。 */
function hostOf(baseUrl: string): string {
  const trimmed = baseUrl.trim().toLocaleLowerCase();
  try {
    return new URL(trimmed).hostname;
  } catch {
    return trimmed;
  }
}

function hostHasAssetLibrary(host: string): boolean {
  if (!host) return true;
  return !HOSTS_WITHOUT_ASSET_LIBRARY.some(
    (unsupported) => host === unsupported || host.endsWith(`.${unsupported}`),
  );
}

/** 该供应商连接是否提供云端素材库；false = 不应出现在素材库的供应商选项里。 */
export function providerSupportsAssetLibrary(provider: ProviderConnection): boolean {
  if (!adapterSupportsAssetLibrary(provider.adapterId)) return false;
  return hostHasAssetLibrary(hostOf(provider.baseUrl));
}

/** 过滤出可作为素材库来源的供应商连接，保持传入顺序。 */
export function assetLibraryProviders(
  providers: readonly ProviderConnection[],
): ProviderConnection[] {
  return providers.filter(providerSupportsAssetLibrary);
}
