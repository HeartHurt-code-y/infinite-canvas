import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertRuntimeBaseline,
  hashResourceTree,
  STABLE_RESOURCE_DIRS,
} from "./runtime-resource-baseline.mjs";

test("slim release baseline detects byte changes in retained resources", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "infinite-canvas-baseline-"));
  try {
    mkdirSync(path.join(root, "nested"));
    writeFileSync(path.join(root, "nested", "engine.exe"), "original");
    const first = await hashResourceTree(root);
    writeFileSync(path.join(root, "nested", "engine.exe"), "changed!");
    const second = await hashResourceTree(root);
    assert.notEqual(first.sha256, second.sha256);
    const resources = Object.fromEntries(STABLE_RESOURCE_DIRS.map((name) => [name, first]));
    const expected = {
      schemaVersion: 2,
      platform: "windows-x86_64",
      bridgeVersion: "0.1.8",
      fullNsisSha256: "a".repeat(64),
      fullNsisSignatureSha256: "b".repeat(64),
      resources,
    };
    assert.doesNotThrow(() => assertRuntimeBaseline(expected, expected, "0.1.9"));
    assert.throws(() => assertRuntimeBaseline(expected, expected, "0.1.8"), /必须高于/);
    assert.throws(
      () =>
        assertRuntimeBaseline(expected, {
          ...expected,
          resources: { ...resources, [STABLE_RESOURCE_DIRS[0]]: second },
        }),
      /不能制作瘦包/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resource baseline hashes internal junction contents without machine-specific targets", async () => {
  const roots = [
    mkdtempSync(path.join(os.tmpdir(), "resource-baseline-a-")),
    mkdtempSync(path.join(os.tmpdir(), "resource-baseline-b-")),
  ];
  try {
    for (const root of roots) {
      mkdirSync(path.join(root, "store"));
      writeFileSync(path.join(root, "store", "engine.js"), "same content");
      symlinkSync(
        path.join(root, "store"),
        path.join(root, "alias"),
        process.platform === "win32" ? "junction" : "dir",
      );
    }
    const [first, second] = await Promise.all(roots.map(hashResourceTree));
    assert.deepEqual(first, second);
    writeFileSync(path.join(roots[1], "store", "engine.js"), "changed");
    assert.notEqual((await hashResourceTree(roots[1])).sha256, first.sha256);
    symlinkSync(
      roots[1],
      path.join(roots[0], "outside"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(() => hashResourceTree(roots[0]), /越出目录/);
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});
