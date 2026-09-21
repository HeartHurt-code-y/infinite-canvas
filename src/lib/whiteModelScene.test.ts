import { describe, expect, it } from "vitest";
import {
  JOINT,
  JOINT_COUNT,
  bakeWhiteModelScene,
  cameraKeyframeFromWorld,
  cameraMoveKeyframes,
  convertCameraFollow,
  decodeMotionClipJoints,
  encodeMotionClipJoints,
  evaluateActor,
  evaluateCamera,
  evaluateJoints,
  locomotionPose,
  migrateWhiteModelScenePlan,
  orbitCamera,
  presetPose,
  solveShot,
  upsertKeyframe,
  vec,
  verticalFovDegrees,
  whiteModelPlanIssue,
  type WhiteModelObject,
  type WhiteModelScenePlan,
  type WhiteModelScenePlanV1,
} from "./whiteModelScene";
import {
  createWhiteModelObject,
  createWhiteModelScenePlan,
  createWhiteModelStudioDraft,
  normalizeWhiteModelStudioDraft,
  whiteModelRenderRequest,
  whiteModelRenderSignature,
  type WhiteModelStudioDraft,
} from "./whiteModelStudio";

const DEG = Math.PI / 180;

function walker(overrides: Partial<WhiteModelObject> = {}): WhiteModelObject {
  return {
    id: "walker",
    name: "角色 1",
    shape: "person",
    color: "#dc6868",
    size: 1.75,
    facing: "path",
    keyframes: [
      { time: 0, position: [-2, 0, 0], yaw: 0 },
      { time: 4, position: [2, 0, 0], yaw: 0 },
    ],
    motion: { kind: "auto" },
    ...overrides,
  };
}

function plan(overrides: Partial<WhiteModelScenePlan> = {}): WhiteModelScenePlan {
  return {
    version: 2,
    durationSeconds: 4,
    fps: 10,
    width: 960,
    height: 540,
    camera: {
      lens: 50,
      interpolation: "linear",
      keyframes: [
        { time: 0, position: [0, -6, 2], target: [0, 0, 1] },
        { time: 4, position: [0, -4, 2], target: [0, 0, 1] },
      ],
      follow: null,
    },
    objects: [walker()],
    ...overrides,
  };
}

describe("角色路径求值", () => {
  it("线性插值位置、按路径方向自动朝向并累计步行相位", () => {
    const actor = walker();
    const middle = evaluateActor(actor, 2);
    expect(middle.position).toEqual([0, 0, 0]);
    // 沿 +X 行走：yaw=0 面朝 -Y，逆时针转 90° 面朝 +X。
    expect(middle.yaw).toBeCloseTo(90);
    expect(middle.speed).toBeCloseTo(1);
    expect(evaluateActor(actor, 3).phase).toBeGreaterThan(middle.phase);
    expect(evaluateActor(actor, -1).position).toEqual([-2, 0, 0]);
    expect(evaluateActor(actor, 9).position).toEqual([2, 0, 0]);
    expect(evaluateActor(actor, 9).speed).toBe(0);
  });

  it("手动朝向按关键帧插值，静止段沿用起步方向", () => {
    const manual = walker({
      facing: "manual",
      keyframes: [
        { time: 0, position: [0, 0, 0], yaw: 0 },
        { time: 2, position: [0, 0, 0], yaw: 90 },
      ],
    });
    expect(evaluateActor(manual, 1).yaw).toBeCloseTo(45);
    const waits = walker({
      keyframes: [
        { time: 0, position: [0, 0, 0], yaw: 0 },
        { time: 2, position: [0, 0, 0], yaw: 0 },
        { time: 4, position: [0, -3, 0], yaw: 0 },
      ],
    });
    // 先站 2 秒再朝 -Y 走：等待期间已面朝行进方向（yaw 0），不会先背对。
    expect(evaluateActor(waits, 1).yaw).toBeCloseTo(0);
    expect(evaluateActor(waits, 1).speed).toBe(0);
  });
});

