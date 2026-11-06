import type { VideoModelCapabilities } from "./canvasModelCapabilities";
import type { SeedanceTaskMode } from "./seedanceTasks";

export type CanvasVideoMode = "auto" | "text" | "reference" | "first_frame" | "first_last_frame" | "multi_frame" | "image_reference" | "video_reference" | "audio_reference" | "edit" | "extend" | "longVideo2video";
export const CANVAS_VIDEO_MODES: readonly { value: CanvasVideoMode; label: string }[] = [
  { value: "text", label: "文生视频" },
  { value: "reference", label: "全能参考" },
  { value: "first_frame", label: "图生视频" },
  { value: "first_last_frame", label: "首尾帧" },
  { value: "image_reference", label: "图片参考" },
];

// LibTV 469850：视频编辑、延长属于模型能力，并非退役模式。
// 这些意图只有已接入对应提交协议的模型才提供新入口。
const ADDITIONAL_MODE_LABELS: Readonly<Record<string, string>> = {
  multi_frame: "多关键帧",
  longVideo2video: "超长视频",
  video_reference: "视频参考",
  audio_reference: "音频参考",
  edit: "视频编辑",
  extend: "视频延长",
};

function modelSupportsMode(policy: VideoModelCapabilities, mode: CanvasVideoMode): boolean {
  if (mode === "longVideo2video") return true;
  const referenceKind = mode === "image_reference" ? "image"
    : mode === "video_reference" ? "video"
    : mode === "audio_reference" ? "audio" : null;
  return referenceKind === null ? policy.modes.includes(mode)
    : policy.modes.includes("reference") && policy.inputKinds.includes(referenceKind);
}

export function canvasVideoModeRestriction(
  policy: VideoModelCapabilities | undefined,
  mode: CanvasVideoMode | undefined,
  inputs: readonly { kind: string }[],
): string | undefined {
  if (!policy || mode === "longVideo2video") return undefined;
  const effective = canvasVideoModeValue(mode, inputs, policy);
  const media = inputs.filter(input => input.kind !== "text");
  const images = media.filter(input => input.kind === "image").length;
  if (!modelSupportsMode(policy, effective)
      || media.some(input => !policy.inputKinds.includes(input.kind))
      || (policy.requiredKind && !media.some(input => input.kind === policy.requiredKind))
      || (policy.maxImages != null && images > policy.maxImages)) {
    return policy.reason;
  }
  if (policy.veo && (effective === "first_frame" && images !== 1 || effective === "first_last_frame" && images !== 2)) {
    return "Veo 单首帧需要 1 张图片，首尾帧需要 2 张图片。";
  }
  if ((effective === "edit" || effective === "extend") && !media.some(input => input.kind === "video")) {
    return "请先连接要编辑或延长的视频。";
  }
  return undefined;
}

export function veoRequiresEightSeconds(
  policy: VideoModelCapabilities | undefined,
  mode: CanvasVideoMode | undefined,
  inputs: readonly { kind: string }[],
  parameters: Readonly<Record<string, unknown>>,
): boolean {
  if (!policy?.veo || mode === "longVideo2video") return false;
  const effective = canvasVideoModeValue(mode, inputs, policy);
  return policy.veo === "3" || effective === "reference" || effective === "image_reference" ||
    /^(1080p|4k)$/i.test(String(parameters["resolution"] ?? ""));
}

export const VEO_DURATION_RESTRICTION = "Veo 3、参考图模式或 1080P 及以上分辨率需要 8 秒时长。";

export function canvasVideoModeOptions(
  mode: CanvasVideoMode,
  inputs: readonly { kind: string }[],
  supportsVideoTasks = false,
  klingV4 = false,
  policy?: VideoModelCapabilities,
) {
  const imageCount = inputs.filter(input => input.kind === "image").length;
  const videoCount = inputs.filter(input => input.kind === "video").length;
  const hasMedia = inputs.some(input => input.kind === "image" || input.kind === "video" || input.kind === "audio");
  const options = CANVAS_VIDEO_MODES.map(option => ({
    ...option,
    disabled: option.value === "reference" ? !hasMedia
      : option.value === "first_last_frame" ? imageCount < 2
      : option.value === "first_frame" || option.value === "image_reference" ? imageCount === 0
      : option.value === "text" && hasMedia,
  }));
  if (klingV4) {
    options.push({ value: "multi_frame", label: "多关键帧", disabled: imageCount < 2 });
  }
  for (const value of ["edit", "extend"] as const) {
    if (policy?.modes.includes(value) ?? (supportsVideoTasks || (klingV4 && value === "edit"))) {
      options.push({ value, label: ADDITIONAL_MODE_LABELS[value]!, disabled: videoCount === 0 });
    }
  }
  if (ADDITIONAL_MODE_LABELS[mode] && !options.some(option => option.value === mode)) {
    options.push({ value: mode, label: ADDITIONAL_MODE_LABELS[mode], disabled: mode !== "longVideo2video" });
  }
  return options.map(option => {
    const description = policy && !modelSupportsMode(policy, option.value) ? policy.reason
      : option.value !== "text" ? canvasVideoModeRestriction(policy, option.value, inputs) : undefined;
    return { ...option, description, disabled: option.disabled || description !== undefined };
  });
}

