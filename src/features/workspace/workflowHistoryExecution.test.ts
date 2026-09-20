import { describe, expect, it, vi } from "vitest";
import type {
  GenerationTaskDetail,
  OptimizeVideoPromptCommand,
  PickedPromptMaterial,
  StartGenerationCommand,
} from "../../lib/backend";
import type {
  SaveWorkflowHistoryCommand,
  WorkflowHistoryDetail,
  WorkflowHistoryRecord,
} from "../../lib/workflowHistory";
import { catalog, completedTask, fakeDependencies, node } from "../../test/videoWorkflowFixtures";
import { createAiFilmWorkflowOptions } from "./aiFilmWorkflowModel";
import { createComicDramaOptions } from "./comicDramaWorkflowModel";
import { createCommerceOptions } from "./commerceWorkflowModel";
import { createRemotionOptions } from "./remotionWorkflowModel";
import { createReverseVideoOptions } from "./reverseVideoWorkflowModel";
import { createXhsCoverOptions } from "./xhsCoverWorkflowModel";
import { createXhsCoverWorkflowRunner } from "./xhsCoverWorkflowRunner";
import { stableJsonSignature } from "../../lib/workflowSignatures";
import { restoreWorkflowVersion } from "./workflowVersionHistory";
import { workflowConnectedTextBlock } from "./workflowMaterials";
import {
  approveWorkflowExecutionPlan,
  createWorkflowDeliveryPlan,
  createWorkflowExecutionPlan,
} from "./workflowExecutionPlan";
import {
  createRecordedWorkflowRunner,
  type RecordedWorkflowDependencies,
  type RecordedWorkflowRunRequest,
} from "./workflowHistoryExecution";
import {
  CANVAS_ID,
  type KnowledgeVideoWorkflowCheckpoint,
  type KnowledgeVideoWorkflowNodeData,
} from "./workspaceModel";

const promptCommand: OptimizeVideoPromptCommand = {
  canvasId: CANVAS_ID,
  sourceNodeId: "workflow-1",
  providerConnectionId: "project-provider",
  modelDefinitionId: "project-text",
  mode: "knowledge_video_director",
  task: "generate",
  userPrompt: "规划主题",
};
const mediaCommand: StartGenerationCommand = {
  canvasId: CANVAS_ID,
  sourceNodeId: "workflow-1",
  operation: "text_to_image",
  providerConnectionId: "project-provider",
  modelDefinitionId: "project-image",
  prompt: [{ kind: "text", text: "画面内容" }],
  generationCount: 1,
};

