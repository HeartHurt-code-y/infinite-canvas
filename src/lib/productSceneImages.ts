import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import * as v from "valibot";
import { isDesktopRuntime } from "./backend";

export interface PreparedProductView {
  readonly path: string;
  readonly width: number;
  readonly height: number;
  readonly contentHash: string;
}

export interface ProductSceneComposite {
  readonly path: string;
  readonly width: number;
  readonly height: number;
  /** 64-bit difference hash of the background alone, before foreground composition. */
  readonly backgroundHash: string;
  /** SHA-256 of the approved foreground file. */
  readonly foregroundHash: string;
}

export interface ProductSceneGeneratedImage {
  readonly path: string;
  readonly width: number;
  readonly height: number;
  /** Full-image dHash, not a product-identity or background-only measurement. */
  readonly imageHash: string;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly padded: boolean;
}

/** Normalized image coordinates, ordered top-left, top-right, bottom-right, bottom-left. */
export interface ProductSceneLogoPoint {
  readonly x: number;
  readonly y: number;
}

export interface ProductSceneLogoComposite {
  readonly path: string;
  readonly width: number;
  readonly height: number;
  readonly imageHash: string;
  readonly logoHash: string;
}

export interface ProductSceneImageClient {
  prepare(command: { readonly sourcePath: string }): Promise<PreparedProductView>;
  prepareLogo(command: { readonly sourcePath: string }): Promise<PreparedProductView>;
  validateLogo(command: { readonly path: string; readonly contentHash: string }): Promise<void>;
  applyLogo(command: {
    readonly sourcePath: string;
    readonly logoPath: string;
    readonly logoHash: string;
    readonly outputId: string;
    readonly quad: readonly ProductSceneLogoPoint[];
  }): Promise<ProductSceneLogoComposite>;
  validateViews(command: {
    readonly views: readonly { readonly path: string; readonly contentHash: string }[];
  }): Promise<void>;
  compose(command: {
    readonly backgroundPath: string;
    readonly productPath: string;
    readonly productHash: string;
    readonly outputId: string;
    readonly aspectRatio: "3:4" | "9:16";
    readonly placement: {
      readonly centerX: number;
      readonly baselineY: number;
      readonly widthFraction: number;
    };
    readonly depthStrength: number;
  }): Promise<ProductSceneComposite>;
  normalizeGenerated(command: {
    readonly sourcePath: string;
    readonly outputId: string;
    readonly aspectRatio: "3:4" | "9:16";
  }): Promise<ProductSceneGeneratedImage>;
  export(command: {
    readonly paths: readonly string[];
    readonly manifest: string;
  }): Promise<{ readonly directory: string; readonly count: number } | null>;
}

const nonempty = v.pipe(v.string(), v.nonEmpty());
const dimension = v.pipe(v.number(), v.integer(), v.minValue(1));
const preparedSchema = v.object({
  path: nonempty,
  width: dimension,
  height: dimension,
  contentHash: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
});
const compositeSchema = v.object({
  path: nonempty,
  width: dimension,
  height: dimension,
  foregroundHash: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
  backgroundHash: v.pipe(v.string(), v.regex(/^[a-f0-9]{16}$/)),
});
const generatedImageSchema = v.object({
  path: nonempty,
  width: dimension,
  height: dimension,
  imageHash: v.pipe(v.string(), v.regex(/^[a-f0-9]{16}$/)),
  sourceWidth: dimension,
  sourceHeight: dimension,
  padded: v.boolean(),
});
const logoCompositeSchema = v.object({
  path: nonempty,
  width: dimension,
  height: dimension,
  imageHash: v.pipe(v.string(), v.regex(/^[a-f0-9]{16}$/)),
  logoHash: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
});
function requireDesktop() {
  if (!isDesktopRuntime()) throw new Error("产品抠图、合成与导出需要在桌面应用中执行。");
}

export const productSceneImageClient: ProductSceneImageClient = {
  async prepare(command) {
    requireDesktop();
    return v.parse(preparedSchema, await invoke("prepare_product_scene_view", { command }));
  },
  async prepareLogo(command) {
    requireDesktop();
    return v.parse(preparedSchema, await invoke("prepare_product_scene_logo", { command }));
  },
  async validateLogo(command) {
    requireDesktop();
    await invoke("validate_product_scene_logo", { command });
  },
  async applyLogo(command) {
    requireDesktop();
    const result = v.parse(
      logoCompositeSchema,
      await invoke("apply_product_scene_logo", { command }),
    );
    if (
      ![1536, 1152].includes(result.width) ||
      result.height !== 2048 ||
      result.logoHash !== command.logoHash
    )
      throw new Error("Logo 贴回返回的尺寸或母版签名不匹配，请重新检查。");
    return result;
  },
  async validateViews(command) {
    requireDesktop();
    await invoke("validate_product_scene_views", { command });
  },
  async compose(command) {
    requireDesktop();
    const result = v.parse(compositeSchema, await invoke("compose_product_scene", { command }));
    const width = command.aspectRatio === "3:4" ? 1536 : 1152;
    if (result.width !== width || result.height !== 2048)
      throw new Error("产品场景图交付尺寸不匹配，请重新合成。");
    return result;
  },
  async normalizeGenerated(command) {
    requireDesktop();
    const result = v.parse(
      generatedImageSchema,
      await invoke("normalize_product_scene_image", { command }),
    );
    if (result.width !== (command.aspectRatio === "3:4" ? 1536 : 1152) || result.height !== 2048)
      throw new Error("产品场景图交付尺寸不匹配，请重新处理原生成图片。");
    return result;
  },
  async export(command) {
    requireDesktop();
    const directory = await open({
      directory: true,
      multiple: false,
      title: "选择产品场景图导出目录",
    });
    if (!directory || Array.isArray(directory)) return null;
    return v.parse(
      v.object({ directory: nonempty, count: v.pipe(dimension, v.maxValue(500)) }),
      await invoke("export_product_scenes", { command: { ...command, directory } }),
    );
  },
};