describe("人形骨架", () => {
  it("步行循环 17 个关节，最低脚踝始终贴地，双腿反相摆动", () => {
    const pose = locomotionPose(0.8, 1);
    expect(pose).toHaveLength(JOINT_COUNT);
    const lowest = Math.min(pose[JOINT.leftAnkle]![2], pose[JOINT.rightAnkle]![2]);
    expect(lowest).toBeCloseTo(0.045, 3);
    const leftForward = pose[JOINT.leftAnkle]![1] - pose[JOINT.leftHip]![1];
    const rightForward = pose[JOINT.rightAnkle]![1] - pose[JOINT.rightHip]![1];
    expect(Math.sign(leftForward)).not.toBe(Math.sign(rightForward));
    expect(presetPose("sit")[JOINT.pelvis]![2]).toBeLessThan(presetPose("stand")[JOINT.pelvis]![2]);
  });

  it("求值时按身高缩放；几何体没有关节", () => {
    const actor = walker({ size: 2 });
    const joints = evaluateJoints(actor, evaluateActor(actor, 9), 9)!;
    // 静止呼吸起伏在毫米级，头部高度应接近 0.93 × 身高。
    expect(Math.abs(joints[JOINT.head]![2] - 0.93 * 2)).toBeLessThan(0.02);
    expect(evaluateJoints({ ...actor, shape: "box" }, evaluateActor(actor, 0), 0)).toBeNull();
  });

  it("动捕片段 base64 int16 往返误差不超过 0.0001，并按时间线性插值与循环", () => {
    const frameCount = 3;
    const source = new Float32Array(frameCount * JOINT_COUNT * 3);
    for (let index = 0; index < source.length; index += 1) source[index] = Math.sin(index) * 1.2;
    const encoded = encodeMotionClipJoints(source);
    const decoded = decodeMotionClipJoints(encoded, frameCount);
    for (let index = 0; index < source.length; index += 1) {
      expect(Math.abs(decoded[index]! - source[index]!)).toBeLessThanOrEqual(0.0001 + 1e-6);
    }
    expect(() => decodeMotionClipJoints(encoded, 4)).toThrow();
    // 三帧：头部高度 0.5 / 1 / 0.5，1 fps。
    const joints = new Float32Array(frameCount * JOINT_COUNT * 3);
    joints[(0 * JOINT_COUNT + JOINT.head) * 3 + 2] = 0.5;
    joints[(1 * JOINT_COUNT + JOINT.head) * 3 + 2] = 1;
    joints[(2 * JOINT_COUNT + JOINT.head) * 3 + 2] = 0.5;
    const actor = walker({
      size: 1,
      motion: {
        kind: "clip",
        clip: { fps: 1, frameCount, joints: encodeMotionClipJoints(joints), sourceName: "demo" },
        startTime: 0,
        loop: true,
        speed: 1,
      },
    });
    const state = evaluateActor(actor, 0);
    expect(evaluateJoints(actor, state, 0.5)![JOINT.head]![2]).toBeCloseTo(0.75, 3);
    expect(evaluateJoints(actor, state, 1)![JOINT.head]![2]).toBeCloseTo(1, 3);
    // 循环：第 3 帧回到第 0 帧之间插值。
    expect(evaluateJoints(actor, state, 2.5)![JOINT.head]![2]).toBeCloseTo(0.5, 3);
    const held = walker({ ...actor, motion: { ...actor.motion, loop: false } as never });
    expect(evaluateJoints(held, state, 10)![JOINT.head]![2]).toBeCloseTo(0.5, 3);
  });
});