function setup(canvasId = CANVAS_ID) {
  const fake = fakeDependencies("");
  const records = new Map<string, WorkflowHistoryRecord>();
  let tasks: readonly GenerationTaskDetail[] = [];
  const events: SaveWorkflowHistoryCommand["event"][] = [];
  const historyClient = {
    save: vi.fn(async (command: SaveWorkflowHistoryCommand) => {
      await Promise.resolve();
      const revision = records.get(command.record.id)?.revision ?? 0;
      if (command.record.revision !== revision) throw new Error("revision conflict");
      const saved = { ...command.record, revision: revision + 1 };
      records.set(saved.id, saved);
      if (command.event) events.push(command.event);
      return saved;
    }),
    get: vi.fn((id: string): Promise<WorkflowHistoryDetail> => {
      const record = records.get(id);
      if (!record) return Promise.reject(new Error("missing history"));
      return Promise.resolve({ record, events: [], tasks: tasks.map((task) => task.summary) });
    }),
  };
  vi.mocked(fake.generation.get).mockImplementation((id) =>
    Promise.resolve(tasks.find((task) => task.summary.id === id) ?? completedTask(id)),
  );
  const runnerFactory = vi.fn<RecordedWorkflowDependencies["runnerFactory"]>((_kind, clients) => ({
    async run(request) {
      const planning = {
        ...request.node.config.checkpoint,
        phase: "planning" as const,
        runId: "internal-run",
      };
      request.onCheckpoint(planning);
      request.onProgress({ phase: "planning", progress: 10, message: "规划中", error: null });
      await clients.promptClient.run(promptCommand);
      const generating = { ...planning, phase: "generating" as const, manifest: "保存后的计划" };
      request.onCheckpoint(generating);
      await clients.generationClient.start(mediaCommand);
      const done = { ...generating, phase: "done" as const, finalPath: "C:\\result.png" };
      request.onCheckpoint(done);
      request.onProgress({ phase: "done", progress: 100, message: "已交付", error: null });
      return done;
    },
  }));
  let id = 0;
  const unreviewedRunner = createRecordedWorkflowRunner({
    canvasId,
    historyClient,
    promptClient: fake.promptClient,
    generationClient: fake.generation,
    runnerFactory,
    now: () => 42,
    createId: () => `event-${++id}`,
  });
  // These cases exercise history recovery after a user explicitly reviews the current inputs.
  // Gate rejection itself is tested against unreviewedRunner below.
  const runner = {
    run(input: RecordedWorkflowRunRequest) {
      const executionPlan = approveWorkflowExecutionPlan(
        createWorkflowExecutionPlan(input.node, input.resume ? "resume" : "restart"),
        input.node,
        40,
      );
      return unreviewedRunner.run({
        ...input,
        node: {
          ...input.node,
          config: {
            ...input.node.config,
            executionPlan,
            checkpoint: { ...input.node.config.checkpoint, executionPlan },
          },
        },
      });
    },
  };
  const source = node();
  const request = {
    node: { ...source, config: { ...source.config, historyRunId: "history-1" } },
    providerCatalog: catalog,
    signal: new AbortController().signal,
    onCheckpoint: vi.fn(),
    onProgress: vi.fn(),
  };
  const seed = (
    checkpoint: KnowledgeVideoWorkflowCheckpoint,
    priorTasks: readonly GenerationTaskDetail[] = [],
  ) => {
    tasks = priorTasks;
    records.set("history-1", {
      id: "history-1",
      canvasId,
      sourceNodeId: source.key,
      workflowKind: "knowledge",
      title: "历史测试",
      status: checkpoint.phase,
      progress: 20,
      message: "已暂停",
      error: null,
      nodeSnapshot: { ...request.node, config: { ...request.node.config, checkpoint } },
      models: [],
      attemptCount: 1,
      revision: 4,
      createdAt: 1,
      updatedAt: 2,
    });
    return {
      ...request,
      resume: true,
      node: { ...request.node, config: { ...request.node.config, checkpoint } },
    };
  };
  return {
    fake,
    records,
    events,
    historyClient,
    runnerFactory,
    runner,
    unreviewedRunner,
    request,
    seed,
  };
}

