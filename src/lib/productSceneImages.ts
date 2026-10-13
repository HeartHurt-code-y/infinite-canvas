import { invokeDesktop, invokeDesktopVoid } from "./ipc";
import { open } from "@tauri-apps/plugin-dialog";
import * as v from "valibot";
import { isDesktopRuntime } from "./backend";

export type ProductSceneAspectRatio = "1:1" | "3:4" | "9:16";
export function productSceneOutputSize(aspectRatio: ProductSceneAspectRatio) {
  return { width: { "1:1": 2048, "3:4": 1536, "9:16": 1152 }[aspectRatio], height: 2048 };
}

export interface PreparedProductView {
  readonly path: string;
  readonly width: number;
  readonly height: number;
  readonly contentHash: string;
  readonly photoPreserved?: boolean;
}

export interface ProductSceneComposite {
  readonly path: string;
  readonly width: number;
  readonly height: number;
  /** 64-bit difference hash of the background alone, before foreground composition. */
  readonly backgroundHash: string;
  /** SHA-256 of the foreground actually read for this composition. */
  readonly foregroundHash: string;
}

/** A protected rectangle in the complete source photograph, before uniform resizing. */
export interface ProductSceneProtectionRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Proves local copying of resized source content, not physical or optical accuracy. */
export interface ProductSceneProtectionReceipt {
  readonly region: ProductSceneProtectionRect;
  readonly feather: number;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly corePixelCount: number;
  readonly verified: boolean;
  readonly outputHash: string;
  readonly warnings?: readonly string[];
}

export interface ProductSceneProtectedComposite extends ProductSceneComposite {
  readonly protection: ProductSceneProtectionReceipt;
}

export interface ComposeProtectedProductSceneCommand {
  readonly backgroundPath: string;
  readonly productPath: string;
  readonly productHash: string;
  readonly outputId: string;
  readonly aspectRatio: ProductSceneAspectRatio;
  readonly placement: {
    readonly centerX: number;
    readonly baselineY: number;
    readonly widthFraction: number;
  };
  readonly region: ProductSceneProtectionRect;
  readonly feather: number;
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
  prepare(command: {
    readonly sourcePath: string;
    readonly preservePhoto?: boolean;
  }): Promise<PreparedProductView>;
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
    readonly views: readonly {
      readonly path: string;
      readonly contentHash: string;
      /** Protected photographs are checked for an opaque, valid core before paid work. */
      readonly region?: ProductSceneProtectionRect;
      readonly feather?: number;
    }[];
  }): Promise<void>;
  compose(command: {
    readonly backgroundPath: string;
    readonly productPath: string;
    readonly productHash: string;
    readonly outputId: string;
    readonly aspectRatio: ProductSceneAspectRatio;
    readonly placement: {
      readonly centerX: number;
      readonly baselineY: number;
      readonly widthFraction: number;
    };
    readonly depthStrength: number;
  }): Promise<ProductSceneComposite>;
  /** Optional for older test/host adapters; protected mode must require this operation. */
  composeProtected?(
    command: ComposeProtectedProductSceneCommand,
  ): Promise<ProductSceneProtectedComposite>;
  normalizeGenerated(command: {
    readonly sourcePath: string;
    readonly outputId: string;
    readonly aspectRatio: ProductSceneAspectRatio;
  }): Promise<ProductSceneGeneratedImage>;
  export(command: {
    readonly paths: readonly string[];
    readonly manifest: string;
  }): Promise<{ readonly directory: string; readonly count: number } | null>;
}

