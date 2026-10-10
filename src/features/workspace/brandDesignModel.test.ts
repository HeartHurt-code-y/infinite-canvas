import { describe, expect, it } from "vitest";
import { createJewelrySceneOptions } from "./productSceneWorkflowModel";
import { generateJewelryLaunchDraft } from "./jewelryLaunchPlan";
import {
  brandDesignInputSignature,
  brandDesignPageSize,
  createBrandDesignDocument,
  parseBrandDesignDocument,
} from "./brandDesignModel";

describe("brand design editable document", () => {
  it("keeps all ten factual draft copies and exact prepared source identities without inline image bytes", () => {
    const options = createJewelrySceneOptions();
    const draft = generateJewelryLaunchDraft({
      ...options,
      productName: "杉间珍珠耳饰",
      views: [
        {
          id: "master",
          label: "佩戴原片",
          sourcePath: "C:/photos/original.jpg",
          preparedPath: "C:/masters/oriented.png",
          contentHash: "a".repeat(64),
          angle: "front45",
          photoRole: "full",
          approved: false,
        },
      ],
    });
    const document = createBrandDesignDocument(draft);
    expect(document.sourceDraftSignature).toBe(draft.inputSignature);
    expect(document.slots.map((slot) => slot.id)).toEqual([
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
    ]);
    expect(document.slots[0]?.copy).toEqual(draft.slots[0]?.copy);
    expect(document.slots[0]?.source).toMatchObject({
      path: "C:/masters/oriented.png",
      contentHash: "a".repeat(64),
      kind: "source",
    });
    expect(document.slots.every((slot) => slot.fit === "contain")).toBe(true);
    expect(document.homepage.heroSlotId).toBe("M01");
    expect(document.homepage.body).toBe("");
    expect(document.seriesDescription).toBe("");
    expect(JSON.stringify(document)).not.toContain("data:image");
    expect(document.inputSignature).toBe(brandDesignInputSignature(document));
  });

  it("changes its signature for edits, crops, logo changes and exact AI generation identity", () => {
    const document = createBrandDesignDocument(
      generateJewelryLaunchDraft(createJewelrySceneOptions()),
    );
    const source = {
      path: "C:/result.png",
      kind: "generated" as const,
      taskId: "stable-task",
      resultIndex: 1,
      sourceNodeId: "node-a",
    };
    const edited = {
      ...document,
      slots: document.slots.map((slot, index) => (index === 0 ? { ...slot, source } : slot)),
    };
    expect(brandDesignInputSignature(edited)).not.toBe(document.inputSignature);
    expect(
      brandDesignInputSignature({
        ...edited,
        slots: edited.slots.map((slot, index) =>
          index === 0 ? { ...slot, source: { ...source, resultIndex: 2 } } : slot,
        ),
      }),
    ).not.toBe(brandDesignInputSignature(edited));
    expect(brandDesignInputSignature({ ...document, brandName: "闻山" })).not.toBe(
      document.inputSignature,
    );
    expect(brandDesignInputSignature({ ...document, inputSignature: "old" })).toBe(
      document.inputSignature,
    );
    expect(brandDesignPageSize("DETAIL")).toEqual({ width: 1536, height: 10240 });
    expect(brandDesignPageSize("HOME")).toEqual({ width: 2048, height: 1152 });
  });

  it("reopens data-only projects with stable AI identity and recomputes their signature", () => {
    const base = createBrandDesignDocument(generateJewelryLaunchDraft(createJewelrySceneOptions()));
    const project = {
      ...base,
      brandName: "闻山",
      inputSignature: "stale-from-file",
      slots: base.slots.map((slot, index) =>
        index === 0
          ? {
              ...slot,
              source: {
                path: "C:/result/shot.png",
                kind: "generated" as const,
                taskId: "paid-task-1",
                sourceNodeId: "brand-node",
                resultIndex: 0,
              },
            }
          : slot,
      ),
    };
    const reopened = parseBrandDesignDocument(JSON.stringify(project));
    expect(reopened.slots[0]?.source).toEqual(project.slots[0]?.source);
    expect(reopened.inputSignature).toBe(brandDesignInputSignature(project));
    expect(reopened.inputSignature).not.toBe("stale-from-file");
    expect(parseBrandDesignDocument(JSON.stringify(reopened))).toEqual(reopened);
  });

  it("rejects missing or duplicate slots, remote sources and unexpected inline fields", () => {
    const base = createBrandDesignDocument(generateJewelryLaunchDraft(createJewelrySceneOptions()));
    for (const invalid of [
      { ...base, slots: base.slots.slice(1) },
      { ...base, slots: base.slots.map((slot) => ({ ...slot, id: "M01" })) },
      { ...base, preset: "unknown" },
      { ...base, imageData: "data:image/png;base64,AAAA" },
      ...["https://example.com/product.png", "data:image/png;base64,AAAA", "relative.png"].map(
        (path) => ({
          ...base,
          slots: base.slots.map((slot, index) =>
            index === 0 ? { ...slot, source: { path, kind: "source" } } : slot,
          ),
        }),
      ),
    ])
      expect(() => parseBrandDesignDocument(JSON.stringify(invalid))).toThrow();
  });
});
