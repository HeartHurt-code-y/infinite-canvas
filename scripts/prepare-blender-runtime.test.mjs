import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertArchiveEntries,
  fileDigest,
  platformDistribution,
  snapshotFiles,
  verifyArchive,
  verifyManifestFiles,
} from "./prepare-blender-runtime.mjs";

test("selects the correct official archive and resource path, rejects unsupported Linux arm64", () => {
  for (const [platform, arch, filename, executable] of [
    ["win32", "x64", "windows-x64.zip", "runtime/blender.exe"],
    ["win32", "arm64", "windows-arm64.zip", "runtime/blender.exe"],
    ["darwin", "x64", "macos-x64.dmg", "runtime/Blender.app/Contents/MacOS/Blender"],
    ["darwin", "arm64", "macos-arm64.dmg", "runtime/Blender.app/Contents/MacOS/Blender"],
    ["linux", "x64", "linux-x64.tar.xz", "runtime/blender"],
  ]) {
    const result = platformDistribution(platform, arch);
    assert.equal(result.filename, `blender-4.5.13-${filename}`);
    assert.equal(result.executable, executable);
    assert.match(result.url, /^https:\/\/download\.blender\.org\/release\/Blender4\.5\//);
    assert.match(result.sha256, /^[0-9a-f]{64}$/);
  }
  assert.throws(() => platformDistribution("linux", "arm64"), /官方便携发行包/);
});

test("cache verification detects a missing dependency and altered same-size dependency", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "blender-cache-check-"));
  try {
    await mkdir(path.join(root, "runtime", "blender.shared"), { recursive: true });
    await writeFile(path.join(root, "runtime", "blender.exe"), "executable");
    const dependency = path.join(root, "runtime", "blender.shared", "library.dll");
    await writeFile(dependency, "original");
    const manifest = await snapshotFiles(root);
    await verifyManifestFiles(root, manifest);
    await writeFile(dependency, "modified");
    await assert.rejects(verifyManifestFiles(root, manifest), /内容校验失败/);
    await rm(dependency);
    await assert.rejects(verifyManifestFiles(root, manifest), /文件缺失/);
    await assert.rejects(verifyManifestFiles(root, []), /清单为空/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("both local overrides and downloaded archives must match size and digest", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "blender-archive-check-"));
  const archive = path.join(root, "fixture.zip");
  try {
    await writeFile(archive, "trusted bytes");
    const metadata = { size: 13, sha256: await fileDigest(archive) };
    await verifyArchive(archive, metadata);
    await writeFile(archive, "changed bytes");
    await assert.rejects(verifyArchive(archive, metadata), /SHA256 校验失败/);
    await writeFile(archive, "short");
    await assert.rejects(verifyArchive(archive, metadata), /大小不匹配/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("archive and inventory paths cannot escape the generated bundle", async () => {
  assertArchiveEntries(
    "blender-4.5.13-windows-x64/blender.exe\nblender-4.5.13-windows-x64/4.5/python/bin/python.exe\n",
  );
  for (const value of [
    "../outside",
    "/outside",
    "C:/outside",
    "folder/../../outside",
    "folder\\..\\outside",
  ]) {
    assert.throws(() => assertArchiveEntries(value), /越界路径/);
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "blender-path-check-"));
  try {
    await assert.rejects(
      verifyManifestFiles(root, [{ path: "../outside", type: "file" }]),
      /路径越界/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
