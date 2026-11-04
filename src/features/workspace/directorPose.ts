import * as v from "valibot";

const angle = v.optional(v.pipe(v.number(), v.finite(), v.minValue(-180), v.maxValue(180)));
const bend = v.optional(v.object({ bend: angle }));
const limb = v.optional(v.object({ raise: angle, straddle: angle, turn: angle }));
const trunk = v.optional(v.object({ bend: angle, turn: angle, tilt: angle }));

export const directorPoseSchema = v.object({
  body: trunk, torso: trunk, head: v.optional(v.object({ nod: angle, turn: angle, tilt: angle })),
  l_arm: limb, r_arm: limb, l_elbow: bend, r_elbow: bend, l_leg: limb, r_leg: limb, l_knee: bend, r_knee: bend,
});
export type DirectorPose = v.InferOutput<typeof directorPoseSchema>;

type Joint = keyof DirectorPose;
type Axis = "bend" | "turn" | "tilt" | "nod" | "raise" | "straddle";
type Control = readonly [Joint, Axis, string, number, number];
export const directorJointSections: readonly (readonly [string, readonly Control[]])[] = [
  ["身体", [["body", "bend", "前倾", -90, 90], ["body", "turn", "转身", -90, 90], ["body", "tilt", "侧倾", -45, 45]]],
  ["躯干", [["torso", "bend", "前倾", -45, 45], ["torso", "turn", "扭转", -45, 45], ["torso", "tilt", "侧倾", -30, 30]]],
  ["头部", [["head", "nod", "点头", -60, 60], ["head", "turn", "转头", -90, 90], ["head", "tilt", "歪头", -45, 45]]],
  ["手臂 — 肩", [
    ["l_arm", "raise", "左前举", -90, 180], ["l_arm", "straddle", "左外展", -10, 90], ["l_arm", "turn", "左扭转", -90, 90],
    ["r_arm", "raise", "右前举", -90, 180], ["r_arm", "straddle", "右外展", -10, 90], ["r_arm", "turn", "右扭转", -90, 90],
  ]],
  ["肘部", [["l_elbow", "bend", "左弯曲", 0, 150], ["r_elbow", "bend", "右弯曲", 0, 150]]],
  ["腿部 — 髋", [
    ["l_leg", "raise", "左前抬", -90, 90], ["l_leg", "straddle", "左外展", -10, 90], ["l_leg", "turn", "左扭转", -90, 90],
    ["r_leg", "raise", "右前抬", -90, 90], ["r_leg", "straddle", "右外展", -10, 90], ["r_leg", "turn", "右扭转", -90, 90],
  ]],
  ["膝部", [["l_knee", "bend", "左弯曲", 0, 155], ["r_knee", "bend", "右弯曲", 0, 155]]],
];

export const directorPosePresets: readonly (readonly [string, DirectorPose])[] = [
  ["站立", {}],
  ["T型", { l_arm: { straddle: 90 }, r_arm: { straddle: 90 } }],
  ["行走", { l_arm: { raise: -22 }, r_arm: { raise: 24 }, l_leg: { raise: 25 }, r_leg: { raise: -23 }, r_knee: { bend: 30 } }],
  ["跑步", { torso: { bend: 15 }, l_arm: { raise: -32 }, r_arm: { raise: 45 }, l_elbow: { bend: 78 }, r_elbow: { bend: 90 }, l_leg: { raise: 52 }, r_leg: { raise: -25 }, r_knee: { bend: 93 } }],
  ["坐姿", { l_leg: { raise: 90 }, r_leg: { raise: 90 }, l_knee: { bend: 90 }, r_knee: { bend: 90 }, l_arm: { raise: 12 }, r_arm: { raise: 12 }, l_elbow: { bend: 40 }, r_elbow: { bend: 40 } }],
  ["蹲下", { torso: { bend: 32 }, l_leg: { raise: 67 }, r_leg: { raise: 67 }, l_knee: { bend: 133 }, r_knee: { bend: 133 }, l_arm: { raise: 42 }, r_arm: { raise: 42 } }],
  ["单膝跪", { l_leg: { raise: 83 }, l_knee: { bend: 90 }, r_leg: { raise: -12 }, r_knee: { bend: 91 }, torso: { bend: 10 } }],
  ["双膝跪", { l_knee: { bend: 104 }, r_knee: { bend: 104 }, torso: { bend: 8 } }],
  ["叉腰", { l_arm: { straddle: 30, turn: 54 }, r_arm: { straddle: 30, turn: 54 }, l_elbow: { bend: 88 }, r_elbow: { bend: 88 } }],
  ["倚靠", { body: { tilt: 12 }, l_leg: { straddle: 10 }, r_knee: { bend: 12 } }],
  ["鞠躬", { torso: { bend: 45 }, head: { nod: 20 } }],
  ["思考", { head: { nod: 12, turn: -10 }, r_arm: { raise: 54, straddle: 12 }, r_elbow: { bend: 128 } }],
  ["格斗", { body: { turn: -20 }, l_leg: { raise: 20 }, r_leg: { raise: -19 }, l_knee: { bend: 20 }, r_knee: { bend: 24 }, l_arm: { raise: 55 }, r_arm: { raise: 45 }, l_elbow: { bend: 100 }, r_elbow: { bend: 115 } }],
  ["踢球", { torso: { bend: -10 }, l_leg: { raise: 65 }, l_knee: { bend: 12 }, r_arm: { straddle: 45 } }],
  ["投掷", { torso: { turn: -28 }, r_arm: { raise: 115, straddle: 28 }, r_elbow: { bend: 80 }, l_arm: { raise: 44 }, l_leg: { raise: 17 } }],
  ["推进", { torso: { bend: 18 }, l_arm: { raise: 92 }, r_arm: { raise: 92 }, l_elbow: { bend: 12 }, r_elbow: { bend: 12 } }],
  ["招手", { r_arm: { raise: 120, straddle: 25 }, r_elbow: { bend: 25 }, head: { turn: -10 } }],
  ["伸手", { r_arm: { raise: 90 } }],
  ["抱臂", { l_arm: { raise: 37, turn: 59 }, r_arm: { raise: 37, turn: 59 }, l_elbow: { bend: 109 }, r_elbow: { bend: 109 } }],
  ["看手机", { head: { nod: 25 }, l_arm: { raise: 36 }, r_arm: { raise: 28 }, l_elbow: { bend: 90 }, r_elbow: { bend: 77 } }],
];

export function directorJointAngle(pose: DirectorPose | undefined, joint: Joint, axis: Axis) {
  const angles: Partial<Record<Axis, number | undefined>> | undefined = pose?.[joint];
  return angles?.[axis] ?? 0;
}

export function interpolateDirectorPose(a: DirectorPose, b: DirectorPose, mix: number): DirectorPose {
  const pose: DirectorPose = {};
  for (const [, controls] of directorJointSections) for (const [joint, axis] of controls) {
    const from = directorJointAngle(a, joint, axis);
    const to = directorJointAngle(b, joint, axis);
    if (from || to) pose[joint] = { ...pose[joint], [axis]: from + (to - from) * mix };
  }
  return pose;
}
