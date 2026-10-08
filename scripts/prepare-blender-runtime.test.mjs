import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertArchiveEntries,
  assertBlenderPackagingInventory,
  assertPreparedManifestIdentity,
  BLENDER_VERSION,
  blenderPackagingPolicy,
  downloadUrls,
  fileDigest,
  platformDistribution,
  pruneWindowsDebugSymbols,
  snapshotFiles,
  SOURCE_ARCHIVE,
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

// 回归：源码归档在 /source/ 下，不在 release/Blender4.5/ 下。
// 曾用发行包的镜像前缀去拼源码文件名，导致 5 个镜像全部 404，
// macOS 打包在 blender:prepare 这一步整条挂掉。
test("source archive is only fetched from /source/, never from release mirrors", () => {
  const urls = downloadUrls(SOURCE_ARCHIVE);
  assert.equal(urls.length, 5);
  assert.equal(urls[0], `https://download.blender.org/source/blender-${BLENDER_VERSION}.tar.xz`);
  for (const url of urls) {
    assert.match(url, /\/source\/blender-4\.5\.13\.tar\.xz$/);
    assert.doesNotMatch(url, /\/release\//);
  }
});

test("platform archives are only fetched from the release directory", () => {
  for (const [platform, arch, filename] of [
    ["win32", "x64", "blender-4.5.13-windows-x64.zip"],
    ["darwin", "arm64", "blender-4.5.13-macos-arm64.dmg"],
    ["linux", "x64", "blender-4.5.13-linux-x64.tar.xz"],
  ]) {
    const urls = downloadUrls(platformDistribution(platform, arch));
    assert.equal(urls.length, 5);
    assert.equal(urls[0], `https://download.blender.org/release/Blender4.5/${filename}`);
    for (const url of urls) {
      assert.match(url, /\/release\/Blender4\.5\//);
      assert.ok(url.endsWith(`/${filename}`));
    }
  }
});

test("a missing mirror configuration is rejected instead of guessing a path", () => {
  assert.throws(() => downloadUrls({ filename: "blender-x.tar.xz" }), /缺少镜像目录配置/);
  assert.throws(
    () => downloadUrls({ filename: "blender-x.tar.xz", mirrorBases: [] }),
    /缺少镜像目录配置/,
  );
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

test("Windows staging excludes only runtime PDBs and inventories the retained runtime and sources", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "blender-prune-"));
  const distribution = platformDistribution("win32", "x64");
  const retained = [
    "runtime/blender.exe",
    "runtime/blender.shared/library.dll",
    "runtime/python311.dll",
    "runtime/4.5/python/bin/python.exe",
    "runtime/4.5/scripts/modules/bpy/__init__.py",
    "runtime/4.5/datafiles/default.blend",
    "runtime/license/license.md",
    "runtime/license/spdx/GPL-3.0-or-later.txt",
    "runtime/copyright.txt",
    `sources/${SOURCE_ARCHIVE.filename}`,
    "sources/white_model.py",
    "sources/white_model.LICENSE.txt",
    "sources/reference.pdb",
  ];
  try {
    for (const name of retained) {
      await mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await writeFile(path.join(root, name), `retained ${name}`);
    }
    await writeFile(path.join(root, "runtime/blender.pdb"), "debug one");
    await writeFile(path.join(root, "runtime/blender.shared/library.PDB"), "debug two");
    const before = await snapshotFiles(root);
    const pruning = await pruneWindowsDebugSymbols(root, distribution);
    assert.deepEqual(pruning, {
      omitted: [
        { path: "runtime/blender.pdb", size: 9 },
        { path: "runtime/blender.shared/library.PDB", size: 9 },
      ],
      totalBytes: 18,
    });
    const after = await snapshotFiles(root);
    assert.deepEqual(
      after,
      before.filter((entry) => retained.includes(entry.path)),
    );
    await verifyManifestFiles(root, after);
    assertBlenderPackagingInventory(after, distribution);
    await assert.rejects(verifyManifestFiles(root, before), /文件缺失/);
    assert.throws(() => assertBlenderPackagingInventory(before, distribution), /PDB 调试符号/);
    for (const name of retained)
      assert.equal(await readFile(path.join(root, name), "utf8"), `retained ${name}`);
    assert.deepEqual(await pruneWindowsDebugSymbols(root, distribution), {
      omitted: [],
      totalBytes: 0,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("macOS signed apps and Linux distributions are never pruned", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "blender-no-prune-"));
  try {
    await mkdir(path.join(root, "runtime/Blender.app/Contents/_CodeSignature"), {
      recursive: true,
    });
    await writeFile(path.join(root, "runtime/Blender.app/Contents/keep.pdb"), "debug");
    await writeFile(
      path.join(root, "runtime/Blender.app/Contents/_CodeSignature/CodeResources"),
      "signature",
    );
    const before = await snapshotFiles(root);
    for (const platform of ["darwin", "linux"]) {
      assert.deepEqual(await pruneWindowsDebugSymbols(root, { platform }), {
        omitted: [],
        totalBytes: 0,
      });
      await verifyManifestFiles(root, before);
      assertBlenderPackagingInventory(before, { platform });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("debug pruning rejects external links before removing any staging files", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "blender-link-check-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "blender-link-outside-"));
  try {
    await mkdir(path.join(root, "runtime"));
    await writeFile(path.join(root, "runtime/a.pdb"), "keep until validated");
    await writeFile(path.join(outside, "outside.pdb"), "outside");
    try {
      await symlink(outside, path.join(root, "runtime/z-outside"), "junction");
    } catch (error) {
      if (error.code === "EPERM") {
        context.skip("Host does not permit creating symlink/junction fixtures");
        return;
      }
      throw error;
    }
    await assert.rejects(pruneWindowsDebugSymbols(root, { platform: "win32" }), /链接指向包外/);
    assert.equal(await readFile(path.join(root, "runtime/a.pdb"), "utf8"), "keep until validated");
    assert.equal(await readFile(path.join(outside, "outside.pdb"), "utf8"), "outside");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("debug pruning refuses a linked runtime directory", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "blender-root-link-check-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "blender-root-link-outside-"));
  try {
    await writeFile(path.join(outside, "outside.pdb"), "outside");
    try {
      await symlink(outside, path.join(root, "runtime"), "junction");
    } catch (error) {
      if (error.code === "EPERM") {
        context.skip("Host does not permit creating symlink/junction fixtures");
        return;
      }
      throw error;
    }
    await assert.rejects(
      pruneWindowsDebugSymbols(root, { platform: "win32" }),
      /暂存目录不能是链接/,
    );
    assert.equal(await readFile(path.join(outside, "outside.pdb"), "utf8"), "outside");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("prepared caches without the current packaging policy are rebuilt rather than pruned in place", () => {
  const distribution = platformDistribution("win32", "x64");
  const manifest = {
    schemaVersion: 1,
    version: BLENDER_VERSION,
    fingerprint: "current-fingerprint",
    platform: distribution.platform,
    arch: distribution.arch,
    executable: distribution.executable,
    archive: { sha256: distribution.sha256 },
    sources: { md5: SOURCE_ARCHIVE.md5 },
    packaging: { policy: blenderPackagingPolicy(distribution.platform) },
  };
  assertPreparedManifestIdentity(manifest, distribution, "current-fingerprint");
  const legacy = { ...manifest };
  delete legacy.packaging;
  assert.throws(
    () => assertPreparedManifestIdentity(legacy, distribution, "current-fingerprint"),
    /发行裁剪策略/,
  );
  assert.throws(
    () => assertPreparedManifestIdentity(manifest, distribution, "changed-fingerprint"),
    /构建清单/,
  );
});
