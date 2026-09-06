import { invoke } from "@tauri-apps/api/core";
import * as v from "valibot";
import { isDesktopRuntime, type GenerationResultRecord } from "./backend";

export interface CoverImageClient {
  resumeResult(command: {
    readonly taskId: string;
    readonly resultIndex: number;
  }): Promise<GenerationResultRecord>;
  normalize(command: { readonly sourcePath: string; readonly outputId: string }): Promise<{
    readonly path: string;
    readonly width: number;
    readonly height: number;
  }>;
}

const coverImageSchema = v.object({
  path: v.pipe(v.string(), v.nonEmpty()),
  width: v.literal(1080),
  height: v.literal(1440),
});

export const coverImageClient: CoverImageClient = {
  async resumeResult(command) {
    if (!isDesktopRuntime()) throw new Error("恢复封面保存需要在桌面应用中执行。");
    return invoke<GenerationResultRecord>("resume_cover_image_result", { command });
  },
  async normalize(command) {
    if (!isDesktopRuntime()) throw new Error("封面尺寸处理需要在桌面应用中执行。");
    const result: unknown = await invoke("normalize_cover_image", { command });
    const parsed = v.safeParse(coverImageSchema, result);
    if (!parsed.success) throw new Error("封面处理未返回完整的 1080×1440 图片。");
    return parsed.output;
  },
};
