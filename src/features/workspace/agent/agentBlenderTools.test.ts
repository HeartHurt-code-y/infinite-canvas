import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWhiteModelStudioDraft,
  whiteModelRenderSignature,
  type BlenderRenderJob,
  type WhiteModelStudioDraft,
} from "../../../lib/whiteModelStudio";
import type * as StudioModule from "../../../lib/whiteModelStudio";
import {
  createAgentBlenderTools,
  previewAgentBlenderScenes,
  type AgentBlenderHost,
} from "./agentBlenderTools";
import {
  encodeMotionClipJoints,
  presetPose,
  bakeWhiteModelScene,
} from "../../../lib/whiteModelScene";
import type { AgentToolContext } from "./agentTypes";

const native = vi.hoisted(() => ({ start: vi.fn(), get: vi.fn(), cancel: vi.fn() }));
vi.mock("../../../lib/whiteModelStudio", async (original) => ({
  ...(await original<typeof StudioModule>()),
  startBlenderRender: native.start,
  getBlenderRender: native.get,
  cancelBlenderRender: native.cancel,
}));

function job(status: BlenderRenderJob["status"]): BlenderRenderJob {
  return {
    jobId: "render-id",
    status,
    progress: status === "succeeded" ? 100 : 10,
    message: "正在渲染",
    error: null,
    videoPath: status === "succeeded" ? "C:/render/output.mp4" : null,
    previewPath: status === "succeeded" ? "C:/render/preview.png" : null,
    projectPath: status === "succeeded" ? "C:/render/scene.blend" : null,
    width: 960,
    height: 540,
    durationSeconds: 8,
    createdAt: 1,
    updatedAt: 2,
  };
}

