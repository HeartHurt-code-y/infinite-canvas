// 包装 `tauri build`：有升级签名私钥时才生成 updater 产物。
//
// createUpdaterArtifacts 一旦打开，没有 TAURI_SIGNING_PRIVATE_KEY（或私钥文件）
// 构建会直接失败。本仓库的 CI 在配齐密钥之前仍要能打出普通安装包，所以默认
// tauri.conf.json 不打开该开关，由这里按密钥是否存在再合并 tauri.updater.conf.json。
import { spawn } from "node:child_process";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  verifyGeneratedNsisRemotionResources,
  verifyGeneratedNsisStyleResources,
} from "./verify-nsis-remotion-resources.mjs";
import { verifyGeneratedNsisEditionResources } from "./verify-nsis-edition-resources.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
export const DEFAULT_UPDATER_KEY_PATH = path.join(REPO_ROOT, "src-tauri", ".updater-key");
export const UPDATER_CONFIG_PATH = path.join(REPO_ROOT, "src-tauri", "tauri.updater.conf.json");

/**
 * @param {{
 *   privateKey?: string | undefined,
 *   privateKeyPath?: string | undefined,
 *   keyFileExists?: boolean | undefined,
 * }} env
 */
export function shouldEnableUpdaterArtifacts(env) {
  if (typeof env.privateKey === "string" && env.privateKey.trim() !== "") return true;
  if (typeof env.privateKeyPath === "string" && env.privateKeyPath.trim() !== "") return true;
  return env.keyFileExists === true;
}

/**
 * @param {{
 *   enableUpdaterArtifacts: boolean,
 *   passthrough?: readonly string[] | undefined,
 *   singleEditionConfig?: boolean,
 * }} options
 */
export function buildTauriCliArgs(options) {
  const args = ["build"];
  if (options.enableUpdaterArtifacts && !options.singleEditionConfig) {
    args.push("--config", UPDATER_CONFIG_PATH);
  }
  if (options.passthrough && options.passthrough.length > 0) {
    args.push(...options.passthrough);
  }
  return args;
}

// Tauri merges CLI overlays together before applying them to the base config.
// Keep edition resource tombstones and the signing flag in one overlay.
export function configureEditionUpdaterConfig(
  passthrough,
  { edition, enableUpdaterArtifacts, root = REPO_ROOT },
) {
  if (!edition) return false;
  if (edition !== "online" && edition !== "offline")
    throw new Error("Invalid distribution edition");
  const expected = path.join(
    root,
    ".cache/tauri-editions",
    edition,
    "tauri-edition.generated.json",
  );
  const configFlags = passthrough.filter(
    (argument) => argument === "--config" || argument === "-c" || argument.startsWith("--config="),
  );
  const position = passthrough.indexOf("--config");
  if (
    configFlags.length !== 1 ||
    position < 0 ||
    path.resolve(passthrough[position + 1] ?? "") !== expected
  )
    throw new Error("Edition build requires its single generated resource/signing config");
  const info = lstatSync(expected);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error("Generated edition config must be a regular file");
  const config = JSON.parse(readFileSync(expected, "utf8"));
  config.bundle = { ...config.bundle, createUpdaterArtifacts: enableUpdaterArtifacts };
  writeFileSync(expected, JSON.stringify(config, null, 2) + "\n");
  return true;
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} defaultKeyPath
 */
