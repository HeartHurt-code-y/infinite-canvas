import { describe, expect, it, vi } from "vitest";
import type { GenerationTaskClient, PromptNodeClient } from "../../lib/backend";
import {
  parseProductSceneInspection,
  productSceneRowCanAccept,
  resetProductSceneQuality,
  type ProductSceneInspection,
} from "./productSceneQuality";
import { productSceneOutputSize, type ProductSceneImageClient } from "../../lib/productSceneImages";
import { catalog, completedTask, node } from "../../test/videoWorkflowFixtures";
import { approveWorkflowExecutionPlan, createWorkflowExecutionPlan } from "./workflowExecutionPlan";
import {
  createProductSceneOptions,
  createJewelrySceneOptions,
  generateProductScenePlan,
  productSceneHashDistance,
  productSceneGenerationMode,
  productSceneRecipeSignature,
  productSceneInputReady,
  productSceneInputSignature,
  productSceneRequirements,
  updateProductSceneViewProtection,
  canRetryProductSceneRow,
  retryProductSceneRow,
  productSceneJewelryReviewWarnings,
  resetProductSceneRow,
  type ProductSceneWorkflowOptions,
} from "./productSceneWorkflowModel";
import {
  createProductSceneWorkflowRunner,
  productSceneImageParameters,
} from "./productSceneWorkflowRunner";
import type {
  KnowledgeVideoWorkflowCheckpoint,
  KnowledgeVideoWorkflowNodeData,
} from "./workspaceModel";

const hash = "a".repeat(64);
const logo = {
  path: "C:\\original-logo.png",
  contentHash: "c".repeat(64),
  width: 300,
  height: 100,
  approved: true,
};
const clearInspection: ProductSceneInspection = {
  version: 1,
  ports: {
    status: "pass",
    evidence: "参考接口图与成图可见接口逐项一致",
    items: [
      {
        name: "网络接口",
        expected: "参考图右侧一个接口",
        observed: "成图右侧一个接口",
        status: "pass",
      },
    ],
  },
  logo: {
    status: "place",
    confidence: 0.96,
    surfaceClear: true,
    quad: [
      { x: 0.4, y: 0.6 },
      { x: 0.55, y: 0.6 },
      { x: 0.55, y: 0.65 },
      { x: 0.4, y: 0.65 },
    ],
    evidence: "原Logo位置明确，生成表面为空白且未覆盖端口",
  },
};
const inspectionResponse = (value: ProductSceneInspection) =>
  Promise.resolve({
    optimizedPrompt: JSON.stringify(value),
    rawModelOutput: JSON.stringify(value),
  });
const options: ProductSceneWorkflowOptions = {
  ...createProductSceneOptions(),
  generationMode: "composite",
  totalCount: 3,
  batchSize: 2,
  views: [
    {
      id: "front",
      label: "正前45度",
      angle: "front45",
      sourcePath: "C:\\product.png",
      preparedPath: "C:\\prepared.png",
      contentHash: hash,
      approved: true,
    },
  ],
};
function jewelryOptions(): ProductSceneWorkflowOptions {
  const defaults = createJewelrySceneOptions();
  return {
    ...defaults,
    aspectRatio: "3:4",
    totalCount: 2,
    jewelry: {
      ...defaults.jewelry!,
      skuId: "SKU-01",
      specimenId: "实物-01",
      criticalFeatures: "12颗水晶珠，右侧爱心主珠，左侧第二珠天然棉絮",
    },
    views: [
      {
        ...options.views[0]!,
        width: 1200,
        height: 1600,
        protection: {
          rect: { x: 0.1, y: 0.2, width: 0.7, height: 0.6 },
          feather: 0.04,
          use: "wearing",
        },
      },
    ],
  };
}
const approvedJewelryChecks = {
  connections: "pass",
  shape: "pass",
  details: "pass",
  texture: "pass",
  scale: "pass",
  style: "pass",
} as const;
function setup(config: ProductSceneWorkflowOptions = options) {
  let sequence = 0;
  const generation: GenerationTaskClient = {
    start: vi.fn(() => Promise.resolve(`image-${++sequence}`)),
    get: vi.fn((taskId: string) => Promise.resolve(completedTask(taskId))),
    getProgress: vi.fn((taskId: string) => Promise.resolve(completedTask(taskId))),
    list: vi.fn(),
    queryVideoTaskNow: vi.fn(),
  };
  const imageClient: Pick<
    ProductSceneImageClient,
    "compose" | "validateViews" | "normalizeGenerated" | "validateLogo" | "applyLogo"
  > & { composeProtected: NonNullable<ProductSceneImageClient["composeProtected"]> } = {
    validateViews: vi.fn(() => Promise.resolve()),
    validateLogo: vi.fn(() => Promise.resolve()),
    applyLogo: vi.fn((command: Parameters<ProductSceneImageClient["applyLogo"]>[0]) =>
      Promise.resolve({
        path: `C:\\logo-applied\\${command.outputId}.png`,
        width: productSceneOutputSize(config.aspectRatio).width,
        height: 2048,
        imageHash: "fedcba9876543210",
        logoHash: command.logoHash,
      }),
    ),
    compose: vi.fn((command: Parameters<ProductSceneImageClient["compose"]>[0]) =>
      Promise.resolve({
        path: `C:\\composed\\${command.outputId}.png`,
        width: productSceneOutputSize(command.aspectRatio).width,
        height: 2048,
        backgroundHash: "0123456789abcdef",
        foregroundHash: hash,
      }),
    ),
    composeProtected: vi.fn(
      (command: Parameters<NonNullable<ProductSceneImageClient["composeProtected"]>>[0]) =>
        Promise.resolve({
          path: `C:\\protected\\${command.outputId}.png`,
          width: productSceneOutputSize(command.aspectRatio).width,
          height: 2048,
          backgroundHash: "0123456789abcdef",
          foregroundHash: command.productHash,
          protection: {
            region: command.region,
            feather: command.feather,
            sourceWidth: config.views[0]?.width ?? 1200,
            sourceHeight: config.views[0]?.height ?? 1600,
            corePixelCount: 10000,
            verified: true,
            outputHash: "d".repeat(64),
          },
        }),
    ),
    normalizeGenerated: vi.fn(
      (command: Parameters<ProductSceneImageClient["normalizeGenerated"]>[0]) =>
        Promise.resolve({
          path: `C:\\generated\\${command.outputId}.png`,
          width: productSceneOutputSize(command.aspectRatio).width,
          height: 2048,
          imageHash: "0123456789abcdef",
          sourceWidth: 1024,
          sourceHeight: 1024,
          padded: true,
        }),
    ),
  };
  const resultRecovery = {
    resume: vi.fn((taskId: string) => Promise.resolve(completedTask(taskId).results[0]!)),
  };
  const promptClient: PromptNodeClient = { run: vi.fn(() => inspectionResponse(clearInspection)) };
  const runner = createProductSceneWorkflowRunner({
    generationClient: generation,
    imageClient,
    resultRecovery,
    promptClient,
    createId: () => "product-run",
    now: () => 123,
    sleep: vi.fn(() => Promise.resolve()),
  });
  const base = node();
  const source: KnowledgeVideoWorkflowNodeData = {
    ...base,
    config: { ...base.config, productScene: config },
  };
  const request = {
    node: source,
    providerCatalog:
      productSceneGenerationMode(config) === "reference"
        ? catalog.map((entry) => ({
            ...entry,
            models: entry.models.map((model) =>
              model.definitionId !== "project-image"
                ? model
                : {
                    ...model,
                    operations: ["image_to_image" as const],
                    operationSchema: {
                      image_to_image: {
                        parameters: {
                          aspect_ratio: { type: "string", enum: ["1:1", "3:4", "9:16"] },
                          n: { type: "integer", default: 1 },
                        },
                      },
                    },
                  },
            ),
          }))
        : catalog,
    signal: new AbortController().signal,
    onCheckpoint: vi.fn(),
    onProgress: vi.fn(),
    beforeSideEffect: vi.fn(() => Promise.resolve()),
  };
  function resume(checkpoint: KnowledgeVideoWorkflowCheckpoint, approvedThrough?: number) {
    const current = {
      ...checkpoint,
      productScene: {
        ...checkpoint.productScene!,
        ...(approvedThrough == null ? {} : { approvedThrough, batchReviewPending: false }),
      },
    };
    const nextNode = { ...source, config: { ...source.config, checkpoint: current } };
    const plan = approveWorkflowExecutionPlan(
      createWorkflowExecutionPlan(nextNode, "resume"),
      nextNode,
      123,
    );
    return {
      ...request,
      resume: true,
      node: {
        ...nextNode,
        config: { ...nextNode.config, checkpoint: { ...current, executionPlan: plan } },
      },
    };
  }
  return { generation, imageClient, resultRecovery, promptClient, runner, request, resume };
}

