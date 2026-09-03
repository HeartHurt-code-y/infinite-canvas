import type { GenerationOperation, ModelOperationSchema } from "./backend";

export type ModelParameterValue = string | number | boolean;

export interface ModelParameterOption {
  readonly value: ModelParameterValue;
  readonly label: string;
}

export interface ModelParameterCapability {
  readonly key: string;
  readonly label: string;
  readonly type: "string" | "integer" | "number" | "boolean";
  readonly defaultValue: ModelParameterValue;
  readonly options: readonly ModelParameterOption[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly step?: number;
  readonly optional: boolean;
  readonly requiresNoMedia: boolean;
  readonly order: number;
}

const PARAMETER_LABELS: Readonly<Record<string, string>> = {
  size: "尺寸",
  quality: "质量",
  ratio: "画幅",
  resolution: "分辨率",
  duration: "时长",
  generate_audio: "生成音频",
  web_search: "联网搜索",
  output_format: "输出格式",
  priority: "执行优先级",
  omni_reference_task_type: "任务类型",
  seed: "随机种子",
  guidance_scale: "引导强度",
  negative_prompt: "反向提示词",
  watermark: "添加水印",
};

const OPTION_LABELS: Readonly<Record<string, string>> = {
  adaptive: "自适应",
  standard: "标准",
  hd: "高清 HD",
  auto: "自动",
  high: "高",
  medium: "中",
  low: "低",
  reference: "参考生成",
  edit: "编辑",
  extend: "延长",
  "-1": "智能时长",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isParameterValue(value: unknown): value is ModelParameterValue {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function optionLabel(value: ModelParameterValue, key: string): string {
  const raw = String(value);
  if (OPTION_LABELS[raw]) return OPTION_LABELS[raw];
  if (key === "duration" && typeof value === "number") return `${value} 秒`;
  if (key === "size") return raw.replace("x", " × ");
  return raw;
}

function parameterLabel(key: string, schema: Record<string, unknown>): string {
  const label = schema["label"];
  if (typeof label === "string" && label.trim()) return label.trim();
  return PARAMETER_LABELS[key] ?? key.replaceAll("_", " ");
}

function rawOptions(key: string, schema: Record<string, unknown>): readonly ModelParameterOption[] {
  const values = Array.isArray(schema["enum"])
    ? schema["enum"]
    : Array.isArray(schema["options"])
      ? schema["options"]
      : [];
  return values.flatMap((item) => {
    if (isParameterValue(item)) {
      return [{ value: item, label: optionLabel(item, key) }];
    }
    if (!isRecord(item) || !isParameterValue(item["value"])) return [];
    const value = item["value"];
    const label =
      typeof item["label"] === "string" && item["label"].trim()
        ? item["label"].trim()
        : optionLabel(value, key);
    return [{ value, label }];
  });
}

function defaultForType(type: ModelParameterCapability["type"]): ModelParameterValue {
  if (type === "boolean") return false;
  if (type === "integer" || type === "number") return 0;
  return "";
}

function parameterCapability(
  key: string,
  value: unknown,
  fallback: unknown,
  index: number,
): ModelParameterCapability | null {
  if (!isRecord(value)) return null;
  const fallbackSchema = isRecord(fallback) ? fallback : {};
  const merged = { ...fallbackSchema, ...value };
  const rawType = merged["type"];
  const type =
    rawType === "boolean" || rawType === "integer" || rawType === "number" ? rawType : "string";
  const options = rawOptions(key, merged);
  const declaredDefault = merged["default"];
  const optional = merged["optional"] === true;
  const defaultValue = isParameterValue(declaredDefault)
    ? declaredDefault
    : optional
      ? ""
      : (options[0]?.value ?? defaultForType(type));
  return {
    key,
    label: parameterLabel(key, merged),
    type,
    defaultValue,
    options,
    optional,
    requiresNoMedia: merged["requiresNoMedia"] === true,
    order: typeof merged["order"] === "number" ? merged["order"] : index,
    ...(typeof merged["minimum"] === "number" ? { minimum: merged["minimum"] } : {}),
    ...(typeof merged["maximum"] === "number" ? { maximum: merged["maximum"] } : {}),
    ...(typeof merged["step"] === "number" ? { step: merged["step"] } : {}),
  };
}

function textToImageParameters(modelId: string): Record<string, unknown> {
  // gpt-image 系列（gpt-image-1/1.5/2 …）遵循 GPT Image 契约：
  // 质量只接受 auto/high/medium/low，尺寸只接受 auto 与三种标准尺寸；
  // 其余模型沿用通用文生图契约（standard/hd）。
  if (modelId.toLocaleLowerCase().includes("gpt-image")) {
    return {
      size: {
        type: "string",
        label: "尺寸",
        default: "auto",
        enum: ["auto", "1024x1024", "1536x1024", "1024x1536"],
      },
      quality: {
        type: "string",
        label: "质量",
        default: "auto",
        enum: ["auto", "high", "medium", "low"],
      },
    };
  }
  return {
    size: {
      type: "string",
      label: "尺寸",
      default: "1024x1024",
      enum: ["256x256", "512x512", "1024x1024", "1536x1024", "1024x1536", "1792x1024", "1024x1792"],
    },
    quality: {
      type: "string",
      label: "质量",
      default: "standard",
      enum: ["hd", "standard"],
    },
  };
}

function isWan30VideoModel(modelId: string): boolean {
  const normalized = modelId.toLocaleLowerCase();
  return normalized.includes("wan3.0-video") || normalized.includes("wan3-0-video");
}

function isSeedance20VideoModel(modelId: string): boolean {
  const normalized = modelId.toLocaleLowerCase();
  return normalized.includes("seedance-2-0") || normalized.includes("seedance-2.0");
}

function isSeedance25VideoModel(modelId: string): boolean {
  const normalized = modelId.toLocaleLowerCase();
  return normalized.includes("seedance-2-5") || normalized.includes("seedance-2.5");
}

function isDreaminaSeedanceVideoModel(modelId: string): boolean {
  return modelId.toLocaleLowerCase().includes("dreamina-seedance");
}

function videoParameters(modelId: string): Record<string, unknown> {
  const normalized = modelId.toLocaleLowerCase();
  const wan30 = isWan30VideoModel(normalized);
  if (wan30) {
    return {
      resolution: {
        type: "string",
        label: "分辨率",
        default: "1080P",
        enum: ["480P", "720P", "1080P"],
        order: 0,
      },
      ratio: {
        type: "string",
        label: "画幅",
        default: "adaptive",
        enum: ["adaptive", "16:9", "4:3", "1:1", "3:4", "9:16"],
        order: 1,
      },
      duration: {
        type: "integer",
        label: "时长",
        default: 5,
        enum: [-1, ...Array.from({ length: 29 }, (_, index) => index + 2)],
        order: 2,
      },
      seed: {
        type: "integer",
        label: "随机种子",
        optional: true,
        minimum: 0,
        maximum: 2_147_483_647,
        order: 3,
      },
      watermark: {
        type: "boolean",
        label: "添加水印",
        default: false,
        order: 4,
      },
    };
  }
  const seedance25 = isSeedance25VideoModel(normalized);
  const seedance20 = isSeedance20VideoModel(normalized);
  if (!seedance20 && !seedance25) return {};
  const dreamina = isDreaminaSeedanceVideoModel(normalized);
  const mini = normalized.includes("mini");
  const fast = normalized.includes("fast");
  const durations = seedance25
    ? [-1, ...Array.from({ length: 27 }, (_, index) => index + 4)]
    : seedance20
      ? Array.from({ length: 12 }, (_, index) => index + 4)
      : [5, 8, 12];
  // 海外 Dreamina Seedance 仅开放 720p/480p；国内 Seedance 2.5 官方全平台
  // 支持 1080p（文档曾前后矛盾，现已确认），2.5 的 fast/mini 变体保持 720p/480p。
  const resolutions = dreamina
    ? ["720p", "480p"]
    : seedance25
      ? fast || mini
        ? ["720p", "480p"]
        : ["720p", "480p", "1080p"]
      : seedance20
        ? ["720p", "480p", "1080p", "4k"]
        : ["720p", "480p", "1080p"];
  const parameters: Record<string, unknown> = {
    ratio: {
      type: "string",
      label: "画幅",
      default: "adaptive",
      enum: ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"],
    },
    resolution: {
      type: "string",
      label: "分辨率",
      default: "720p",
      enum: resolutions,
    },
    duration: {
      type: "integer",
      label: "时长",
      default: seedance25 ? -1 : seedance20 ? 5 : 8,
      enum: durations,
    },
    generate_audio: {
      type: "boolean",
      label: "生成音频",
      default: true,
    },
  };
  // 联网搜索：Seedance 2.0 标准版，以及全部 Seedance 2.5（国内与海外）均支持，
  // 仅在无媒体输入的文生视频场景启用。
  if ((seedance20 && !mini) || seedance25) {
    parameters["web_search"] = {
      type: "boolean",
      label: "联网搜索",
      default: false,
      requiresNoMedia: true,
    };
  }
  if (seedance25) {
    parameters["output_format"] = {
      type: "string",
      label: "输出格式",
      default: "mp4",
      enum: ["mp4", "mov"],
    };
    if (dreamina) {
      parameters["priority"] = {
        type: "integer",
        label: "执行优先级",
        default: 0,
        minimum: 0,
        maximum: 9,
      };
    } else {
      parameters["omni_reference_task_type"] = {
        type: "string",
        label: "任务类型",
        default: "auto",
        enum: ["auto", "reference", "edit", "extend"],
      };
    }
  }
  return parameters;
}

export function defaultModelOperationSchema(
  modelId: string,
  operations: readonly GenerationOperation[],
): ModelOperationSchema {
  return Object.fromEntries(
    operations.map((operation) => {
      if (operation === "text_to_image") {
        return [operation, { resultType: "image", parameters: textToImageParameters(modelId) }];
      }
      if (operation === "image_to_image") {
        return [operation, { resultType: "image", parameters: {} }];
      }
      if (operation === "text_generation") {
        return [operation, { resultType: "text", parameters: {} }];
      }
      const wan30 = isWan30VideoModel(modelId);
      return [
        operation,
        {
          resultType: "video",
          parameters: videoParameters(modelId),
          ...(wan30 ? { request: { promptMode: "prompt_or_media" } } : {}),
        },
      ];
    }),
  );
}

export function modelAllowsMediaOnlyPrompt(
  operationSchema: ModelOperationSchema,
  operation: GenerationOperation,
): boolean {
  const operationDefinition = operationSchema[operation];
  if (!isRecord(operationDefinition)) return false;
  const request = operationDefinition["request"];
  return isRecord(request) && request["promptMode"] === "prompt_or_media";
}

function fallbackParameters(
  modelId: string,
  operation: GenerationOperation,
): Record<string, unknown> {
  if (operation === "text_to_image") return textToImageParameters(modelId);
  if (operation === "video_generation") return videoParameters(modelId);
  return {};
}

export function modelParameterCapabilities(
  operationSchema: ModelOperationSchema,
  operation: GenerationOperation,
  modelId: string,
): readonly ModelParameterCapability[] {
  const operationValue = operationSchema[operation];
  const operationDefinition = isRecord(operationValue) ? operationValue : null;
  const declaredParameters = operationDefinition?.["parameters"];
  if (!isRecord(declaredParameters)) {
    if (operationDefinition) return [];
    const fallback = fallbackParameters(modelId, operation);
    return Object.entries(fallback)
      .flatMap(([key, value], index) => parameterCapability(key, value, undefined, index) ?? [])
      .sort((left, right) => left.order - right.order);
  }

  const fallback = fallbackParameters(modelId, operation);
  // 升级前保存的 Wan / 海外 Dreamina Seedance 定义带有显式
  // `parameters: {}`；通用模型仍把空对象视为权威声明，但这两个已知契约需要
  // 立即回退到当前档案，避免节点参数区空白。
  const effectiveParameters =
    (isWan30VideoModel(modelId) ||
      (isDreaminaSeedanceVideoModel(modelId) && Object.keys(fallback).length > 0)) &&
    Object.keys(declaredParameters).length === 0
      ? fallback
      : declaredParameters;
  return Object.entries(effectiveParameters)
    .flatMap(([key, value], index) => parameterCapability(key, value, fallback[key], index) ?? [])
    .sort((left, right) => left.order - right.order);
}

function matchesCapability(
  value: unknown,
  capability: ModelParameterCapability,
): value is ModelParameterValue {
  if (!isParameterValue(value)) return false;
  if (capability.type === "boolean" && typeof value !== "boolean") return false;
  if (
    (capability.type === "integer" || capability.type === "number") &&
    typeof value !== "number"
  ) {
    return false;
  }
  if (capability.type === "integer" && typeof value === "number" && !Number.isInteger(value)) {
    return false;
  }
  if (
    capability.options.length > 0 &&
    !capability.options.some((option) => option.value === value)
  ) {
    return false;
  }
  if (typeof value === "number" && capability.minimum != null && value < capability.minimum) {
    return false;
  }
  if (typeof value === "number" && capability.maximum != null && value > capability.maximum) {
    return false;
  }
  return true;
}

export function resolvedParameterValue(
  capability: ModelParameterCapability,
  values: Readonly<Record<string, ModelParameterValue>>,
): ModelParameterValue {
  const value = values[capability.key];
  return matchesCapability(value, capability) ? value : capability.defaultValue;
}

export function generationParameters(
  capabilities: readonly ModelParameterCapability[],
  values: Readonly<Record<string, ModelParameterValue>>,
  hasMediaInputs: boolean,
): Record<string, ModelParameterValue> {
  return Object.fromEntries(
    capabilities.flatMap((capability) => {
      if (capability.requiresNoMedia && hasMediaInputs) return [];
      if (capability.optional) {
        const value = values[capability.key];
        return matchesCapability(value, capability) ? [[capability.key, value]] : [];
      }
      return [[capability.key, resolvedParameterValue(capability, values)]];
    }),
  );
}
