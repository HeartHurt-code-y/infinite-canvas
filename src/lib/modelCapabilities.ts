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
  n: "生成数量",
  ratio: "画幅",
  resolution: "分辨率",
  duration: "时长",
  generate_audio: "生成音频",
  web_search: "联网搜索",
  output_format: "输出格式",
  priority: "执行优先级",
  omni_reference_task_type: "任务类型",
  task_type: "任务类型",
  aigc_watermark: "AIGC水印",
  seed: "随机种子",
  guidance_scale: "引导强度",
  negative_prompt: "反向提示词",
  watermark: "添加水印",
  aspect_ratio: "画幅",
  movement_amplitude: "运动幅度",
  style: "风格",
  audio: "生成音频",
  audio_type: "音频类型",
  off_peak: "闲时模式",
  bgm: "背景音乐",
  sequential_image_generation: "组图模式",
  max_images: "组图数量",
  optimize_prompt_mode: "提示词优化",
  background: "背景通道",
  layer_decomposition: "图层拆分",
};

const OPTION_LABELS: Readonly<Record<string, string>> = {
  adaptive: "自适应",
  standard: "标准",
  hd: "高清 HD",
  auto: "自动",
  high: "高",
  medium: "中",
  low: "低",
  small: "小",
  large: "大",
  general: "通用",
  anime: "动漫",
  reference: "参考生成",
  edit: "编辑",
  extend: "延长",
  generation: "生成",
  regeneration: "再生成",
  h3_context_ir: "智能扩写",
  "-1": "智能时长",
  disabled: "关闭",
  fast: "快速",
  jpeg: "JPEG",
  jpg: "JPG",
  png: "PNG",
  webp: "WEBP",
  url: "图片链接",
  b64_json: "Base64 数据",
  opaque: "实体背景",
  transparent: "透明背景",
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

/**
 * Doubao Seedream 图片生成模型（如 doubao-seedream-5-0-260128（moyu 文档推荐）/
 * doubao-seedream-4-5-251128 / doubao-seedream-5-0-pro-260628）：走 moyu OpenAI
 * Images API，但契约与 dall-e/gpt-image 不同——`size` 只接受 `2K` 及 ≥2K 的像素
 * 尺寸，`quality` 仅 `standard`/`hd`，并支持 watermark、response_format
 * （url/b64_json）、组图（sequential_image_generation）与输出格式
 * （output_format：jpg/png/webp）等专属参数。
 * 与视频模型 seedance 名称不同（seedream 不含 seedance），互不干扰。
 */
export function isSeedreamImageModel(modelId: string): boolean {
  return modelId.toLocaleLowerCase().includes("seedream");
}

type SeedreamImageVersion = "5.0" | "5.0-pro" | "5.0-lite" | "4.5" | "4.0" | "generic";

/** Seedream 能力版本：5.0（文档推荐，组图/输出格式）、5.0 pro（图层拆分/
 * 优化/输出格式/透明背景）、5.0 lite（组图/优化/联网搜索/输出格式）、
 * 4.5/4.0（组图）、其他按通用处理。 */
function seedreamImageVersion(modelId: string): SeedreamImageVersion | null {
  const normalized = modelId.toLocaleLowerCase();
  if (!normalized.includes("seedream")) return null;
  if (normalized.includes("seedream-5-0-pro") || normalized.includes("seedream-5.0-pro")) {
    return "5.0-pro";
  }
  if (normalized.includes("seedream-5-0-lite") || normalized.includes("seedream-5.0-lite")) {
    return "5.0-lite";
  }
  if (normalized.includes("seedream-5-0") || normalized.includes("seedream-5.0")) {
    return "5.0";
  }
  if (normalized.includes("seedream-4-5") || normalized.includes("seedream-4.5")) return "4.5";
  if (normalized.includes("seedream-4-0") || normalized.includes("seedream-4.0")) return "4.0";
  return "generic";
}

/** Seedream 基础参数：2K 契约尺寸、standard/hd 质量、水印开关（应用侧默认无水印，
 * 与后端一致）、返回格式（url/b64_json，默认内联 b64_json 以避免保存阶段再直连
 * 供应商的存储域名）。 */
function seedreamTextToImageBaseParameters(): Record<string, unknown> {
  return {
    size: {
      type: "string",
      label: "尺寸",
      default: "2K",
      enum: ["2K", "2048x2048", "2848x1600"],
      order: 0,
    },
    quality: {
      type: "string",
      label: "质量",
      default: "standard",
      enum: ["standard", "hd"],
      order: 1,
    },
    watermark: {
      type: "boolean",
      label: "添加水印",
      default: false,
      order: 2,
    },
    response_format: {
      type: "string",
      label: "返回格式",
      default: "b64_json",
      enum: ["url", "b64_json"],
      order: 9,
    },
  };
}

/** OpenAI Images 契约（`/v1/images/generations`）的返回格式参数。
 *  默认内联 `b64_json`：`url` 需要客户端再对供应商返回的存储地址发第二次请求，
 *  而该地址与生成接口的域名往往不同；内联结果不引入第二次连接。 */
function openaiImageResponseFormatParameter(): Record<string, unknown> {
  return {
    response_format: {
      type: "string",
      label: "返回格式",
      default: "b64_json",
      enum: ["url", "b64_json"],
      order: 3,
    },
  };
}

/** 按 Seedream 能力版本追加高级参数（与后端 model_schema 保持一致）。 */
function seedreamVersionParameters(
  version: SeedreamImageVersion,
  imageToImage: boolean,
): Record<string, unknown> {
  const parameters: Record<string, unknown> = {};
  if (version === "5.0" || version === "5.0-lite" || version === "4.5" || version === "4.0") {
    parameters["sequential_image_generation"] = {
      type: "string",
      label: "组图模式",
      default: "disabled",
      enum: ["disabled", "auto"],
      order: 3,
    };
    parameters["max_images"] = {
      type: "integer",
      label: "组图数量",
      optional: true,
      default: 4,
      minimum: 1,
      maximum: 15,
      order: 4,
    };
  }
  if (version === "5.0-pro" || version === "5.0-lite") {
    parameters["optimize_prompt_mode"] = {
      type: "string",
      label: "提示词优化",
      default: "fast",
      enum: ["fast", "standard"],
      order: 5,
    };
  }
  if (version === "5.0" || version === "5.0-pro" || version === "5.0-lite") {
    parameters["output_format"] = {
      type: "string",
      label: "输出格式",
      default: "jpg",
      enum: ["jpg", "png", "webp"],
      order: 6,
    };
  }
  if (version === "5.0-lite" && !imageToImage) {
    parameters["web_search"] = {
      type: "boolean",
      label: "联网搜索",
      default: false,
      requiresNoMedia: true,
      order: 7,
    };
  }
  if (version === "5.0-pro" && imageToImage) {
    parameters["background"] = {
      type: "string",
      label: "背景通道",
      default: "opaque",
      enum: ["opaque", "transparent"],
      order: 7,
    };
    parameters["layer_decomposition"] = {
      type: "boolean",
      label: "图层拆分",
      default: false,
      order: 8,
    };
  }
  return parameters;
}

function textToImageParameters(modelId: string): Record<string, unknown> {
  // Doubao Seedream 契约：2K 尺寸 / standard-hd 质量 / 水印 + 版本高级参数。
  if (isSeedreamImageModel(modelId)) {
    const version = seedreamImageVersion(modelId) ?? "generic";
    return {
      ...seedreamTextToImageBaseParameters(),
      ...seedreamVersionParameters(version, false),
    };
  }
  // Gemini 图片生成契约：size 只接受画幅比例（1:1/16:9/…），不声明 quality，
  // 且接口忽略 n（多张走任务拆分）。
  if (isGeminiImageModel(modelId)) {
    return {
      size: {
        type: "string",
        label: "尺寸",
        default: "1:1",
        enum: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"],
      },
    };
  }
  // gpt-image 系列（gpt-image-1/1.5/2 …）遵循 GPT Image 契约：
  // 质量只接受 auto/high/medium/low，尺寸只接受 auto 与三种标准尺寸，并声明生成数量 n；
  // 其余模型沿用通用文生图契约（standard/hd）。
  // 两者都声明返回格式并默认内联 b64_json，避免结果保存阶段再直连供应商存储域名。
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
      n: {
        type: "integer",
        label: "生成数量",
        default: 1,
        minimum: 1,
        maximum: 10,
      },
      ...openaiImageResponseFormatParameter(),
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
    ...openaiImageResponseFormatParameter(),
  };
}

