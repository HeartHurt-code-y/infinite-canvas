import { describe, expect, it, vi } from "vitest";
import type { GenerationTaskClient, PromptNodeClient } from "../../lib/backend";
import {
  parseProductSceneInspection,
  productSceneRowCanAccept,
  resetProductSceneQuality,
  type ProductSceneInspection,
} from "./productSceneQuality";
import type { ProductSceneImageClient } from "../../lib/productSceneImages";
import { catalog, completedTask, node } from "../../test/videoWorkflowFixtures";
import { approveWorkflowExecutionPlan, createWorkflowExecutionPlan } from "./workflowExecutionPlan";
import {
  createProductSceneOptions,
  generateProductScenePlan,
  productSceneHashDistance,
  productSceneGenerationMode,
  productSceneRecipeSignature,
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
function setup(config: ProductSceneWorkflowOptions = options) {
  let sequence = 0;
  const generation: GenerationTaskClient = {
    start: vi.fn(() => Promise.resolve(`image-${++sequence}`)),
    get: vi.fn((taskId: string) => Promise.resolve(completedTask(taskId))),
    list: vi.fn(),
    queryVideoTaskNow: vi.fn(),
  };
  const imageClient: Pick<
    ProductSceneImageClient,
    "compose" | "validateViews" | "normalizeGenerated" | "validateLogo" | "applyLogo"
  > = {
    validateViews: vi.fn(() => Promise.resolve()),
    validateLogo: vi.fn(() => Promise.resolve()),
    applyLogo: vi.fn((command: Parameters<ProductSceneImageClient["applyLogo"]>[0]) =>
      Promise.resolve({
        path: `C:\\logo-applied\\${command.outputId}.png`,
        width: config.aspectRatio === "3:4" ? 1536 : 1152,
        height: 2048,
        imageHash: "fedcba9876543210",
        logoHash: command.logoHash,
      }),
    ),
    compose: vi.fn((command: Parameters<ProductSceneImageClient["compose"]>[0]) =>
      Promise.resolve({
        path: `C:\\composed\\${command.outputId}.png`,
        width: command.aspectRatio === "3:4" ? 1536 : 1152,
        height: 2048,
        backgroundHash: "0123456789abcdef",
        foregroundHash: hash,
      }),
    ),
    normalizeGenerated: vi.fn(
      (command: Parameters<ProductSceneImageClient["normalizeGenerated"]>[0]) =>
        Promise.resolve({
          path: `C:\\generated\\${command.outputId}.png`,
          width: command.aspectRatio === "3:4" ? 1536 : 1152,
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

  it.each(["3:4", "9:16"] as const)(
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
      expect(generation.get).not.toHaveBeenCalled();
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
    vi.mocked(generation.get).mockImplementation((taskId) => {
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

  it("requires the current execution-plan approval and limits each approved quota to one batch", async () => {
    const { runner, request, resume, generation } = setup();
    const planned = await runner.run(request);
    const unapproved = {
      ...planned,
      productScene: { ...planned.productScene!, approvedThrough: 2 },
    };
    const denied = await runner.run({
      ...request,
      resume: true,
      node: { ...request.node, config: { ...request.node.config, checkpoint: unapproved } },
    });
    expect(denied.error).toContain("执行计划");
    const tooMany = await runner.run(resume(planned, 3));
    expect(tooMany.error).toContain("超过单批数量");
    expect(generation.start).not.toHaveBeenCalled();
  });

  it("never auto-retries a failed remote task; explicit redo retains the previous attempt", async () => {
    const { runner, request, resume, generation } = setup({
      ...options,
      totalCount: 1,
      batchSize: 1,
    });
    const planned = await runner.run(request);
    vi.mocked(generation.get).mockImplementation((taskId) =>
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
    vi.mocked(generation.get).mockImplementation((taskId) =>
      Promise.resolve(completedTask(taskId)),
    );
    const done = await runner.run(resume({ ...failed, productScene: reset }));
    expect(done.phase).toBe("awaiting_approval");
    expect(generation.start).toHaveBeenCalledTimes(2);
  });
});
