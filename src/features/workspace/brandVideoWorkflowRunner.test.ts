import { describe, expect, it, vi } from "vitest";
import type { BrandModelSelection, BrandModelVersion } from "../../lib/brandModels";
import type { ModelParameterCapability } from "../../lib/modelCapabilities";
import { catalog, node, fakeDependencies } from "../../test/videoWorkflowFixtures";
import {
  brandVideoDurationPlan,
  createBrandVideoWorkflowRunner,
  parseBrandVideoPlan,
} from "./brandVideoWorkflowRunner";
import {
  createBrandVideoOptions,
  brandVideoRequirements,
  brandVideoInputReady,
  brandVideoDeliveryMarkdown,
  type BrandVideoWorkflowOptions,
  type BrandVideoSourceImage,
} from "./brandVideoWorkflowModel";
import {
  approveWorkflowExecutionPlan,
  createWorkflowDeliveryPlan,
  getWorkflowExecutionPlan,
} from "./workflowExecutionPlan";
import type {
  KnowledgeVideoWorkflowCheckpoint,
  KnowledgeVideoWorkflowNodeData,
} from "./workspaceModel";

const product = {
  localPath: "C:\\source\\earring.png",
  displayName: "本款珍珠耳饰",
  kind: "image" as const,
  mimeType: "image/png",
  byteSize: 1024,
};
const model: BrandModelSelection = {
  profileId: "profile-1",
  versionId: "identity-1",
  signature: "1".repeat(64),
  name: "品牌模特 A",
  description: "原创成年女性模特",
  invariants: "蓝眼、短发、脸部雀斑",
  references: [
    {
      id: "front",
      label: "定稿正面",
      role: "front",
      path: "C:\\library\\model.png",
      contentHash: "a".repeat(64),
      width: 2048,
      height: 2048,
      taskId: "original-model-task",
      resultIndex: 0,
      sourceNodeId: "original-node",
    },
  ],
};
const version: BrandModelVersion = {
  id: model.versionId,
  version: 1,
  createdAt: 1,
  status: "approved",
  signature: model.signature,
  description: model.description,
  invariants: model.invariants,
  references: model.references,
};
const options: BrandVideoWorkflowOptions = {
  ...createBrandVideoOptions(),
  brandName: "珠宝品牌",
  productFacts: "本款珍珠耳饰，银色金属",
  productImages: [product],
  model,
};
const sources: readonly BrandVideoSourceImage[] = [
  {
    id: "product-1",
    label: product.displayName,
    role: "product",
    path: product.localPath,
    contentHash: "a".repeat(64),
    width: 2048,
    height: 2048,
  },
  {
    id: "model-front",
    label: "模特正面",
    role: "model",
    path: model.references[0]!.path,
    contentHash: "a".repeat(64),
    width: 2048,
    height: 2048,
  },
];
function output(count = 4, references = ["model-front", "product-1"], subject = "model") {
  return {
    schemaVersion: "brand-video-plan.v1",
    concept: {
      title: "光的形状",
      idea: "用珠光与剪影表达系列",
      visualDirection: "冷白留白，缓慢运镜",
      soundDirection: "克制环境音，需实际试听",
      copy: "留住一束光",
    },
    shots: Array.from({ length: count }, (_, index) => ({
      id: `shot-${index + 1}`,
      title: `镜头 ${index + 1}`,
      subject,
      visual: "模特佩戴耳饰缓慢转头",
      videoPrompt: "微距展示珠光，轻微转头",
      narration: "",
      referenceAssetIds: references,
      acceptance: ["耳饰结构和人物特征与原图一致"],
    })),
  };
}
function fixture(changes: Partial<BrandVideoWorkflowOptions> = {}) {
  const fake = fakeDependencies("");
  vi.mocked(fake.promptClient.run).mockImplementation((command) => {
    const raw =
      command.mode === "brand_video_plan"
        ? JSON.stringify(output())
        : JSON.stringify({ result: "PASS", report: "采样帧未发现明显改变，仍需人工对照审核" });
    return Promise.resolve({ optimizedPrompt: raw, rawModelOutput: raw });
  });
  let sourceHash = "a".repeat(64);
  const readImage = vi.fn(() =>
    Promise.resolve({
      dataUrl: "data:image/png;base64,AA==",
      width: 2048,
      height: 2048,
      contentHash: sourceHash,
    }),
  );
  const validateModel = vi.fn(() => Promise.resolve(version));
  const runner = createBrandVideoWorkflowRunner(
    {
      promptClient: fake.promptClient,
      generationClient: fake.generation,
      frameClient: fake.frames,
      composerClient: fake.composer,
      sleep: () => Promise.resolve(),
      createId: () => "brand-run-1",
      now: () => 10,
    },
    { readImage, validateModel },
  );
  const original = node();
  const base: KnowledgeVideoWorkflowNodeData = {
    ...original,
    config: {
      ...original.config,
      brief: "",
      brandVideo: { ...options, ...changes },
      models: { ...original.config.models, image: { providerId: "", modelDefinitionId: "" } },
    },
  };
  const run = (checkpoint?: KnowledgeVideoWorkflowCheckpoint) =>
    runner.run({
      node: checkpoint ? { ...base, config: { ...base.config, checkpoint } } : base,
      providerCatalog: catalog,
      ...(checkpoint ? { resume: true } : {}),
      signal: new AbortController().signal,
      onCheckpoint: vi.fn(),
      onProgress: vi.fn(),
    });
  const approve = (
    checkpoint: KnowledgeVideoWorkflowCheckpoint,
  ): KnowledgeVideoWorkflowCheckpoint => {
    const current = { ...base, config: { ...base.config, checkpoint } };
    const plan = getWorkflowExecutionPlan(current)!;
    return { ...checkpoint, executionPlan: approveWorkflowExecutionPlan(plan, current, 20) };
  };
  return {
    ...fake,
    runner,
    base,
    run,
    approve,
    readImage,
    validateModel,
    changeSource: () => {
      sourceHash = "b".repeat(64);
    },
  };
}

