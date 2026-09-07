import { describe, expect, it, vi } from "vitest";
import {
  workflowReferenceFixtures,
  workflowReferenceInputs,
  workflowConnectedReferenceFixtures,
} from "../../test/workflowMaterialFixtures";
import { stableJsonSignature } from "../../lib/workflowSignatures";
import type {
  OptimizeVideoPromptCommand,
  PickedPromptMaterial,
  ProviderCatalogEntry,
} from "../../lib/backend";
import { catalog, completedTask, fakeDependencies, node } from "../../test/videoWorkflowFixtures";
import {
  createXhsCoverOptions,
  XHS_COVER_MAX_REFERENCE_BYTES,
  xhsCoverDeliveryMarkdown,
  xhsCoverInputReady,
  type XhsCoverPlan,
} from "./xhsCoverWorkflowModel";
import {
  createXhsCoverWorkflowRunner,
  parseXhsCoverPlan,
  parseXhsCoverReview,
} from "./xhsCoverWorkflowRunner";
import type {
  KnowledgeVideoWorkflowCheckpoint,
  KnowledgeVideoWorkflowNodeData,
} from "./workspaceModel";

const portrait: PickedPromptMaterial = {
  localPath: "C:\\references\\portrait.png",
  displayName: "人物原图.png",
  kind: "image",
  mimeType: "image/png",
  byteSize: 100,
};
const material: PickedPromptMaterial = {
  ...portrait,
  localPath: "C:\\references\\product.png",
  displayName: "产品截图.png",
};
const plan: XhsCoverPlan = {
  schemaVersion: "xhs-cover-plan.v1",
  style: "checklist",
  title: "零基础也能上手",
  subtitle: "三步完成部署",
  titleCandidates: ["零基础也能上手", "这次终于懂了", "三步轻松部署"],
  rationale: "面向零基础读者的三步教程，采用勾选清单",
  prompt: "人物原图居左并指向清单，超粗主标题「零基础也能上手」，产品截图位于右侧。",
};
const pass = { result: "PASS", report: "逐字标题、原人物、素材与安全区均已对照实际封面检查" };
const output = (value: object) =>
  Promise.resolve({
    optimizedPrompt: JSON.stringify(value),
    rawModelOutput: JSON.stringify(value),
  });
const projectCatalog: readonly ProviderCatalogEntry[] = catalog.map((entry) => ({
  ...entry,
  models: entry.models.map((model) =>
    model.definitionId !== "project-image"
      ? model
      : {
          ...model,
          operations: ["image_to_image"],
          operationSchema: {
            image_to_image: {
              parameters: {
                aspect_ratio: { type: "string", default: "1:1", enum: ["1:1", "3:4"] },
                n: { type: "integer", default: 4 },
              },
            },
          },
        },
  ),
}));

function setup() {
  const fake = fakeDependencies("");
  const normalResponse = (command: OptimizeVideoPromptCommand) =>
    output(command.mode === "xhs_cover_plan" ? plan : pass);
  vi.mocked(fake.promptClient.run).mockImplementation(normalResponse);
  let sequence = 0;
  vi.mocked(fake.generation.start).mockImplementation(() => Promise.resolve(`image-${++sequence}`));
  const normalizer = {
    normalize: vi.fn((command: { sourcePath: string; outputId: string }) =>
      Promise.resolve({ path: `C:\\covers\\${command.outputId}.png`, width: 1080, height: 1440 }),
    ),
  };
  const resultRecovery = {
    resume: vi.fn((taskId: string, resultIndex: number) =>
      Promise.resolve({ ...completedTask(taskId).results[0]!, resultIndex }),
    ),
  };
  const source = node();
  const coverNode: KnowledgeVideoWorkflowNodeData = {
    ...source,
    config: {
      ...source.config,
      brief: "给小白介绍三步部署方法",
      xhsCover: { ...createXhsCoverOptions(), portraits: [portrait], materials: [material] },
      models: { ...source.config.models, video: { providerId: "", modelDefinitionId: "" } },
    },
  };
  const runner = createXhsCoverWorkflowRunner({
    promptClient: fake.promptClient,
    generationClient: fake.generation,
    resultRecovery,
    normalizer,
    createId: () => "cover-run-1",
    now: () => 42,
    sleep: vi.fn(() => Promise.resolve()),
  });
  const request = {
    node: coverNode,
    providerCatalog: projectCatalog,
    signal: new AbortController().signal,
    onCheckpoint: vi.fn(),
    onProgress: vi.fn(),
  };
  const resume = (checkpoint: KnowledgeVideoWorkflowCheckpoint) => ({
    ...request,
    resume: true,
    node: { ...coverNode, config: { ...coverNode.config, checkpoint } },
  });
  const calls = () => vi.mocked(fake.promptClient.run).mock.calls.map(([command]) => command);
  return { fake, normalizer, resultRecovery, runner, request, resume, calls, normalResponse };
}

