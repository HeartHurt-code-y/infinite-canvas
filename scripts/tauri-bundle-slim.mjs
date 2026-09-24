// Rebundle the already built Windows executable as a small, signed NSIS updater.
// The full NSIS/MSI installers are staged first and restored after bundling.
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DEFAULT_UPDATER_KEY_PATH,
  REPO_ROOT,
  resolveUpdaterSigningEnv,
  UPDATER_CONFIG_PATH,
} from "./tauri-build.mjs";
import { readAppVersion, writeLatestJson } from "./write-latest-json.mjs";
import { tosUpdatesPublicBaseUrl } from "./tos-updates-config.mjs";
import { assertRuntimeBaseline, createRuntimeBaseline } from "./runtime-resource-baseline.mjs";
import { verifyUpdaterSignature } from "./verify-updater-signature.mjs";

const BUNDLE_ROOT = path.join(REPO_ROOT, "src-tauri", "target", "release", "bundle");
const SLIM_CONFIG_PATH = path.join(REPO_ROOT, "src-tauri", "tauri.slim.conf.json");
const PINNED_TAURI_CLI_VERSION = "2.11.4";
const PREFLIGHT_FLAG = "--check-runtime-components";
const PREFLIGHT_MARKER = "IC_RUNTIME_COMPONENT_CHECK_V1";

export function assertPinnedTauriCli(actual) {
  if (actual !== PINNED_TAURI_CLI_VERSION) {
    throw new Error(
      `瘦包 NSIS 模板基于 Tauri CLI ${PINNED_TAURI_CLI_VERSION}，当前为 ${actual}；请先审查并同步模板`,
    );
  }
}

export async function assertPreflightExecutable(executable) {
  const bytes = readFileSync(executable);
  if (
    !bytes.includes(Buffer.from(PREFLIGHT_FLAG)) ||
    !bytes.includes(Buffer.from(PREFLIGHT_MARKER))
  ) {
    throw new Error("release exe 不含资源自检命令；请先重新构建完整过渡版");
  }
  await new Promise((resolve, reject) => {
    const child = spawn(executable, [PREFLIGHT_FLAG], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    const capture = (chunk) => {
      output += chunk.toString("utf8");
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("release exe 资源自检超时；不能制作瘦包"));
    }, 120_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if ((code !== 0 && code !== 1) || !output.includes(PREFLIGHT_MARKER)) {
        reject(new Error("release exe 未按资源自检协议退出；不能制作瘦包"));
      } else {
        resolve();
      }
    });
  });
}

export function expectedWindowsBundleNames(version, productName = "无限画布") {
  return {
    nsis: `${productName}_${version}_x64-setup.exe`,
    slim: `${productName}_${version}_x64-slim-setup.exe`,
    msi: `${productName}_${version}_x64_zh-CN.msi`,
  };
}

export function assertSlimNsisScript(script) {
  for (const directory of ["blender", "remotion-runtime", "ffmpeg", "skills"]) {
    if (
      script.includes(`File /a "/oname=${directory}\\`) ||
      script.includes(`CreateDirectory "$INSTDIR\\${directory}\\`)
    ) {
      throw new Error(`瘦包仍包含 ${directory} 资源；检查 Tauri resources 覆盖配置`);
    }
  }
  if (!script.includes("slim-installer-hooks.nsh")) {
    throw new Error("瘦包缺少卸载时清理旧资源的 NSIS hook");
  }
  const init = script.match(/Function \.onInit\b([\s\S]*?)FunctionEnd/);
  if (!init?.[1].includes("!insertmacro NSIS_HOOK_PREFLIGHT")) {
    throw new Error("瘦包缺少安装前资源完整性预检；不能在卸载旧 MSI 后才检查");
  }
}

function runTauriBundle(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "pnpm",
      [
        "exec",
        "tauri",
        "bundle",
        "--bundles",
        "nsis",
        "--config",
        UPDATER_CONFIG_PATH,
        "--config",
        SLIM_CONFIG_PATH,
      ],
      { cwd: REPO_ROOT, env, stdio: "inherit", shell: process.platform === "win32" },
    );
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`tauri bundle 失败（exit=${code ?? 1}）`)),
    );
  });
}

