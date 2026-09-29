// Rebundle the already built Windows executable as a small, signed NSIS updater.
// The full NSIS/MSI installers are staged first and restored after bundling.
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
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
import {
  RESOURCE_COMPONENTS,
  stageRuntimeResourceRelease,
  stageRuntimeResourceReleaseFromSignedManifest,
} from "./runtime-resource-release.mjs";
import { verifyUpdaterSignature } from "./verify-updater-signature.mjs";

const BUNDLE_ROOT = path.join(REPO_ROOT, "src-tauri", "target", "release", "bundle");
const SLIM_CONFIG_PATH = path.join(REPO_ROOT, "src-tauri", "tauri.slim.conf.json");
const PINNED_TAURI_CLI_VERSION = "2.11.4";
const PREFLIGHT_FLAG = "--check-runtime-components";
const PREFLIGHT_MARKER = "IC_RUNTIME_COMPONENT_CHECK_V1";
const PINS_FLAG = "--print-runtime-component-pins";
const PINS_MARKER = "IC_RUNTIME_COMPONENT_PINS_V1 ";

export function assertPinnedTauriCli(actual) {
  if (actual !== PINNED_TAURI_CLI_VERSION) {
    throw new Error(
      `瘦包 NSIS 模板基于 Tauri CLI ${PINNED_TAURI_CLI_VERSION}，当前为 ${actual}；请先审查并同步模板`,
    );
  }
}

export async function assertPreflightExecutable(executable) {
  // Release optimization can split or fold string literals. Verify the actual
  // command behavior instead of searching for its argument bytes in the exe.
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

export function assertCompiledManifestPinsOutput(output, manifest) {
  const lines = output.split(/\r?\n/).filter((line) => line.startsWith(PINS_MARKER));
  if (lines.length !== 1) throw new Error("release exe 未提供唯一的资源清单编译标记");
  let pins;
  try {
    pins = JSON.parse(lines[0].slice(PINS_MARKER.length));
  } catch {
    throw new Error("release exe 的资源清单编译标记不是 JSON");
  }
  const expected = Object.fromEntries(
    manifest.components.map((component) => [component.name, component.manifestSha256]),
  );
  if (
    !pins ||
    typeof pins !== "object" ||
    Array.isArray(pins) ||
    Object.keys(pins).length !== Object.keys(expected).length ||
    Object.entries(expected).some(([name, sha256]) => pins[name] !== sha256)
  ) {
    throw new Error("release exe 内置资源清单与签名资源发布清单不一致；不能制作瘦包");
  }
}

export function assertFullNsisNewerThanInputs(fullNsis, executable, manifest, root = REPO_ROOT) {
  const bundleTime = statSync(fullNsis).mtimeMs;
  // Windows can finalize the executable and NSIS output timestamps within the
  // same build in either order. Allow only a subsecond skew for the executable;
  // resource files must still be strictly older than the full installer.
  const EXECUTABLE_TIMESTAMP_SKEW_MS = 500;
  const inputs = [executable];
  for (const component of manifest.components) {
    const definition = RESOURCE_COMPONENTS.find((item) => item.name === component.name);
    if (!definition) throw new Error(`未知资源组件：${component.name}`);
    for (const file of component.files) {
      inputs.push(path.join(root, definition.source, ...file.path.split("/")));
    }
  }
  for (const input of inputs) {
    const info = statSync(input);
    const allowedSkew = input === executable ? EXECUTABLE_TIMESTAMP_SKEW_MS : 0;
    if (!info.isFile() || info.mtimeMs >= bundleTime + allowedSkew) {
      throw new Error(`完整 NSIS 早于程序或资源文件 ${input}；请重新构建完整安装包`);
    }
  }
}

export function assertReleaseExecutableFreshness(executable, inputs) {
  const executableTime = statSync(executable).mtimeMs;
  for (const input of inputs) {
    if (statSync(input).mtimeMs > executableTime) {
      throw new Error(`release exe 早于当前源码或前端产物 ${input}；请重新构建程序`);
    }
  }
}

function releaseExecutableInputs() {
  const inputs = [
    "package.json",
    "pnpm-lock.yaml",
    "vite.config.ts",
    "src-tauri/Cargo.toml",
    "src-tauri/Cargo.lock",
    "src-tauri/tauri.conf.json",
    "src-tauri/build.rs",
  ]
    .map((relative) => path.join(REPO_ROOT, relative))
    .filter(existsSync);
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) inputs.push(file);
      else throw new Error(`构建输入含不支持的链接或文件：${file}`);
    }
  };
  for (const directory of ["src", "src-tauri/src", "dist"]) {
    visit(path.join(REPO_ROOT, directory));
  }
  return inputs;
}

