import * as v from "valibot";
import { directorBodies, directorProps, isDirectorBody } from "./directorCatalog";
import { directorPoseSchema, interpolateDirectorPose, type DirectorPose } from "./directorPose";

export const DIRECTOR_NODE_SIZE = 350;

export const DIRECTOR_ASSETS = [...directorProps, ...directorBodies, ["camera", "机位"]] as const;
export const directorKinds = DIRECTOR_ASSETS.map(([kind]) => kind);
const modelId = v.pipe(v.string(), v.uuid());
const number = v.pipe(v.number(), v.finite(), v.minValue(-1000), v.maxValue(1000));
const triple = v.tuple([number, number, number]);
const extent = v.pipe(v.number(), v.finite(), v.minValue(0.05), v.maxValue(100));
const name = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80));
const color = v.pipe(v.string(), v.regex(/^#[0-9a-f]{6}$/iu));
const transform = v.object({
  position: triple,
  rotation: triple,
  scale: v.tuple([extent, extent, extent]),
});
const object = v.object({
  ...transform.entries,
  id: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
  kind: v.picklist([...directorKinds, "model"]),
  modelId: v.optional(modelId),
  imageKey: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(200))),
  jointAngles: v.optional(directorPoseSchema),
  name,
  color,
  fov: v.optional(v.pipe(v.number(), v.minValue(15), v.maxValue(100)), 48),
});
const keyframe = v.object({
  ...transform.entries,
  jointAngles: v.optional(directorPoseSchema),
  time: v.pipe(v.number(), v.minValue(0), v.maxValue(30)),
});
const scene = v.object({
  objects: v.pipe(v.array(object), v.maxLength(80)),
  background: color,
  aspect: v.picklist(["16:9", "4:3", "1:1", "9:16", "21:9"]),
  duration: v.pipe(v.number(), v.minValue(1), v.maxValue(30)),
  tracks: v.pipe(v.array(v.object({
    objectId: object.entries.id,
    keyframes: v.pipe(v.array(keyframe), v.maxLength(120)),
  })), v.maxLength(80)),
});

export type DirectorScene = v.InferOutput<typeof scene>;
export type DirectorObject = v.InferOutput<typeof object>;
export type DirectorTransform = v.InferOutput<typeof transform>;
export type DirectorObjectKind = DirectorObject["kind"];

export function emptyDirectorScene(): DirectorScene {
  return { objects: [], background: "#303136", aspect: "16:9", duration: 5, tracks: [] };
}

export function decodeDirectorScene(input: unknown): DirectorScene | null {
  const parsed = v.safeParse(scene, input);
  if (!parsed.success) return null;
  const ids = new Set(parsed.output.objects.map(item => item.id));
  if (ids.size !== parsed.output.objects.length) return null;
  if (parsed.output.objects.some(item => item.kind === "model" && !item.modelId)) return null;
  const tracks = parsed.output.tracks.filter(track => ids.has(track.objectId));
  if (new Set(tracks.map(track => track.objectId)).size !== tracks.length) return null;
  return { ...parsed.output, tracks: tracks.map(track => ({
    ...track, keyframes: [...track.keyframes].sort((a, b) => a.time - b.time),
  })) };
}

export function directorObject(kind: DirectorObjectKind, count: number): DirectorObject {
  return {
    id: crypto.randomUUID(), kind, name: kind === "camera" ? `机位 ${count + 1}` :
      DIRECTOR_ASSETS.find(([key]) => key === kind)?.[1] ?? "GLB 角色",
    color: isDirectorBody(kind) ? "#b5b8c4" : "#80accc",
    position: kind === "camera" ? [4, 2.6, 6] : [count % 4 * 1.35, 0, Math.floor(count / 4) * 1.35],
    rotation: kind === "camera" ? [-15, 34, 0] : [0, 0, 0], scale: [1, 1, 1], fov: 48,
  };
}

export function parseFlatDirectorPlan(data: unknown): DirectorScene | null {
  const plan = v.safeParse(v.object({
    objects: v.pipe(v.array(v.object({
      ...transform.entries, kind: v.picklist(directorKinds), name, color,
      fov: object.entries.fov, jointAngles: v.optional(directorPoseSchema),
    })), v.minLength(1), v.maxLength(48)),
    background: v.optional(color),
  }), data);
  if (!plan.success) return null;
  return {
    ...emptyDirectorScene(),
    ...(plan.output.background ? { background: plan.output.background } : {}),
    objects: plan.output.objects.map(item => ({ ...item, id: crypto.randomUUID() })),
  };
}