describe("recorded workflow execution", () => {
  it.each([
    ["knowledge", {}],
    ["film", { film: createAiFilmWorkflowOptions() }],
    ["comicDrama", { comicDrama: createComicDramaOptions() }],
    ["commerce", { commerce: createCommerceOptions() }],
    ["remotion", { remotion: createRemotionOptions() }],
    ["xhsCover", { xhsCover: createXhsCoverOptions() }],
    ["reverseVideo", { reverseVideo: createReverseVideoOptions() }],
  ] as const)(
    "requires review before the %s production entry starts any effects",
    async (_kind, config) => {
      const { unreviewedRunner, request, runnerFactory, historyClient, fake } = setup();
      const result = await unreviewedRunner.run({
        ...request,
        node: { ...request.node, config: { ...request.node.config, ...config } },
      });
      expect(result.phase).toBe("awaiting_approval");
      expect(result.executionPlan?.approval).toBeNull();
      expect(runnerFactory).not.toHaveBeenCalled();
      expect(historyClient.save).not.toHaveBeenCalled();
      expect(fake.promptClient.run).not.toHaveBeenCalled();
      expect(fake.generation.start).not.toHaveBeenCalled();
    },
  );

  it("archives generated workflow revisions and returns the same chain to the node", async () => {
    const { runner, request, records } = setup();
    await runner.run(request);
    const config = records.get("history-1")!.nodeSnapshot.config;
    expect(config.versionHistory?.versions.length).toBeGreaterThan(1);
    expect(request.onCheckpoint.mock.lastCall?.[1]).toEqual(config.versionHistory);
    const initial = restoreWorkflowVersion(config, config.versionHistory!.versions[0]!.id);
    expect(initial.checkpoint.manifest).toBe(request.node.config.checkpoint.manifest);
    expect(initial.versionHistory!.versions).toEqual(config.versionHistory!.versions);
    expect(initial.checkpoint.executionPlan?.approval).toBeNull();
  });

  it("archives live execution references while versioning only the editable workflow inputs", async () => {
    const { runner, request, records } = setup();
    const versionConfig = request.node.config;
    const configWithReference = {
      ...versionConfig,
      connectedTexts: [
        { key: "reference", sourceKey: "text-node", displayName: "参考", text: "连线内容" },
      ],
    };
    const expanded = {
      ...configWithReference,
      brief: `${versionConfig.brief}\n\n${workflowConnectedTextBlock(configWithReference)}`,
    };
    await runner.run({ ...request, node: { ...request.node, config: expanded }, versionConfig });
    const saved = records.get("history-1")!.nodeSnapshot.config;
    expect(saved.brief).toContain("连线内容");
    expect(saved.connectedTexts).toEqual(configWithReference.connectedTexts);
    expect(
      saved.versionHistory!.versions.every(
        (version) => version.config.brief === versionConfig.brief,
      ),
    ).toBe(true);
    expect(request.onCheckpoint.mock.lastCall?.[1]).toEqual(saved.versionHistory);
  });

  it("persists the exact approval before the first model call and retains it when runners replace checkpoints", async () => {
    const { runner, request, records, fake } = setup();
    vi.mocked(fake.promptClient.run).mockImplementation(async () => {
      expect(
        records.get("history-1")?.nodeSnapshot.config.checkpoint.executionPlan?.approval
          ?.approvedAt,
      ).toBe(40);
      return Promise.resolve({ optimizedPrompt: "计划", rawModelOutput: "计划" });
    });
    const result = await runner.run(request);
    expect(result.executionPlan?.approval?.approvedAt).toBe(40);
    expect(
      records.get("history-1")?.nodeSnapshot.config.checkpoint.executionPlan?.approval?.approvedAt,
    ).toBe(40);
  });
  it("binds new history and nested model requests to the owning canvas", async () => {
    const canvasId = "canvas-scene-two";
    const { runner, request, fake, records } = setup(canvasId);

    const result = await runner.run(request);

    expect(result.phase).toBe("done");
    expect(records.get("history-1")?.canvasId).toBe(canvasId);
    expect(fake.promptClient.run).toHaveBeenCalledWith({
      ...promptCommand,
      canvasId,
      workflowRunId: "history-1",
    });
    expect(fake.generation.start).toHaveBeenCalledWith({
      ...mediaCommand,
      canvasId,
      workflowRunId: "history-1",
    });
  });

  it("does not skip edited completed deliveries when an older authoring version is restored", async () => {
    const { unreviewedRunner, request, seed, runnerFactory } = setup();
    const resumed = seed({
      ...request.node.config.checkpoint,
      runId: "completed-run",
      phase: "done",
      finalPath: null,
    });
    const executionPlan = approveWorkflowExecutionPlan(
      createWorkflowDeliveryPlan(resumed.node),
      resumed.node,
    );
    runnerFactory.mockImplementation(() => ({
      run(input) {
        expect(input.node.config.checkpoint.phase).toBe("paused");
        return Promise.resolve({ ...input.node.config.checkpoint, phase: "done" });
      },
    }));
    await unreviewedRunner.run({
      ...resumed,
      node: {
        ...resumed.node,
        config: {
          ...resumed.node.config,
          executionPlan,
          checkpoint: { ...resumed.node.config.checkpoint, executionPlan },
        },
      },
    });
    expect(runnerFactory).toHaveBeenCalledTimes(1);
  });

  it("resumes a non-default canvas history and rejects history owned by another canvas", async () => {
    const canvasId = "canvas-scene-two";
    const { runner, request, seed, historyClient, runnerFactory, fake, records } = setup(canvasId);
    const resumed = seed({
      ...request.node.config.checkpoint,
      phase: "paused",
      runId: "internal-run",
    });

    const result = await runner.run(resumed);
    expect(result.phase).toBe("done");
    expect(records.get("history-1")?.attemptCount).toBe(2);

    const archived = { ...records.get("history-1")!, canvasId: "canvas-another-scene" };
    records.set(archived.id, archived);
    historyClient.save.mockClear();
    runnerFactory.mockClear();
    vi.mocked(fake.promptClient.run).mockClear();
    vi.mocked(fake.generation.start).mockClear();

    const rejected = await runner.run(resumed);

    expect(rejected.phase).toBe("failed");
    expect(rejected.error).toContain("历史记录与当前工作流类型或画布不匹配");
    expect(historyClient.save).not.toHaveBeenCalled();
    expect(runnerFactory).not.toHaveBeenCalled();
    expect(fake.promptClient.run).not.toHaveBeenCalled();
    expect(fake.generation.start).not.toHaveBeenCalled();
    expect(records.get(archived.id)).toBe(archived);
  });

  it.each([
    ["knowledge", {}],
    ["film", { film: createAiFilmWorkflowOptions() }],
    ["comicDrama", { comicDrama: createComicDramaOptions() }],
    ["commerce", { commerce: createCommerceOptions() }],
    ["remotion", { remotion: createRemotionOptions() }],
    ["xhsCover", { xhsCover: createXhsCoverOptions() }],
    ["reverseVideo", { reverseVideo: createReverseVideoOptions() }],
  ] as const)(
    "routes %s through the same history identity and tags model requests",
    async (kind, config) => {
      const { runner, request, runnerFactory, fake, records } = setup();
      const result = await runner.run({
        ...request,
        node: { ...request.node, config: { ...request.node.config, ...config } },
      });
      expect(result.phase).toBe("done");
      expect(runnerFactory.mock.calls[0]?.[0]).toBe(kind);
      expect(records.get("history-1")?.workflowKind).toBe(kind);
      expect(fake.promptClient.run).toHaveBeenCalledWith({
        ...promptCommand,
        workflowRunId: "history-1",
      });
      expect(fake.generation.start).toHaveBeenCalledWith({
        ...mediaCommand,
        workflowRunId: "history-1",
      });
    },
  );

  it("does not execute the runner or submit paid calls if the initial history save fails", async () => {
    const { runner, request, historyClient, runnerFactory, fake } = setup();
    historyClient.save.mockRejectedValueOnce(new Error("磁盘已满"));
    const result = await runner.run(request);
    expect(result.phase).toBe("failed");
    expect(result.error).toContain("历史记录保存失败：磁盘已满");
    expect(runnerFactory).not.toHaveBeenCalled();
    expect(fake.promptClient.run).not.toHaveBeenCalled();
  });

  it("can retry an initial save failure only after a typed not_found proves the unused history identity is absent", async () => {
    const { runner, request, historyClient, runnerFactory, records } = setup();
    historyClient.save.mockRejectedValueOnce(new Error("磁盘已满"));
    const failed = await runner.run(request);
    expect(failed.runId).toBeNull();
    // The desktop command rejects with a structured BackendErrorPayload.
    historyClient.get.mockRejectedValueOnce({
      kind: "not_found",
      message: "history does not exist",
    });
    const result = await runner.run({
      ...request,
      resume: true,
      node: { ...request.node, config: { ...request.node.config, checkpoint: failed } },
    });
    expect(result.phase).toBe("done");
    expect(runnerFactory).toHaveBeenCalledOnce();
    expect(records.get("history-1")?.attemptCount).toBe(1);
    expect(historyClient.save.mock.calls[1]?.[0].record.revision).toBe(0);
  });

  it("does not recreate a missing history record after model execution has already started", async () => {
    const { runner, request, historyClient, runnerFactory } = setup();
    historyClient.get.mockRejectedValueOnce({
      kind: "not_found",
      message: "history does not exist",
    });
    const result = await runner.run({
      ...request,
      resume: true,
      node: {
        ...request.node,
        config: {
          ...request.node.config,
          checkpoint: { ...request.node.config.checkpoint, runId: "started-run" },
        },
      },
    });
    expect(result.phase).toBe("failed");
    expect(historyClient.save).not.toHaveBeenCalled();
    expect(runnerFactory).not.toHaveBeenCalled();
  });

  it("awaits all checkpoint snapshots in CAS order before each paid request", async () => {
    const { runner, request, historyClient, fake, records } = setup();
    vi.mocked(fake.promptClient.run).mockImplementation(() => {
      expect(records.get("history-1")?.nodeSnapshot.config.checkpoint.phase).toBe("planning");
      expect(records.get("history-1")?.message).toBe("规划中");
      return Promise.resolve({ optimizedPrompt: "计划", rawModelOutput: "计划" });
    });
    vi.mocked(fake.generation.start).mockImplementation(() => {
      expect(records.get("history-1")?.nodeSnapshot.config.checkpoint.manifest).toBe(
        "保存后的计划",
      );
      return Promise.resolve("image-1");
    });
    await runner.run(request);
    const revisions = historyClient.save.mock.calls.map(([command]) => command.record.revision);
    expect(revisions).toEqual(revisions.map((_, index) => index));
    expect(records.get("history-1")?.nodeSnapshot.config.checkpoint.finalPath).toBe(
      "C:\\result.png",
    );
  });

  it("stops before a later model call if an enqueued checkpoint cannot be persisted", async () => {
    const { runner, request, historyClient, fake } = setup();
    const save = historyClient.save.getMockImplementation()!;
    historyClient.save.mockImplementation((command) =>
      command.record.nodeSnapshot.config.checkpoint.phase === "generating"
        ? Promise.reject(new Error("写入失败"))
        : save(command),
    );
    const result = await runner.run(request);
    expect(result.phase).toBe("failed");
    expect(result.manifest).toBe("保存后的计划");
    expect(result.error).toContain("历史记录保存失败");
    expect(fake.promptClient.run).toHaveBeenCalledOnce();
    expect(fake.generation.start).not.toHaveBeenCalled();
  });

  it("reports a failed final save with the completed delivery checkpoint still available to the canvas", async () => {
    const { runner, request, historyClient } = setup();
    const save = historyClient.save.getMockImplementation()!;
    historyClient.save.mockImplementation((command) =>
      command.record.status === "done" ? Promise.reject(new Error("最终写盘失败")) : save(command),
    );
    const result = await runner.run(request);
    expect(result).toMatchObject({ phase: "failed", finalPath: "C:\\result.png" });
    expect(result.error).toContain("最终写盘失败");
    expect(request.onCheckpoint).toHaveBeenLastCalledWith(
      result,
      expect.objectContaining({ version: 1 }),
    );
  });

  it("resumes the same run with a higher attempt count and the latest revision", async () => {
    const { runner, request, records, seed, historyClient } = setup();
    const resumed = seed({
      ...request.node.config.checkpoint,
      phase: "paused",
      runId: "internal-existing",
    });
    await runner.run(resumed);
    expect(records.size).toBe(1);
    expect(records.get("history-1")?.attemptCount).toBe(2);
    expect(historyClient.save.mock.calls[0]?.[0].record.revision).toBe(4);
    expect(records.get("history-1")?.createdAt).toBe(1);
  });

  it.each([
    ["paused", "removed"],
    ["paused", "replaced"],
    ["done", "removed"],
    ["done", "replaced"],
  ] as const)(
    "rejects %s history with %s references before changing the archived input or executing models",
    async (phase, change) => {
      const { runner, request, records, seed, historyClient, runnerFactory, fake } = setup();
      const original: PickedPromptMaterial = {
        localPath: "C:\\references\\original.png",
        displayName: "original.png",
        kind: "image",
        mimeType: "image/png",
        byteSize: 4096,
      };
      const resumed = seed({
        ...request.node.config.checkpoint,
        phase,
        runId: "original-internal-run",
        manifest: "原始资料生成的计划",
      });
      const prior = records.get("history-1")!;
      const archived: WorkflowHistoryRecord = {
        ...prior,
        nodeSnapshot: {
          ...prior.nodeSnapshot,
          config: { ...prior.nodeSnapshot.config, materials: [original] },
        },
      };
      records.set(archived.id, archived);
      const materials =
        change === "removed" ? [] : [{ ...original, localPath: "C:\\references\\replacement.png" }];

      const result = await runner.run({
        ...resumed,
        node: { ...resumed.node, config: { ...resumed.node.config, materials } },
      });

      expect(result.phase).toBe("failed");
      expect(result.error).toContain("参考素材已修改");
      expect(result.error).toContain("重新制作");
      expect(historyClient.save).not.toHaveBeenCalled();
      expect(runnerFactory).not.toHaveBeenCalled();
      expect(fake.promptClient.run).not.toHaveBeenCalled();
      expect(fake.generation.start).not.toHaveBeenCalled();
      expect(records.get(archived.id)).toBe(archived);
      expect(records.get(archived.id)?.nodeSnapshot.config.materials).toEqual([original]);
      expect(records.get(archived.id)?.revision).toBe(4);
      expect(records.get(archived.id)?.attemptCount).toBe(1);
    },
  );

  it("keeps independent runs on the same node rather than replacing previous records", async () => {
    const { runner, request, records } = setup();
    await runner.run(request);
    await runner.run({
      ...request,
      node: { ...request.node, config: { ...request.node.config, historyRunId: "history-2" } },
    });
    expect([...records.keys()]).toEqual(["history-1", "history-2"]);
    expect(records.get("history-1")?.attemptCount).toBe(1);
    expect(records.get("history-2")?.attemptCount).toBe(1);
  });

  it("preserves a paused task checkpoint and a pause event", async () => {
    const { runner, request, records, events, runnerFactory } = setup();
    runnerFactory.mockImplementation(() => ({
      run(input) {
        const paused = {
          ...input.node.config.checkpoint,
          phase: "paused" as const,
          runId: "internal-run",
          activeCompositionJobId: "composition-pending",
        };
        input.onCheckpoint(paused);
        input.onProgress({
          phase: "paused",
          progress: 70,
          message: "已暂停，继续保留原任务",
          error: null,
        });
        return Promise.resolve(paused);
      },
    }));
    await runner.run(request);
    expect(records.get("history-1")?.nodeSnapshot.config.checkpoint.activeCompositionJobId).toBe(
      "composition-pending",
    );
    expect(events.at(-1)?.phase).toBe("paused");
  });

  it("does not submit a model request if the user pauses while its checkpoint is being saved", async () => {
    const { runner, request, historyClient, fake, records } = setup();
    const controller = new AbortController();
    const save = historyClient.save.getMockImplementation()!;
    historyClient.save.mockImplementation(async (command) => {
      const saved = await save(command);
      if (saved.status === "planning") controller.abort();
      return saved;
    });
    const result = await runner.run({ ...request, signal: controller.signal });
    expect(result.phase).toBe("paused");
    expect(result.error).toBeNull();
    expect(records.get("history-1")?.status).toBe("paused");
    expect(fake.promptClient.run).not.toHaveBeenCalled();
    expect(fake.generation.start).not.toHaveBeenCalled();
  });

  it("creates history for a legacy checkpoint only when explicitly marked newHistory", async () => {
    const { runner, request, historyClient, events, runnerFactory } = setup();
    const existing = {
      ...request.node.config.checkpoint,
      runId: "legacy-run",
      phase: "paused" as const,
      manifest: "原画布计划",
    };
    runnerFactory.mockImplementation(() => ({
      run(input) {
        expect(input.resume).toBe(true);
        expect(input.node.config.checkpoint).toEqual(existing);
        return Promise.resolve(existing);
      },
    }));
    await runner.run({
      ...request,
      resume: true,
      newHistory: true,
      node: { ...request.node, config: { ...request.node.config, checkpoint: existing } },
    });
    expect(historyClient.get).not.toHaveBeenCalled();
    expect(events[0]?.message).toContain("从已有画布断点建立历史记录");
  });

  it("does not silently create a new record if reading an existing history fails", async () => {
    const { runner, request, historyClient, runnerFactory } = setup();
    historyClient.get.mockRejectedValueOnce(new Error("database offline"));
    const result = await runner.run({ ...request, resume: true });
    expect(result.error).toContain("database offline");
    expect(historyClient.save).not.toHaveBeenCalled();
    expect(runnerFactory).not.toHaveBeenCalled();
  });
});