describe("protected jewelry scenes", () => {
  it("runs square protected composition without altering the original source identity", async () => {
    const config = { ...jewelryOptions(), aspectRatio: "1:1" as const, totalCount: 1 };
    const { runner, request, resume, imageClient, generation } = setup(config);
    const plan = await runner.run(request);
    expect(generation.start).not.toHaveBeenCalled();
    expect(plan.productScene!.rows[0]!.recipe.prompt).toContain("Square 1:1");
    const result = await runner.run(resume(plan, 1));
    expect(imageClient.composeProtected).toHaveBeenCalledWith(
      expect.objectContaining({
        aspectRatio: "1:1",
        productPath: config.views[0]!.preparedPath,
        productHash: hash,
      }),
    );
    expect(result.productScene!.rows[0]!.outputPath).toBeTruthy();
    expect(result.productScene!.rows[0]!.status).toBe("needs_review");
  });
  it("requires physical identity, features and an approved valid protection region without hardware quality", () => {
    const config = jewelryOptions();
    expect(createJewelrySceneOptions(options)).toMatchObject({
      generationMode: "protected",
      totalCount: 10,
      views: [],
      productName: "珠宝商品",
    });
    expect(
      createJewelrySceneOptions({
        ...options,
        quality: { inspectPorts: true, portSpecification: "ports" },
      }).quality,
    ).toBeUndefined();
    expect(productSceneInputReady(createJewelrySceneOptions())).toBe(false);
    expect(productSceneInputReady(config)).toBe(true);
    for (const field of ["skuId", "specimenId", "criticalFeatures"] as const)
      expect(
        productSceneInputReady({ ...config, jewelry: { ...config.jewelry!, [field]: " " } }),
      ).toBe(false);
    expect(
      productSceneInputReady({
        ...config,
        quality: { inspectPorts: true, portSpecification: "ports" },
      }),
    ).toBe(false);
    const view = config.views[0]!;
    for (const rect of [
      { x: NaN, y: 0, width: 0.5, height: 0.5 },
      { x: 0.8, y: 0, width: 0.5, height: 0.5 },
      { x: 0, y: 0, width: 0, height: 0.5 },
    ])
      expect(
        productSceneInputReady({
          ...config,
          views: [{ ...view, protection: { ...view.protection!, rect } }],
        }),
      ).toBe(false);
    expect(
      productSceneInputReady({
        ...config,
        views: [{ ...view, protection: { ...view.protection!, feather: Infinity } }],
      }),
    ).toBe(false);
  });

  it("derives the missing-required list from the same conditions the runner blocks on", () => {
    const config = jewelryOptions();
    expect(productSceneInputReady(config)).toBe(true);
    expect(productSceneRequirements(config)).toEqual([]);
    const missing = productSceneRequirements(createJewelrySceneOptions());
    expect(missing.map((item) => item.field)).toEqual([
      "产品参考原图",
      "商品 SKU",
      "单件实物编号 / 天然纹理身份",
      "必须保留的关键特征",
    ]);
    expect(missing.every((item) => item.hint.trim().length > 0)).toBe(true);
    for (const field of ["skuId", "specimenId", "criticalFeatures"] as const) {
      const broken = { ...config, jewelry: { ...config.jewelry!, [field]: " " } };
      expect(productSceneInputReady(broken)).toBe(false);
      expect(productSceneRequirements(broken)).not.toEqual([]);
    }
  });

  it("invalidates source approval and plan signatures after source, region or frozen template changes", () => {
    const config = jewelryOptions(),
      view = config.views[0]!;
    expect(updateProductSceneViewProtection(view, view.protection!)).toBe(view);
    const updated = updateProductSceneViewProtection(view, {
      ...view.protection!,
      rect: { ...view.protection!.rect, width: 0.6 },
    });
    expect(updated.approved).toBe(false);
    expect(productSceneInputReady({ ...config, views: [updated] })).toBe(false);
    const signature = (productScene: ProductSceneWorkflowOptions) =>
      productSceneInputSignature({ ...node().config, productScene });
    expect(signature({ ...config, views: [{ ...view, contentHash: "b".repeat(64) }] })).not.toBe(
      signature(config),
    );
    expect(
      signature({
        ...config,
        jewelry: {
          ...config.jewelry!,
          seriesStyle: { ...config.jewelry!.seriesStyle, version: "2" },
        },
      }),
    ).not.toBe(signature(config));
    expect(signature({ ...config, views: [{ ...updated, approved: true }] })).not.toBe(
      signature(config),
    );
  });

  it("freezes background, lighting, placement and the real source camera across the series and redo", () => {
    const config = jewelryOptions();
    const rows = generateProductScenePlan({ ...config, totalCount: 20 });
    expect(new Set(rows.map((row) => row.recipe.material))).toEqual(
      new Set([config.jewelry!.seriesStyle.background]),
    );
    expect(new Set(rows.map((row) => row.recipe.lighting))).toEqual(
      new Set([config.jewelry!.seriesStyle.lighting]),
    );
    expect(new Set(rows.map((row) => JSON.stringify(row.recipe.placement))).size).toBe(1);
    expect(
      rows.every(
        (row) => !row.recipe.targetCamera && row.recipe.prompt.includes("empty background plate"),
      ),
    ).toBe(true);
    expect(rows[0]!.recipe.prompt).not.toContain("hardware");
    expect(
      resetProductSceneRow(
        { inputSignature: null, rows, approvedThrough: 20, batchReviewPending: false },
        rows[0]!.id,
      ).rows[0]!.recipe,
    ).toEqual(rows[0]!.recipe);
  });

  it("generates an empty plate without source media and records optional manual checks", async () => {
    const config = jewelryOptions();
    const { runner, request, resume, generation, imageClient, promptClient } = setup(config);
    const plan = await runner.run(request);
    const result = await runner.run(resume(plan, 2));
    const row = result.productScene!.rows[0]!;
    const command = vi.mocked(generation.start).mock.calls[0]![0];
    expect(command.operation).toBe("text_to_image");
    expect(command.prompt).toHaveLength(1);
    expect(command.prompt[0]).toMatchObject({ kind: "text" });
    expect(imageClient.compose).not.toHaveBeenCalled();
    expect(imageClient.normalizeGenerated).not.toHaveBeenCalled();
    expect(promptClient.run).not.toHaveBeenCalled();
    expect(imageClient.composeProtected).toHaveBeenCalledWith(
      expect.objectContaining({
        productPath: config.views[0]!.preparedPath,
        productHash: hash,
        region: config.views[0]!.protection!.rect,
        feather: config.views[0]!.protection!.feather,
      }),
    );
    expect(imageClient.validateViews).toHaveBeenCalledWith({
      views: [
        {
          path: config.views[0]!.preparedPath,
          contentHash: hash,
          region: config.views[0]!.protection!.rect,
          feather: config.views[0]!.protection!.feather,
        },
      ],
    });
    expect(row.protection?.verified).toBe(true);
    expect(row.status).toBe("needs_review");
    expect(productSceneRowCanAccept(row, config)).toBe(true);
    expect(productSceneJewelryReviewWarnings(row, config).join("；")).toContain("尚未记录人工核对");
    const reviewed = {
      ...row,
      jewelryReview: {
        outputPath: row.outputPath!,
        checks: approvedJewelryChecks,
        notes: "已对照单件原图逐项检查",
      },
    };
    expect(productSceneRowCanAccept(reviewed, config)).toBe(true);
    for (const key of Object.keys(approvedJewelryChecks))
      for (const state of ["fail", "uncertain"] as const)
        expect(
          productSceneRowCanAccept(
            {
              ...reviewed,
              jewelryReview: {
                ...reviewed.jewelryReview,
                checks: { ...approvedJewelryChecks, [key]: state },
              },
            },
            config,
          ),
        ).toBe(true);
    const resumed = await runner.run(resume(result, 2));
    expect(generation.start).toHaveBeenCalledTimes(2);
    expect(resumed.productScene!.rows[0]!.outputPath).toBe(row.outputPath);
  });

  it("allows old reviews and changed source or protection records while preserving redo evidence", async () => {
    const config = jewelryOptions();
    const { runner, request, resume } = setup(config);
    const result = await runner.run(resume(await runner.run(request), 2));
    const generated = result.productScene!.rows[0]!;
    const row = {
      ...generated,
      jewelryReview: {
        outputPath: generated.outputPath!,
        checks: approvedJewelryChecks,
        notes: "通过",
      },
    };
    const replaced = { ...row, outputPath: "C:\\another.png" };
    expect(productSceneRowCanAccept(replaced, config)).toBe(true);
    expect(productSceneJewelryReviewWarnings(replaced, config).join("；")).toContain(
      "属于另一成图",
    );
    for (const changed of [
      { ...config, views: [{ ...config.views[0]!, contentHash: "b".repeat(64) }] },
      {
        ...config,
        views: [
          { ...config.views[0]!, protection: { ...config.views[0]!.protection!, feather: 0.03 } },
        ],
      },
      { ...config, jewelry: { ...config.jewelry!, specimenId: "另一件实物" } },
      {
        ...config,
        jewelry: {
          ...config.jewelry!,
          seriesStyle: { ...config.jewelry!.seriesStyle, version: "2" },
        },
      },
    ])
      expect(productSceneRowCanAccept(row, changed)).toBe(true);
    const reset = resetProductSceneRow({ ...result.productScene!, rows: [row] }, row.id).rows[0]!;
    expect(reset.jewelryReview).toBeUndefined();
    expect(reset.protection).toBeUndefined();
    expect(reset.attempts[0]?.jewelryReview).toEqual(row.jewelryReview);
    expect(reset.attempts[0]?.protection).toEqual(row.protection);
    expect(reset.recipe).toEqual(row.recipe);
    expect(productSceneRowCanAccept(reset, config)).toBe(false);
  });

  it.each(["unverified", "wrong-region", "wrong-dimensions", "empty-core", "wrong-source"])(
    "records %s native protection differences without blocking existing images or paying again",
    async (failure) => {
      const config = { ...jewelryOptions(), totalCount: 1 };
      const { runner, request, resume, imageClient, generation } = setup(config);
      const plan = await runner.run(request);
      const receipt = {
        region: config.views[0]!.protection!.rect,
        feather: 0.04,
        sourceWidth: 1200,
        sourceHeight: 1600,
        corePixelCount: 10000,
        verified: true,
        outputHash: "d".repeat(64),
      };
      vi.mocked(imageClient.composeProtected)
        .mockReset()
        .mockResolvedValue({
          path: "C:\\unverified.png",
          width: 1536,
          height: 2048,
          backgroundHash: "0123456789abcdef",
          foregroundHash: failure === "wrong-source" ? "b".repeat(64) : hash,
          protection: {
            ...receipt,
            ...(failure === "unverified" ? { verified: false } : {}),
            ...(failure === "wrong-region" ? { region: { ...receipt.region, width: 0.6 } } : {}),
            ...(failure === "wrong-dimensions" ? { sourceWidth: 1199 } : {}),
            ...(failure === "empty-core" ? { corePixelCount: 0 } : {}),
            warnings: ["原生合成诊断记录"],
          },
        });
      const result = await runner.run(resume(plan, 1));
      const row = result.productScene!.rows[0]!;
      expect(row.status).toBe("needs_review");
      expect(row.taskId).toBe("image-1");
      expect(row.outputPath).toBe("C:\\unverified.png");
      expect(productSceneRowCanAccept(row, config)).toBe(true);
      expect(row.reviewNotes.join("；")).toContain("原生合成诊断记录");
      expect(row.reviewNotes.join("；")).toContain(
        failure === "wrong-source" ? "源片内容签名" : "保护回执未验证",
      );
      expect(row.reviewNotes.join("；")).not.toContain("六项全部通过才能选用");
      expect(productSceneJewelryReviewWarnings(row, config)).not.toContain("原生合成诊断记录");
      expect(generation.start).toHaveBeenCalledOnce();
      await runner.run(resume(result, 1));
      expect(generation.start).toHaveBeenCalledOnce();
    },
  );

  it("allows native verified output-core counts larger than a small source after uniform scaling", async () => {
    const base = jewelryOptions();
    const config = {
      ...base,
      totalCount: 1,
      views: [{ ...base.views[0]!, width: 64, height: 80 }],
    };
    const { runner, request, resume } = setup(config);
    const result = await runner.run(resume(await runner.run(request), 1));
    const row = result.productScene!.rows[0]!;
    expect(row.protection?.corePixelCount).toBeGreaterThan(64 * 80);
    expect(
      productSceneRowCanAccept(
        {
          ...row,
          jewelryReview: {
            outputPath: row.outputPath!,
            checks: approvedJewelryChecks,
            notes: "通过",
          },
        },
        config,
      ),
    ).toBe(true);
  });

  it("refuses opaque-core preflight failures before creating any paid image request", async () => {
    const config = { ...jewelryOptions(), totalCount: 1 };
    const { runner, request, resume, imageClient, generation } = setup(config);
    const plan = await runner.run(request);
    vi.mocked(imageClient.validateViews).mockRejectedValue(
      new Error("保护核心含透明像素，请改用完整实拍母版"),
    );
    const result = await runner.run(resume(plan, 1));
    expect(result.phase).toBe("failed");
    expect(result.error).toContain("透明像素");
    expect(generation.start).not.toHaveBeenCalled();
  });

  it("refuses a changed template on resume and keeps the original paid task and output", async () => {
    const config = { ...jewelryOptions(), totalCount: 1 };
    const { runner, request, resume, generation } = setup(config);
    const result = await runner.run(resume(await runner.run(request), 1));
    const changed = resume(result, 1);
    const refused = await runner.run({
      ...changed,
      node: {
        ...changed.node,
        config: {
          ...changed.node.config,
          productScene: {
            ...config,
            jewelry: {
              ...config.jewelry!,
              seriesStyle: { ...config.jewelry!.seriesStyle, version: "2" },
            },
          },
        },
      },
    });
    expect(refused.phase).toBe("failed");
    expect(refused.productScene!.rows[0]!.taskId).toBe(result.productScene!.rows[0]!.taskId);
    expect(refused.productScene!.rows[0]!.outputPath).toBe(
      result.productScene!.rows[0]!.outputPath,
    );
    expect(generation.start).toHaveBeenCalledOnce();
  });

  it("requires the protected compositor instead of falling back to the legacy cutout compositor", async () => {
    const config = { ...jewelryOptions(), totalCount: 1 };
    const { runner, request, resume, generation, imageClient } = setup(config);
    const plan = await runner.run(request);
    const legacyClient: Pick<
      ProductSceneImageClient,
      | "compose"
      | "composeProtected"
      | "validateViews"
      | "normalizeGenerated"
      | "validateLogo"
      | "applyLogo"
    > = { ...imageClient };
    delete legacyClient.composeProtected;
    const oldAdapterRunner = createProductSceneWorkflowRunner({
      generationClient: generation,
      imageClient: legacyClient,
    });
    const result = await oldAdapterRunner.run(resume(plan, 1));
    expect(result.phase).toBe("failed");
    expect(result.error).toContain("不支持源片保护合成");
    expect(result.productScene!.rows[0]!.taskId).toBeNull();
    expect(generation.start).not.toHaveBeenCalled();
    expect(imageClient.compose).not.toHaveBeenCalled();
  });

  it("retries only a failed local composition using its saved background and preserves other manual reviews", async () => {
    const config = { ...jewelryOptions(), maxConcurrency: 1 };
    const { runner, request, resume, generation, imageClient } = setup(config);
    vi.mocked(imageClient.composeProtected).mockRejectedValueOnce(
      new Error("本地成图保存暂时失败"),
    );
    const result = await runner.run(resume(await runner.run(request), 2));
    const failed = result.productScene!.rows[0]!;
    const successful = result.productScene!.rows[1]!;
    const accepted = {
      ...successful,
      status: "accepted" as const,
      jewelryReview: {
        outputPath: successful.outputPath!,
        checks: approvedJewelryChecks,
        notes: "已通过",
      },
    };
    const state = { ...result.productScene!, rows: [failed, accepted] };
    expect(canRetryProductSceneRow(failed)).toBe(true);
    const retried = retryProductSceneRow(state, failed.id);
    expect(resetProductSceneRow(retried, failed.id).retryRowId).toBeNull();
    expect(retried.rows[0]).toMatchObject({
      taskId: failed.taskId,
      backgroundPath: failed.backgroundPath,
      recipe: failed.recipe,
      attempts: failed.attempts,
      status: "queued",
      error: null,
    });
    expect(retried.rows[1]).toBe(accepted);
    const pollsBefore = vi.mocked(generation.getProgress).mock.calls.length;
    const completed = await runner.run(
      resume({ ...result, phase: "paused", productScene: retried }),
    );
    expect(generation.start).toHaveBeenCalledTimes(2);
    expect(generation.getProgress).toHaveBeenCalledTimes(pollsBefore);
    expect(imageClient.composeProtected).toHaveBeenCalledTimes(3);
    expect(completed.productScene!.rows[0]).toMatchObject({
      taskId: failed.taskId,
      status: "needs_review",
      protection: { verified: true },
    });
    expect(completed.productScene!.rows[1]).toBe(accepted);
    expect(completed.productScene!.retryRowId).toBeNull();
    expect(completed.productScene!.batchReviewPending).toBe(true);
  });

  it("does not resubmit uncharged failed rows when a different existing background task is retried", async () => {
    const config = { ...jewelryOptions(), maxConcurrency: 1 };
    const { runner, request, resume, generation, imageClient } = setup(config);
    vi.mocked(generation.start)
      .mockResolvedValueOnce("image-existing")
      .mockRejectedValueOnce(new Error("第二张尚未取得任务身份"));
    vi.mocked(imageClient.composeProtected).mockRejectedValueOnce(new Error("本地合成暂时失败"));
    const result = await runner.run(resume(await runner.run(request), 2));
    const existing = result.productScene!.rows[0]!,
      unsubmitted = result.productScene!.rows[1]!;
    expect(unsubmitted.taskId).toBeNull();
    expect(canRetryProductSceneRow(unsubmitted)).toBe(false);
    expect(retryProductSceneRow(result.productScene!, unsubmitted.id)).toBe(result.productScene);
    const retried = retryProductSceneRow(result.productScene!, existing.id);
    const completed = await runner.run(
      resume({ ...result, phase: "paused", productScene: retried }),
    );
    expect(generation.start).toHaveBeenCalledTimes(2);
    expect(completed.productScene!.rows[0]!.status).toBe("needs_review");
    expect(completed.productScene!.rows[1]).toBe(unsubmitted);
    const forged = {
      ...result.productScene!,
      batchReviewPending: false,
      retryRowId: unsubmitted.id,
    };
    const refused = await runner.run(resume({ ...result, productScene: forged }));
    expect(refused.phase).toBe("failed");
    expect(generation.start).toHaveBeenCalledTimes(2);
  });

  it("retries local-save recovery against the original task without creating another image", async () => {
    const config = { ...jewelryOptions(), totalCount: 1 };
    const { runner, request, resume, generation, resultRecovery } = setup(config);
    const task = completedTask("image-1");
    vi.mocked(generation.getProgress).mockResolvedValue({
      ...task,
      results: [{ ...task.results[0]!, saveStatus: "failed", finalPath: null }],
    });
    vi.mocked(resultRecovery.resume).mockRejectedValueOnce(new Error("保存恢复暂时失败"));
    const result = await runner.run(resume(await runner.run(request), 1));
    const failed = result.productScene!.rows[0]!;
    expect(failed).toMatchObject({
      status: "error",
      taskId: "image-1",
      backgroundPath: null,
      outputPath: null,
    });
    const completed = await runner.run(
      resume({
        ...result,
        phase: "paused",
        productScene: retryProductSceneRow(result.productScene!, failed.id),
      }),
    );
    expect(generation.start).toHaveBeenCalledOnce();
    expect(resultRecovery.resume).toHaveBeenCalledTimes(2);
    expect(resultRecovery.resume).toHaveBeenNthCalledWith(1, "image-1", 0);
    expect(resultRecovery.resume).toHaveBeenNthCalledWith(2, "image-1", 0);
    expect(completed.productScene!.rows[0]).toMatchObject({
      status: "needs_review",
      taskId: "image-1",
      protection: { verified: true },
    });
  });

  it("keeps the retry scope across a pause and resumes the saved output without a new request", async () => {
    const config = { ...jewelryOptions(), totalCount: 1 };
    const { runner, request, resume, generation, imageClient } = setup(config);
    const normalCompose = vi.mocked(imageClient.composeProtected).getMockImplementation()!;
    vi.mocked(imageClient.composeProtected).mockRejectedValueOnce(new Error("本地合成暂时失败"));
    const result = await runner.run(resume(await runner.run(request), 1));
    const failed = result.productScene!.rows[0]!;
    const controller = new AbortController();
    vi.mocked(imageClient.composeProtected).mockImplementationOnce(async (command) => {
      const output = await normalCompose(command);
      controller.abort();
      return output;
    });
    const paused = await runner.run({
      ...resume({ ...result, productScene: retryProductSceneRow(result.productScene!, failed.id) }),
      signal: controller.signal,
    });
    expect(paused.phase).toBe("paused");
    expect(paused.productScene!.retryRowId).toBe(failed.id);
    expect(paused.productScene!.rows[0]!.taskId).toBe(failed.taskId);
    expect(paused.productScene!.rows[0]!.outputPath).toBeTruthy();
    const completed = await runner.run(resume(paused));
    expect(generation.start).toHaveBeenCalledOnce();
    expect(imageClient.composeProtected).toHaveBeenCalledTimes(2);
    expect(completed.productScene!.rows[0]!.outputPath).toBe(
      paused.productScene!.rows[0]!.outputPath,
    );
    expect(completed.productScene!.retryRowId).toBeNull();
  });
});