describe("single-node portrait cover workflow", () => {
  it("preserves portrait and product order while reading every general reference through planning and QC", async () => {
    const { runner, request, calls, fake } = setup();
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
      expect(input.multimodalInputs?.slice(0, 2).map((item) => item.localPath)).toEqual([
        portrait.localPath,
        material.localPath,
      ]);
      expect(input.multimodalInputs?.slice(2)).toEqual(workflowReferenceInputs);
    }
    expect(calls().find((input) => input.mode === "xhs_cover_qc")?.visionImages).toHaveLength(1);
    vi.mocked(fake.promptClient.run).mockClear();
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
    expect(fake.promptClient.run).not.toHaveBeenCalled();
  });

  it("uses project text and reference-image models and visually checks the normalized cover against actual references", async () => {
    const { fake, runner, request, normalizer, calls } = setup();
    const result = await runner.run(request);
    expect(result.phase).toBe("done");
    expect(result.xhsCover?.review?.result).toBe("PASS");
    expect(fake.generation.start).toHaveBeenCalledOnce();
    const generation = vi.mocked(fake.generation.start).mock.calls[0]![0];
    expect(generation).toMatchObject({
      operation: "image_to_image",
      providerConnectionId: "project-provider",
      modelDefinitionId: "project-image",
      generationCount: 1,
      parameters: { aspect_ratio: "3:4", n: 1 },
    });
    expect(generation.prompt.slice(1)).toMatchObject([
      { target: { kind: "local_file", path: portrait.localPath } },
      { target: { kind: "local_file", path: material.localPath } },
    ]);
    expect(calls().map((command) => command.mode)).toEqual(["xhs_cover_plan", "xhs_cover_qc"]);
    expect(
      calls().every(
        (command) =>
          command.providerConnectionId === "project-provider" &&
          command.modelDefinitionId === "project-text",
      ),
    ).toBe(true);
    expect(calls()[1]?.multimodalInputs).toEqual([portrait, material]);
    expect(calls()[1]?.visionImages).toMatchObject([
      { target: { kind: "local_file", path: result.finalPath } },
    ]);
    expect(normalizer.normalize).toHaveBeenCalledWith({
      sourcePath: "C:\\output\\image-1.png",
      outputId: "cover-run-1-1",
    });
    expect(result.script).toContain("3:4竖版小红书封面");
    expect(result.script).toContain("#FDFFA7");
    expect(xhsCoverDeliveryMarkdown(result)).toContain("1080×1440");
    expect(fake.composer.startComposition).not.toHaveBeenCalled();
  });

  it("delivers prompt and title candidates without requiring an image or video model or submitting image work", async () => {
    const { fake, runner, request, normalizer } = setup();
    const result = await runner.run({
      ...request,
      node: {
        ...request.node,
        config: {
          ...request.node.config,
          models: {
            ...request.node.config.models,
            image: { providerId: "", modelDefinitionId: "" },
          },
          xhsCover: { ...request.node.config.xhsCover!, deliverable: "prompt" },
        },
      },
    });
    expect(result).toMatchObject({ phase: "done", documentsOnly: true, finalPath: null });
    expect(result.xhsCover?.plan?.titleCandidates).toHaveLength(3);
    expect(fake.generation.start).not.toHaveBeenCalled();
    expect(normalizer.normalize).not.toHaveBeenCalled();
  });

  it("requires real portraits and rejects unsupported image models before any paid requests", async () => {
    const { fake, runner, request } = setup();
    const empty = await runner.run({
      ...request,
      node: {
        ...request.node,
        config: { ...request.node.config, xhsCover: createXhsCoverOptions() },
      },
    });
    expect(empty.error).toContain("人物参考图");
    const unsupported = await runner.run({ ...request, providerCatalog: catalog });
    expect(unsupported.error).toContain("图生图");
    expect(fake.promptClient.run).not.toHaveBeenCalled();
    expect(fake.generation.start).not.toHaveBeenCalled();
  });

  it("prevents title rewriting and repairs malformed plans before image submission", async () => {
    const { fake, runner, request, calls } = setup();
    vi.mocked(fake.promptClient.run).mockImplementationOnce(() =>
      output({ ...plan, title: "被模型改写的标题" }),
    );
    const result = await runner.run({
      ...request,
      node: {
        ...request.node,
        config: {
          ...request.node.config,
          xhsCover: { ...request.node.config.xhsCover!, title: plan.title },
        },
      },
    });
    expect(result.phase).toBe("done");
    expect(calls()[1]?.userPrompt).toContain("主标题必须逐字保留");
    expect(fake.generation.start).toHaveBeenCalledOnce();
  });

  it("repairs failed visual QC automatically, archives the failed image and checks the new image before delivery", async () => {
    const { fake, runner, request, calls, normalResponse } = setup();
    let qc = 0;
    vi.mocked(fake.promptClient.run).mockImplementation((command) =>
      command.mode === "xhs_cover_qc" && qc++ === 0
        ? output({
            result: "REVISE",
            report: "标题漏字",
            repairInstructions: "恢复标题中的基础两字",
          })
        : normalResponse(command),
    );
    const result = await runner.run(request);
    expect(result.phase).toBe("done");
    expect(fake.generation.start).toHaveBeenCalledTimes(2);
    expect(calls()[2]?.userPrompt).toContain("恢复标题中的基础两字");
    expect(result.xhsCover?.history).toHaveLength(1);
    expect(result.xhsCover?.history[0]?.review?.result).toBe("REVISE");
    expect(result.xhsCover?.history[0]?.finalPath).not.toBe(result.finalPath);
    expect(result.xhsCover?.review?.result).toBe("PASS");
  });

  it("keeps reworking automatically on REVISE without a retry limit, accepting only a passed review", async () => {
    const { fake, runner, request, normalResponse } = setup();
    let qcCalls = 0;
    vi.mocked(fake.promptClient.run).mockImplementation((command) =>
      command.mode === "xhs_cover_qc"
        ? (qcCalls += 1) <= 2
          ? output({
              result: "REVISE",
              report: "人物脸部被标题挡住",
              repairInstructions: "把人物向下移动",
            })
          : normalResponse(command)
        : normalResponse(command),
    );
    const result = await runner.run(request);
    expect(result.phase).toBe("done");
    expect(qcCalls).toBe(3);
    expect(fake.generation.start).toHaveBeenCalledTimes(3);
    expect(result.xhsCover?.review?.result).toBe("PASS");
    expect(result.xhsCover?.history).toHaveLength(2);
  });

  it("retains a necessary planning decision and makes no image request before confirmation", async () => {
    const { fake, runner, request, resume } = setup();
    vi.mocked(fake.promptClient.run).mockImplementationOnce(() =>
      output({
        ...plan,
        decision: {
          question: "参考图中的人物不是同一人，使用谁？",
          recommendation: "以第一张参考图为准",
        },
      }),
    );
    const pending = await runner.run(request);
    expect(pending.phase).toBe("awaiting_approval");
    expect(fake.generation.start).not.toHaveBeenCalled();
    const result = await runner.run({
      ...resume(pending),
      decisionResolution: "使用第一张中的人物",
    });
    expect(result.phase).toBe("done");
    expect(result.xhsCover?.confirmedDecisions?.[0]).toContain("使用第一张中的人物");
  });

  it("persists a submitted task when paused and resumes that task without another submission", async () => {
    const { fake, runner, request, resume } = setup();
    const controller = new AbortController();
    vi.mocked(fake.generation.start).mockImplementationOnce(() => {
      controller.abort();
      return Promise.resolve("image-existing");
    });
    const paused = await runner.run({ ...request, signal: controller.signal });
    expect(paused.phase).toBe("paused");
    expect(paused.xhsCover?.taskId).toBe("image-existing");
    const result = await runner.run(resume(paused));
    expect(result.phase).toBe("done");
    expect(fake.generation.start).toHaveBeenCalledOnce();
    expect(fake.generation.get).toHaveBeenCalledWith("image-existing");
  });

  it("resumes legacy QC after a serde-style key-order round trip without regenerating or renormalizing", async () => {
    const { fake, runner, request, resume, normalizer, normalResponse } = setup();
    vi.mocked(fake.promptClient.run).mockImplementation((command) =>
      command.mode === "xhs_cover_qc"
        ? // Tauri rejects with a structured wire error rather than an Error instance.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          Promise.reject({ kind: "http", message: "HTTP 503 暂时不可用" })
        : normalResponse(command),
    );
    const failed = await runner.run(request);
    expect(failed.phase).toBe("failed");
    expect(failed.error).toContain("HTTP 503");
    expect(failed.error).not.toContain("[object Object]");
    vi.mocked(fake.promptClient.run).mockImplementation(normalResponse);
    const restored = resume({
      ...failed,
      xhsCover: {
        ...failed.xhsCover!,
        inputSignature: JSON.stringify({
          brief: request.node.config.brief,
          options: request.node.config.xhsCover,
        }),
      },
    });
    const result = await runner.run({
      ...restored,
      node: JSON.parse(stableJsonSignature(restored.node)) as KnowledgeVideoWorkflowNodeData,
    });
    expect(result.phase).toBe("done");
    expect(fake.generation.start).toHaveBeenCalledOnce();
    expect(normalizer.normalize).toHaveBeenCalledOnce();
  });

  it.each(["unknown", "interrupted"] as const)(
    "keeps %s task identity instead of creating a second charge",
    async (status) => {
      const { fake, runner, request, resume } = setup();
      vi.mocked(fake.generation.get).mockImplementation(() =>
        Promise.resolve({
          ...completedTask("image-1"),
          summary: { ...completedTask("image-1").summary, status },
          results: [],
        }),
      );
      const unknown = await runner.run(request);
      expect(unknown.xhsCover?.taskId).toBe("image-1");
      expect(unknown.error).toContain("没有可恢复的远程查询接口");
      await runner.run(resume(unknown));
      expect(fake.generation.start).toHaveBeenCalledOnce();
    },
  );

  it.each(["failed", "interrupted", "local_missing", "conflict"] as const)(
    "actually restores a %s local save once on explicit retry, without new image generation",
    async (saveStatus) => {
      const { fake, runner, request, resume, resultRecovery } = setup();
      vi.mocked(fake.generation.get).mockImplementation(() =>
        Promise.resolve({
          ...completedTask("image-1"),
          results: completedTask("image-1").results.map((result) => ({
            ...result,
            saveStatus,
            error: "disk full",
            finalPath: null,
          })),
        }),
      );
      const saveFailed = await runner.run(request);
      expect(saveFailed.error).toContain("disk full");
      expect(saveFailed.xhsCover?.taskId).toBe("image-1");
      expect(resultRecovery.resume).not.toHaveBeenCalled();
      const result = await runner.run(resume(saveFailed));
      expect(result.phase).toBe("done");
      expect(resultRecovery.resume).toHaveBeenCalledExactlyOnceWith("image-1", 0);
      expect(fake.generation.start).toHaveBeenCalledOnce();
    },
  );

  it("stops after one unsuccessful local recovery attempt per retry and preserves the source task", async () => {
    const { fake, runner, request, resume, resultRecovery } = setup();
    const failedResult = {
      ...completedTask("image-1").results[0]!,
      saveStatus: "failed" as const,
      error: "disk still full",
      finalPath: null,
    };
    vi.mocked(fake.generation.get).mockResolvedValue({
      ...completedTask("image-1"),
      results: [failedResult],
    });
    resultRecovery.resume.mockResolvedValue(failedResult);
    const failed = await runner.run(request);
    const retried = await runner.run(resume(failed));
    expect(retried.phase).toBe("failed");
    expect(retried.error).toContain("disk still full");
    expect(retried.xhsCover?.taskId).toBe("image-1");
    expect(resultRecovery.resume).toHaveBeenCalledOnce();
    expect(fake.generation.start).toHaveBeenCalledOnce();
    expect(fake.generation.get).toHaveBeenCalledTimes(2);
  });

  it("allows a new image task only after the previous task is confirmed failed", async () => {
    const { fake, runner, request, resume } = setup();
    vi.mocked(fake.generation.get).mockResolvedValueOnce({
      ...completedTask("image-1"),
      summary: { ...completedTask("image-1").summary, status: "failed" },
      results: [],
      finalError: { message: "图片生成被供应商拒绝" },
    });
    const failed = await runner.run(request);
    expect(failed.error).toContain("图片生成被供应商拒绝");
    expect(failed.xhsCover?.taskId).toBeNull();
    const result = await runner.run(resume(failed));
    expect(result.phase).toBe("done");
    expect(fake.generation.start).toHaveBeenCalledTimes(2);
    expect(result.xhsCover?.taskId).toBe("image-2");
  });

  it("retries local normalization using the already saved source without repeating model work", async () => {
    const { fake, runner, request, resume, normalizer } = setup();
    normalizer.normalize.mockRejectedValueOnce(new Error("输出目录暂时无法写入"));
    const failed = await runner.run(request);
    expect(failed.xhsCover?.imagePath).toBe("C:\\output\\image-1.png");
    const result = await runner.run(resume(failed));
    expect(result.phase).toBe("done");
    expect(fake.generation.start).toHaveBeenCalledOnce();
    expect(normalizer.normalize).toHaveBeenCalledTimes(2);
  });

  it("asks about factual visual ambiguity immediately rather than spending automatic image retries", async () => {
    const { fake, runner, request, normalResponse } = setup();
    vi.mocked(fake.promptClient.run).mockImplementation((command) =>
      command.mode === "xhs_cover_qc"
        ? output({
            result: "NEEDS_DECISION",
            report: "原始截图中有两个版本的标识",
            question: "封面展示哪个版本？",
            recommendation: "使用当前上线版本",
          })
        : normalResponse(command),
    );
    const pending = await runner.run(request);
    expect(pending.phase).toBe("awaiting_approval");
    expect(pending.decision?.question).toBe("封面展示哪个版本？");
    expect(pending.finalPath).toBeNull();
    expect(fake.generation.start).toHaveBeenCalledOnce();
  });

  it("rejects changed input on resume and reuses completed delivery on an unchanged resume", async () => {
    const { fake, runner, request, resume } = setup();
    const done = await runner.run(request);
    const restored = await runner.run(resume(done));
    expect(restored.finalPath).toBe(done.finalPath);
    expect(fake.generation.start).toHaveBeenCalledOnce();
    const changed = resume(done);
    const rejected = await runner.run({
      ...changed,
      node: { ...changed.node, config: { ...changed.node.config, brief: "改做新产品" } },
    });
    expect(rejected.error).toContain("已修改");
    expect(fake.generation.start).toHaveBeenCalledOnce();
  });

  it("does not deliver a near-3:4 or incorrectly normalized image", async () => {
    const { runner, request, normalizer, calls } = setup();
    normalizer.normalize.mockResolvedValue({ path: "C:\\wrong.png", width: 1024, height: 1536 });
    const result = await runner.run(request);
    expect(result.phase).toBe("failed");
    expect(result.error).toContain("严格 1080×1440");
    expect(result.finalPath).toBeNull();
    expect(calls()).toHaveLength(1);
  });
});

