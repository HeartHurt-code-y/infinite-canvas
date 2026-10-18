import { describe, expect, it, vi } from "vitest";
import {
  catalog,
  completedTask,
  fakeDependencies,
  node,
  planJson,
} from "../../test/videoWorkflowFixtures";
import {
  approveWorkflowExecutionPlan,
  createWorkflowDeliveryPlan,
  createWorkflowExecutionPlan,
  executeWorkflowSteps,
  getWorkflowExecutionPlan,
  isWorkflowExecutionPlanApproved,
  isWorkflowExecutionPlanCurrent,
  topologicallySortWorkflowSteps,
} from "./workflowExecutionPlan";
import {
  createKnowledgeVideoWorkflowRunner,
  parseKnowledgeVideoPlan,
} from "./knowledgeVideoWorkflowRunner";
import { createRecordedWorkflowRunner } from "./workflowHistoryExecution";
import type { KnowledgeVideoWorkflowNodeData } from "./workspaceModel";
import { createComicDramaOptions } from "./comicDramaWorkflowModel";
import { createJewelrySceneOptions, createProductSceneOptions } from "./productSceneWorkflowModel";
import { createReelbenchOptions } from "./reelbenchWorkflowModel";
import { stableJsonSignature } from "../../lib/workflowSignatures";

