import { appDataDir, join } from "@tauri-apps/api/path";
import { exists, mkdir, readDir, readFile, readTextFile, writeFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { Box3, Group, LoadingManager, Texture } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const MAX_MODEL_BYTES = 32 * 1024 * 1024;
const GLB_MAGIC = 0x46546c67;
const GLB_JSON = 0x4e4f534a;
const MODEL_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
export interface DirectorModelRecord {
  id: string;
  name: string;
  category: "props" | "people";
}

function validateGlb(bytes: ArrayBuffer) {
  if (bytes.byteLength < 20 || bytes.byteLength > MAX_MODEL_BYTES) throw new Error("GLB 文件需要小于 32 MB。");
  const view = new DataView(bytes);
  const jsonLength = view.getUint32(12, true);
  if (view.getUint32(0, true) !== GLB_MAGIC || view.getUint32(4, true) !== 2 ||
    view.getUint32(8, true) !== bytes.byteLength || view.getUint32(16, true) !== GLB_JSON ||
    jsonLength > bytes.byteLength - 20) throw new Error("请选择有效的 GLB 2.0 文件。");
  const json = new TextDecoder().decode(new Uint8Array(bytes, 20, jsonLength));
  const metadata = JSON.parse(json) as { images?: { uri?: unknown }[]; buffers?: { uri?: unknown }[] };
  if ([...(metadata.images ?? []), ...(metadata.buffers ?? [])]
    .some(entry => typeof entry.uri === "string" && !entry.uri.startsWith("data:"))) {
    throw new Error("请导入贴图和缓冲区均内嵌的 GLB 文件。");
  }
}

async function parse(bytes: ArrayBuffer) {
  validateGlb(bytes);
  const manager = new LoadingManager();
  manager.setURLModifier(url => {
    if (url.startsWith("blob:") || url.startsWith("data:")) return url;
    throw new Error("GLB 引用了外部资源。");
  });
  const { scene } = await new GLTFLoader(manager).parseAsync(bytes, "");
  const box = new Box3().setFromObject(scene);
  const height = box.max.y - box.min.y;
  const largestSide = Math.max(box.max.x - box.min.x, height, box.max.z - box.min.z);
  if (box.isEmpty() || !Number.isFinite(largestSide) || largestSide < 0.00001) throw new Error("GLB 中没有可渲染的网格。");
  const scale = 1.8 / (height > largestSide * 0.2 ? height : largestSide);
  const model = new Group();
  model.position.set(-(box.min.x + box.max.x) * scale / 2, -box.min.y * scale, -(box.min.z + box.max.z) * scale / 2);
  model.scale.setScalar(scale);
  model.add(scene);
  return model;
}

const directory = async () => join(await appDataDir(), "director-models");

export async function importDirectorModel(file: File, category: DirectorModelRecord["category"], signal: AbortSignal): Promise<DirectorModelRecord> {
  if (file.size > MAX_MODEL_BYTES) throw new Error("GLB 文件需要小于 32 MB。");
  const bytes = await file.arrayBuffer();
  const parsed = await parse(bytes);
  const materials = new Set<import("three").Material>();
  parsed.traverse(child => {
    if (!("isMesh" in child)) return;
    const mesh = child as import("three").Mesh;
    mesh.geometry.dispose();
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) materials.add(material);
  });
  for (const material of materials) {
    for (const value of Object.values(material)) if (value instanceof Texture) value.dispose();
    material.dispose();
  }
  signal.throwIfAborted();
  const target = await directory();
  await mkdir(target, { recursive: true });
  const model: DirectorModelRecord = { id: crypto.randomUUID(),
    name: file.name.replace(/\.glb$/iu, "").trim().slice(0, 80) || (category === "people" ? "GLB 角色" : "GLB 道具"), category };
  signal.throwIfAborted();
  await writeTextFile(await join(target, model.id + ".json"), JSON.stringify({ name: model.name, category }));
  await writeFile(await join(target, model.id + ".glb"), new Uint8Array(bytes));
  return model;
}

export async function listDirectorModels() {
  const target = await directory();
  if (!await exists(target)) return [];
  const entries = await readDir(target);
  const names = new Set(entries.filter(entry => entry.isFile).map(entry => entry.name));
  const ids = [...names].filter(file => file.endsWith(".glb")).map(file => file.slice(0, -4)).filter(id => MODEL_ID.test(id));
  const models = await Promise.all(ids.map(async (id): Promise<DirectorModelRecord> => {
    if (names.has(id + ".json")) {
      const raw: unknown = await readTextFile(await join(target, id + ".json"))
        .then(value => JSON.parse(value) as unknown).catch(() => null);
      if (raw && typeof raw === "object" && "name" in raw && typeof raw.name === "string" &&
        "category" in raw && (raw.category === "props" || raw.category === "people")) {
        return { id, name: raw.name, category: raw.category };
      }
    }
    return { id, name: `GLB 模型 · ${id.slice(0, 6)}`, category: "people" };
  }));
  return models.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

export async function loadDirectorModel(id: string) {
  if (!MODEL_ID.test(id)) throw new Error("GLB 素材标识无效。");
  const bytes = await readFile(await join(await directory(), id + ".glb"));
  return parse(Uint8Array.from(bytes).buffer);
}