/** gpt-image 系列图片编辑（multipart）接口：与文生图一样声明 n/size/quality。
 *  Seedream 走 JSON 图生图（/v1/images/generations），声明 2K 契约参数，
 *  5.0 pro 额外支持透明背景与图层拆分。
 *  Gemini 走 JSON 图生图（/v1/images/generations），参考图以顶层 `image`
 *  data URI 传入，声明画幅比例 `size`（与原生 imageConfig.aspectRatio 同义），
 *  不声明 quality，且接口忽略 n（多张走任务拆分）。 */
function imageToImageParameters(modelId: string): Record<string, unknown> {
  if (isSeedreamImageModel(modelId)) {
    const version = seedreamImageVersion(modelId) ?? "generic";
    return {
      ...seedreamTextToImageBaseParameters(),
      ...seedreamVersionParameters(version, true),
    };
  }
  if (isGeminiImageModel(modelId)) {
    return {
      size: {
        type: "string",
        label: "尺寸",
        default: "1:1",
        enum: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"],
      },
    };
  }
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
      n: {
        type: "integer",
        label: "生成数量",
        default: 1,
        minimum: 1,
        maximum: 10,
      },
    };
  }
  return {};
}

/** 是否万相 3.0 视频模型：支持首帧/首尾帧/参考图/参考视频/参考音频/文档(file)/网页(link) 素材角色。 */
export function isWan30VideoModel(modelId: string): boolean {
  const normalized = modelId.toLocaleLowerCase();
  return normalized.includes("wan3.0-video") || normalized.includes("wan3-0-video");
}