function approve(source: KnowledgeVideoWorkflowNodeData): KnowledgeVideoWorkflowNodeData {
  const plan = getWorkflowExecutionPlan(source) ?? createWorkflowExecutionPlan(source);
  const executionPlan = approveWorkflowExecutionPlan(plan, source, 42);
  return {
    ...source,
    config: {
      ...source.config,
      executionPlan,
      checkpoint: { ...source.config.checkpoint, executionPlan },
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("incremental DAG scheduling", () => {
  const step = (id: string, dependsOn: string[] = []) => ({ id, title: id, dependsOn });

  it("releases a fast branch before an unrelated slow branch finishes, within the concurrency limit", async () => {
    const slow = deferred<void>();
    const fast = deferred<void>();
    const childStarted = deferred<void>();
    const calls: string[] = [];
    const running = executeWorkflowSteps(
      [step("slow"), step("fast"), step("child", ["fast"]), step("join", ["slow", "child"])],
      async ({ id }) => {
        calls.push(id);
        if (id === "slow") await slow.promise;
        if (id === "fast") await fast.promise;
        if (id === "child") childStarted.resolve();
      },
      { concurrency: 2 },
    );
    expect(calls).toEqual(["slow", "fast"]);
    fast.resolve();
    await childStarted.promise;
    expect(calls).toEqual(["slow", "fast", "child"]);
    slow.resolve();
    expect(await running).toBe(true);
    expect(calls).toEqual(["slow", "fast", "child", "join"]);
  });

  it.each(["pause", "failure"])(
    "stops dispatch after %s and drains already active work",
    async (mode) => {
      const first = deferred<void | false>();
      const active = deferred<void>();
      const calls: string[] = [];
      let settled = false;
      const outcome = executeWorkflowSteps(
        [step("first"), step("active"), step("queued"), step("child", ["active"])],
        async ({ id }) => {
          calls.push(id);
          if (id === "first") {
            const result = await first.promise;
            if (mode === "failure") throw new Error("original failure");
            return result;
          }
          await active.promise;
        },
        { concurrency: 2 },
      ).then(
        (value) => {
          settled = true;
          return value;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      first.resolve(false);
      await first.promise;
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(calls).toEqual(["first", "active"]);
      active.resolve();
      if (mode === "pause") expect(await outcome).toBe(false);
      else expect(await outcome).toEqual(new Error("original failure"));
      expect(calls).toEqual(["first", "active"]);
    },
  );

  it("aborts queued steps and waits for active calls to settle", async () => {
    const active = deferred<void>();
    const controller = new AbortController();
    const execute = vi.fn(() => active.promise);
    let settled = false;
    const outcome = executeWorkflowSteps([step("active"), step("queued")], execute, {
      signal: controller.signal,
    }).catch((error: unknown) => {
      settled = true;
      return error;
    });
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    active.resolve();
    expect(await outcome).toMatchObject({ name: "AbortError" });
    expect(execute).toHaveBeenCalledTimes(1);
    await expect(
      executeWorkflowSteps([step("never")], execute, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("processes long dependency chains with linear dependency reads", async () => {
    let reads = 0;
    const steps = Array.from({ length: 2000 }, (_, index) => ({
      id: String(index),
      title: String(index),
      get dependsOn() {
        reads += 1;
        return index === 0 ? [] : [String(index - 1)];
      },
    }));
    const execute = vi.fn(() => Promise.resolve());
    expect(await executeWorkflowSteps(steps, execute)).toBe(true);
    expect(execute).toHaveBeenCalledTimes(2000);
    expect(reads).toBeLessThanOrEqual(steps.length * 8);
  });
});

describe("workflow dependency plans and human review", () => {
  it("binds video shot analysis approval to its source and export choice", () => {
    const original = node();
    const source = approve({
      ...original,
      config: {
        ...original.config,
        reelbench: { ...createReelbenchOptions(), localVideoPath: "C:/clips/source.mp4" },
      },
    });
    const titles = getWorkflowExecutionPlan(source)!.steps.map((step) => step.title);
    expect(titles).toContain("按机器证据检查镜头表，人工修订切点与标注并确认当前版本");
    expect(titles.some((title) => title.includes("同步分镜信息视频"))).toBe(false);
    const changed = {
      ...source,
      config: {
        ...source.config,
        reelbench: { ...source.config.reelbench!, includeSyncVideo: true },
      },
    };
    expect(isWorkflowExecutionPlanApproved(getWorkflowExecutionPlan(source), changed)).toBe(false);
    expect(createWorkflowExecutionPlan(changed).steps.at(-1)?.title).toContain("同步分镜信息视频");
  });
  it("discloses per-image inspection and Logo placement, and invalidates prior approval on enablement", () => {
    const original = node();
    const source = approve({
      ...original,
      config: { ...original.config, productScene: createProductSceneOptions() },
    });
    const changed = {
      ...source,
      config: {
        ...source.config,
        productScene: {
          ...source.config.productScene!,
          quality: {
            inspectPorts: true,
            portSpecification: "1 个 HDMI",
            logo: {
              path: "C:/logo.png",
              contentHash: "b".repeat(64),
              width: 200,
              height: 60,
              approved: true,
            },
          },
        },
      },
    };
    expect(isWorkflowExecutionPlanApproved(getWorkflowExecutionPlan(source), changed)).toBe(false);
    const titles = createWorkflowExecutionPlan(changed).steps.map((step) => step.title);
    expect(titles).toContain("逐张调用视觉文本模型，检查可见接口与 Logo 所在平面");
    expect(titles).toContain("定位可靠且表面清晰时按透视贴回已确认 Logo");
  });
  it("discloses protected photograph processing and invalidates approval after a series change", () => {
    const original = node();
    const options = createJewelrySceneOptions();
    const source = approve({
      ...original,
      config: { ...original.config, productScene: options },
    });
    const titles = createWorkflowExecutionPlan(source).steps.map((step) => step.title);
    expect(titles.join("\n")).toContain("只生成外围空背景");
    expect(titles.join("\n")).toContain("六项人工核对");
    expect(titles.join("\n")).not.toContain("调用视觉文本模型");
    const changed = {
      ...source,
      config: {
        ...source.config,
        productScene: {
          ...options,
          jewelry: {
            ...options.jewelry!,
            seriesStyle: { ...options.jewelry!.seriesStyle, version: "2" },
          },
        },
      },
    };
    expect(isWorkflowExecutionPlanApproved(getWorkflowExecutionPlan(source), changed)).toBe(false);
  });
  it("uses Kahn order on an unsorted diamond and rejects cycles/missing dependencies before execution", async () => {
    const steps = [
      { id: "finish", title: "完成", dependsOn: ["left", "right"] },
      { id: "left", title: "左", dependsOn: ["start"] },
      { id: "start", title: "开始", dependsOn: [] },
      { id: "right", title: "右", dependsOn: ["start"] },
    ];
    expect(topologicallySortWorkflowSteps(steps).map(({ id }) => id)).toEqual([
      "start",
      "left",
      "right",
      "finish",
    ]);
    const order: string[] = [];
    await executeWorkflowSteps(steps, ({ id }) => {
      order.push(id);
      return Promise.resolve();
    });
    expect(order).toEqual(["start", "left", "right", "finish"]);
    const execute = vi.fn(() => Promise.resolve());
    await expect(
      executeWorkflowSteps(
        [
          { id: "a", title: "a", dependsOn: ["b"] },
          { id: "b", title: "b", dependsOn: ["a"] },
        ],
        execute,
      ),
    ).rejects.toThrow("循环依赖");
    await expect(
      executeWorkflowSteps([{ id: "a", title: "a", dependsOn: ["missing"] }], execute),
    ).rejects.toThrow("不存在");
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not release dependents after failure or a human review pause", async () => {
    const steps = [
      { id: "a", title: "a", dependsOn: [] },
      { id: "b", title: "b", dependsOn: ["a"] },
    ];
    const paused = vi.fn(() => Promise.resolve(false as const));
    expect(await executeWorkflowSteps(steps, paused)).toBe(false);
    expect(paused).toHaveBeenCalledTimes(1);
    const failed = vi.fn(() => Promise.reject(new Error("上游失败")));
    await expect(executeWorkflowSteps(steps, failed)).rejects.toThrow("上游失败");
    expect(failed).toHaveBeenCalledTimes(1);
  });

  it("binds approval to exact input and plan revision while ignoring progress and layout", () => {
    const source = approve(node());
    const plan = getWorkflowExecutionPlan(source)!;
    expect(isWorkflowExecutionPlanApproved(plan, { ...source, x: 999 })).toBe(true);
    expect(
      isWorkflowExecutionPlanApproved(plan, {
        ...source,
        config: { ...source.config, brief: "不同输入" },
      }),
    ).toBe(false);
    expect(isWorkflowExecutionPlanApproved({ ...plan, revision: plan.revision + 1 }, source)).toBe(
      false,
    );
    expect(
      isWorkflowExecutionPlanApproved({ ...plan, steps: [...plan.steps].reverse() }, source),
    ).toBe(false);
    const parsed = parseKnowledgeVideoPlan(planJson());
    const planned = {
      ...source,
      config: {
        ...source.config,
        checkpoint: { ...source.config.checkpoint, shots: parsed.shots },
      },
    };
    const delivery = createWorkflowDeliveryPlan(planned);
    for (const dependency of ["missing-shot", parsed.shots[0]!.id]) {
      const shots = parsed.shots.map((shot, index) =>
        index === 0 ? { ...shot, dependsOn: [dependency] } : shot,
      );
      const corrupt = {
        ...planned,
        config: { ...planned.config, checkpoint: { ...planned.config.checkpoint, shots } },
      };
      const corruptPlan = {
        ...delivery,
        contentSignature: stableJsonSignature({
          ...(JSON.parse(delivery.contentSignature!) as Record<string, unknown>),
          shots,
        }),
      };
      expect(isWorkflowExecutionPlanCurrent(corruptPlan, corrupt)).toBe(false);
    }
  });

  it.each(["new", "resume"])(
    "blocks every runner and history/provider side effect for an unapproved %s request",
    async (mode) => {
      const factory = vi.fn();
      const save = vi.fn();
      const result = await createRecordedWorkflowRunner({
        runnerFactory: factory,
        historyClient: { save, get: vi.fn() },
      }).run({
        node: node(),
        providerCatalog: catalog,
        resume: mode === "resume",
        signal: new AbortController().signal,
        onCheckpoint: vi.fn(),
        onProgress: vi.fn(),
      });
      expect(result.phase).toBe("awaiting_approval");
      expect(result.executionPlan?.approval).toBeNull();
      expect(factory).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
    },
  );

  it("reviews actual shots before media and reviews all clips before composing, resuming without repeated paid tasks", async () => {
    const fake = fakeDependencies(planJson());
    const runner = createKnowledgeVideoWorkflowRunner({
      promptClient: fake.promptClient,
      generationClient: fake.generation,
      frameClient: fake.frames,
      composerClient: fake.composer,
      sleep: () => Promise.resolve(),
    });
    let source = approve(node());
    const request = {
      providerCatalog: catalog,
      signal: new AbortController().signal,
      onCheckpoint: vi.fn(),
      onProgress: vi.fn(),
    };
    const planned = await runner.run({ ...request, node: source });
    expect(planned.phase).toBe("awaiting_approval");
    expect(planned.executionPlan?.scope).toBe("delivery");
    expect(planned.shots).toHaveLength(6);
    expect(fake.generation.start).not.toHaveBeenCalled();
    source = approve({ ...source, config: { ...source.config, checkpoint: planned } });
    const generated = await runner.run({ ...request, node: source, resume: true });
    expect(generated.phase).toBe("awaiting_approval");
    expect(generated.executionPlan?.review?.kind).toBe("composition");
    expect(generated.executionPlan?.review?.paths).toHaveLength(6);
    expect(fake.composer.startComposition).not.toHaveBeenCalled();
    const mediaCalls = vi.mocked(fake.generation.start).mock.calls.length;
    source = approve({ ...source, config: { ...source.config, checkpoint: generated } });
    const finished = await runner.run({ ...request, node: source, resume: true });
    expect(finished.phase).toBe("done");
    expect(fake.generation.start).toHaveBeenCalledTimes(mediaCalls);
    expect(fake.composer.startComposition).toHaveBeenCalledTimes(1);
    const delivery = createWorkflowDeliveryPlan(source);
    expect(isWorkflowExecutionPlanApproved(delivery, source)).toBe(false);

    const changedShot = finished.shots[1]!;
    const edited = {
      ...source,
      config: {
        ...source.config,
        checkpoint: {
          ...finished,
          phase: "paused" as const,
          shots: finished.shots.map((shot) =>
            shot.id === changedShot.id ? { ...shot, videoPrompt: "用户编辑后的新镜头" } : shot,
          ),
          shotRuns: {
            ...finished.shotRuns,
            [changedShot.id]: { ...finished.shotRuns[changedShot.id]!, promptEdited: true },
          },
        },
      },
    };
    const revised = createWorkflowDeliveryPlan(edited);
    source = approve({
      ...edited,
      config: {
        ...edited.config,
        executionPlan: revised,
        checkpoint: { ...edited.config.checkpoint, executionPlan: revised },
      },
    });
    const reworked = await runner.run({ ...request, node: source, resume: true });
    expect(reworked.executionPlan?.review?.kind).toBe("composition");
    expect(fake.generation.start).toHaveBeenCalledTimes(mediaCalls + 1);
    expect(reworked.shotRuns[changedShot.id]?.promptEdited).toBe(false);
    expect(reworked.shotRuns[changedShot.id]?.redoRequested).toBe(false);
    expect(reworked.shotRuns[changedShot.id]?.supersededTaskIds).toContain(
      finished.shotRuns[changedShot.id]?.videoTaskId,
    );
    expect(reworked.shotRuns[finished.shots[0]!.id]?.clipPath).toBe(
      finished.shotRuns[finished.shots[0]!.id]?.clipPath,
    );
    expect(reworked.finalPath).toBeNull();
    expect(fake.composer.startComposition).toHaveBeenCalledTimes(1);
  });

  it("dispatches a dependency before its earlier-listed child and supplies its real tail frame", async () => {
    const fake = fakeDependencies(planJson());
    const runner = createKnowledgeVideoWorkflowRunner({
      promptClient: fake.promptClient,
      generationClient: fake.generation,
      frameClient: fake.frames,
      composerClient: fake.composer,
      sleep: () => Promise.resolve(),
    });
    const source = node();
    const parsed = parseKnowledgeVideoPlan(planJson());
    const parent = { ...parsed.shots[1]!, id: "parent", videoPrompt: "先生成的父镜头" };
    const child = {
      ...parsed.shots[0]!,
      id: "child",
      continuationFromShotId: parent.id,
      videoPrompt: "依赖父镜头的子镜头",
    };
    const checkpoint = {
      ...source.config.checkpoint,
      runId: "dependency-run",
      phase: "paused" as const,
      planRevision: 1,
      manifest: parsed.manifest,
      script: parsed.script,
      storyboard: parsed.storyboard,
      shots: [child, parent],
      shotRuns: {
        child: { shotId: "child", qcStatus: "pending" as const, retryCount: 0 },
        parent: { shotId: "parent", qcStatus: "pending" as const, retryCount: 0 },
      },
    };
    const planned = { ...source, config: { ...source.config, checkpoint } };
    const executionPlan = createWorkflowDeliveryPlan(planned);
    const approved = approve({ ...planned, config: { ...planned.config, executionPlan } });
    const result = await runner.run({
      node: approved,
      resume: true,
      providerCatalog: catalog,
      signal: new AbortController().signal,
      onCheckpoint: vi.fn(),
      onProgress: vi.fn(),
    });
    expect(result.executionPlan?.review?.kind).toBe("composition");
    const commands = vi
      .mocked(fake.generation.start)
      .mock.calls.map(([command]) => command)
      .filter((command) => command.operation === "video_generation");
    expect(commands[0]?.prompt).toEqual([{ kind: "text", text: parent.videoPrompt }]);
    expect(commands[1]?.explicitMedia).toContainEqual(
      expect.objectContaining({
        target: { kind: "local_file", path: "C:\\output\\sample.png", mediaType: "image" },
        displayNameSnapshot: "镜头 parent 的接续尾帧",
      }),
    );
    expect(fake.frames.startExtraction).toHaveBeenCalledWith(
      result.shotRuns["parent"]?.clipPath,
      [],
      [0.99],
    );
    expect(result.shotRuns["child"]?.continuationSourcePath).toBe(
      result.shotRuns["parent"]?.clipPath,
    );
    expect(result.shotRuns["child"]?.continuationReferencePath).toBe("C:\\output\\sample.png");
  });

  it.each(["succeeded", "failed"] as const)(
    "retains a QC pause when an independent in-flight submission is later %s",
    async (status) => {
      const fake = fakeDependencies(planJson());
      const submitted = deferred<string>();
      const reviewReached = deferred<void>();
      vi.mocked(fake.generation.start).mockImplementation(() => submitted.promise);
      if (status === "failed")
        vi.mocked(fake.generation.getProgress).mockImplementation((taskId) => {
          const task = completedTask(taskId);
          return Promise.resolve({
            ...task,
            summary: { ...task.summary, status: "failed" },
            results: [],
            finalError: { kind: "protocol", message: "provider rejected", details: null },
          });
        });
      vi.mocked(fake.frames.getJob).mockResolvedValue({
        jobId: "incomplete",
        videoPath: "C:/pilot.mp4",
        status: "completed",
        progress: 100,
        frames: [],
        error: null,
        createdAt: 1,
        updatedAt: 2,
      });
      const parsed = parseKnowledgeVideoPlan(planJson());
      const shots = parsed.shots.slice(0, 3).map((shot, index) => ({
        ...shot,
        id: ["pilot", "independent", "child"][index]!,
        dependsOn: index === 2 ? ["pilot"] : [],
      }));
      const initial = node();
      const checkpoint = {
        ...initial.config.checkpoint,
        runId: "pause-with-active-submission",
        phase: "paused" as const,
        planRevision: 1,
        manifest: parsed.manifest,
        script: parsed.script,
        storyboard: parsed.storyboard,
        coverImagePath: "C:/cover.png",
        shots,
        shotRuns: Object.fromEntries(
          shots.map((shot, index) => [
            shot.id,
            {
              shotId: shot.id,
              qcStatus: "pending" as const,
              retryCount: 0,
              ...(index === 0 ? { videoTaskId: "video-pilot", clipPath: "C:/pilot.mp4" } : {}),
            },
          ]),
        ),
      };
      const planned = {
        ...initial,
        config: { ...initial.config, maxAutomaticRetries: 1, checkpoint },
      };
      const source = approve({
        ...planned,
        config: { ...planned.config, executionPlan: createWorkflowDeliveryPlan(planned) },
      });
      const runner = createKnowledgeVideoWorkflowRunner({
        promptClient: fake.promptClient,
        generationClient: fake.generation,
        frameClient: fake.frames,
        composerClient: fake.composer,
        sleep: () => Promise.resolve(),
      });
      const phases: string[] = [];
      const running = runner.run({
        node: source,
        resume: true,
        providerCatalog: catalog,
        signal: new AbortController().signal,
        onCheckpoint: (current) => {
          if (current.phase === "awaiting_approval" && current.decision?.kind === "qc")
            reviewReached.resolve();
        },
        onProgress: (state) => phases.push(state.phase),
      });
      await reviewReached.promise;
      expect(fake.generation.start).toHaveBeenCalledTimes(1);
      submitted.resolve("video-independent");
      const result = await running;
      expect(result.phase).toBe("awaiting_approval");
      expect(result.decision?.kind).toBe("qc");
      if (status === "succeeded") {
        expect(result.shotRuns["independent"]?.videoTaskId).toBe("video-independent");
        expect(result.shotRuns["independent"]?.clipPath).toBeTruthy();
      } else {
        expect(result.shotRuns["independent"]?.videoTaskId).toBeNull();
        expect(result.shotRuns["independent"]?.retryCount).toBe(1);
      }
      expect(phases.at(-1)).toBe("awaiting_approval");
      expect(fake.generation.start).toHaveBeenCalledTimes(1);
      expect(fake.composer.startComposition).not.toHaveBeenCalled();
    },
  );

  it("pauses comic production at assets, pilot shot, clips and final delivery without regenerating approved results", async () => {
    const fake = fakeDependencies(planJson());
    const runner = createKnowledgeVideoWorkflowRunner({
      promptClient: fake.promptClient,
      generationClient: fake.generation,
      frameClient: fake.frames,
      composerClient: fake.composer,
      sleep: () => Promise.resolve(),
    });
    const initial = node();
    let source = approve({
      ...initial,
      config: { ...initial.config, comicDrama: createComicDramaOptions() },
    });
    const request = {
      providerCatalog: catalog,
      signal: new AbortController().signal,
      onCheckpoint: vi.fn(),
      onProgress: vi.fn(),
    };
    let checkpoint = await runner.run({ ...request, node: source });
    expect(checkpoint.executionPlan?.scope).toBe("delivery");
    for (const kind of ["assets", "first_shot", "composition", "final"] as const) {
      source = approve({ ...source, config: { ...source.config, checkpoint } });
      checkpoint = await runner.run({ ...request, node: source, resume: true });
      expect(checkpoint.phase).toBe("awaiting_approval");
      expect(checkpoint.executionPlan?.review?.kind).toBe(kind);
      const videos = vi
        .mocked(fake.generation.start)
        .mock.calls.filter(([command]) => command.operation === "video_generation");
      if (kind === "assets") expect(videos).toHaveLength(0);
      if (kind === "first_shot") expect(videos).toHaveLength(1);
      if (kind === "composition") {
        expect(videos).toHaveLength(6);
        expect(fake.composer.startComposition).not.toHaveBeenCalled();
      }
    }
    source = approve({ ...source, config: { ...source.config, checkpoint } });
    const finished = await runner.run({ ...request, node: source, resume: true });
    expect(finished.phase).toBe("done");
    expect(fake.composer.startComposition).toHaveBeenCalledTimes(1);
    expect(
      vi
        .mocked(fake.generation.start)
        .mock.calls.filter(([command]) => command.operation === "video_generation"),
    ).toHaveLength(6);
  });
});
