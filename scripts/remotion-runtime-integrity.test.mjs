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
  remotionPackagesPresent,
  remotionCachedSourcesMatch,
  writeRemotionFileInventory,
} from "./remotion-runtime-integrity.mjs";

test("offline migration verifies copied sources and original bundled sources from preserved error maps", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "remotion-cached-sources-"));
  const source = mkdtempSync(path.join(os.tmpdir(), "remotion-current-sources-"));
  try {
    mkdirSync(path.join(root, "bundle"));
    for (const name of [
      "package.json",
      "pnpm-lock.yaml",
      "plan.mjs",
      "Composition.tsx",
      "render.mjs",
      "resolve-douyin.mjs",
      "resolve-rednote.mjs",
      "index.tsx",
    ]) {
      writeFileSync(path.join(source, name), `current:${name}`);
      if (name !== "index.tsx") writeFileSync(path.join(root, name), `current:${name}`);
    }
    const sources = ["./index.tsx", "./Composition.tsx", "./plan.mjs"];
    const sourcesContent = ["current:index.tsx", "current:Composition.tsx", "current:plan.mjs"];
    const map = path.join(root, "bundle/bundle.js.map");
    writeFileSync(map, JSON.stringify({ sources, sourcesContent }));
    assert.equal(await remotionCachedSourcesMatch(root, source), true);
    writeFileSync(path.join(source, "index.tsx"), "new entrypoint");
    assert.equal(await remotionCachedSourcesMatch(root, source), false);
    writeFileSync(path.join(source, "index.tsx"), "current:index.tsx");
    writeFileSync(path.join(root, "resolve-douyin.mjs"), "stale resolver");
    assert.equal(await remotionCachedSourcesMatch(root, source), false);
    writeFileSync(path.join(root, "resolve-douyin.mjs"), "current:resolve-douyin.mjs");
    rmSync(map);
    assert.equal(await remotionCachedSourcesMatch(root, source), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
  }
});

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
      "resolve-douyin.mjs",
      "resolve-rednote.mjs",
      "bundle/index.html",
    ]) {
      writeFileSync(path.join(root, name), `original:${name}`);
    }
    const hashes = await hashRemotionCriticalFiles(
      root,
      "node.exe",
      "browser/chrome-headless-shell.exe",
    );
    assert.equal(Object.keys(hashes).length, 7);
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
    writeFileSync(path.join(root, "render.mjs"), "original:render.mjs");
    writeFileSync(path.join(root, "resolve-douyin.mjs"), "changed");
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

test("runtime dependencies must include Playwright and source-map before preparation is ready", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "remotion-deps-"));
  try {
    const packages = ["@remotion/renderer", "playwright-core", "source-map"];
    for (const name of ["@remotion/renderer", "source-map"]) {
      const directory = path.join(root, "node_modules", ...name.split("/"));
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, "package.json"), "{}");
    }
    assert.equal(remotionPackagesPresent(root, packages), false);
    const playwright = path.join(root, "node_modules", "playwright-core");
    mkdirSync(playwright, { recursive: true });
    writeFileSync(path.join(playwright, "package.json"), "{}");
    assert.equal(remotionPackagesPresent(root, packages), true);
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