describe("product scene plan", () => {
  it("defaults new plans to reference generation while legacy options keep composite operation", () => {
    expect(productSceneGenerationMode(createProductSceneOptions())).toBe("reference");
    const legacy = { ...options };
    delete legacy.generationMode;
    expect(productSceneGenerationMode(legacy)).toBe("composite");
    expect(generateProductScenePlan(legacy)[0]?.recipe.generationMode).toBe("composite");
  });

  it("separates actual new camera viewpoints from source angles and deduplicates across primary reference labels", () => {
    const reference = { ...options, generationMode: "reference" as const, totalCount: 500 };
    const singleView = generateProductScenePlan(reference);
    expect(new Set(singleView.map((row) => row.recipe.viewId)).size).toBe(1);
    expect(new Set(singleView.map((row) => row.recipe.targetCamera?.id)).size).toBe(10);
    expect(singleView.some((row) => row.recipe.targetCamera?.id.startsWith("rear"))).toBe(false);
    const multiView = generateProductScenePlan({
      ...reference,
      views: [
        ...options.views,
        { ...options.views[0]!, id: "rear", angle: "rear30", contentHash: "b".repeat(64) },
      ],
    });
    expect(new Set(multiView.map((row) => row.recipe.targetCamera?.id)).size).toBe(12);
    expect(new Set(multiView.map((row) => productSceneRecipeSignature(row.recipe))).size).toBe(500);
    const recipe = multiView[0]!.recipe;
    expect(productSceneRecipeSignature(recipe)).toBe(
      productSceneRecipeSignature({ ...recipe, viewId: "a-different-primary-reference" }),
    );
    expect(recipe.prompt).toContain("MOVE THE CAMERA");
    expect(recipe.prompt).not.toContain("empty background plate");
    expect(recipe.prompt).not.toContain("gold grille");
    expect(recipe.prompt).toContain("Background depth preference 20 percent");
    expect(recipe.prompt).toContain("mm full-frame-equivalent");
    expect(
      singleView.find((row) => row.recipe.targetCamera?.id === "low-angle")?.recipe.prompt,
    ).toContain("ABOVE the lower desk surface");
  });

  it("plans 500 distinct allowed recipes with balanced scenes and real approved viewpoints", () => {
    const planOptions: ProductSceneWorkflowOptions = {
      ...options,
      totalCount: 500,
      views: [
        options.views[0]!,
        { ...options.views[0]!, id: "rear", angle: "rear30", contentHash: "b".repeat(64) },
        { ...options.views[0]!, id: "top", angle: "top90", contentHash: "c".repeat(64) },
        { ...options.views[0]!, id: "eye", angle: "eye", contentHash: "d".repeat(64) },
      ],
    };
    const plan = generateProductScenePlan(planOptions);
    expect(plan).toHaveLength(500);
    expect(new Set(plan.map((row) => productSceneRecipeSignature(row.recipe))).size).toBe(500);
    expect(new Set(plan.map((row) => row.recipe.scene)).size).toBe(12);
    expect(new Set(plan.map((row) => row.recipe.viewId)).size).toBe(4);
    expect(generateProductScenePlan(planOptions)).toEqual(plan);
    const sceneCounts = [...new Set(plan.map((row) => row.recipe.scene))].map(
      (scene) => plan.filter((row) => row.recipe.scene === scene).length,
    );
    expect(Math.max(...sceneCounts) - Math.min(...sceneCounts)).toBeLessThanOrEqual(1);
    for (const sceneBias of ["geek", "office", "unboxing"] as const) {
      const focused = generateProductScenePlan({ ...options, totalCount: 500, sceneBias });
      expect(new Set(focused.map((row) => productSceneRecipeSignature(row.recipe))).size).toBe(500);
      expect(new Set(focused.map((row) => row.recipe.viewId))).toEqual(new Set(["front"]));
    }
  });

  it.each(["1:1", "3:4", "9:16"] as const)(
    "uses declared %s model geometry and always submits one image",
    (aspectRatio) => {
      const model = {
        ...catalog[0]!.models[1]!,
        operationSchema: {
          text_to_image: {
            parameters: {
              aspect_ratio: { type: "string", enum: ["1:1", "3:4", "9:16"] },
              n: { type: "integer", default: 4 },
            },
          },
        },
      };
      expect(productSceneImageParameters(model, { ...options, aspectRatio }, {})).toMatchObject({
        aspect_ratio: aspectRatio,
        n: 1,
      });
    },
  );

  it("only compares valid background dHashes conservatively", () => {
    expect(productSceneHashDistance("0000000000000000", "0000000000000007")).toBe(3);
    expect(productSceneHashDistance(hash, hash)).toBeNull();
  });

  it("controls product frame width with bounded variation and an empty-background safety margin", () => {
    for (const productScale of [0.3, 0.48, 0.65]) {
      const plan = generateProductScenePlan({ ...options, totalCount: 20, productScale });
      for (const row of plan) {
        expect(row.recipe.placement.widthFraction).toBeGreaterThanOrEqual(productScale * 0.9);
        expect(row.recipe.placement.widthFraction).toBeLessThanOrEqual(
          Math.min(0.7, productScale * 1.1),
        );
        const emptyPercent = Number(row.recipe.prompt.match(/lower central (\d+) percent/)?.[1]);
        expect(emptyPercent / 100).toBeGreaterThanOrEqual(
          row.recipe.placement.widthFraction + 0.12,
        );
        expect(row.recipe.lighting).not.toMatch(/warm desk lamp|late afternoon/);
      }
    }
    const legacy = { ...options };
    delete legacy.productScale;
    expect(generateProductScenePlan(legacy)).toEqual(
      generateProductScenePlan({ ...options, productScale: 0.48 }),
    );
    expect(() => generateProductScenePlan({ ...options, productScale: 0.66 })).toThrow();
  });

  it("does not invent dimensions when the provider only declares an unconstrained size string", () => {
    const model = {
      ...catalog[0]!.models[1]!,
      operationSchema: {
        text_to_image: { parameters: { size: { type: "string", default: "1024x1024" } } },
      },
    };
    expect(productSceneImageParameters(model, options, {})).toEqual({ size: "1024x1024" });
    expect(() =>
      generateProductScenePlan({
        ...options,
        views: [...options.views, { ...options.views[0]!, id: "duplicate-angle" }],
      }),
    ).toThrow();
  });
});

