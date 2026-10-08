import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  componentArchiveCacheKey,
  packageRuntimeComponent,
  resolveComponentPython,
} from "./package-runtime-components.mjs";
import {
  componentBytesSha256,
  componentFileSha256,
  inventoryComponentFiles,
} from "./runtime-component-catalog.mjs";
const WINDOWS = { platform: "win32", arch: "x64" };

test("archive cache key binds full inventory, permissions and ZIP recipe source", () => {
  const component = {
    files: [{ path: "LICENSE.txt", size: 2, sha256: "a".repeat(64), mode: 0o644 }],
  };
  const original = componentArchiveCacheKey(component, "b".repeat(64));
  assert.notEqual(original, componentArchiveCacheKey(component, "c".repeat(64)));
  assert.notEqual(
    original,
    componentArchiveCacheKey({ files: [{ ...component.files[0], mode: 0o755 }] }, "b".repeat(64)),
  );
});

test("real ZIP packaging is deterministic, validates cache contents and repairs a corrupted cached archive", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ic-zip-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source");
  const packageDirectory = path.join(root, "packages");
  await mkdir(sourceRoot);
  await writeFile(path.join(sourceRoot, "LICENSE.txt"), "full legal notice\n".repeat(40));
  await writeFile(path.join(sourceRoot, "runtime-manifest.json"), '{"schemaVersion":1}\n');
  const component = {
    id: "pose-runtime",
    files: await inventoryComponentFiles(sourceRoot, WINDOWS),
  };
  const options = {
    sourceRoot,
    packageDirectory,
    python: resolveComponentPython(),
    applicationVersion: "0.2.1",
    ...WINDOWS,
    progress: () => {},
  };
  const first = await packageRuntimeComponent(component, options);
  const firstPath = path.join(packageDirectory, `${first.archive.sha256}.zip`);
  assert.equal(await componentFileSha256(firstPath), first.archive.sha256);
  const second = await packageRuntimeComponent(component, options);
  assert.deepEqual(second, first);
  const foreignSource = path.join(root, "foreign");
  await mkdir(foreignSource);
  await writeFile(path.join(foreignSource, "different.txt"), "wrong ZIP with a valid checksum");
  const foreign = await packageRuntimeComponent(
    { id: "pose-runtime", files: await inventoryComponentFiles(foreignSource, WINDOWS) },
    { ...options, sourceRoot: foreignSource },
  );
  const primaryCache = (await readdir(packageDirectory)).filter((name) => name.endsWith(".json"));
  for (const name of primaryCache) {
    const filename = path.join(packageDirectory, name);
    const metadata = JSON.parse(await readFile(filename));
    if (metadata.sha256 === first.archive.sha256)
      await writeFile(
        filename,
        JSON.stringify({ ...metadata, sha256: foreign.archive.sha256, size: foreign.archive.size }),
      );
  }
  // Even self-consistent cached SHA/size metadata cannot bless a different member set.
  assert.deepEqual(await packageRuntimeComponent(component, options), first);
  const original = await readFile(firstPath);
  await writeFile(firstPath, "corrupt cached archive");
  // An immutable SHA-addressed file must never be silently replaced.
  await assert.rejects(packageRuntimeComponent(component, options), /Corrupted immutable ZIP/);
  await rm(firstPath);
  const repaired = await packageRuntimeComponent(component, options);
  assert.equal(repaired.archive.sha256, first.archive.sha256);
  assert.deepEqual(await readFile(firstPath), original);
  const separate = await packageRuntimeComponent(component, {
    ...options,
    packageDirectory: path.join(root, "second-packages"),
  });
  assert.equal(separate.archive.sha256, first.archive.sha256);
});

test("macOS Python selection uses prepared native runtimes without a system dependency", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ic-mac-python-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = path.join(
    root,
    "src-tauri/resources/blender/runtime/Blender.app/Contents/Resources/4.5/python/bin/python3.11",
  );
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, "native python fixture");
  assert.equal(resolveComponentPython(root, {}, "darwin"), filename);
  assert.throws(() => resolveComponentPython(root, {}, "win32"), /no download/);
});

