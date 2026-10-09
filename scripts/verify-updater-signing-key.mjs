// Sign a tiny fixture before native compilation and verify it against the app's
// configured updater public key. Never print credentials or signer diagnostics.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_UPDATER_KEY_PATH, REPO_ROOT, resolveUpdaterSigningEnv } from "./tauri-build.mjs";
import { verifyUpdaterSignature } from "./verify-updater-signature.mjs";

const env = resolveUpdaterSigningEnv(process.env, DEFAULT_UPDATER_KEY_PATH);
if (!env.TAURI_SIGNING_PRIVATE_KEY?.trim()) throw new Error("Missing updater signing key");
const config = JSON.parse(readFileSync(path.join(REPO_ROOT, "src-tauri/tauri.conf.json"), "utf8"));
const tempRoot = path.resolve(os.tmpdir());
const directory = mkdtempSync(path.join(tempRoot, "ic-updater-signing-check-"));
if (path.dirname(directory) !== tempRoot) throw new Error("Unexpected signing check directory");
try {
  const fixture = path.join(directory, "signing-check.bin");
  writeFileSync(fixture, "infinite-canvas updater signing preflight\n");
  const signerEnv = {
    ...env,
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "",
  };
  delete signerEnv.TAURI_SIGNING_PRIVATE_KEY_PATH;
  const result = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "node_modules/@tauri-apps/cli/tauri.js"), "signer", "sign", fixture],
    {
      cwd: REPO_ROOT,
      env: signerEnv,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 64 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.error || result.status !== 0)
    throw new Error("Updater signing preflight failed; check key encoding and password");
  await verifyUpdaterSignature(fixture, `${fixture}.sig`, config.plugins.updater.pubkey);
  console.log("Updater signing preflight verified against the configured public key.");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
