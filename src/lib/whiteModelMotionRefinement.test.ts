import { describe, expect, it } from "vitest";
import {
  applyWhiteModelMotionRefinement,
  parseWhiteModelMotionRefinement,
  solveWhiteModelTwoBoneIK,
  whiteModelMotionRefinementIssue,
  type WhiteModelMotionRefinement,
} from "./whiteModelMotionRefinement";
import {
  JOINT,
  SEGMENTS,
  bakeWhiteModelScene,
  encodeMotionClipJoints,
  evaluateActor,
  evaluateJoints,
  presetPose,
  rescalePlanDuration,
  roundTo,
  whiteModelPlanIssue,
  type WhiteModelVector,
} from "./whiteModelScene";
import { createWhiteModelStudioDraft } from "./whiteModelStudio";

const distance = (a: WhiteModelVector, b: WhiteModelVector) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const refine = (track: WhiteModelMotionRefinement, time: number) =>
  applyWhiteModelMotionRefinement(presetPose("stand"), track, time, presetPose, JOINT);

function expectSameBones(actual: readonly WhiteModelVector[], source = presetPose("stand")) {
  for (const [a, b] of SEGMENTS)
    expect(distance(actual[a]!, actual[b]!)).toBeCloseTo(distance(source[a]!, source[b]!), 8);
}