describe("brand video production", () => {
  it("shares truthful missing inputs while allowing imagery-only and document work", () => {
    expect(brandVideoInputReady(createBrandVideoOptions())).toBe(false);
    const required = brandVideoRequirements({
      ...createBrandVideoOptions(),
      brandName: "品牌",
      productFacts: "银色耳饰",
    });
    expect(required.map(({ field }) => field)).toEqual(["真实商品图"]);
    expect(required[0]?.hint).toContain("添加本款商品");
    expect(
      brandVideoInputReady({ ...createBrandVideoOptions(), brief: "用光和冰花表达新品季节" }),
    ).toBe(true);
    expect(
      brandVideoInputReady({
        ...createBrandVideoOptions(),
        brandName: "品牌",
        productFacts: "银色耳饰",
        deliverable: "documents",
      }),
    ).toBe(true);
  });

  it("uses declared discrete/range durations and discloses rounded totals", () => {
    const capability: ModelParameterCapability = {
      key: "duration",
      label: "时长",
      type: "integer",
      defaultValue: 8,
      options: [
        { value: 8, label: "8秒" },
        { value: 12, label: "12秒" },
      ],
      optional: false,
      requiresNoMedia: false,
      order: 0,
    };
    expect(brandVideoDurationPlan(20, capability)).toEqual([8, 8, 8]);
    expect(
      brandVideoDurationPlan(20, { ...capability, options: [], minimum: 2, maximum: 12, step: 2 }),
    ).toEqual([6, 6, 6, 2]);
    expect(() => brandVideoDurationPlan(20)).toThrow("未声明合法单镜时长");
    expect(() => brandVideoDurationPlan(0, capability)).toThrow("总时长无效");
  });

  it("rejects duplicated Windows file targets across product/model roles before planning", async () => {
    const f = fixture({ productImages: [{ ...product, localPath: "c:/LIBRARY/model.png" }] });
    expect(brandVideoRequirements(f.base.config.brandVideo!).map(({ field }) => field)).toContain(
      "参考图用途",
    );
    const pending = await f.run();
    const failed = await f.run(f.approve(pending));
    expect(failed.error).toContain("选择独立的商品原图或模特身份图");
    expect(f.promptClient.run).not.toHaveBeenCalled();
    expect(f.generation.start).not.toHaveBeenCalled();
  });

  it("parses the dedicated protocol, preserves reference order, and rejects invented assets or replacement images", () => {
    const parsed = parseBrandVideoPlan(JSON.stringify(output()), options, sources, [5, 5, 5, 5]);
    expect(parsed.shots[0]!.videoPrompt).toContain("图片1=model-front");
    expect(parsed.shots[0]!.videoPrompt).toContain("图片2=product-1");
    expect(parsed.shots[0]!.videoPrompt).toContain("克制环境音，需实际试听");
    expect(parsed.shots[0]!.imagePrompt).toBeUndefined();
    expect(() =>
      parseBrandVideoPlan(JSON.stringify(output(4, ["invented"])), options, sources, [5, 5, 5, 5]),
    ).toThrow("未提供");
    expect(() =>
      parseBrandVideoPlan(
        JSON.stringify({ ...output(), assets: [] }),
        options,
        sources,
        [5, 5, 5, 5],
      ),
    ).toThrow("不完整方案");
    expect(() =>
      parseBrandVideoPlan(JSON.stringify(output(4, [], "product")), options, sources, [5, 5, 5, 5]),
    ).toThrow("真实商品参考");
  });

  it("gates assets, first shot, batch, composition and final with stable saved task identities", async () => {
    const f = fixture();
    let state = await f.run();
    expect(state.phase).toBe("awaiting_approval");
    expect(f.promptClient.run).not.toHaveBeenCalled();
    state = await f.run(f.approve(state));
    expect(state.executionPlan?.scope).toBe("delivery");
    expect(state.brandVideo?.sourceImages[1]).toMatchObject({
      taskId: "original-model-task",
      resultIndex: 0,
      sourceNodeId: "original-node",
    });
    expect(f.generation.start).not.toHaveBeenCalled();
    state = await f.run(f.approve(state));
    expect(state.executionPlan?.review?.kind).toBe("assets");
    expect(f.generation.start).not.toHaveBeenCalled();
    state = await f.run(f.approve(state));
    expect(state.executionPlan?.review?.kind).toBe("first_shot");
    expect(f.generation.start).toHaveBeenCalledTimes(1);
    const firstTask = state.shotRuns["shot-1"]?.videoTaskId;
    const command = vi.mocked(f.generation.start).mock.calls[0]![0];
    expect(command.operation).toBe("video_generation");
    expect(command.explicitMedia?.map((media) => media.target)).toEqual([
      { kind: "local_file", path: model.references[0]!.path, mediaType: "image" },
      { kind: "local_file", path: product.localPath, mediaType: "image" },
    ]);
    state = await f.run(f.approve(state));
    expect(state.executionPlan?.review?.kind).toBe("composition");
    expect(f.generation.start).toHaveBeenCalledTimes(4);
    expect(state.shotRuns["shot-1"]?.videoTaskId).toBe(firstTask);
    const qc = vi
      .mocked(f.promptClient.run)
      .mock.calls.map(([command]) => command)
      .find((command) => command.mode === "ai_film_qc")!;
    expect(qc.visionImages).toHaveLength(7);
    expect(qc.userPrompt).toContain("后五张为本镜头实际采样帧");
    expect(qc.userPrompt).toContain(model.invariants);
    expect(f.composer.startComposition).not.toHaveBeenCalled();
    state = await f.run(f.approve(state));
    expect(state.executionPlan?.review?.kind).toBe("final");
    expect(f.composer.startComposition).toHaveBeenCalledTimes(1);
    state = await f.run(f.approve(state));
    expect(state.phase).toBe("done");
    expect(f.generation.start).toHaveBeenCalledTimes(4);
    expect(f.composer.startComposition).toHaveBeenCalledTimes(1);
    const markdown = brandVideoDeliveryMarkdown(state);
    expect(markdown).toContain(model.versionId);
    expect(markdown).toContain(firstTask!);
    expect(markdown).toContain(state.finalPath!);
  });

  it("rechecks same-path source bytes before resumed paid generation and retains completed work", async () => {
    const f = fixture();
    let state = await f.run();
    state = await f.run(f.approve(state));
    state = await f.run(f.approve(state));
    state = await f.run(f.approve(state));
    const taskId = state.shotRuns["shot-1"]?.videoTaskId;
    f.changeSource();
    const failed = await f.run(f.approve(state));
    expect(failed.phase).toBe("failed");
    expect(failed.error).toContain("文件内容已改变");
    expect(failed.shotRuns["shot-1"]?.videoTaskId).toBe(taskId);
    expect(f.generation.start).toHaveBeenCalledTimes(1);
  });

  it("rejects a tampered identity snapshot before any text or media request", async () => {
    const f = fixture({ model: { ...model, invariants: "与定稿不同的脸" } });
    const state = await f.run();
    const failed = await f.run(f.approve(state));
    expect(failed.error).toContain("定稿版本不一致");
    expect(f.promptClient.run).not.toHaveBeenCalled();
    expect(f.generation.start).not.toHaveBeenCalled();
  });

  it("blocks paid media after an edited shot loses its frozen identity reference", async () => {
    const f = fixture();
    let state = await f.run();
    state = await f.run(f.approve(state));
    state = {
      ...state,
      shots: state.shots.map((shot) => ({ ...shot, referenceAssetIds: ["product-1"] })),
    };
    // The node's existing editor produces a fresh delivery plan for the changed storyboard.
    state = {
      ...state,
      executionPlan: createWorkflowDeliveryPlan({
        ...f.base,
        config: { ...f.base.config, checkpoint: state },
      }),
    };
    const failed = await f.run(f.approve(state));
    expect(failed.error).toContain("保留定稿模特参考");
    expect(f.generation.start).not.toHaveBeenCalled();
  });

  it("refuses to regenerate a missing fixed product/model asset during recovery", async () => {
    const f = fixture();
    let state = await f.run();
    state = await f.run(f.approve(state));
    state = {
      ...state,
      film: {
        ...state.film!,
        assets: state.film!.assets.map((asset) => ({ ...asset, path: null })),
      },
    };
    const failed = await f.run(f.approve(state));
    expect(failed.error).toContain("不能生成替代商品或模特资产");
    expect(f.generation.start).not.toHaveBeenCalled();
  });

  it("rechecks original bytes after text planning and before accepting its result", async () => {
    const f = fixture();
    const plan = await f.run();
    const originalRun = vi.mocked(f.promptClient.run).getMockImplementation()!;
    vi.mocked(f.promptClient.run).mockImplementation(async (command) => {
      const response = await originalRun(command);
      f.changeSource();
      return response;
    });
    const failed = await f.run(f.approve(plan));
    expect(failed.error).toContain("文件内容已改变");
    expect(f.generation.start).not.toHaveBeenCalled();
  });

  it("delivers document concepts without requiring image/video models or paying for media", async () => {
    const f = fixture({ deliverable: "documents" });
    let state = await f.run();
    state = await f.run(f.approve(state));
    expect(state.phase).toBe("done");
    expect(state.documentsOnly).toBe(true);
    expect(state.brandVideo?.durationNote).toContain("尚未绑定供应商合法时长");
    expect(f.generation.start).not.toHaveBeenCalled();
    expect(f.composer.startComposition).not.toHaveBeenCalled();
  });
});
