import type { IconName } from "../../components/Icon";

/**
 * 画布「添加节点」菜单的条目。
 *
 * 清单与原站 liblib.tv 画布逐项对齐（实测：点击节点左侧手柄弹出的
 * 「引用该节点生成」菜单，见 docs/integrations/liblib-canvas-re.md 第 3.3 节）：
 *
 *   文本 · 图片 · 视频 · 智能剪辑(Beta) · 导演台(NEW) · 逐帧拉片 · 音频 · 剧本 · 参考节点
 *
 * 原站没有的节点类型（网络爆款视频下载 / 视频抽帧 / 爆款视频复刻）已删除；
 * 原站有而本项目后端尚未提供的（导演台 / 逐帧拉片 / 音频 / 参考节点）
 * 保留条目与文案，点击给出「后端暂未接入」的明确说明，不静默失败。
 */
export type CanvasQuickAddKind =
  | "text"
  | "image"
  | "video"
  | "video_clip"
  | "director"
  | "shot_breakdown"
  | "audio"
  | "screenplay"
  | "reference";

export interface CanvasQuickAddChoice {
  readonly kind: CanvasQuickAddKind;
  /** 与原站一致的条目文案。 */
  readonly label: string;
  readonly icon: IconName;
  /** 原站在该条目右侧的角标（Beta / NEW / 模型版本）。 */
  readonly badge?: string;
  /**
   * 该条目对应的能力本项目后端是否已接入。
   * 未接入的条目保留位置与文案，点击给出「后端暂未接入」的说明。
   */
  readonly available?: boolean;
}

/** 画布创建菜单只列出能立刻建出来的节点；未接入的条目按原站保留位置。 */
export const CANVAS_QUICK_ADD_CHOICES: readonly CanvasQuickAddChoice[] = [
  { kind: "text", label: "文本", icon: "text-t" },
  { kind: "image", label: "图片", icon: "image" },
  { kind: "video", label: "视频", icon: "video-camera" },
  { kind: "video_clip", label: "智能剪辑", icon: "film-strip", badge: "Beta" },
  { kind: "director", label: "导演台", icon: "video-camera", badge: "NEW", available: false },
  {
    kind: "shot_breakdown",
    label: "逐帧拉片",
    icon: "film-strip",
    badge: "SD 2.5",
    available: false,
  },
  { kind: "audio", label: "音频", icon: "music-notes", available: false },
  { kind: "screenplay", label: "剧本", icon: "book-open-text" },
  { kind: "reference", label: "参考节点", icon: "clipboard", available: false },
];

/**
 * 空画布状态下的快捷创建入口（对齐原站 liblib）。
 *
 * 原站空画布上是一行提示 + 五个入口：图片生成 / 视频生成 / 音频生成 / 剧本生成 /
 * 智能剪辑（i18n：assetSourceImage/assetSourceVideo/assetSourceAudio、
 * nodeTypeVideoClip）。文案沿用原站的说法，与「添加节点」菜单里的短名区分开。
 */
export const EMPTY_CANVAS_SHORTCUTS: readonly {
  readonly kind: CanvasQuickAddKind;
  readonly label: string;
  readonly icon: IconName;
}[] = [
  { kind: "image", label: "图片生成", icon: "image" },
  { kind: "video", label: "视频生成", icon: "video-camera" },
  { kind: "audio", label: "音频生成", icon: "music-notes" },
  { kind: "screenplay", label: "剧本生成", icon: "book-open-text" },
  { kind: "video_clip", label: "智能剪辑", icon: "film-strip" },
];