describe("白模动作精修数据与数学", () => {
  it("严格拒绝非有限数、未知字段、重复/倒序/越界时间与非法权重", () => {
    for (const invalid of [
      { keyframes: [] },
      { keyframes: [{ time: NaN }] },
      { keyframes: [{ time: 0 }, { time: 0 }] },
      { keyframes: [{ time: 2 }, { time: 1 }] },
      { keyframes: [{ time: 5 }] },
      { keyframes: [{ time: 0, pelvisOffset: [0, Infinity, 0] }] },
      { keyframes: [{ time: 0, headRotation: [181, 0, 0] }] },
      { keyframes: [{ time: 0, targets: { leftHand: { position: [0, 0, 0], weight: 2 } } }] },
      { keyframes: [{ time: 0, targets: { rightFoot: { position: [0, 0, 5] } } }] },
      { keyframes: [{ time: 0, pose: "fight" }] },
      { keyframes: [{ time: 0 }], python: "print('no')" },
      null,
    ])
      expect(() => parseWhiteModelMotionRefinement(invalid, 4)).toThrow();
    const valid = {
      interpolation: "smooth",
      keyframes: [{ time: 0 }, { time: 4, pose: "crouch" }],
    };
    expect(parseWhiteModelMotionRefinement(valid, 4)).toEqual(valid);
    expect(whiteModelMotionRefinementIssue(valid, 4)).toBeNull();
    expect(whiteModelMotionRefinementIssue(valid, 3)).toContain("超出片长");
  });

  it("两骨IK准确到达可达目标，pole决定弯曲方向且骨长不变", () => {
    const solved = solveWhiteModelTwoBoneIK(
      [0, 0, 0],
      [0, -1, 0],
      [0, -1, -1],
      [1, 0, 0],
      [0, -1, 0],
    );
    expect(solved.end).toEqual([1, 0, 0]);
    expect(solved.middle[1]).toBeLessThan(0);
    expect(distance([0, 0, 0], solved.middle)).toBeCloseTo(1, 9);
    expect(distance(solved.middle, solved.end)).toBeCloseTo(1, 9);
  });

  it("IK不可达、完全折叠、共线pole和零长度骨段均稳定且不拉长骨骼", () => {
    const root: WhiteModelVector = [0, 0, 0];
    for (const [middle, end, target, pole] of [
      [
        [0, 1, 0],
        [0, 2, 0],
        [20, 0, 0],
        [1, 0, 0],
      ],
      [
        [0, 1, 0],
        [0, 2, 0],
        [0, 0, 0],
        [0, 0, 0],
      ],
      [
        [0, 0.5, 0],
        [0, 2, 0],
        [0, 0, 0],
        [0, 1, 0],
      ],
      [
        [0, 0, 0],
        [0, 1, 0],
        [2, 0, 0],
        [0, 0, 0],
      ],
      [
        [0, 1, 0],
        [0, 1, 0],
        [0, 0, 0],
        [0, 1, 0],
      ],
      [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
      ],
    ] as [WhiteModelVector, WhiteModelVector, WhiteModelVector, WhiteModelVector][]) {
      const solved = solveWhiteModelTwoBoneIK(root, middle, end, target, pole);
      expect([...solved.middle, ...solved.end].every(Number.isFinite)).toBe(true);
      expect(distance(root, solved.middle)).toBeCloseTo(distance(root, middle), 8);
      expect(distance(solved.middle, solved.end)).toBeCloseTo(distance(middle, end), 8);
    }
  });

  it("关键帧边界保持，线性与平滑插值按预期计算", () => {
    const linear: WhiteModelMotionRefinement = {
      interpolation: "linear",
      keyframes: [
        { time: 1, pelvisOffset: [0, 0, 0] },
        { time: 5, pelvisOffset: [1, 0, 0] },
      ],
    };
    expect(refine(linear, -1)[JOINT.pelvis]![0]).toBe(0);
    expect(refine(linear, 8)[JOINT.pelvis]![0]).toBe(1);
    expect(refine(linear, 2)[JOINT.pelvis]![0]).toBeCloseTo(0.25, 9);
    expect(refine({ ...linear, interpolation: "smooth" }, 2)[JOINT.pelvis]![0]).toBeCloseTo(
      0.15625,
      9,
    );
  });

  it("按时间编排站立、下蹲、起身伸手与挥手，全程保持源骨长", () => {
    const track: WhiteModelMotionRefinement = {
      keyframes: [
        { time: 0, pose: "stand" },
        { time: 1, pose: "crouch" },
        { time: 2, pose: "reach" },
        {
          time: 3,
          pose: "stand",
          targets: { rightHand: { position: [-0.3, -0.1, 1], pole: [-0.4, 0, 0.9] } },
        },
        {
          time: 4,
          pose: "stand",
          targets: { rightHand: { position: [-0.08, -0.1, 1], pole: [-0.4, 0, 0.9] } },
        },
      ],
    };
    expect(refine(track, 1)[JOINT.pelvis]![2]).toBeLessThan(
      refine(track, 0)[JOINT.pelvis]![2] - 0.2,
    );
    expect(refine(track, 2)[JOINT.rightWrist]![1]).toBeLessThan(-0.3);
    expect(refine(track, 4)[JOINT.rightWrist]![0]).toBeGreaterThan(
      refine(track, 3)[JOINT.rightWrist]![0] + 0.15,
    );
    for (let time = 0; time <= 4; time += 0.1) expectSameBones(refine(track, time));
  });

  it("骨盆移动配合脚部IK可定脚下蹲，躯干和头部转动保持骨长", () => {
    const standing = presetPose("stand");
    const track: WhiteModelMotionRefinement = {
      keyframes: [
        {
          time: 0,
          pelvisOffset: [0, 0, -0.1],
          torsoRotation: [20, 10, 15],
          headRotation: [-10, 0, 45],
          targets: {
            leftFoot: { position: standing[JOINT.leftAnkle]!, pole: [0.1, -1, 0.3] },
            rightFoot: { position: standing[JOINT.rightAnkle]!, pole: [-0.1, -1, 0.3] },
          },
        },
      ],
    };
    const actual = refine(track, 0);
    expectSameBones(actual);
    expect(distance(actual[JOINT.leftAnkle]!, standing[JOINT.leftAnkle]!)).toBeLessThan(1e-8);
    expect(distance(actual[JOINT.rightAnkle]!, standing[JOINT.rightAnkle]!)).toBeLessThan(1e-8);
    expect(actual[JOINT.nose]).not.toEqual(standing[JOINT.nose]);
  });

  it("IK目标进入与退出时按权重过渡，不在关键帧边界瞬间跳变", () => {
    const track: WhiteModelMotionRefinement = {
      interpolation: "linear",
      keyframes: [
        { time: 0 },
        { time: 1, targets: { rightHand: { position: [-0.2, -0.2, 0.85] } } },
        { time: 2 },
      ],
    };
    const original = presetPose("stand")[JOINT.rightWrist]!;
    expect(refine(track, 0)[JOINT.rightWrist]).toEqual(original);
    expect(refine(track, 2)[JOINT.rightWrist]).toEqual(original);
    expect(
      distance(refine(track, 0.999)[JOINT.rightWrist]!, refine(track, 1)[JOINT.rightWrist]!),
    ).toBeLessThan(0.001);
    expect(
      distance(refine(track, 1.001)[JOINT.rightWrist]!, refine(track, 1)[JOINT.rightWrist]!),
    ).toBeLessThan(0.001);
  });

  it("精修覆盖现有动捕而不改原片段，清除后恢复原始动作且角色彼此独立", () => {
    const plan = createWhiteModelStudioDraft().plan;
    const actor = plan.objects[0]!;
    actor.size = 1;
    const captured = presetPose("stand").flat();
    actor.motion = {
      kind: "clip",
      clip: {
        fps: 1,
        frameCount: 1,
        joints: encodeMotionClipJoints(captured),
        sourceName: "actor.mp4",
      },
      startTime: 0,
      speed: 1,
      loop: true,
    };
    const raw = JSON.stringify(actor.motion);
    const state = evaluateActor(actor, 0.5);
    const original = evaluateJoints(actor, state, 0.5)!;
    const other = structuredClone(actor);
    actor.motionRefinement = { keyframes: [{ time: 0, headRotation: [0, 0, 60] }] };
    const refined = evaluateJoints(actor, state, 0.5)!;
    expect(refined[JOINT.nose]).not.toEqual(original[JOINT.nose]);
    expect(evaluateJoints(other, state, 0.5)).toEqual(original);
    expect(JSON.stringify(actor.motion)).toBe(raw);
    delete actor.motionRefinement;
    expect(evaluateJoints(actor, state, 0.5)).toEqual(original);
  });

  it("精修只作用于人形，片长缩放保留控制字段且预览与bake使用同一求值", () => {
    const plan = createWhiteModelStudioDraft().plan;
    plan.durationSeconds = 4;
    plan.fps = 8;
    const actor = plan.objects[0]!;
    actor.keyframes = [
      { time: 0, position: [0, 0, 0], yaw: 0 },
      { time: 4, position: [1, 0, 0], yaw: 90 },
    ];
    actor.motionRefinement = {
      interpolation: "linear",
      keyframes: [
        { time: 0, pose: "stand" },
        { time: 2, pose: "crouch" },
        { time: 4, pose: "reach", headRotation: [0, 0, 20] },
      ],
    };
    expect(whiteModelPlanIssue(plan)).toBeNull();
    expect(whiteModelPlanIssue({ ...plan, objects: [{ ...actor, shape: "box" }] })).toContain(
      "不是人形",
    );
    const shorter = rescalePlanDuration(plan, 2);
    expect(shorter.objects[0]!.motionRefinement?.keyframes.map((frame) => frame.time)).toEqual([
      0, 1, 2,
    ]);
    expect(shorter.objects[0]!.motionRefinement?.keyframes[2]?.headRotation).toEqual([0, 0, 20]);
    expect(whiteModelPlanIssue(shorter)).toBeNull();
    expect(actor.motionRefinement.keyframes[2]!.time).toBe(4);
    const closeKeys = rescalePlanDuration(
      {
        ...plan,
        objects: [
          { ...actor, motionRefinement: { keyframes: [{ time: 1.0001 }, { time: 1.0002 }] } },
        ],
      },
      2,
    );
    const times = closeKeys.objects[0]!.motionRefinement!.keyframes.map((frame) => frame.time);
    expect(times[1]! - times[0]!).toBeGreaterThan(0);
    expect(whiteModelPlanIssue(closeKeys)).toBeNull();
    const fractionalTail = rescalePlanDuration(
      {
        ...plan,
        durationSeconds: 7,
        objects: [{ ...actor, motionRefinement: { keyframes: [{ time: 0 }, { time: 7 }] } }],
      },
      29,
    );
    expect(fractionalTail.objects[0]!.motionRefinement!.keyframes[1]!.time).toBe(29);
    expect(whiteModelPlanIssue(fractionalTail)).toBeNull();
    const baked = bakeWhiteModelScene(shorter);
    const changed = shorter.objects[0]!;
    for (let frame = 0; frame < baked.frameCount; frame++) {
      const time = frame / shorter.fps;
      const expected = evaluateJoints(changed, evaluateActor(changed, time), time)!
        .flat()
        .map((value) => roundTo(value));
      expect(baked.objects[0]!.joints!.slice(frame * 51, (frame + 1) * 51)).toEqual(expected);
    }
  });
});
