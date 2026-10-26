/*
 * 创作台的主页面配置：默认创作类型与默认模型。
 *
 * 落在服务端偏好（sqlite 的 application_settings）里而不是 localStorage：
 * 自动更新会清掉 WebView 的 localStorage，用户每次回来都要重新选一遍模型。
 *
 * 对齐即梦的 `remember_me`：模型目录里带这个开关，含义相同——
 * 「下次进来还按上次的创作类型与模型开始」。
 */
import { workspaceUiClient } from "../../lib/backend";
import { CREATE_MODES, type CreateModeId } from "./createModel";

export interface CreationPreferences {
  readonly mode: CreateModeId | null;
  readonly modelDefinitionId: string | null;
}

const EMPTY: CreationPreferences = { mode: null, modelDefinitionId: null };

/** 读取主页面配置；读不到或模式名不认识时按「没有配置」处理。 */
export async function loadCreationPreferences(): Promise<CreationPreferences> {
  const prefs = await workspaceUiClient.get();
  const mode = CREATE_MODES.find((item) => item.id === prefs.creationMode)?.id ?? null;
  return {
    mode,
    modelDefinitionId: prefs.creationModelDefinitionId ?? null,
  };
}

/**
 * 保存主页面配置。
 *
 * 只写这两个字段：服务端按「非空才覆盖」合并，素材库等别的偏好不会被清掉。
 */
export async function saveCreationPreferences(input: {
  readonly mode: CreateModeId;
  readonly modelDefinitionId: string | null;
}): Promise<void> {
  await workspaceUiClient.save({
    activeAssetProviderId: null,
    assetLibrarySource: null,
    creationMode: input.mode,
    creationModelDefinitionId: input.modelDefinitionId,
  });
}

export { EMPTY as EMPTY_CREATION_PREFERENCES };