export async function stageSlimWindowsBundle(baselinePath) {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("瘦包流程目前只支持 Windows x64");
  }
  if (typeof baselinePath !== "string" || !existsSync(baselinePath)) {
    throw new Error("必须用 --baseline 指定已发布完整过渡版的稳定资源基线");
  }
  const cli = JSON.parse(
    readFileSync(
      path.join(REPO_ROOT, "node_modules", "@tauri-apps", "cli", "package.json"),
      "utf8",
    ),
  );
  assertPinnedTauriCli(cli.version);
  const version = readAppVersion();
  assertRuntimeBaseline(
    JSON.parse(readFileSync(baselinePath, "utf8")),
    await createRuntimeBaseline(),
    version,
  );
  const conf = JSON.parse(
    readFileSync(path.join(REPO_ROOT, "src-tauri", "tauri.conf.json"), "utf8"),
  );
  const names = expectedWindowsBundleNames(version, conf.productName);
  const fullNsis = path.join(BUNDLE_ROOT, "nsis", names.nsis);
  const fullSig = `${fullNsis}.sig`;
  if (!existsSync(fullNsis) || !existsSync(fullSig)) {
    throw new Error(`请先运行 pnpm tauri:build 生成本版已签名的完整 NSIS 包：${fullNsis}`);
  }
  await verifyUpdaterSignature(fullNsis, fullSig, conf.plugins.updater.pubkey);
  await assertPreflightExecutable(
    path.join(REPO_ROOT, "src-tauri", "target", "release", "infinite-canvas.exe"),
  );
  const fullSignature = readFileSync(fullSig, "utf8");
  const env = resolveUpdaterSigningEnv(process.env, DEFAULT_UPDATER_KEY_PATH);
  if (!env.TAURI_SIGNING_PRIVATE_KEY) {
    throw new Error("缺少 updater 签名私钥，不能生成可发布瘦包");
  }
  if (
    env.TAURI_SIGNING_PRIVATE_KEY_PATH === DEFAULT_UPDATER_KEY_PATH &&
    env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD === undefined
  ) {
    // The local key has an empty password. Pass it explicitly so Tauri does
    // not wait for an interactive prompt in an unattended release build.
    env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "";
  }
  const stageRoot = path.join(BUNDLE_ROOT, "release-staging", version, "windows-x86_64");
  const fullDir = path.join(stageRoot, "full");
  const slimDir = path.join(stageRoot, "slim");
  mkdirSync(fullDir, { recursive: true });
  mkdirSync(slimDir, { recursive: true });
  const stagedFull = path.join(fullDir, names.nsis);
  const stagedFullSig = `${stagedFull}.sig`;
  copyFileSync(fullNsis, stagedFull);
  copyFileSync(fullSig, stagedFullSig);
  const msi = path.join(BUNDLE_ROOT, "msi", names.msi);
  if (existsSync(msi)) copyFileSync(msi, path.join(fullDir, names.msi));

  try {
    await runTauriBundle(env);
    const generatedScript = path.join(
      REPO_ROOT,
      "src-tauri",
      "target",
      "release",
      "nsis",
      "x64",
      "installer.nsi",
    );
    assertSlimNsisScript(readFileSync(generatedScript, "utf8"));
    if (!existsSync(fullNsis) || !existsSync(fullSig)) {
      throw new Error("Tauri 未生成带签名的瘦包");
    }
    if (readFileSync(fullSig, "utf8") === fullSignature) {
      throw new Error("瘦包签名未更新，不能复用完整安装包的签名");
    }
    await verifyUpdaterSignature(fullNsis, fullSig, conf.plugins.updater.pubkey);
    const slimBytes = statSync(fullNsis).size;
    const fullBytes = statSync(stagedFull).size;
    if (slimBytes >= fullBytes) {
      throw new Error(`瘦包大小异常：${slimBytes} 字节，完整包 ${fullBytes} 字节`);
    }
    const stagedSlim = path.join(slimDir, names.slim);
    copyFileSync(fullNsis, stagedSlim);
    copyFileSync(fullSig, `${stagedSlim}.sig`);
    const baseUrl = `${tosUpdatesPublicBaseUrl()}/windows-x86_64`;
    writeLatestJson({
      "bundle-dir": slimDir,
      "base-url": baseUrl,
      out: path.join(slimDir, "latest.json"),
      version,
      platform: "windows-x86_64",
    });
    return { stageRoot, fullBytes, slimBytes, fullDir, slimDir };
  } finally {
    // Preserve the regular full offline installer in Tauri's default bundle path.
    copyFileSync(stagedFull, fullNsis);
    copyFileSync(stagedFullSig, fullSig);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  try {
    if (process.argv[2] !== "--baseline" || !process.argv[3] || process.argv.length !== 4) {
      throw new Error("用法：pnpm tauri:bundle:slim -- --baseline <完整过渡版基线文件>");
    }
    const result = await stageSlimWindowsBundle(process.argv[3]);
    console.log(`[tauri-slim] 完整 NSIS ${result.fullBytes} 字节；瘦包 ${result.slimBytes} 字节`);
    console.log(`[tauri-slim] 已暂存 ${result.stageRoot}；未发布到 TOS`);
  } catch (error) {
    console.error(`[tauri-slim] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
