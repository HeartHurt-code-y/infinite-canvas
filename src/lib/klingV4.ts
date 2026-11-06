/** Moyu Kling 4.0; the Atlas-prefixed model has a different contract. */
export function isMoyuKlingV4Model(modelId: string): boolean {
  return modelId.toLowerCase() === "kling-v4";
}

export function klingV4Parameters(): Record<string, unknown> {
  return {
    aspect_ratio: { type: "string", label: "画幅", default: "auto", enum: ["auto", "16:9", "9:16", "1:1", "21:9"], order: 0,
      description: "自动时跟随首帧或上游判断；纯文生默认横屏。" },
    resolution: { type: "string", label: "分辨率", default: "1080p", enum: ["720p", "1080p"], order: 1 },
    duration: { type: "integer", label: "时长", default: 10, minimum: 3, maximum: 30, step: 1, order: 2 },
    element_ids: { type: "string", label: "主体 ID", optional: true, order: 4,
      description: "引用可灵已创建的主体，最多 7 个，以逗号或换行分隔；须同时提供参考图、视频或音色。" },
    voice_ids: { type: "string", label: "音色 ID", optional: true, order: 5,
      description: "引用可灵已创建的音色，最多 3 个，以逗号或换行分隔；不是本地音频文件。" },
  };
}

export function klingV4MediaRoles(kind: string): readonly { value: string; label: string }[] {
  if (kind === "video") return [{ value: "reference_video", label: "参考视频" }, { value: "base_video", label: "待编辑视频" }];
  if (kind !== "image") return [];
  return [
    { value: "reference_image", label: "参考图" },
    { value: "first_frame", label: "首帧" },
    { value: "middle_frame", label: "中间帧" },
    { value: "last_frame", label: "尾帧" },
  ];
}
