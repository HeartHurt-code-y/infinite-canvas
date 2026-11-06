import { pixverseActionRestriction } from "./canvasModelCapabilities";
import type { ModelParameterValue } from "./modelCapabilities";

export const PIXVERSE_PROFILE = "moyu_pixverse_video_v1";
export const PIXVERSE_ACTIONS = [
  ["text", "文生视频"], ["img", "图生视频"], ["transition", "首尾帧"],
  ["fusion", "多图参考"], ["extend", "视频延长"], ["lip_sync", "对口型"],
  ["sound_effect", "音效生成"], ["restyle", "视频重绘"], ["swap", "主体替换"],
  ["multi_transition", "智能多帧"], ["mimic", "动作模仿"], ["modify", "视频编辑"],
  ["upscale", "超清视频"], ["avatar", "图片数字人"], ["agent", "场景化生成"],
] as const;

const VIDEO_ACTIONS = new Set(["extend", "lip_sync", "sound_effect", "restyle", "swap", "mimic", "modify", "upscale", "agent"]);

export function pixverseIntent(model: string, values: Readonly<Record<string, ModelParameterValue>>, inputs: readonly { kind: string }[], hasLastFrame = false) {
  const images = inputs.filter(input => input.kind === "image").length;
  const videos = inputs.filter(input => input.kind === "video").length;
  const audios = inputs.filter(input => input.kind === "audio").length;
  const v6 = model.toLowerCase() === "pixverse-v6";
  const templates = model.toLowerCase() !== "pixverse-v6-max";
  const explicit = String(values["action"] ?? "");
  const action = explicit || (hasLastFrame ? "transition" : videos && v6 || images > 1 ? "fusion" : images ? "img" : "text");
  const omni = v6 && action === "fusion" && (values["reference_mode"] === "omni" || videos > 0);
  const hasVideoId = !!values["video_media_id"] || !!values["source_video_id"];
  return { action, omni, images, videos, audios, templates, durationFromVideo: omni && (videos > 0 || hasVideoId), ratio: action === "text" || action === "fusion", multiClip: v6 && (action === "text" || action === "img"), audio: ["text", "img", "transition", "fusion", "extend"].includes(action), videoInput: VIDEO_ACTIONS.has(action) || omni };
}

export function pixverseRequestRestriction(
  model: string,
  values: Readonly<Record<string, ModelParameterValue>>,
  inputs: readonly { kind: string }[],
  hasLastFrame: boolean,
): string | undefined {
  const intent = pixverseIntent(model, values, inputs, hasLastFrame);
  const restriction = pixverseActionRestriction(model, intent.action) ??
    (values["reference_mode"] === "omni" ? pixverseActionRestriction(model, "fusion_omni") : undefined);
  if (restriction) return restriction;
  if (intent.videos > 0 && !intent.videoInput) return "当前 PixVerse 模式不接收视频素材；请更换模式或移除视频。";
  if (intent.audios > 0 && ["text", "img", "transition", "fusion", "extend"].includes(intent.action)) {
    return "当前 PixVerse 模式不接收音频素材。";
  }
  if (intent.action === "img" && intent.images !== 1 || intent.action === "transition" && intent.images !== 2) {
    return "PixVerse 图生视频需要 1 张图片，首尾帧需要 2 张图片。";
  }
  const sources = intent.videos + Number(Boolean(values["source_video_id"])) + Number(Boolean(values["video_media_id"]));
  if (intent.action === "extend" && sources !== 1) return "PixVerse 视频延长需要且仅能使用一个视频来源。";
  return undefined;
}

export function pixverseFieldVisible(key: string, intent: ReturnType<typeof pixverseIntent>): boolean {
  if (key === "action" || key === "reference_mode") return false;
  if (key === "aspect_ratio") return intent.ratio;
  if (key === "duration") return !intent.durationFromVideo;
  if (key === "generate_audio_switch") return intent.audio;
  if (key === "generate_multi_clip_switch") return intent.multiClip;
  if (key === "template_id") return intent.action === "img" && intent.templates;
  if (key === "source_video_id" || key === "video_media_id") return intent.videoInput && intent.videos === 0;
  if (key === "restyle_id") return intent.action === "restyle";
  if (key === "audio_media_id" || key === "lip_sync_tts_content" || key === "lip_sync_tts_speaker_id") return intent.audios === 0 && (intent.action === "lip_sync" || intent.action === "avatar");
  if (key === "sound_effect_content" || key === "sound_effect_switch") return intent.action === "sound_effect";
  return true;
}

export function pixverseHint(intent: ReturnType<typeof pixverseIntent>): string {
  if (intent.omni) return "V6 Omni 支持最多 10 张图片、2 段视频，视频合计不超过 15 秒；含视频时按最长参考视频匹配时长。可用 @ 插入素材引用。";
  if (intent.action === "fusion") return "多图参考支持 1～7 张图片，可选择输出画幅；可用 @ 插入素材引用。";
  if (intent.action === "img") return "图生视频只用一张图片，画幅由图片决定。特效模板需使用已开通的模板 ID。";
  if (intent.action === "transition") return "连接两张图片并指定首帧、尾帧，输出画幅沿用输入图片。";
  if (intent.action === "lip_sync") return "连接一段视频，并连接音频或填写 TTS 音色与文本；音频和 TTS 二选一。";
  if (intent.action === "avatar") return "连接一张人物图片，并连接音频或填写 TTS 音色与文本。";
  if (VIDEO_ACTIONS.has(intent.action)) return "连接源视频后自动上传；也可填写一个已有视频资源 ID 或生成任务 ID。1080P 与后期能力取决于账号权限。";
  return "支持 1～15 秒、8 种画幅。1080P 需账号开通权限；提示词最多 5000 字符。";
}
