/** 与后端 `provider_adapter.rs` 对齐的供应商适配器身份与百炼 URL 规则。 */

export const MOYU_ADAPTER_ID = "moyu_v1";
export const ARK_ADAPTER_ID = "volcengine_ark_v1";
export const BAILIAN_ADAPTER_ID = "aliyun_bailian_v1";
export const DOUBAO_VOICE_ADAPTER_ID = "doubao_voice_v1";
export const DOUBAO_VOICE_BASE_URL = "https://openspeech.bytedance.com";
/** Grsai 图片生成 API：自有协议（`/v1/api/generate` + `/v1/api/result`）。 */
export const GRSAI_ADAPTER_ID = "grsai_v1";

/**
 * 语音合成的两个请求档案，与后端 `model_schema.rs` 一一对应：豆包语音 OpenSpeech
 * 的 SSE 接口，以及 OpenAI 兼容网关的 `POST /v1/tts/create`。
 */
export const DOUBAO_TTS_REQUEST_PROFILE = "doubao_voice_tts_v3_sse";
export const GATEWAY_TTS_REQUEST_PROFILE = "gateway_tts_create_v1";

export function speechRequestProfile(schema: Record<string, unknown> | undefined): string {
  const operation = schema?.["speech_generation"] as Record<string, unknown> | undefined;
  const profile = operation?.["requestProfileId"];
  return typeof profile === "string" ? profile : "";
}

export function doubaoSamiCredentialRefs(providerConnectionId: string) {
  return {
    appkey: `provider:${providerConnectionId}:sami_appkey`,
    token: `provider:${providerConnectionId}:sami_token`,
  } as const;
}

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
  // Grsai 只有 generate / result 两个接口，没有素材库。
  return (
    !isBailianAdapter(adapterId) &&
    adapterId !== DOUBAO_VOICE_ADAPTER_ID &&
    adapterId !== GRSAI_ADAPTER_ID
  );
}

export function isValidBailianWorkspaceId(workspaceId: string): boolean {
  const trimmed = workspaceId.trim();
  return trimmed.length > 0 && trimmed.length <= 64 && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(trimmed);
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
