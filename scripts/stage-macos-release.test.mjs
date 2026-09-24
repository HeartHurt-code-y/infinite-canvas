import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stageMacosRelease } from "./stage-macos-release.mjs";

test("macOS staging adds an immutable versioned name and never publishes", () => {
  const bundleRoot = mkdtempSync(path.join(os.tmpdir(), "infinite-canvas-mac-stage-"));
  try {
    const sourceDir = path.join(bundleRoot, "macos");
    mkdirSync(sourceDir);
    writeFileSync(path.join(sourceDir, "无限画布.app.tar.gz"), "archive");
    writeFileSync(path.join(sourceDir, "无限画布.app.tar.gz.sig"), "signature");
    const staged = stageMacosRelease({ bundleRoot, version: "0.1.8", arch: "arm64" });
    assert.equal(staged.outputName, "无限画布_0.1.8_aarch64-full.app.tar.gz");
    assert.equal(readFileSync(path.join(staged.outputDir, staged.outputName), "utf8"), "archive");
    assert.match(
      readFileSync(path.join(staged.outputDir, "install-macos.sh"), "utf8"),
      /install-macos/,
    );
    const manifest = JSON.parse(readFileSync(path.join(staged.outputDir, "latest.json"), "utf8"));
    assert.equal(manifest.version, "0.1.8");
    assert.equal(manifest.platforms["darwin-aarch64"].signature, "signature");
  } finally {
    rmSync(bundleRoot, { recursive: true, force: true });
  }
});
