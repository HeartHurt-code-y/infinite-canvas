/** 与后端 `provider_adapter.rs` 对齐的供应商适配器身份与百炼 URL 规则。 */

export const MOYU_ADAPTER_ID = "moyu_v1";
export const ARK_ADAPTER_ID = "volcengine_ark_v1";
export const BAILIAN_ADAPTER_ID = "aliyun_bailian_v1";

/** 华北2（北京）百炼 MaaS 主机后缀。 */
export const BAILIAN_BEIJING_HOST_SUFFIX = "cn-beijing.maas.aliyuncs.com";

export function isBailianAdapter(adapterId: string): boolean {
  return adapterId === BAILIAN_ADAPTER_ID;
}

export function isArkAdapter(adapterId: string): boolean {
  return adapterId === ARK_ADAPTER_ID;
}

export function adapterAllowsEmptyApiKey(adapterId: string): boolean {
  return isArkAdapter(adapterId);
}

export function adapterSupportsAssetLibrary(adapterId: string): boolean {
  return !isBailianAdapter(adapterId);
}

export function isValidBailianWorkspaceId(workspaceId: string): boolean {
  const trimmed = workspaceId.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= 64 &&
    /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(trimmed)
  );
}

export function assembleBailianBaseUrl(workspaceId: string): string {
  const trimmed = workspaceId.trim();
  return trimmed ? `https://${trimmed}.${BAILIAN_BEIJING_HOST_SUFFIX}` : "";
}

export function parseBailianWorkspaceId(baseUrl: string): string {
  try {
    const host = new URL(baseUrl.trim()).hostname.toLocaleLowerCase();
    const suffix = `.${BAILIAN_BEIJING_HOST_SUFFIX}`;
    if (!host.endsWith(suffix)) return "";
    const workspaceId = host.slice(0, -suffix.length);
    return workspaceId && !workspaceId.includes(".") ? workspaceId : "";
  } catch {
    return "";
  }
}