describe("机位求值与跟随", () => {
  it("关键帧之间线性/平滑插值，aim 跟随只改注视点，track 跟随随角色平移", () => {
    const linear = plan();
    expect(evaluateCamera(linear, 2).position[1]).toBeCloseTo(-5);
    const smooth = plan({ camera: { ...linear.camera, interpolation: "smooth" } });
    expect(evaluateCamera(smooth, 1).position[1]).toBeCloseTo(-6 + 2 * 0.15625);
    const aim = plan({
      camera: { ...linear.camera, follow: { actorId: "walker", mode: "aim" } },
    });
    const aimed = evaluateCamera(aim, 2);
    expect(aimed.position).toEqual([0, -5, 2]);
    expect(aimed.target).toEqual([0, 0, 1.75 * 0.75]);
    const track = plan({
      camera: {
        ...linear.camera,
        keyframes: [{ time: 0, position: [0, -3, 1.5], target: [0, 0, 1] }],
        follow: { actorId: "walker", mode: "track" },
      },
    });
    const tracked = evaluateCamera(track, 2);
    expect(tracked.position).toEqual([0, -3, 1.5]);
    expect(evaluateCamera(track, 4).position).toEqual([2, -3, 1.5]);
    expect(evaluateCamera(track, 4).target).toEqual([2, 0, 1]);
  });

  it("切换跟随模式时换算关键帧，切换瞬间画面不跳；写入机位时自动换算偏移", () => {
    const world = plan();
    const before = evaluateCamera(world, 0);
    const tracked = { ...world, camera: convertCameraFollow(world, { actorId: "walker", mode: "track" }) };
    expect(tracked.camera.keyframes[0]!.position).toEqual([2, -6, 2]);
    expect(evaluateCamera(tracked, 0)).toEqual(before);
    const restored = { ...tracked, camera: convertCameraFollow(tracked, null) };
    expect(restored.camera.keyframes[0]!.position).toEqual([0, -6, 2]);
    const keyframe = cameraKeyframeFromWorld(tracked, 4, {
      position: [3, -3, 1],
      target: [2, 0, 1],
    });
    expect(keyframe).toEqual({ time: 4, position: [1, -3, 1], target: [0, 0, 1] });
  });

  it("环绕保持与注视点的距离并改变方位", () => {
    const state = { position: [0, -6, 2] as const, target: [0, 0, 1] as const };
    const orbited = orbitCamera(
      { position: [...state.position], target: [...state.target] },
      90,
      0,
    );
    expect(vec.distance(orbited.position, [0, 0, 1])).toBeCloseTo(vec.distance([0, -6, 2], [0, 0, 1]));
    expect(orbited.position[0]).toBeCloseTo(6);
    expect(orbited.position[1]).toBeCloseTo(0);
  });
});