function harness(initial: WhiteModelStudioDraft | null = createWhiteModelStudioDraft()) {
  let draft = initial;
  const host = {
    getDraft: vi.fn(() => draft),
    setDraft: vi.fn((_nodeKey: string, next: WhiteModelStudioDraft) => {
      draft = next;
      return Promise.resolve();
    }),
    attachVideo: vi.fn(() => Promise.resolve({ outputNodeKey: "white-output" })),
    openStudio: vi.fn(),
  } satisfies AgentBlenderHost;
  const controller = new AbortController();
  const context: AgentToolContext = {
    signal: controller.signal,
    callId: "call-1",
    report: vi.fn(),
    resolveNodeKey: (key) => (key === "$video" ? "video-1" : key),
    assertCurrent: vi.fn(),
    mutate: (change) => change(),
  };
  const tools = createAgentBlenderTools(host);
  const tool = (name: string) => tools.find((entry) => entry.name === `blender.${name}`)!;
  return {
    host,
    context,
    controller,
    tool,
    draft: () => draft,
    replace: (next: WhiteModelStudioDraft) => {
      draft = next;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  native.start.mockResolvedValue(job("queued"));
  native.get.mockResolvedValue(job("succeeded"));
  native.cancel.mockResolvedValue(job("cancelled"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("智能体白模工具", () => {
  it("精修保留原始动捕与其他角色，本地预览同样烘焙且撤去修改恢复原动作", async () => {
    const draft = createWhiteModelStudioDraft();
    const actor = draft.plan.objects[0]!;
    actor.motion = {
      kind: "clip",
      clip: {
        fps: 24,
        frameCount: 1,
        joints: encodeMotionClipJoints(presetPose("stand").flat()),
        sourceName: "capture.mp4",
      },
      startTime: 0,
      loop: false,
      speed: 1,
    };
    draft.plan.objects.push({ ...actor, id: "other", motion: { kind: "pose", pose: "sit" } });
    draft.jobId = "render-id";
    draft.jobInputSignature = whiteModelRenderSignature(draft);
    const view = harness(draft);
    const args = {
      nodeKey: "video-1",
      actorId: actor.id,
      clipPlayback: { startTime: 0.5, speed: 0.5, loop: true },
      refinement: {
        keyframes: [
          { time: 0, pose: "crouch" },
          { time: 2, pose: "arms_up" },
        ],
      },
    };
    const previews = previewAgentBlenderScenes(
      [{ id: "refine", tool: "blender.refine_motion", args, dependsOn: [] }],
      view.host.getDraft,
    );
    expect(view.host.setDraft).not.toHaveBeenCalled();
    const result = await view.tool("refine_motion").execute(args, view.context);
    const next = view.draft()!;
    expect(next.plan).toEqual(previews.get("refine"));
    expect(next.plan.objects[0]!.motion).toMatchObject({ clip: actor.motion.clip, speed: 0.5 });
    expect(next.plan.objects[1]).toEqual(draft.plan.objects[1]);
    expect(next.jobId).toBeNull();
    expect(next.jobInputSignature).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(actor.motion.clip.joints);
    expect(bakeWhiteModelScene(next.plan).objects[0]!.joints).not.toEqual(
      bakeWhiteModelScene(draft.plan).objects[0]!.joints,
    );
    await view
      .tool("refine_motion")
      .execute({ nodeKey: "video-1", actorId: actor.id, refinement: null }, view.context);
    expect(view.draft()!.plan.objects[0]!.motionRefinement).toBeUndefined();
    expect(view.draft()!.plan.objects[0]!.motion).toMatchObject({ clip: actor.motion.clip });
    expect(native.start).not.toHaveBeenCalled();
  });

  it("动作精修拒绝越界、未知角色、空修改和渲染期间异步覆盖", async () => {
    const draft = createWhiteModelStudioDraft();
    const view = harness(draft);
    const base = { nodeKey: "video-1", actorId: draft.plan.objects[0]!.id };
    expect(() => view.tool("refine_motion").validate(base)).toThrow();
    expect(() =>
      view.tool("refine_motion").validate({
        ...base,
        refinement: { keyframes: [{ time: 0, torsoRotation: [NaN, 0, 0] }] },
      }),
    ).toThrow();
    await expect(
      view
        .tool("refine_motion")
        .execute(
          { ...base, refinement: { keyframes: [{ time: 20, pose: "crouch" }] } },
          view.context,
        ),
    ).rejects.toThrow();
    await expect(
      view
        .tool("refine_motion")
        .execute({ ...base, actorId: "missing", refinement: null }, view.context),
    ).rejects.toThrow("找不到");
    await expect(
      view
        .tool("refine_motion")
        .execute({ ...base, clipPlayback: { startTime: 0, speed: 0.5, loop: true } }, view.context),
    ).rejects.toThrow("没有动捕");
    draft.jobId = "render-id";
    native.get.mockResolvedValueOnce(job("running"));
    const args = { ...base, refinement: { keyframes: [{ time: 0, pose: "crouch" }] } };
    await expect(view.tool("refine_motion").execute(args, view.context)).rejects.toThrow(
      "仍在渲染",
    );
    native.get.mockImplementationOnce(() => {
      const newer = structuredClone(draft);
      newer.plan.camera.lens = 85;
      view.replace(newer);
      return Promise.resolve(job("succeeded"));
    });
    await expect(view.tool("refine_motion").execute(args, view.context)).rejects.toThrow(
      "已被修改",
    );
    expect(view.host.setDraft).not.toHaveBeenCalled();
  });

  it("预览按依赖串联新场景和动作精修，不修改原始计划", () => {
    const scene = createWhiteModelStudioDraft().plan;
    const previews = previewAgentBlenderScenes(
      [
        {
          id: "scene",
          tool: "blender.set_scene",
          args: { nodeKey: "$video", scene },
          dependsOn: ["video"],
        },
        {
          id: "refine",
          tool: "blender.refine_motion",
          args: {
            nodeKey: "$scene",
            actorId: scene.objects[0]!.id,
            refinement: { keyframes: [{ time: 0, pose: "crouch" }] },
          },
          dependsOn: ["scene"],
        },
      ],
      () => null,
    );
    expect(previews.get("scene")!.objects[0]!.motionRefinement).toBeUndefined();
    expect(previews.get("refine")!.objects[0]!.motionRefinement).toBeDefined();
    expect(scene.objects[0]!.motionRefinement).toBeUndefined();
  });

  it("画布编辑返回的节点引用与真实节点共享同一份预览场景", () => {
    const draft = createWhiteModelStudioDraft();
    const scene = { ...draft.plan, camera: { ...draft.plan.camera, lens: 85 } };
    const previews = previewAgentBlenderScenes(
      [
        {
          id: "move",
          tool: "canvas.move_node",
          args: { nodeKey: "video-1", x: 1, y: 2 },
          dependsOn: [],
        },
        {
          id: "prompt",
          tool: "canvas.set_prompt",
          args: { nodeKey: "$move", text: "测试" },
          dependsOn: ["move"],
        },
        {
          id: "scene",
          tool: "blender.set_scene",
          args: { nodeKey: "$prompt", scene },
          dependsOn: ["prompt"],
        },
        {
          id: "refine",
          tool: "blender.refine_motion",
          args: {
            nodeKey: "video-1",
            actorId: scene.objects[0]!.id,
            refinement: { keyframes: [{ time: 0, pose: "crouch" }] },
          },
          dependsOn: ["scene"],
        },
        {
          id: "refine-again",
          tool: "blender.refine_motion",
          args: { nodeKey: "$move", actorId: scene.objects[0]!.id, facing: "manual" },
          dependsOn: ["refine"],
        },
      ],
      () => draft,
    );
    expect(previews.get("refine")!.camera.lens).toBe(85);
    expect(previews.get("refine-again")!.objects[0]!.motionRefinement).toBeDefined();
    expect(previews.get("refine-again")!.camera.lens).toBe(85);
    expect(draft.plan.camera.lens).not.toBe(85);
  });

  it("拒绝任意代码、非法场景、伪造动捕和重复对象身份", () => {
    const { tool } = harness();
    const scene = createWhiteModelStudioDraft().plan;
    const validate = (value: unknown) => tool("set_scene").validate(value);
    expect(() => validate({ nodeKey: "video-1", scene, python: "print('unsafe')" })).toThrow();
    expect(() => validate({ nodeKey: "video-1", scene: { ...scene, width: 961 } })).toThrow();
    expect(() => validate({ nodeKey: "video-1", scene: { ...scene, fps: Infinity } })).toThrow();
    expect(() =>
      validate({
        nodeKey: "video-1",
        scene: { ...scene, objects: [scene.objects[0], scene.objects[0]] },
      }),
    ).toThrow("不同的标识");
    expect(() =>
      validate({
        nodeKey: "video-1",
        scene: { ...scene, objects: [{ ...scene.objects[0], motion: { kind: "clip", clip: {} } }] },
      }),
    ).toThrow();
    expect(() =>
      validate({
        nodeKey: "video-1",
        scene: {
          ...scene,
          camera: { ...scene.camera, follow: { actorId: "missing", mode: "track" } },
        },
      }),
    ).toThrow("角色已不存在");
  });

  it("仅设置已校验场景、清理过期派生引用且不提交渲染", async () => {
    const draft = createWhiteModelStudioDraft();
    draft.jobId = "render-id";
    draft.jobInputSignature = whiteModelRenderSignature(draft);
    draft.blockingImagePath = "C:/old.png";
    draft.blockingImageSignature = "old";
    const view = harness(draft);
    const scene = structuredClone(draft.plan);
    scene.camera.lens = 50;
    await view.tool("set_scene").execute({ nodeKey: "$video", scene }, view.context);
    expect(view.host.setDraft).toHaveBeenCalledWith(
      "video-1",
      expect.objectContaining({
        mode: "create",
        executablePath: "",
        sourceBlendPath: "",
        plan: scene,
        jobId: null,
        blockingImagePath: null,
      }),
    );
    expect(view.draft()?.jobInputSignature).toBeUndefined();
    expect(native.start).not.toHaveBeenCalled();
    expect(view.host.attachVideo).not.toHaveBeenCalled();
  });

  it("已有动捕读取只给摘要，整场替换不抹掉动作", async () => {
    const draft = createWhiteModelStudioDraft();
    draft.plan.objects[0]!.motion = {
      kind: "clip",
      clip: { fps: 24, frameCount: 1, joints: "SECRET_JOINT_BUFFER", sourceName: "walk.mp4" },
      startTime: 0,
      loop: true,
      speed: 1,
    };
    const view = harness(draft);
    const result = await view.tool("get_scene").execute({ nodeKey: "video-1" }, view.context);
    expect(JSON.stringify(result)).not.toContain("SECRET_JOINT_BUFFER");
    expect(JSON.stringify(result)).toContain("clipDataOmitted");
    await expect(
      view
        .tool("set_scene")
        .execute({ nodeKey: "video-1", scene: createWhiteModelStudioDraft().plan }, view.context),
    ).rejects.toThrow("保留已有动作片段");
    expect(view.host.setDraft).not.toHaveBeenCalled();
  });

  it("先持久化任务身份再轮询，将真实成功任务交给画布接入", async () => {
    vi.useFakeTimers();
    const view = harness();
    const result = view.tool("render").execute({ nodeKey: "$video" }, view.context);
    await vi.advanceTimersByTimeAsync(0);
    expect(view.host.setDraft).toHaveBeenCalledWith(
      "video-1",
      expect.objectContaining({
        jobId: "render-id",
        jobInputSignature: whiteModelRenderSignature(view.draft()!),
      }),
    );
    expect(native.get).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(result).resolves.toMatchObject({ jobId: "render-id", status: "succeeded" });
    expect(view.host.attachVideo).toHaveBeenCalledWith("video-1", job("succeeded"));
    expect(native.start.mock.calls[0]?.[0]).toMatchObject({
      executablePath: null,
      sourceBlendPath: null,
      bake: { frameCount: 192 },
    });
  });

  it("相同方案复用已完成结果，失败任务只在新确认调用时重试", async () => {
    const draft = createWhiteModelStudioDraft();
    draft.jobId = "render-id";
    draft.jobInputSignature = whiteModelRenderSignature(draft);
    const view = harness(draft);
    await view.tool("render").execute({ nodeKey: "video-1" }, view.context);
    expect(native.start).not.toHaveBeenCalled();
    expect(view.host.attachVideo).toHaveBeenCalledOnce();
    native.get.mockResolvedValueOnce(job("failed"));
    native.start.mockResolvedValueOnce(job("succeeded"));
    await view.tool("render").execute({ nodeKey: "video-1" }, view.context);
    expect(native.start).toHaveBeenCalledOnce();
  });

  it("取消停止底层渲染，保留任务身份且不接入结果", async () => {
    vi.useFakeTimers();
    const view = harness();
    const result = view.tool("render").execute({ nodeKey: "video-1" }, view.context);
    const rejected = expect(result).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    view.controller.abort();
    await rejected;
    expect(native.cancel).toHaveBeenCalledWith("render-id");
    expect(view.draft()?.jobId).toBe("render-id");
    expect(view.host.attachVideo).not.toHaveBeenCalled();
  });

  it("恢复已保存的运行中任务只继续轮询，不重复启动 Blender", async () => {
    vi.useFakeTimers();
    const draft = createWhiteModelStudioDraft();
    draft.jobId = "render-id";
    draft.jobInputSignature = whiteModelRenderSignature(draft);
    native.get.mockResolvedValueOnce(job("running")).mockResolvedValueOnce(job("succeeded"));
    const view = harness(draft);
    const result = view.tool("render").execute({ nodeKey: "video-1" }, view.context);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(result).resolves.toMatchObject({ jobId: "render-id", status: "succeeded" });
    expect(native.start).not.toHaveBeenCalled();
    expect(view.host.setDraft).not.toHaveBeenCalled();
    expect(view.host.attachVideo).toHaveBeenCalledOnce();
  });

  it("异步提交期间场景被修改时取消旧任务，不覆盖新方案", async () => {
    const view = harness();
    const newer = createWhiteModelStudioDraft();
    newer.plan.camera.lens = 85;
    native.start.mockImplementationOnce(() => {
      view.replace(newer);
      return Promise.resolve(job("queued"));
    });
    await expect(view.tool("render").execute({ nodeKey: "video-1" }, view.context)).rejects.toThrow(
      "场景在任务执行期间已改变",
    );
    expect(native.cancel).toHaveBeenCalledWith("render-id");
    expect(view.host.setDraft).not.toHaveBeenCalled();
    expect(view.host.attachVideo).not.toHaveBeenCalled();
    expect(view.draft()).toBe(newer);
  });

  it("草稿保存失败会回收刚启动的渲染，不留下未关联任务", async () => {
    const view = harness();
    view.host.setDraft.mockRejectedValueOnce(new Error("磁盘已满"));
    await expect(view.tool("render").execute({ nodeKey: "video-1" }, view.context)).rejects.toThrow(
      "磁盘已满",
    );
    expect(native.cancel).toHaveBeenCalledWith("render-id");
    expect(view.host.attachVideo).not.toHaveBeenCalled();
  });

  it("拒绝智能体使用外部程序或直接渲染导入工程", async () => {
    const draft = createWhiteModelStudioDraft();
    draft.executablePath = "C:/external/blender.exe";
    const view = harness(draft);
    await expect(view.tool("render").execute({ nodeKey: "video-1" }, view.context)).rejects.toThrow(
      "内置引擎",
    );
    expect(native.start).not.toHaveBeenCalled();
    await view.tool("open_studio").execute({ nodeKey: "video-1" }, view.context);
    expect(view.host.openStudio).toHaveBeenCalledWith("video-1");
  });
});