/** 万相 3.0 可分配给连接素材的媒体角色（文档 file / 网页 link 走 URL 输入，不在此列）。 */
export interface WanVideoMediaRoleOption {
  readonly value:
    "first_frame" | "last_frame" | "reference_image" | "reference_video" | "reference_audio";
  readonly label: string;
  readonly hint: string;
}

export const WAN_VIDEO_MEDIA_ROLE_OPTIONS: readonly WanVideoMediaRoleOption[] = [
  { value: "reference_image", label: "参考图", hint: "作为画面参考" },
  { value: "first_frame", label: "首帧", hint: "严格作为视频第一帧" },
  { value: "last_frame", label: "首尾帧", hint: "严格作为视频最后一帧" },
  { value: "reference_video", label: "参考视频", hint: "作为运动/风格参考" },
  { value: "reference_audio", label: "参考音频", hint: "作为配乐/音效参考" },
];

/** 按素材类型给出可用的万相角色；文档/网页用 URL 输入表达，不占用连接素材角色。 */
export function wanMediaRolesForKind(
  kind: "image" | "video" | "audio",
): readonly WanVideoMediaRoleOption[] {
  if (kind === "video") {
    return WAN_VIDEO_MEDIA_ROLE_OPTIONS.filter((option) => option.value === "reference_video");
  }
  if (kind === "audio") {
    return WAN_VIDEO_MEDIA_ROLE_OPTIONS.filter((option) => option.value === "reference_audio");
  }
  return WAN_VIDEO_MEDIA_ROLE_OPTIONS.filter(
    (option) =>
      option.value === "reference_image" ||
      option.value === "first_frame" ||
      option.value === "last_frame",
  );
}

/** gpt-image 系列遵循 GPT Image 契约（n/size/quality），与后端模型档案保持一致。 */
export function isGptImageModel(modelId: string): boolean {
  return modelId.toLocaleLowerCase().includes("gpt-image");
}

/**
 * Gemini 图片生成模型（如 gemini-2.5-flash-image / gemini-3-pro-image-preview）：
 * 走 OpenAI Images API，`size` 只接受画幅比例（1:1/16:9/…），不声明 quality，
 * 且上游忽略 `n`（一次只返回一张，多张由业务侧并发拆分任务）。
 */
export function isGeminiImageModel(modelId: string): boolean {
  const normalized = modelId.toLocaleLowerCase();
  return normalized.includes("gemini") && normalized.split(/[^a-z0-9]+/).includes("image");
}

function isSeedance20VideoModel(modelId: string): boolean {
  const normalized = modelId.toLocaleLowerCase();
  return normalized.includes("seedance-2-0") || normalized.includes("seedance-2.0");
}

export function isSeedance25VideoModel(modelId: string): boolean {
  const normalized = modelId.toLocaleLowerCase();
  return normalized.includes("seedance-2-5") || normalized.includes("seedance-2.5");
}