export function resolveUpdaterSigningEnv(env, defaultKeyPath) {
  const next = { ...env };
  const hasInlineKey =
    typeof next.TAURI_SIGNING_PRIVATE_KEY === "string" &&
    next.TAURI_SIGNING_PRIVATE_KEY.trim() !== "";
  if (hasInlineKey) {
    // CI secrets can retain a UTF-8 BOM or trailing newline from the key file.
    // Normalize the key exactly like file input; passwords stay byte-for-byte.
    next.TAURI_SIGNING_PRIVATE_KEY = next.TAURI_SIGNING_PRIVATE_KEY.trim();
  }
  const hasPath =
    typeof next.TAURI_SIGNING_PRIVATE_KEY_PATH === "string" &&
    next.TAURI_SIGNING_PRIVATE_KEY_PATH.trim() !== "";
  if (!hasInlineKey && !hasPath && existsSync(defaultKeyPath)) {
    next.TAURI_SIGNING_PRIVATE_KEY_PATH = defaultKeyPath;
  }
  const keyPath =
    typeof next.TAURI_SIGNING_PRIVATE_KEY_PATH === "string"
      ? next.TAURI_SIGNING_PRIVATE_KEY_PATH
      : "";
  // `tauri build` 的 updater 产物只认 TAURI_SIGNING_PRIVATE_KEY 正文；
  // PATH 变量只对 `tauri signer sign` 生效。本地有密钥文件时把正文灌进去。
  if (!hasInlineKey && keyPath !== "" && existsSync(keyPath)) {
    next.TAURI_SIGNING_PRIVATE_KEY = readFileSync(keyPath, "utf8").trim();
  }
  if (keyPath === defaultKeyPath && next.TAURI_SIGNING_PRIVATE_KEY_PASSWORD === undefined) {
    // This repository's local encrypted key uses an empty password. Pass the
    // empty value only to the child process so unattended builds never prompt.
    next.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "";
  }
  return next;
}

function runTauri(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["exec", "tauri", ...args], {
      cwd: REPO_ROOT,
      env,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

async function main() {
  const keyFileExists = existsSync(DEFAULT_UPDATER_KEY_PATH);
  const env = resolveUpdaterSigningEnv(process.env, DEFAULT_UPDATER_KEY_PATH);
  const enableUpdaterArtifacts = shouldEnableUpdaterArtifacts({
    privateKey: env.TAURI_SIGNING_PRIVATE_KEY,
    privateKeyPath: env.TAURI_SIGNING_PRIVATE_KEY_PATH,
    keyFileExists,
  });
  if (!enableUpdaterArtifacts) {
    console.warn(
      "[tauri-build] 未找到升级签名私钥，本次只打安装包，不生成 in-app 更新产物。请把 src-tauri/.updater-key 放到构建机，或设置 TAURI_SIGNING_PRIVATE_KEY。",
    );
  }
  const passthrough = process.argv.slice(2);
  const singleEditionConfig = configureEditionUpdaterConfig(passthrough, {
    edition: env.IC_DISTRIBUTION_EDITION,
    enableUpdaterArtifacts,
  });
  const code = await runTauri(
    buildTauriCliArgs({ enableUpdaterArtifacts, passthrough, singleEditionConfig }),
    env,
  );
  if (code !== 0) {
    process.exitCode = code;
    return;
  }
  const bundlesIndex = passthrough.indexOf("--bundles");
  const bundles = bundlesIndex >= 0 ? (passthrough[bundlesIndex + 1] ?? "") : "all";
  const targetAt = passthrough.indexOf("--target");
  const target =
    targetAt < 0
      ? passthrough.find((argument) => argument.startsWith("--target="))?.slice(9)
      : passthrough[targetAt + 1];
  const profile = passthrough.includes("--debug") ? "debug" : "release";
  if (
    process.platform === "win32" &&
    env.IC_DISTRIBUTION_EDITION &&
    !passthrough.includes("--no-bundle") &&
    (bundles === "all" || bundles.split(",").includes("nsis"))
  ) {
    const count = await verifyGeneratedNsisEditionResources({
      root: REPO_ROOT,
      edition: env.IC_DISTRIBUTION_EDITION,
      targetDirectory: env.CARGO_TARGET_DIR ?? path.join(REPO_ROOT, "src-tauri/target"),
      target,
      profile,
    });
    console.log(
      `[tauri-build] ${env.IC_DISTRIBUTION_EDITION} NSIS exact resource table verified: ${count} files`,
    );
  }
  if (
    process.platform === "win32" &&
    env.IC_DISTRIBUTION_EDITION !== "online" &&
    !passthrough.includes("--no-bundle") &&
    (bundles === "all" || bundles.split(",").includes("nsis"))
  ) {
    const verification = { targetDirectory: env.CARGO_TARGET_DIR, target, profile };
    const remotionCount = verifyGeneratedNsisRemotionResources(REPO_ROOT, verification);
    const styleCount = verifyGeneratedNsisStyleResources(REPO_ROOT, verification);
    console.log(
      `[tauri-build] 完整 NSIS 已包含 ${remotionCount} 个 Remotion 资源文件和 ${styleCount} 个风格库清单文件`,
    );
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  try {
    await main();
  } catch (error) {
    console.error(`[tauri-build] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
