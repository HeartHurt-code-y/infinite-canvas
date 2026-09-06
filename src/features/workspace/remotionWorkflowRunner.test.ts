import { describe, expect, it, vi } from "vitest";
import {
  workflowReferenceFixtures,
  workflowReferenceInputs,
} from "../../test/workflowMaterialFixtures";
import { stableJsonSignature } from "../../lib/workflowSignatures";

import type { OptimizeVideoPromptCommand } from "../../lib/backend";
import type { RemotionRendererClient } from "../../lib/remotionRenderer";
import { catalog, fakeDependencies, node, planJson } from "../../test/videoWorkflowFixtures";
import {
  createRemotionOptions,
  type AnimationPlan,
  type AnimationRenderJob,
} from "./remotionWorkflowModel";
import { createRemotionWorkflowRunner, parseAnimationPlan } from "./remotionWorkflowRunner";
import type {
  KnowledgeVideoWorkflowCheckpoint,
  KnowledgeVideoWorkflowNodeData,
} from "./workspaceModel";

const plan: AnimationPlan = {
  schemaVersion: "animation-plan.v1",
  template: "cycle-flowchart",
  title: "学习循环",
  width: 800,
  height: 600,
  fps: 30,
  durationInFrames: 240,
  background: "#ffffff",
  palette: ["#3498db", "#2ecc71"],
  elements: [
    { id: "learn", label: "学习", detail: "理解概念" },
    { id: "practice", label: "实践", detail: "实际应用" },
    { id: "reflect", label: "复盘", detail: "反馈改进" },
  ],
  connections: [
    { from: "learn", to: "practice" },
    { from: "practice", to: "reflect" },
    { from: "reflect", to: "learn" },
  ],
  staggerFrames: 30,
  holdFrames: 60,
  springDamping: 10,
};
const ready = (value: AnimationPlan = plan) => ({
  schemaVersion: "remotion-workflow.v1",
  status: "ready",
  matchReason: "复盘回到学习，使用闭环模板",
  decision: null,
  plan: value,
});
const pass = { result: "PASS", report: "原文、元素方向、时序与静置时间均通过" };
const output = (data: object) => {
  const raw = JSON.stringify(data);
  return Promise.resolve({ optimizedPrompt: raw, rawModelOutput: raw });
};
const job = (changes: Partial<AnimationRenderJob> = {}): AnimationRenderJob => ({
  id: "render-1",
  status: "succeeded",
  progress: 100,
  message: "动画渲染完成",
  createdAt: 1,
  updatedAt: 2,
  gifPath: "C:\\animation-output\\cycle.gif",
  videoPath: "C:\\animation-output\\cycle.mp4",
  previewPath: "C:\\animation-output\\preview.png",
  projectPath: "C:\\animation-output\\project",
  ...changes,
});

function setup() {
  const fake = fakeDependencies(planJson());
  const events: string[] = [];
  const normalResponse = (command: OptimizeVideoPromptCommand) => {
    events.push(command.mode);
    return output(command.mode === "remotion_planner" ? ready() : pass);
  };
  vi.mocked(fake.promptClient.run).mockImplementation(normalResponse);
  const renderer = {
    preflight: vi.fn(() => {
      events.push("preflight");
      return Promise.resolve({ ready: true, message: "本地环境就绪" });
    }),
    start: vi.fn(() => {
      events.push("render-start");
      return Promise.resolve(job({ status: "running", progress: 0 }));
    }),
    get: vi.fn(() => Promise.resolve(job())),
    cancel: vi.fn(() => Promise.resolve()),
  } satisfies RemotionRendererClient;
  const sleeper = vi
    .fn<(milliseconds: number, signal: AbortSignal) => Promise<void>>()
    .mockResolvedValue(undefined);
  const source = node();
  const animationNode: KnowledgeVideoWorkflowNodeData = {
    ...source,
    config: {
      ...source.config,
      brief: "学习 -> 实践 -> 复盘 -> 学习",
      remotion: { ...createRemotionOptions(), format: "both" },
      models: {
        text: source.config.models.text,
        image: { providerId: "", modelDefinitionId: "" },
        video: { providerId: "", modelDefinitionId: "" },
      },
    },
  };
  const runner = createRemotionWorkflowRunner({
    promptClient: fake.promptClient,
    renderer,
    sleep: sleeper,
    now: () => 42,
  });
  const request = {
    node: animationNode,
    providerCatalog: catalog,
    signal: new AbortController().signal,
    onCheckpoint: vi.fn(),
    onProgress: vi.fn(),
  };
  const resume = (checkpoint: KnowledgeVideoWorkflowCheckpoint) => ({
    ...request,
    resume: true,
    node: { ...animationNode, config: { ...animationNode.config, checkpoint } },
  });
  const calls = () => vi.mocked(fake.promptClient.run).mock.calls.map(([command]) => command);
  return { fake, renderer, sleeper, runner, request, resume, calls, events, normalResponse };
}

