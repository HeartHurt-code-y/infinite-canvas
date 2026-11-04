import * as v from "valibot";
import { invokeDesktop } from "./ipc";
import type { ConfiguredModel, ProviderCatalogEntry, StartGenerationCommand } from "./backend";
import type { ImageStyleReference } from "./imageStyleMarket";
import type { CanvasImagePresetSelection } from "./canvasImagePresets";
import type { CanvasCameraControl } from "./canvasCameraControl";

/** 保留旧画布模式的解码；新任务按实际参考素材自动选择操作。 */
export type CanvasImageMode = "auto" | "image_to_image" | "upscale";

export const IMAGE_UPSCALER_MODEL = "atlascloud/image-upscaler";
export const IMAGE_REGION_EDIT_BINDING = "atlascloud/masked-image-edit";
export function resolveImageUpscaler(catalog: readonly ProviderCatalogEntry[], providerId?: string) {
  const provider = catalog.find(entry => entry.provider.enabled && entry.provider.adapterId === "atlascloud_v1" && (!providerId || entry.provider.id === providerId));
  if (!provider) return null;
  const model: ConfiguredModel = { definitionId: `remote::${provider.provider.id}::${IMAGE_UPSCALER_MODEL}`, remoteModelId: IMAGE_UPSCALER_MODEL, displayName: "图片高清（2× / 4×）", operations: ["image_to_image"], operationSchema: {} };
  return { provider, model };
}

export interface CanvasImageTranslationTask {
  readonly taskId: string;
  readonly sourceFingerprint: string;
  readonly language: "English" | "Chinese";
  readonly generation: StartGenerationCommand;
}

/** 图片编辑器只负责本项目的素材和任务，不调用 liblib 私有接口。 */
export const canvasImageClient = {
  translate: (command: { readonly taskId: string; readonly generation: StartGenerationCommand }) =>
    invokeDesktop("start_canvas_image_translation", v.string(), { command }),
  start: (command: {
    readonly generation: StartGenerationCommand;
    readonly mode: CanvasImageMode | "masked_edit";
    readonly styleReference?: ImageStyleReference;
    readonly upscaleScale?: number;
    readonly preset?: CanvasImagePresetSelection;
    readonly cameraControl?: CanvasCameraControl;
    readonly panorama?: boolean;
  }) => invokeDesktop("start_canvas_image_generation", v.string(), { command }),
};
