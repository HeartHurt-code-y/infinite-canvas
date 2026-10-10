import { stableJsonSignature } from "../../lib/workflowSignatures";
import type { JewelryLaunchOptions } from "./jewelryLaunchPlan";
import type {
  ProductSceneProtectionRect,
  ProductSceneProtectionReceipt,
} from "../../lib/productSceneImages";
import type {
  ProductSceneRecipe,
  ProductSceneRow,
  ProductSceneView,
  ProductSceneWorkflowOptions,
} from "./productSceneWorkflowModel";

export type ProductSceneProtectionRegion = ProductSceneProtectionRect;
export interface ProductSceneViewProtection {
  readonly rect: ProductSceneProtectionRegion;
  /** Feather is outside the core copied from the resized approved source. */
  readonly feather: number;
  readonly use: "product" | "wearing";
}
export interface ProductSceneJewelryOptions {
  readonly skuId: string;
  readonly specimenId: string;
  readonly criticalFeatures: string;
  /** Optional local planning documents; never authorization for paid image work. */
  readonly launch?: JewelryLaunchOptions;
  readonly seriesStyle: {
    readonly name: string;
    readonly version: string;
    readonly background: string;
    readonly lighting: string;
  };
}
export type ProductSceneProtectionEvidence = ProductSceneProtectionReceipt;
export const JEWELRY_REVIEW_CHECKS = [
  { key: "connections", label: "珠序、链条连接与朝向" },
  { key: "shape", label: "异形主珠与商品轮廓" },
  { key: "details", label: "配饰与细节无增删" },
  { key: "texture", label: "天然纹理、棉絮与包裹物" },
  { key: "scale", label: "佩戴关系、比例与遮挡" },
  { key: "style", label: "系列风格、接缝与光照" },
] as const;
export type ProductSceneJewelryCheck = (typeof JEWELRY_REVIEW_CHECKS)[number]["key"];
export interface ProductSceneJewelryReview {
  readonly outputPath: string;
  readonly checks: Readonly<Record<ProductSceneJewelryCheck, "pass" | "fail" | "uncertain">>;
  readonly notes: string;
}

export function productSceneProtectionValid(
  value: ProductSceneViewProtection | undefined,
): value is ProductSceneViewProtection {
  if (!value || !value.rect || !["product", "wearing"].includes(value.use)) return false;
  const { x, y, width, height } = value.rect;
  return (
    [x, y, width, height, value.feather].every(Number.isFinite) &&
    x >= 0 &&
    y >= 0 &&
    width > 0 &&
    height > 0 &&
    x + width <= 1 &&
    y + height <= 1 &&
    value.feather >= 0 &&
    value.feather <= 0.1
  );
}

export function productSceneJewelryOptionsValid(options: ProductSceneWorkflowOptions): boolean {
  if (options.generationMode !== "protected") return true;
  const jewelry = options.jewelry;
  if (!jewelry || !jewelry.seriesStyle) return false;
  return (
    [
      jewelry.skuId,
      jewelry.specimenId,
      jewelry.criticalFeatures,
      jewelry.seriesStyle.name,
      jewelry.seriesStyle.version,
      jewelry.seriesStyle.background,
      jewelry.seriesStyle.lighting,
    ].every((value) => typeof value === "string" && Boolean(value.trim())) &&
    options.views.every((view) => productSceneProtectionValid(view.protection))
  );
}

/** Bind manual review and plan to this physical specimen, protected source and frozen template. */
export function productSceneJewelrySignature(
  options: ProductSceneWorkflowOptions,
  view: ProductSceneView,
  placement: ProductSceneRecipe["placement"],
): string {
  const identity = { ...options.jewelry };
  delete identity.launch;
  return stableJsonSignature({
    jewelry: options.jewelry ? identity : undefined,
    view: {
      id: view.id,
      sourcePath: view.sourcePath,
      preparedPath: view.preparedPath,
      contentHash: view.contentHash,
      protection: view.protection,
      width: view.width,
      height: view.height,
    },
    aspectRatio: options.aspectRatio,
    placement,
    productScale: options.productScale ?? 0.48,
  });
}

