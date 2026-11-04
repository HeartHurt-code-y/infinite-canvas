import type { VideoPreparationOperation } from "../../lib/videoPreparation";
import type { CanvasImageTransform } from "./CanvasImageInlineEditor";
import type { LibTVMediaIconName } from "./LibTVMediaIcon";

export type CanvasInlineFeature =
  | { kind: "image"; mode: CanvasImageTransform }
  | { kind: "frame"; mode: "current" | "first" | "last" }
  | { kind: "audio"; mode: "trim" | "speed" | "smart" | "custom" };

export type CanvasFeatureAction = CanvasInlineFeature
  | { kind: "video-preparation"; mode: VideoPreparationOperation; tool?: "remake" }
  | { kind: "video-crop" }
  | { kind: "image-hd" }
  | { kind: "image-camera" }
  | { kind: "video-opening" }
  | { kind: "image-local"; mode: "grid"; columns: 2 | 3 | 4 }
  | { kind: "image-local"; mode: "annotate" | "erase" | "elements" }
  | { kind: "image-preset"; scene: string }
  | { kind: "video-draft"; mode: "edit" | "extend"; prompt: string; mark?: boolean }
  | { kind: "atlas-tool"; mode: "video_upscale" | "image_background" | "image_layers" };

export function canvasFeatureMediaType(action: CanvasFeatureAction): "image" | "audio" | "video" {
  if (action.kind === "audio") return "audio";
  if (action.kind === "frame" || action.kind === "video-crop" || action.kind === "video-preparation" || action.kind === "video-draft" || action.kind === "video-opening" ||
      (action.kind === "atlas-tool" && action.mode === "video_upscale")) return "video";
  return "image";
}

export interface CanvasInlineFeatureRequest {
  readonly nodeKey: string;
  readonly sourcePath: string;
  readonly action: CanvasInlineFeature;
  readonly onHandled: () => void;
}

export interface CanvasFeatureTarget {
  readonly key: string;
  readonly label: string;
  readonly selected: boolean;
  readonly previewSrc?: string | null;
}

export interface FeatureEntry {
  readonly label: string;
  readonly action?: CanvasFeatureAction;
  readonly unavailable?: string;
}

export interface FeatureCard extends FeatureEntry {
  readonly icon: LibTVMediaIconName;
  readonly premium?: boolean;
  readonly children?: readonly FeatureEntry[];
}