describe("recovering model calls between submission and checkpoint persistence", () => {
  it("keeps a real cover QC request identical across a serde-style restart and reuses its completed orphan response", async () => {
    const { runner, request, runnerFactory, fake, records, historyClient } = setup();
    const rawProse = '请逐字保留 JSON 示例 {"z":1,"a":2}，介绍零基础上手';
    const configuredNode: KnowledgeVideoWorkflowNodeData = {
      ...request.node,
      config: {
        ...request.node.config,
        brief: rawProse,
        xhsCover: {
          ...createXhsCoverOptions(),
          portraits: [
            {
              kind: "image",
              localPath: "C:\\portrait.png",
              displayName: "人像",
              mimeType: "image/png",
              byteSize: 100,
            },
          ],
        },
      },
    };
    const providerCatalog = catalog.map((entry) => ({
      ...entry,
      models: entry.models.map((model) =>
        model.definitionId === "project-image"
          ? { ...model, operations: ["image_to_image" as const] }
          : model,
      ),
    }));
    const normalizer = {
      normalize: vi.fn(() => Promise.resolve({ path: "C:\\cover.png", width: 1080, height: 1440 })),
    };
    const qcPrompts: string[] = [];
    runnerFactory.mockImplementation((_kind, clients) =>
      createXhsCoverWorkflowRunner({
        ...clients,
        promptClient: {
          run(command) {
            if (command.mode === "xhs_cover_qc") qcPrompts.push(command.userPrompt);
            return clients.promptClient.run(command);
          },
        },
        normalizer,
        createId: () => "cover-run",
        now: () => 42,
      }),
    );
    let completedQc: GenerationTaskDetail | null = null;
    vi.mocked(fake.promptClient.run).mockImplementation((command) => {
      if (command.mode === "xhs_cover_plan") {
        const plan = JSON.stringify({
          schemaVersion: "xhs-cover-plan.v1",
          style: "headline",
          title: "零基础上手",
          subtitle: "三步入门",
          titleCandidates: ["零基础上手", "三步入门", "简单教程"],
          rationale: "让标题醒目",
          prompt: "人物位于中间，标题逐字为零基础上手。",
        });
        return Promise.resolve({ optimizedPrompt: plan, rawModelOutput: plan });
      }
      const review = JSON.stringify({ result: "PASS", report: "人物和标题通过" });
      completedQc = {
        ...completedTask("text-qc-orphan"),
        summary: { ...completedTask("text-qc-orphan").summary, operation: "text_generation" },
        results: [],
        logicalRequest: command,
        textOutput: { optimizedPrompt: review, rawModelOutput: review },
      };
      return Promise.reject(new Error("回复已生成，但客户端在保存检查点前断开"));
    });
    vi.mocked(fake.generation.start).mockResolvedValue("image-cover");
    const first = await runner.run({ ...request, node: configuredNode, providerCatalog });
    expect(first.phase).toBe("failed");
    expect(first.xhsCover?.review).toBeNull();
    expect(completedQc).not.toBeNull();
    const stored = JSON.parse(
      stableJsonSignature(records.get("history-1")!),
    ) as WorkflowHistoryRecord;
    historyClient.get.mockResolvedValueOnce({
      record: stored,
      events: [],
      tasks: [completedQc!.summary],
    });
    vi.mocked(fake.generation.get).mockResolvedValueOnce(completedQc!);
    const resumed = await runner.run({
      ...request,
      resume: true,
      node: stored.nodeSnapshot,
      providerCatalog,
    });
    expect(resumed.phase).toBe("done");
    expect(qcPrompts).toHaveLength(2);
    expect(qcPrompts[1]).toBe(qcPrompts[0]);
    expect(qcPrompts[1]).toContain(rawProse);
    expect(fake.promptClient.run).toHaveBeenCalledTimes(2);
    expect(fake.generation.start).toHaveBeenCalledOnce();
    expect(normalizer.normalize).toHaveBeenCalledOnce();
  });

  it("does not normalize JSON literals in arbitrary user prose when matching prior text requests", async () => {
    const { runner, request, seed, runnerFactory, fake } = setup();
    const previousCommand = { ...promptCommand, userPrompt: '必须逐字写出 {"z":1,"a":2}' };
    const prior = {
      ...completedTask("text-literal"),
      summary: { ...completedTask("text-literal").summary, operation: "text_generation" as const },
      results: [],
      logicalRequest: previousCommand,
      textOutput: { optimizedPrompt: "旧结果", rawModelOutput: "旧结果" },
    };
    const resumed = seed(
      { ...request.node.config.checkpoint, phase: "planning", runId: "internal-run" },
      [prior],
    );
    runnerFactory.mockImplementation((_kind, clients) => ({
      async run(input) {
        await clients.promptClient.run({
          ...previousCommand,
          userPrompt: '必须逐字写出 {"a":2,"z":1}',
        });
        return input.node.config.checkpoint;
      },
    }));
    await runner.run(resumed);
    expect(fake.promptClient.run).toHaveBeenCalledOnce();
  });

  it("reuses an orphan media task after restoring the history to a new canvas node key", async () => {
    const { runner, request, seed, runnerFactory, fake, records } = setup();
    const prior = {
      ...completedTask("image-orphan"),
      logicalRequest: { ...mediaCommand, workflowRunId: "history-1" },
    };
    const resumed = seed(
      { ...request.node.config.checkpoint, phase: "generating", runId: "internal-run" },
      [prior],
    );
    runnerFactory.mockImplementation((_kind, clients) => ({
      async run(input) {
        const taskId = await clients.generationClient.start({
          ...mediaCommand,
          sourceNodeId: "restored-copy",
        });
        expect(taskId).toBe("image-orphan");
        return { ...input.node.config.checkpoint, phase: "done" };
      },
    }));
    const result = await runner.run({
      ...resumed,
      node: { ...resumed.node, key: "restored-copy" },
    });
    expect(result.phase).toBe("done");
    expect(fake.generation.start).not.toHaveBeenCalled();
    expect(records.get("history-1")?.sourceNodeId).toBe("restored-copy");
  });

  it("reuses completed text output without calling the provider again", async () => {
    const { runner, request, seed, runnerFactory, fake } = setup();
    const prior = {
      ...completedTask("text-orphan"),
      summary: { ...completedTask("text-orphan").summary, operation: "text_generation" as const },
      results: [],
      logicalRequest: {
        ...promptCommand,
        workflowRunId: "history-1",
        contextHistory: [],
        visionImages: [],
        multimodalInputs: [],
      },
      textOutput: { optimizedPrompt: "已完成的原计划", rawModelOutput: "原始计划" },
    };
    const resumed = seed(
      { ...request.node.config.checkpoint, phase: "planning", runId: "internal-run" },
      [prior],
    );
    runnerFactory.mockImplementation((_kind, clients) => ({
      async run(input) {
        const result = await clients.promptClient.run(promptCommand);
        return { ...input.node.config.checkpoint, phase: "done", manifest: result.optimizedPrompt };
      },
    }));
    const result = await runner.run(resumed);
    expect(result.manifest).toBe("已完成的原计划");
    expect(fake.promptClient.run).not.toHaveBeenCalled();
  });

  it("does not reuse an old failed-QC image that is already represented in checkpoint history", async () => {
    const { runner, request, seed, runnerFactory, fake } = setup();
    const prior = { ...completedTask("image-consumed"), logicalRequest: mediaCommand };
    const resumed = seed(
      {
        ...request.node.config.checkpoint,
        phase: "generating",
        runId: "internal-run",
        coverImagePath: prior.results[0]!.finalPath,
      },
      [prior],
    );
    runnerFactory.mockImplementation((_kind, clients) => ({
      async run(input) {
        await clients.generationClient.start(mediaCommand);
        return input.node.config.checkpoint;
      },
    }));
    await runner.run(resumed);
    expect(fake.generation.start).toHaveBeenCalledOnce();
  });

  it("blocks new paid requests when an unresolved prior task cannot be associated with the current step", async () => {
    const { runner, request, seed, fake } = setup();
    const prior = {
      ...completedTask("image-unknown"),
      summary: { ...completedTask("image-unknown").summary, status: "unknown" as const },
      results: [],
      logicalRequest: { ...mediaCommand, prompt: [{ kind: "text", text: "无法对应的旧步骤" }] },
    };
    const resumed = seed(
      { ...request.node.config.checkpoint, phase: "planning", runId: "internal-run" },
      [prior],
    );
    const result = await runner.run(resumed);
    expect(result.error).toContain("无法与当前步骤唯一对应");
    expect(fake.promptClient.run).not.toHaveBeenCalled();
    expect(fake.generation.start).not.toHaveBeenCalled();
  });

  it("allows retrying a confirmed failed task without treating it as an unknown orphan", async () => {
    const { runner, request, seed, fake } = setup();
    const prior = {
      ...completedTask("image-failed"),
      summary: { ...completedTask("image-failed").summary, status: "failed" as const },
      results: [],
      logicalRequest: mediaCommand,
    };
    await runner.run(
      seed({ ...request.node.config.checkpoint, phase: "failed", runId: "internal-run" }, [prior]),
    );
    expect(fake.generation.start).toHaveBeenCalledOnce();
  });
});
