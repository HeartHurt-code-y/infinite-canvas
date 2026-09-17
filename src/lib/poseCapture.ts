/**
 * 一键动捕：在 WebView 内用 MediaPipe Pose Landmarker 逐帧读取参考视频，
 * 把 33 个世界关键点换算成白模人形的 17 个关节，并归一化到「单位身高、面朝 -Y、脚踩地面」
 * 的局部空间，编码为可随画布保存的紧凑动捕片段。
 *
 * 运行时资源（WASM 与 .task 模型）由 `pnpm pose:prepare` 复制/下载到 public/pose/，
 * 随安装包离线分发；资源缺失时 `poseCaptureAvailable()` 返回 false，界面据此提示。
 */

import {
  JOINT,
  JOINT_COUNT,
  encodeMotionClipJoints,
  yawFromDirection,
  type WhiteModelMotionClip,
} from "./whiteModelScene";

export const POSE_ASSET_BASE = `${import.meta.env.BASE_URL ?? "/"}pose/`;
export const POSE_MODEL_FILE = "pose_landmarker_full.task";
export const POSE_MAX_SECONDS = 30;

export interface PoseCaptureOptions {
  readonly fps: number;
  readonly sourceName: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (done: number, total: number, message: string) => void;
}

interface Landmark {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

type Frame = Float64Array | null;

let availability: Promise<boolean> | null = null;

/** 资源是否随构建打包；404 视为缺失，其它响应（含不支持 HEAD 的自定义协议）乐观放行。 */
export function poseCaptureAvailable(): Promise<boolean> {
  availability ??= (async () => {
    try {
      const response = await fetch(`${POSE_ASSET_BASE}${POSE_MODEL_FILE}`, { method: "HEAD" });
      return response.status !== 404;
    } catch {
      return false;
    }
  })();
  return availability;
}

function waitForEvent(
  element: HTMLMediaElement,
  event: "loadedmetadata" | "loadeddata" | "seeked",
  signal?: AbortSignal,
  timeoutMs = 15_000,
): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException("已取消动作捕捉。", "AbortError"));
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      window.clearTimeout(timer);
      element.removeEventListener(event, onSuccess);
      element.removeEventListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const onSuccess = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("视频无法解码，无法提取动作。"));
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException("已取消动作捕捉。", "AbortError"));
    };
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error(`等待视频 ${event} 超时。`));
    }, timeoutMs);
    element.addEventListener(event, onSuccess, { once: true });
    element.addEventListener("error", onError, { once: true });
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function seek(video: HTMLVideoElement, time: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const target = Math.min(Math.max(0, time), Math.max(0, video.duration - 0.001));
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && Math.abs(video.currentTime - target) < 0.002) {
    return;
  }
  const ready = waitForEvent(video, "seeked", signal);
  video.currentTime = target;
  await ready;
}

/** MediaPipe 世界坐标（x 右、y 下、z 朝向镜头）→ 白模坐标（x 右、y 远离镜头、z 上）。 */
function convert(point: Landmark): [number, number, number] {
  return [point.x, point.z, -point.y];
}

function mid(a: Landmark, b: Landmark): Landmark {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
}

function mix(a: Landmark, b: Landmark, factor: number): Landmark {
  return {
    x: a.x + (b.x - a.x) * factor,
    y: a.y + (b.y - a.y) * factor,
    z: a.z + (b.z - a.z) * factor,
  };
}

