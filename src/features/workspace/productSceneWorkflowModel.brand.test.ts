import { describe, expect, it } from "vitest";
import { node } from "../../test/videoWorkflowFixtures";
import { workflowExecutionInputSignature } from "./workflowExecutionPlan";
import {
  PRODUCT_SCENE_BRAND_STYLES,
  createJewelrySceneOptions,
  createProductSceneCheckpoint,
  createProductSceneOptions,
  generateProductScenePlan,
  productSceneInputReady,
  productSceneInputSignature,
  productSceneRecipeSignature,
  resetProductSceneRow,
  type ProductSceneWorkflowOptions,
} from "./productSceneWorkflowModel";

function options(): ProductSceneWorkflowOptions {
  return {
    ...createProductSceneOptions(),
    productName: "珍珠项链",
    totalCount: 10,
    views: [
      {
        id: "product-front",
        label: "商品正面实拍",
        angle: "front45",
        sourcePath: "C:/brand/product.jpg",
        preparedPath: "C:/brand/prepared.png",
        contentHash: "a".repeat(64),
        approved: true,
        photoRole: "full",
      },
      {
        id: "product-wearing",
        label: "真实佩戴原片",
        angle: "eye",
        sourcePath: "C:/brand/wearing.jpg",
        preparedPath: "C:/brand/wearing-prepared.png",
        contentHash: "b".repeat(64),
        approved: true,
        photoRole: "wearing",
      },
    ],
  };
}

