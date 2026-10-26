import type { LucideIcon } from "lucide-react";
import { AudioLines, Briefcase, MicVocal, Scissors, Sparkles } from "lucide-react";

/**
 * 「智能剪辑」剪辑模式目录。
 *
 * 照抄原站 liblib.tv 画布的 `video-clip` 节点（逆向证据见
 * `docs/integrations/liblib-video-clip-re.md`）：
 *
 * - 原站把模式表放在一个独立模块里，导出 `defaultMode` 与 `modes` 两段；
 *   `defaultMode` 是「默认模式」，`modes` 是四个可切换的预设模式。
 * - 每个模式声明自己的素材槽位（`materialSlots`）、提示词是否必填、
 *   预置提示词与预置素材、以及它背后的技能标识。
 * - 参数（比例 / 时长 / 清晰度）是模式表外面的一份全局配置，所有模式共用。
 *
 * 原站模式键（`modeKey`）：default / explainerVideo / batchAd /
 * talkingHeadVideo / smartMixCut。原站第五项「口播视频」是后续版本补上的，
 * 早期版本只有四项，本项目按活体实测的当前版本实现五项。
 */

/** 模式键。命名与原站 `modeKey` 一致（驼峰），便于与原站事件字段对齐。 */
export type VideoClipModeKey =
  "default" | "explainerVideo" | "batchAd" | "talkingHeadVideo" | "smartMixCut";

/**
 * 素材槽位键。命名与原站 `slotKey` 一致。
 *
 * - video          视频
 * - audio          音频
 * - text           文字
 * - productImage   产品图
 * - refVideo       参考视频
 * - generatedVideo 生成视频
 */
export type VideoClipSlotKey =
  "video" | "audio" | "text" | "productImage" | "refVideo" | "generatedVideo";

/** 原站槽位的中文标签（i18n：canvas:videoComposeSlot_*）。 */
export const VIDEO_CLIP_SLOT_LABELS: Readonly<Record<VideoClipSlotKey, string>> = {
  video: "视频",
  audio: "音频",
  text: "文字",
  productImage: "产品图",
  refVideo: "参考视频",
  generatedVideo: "生成视频",
};

export interface VideoClipMaterialSlot {
  readonly slotKey: VideoClipSlotKey;
  /** 该槽位接受哪几类画布节点（画布节点类型名）。 */
  readonly nodeTypes: readonly string[];
  /** 是否必填。原站必填槽位缺料时会直接拦住提交。 */
  readonly required: boolean;
  readonly min: number;
  readonly max: number;
  /** 媒体槽位交给供应商时用的角色；文字槽位没有媒体角色。 */
  readonly role?: string;
}

export interface VideoClipMode {
  readonly modeKey: VideoClipModeKey;
  /** 模式名（原站 `name`）。 */
  readonly name: string;
  /** 模式图标。原站用 Iconify，这里统一用 Lucide 同语义字形。 */
  readonly icon: LucideIcon;
  /** 模式说明（原站 `description`），显示在模式菜单的悬浮提示里。 */
  readonly description: string;
  readonly urlInput: null;
  readonly materialSlots: readonly VideoClipMaterialSlot[];
  readonly promptRequired: boolean;
  /**
   * 预置：点「尝试：」某一项后写进编辑层的提示词。
   *
   * 原站这五个模式还带预置素材，但那是它自家 CDN 上的外链地址——本项目不引入
   * 外链素材，素材由用户自己连进来（这也是原站空态提示「请连接视频节点后操作」的用意）。
   */
  readonly preset?: {
    readonly prompt: string;
  };
  /** 原站该模式背后的技能标识（本项目暂不接技能系统，仅保留对照）。 */
  readonly skill?: {
    readonly skillKey: string;
    readonly name: string;
  };
}

/**
 * 默认模式：自由剪辑。原站描述「自由剪辑：添加视频素材并描述想剪成什么效果」，
 * 只吃视频素材（1~30 个），提示词必填。
 */
