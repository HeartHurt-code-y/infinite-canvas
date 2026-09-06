import { describe, expect, it, vi } from "vitest";
import {
  workflowReferenceFixtures,
  workflowReferenceInputs,
  workflowConnectedReferenceFixtures,
} from "../../test/workflowMaterialFixtures";
import { stableJsonSignature } from "../../lib/workflowSignatures";
import type { OptimizeVideoPromptCommand, ProviderCatalogEntry } from "../../lib/backend";
import type { CommerceSourceClient } from "../../lib/commerceSources";
import { catalog, fakeDependencies, node, planJson } from "../../test/videoWorkflowFixtures";
import {
  createCommerceOptions,
  type CommerceSource,
  type CommerceStage,
} from "./commerceWorkflowModel";
import { createCommerceWorkflowRunner, parseCommerceStage } from "./commerceWorkflowRunner";
import type { KnowledgeVideoWorkflowNodeData } from "./workspaceModel";

const productPath = "C:\\products\\真实产品.png";
const productImage = {
  localPath: productPath,
  displayName: "真实产品.png",
  kind: "image" as const,
  mimeType: "image/png",
  byteSize: 2048,
};
const assets = [
  {
    id: "CHAR-01",
    kind: "character",
    name: "通勤者",
    prompt:
      "固定人物四宫格：正面全身、侧面全身、背面全身、正面脸部近景；同一身份和服装，灰背景，细分隔线，无标签。",
  },
];
const userFact = { id: "F01", claim: "白色杯身，带提手", basis: "user", sourceUrls: [] };
const pass = { result: "PASS", report: "当前事实依据、剧情与原图引用检查通过" };
const stageData = (stage: CommerceStage) => ({
  schemaVersion: "commerce-stage.v1",
  stage,
  status: "ready",
  decision: null,
  content:
    stage === "creative"
      ? "A：通勤救场，评分 9；B：家庭误会，评分 8；C：悬疑揭秘，评分 7。自动选择 A，产品直接解决冲突。"
      : stage === "quick"
        ? "0–3 秒冲突；3–6 秒主动拿出产品；6–10 秒使用证明；10–15 秒回扣和 CTA。"
        : `# ${stage} 完整成果`,
  inputSummary: "用户提供的产品资料及已检查上游成果",
  facts: stage === "research" || stage === "quick" ? [userFact] : [],
  assets: stage === "assets" || stage === "quick" ? assets : [],
  shots:
    stage === "storyboard" || stage === "quick"
      ? [1, 2, 3].map((index) => ({
          id: `V-0${index}`,
          title: `通勤救场 ${index}`,
          durationSeconds: 5,
          visual: "通勤者主动提起白色水杯，包装外观保持原图",
          dialogue: index === 1 ? "这下方便了。" : "",
          videoPrompt: "使用产品原图与固定人物参考，保持杯身和提手外观，动作连贯。",
          referenceAssetIds: ["product-01", "CHAR-01"],
          acceptance: ["真实产品外观不变", "人物身份一致"],
        }))
      : [],
});
function response(data: object) {
  const raw = JSON.stringify(data);
  return Promise.resolve({ optimizedPrompt: raw, rawModelOutput: raw });
}
function normalResponse(command: OptimizeVideoPromptCommand) {
  if (command.mode === "commerce_review" || command.mode === "ai_film_qc") return response(pass);
  return response(stageData(command.mode.replace("commerce_", "") as CommerceStage));
}
function setup(mode: "quick" | "full" = "quick", deliverable: "video" | "documents" = "documents") {
  const fake = fakeDependencies(planJson());
  vi.mocked(fake.promptClient.run).mockImplementation(normalResponse);
  let imageCount = 0;
  let videoCount = 0;
  vi.mocked(fake.generation.start).mockImplementation((command) =>
    Promise.resolve(
      command.operation === "text_to_image" ? `image-${++imageCount}` : `video-${++videoCount}`,
    ),
  );
  const sourceClient = { fetch: vi.fn<CommerceSourceClient["fetch"]>().mockResolvedValue([]) };
  const source = node();
  const commerceNode: KnowledgeVideoWorkflowNodeData = {
    ...source,
    config: {
      ...source.config,
      brief: "用可观察的外观和使用动作制作剧情带货视频",
      commerce: {
        ...createCommerceOptions(),
        mode,
        deliverable,
        productName: "通勤水杯",
        productFacts: "白色杯身，带提手",
        materials: [productImage],
      },
    },
  };
  const runner = createCommerceWorkflowRunner({
    promptClient: fake.promptClient,
    generationClient: fake.generation,
    frameClient: fake.frames,
    composerClient: fake.composer,
    sourceClient,
    sleep: () => Promise.resolve(),
    now: () => 42,
  });
  const request = {
    node: commerceNode,
    providerCatalog: catalog,
    signal: new AbortController().signal,
    onCheckpoint: vi.fn(),
    onProgress: vi.fn(),
  };
  const calls = () => vi.mocked(fake.promptClient.run).mock.calls.map(([command]) => command);
  return { fake, sourceClient, runner, request, calls };
}