test("real macOS ZIP preserves executable permissions, file and directory symlinks deterministically", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ic-mac-zip-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source");
  await mkdir(path.join(sourceRoot, "Versions/A"), { recursive: true });
  await writeFile(path.join(sourceRoot, "Versions/A/worker"), "native Mac worker fixture");
  await chmod(path.join(sourceRoot, "Versions/A/worker"), 0o755);
  try {
    await symlink("Versions/A/worker", path.join(sourceRoot, "worker"), "file");
    await symlink("A", path.join(sourceRoot, "Versions/Current"), "dir");
  } catch (error) {
    if (["EPERM", "EACCES"].includes(error.code)) {
      t.skip("Host cannot create native symlinks");
      return;
    }
    throw error;
  }
  const component = {
    id: "blender",
    files: await inventoryComponentFiles(sourceRoot, { platform: "darwin" }),
  };
  assert.deepEqual(
    component.files.map((entry) => entry.path),
    ["Versions/A/worker", "Versions/Current", "worker"],
  );
  const options = {
    sourceRoot,
    packageDirectory: path.join(root, "packages"),
    python: resolveComponentPython(),
    applicationVersion: "0.2.2",
    platform: "darwin",
    arch: "arm64",
    progress: () => {},
  };
  const first = await packageRuntimeComponent(component, options);
  assert.match(first.archive.url, /\/components\/darwin-aarch64\//);
  assert.deepEqual(await packageRuntimeComponent(component, options), first);
  const inspector = spawnSync(
    options.python,
    [
      "-I",
      "-B",
      "-c",
      "import json,sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);print(json.dumps([{'path':i.filename,'mode':i.external_attr>>16,'payload':z.read(i).decode()} for i in z.infolist()]))",
      path.join(options.packageDirectory, `${first.archive.sha256}.zip`),
    ],
    { encoding: "utf8" },
  );
  assert.equal(inspector.status, 0, inspector.stderr);
  const archived = JSON.parse(inspector.stdout);
  assert.equal(archived[0].mode, 0o100000 | component.files[0].mode);
  assert.equal(archived[1].mode, 0o120755);
  assert.equal(archived[1].payload, "A");
  assert.equal(archived[2].payload, "Versions/A/worker");
  const intel = await packageRuntimeComponent(component, { ...options, arch: "x64" });
  assert.equal(intel.archive.sha256, first.archive.sha256);
  assert.match(intel.archive.url, /\/components\/darwin-x86_64\//);
  await assert.rejects(
    packageRuntimeComponent(component, { ...options, ...WINDOWS }),
    /Only macOS component ZIPs/,
  );
});

test("ZIP helper rejects forged macOS links that escape the source root", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ic-mac-zip-unsafe-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "source"));
  const target = "../outside";
  const component = {
    id: "blender",
    files: [
      {
        path: "link",
        type: "symlink",
        target,
        size: Buffer.byteLength(target),
        sha256: componentBytesSha256(target),
        mode: 0o755,
      },
    ],
  };
  await assert.rejects(
    packageRuntimeComponent(component, {
      sourceRoot: path.join(root, "source"),
      packageDirectory: path.join(root, "packages"),
      python: resolveComponentPython(),
      applicationVersion: "0.2.2",
      platform: "darwin",
      arch: "arm64",
      progress: () => {},
    }),
    /ZIP packaging failed/,
  );
});

test("real ZIP verification checks macOS symlink type, payload and permission metadata on every host", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ic-mac-zip-verify-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const payload = "worker";
  const entries = [
    {
      path: "alias",
      type: "symlink",
      target: payload,
      size: payload.length,
      sha256: componentBytesSha256(payload),
      mode: 0o755,
    },
    { path: "worker", size: 6, sha256: componentBytesSha256("binary"), mode: 0o755 },
  ];
  const spec = path.join(root, "spec.json");
  const archive = path.join(root, "component.zip");
  await writeFile(spec, JSON.stringify({ root, files: entries, platform: "darwin-aarch64" }));
  const python = resolveComponentPython();
  const writer =
    "import json,sys,stat,zipfile;s=json.load(open(sys.argv[1]));z=zipfile.ZipFile(sys.argv[2],'w',compression=zipfile.ZIP_DEFLATED,compresslevel=6);\nfor e in s['files']:\n i=zipfile.ZipInfo(e['path'],date_time=(1980,1,1,0,0,0));i.create_system=3;i.compress_type=zipfile.ZIP_DEFLATED;i.external_attr=((stat.S_IFLNK if e.get('type')=='symlink' else stat.S_IFREG)|e['mode'])<<16;z.writestr(i,e.get('target','binary').encode())\nz.close()";
  const written = spawnSync(python, ["-I", "-B", "-c", writer, spec, archive], {
    encoding: "utf8",
  });
  assert.equal(written.status, 0, written.stderr);
  const helper = path.join(import.meta.dirname, "runtime-component-zip.py");
  const verify = () =>
    spawnSync(python, ["-I", "-B", helper, spec, archive, "--verify"], { encoding: "utf8" });
  assert.equal(verify().status, 0);
  entries[0].target = "broken";
  await writeFile(spec, JSON.stringify({ root, files: entries, platform: "darwin-aarch64" }));
  const corrupted = verify();
  assert.notEqual(corrupted.status, 0);
  assert.match(corrupted.stderr, /symlink payload mismatch/);
  entries[0].target = payload;
  entries[0].type = "file";
  await writeFile(spec, JSON.stringify({ root, files: entries, platform: "darwin-aarch64" }));
  assert.match(verify().stderr, /ZIP metadata mismatch/);
});

test("Python selection never downloads a missing runtime", () => {
  assert.throws(
    () => resolveComponentPython(path.join(os.tmpdir(), "nonexistent-ic-runtime"), {}),
    /no download/,
  );
});