describe("recoverable product scene batches", () => {
  it("submits brand photography with ordered actual product and wearing references only after approval", async () => {
    const brandOptions: ProductSceneWorkflowOptions = {
      ...options,
      generationMode: "reference",
      productName: "杉间珍珠耳饰",
      totalCount: 1,
      batchSize: 1,
      brandCreative: { style: "editorial", brief: "成年原创模特，冷白留白，实际耳饰尺寸" },
      views: [
        { ...options.views[0]!, label: "耳饰实物", photoRole: "full" },
        {
          ...options.views[0]!,
          id: "wearing",
          label: "实际佩戴图",
          preparedPath: "C:/product/wearing.png",
          contentHash: "b".repeat(64),
          photoRole: "wearing",
        },
      ],
    };
    const { runner, request, resume, generation } = setup(brandOptions);
    const plan = await runner.run(request);
    expect(plan.phase).toBe("awaiting_approval");
    expect(generation.start).not.toHaveBeenCalled();
    const result = await runner.run(resume(plan, 1));
    expect(generation.start).toHaveBeenCalledOnce();
    const command = vi.mocked(generation.start).mock.calls[0]![0];
    const text = command.prompt[0];
    expect(text?.kind).toBe("text");
    if (text?.kind !== "text") throw new Error("missing brand prompt");
    expect(text.text).toContain("Actual product reference map:");
    expect(text.text).toContain("role wearing");
    expect(text.text).toContain("杉间珍珠耳饰");
    expect(text.text).not.toContain("all are the same hardware");
    expect(command.prompt.slice(1)).toEqual(
      brandOptions.views.map((view, index) => ({
        kind: "media_reference",
        mentionId: `product-scene-reference-${view.id}`,
        target: { kind: "local_file", path: view.preparedPath, mediaType: "image" },
        displayNameSnapshot: view.label,
        typePosition: index + 1,
        contentIndex: index + 1,
      })),
    );
    expect(result.productScene?.rows[0]?.taskId).toBe("image-1");
  });

  it("inspects image plus ordered references, then perspective-places only the approved logo asset", async () => {
    const qualityOptions: ProductSceneWorkflowOptions = {
      ...options,
      generationMode: "reference",
      totalCount: 1,
      batchSize: 1,
      quality: { inspectPorts: true, portSpecification: "右侧1个网络接口", logo },
    };
    const { runner, request, resume, generation, imageClient, promptClient } =
      setup(qualityOptions);
    const plan = await runner.run(request);
    expect(plan.productScene?.rows[0]?.recipe.prompt).toContain("LOGO POST-PRODUCTION EXCEPTION");
    const result = await runner.run(resume(plan, 1));
    const row = result.productScene!.rows[0]!;
    expect(generation.start).toHaveBeenCalledOnce();
    expect(promptClient.run).toHaveBeenCalledOnce();
    const inspection = vi.mocked(promptClient.run).mock.calls[0]![0];
    expect(inspection.mode).toBe("product_scene_inspect");
    expect(inspection.userPrompt).toContain("inspectionAttempt=0");
    expect(inspection.visionImages?.map((image) => image.target)).toEqual(
      [row.quality!.basePath, options.views[0]!.preparedPath, logo.path].map((path) => ({
        kind: "local_file",
        path,
        mediaType: "image",
      })),
    );
    expect(imageClient.applyLogo).toHaveBeenCalledWith(
      expect.objectContaining({
        sourcePath: row.quality!.basePath,
        logoPath: logo.path,
        logoHash: logo.contentHash,
        quad: clearInspection.logo.quad,
      }),
    );
    expect(row.outputPath).toContain("logo-applied");
    expect(row.quality?.status).toBe("passed");
    expect(productSceneRowCanAccept(row, qualityOptions)).toBe(true);
    expect(
      productSceneRowCanAccept(
        { ...row, quality: { ...row.quality!, inspection: null } },
        qualityOptions,
      ),
    ).toBe(false);
    expect(
      productSceneRowCanAccept(
        { ...row, quality: { ...row.quality!, appliedLogoHash: "d".repeat(64) } },
        qualityOptions,
      ),
    ).toBe(false);
    const redo = resetProductSceneRow(result.productScene!, row.id).rows[0]!;
    expect(redo.quality).toBeUndefined();
    expect(redo.attempts[0]?.quality?.status).toBe("passed");
  });

  it.each(["fail", "uncertain"] as const)(
    "blocks acceptance on %s ports and rechecks the same saved image without another image charge",
    async (status) => {
      const qualityOptions: ProductSceneWorkflowOptions = {
        ...options,
        generationMode: "reference",
        totalCount: 1,
        batchSize: 1,
        quality: { inspectPorts: true, portSpecification: "参考图中可见1个接口" },
      };
      const { runner, request, resume, generation, promptClient, imageClient } =
        setup(qualityOptions);
      vi.mocked(promptClient.run).mockImplementationOnce(() =>
        inspectionResponse({
          ...clearInspection,
          ports: {
            ...clearInspection.ports,
            status,
            items: clearInspection.ports.items.map((item) => ({ ...item, status })),
          },
        }),
      );
      const plan = await runner.run(request),
        blocked = await runner.run(resume(plan, 1));
      const row = blocked.productScene!.rows[0]!;
      expect(row.status).toBe("needs_review");
      expect(row.quality?.status).toBe("blocked");
      expect(productSceneRowCanAccept(row, qualityOptions)).toBe(false);
      expect(imageClient.applyLogo).not.toHaveBeenCalled();
      const retryState = resetProductSceneQuality(blocked.productScene!, row.id);
      const retried = await runner.run(resume({ ...blocked, productScene: retryState }));
      expect(retried.productScene?.rows[0]?.quality?.status).toBe("passed");
      expect(generation.start).toHaveBeenCalledOnce();
      expect(promptClient.run).toHaveBeenCalledTimes(2);
      expect(vi.mocked(promptClient.run).mock.calls[1]![0].userPrompt).toContain(
        "inspectionAttempt=1",
      );
    },
  );

  it("preserves successful inspection on pause, then resumes only the local logo placement", async () => {
    const qualityOptions: ProductSceneWorkflowOptions = {
      ...options,
      generationMode: "reference",
      totalCount: 1,
      batchSize: 1,
      quality: { inspectPorts: true, portSpecification: "1个接口", logo },
    };
    const { runner, request, resume, generation, promptClient, imageClient } =
      setup(qualityOptions);
    const plan = await runner.run(request),
      controller = new AbortController();
    vi.mocked(promptClient.run).mockImplementationOnce(() => {
      controller.abort();
      return inspectionResponse(clearInspection);
    });
    const paused = await runner.run({ ...resume(plan, 1), signal: controller.signal });
    expect(paused.phase).toBe("paused");
    expect(paused.productScene?.rows[0]?.quality?.inspection).toEqual(clearInspection);
    expect(imageClient.applyLogo).not.toHaveBeenCalled();
    const completed = await runner.run(resume(paused));
    expect(completed.productScene?.rows[0]?.quality?.status).toBe("passed");
    expect(generation.start).toHaveBeenCalledOnce();
    expect(promptClient.run).toHaveBeenCalledOnce();
    expect(imageClient.applyLogo).toHaveBeenCalledOnce();
  });

  it("skips invisible logo and ports explicitly while blocking dirty or low-confidence logo surfaces", async () => {
    const qualityOptions: ProductSceneWorkflowOptions = {
      ...options,
      generationMode: "reference",
      totalCount: 1,
      batchSize: 1,
      quality: { inspectPorts: true, portSpecification: "参考图接口", logo },
    };
    const { runner, request, resume, promptClient, imageClient } = setup(qualityOptions);
    vi.mocked(promptClient.run).mockImplementationOnce(() =>
      inspectionResponse({
        ...clearInspection,
        ports: { status: "not_visible", evidence: "当前顶部视角接口面不在画面内", items: [] },
        logo: {
          status: "not_visible",
          confidence: 0.96,
          surfaceClear: false,
          quad: null,
          evidence: "Logo所在表面不在画面内",
        },
      }),
    );
    const plan = await runner.run(request),
      skipped = await runner.run(resume(plan, 1));
    const row = skipped.productScene!.rows[0]!;
    expect(row.quality?.status).toBe("passed");
    expect(row.reviewNotes.join(" ")).toContain("接口未检查");
    expect(row.reviewNotes.join(" ")).toContain("Logo 未贴回");
    expect(imageClient.applyLogo).not.toHaveBeenCalled();
    const reset = resetProductSceneQuality(skipped.productScene!, row.id);
    vi.mocked(promptClient.run).mockImplementationOnce(() =>
      inspectionResponse({
        ...clearInspection,
        logo: { ...clearInspection.logo, confidence: 0.7, surfaceClear: false },
      }),
    );
    const blocked = await runner.run(resume({ ...skipped, productScene: reset }));
    expect(blocked.productScene?.rows[0]?.quality?.status).toBe("blocked");
    expect(productSceneRowCanAccept(blocked.productScene!.rows[0]!, qualityOptions)).toBe(false);
    expect(imageClient.applyLogo).not.toHaveBeenCalled();
  });

  it("rejects malformed logo quads and hidden failed port items", () => {
    expect(() =>
      parseProductSceneInspection(
        JSON.stringify({
          ...clearInspection,
          logo: {
            ...clearInspection.logo,
            quad: [
              { x: 0.4, y: 0.6 },
              { x: 0.4, y: 0.65 },
              { x: 0.55, y: 0.65 },
              { x: 0.55, y: 0.6 },
            ],
          },
        }),
      ),
    ).toThrow();
    expect(() =>
      parseProductSceneInspection(
        JSON.stringify({
          ...clearInspection,
          ports: {
            ...clearInspection.ports,
            status: "not_visible",
            items: [{ ...clearInspection.ports.items[0], status: "fail" }],
          },
        }),
      ),
    ).toThrow();
  });

  it("sends all stable approved references to image-to-image and normalizes the full generated image without compositing", async () => {
    const views = [
      options.views[0]!,
      {
        ...options.views[0]!,
        id: "rear",
        angle: "rear30" as const,
        preparedPath: "C:\\prepared-rear.png",
        contentHash: "b".repeat(64),
      },
    ];
    const { runner, request, resume, generation, imageClient } = setup({
      ...options,
      generationMode: "reference",
      aspectRatio: "9:16",
      totalCount: 1,
      batchSize: 1,
      views,
    });
    const plan = await runner.run(request);
    expect(generation.start).not.toHaveBeenCalled();
    const generated = await runner.run(resume(plan, 1));
    const command = vi.mocked(generation.start).mock.calls[0]![0];
    expect(command.operation).toBe("image_to_image");
    expect(command.parameters).toMatchObject({ aspect_ratio: "9:16", n: 1 });
    expect(command.prompt.slice(1)).toMatchObject(
      views.map((view, index) => ({
        kind: "media_reference",
        mentionId: `product-scene-reference-${view.id}`,
        target: { kind: "local_file", path: view.preparedPath, mediaType: "image" },
        typePosition: index + 1,
        contentIndex: index + 1,
      })),
    );
    expect(imageClient.validateViews).toHaveBeenCalledTimes(2);
    expect(imageClient.compose).not.toHaveBeenCalled();
    expect(imageClient.normalizeGenerated).toHaveBeenCalledWith({
      sourcePath: "C:\\output\\image-1.png",
      outputId: "product-run-product-scene-1-0",
      aspectRatio: "9:16",
    });
    expect(generated.productScene?.rows[0]?.foregroundHash).toBeNull();
    expect(generated.productScene?.rows[0]?.reviewNotes.join(" ")).toContain("画幅不匹配");
    expect(generated.productScene?.rows[0]?.reviewNotes.join(" ")).toContain("不是像素锁定");
  });

  it("stops a reference batch before the next submission if a prepared reference changes mid-batch", async () => {
    const { runner, request, resume, generation, imageClient } = setup({
      ...options,
      generationMode: "reference",
      totalCount: 2,
      batchSize: 2,
      maxConcurrency: 1,
    });
    const plan = await runner.run(request);
    vi.mocked(imageClient.validateViews)
      .mockResolvedValueOnce()
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error("产品原图内容签名已改变"));
    const stopped = await runner.run(resume(plan, 2));
    expect(stopped.phase).toBe("failed");
    expect(generation.start).toHaveBeenCalledOnce();
    expect(stopped.productScene?.rows[0]?.status).toBe("needs_review");
    expect(stopped.productScene?.rows[1]?.taskId).toBeNull();
    expect(stopped.error).toContain("签名已改变");
  });

  it("starts multiple image requests before waiting for a result and never exceeds the configured limit", async () => {
    const { runner, request, resume, generation } = setup({
      ...options,
      totalCount: 5,
      batchSize: 5,
      maxConcurrency: 2,
    });
    const releases: Array<() => void> = [];
    let active = 0;
    let peak = 0;
    vi.mocked(generation.start).mockImplementation(() => {
      const taskId = `image-${releases.length + 1}`;
      active += 1;
      peak = Math.max(peak, active);
      return new Promise<string>((resolve) => {
        releases.push(() => {
          active -= 1;
          resolve(taskId);
        });
      });
    });
    const plan = await runner.run(request);
    const batchPromise = runner.run(resume(plan, 5));
    await vi.waitFor(() => expect(generation.start).toHaveBeenCalledTimes(2));
    expect(peak).toBe(2);
    releases[0]!();
    await vi.waitFor(() => expect(generation.start).toHaveBeenCalledTimes(3));
    releases[1]!();
    await vi.waitFor(() => expect(generation.start).toHaveBeenCalledTimes(4));
    releases[2]!();
    await vi.waitFor(() => expect(generation.start).toHaveBeenCalledTimes(5));
    releases[3]!();
    releases[4]!();
    const result = await batchPromise;
    expect(peak).toBe(2);
    expect(result.productScene?.rows.map((row) => row.taskId)).toEqual([
      "image-1",
      "image-2",
      "image-3",
      "image-4",
      "image-5",
    ]);
    expect(result.productScene?.rows.every((row) => row.status === "needs_review")).toBe(true);
    expect(result.productScene?.batchReviewPending).toBe(true);
    expect(generation.get).not.toHaveBeenCalled();
  });

  it("honors a requested 50 concurrent images without runtime throttling", async () => {
    const config = { ...options, totalCount: 50, batchSize: 50, maxConcurrency: 50 };
    const { runner, request, resume, generation } = setup(config);
    const releases: Array<() => void> = [];
    let active = 0;
    let peak = 0;
    vi.mocked(generation.start).mockImplementation(() => {
      const taskId = `image-${releases.length + 1}`;
      active += 1;
      peak = Math.max(peak, active);
      return new Promise<string>((resolve) => {
        releases.push(() => {
          active -= 1;
          resolve(taskId);
        });
      });
    });
    const plan = await runner.run(request);
    const controller = new AbortController();
    const running = runner.run({ ...resume(plan, 50), signal: controller.signal });
    await vi.waitFor(() => expect(generation.start).toHaveBeenCalledTimes(50));
    expect(peak).toBe(50);
    controller.abort();
    releases.forEach((release) => release());
    const paused = await running;
    expect(paused.phase).toBe("paused");
    expect(generation.start).toHaveBeenCalledTimes(50);
  });

  it("isolates a failed submission while preserving other concurrent results for review", async () => {
    const { runner, request, resume, generation } = setup({
      ...options,
      totalCount: 3,
      batchSize: 3,
      maxConcurrency: 3,
    });
    vi.mocked(generation.start).mockRejectedValueOnce(new Error("provider rate limit"));
    const plan = await runner.run(request);
    const batch = await runner.run(resume(plan, 3));
    expect(generation.start).toHaveBeenCalledTimes(3);
    expect(batch.phase).toBe("awaiting_approval");
    expect(batch.productScene?.rows.map((row) => row.status)).toEqual([
      "error",
      "needs_review",
      "needs_review",
    ]);
    expect(batch.productScene?.rows[0]?.error).toContain("provider rate limit");
    expect(batch.productScene?.rows[1]?.outputPath).toBeTruthy();
    expect(batch.productScene?.rows[2]?.outputPath).toBeTruthy();
  });

  it("stops queued submissions when a concurrent reference check fails", async () => {
    const { runner, request, resume, generation, imageClient } = setup({
      ...options,
      generationMode: "reference",
      totalCount: 3,
      batchSize: 3,
      maxConcurrency: 2,
    });
    let releaseFirst: (() => void) | undefined;
    vi.mocked(imageClient.validateViews)
      .mockResolvedValueOnce()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseFirst = resolve;
          }),
      )
      .mockRejectedValueOnce(new Error("产品参考图已更改"));
    const plan = await runner.run(request);
    const batchPromise = runner.run(resume(plan, 3));
    await vi.waitFor(() =>
      expect(
        vi
          .mocked(request.onProgress)
          .mock.calls.some(([value]) =>
            (value as { message: string }).message.includes("停止提交剩余任务"),
          ),
      ).toBe(true),
    );
    releaseFirst!();
    const stopped = await batchPromise;
    expect(stopped.phase).toBe("failed");
    expect(stopped.error).toContain("产品参考图已更改");
    expect(generation.start).not.toHaveBeenCalled();
    expect(stopped.productScene?.rows[2]?.taskId).toBeNull();
  });

  it("resumes an interrupted concurrent batch using its saved task identities", async () => {
    const { runner, request, resume, generation } = setup({
      ...options,
      totalCount: 2,
      batchSize: 2,
      maxConcurrency: 2,
    });
    const releaseGets: Array<() => void> = [];
    vi.mocked(generation.getProgress)
      .mockImplementationOnce(
        (taskId) =>
          new Promise((resolve) => {
            releaseGets.push(() => resolve(completedTask(taskId)));
          }),
      )
      .mockImplementationOnce(
        (taskId) =>
          new Promise((resolve) => {
            releaseGets.push(() => resolve(completedTask(taskId)));
          }),
      );
    const plan = await runner.run(request);
    const controller = new AbortController();
    const running = runner.run({ ...resume(plan, 2), signal: controller.signal });
    await vi.waitFor(() => expect(generation.getProgress).toHaveBeenCalledTimes(2));
    controller.abort();
    releaseGets.forEach((release) => release());
    const paused = await running;
    expect(paused.phase).toBe("paused");
    expect(paused.productScene?.rows.map((row) => row.taskId)).toEqual(["image-1", "image-2"]);
    const continued = await runner.run(resume(paused));
    expect(generation.start).toHaveBeenCalledTimes(2);
    expect(continued.productScene?.rows.every((row) => row.status === "needs_review")).toBe(true);
  });

  it("starts every image in the approved batch before slow visual checks occupy workers", async () => {
    const { runner, request, resume, generation, promptClient } = setup({
      ...options,
      totalCount: 3,
      batchSize: 3,
      maxConcurrency: 2,
      quality: { inspectPorts: true, portSpecification: "参考图中一个网络接口" },
    });
    const imageCountsWhenChecking: number[] = [];
    vi.mocked(promptClient.run).mockImplementation(() => {
      imageCountsWhenChecking.push(vi.mocked(generation.start).mock.calls.length);
      return inspectionResponse({
        ...clearInspection,
        logo: {
          status: "not_visible",
          confidence: 0,
          surfaceClear: false,
          quad: null,
          evidence: "未启用Logo贴回",
        },
      });
    });
    const plan = await runner.run(request);
    const batch = await runner.run(resume(plan, 3));
    expect(imageCountsWhenChecking).toEqual([3, 3, 3]);
    expect(batch.productScene?.rows.every((row) => row.quality?.status === "passed")).toBe(true);
  });

  it("creates a free local plan and pauses after the explicitly approved batch for manual review", async () => {
    const { runner, request, resume, generation, imageClient } = setup();
    const planned = await runner.run(request);
    expect(planned.productScene?.rows).toHaveLength(3);
    expect(generation.start).not.toHaveBeenCalled();
    expect(imageClient.compose).not.toHaveBeenCalled();
    const batch = await runner.run(resume(planned, 2));
    expect(generation.start).toHaveBeenCalledTimes(2);
    expect(batch.productScene?.rows.map((row) => row.status)).toEqual([
      "needs_review",
      "needs_review",
      "queued",
    ]);
    expect(batch.productScene?.rows[1]?.reviewNotes.join(" ")).toContain("背景可能");
    expect(batch.productScene?.batchReviewPending).toBe(true);
    await runner.run(resume(batch));
    expect(generation.start).toHaveBeenCalledTimes(2);
    const reviewed = {
      ...batch,
      productScene: {
        ...batch.productScene!,
        rows: batch.productScene!.rows.map((row) =>
          row.outputPath ? { ...row, status: "accepted" as const } : row,
        ),
      },
    };
    const done = await runner.run(resume(reviewed, 3));
    expect(done.phase).toBe("awaiting_approval");
    expect(done.productScene?.rows.filter((row) => row.status === "accepted")).toHaveLength(2);
    expect(done.productScene?.rows[2]?.status).toBe("needs_review");
    expect(generation.start).toHaveBeenCalledTimes(3);
    for (const [command] of vi.mocked(generation.start).mock.calls) {
      expect(command.operation).toBe("text_to_image");
      expect(command.prompt).toHaveLength(1);
    }
  });

  it.each(["composite", "reference"] as const)(
    "persists %s task identity before honoring a pause during submit and resumes without another submission",
    async (generationMode) => {
      const { runner, request, resume, generation } = setup({
        ...options,
        generationMode,
        totalCount: 1,
        batchSize: 1,
      });
      const planned = await runner.run(request);
      const abort = new AbortController();
      vi.mocked(generation.start).mockImplementationOnce(() => {
        abort.abort();
        return Promise.resolve("image-pending");
      });
      const paused = await runner.run({ ...resume(planned, 1), signal: abort.signal });
      expect(paused.phase).toBe("paused");
      expect(paused.productScene?.rows[0]?.taskId).toBe("image-pending");
      expect(generation.getProgress).not.toHaveBeenCalled();
      const done = await runner.run(resume(paused));
      expect(done.productScene?.rows[0]?.outputPath).toBeTruthy();
      expect(generation.start).toHaveBeenCalledOnce();
    },
  );

  it("recovers a generated image's local save while retaining its remote task", async () => {
    const { runner, request, resume, generation, resultRecovery } = setup({
      ...options,
      totalCount: 1,
      batchSize: 1,
    });
    const planned = await runner.run(request);
    vi.mocked(generation.getProgress).mockImplementation((taskId) => {
      const detail = completedTask(taskId);
      return Promise.resolve({
        ...detail,
        results: detail.results.map((result) => ({
          ...result,
          saveStatus: "local_missing" as const,
          finalPath: null,
        })),
      });
    });
    const done = await runner.run(resume(planned, 1));
    expect(done.phase).toBe("awaiting_approval");
    expect(resultRecovery.resume).toHaveBeenCalledWith("image-1", 0);
    expect(generation.start).toHaveBeenCalledOnce();
  });

  it("refuses changed foreground content before submitting a paid background", async () => {
    const { runner, request, resume, generation, imageClient } = setup();
    const planned = await runner.run(request);
    vi.mocked(imageClient.validateViews).mockRejectedValue(new Error("产品原图签名已改变"));
    const failed = await runner.run(resume(planned, 2));
    expect(failed.phase).toBe("failed");
    expect(failed.error).toContain("签名已改变");
    expect(generation.start).not.toHaveBeenCalled();
  });

  it("requires the current execution-plan approval and generates the whole plan past legacy batch size", async () => {
    const { runner, request, resume, generation } = setup();
    const planned = await runner.run(request);
    const unapproved = {
      ...planned,
      productScene: { ...planned.productScene!, approvedThrough: 3 },
    };
    const denied = await runner.run({
      ...request,
      resume: true,
      node: { ...request.node, config: { ...request.node.config, checkpoint: unapproved } },
    });
    expect(denied.error).toContain("执行计划");
    expect(generation.start).not.toHaveBeenCalled();
    // 一键全量审批：approvedThrough 超过遗留 batchSize 也应单次运行生成全部 3 张。
    const done = await runner.run(resume(planned, 3));
    expect(done.phase).toBe("awaiting_approval");
    expect(done.productScene!.rows.every((row) => row.outputPath)).toBe(true);
    expect(generation.start).toHaveBeenCalledTimes(3);
  });

  it("never auto-retries a failed remote task; explicit redo retains the previous attempt", async () => {
    const { runner, request, resume, generation } = setup({
      ...options,
      totalCount: 1,
      batchSize: 1,
    });
    const planned = await runner.run(request);
    vi.mocked(generation.getProgress).mockImplementation((taskId) =>
      Promise.resolve({
        ...completedTask(taskId),
        results: [],
        summary: { ...completedTask(taskId).summary, status: "failed" },
      }),
    );
    const failed = await runner.run(resume(planned, 1));
    await runner.run(resume(failed));
    expect(generation.start).toHaveBeenCalledOnce();
    const reset = resetProductSceneRow(failed.productScene!, "product-scene-1");
    expect(reset.rows[0]?.attempts[0]?.taskId).toBe("image-1");
    expect(reset.rows[0]?.taskId).toBeNull();
    expect(reset.rows[0]?.recipe.prompt).not.toBe(failed.productScene?.rows[0]?.recipe.prompt);
    expect(reset.rows[0]?.attempts[0]?.recipe).toEqual(failed.productScene?.rows[0]?.recipe);
    vi.mocked(generation.getProgress).mockImplementation((taskId) =>
      Promise.resolve(completedTask(taskId)),
    );
    const done = await runner.run(resume({ ...failed, productScene: reset }));
    expect(done.phase).toBe("awaiting_approval");
    expect(generation.start).toHaveBeenCalledTimes(2);
  });
});