export const CANVAS_FEATURE_GROUPS: readonly {
  label: string;
  cards: readonly FeatureCard[];
}[] = [
  {
    label: "视频编辑",
    cards: [
      { label: "片段截图", icon: "icon-group-storyboard", children: [
        { label: "截取当前帧", action: { kind: "frame", mode: "current" } },
        { label: "截取首帧", action: { kind: "frame", mode: "first" } },
        { label: "截取尾帧", action: { kind: "frame", mode: "last" } },
      ] },
      { label: "高清", icon: "hd", action: { kind: "atlas-tool", mode: "video_upscale" } },
      { label: "元素替换", icon: "remix", premium: true, action: { kind: "video-draft", mode: "edit", mark: true, prompt: "替换所标注的元素，保留视频中其他内容与镜头运动。请描述替换后的元素。" } },
      { label: "去字幕", icon: "feature-glyph-subtitle", children: [
        { label: "智能擦除", action: { kind: "video-draft", mode: "edit", prompt: "去除画面中的字幕并自然补全被覆盖的背景，保留其他画面和镜头运动。" } },
        { label: "框选擦除", action: { kind: "video-draft", mode: "edit", mark: true, prompt: "仅移除所标注区域内的字幕并修复背景，其余画面保持一致。" } },
      ] },
      { label: "片段重拍", icon: "segment-remake", action: { kind: "video-preparation", mode: "clip_video", tool: "remake" } },
      { label: "分离音视频", icon: "icon-video-voice", children: [
        { label: "提取音轨", action: { kind: "video-preparation", mode: "extract_audio" } },
        { label: "导出无声视频", action: { kind: "video-preparation", mode: "silent_video" } },
        { label: "仅保留人声", unavailable: "需要支持人声分离的供应商" },
        { label: "仅保留背景音", unavailable: "需要支持人声分离的供应商" },
      ] },
      { label: "逐帧拉片", icon: "smart-breakdown", premium: true, unavailable: "缺少镜头拆解服务" },
      { label: "深度动作捕捉", icon: "feature-glyph-scan-man", unavailable: "缺少视频深度估计服务" },
      { label: "创意片头", icon: "icon-storyboard-gen", action: { kind: "video-opening" } },
      { label: "画面裁切", icon: "cut", action: { kind: "video-crop" } },
      { label: "智能续写", icon: "icon-video-gen", action: { kind: "video-draft", mode: "extend", prompt: "从参考视频结尾继续镜头，保持人物、场景和运动连贯。" } },
      { label: "主体消除", icon: "feature-glyph-remove", children: [
        { label: "主体消除", action: { kind: "video-draft", mode: "edit", mark: true, prompt: "消除标注的主体，自然补全背景，保持其他主体和镜头运动。" } },
        { label: "主体修改", action: { kind: "video-draft", mode: "edit", mark: true, prompt: "只修改标注的主体，保留其他主体和背景。请补充修改描述。" } },
        { label: "主体替换", action: { kind: "video-draft", mode: "edit", mark: true, prompt: "只替换标注的主体，保持镜头连续。请补充替换后的主体描述。" } },
      ] },
      { label: "片段截取", icon: "icon-scissors", action: { kind: "video-preparation", mode: "clip_video" } },
      { label: "智能抠像", icon: "feature-glyph-matting", unavailable: "缺少视频逐帧抠像服务" },
    ],
  },
  {
    label: "图片编辑",
    cards: [
      { label: "高清", icon: "hd", action: { kind: "image-hd" } },
      { label: "元素编辑", icon: "feature-glyph-elements", action: { kind: "image-local", mode: "elements" } },
      { label: "多角度", icon: "rotate-3d", action: { kind: "image-camera" } },
      { label: "宫格切分", icon: "grid-split", children: [
        { label: "四宫格", action: { kind: "image-local", mode: "grid", columns: 2 } },
        { label: "九宫格", action: { kind: "image-local", mode: "grid", columns: 3 } },
        { label: "十六宫格", action: { kind: "image-local", mode: "grid", columns: 4 } },
      ] },
      { label: "图层分离", icon: "icon-element", action: { kind: "atlas-tool", mode: "image_layers" } },
      { label: "720度全景图", icon: "toolbar-q4-panorama", action: { kind: "image-preset", scene: "720_panoramic" } },
      { label: "人像质感调节", icon: "feature-glyph-face", children: [
        { label: "人像质感调节", action: { kind: "image-preset", scene: "portrait_texture_adjustment" } },
      ] },
      { label: "旋转", icon: "rotate", action: { kind: "image", mode: "rotate" } },
      { label: "标注", icon: "annotate", action: { kind: "image-local", mode: "annotate" } },
      { label: "扩图", icon: "expand", action: { kind: "image", mode: "outpaint" } },
      { label: "九宫格", icon: "grid-3x3", children: [
        { label: "分镜九宫格", action: { kind: "image-preset", scene: "storyboard_canvas_skill" } },
        { label: "多角度九宫格", action: { kind: "image-preset", scene: "multi_camera_grid_9" } },
      ] },
      { label: "打光", icon: "feature-glyph-light", action: { kind: "image-preset", scene: "cinematic_lighting_correction" } },
      { label: "抠图", icon: "feature-glyph-matting", action: { kind: "atlas-tool", mode: "image_background" } },
      { label: "擦除", icon: "feature-glyph-remove", action: { kind: "image-local", mode: "erase" } },
      { label: "重绘", icon: "feature-glyph-pencil-ai", action: { kind: "image", mode: "repaint" } },
      { label: "裁剪", icon: "cut", action: { kind: "image", mode: "crop" } },
    ],
  },
  {
    label: "音频编辑",
    cards: [
      { label: "裁剪", icon: "icon-scissors", action: { kind: "audio", mode: "trim" } },
      { label: "变速", icon: "clip-speed-gauge", action: { kind: "audio", mode: "speed" } },
      { label: "智能切分", icon: "ai-clipper", action: { kind: "audio", mode: "smart" } },
      { label: "自定义切分", icon: "audio-custom-split", action: { kind: "audio", mode: "custom" } },
    ],
  },
];