function readWindowsProductVersion(filePath) {
  const powershell = path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  return execFileSync(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[System.Diagnostics.FileVersionInfo]::GetVersionInfo($env:IC_VERSION_PATH).ProductVersion",
    ],
    {
      encoding: "utf8",
      env: { ...process.env, IC_VERSION_PATH: filePath },
      timeout: 30_000,
      maxBuffer: 4096,
      windowsHide: true,
    },
  ).trim();
}

export function assertReusableFullVersions(sourceVersion, currentVersion, bridgeVersion) {
  const parse = (value) =>
    /^\d+\.\d+\.\d+$/.test(value ?? "") ? value.split(".").map(Number) : null;
  const source = parse(sourceVersion);
  const current = parse(currentVersion);
  const bridge = parse(bridgeVersion);
  const compare = (left, right) => left.findIndex((value, index) => value !== right[index]);
  const earlier = (left, right) => {
    const index = compare(left, right);
    return index >= 0 && left[index] < right[index];
  };
  if (!source || !current || !bridge || !earlier(source, current) || earlier(source, bridge)) {
    throw new Error("复用的完整包版本必须位于资源过渡版和当前瘦包版本之间");
  }
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function assertSignedBridgeFull(baseline, baselinePath, productName, pubkey) {
  const full = path.join(
    path.dirname(path.resolve(baselinePath)),
    expectedWindowsBundleNames(baseline.bridgeVersion, productName).nsis,
  );
  if (!existsSync(full) || !existsSync(`${full}.sig`)) {
    throw new Error("资源过渡版完整 NSIS 及签名不存在；不能仅制作瘦包");
  }
  await verifyUpdaterSignature(full, `${full}.sig`, pubkey);
  if (
    (await sha256File(full)) !== baseline.fullNsisSha256 ||
    (await sha256File(`${full}.sig`)) !== baseline.fullNsisSignatureSha256 ||
    readWindowsProductVersion(full) !== baseline.bridgeVersion
  ) {
    throw new Error("资源过渡版完整 NSIS 与基线记录不一致；不能仅制作瘦包");
  }
}

export async function assertCompiledResourcePins(executable, manifest) {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, [PINS_FLAG], {
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
      reject(new Error("release exe 资源清单编译标记读取超时；不能制作瘦包"));
    }, 30_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      try {
        if (code !== 0) throw new Error("release exe 资源清单编译标记读取失败；不能制作瘦包");
        assertCompiledManifestPinsOutput(output, manifest);
        resolve();
      } catch (error) {
        reject(error);
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

export async function stageSlimWindowsBundle(baselinePath, { reuseFullVersion } = {}) {
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
  const bridgeBaseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const conf = JSON.parse(
    readFileSync(path.join(REPO_ROOT, "src-tauri", "tauri.conf.json"), "utf8"),
  );
  const names = expectedWindowsBundleNames(version, conf.productName);
  const fullNsis = path.join(BUNDLE_ROOT, "nsis", names.nsis);
  const fullSig = `${fullNsis}.sig`;
  if (!reuseFullVersion && (!existsSync(fullNsis) || !existsSync(fullSig))) {
    throw new Error(`请先运行 pnpm tauri:build 生成本版已签名的完整 NSIS 包：${fullNsis}`);
  }
  if (reuseFullVersion && (existsSync(fullNsis) || existsSync(fullSig))) {
    throw new Error("当前版本已存在同名完整包路径；不能将瘦包伪装成完整包");
  }
  const executable = path.join(REPO_ROOT, "src-tauri", "target", "release", "infinite-canvas.exe");
  if (readWindowsProductVersion(executable) !== version) {
    throw new Error(`release exe 内部版本不是 ${version}；请重新构建程序`);
  }
  assertReleaseExecutableFreshness(executable, releaseExecutableInputs());
  await assertPreflightExecutable(executable);
  const fullSignature = reuseFullVersion ? null : readFileSync(fullSig, "utf8");
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
  if (reuseFullVersion && existsSync(fullDir)) {
    throw new Error("当前版本已有完整包暂存目录；slim-only 发布不能包含同版完整包");
  }
  mkdirSync(slimDir, { recursive: true });
  let comparisonFull = fullNsis;
  let stagedFull = null;
  let stagedFullSig = null;
  if (!reuseFullVersion) {
    await verifyUpdaterSignature(fullNsis, fullSig, conf.plugins.updater.pubkey);
    mkdirSync(fullDir, { recursive: true });
    stagedFull = path.join(fullDir, names.nsis);
    stagedFullSig = `${stagedFull}.sig`;
    copyFileSync(fullNsis, stagedFull);
    copyFileSync(fullSig, stagedFullSig);
    const msi = path.join(BUNDLE_ROOT, "msi", names.msi);
    if (existsSync(msi)) copyFileSync(msi, path.join(fullDir, names.msi));
    comparisonFull = stagedFull;
  }

  // The full NSIS was built from this source tree. Sign a complete file-level
  // inventory only after checking that its generated file table contains each
  // resource exactly once. This proof replaces the old byte-equality gate.
  const resourceOutDir = path.join(slimDir, "resources", version, "windows-x86_64");
  let resourceRelease;
  if (reuseFullVersion) {
    assertReusableFullVersions(reuseFullVersion, version, bridgeBaseline.bridgeVersion);
    // Strictly identical stable trees prove that installed resources from the
    // signed full bridge can be reused. Do not permit file-level changes here.
    assertRuntimeBaseline(bridgeBaseline, await createRuntimeBaseline(), version);
    await assertSignedBridgeFull(
      bridgeBaseline,
      baselinePath,
      conf.productName,
      conf.plugins.updater.pubkey,
    );
    comparisonFull = path.join(
      BUNDLE_ROOT,
      "release-staging",
      reuseFullVersion,
      "windows-x86_64",
      "full",
      expectedWindowsBundleNames(reuseFullVersion, conf.productName).nsis,
    );
    if (!existsSync(comparisonFull) || !existsSync(`${comparisonFull}.sig`)) {
      throw new Error("复用版本的完整 NSIS 或 updater 签名不存在");
    }
    await verifyUpdaterSignature(
      comparisonFull,
      `${comparisonFull}.sig`,
      conf.plugins.updater.pubkey,
    );
    if (readWindowsProductVersion(comparisonFull) !== reuseFullVersion) {
      throw new Error("复用版本的完整 NSIS 内部版本不匹配");
    }
    const sourceManifestPath = path.join(
      BUNDLE_ROOT,
      "release-staging",
      reuseFullVersion,
      "windows-x86_64",
      "slim",
      "resources",
      reuseFullVersion,
      "windows-x86_64",
      "manifest.json",
    );
    resourceRelease = await stageRuntimeResourceReleaseFromSignedManifest({
      root: REPO_ROOT,
      version,
      outDir: resourceOutDir,
      sourceManifestPath,
      sourceVersion: reuseFullVersion,
    });
  } else {
    const fullNsisScript = path.join(
      REPO_ROOT,
      "src-tauri",
      "target",
      "release",
      "nsis",
      "x64",
      "installer.nsi",
    );
    resourceRelease = await stageRuntimeResourceRelease({
      root: REPO_ROOT,
      version,
      outDir: resourceOutDir,
      nsisScriptPath: fullNsisScript,
    });
    assertFullNsisNewerThanInputs(fullNsis, executable, resourceRelease.manifest);
    assertRuntimeBaseline(bridgeBaseline, await createRuntimeBaseline(), version, {
      signedResourceReleaseVerified: true,
    });
  }
  await assertCompiledResourcePins(executable, resourceRelease.manifest);

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
    if (fullSignature && readFileSync(fullSig, "utf8") === fullSignature) {
      throw new Error("瘦包签名未更新，不能复用完整安装包的签名");
    }
    await verifyUpdaterSignature(fullNsis, fullSig, conf.plugins.updater.pubkey);
    const slimBytes = statSync(fullNsis).size;
    const fullBytes = statSync(comparisonFull).size;
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
      resourceManifest: {
        url: `${tosUpdatesPublicBaseUrl()}/resources/${version}/windows-x86_64/manifest.json`,
        signature: resourceRelease.signature,
      },
    });
    return { stageRoot, fullBytes, slimBytes, fullDir, slimDir };
  } finally {
    if (reuseFullVersion) {
      // Tauri writes the slim NSIS under its normal full-looking name. Keep only
      // the explicitly named slim staging artifact for this version.
      if (existsSync(fullNsis)) unlinkSync(fullNsis);
      if (existsSync(fullSig)) unlinkSync(fullSig);
    } else {
      // Preserve the regular full offline installer in Tauri's default bundle path.
      copyFileSync(stagedFull, fullNsis);
      copyFileSync(stagedFullSig, fullSig);
    }
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  try {
    if (
      process.argv[2] !== "--baseline" ||
      !process.argv[3] ||
      (process.argv.length !== 4 &&
        !(
          process.argv.length === 6 &&
          process.argv[4] === "--reuse-full-version" &&
          process.argv[5]
        ))
    ) {
      throw new Error(
        "用法：pnpm tauri:bundle:slim -- --baseline <完整过渡版基线文件> [--reuse-full-version <已签名完整包版本>]",
      );
    }
    const result = await stageSlimWindowsBundle(process.argv[3], {
      ...(process.argv[5] ? { reuseFullVersion: process.argv[5] } : {}),
    });
    console.log(
      `[tauri-slim] 参考完整 NSIS ${result.fullBytes} 字节；瘦包 ${result.slimBytes} 字节`,
    );
    console.log(`[tauri-slim] 已暂存 ${result.stageRoot}；未发布到 TOS`);
  } catch (error) {
    console.error(`[tauri-slim] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
