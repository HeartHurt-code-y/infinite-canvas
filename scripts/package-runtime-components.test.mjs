import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  componentArchiveCacheKey,
  packageRuntimeComponent,
  resolveComponentPython,
} from "./package-runtime-components.mjs";
import { componentFileSha256, inventoryComponentFiles } from "./runtime-component-catalog.mjs";

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
  const component = { id: "pose-runtime", files: await inventoryComponentFiles(sourceRoot) };
  const options = {
    sourceRoot,
    packageDirectory,
    python: resolveComponentPython(),
    applicationVersion: "0.2.1",
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
    { id: "pose-runtime", files: await inventoryComponentFiles(foreignSource) },
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

test("Python selection never downloads a missing runtime", () => {
  assert.throws(
    () => resolveComponentPython(path.join(os.tmpdir(), "nonexistent-ic-runtime"), {}),
    /no download/,
  );
});
