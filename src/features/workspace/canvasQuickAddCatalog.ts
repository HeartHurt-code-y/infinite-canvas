import type { IconName } from "../../components/Icon";
import type { LibTVMediaIconName } from "./LibTVMediaIcon";
import { DIRECTOR_NODE_SIZE } from "./directorScene";
import {
  SCREENPLAY_NODE_COARSE_HEIGHT,
  SCREENPLAY_NODE_HEIGHT,
  SCRIPT_GENERATOR_NODE_SIZE,
  SCREENPLAY_NODE_WIDTH,
  VIDEO_CLIP_NODE_HEIGHT,
  VIDEO_CLIP_NODE_WIDTH,
  genNodeDimensions,
  usesCoarsePointer,
} from "./workspaceModel";

/**
 * 画布「添加节点」和手柄连线菜单共用的创建类型。
 *
 * 本项目的端口方向与原站相反：原站从**左侧**手柄「引用该节点生成」，这里输出端口在右、
 * 输入端口在左，于是同一个菜单有两种方向——点右侧（输出）= 引用该节点生成（新节点在左），
 * 点左侧（输入）= 接入该节点（新节点在右）。菜单标题写明当前方向。
 *
 * 原站没有的节点类型（网络爆款视频下载 / 视频抽帧 / 爆款视频复刻）已删除；
 * 原站有而本项目后端尚未提供的（导演台 / 逐帧拉片 / 参考节点）
 * 保留条目与文案，点击给出「后端暂未接入」的明确说明，不静默失败。
 * 音频节点已接入（走 `speech_generation` 任务），规格见
 * `docs/integrations/liblib-audio-node-re.md`。
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
  | "screenplay_legacy"
  | "reference";

export interface CanvasQuickAddChoice {
  readonly kind: CanvasQuickAddKind;
  /** 与原站一致的条目文案。 */
  readonly label: string;
  readonly icon: LibTVMediaIconName;
  /** 原站在该条目右侧的角标（Beta / NEW / 模型版本）。 */
  readonly badge?: string;
  /**
   * 该条目对应的能力本项目后端是否已接入。
   * 未接入的条目保留位置与文案，点击给出「后端暂未接入」的说明。
   */
  readonly available?: boolean;
}

/** 连线菜单沿用节点手柄的可选类型；空白处菜单使用原站的精简清单。 */
export const CANVAS_QUICK_ADD_CHOICES: readonly CanvasQuickAddChoice[] = [
  { kind: "text", label: "文本", icon: "menu-q4-text" },
  { kind: "image", label: "图片", icon: "menu-q4-image" },
  { kind: "video", label: "视频", icon: "menu-q4-video" },
  { kind: "video_clip", label: "智能剪辑", icon: "menu-q4-smart-clip", badge: "Beta" },
  { kind: "director", label: "导演台", icon: "menu-q4-director", badge: "NEW" },
  {
    kind: "shot_breakdown",
    label: "逐帧拉片",
    icon: "smart-breakdown",
    badge: "SD 2.5",
    available: false,
  },
  { kind: "audio", label: "音频", icon: "menu-q4-audio" },
  { kind: "screenplay", label: "脚本", icon: "menu-q4-script" },
  { kind: "reference", label: "参考节点", icon: "link", available: false },
];

const ADD_NODE_ORDER = ["text", "screenplay", "image", "video", "director", "video_clip", "audio"];
export const CANVAS_ADD_NODE_CHOICES = ADD_NODE_ORDER.flatMap(kind =>
  CANVAS_QUICK_ADD_CHOICES.filter(choice => choice.kind === kind),
);
export const CANVAS_ADD_SCRIPT_CHOICES = [
  { kind: "screenplay", label: "脚本", badge: "NEW" },
  { kind: "screenplay_legacy", label: "脚本（旧版）", badge: "Beta" },
] as const;

/**
 * 某一类新建节点的尺寸。
 *
 * 「引用该节点生成」从**手柄点按**进入时，落点不是松手处，而是被引用节点的**另一侧**——
 * 那时需要先知道新节点有多宽，才能把它整整齐齐摆在端口对面（不压住原节点）。
 * 这里的尺寸必须与真正建节点时用的那一份一致（`createGenNode` / 剧本 / 智能剪辑）。
 */
export function quickAddNodeDimensions(kind: CanvasQuickAddKind): {
  readonly width: number;
  readonly height: number;
} {
  switch (kind) {
    case "text":
      return genNodeDimensions("prompt");
    case "image":
      return genNodeDimensions("image");
    case "video":
      return genNodeDimensions("video");
    case "audio":
      return genNodeDimensions("audio");
    case "screenplay":
      return { width: SCRIPT_GENERATOR_NODE_SIZE, height: SCRIPT_GENERATOR_NODE_SIZE };
    case "director":
      return { width: DIRECTOR_NODE_SIZE, height: DIRECTOR_NODE_SIZE };
    case "screenplay_legacy":
      return {
        width: SCREENPLAY_NODE_WIDTH,
        height: usesCoarsePointer() ? SCREENPLAY_NODE_COARSE_HEIGHT : SCREENPLAY_NODE_HEIGHT,
      };
    case "video_clip":
      return { width: VIDEO_CLIP_NODE_WIDTH, height: VIDEO_CLIP_NODE_HEIGHT };
    default:
      // 未接入的条目（导演台 / 逐帧拉片 / 参考节点）不会走到建节点这一步：
      // 菜单在选中它们时就给出了「后端暂未接入」的说明。
      return { width: 0, height: 0 };
  }
}

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
