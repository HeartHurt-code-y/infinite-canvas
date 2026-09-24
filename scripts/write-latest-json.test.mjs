import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { tosUpdatesPublicBaseUrl } from "./tos-updates-config.mjs";
import {
  detectPlatformFromArtifact,
  joinDownloadUrl,
  mergeLatestManifest,
  writeLatestJson,
} from "./write-latest-json.mjs";

test("maps installer filenames onto Tauri platform keys", () => {
  assert.equal(
    detectPlatformFromArtifact("无限画布_0.1.1_x64-setup.exe", "windows-x86_64"),
    "windows-x86_64",
  );
  assert.equal(
    detectPlatformFromArtifact("无限画布_0.1.1_arm64-setup.exe", "windows-x86_64"),
    "windows-aarch64",
  );
  assert.equal(
    detectPlatformFromArtifact("无限画布.app.tar.gz", "darwin-aarch64"),
    "darwin-aarch64",
  );
  assert.equal(detectPlatformFromArtifact("无限画布_0.1.1_aarch64.dmg", "darwin-aarch64"), null);
});

test("encodes CJK installer names in download URLs", () => {
  assert.equal(
    joinDownloadUrl("https://cdn.example/releases/0.1.1/", "无限画布.app.tar.gz"),
    "https://cdn.example/releases/0.1.1/%E6%97%A0%E9%99%90%E7%94%BB%E5%B8%83.app.tar.gz",
  );
});

test("merges platforms only when their release versions match", () => {
  const merged = mergeLatestManifest(
    {
      version: "0.1.1",
      platforms: {
        "darwin-aarch64": { url: "https://old/mac", signature: "old-sig" },
      },
    },
    {
      "windows-x86_64": { url: "https://new/win", signature: "new-sig" },
    },
    "0.1.1",
  );
  assert.deepEqual(merged.platforms, {
    "darwin-aarch64": { url: "https://old/mac", signature: "old-sig" },
    "windows-x86_64": { url: "https://new/win", signature: "new-sig" },
  });
  const bumped = mergeLatestManifest(
    { version: "0.1.0", platforms: merged.platforms },
    { "windows-x86_64": { url: "https://new/win", signature: "new-sig" } },
    "0.1.1",
  );
  assert.deepEqual(bumped.platforms, {
    "windows-x86_64": { url: "https://new/win", signature: "new-sig" },
  });
});

test("writes latest.json from signed updater artifacts", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "infinite-canvas-latest-"));
  try {
    const nsisDir = path.join(dir, "nsis");
    mkdirSync(nsisDir);
    writeFileSync(path.join(nsisDir, "无限画布_0.1.1_x64-setup.exe"), "installer");
    writeFileSync(path.join(nsisDir, "无限画布_0.1.1_x64-setup.exe.sig"), "signed\n");
    const out = path.join(dir, "latest.json");
    const result = writeLatestJson({
      "bundle-dir": dir,
      "base-url": "https://cdn.example/app",
      out,
      version: "0.1.1",
      notes: "in-place upgrade",
      "pub-date": "2026-09-18T00:00:00.000Z",
      platform: "windows-x86_64",
    });
    assert.equal(result.out, out);
    const manifest = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(manifest.version, "0.1.1");
    assert.equal(manifest.notes, "in-place upgrade");
    assert.equal(
      manifest.platforms["windows-x86_64"].url,
      "https://cdn.example/app/%E6%97%A0%E9%99%90%E7%94%BB%E5%B8%83_0.1.1_x64-setup.exe",
    );
    assert.equal(manifest.platforms["windows-x86_64"].signature, "signed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("defaults the download directory to the public TOS prefix", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "infinite-canvas-latest-"));
  try {
    const nsisDir = path.join(dir, "nsis");
    mkdirSync(nsisDir);
    writeFileSync(path.join(nsisDir, "无限画布_0.1.1_x64-setup.exe"), "installer");
    writeFileSync(path.join(nsisDir, "无限画布_0.1.1_x64-setup.exe.sig"), "signed\n");
    const result = writeLatestJson({
      "bundle-dir": dir,
      out: path.join(dir, "latest.json"),
      version: "0.1.1",
      "pub-date": "2026-09-18T00:00:00.000Z",
      platform: "windows-x86_64",
    });
    assert.equal(
      result.manifest.platforms["windows-x86_64"].url,
      `${tosUpdatesPublicBaseUrl()}/%E6%97%A0%E9%99%90%E7%94%BB%E5%B8%83_0.1.1_x64-setup.exe`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects old and duplicate Windows artifacts in a release staging directory", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "infinite-canvas-stale-"));
  try {
    const nsisDir = path.join(dir, "nsis");
    mkdirSync(nsisDir);
    writeFileSync(path.join(nsisDir, "无限画布_0.1.7_x64-setup.exe"), "old");
    writeFileSync(path.join(nsisDir, "无限画布_0.1.7_x64-setup.exe.sig"), "old-sig");
    assert.throws(
      () =>
        writeLatestJson({
          "bundle-dir": dir,
          version: "0.1.8",
          out: path.join(dir, "latest.json"),
        }),
      /非本版 updater/,
    );
    rmSync(path.join(nsisDir, "无限画布_0.1.7_x64-setup.exe"));
    rmSync(path.join(nsisDir, "无限画布_0.1.7_x64-setup.exe.sig"));
    for (const suffix of ["", "-slim"]) {
      const name = `无限画布_0.1.8_x64${suffix}-setup.exe`;
      writeFileSync(path.join(nsisDir, name), suffix);
      writeFileSync(path.join(nsisDir, `${name}.sig`), "sig");
    }
    assert.throws(
      () =>
        writeLatestJson({
          "bundle-dir": dir,
          version: "0.1.8",
          out: path.join(dir, "latest.json"),
        }),
      /多个 updater 产物/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
