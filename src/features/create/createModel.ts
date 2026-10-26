/*
 * 创作台（独立入口 · 极简模式）的纯逻辑层。
 *
 * 这一层只做三件事，不碰 React：
 *   1. 入口判定：同一个前端产物既可以是画布工作台，也可以是独立的极简创作台。
 *   2. 状态机：把后端任务状态翻译成「界面上该显示哪一种形态」。
 *   3. 展示口径：提示词、比例、分辨率在卡片与工具条上怎么写。
 *
 * 视觉与交互规格来自对即梦 AI 创作页的逆向（见 docs/或分析归档）：
 *   - 底部固定浮坞：参考图条 + 提示词 + 参数工具条 + 圆形提交钮；
 *   - 结果流用骨架占位（最多 4 张），成功后再换成成品；
 *   - 失败时给的是「发生了什么 + 接下来怎么办」，而不是原始 payload。
 * 数据层仍然走本项目自有 API（generationClient / providerCatalog），
 * 不复用被逆向方的任何端点或签名。
 */
import type { GenerationOperation, GenerationTaskStatus } from "../../lib/backend";
import type { ModelParameterCapability, ModelParameterValue } from "../../lib/modelCapabilities";

/* ── 入口 ───────────────────────────────────────────────────────────── */

/** URL 查询参数：`?view=create` 直达创作台（浏览器预览与开发都用它）。 */
export const CREATE_ENTRY_PARAM = "view";
/** URL 查询参数的取值。 */
export const CREATE_ENTRY_VALUE = "create";
/** 独立窗口的标签名：Tauri 窗口 label 为 create 时同样进入创作台。 */
export const CREATE_WINDOW_LABEL = "create";
/** 创作台专用的画布标识：任务历史按它归档，独立于任何一张画布文档。 */
export const CREATE_CANVAS_ID = "create-surface";
/** 创作台专用的来源节点标识。 */
export const CREATE_SOURCE_NODE_ID = "create-surface";

export type AppEntry = "studio" | "create";

/**
 * 判定当前应该进入哪个入口。
 *
 * 优先级：URL 查询参数 > hash > Tauri 窗口标签。
 * 三条通道都要留：开发态走 localhost:1420 只能靠 URL；打包后没有地址栏，
 * 独立窗口只能靠 label；而浏览器里手动改 hash 是最快的调试入口。
 */
