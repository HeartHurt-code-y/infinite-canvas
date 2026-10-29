import type { SeedanceTaskMode } from "./seedanceTasks";

export type CanvasVideoMode = "auto" | "text" | "reference" | "first_frame" | "first_last_frame" | "image_reference" | "video_reference" | "audio_reference" | "edit" | "extend" | "longVideo2video";
export const CANVAS_VIDEO_MODES: readonly { value: CanvasVideoMode; label: string }[] = [
  { value: "auto", label: "自动判断" },
  { value: "text", label: "文生视频" },
  { value: "longVideo2video", label: "超长视频" },
  { value: "reference", label: "全能参考" },
  { value: "first_frame", label: "图生视频" },
  { value: "first_last_frame", label: "首尾帧" },
  { value: "image_reference", label: "图片参考" },
  { value: "video_reference", label: "视频参考" },
  { value: "audio_reference", label: "音频参考" },
  { value: "edit", label: "视频编辑" },
  { value: "extend", label: "视频延长" },
];

export function videoModeLabel(mode: CanvasVideoMode | undefined, inputs: readonly { kind: string }[]): string {
  if (mode && mode !== "auto") return CANVAS_VIDEO_MODES.find(item => item.value === mode)?.label ?? "文生视频";
  return inputs.length ? "全能参考" : "文生视频";
}

/** User mode chooses roles, never filters media. The supplier decides whether the combination is accepted. */
export function compileCanvasVideoMode(
  mode: CanvasVideoMode | undefined,
  inputs: readonly { key: string; kind: string }[],
  originalRoles: Readonly<Record<string, string>> = {},
): { mediaRoles: Record<string, string>; taskMode: SeedanceTaskMode } {
  const mediaRoles = { ...originalRoles };
  if (mode === "longVideo2video") return { mediaRoles, taskMode: "auto" };
  if (!mode || mode === "auto") return { mediaRoles, taskMode: "auto" };
  if (mode === "first_frame" || mode === "first_last_frame") {
    const images = inputs.filter(item => item.kind === "image");
    const first = images.find(item => originalRoles[item.key] === "first_frame") ?? images[0];
    const last = images.find(item => item.key !== first?.key && originalRoles[item.key] === "last_frame") ?? images.find(item => item.key !== first?.key);
    for (const input of inputs) if (input.kind !== "text") mediaRoles[input.key] = `reference_${input.kind}`;
    if (first) mediaRoles[first.key] = "first_frame";
    if (mode === "first_last_frame" && last) mediaRoles[last.key] = "last_frame";
    return { mediaRoles, taskMode: mode };
  }
  if (mode !== "text") for (const input of inputs) {
    if (input.kind !== "text" && !["file", "link"].includes(originalRoles[input.key] ?? "")) mediaRoles[input.key] = `reference_${input.kind}`;
  }
  return { mediaRoles, taskMode: mode === "edit" || mode === "extend" ? mode : mode === "text" ? "auto" : "reference" };
}
