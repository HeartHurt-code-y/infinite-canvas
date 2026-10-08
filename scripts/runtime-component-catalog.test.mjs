import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertComponentPlatform,
  buildRuntimeComponentCatalog,
  componentBytesSha256,
  componentPlatform,
  componentPathIsValid,
  componentSymlinkTargetIsValid,
  describeRuntimeComponent,
  inventoryComponentFiles,
  RUNTIME_COMPONENTS,
  runtimeComponentArchiveUrl,
  validateMacRuntimeComponent,
} from "./runtime-component-catalog.mjs";
const WINDOWS = { platform: "win32", arch: "x64" };

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ic-components-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "runtime");
  await mkdir(directory);
  await writeFile(path.join(directory, "LICENSE.txt"), "the license stays in the archive");
  await writeFile(path.join(directory, "worker.exe"), "native worker");
  const files = await inventoryComponentFiles(directory, WINDOWS);
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
  const component = await describeRuntimeComponent(definition, { root, ...WINDOWS });
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
  await assert.rejects(
    describeRuntimeComponent(definition, { root, ...WINDOWS }),
    /inventory count mismatch/,
  );
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
  await assert.rejects(
    describeRuntimeComponent(definition, { root, ...WINDOWS }),
    /entry mismatch/,
  );
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
    assert.equal(
      (await describeRuntimeComponent({ ...definition, id }, { root, ...WINDOWS })).files.length,
      4,
    );
  recorded[0].bytes += 1;
  await saveInventory();
  await assert.rejects(
    describeRuntimeComponent({ ...definition, id: "ai-media-runtime" }, { root, ...WINDOWS }),
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
  await assert.rejects(inventoryComponentFiles(directory, WINDOWS), /symlink or junction/);
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
  const first = buildRuntimeComponentCatalog({
    applicationVersion: "0.2.1",
    components,
    platform: "windows-x86_64",
  });
  const second = buildRuntimeComponentCatalog({
    applicationVersion: "0.2.1",
    components,
    platform: "windows-x86_64",
  });
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.features.find((feature) => feature.id === "white-model-render").components,
    ["blender", "ffmpeg"],
  );
  assert.throws(
    () =>
      buildRuntimeComponentCatalog({
        applicationVersion: "0.2.1",
        platform: "windows-x86_64",
        components: [...components, components[0]],
      }),
    /exactly once/,
  );
  assert.doesNotThrow(() => assertComponentPlatform("darwin", "arm64", "aarch64-apple-darwin"));
  assert.doesNotThrow(() => assertComponentPlatform("darwin", "x64", "x86_64-apple-darwin"));
  assert.throws(
    () => assertComponentPlatform("win32", "x64", "aarch64-pc-windows-msvc"),
    /requires native/,
  );
  assert.doesNotThrow(() => assertComponentPlatform("win32", "x64", "x86_64-pc-windows-msvc"));
});

test("archives remain on the trusted public component prefix", () => {
  const digest = "a".repeat(64);
  const url = runtimeComponentArchiveUrl("pose-runtime", digest, {
    applicationVersion: "0.2.1",
    platform: "windows-x86_64",
  });
  assert.match(
    url,
    /\/infinite-canvas\/updates\/components\/windows-x86_64\/0\.2\.1\/pose-runtime-a{64}\.zip$/,
  );
  assert.throws(
    () =>
      runtimeComponentArchiveUrl("pose-runtime", digest, {
        applicationVersion: "0.2.1",
        platform: "windows-x86_64",
        publicBaseUrl: "https://example.com/infinite-canvas/updates",
      }),
    /trusted/,
  );
  assert.throws(
    () => runtimeComponentArchiveUrl("../x", digest, { applicationVersion: "0.2.1" }),
    /identity/,
  );
});

test("native component platform keys separate both macOS architectures and reject universal or foreign targets", () => {
  assert.equal(componentPlatform("win32", "x64"), "windows-x86_64");
  assert.equal(componentPlatform("darwin", "arm64"), "darwin-aarch64");
  assert.equal(componentPlatform("darwin", "x64"), "darwin-x86_64");
  assert.equal(componentPlatform("linux", "x64"), null);
  for (const args of [
    ["darwin", "arm64", "x86_64-apple-darwin"],
    ["darwin", "x64", "universal-apple-darwin"],
    ["linux", "x64"],
    ["win32", "arm64"],
  ])
    assert.throws(() => assertComponentPlatform(...args), /requires native/);
  for (const platform of ["darwin-aarch64", "darwin-x86_64"]) {
    const catalog = buildRuntimeComponentCatalog({
      applicationVersion: "0.2.2",
      components: RUNTIME_COMPONENTS.map(({ id }) => ({ id })),
      platform,
    });
    assert.equal(catalog.platform, platform);
    assert.match(
      runtimeComponentArchiveUrl("blender", "a".repeat(64), {
        applicationVersion: "0.2.2",
        platform,
      }),
      new RegExp(`/components/${platform}/`),
    );
  }
});

