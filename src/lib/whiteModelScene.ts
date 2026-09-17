/**
 * 白模导演台的场景模型：类型、v1 迁移、求值、人形骨架、动捕片段、烘焙与镜头语言求解。
 *
 * 这里是唯一的运动学真源：Three.js 实时视口逐帧调用同一套求值函数，Blender 渲染则接收
 * 由 `bakeWhiteModelScene` 烘出的逐帧数据，因此「预览所见」与「渲染所得」由构造保证一致，
 * 不存在 TypeScript 与 Python 各写一份插值逻辑而彼此漂移的问题。
 *
 * 坐标约定与 Blender 相同：Z 轴向上，单位为米；角色朝向 yaw 为绕 Z 轴逆时针角度（度），
 * yaw = 0 时面朝 -Y（默认机位所在方向）。人形的 `size` 即身高（米）。
 */

export type WhiteModelVector = [number, number, number];

export type WhiteModelShape = "box" | "sphere" | "cylinder" | "person";
export type WhiteModelFacing = "path" | "manual";
export type WhiteModelPosePreset = "stand" | "sit" | "kneel" | "crouch" | "reach" | "arms_up";
export type WhiteModelCameraInterpolation = "linear" | "smooth";
export type WhiteModelFollowMode = "aim" | "track";

export interface WhiteModelPathKeyframe {
  time: number;
  position: WhiteModelVector;
  yaw: number;
}

export interface WhiteModelMotionClip {
  /** 采样帧率；与场景帧率不同也没关系，求值时按时间线性插值。 */
  fps: number;
  frameCount: number;
  /** base64 小端 int16，单位 1/10000 身高；共 frameCount × 17 × 3 个数。 */
  joints: string;
  sourceName: string;
}

export type WhiteModelMotion =
  | { kind: "auto" }
  | { kind: "pose"; pose: WhiteModelPosePreset }
  | { kind: "clip"; clip: WhiteModelMotionClip; startTime: number; loop: boolean; speed: number };

export interface WhiteModelObject {
  id: string;
  name: string;
  shape: WhiteModelShape;
  color: string;
  /** 人形为身高（米）；其它几何体为边长或直径。 */
  size: number;
  facing: WhiteModelFacing;
  keyframes: WhiteModelPathKeyframe[];
  motion: WhiteModelMotion;
}

export interface WhiteModelCameraKeyframe {
  time: number;
  position: WhiteModelVector;
  target: WhiteModelVector;
}

export interface WhiteModelCameraFollow {
  actorId: string;
  /** aim：只让注视点跟着角色；track：机位与注视点都相对角色（关键帧存储的是相对偏移）。 */
  mode: WhiteModelFollowMode;
}

export interface WhiteModelCamera {
  /** 焦距（毫米），36mm 传感器，与 Blender 的 AUTO 传感器适配一致。 */
  lens: number;
  interpolation: WhiteModelCameraInterpolation;
  keyframes: WhiteModelCameraKeyframe[];
  follow: WhiteModelCameraFollow | null;
}

export interface WhiteModelScenePlan {
  version: 2;
  durationSeconds: number;
  fps: number;
  width: number;
  height: number;
  camera: WhiteModelCamera;
  objects: WhiteModelObject[];
}

/** 旧版（v1）方案：固定四种运镜 + 单一注视点；仅用于迁移。 */
export interface WhiteModelScenePlanV1 {
  version: 1;
  durationSeconds: number;
  fps: number;
  width: number;
  height: number;
  camera: {
    motion: "static" | "dolly" | "truck" | "orbit";
    start: WhiteModelVector;
    end: WhiteModelVector;
    target: WhiteModelVector;
    orbitDegrees: number;
    lens: number;
  };
  objects: {
    id: string;
    name: string;
    shape: WhiteModelShape;
    color: string;
    size: number;
    keyframes: WhiteModelPathKeyframe[];
  }[];
}

export interface WhiteModelActorState {
  position: WhiteModelVector;
  /** 度 */
  yaw: number;
  /** 米/秒 */
  speed: number;
  /** 步行相位（弧度，单调递增） */
  phase: number;
}

export interface WhiteModelCameraState {
  position: WhiteModelVector;
  target: WhiteModelVector;
}

export interface WhiteModelBakedObject {
  id: string;
  /** frameCount × 4：x, y, z, yaw（度） */
  root: number[];
  /** 人形：frameCount × 17 × 3 局部关节坐标（米，未旋转）；其它几何体为 null。 */
  joints: number[] | null;
}

export interface WhiteModelBake {
  frameCount: number;
  /** frameCount × 6：机位 xyz + 注视点 xyz */
  camera: number[];
  objects: WhiteModelBakedObject[];
}

// ---------------------------------------------------------------------------
// 向量
// ---------------------------------------------------------------------------

const EPSILON = 1e-9;

export const vec = {
  add: (a: WhiteModelVector, b: WhiteModelVector): WhiteModelVector => [
    a[0] + b[0],
    a[1] + b[1],
    a[2] + b[2],
  ],
  sub: (a: WhiteModelVector, b: WhiteModelVector): WhiteModelVector => [
    a[0] - b[0],
    a[1] - b[1],
    a[2] - b[2],
  ],
  scale: (a: WhiteModelVector, s: number): WhiteModelVector => [a[0] * s, a[1] * s, a[2] * s],
  lerp: (a: WhiteModelVector, b: WhiteModelVector, t: number): WhiteModelVector => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ],
  length: (a: WhiteModelVector): number => Math.hypot(a[0], a[1], a[2]),
  distance: (a: WhiteModelVector, b: WhiteModelVector): number =>
    Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
  normalize: (a: WhiteModelVector): WhiteModelVector => {
    const length = Math.hypot(a[0], a[1], a[2]);
    return length < EPSILON ? [0, 0, 0] : [a[0] / length, a[1] / length, a[2] / length];
  },
  cross: (a: WhiteModelVector, b: WhiteModelVector): WhiteModelVector => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ],
  round: (a: WhiteModelVector, digits = 4): WhiteModelVector => [
    roundTo(a[0], digits),
    roundTo(a[1], digits),
    roundTo(a[2], digits),
  ],
};

