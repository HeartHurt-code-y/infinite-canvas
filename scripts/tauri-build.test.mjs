import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildTauriCliArgs,
  configureEditionUpdaterConfig,
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
    assert.equal(env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD, "");
    assert.equal(
      resolveUpdaterSigningEnv({ TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "protected" }, keyPath)
        .TAURI_SIGNING_PRIVATE_KEY_PASSWORD,
      "protected",
    );
    assert.equal(
      resolveUpdaterSigningEnv({ TAURI_SIGNING_PRIVATE_KEY: "inline" }, keyPath)
        .TAURI_SIGNING_PRIVATE_KEY_PATH,
      undefined,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("signed editions keep deletion tombstones and signing in one actual CLI overlay", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ic-single-edition-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, ".cache/tauri-editions/online/tauri-edition.generated.json");
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    JSON.stringify({
      bundle: { resources: { "resources/blender/": null, "resources/ffmpeg/": "ffmpeg/" } },
    }),
  );
  const passthrough = ["--config", configPath, "--ci"];
  for (const enableUpdaterArtifacts of [true, false]) {
    assert.equal(
      configureEditionUpdaterConfig(passthrough, {
        edition: "online",
        enableUpdaterArtifacts,
        root,
      }),
      true,
    );
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    assert.equal(config.bundle.resources["resources/blender/"], null);
    assert.equal(config.bundle.createUpdaterArtifacts, enableUpdaterArtifacts);
    assert.deepEqual(
      buildTauriCliArgs({ enableUpdaterArtifacts, passthrough, singleEditionConfig: true }),
      ["build", ...passthrough],
    );
  }
  assert.throws(
    () =>
      configureEditionUpdaterConfig(["--config", configPath, "--config", "other.json"], {
        edition: "online",
        enableUpdaterArtifacts: true,
        root,
      }),
    /single generated/,
  );
  assert.equal(configureEditionUpdaterConfig([], { enableUpdaterArtifacts: true, root }), false);
});

test("normalizes BOM and boundary whitespace in inline CI keys without changing passwords or input", () => {
  const original = {
    TAURI_SIGNING_PRIVATE_KEY: "\uFEFF  encoded-private-key\r\n",
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "  protected\r\n",
  };
  const resolved = resolveUpdaterSigningEnv(original, "missing-updater-key");
  assert.equal(resolved.TAURI_SIGNING_PRIVATE_KEY, "encoded-private-key");
  assert.equal(
    resolved.TAURI_SIGNING_PRIVATE_KEY_PASSWORD,
    original.TAURI_SIGNING_PRIVATE_KEY_PASSWORD,
  );
  assert.equal(original.TAURI_SIGNING_PRIVATE_KEY, "\uFEFF  encoded-private-key\r\n");
  assert.equal(resolved.TAURI_SIGNING_PRIVATE_KEY_PATH, undefined);
});
