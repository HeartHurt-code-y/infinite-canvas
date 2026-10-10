import { stableJsonSignature } from "../../lib/workflowSignatures";
import * as v from "valibot";
import type { JewelryLaunchDraft, JewelryLaunchSlotId } from "./jewelryLaunchPlan";

export type BrandDesignPreset = "editorial" | "retro" | "quiet";
export type BrandDesignPageId = JewelryLaunchSlotId | "HOME" | "DETAIL";
export interface BrandDesignSource {
  readonly path: string;
  readonly contentHash?: string;
  readonly kind: "source" | "generated";
  readonly label?: string;
  readonly taskId?: string;
  readonly resultIndex?: number;
  readonly sourceNodeId?: string;
}
export interface BrandDesignSlot {
  readonly id: JewelryLaunchSlotId;
  readonly title: string;
  readonly copy: { readonly title: string; readonly body: string };
  readonly source?: BrandDesignSource;
  /** Cover is an explicit crop choice; the default always shows the complete source. */
  readonly fit: "contain" | "cover";
}
/** Persist paths and editable text only. Image bytes belong to a render, never canvas history. */
export interface BrandDesignDocument {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly sourceDraftSignature: string;
  readonly brandName: string;
  readonly seriesTitle: string;
  readonly seriesDescription: string;
  readonly preset: BrandDesignPreset;
  readonly logo?: { readonly path: string; readonly contentHash?: string };
  readonly slots: readonly BrandDesignSlot[];
  readonly homepage: {
    readonly heroSlotId: JewelryLaunchSlotId;
    readonly title: string;
    readonly body: string;
  };
  readonly inputSignature: string;
}

export const BRAND_DESIGN_SLOT_IDS: readonly JewelryLaunchSlotId[] = [
  "M01",
  "M02",
  "M03",
  "M04",
  "M05",
  "D01",
  "D02",
  "D03",
  "D04",
  "D05",
];
export const BRAND_DESIGN_PAGE_IDS: readonly BrandDesignPageId[] = [
  ...BRAND_DESIGN_SLOT_IDS,
  "HOME",
  "DETAIL",
];
export const BRAND_DESIGN_PRESETS: readonly {
  readonly id: BrandDesignPreset;
  readonly label: string;
}[] = [
  { id: "editorial", label: "冷白杂志" },
  { id: "retro", label: "深色复古" },
  { id: "quiet", label: "暖色留白" },
];

export function brandDesignInputSignature(document: BrandDesignDocument): string {
  return stableJsonSignature({ ...document, inputSignature: undefined });
}

/** Import an editable project as data only; no inline media, URLs or executable settings. */
export function parseBrandDesignDocument(raw: string): BrandDesignDocument {
  const localPath = v.pipe(
    v.string(),
    v.nonEmpty(),
    v.check(
      (path) =>
        !path.includes("\0") &&
        (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith("/") || path.startsWith("\\\\")),
      "设计图片必须使用本机绝对路径",
    ),
  );
  const hash = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
  const slotId = v.picklist(BRAND_DESIGN_SLOT_IDS);
  const source = v.strictObject({
    path: localPath,
    contentHash: v.exactOptional(hash),
    kind: v.picklist(["source", "generated"]),
    label: v.exactOptional(v.string()),
    taskId: v.exactOptional(v.pipe(v.string(), v.nonEmpty())),
    resultIndex: v.exactOptional(v.pipe(v.number(), v.integer(), v.minValue(0))),
    sourceNodeId: v.exactOptional(v.string()),
  });
  const parsed = v.parse(
    v.strictObject({
      schemaVersion: v.literal(1),
      revision: v.pipe(v.number(), v.integer(), v.minValue(1)),
      sourceDraftSignature: v.string(),
      brandName: v.string(),
      seriesTitle: v.string(),
      seriesDescription: v.string(),
      preset: v.picklist(["editorial", "retro", "quiet"]),
      logo: v.exactOptional(
        v.strictObject({ path: localPath, contentHash: v.exactOptional(hash) }),
      ),
      slots: v.pipe(
        v.array(
          v.strictObject({
            id: slotId,
            title: v.string(),
            copy: v.strictObject({ title: v.string(), body: v.string() }),
            source: v.exactOptional(source),
            fit: v.picklist(["contain", "cover"]),
          }),
        ),
        v.length(10),
      ),
      homepage: v.strictObject({ heroSlotId: slotId, title: v.string(), body: v.string() }),
      inputSignature: v.string(),
    }),
    JSON.parse(raw) as unknown,
  );
  if (new Set(parsed.slots.map((slot) => slot.id)).size !== 10)
    throw new Error("设计工程必须保留十个不同图位。");
  return { ...parsed, inputSignature: brandDesignInputSignature(parsed) };
}

export function createBrandDesignDocument(draft: JewelryLaunchDraft): BrandDesignDocument {
  const document: BrandDesignDocument = {
    schemaVersion: 1,
    revision: 1,
    sourceDraftSignature: draft.inputSignature,
    brandName: "",
    seriesTitle: draft.productName,
    seriesDescription: "",
    preset: "editorial",
    slots: BRAND_DESIGN_SLOT_IDS.map((id) => {
      const slot = draft.slots.find((item) => item.id === id);
      return {
        id,
        title: slot?.title ?? id,
        copy: slot?.copy ?? { title: draft.productName, body: "" },
        ...(slot?.source
          ? {
              source: {
                path: slot.source.preparedPath || slot.source.sourcePath,
                contentHash: slot.source.contentHash,
                kind: "source" as const,
                label: slot.source.label,
              },
            }
          : {}),
        fit: "contain",
      };
    }),
    homepage: { heroSlotId: "M01", title: draft.productName, body: "" },
    inputSignature: "",
  };
  return { ...document, inputSignature: brandDesignInputSignature(document) };
}

export function brandDesignPageSize(pageId: BrandDesignPageId): {
  readonly width: number;
  readonly height: number;
} {
  if (pageId === "HOME") return { width: 2048, height: 1152 };
  if (pageId === "DETAIL") return { width: 1536, height: 10240 };
  return pageId.startsWith("M") ? { width: 2048, height: 2048 } : { width: 1536, height: 2048 };
}
