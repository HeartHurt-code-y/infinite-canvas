import type { ModelParameterValue } from "./modelCapabilities";

export const SEEDREAM_PRO_RESOLUTIONS = ["1K", "1.5K", "2K"] as const;
export type SeedreamProResolution = (typeof SEEDREAM_PRO_RESOLUTIONS)[number];
export const SEEDREAM_PRO_RATIOS = ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9"] as const;
export type SeedreamProRatio = (typeof SEEDREAM_PRO_RATIOS)[number];

// Official Pro mappings differ from the Lite/4.5 table, notably at 16:9.
const SIZES: Readonly<Record<SeedreamProResolution, readonly string[]>> = {
  "1K": ["1024x1024", "1152x864", "864x1152", "1424x800", "800x1424", "1248x832", "832x1248", "1568x672"],
  "1.5K": ["1536x1536", "1792x1344", "1344x1792", "2048x1152", "1152x2048", "1872x1248", "1248x1872", "2352x1008"],
  "2K": ["2048x2048", "2368x1776", "1776x2368", "2816x1584", "1584x2816", "2496x1664", "1664x2496", "3136x1344"],
};

export function isSeedreamProImageModel(modelId: string): boolean {
  return /seedream-5[.-]0-pro(?:-|$)/i.test(modelId);
}

export function seedreamProSize(resolution: SeedreamProResolution, ratio: SeedreamProRatio): string {
  return SIZES[resolution][SEEDREAM_PRO_RATIOS.indexOf(ratio)]!;
}

export function seedreamProSizeInfo(size: string): { resolution: SeedreamProResolution; ratio: SeedreamProRatio | "adaptive" | "custom" } {
  if (SEEDREAM_PRO_RESOLUTIONS.some(value => value === size)) {
    return { resolution: size as SeedreamProResolution, ratio: "adaptive" };
  }
  for (const resolution of SEEDREAM_PRO_RESOLUTIONS) {
    const index = SIZES[resolution].indexOf(size);
    if (index >= 0) return { resolution, ratio: SEEDREAM_PRO_RATIOS[index]! };
  }
  const [width, height] = size.split("x").map(Number);
  const pixels = (width ?? 0) * (height ?? 0);
  return { resolution: pixels <= 1_200_000 ? "1K" : pixels <= 2_600_000 ? "1.5K" : "2K", ratio: "custom" };
}

export function seedreamProParameterIssue(values: Readonly<Record<string, ModelParameterValue>>): string | null {
  const size = String(values["size"] ?? "2K");
  const layers = values["layer_decomposition"] === true;
  if (layers) {
    if (size !== "auto" && !SEEDREAM_PRO_RESOLUTIONS.some(value => value === size)) {
      return "图层拆分请选择自动、1K、1.5K 或 2K，输出画幅沿用原图。";
    }
  } else if (!SEEDREAM_PRO_RESOLUTIONS.some(value => value === size)) {
    const match = /^(\d+)x(\d+)$/.exec(size);
    if (!match) return "请输入完整的图片宽度和高度。";
    const width = Number(match[1]), height = Number(match[2]);
    const pixels = width * height;
    if (!Number.isSafeInteger(pixels) || pixels < 921_600 || pixels > 4_624_220) {
      return "总像素须在 921,600～4,624,220 之间（约 0.92～4.62 MP）。";
    }
    if (width / height < 1 / 16 || width / height > 16) return "宽高比须在 1:16～16:1 之间。";
  }
  const format = String(values["output_format"] ?? "jpeg");
  if (!["jpeg", "jpg", "png"].includes(format)) return "Seedream 5.0 Pro 仅支持 JPEG 或 PNG 输出。";
  if (values["background"] === "transparent" && format !== "png") return "透明背景请使用 PNG 输出。";
  return null;
}

export function seedreamProSummary(values: Readonly<Record<string, ModelParameterValue>>): string {
  const size = String(values["size"] ?? "2K");
  if (values["layer_decomposition"] === true) return `图层拆分 · ${size === "auto" ? "自动" : size}`;
  const info = seedreamProSizeInfo(size);
  return info.ratio === "custom" ? size.replace("x", " × ") : `${info.ratio === "adaptive" ? "智能比例" : info.ratio} · ${info.resolution}`;
}