function isDreaminaSeedanceVideoModel(modelId: string): boolean {
  return modelId.toLocaleLowerCase().includes("dreamina-seedance");
}

/** Veo 系列（Google Veo）：veo-3 / veo-3-fast / veo-3.1 / veo-3.1-fast。 */
export function isVeoVideoModel(modelId: string): boolean {
  const normalized = modelId.toLocaleLowerCase();
  return normalized.split(/[^a-z0-9]+/).includes("veo");
}

/**
 * Vidu 系列（魔芋AI 聚合平台）：vidu2.0 / viduq1 / viduq3-pro / viduq3-turbo。
 * 生成模式由图片数量自动判定（1 张=图生、2 张=首尾帧、≥3 张=参考图），
 * 不支持参考视频/音频输入；分辨率受模型白名单前置校验。
 */
export function isViduVideoModel(modelId: string): boolean {
  const normalized = modelId.toLocaleLowerCase();
  return (
    normalized.split(/[^a-z0-9]+/).includes("vidu") ||
    normalized.includes("vidu2.0") ||
    normalized.includes("viduq1") ||
    normalized.includes("viduq3")
  );
}

/**
 * MiniMax-H3（魔芋平台新一代视频生成模型）：`MiniMax-H3`。
 * 分辨率取 `768P`/`2K`；画幅支持 adaptive/21:9/16:9/4:3/1:1/3:4/9:16；
 * 时长 4-15 秒；`aigc_watermark` 控制 AIGC 水印；`metadata.task_type` 区分
 * 文生/图生/参考生成（generation）与 768P→2K 再生成（regeneration）。
 * 媒体角色与万相 3.0 相同（first_frame/last_frame/reference_image/
 * reference_video/reference_audio），由后端请求体映射到 metadata。
 */
export function isMinimaxH3VideoModel(modelId: string): boolean {
  const normalized = modelId.toLocaleLowerCase();
  return (
    normalized.includes("minimax-h3") ||
    normalized.includes("minimax_h3") ||
    normalized.includes("minimax h3")
  );
}

