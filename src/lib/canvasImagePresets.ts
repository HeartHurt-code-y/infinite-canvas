import * as v from "valibot";
import rawCatalog from "../../shared/canvas-image-presets.json";
import type { ModelParameterCapability, ModelParameterValue } from "./modelCapabilities";

const optionValueSchema = v.object({ value: v.string(), label: v.string(), instruction: v.string() });
const optionSchema = v.object({
  key: v.string(), label: v.string(), default: v.string(), values: v.array(optionValueSchema),
});
const presetSchema = v.object({
  scene: v.string(),
  label: v.string(),
  description: v.string(),
  placeholder: v.string(),
  icon: v.picklist(["storyboard", "grid3", "grid2", "clock", "portrait", "light", "angle", "face", "member", "assets", "product"]),
  newFeature: v.boolean(),
  inputRequirement: v.picklist(["prompt", "image", "prompt_or_image"]),
  defaults: v.record(v.string(), v.string()),
  instruction: v.string(),
  options: v.optional(v.array(optionSchema), []),
});
const catalog = v.parse(v.object({
  version: v.number(),
  instructionOrigin: v.string(),
  groups: v.array(v.object({ id: v.string(), label: v.string(), column: v.number(), presets: v.array(presetSchema) })),
}), rawCatalog);

export type BuiltinCanvasImagePreset = v.InferOutput<typeof presetSchema>;
export interface CanvasImagePresetSelection {
  readonly scene: string;
  readonly version: number;
  readonly options: Readonly<Record<string, string>>;
  readonly parameterModelKey: string;
  /** 仅用于下次切换预设时辨认自动填入的参数；用户修改过的值优先保留。 */
  readonly appliedParameters: Readonly<Record<string, ModelParameterValue>>;
}

export const CANVAS_IMAGE_PRESET_VERSION = catalog.version;
export const CANVAS_IMAGE_PRESET_GROUPS = catalog.groups;
export const CANVAS_IMAGE_PRESETS = catalog.groups.flatMap(group => group.presets);
export const CANVAS_IMAGE_PROMPT_PLACEHOLDER = "可直接文字生图，或上传图片输入文字指令对图片进行编辑，如：将背景改为雪夜";

export function canvasImagePreset(scene: string | undefined): BuiltinCanvasImagePreset | undefined {
  return CANVAS_IMAGE_PRESETS.find(preset => preset.scene === scene);
}

export function imagePresetOptionValues(preset: BuiltinCanvasImagePreset, saved?: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(preset.options.map(option => [
    option.key,
    option.values.some(value => value.value === saved?.[option.key]) ? saved?.[option.key] ?? option.default : option.default,
  ]));
}

const PARAMETER_KEYS: Readonly<Record<string, readonly string[]>> = {
  ratio: ["ratio", "aspect_ratio"],
  resolution: ["resolution", "image_size"],
  quality: ["quality"],
};

/**
 * 原站私有模型 ID 与支持白名单不进入本项目。只匹配当前模型真实声明的枚举，
 * 并保留用户已选参数；上一次由预设自动填入且仍未改变的值才跟随新预设更新。
 */
export function selectCanvasImagePreset(
  preset: BuiltinCanvasImagePreset,
  capabilities: readonly ModelParameterCapability[],
  parameterValues: Readonly<Record<string, ModelParameterValue>>,
  parameterModelKey: string,
  previous?: CanvasImagePresetSelection,
): { readonly selection: CanvasImagePresetSelection; readonly parameterValues: Readonly<Record<string, ModelParameterValue>> } {
  const values = { ...parameterValues };
  const priorApplied = previous?.parameterModelKey === parameterModelKey ? previous.appliedParameters : undefined;
  const applied: Record<string, ModelParameterValue> = Object.fromEntries(
    Object.entries(priorApplied ?? {}).filter(([key, value]) => parameterValues[key] === value),
  );
  for (const [semantic, wanted] of Object.entries(preset.defaults)) {
    const capability = capabilities.find(item => PARAMETER_KEYS[semantic]?.includes(item.key));
    if (!capability) continue;
    const option = capability.options.find(item => String(item.value).toLowerCase() === wanted.toLowerCase());
    if (!option) continue;
    const current = values[capability.key];
    const prior = priorApplied?.[capability.key];
    if (current !== undefined && current !== prior) continue;
    values[capability.key] = option.value;
    applied[capability.key] = option.value;
  }
  return {
    selection: {
      scene: preset.scene,
      version: catalog.version,
      options: imagePresetOptionValues(preset, previous?.scene === preset.scene ? previous.options : undefined),
      parameterModelKey,
      appliedParameters: applied,
    },
    parameterValues: values,
  };
}
