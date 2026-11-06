import * as v from "valibot";
import rawCatalog from "../../shared/canvas-image-presets.json";
import { GPT_IMAGE_25_PROFILE, gptImage25Size } from "./gptImage25";
import type { ModelParameterCapability, ModelParameterValue } from "./modelCapabilities";
import type { PromptContentDocumentV1 } from "./promptContent";
import { SEEDREAM_PRO_RATIOS, SEEDREAM_PRO_RESOLUTIONS, seedreamProSize } from "./seedreamPro";

const optionValueSchema = v.object({
  value: v.string(), label: v.string(), instruction: v.string(),
  presetLabel: v.optional(v.string()),
  legacy: v.optional(v.object({ key: v.string(), value: v.string() })),
});
const optionSchema = v.object({
  key: v.string(), label: v.string(), default: v.string(), values: v.array(optionValueSchema),
  control: v.optional(v.picklist(["choices", "switch"]), "choices"),
  help: v.optional(v.string()),
});
const presetSchema = v.object({
  scene: v.string(),
  label: v.string(),
  description: v.string(),
  placeholder: v.string(),
  icon: v.picklist(["slash-storyboard","slash-storyboard-25grid","slash-story-beat-4grid","slash-frame-prediction-plus3s","slash-frame-prediction-minus5s","portrait-adjust","slash-cinematic-lighting-correction","slash-panoramic-720","grid-3x3","slash-character-design","slash-character-face-turnaround","perspnal-n","slash-list","slash-product-turnaround"]),
  newFeature: v.boolean(),
  inputRequirement: v.picklist(["prompt", "image", "prompt_or_image"]),
  defaults: v.record(v.string(), v.string()),
  instruction: v.string(),
  options: v.optional(v.array(optionSchema), []),
  optionsPreviewUrl: v.optional(v.pipe(v.string(), v.url())),
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
const storyboardPresets = catalog.groups.find(group => group.id === "storyboard")?.presets ?? [];

export function canvasImagePreset(scene: string | undefined): BuiltinCanvasImagePreset | undefined {
  return CANVAS_IMAGE_PRESETS.find(preset => preset.scene === scene);
}

export function canvasStoryboardPreset(scene: string | undefined): BuiltinCanvasImagePreset | undefined {
  return storyboardPresets.find(preset => preset.scene === scene);
}

type StoryboardPromptInput = "empty" | "text" | "image" | "text_and_image";

export function storyboardPromptInput(document: PromptContentDocumentV1 | undefined): StoryboardPromptInput {
  const items = document?.items ?? [];
  const hasImage = items.some(item =>
    (item.kind === "attachment" || item.kind === "media_reference") && item.target.mediaType === "image",
  );
  const hasText = items.some(item => item.kind === "text" && item.text.trim() !== "");
  if (hasImage) return hasText ? "text_and_image" : "image";
  return hasText ? "text" : "empty";
}

export function storyboardPresetInputIssue(
  preset: BuiltinCanvasImagePreset,
  prompt: StoryboardPromptInput,
  hasConnectedImage: boolean,
): string | null {
  const hasImage = hasConnectedImage || prompt === "image" || prompt === "text_and_image";
  const hasText = prompt === "text" || prompt === "text_and_image";
  if (preset.inputRequirement === "prompt" && !hasText) return `请填写「${preset.label}」的剧情描述。`;
  if (preset.inputRequirement === "image" && !hasImage) return `「${preset.label}」需要一张参考图。请上传或从画布引用。`;
  if (preset.inputRequirement === "prompt_or_image" && !hasText && !hasImage) return `请为「${preset.label}」填写描述或添加参考图。`;
  return null;
}

export function imagePresetOptionValues(preset: BuiltinCanvasImagePreset, saved?: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(preset.options.map(option => {
    const selected = option.values.find(value => value.value === saved?.[option.key]);
    const legacy = option.values.find(value => value.legacy && saved?.[value.legacy.key] === value.legacy.value);
    return [option.key, selected?.value ?? legacy?.value ?? option.default];
  }));
}

export function canvasImagePresetLabel(preset: BuiltinCanvasImagePreset, saved?: Readonly<Record<string, string>>): string {
  const values = imagePresetOptionValues(preset, saved);
  for (const option of preset.options) {
    const label = option.values.find(value => value.value === values[option.key])?.presetLabel;
    if (label) return label;
  }
  return preset.label;
}

const PARAMETER_KEYS = {
  ratio: ["ratio", "aspect_ratio"],
  resolution: ["resolution", "image_size"],
  quality: ["quality"],
} as const satisfies Readonly<Record<string, readonly string[]>>;

/** 分镜默认值在显示和提交时按实际操作的模型契约计算，移除预设后恢复普通模型默认值。 */
export function storyboardImageParameterValues(
  preset: BuiltinCanvasImagePreset | undefined,
  capabilities: readonly ModelParameterCapability[],
  parameterValues: Readonly<Record<string, ModelParameterValue>>,
  requestProfileId: unknown,
): Readonly<Record<string, ModelParameterValue>> {
  if (!preset) return parameterValues;
  const values = { ...parameterValues };
  const { ratio, resolution, quality } = preset.defaults;
  const hasSize = ["size", "ratio", "aspect_ratio", "resolution", "image_size"].some(key => key in values);
  if (!hasSize && ratio && resolution) {
    if (requestProfileId === GPT_IMAGE_25_PROFILE) {
      values["size"] = gptImage25Size({ aspect_ratio: ratio, resolution });
    } else if (requestProfileId === "moyu_seedream_image_v1" && values["layer_decomposition"] !== true) {
      const sizeRatio = SEEDREAM_PRO_RATIOS.find(value => value === ratio);
      const tier = SEEDREAM_PRO_RESOLUTIONS.find(value => value === resolution) ?? "2K";
      if (sizeRatio) values["size"] = seedreamProSize(tier, sizeRatio);
    }
  }
  const defaults: readonly { readonly keys: readonly string[]; readonly choices: readonly (string | undefined)[] }[] = [
    { keys: PARAMETER_KEYS.ratio, choices: [ratio] },
    { keys: [...PARAMETER_KEYS.resolution, "size"], choices: [resolution, "4K", "2K", "1.5K", "1K"] },
    { keys: PARAMETER_KEYS.quality, choices: [quality] },
  ];
  for (const { keys, choices } of defaults) {
    if (keys.some(key => key in values)) continue;
    for (const capability of capabilities) {
      if (!keys.includes(capability.key)) continue;
      const option = choices
        .map(choice => capability.options.find(item => String(item.value).toLowerCase() === choice?.toLowerCase()))
        .find(item => item != null);
      if (!option) continue;
      values[capability.key] = option.value;
      break;
    }
  }
  return values;
}

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
  const storyboard = canvasStoryboardPreset(preset.scene);
  if (storyboard) {
    // 旧版把预设默认值写进参数；切换时只移除仍由预设持有的值。
    for (const key of Object.keys(applied)) {
      delete values[key];
      delete applied[key];
    }
  }
  for (const [semantic, wanted] of Object.entries(storyboard ? {} : preset.defaults)) {
    const keys: readonly string[] | undefined = (PARAMETER_KEYS as Readonly<Record<string, readonly string[]>>)[semantic];
    const capability = capabilities.find(item => keys?.includes(item.key));
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
