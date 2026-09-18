import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTauriCliArgs,
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
