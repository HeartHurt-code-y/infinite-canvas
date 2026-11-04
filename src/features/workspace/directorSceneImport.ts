import * as v from "valibot";
import { directorLookAt, directorProps, isDirectorBody } from "./directorCatalog";
import { directorPoseSchema } from "./directorPose";
import { decodeDirectorScene, directorObject, emptyDirectorScene, parseFlatDirectorPlan,
  type DirectorObject, type DirectorObjectKind, type DirectorScene, type DirectorTransform } from "./directorScene";

export type DirectorImportMode = "insert" | "replace";
export interface DirectorImageModel {
  readonly providerId: string;
  readonly modelDefinitionId: string;
}
export interface DirectorImageRequest {
  readonly referenceKey: string;
  readonly mode: DirectorImportMode;
  readonly charactersOnly: boolean;
  readonly model: DirectorImageModel;
}

const number = v.pipe(v.number(), v.finite(), v.minValue(-1000), v.maxValue(1000));
const extent = v.pipe(v.number(), v.finite(), v.minValue(0.05), v.maxValue(100));
const xyz = v.object({ x: number, y: number, z: number });
const xyzScale = v.object({ x: extent, y: extent, z: extent });
const label = v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80)));
const importedObject = {
  label, position: xyz, rotation: v.optional(xyz), scale: v.optional(xyzScale),
  color: v.optional(v.pipe(v.string(), v.regex(/^#[0-9a-f]{6}$/iu))),
};
const importPlan = v.object({
  characters: v.optional(v.pipe(v.array(v.object({
    ...importedObject, bodyType: v.optional(v.string()), jointAngles: v.optional(directorPoseSchema),
  })), v.maxLength(80)), []),
  props: v.optional(v.pipe(v.array(v.object({ ...importedObject, assetId: v.string() })), v.maxLength(80)), []),
  cameras: v.optional(v.pipe(v.array(v.object({
    label, position: xyz, lookAt: v.optional(xyz), cameraRotation: v.optional(xyz),
    fov: v.optional(v.pipe(v.number(), v.minValue(15), v.maxValue(100)), 48),
  })), v.maxLength(80)), []),
});
const toTriple = ({ x, y, z }: { x: number; y: number; z: number }): DirectorTransform["position"] => [x, y, z];

function place(kind: DirectorObjectKind, input: v.InferOutput<v.ObjectSchema<typeof importedObject, undefined>>, index: number) {
  const item = directorObject(kind, index);
  return { ...item, name: input.label ?? item.name, color: input.color ?? item.color,
    position: toTriple(input.position), rotation: input.rotation ? toTriple(input.rotation) : item.rotation,
    scale: input.scale ? toTriple(input.scale) : item.scale };
}

function parseSourceLayout(data: unknown, charactersOnly: boolean): DirectorScene | null {
  const source = v.safeParse(importPlan, data);
  if (!source.success) return null;
  const { characters, props, cameras } = source.output;
  if (!characters.length && !props.length && !cameras.length) return null;
  const objects: DirectorObject[] = characters.map((input, index) => {
    const kind = input.bodyType && isDirectorBody(input.bodyType) ? input.bodyType : "character";
    return { ...place(kind, input, index), jointAngles: input.jointAngles };
  });
  if (!charactersOnly) {
    for (const [index, input] of props.entries()) {
      const assetId = input.assetId.replace(/^mesh_/, "");
      const kind = directorProps.find(([value]) => value === assetId)?.[0];
      if (!kind) throw new Error(`无法导入道具类型「${input.assetId}」。请使用道具目录中的类型。`);
      objects.push(place(kind, input, index));
    }
    for (const [index, input] of cameras.entries()) {
      const camera = directorObject("camera", index);
      const position = toTriple(input.position);
      const rotation: DirectorTransform["rotation"] = input.lookAt ? directorLookAt(position, toTriple(input.lookAt))
        : input.cameraRotation ? [-input.cameraRotation.x, (input.cameraRotation.y + 180) % 360, input.cameraRotation.z]
        : directorLookAt(position, [0, 1.2, 0]);
      objects.push({ ...camera, name: input.label ?? camera.name, position, rotation, fov: input.fov });
    }
  }
  if (!objects.length || objects.length > 80) throw new Error("未识别到可导入的对象，或场景超过 80 项。");
  return { ...emptyDirectorScene(), objects };
}

export function parseDirectorLayout(text: string, source: "json" | "model", charactersOnly = false): DirectorScene {
  const raw = text.trim();
  const fenced = /^\x60{3}(?:json)?\s*([\s\S]*?)\s*\x60{3}$/iu.exec(raw);
  let data: unknown;
  try { data = JSON.parse(fenced?.[1] ?? raw) as unknown; }
  catch { throw new Error(source === "json" ? "JSON 格式无效，请检查后重试。" : "模型回复不是有效的场景 JSON，可在任务历史查看。"); }
  const scene = (source === "json" ? decodeDirectorScene(data) : null)
    ?? parseSourceLayout(data, charactersOnly) ?? parseFlatDirectorPlan(data);
  if (!scene) throw new Error(source === "json" ? "场景 JSON 缺少有效的角色、道具或机位。" : "模型回复缺少有效的场景字段，可在任务历史查看。");
  if (!charactersOnly) return scene;
  const objects = scene.objects.filter(item => isDirectorBody(item.kind));
  if (!objects.length) throw new Error("参考图中未识别到可导入的人物。");
  return { ...scene, objects };
}

export function mergeDirectorLayout(base: DirectorScene, incoming: DirectorScene, mode: DirectorImportMode): DirectorScene {
  if (mode === "replace") return incoming;
  if (base.objects.length + incoming.objects.length > 80) throw new Error("插入后将超过 80 个场景对象。请先精简场景。");
  const ids = new Map(incoming.objects.map(item => [item.id, crypto.randomUUID()]));
  return { ...base, objects: [...base.objects, ...incoming.objects.map(item => ({ ...item, id: ids.get(item.id)! }))],
    tracks: [...base.tracks, ...incoming.tracks.map(track => ({ ...track, objectId: ids.get(track.objectId)! }))] };
}

export function directorImagePrompt(prompt: string, charactersOnly: boolean): string {
  return [
    "根据参考图估计可编辑的 3D 站位、姿势和构图。仅输出一个 JSON 对象，不要输出解释、模型 URL 或网格。",
    '结构：{"characters":[{"label":"人物","bodyType":"mannequin","position":{"x":0,"y":0,"z":0},"rotation":{"x":0,"y":0,"z":0},"jointAngles":{"head":{"nod":10},"l_arm":{"raise":35},"l_elbow":{"bend":60}}}],"props":[{"assetId":"chair","position":{"x":1,"y":0,"z":0}}],"cameras":[{"position":{"x":0,"y":1.5,"z":4},"lookAt":{"x":0,"y":1.2,"z":0},"fov":50}]}。',
    "Y 朝上、米为单位。人物面向 +Z，角色位置为地面站位，正的 raise 表示前举/前抬，正的 straddle 表示外展。关节可用 body/torso 的 bend、turn、tilt，head 的 nod、turn、tilt，l_arm/r_arm/l_leg/r_leg 的 raise、straddle、turn，l_elbow/r_elbow/l_knee/r_knee 的 bend。角度用度。",
    "bodyType 可选 mannequin、female、child、chibi。根据原图估计相对深度和距离。最多 48 个对象。",
    charactersOnly ? "只识别人物和姿势，props 和 cameras 返回空数组。"
      : `道具类型只能从以下目录选用：${directorProps.filter(([kind]) => kind !== "image_board").map(([kind, name]) => kind + " " + name).join("、")}。机位须朝向主体。`,
    prompt ? `额外构图要求：${prompt}` : "",
  ].filter(Boolean).join("\n");
}