describe("cover input and model contracts", () => {
  it("enforces original portrait presence, unique images and the total inline upload limit", () => {
    const options = { ...createXhsCoverOptions(), portraits: [portrait] };
    expect(xhsCoverInputReady("教程", options)).toBe(true);
    expect(xhsCoverInputReady("", { ...options, title: "固定标题" })).toBe(true);
    expect(xhsCoverInputReady("教程", { ...options, materials: [portrait] })).toBe(false);
    expect(
      xhsCoverInputReady("教程", {
        ...options,
        materials: [
          { ...material, byteSize: XHS_COVER_MAX_REFERENCE_BYTES - portrait.byteSize + 1 },
        ],
      }),
    ).toBe(false);
    expect(
      xhsCoverInputReady("教程", {
        ...options,
        materials: [{ ...material, byteSize: XHS_COVER_MAX_REFERENCE_BYTES - portrait.byteSize }],
      }),
    ).toBe(true);
    expect(
      xhsCoverInputReady("教程", { ...options, portraits: [{ ...portrait, kind: "video" }] }),
    ).toBe(false);
  });
  it("rejects invalid style names, missing candidate titles and empty repair instructions", () => {
    expect(() => parseXhsCoverPlan(JSON.stringify({ ...plan, style: "unknown" }))).toThrow("风格");
    expect(() => parseXhsCoverPlan(JSON.stringify({ ...plan, titleCandidates: [] }))).toThrow(
      "三个",
    );
    expect(() =>
      parseXhsCoverReview(JSON.stringify({ result: "REVISE", report: "标题有误" })),
    ).toThrow("repairInstructions");
    expect(() =>
      parseXhsCoverReview(
        JSON.stringify({ result: "NEEDS_DECISION", report: "人物不符", question: "使用哪个人物" }),
      ),
    ).toThrow("recommendation");
  });
});