export function directorSceneRequest(prompt: string): string {
  return [
    "请担任3D场景预演导演，把描述转换为可编辑的空间构图。只返回合法 JSON。",
    '结构：{"background":"#303136","objects":[{"kind":"cube","name":"道具","color":"#80accc","position":[0,0,0],"rotation":[0,0,0],"scale":[1,1,1],"fov":48}]}。',
    `kind 支持 ${directorKinds.filter(kind => kind !== "image_board").join("、")}。`,
    "单位为米，Y 朝上，物体原点在底部，所有 rotation 字段为 XYZ 欧拉角（度），摄像机朝本地 -Z 轴。镜头优先取能看到主要角色和道具的位置。比例至少 0.05。最多 48 项。",
    `场景描述：${prompt || "按参考图搭建场景"}`,
  ].filter(Boolean).join("\n");
}

export function directorMotionRequest(scene: DirectorScene, camera: DirectorObject, prompt: string): string {
  return [
    "你是3D导演台的摄影师。根据画面和场景布局生成可以编辑的机位关键帧。只输出 JSON。",
    '结构：{"keyframes":[{"time":0,"position":[0,2,6],"rotation":[-10,0,0]},{"time":5,"position":[0,2,4],"rotation":[-10,0,0]}]}。',
    `从 time 0 到 ${scene.duration} 秒，时间严格递增，输出 2 到 30 帧。Y 朝上，旋转以度计，摄像机朝本地 -Z 轴。维持目标构图且避开道具。`,
    "当前机位：" + JSON.stringify(camera),
    "场景对象：" + JSON.stringify(scene.objects.map(({ kind, name, position, rotation, scale }) =>
      ({ kind, name, position, rotation, scale }))),
    "运镜要求：" + prompt,
  ].join("\n");
}

export function parseDirectorMotion(text: string, camera: DirectorObject, duration: number): DirectorScene["tracks"][number] {
  const raw = text.trim();
  const fenced = /^\x60{3}(?:json)?\s*([\s\S]*?)\s*\x60{3}$/iu.exec(raw);
  let json: unknown;
  try { json = JSON.parse(fenced?.[1] ?? raw) as unknown; }
  catch { throw new Error("模型没有返回可读取的运镜 JSON。原始回复可从任务历史查看。"); }
  const schema = v.object({
    keyframes: v.pipe(v.array(v.object({
      time: v.pipe(v.number(), v.minValue(0), v.maxValue(duration)), position: triple, rotation: triple,
    })), v.minLength(2), v.maxLength(30)),
  });
  const parsed = v.safeParse(schema, json);
  if (!parsed.success || parsed.output.keyframes.some((frame, index, frames) => index > 0 && frame.time <= frames[index - 1]!.time)) {
    throw new Error("模型返回的机位关键帧无效。原始回复可从任务历史查看。");
  }
  return { objectId: camera.id, keyframes: parsed.output.keyframes.map(frame => ({ ...frame, scale: camera.scale })) };
}

export function transformAt(scene: DirectorScene, item: DirectorObject, time: number): DirectorTransform {
  const [prev, next, mix] = framesAt(scene, item, time);
  if (prev === next) return next;
  const lerp = (a: [number, number, number], b: [number, number, number]): [number, number, number] =>
    [a[0] + (b[0] - a[0]) * mix, a[1] + (b[1] - a[1]) * mix, a[2] + (b[2] - a[2]) * mix];
  return { position: lerp(prev.position, next.position), rotation: lerp(prev.rotation, next.rotation), scale: lerp(prev.scale, next.scale) };
}

function framesAt(scene: DirectorScene, item: DirectorObject, time: number) {
  const frames = scene.tracks.find(track => track.objectId === item.id)?.keyframes;
  if (!frames?.length) return [item, item, 0] as const;
  const right = frames.findIndex(frame => frame.time >= time);
  const next = right >= 0 ? frames[right]! : frames[frames.length - 1]!;
  const prev = right > 0 ? frames[right - 1]! : next;
  return [prev, next, prev === next ? 0 : (time - prev.time) / (next.time - prev.time)] as const;
}

export function directorPoseAt(scene: DirectorScene, item: DirectorObject, time: number): DirectorPose | undefined {
  const [prev, next, mix] = framesAt(scene, item, time);
  if (prev === next || (!prev.jointAngles && !next.jointAngles)) return prev.jointAngles ?? item.jointAngles;
  return interpolateDirectorPose(prev.jointAngles ?? item.jointAngles ?? {}, next.jointAngles ?? item.jointAngles ?? {}, mix);
}