describe("commerce composite workflow", () => {
  it("retains product references before general materials and keeps all five QC frames", async () => {
    const { runner, request, calls } = setup("quick", "video");
    const withMaterials = {
      ...request,
      node: {
        ...request.node,
        config: {
          ...request.node.config,
          materials: workflowReferenceFixtures,
          connectedMaterials: workflowConnectedReferenceFixtures,
        },
      },
    };
    const checkpoint = await runner.run(withMaterials);
    expect(checkpoint.phase).toBe("done");
    for (const input of calls()) {
      expect(input.referenceInputs).toEqual(workflowConnectedReferenceFixtures);
      if (input.mode === "ai_film_qc") {
        expect(input.multimodalInputs).toEqual(workflowReferenceInputs);
        expect(input.visionImages).toHaveLength(6);
        expect(input.visionImages?.[0]?.target).toEqual({
          kind: "local_file",
          path: productPath,
          mediaType: "image",
        });
      } else {
        expect(input.multimodalInputs?.[0]?.localPath).toBe(productPath);
        expect(input.multimodalInputs?.slice(1)).toEqual(workflowReferenceInputs);
      }
    }
    const resumed = await runner.run({
      ...withMaterials,
      resume: true,
      node: {
        ...withMaterials.node,
        config: {
          ...withMaterials.node.config,
          materials: [],
          checkpoint: { ...checkpoint, phase: "paused" },
        },
      },
    });
    expect(resumed.error).toContain("参考素材已修改");
  });

  it("delivers 15 seconds with original product media, generating only fictional assets through project models", async () => {
    const { runner, request, fake, calls } = setup("quick", "video");
    const result = await runner.run(request);
    expect(result.phase).toBe("done");
    expect(result.finalPath).toBeTruthy();
    expect(result.shots.reduce((sum, shot) => sum + shot.durationSeconds, 0)).toBe(15);
    expect(calls().map((command) => command.mode)).toEqual([
      "commerce_quick",
      "commerce_review",
      "ai_film_qc",
      "ai_film_qc",
      "ai_film_qc",
    ]);
    expect(calls()[0]?.multimodalInputs).toEqual([
      {
        localPath: productPath,
        displayName: productImage.displayName,
        kind: "image",
        mimeType: "image/png",
      },
    ]);
    expect(calls().every((command) => command.providerConnectionId === "project-provider")).toBe(
      true,
    );
    for (const qc of calls().filter((command) => command.mode === "ai_film_qc")) {
      expect(qc.visionImages).toEqual([
        {
          target: { kind: "local_file", path: productPath, mediaType: "image" },
          displayName: "product-01 · 产品原图对照",
        },
      ]);
      expect(qc.multimodalInputs).toHaveLength(5);
      expect(
        qc.multimodalInputs?.every((material) => material.localPath === "C:\\output\\sample.png"),
      ).toBe(true);
      expect(qc.userPrompt).toContain("前 1 张图片为真实产品原图");
      expect(qc.userPrompt).toContain("后续五张为按时间顺序的成片采样帧");
    }
    const submissions = vi.mocked(fake.generation.start).mock.calls.map(([command]) => command);
    const images = submissions.filter((command) => command.operation === "text_to_image");
    expect(images).toHaveLength(1);
    expect(images[0]?.prompt).toEqual([{ kind: "text", text: assets[0]!.prompt }]);
    expect(result.film?.assets.find((asset) => asset.id === "product-01")).toMatchObject({
      path: productPath,
    });
    const videos = submissions.filter((command) => command.operation === "video_generation");
    expect(videos).toHaveLength(3);
    for (const video of videos) {
      expect(video.providerConnectionId).toBe("project-provider");
      expect(video.modelDefinitionId).toBe("project-video");
      expect(video.explicitMedia?.map((media) => media.target)).toEqual([
        { kind: "local_file", path: productPath, mediaType: "image" },
        { kind: "local_file", path: "C:\\output\\image-1.png", mediaType: "image" },
      ]);
      expect(video.explicitMedia?.map((media) => media.typePosition)).toEqual([1, 2]);
      const prompt = video.prompt[0];
      if (prompt?.kind !== "text") throw new Error("Missing video prompt");
      expect(prompt.text).toContain("图片1 对应 product-01");
    }
    expect(fake.composer.startComposition).toHaveBeenCalledTimes(1);
  });

  it("completes five document stages without product images or media models and automatically selects from three creative options", async () => {
    const { runner, request, fake, calls } = setup("full");
    vi.mocked(fake.promptClient.run).mockImplementation((command) => {
      if (command.mode === "commerce_storyboard")
        return response({
          ...stageData("storyboard"),
          shots: stageData("storyboard").shots.map((shot) => ({
            ...shot,
            referenceAssetIds: ["CHAR-01"],
          })),
        });
      return normalResponse(command);
    });
    request.node = {
      ...request.node,
      config: {
        ...request.node.config,
        commerce: { ...request.node.config.commerce!, materials: [] },
        models: {
          ...request.node.config.models,
          image: { providerId: "", modelDefinitionId: "" },
          video: { providerId: "", modelDefinitionId: "" },
        },
      },
    };
    const result = await runner.run(request);
    expect(result.phase).toBe("done");
    expect(result.documentsOnly).toBe(true);
    expect(result.decision).toBeNull();
    expect(calls().map((command) => command.mode)).toEqual([
      "commerce_research",
      "commerce_review",
      "commerce_creative",
      "commerce_review",
      "commerce_script",
      "commerce_review",
      "commerce_storyboard",
      "commerce_review",
      "commerce_assets",
      "commerce_review",
    ]);
    expect(calls()[4]?.userPrompt).toContain("自动选择 A");
    expect(calls()[4]?.userPrompt).toContain("B：家庭误会");
    expect(calls()[8]?.userPrompt).toContain("CHAR-01");
    expect(
      Object.values(result.commerce!.stages).every((run) => run.review?.result === "PASS"),
    ).toBe(true);
    expect(fake.generation.start).not.toHaveBeenCalled();
    expect(fake.composer.startComposition).not.toHaveBeenCalled();
  });

  it("passes fetched page text into research and refuses source claims pointing to unread pages", async () => {
    const { runner, request, sourceClient, fake, calls } = setup("full");
    const url = "https://product.example/cup";
    const source: CommerceSource = {
      url,
      title: "产品说明",
      text: "杯身为白色，顶部装有提手。",
      status: "fetched",
    };
    request.node = {
      ...request.node,
      config: {
        ...request.node.config,
        commerce: { ...request.node.config.commerce!, productUrl: url },
      },
    };
    sourceClient.fetch.mockResolvedValue([source]);
    const research = {
      ...stageData("research"),
      facts: [{ id: "F01", claim: "杯身为白色，顶部装有提手", basis: "source", sourceUrls: [url] }],
    };
    vi.mocked(fake.promptClient.run).mockImplementation((command) =>
      command.mode === "commerce_research" ? response(research) : normalResponse(command),
    );
    const result = await runner.run(request);
    expect(result.phase).toBe("done");
    expect(sourceClient.fetch).toHaveBeenCalledWith([url]);
    expect(calls()[0]?.userPrompt).toContain(source.text);
    expect(result.commerce?.stages.research?.artifact?.facts[0]?.basis).toBe("source");
    expect(() =>
      parseCommerceStage(JSON.stringify(research), "research", [
        { ...source, status: "failed", text: "" },
      ]),
    ).toThrow("未实际读取的来源");
    expect(() => parseCommerceStage(JSON.stringify(research), "research", [])).toThrow(
      "未实际读取的来源",
    );
  });

  it("resumes a legacy signature after a serde-style key-order round trip and reuses completed research and source results", async () => {
    const { runner, request, fake, sourceClient, calls } = setup("full");
    const url = "https://product.example/cup";
    request.node = {
      ...request.node,
      config: {
        ...request.node.config,
        commerce: { ...request.node.config.commerce!, productUrl: url },
      },
    };
    sourceClient.fetch.mockResolvedValue([
      { url, title: "说明", text: "带提手", status: "fetched" },
    ]);
    let interrupted = false;
    vi.mocked(fake.promptClient.run).mockImplementation((command) => {
      if (command.mode === "commerce_review" && !interrupted) {
        interrupted = true;
        return Promise.reject(new Error("review connection interrupted"));
      }
      return normalResponse(command);
    });
    const first = await runner.run(request);
    expect(first.phase).toBe("failed");
    expect(first.commerce?.stages.research?.artifact).toBeTruthy();
    expect(first.commerce?.stages.research?.review).toBeNull();
    const restored = {
      ...request.node,
      config: {
        ...request.node.config,
        checkpoint: {
          ...first,
          commerce: {
            ...first.commerce!,
            inputSignature: JSON.stringify({
              brief: request.node.config.brief,
              ...request.node.config.commerce,
              deliverable: undefined,
            }),
          },
        },
      },
    };
    const next = await runner.run({
      ...request,
      resume: true,
      node: JSON.parse(stableJsonSignature(restored)) as KnowledgeVideoWorkflowNodeData,
    });
    expect(next.phase).toBe("done");
    expect(calls()[2]?.mode).toBe("commerce_review");
    expect(calls().filter((command) => command.mode === "commerce_research")).toHaveLength(1);
    expect(sourceClient.fetch).toHaveBeenCalledTimes(1);
    expect(fake.generation.start).not.toHaveBeenCalled();
  });

  it("revises failed checks automatically and preserves the previous artifact before a fresh review", async () => {
    const { runner, request, fake, calls } = setup();
    let reviewCount = 0;
    vi.mocked(fake.promptClient.run).mockImplementation((command) => {
      if (command.mode === "commerce_review" && reviewCount++ === 0)
        return response({
          result: "REVISE",
          report: "缺少产品伏笔",
          repairInstructions: "在第一镜提前放置水杯，第二镜主动拿起",
        });
      return normalResponse(command);
    });
    const result = await runner.run(request);
    expect(result.phase).toBe("done");
    expect(calls().map((command) => command.mode)).toEqual([
      "commerce_quick",
      "commerce_review",
      "commerce_quick",
      "commerce_review",
    ]);
    expect(calls()[2]?.userPrompt).toContain("在第一镜提前放置水杯，第二镜主动拿起");
    expect(result.commerce?.stages.quick?.artifact?.version).toBe(2);
    expect(result.commerce?.stages.quick?.history).toHaveLength(1);
    expect(result.commerce?.stages.quick?.review?.result).toBe("PASS");
  });

  it("applies customer decisions by rewriting and rechecking instead of accepting the old artifact", async () => {
    const { runner, request, fake, calls } = setup();
    let reviewCount = 0;
    vi.mocked(fake.promptClient.run).mockImplementation((command) => {
      if (command.mode === "commerce_review" && reviewCount++ === 0)
        return response({
          result: "NEEDS_DECISION",
          report: "使用方式缺少说明",
          question: "是否删除未经确认的密封承诺？",
          recommendation: "删去密封承诺，仅表现提手",
        });
      return normalResponse(command);
    });
    const first = await runner.run(request);
    expect(first.phase).toBe("awaiting_approval");
    expect(calls()).toHaveLength(2);
    const next = await runner.run({
      ...request,
      resume: true,
      decisionResolution: "删去密封承诺，保留提手动作",
      node: { ...request.node, config: { ...request.node.config, checkpoint: first } },
    });
    expect(next.phase).toBe("done");
    expect(
      calls()
        .slice(2)
        .map((command) => command.mode),
    ).toEqual(["commerce_quick", "commerce_review"]);
    expect(calls()[2]?.userPrompt).toContain(
      "用户已确认的决定，必须实际应用：删去密封承诺，保留提手动作",
    );
    expect(next.commerce?.stages.quick?.artifact?.version).toBe(2);
    expect(next.commerce?.stages.quick?.history).toHaveLength(1);
  });

  it("rejects changed product inputs before reusing an already completed paused plan", async () => {
    const { runner, request, fake, calls } = setup();
    const first = await runner.run(request);
    const count = calls().length;
    const result = await runner.run({
      ...request,
      resume: true,
      node: {
        ...request.node,
        config: {
          ...request.node.config,
          checkpoint: { ...first, phase: "paused" },
          commerce: { ...request.node.config.commerce!, productFacts: "红色杯身，没有提手" },
        },
      },
    });
    expect(result.phase).toBe("failed");
    expect(result.error).toContain("产品资料或制作设置已修改");
    expect(calls()).toHaveLength(count);
    expect(result.commerce?.stages.quick?.artifact).toEqual(first.commerce?.stages.quick?.artifact);
    expect(fake.generation.start).not.toHaveBeenCalled();
  });

  it("rejects a video model whose allowed durations cannot compose 15 seconds before any model call", async () => {
    const { runner, request, fake, calls } = setup("quick", "video");
    const incompatibleCatalog: readonly ProviderCatalogEntry[] = catalog.map((entry) => ({
      ...entry,
      models: entry.models.map((model) =>
        model.definitionId === "project-video"
          ? {
              ...model,
              operationSchema: {
                video_generation: {
                  parameters: { duration: { type: "integer", enum: [4, 8], default: 4 } },
                },
              },
            }
          : model,
      ),
    }));
    const result = await runner.run({ ...request, providerCatalog: incompatibleCatalog });
    expect(result.phase).toBe("failed");
    expect(result.error).toContain("时长无法组合为 15 秒");
    expect(calls()).toHaveLength(0);
    expect(fake.generation.start).not.toHaveBeenCalled();
  });

  it("keeps completed assets when a new full workflow with archived quick history resumes media generation", async () => {
    const { runner, request, fake, calls } = setup("quick", "video");
    const quick = await runner.run(request);
    expect(quick.phase).toBe("done");
    const normalStart = vi.mocked(fake.generation.start).getMockImplementation()!;
    vi.mocked(fake.generation.start).mockImplementation((command) =>
      command.operation === "video_generation"
        ? Promise.reject(new Error("temporary video provider interruption"))
        : normalStart(command),
    );
    const fullNode: KnowledgeVideoWorkflowNodeData = {
      ...request.node,
      config: {
        ...request.node.config,
        checkpoint: quick,
        maxAutomaticRetries: 0,
        commerce: { ...request.node.config.commerce!, mode: "full" },
      },
    };
    const interrupted = await runner.run({ ...request, node: fullNode });
    expect(interrupted.phase).toBe("failed");
    expect(interrupted.commerce?.stages.quick?.artifact).toBeNull();
    expect(interrupted.commerce?.stages.quick?.history).toHaveLength(1);
    expect(interrupted.commerce?.planningComplete).toBe(true);
    const generatedAsset = interrupted.film?.assets.find((asset) => asset.id === "CHAR-01");
    expect(generatedAsset?.path).toBe("C:\\output\\image-2.png");
    const stageCalls = () => calls().filter((command) => command.mode.startsWith("commerce_"));
    const stageCallCount = stageCalls().length;
    const imageCalls = () =>
      vi
        .mocked(fake.generation.start)
        .mock.calls.filter(([command]) => command.operation === "text_to_image");
    const imageCount = imageCalls().length;
    vi.mocked(fake.generation.start).mockImplementation(normalStart);
    const result = await runner.run({
      ...request,
      resume: true,
      node: { ...fullNode, config: { ...fullNode.config, checkpoint: interrupted } },
    });
    expect(result.phase).toBe("done");
    expect(stageCalls()).toHaveLength(stageCallCount);
    expect(imageCalls()).toHaveLength(imageCount);
    expect(result.film?.assets.find((asset) => asset.id === "CHAR-01")).toEqual(generatedAsset);
    expect(result.shots).toHaveLength(3);
  });

  it("rejects attempts to regenerate product IDs or silently omit real product references", async () => {
    expect(() =>
      parseCommerceStage(
        JSON.stringify({ ...stageData("quick"), assets: [{ ...assets[0], id: "product-01" }] }),
        "quick",
        [],
      ),
    ).toThrow("不能生成或替换 product-*");
    const { runner, request, fake } = setup("quick", "video");
    vi.mocked(fake.promptClient.run).mockImplementation(() =>
      response({
        ...stageData("quick"),
        shots: stageData("quick").shots.map((shot) => ({
          ...shot,
          referenceAssetIds: ["CHAR-01"],
        })),
      }),
    );
    const result = await runner.run(request);
    expect(result.phase).toBe("failed");
    expect(result.error).toContain("必须引用真实产品原图");
    expect(fake.generation.start).not.toHaveBeenCalled();
  });
});
