import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildTauriCliArgs,
  resolveUpdaterSigningEnv,
  shouldEnableUpdaterArtifacts,
  UPDATER_CONFIG_PATH,
} from "./tauri-build.mjs";

test("updater artifacts stay off until a signing key is actually present", () => {
  assert.equal(shouldEnableUpdaterArtifacts({}), false);
  assert.equal(shouldEnableUpdaterArtifacts({ privateKey: "   " }), false);
  assert.equal(shouldEnableUpdaterArtifacts({ privateKey: "minisign-key" }), true);
  assert.equal(shouldEnableUpdaterArtifacts({ privateKeyPath: "C:\\\\keys\\\\updater.key" }), true);
  assert.equal(shouldEnableUpdaterArtifacts({ keyFileExists: true }), true);
});

test("passes the overlay config only when updater artifacts are enabled", () => {
  assert.deepEqual(buildTauriCliArgs({ enableUpdaterArtifacts: false, passthrough: ["--ci"] }), [
    "build",
    "--ci",
  ]);
  assert.deepEqual(buildTauriCliArgs({ enableUpdaterArtifacts: true }), [
    "build",
    "--config",
    UPDATER_CONFIG_PATH,
  ]);
});

test("loads the updater private key file into TAURI_SIGNING_PRIVATE_KEY for tauri build", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "infinite-canvas-signer-"));
  try {
    const keyPath = path.join(dir, ".updater-key");
    writeFileSync(keyPath, "  minisign-secret  \n");
    const env = resolveUpdaterSigningEnv({}, keyPath);
    assert.equal(env.TAURI_SIGNING_PRIVATE_KEY, "minisign-secret");
    assert.equal(env.TAURI_SIGNING_PRIVATE_KEY_PATH, keyPath);
    assert.equal(env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