function videoParameters(modelId: string): Record<string, unknown> {
  const normalized = modelId.toLocaleLowerCase();
  const minimaxH3 = isMinimaxH3VideoModel(normalized);
  if (minimaxH3) {
    // MiniMax-H3（魔芋平台新一代视频生成模型）：duration/resolution/ratio/
    // aigc_watermark 为顶层字段；task_type 归入 metadata。
    // task_type=regeneration（再生成）时连接的源视频作为 base_video_url，
    // 输出时长由源视频决定（后端忽略 duration）。
    return {
      task_type: {
        type: "string",
        label: "任务类型",
        default: "generation",
        enum: ["generation", "regeneration", "h3_context_ir"],
        order: 0,
      },
      resolution: {
        type: "string",
        label: "分辨率",
        default: "2K",
        enum: ["768P", "2K"],
        order: 1,
      },
      ratio: {
        type: "string",
        label: "画幅",
        default: "adaptive",
        enum: ["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
        order: 2,
      },
      duration: {
        type: "integer",
        label: "时长",
        default: 5,
        enum: Array.from({ length: 12 }, (_, index) => index + 4),
        order: 3,
      },
      aigc_watermark: {
        type: "boolean",
        label: "AIGC水印",
        default: false,
        order: 4,
      },
    };
  }
  const vidu = isViduVideoModel(normalized);
  if (vidu) {
    // Vidu 系列：resolution 受模型白名单约束（vidu2.0=360p/720p/1080p、
    // viduq1=仅 1080p、viduq3-pro/viduq3-turbo=540p/720p/1080p）；画幅支持
    // 16:9/9:16/1:1/3:4/4:3；时长 1-16 秒；seed 传 -1/0 表示随机。
    // movement_amplitude/style/audio/audio_type/off_peak/bgm 由后端归入 metadata。
    const defaultResolution = normalized.includes("viduq1") ? "1080p" : "720p";
    const resolutions = normalized.includes("vidu2.0")
      ? ["360p", "720p", "1080p"]
      : normalized.includes("viduq1")
        ? ["1080p"]
        : ["540p", "720p", "1080p"];
    return {
      resolution: {
        type: "string",
        label: "分辨率",
        default: defaultResolution,
        enum: resolutions,
        order: 0,
      },
      aspect_ratio: {
        type: "string",
        label: "画幅",
        default: "16:9",
        enum: ["16:9", "9:16", "1:1", "3:4", "4:3"],
        order: 1,
      },
      duration: {
        type: "integer",
        label: "时长",
        default: 5,
        enum: Array.from({ length: 16 }, (_, index) => index + 1),
        order: 2,
      },
      seed: {
        type: "integer",
        label: "随机种子",
        optional: true,
        minimum: -1,
        maximum: 4_294_967_295,
        order: 3,
      },
      watermark: {
        type: "boolean",
        label: "添加水印",
        default: false,
        order: 4,
      },
      movement_amplitude: {
        type: "string",
        label: "运动幅度",
        default: "auto",
        enum: ["auto", "small", "medium", "large"],
        order: 5,
      },
      style: {
        type: "string",
        label: "风格",
        default: "general",
        enum: ["general", "anime"],
        order: 6,
      },
      audio: {
        type: "boolean",
        label: "生成音频",
        default: true,
        order: 7,
      },
      audio_type: {
        type: "string",
        label: "音频类型",
        optional: true,
        order: 8,
      },
      off_peak: {
        type: "boolean",
        label: "闲时模式",
        default: false,
        order: 9,
      },
      bgm: {
        type: "boolean",
        label: "背景音乐",
        default: false,
        order: 10,
      },
    };
  }
  const veo = isVeoVideoModel(normalized);
  if (veo) {
    // Veo（Google Veo）：resolution 必填；1080p 仅支持 8 秒时长；
    // 画幅只支持 16:9 / 9:16；negativePrompt/sampleCount/enhancePrompt/seed
    // 由后端归入 metadata。
    return {
      resolution: {
        type: "string",
        label: "分辨率",
        default: "720p",
        enum: ["720p", "1080p"],
        order: 0,
      },
      aspect_ratio: {
        type: "string",
        label: "画幅",
        default: "16:9",
        enum: ["16:9", "9:16"],
        order: 1,
      },
      duration: {
        type: "integer",
        label: "时长",
        default: 8,
        enum: [4, 6, 8],
        order: 2,
      },
      negativePrompt: {
        type: "string",
        label: "反向提示词",
        optional: true,
        order: 3,
      },
      sampleCount: {
        type: "integer",
        label: "单次生成数",
        default: 1,
        minimum: 1,
        maximum: 4,
        order: 4,
      },
      enhancePrompt: {
        type: "boolean",
        label: "提示词优化",
        default: true,
        order: 5,
      },
      seed: {
        type: "integer",
        label: "随机种子",
        optional: true,
        minimum: 0,
        maximum: 4_294_967_295,
        order: 6,
      },
    };
  }
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
      ? [-1, ...Array.from({ length: 12 }, (_, index) => index + 4)]
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
        return [operation, { resultType: "image", parameters: imageToImageParameters(modelId) }];
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
  if (operation === "image_to_image") return imageToImageParameters(modelId);
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
  // 升级前保存的 Wan / 海外 Dreamina Seedance / Veo / Vidu / gpt-image / Gemini 图片
  // 定义带有显式 `parameters: {}`；通用模型仍把空对象视为权威声明，但这些已知契约
  // 需要立即回退到当前档案，避免节点参数区空白。
  const effectiveParameters =
    (isWan30VideoModel(modelId) ||
      isVeoVideoModel(modelId) ||
      isViduVideoModel(modelId) ||
      isMinimaxH3VideoModel(modelId) ||
      isGptImageModel(modelId) ||
      isGeminiImageModel(modelId) ||
      isSeedreamImageModel(modelId) ||
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

/** 模型是否支持批量数量参数 `n`：支持时一次请求生成多张，不再拆分多个独立任务。 */
export function modelSupportsBatchCount(
  operationSchema: ModelOperationSchema,
  operation: GenerationOperation,
  modelId: string,
): boolean {
  return modelParameterCapabilities(operationSchema, operation, modelId).some(
    (capability) => capability.key === "n" && capability.type === "integer",
  );
}

/** 模型声明的批量数量上限；模型不支持 `n` 时回退到 fallback（沿用任务拆分上限）。 */
export function modelGenerationCountMaximum(
  operationSchema: ModelOperationSchema,
  operation: GenerationOperation,
  modelId: string,
  fallback: number,
): number {
  const capability = modelParameterCapabilities(operationSchema, operation, modelId).find(
    (item) => item.key === "n" && item.type === "integer",
  );
  return capability?.maximum ?? fallback;
}