export function canvasVideoModeValue(
  mode: CanvasVideoMode | undefined,
  inputs: readonly { kind: string }[],
  policy?: VideoModelCapabilities,
): CanvasVideoMode {
  const hasMedia = inputs.some(input => input.kind === "image" || input.kind === "video" || input.kind === "audio");
  if (!mode || mode === "auto" || (mode === "text" && hasMedia)) {
    if (!hasMedia) return "text";
    if (policy && (policy.veo || !policy.modes.includes("reference")) && policy.modes.includes("first_frame") &&
        inputs.filter(input => input.kind !== "text").every(input => input.kind === "image") &&
        inputs.filter(input => input.kind === "image").length === 1) return "first_frame";
    return "reference";
  }
  return mode;
}

export function videoModeLabel(mode: CanvasVideoMode | undefined, inputs: readonly { kind: string }[]): string {
  const value = canvasVideoModeValue(mode, inputs);
  return CANVAS_VIDEO_MODES.find(item => item.value === value)?.label ?? ADDITIONAL_MODE_LABELS[value] ?? "文生视频";
}

/** User mode chooses roles, never filters media. The supplier decides whether the combination is accepted. */
export function compileCanvasVideoMode(
  mode: CanvasVideoMode | undefined,
  inputs: readonly { key: string; kind: string; role?: string }[],
  originalRoles: Readonly<Record<string, string>> = {},
  policy?: VideoModelCapabilities,
): { mediaRoles: Record<string, string>; taskMode: SeedanceTaskMode } {
  const mediaRoles = { ...originalRoles };
  const mediaInputs = inputs.filter(input => input.kind !== "text" && !["file", "link"].includes(originalRoles[input.key] ?? input.role ?? ""));
  if (mode === "longVideo2video") return { mediaRoles, taskMode: "auto" };
  if (!mode || mode === "auto") return { mediaRoles, taskMode: "auto" };
  mode = canvasVideoModeValue(mode, mediaInputs, policy);
  if (mode === "multi_frame") {
    const images = mediaInputs.filter(input => input.kind === "image");
    const first = images.find(input => originalRoles[input.key] === "first_frame") ?? images[0];
    const last = images.find(input => input.key !== first?.key && originalRoles[input.key] === "last_frame") ?? images.at(-1);
    for (const input of mediaInputs) mediaRoles[input.key] = input.kind === "image"
      ? input.key === first?.key ? "first_frame" : input.key === last?.key ? "last_frame" : "middle_frame"
      : `reference_${input.kind}`;
    return { mediaRoles, taskMode: "auto" };
  }
  if (mode === "first_frame" || mode === "first_last_frame") {
    const images = mediaInputs.filter(item => item.kind === "image");
    const first = images.find(item => originalRoles[item.key] === "first_frame") ?? images[0];
    const last = images.find(item => item.key !== first?.key && originalRoles[item.key] === "last_frame") ?? images.find(item => item.key !== first?.key);
    for (const input of mediaInputs) mediaRoles[input.key] = `reference_${input.kind}`;
    if (first) mediaRoles[first.key] = "first_frame";
    if (mode === "first_last_frame" && last) mediaRoles[last.key] = "last_frame";
    return { mediaRoles, taskMode: mode };
  }
  if (mode !== "text") for (const input of mediaInputs) {
    mediaRoles[input.key] = mode === "edit" && originalRoles[input.key] === "base_video" && input.kind === "video"
      ? "base_video" : `reference_${input.kind}`;
  }
  return { mediaRoles, taskMode: mode === "edit" || mode === "extend" ? mode : mode === "text" ? "auto" : "reference" };
}
