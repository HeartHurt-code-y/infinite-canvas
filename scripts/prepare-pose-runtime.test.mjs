import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { componentBytesSha256 } from "./runtime-component-catalog.mjs";
import {
  POSE_WASM_FILES,
  preparePoseRuntime,
  removeLegacyPublicPose,
  reusePreparedPose,
} from "./prepare-pose-runtime.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ic-pose-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "node_modules/tasks-vision");
  const legacy = path.join(root, "public/pose");
  const modelBytes = Buffer.from("verified local pose model");
  const model = {
    filename: "pose_landmarker_full.task",
    url: "https://example.invalid/model",
    size: modelBytes.length,
    sha256: componentBytesSha256(modelBytes),
  };
  await mkdir(path.join(source, "wasm"), { recursive: true });
  await mkdir(path.join(legacy, "wasm"), { recursive: true });
  await mkdir(path.join(root, "public/licenses"), { recursive: true });
  await writeFile(
    path.join(source, "package.json"),
    JSON.stringify({ name: "@mediapipe/tasks-vision", version: "1.0.1", license: "Apache-2.0" }),
  );
  await writeFile(
    path.join(root, "public/licenses/mediapipe-LICENSE.txt"),
    "Apache License Version 2.0, complete license",
  );
  for (const name of POSE_WASM_FILES) {
    await writeFile(path.join(source, "wasm", name), `wasm ${name}`);
    await writeFile(path.join(legacy, "wasm", name), `wasm ${name}`);
  }
  await writeFile(path.join(legacy, model.filename), modelBytes);
  await writeFile(
    path.join(legacy, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      runtime: { package: "@mediapipe/tasks-vision", version: "1.0.1", license: "Apache-2.0" },
      model: { ...model, state: "cached" },
    }),
  );
  return {
    root,
    source,
    model,
    legacy,
    destination: path.join(root, "src-tauri/resources/pose-runtime"),
    offline: true,
    progress: () => {},
    fetchFn: () => {
      throw new Error("network must not run");
    },
  };
}

test("pose migrates verified cached assets out of public with full inventory/license and stable reuse", async (t) => {
  const options = await fixture(t);
  const manifest = await preparePoseRuntime(options);
  assert.equal(manifest.inventory.count, 6);
  assert.equal(existsSync(options.legacy), false);
  assert.equal(existsSync(path.join(options.destination, "LICENSE.txt")), true);
  const inventory = await readFile(path.join(options.destination, "files-manifest.json"));
  assert.equal(componentBytesSha256(inventory), manifest.inventory.sha256);
  assert.deepEqual(await preparePoseRuntime(options), manifest);
  await writeFile(
    path.join(options.destination, "wasm", POSE_WASM_FILES[0]),
    "same hash impossible",
  );
  assert.equal(
    await reusePreparedPose(options.destination, manifest.fingerprint, options.model),
    null,
  );
  assert.deepEqual((await preparePoseRuntime(options)).inventory, manifest.inventory);
});

test("unknown public files or empty directories are kept and fail cleanup before native replacement", async (t) => {
  const options = await fixture(t);
  await writeFile(path.join(options.legacy, "user-owned.txt"), "keep me");
  await assert.rejects(preparePoseRuntime(options), /unknown files/);
  assert.equal(existsSync(path.join(options.legacy, "user-owned.txt")), true);
  assert.equal(existsSync(options.destination), false);
  await rm(path.join(options.legacy, "user-owned.txt"));
  await mkdir(path.join(options.legacy, "unknown-empty"));
  await assert.rejects(
    removeLegacyPublicPose(options.root, options.source, options.model),
    /unknown directory/,
  );
});

test("legacy public junctions cannot be removed or used for migration", async (t) => {
  const options = await fixture(t);
  const external = path.join(options.root, "external");
  await mkdir(external);
  await writeFile(path.join(external, "outside.txt"), "keep");
  await rm(options.legacy, { recursive: true });
  await symlink(external, options.legacy, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(preparePoseRuntime(options), /offline preparation cannot download/);
  await assert.rejects(
    removeLegacyPublicPose(options.root, options.source, options.model),
    /materialized/,
  );
  assert.equal(existsSync(path.join(external, "outside.txt")), true);
});

test("offline preparation fails when model cache is absent, leaving generated assets intact", async (t) => {
  const options = await fixture(t);
  await rm(path.join(options.legacy, options.model.filename));
  await assert.rejects(preparePoseRuntime(options), /offline preparation cannot download/);
  assert.equal(existsSync(path.join(options.legacy, "manifest.json")), true);
  assert.equal(existsSync(options.destination), false);
});
