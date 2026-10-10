import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import * as v from "valibot";
import { isDesktopRuntime } from "./backend";

export interface BrandDesignImage {
  readonly dataUrl: string;
  readonly width: number;
  readonly height: number;
  /** SHA-256 of the original captured source bytes, before EXIF normalization. */
  readonly contentHash: string;
}

export interface BrandDesignExportFile {
  readonly name: string;
  /** Raw base64 file bytes without a data URL prefix. */
  readonly base64: string;
}

export interface BrandDesignExportResult {
  readonly directory: string;
  /** Requested deliverable count, excluding the native SHA-256 bundle receipt. */
  readonly count: number;
}

const nonempty = v.pipe(v.string(), v.nonEmpty());
const positiveInteger = v.pipe(v.number(), v.integer(), v.minValue(1));
const imageSchema = v.object({
  dataUrl: v.pipe(v.string(), v.regex(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/)),
  width: positiveInteger,
  height: positiveInteger,
  contentHash: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
});
const exportSchema = v.object({ directory: nonempty, count: positiveInteger });

function requireDesktop() {
  if (!isDesktopRuntime()) throw new Error("请在桌面应用中读取本机图片或导出品牌设计。");
}

export async function readBrandDesignImage(path: string): Promise<BrandDesignImage> {
  requireDesktop();
  if (!path.trim()) throw new Error("请选择已保存到本机的图片文件。");
  return v.parse(imageSchema, await invoke("read_brand_design_image", { command: { path } }));
}

export async function exportBrandDesignBundle(
  files: readonly BrandDesignExportFile[],
  manifest: string,
): Promise<BrandDesignExportResult | null> {
  requireDesktop();
  const directory = await open({
    directory: true,
    multiple: false,
    title: "选择品牌设计交付目录",
  });
  if (!directory || Array.isArray(directory)) return null;
  const result = v.parse(
    exportSchema,
    await invoke("export_brand_design_bundle", { command: { directory, files, manifest } }),
  );
  if (result.count !== files.length) throw new Error("设计交付文件数量不匹配，请检查导出结果。");
  return result;
}