export const VIDEO_CLIP_DEFAULT_MODE: VideoClipMode = {
  modeKey: "default",
  name: "默认模式",
  icon: Scissors,
  description: "自由剪辑：添加视频素材并描述想剪成什么效果",
  urlInput: null,
  materialSlots: [
    {
      slotKey: "video",
      nodeTypes: ["video"],
      required: true,
      min: 1,
      max: 30,
      role: "reference_video",
    },
  ],
  promptRequired: true,
};

/** 原站四个预设模式。 */
export const VIDEO_CLIP_MODES: readonly VideoClipMode[] = [
  {
    modeKey: "explainerVideo",
    name: "讲解视频",
    icon: AudioLines,
    description: "添加音频参考与文字稿，AI自动生成讲解视频",
    urlInput: null,
    materialSlots: [
      {
        slotKey: "audio",
        nodeTypes: ["audio"],
        required: true,
        min: 1,
        max: 1,
        role: "reference_audio",
      },
      { slotKey: "text", nodeTypes: ["text"], required: false, min: 0, max: 10 },
    ],
    promptRequired: true,
    preset: {
      prompt: "根据我的音色和主题，生成讲解视频。我的主题是‘神经网络发展历史科普’",
      },
    skill: { skillKey: "faceless-commentary-video", name: "讲解视频" },
  },
  {
    modeKey: "batchAd",
    name: "批量广告",
    icon: Briefcase,
    description: "上传产品图与参考视频，批量生成同款广告",
    urlInput: null,
    materialSlots: [
      {
        slotKey: "productImage",
        nodeTypes: ["image"],
        required: true,
        min: 1,
        max: 10,
        role: "reference_image",
      },
      {
        slotKey: "refVideo",
        nodeTypes: ["video"],
        required: true,
        min: 1,
        max: 1,
        role: "reference_video",
      },
    ],
    promptRequired: true,
    preset: {
      prompt: "参考这支视频的节奏和运镜，用我的产品图批量制作广告",
      },
    skill: { skillKey: "batch-ad-replicator", name: "批量广告" },
  },
  {
    modeKey: "talkingHeadVideo",
    name: "口播视频",
    icon: MicVocal,
    description: "添加音频参考与文字稿，AI自动生成口播视频",
    urlInput: null,
    materialSlots: [
      {
        slotKey: "audio",
        nodeTypes: ["audio"],
        required: true,
        min: 1,
        max: 1,
        role: "reference_audio",
      },
      { slotKey: "text", nodeTypes: ["text"], required: false, min: 0, max: 10 },
    ],
    promptRequired: true,
    preset: {
      prompt: "用我的声音和这份文稿生成口播视频，文稿主题是‘神经网络发展历史科普’",
      },
    skill: { skillKey: "talking-head-video", name: "口播视频" },
  },
  {
    modeKey: "smartMixCut",
    name: "素材混剪",
    icon: Sparkles,
    description: "把我的视频素材，进行卡点快剪。",
    urlInput: null,
    materialSlots: [
      {
        slotKey: "generatedVideo",
        nodeTypes: ["video"],
        required: true,
        min: 5,
        max: 30,
        role: "reference_video",
      },
    ],
    promptRequired: true,
    preset: {
      prompt: "把我的素材进行智能混剪，要卡点并突出产品",
      },
    skill: { skillKey: "beat-sync-video-producer", name: "卡点视频制作工作流" },
  },
];

/** 模式菜单里的完整顺序：默认模式在前，四个预设模式在后（原站实测顺序）。 */
export const VIDEO_CLIP_ALL_MODES: readonly VideoClipMode[] = [
  VIDEO_CLIP_DEFAULT_MODE,
  ...VIDEO_CLIP_MODES,
];

/** 按 modeKey 取模式；未知键回落到默认模式。 */
export function videoClipMode(modeKey: string): VideoClipMode {
  return VIDEO_CLIP_ALL_MODES.find((mode) => mode.modeKey === modeKey) ?? VIDEO_CLIP_DEFAULT_MODE;
}

/**
 * 模式键 → 后端枚举值。Rust 侧 `VideoClipMode` 用 snake_case 序列化，
 * 这里给出唯一映射，避免前后端各写一份字符串。
 */
