export const NANO_BANANA_21_MODEL = "gemini-nano-banana-2.1";
export const NANO_BANANA_21_PROFILE = "gemini_native_image_v1";
export const NANO_BANANA_21_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "4:5", "5:4", "21:9", "1:4", "4:1", "1:8", "8:1"] as const;

export function isNanoBanana21Model(modelId: string): boolean {
  return modelId.toLowerCase() === NANO_BANANA_21_MODEL;
}

export function nanoBanana21Parameters(): Record<string, unknown> {
  // Konjac 2026-11-05: search variants either lacked grounding evidence or
  // returned HTTP 400. Expose image and thinking controls verified on this route.
  return {
    aspect_ratio: { type: "string", label: "画幅", default: "1:1", enum: [...NANO_BANANA_21_RATIOS], order: 0 },
    resolution: { type: "string", label: "分辨率", default: "1K", enum: ["1K", "2K", "4K"], order: 1 },
    thinking_level: { type: "string", label: "思考强度", default: "medium", enum: ["minimal", "medium", "high"], description: "快速模式延迟更低；深入模式投入更多推理，耗时与费用可能增加。", order: 2 },
  };
}
