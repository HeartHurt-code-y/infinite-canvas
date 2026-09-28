import * as v from "valibot";
import type { WhiteModelPosePreset, WhiteModelVector } from "./whiteModelScene";

export type WhiteModelIKLimb = "leftHand" | "rightHand" | "leftFoot" | "rightFoot";
export interface WhiteModelIKTarget {
  /** Actor-local coordinates, in units of character height, before root yaw. */
  position: WhiteModelVector;
  /** A point toward which the elbow/knee bends, in the same coordinate system. */
  pole?: WhiteModelVector;
  weight?: number;
}
export interface WhiteModelMotionRefinementKeyframe {
  time: number;
  /** source keeps the original auto/pose/capture animation underneath this track. */
  pose?: "source" | WhiteModelPosePreset;
  pelvisOffset?: WhiteModelVector;
  /** Euler X, then Y, then Z, in degrees; the torso pivots around the pelvis. */
  torsoRotation?: WhiteModelVector;
  /** Head and nose rotate around the neck, using actor-local axes. */
  headRotation?: WhiteModelVector;
  targets?: Partial<Record<WhiteModelIKLimb, WhiteModelIKTarget>>;
}
export interface WhiteModelMotionRefinement {
  /** Defaults to smooth. First/last controls hold outside the authored interval. */
  interpolation?: "linear" | "smooth";
  keyframes: WhiteModelMotionRefinementKeyframe[];
}

const bounded = (minimum: number, maximum: number) =>
  v.pipe(v.number(), v.finite(), v.minValue(minimum), v.maxValue(maximum));
const vectorSchema = (limit: number) =>
  v.tuple([bounded(-limit, limit), bounded(-limit, limit), bounded(-limit, limit)]);
const targetSchema = v.strictObject({
  position: vectorSchema(4),
  pole: v.exactOptional(vectorSchema(4)),
  weight: v.exactOptional(bounded(0, 1)),
});
export const whiteModelMotionRefinementSchema = v.strictObject({
  interpolation: v.exactOptional(v.picklist(["linear", "smooth"])),
  keyframes: v.pipe(
    v.array(
      v.strictObject({
        time: bounded(0, 30),
        pose: v.exactOptional(
          v.picklist(["source", "stand", "sit", "kneel", "crouch", "reach", "arms_up"]),
        ),
        pelvisOffset: v.exactOptional(vectorSchema(2)),
        torsoRotation: v.exactOptional(vectorSchema(180)),
        headRotation: v.exactOptional(vectorSchema(180)),
        targets: v.exactOptional(
          v.strictObject({
            leftHand: v.exactOptional(targetSchema),
            rightHand: v.exactOptional(targetSchema),
            leftFoot: v.exactOptional(targetSchema),
            rightFoot: v.exactOptional(targetSchema),
          }),
        ),
      }),
    ),
    v.minLength(1),
    v.maxLength(256),
  ),
});

export function parseWhiteModelMotionRefinement(
  value: unknown,
  durationSeconds: number,
): WhiteModelMotionRefinement {
  const result = v.parse(whiteModelMotionRefinementSchema, value);
  if (!Number.isFinite(durationSeconds) || durationSeconds < 1 || durationSeconds > 30) {
    throw new Error("动作精修需要有效的 1–30 秒片长。");
  }
  for (const [index, frame] of result.keyframes.entries()) {
    if (frame.time > durationSeconds) throw new Error("动作精修关键帧不能超出片长。");
    if (index > 0 && frame.time <= result.keyframes[index - 1]!.time) {
      throw new Error("动作精修关键帧时间必须严格递增，不能重复。");
    }
  }
  return result;
}

export function whiteModelMotionRefinementIssue(
  value: unknown,
  durationSeconds: number,
): string | null {
  try {
    parseWhiteModelMotionRefinement(value, durationSeconds);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "动作精修数据无效。";
  }
}

type Pose = readonly WhiteModelVector[];
/** Supplied by whiteModelScene to keep its joint map the sole source of skeleton indices. */
export interface WhiteModelRefinementJoints {
  pelvis: number;
  chest: number;
  neck: number;
  head: number;
  nose: number;
  leftShoulder: number;
  leftElbow: number;
  leftWrist: number;
  rightShoulder: number;
  rightElbow: number;
  rightWrist: number;
  leftHip: number;
  leftKnee: number;
  leftAnkle: number;
  rightHip: number;
  rightKnee: number;
  rightAnkle: number;
}