/** 33 个 Pose 关键点 → 17 个白模关节（米，未归一化）。 */
export function landmarksToJoints(landmarks: readonly Landmark[]): Float64Array {
  const at = (index: number) => landmarks[index]!;
  const pelvis = mid(at(23), at(24));
  const shoulders = mid(at(11), at(12));
  const head = mid(at(7), at(8));
  const chest = mix(pelvis, shoulders, 0.85);
  const neck = mix(shoulders, head, 0.35);
  const table: Record<number, Landmark> = {
    [JOINT.pelvis]: pelvis,
    [JOINT.chest]: chest,
    [JOINT.neck]: neck,
    [JOINT.head]: head,
    [JOINT.leftShoulder]: at(11),
    [JOINT.leftElbow]: at(13),
    [JOINT.leftWrist]: at(15),
    [JOINT.rightShoulder]: at(12),
    [JOINT.rightElbow]: at(14),
    [JOINT.rightWrist]: at(16),
    [JOINT.leftHip]: at(23),
    [JOINT.leftKnee]: at(25),
    [JOINT.leftAnkle]: at(27),
    [JOINT.rightHip]: at(24),
    [JOINT.rightKnee]: at(26),
    [JOINT.rightAnkle]: at(28),
    [JOINT.nose]: at(0),
  };
  const joints = new Float64Array(JOINT_COUNT * 3);
  for (let joint = 0; joint < JOINT_COUNT; joint += 1) {
    const [x, y, z] = convert(table[joint]!);
    joints[joint * 3] = x;
    joints[joint * 3 + 1] = y;
    joints[joint * 3 + 2] = z;
  }
  return joints;
}

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(fraction * (sorted.length - 1))))]!;
}

/**
 * 归一化整段关节序列：补齐漏检帧、统一面向 -Y、按估算身高缩放到 1、脚底落到 z=0、轻度平滑。
 * 纯函数，便于单测。
 */
export function normalizeCapturedFrames(frames: readonly Frame[]): Float32Array {
  const filled = fillMissing(frames);
  if (!filled.length) throw new Error("视频中没有检测到人物动作。");
  // 平均面向：肩线（左肩 - 右肩）顺时针转 90° 即面向。
  let facingX = 0;
  let facingY = 0;
  for (const frame of filled) {
    const sx = frame[JOINT.leftShoulder * 3]! - frame[JOINT.rightShoulder * 3]!;
    const sy = frame[JOINT.leftShoulder * 3 + 1]! - frame[JOINT.rightShoulder * 3 + 1]!;
    facingX += sy;
    facingY += -sx;
  }
  const yaw = yawFromDirection([facingX, facingY, 0]);
  const radians = (-yaw * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const heights: number[] = [];
  const floors: number[] = [];
  for (const frame of filled) {
    for (let joint = 0; joint < JOINT_COUNT; joint += 1) {
      const x = frame[joint * 3]!;
      const y = frame[joint * 3 + 1]!;
      frame[joint * 3] = x * cos - y * sin;
      frame[joint * 3 + 1] = x * sin + y * cos;
    }
    const lowest = Math.min(frame[JOINT.leftAnkle * 3 + 2]!, frame[JOINT.rightAnkle * 3 + 2]!);
    heights.push((frame[JOINT.head * 3 + 2]! - lowest) / 0.885);
    floors.push(lowest);
  }
  const height = Math.max(0.5, percentile(heights, 0.5));
  const floor = percentile(floors, 0.05) - 0.045 * height;
  const output = new Float32Array(filled.length * JOINT_COUNT * 3);
  for (let index = 0; index < filled.length; index += 1) {
    const frame = filled[index]!;
    for (let joint = 0; joint < JOINT_COUNT; joint += 1) {
      output[(index * JOINT_COUNT + joint) * 3] = frame[joint * 3]! / height;
      output[(index * JOINT_COUNT + joint) * 3 + 1] = frame[joint * 3 + 1]! / height;
      output[(index * JOINT_COUNT + joint) * 3 + 2] = (frame[joint * 3 + 2]! - floor) / height;
    }
  }
  return smooth(output, filled.length);
}

function fillMissing(frames: readonly Frame[]): Float64Array[] {
  const known = frames
    .map((frame, index) => (frame ? index : -1))
    .filter((index) => index >= 0);
  if (!known.length) return [];
  return frames.map((frame, index) => {
    if (frame) return Float64Array.from(frame);
    const previous = [...known].reverse().find((value) => value < index);
    const next = known.find((value) => value > index);
    if (previous == null) return Float64Array.from(frames[next!]!);
    if (next == null) return Float64Array.from(frames[previous]!);
    const factor = (index - previous) / (next - previous);
    const a = frames[previous]!;
    const b = frames[next]!;
    return Float64Array.from(a, (value, position) => value + (b[position]! - value) * factor);
  });
}

function smooth(joints: Float32Array, frameCount: number): Float32Array {
  if (frameCount < 3) return joints;
  const stride = JOINT_COUNT * 3;
  const output = new Float32Array(joints.length);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const previous = Math.max(0, frame - 1) * stride;
    const current = frame * stride;
    const next = Math.min(frameCount - 1, frame + 1) * stride;
    for (let offset = 0; offset < stride; offset += 1) {
      output[current + offset] =
        joints[previous + offset]! * 0.25 + joints[current + offset]! * 0.5 + joints[next + offset]! * 0.25;
    }
  }
  return output;
}