describe("remotion composite workflow", () => {
  it("reads every general reference in planning and independent reviews and rejects changed resume inputs", async () => {
    const { runner, request, fake } = setup();
    const withMaterials = {
      ...request,
      node: {
        ...request.node,
        config: { ...request.node.config, materials: workflowReferenceFixtures },
      },
    };
    const checkpoint = await runner.run(withMaterials);
    expect(checkpoint.phase).toBe("done");
    const calls = vi.mocked(fake.promptClient.run).mock.calls.map(([input]) => input);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const input of calls) expect(input.multimodalInputs).toEqual(workflowReferenceInputs);
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

  it("uses only the project text model, checks independently and renders both formats through the local job client", async () => {
    const { fake, renderer, runner, request, calls, events } = setup();
    const result = await runner.run(request);
    expect(result.phase).toBe("done");
    expect(events).toEqual(["preflight", "remotion_planner", "remotion_review", "render-start"]);
    expect(
      calls().every(
        (command) =>
          command.providerConnectionId === "project-provider" &&
          command.modelDefinitionId === "project-text",
      ),
    ).toBe(true);
    expect(renderer.start).toHaveBeenCalledWith({ plan, format: "both" });
    expect(renderer.get).toHaveBeenCalledWith("render-1");
    expect(result.remotion?.renderJob).toMatchObject({
      gifPath: job().gifPath,
      videoPath: job().videoPath,
      previewPath: job().previewPath,
      projectPath: job().projectPath,
    });
    expect(result.finalPath).toBe(job().gifPath);
    expect(fake.generation.start).not.toHaveBeenCalled();
    expect(fake.composer.startComposition).not.toHaveBeenCalled();
  });

  it("rewrites after REVISE and checks the revised plan before rendering", async () => {
    const { fake, renderer, runner, request, calls, normalResponse } = setup();
    let reviews = 0;
    vi.mocked(fake.promptClient.run).mockImplementation((command) =>
      command.mode === "remotion_review" && reviews++ === 0
        ? output({
            result: "REVISE",
            report: "卡片说明偏长",
            repairInstructions: "将每个说明缩短至八个字",
          })
        : normalResponse(command),
    );
    const result = await runner.run(request);
    expect(result.phase).toBe("done");
    expect(calls().map((command) => command.mode)).toEqual([
      "remotion_planner",
      "remotion_review",
      "remotion_planner",
      "remotion_review",
    ]);
    expect(calls()[2]?.userPrompt).toContain("将每个说明缩短至八个字");
    expect(result.remotion?.history).toHaveLength(1);
    expect(result.remotion?.review?.result).toBe("PASS");
    expect(renderer.start).toHaveBeenCalledOnce();
  });

  it("retains a planner decision as factual context for both planning and independent review", async () => {
    const { fake, renderer, runner, request, resume, calls, normalResponse } = setup();
    vi.mocked(fake.promptClient.run).mockImplementationOnce(() =>
      output({
        schemaVersion: "remotion-workflow.v1",
        status: "needs_confirmation",
        matchReason: "缺少目标用户的背景",
        plan: null,
        decision: { question: "内容面向谁？", recommendation: "面向新入职工程师" },
      }),
    );
    const pending = await runner.run(request);
    expect(pending.phase).toBe("awaiting_approval");
    expect(renderer.start).not.toHaveBeenCalled();
    vi.mocked(fake.promptClient.run).mockImplementation(normalResponse);
    const result = await runner.run({
      ...resume(pending),
      decisionResolution: "面向中学生，采用日常例子",
    });
    expect(result.phase).toBe("done");
    expect(result.remotion?.confirmedDecisions?.join("\n")).toContain("面向中学生，采用日常例子");
    for (const command of calls().slice(1))
      expect(command.userPrompt).toContain("面向中学生，采用日常例子");
    expect(
      calls()
        .slice(1)
        .map((command) => command.mode),
    ).toEqual(["remotion_planner", "remotion_review"]);
  });

  it("applies confirmed review decisions through a real revision and another review", async () => {
    const { fake, renderer, runner, request, resume, calls, normalResponse } = setup();
    let reviews = 0;
    vi.mocked(fake.promptClient.run).mockImplementation((command) =>
      command.mode === "remotion_review" && reviews++ === 0
        ? output({
            result: "NEEDS_DECISION",
            report: "回路方向存在业务歧义",
            question: "复盘之后是否直接进入学习？",
            recommendation: "复盘后进入学习",
            repairInstructions: "按用户确认的方向修订关系",
          })
        : normalResponse(command),
    );
    const pending = await runner.run(request);
    expect(pending.phase).toBe("awaiting_approval");
    expect(renderer.start).not.toHaveBeenCalled();
    const result = await runner.run({
      ...resume(pending),
      decisionResolution: "确认复盘后进入学习，不增加其他步骤",
    });
    expect(result.phase).toBe("done");
    expect(calls().map((command) => command.mode)).toEqual([
      "remotion_planner",
      "remotion_review",
      "remotion_planner",
      "remotion_review",
    ]);
    for (const command of calls().slice(2))
      expect(command.userPrompt).toContain("确认复盘后进入学习，不增加其他步骤");
  });

  it("resumes a failed review request without paying to plan again", async () => {
    const { fake, renderer, runner, request, resume, calls, normalResponse } = setup();
    vi.mocked(fake.promptClient.run).mockImplementation((command) =>
      command.mode === "remotion_review"
        ? Promise.reject(new Error("检查接口暂时不可达"))
        : normalResponse(command),
    );
    const failed = await runner.run(request);
    expect(failed.phase).toBe("failed");
    expect(failed.remotion?.plan).toEqual(plan);
    expect(failed.remotion?.review).toBeNull();
    expect(renderer.start).not.toHaveBeenCalled();
    vi.mocked(fake.promptClient.run).mockImplementation(normalResponse);
    const result = await runner.run(resume(failed));
    expect(result.phase).toBe("done");
    expect(calls().map((command) => command.mode)).toEqual([
      "remotion_planner",
      "remotion_review",
      "remotion_review",
    ]);
  });

  it("resumes a paused job with a legacy signature after a serde-style key-order round trip without duplicate rendering or text charges", async () => {
    const { fake, renderer, sleeper, runner, request, resume } = setup();
    const controller = new AbortController();
    sleeper.mockImplementationOnce(() => {
      controller.abort();
      return Promise.reject(new DOMException("暂停", "AbortError"));
    });
    vi.mocked(renderer.cancel).mockRejectedValueOnce(new Error("取消响应丢失"));
    const paused = await runner.run({ ...request, signal: controller.signal });
    expect(paused.phase).toBe("paused");
    expect(paused.remotion?.renderJob?.id).toBe("render-1");
    expect(renderer.cancel).toHaveBeenCalledWith("render-1");
    const restored = resume({
      ...paused,
      remotion: {
        ...paused.remotion!,
        inputSignature: JSON.stringify({
          brief: request.node.config.brief,
          options: request.node.config.remotion,
        }),
      },
    });
    const result = await runner.run({
      ...restored,
      node: JSON.parse(stableJsonSignature(restored.node)) as KnowledgeVideoWorkflowNodeData,
    });
    expect(result.phase).toBe("done");
    expect(renderer.get).toHaveBeenCalledWith("render-1");
    expect(renderer.start).toHaveBeenCalledOnce();
    expect(fake.promptClient.run).toHaveBeenCalledTimes(2);
  });

  it("restarts only local rendering when a paused job becomes cancelled after the initial resume query", async () => {
    const { fake, renderer, sleeper, runner, request, resume } = setup();
    const controller = new AbortController();
    sleeper.mockImplementationOnce(() => {
      controller.abort();
      return Promise.reject(new DOMException("暂停", "AbortError"));
    });
    const paused = await runner.run({ ...request, signal: controller.signal });
    expect(paused.phase).toBe("paused");
    vi.mocked(renderer.get)
      .mockResolvedValueOnce(job({ status: "running", progress: 25 }))
      .mockResolvedValueOnce(job({ status: "cancelled", progress: 25 }))
      .mockResolvedValue(job({ id: "render-2" }));
    vi.mocked(renderer.start).mockResolvedValueOnce(
      job({ id: "render-2", status: "running", progress: 0 }),
    );
    const result = await runner.run(resume(paused));
    expect(result.phase).toBe("done");
    expect(result.remotion?.renderJob?.id).toBe("render-2");
    expect(renderer.start).toHaveBeenCalledTimes(2);
    expect(fake.promptClient.run).toHaveBeenCalledTimes(2);
  });

  it("fails preflight before any model charges when the local render engine is unavailable", async () => {
    const { fake, renderer, runner, request } = setup();
    vi.mocked(renderer.preflight).mockResolvedValueOnce({
      ready: false,
      message: "本地动画渲染引擎未就绪",
    });
    const result = await runner.run(request);
    expect(result.phase).toBe("failed");
    expect(result.error).toBe("本地动画渲染引擎未就绪");
    expect(fake.promptClient.run).not.toHaveBeenCalled();
    expect(renderer.start).not.toHaveBeenCalled();
  });

  it("rejects executable fields, unknown references, insufficient hold time, missing pie values and off-canvas rectangles", () => {
    const invalidPlans: readonly [unknown, RegExp][] = [
      [{ ...plan, code: "process.exit(0)" }, /未定义字段/],
      [
        { ...plan, elements: [{ ...plan.elements[0], html: "<img src=x onerror=alert(1)>" }] },
        /未定义字段/,
      ],
      [{ ...plan, connections: [{ from: "learn", to: "unknown" }] }, /引用两个不同且已存在/],
      [
        {
          ...plan,
          connections: [
            { from: "learn", to: "practice" },
            { from: "learn", to: "practice" },
          ],
        },
        /重复/,
      ],
      [{ ...plan, durationInFrames: 90 }, /60 帧静止/],
      [{ ...plan, template: "pie-chart" }, /真实非负数值/],
      [
        {
          ...plan,
          template: "custom",
          connections: [],
          elements: [{ id: "box", label: "越界", x: 770, y: 10, width: 80, height: 50 }],
        },
        /超出画布/,
      ],
    ];
    for (const [invalid, message] of invalidPlans)
      expect(() => parseAnimationPlan(invalid)).toThrow(message);
  });

  it("rejects changed inputs before reusing a persisted plan or render job", async () => {
    const { fake, renderer, runner, request, resume, normalResponse } = setup();
    vi.mocked(fake.promptClient.run).mockImplementation((command) =>
      command.mode === "remotion_review"
        ? Promise.reject(new Error("网络中断"))
        : normalResponse(command),
    );
    const failed = await runner.run(request);
    const resumed = resume(failed);
    const result = await runner.run({
      ...resumed,
      node: { ...resumed.node, config: { ...resumed.node.config, brief: "已改为产品对比" } },
    });
    expect(result.phase).toBe("failed");
    expect(result.error).toContain("按当前资料重新制作");
    expect(fake.promptClient.run).toHaveBeenCalledTimes(2);
    expect(renderer.preflight).toHaveBeenCalledOnce();
    expect(renderer.start).not.toHaveBeenCalled();
  });

  it("restarts local rendering after a succeeded job omitted a required delivery file, while preserving approved text", async () => {
    const { fake, renderer, runner, request, resume } = setup();
    vi.mocked(renderer.get).mockResolvedValueOnce(job({ gifPath: null }));
    const failed = await runner.run(request);
    expect(failed.phase).toBe("failed");
    expect(failed.error).toContain("完整交付物");
    vi.mocked(renderer.get)
      .mockResolvedValueOnce(job({ gifPath: null }))
      .mockResolvedValue(job());
    const result = await runner.run(resume(failed));
    expect(result.phase).toBe("done");
    expect(renderer.start).toHaveBeenCalledTimes(2);
    expect(fake.promptClient.run).toHaveBeenCalledTimes(2);
  });
});
