// 预置「一键动捕」运行时：把 MediaPipe Tasks Vision 的 WASM 运行时从 node_modules 复制到
// public/pose/wasm/，并下载 Pose Landmarker (full) 模型到 public/pose/，随前端产物离线分发。
//
// 与 ffmpeg:prepare / blender:prepare 一样在 beforeDevCommand / beforeBuildCommand 中运行。
// 模型按 SHA-256 校验；已存在且校验通过的文件直接复用。下载失败不会中断构建：动捕是白模
// 导演台的可选能力，应用会在界面上提示「模型未随应用打包」，其余功能不受影响。
//
// 许可证：MediaPipe 运行时与模型均为 Apache-2.0（见 public/licenses/mediapipe-LICENSE.txt）。

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "node_modules", "@mediapipe", "tasks-vision");
const destination = path.join(root, "public", "pose");
const wasmDestination = path.join(destination, "wasm");

export const POSE_MODEL = {
  filename: "pose_landmarker_full.task",
  url: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task",
  sha256: "5134a3aad27a58b93da0088d431f366da362b44e3ccfbe3462b3827a839011b1",
  size: 9_398_198,
};

const WASM_FILES = [
  "vision_wasm_internal.js",
  "vision_wasm_internal.wasm",
  "vision_wasm_nosimd_internal.js",
  "vision_wasm_nosimd_internal.wasm",
];

export function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

export function modelIsValid(filePath, model = POSE_MODEL) {
  return existsSync(filePath) && statSync(filePath).size === model.size && sha256(filePath) === model.sha256;
}

function copyWasm() {
  const packageJson = JSON.parse(readFileSync(path.join(source, "package.json"), "utf8"));
  mkdirSync(wasmDestination, { recursive: true });
  for (const name of WASM_FILES) {
    const from = path.join(source, "wasm", name);
    const to = path.join(wasmDestination, name);
    if (!existsSync(from)) throw new Error(`缺少 MediaPipe 运行时文件：${from}`);
    if (existsSync(to) && statSync(to).size === statSync(from).size) continue;
    copyFileSync(from, to);
  }
  return packageJson.version;
}

async function downloadModel(target, model = POSE_MODEL) {
  if (modelIsValid(target, model)) return "cached";
  const response = await fetch(model.url);
  if (!response.ok) throw new Error(`下载模型失败：HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (bytes.length !== model.size || digest !== model.sha256) {
    throw new Error(`模型校验失败：size=${bytes.length} sha256=${digest}`);
  }
  const temporary = `${target}.tmp`;
  writeFileSync(temporary, bytes);
  renameSync(temporary, target);
  return "downloaded";
}

async function main() {
  const version = copyWasm();
  const target = path.join(destination, POSE_MODEL.filename);
  let modelState = "missing";
  try {
    modelState = await downloadModel(target);
  } catch (error) {
    console.warn(`[pose:prepare] 模型未就绪，动捕功能将在界面中标记为不可用：${error.message}`);
  }
  writeFileSync(
    path.join(destination, "manifest.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        runtime: { package: "@mediapipe/tasks-vision", version, license: "Apache-2.0" },
        model: {
          ...POSE_MODEL,
          state: modelState,
          license: "Apache-2.0",
          source: "https://developers.google.com/mediapipe/solutions/vision/pose_landmarker",
        },
      },
      null,
      2,
    ),
  );
  console.log(`[pose:prepare] runtime ${version} 已就绪，模型 ${modelState} → ${destination}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[pose:prepare] 失败：${error.message}`);
    process.exit(1);
  });
}