interface Landmarker {
  detectForVideo(frame: HTMLCanvasElement, timestampMs: number): { worldLandmarks: Landmark[][] };
  close(): void;
}

async function createLandmarker(): Promise<Landmarker> {
  const vision = await import("@mediapipe/tasks-vision");
  const fileset = await vision.FilesetResolver.forVisionTasks(`${POSE_ASSET_BASE}wasm`);
  const options = (delegate: "GPU" | "CPU") => ({
    baseOptions: { modelAssetPath: `${POSE_ASSET_BASE}${POSE_MODEL_FILE}`, delegate },
    runningMode: "VIDEO" as const,
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
    outputSegmentationMasks: false,
  });
  try {
    return await vision.PoseLandmarker.createFromOptions(fileset, options("GPU"));
  } catch {
    return await vision.PoseLandmarker.createFromOptions(fileset, options("CPU"));
  }
}

/** 从本地视频地址提取动作片段。 */
export async function captureMotionFromVideo(
  videoSrc: string,
  options: PoseCaptureOptions,
): Promise<WhiteModelMotionClip> {
  const { signal, onProgress } = options;
  signal?.throwIfAborted();
  onProgress?.(0, 1, "正在加载动作捕捉模型…");
  const landmarker = await createLandmarker();
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  if (/^https?:\/\//i.test(videoSrc)) video.crossOrigin = "anonymous";
  video.src = videoSrc;
  try {
    if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
      video.load();
      await waitForEvent(video, "loadedmetadata", signal);
    }
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      await waitForEvent(video, "loadeddata", signal);
    }
    if (!Number.isFinite(video.duration) || video.duration <= 0 || video.videoWidth <= 0) {
      throw new Error("视频元数据无效，无法提取动作。");
    }
    const fps = Math.max(8, Math.min(30, Math.round(options.fps)));
    const seconds = Math.min(video.duration, POSE_MAX_SECONDS);
    const total = Math.max(1, Math.floor(seconds * fps));
    const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("当前 WebView 不支持视频抽帧画布。");
    const frames: Frame[] = [];
    let lastTimestamp = -1;
    let detected = 0;
    for (let index = 0; index < total; index += 1) {
      const time = index / fps;
      await seek(video, time, signal);
      signal?.throwIfAborted();
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      // VIDEO 模式要求时间戳严格递增。
      let timestamp = Math.round(time * 1000);
      if (timestamp <= lastTimestamp) timestamp = lastTimestamp + 1;
      lastTimestamp = timestamp;
      const result = landmarker.detectForVideo(canvas, timestamp);
      const landmarks = result.worldLandmarks[0];
      if (landmarks && landmarks.length >= 29) {
        frames.push(landmarksToJoints(landmarks));
        detected += 1;
      } else frames.push(null);
      onProgress?.(index + 1, total, `正在分析动作：${index + 1}/${total} 帧`);
    }
    if (detected < Math.max(2, total * 0.2)) {
      throw new Error("视频中可识别的人物动作太少，请使用全身清晰、单人出镜的参考视频。");
    }
    const joints = normalizeCapturedFrames(frames);
    return {
      fps,
      frameCount: total,
      joints: encodeMotionClipJoints(joints),
      sourceName: options.sourceName,
    };
  } finally {
    landmarker.close();
    video.removeAttribute("src");
    video.load();
  }
}