const nonempty = v.pipe(v.string(), v.nonEmpty());
const dimension = v.pipe(v.number(), v.integer(), v.minValue(1));
const recordedCount = v.pipe(v.number(), v.integer(), v.minValue(0));
const preparedSchema = v.object({
  path: nonempty,
  width: dimension,
  height: dimension,
  contentHash: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
  photoPreserved: v.exactOptional(v.boolean()),
});
const compositeSchema = v.object({
  path: nonempty,
  width: dimension,
  height: dimension,
  foregroundHash: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
  backgroundHash: v.pipe(v.string(), v.regex(/^[a-f0-9]{16}$/)),
});
const normalized = v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(1));
const protectedCompositeSchema = v.object({
  ...compositeSchema.entries,
  protection: v.object({
    region: v.object({ x: normalized, y: normalized, width: normalized, height: normalized }),
    feather: v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(0.1)),
    sourceWidth: recordedCount,
    sourceHeight: recordedCount,
    corePixelCount: recordedCount,
    verified: v.boolean(),
    outputHash: v.string(),
    warnings: v.exactOptional(v.array(v.string())),
  }),
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
    const result = await invokeDesktop("prepare_product_scene_view", preparedSchema, { command });
    if (command.preservePhoto && result.photoPreserved !== true)
      throw new Error("当前桌面后端未确认整张原片保留，请重启更新后的桌面应用再导入。");
    return result;
  },
  async prepareLogo(command) {
    requireDesktop();
    return invokeDesktop("prepare_product_scene_logo", preparedSchema, { command });
  },
  async validateLogo(command) {
    requireDesktop();
    await invokeDesktopVoid("validate_product_scene_logo", { command });
  },
  async applyLogo(command) {
    requireDesktop();
    const result = await invokeDesktop("apply_product_scene_logo", logoCompositeSchema, {
      command,
    });
    if (
      ![2048, 1536, 1152].includes(result.width) ||
      result.height !== 2048 ||
      result.logoHash !== command.logoHash
    )
      throw new Error("Logo 贴回返回的尺寸或母版签名不匹配，请重新检查。");
    return result;
  },
  async validateViews(command) {
    requireDesktop();
    // 旧版桌面端可能返回 undefined；这里必须走下方「未确认原片保护检查」的
    // 人话拦截而不是契约错误，所以不做严格布尔校验（`!== true` 即校验）。
    const protectedValidated = await invokeDesktop("validate_product_scene_views", v.unknown(), {
      command,
    });
    if (command.views.some((view) => view.region != null) && protectedValidated !== true)
      throw new Error("当前桌面后端未确认原片保护检查，已阻止生成；请重启更新后的桌面应用。");
  },
  async compose(command) {
    requireDesktop();
    const result = await invokeDesktop("compose_product_scene", compositeSchema, { command });
    const { width } = productSceneOutputSize(command.aspectRatio);
    if (result.width !== width || result.height !== 2048)
      throw new Error("产品场景图交付尺寸不匹配，请重新合成。");
    return result;
  },
  async composeProtected(command) {
    requireDesktop();
    const { region, feather } = command;
    if (
      ![region.x, region.y, region.width, region.height, feather].every(Number.isFinite) ||
      region.x < 0 ||
      region.y < 0 ||
      region.width <= 0 ||
      region.height <= 0 ||
      region.x + region.width > 1 ||
      region.y + region.height > 1 ||
      feather < 0 ||
      feather > 0.1
    )
      throw new Error("原片保护范围无效，请重新框选完整商品及必要的手腕或背景。");
    const result = await invokeDesktop(
      "compose_product_scene_protected",
      protectedCompositeSchema,
      {
        command,
      },
    );
    if (
      result.width !== productSceneOutputSize(command.aspectRatio).width ||
      result.height !== 2048
    )
      throw new Error("原片合成返回的输出尺寸不匹配，请重新合成。");
    return result;
  },
  async normalizeGenerated(command) {
    requireDesktop();
    const result = await invokeDesktop("normalize_product_scene_image", generatedImageSchema, {
      command,
    });
    if (
      result.width !== productSceneOutputSize(command.aspectRatio).width ||
      result.height !== 2048
    )
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
    return invokeDesktop(
      "export_product_scenes",
      v.object({ directory: nonempty, count: v.pipe(dimension, v.maxValue(500)) }),
      { command: { ...command, directory } },
    );
  },
};