export const VIDEO_CLIP_BACKEND_MODES: Readonly<Record<VideoClipModeKey, string>> = {
  default: "default",
  explainerVideo: "explainer_video",
  batchAd: "batch_ad",
  talkingHeadVideo: "talking_head_video",
  smartMixCut: "smart_mix_cut",
};

/**
 * 参数配置（比例 / 时长 / 清晰度）。原站这是一份模式表之外的全局配置：
 * 可选比例 6 档、时长 0~300 秒（默认 30）、清晰度 3 档（默认 720P），
 * 默认组合是 16:9 · 720P · 30s。
 */
export const VIDEO_CLIP_ASPECT_RATIOS = ["21:9", "16:9", "9:16", "1:1", "4:3", "3:4"] as const;
export const VIDEO_CLIP_RESOLUTIONS = ["480P", "720P", "1080P"] as const;
export const VIDEO_CLIP_DURATION_RANGE = { min: 0, max: 300, default: 30 } as const;

export interface VideoClipParams {
  readonly aspectRatio: string;
  readonly durationSeconds: number;
  readonly resolution: string;
}

export const VIDEO_CLIP_DEFAULT_PARAMS: VideoClipParams = {
  aspectRatio: "16:9",
  durationSeconds: VIDEO_CLIP_DURATION_RANGE.default,
  resolution: "720P",
};

/**
 * 从节点配置里解析出可用的合成参数，缺字段一律回落默认值。
 *
 * 画布文档按 JSON 透传、恢复时不校验 config 结构（见 `normalizeCanvasDocument`），
 * 所以手工编辑过的或来自其它版本的文档可能缺字段。缺字段直接透传给后端会被
 * serde 以 `missing field` 拒绝（参数在 Rust 侧是必填），用户只看到一句莫名报错。
 * 这里按项目既有惯例（未知提示词模式降级成默认模式）做前端兜底，让历史/损坏
 * 画布仍能提交。
 */
export function resolveVideoClipParams(config: {
  readonly aspectRatio?: string | undefined;
  readonly durationSeconds?: number | undefined;
  readonly resolution?: string | undefined;
}): VideoClipParams {
  // 时长必须是整数秒：Rust 侧是 u32，小数会让 serde 直接拒绝整个请求
  // （invalid type: floating point）。输入框允许敲小数，这里统一取整。
  const rawDuration =
    typeof config.durationSeconds === "number" && Number.isFinite(config.durationSeconds)
      ? Math.round(config.durationSeconds)
      : null;
  return {
    aspectRatio: config.aspectRatio?.trim() || VIDEO_CLIP_DEFAULT_PARAMS.aspectRatio,
    durationSeconds:
      rawDuration !== null &&
      rawDuration >= VIDEO_CLIP_DURATION_RANGE.min &&
      rawDuration <= VIDEO_CLIP_DURATION_RANGE.max
        ? rawDuration
        : VIDEO_CLIP_DEFAULT_PARAMS.durationSeconds,
    resolution: config.resolution?.trim() || VIDEO_CLIP_DEFAULT_PARAMS.resolution,
  };
}

/**
 * 比例图标的外框尺寸。原站比例按钮里放一个 16×9 之类的比例示意框，
 * 这里按同一套算法从比例字符串推出示意框的宽高。
 */
export function videoClipRatioBox(ratio: string): {
  readonly width: number;
  readonly height: number;
} {
  const [rawWidth, rawHeight] = ratio.split(":");
  const width = Number(rawWidth);
  const height = Number(rawHeight);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: 16, height: 9 };
  }
  const scale = 16 / Math.max(width, height);
  return {
    width: Math.round(width * scale),
    height: Math.round(height * scale),
  };
}

/** 参数摘要文案。原站底栏按钮显示「16:9 · 720P · 30s」。 */
export function videoClipParamsSummary(params: VideoClipParams): string {
  return `${params.aspectRatio} · ${params.resolution} · ${params.durationSeconds}s`;
}

/**
 * 按模式的槽位声明把上游素材分槽。
 *
 * 规则（照抄原站）：按槽位声明顺序依次取用节点类型匹配的素材，一份素材只进
 * 一个槽位（先到先得）。当前五个模式的槽位之间节点类型互不重叠，因此顺序即结果。
 *
 * **不做「超出 max 就截断」**：截断会让多连的素材被静默丢掉——编辑层仍显示着
 * 那些素材，用户以为它们都会参与合成，实际没有。超限由校验层
 * （`videoClipSlotIssue` 与后端 `validate_materials`）明确报错，提示用户删掉多余素材。
 */
