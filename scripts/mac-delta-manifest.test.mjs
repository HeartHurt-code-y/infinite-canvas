import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { rm } from "node:fs/promises";
import {
  MAC_DELTA_OBJECT_BASE_URL,
  inventoryMacApp,
  stageMacDelta,
  validateMacDeltaManifest,
} from "./mac-delta-manifest.mjs";

function app(root, name) {
  const directory = path.join(root, name, "无限画布.app");
  mkdirSync(path.join(directory, "Contents", "MacOS"), { recursive: true });
  mkdirSync(path.join(directory, "Contents", "Resources", "empty"), { recursive: true });
  return directory;
}

test("stages only changed file objects and signs a complete, ordered tree input", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mac-delta-"));
  try {
    const base = app(root, "base");
    const target = app(root, "target");
    for (const directory of [base, target]) {
      writeFileSync(path.join(directory, "Contents", "MacOS", "canvas"), "unchanged executable");
    }
    writeFileSync(path.join(base, "Contents", "Resources", "data.bin"), "old");
    writeFileSync(path.join(target, "Contents", "Resources", "data.bin"), "new bytes");
    writeFileSync(path.join(target, "Contents", "Resources", "new.bin"), "new bytes");
    const output = path.join(root, "stage");
    const staged = await stageMacDelta({
      baseAppDir: base,
      targetAppDir: target,
      baseVersion: "0.1.10",
      version: "0.1.11",
      outDir: output,
    });
    const manifest = JSON.parse(readFileSync(staged.manifestPath, "utf8"));
    assert.deepEqual(validateMacDeltaManifest(manifest), manifest);
    assert.equal(manifest.platform, "darwin-aarch64");
    assert.equal(manifest.appName, "无限画布.app");
    assert.equal(
      manifest.files.find((entry) => entry.path === "Contents/MacOS/canvas").source,
      "base",
    );
    assert.equal(
      manifest.files.find((entry) => entry.path === "Contents/Resources/data.bin").source,
      "object",
    );
    assert.equal(
      manifest.files.find((entry) => entry.path === "Contents/Resources/new.bin").source,
      "object",
    );
    assert.equal(
      manifest.files.find((entry) => entry.path === "Contents/Resources/empty").kind,
      "dir",
    );
    assert.equal(staged.changedBytes, Buffer.byteLength("new bytes"));
    assert.deepEqual(
      manifest.files.map((entry) => entry.path),
      [...manifest.files.map((entry) => entry.path)].sort((a, b) =>
        Buffer.compare(Buffer.from(a), Buffer.from(b)),
      ),
    );
    const object = manifest.files.find(
      (entry) => entry.path === "Contents/Resources/data.bin",
    ).sha256;
    assert.equal(readFileSync(path.join(staged.objectDir, object), "utf8"), "new bytes");
    await assert.rejects(
      () =>
        stageMacDelta({
          baseAppDir: base,
          targetAppDir: target,
          baseVersion: "0.1.10",
          version: "0.1.11",
          outDir: output,
        }),
      /必须为空/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects unsafe link targets, path aliases and missing parent directories", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mac-delta-check-"));
  try {
    const target = app(root, "target");
    const files = await inventoryMacApp(target);
    const valid = {
      schemaVersion: 1,
      baseVersion: "0.1.10",
      version: "0.1.11",
      platform: "darwin-aarch64",
      appName: "无限画布.app",
      objectBaseUrl: MAC_DELTA_OBJECT_BASE_URL,
      files,
    };
    assert.doesNotThrow(() => validateMacDeltaManifest(valid));
    const escaped = {
      ...valid,
      files: [...files, { path: "escape", kind: "symlink", target: "../outside" }].sort((a, b) =>
        Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)),
      ),
    };
    assert.throws(() => validateMacDeltaManifest(escaped), /越界/);
    const alias = {
      ...valid,
      files: [...files, { path: "contents", kind: "dir", mode: 0o755 }].sort((a, b) =>
        Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)),
      ),
    };
    assert.throws(() => validateMacDeltaManifest(alias), /大小写或 Unicode 冲突/);
    const missingParent = {
      ...valid,
      files: [
        ...files,
        {
          path: "Contents/no-parent/file",
          kind: "file",
          size: 0,
          sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          mode: 0o644,
          source: "object",
        },
      ].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))),
    };
    assert.throws(() => validateMacDeltaManifest(missingParent), /父目录缺失/);
    assert.throws(
      () => validateMacDeltaManifest({ ...valid, objectBaseUrl: "https://example.com/objects/" }),
      /对象地址无效/,
    );
    assert.throws(
      () => validateMacDeltaManifest({ ...valid, baseVersion: "0.1.12" }),
      /结构或版本无效/,
    );
    assert.doesNotThrow(() => validateMacDeltaManifest({ ...valid, version: "0.1.12" }));
    const linked = {
      ...valid,
      files: [
        ...files,
        { path: "Contents/Resources/a", kind: "symlink", target: "b" },
        { path: "Contents/Resources/b", kind: "symlink", target: "empty" },
      ].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))),
    };
    assert.doesNotThrow(() => validateMacDeltaManifest(linked));
    const cycle = {
      ...linked,
      files: linked.files.map((entry) =>
        entry.path === "Contents/Resources/b" ? { ...entry, target: "a" } : entry,
      ),
    };
    assert.throws(() => validateMacDeltaManifest(cycle), /成环/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inventories in-bundle symlink chains and rejects links escaping the app", async (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mac-delta-links-"));
  try {
    const target = app(root, "target");
    const resources = path.join(target, "Contents", "Resources");
    try {
      symlinkSync("empty", path.join(resources, "a"), "dir");
      symlinkSync("a", path.join(resources, "b"), "dir");
    } catch (error) {
      if (process.platform === "win32" && error?.code === "EPERM") {
        context.skip("Windows lacks permission to create a test symlink");
        return;
      }
      throw error;
    }
    const files = await inventoryMacApp(target);
    assert.deepEqual(
      files.filter((entry) => entry.kind === "symlink").map((entry) => entry.path),
      ["Contents/Resources/a", "Contents/Resources/b"],
    );
    assert.doesNotThrow(() =>
      validateMacDeltaManifest({
        schemaVersion: 1,
        baseVersion: "0.1.10",
        version: "0.1.11",
        platform: "darwin-aarch64",
        appName: "无限画布.app",
        objectBaseUrl: MAC_DELTA_OBJECT_BASE_URL,
        files,
      }),
    );
    symlinkSync("../../../../outside", path.join(resources, "escape"), "dir");
    await assert.rejects(() => inventoryMacApp(target), /符号链接越界/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