/** A changed region or wearing/product purpose always requires fresh source approval. */
export function updateProductSceneViewProtection(
  view: ProductSceneView,
  protection: ProductSceneViewProtection,
): ProductSceneView {
  if (stableJsonSignature(view.protection ?? null) === stableJsonSignature(protection)) return view;
  return { ...view, protection, approved: false };
}

export function productSceneProtectionMatches(
  evidence: ProductSceneProtectionEvidence | undefined,
  view: ProductSceneView,
): boolean {
  if (!productSceneProtectionValid(view.protection) || !evidence || evidence.verified !== true)
    return false;
  return (
    /^[a-f0-9]{64}$/i.test(evidence.outputHash) &&
    productSceneProtectionValid({
      rect: evidence.region,
      feather: evidence.feather,
      use: view.protection.use,
    }) &&
    stableJsonSignature(evidence.region) === stableJsonSignature(view.protection.rect) &&
    evidence.feather === view.protection.feather &&
    Number.isInteger(evidence.sourceWidth) &&
    evidence.sourceWidth > 0 &&
    Number.isInteger(evidence.sourceHeight) &&
    evidence.sourceHeight > 0 &&
    Number.isInteger(evidence.corePixelCount) &&
    evidence.corePixelCount > 0 &&
    (view.width == null || evidence.sourceWidth === view.width) &&
    (view.height == null || evidence.sourceHeight === view.height)
  );
}

/** Source/receipt differences describe the recording state; they never gate selection/export. */
export function productSceneProtectionWarnings(
  evidence: ProductSceneProtectionEvidence | undefined,
  view: ProductSceneView | undefined,
  foregroundHash: string | null,
): string[] {
  const warnings = [...(evidence?.warnings ?? [])];
  if (!view) {
    warnings.push("当前母版来源记录不可用，无法将旧保护记录与当前源片核对。");
  } else {
    if (foregroundHash !== view.contentHash)
      warnings.push("源片内容签名与计划记录不同，本次成图记录实际采用的文件内容；仍可选用或导出。");
    if (!productSceneProtectionMatches(evidence, view))
      warnings.push(
        "保护回执未验证或与当前范围、尺寸记录不一致，不能据此声称当前文件已通过保护验证；仍可选用或导出。",
      );
  }
  return [...new Set(warnings)];
}

/** Manual review is advisory and retained even when it belongs to an older image. */
export function productSceneJewelryReviewWarnings(
  row: ProductSceneRow,
  options: ProductSceneWorkflowOptions,
): string[] {
  if (row.recipe.generationMode !== "protected" && options.generationMode !== "protected")
    return [];
  const view = options.views.find((entry) => entry.id === row.recipe.viewId);
  const review = row.jewelryReview;
  const warnings = productSceneProtectionWarnings(row.protection, view, row.foregroundHash);
  if (!review) warnings.push("尚未记录人工核对，仍可选用或导出成图。");
  else {
    if (review.outputPath !== row.outputPath)
      warnings.push("保留的人工核对属于另一成图，不能代表当前文件已审核；仍可选用或导出。");
    if (JEWELRY_REVIEW_CHECKS.some(({ key }) => review.checks?.[key] !== "pass"))
      warnings.push("人工核对包含未检查、不通过或无法确定项，结果作为记录保留，不影响选用或导出。");
  }
  if (
    view &&
    row.recipe.jewelrySignature !==
      productSceneJewelrySignature(options, view, row.recipe.placement)
  )
    warnings.push(
      "成图的实物、来源或系列记录与当前配置不同，现有成图仍可导出；新增付费制作继续使用当前执行计划审批。",
    );
  return [...new Set(warnings)].filter((warning) => !row.reviewNotes.includes(warning));
}
