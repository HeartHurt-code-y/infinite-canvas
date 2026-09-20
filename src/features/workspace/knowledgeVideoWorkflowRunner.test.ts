import { describe, expect, it, vi } from "vitest";
import type { ProviderCatalogEntry } from "../../lib/backend";
import {
  createKnowledgeVideoWorkflowRunner,
  parseKnowledgeVideoPlan,
} from "./knowledgeVideoWorkflowRunner";
import {
  catalog,
  planJson,
  node,
  completedTask,
  fakeDependencies,
} from "../../test/videoWorkflowFixtures";
import { createAiFilmCheckpoint } from "./aiFilmWorkflowModel";
import {
  workflowReferenceFixtures,
  workflowConnectedReferenceFixtures,
} from "../../test/workflowMaterialFixtures";

describe("knowledge video workflow runner", () => {
  it("passes connected-only media to planning and visual checks and rejects a disconnected resume", async () => {
    const fake = fakeDependencies(planJson());
    const runner = createKnowledgeVideoWorkflowRunner({
      promptClient: fake.promptClient,
      generationClient: fake.generation,
      frameClient: fake.frames,
      composerClient: fake.composer,
      sleep: () => Promise.resolve(),
    });
    const source = node();
    const request = {
      node: {
        ...source,
        config: { ...source.config, connectedMaterials: workflowConnectedReferenceFixtures },
      },
      providerCatalog: catalog,
      signal: new AbortController().signal,
      onCheckpoint: vi.fn(),
      onProgress: vi.fn(),
    };
    const result = await runner.run(request);
    expect(result.phase).toBe("done");
    const calls = vi.mocked(fake.promptClient.run).mock.calls.map(([input]) => input);
    expect(calls.some((input) => input.mode === "knowledge_video_director")).toBe(true);
    expect(calls.some((input) => input.mode === "knowledge_video_qc")).toBe(true);
    for (const input of calls)
      expect(input.referenceInputs).toEqual(workflowConnectedReferenceFixtures);
    vi.mocked(fake.promptClient.run).mockClear();
    vi.mocked(fake.generation.start).mockClear();
    const resumed = await runner.run({
      ...request,
      resume: true,
      node: { ...source, config: { ...source.config, checkpoint: { ...result, phase: "paused" } } },
    });
    expect(resumed.error).toContain("参考素材已修改");
    expect(fake.promptClient.run).not.toHaveBeenCalled();
    expect(fake.generation.start).not.toHaveBeenCalled();
  });

  it("reads multimodal references during planning and QC without consuming frame evidence slots", async () => {
    const fake = fakeDependencies(planJson());
    const runner = createKnowledgeVideoWorkflowRunner({
      promptClient: fake.promptClient,
      generationClient: fake.generation,
      frameClient: fake.frames,
      composerClient: fake.composer,
      sleep: () => Promise.resolve(),
    });
    const source = node();
    const materials = [
      ...workflowReferenceFixtures,
      ...workflowReferenceFixtures.map((material) => ({
        ...material,
        localPath: material.localPath.replace("reference", "other-reference"),
      })),
    ];
    const expectedInputs = materials.map(({ localPath, displayName, kind, mimeType }) => ({
      localPath,
      displayName,
      kind,
      mimeType,
    }));
    const materialsNode = {
      ...source,
      config: { ...source.config, materials },
    };
    const request = {
      node: materialsNode,
      providerCatalog: catalog,
      signal: new AbortController().signal,
      onCheckpoint: vi.fn(),
      onProgress: vi.fn(),
    };
    const result = await runner.run(request);
    expect(result.phase).toBe("done");
    const calls = vi.mocked(fake.promptClient.run).mock.calls.map(([input]) => input);
    for (const input of calls) expect(input.multimodalInputs).toEqual(expectedInputs);
    const checks = calls.filter((input) => input.mode === "knowledge_video_qc");
    expect(checks).toHaveLength(6);
    expect(checks.every((input) => input.visionImages?.length === 5)).toBe(true);
    vi.mocked(fake.promptClient.run).mockClear();
    vi.mocked(fake.generation.start).mockClear();
    const unchanged = await runner.run({
      ...request,
      resume: true,
      node: {
        ...materialsNode,
        config: { ...materialsNode.config, checkpoint: { ...result, phase: "paused" } },
      },
    });
    expect(unchanged.phase).toBe("done");
    expect(unchanged.finalPath).toBe(result.finalPath);
    expect(fake.promptClient.run).not.toHaveBeenCalled();
    expect(fake.generation.start).not.toHaveBeenCalled();
    const resumed = await runner.run({
      ...request,
      resume: true,
      node: {
        ...materialsNode,
        config: {
          ...materialsNode.config,
          materials: [],
          checkpoint: { ...result, phase: "paused" },
        },
      },
    });
    expect(resumed.error).toContain("参考素材已修改");
    expect(fake.promptClient.run).not.toHaveBeenCalled();
    expect(fake.generation.start).not.toHaveBeenCalled();
  });

  it("preserves structured backend planning errors in the checkpoint and progress", async () => {
    const fake = fakeDependencies(planJson());
    const backendError = {
      kind: "protocol",
      message: "protocol error: prompt model chat completion failed",
      details: {
        httpStatus: 401,
        profile: "gemini_generate_content_v1",
        path: "/v1/models/project-text:generateContent",
        rawResponse: JSON.stringify({
          error: {
            type: "moyu_api_error",
            message:
              "该令牌额度已用尽 TokenStatusExhausted[test-token-secret] (request id: request-test)",
          },
        }),
      },
    };
    vi.mocked(fake.promptClient.run).mockRejectedValueOnce(backendError);
    const onCheckpoint = vi.fn();
    const onProgress = vi.fn();
    const runner = createKnowledgeVideoWorkflowRunner({
      promptClient: fake.promptClient,
      generationClient: fake.generation,
      frameClient: fake.frames,
      composerClient: fake.composer,
      sleep: () => Promise.resolve(),
    });

    const result = await runner.run({
      node: node(),
      providerCatalog: catalog,
      signal: new AbortController().signal,
      onCheckpoint,
      onProgress,
    });

    expect(result.phase).toBe("failed");
    expect(result.lastActivePhase).toBe("planning");
    expect(result.error).not.toContain("[object Object]");
    expect(result.error).toContain(backendError.message);
    expect(result.error).toContain("401");
    expect(result.error).toContain("该令牌额度已用尽");
    expect(result.error).not.toContain("test-token-secret");
    expect(onCheckpoint).toHaveBeenLastCalledWith(result);
    expect(onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: "failed", progress: 8, error: result.error }),
    );
    expect(fake.generation.start).not.toHaveBeenCalled();
  });

  it("parses a fenced six-section plan into a stable execution manifest", () => {
    const plan = parseKnowledgeVideoPlan(`说明\n\`\`\`json\n${planJson()}\n\`\`\``);
    expect(plan.shots.map((shot) => shot.section)).toEqual([
      "HOOK",
      "CONCEPT",
      "VISUAL",
      "EXAMPLE",
      "PITFALL",
      "RECAP",
    ]);
    expect(plan.script).toContain("RAG 入门 · 讲述脚本");
    expect(plan.storyboard).toContain("STYLE-A");
    expect(plan.aspectRatio).toBe("16:9");
    expect(plan.shots[0]?.videoPrompt).toContain("【旁白台词（逐字使用）】HOOK 旁白");
  });

  it("runs planning, project media generation, frame QC, and composition automatically", async () => {
    const fake = fakeDependencies(planJson());
    const checkpoints: string[] = [];
    const runner = createKnowledgeVideoWorkflowRunner({
      promptClient: fake.promptClient,
      generationClient: fake.generation,
      frameClient: fake.frames,
      composerClient: fake.composer,
      now: () => 42,
      createId: () => "run-1",
      sleep: () => Promise.resolve(),
    });

    const result = await runner.run({
      node: node(),
      providerCatalog: catalog,
      signal: new AbortController().signal,
      onCheckpoint: (checkpoint) => checkpoints.push(checkpoint.phase),
      onProgress: vi.fn(),
    });

    expect(result.phase).toBe("done");
    expect(result.finalPath).toBe("C:\\output\\知识教学视频-完整交付.mp4");
    expect(fake.generation.start).toHaveBeenCalledTimes(7);
    expect(fake.frames.startExtraction).toHaveBeenCalledTimes(6);
    expect(fake.composer.startComposition).toHaveBeenCalledTimes(1);
    const promptCalls = vi.mocked(fake.promptClient.run).mock.calls.map(([command]) => command);
    expect(promptCalls.some((command) => command.mode === "knowledge_video_qc")).toBe(true);
    const videoCommand = vi
      .mocked(fake.generation.start)
      .mock.calls.map(([command]) => command)
      .find((command) => command.operation === "video_generation");
    expect(videoCommand?.parameters?.["duration"]).toBe(5);
    expect(videoCommand?.parameters?.["aspect_ratio"]).toBe("16:9");
    expect(checkpoints).toContain("qc");
    expect(checkpoints.at(-1)).toBe("done");
  });

  it.each(["ratio", "aspect_ratio"] as const)(
    "maps a vertical manifest into image size and video %s parameters",
    async (aspectParameterKey) => {
      const verticalCatalog: readonly ProviderCatalogEntry[] = catalog.map((entry) => ({
        ...entry,
        models: entry.models.map((model) =>
          model.definitionId === "project-video"
            ? {
                ...model,
                operationSchema: {
                  video_generation: {
                    parameters: {
                      [aspectParameterKey]: {
                        type: "string",
                        default: "16:9",
                        enum: ["16:9", "9:16"],
                      },
                      duration: { type: "integer", default: 5, enum: [4, 5, 6] },
                    },
                  },
                },
              }
            : model,
        ),
      }));
      const fake = fakeDependencies(planJson(null, "9:16"));
      const runner = createKnowledgeVideoWorkflowRunner({
        promptClient: fake.promptClient,
        generationClient: fake.generation,
        frameClient: fake.frames,
        composerClient: fake.composer,
        now: () => 42,
        createId: () => `run-vertical-${aspectParameterKey}`,
        sleep: () => Promise.resolve(),
      });

      const result = await runner.run({
        node: node(),
        providerCatalog: verticalCatalog,
        signal: new AbortController().signal,
        onCheckpoint: vi.fn(),
        onProgress: vi.fn(),
      });

      expect(result.phase).toBe("done");
      const commands = vi.mocked(fake.generation.start).mock.calls.map(([command]) => command);
      const imageCommand = commands.find((command) => command.operation === "text_to_image");
      const videoCommands = commands.filter((command) => command.operation === "video_generation");
      expect(imageCommand?.parameters?.["size"]).toBe("1024x1792");
      expect(videoCommands).toHaveLength(6);
      for (const command of videoCommands) {
        expect(command.parameters?.[aspectParameterKey]).toBe("9:16");
        const prompt = command.prompt.find((segment) => segment.kind === "text");
        expect(prompt?.kind).toBe("text");
        if (prompt?.kind !== "text") throw new Error("视频任务缺少文本提示词");
        expect(prompt.text).toContain("【目标画幅】9:16\n【旁白台词（逐字使用）】");
      }
    },
  );

  it("retains the customer decision through a failed replan before any paid generation", async () => {
    const fake = fakeDependencies([
      planJson({
        id: "decision-01",
        reason: "受众会改变术语深度",
        question: "受众必须是哪一类？",
        recommendedOptionId: "option-01",
        options: [
          { id: "option-01", label: "一线员工", description: "减少术语并增加现场示例" },
          { id: "option-02", label: "管理者", description: "强调管理价值" },
        ],
      }),
      "invalid manifest",
      "invalid manifest",
      planJson(),
    ]);
    const runner = createKnowledgeVideoWorkflowRunner({
      promptClient: fake.promptClient,
      generationClient: fake.generation,
      frameClient: fake.frames,
      composerClient: fake.composer,
      now: () => 42,
      createId: () => "run-1",
      sleep: () => Promise.resolve(),
    });
    const source = node();
    const first = await runner.run({
      node: source,
      providerCatalog: catalog,
      signal: new AbortController().signal,
      onCheckpoint: vi.fn(),
      onProgress: vi.fn(),
    });

    expect(first.phase).toBe("awaiting_approval");
    expect(first.decision?.recommendation).toBe("一线员工：减少术语并增加现场示例");
    expect(fake.generation.start).not.toHaveBeenCalled();

    const failedReplan = await runner.run({
      node: { ...source, config: { ...source.config, checkpoint: first } },
      providerCatalog: catalog,
      resume: true,
      decisionResolution: "管理者：强调管理价值",
      signal: new AbortController().signal,
      onCheckpoint: vi.fn(),
      onProgress: vi.fn(),
    });
    expect(failedReplan.phase).toBe("failed");
    expect(failedReplan.decision?.recommendation).toBe("管理者：强调管理价值");
    expect(fake.generation.start).not.toHaveBeenCalled();
    const resumed = await runner.run({
      node: { ...source, config: { ...source.config, checkpoint: failedReplan } },
      providerCatalog: catalog,
      resume: true,
      signal: new AbortController().signal,
      onCheckpoint: vi.fn(),
      onProgress: vi.fn(),
    });
    expect(resumed.phase).toBe("done");
    expect(fake.generation.start).toHaveBeenCalledTimes(7);
    const planningCalls = vi.mocked(fake.promptClient.run).mock.calls.map(([command]) => command);
    expect(
      planningCalls.some(
        (command) =>
          command.mode === "knowledge_video_director" &&
          command.userPrompt.includes("用户已经确认：管理者：强调管理价值"),
      ),
    ).toBe(true);
  });

  it("submits a fresh task for terminal failures and allows a manual retry after the limit", async () => {
    const fake = fakeDependencies(planJson());
    let allowVideos = false;
    vi.mocked(fake.generation.get).mockImplementation((taskId) => {
      const task = completedTask(taskId);
      return Promise.resolve(
        !allowVideos && taskId.startsWith("video")
          ? { ...task, summary: { ...task.summary, status: "failed" }, results: [] }
          : task,
      );
    });
    const source = node();
    const sourceNode = { ...source, config: { ...source.config, maxAutomaticRetries: 1 } };
    const runner = createKnowledgeVideoWorkflowRunner({
      promptClient: fake.promptClient,
      generationClient: fake.generation,
      frameClient: fake.frames,
      composerClient: fake.composer,
      sleep: () => Promise.resolve(),
    });
    const request = {
      node: sourceNode,
      providerCatalog: catalog,
      signal: new AbortController().signal,
      onCheckpoint: vi.fn(),
      onProgress: vi.fn(),
    };
    const failed = await runner.run(request);
    expect(failed.phase).toBe("failed");
    expect(failed.shotRuns["shot-01"]?.videoTaskId).toBeNull();
    expect(fake.generation.start).toHaveBeenCalledTimes(3);
    expect(fake.generation.get).toHaveBeenCalledWith("video-2");
    allowVideos = true;
    const resumed = await runner.run({
      ...request,
      resume: true,
      node: { ...sourceNode, config: { ...sourceNode.config, checkpoint: failed } },
    });
    expect(resumed.phase).toBe("done");
    expect(fake.generation.start).toHaveBeenCalledTimes(9);
    expect(resumed.coverImagePath).toBe(failed.coverImagePath);
  });

  it.each(["query_error", "unknown", "interrupted", "save_failed"] as const)(
    "retains the submitted video task on %s and resumes it without another charge",
    async (failure) => {
      const fake = fakeDependencies(planJson());
      let recovered = false;
      vi.mocked(fake.generation.get).mockImplementation((taskId) => {
        const detail = completedTask(taskId);
        if (recovered || !taskId.startsWith("video")) return Promise.resolve(detail);
        if (failure === "query_error") return Promise.reject(new Error("HTTP 503 查询暂时失败"));
        if (failure === "save_failed")
          return Promise.resolve({
            ...detail,
            summary: { ...detail.summary, status: "failed" },
            results: detail.results.map((result) => ({
              ...result,
              saveStatus: "failed",
              finalPath: null,
              error: "disk full",
            })),
          });
        return Promise.resolve({
          ...detail,
          summary: { ...detail.summary, status: failure },
          results: [],
        });
      });
      const source = node();
      const runner = createKnowledgeVideoWorkflowRunner({
        promptClient: fake.promptClient,
        generationClient: fake.generation,
        frameClient: fake.frames,
        composerClient: fake.composer,
        sleep: () => Promise.resolve(),
      });
      const request = {
        node: { ...source, config: { ...source.config, maxAutomaticRetries: 2 } },
        providerCatalog: catalog,
        signal: new AbortController().signal,
        onCheckpoint: vi.fn(),
        onProgress: vi.fn(),
      };
      const failed = await runner.run(request);
      expect(failed.phase).toBe("failed");
      expect(failed.shotRuns["shot-01"]?.videoTaskId).toBe("video-1");
      expect(fake.generation.start).toHaveBeenCalledTimes(2);
      const stillFailed = await runner.run({
        ...request,
        resume: true,
        node: { ...request.node, config: { ...request.node.config, checkpoint: failed } },
      });
      expect(stillFailed.shotRuns["shot-01"]?.videoTaskId).toBe("video-1");
      expect(fake.generation.start).toHaveBeenCalledTimes(2);
      if (failure === "save_failed") expect(stillFailed.error).toContain("任务详情");
      recovered = true;
      const completed = await runner.run({
        ...request,
        resume: true,
        node: { ...request.node, config: { ...request.node.config, checkpoint: stillFailed } },
      });
      expect(completed.phase).toBe("done");
      expect(completed.shotRuns["shot-01"]?.videoTaskId).toBe("video-1");
      expect(fake.generation.start).toHaveBeenCalledTimes(7);
      expect(fake.generation.get).toHaveBeenCalledWith("video-1");
    },
  );

  it.each(["query_error", "unknown", "interrupted", "save_failed"] as const)(
    "retains the submitted cover on %s until its original result can be read",
    async (failure) => {
      const fake = fakeDependencies(planJson());
      let recovered = false;
      vi.mocked(fake.generation.get).mockImplementation((taskId) => {
        const detail = completedTask(taskId);
        if (recovered || !taskId.startsWith("image")) return Promise.resolve(detail);
        if (failure === "query_error") return Promise.reject(new Error("读取任务连接中断"));
        if (failure === "save_failed")
          return Promise.resolve({
            ...detail,
            results: detail.results.map((result) => ({
              ...result,
              saveStatus: "failed",
              finalPath: null,
              error: "disk full",
            })),
          });
        return Promise.resolve({
          ...detail,
          summary: { ...detail.summary, status: failure },
          results: [],
        });
      });
      const source = node();
      const runner = createKnowledgeVideoWorkflowRunner({
        promptClient: fake.promptClient,
        generationClient: fake.generation,
        frameClient: fake.frames,
        composerClient: fake.composer,
        sleep: () => Promise.resolve(),
      });
      const request = {
        node: source,
        providerCatalog: catalog,
        signal: new AbortController().signal,
        onCheckpoint: vi.fn(),
        onProgress: vi.fn(),
      };
      const failed = await runner.run(request);
      expect(failed.phase).toBe("failed");
      expect(failed.shotRuns["shot-01"]?.imageTaskId).toBe("image-cover");
      expect(fake.generation.start).toHaveBeenCalledOnce();
      recovered = true;
      const completed = await runner.run({
        ...request,
        resume: true,
        node: { ...source, config: { ...source.config, checkpoint: failed } },
      });
      expect(completed.phase).toBe("done");
      expect(fake.generation.start).toHaveBeenCalledTimes(7);
    },
  );

  it.each(["query_error", "unknown", "interrupted", "save_failed"] as const)(
    "preserves the shared film asset task on %s before a resumed workflow continues",
    async (failure) => {
      const fake = fakeDependencies(planJson());
      const runner = createKnowledgeVideoWorkflowRunner({
        promptClient: fake.promptClient,
        generationClient: fake.generation,
        frameClient: fake.frames,
        composerClient: fake.composer,
        sleep: () => Promise.resolve(),
      });
      const source = node();
      const request = {
        node: source,
        providerCatalog: catalog,
        signal: new AbortController().signal,
        onCheckpoint: vi.fn(),
        onProgress: vi.fn(),
      };
      const previous = await runner.run(request);
      vi.mocked(fake.generation.start).mockClear().mockResolvedValue("image-asset");
      let recovered = false;
      vi.mocked(fake.generation.get).mockImplementation((taskId) => {
        const detail = completedTask(taskId);
        if (recovered || taskId !== "image-asset") return Promise.resolve(detail);
        if (failure === "query_error") return Promise.reject(new Error("读取资产结果连接中断"));
        if (failure === "save_failed")
          return Promise.resolve({
            ...detail,
            results: detail.results.map((result) => ({
              ...result,
              saveStatus: "failed",
              finalPath: null,
              error: "disk full",
            })),
          });
        return Promise.resolve({
          ...detail,
          summary: { ...detail.summary, status: failure },
          results: [],
        });
      });
      const checkpoint = {
        ...previous,
        phase: "failed" as const,
        film: {
          ...createAiFilmCheckpoint(),
          planningComplete: true,
          assets: [
            { id: "actor", kind: "character" as const, name: "主角", prompt: "真实角色参考" },
          ],
        },
      };
      const failed = await runner.run({
        ...request,
        resume: true,
        node: { ...source, config: { ...source.config, checkpoint } },
      });
      expect(failed.phase).toBe("failed");
      expect(failed.film?.assets[0]?.taskId).toBe("image-asset");
      expect(fake.generation.start).toHaveBeenCalledOnce();
      recovered = true;
      const completed = await runner.run({
        ...request,
        resume: true,
        node: { ...source, config: { ...source.config, checkpoint: failed } },
      });
      expect(completed.phase).toBe("done");
      expect(completed.film?.assets[0]?.path).toBe("C:\\output\\image-asset.png");
      expect(fake.generation.start).toHaveBeenCalledOnce();
    },
  );

  it("keeps delivery incomplete when the required cover fails after automatic retries", async () => {
    const fake = fakeDependencies(planJson());
    vi.mocked(fake.generation.get).mockImplementation((taskId) => {
      const task = completedTask(taskId);
      return Promise.resolve({
        ...task,
        summary: { ...task.summary, status: "failed" },
        results: [],
      });
    });
    const source = node();
    const runner = createKnowledgeVideoWorkflowRunner({
      promptClient: fake.promptClient,
      generationClient: fake.generation,
      frameClient: fake.frames,
      composerClient: fake.composer,
      sleep: () => Promise.resolve(),
    });
    const result = await runner.run({
      node: { ...source, config: { ...source.config, maxAutomaticRetries: 1 } },
      providerCatalog: catalog,
      signal: new AbortController().signal,
      onCheckpoint: vi.fn(),
      onProgress: vi.fn(),
    });
    expect(result.phase).toBe("failed");
    expect(result.error).toContain("封面生成失败");
    expect(result.shotRuns["shot-01"]?.imageTaskId).toBeNull();
    expect(fake.generation.start).toHaveBeenCalledTimes(2);
    expect(fake.composer.startComposition).not.toHaveBeenCalled();
  });

  it("automatically regenerates a failed shot from the QC repair prompt", async () => {
    const fake = fakeDependencies(planJson(), [
      JSON.stringify({
        result: "RETRY",
        report: "主体在尾帧消失",
        repairPrompt: "主体保持在画面中心，并以稳定完整姿态收束",
      }),
      JSON.stringify({ result: "PASS", report: "返工后五点一致" }),
    ]);
    const runner = createKnowledgeVideoWorkflowRunner({
      promptClient: fake.promptClient,
      generationClient: fake.generation,
      frameClient: fake.frames,
      composerClient: fake.composer,
      now: () => 42,
      createId: () => "run-qc-retry",
      sleep: () => Promise.resolve(),
    });

    const result = await runner.run({
      node: node(),
      providerCatalog: catalog,
      signal: new AbortController().signal,
      onCheckpoint: vi.fn(),
      onProgress: vi.fn(),
    });

    expect(result.phase).toBe("done");
    expect(fake.generation.start).toHaveBeenCalledTimes(8);
    const submittedPrompts = vi
      .mocked(fake.generation.start)
      .mock.calls.flatMap(([command]) =>
        command.prompt.flatMap((segment) => (segment.kind === "text" ? [segment.text] : [])),
      );
    expect(
      submittedPrompts.some((prompt) =>
        prompt.includes("主体保持在画面中心，并以稳定完整姿态收束"),
      ),
    ).toBe(true);
    expect(fake.frames.startExtraction).toHaveBeenCalledTimes(7);
  });

  it("stops paid QC regeneration at the configured limit and preserves the clip for explicit adoption", async () => {
    const retry = JSON.stringify({
      result: "RETRY",
      report: "人物尾帧仍有偏差",
      repairPrompt: "保持人物完整可见",
    });
    const fake = fakeDependencies(planJson(), [retry, retry]);
    const source = node();
    const sourceNode = { ...source, config: { ...source.config, maxAutomaticRetries: 1 } };
    const runner = createKnowledgeVideoWorkflowRunner({
      promptClient: fake.promptClient,
      generationClient: fake.generation,
      frameClient: fake.frames,
      composerClient: fake.composer,
      sleep: () => Promise.resolve(),
    });
    const request = {
      node: sourceNode,
      providerCatalog: catalog,
      signal: new AbortController().signal,
      onCheckpoint: vi.fn(),
      onProgress: vi.fn(),
    };
    const paused = await runner.run(request);
    expect(paused.phase).toBe("awaiting_approval");
    expect(paused.decision?.kind).toBe("qc");
    expect(paused.decision?.question).toContain("1 次自动返工上限");
    expect(paused.shotRuns["shot-01"]?.retryCount).toBe(1);
    expect(paused.shotRuns["shot-01"]?.videoTaskId).toBe("video-7");
    expect(paused.shotRuns["shot-01"]?.clipPath).toBe("C:\\output\\video-7.mp4");
    expect(fake.generation.start).toHaveBeenCalledTimes(8);
    expect(fake.composer.startComposition).not.toHaveBeenCalled();
    const adopted = await runner.run({
      ...request,
      resume: true,
      node: { ...sourceNode, config: { ...sourceNode.config, checkpoint: paused } },
    });
    expect(adopted.phase).toBe("done");
    expect(fake.generation.start).toHaveBeenCalledTimes(8);
    expect(adopted.shotRuns["shot-01"]?.clipPath).toBe(paused.shotRuns["shot-01"]?.clipPath);
  });

  it("pauses for confirmation when visual QC infrastructure cannot produce five frames", async () => {
    const fake = fakeDependencies(planJson());
    vi.mocked(fake.frames.getJob).mockResolvedValue({
      jobId: "frames-incomplete",
      videoPath: "C:\\output\\clip.mp4",
      status: "completed",
      progress: 100,
      frames: [],
      error: null,
      createdAt: 1,
      updatedAt: 2,
    });
    const runner = createKnowledgeVideoWorkflowRunner({
      promptClient: fake.promptClient,
      generationClient: fake.generation,
      frameClient: fake.frames,
      composerClient: fake.composer,
      now: () => 42,
      createId: () => "run-qc-blocked",
      sleep: () => Promise.resolve(),
    });

    const result = await runner.run({
      node: node(),
      providerCatalog: catalog,
      signal: new AbortController().signal,
      onCheckpoint: vi.fn(),
      onProgress: vi.fn(),
    });

    expect(result.phase).toBe("awaiting_approval");
    expect(result.decision).toMatchObject({ kind: "qc" });
    expect(fake.composer.startComposition).not.toHaveBeenCalled();
  });

  it("resumes a single re-done shot while keeping every other clip untouched", async () => {
    const fake = fakeDependencies(planJson());
    const runner = createKnowledgeVideoWorkflowRunner({
      promptClient: fake.promptClient,
      generationClient: fake.generation,
      frameClient: fake.frames,
      composerClient: fake.composer,
      now: () => 42,
      createId: () => "run-shot-redo",
      sleep: () => Promise.resolve(),
    });
    const source = node();
    const request = {
      node: source,
      providerCatalog: catalog,
      signal: new AbortController().signal,
      onCheckpoint: vi.fn(),
      onProgress: vi.fn(),
    };
    const done = await runner.run(request);
    expect(done.phase).toBe("done");
    expect(done.shotRuns["shot-02"]?.clipPath).toBeTruthy();

    // 模拟用户重做镜头 02：清空生成结果与任务身份，保留旧任务 ID 防历史复用。
    const redoRun = done.shotRuns["shot-02"]!;
    const redoCheckpoint = {
      ...done,
      phase: "paused" as const,
      shotRuns: {
        ...done.shotRuns,
        "shot-02": {
          ...redoRun,
          redoRequested: true,
          videoTaskId: null,
          clipPath: null,
          qcStatus: "pending" as const,
          retryCount: 0,
          repairPrompt: null,
          supersededTaskIds: [...(redoRun.supersededTaskIds ?? []), redoRun.videoTaskId!],
        },
      },
    };

    vi.mocked(fake.generation.start).mockClear();
    vi.mocked(fake.composer.startComposition).mockClear();

    const resumed = await runner.run({
      ...request,
      resume: true,
      node: { ...source, config: { ...source.config, checkpoint: redoCheckpoint } },
    });

    expect(resumed.phase).toBe("done");
    expect(resumed.shotRuns["shot-02"]?.redoRequested).toBe(false);
    expect(resumed.shotRuns["shot-02"]?.clipPath).not.toBeNull();
    // 只重新生成被重做的镜头，其余镜头复用原片段。
    const videoStarts = vi
      .mocked(fake.generation.start)
      .mock.calls.filter(([command]) => command.operation === "video_generation");
    expect(videoStarts).toHaveLength(1);
    const prompts = videoStarts.flatMap(([command]) =>
      command.prompt.flatMap((segment) => (segment.kind === "text" ? [segment.text] : [])),
    );
    expect(prompts[0]).toContain("CONCEPT 视频提示词");
    expect(resumed.shotRuns["shot-01"]?.clipPath).toBe(done.shotRuns["shot-01"]?.clipPath);
    expect(resumed.shotRuns["shot-03"]?.clipPath).toBe(done.shotRuns["shot-03"]?.clipPath);
    // 重做镜头通过质检后仍会重新执行合成。
    expect(fake.composer.startComposition).toHaveBeenCalledTimes(1);
  });
});