const EPS = 1e-9;
const ZERO: WhiteModelVector = [0, 0, 0];
const add = (a: WhiteModelVector, b: WhiteModelVector): WhiteModelVector => [
  a[0] + b[0],
  a[1] + b[1],
  a[2] + b[2],
];
const sub = (a: WhiteModelVector, b: WhiteModelVector): WhiteModelVector => [
  a[0] - b[0],
  a[1] - b[1],
  a[2] - b[2],
];
const scale = (a: WhiteModelVector, s: number): WhiteModelVector => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: WhiteModelVector, b: WhiteModelVector) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const length = (a: WhiteModelVector) => Math.hypot(...a);
const distance = (a: WhiteModelVector, b: WhiteModelVector) => length(sub(a, b));
const lerp = (a: WhiteModelVector, b: WhiteModelVector, t: number): WhiteModelVector =>
  add(a, scale(sub(b, a), t));
const unit = (a: WhiteModelVector, fallback: WhiteModelVector): WhiteModelVector => {
  const size = length(a);
  return size > EPS
    ? scale(a, 1 / size)
    : length(fallback) > EPS
      ? scale(fallback, 1 / length(fallback))
      : [0, 0, -1];
};
const copyPose = (pose: Pose) => pose.map((point): WhiteModelVector => [...point]);

function perpendicular(axis: WhiteModelVector): WhiteModelVector {
  const bases: WhiteModelVector[] = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  let least = bases[0]!;
  for (const candidate of bases)
    if (Math.abs(dot(axis, candidate)) < Math.abs(dot(axis, least))) least = candidate;
  return unit(sub(least, scale(axis, dot(least, axis))), [1, 0, 0]);
}

/** Analytic two-bone IK. Unreachable targets clamp to reach; zero-length and collinear inputs stay finite. */
export function solveWhiteModelTwoBoneIK(
  root: WhiteModelVector,
  middle: WhiteModelVector,
  end: WhiteModelVector,
  target: WhiteModelVector,
  pole?: WhiteModelVector,
): { middle: WhiteModelVector; end: WhiteModelVector } {
  const upper = distance(root, middle);
  const lower = distance(middle, end);
  const toward = sub(target, root);
  const axis = unit(toward, sub(end, root));
  if (upper < EPS) return { middle: [...root], end: add(root, scale(axis, lower)) };
  if (lower < EPS) {
    const point = add(root, scale(axis, upper));
    return { middle: point, end: [...point] };
  }
  const reach = Math.min(upper + lower, Math.max(Math.abs(upper - lower), length(toward)));
  // An exactly folded equal-length chain has no unique direction; use its existing bend plane.
  const along = reach > EPS ? (upper * upper - lower * lower + reach * reach) / (2 * reach) : 0;
  const height = Math.sqrt(Math.max(0, upper * upper - along * along));
  const bendHint = sub(pole ?? middle, root);
  let bend = sub(bendHint, scale(axis, dot(bendHint, axis)));
  if (length(bend) < EPS) {
    const oldBend = sub(middle, root);
    bend = sub(oldBend, scale(axis, dot(oldBend, axis)));
  }
  const direction = unit(bend, perpendicular(axis));
  return {
    middle: add(add(root, scale(axis, along)), scale(direction, height)),
    end: add(root, scale(axis, reach)),
  };
}

function bracket(track: WhiteModelMotionRefinement, time: number) {
  const frames = track.keyframes;
  const first = frames[0]!;
  const last = frames.at(-1)!;
  if (time <= first.time) return { a: first, b: first, t: 0 };
  if (time >= last.time) return { a: last, b: last, t: 0 };
  const next = frames.findIndex((frame) => frame.time > time);
  const a = frames[next - 1]!;
  const b = frames[next]!;
  const fraction = (time - a.time) / (b.time - a.time);
  return {
    a,
    b,
    t: track.interpolation === "linear" ? fraction : fraction * fraction * (3 - 2 * fraction),
  };
}

function rotations(
  a: WhiteModelVector | undefined,
  b: WhiteModelVector | undefined,
  t: number,
): WhiteModelVector {
  const first = a ?? ZERO;
  const second = b ?? ZERO;
  const angle = (axis: number) => {
    const delta = ((second[axis]! - first[axis]! + 540) % 360) - 180;
    return first[axis]! + delta * t;
  };
  return [angle(0), angle(1), angle(2)];
}

function rotate(
  point: WhiteModelVector,
  pivot: WhiteModelVector,
  degrees: WhiteModelVector,
): WhiteModelVector {
  let [x, y, z] = sub(point, pivot);
  const [rx, ry, rz] = degrees.map((degree) => (degree * Math.PI) / 180) as WhiteModelVector;
  [y, z] = [y * Math.cos(rx) - z * Math.sin(rx), y * Math.sin(rx) + z * Math.cos(rx)];
  [x, z] = [x * Math.cos(ry) + z * Math.sin(ry), -x * Math.sin(ry) + z * Math.cos(ry)];
  [x, y] = [x * Math.cos(rz) - y * Math.sin(rz), x * Math.sin(rz) + y * Math.cos(rz)];
  return add(pivot, [x, y, z]);
}