describe("镜头语言", () => {
  it("垂直视野与 Blender AUTO 传感器一致：横屏按画幅换算，竖屏直接取 36mm", () => {
    const horizontal = (2 * Math.atan(18 / 50)) / DEG;
    expect(verticalFovDegrees(50, 9 / 16)).toBeCloseTo(horizontal, 6);
    expect(verticalFovDegrees(50, 16 / 9)).toBeCloseTo(
      (2 * Math.atan(Math.tan((horizontal / 2) * DEG) / (16 / 9))) / DEG,
      6,
    );
  });

  it("景别求解：全景刚好容纳全身，特写比远景近，仰拍机位低于注视点，方位相对角色朝向", () => {
    const subject = { position: [1, 2, 0] as const, yaw: 90, height: 1.75, isPerson: true };
    const lens = 50;
    const aspect = 16 / 9;
    const full = solveShot({ ...subject, position: [1, 2, 0] }, { size: "full", angle: "eye", direction: "front" }, lens, aspect);
    const distance = vec.distance(full.position, full.target);
    const vfov = verticalFovDegrees(lens, aspect) * DEG;
    const visibleHeight = 2 * distance * Math.tan(vfov / 2);
    expect(visibleHeight).toBeGreaterThan(1.75);
    expect(visibleHeight).toBeLessThan(1.75 * 1.4);
    // 角色面朝 +X，「正面」机位在 +X 一侧。
    expect(full.position[0]).toBeGreaterThan(1);
    expect(full.position[1]).toBeCloseTo(2, 3);
    const extreme = solveShot({ ...subject, position: [1, 2, 0] }, { size: "extreme", angle: "eye", direction: "front" }, lens, aspect);
    const wide = solveShot({ ...subject, position: [1, 2, 0] }, { size: "wide", angle: "eye", direction: "front" }, lens, aspect);
    expect(vec.distance(extreme.position, extreme.target)).toBeLessThan(distance);
    expect(vec.distance(wide.position, wide.target)).toBeGreaterThan(distance);
    const low = solveShot({ ...subject, position: [1, 2, 0] }, { size: "medium", angle: "low", direction: "back" }, lens, aspect);
    expect(low.position[2]).toBeLessThan(low.target[2]);
    expect(low.position[0]).toBeLessThan(1);
  });

  it("运镜预设：推镜结束于基准机位，环绕保持距离且首尾对称", () => {
    const base = { position: [0, -6, 2] as const, target: [0, 0, 1] as const };
    const push = cameraMoveKeyframes({ position: [...base.position], target: [...base.target] }, "push_in", 8);
    expect(push).toHaveLength(2);
    expect(push[1]).toEqual({ time: 8, position: [0, -6, 2], target: [0, 0, 1] });
    expect(vec.distance(push[0]!.position, [0, 0, 1])).toBeGreaterThan(vec.distance([0, -6, 2], [0, 0, 1]));
    const arc = cameraMoveKeyframes({ position: [...base.position], target: [...base.target] }, "arc_left", 8);
    expect(arc).toHaveLength(9);
    const radius = vec.distance([0, -6, 2], [0, 0, 1]);
    for (const frame of arc) expect(vec.distance(frame.position, [0, 0, 1])).toBeCloseTo(radius, 3);
    expect(arc[0]!.position[0]).toBeCloseTo(-arc[8]!.position[0], 3);
    expect(arc[0]!.time).toBe(0);
    expect(arc[8]!.time).toBe(8);
  });
});

describe("关键帧工具与烘焙", () => {
  it("自动关键帧：半帧内覆盖已有关键帧，否则按时间插入", () => {
    const frames = [
      { time: 0, value: "a" },
      { time: 2, value: "b" },
    ];
    const overwritten = upsertKeyframe(frames, 2.01, 24, () => ({ time: 99, value: "c" }));
    expect(overwritten).toEqual([
      { time: 0, value: "a" },
      { time: 2, value: "c" },
    ]);
    const inserted = upsertKeyframe(frames, 1, 24, () => ({ time: 99, value: "d" }));
    expect(inserted.map((frame) => frame.time)).toEqual([0, 1, 2]);
  });

  it("烘焙帧数与各通道长度一致，几何体没有关节数据", () => {
    const scene = plan({ objects: [walker(), createWhiteModelObject(1, 4, "box")] });
    const bake = bakeWhiteModelScene(scene);
    expect(bake.frameCount).toBe(40);
    expect(bake.camera).toHaveLength(40 * 6);
    expect(bake.objects[0]!.root).toHaveLength(40 * 4);
    expect(bake.objects[0]!.joints).toHaveLength(40 * JOINT_COUNT * 3);
    expect(bake.objects[1]!.joints).toBeNull();
    // 第 20 帧（2 秒）角色位于原点、面朝 +X。
    expect(bake.objects[0]!.root.slice(80, 84)).toEqual([0, 0, 0, 90]);
  });

  it("方案校验提示缺少角色、时间不递增、机位与注视点重合", () => {
    expect(whiteModelPlanIssue(plan({ objects: [] }))).toContain("至少一个角色");
    const bad = plan();
    bad.objects[0]!.keyframes[1]!.time = 0;
    expect(whiteModelPlanIssue(bad)).toContain("递增");
    const collide = plan();
    collide.camera.keyframes[0]!.target = [...collide.camera.keyframes[0]!.position];
    expect(whiteModelPlanIssue(collide)).toContain("重合");
    expect(whiteModelPlanIssue(createWhiteModelScenePlan())).toBeNull();
  });
});