export function assignVideoClipSlots<T extends { readonly nodeType: string }>(
  mode: VideoClipMode,
  inputs: readonly T[],
): readonly { readonly slotKey: VideoClipSlotKey; readonly items: readonly T[] }[] {
  const taken = new Set<number>();
  return mode.materialSlots.map((slot) => {
    const items: T[] = [];
    for (let index = 0; index < inputs.length; index += 1) {
      if (taken.has(index)) continue;
      if (!slot.nodeTypes.includes(inputs[index]!.nodeType)) continue;
      taken.add(index);
      items.push(inputs[index]!);
    }
    return { slotKey: slot.slotKey, items };
  });
}

/**
 * 找出「当前模式下没有任何槽位接纳」的素材。
 *
 * 切换模式后，已连的素材可能不再匹配新模式的槽位（例如从「默认模式」切到
 * 「批量广告」，原先连的视频里只有一个能进「参考视频」槽，其余的音频/图片
 * 无处安放）。这些素材不会进合成载荷——不提示就是静默丢弃：用户以为它们
 * 都会用上，实际没有。
 */
/**
 * 找出「当前模式下没有被采用」的素材，并区分两种原因。
 *
 * - `overflow`：素材类型**匹配某个槽位**，但那个槽位已经装满（例：批量广告的
 *   「参考视频」上限 1 个，多连的那个视频就属于这一类）。文案应说「最多 N 个」，
 *   而不是笼统的「不参与合成」——否则用户会以为自己连的东西类型不对。
 * - `unmatched`：素材类型**不被任何槽位接受**（例：默认模式只吃视频，多连的
 *   音频属于这一类）。这类素材确实不会参与合成，必须明确告知。
 */
export function videoClipUnusedMaterials<T extends { readonly nodeType: string }>(
  mode: VideoClipMode,
  inputs: readonly T[],
  slots: readonly { readonly slotKey: VideoClipSlotKey; readonly items: readonly T[] }[],
): {
  readonly overflow: readonly { readonly label: string; readonly max: number; readonly count: number }[];
  readonly unmatched: readonly T[];
} {
  const used = new Set<T>();
  for (const slot of slots) {
    for (const item of slot.items) used.add(item);
  }
  const overflow = new Map<string, { label: string; max: number; count: number }>();
  const unmatched: T[] = [];
  for (const item of inputs) {
    if (used.has(item)) continue;
    const full = mode.materialSlots.find(
      (slot) =>
        slot.nodeTypes.includes(item.nodeType) &&
        (slots.find((entry) => entry.slotKey === slot.slotKey)?.items.length ?? 0) >= slot.max,
    );
    if (!full) {
      unmatched.push(item);
      continue;
    }
    const label = VIDEO_CLIP_SLOT_LABELS[full.slotKey];
    const current = overflow.get(full.slotKey);
    if (current) current.count += 1;
    else overflow.set(full.slotKey, { label, max: full.max, count: 1 });
  }
  return { overflow: [...overflow.values()], unmatched };
}

/**
 * 槽位缺料 / 超限的人话报错（文案照抄原站 i18n）。
 *
 * 返回 null 表示这一轮的槽位校验通过。
 */
export function videoClipSlotIssue(
  mode: VideoClipMode,
  slots: readonly { readonly slotKey: VideoClipSlotKey; readonly items: readonly unknown[] }[],
): string | null {
  for (const slot of mode.materialSlots) {
    const filled = slots.find((entry) => entry.slotKey === slot.slotKey)?.items.length ?? 0;
    const label = VIDEO_CLIP_SLOT_LABELS[slot.slotKey];
    if (filled < slot.min) {
      return slot.min > 0 ? `还需添加${label}（至少 ${slot.min} 个）` : `还需添加${label}`;
    }
    if (filled > slot.max) {
      return `${label}最多 ${slot.max} 个`;
    }
  }
  return null;
}