test("native platform and architecture manifest mismatches fail before catalog publication", async (t) => {
  const { root, definition } = await fixture(t);
  await assert.rejects(
    describeRuntimeComponent(definition, { root, platform: "darwin", arch: "arm64" }),
    /platform mismatch/,
  );
  await assert.rejects(
    describeRuntimeComponent(definition, { root, platform: "win32", arch: "arm64" }),
    /requires native/,
  );
});

test("macOS symlink target grammar permits internal relative paths and rejects escapes", () => {
  assert.equal(componentSymlinkTargetIsValid("runtime/Versions/Current", "A"), true);
  assert.equal(componentSymlinkTargetIsValid("runtime/bin/python3", "../lib/python3.11"), true);
  for (const target of [
    "../../../outside",
    "/outside",
    "C:/outside",
    "..\\outside",
    "a//b",
    "a\u0000b",
  ])
    assert.equal(componentSymlinkTargetIsValid("runtime/link", target), false, target);
});

test("macOS inventory retains source permissions rather than deriving executable bits from a Windows extension", async (t) => {
  const { directory } = await fixture(t);
  const filename = path.join(directory, "worker.exe");
  await chmod(filename, 0o644);
  const actualMode = (await lstat(filename)).mode & 0o777;
  const macFiles = await inventoryComponentFiles(directory, { platform: "darwin" });
  assert.equal(macFiles.find((entry) => entry.path === "worker.exe").mode, actualMode);
  const windowsFiles = await inventoryComponentFiles(directory, WINDOWS);
  assert.equal(windowsFiles.find((entry) => entry.path === "worker.exe").mode, 0o755);
});

test("macOS executable permissions and native Blender symlink inventory remain intact", async (t) => {
  const { root, directory, definition } = await fixture(t);
  const worker = path.join(directory, "worker.exe");
  await chmod(worker, 0o755);
  try {
    await symlink("worker.exe", path.join(directory, "worker"), "file");
  } catch (error) {
    if (["EPERM", "EACCES"].includes(error.code)) {
      t.skip("Host cannot create file symlinks");
      return;
    }
    throw error;
  }
  const files = (await inventoryComponentFiles(directory, { platform: "darwin" })).filter(
    (entry) => !["files-manifest.json", "runtime-manifest.json"].includes(entry.path),
  );
  const bytes = JSON.stringify(
    files.map((entry) =>
      entry.type === "symlink"
        ? { path: entry.path, type: "symlink", target: entry.target }
        : { ...entry, type: "file" },
    ),
  );
  await writeFile(path.join(directory, "files-manifest.json"), bytes);
  await writeFile(
    path.join(directory, "runtime-manifest.json"),
    JSON.stringify({
      platform: "darwin",
      arch: "arm64",
      inventory: {
        path: "files-manifest.json",
        count: files.length,
        sha256: componentBytesSha256(bytes),
      },
    }),
  );
  const component = await describeRuntimeComponent(definition, {
    root,
    platform: "darwin",
    arch: "arm64",
  });
  assert.equal(
    component.files.find((entry) => entry.path === "worker.exe").mode,
    (await lstat(worker)).mode & 0o777,
  );
  assert.deepEqual(
    component.files.find((entry) => entry.path === "worker"),
    {
      path: "worker",
      type: "symlink",
      target: "worker.exe",
      size: 10,
      sha256: componentBytesSha256("worker.exe"),
      mode: 0o755,
    },
  );
  await assert.rejects(
    describeRuntimeComponent(definition, { root, platform: "darwin", arch: "x64" }),
    /architecture mismatch/,
  );
  await rm(path.join(directory, "worker"));
  await symlink("missing", path.join(directory, "worker"), "file");
  await assert.rejects(
    inventoryComponentFiles(directory, { platform: "darwin" }),
    /dangling or cyclic/,
  );
});

test("native macOS packaging inspects real Mach-O architecture and verifies existing signatures without changing bytes", async (t) => {
  const { root, directory, definition } = await fixture(t);
  await writeFile(path.join(directory, "ffmpeg"), "Mach-O fixture bytes");
  await writeFile(
    path.join(directory, "runtime-manifest.json"),
    JSON.stringify({ ffprobeUnavailable: true }),
  );
  const calls = [];
  const run = async (executable, args) => {
    calls.push([executable, args]);
    return { stdout: "arm64\n" };
  };
  const bytes = await readFile(path.join(directory, "ffmpeg"));
  await validateMacRuntimeComponent({ ...definition, id: "ffmpeg" }, { root, arch: "arm64", run });
  assert.deepEqual(
    calls.map(([executable]) => executable),
    ["/usr/bin/lipo", "/usr/bin/codesign"],
  );
  assert.deepEqual(await readFile(path.join(directory, "ffmpeg")), bytes);
  await assert.rejects(
    validateMacRuntimeComponent({ ...definition, id: "ffmpeg" }, { root, arch: "x64", run }),
    /architecture mismatch/,
  );
  await assert.rejects(
    validateMacRuntimeComponent(
      { ...definition, id: "ffmpeg" },
      {
        root,
        arch: "arm64",
        run: async (executable) => {
          if (executable.endsWith("codesign"))
            throw Object.assign(new Error("invalid existing signature"), {
              stderr: "invalid signature",
            });
          return { stdout: "arm64" };
        },
      },
    ),
    /invalid existing signature/,
  );
});