describe("brand art direction in the existing product scene workflow", () => {
  it.each(PRODUCT_SCENE_BRAND_STYLES)(
    "uses $label art direction without hardware photography rules",
    ({ id }) => {
      const source = {
        ...options(),
        brandCreative: { style: id, brief: "珍珠项链，保留真实佩戴比例，首页右侧留白" },
      };
      const rows = generateProductScenePlan(source);
      expect(rows).toHaveLength(10);
      for (const { recipe } of rows) {
        expect(recipe.scene).toMatch(new RegExp(`^${id}-`));
        expect(recipe.brandCreative).toEqual(source.brandCreative);
        expect(recipe.prompt).toContain("brand jewelry or fashion product photograph");
        expect(recipe.prompt).toContain(source.brandCreative.brief);
        expect(recipe.prompt).toContain("full, wearing");
        expect(recipe.prompt).toContain("a person's face, outfit or background");
        expect(recipe.prompt).toContain("original anonymous adult fashion model");
        expect(recipe.prompt).toContain("pearl or bead order");
        expect(recipe.prompt).toContain(
          "Typography will be composed as editable local design layers",
        );
        expect(recipe.prompt).not.toMatch(
          /hardware|smartphone|connector|grille|No people or hands/,
        );
        expect(recipe.targetCamera?.focalLength).toBeGreaterThanOrEqual(50);
      }
    },
  );

  it.each(["reference", "composite"] as const)(
    "keeps 500 %s brand recipes distinct, deterministic and inside one style",
    (generationMode) => {
      const source = {
        ...options(),
        generationMode,
        totalCount: 500,
        views: [options().views[0]!],
        brandCreative: { style: "quiet" as const, brief: "单体静物，低反差" },
      };
      const rows = generateProductScenePlan(source);
      expect(new Set(rows.map(({ recipe }) => productSceneRecipeSignature(recipe))).size).toBe(500);
      expect(generateProductScenePlan(source)).toEqual(rows);
      const oldRecipe = rows[0]!.recipe;
      const state = {
        ...createProductSceneCheckpoint(),
        rows: rows.slice(0, 10),
        approvedThrough: 10,
      };
      const reset = resetProductSceneRow(state, rows[0]!.id).rows[0]!;
      expect(reset.recipe.brandCreative).toEqual(source.brandCreative);
      expect(reset.recipe.prompt).toContain("quiet minimal brand still-life photography");
      expect(reset.recipe.prompt).not.toMatch(/hardware|smartphone|network cable|developer desk/);
      expect(productSceneRecipeSignature(reset.recipe)).not.toBe(
        productSceneRecipeSignature(oldRecipe),
      );
      expect(reset.attempts[0]?.recipe).toEqual(oldRecipe);
    },
  );

  it("applies brand atmosphere only to the surrounding plate in protected source mode", () => {
    const base = createJewelrySceneOptions();
    const source = {
      ...base,
      jewelry: {
        ...base.jewelry!,
        skuId: "SKU-01",
        specimenId: "实物-01",
        criticalFeatures: "12颗异形珍珠与原始珠序",
      },
      brandCreative: { style: "retro" as const, brief: "深色背景，复古时装氛围" },
      views: [
        {
          ...options().views[1]!,
          protection: {
            rect: { x: 0.1, y: 0.1, width: 0.7, height: 0.7 },
            feather: 0.04,
            use: "wearing" as const,
          },
        },
      ],
    };
    const rows = generateProductScenePlan(source);
    for (const { recipe } of rows) {
      expect(recipe.targetCamera).toBeUndefined();
      expect(recipe.material).toBe(source.jewelry.seriesStyle.background);
      expect(recipe.lighting).toBe(source.jewelry.seriesStyle.lighting);
      expect(recipe.prompt).toContain("only one empty background plate");
      expect(recipe.prompt).toContain("vintage fashion editorial photography");
      expect(recipe.prompt).toContain(source.brandCreative.brief);
      expect(recipe.prompt).toContain(
        "Do not redraw or restyle the protected product, skin, hands or wearing relationship",
      );
      expect(recipe.prompt).toContain(
        "source lighting, source camera and local composition requirements below take precedence",
      );
    }
    const reset = resetProductSceneRow({ ...createProductSceneCheckpoint(), rows }, rows[0]!.id);
    expect(reset.rows[0]!.recipe).toEqual(rows[0]!.recipe);
  });

  it("invalidates paid-plan signatures after brand style, brief or actual photo-role changes", () => {
    const source: ProductSceneWorkflowOptions = {
      ...options(),
      brandCreative: { style: "editorial", brief: "冷白留白" },
    };
    const config = { ...node().config, productScene: source };
    const executionNode = { ...node(), config };
    for (const changed of [
      { ...source, brandCreative: { style: "retro" as const, brief: "冷白留白" } },
      { ...source, brandCreative: { ...source.brandCreative!, brief: "新品系列，右侧留白" } },
      {
        ...source,
        views: [{ ...source.views[0]!, photoRole: "detail" as const }, source.views[1]!],
      },
    ]) {
      const changedConfig = { ...config, productScene: changed };
      expect(productSceneInputSignature(changedConfig)).not.toBe(
        productSceneInputSignature(config),
      );
      expect(workflowExecutionInputSignature({ ...executionNode, config: changedConfig })).not.toBe(
        workflowExecutionInputSignature(executionNode),
      );
    }
  });

  it("keeps the original hardware workflow and its planning-only photo labels unchanged without brand art direction", () => {
    const source = options();
    const original = generateProductScenePlan(source);
    expect(original[0]!.recipe.prompt).toContain("ordinary smartphone-style photograph");
    expect(original[0]!.recipe.prompt).toContain("EXACT SAME physical hardware product");
    expect(original.every(({ recipe }) => !recipe.brandCreative)).toBe(true);
    const changed = {
      ...source,
      views: source.views.map((view) => ({ ...view, photoRole: "detail" as const })),
    };
    expect(generateProductScenePlan(changed)).toEqual(original);
    expect(productSceneInputSignature({ ...node().config, productScene: changed })).toBe(
      productSceneInputSignature({ ...node().config, productScene: source }),
    );
  });

  it("rejects unknown brand styles and malformed art direction before planning", () => {
    expect(
      productSceneInputReady({ ...options(), brandCreative: { style: "editorial", brief: "" } }),
    ).toBe(true);
    expect(
      productSceneInputReady({
        ...options(),
        brandCreative: { style: "unknown", brief: "" },
      } as unknown as ProductSceneWorkflowOptions),
    ).toBe(false);
    expect(
      productSceneInputReady({
        ...options(),
        brandCreative: { style: "quiet", brief: null },
      } as unknown as ProductSceneWorkflowOptions),
    ).toBe(false);
  });
});
