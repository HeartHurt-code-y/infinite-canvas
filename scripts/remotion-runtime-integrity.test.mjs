import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildRemotionFileInventory,
  hashRemotionCriticalFiles,
  remotionCriticalFilesMatch,
  remotionInventoryManifestMatches,
  remotionInventoryFilesMatch,
  remotionTreeIsMaterialized,
  materializeRemotionRuntime,
  writeRemotionFileInventory,
} from "./remotion-runtime-integrity.mjs";

test("prepared Remotion manifest detects changes to runtime executables and scripts", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "remotion-critical-"));
  try {
    mkdirSync(path.join(root, "browser"));
    mkdirSync(path.join(root, "bundle"));
    for (const name of [
      "node.exe",
      "browser/chrome-headless-shell.exe",
      "render.mjs",
      "plan.mjs",
      "bundle/index.html",
    ]) {
      writeFileSync(path.join(root, name), `original:${name}`);
    }
    const hashes = await hashRemotionCriticalFiles(
      root,
      "node.exe",
      "browser/chrome-headless-shell.exe",
    );
    assert.equal(Object.keys(hashes).length, 5);
    assert.equal(
      await remotionCriticalFilesMatch(
        root,
        "node.exe",
        "browser/chrome-headless-shell.exe",
        hashes,
      ),
      true,
    );
    writeFileSync(path.join(root, "render.mjs"), "changed");
    assert.equal(
      await remotionCriticalFilesMatch(
        root,
        "node.exe",
        "browser/chrome-headless-shell.exe",
        hashes,
      ),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("materialization replaces internal junctions with ordinary bundled directories", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "remotion-materialize-"));
  try {
    const packageDir = path.join(root, "node_modules", ".pnpm", "pkg");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(path.join(packageDir, "index.js"), "module.exports = true");
    symlinkSync(
      packageDir,
      path.join(root, "node_modules", "pkg"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const inventory = await writeRemotionFileInventory(root);
    writeFileSync(path.join(root, "runtime-manifest.json"), JSON.stringify({ inventory }));
    assert.equal(await remotionTreeIsMaterialized(root), false);
    await materializeRemotionRuntime(root, inventory);
    assert.equal(await remotionTreeIsMaterialized(root), true);
    assert.equal(lstatSync(path.join(root, "node_modules", "pkg")).isDirectory(), true);
    assert.equal(
      readFileSync(path.join(root, "node_modules", "pkg", "index.js"), "utf8"),
      "module.exports = true",
    );
    assert.equal(await remotionInventoryFilesMatch(root, inventory), true);
    assert.equal(existsSync(path.join(root, "runtime-manifest.json")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Remotion inventory expands internal junctions into sorted logical file paths", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "remotion-inventory-"));
  try {
    const packageDir = path.join(root, "node_modules", ".pnpm", "pkg", "node_modules", "pkg");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(path.join(packageDir, "index.js"), "module.exports = 1");
    symlinkSync(
      packageDir,
      path.join(root, "node_modules", "pkg"),
      process.platform === "win32" ? "junction" : "dir",
    );
    writeFileSync(path.join(root, "runtime-manifest.json"), "old manifest");
    const inventory = await writeRemotionFileInventory(root);
    const files = await buildRemotionFileInventory(root);
    assert.deepEqual(
      files.map((file) => file.path),
      ["node_modules/.pnpm/pkg/node_modules/pkg/index.js", "node_modules/pkg/index.js"],
    );
    assert.equal(files[0].sha256, files[1].sha256);
    assert.equal(inventory.count, 2);
    assert.equal(await remotionInventoryManifestMatches(root, inventory), true);
    writeFileSync(path.join(root, "files-manifest.json"), "[]");
    assert.equal(await remotionInventoryManifestMatches(root, inventory), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Remotion inventory rejects links outside root and cycles", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "remotion-inventory-links-"));
  const outside = mkdtempSync(path.join(os.tmpdir(), "remotion-inventory-outside-"));
  try {
    mkdirSync(path.join(root, "inner"));
    symlinkSync(
      outside,
      path.join(root, "inner", "outside"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(() => buildRemotionFileInventory(root), /越出根目录/);
    rmSync(path.join(root, "inner", "outside"));
    symlinkSync(
      root,
      path.join(root, "inner", "loop"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(() => buildRemotionFileInventory(root), /形成循环/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