export function resolveAppEntry(
  location: { readonly search: string; readonly hash: string },
  windowLabel: string | null,
): AppEntry {
  const params = new URLSearchParams(location.search);
  if (params.get(CREATE_ENTRY_PARAM) === CREATE_ENTRY_VALUE) return "create";
  if (location.hash.replace(/^#/, "") === CREATE_ENTRY_VALUE) return "create";
  if (windowLabel === CREATE_WINDOW_LABEL) return "create";
  return "studio";
}

/* ── 创作类型 ───────────────────────────────────────────────────────── */

export interface CreateModeDescriptor {
  readonly id: CreateModeId;
  readonly label: string;
  /** 该模式对应的生成操作；一个操作可服务多个模式（例如文生图与图生图）。 */
  readonly operation: GenerationOperation;
  /** 是否允许带参考素材（图生图 / 参考生视频）。 */
  readonly supportsReference: boolean;
}

export type CreateModeId = "image" | "video" | "text" | "speech";

/** 兜底模式：模式表被改动或传入未知值时，仍要有一个能用的操作。 */
const FALLBACK_MODE: CreateModeDescriptor = {
  id: "image",
  label: "图片生成",
  operation: "text_to_image",
  supportsReference: true,
};

/**
 * 创作类型只保留本项目后端真正支持的四种。
 * 即梦有七种（还有音乐、数字人、动作模仿），那些要么没有对应后端能力，
 * 要么属于另一个子系统，硬凑只会做出一个点了就报错的下拉。
 */
export const CREATE_MODES: readonly CreateModeDescriptor[] = [
  { id: "image", label: "图片生成", operation: "text_to_image", supportsReference: true },
  { id: "video", label: "视频生成", operation: "video_generation", supportsReference: true },
  { id: "text", label: "文本生成", operation: "text_generation", supportsReference: false },
  { id: "speech", label: "音频生成", operation: "speech_generation", supportsReference: false },
];

export function createModeById(id: CreateModeId): CreateModeDescriptor {
  const found = CREATE_MODES.find((mode) => mode.id === id);
  return found ?? FALLBACK_MODE;
}

/* ── 状态机 ─────────────────────────────────────────────────────────── */

/**
 * 一条生成记录在界面上的四种形态。
 *
 * 对齐即梦创作页的 `standardBodyVariant`：成功 → 成品；失败 → 报错条；
 * 其余 → 生成中。排队单独成形态，因为排队与生成中的文案不同。
 */
export type CreateRecordVariant = "media" | "failed" | "loading" | "relax-queue";

/**
 * 后端任务状态 → 界面形态。
 *
 * 任务状态枚举：created / submitting / retry_wait / queued / running /
 * succeeded / failed / unknown / interrupted。
 * 其中 retry_wait（等待重试）仍然是进行中，只是要提示用户「正在重试」，
 * 不能当失败渲染——否则用户会以为白等了。
 *
 * **unknown 必须按失败形态渲染**：它是终态（`isLiveStatus` 不含它 → 轮询会停），
 * 含义是「请求已发出但回执不明、可能已计费」。之前它落进 loading 分支，
 * 于是创作台显示「生成中...」的骨架屏**永远转下去**（轮询早已停止），
 * 用户既看不到「结果未知」，也无法判断该不该重试 → 反而更想再点一次 → 重复扣费。
 */
export function resolveRecordVariant(
  status: GenerationTaskStatus | null | undefined,
): CreateRecordVariant {
  switch (status) {
    case "succeeded":
      return "media";
    case "failed":
    case "interrupted":
    // 取消是终态、且没有产物：按失败形态渲染，但文案由记录卡单独区分。
    // 漏掉这个分支会让本函数在 strict 模式下不满足返回类型（TS2366），直接编译失败。
    case "cancelled":
    // 结果未知（可能已计费）：按失败形态渲染，文案单独区分 —— 见 CreateRecordList。
    case "unknown":
      return "failed";
    case "queued":
      return "relax-queue";
    case "created":
    case "submitting":
    case "retry_wait":
    case "running":
    case null:
    case undefined:
      return "loading";
  }
}

/** 生成中骨架占位的张数：最多 4 张，且不超过本次任务应有的产物数。 */
export function placeholderCount(total: number, finished: number): number {
  // 产物数还没拿到时先占一位，让用户看到「在动了」而不是一片空白。
  if (total <= 0) return 1;
  return Math.min(4, Math.max(0, total - finished));
}

/** 任务是否仍在进行中（用于决定是否继续轮询）。 */
export function isLiveStatus(status: GenerationTaskStatus | null | undefined): boolean {
  return (
    status === "created" ||
    status === "submitting" ||
    status === "queued" ||
    status === "running" ||
    status === "retry_wait"
  );
}

/* ── 提示文案 ───────────────────────────────────────────────────────── */

/**
 * 创作台的固定文案。
 *
 * 这些句子取自即梦创作页实测到的真实反馈文案，它们解决的是同一类问题：
 * 用户在等结果的时候，需要知道「系统还在动」「还要等多久」「失败了我该做什么」。
 */
export const CREATE_COPY = {
  submitting: "造梦中",
  queued: "排队中，请稍候...",
  queuedPosition: (position: number, total: number) => `当前排队 ${position}/${total} 位。`,
  generating: (finished: number, total: number) =>
    total > 0 ? `（${finished}/${total}）生成中...` : "生成中...",
  retrying: "本次请求失败，正在自动重试...",
  emptyTitle: "开启你的新创作",
  emptyHint: "输入想法、上传参考，或从「技能」开始。",
  referenceTileLabel: "参考内容",
  moderationFailed: "内容审核失败。请替换此参考并重试。",
  /*
   * 失败提示不能承诺「不消耗积分」。
   *
   * 后端没有积分/退款链路（Rust 侧全仓检索 refund/credit 零命中），
   * 而失败可能发生在供应商**已经计费之后**（例如生成成功、只是本地落盘失败）。
   * 这里给出一个系统兑现不了的承诺，会让用户据此放心重试 → 真实重复扣费。
   */
  creditsRefunded: "生成失败，可重新生成。",
  failedTitle: "生成失败",
  /*
   * 「结果未知」的专用标题与提示。
   *
   * unknown 是终态，含义是「请求已发出、但没拿到可用回执」——供应商侧**可能已计费**。
   * 这时若只说「生成失败，可重新生成」，用户会放心地再点一次 → 真实重复扣费；
   * 若说「生成中」又会让骨架屏永远转下去。所以要说清三件事：结果未知、
   * 可能已计费、先去核对再决定要不要重试。
   *
   * 标题自己就要带上「可能已计费」：它是卡片上最先被读到的那一行。
   * 只写「结果未知」的话，用户仍会把它读成普通失败 → 顺手再点一次生成 → 重复扣费。
   * （这张标题之前是死文案：定义了就没人用，unknown 卡片只有一段长提示、没有标题。）
   */
  unknownResultTitle: "结果未知（可能已计费）",
  unknownResultHint:
    "请求已发送，但没有拿到可用回执，供应商可能已经计费。请先到供应商后台确认这次请求的结果，再决定是否重新生成。",
  noModelHint: "先在设置里接入一个供应商并保存模型，才能开始生成。",
  noPromptHint: "先输入提示词或添加参考素材。",
} as const;

/**
 * 普通浮坞的占位文案（**按创作类型分档**）。
 *
 * 即梦活体实测（2026-10-22，登录态）：
 *   · 图片档 `?type=image`：
 *     「上传参考图、输入文字或【主体】，描述你想生成的图片。」
 *     —— 芯片是「主体」，点开是那块 240 宽的主体选择器。
 *   · 视频档 `?type=video`：
 *     「上传最多12个参考素材、输入文字或【参考内容】，自由组合图、文、音、视频多元素，
 *      定义精彩互动。例如：@图片1 模仿 @视频1 的动作，音色参考 @音频1。」
 *     —— 芯片是「参考内容」，点开是素材库。
 *
 * 本地原先只有视频档那一句，图片档也用它，对不上。
 */
export interface ComposerPlaceholder {
  /** 芯片之前的文案。 */
  readonly before: string;
  /** 芯片上的文字（即梦：图片档「主体」、视频档「参考内容」）。 */
  readonly chip: string;
  /** 芯片之后的文案。 */
  readonly after: string;
}

export const COMPOSER_PLACEHOLDER: Readonly<Record<CreateModeId, ComposerPlaceholder>> = {
  image: {
    before: "上传参考图、输入文字或",
    chip: "主体",
    after: "，描述你想生成的图片。",
  },
  video: {
    before: "上传最多12个参考素材、输入文字或",
    chip: "参考内容",
    after:
      "，自由组合图、文、音、视频多元素，定义精彩互动。例如：@图片1 模仿 @视频1 的动作，音色参考 @音频1。",
  },
  text: {
    before: "上传最多12个参考素材、输入文字或",
    chip: "参考内容",
    after:
      "，自由组合图、文、音、视频多元素，定义精彩互动。例如：@图片1 模仿 @视频1 的动作，音色参考 @音频1。",
  },
  speech: {
    before: "上传最多12个参考素材、输入文字或",
    chip: "参考内容",
    after:
      "，自由组合图、文、音、视频多元素，定义精彩互动。例如：@图片1 模仿 @视频1 的动作，音色参考 @音频1。",
  },
};

/** 生成结果的失败原因里带审核字样时，提示用户换素材而不是改提示词。 */
export function isModerationFailure(detail: string | null | undefined): boolean {
  if (!detail) return false;
  return /审核|违规|不合规|review|audit|moderation/i.test(detail);
}

/* ── 比例与像素 ─────────────────────────────────────────────────────── */

export interface AspectRatioDescriptor {
  readonly id: string;
  readonly label: string;
}

/**
 * 比例档位。
 *
 * 取自即梦创作页实测的比例单选组：智能 + 8 个固定比例。
 * 「智能」交还给后端决定（intelligent_ratio），不由前端猜。
 */
export const CREATE_ASPECT_RATIOS: readonly AspectRatioDescriptor[] = [
  { id: "auto", label: "智能" },
  { id: "1:1", label: "1:1" },
  { id: "3:4", label: "3:4" },
  { id: "16:9", label: "16:9" },
  { id: "4:3", label: "4:3" },
  { id: "9:16", label: "9:16" },
  { id: "2:3", label: "2:3" },
  { id: "3:2", label: "3:2" },
  { id: "21:9", label: "21:9" },
];

/**
 * 比例 → 像素的参考表。
 *
 * 来自即梦 Seedream 4.5 的 `resolution_map`（实测抓包）。用途只有一个：
 * 当后端只给了比例、没有给具体像素时，用它把「2K · 16:9」显示成
 * 「2K · 2560×1440」这样的确切尺寸，让用户在提交前就知道会拿到什么。
 *
 * 注意 4K 的 16:9 是 5404×3040 而不是 5120×2880 —— 尺寸是按最大边长与
 * 像素总数上限反解出来的，不是把 2K 乘二。用错会让用户拿到非预期尺寸。
 */
export const CREATE_RATIO_PIXELS: Readonly<
  Record<string, Readonly<Record<string, readonly [number, number]>>>
> = {
  "1k": {
    "1:1": [1024, 1024],
    "3:4": [864, 1152],
    "16:9": [1280, 720],
    "4:3": [1152, 864],
    "9:16": [720, 1280],
    "2:3": [832, 1248],
    "3:2": [1248, 832],
    "21:9": [1516, 648],
  },
  "1.5k": {
    "1:1": [1536, 1536],
    "3:4": [1296, 1728],
    "16:9": [1920, 1080],
    "4:3": [1728, 1296],
    "9:16": [1080, 1920],
    "2:3": [1248, 1872],
    "3:2": [1872, 1248],
    "21:9": [2268, 972],
  },
  "2k": {
    "1:1": [2048, 2048],
    "3:4": [1728, 2304],
    "16:9": [2560, 1440],
    "4:3": [2304, 1728],
    "9:16": [1440, 2560],
    "2:3": [1664, 2496],
    "3:2": [2496, 1664],
    "21:9": [3024, 1296],
  },
  "4k": {
    "1:1": [4096, 4096],
    "3:4": [3520, 4693],
    "16:9": [5404, 3040],
    "4:3": [4693, 3520],
    "9:16": [3040, 5404],
    "2:3": [3328, 4992],
    "3:2": [4992, 3328],
    "21:9": [6197, 2656],
  },
};

/** 把分辨率名归一化到参考表的键（"4K" / "4k" / "超清 4K" → "4k"）。 */
export function normalizeResolutionKey(resolution: string | null | undefined): string | null {
  if (!resolution) return null;
  const match = resolution.toLowerCase().match(/(\d+(?:\.\d+)?)\s*k/);
  return match ? `${match[1]}k` : null;
}

/** 比例 + 分辨率 → 具体像素；查不到时返回 null（此时只显示比例，不硬编尺寸）。 */
export function resolveRatioPixels(
  ratio: string | null | undefined,
  resolution: string | null | undefined,
): readonly [number, number] | null {
  const key = normalizeResolutionKey(resolution);
  if (!key || !ratio || ratio === "auto") return null;
  const byResolution = CREATE_RATIO_PIXELS[key];
  if (!byResolution) return null;
  return byResolution[ratio] ?? null;
}

/** 卡片上的尺寸描述：「2K · 2560×1440」或「智能比例」。 */
export function describeOutputSize(
  ratio: string | null | undefined,
  resolution: string | null | undefined,
): string | null {
  if (!ratio || ratio === "auto") return resolution ?? null;
  const pixels = resolveRatioPixels(ratio, resolution);
  if (!pixels) return resolution ? `${resolution} · ${ratio}` : ratio;
  return `${resolution ?? ""} · ${ratio} · ${pixels[0]}×${pixels[1]}`.trim();
}

/* ── 参数分组 ─────────────────────────────────────────────────────── */

export type ParameterGroupId = "ability" | "ratio" | "resolution" | "count" | "duration" | "other";

export interface ParameterGroup {
  readonly id: ParameterGroupId;
  readonly title: string;
  readonly capabilities: readonly ModelParameterCapability[];
}

/**
 * 分组标题。
 *
 * 取自即梦参数面板的实测文案（实测面板标题为「选择比例 / 样片分辨率 /
 * 选择生成数量」，时长在独立面板里叫「选择视频生成时长」）。
 */
const GROUP_TITLES: Record<ParameterGroupId, string> = {
  ability: "选择能力模式",
  ratio: "选择比例",
  resolution: "选择分辨率",
  count: "选择生成数量",
  duration: "选择时长",
  other: "其他参数",
};

const ABILITY_KEYS = new Set(["action", "task_type", "omni_reference_task_type"]);
const RATIO_KEYS = new Set(["ratio", "aspect_ratio"]);
const RESOLUTION_KEYS = new Set(["resolution", "quality", "size"]);
const COUNT_KEYS = new Set(["n"]);
/** 时长单独成组：即梦把它放在独立控件上，不与比例/分辨率混在同一块面板里。 */
const DURATION_KEYS = new Set(["duration"]);

/**
 * 把模型声明的参数能力分组。
 *
 * 只处理带枚举值的参数：自由输入项（种子、引导强度这类）在极简模式下不暴露，
 * 它们交给画布侧的参数面板处理，创作台只保留「选一下就能生成」的那几项。
 */
export function groupCapabilities(
  capabilities: readonly ModelParameterCapability[],
): readonly ParameterGroup[] {
  const buckets = new Map<ParameterGroupId, ModelParameterCapability[]>();
  for (const capability of capabilities) {
    if (capability.options.length === 0) continue;
    const id: ParameterGroupId = ABILITY_KEYS.has(capability.key)
      ? "ability"
      : RATIO_KEYS.has(capability.key)
        ? "ratio"
        : RESOLUTION_KEYS.has(capability.key)
          ? "resolution"
          : COUNT_KEYS.has(capability.key)
            ? "count"
            : DURATION_KEYS.has(capability.key)
              ? "duration"
              : "other";
    const bucket = buckets.get(id);
    if (bucket) bucket.push(capability);
    else buckets.set(id, [capability]);
  }
  const order: ParameterGroupId[] = [
    "ability",
    "ratio",
    "resolution",
    "count",
    "duration",
    "other",
  ];
  return order
    .filter((id) => buckets.has(id))
    .map((id) => ({ id, title: GROUP_TITLES[id], capabilities: buckets.get(id) ?? [] }));
}

/**
 * 「生成数量」按钮的摘要。
 *
 * 即梦把数量做成工具条上**独立**的一个按钮（实测图片生成档）：
 * 触发器 55×32、文案「2张」，右侧还带单价「3/张」（单价属于账户侧信息，
 * 本项目没有对应概念，故不渲染）。
 * 浮层是 320×97 的独立 popover，里面 8 个数字磁贴。
 */
export function summarizeCount(
  capabilities: readonly ModelParameterCapability[],
  values: Readonly<Record<string, ModelParameterValue>>,
): string {
  for (const capability of capabilities) {
    if (!COUNT_KEYS.has(capability.key)) continue;
    const value = values[capability.key];
    if (value == null) continue;
    const option = capability.options.find((item) => item.value === value);
    const label = option?.label ?? String(value);
    return /^\d+$/.test(label) ? `${label}张` : label;
  }
  return "";
}

/**
 * 当前取值的可读摘要，落在参数按钮上（对应即梦的「智能比例 2K 2」）。
 *
 * `exclude` 里的键会被跳过：时长有自己的控件，混进来会让这一行变长。
 */
export function summarizeParameters(
  capabilities: readonly ModelParameterCapability[],
  values: Readonly<Record<string, ModelParameterValue>>,
  exclude: ReadonlySet<string> = new Set(),
): string {
  return summarizeParameterParts(capabilities, values, exclude).join(" ");
}

/**
 * 参数摘要的**分段**。
 *
 * 即梦的参数按钮不是一串文字，而是「图标 + 智能比例 + 圆点 + 2K」：
 * 圆点是 `.divider-OobeV4`（3×3、底 rgba(255,255,255,.2)、左右各 6px），
 * 把比例与分辨率分开。所以这里返回数组，由组件按段渲染。
 */
export function summarizeParameterParts(
  capabilities: readonly ModelParameterCapability[],
  values: Readonly<Record<string, ModelParameterValue>>,
  exclude: ReadonlySet<string> = new Set(),
): string[] {
  const parts: string[] = [];
  for (const capability of capabilities) {
    if (exclude.has(capability.key)) continue;
    const value = values[capability.key];
    if (value == null) continue;
    const option = capability.options.find((item) => item.value === value);
    parts.push(option?.label ?? String(value));
  }
  return parts;
}

/**
 * 参数摘要里**有没有** AI 能力标记（即梦那枚蓝色 ✦）。
 *
 * 即梦给「新模型 / 新能力」挂标记（截图里是「智能比例 · 2K ✦」）。
 * 我们的模型目录没有这层产品配置，只对语义明确是 AI 能力的选项打标
 * （能力目录里的 `aiMark`），所以这里查当前取值落在哪个带标记的选项上。
 */
export function hasAiMark(
  capabilities: readonly ModelParameterCapability[],
  values: Readonly<Record<string, ModelParameterValue>>,
  exclude: ReadonlySet<string> = new Set(),
): boolean {
  for (const capability of capabilities) {
    if (exclude.has(capability.key)) continue;
    const value = values[capability.key];
    if (value == null) continue;
    const option = capability.options.find((item) => item.value === value);
    if (option?.aiMark === true) return true;
  }
  return false;
}

/**
 * 时长控件上的摘要（对应即梦的「5s」）。
 *
 * 走模型声明的选项文案；没有选项时退回裸值。
 */
export function summarizeDuration(
  capabilities: readonly ModelParameterCapability[],
  values: Readonly<Record<string, ModelParameterValue>>,
): string {
  const duration = capabilities.find((capability) => capability.key === "duration");
  if (!duration) return "";
  const value = values["duration"] ?? duration.defaultValue;
  const option = duration.options.find((item) => item.value === value);
  if (option) return option.label;
  return typeof value === "number" ? `${value} 秒` : String(value);
}

/* ── 创作类型与模型的可用操作 ─────────────────────────────────────── */

/**
 * 创作类型 → 该类型下可用的生成操作。
 *
 * 图片类型同时容纳文生图与图生图：挂了参考素材就走图生图，
 * 所以只支持图生图的模型也必须出现在模型列表里（即梦的「全能参考」同理）。
 */
export function modeOperations(mode: CreateModeId): readonly GenerationOperation[] {
  if (mode === "image") return ["text_to_image", "image_to_image"];
  if (mode === "video") return ["video_generation"];
  if (mode === "text") return ["text_generation"];
  return ["speech_generation"];
}

/**
 * 把用户显式选过的值合并到当前能力表的默认值上。
 *
 * 合并而不是覆盖：换模型后新能力表里可能没有旧的键，那部分要丢掉；
 * 但同一个键（例如分辨率）如果用户显式选过，就不能被默认值悄悄改回去。
 * 值不在新选项里时同样丢弃——留着会被原样发给后端并被拒绝。
 */
export function mergeParameterValues(
  capabilities: readonly ModelParameterCapability[],
  chosen: Readonly<Record<string, ModelParameterValue>>,
): Record<string, ModelParameterValue> {
  const merged: Record<string, ModelParameterValue> = {};
  for (const capability of capabilities) {
    const value = chosen[capability.key];
    if (value === undefined) {
      merged[capability.key] = capability.defaultValue;
      continue;
    }
    if (capability.options.length === 0) {
      merged[capability.key] = value;
      continue;
    }
    const stillValid = capability.options.some((option) => option.value === value);
    merged[capability.key] = stillValid ? value : capability.defaultValue;
  }
  return merged;
}

/* ── 结果分组 ───────────────────────────────────────────────────────── */

/**
 * 记录流分组标题。
 *
 * 对齐即梦源码（`js/async/AIGeneratedRecord-2.922b2d02a3.js` 模块 `60454`）：
 *
 * ```js
 * l = Math.floor((今天00:00 - 记录那天00:00) / 864e5)
 * if (0 === l) return "今天"            // web_assets_date_title_today
 * if (1 === l) return "昨天"            // web_assets_date_title_yesterday
 * if (2 === l) return "2天前"           // web_notifications_time_days_ago
 * return "{M}月{D}日"                   // web_month_day_date_format
 * ```
 *
 * 三个容易对错的点：
 *   1. 有「2天前」这一档，本地原先直接跳到绝对日期；
 *   2. 月份是 **1..12 的纯数字**（`web_month_jan` = "1" … `web_month_dec` = "12"）；
 *   3. 绝对日期**不带年份**（即梦实测「12月26日」「1月6日」）。
 */
export function groupDayLabel(timestampMs: number, nowMs: number): string {
  const day = new Date(timestampMs);
  const today = new Date(nowMs);
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.floor((startOf(today) - startOf(day)) / 86_400_000);
  if (diffDays === 0) return "今天";
  if (diffDays === 1) return "昨天";
  if (diffDays === 2) return "2天前";
  return `${day.getMonth() + 1}月${day.getDate()}日`;
}

/* ── 记录抬头 ───────────────────────────────────────────────────────── */

/** 取参数表里第一个有值的字符串键。 */
function firstStringValue(
  values: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = values[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

/**
 * 从任务详情里取出「这次用了什么参数」，做成抬头上的短标签。
 *
 * 即梦的记录抬头是「提示词 · 模型 · 比例 · 分辨率」。模型名已经有了，
 * 缺的是比例与分辨率——它们只能从任务详情里的 `logicalRequest.parameters` 取，
 * 那是提交当时的快照，换模型改参数都不会改写历史记录。
 *
 * 只认声明过的枚举键：自由输入项（种子、引导强度）不进抬头，那一行放不下，
 * 也不该让用户误以为那是模型能力。
 */
export function describeRecordParameters(detail: {
  readonly logicalRequest?: unknown;
}): readonly string[] {
  const request = detail.logicalRequest;
  if (!request || typeof request !== "object") return [];
  const parameters = (request as Record<string, unknown>)["parameters"];
  if (!parameters || typeof parameters !== "object") return [];
  const values = parameters as Record<string, unknown>;

  const labels: string[] = [];
  const ratio = firstStringValue(values, ["ratio", "aspect_ratio"]);
  if (ratio) labels.push(ratio === "auto" ? "智能比例" : ratio);
  const resolution = firstStringValue(values, ["resolution", "quality", "size"]);
  if (resolution) {
    /*
     * 分辨率统一大写后缀：即梦的界面写「720P」「2K」，
     * 而模型能力表里存的是「720p」「2k」。不归一的话，同一个档位
     * 在参数按钮上显示 720P、在记录抬头上显示 720p，看着像两个档。
     */
    const key = normalizeResolutionKey(resolution);
    if (key) {
      labels.push(key.toUpperCase());
    } else if (/^\d+\s*p$/i.test(resolution)) {
      labels.push(resolution.toUpperCase());
    } else {
      labels.push(resolution);
    }
  }
  return labels;
}