function limbs(
  j: WhiteModelRefinementJoints,
): readonly [WhiteModelIKLimb, number, number, number][] {
  return [
    ["leftHand", j.leftShoulder, j.leftElbow, j.leftWrist],
    ["rightHand", j.rightShoulder, j.rightElbow, j.rightWrist],
    ["leftFoot", j.leftHip, j.leftKnee, j.leftAnkle],
    ["rightFoot", j.rightHip, j.rightKnee, j.rightAnkle],
  ];
}

/** Interpolated Cartesian poses are reprojected to the source skeleton, avoiding shrinking bones. */
function constrainPose(
  desired: Pose,
  source: Pose,
  j: WhiteModelRefinementJoints,
): WhiteModelVector[] {
  const pose = copyPose(desired);
  const project = (parent: number, child: number) => {
    const reference = sub(source[child]!, source[parent]!);
    pose[child] = add(
      pose[parent]!,
      scale(unit(sub(desired[child]!, desired[parent]!), reference), length(reference)),
    );
  };
  project(j.pelvis, j.chest);
  project(j.chest, j.neck);
  project(j.neck, j.head);
  project(j.head, j.nose);
  const alignPair = (center: number, left: number, right: number) => {
    const desiredMiddle = scale(add(desired[left]!, desired[right]!), 0.5);
    const sourceMiddle = scale(add(source[left]!, source[right]!), 0.5);
    const originalOffset = sub(sourceMiddle, source[center]!);
    const middle = add(
      pose[center]!,
      scale(unit(sub(desiredMiddle, desired[center]!), originalOffset), length(originalOffset)),
    );
    const half = scale(
      unit(sub(desired[left]!, desired[right]!), sub(source[left]!, source[right]!)),
      distance(source[left]!, source[right]!) / 2,
    );
    pose[left] = add(middle, half);
    pose[right] = sub(middle, half);
  };
  alignPair(j.chest, j.leftShoulder, j.rightShoulder);
  alignPair(j.pelvis, j.leftHip, j.rightHip);
  for (const [, root, middle, end] of limbs(j)) {
    // Translate the original chain to the new root before solving, preserving both original lengths.
    const shift = sub(pose[root]!, source[root]!);
    const solved = solveWhiteModelTwoBoneIK(
      pose[root]!,
      add(source[middle]!, shift),
      add(source[end]!, shift),
      desired[end]!,
      desired[middle],
    );
    pose[middle] = solved.middle;
    pose[end] = solved.end;
  }
  return pose;
}

/** Pure local-space evaluator shared by live preview and the Blender bake. Never mutates source clips. */
export function applyWhiteModelMotionRefinement(
  source: Pose,
  track: WhiteModelMotionRefinement,
  time: number,
  preset: (name: WhiteModelPosePreset) => WhiteModelVector[],
  j: WhiteModelRefinementJoints,
): WhiteModelVector[] {
  if (!track.keyframes.length || !Number.isFinite(time)) return copyPose(source);
  const { a, b, t } = bracket(track, time);
  const first = !a.pose || a.pose === "source" ? source : preset(a.pose);
  const second = !b.pose || b.pose === "source" ? source : preset(b.pose);
  let pose =
    first === source && second === source
      ? copyPose(source)
      : constrainPose(
          first.map((joint, index) => lerp(joint, second[index]!, t)),
          source,
          j,
        );
  const offset = lerp(a.pelvisOffset ?? ZERO, b.pelvisOffset ?? ZERO, t);
  pose = pose.map((joint) => add(joint, offset));
  const torso = rotations(a.torsoRotation, b.torsoRotation, t);
  const upper = [
    j.chest,
    j.neck,
    j.head,
    j.nose,
    j.leftShoulder,
    j.leftElbow,
    j.leftWrist,
    j.rightShoulder,
    j.rightElbow,
    j.rightWrist,
  ];
  for (const index of upper) pose[index] = rotate(pose[index]!, pose[j.pelvis]!, torso);
  const head = rotations(a.headRotation, b.headRotation, t);
  for (const index of [j.head, j.nose]) pose[index] = rotate(pose[index]!, pose[j.neck]!, head);
  for (const [name, root, middle, end] of limbs(j)) {
    const left = a.targets?.[name];
    const right = b.targets?.[name];
    if (!left && !right) continue;
    const weight =
      (left ? (left.weight ?? 1) : 0) * (1 - t) + (right ? (right.weight ?? 1) : 0) * t;
    if (weight <= 0) continue;
    const position = lerp(left?.position ?? right!.position, right?.position ?? left!.position, t);
    const pole =
      left?.pole || right?.pole
        ? lerp(left?.pole ?? pose[middle]!, right?.pole ?? pose[middle]!, t)
        : undefined;
    const solved = solveWhiteModelTwoBoneIK(
      pose[root]!,
      pose[middle]!,
      pose[end]!,
      lerp(pose[end]!, position, weight),
      pole,
    );
    pose[middle] = solved.middle;
    pose[end] = solved.end;
  }
  return pose;
}
