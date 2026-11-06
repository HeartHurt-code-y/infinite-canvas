import type { ModelParameterValue } from "./modelCapabilities";

export const GPT_IMAGE_25_PROFILE = "openai_gpt25_images_v1";

export function isGptImage25Model(modelId: string): boolean {
  return /^gpt-image-2\.5-(sunburst|flare)(?:-\d{4}-\d{2}-\d{2})?$/i.test(modelId);
}

// These are UI shortcuts for native pixel sizes, not upstream resolution tiers.
export const GPT_IMAGE_25_SIZES = [
  { ratio: "1:1", sizes: ["1024x1024", "2048x2048", "2880x2880"] },
  { ratio: "16:9", sizes: ["1536x864", "2560x1440", "3840x2160"] },
  { ratio: "9:16", sizes: ["864x1536", "1440x2560", "2160x3840"] },
  { ratio: "4:3", sizes: ["1536x1152", "2048x1536", "3264x2448"] },
  { ratio: "3:4", sizes: ["1152x1536", "1536x2048", "2448x3264"] },
  { ratio: "3:2", sizes: ["1536x1024", "2304x1536", "3456x2304"] },
  { ratio: "2:3", sizes: ["1024x1536", "1536x2304", "2304x3456"] },
  { ratio: "4:5", sizes: ["1024x1280", "1664x2080", "2560x3200"] },
  { ratio: "5:4", sizes: ["1280x1024", "2080x1664", "3200x2560"] },
  { ratio: "21:9", sizes: ["1792x768", "2800x1200", "3808x1632"] },
  { ratio: "3:1", sizes: ["1536x512", "3072x1024", "3840x1280"] },
  { ratio: "1:3", sizes: ["512x1536", "1024x3072", "1280x3840"] },
] as const;

export function gptImage25Size(values: Readonly<Record<string, ModelParameterValue>>): string {
  const size = String(values["size"] ?? "auto");
  if (size !== "auto" || !values["aspect_ratio"]) return size;
  const row = GPT_IMAGE_25_SIZES.find(entry => entry.ratio === values["aspect_ratio"]);
  const tier = String(values["resolution"] ?? "2k").toLowerCase();
  return row?.sizes[tier === "1k" ? 0 : tier === "4k" ? 2 : 1] ?? size;
}

export function gptImage25SizeIssue(size: string): string | null {
  if (size === "auto") return null;
  const match = /^(\d+)x(\d+)$/.exec(size);
  if (!match) return "请输入完整的图片宽度和高度。";
  const width = Number(match[1]), height = Number(match[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 16 || height < 16 || width > 3840 || height > 3840 || width % 16 !== 0 || height % 16 !== 0)
    return "宽高须为 16 的倍数，且单边不超过 3840 px。";
  if (width / height < 1 / 3 || width / height > 3) return "宽高比须在 1:3～3:1 之间。";
  if (width * height < 655_360 || width * height > 8_294_400) return "总像素须在 655,360～8,294,400 之间（约 0.66～8.29 MP）。";
  return null;
}

export function gptImage25Parameters(): Record<string, unknown> {
  return {
    size: { type: "string", label: "尺寸", default: "auto", order: 1 },
    quality: { type: "string", label: "质量", default: "auto", enum: ["auto", "low", "medium", "high", "xhigh", "max"], order: 2 },
    background: { type: "string", label: "背景", default: "auto", enum: ["auto", "opaque", "transparent"], order: 3 },
    // Konjac rejects WebP for these models, despite the broader official API.
    output_format: { type: "string", label: "输出格式", default: "png", enum: ["png", "jpeg"], order: 4 },
    output_compression: { type: "integer", label: "JPEG 质量", description: "仅对 JPEG 生效；数值越高，保留细节越多，文件通常越大。", default: 100, minimum: 0, maximum: 100, step: 1, order: 5 },
    moderation: { type: "string", label: "内容审核", default: "auto", enum: ["auto", "low"], optional: true, order: 6 },
    n: { type: "integer", label: "生成数量", default: 1, minimum: 1, maximum: 10, order: 7 },
  };
}
