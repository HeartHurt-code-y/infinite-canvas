import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertComponentPlatform,
  buildRuntimeComponentCatalog,
  componentBytesSha256,
  componentPathIsValid,
  describeRuntimeComponent,
  inventoryComponentFiles,
  RUNTIME_COMPONENTS,
  runtimeComponentArchiveUrl,
} from "./runtime-component-catalog.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ic-components-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "runtime");
  await mkdir(directory);
  await writeFile(path.join(directory, "LICENSE.txt"), "the license stays in the archive");
  await writeFile(path.join(directory, "worker.exe"), "native worker");
  const files = await inventoryComponentFiles(directory);
  const bytes = JSON.stringify(files, null, 2) + "\n";
  await writeFile(path.join(directory, "files-manifest.json"), bytes);
  await writeFile(
    path.join(directory, "runtime-manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      version: "1.0.0",
      platform: "win32",
      arch: "x64",
      inventory: {
        path: "files-manifest.json",
        count: files.length,
        sha256: componentBytesSha256(bytes),
      },
    }),
  );
  const definition = {
    id: "example",
    title: "Example",
    description: "Example",
    sourcePath: "runtime",
    manifestPath: "runtime-manifest.json",
    bundlePath: "example",
    dependencies: [],
  };
  return { root, directory, definition };
}

test("catalog includes both native manifests, all legal files and excludes only installation marker", async (t) => {
  const { root, directory, definition } = await fixture(t);
  await writeFile(path.join(directory, ".complete.json"), "installed marker");
  const component = await describeRuntimeComponent(definition, { root });
  assert.deepEqual(
    component.files.map((entry) => entry.path),
    ["LICENSE.txt", "files-manifest.json", "runtime-manifest.json", "worker.exe"],
  );
  assert.equal(component.files.find((entry) => entry.path === "worker.exe").mode, 0o755);
  assert.equal(
    component.manifestSha256,
    component.files.find((entry) => entry.path === "runtime-manifest.json").sha256,
  );
  await writeFile(path.join(directory, "unrecorded.txt"), "extra");
  await assert.rejects(describeRuntimeComponent(definition, { root }), /inventory count mismatch/);
});

test("native inventory corruption, duplicate entries and stale payload fail closed", async (t) => {
  const { root, directory, definition } = await fixture(t);
  const manifestPath = path.join(directory, "runtime-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath));
  const inventory = JSON.parse(await readFile(path.join(directory, "files-manifest.json")));
  const corrupted = JSON.stringify([inventory[0], inventory[0]]);
  manifest.inventory.sha256 = componentBytesSha256(corrupted);
  await writeFile(path.join(directory, "files-manifest.json"), corrupted);
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(describeRuntimeComponent(definition, { root }), /entry mismatch/);
});

test("AI native bytes inventory is verified without changing its existing contract", async (t) => {
  const { root, directory, definition } = await fixture(t);
  const manifestPath = path.join(directory, "runtime-manifest.json");
  const inventoryPath = path.join(directory, "files-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath));
  const recorded = JSON.parse(await readFile(inventoryPath)).map(({ path, size, sha256 }) => ({
    type: "file",
    path,
    bytes: size,
    sha256,
  }));
  async function saveInventory() {
    const bytes = JSON.stringify(recorded);
    manifest.inventory.sha256 = componentBytesSha256(bytes);
    await writeFile(inventoryPath, bytes);
    await writeFile(manifestPath, JSON.stringify(manifest));
  }
  await saveInventory();
  for (const id of ["ai-media-runtime", "ai-media-quality-runtime"])
    assert.equal((await describeRuntimeComponent({ ...definition, id }, { root })).files.length, 4);
  recorded[0].bytes += 1;
  await saveInventory();
  await assert.rejects(
    describeRuntimeComponent({ ...definition, id: "ai-media-runtime" }, { root }),
    /entry mismatch/,
  );
});

test("root and nested junctions cannot import an external tree", async (t) => {
  const { root, directory } = await fixture(t);
  const external = await mkdtemp(path.join(os.tmpdir(), "ic-external-"));
  t.after(() => rm(external, { recursive: true, force: true }));
  await writeFile(path.join(external, "outside.txt"), "outside");
  const linked = path.join(root, "linked");
  await symlink(external, linked, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(inventoryComponentFiles(linked, { workspaceRoot: root }), /materialized/);
  await symlink(
    external,
    path.join(directory, "nested"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(inventoryComponentFiles(directory), /symlink or junction/);
  await assert.rejects(
    inventoryComponentFiles(external, { workspaceRoot: root }),
    /outside workspace/,
  );
});

test("Windows-safe paths reject traversal, aliases and control characters", () => {
  for (const candidate of [
    "../x",
    "/x",
    "a\\b",
    "C:/x",
    "a//b",
    "NUL.txt",
    "x. /y",
    "x\u0000y",
    ".",
    "a/..",
    "foo.",
  ])
    assert.equal(componentPathIsValid(candidate), false, candidate);
  assert.equal(componentPathIsValid("runtime/4.5/许可证.txt"), true);
});

test("seven component/features catalog is stable and does not introduce optional AI dependencies into other features", () => {
  const components = RUNTIME_COMPONENTS.map(({ id }) => ({ id }));
  const first = buildRuntimeComponentCatalog({ applicationVersion: "0.2.1", components });
  const second = buildRuntimeComponentCatalog({ applicationVersion: "0.2.1", components });
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.features.find((feature) => feature.id === "white-model-render").components,
    ["blender", "ffmpeg"],
  );
  assert.throws(
    () =>
      buildRuntimeComponentCatalog({
        applicationVersion: "0.2.1",
        components: [...components, components[0]],
      }),
    /exactly once/,
  );
  assert.throws(() => assertComponentPlatform("darwin", "arm64"), /only native Windows/);
  assert.throws(
    () => assertComponentPlatform("win32", "x64", "aarch64-pc-windows-msvc"),
    /only native Windows/,
  );
  assert.doesNotThrow(() => assertComponentPlatform("win32", "x64", "x86_64-pc-windows-msvc"));
});

test("archives remain on the trusted public component prefix", () => {
  const digest = "a".repeat(64);
  const url = runtimeComponentArchiveUrl("pose-runtime", digest, { applicationVersion: "0.2.1" });
  assert.match(
    url,
    /\/infinite-canvas\/updates\/components\/windows-x86_64\/0\.2\.1\/pose-runtime-a{64}\.zip$/,
  );
  assert.throws(
    () =>
      runtimeComponentArchiveUrl("pose-runtime", digest, {
        applicationVersion: "0.2.1",
        publicBaseUrl: "https://example.com/infinite-canvas/updates",
      }),
    /trusted/,
  );
  assert.throws(
    () => runtimeComponentArchiveUrl("../x", digest, { applicationVersion: "0.2.1" }),
    /identity/,
  );
});