describe("旧版方案迁移", () => {
  function legacy(motion: WhiteModelScenePlanV1["camera"]["motion"]): WhiteModelScenePlanV1 {
    return {
      version: 1,
      durationSeconds: 8,
      fps: 24,
      width: 960,
      height: 540,
      camera: {
        motion,
        start: [8, -12, 7],
        end: [6, -9, 5],
        target: [0, 0, 1],
        orbitDegrees: 90,
        lens: 50,
      },
      objects: [
        {
          id: "a",
          name: "角色 1",
          shape: "person",
          color: "#dc6868",
          size: 1,
          keyframes: [
            { time: 0, position: [-2, 0, 0], yaw: 0 },
            { time: 8, position: [2, 0, 0], yaw: 45 },
          ],
        },
      ],
    };
  }

  it("四种运镜换算为关键帧，角色保持手动朝向与原尺寸", () => {
    const dolly = migrateWhiteModelScenePlan(legacy("dolly"));
    expect(dolly.version).toBe(2);
    expect(dolly.camera.keyframes).toEqual([
      { time: 0, position: [8, -12, 7], target: [0, 0, 1] },
      { time: 8, position: [6, -9, 5], target: [0, 0, 1] },
    ]);
    expect(migrateWhiteModelScenePlan(legacy("static")).camera.keyframes).toHaveLength(1);
    const orbit = migrateWhiteModelScenePlan(legacy("orbit"));
    const radius = vec.distance([8, -12, 7], [0, 0, 1]);
    expect(orbit.camera.keyframes.length).toBeGreaterThan(2);
    expect(orbit.camera.keyframes[0]!.position).toEqual([8, -12, 7]);
    for (const frame of orbit.camera.keyframes) {
      expect(vec.distance(frame.position, [0, 0, 1])).toBeCloseTo(radius, 3);
    }
    expect(orbit.camera.keyframes.at(-1)!.time).toBe(8);
    expect(dolly.objects[0]).toMatchObject({ facing: "manual", size: 1, motion: { kind: "auto" } });
    expect(evaluateActor(dolly.objects[0]!, 8).yaw).toBe(45);
  });

  it("归一化草稿：旧签名匹配则换算成新签名，成片仍可用；不匹配则保持失配", () => {
    const legacyDraft = {
      ...createWhiteModelStudioDraft(),
      plan: legacy("dolly"),
      jobId: "job-1",
    } as unknown as WhiteModelStudioDraft;
    const legacyRequest = { executablePath: null, sourceBlendPath: null, plan: legacyDraft.plan };
    const matched = normalizeWhiteModelStudioDraft({
      ...legacyDraft,
      jobInputSignature: JSON.stringify(legacyRequest),
    });
    expect(matched.plan.version).toBe(2);
    expect(matched.jobInputSignature).toBe(whiteModelRenderSignature(matched));
    const stale = normalizeWhiteModelStudioDraft({ ...legacyDraft, jobInputSignature: "stale" });
    expect(stale.plan.version).toBe(2);
    expect(stale.jobInputSignature).toBe("stale");
    const fresh = createWhiteModelStudioDraft();
    expect(normalizeWhiteModelStudioDraft(fresh)).toBe(fresh);
  });

  it("渲染请求携带烘焙数据，签名只看方案；导入工程不烘焙", () => {
    const draft = createWhiteModelStudioDraft();
    expect(whiteModelRenderRequest(draft).bake?.frameCount).toBe(8 * 24);
    expect(whiteModelRenderSignature(draft)).not.toContain("frameCount");
    expect(whiteModelRenderRequest({ ...draft, mode: "blend", sourceBlendPath: "C:/a.blend" }).bake).toBeNull();
  });
});
