// 包装 `tauri build`：有升级签名私钥时才生成 updater 产物。
//
// createUpdaterArtifacts 一旦打开，没有 TAURI_SIGNING_PRIVATE_KEY（或私钥文件）
// 构建会直接失败。本仓库的 CI 在配齐密钥之前仍要能打出普通安装包，所以默认
// tauri.conf.json 不打开该开关，由这里按密钥是否存在再合并 tauri.updater.conf.json。
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
 * }} options
 */
export function buildTauriCliArgs(options) {
  const args = ["build"];
  if (options.enableUpdaterArtifacts) {
    args.push("--config", UPDATER_CONFIG_PATH);
  }
  if (options.passthrough && options.passthrough.length > 0) {
    args.push(...options.passthrough);
  }
  return args;
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
  const hasPath =
    typeof next.TAURI_SIGNING_PRIVATE_KEY_PATH === "string" &&
    next.TAURI_SIGNING_PRIVATE_KEY_PATH.trim() !== "";
  if (!hasInlineKey && !hasPath && existsSync(defaultKeyPath)) {
    next.TAURI_SIGNING_PRIVATE_KEY_PATH = defaultKeyPath;
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
  const code = await runTauri(
    buildTauriCliArgs({ enableUpdaterArtifacts, passthrough: process.argv.slice(2) }),
    env,
  );
  process.exit(code);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  await main();
}
