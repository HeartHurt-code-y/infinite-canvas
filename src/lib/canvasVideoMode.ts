import type { SeedanceTaskMode } from "./seedanceTasks";

export type CanvasVideoMode = "auto" | "text" | "reference" | "first_frame" | "first_last_frame" | "image_reference" | "video_reference" | "audio_reference" | "edit" | "extend" | "longVideo2video";
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
  longVideo2video: "超长视频",
  video_reference: "视频参考",
  audio_reference: "音频参考",
  edit: "视频编辑",
  extend: "视频延长",
};

export function canvasVideoModeOptions(mode: CanvasVideoMode, inputs: readonly { kind: string }[], supportsVideoTasks = false) {
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
  if (supportsVideoTasks) for (const value of ["edit", "extend"] as const) {
    options.push({ value, label: ADDITIONAL_MODE_LABELS[value]!, disabled: videoCount === 0 });
  }
  if (ADDITIONAL_MODE_LABELS[mode] && !options.some(option => option.value === mode)) {
    options.push({ value: mode, label: ADDITIONAL_MODE_LABELS[mode], disabled: mode !== "longVideo2video" });
  }
  return options;
}

export function canvasVideoModeValue(mode: CanvasVideoMode | undefined, inputs: readonly { kind: string }[]): CanvasVideoMode {
  const hasMedia = inputs.some(input => input.kind === "image" || input.kind === "video" || input.kind === "audio");
  if (!mode || mode === "auto" || (mode === "text" && hasMedia)) return hasMedia ? "reference" : "text";
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
): { mediaRoles: Record<string, string>; taskMode: SeedanceTaskMode } {
  const mediaRoles = { ...originalRoles };
  const mediaInputs = inputs.filter(input => input.kind !== "text" && !["file", "link"].includes(originalRoles[input.key] ?? input.role ?? ""));
  if (mode === "longVideo2video") return { mediaRoles, taskMode: "auto" };
  if (!mode || mode === "auto") return { mediaRoles, taskMode: "auto" };
  mode = canvasVideoModeValue(mode, mediaInputs);
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
    mediaRoles[input.key] = `reference_${input.kind}`;
  }
  return { mediaRoles, taskMode: mode === "edit" || mode === "extend" ? mode : mode === "text" ? "auto" : "reference" };
}
