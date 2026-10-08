// Pose assets belong to the native component tree, not Vite's public directory.
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertComponentRoot,
  componentBytesSha256,
  componentFileSha256,
  inventoryComponentFiles,
} from "./runtime-component-catalog.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const POSE_MODEL = Object.freeze({
  filename: "pose_landmarker_full.task",
  url: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task",
  sha256: "5134a3aad27a58b93da0088d431f366da362b44e3ccfbe3462b3827a839011b1",
  size: 9_398_198,
});
export const POSE_WASM_FILES = Object.freeze([
  "vision_wasm_internal.js",
  "vision_wasm_internal.wasm",
  "vision_wasm_nosimd_internal.js",
  "vision_wasm_nosimd_internal.wasm",
]);
export function sha256(filename) {
  return componentBytesSha256(readFileSync(filename));
}
export function modelIsValid(filename, model = POSE_MODEL) {
  return (
    existsSync(filename) &&
    lstatSync(filename).isFile() &&
    !lstatSync(filename).isSymbolicLink() &&
    lstatSync(filename).size === model.size &&
    sha256(filename) === model.sha256
  );
}

async function poseInputs(source, licensePath, model) {
  const packageBytes = await readFile(path.join(source, "package.json"));
  const packageJson = JSON.parse(packageBytes);
  if (packageJson.name !== "@mediapipe/tasks-vision" || packageJson.license !== "Apache-2.0")
    throw new Error("Unexpected MediaPipe package identity/license");
  const inputs = {
    recipe: "native-pose-component-v1",
    packageJson: componentBytesSha256(packageBytes),
    license: await componentFileSha256(licensePath),
    model: { ...model },
    preparer: await componentFileSha256(fileURLToPath(import.meta.url)),
    inventoryHelper: await componentFileSha256(
      fileURLToPath(new URL("./runtime-component-catalog.mjs", import.meta.url)),
    ),
  };
  for (const name of POSE_WASM_FILES)
    inputs[`wasm/${name}`] = await componentFileSha256(path.join(source, "wasm", name));
  return {
    version: packageJson.version,
    inputs,
    fingerprint: componentBytesSha256(JSON.stringify(inputs)),
  };
}

export async function reusePreparedPose(directory, fingerprint, model = POSE_MODEL, workspaceRoot) {
  try {
    await assertComponentRoot(directory, workspaceRoot);
    const manifest = JSON.parse(
      await readFile(path.join(directory, "runtime-manifest.json"), "utf8"),
    );
    if (
      manifest.schemaVersion !== 1 ||
      manifest.component !== "pose-runtime" ||
      manifest.fingerprint !== fingerprint ||
      manifest.model?.sha256 !== model.sha256 ||
      manifest.inventory?.path !== "files-manifest.json" ||
      !modelIsValid(path.join(directory, model.filename), model)
    )
      return null;
    const bytes = await readFile(path.join(directory, "files-manifest.json"));
    if (componentBytesSha256(bytes) !== manifest.inventory.sha256) return null;
    const recorded = JSON.parse(bytes);
    const actual = (await inventoryComponentFiles(directory)).filter(
      (entry) => entry.path !== "runtime-manifest.json" && entry.path !== "files-manifest.json",
    );
    if (
      !Array.isArray(recorded) ||
      recorded.length !== manifest.inventory.count ||
      JSON.stringify(recorded) !== JSON.stringify(actual)
    )
      return null;
    return manifest;
  } catch {
    return null;
  }
}

export async function removeLegacyPublicPose(
  root,
  source,
  model = POSE_MODEL,
  { remove = true } = {},
) {
  const legacy = path.resolve(root, "public", "pose");
  if (
    legacy !== path.join(path.resolve(root), "public", "pose") ||
    path.relative(root, legacy) !== path.join("public", "pose")
  )
    throw new Error("Unsafe legacy pose cleanup scope");
  if (!existsSync(legacy)) return false;
  await assertComponentRoot(legacy, root);
  const actual = await inventoryComponentFiles(legacy);
  const allowed = new Set([
    "manifest.json",
    model.filename,
    ...POSE_WASM_FILES.map((name) => `wasm/${name}`),
  ]);
  if (actual.some((entry) => !allowed.has(entry.path)))
    throw new Error("Legacy public/pose contains unknown files; refusing recursive deletion");
  for (const name of await readdir(legacy)) {
    const info = await lstat(path.join(legacy, name));
    if (info.isDirectory() && name !== "wasm")
      throw new Error("Legacy public/pose contains an unknown directory");
    if (info.isFile() && !allowed.has(name))
      throw new Error("Legacy public/pose contains unknown files");
  }
  if (existsSync(path.join(legacy, "wasm")))
    for (const name of await readdir(path.join(legacy, "wasm")))
      if ((await lstat(path.join(legacy, "wasm", name))).isDirectory())
        throw new Error("Legacy public/pose/wasm contains an unknown directory");
  const manifest = JSON.parse(await readFile(path.join(legacy, "manifest.json"), "utf8"));
  const packageJson = JSON.parse(await readFile(path.join(source, "package.json"), "utf8"));
  if (
    manifest.schemaVersion !== 1 ||
    manifest.runtime?.package !== "@mediapipe/tasks-vision" ||
    manifest.runtime.version !== packageJson.version ||
    manifest.runtime.license !== "Apache-2.0" ||
    manifest.model?.filename !== model.filename ||
    manifest.model.sha256 !== model.sha256
  )
    throw new Error("Legacy public/pose was not produced by this project's known generator");
  for (const entry of actual) {
    if (
      entry.path.startsWith("wasm/") &&
      entry.sha256 !== (await componentFileSha256(path.join(source, entry.path)))
    )
      throw new Error(`Unknown legacy pose payload: ${entry.path}`);
    if (
      entry.path === model.filename &&
      (entry.size !== model.size || entry.sha256 !== model.sha256)
    )
      throw new Error("Unknown legacy pose model");
  }
  if (remove) await rm(legacy, { recursive: true });
  return true;
}

