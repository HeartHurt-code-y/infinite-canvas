import type { LibTVMediaIconName } from "./LibTVMediaIcon";

/**
 * 文本节点空态的「尝试：」快捷入口。
 *
 * 逆向来源：liblib.tv 画布的文本节点（`react-flow__node-text`）在 `empty_generate`
 * 状态下渲染一张「尝试：」卡片，卡片里的按钮各自带一个 `functionKey`，
 * 原站用 `libtv.canvas.node.hint.click` 上报点击。逆向规格见
 * `docs/integrations/liblib-text-node-re.md` 第 2、3 节。
 *
 * 本项目把原站的 `TEXT` 节点落在**提示词节点**（`gen` + `kind: "prompt"`）上：
 * 原站的文本节点既要写正文、又能一键转成视频/图片/音乐，本项目的提示词节点
 * 已经能写正文并驱动下游生成节点，这里保留已接通的动作。
 */
export type CanvasTextTryActionKey =
  | "writeText"
  | "textToVideo"
  | "imageToPrompt"
  | "textToMusic";

export interface CanvasTextTryActionDefinition {
  readonly key: CanvasTextTryActionKey;
  /** 与原站 i18n 一致的文案。 */
  readonly label: string;
  readonly icon: LibTVMediaIconName;
  /** 悬停时在文案右侧显现的补充说明（原站同样有这一位 `hint`）。 */
  readonly hint: string;
}

export const CANVAS_TEXT_TRY_ACTIONS: readonly CanvasTextTryActionDefinition[] = [
  {
    key: "writeText",
    label: "自己编写内容",
    icon: "text-file",
    hint: "在这个节点里直接写正文，写完可连到下游节点",
  },
  {
    key: "textToVideo",
    label: "文生视频",
    icon: "video-add-s",
    hint: "写一段故事，并在右边建一个视频节点接着生成",
  },
  {
    key: "imageToPrompt",
    label: "图片反推提示词",
    icon: "image-s",
    hint: "从画布、素材库或本机选图，由文本模型反推提示词",
  },
  {
    key: "textToMusic",
    label: "文字生音乐",
    icon: "audio",
    hint: "写入音乐描述模板 · 当前供应商未接入音乐生成",
  },
];

/**
 * 「文生视频」预置的故事提示词。
 *
 * 原站在三段爆款脚本里随机取一段（`t[Math.floor(Math.random() * t.length)]`），
 * 本项目照抄这三段原文与「随机取一段」的规则。
 */
export const TEXT_TO_VIDEO_PROMPTS: readonly string[] = [
  "爆款情绪短片\n傍晚的城市天台，一个年轻人迎着晚风张开双手，镜头从远景缓慢推进到中景，头发被风吹起，夕阳逆光，光晕明显，空气中有漂浮微尘，电影级色彩分级，浅景深，情绪张力强，慢动作",
  "电影级人物镜头\n雨夜街头，霓虹灯反射在湿漉漉的地面，女主撑伞站在路灯下，表情克制而坚定，镜头环绕人物360度缓慢移动，浅景深，光影对比强烈，电影级调色，真实皮肤质感",
  "高级广告镜头\n黑色背景中一款高端腕表悬浮出现，镜头从极近距离微距开始，缓慢拉远，金属表面光泽细腻，细节清晰，柔光灯打亮轮廓，商业广告级质感，干净构图，慢速旋转展示",
];

/** 「图片反推提示词」写进文本节点的任务指令（原站写在文本节点的 `params.prompt`）。 */
export const IMAGE_TO_PROMPT_NODE_PROMPT =
  "根据图片生成结构化中文提示词，包括主体描述、环境、光影、镜头语言、风格关键词。";

export const TEXT_TO_MUSIC_PROMPT =
  "生成一首现代品牌电子音乐（约 110 BPM），干净有力的低频贝斯，清晰电子鼓点，整体风格高级、未来感强。开场节奏型贝斯与简洁合成器音色建立律动。主段加入稳定鼓点，节奏清晰，保持克制的张力。强化段加入更丰富的音层，合成器音色提升，律动增强但不过度拥挤。结尾鼓点减弱，仅保留低频与氛围音渐出，干净利落收尾。";

/** 从预置故事里随机取一段（与原站的取法一致）。 */
export function randomTextToVideoPrompt(): string {
  const index = Math.floor(Math.random() * TEXT_TO_VIDEO_PROMPTS.length);
  return TEXT_TO_VIDEO_PROMPTS[index] ?? TEXT_TO_VIDEO_PROMPTS[0] ?? "";
}
