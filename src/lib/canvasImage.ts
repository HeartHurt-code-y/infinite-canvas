import * as v from "valibot";
import { invokeDesktop, invokeDesktopVoid } from "./ipc";
import type { StartGenerationCommand } from "./backend";
import type { CanvasImagePresetSelection } from "./canvasImagePresets";
import type { CanvasCameraControl } from "./canvasCameraControl";

export const CANVAS_IMAGE_MODES = [
  { value: "auto", label: "自动" },
  { value: "image_to_image", label: "图生图" },
  { value: "upscale", label: "图片高清" },
] as const;
export type CanvasImageMode = (typeof CANVAS_IMAGE_MODES)[number]["value"];

export interface CanvasImageStyle {
  readonly name: string;
  readonly prompt: string;
}

export interface CanvasImageTranslationTask {
  readonly taskId: string;
  readonly sourceFingerprint: string;
  readonly language: "English" | "Chinese";
  readonly generation: StartGenerationCommand;
}

const presetSchema = v.object({
  id: v.string(),
  kind: v.picklist(["style", "prompt"]),
  name: v.string(),
  text: v.string(),
  updatedAt: v.number(),
});
export type CanvasImagePreset = v.InferOutput<typeof presetSchema>;

/** 图片编辑器只负责本项目的素材和任务，不调用 liblib 私有接口。 */
export const canvasImageClient = {
  translate: (command: { readonly taskId: string; readonly generation: StartGenerationCommand }) =>
    invokeDesktop("start_canvas_image_translation", v.string(), { command }),
  start: (command: {
    readonly generation: StartGenerationCommand;
    readonly mode: CanvasImageMode;
    readonly targetResolution?: string;
    readonly style?: CanvasImageStyle;
    readonly preset?: CanvasImagePresetSelection;
    readonly cameraControl?: CanvasCameraControl;
    readonly panorama?: boolean;
  }) => invokeDesktop("start_canvas_image_generation", v.string(), { command }),
  listPresets: () => invokeDesktop("list_canvas_image_presets", v.array(presetSchema)),
  savePreset: (command: {
    readonly id?: string;
    readonly kind: "style" | "prompt";
    readonly name: string;
    readonly text: string;
  }) => invokeDesktop("save_canvas_image_preset", presetSchema, { command }),
  deletePreset: (id: string) => invokeDesktopVoid("delete_canvas_image_preset", { id }),
};