export function roundTo(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

const DEG = Math.PI / 180;

/** yaw = 0 面朝 -Y；逆时针为正。 */
export function forwardFromYaw(yawDegrees: number): WhiteModelVector {
  const radians = yawDegrees * DEG;
  return [Math.sin(radians), -Math.cos(radians), 0];
}

/** 由地面方向求 yaw（度）；零向量返回 0。 */
export function yawFromDirection(direction: WhiteModelVector): number {
  if (Math.hypot(direction[0], direction[1]) < EPSILON) return 0;
  return Math.atan2(direction[0], -direction[1]) / DEG;
}

/** 把 yaw 差值折到 (-180, 180]，用于角度插值。 */
export function lerpAngle(from: number, to: number, t: number): number {
  let delta = (((to - from) % 360) + 360) % 360;
  if (delta > 180) delta -= 360;
  return from + delta * t;
}

/** 绕 Z 轴旋转局部坐标（度）。 */
export function rotateAboutZ(point: WhiteModelVector, yawDegrees: number): WhiteModelVector {
  const radians = yawDegrees * DEG;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [point[0] * cos - point[1] * sin, point[0] * sin + point[1] * cos, point[2]];
}

// ---------------------------------------------------------------------------
// 帧数与视野
// ---------------------------------------------------------------------------

export function whiteModelFrameCount(plan: Pick<WhiteModelScenePlan, "durationSeconds" | "fps">) {
  return Math.max(1, Math.floor(plan.durationSeconds * plan.fps + 0.5));
}

export const CAMERA_SENSOR_WIDTH_MM = 36;

/**
 * 垂直视野（度）。Blender 相机默认 AUTO 传感器适配：36mm 传感器对应画面较长的一边，
 * Three.js 的 PerspectiveCamera 使用垂直视野，因此横屏时由水平视野按画幅换算。
 */
export function verticalFovDegrees(lens: number, aspect: number): number {
  const half = Math.atan(CAMERA_SENSOR_WIDTH_MM / 2 / Math.max(1, lens));
  if (aspect >= 1) return (2 * Math.atan(Math.tan(half) / aspect)) / DEG;
  return (2 * half) / DEG;
}

// ---------------------------------------------------------------------------
// 关键帧工具
// ---------------------------------------------------------------------------

function sortedByTime<T extends { time: number }>(frames: readonly T[]): T[] {
  return [...frames].sort((a, b) => a.time - b.time);
}

/**
 * 在时间 `time` 写入关键帧：命中已有关键帧（容差半帧）就覆盖，否则插入并保持时间递增。
 * 这是视口里「拖到哪算哪」的自动关键帧语义。
 */
export function upsertKeyframe<T extends { time: number }>(
  frames: readonly T[],
  time: number,
  fps: number,
  build: (existing: T | null) => T,
): T[] {
  const tolerance = 0.5 / Math.max(1, fps);
  const index = frames.findIndex((frame) => Math.abs(frame.time - time) <= tolerance);
  if (index >= 0) {
    const next = [...frames];
    next[index] = { ...build(frames[index]!), time: frames[index]!.time };
    return next;
  }
  return sortedByTime([...frames, { ...build(null), time }]);
}

export function nearestKeyframeIndex(
  frames: readonly { time: number }[],
  time: number,
  fps: number,
): number {
  const tolerance = 0.5 / Math.max(1, fps);
  return frames.findIndex((frame) => Math.abs(frame.time - time) <= tolerance);
}

/** 片长改变时把所有关键帧时间按比例缩放，保持相对节奏。 */
export function rescalePlanDuration(
  plan: WhiteModelScenePlan,
  durationSeconds: number,
): WhiteModelScenePlan {
  const factor = durationSeconds / plan.durationSeconds;
  const scaleTime = (time: number) => roundTo(time * factor, 3);
  return {
    ...plan,
    durationSeconds,
    camera: {
      ...plan.camera,
      keyframes: plan.camera.keyframes.map((frame) => ({ ...frame, time: scaleTime(frame.time) })),
    },
    objects: plan.objects.map((actor) => ({
      ...actor,
      keyframes: actor.keyframes.map((frame) => ({ ...frame, time: scaleTime(frame.time) })),
      motion:
        actor.motion.kind === "clip"
          ? { ...actor.motion, startTime: scaleTime(actor.motion.startTime) }
          : actor.motion,
    })),
  };
}

// ---------------------------------------------------------------------------
// 角色路径求值
// ---------------------------------------------------------------------------

/** 常见步速 1.4 m/s 作为「正常步行」基准。 */
const WALK_SPEED = 1.4;
const TURN_BLEND_SECONDS = 0.25;
const MOVING_SPEED = 0.05;

function strideMeters(height: number, speed: number): number {
  const factor = clamp(speed / WALK_SPEED, 0, 2.2);
  return height * (0.5 + 0.25 * factor);
}

interface PathSegment {
  start: WhiteModelPathKeyframe;
  end: WhiteModelPathKeyframe;
  direction: WhiteModelVector;
  speed: number;
  heading: number;
  phaseStart: number;
  phaseRate: number;
}

const segmentCache = new WeakMap<WhiteModelObject, PathSegment[]>();

function pathSegments(actor: WhiteModelObject): PathSegment[] {
  const cached = segmentCache.get(actor);
  if (cached) return cached;
  const frames = sortedByTime(actor.keyframes);
  const segments: PathSegment[] = [];
  let phase = 0;
  let lastHeading = frames[0]?.yaw ?? 0;
  let firstMovingHeading: number | null = null;
  for (let index = 0; index + 1 < frames.length; index += 1) {
    const start = frames[index]!;
    const end = frames[index + 1]!;
    const delta = vec.sub(end.position, start.position);
    const duration = Math.max(EPSILON, end.time - start.time);
    const distance = vec.length(delta);
    const speed = distance / duration;
    const moving = speed > MOVING_SPEED;
    const heading = moving ? yawFromDirection(delta) : lastHeading;
    if (moving && firstMovingHeading == null) firstMovingHeading = heading;
    const stride = strideMeters(actor.shape === "person" ? actor.size : 1, speed);
    const phaseRate = moving ? (2 * Math.PI * speed) / stride : 0;
    segments.push({
      start,
      end,
      direction: vec.normalize(delta),
      speed,
      heading,
      phaseStart: phase,
      phaseRate,
    });
    phase += phaseRate * duration;
    lastHeading = heading;
  }
  // 起步前静止的段沿用第一段有效运动方向，避免角色先背对再转身。
  if (firstMovingHeading != null) {
    for (const segment of segments) {
      if (segment.speed > MOVING_SPEED) break;
      segment.heading = firstMovingHeading;
    }
  }
  segmentCache.set(actor, segments);
  return segments;
}

function pathHeading(segments: PathSegment[], index: number, time: number): number {
  const segment = segments[index]!;
  const previous = segments[index - 1];
  const next = segments[index + 1];
  const blend = (from: number, to: number, boundary: number, halfWindow: number) =>
    lerpAngle(from, to, clamp((time - (boundary - halfWindow)) / (2 * halfWindow), 0, 1));
  if (previous && previous.heading !== segment.heading) {
    const halfWindow = Math.min(
      TURN_BLEND_SECONDS,
      (segment.end.time - segment.start.time) / 2,
      (previous.end.time - previous.start.time) / 2,
    );
    if (time < segment.start.time + halfWindow)
      return blend(previous.heading, segment.heading, segment.start.time, halfWindow);
  }
  if (next && next.heading !== segment.heading) {
    const halfWindow = Math.min(
      TURN_BLEND_SECONDS,
      (segment.end.time - segment.start.time) / 2,
      (next.end.time - next.start.time) / 2,
    );
    if (time > segment.end.time - halfWindow)
      return blend(segment.heading, next.heading, segment.end.time, halfWindow);
  }
  return segment.heading;
}

/** 角色在时间 t 的根变换与运动状态。路径为线性插值，与 Blender 的 LINEAR 关键帧一致。 */
export function evaluateActor(actor: WhiteModelObject, time: number): WhiteModelActorState {
  const frames = sortedByTime(actor.keyframes);
  const first = frames[0];
  if (!first) return { position: [0, 0, 0], yaw: 0, speed: 0, phase: 0 };
  const segments = pathSegments(actor);
  const last = frames.at(-1)!;
  if (time <= first.time || segments.length === 0) {
    const heading = segments[0]?.heading ?? first.yaw;
    return {
      position: first.position,
      yaw: actor.facing === "path" ? heading : first.yaw,
      speed: 0,
      phase: 0,
    };
  }
  if (time >= last.time) {
    const tail = segments.at(-1)!;
    return {
      position: last.position,
      yaw: actor.facing === "path" ? tail.heading : last.yaw,
      speed: 0,
      phase: tail.phaseStart + tail.phaseRate * (tail.end.time - tail.start.time),
    };
  }
  let index = segments.findIndex((segment) => time < segment.end.time);
  if (index < 0) index = segments.length - 1;
  const segment = segments[index]!;
  const local = time - segment.start.time;
  const factor = clamp(local / Math.max(EPSILON, segment.end.time - segment.start.time), 0, 1);
  return {
    position: vec.lerp(segment.start.position, segment.end.position, factor),
    yaw:
      actor.facing === "path"
        ? pathHeading(segments, index, time)
        : lerpAngle(segment.start.yaw, segment.end.yaw, factor),
    speed: segment.speed,
    phase: segment.phaseStart + segment.phaseRate * local,
  };
}

// ---------------------------------------------------------------------------
// 人形骨架
// ---------------------------------------------------------------------------

export const JOINT = {
  pelvis: 0,
  chest: 1,
  neck: 2,
  head: 3,
  leftShoulder: 4,
  leftElbow: 5,
  leftWrist: 6,
  rightShoulder: 7,
  rightElbow: 8,
  rightWrist: 9,
  leftHip: 10,
  leftKnee: 11,
  leftAnkle: 12,
  rightHip: 13,
  rightKnee: 14,
  rightAnkle: 15,
  nose: 16,
} as const;

export const JOINT_COUNT = 17;

/** 关节球半径（身高比例）；头部与鼻尖单独放大/缩小以表达朝向。 */
export const JOINT_RADIUS: readonly number[] = [
  0.06, 0.06, 0.03, 0.075, 0.036, 0.03, 0.03, 0.036, 0.03, 0.03, 0.05, 0.045, 0.045, 0.05, 0.045,
  0.045, 0.022,
];

/** 骨段：起点关节、终点关节、半径（身高比例）。 */
export const SEGMENTS: readonly (readonly [number, number, number])[] = [
  [JOINT.pelvis, JOINT.chest, 0.085],
  [JOINT.chest, JOINT.neck, 0.03],
  [JOINT.neck, JOINT.head, 0.03],
  [JOINT.leftShoulder, JOINT.rightShoulder, 0.035],
  [JOINT.leftHip, JOINT.rightHip, 0.045],
  [JOINT.leftShoulder, JOINT.leftElbow, 0.032],
  [JOINT.leftElbow, JOINT.leftWrist, 0.028],
  [JOINT.rightShoulder, JOINT.rightElbow, 0.032],
  [JOINT.rightElbow, JOINT.rightWrist, 0.028],
  [JOINT.leftHip, JOINT.leftKnee, 0.05],
  [JOINT.leftKnee, JOINT.leftAnkle, 0.04],
  [JOINT.rightHip, JOINT.rightKnee, 0.05],
  [JOINT.rightKnee, JOINT.rightAnkle, 0.04],
];

/** 单位身高（H = 1）、面朝 -Y、左侧为 +X 的站立姿势。 */
const REST_POSE: readonly WhiteModelVector[] = [
  [0, 0, 0.53],
  [0, 0, 0.78],
  [0, 0, 0.86],
  [0, 0, 0.93],
  [0.12, 0, 0.81],
  [0.14, 0, 0.62],
  [0.15, -0.02, 0.44],
  [-0.12, 0, 0.81],
  [-0.14, 0, 0.62],
  [-0.15, -0.02, 0.44],
  [0.07, 0, 0.52],
  [0.075, -0.005, 0.28],
  [0.08, 0, 0.045],
  [-0.07, 0, 0.52],
  [-0.075, -0.005, 0.28],
  [-0.08, 0, 0.045],
  [0, -0.075, 0.92],
];

const THIGH = 0.24;
const SHIN = 0.235;
const UPPER_ARM = 0.19;
const FOREARM = 0.18;
const ANKLE_CLEARANCE = 0.045;

type UnitPose = WhiteModelVector[];

function restPose(): UnitPose {
  return REST_POSE.map((joint) => [...joint] as WhiteModelVector);
}

function shiftJoints(pose: UnitPose, indices: readonly number[], offset: WhiteModelVector) {
  for (const index of indices) pose[index] = vec.add(pose[index]!, offset);
}

const UPPER_BODY = [
  JOINT.pelvis,
  JOINT.chest,
  JOINT.neck,
  JOINT.head,
  JOINT.leftShoulder,
  JOINT.leftElbow,
  JOINT.leftWrist,
  JOINT.rightShoulder,
  JOINT.rightElbow,
  JOINT.rightWrist,
  JOINT.leftHip,
  JOINT.rightHip,
  JOINT.nose,
];

/** 前向 -Y：`forward` 为正表示向前伸。 */
function limb(
  origin: WhiteModelVector,
  length: number,
  forwardAngle: number,
  lateral = 0,
): WhiteModelVector {
  return [
    origin[0] + lateral,
    origin[1] - length * Math.sin(forwardAngle),
    origin[2] - length * Math.cos(forwardAngle),
  ];
}

/** 步行/奔跑循环：phase 为弧度，speedFactor = 速度 / 1.4 m/s。 */
export function locomotionPose(phase: number, speedFactor: number): UnitPose {
  const pose = restPose();
  const run = speedFactor > 1.7;
  const swing = 0.3 + 0.25 * Math.min(speedFactor, 1.6);
  const kneeFlex = run ? 1.4 : 0.9;
  const armSwing = swing * (run ? 0.8 : 0.55);
  const lean = 0.015 * Math.min(speedFactor, 2.2);
  for (const [hip, knee, ankle, sign] of [
    [JOINT.leftHip, JOINT.leftKnee, JOINT.leftAnkle, 1],
    [JOINT.rightHip, JOINT.rightKnee, JOINT.rightAnkle, -1],
  ] as const) {
    const legPhase = phase + (sign > 0 ? 0 : Math.PI);
    const thighAngle = swing * Math.sin(legPhase);
    const flex = kneeFlex * Math.max(0, Math.cos(legPhase));
    pose[knee] = limb(pose[hip]!, THIGH, thighAngle);
    pose[ankle] = limb(pose[knee]!, SHIN, thighAngle - flex);
  }
  for (const [shoulder, elbow, wrist, sign] of [
    [JOINT.leftShoulder, JOINT.leftElbow, JOINT.leftWrist, 1],
    [JOINT.rightShoulder, JOINT.rightElbow, JOINT.rightWrist, -1],
  ] as const) {
    // 手臂与同侧腿反向摆动。
    const armPhase = phase + (sign > 0 ? Math.PI : 0);
    const upper = armSwing * Math.sin(armPhase);
    const bend = run ? 1.5 : 0.35 + 0.45 * Math.max(0, Math.sin(armPhase));
    pose[elbow] = limb(pose[shoulder]!, UPPER_ARM, upper, sign * 0.02);
    pose[wrist] = limb(pose[elbow]!, FOREARM, upper + bend, sign * 0.01);
  }
  // 站立腿的脚踝落地：用最低脚踝把整个身体抬到地面。
  const lowest = Math.min(pose[JOINT.leftAnkle]![2], pose[JOINT.rightAnkle]![2]);
  const lift = ANKLE_CLEARANCE - lowest;
  for (const joint of pose) joint[2] += lift;
  // 身体随速度略向前倾。
  shiftJoints(
    pose,
    [JOINT.chest, JOINT.neck, JOINT.head, JOINT.leftShoulder, JOINT.rightShoulder, JOINT.nose],
    [0, -lean, 0],
  );
  shiftJoints(pose, [JOINT.head, JOINT.nose], [0, -lean, 0]);
  return pose;
}

/** 静止时的微小呼吸起伏，保证白模不像冻住的雕像。 */
export function idlePose(time: number): UnitPose {
  const pose = restPose();
  const breathe = 0.004 * Math.sin(time * 2.2);
  shiftJoints(
    pose,
    [JOINT.chest, JOINT.neck, JOINT.head, JOINT.leftShoulder, JOINT.rightShoulder, JOINT.nose],
    [0, 0, breathe],
  );
  return pose;
}

export const POSE_PRESETS: readonly { value: WhiteModelPosePreset; label: string }[] = [
  { value: "stand", label: "站立" },
  { value: "sit", label: "坐姿" },
  { value: "kneel", label: "单膝跪" },
  { value: "crouch", label: "下蹲" },
  { value: "reach", label: "伸手" },
  { value: "arms_up", label: "举手" },
];

export function presetPose(preset: WhiteModelPosePreset): UnitPose {
  const pose = restPose();
  switch (preset) {
    case "stand":
      return pose;
    case "sit": {
      shiftJoints(pose, UPPER_BODY, [0, 0, -0.23]);
      pose[JOINT.leftKnee] = [0.075, -0.24, 0.3];
      pose[JOINT.rightKnee] = [-0.075, -0.24, 0.3];
      pose[JOINT.leftAnkle] = [0.08, -0.24, ANKLE_CLEARANCE];
      pose[JOINT.rightAnkle] = [-0.08, -0.24, ANKLE_CLEARANCE];
      pose[JOINT.leftElbow] = [0.14, -0.05, 0.42];
      pose[JOINT.rightElbow] = [-0.14, -0.05, 0.42];
      pose[JOINT.leftWrist] = [0.09, -0.18, 0.33];
      pose[JOINT.rightWrist] = [-0.09, -0.18, 0.33];
      return pose;
    }
    case "kneel": {
      shiftJoints(pose, UPPER_BODY, [0, 0, -0.23]);
      pose[JOINT.leftKnee] = [0.075, -0.2, 0.28];
      pose[JOINT.leftAnkle] = [0.08, -0.22, ANKLE_CLEARANCE];
      pose[JOINT.rightKnee] = [-0.075, 0.02, 0.05];
      pose[JOINT.rightAnkle] = [-0.08, 0.25, ANKLE_CLEARANCE];
      pose[JOINT.leftElbow] = [0.14, -0.05, 0.42];
      pose[JOINT.rightElbow] = [-0.14, -0.05, 0.42];
      pose[JOINT.leftWrist] = [0.09, -0.2, 0.33];
      pose[JOINT.rightWrist] = [-0.12, -0.08, 0.26];
      return pose;
    }
    case "crouch": {
      shiftJoints(pose, UPPER_BODY, [0, -0.08, -0.28]);
      pose[JOINT.leftKnee] = [0.12, -0.2, 0.25];
      pose[JOINT.rightKnee] = [-0.12, -0.2, 0.25];
      pose[JOINT.leftAnkle] = [0.1, -0.05, ANKLE_CLEARANCE];
      pose[JOINT.rightAnkle] = [-0.1, -0.05, ANKLE_CLEARANCE];
      pose[JOINT.leftElbow] = [0.14, -0.2, 0.4];
      pose[JOINT.rightElbow] = [-0.14, -0.2, 0.4];
      pose[JOINT.leftWrist] = [0.1, -0.28, 0.3];
      pose[JOINT.rightWrist] = [-0.1, -0.28, 0.3];
      return pose;
    }
    case "reach": {
      pose[JOINT.rightElbow] = [-0.1, -0.17, 0.8];
      pose[JOINT.rightWrist] = [-0.08, -0.35, 0.8];
      return pose;
    }
    case "arms_up": {
      pose[JOINT.leftElbow] = [0.17, 0, 0.95];
      pose[JOINT.rightElbow] = [-0.17, 0, 0.95];
      pose[JOINT.leftWrist] = [0.15, 0, 1.12];
      pose[JOINT.rightWrist] = [-0.15, 0, 1.12];
      return pose;
    }
  }
}

// ---------------------------------------------------------------------------
// 动捕片段编解码与求值
// ---------------------------------------------------------------------------

const CLIP_UNIT = 1 / 10000;
const CLIP_LIMIT = 32767 * CLIP_UNIT;

/** 把单位身高关节序列（frameCount × 17 × 3）编码为 base64 小端 int16。 */
export function encodeMotionClipJoints(joints: ArrayLike<number>): string {
  const bytes = new Uint8Array(joints.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < joints.length; index += 1) {
    const value = clamp(joints[index]!, -CLIP_LIMIT, CLIP_LIMIT);
    view.setInt16(index * 2, Math.round(value / CLIP_UNIT), true);
  }
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

export function decodeMotionClipJoints(encoded: string, frameCount: number): Float32Array {
  const binary = atob(encoded);
  const expected = frameCount * JOINT_COUNT * 3;
  if (binary.length !== expected * 2) throw new Error("动捕片段数据长度与帧数不符。");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const view = new DataView(bytes.buffer);
  const joints = new Float32Array(expected);
  for (let index = 0; index < expected; index += 1) {
    joints[index] = view.getInt16(index * 2, true) * CLIP_UNIT;
  }
  return joints;
}

const clipCache = new WeakMap<WhiteModelMotionClip, Float32Array>();

function clipJoints(clip: WhiteModelMotionClip): Float32Array {
  let joints = clipCache.get(clip);
  if (!joints) {
    joints = decodeMotionClipJoints(clip.joints, clip.frameCount);
    clipCache.set(clip, joints);
  }
  return joints;
}

function clipPose(
  motion: Extract<WhiteModelMotion, { kind: "clip" }>,
  time: number,
): UnitPose {
  const { clip } = motion;
  const joints = clipJoints(clip);
  const local = Math.max(0, (time - motion.startTime) * Math.max(0.01, motion.speed));
  let frame = local * clip.fps;
  const lastFrame = clip.frameCount - 1;
  let next: number;
  if (motion.loop && clip.frameCount > 1) {
    frame %= clip.frameCount;
    next = (Math.floor(frame) + 1) % clip.frameCount;
  } else {
    frame = Math.min(frame, lastFrame);
    next = Math.min(Math.floor(frame) + 1, lastFrame);
  }
  const base = Math.floor(frame);
  const blend = frame - base;
  const pose: UnitPose = [];
  for (let joint = 0; joint < JOINT_COUNT; joint += 1) {
    const a = (base * JOINT_COUNT + joint) * 3;
    const b = (next * JOINT_COUNT + joint) * 3;
    pose.push([
      joints[a]! + (joints[b]! - joints[a]!) * blend,
      joints[a + 1]! + (joints[b + 1]! - joints[a + 1]!) * blend,
      joints[a + 2]! + (joints[b + 2]! - joints[a + 2]!) * blend,
    ]);
  }
  return pose;
}

/**
 * 人形在时间 t 的局部关节坐标（米；已按身高缩放，未按 yaw 旋转、未平移到根位置）。
 * 非人形返回 null。
 */
export function evaluateJoints(
  actor: WhiteModelObject,
  state: WhiteModelActorState,
  time: number,
): WhiteModelVector[] | null {
  if (actor.shape !== "person") return null;
  let pose: UnitPose;
  switch (actor.motion.kind) {
    case "pose":
      pose = presetPose(actor.motion.pose);
      break;
    case "clip":
      pose = clipPose(actor.motion, time);
      break;
    default:
      pose =
        state.speed > MOVING_SPEED
          ? locomotionPose(state.phase, state.speed / WALK_SPEED)
          : idlePose(time);
  }
  return pose.map((joint) => vec.scale(joint, actor.size));
}

/** 把局部关节坐标变换到世界坐标。 */
export function jointsToWorld(
  joints: readonly WhiteModelVector[],
  state: WhiteModelActorState,
): WhiteModelVector[] {
  return joints.map((joint) => vec.add(rotateAboutZ(joint, state.yaw), state.position));
}

/** 角色顶部高度（米），用于机位注视与景别求解。 */
export function actorHeight(actor: WhiteModelObject): number {
  return actor.size;
}

/** 景别求解时的注视高度：人形看胸口偏上，几何体看中心。 */
export function actorAimHeight(actor: WhiteModelObject): number {
  return actor.shape === "person" ? actor.size * 0.75 : actor.size * 0.5;
}

// ---------------------------------------------------------------------------
// 机位求值
// ---------------------------------------------------------------------------

function ease(factor: number, interpolation: WhiteModelCameraInterpolation): number {
  if (interpolation === "smooth") return factor * factor * (3 - 2 * factor);
  return factor;
}

function interpolateCamera(camera: WhiteModelCamera, time: number): WhiteModelCameraState {
  const frames = sortedByTime(camera.keyframes);
  const first = frames[0];
  if (!first) return { position: [6, -8, 4], target: [0, 0, 1] };
  if (time <= first.time || frames.length === 1)
    return { position: first.position, target: first.target };
  const last = frames.at(-1)!;
  if (time >= last.time) return { position: last.position, target: last.target };
  let index = frames.findIndex((frame) => time < frame.time);
  if (index <= 0) index = frames.length - 1;
  const start = frames[index - 1]!;
  const end = frames[index]!;
  const factor = ease(
    clamp((time - start.time) / Math.max(EPSILON, end.time - start.time), 0, 1),
    camera.interpolation,
  );
  return {
    position: vec.lerp(start.position, end.position, factor),
    target: vec.lerp(start.target, end.target, factor),
  };
}

function followAnchor(plan: WhiteModelScenePlan, actorId: string, time: number) {
  const actor = plan.objects.find((entry) => entry.id === actorId);
  if (!actor) return null;
  return { actor, state: evaluateActor(actor, time) };
}

/** 机位在时间 t 的位置与注视点（世界坐标，已处理跟随）。 */
export function evaluateCamera(plan: WhiteModelScenePlan, time: number): WhiteModelCameraState {
  const base = interpolateCamera(plan.camera, time);
  const follow = plan.camera.follow;
  if (!follow) return base;
  const anchor = followAnchor(plan, follow.actorId, time);
  if (!anchor) return base;
  if (follow.mode === "aim") {
    return {
      position: base.position,
      target: vec.add(anchor.state.position, [0, 0, actorAimHeight(anchor.actor)]),
    };
  }
  return {
    position: vec.add(anchor.state.position, base.position),
    target: vec.add(anchor.state.position, base.target),
  };
}

/**
 * 切换跟随模式时换算关键帧：track 模式下关键帧保存的是相对角色的偏移，其余模式为世界坐标。
 * 换算保证切换瞬间画面不跳。
 */
export function convertCameraFollow(
  plan: WhiteModelScenePlan,
  follow: WhiteModelCameraFollow | null,
): WhiteModelCamera {
  const current = plan.camera;
  const wasTrack = current.follow?.mode === "track";
  const willTrack = follow?.mode === "track";
  if (wasTrack === willTrack && (!willTrack || current.follow?.actorId === follow?.actorId)) {
    return { ...current, follow };
  }
  const toWorld = (frame: WhiteModelCameraKeyframe): WhiteModelCameraKeyframe => {
    if (!wasTrack || !current.follow) return frame;
    const anchor = followAnchor(plan, current.follow.actorId, frame.time);
    if (!anchor) return frame;
    return {
      ...frame,
      position: vec.add(anchor.state.position, frame.position),
      target: vec.add(anchor.state.position, frame.target),
    };
  };
  const toOffset = (frame: WhiteModelCameraKeyframe): WhiteModelCameraKeyframe => {
    if (!willTrack || !follow) return frame;
    const anchor = followAnchor(plan, follow.actorId, frame.time);
    if (!anchor) return frame;
    return {
      ...frame,
      position: vec.round(vec.sub(frame.position, anchor.state.position)),
      target: vec.round(vec.sub(frame.target, anchor.state.position)),
    };
  };
  return {
    ...current,
    follow,
    keyframes: current.keyframes.map((frame) => toOffset(toWorld(frame))),
  };
}

/** 把世界坐标的机位写入关键帧（自动换算 track 偏移）。 */
export function cameraKeyframeFromWorld(
  plan: WhiteModelScenePlan,
  time: number,
  state: WhiteModelCameraState,
): WhiteModelCameraKeyframe {
  const follow = plan.camera.follow;
  if (follow?.mode === "track") {
    const anchor = followAnchor(plan, follow.actorId, time);
    if (anchor) {
      return {
        time,
        position: vec.round(vec.sub(state.position, anchor.state.position)),
        target: vec.round(vec.sub(state.target, anchor.state.position)),
      };
    }
  }
  return { time, position: vec.round(state.position), target: vec.round(state.target) };
}

// ---------------------------------------------------------------------------
// 镜头语言：景别 / 角度 / 方位 / 运镜
// ---------------------------------------------------------------------------

export type ShotSize = "wide" | "full" | "medium" | "closeup" | "extreme";
export type ShotAngle = "high" | "eye" | "low";
export type ShotDirection = "front" | "front_left" | "front_right" | "left" | "right" | "back";
export type CameraMovePreset =
  | "static"
  | "push_in"
  | "pull_out"
  | "truck_left"
  | "truck_right"
  | "crane_up"
  | "crane_down"
  | "arc_left"
  | "arc_right"
  | "pan";

export const SHOT_SIZES: readonly { value: ShotSize; label: string }[] = [
  { value: "wide", label: "远景" },
  { value: "full", label: "全景" },
  { value: "medium", label: "中景" },
  { value: "closeup", label: "近景" },
  { value: "extreme", label: "特写" },
];
export const SHOT_ANGLES: readonly { value: ShotAngle; label: string }[] = [
  { value: "high", label: "俯拍" },
  { value: "eye", label: "平视" },
  { value: "low", label: "仰拍" },
];
export const SHOT_DIRECTIONS: readonly { value: ShotDirection; label: string }[] = [
  { value: "front", label: "正面" },
  { value: "front_left", label: "左前" },
  { value: "front_right", label: "右前" },
  { value: "left", label: "左侧" },
  { value: "right", label: "右侧" },
  { value: "back", label: "背面" },
];
export const CAMERA_MOVES: readonly { value: CameraMovePreset; label: string }[] = [
  { value: "static", label: "固定" },
  { value: "push_in", label: "推" },
  { value: "pull_out", label: "拉" },
  { value: "pan", label: "摇" },
  { value: "truck_left", label: "左移" },
  { value: "truck_right", label: "右移" },
  { value: "crane_up", label: "升" },
  { value: "crane_down", label: "降" },
  { value: "arc_left", label: "左环绕" },
  { value: "arc_right", label: "右环绕" },
];

/** 各景别：画面竖向需要容纳的主体高度比例、注视高度比例。 */
const SHOT_FRAMING: Record<ShotSize, { frameHeight: number; aim: number }> = {
  wide: { frameHeight: 4, aim: 0.5 },
  full: { frameHeight: 1.25, aim: 0.5 },
  medium: { frameHeight: 0.6, aim: 0.7 },
  closeup: { frameHeight: 0.36, aim: 0.85 },
  extreme: { frameHeight: 0.2, aim: 0.93 },
};
const SHOT_ELEVATION: Record<ShotAngle, number> = { high: 25, eye: 0, low: -18 };
const SHOT_AZIMUTH: Record<ShotDirection, number> = {
  front: 0,
  front_left: 45,
  front_right: -45,
  left: 90,
  right: -90,
  back: 180,
};

export interface ShotSpec {
  size: ShotSize;
  angle: ShotAngle;
  direction: ShotDirection;
}

/**
 * 根据主体状态与镜头语言求解机位：主体高度按景别换算成所需画面高度，
 * 再由垂直视野得到距离；方位相对主体朝向，角度决定俯仰。
 */
export function solveShot(
  subject: { position: WhiteModelVector; yaw: number; height: number; isPerson: boolean },
  spec: ShotSpec,
  lens: number,
  aspect: number,
): WhiteModelCameraState {
  const framing = SHOT_FRAMING[spec.size];
  const height = Math.max(0.2, subject.height);
  // 几何体没有「腰部」「胸口」，注视中心并全身取景。
  const aimHeight = subject.isPerson ? framing.aim * height : height * 0.5;
  const frameHeight = (subject.isPerson ? framing.frameHeight : Math.max(framing.frameHeight, 1.3)) * height;
  const vfov = verticalFovDegrees(lens, aspect) * DEG;
  const distance = Math.max(0.3, frameHeight / 2 / Math.tan(vfov / 2));
  const azimuth = subject.yaw + SHOT_AZIMUTH[spec.direction];
  const forward = forwardFromYaw(azimuth);
  const elevation = SHOT_ELEVATION[spec.angle] * DEG;
  const target: WhiteModelVector = vec.add(subject.position, [0, 0, aimHeight]);
  const position: WhiteModelVector = [
    target[0] + forward[0] * distance * Math.cos(elevation),
    target[1] + forward[1] * distance * Math.cos(elevation),
    Math.max(0.15, target[2] + distance * Math.sin(elevation)),
  ];
  return { position: vec.round(position), target: vec.round(target) };
}

/**
 * 以某个基准机位为终点/起点生成整段运镜关键帧（0 到片长）。
 * 环绕采样多帧折线逼近圆弧；摇镜位置不动、注视点横扫。
 */
export function cameraMoveKeyframes(
  base: WhiteModelCameraState,
  move: CameraMovePreset,
  durationSeconds: number,
): WhiteModelCameraKeyframe[] {
  const offset = vec.sub(base.position, base.target);
  const distance = Math.max(0.3, vec.length(offset));
  const flat = vec.normalize([offset[0], offset[1], 0]);
  const right: WhiteModelVector =
    vec.length(flat) < EPSILON ? [1, 0, 0] : vec.normalize(vec.cross([0, 0, 1], flat));
  const key = (time: number, position: WhiteModelVector, target: WhiteModelVector) => ({
    time: roundTo(time, 3),
    position: vec.round(position),
    target: vec.round(target),
  });
  const end = durationSeconds;
  switch (move) {
    case "static":
      return [key(0, base.position, base.target)];
    case "push_in":
      return [
        key(0, vec.add(base.target, vec.scale(offset, 1.7)), base.target),
        key(end, base.position, base.target),
      ];
    case "pull_out":
      return [
        key(0, base.position, base.target),
        key(end, vec.add(base.target, vec.scale(offset, 1.7)), base.target),
      ];
    case "truck_left":
    case "truck_right": {
      const shift = vec.scale(right, distance * 0.6 * (move === "truck_left" ? 1 : -1));
      return [
        key(0, vec.sub(base.position, shift), vec.sub(base.target, shift)),
        key(end, vec.add(base.position, shift), vec.add(base.target, shift)),
      ];
    }
    case "crane_up":
    case "crane_down": {
      const rise = distance * 0.6 * (move === "crane_up" ? 1 : -1);
      const from: WhiteModelVector = [
        base.position[0],
        base.position[1],
        Math.max(0.15, base.position[2] - rise),
      ];
      const to: WhiteModelVector = [
        base.position[0],
        base.position[1],
        Math.max(0.15, base.position[2] + rise),
      ];
      return [key(0, from, base.target), key(end, to, base.target)];
    }
    case "pan": {
      const sweep = vec.scale(right, distance * 0.35);
      return [
        key(0, base.position, vec.sub(base.target, sweep)),
        key(end, base.position, vec.add(base.target, sweep)),
      ];
    }
    case "arc_left":
    case "arc_right": {
      const samples = 8;
      const total = 90 * (move === "arc_left" ? 1 : -1);
      const frames: WhiteModelCameraKeyframe[] = [];
      for (let index = 0; index <= samples; index += 1) {
        const angle = -total / 2 + (total * index) / samples;
        const rotated = rotateAboutZ(offset, angle);
        frames.push(key((end * index) / samples, vec.add(base.target, rotated), base.target));
      }
      return frames;
    }
  }
}

/** 从视口的鼠标操作推导新机位：绕注视点环绕。 */
export function orbitCamera(
  state: WhiteModelCameraState,
  yawDeltaDegrees: number,
  pitchDeltaDegrees: number,
): WhiteModelCameraState {
  const offset = vec.sub(state.position, state.target);
  const distance = Math.max(0.05, vec.length(offset));
  const currentYaw = Math.atan2(offset[1], offset[0]);
  const currentPitch = Math.asin(clamp(offset[2] / distance, -1, 1));
  const yaw = currentYaw + yawDeltaDegrees * DEG;
  const pitch = clamp(currentPitch + pitchDeltaDegrees * DEG, -85 * DEG, 85 * DEG);
  const position: WhiteModelVector = [
    state.target[0] + distance * Math.cos(pitch) * Math.cos(yaw),
    state.target[1] + distance * Math.cos(pitch) * Math.sin(yaw),
    state.target[2] + distance * Math.sin(pitch),
  ];
  return { position, target: state.target };
}

/** 摇镜/抬头：机位不动，注视点绕机位旋转。 */
export function lookAroundCamera(
  state: WhiteModelCameraState,
  yawDeltaDegrees: number,
  pitchDeltaDegrees: number,
): WhiteModelCameraState {
  const inverted = orbitCamera(
    { position: state.target, target: state.position },
    yawDeltaDegrees,
    pitchDeltaDegrees,
  );
  return { position: state.position, target: inverted.position };
}

/** 推拉：沿视线移动机位，保持注视点。 */
export function dollyCamera(state: WhiteModelCameraState, factor: number): WhiteModelCameraState {
  const offset = vec.sub(state.position, state.target);
  const distance = vec.length(offset);
  const next = clamp(distance * factor, 0.2, 200);
  return {
    position: vec.add(state.target, vec.scale(vec.normalize(offset), next)),
    target: state.target,
  };
}

/** 平移：机位与注视点同时沿机位的右/上方向移动。 */
export function truckCamera(
  state: WhiteModelCameraState,
  rightMeters: number,
  upMeters: number,
): WhiteModelCameraState {
  const forward = vec.normalize(vec.sub(state.target, state.position));
  let right = vec.cross(forward, [0, 0, 1]);
  if (vec.length(right) < EPSILON) right = [1, 0, 0];
  right = vec.normalize(right);
  const up = vec.normalize(vec.cross(right, forward));
  const shift = vec.add(vec.scale(right, rightMeters), vec.scale(up, upMeters));
  return { position: vec.add(state.position, shift), target: vec.add(state.target, shift) };
}

// ---------------------------------------------------------------------------
// 烘焙
// ---------------------------------------------------------------------------

/** 逐帧烘焙整场：Blender 端只做「把数据写成关键帧」，不再重复任何插值逻辑。 */
export function bakeWhiteModelScene(plan: WhiteModelScenePlan): WhiteModelBake {
  const frameCount = whiteModelFrameCount(plan);
  const camera: number[] = [];
  const objects: WhiteModelBakedObject[] = plan.objects.map((actor) => ({
    id: actor.id,
    root: [],
    joints: actor.shape === "person" ? [] : null,
  }));
  for (let frame = 0; frame < frameCount; frame += 1) {
    const time = frame / plan.fps;
    const shot = evaluateCamera(plan, time);
    camera.push(...vec.round(shot.position), ...vec.round(shot.target));
    plan.objects.forEach((actor, index) => {
      const state = evaluateActor(actor, time);
      const baked = objects[index]!;
      baked.root.push(...vec.round(state.position), roundTo(state.yaw, 3));
      if (baked.joints) {
        const joints = evaluateJoints(actor, state, time)!;
        for (const joint of joints) baked.joints.push(...vec.round(joint));
      }
    });
  }
  return { frameCount, camera, objects };
}

// ---------------------------------------------------------------------------
// v1 迁移
// ---------------------------------------------------------------------------

export function isWhiteModelScenePlanV1(plan: unknown): plan is WhiteModelScenePlanV1 {
  return (
    typeof plan === "object" &&
    plan != null &&
    (plan as { version?: unknown }).version === 1 &&
    typeof (plan as { camera?: { motion?: unknown } }).camera?.motion === "string"
  );
}

/** 旧版四种运镜换算为关键帧：环绕采样折线，推拉/横移两端关键帧，固定单帧。 */
export function migrateWhiteModelScenePlan(plan: WhiteModelScenePlanV1): WhiteModelScenePlan {
  const { camera } = plan;
  const key = (time: number, position: WhiteModelVector): WhiteModelCameraKeyframe => ({
    time: roundTo(time, 3),
    position: vec.round(position),
    target: vec.round(camera.target),
  });
  let keyframes: WhiteModelCameraKeyframe[];
  if (camera.motion === "orbit") {
    const samples = Math.max(2, Math.min(24, Math.ceil(Math.abs(camera.orbitDegrees) / 12)));
    const offset = vec.sub(camera.start, camera.target);
    keyframes = [];
    for (let index = 0; index <= samples; index += 1) {
      const angle = (camera.orbitDegrees * index) / samples;
      keyframes.push(
        key((plan.durationSeconds * index) / samples, vec.add(camera.target, rotateAboutZ(offset, angle))),
      );
    }
  } else if (camera.motion === "static") {
    keyframes = [key(0, camera.start)];
  } else {
    keyframes = [key(0, camera.start), key(plan.durationSeconds, camera.end)];
  }
  return {
    version: 2,
    durationSeconds: plan.durationSeconds,
    fps: plan.fps,
    width: plan.width,
    height: plan.height,
    camera: { lens: camera.lens, interpolation: "linear", keyframes, follow: null },
    objects: plan.objects.map((actor) => ({
      id: actor.id,
      name: actor.name,
      shape: actor.shape,
      color: actor.color,
      size: actor.size,
      // 旧版角色朝向全部手填，保留原值。
      facing: "manual",
      keyframes: actor.keyframes.map((frame) => ({ ...frame })),
      motion: { kind: "auto" },
    })),
  };
}

// ---------------------------------------------------------------------------
// 校验（与 Rust / Python 端一致的业务规则，用于前端即时提示）
// ---------------------------------------------------------------------------

export function whiteModelPlanIssue(plan: WhiteModelScenePlan): string | null {
  if (!plan.objects.length) return "请添加至少一个角色或几何体。";
  for (const actor of plan.objects) {
    if (
      !actor.keyframes.length ||
      actor.keyframes.some(
        (frame, index) =>
          frame.time < 0 ||
          frame.time > plan.durationSeconds ||
          (index > 0 && frame.time <= actor.keyframes[index - 1]!.time),
      )
    ) {
      return `「${actor.name}」的路径时间必须递增，并且位于 0 至 ${plan.durationSeconds} 秒之间。`;
    }
  }
  const camera = plan.camera.keyframes;
  if (!camera.length) return "请至少设置一个机位关键帧。";
  if (
    camera.some(
      (frame, index) =>
        frame.time < 0 ||
        frame.time > plan.durationSeconds ||
        (index > 0 && frame.time <= camera[index - 1]!.time),
    )
  ) {
    return `机位关键帧时间必须递增，并且位于 0 至 ${plan.durationSeconds} 秒之间。`;
  }
  if (camera.some((frame) => vec.distance(frame.position, frame.target) < 0.01)) {
    return "机位不能与注视点重合。";
  }
  if (plan.camera.follow && !plan.objects.some((actor) => actor.id === plan.camera.follow!.actorId)) {
    return "机位跟随的角色已不存在，请重新选择。";
  }
  return null;
}
