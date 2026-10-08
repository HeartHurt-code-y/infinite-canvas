import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { inspectAiMediaPack } from "./package-ai-media-runtime.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function fixture(t, entries) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-media-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from("test-python");
  await mkdir(path.join(root, "python"));
  await writeFile(path.join(root, "python/python.exe"), bytes);
  const inventory = Buffer.from(
    JSON.stringify(
      entries ?? [
        { type: "file", path: "python/python.exe", bytes: bytes.length, sha256: digest(bytes) },
      ],
    ),
  );
  await writeFile(path.join(root, "files-manifest.json"), inventory);
  await writeFile(
    path.join(root, "runtime-manifest.json"),
    JSON.stringify({
      runtimeProfile: "lite",
      pythonPath: "python/python.exe",
      inventory: {
        path: "files-manifest.json",
        count: JSON.parse(inventory).length,
        sha256: digest(inventory),
      },
    }),
  );
  return root;
}

test("offline component includes only the verified inventory", async (t) => {
  const root = await fixture(t);
  const result = await inspectAiMediaPack(root);
  assert.equal(result.fileCount, 1);
  assert.equal(result.totalBytes, 11);
  await writeFile(path.join(root, "unlisted.dll"), "extra");
  await assert.rejects(inspectAiMediaPack(root), /未登记/);
});

test("offline component rejects tampered model/runtime bytes", async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, "python/python.exe"), "tampered");
  await assert.rejects(inspectAiMediaPack(root), /文件校验失败/);
});

test("offline component rejects path traversal before filesystem access", async (t) => {
  const root = await fixture(t, [
    { type: "file", path: "../outside.dll", bytes: 1, sha256: "0".repeat(64) },
  ]);
  await assert.rejects(inspectAiMediaPack(root), /无效或重复路径/);
});

test("main installer excludes both optional AI components", async () => {
  const { readFile } = await import("node:fs/promises");
  const config = JSON.parse(
    await readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
  );
  assert.equal(
    Object.keys(config.bundle.resources).some((name) => name.includes("ai-media")),
    false,
  );
  assert.match(config.build.beforeBuildCommand, /pnpm ai-media:prepare:quality/);
});