export async function preparePoseRuntime({
  root = REPO_ROOT,
  source = path.join(root, "node_modules/@mediapipe/tasks-vision"),
  destination = path.join(root, "src-tauri/resources/pose-runtime"),
  licensePath = path.join(root, "public/licenses/mediapipe-LICENSE.txt"),
  model = POSE_MODEL,
  offline = false,
  fetchFn = globalThis.fetch,
  progress = console.log,
  cleanupLegacy = true,
} = {}) {
  const { version, inputs, fingerprint } = await poseInputs(source, licensePath, model);
  const previous = await reusePreparedPose(destination, fingerprint, model, root);
  if (previous) {
    if (cleanupLegacy) await removeLegacyPublicPose(root, source, model);
    progress(`[pose:prepare] verified native component ${version} reused → ${destination}`);
    return previous;
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await assertComponentRoot(path.dirname(destination), root);
  if (existsSync(destination)) await assertComponentRoot(destination, root);
  const stage = `${destination}.stage-${randomUUID()}`;
  const backup = `${destination}.previous-${randomUUID()}`;
  await mkdir(path.join(stage, "wasm"), { recursive: true });
  let movedPrevious = false;
  try {
    for (const name of POSE_WASM_FILES)
      await copyFile(path.join(source, "wasm", name), path.join(stage, "wasm", name));
    await copyFile(licensePath, path.join(stage, "LICENSE.txt"));
    const target = path.join(stage, model.filename);
    const existing = [
      path.join(destination, model.filename),
      path.join(root, "public/pose", model.filename),
    ].find((candidate) => modelIsValid(candidate, model));
    if (existing) await copyFile(existing, target);
    else {
      if (offline)
        throw new Error(
          "Pose model is unavailable in local prepared/public cache; offline preparation cannot download it",
        );
      const response = await fetchFn(model.url);
      if (!response.ok) throw new Error(`Pose model download failed: HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length !== model.size || componentBytesSha256(bytes) !== model.sha256)
        throw new Error("Pose model download hash/size mismatch");
      await writeFile(target, bytes);
    }
    const files = await inventoryComponentFiles(stage, { workspaceRoot: root });
    const inventoryBytes = JSON.stringify(files, null, 2) + "\n";
    await writeFile(path.join(stage, "files-manifest.json"), inventoryBytes);
    const manifest = {
      schemaVersion: 1,
      component: "pose-runtime",
      version,
      fingerprint,
      buildInputs: inputs,
      runtime: {
        package: "@mediapipe/tasks-vision",
        version,
        license: "Apache-2.0",
        wasmPath: "wasm",
      },
      model: {
        ...model,
        path: model.filename,
        license: "Apache-2.0",
        source: "https://developers.google.com/mediapipe/solutions/vision/pose_landmarker",
      },
      inventory: {
        path: "files-manifest.json",
        count: files.length,
        sha256: componentBytesSha256(inventoryBytes),
      },
    };
    await writeFile(
      path.join(stage, "runtime-manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
    );
    if (!(await reusePreparedPose(stage, fingerprint, model, root)))
      throw new Error("Staged pose component failed complete integrity verification");
    if (cleanupLegacy) await removeLegacyPublicPose(root, source, model, { remove: false });
    if (existsSync(destination)) {
      await rename(destination, backup);
      movedPrevious = true;
    }
    await rename(stage, destination);
    if (movedPrevious) await rm(backup, { recursive: true });
    if (cleanupLegacy) await removeLegacyPublicPose(root, source, model);
    progress(
      `[pose:prepare] complete native component ${version}, ${files.length} payload files → ${destination}`,
    );
    return manifest;
  } catch (error) {
    if (movedPrevious && !existsSync(destination)) await rename(backup, destination);
    throw error;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  preparePoseRuntime({ offline: process.argv.includes("--offline-cached") }).catch((error) => {
    console.error(`[pose:prepare] ${error.message}`);
    process.exitCode = 1;
  });
}
