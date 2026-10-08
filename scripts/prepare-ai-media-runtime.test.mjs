import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { AI_MEDIA_PRUNING_POLICY } from "./ai-media-runtime-prune.mjs";
import {
  downloadVerified,
  fileInventory,
  safeRelative,
  torchVersions,
  MODELS,
  LITE_DEPENDENCIES,
  OPEN_UNMIX_CHECKPOINT,
  reusePrepared,
  sha256,
} from "./prepare-ai-media-runtime.mjs";

test("default lightweight dependencies exclude Torch and licensed model pins are complete", () => {
  assert.equal(
    Object.keys(LITE_DEPENDENCIES).some((name) => name.startsWith("torch")),
    false,
  );
  assert.equal(MODELS[0].license, "Apache-2.0");
  assert.equal(OPEN_UNMIX_CHECKPOINT.license, "MIT");
  for (const model of [...MODELS, OPEN_UNMIX_CHECKPOINT]) {
    assert.match(model.sha256, /^[0-9a-f]{64}$/);
    assert.equal(safeRelative(model.path), true);
  }
  assert.equal(
    torchVersions("win32", "x64", "cuda").index,
    "https://download.pytorch.org/whl/cu128",
  );
  assert.throws(() => torchVersions("darwin", "arm64", "cuda"));
});

test("component paths cannot escape their verified directory", () => {
  for (const filename of [
    "../worker.py",
    "python/../../worker.py",
    "/tmp/x",
    "C:/x",
    "python\\python.exe",
    "x/./y",
    "a//b",
    "x\0y",
  ])
    assert.equal(safeRelative(filename), false);
  assert.equal(safeRelative("python/Lib/site-packages/onnxruntime/capi/runtime.dll"), true);
});

test("complete file inventory hashes nested runtime files and excludes its own manifest", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-media-integrity-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, "worker"));
  await writeFile(path.join(directory, "worker/worker.py"), "offline-worker");
  await writeFile(path.join(directory, "runtime-manifest.json"), "manifest");
  const entries = await fileInventory(directory);
  assert.deepEqual(entries, [
    {
      type: "file",
      path: "worker/worker.py",
      bytes: 14,
      sha256: createHash("sha256").update("offline-worker").digest("hex"),
    },
  ]);
});

test("corrupted cached artifacts are rejected without publishing downloaded bytes", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-media-download-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "model.pth");
  await writeFile(target, "old");
  await assert.rejects(
    downloadVerified("data:application/octet-stream;base64,YmFk", target, {
      bytes: 3,
      sha256: "0".repeat(64),
    }),
    /校验失败/,
  );
  assert.equal(await readFile(target, "utf8"), "old");
});

test("artifact downloads identify the project and verify complete response bytes", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-media-download-agent-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from("pinned-official-model-payload");
  let accepted = 0;
  const server = createServer((request, response) => {
    if (
      !/^infinite-canvas-build\/\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(
        request.headers["user-agent"] ?? "",
      ) ||
      request.headers.accept !== "application/octet-stream"
    ) {
      response.writeHead(403);
      response.end("Project download identity required");
      return;
    }
    accepted += 1;
    response.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": bytes.length,
    });
    response.end(bytes);
  });
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/model.pth`;
  const anonymous = await fetch(url);
  assert.equal(anonymous.status, 403);
  await anonymous.arrayBuffer();
  const target = path.join(directory, "model.pth");
  const pin = { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  await downloadVerified(url, target, pin);
  assert.deepEqual(await readFile(target), bytes);
  assert.equal(await sha256(target), pin.sha256);
  await downloadVerified(url, target, pin);
  assert.equal(accepted, 1, "a verified cache entry does not need another network request");
});

test("prepared components reuse only unchanged build inputs and every recorded file", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-media-reuse-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const inputs = {
    sha256: "1".repeat(64),
    platform: "win32",
    arch: "x64",
    runtimeProfile: "lite",
    profile: "cpu",
  };
  await writeFile(path.join(directory, "worker.py"), "verified-worker");
  const recorded = await fileInventory(directory);
  await writeFile(path.join(directory, "files-manifest.json"), JSON.stringify(recorded));
  const manifest = {
    ...inputs,
    buildInputs: inputs,
    pruning: { policyVersion: AI_MEDIA_PRUNING_POLICY },
    inventory: {
      path: "files-manifest.json",
      count: recorded.length,
      sha256: await sha256(path.join(directory, "files-manifest.json")),
    },
  };
  await writeFile(path.join(directory, "runtime-manifest.json"), JSON.stringify(manifest));
  assert.deepEqual(await reusePrepared(directory, inputs), manifest);
  const oldManifest = { ...manifest };
  delete oldManifest.pruning;
  await writeFile(path.join(directory, "runtime-manifest.json"), JSON.stringify(oldManifest));
  assert.equal(await reusePrepared(directory, inputs), null);
  await writeFile(path.join(directory, "runtime-manifest.json"), JSON.stringify(manifest));
  assert.equal(await reusePrepared(directory, { ...inputs, sha256: "2".repeat(64) }), null);
  await writeFile(path.join(directory, "worker.py"), "modified-worker");
  assert.equal(await reusePrepared(directory, inputs), null);
  await writeFile(path.join(directory, "worker.py"), "verified-worker");
  await writeFile(path.join(directory, "unrecorded.py"), "extra-code");
  assert.equal(await reusePrepared(directory, inputs), null);
});
