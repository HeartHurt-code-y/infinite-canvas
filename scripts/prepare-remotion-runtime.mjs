import { readFile, writeFile, mkdir, copyFile, cp, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "tools", "remotion-runtime");
// Node 26 currently leaves extract-zip's stream pipeline unresolved on Windows.
// Use the same pinned Node LTS for preparation and the shipped offline engine.
const nodeVersion = "24.19.0";
if (process.platform === "win32" && process.version !== `v${nodeVersion}`) {
  const checksums = {
    x64: "3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237",
    arm64: "3958e4bb3f2d4ef37c938215dfc65a9d3c9d839b5060fec103bd2345fa78e951",
  };
  const checksum = checksums[process.arch];
  if (!checksum) throw new Error("动画运行时仅支持 Windows x64 / arm64");
  const nodeDirectory = path.join(source, ".build-node", `${nodeVersion}-${process.arch}`);
  const executable = path.join(nodeDirectory, "node.exe");
  let available = false;
  try {
    available =
      createHash("sha256")
        .update(await readFile(executable))
        .digest("hex") === checksum;
  } catch {
    /* Fetch official pinned Node. */
  }
  if (!available) {
    for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
      const candidate = path.join(directory.replace(/^"|"$/g, ""), "node.exe");
      try {
        if (
          createHash("sha256")
            .update(await readFile(candidate))
            .digest("hex") !== checksum
        )
          continue;
        await mkdir(nodeDirectory, { recursive: true });
        await copyFile(candidate, executable);
        available = true;
        break;
      } catch {
        /* Not a matching pinned runtime on PATH. */
      }
    }
  }
  if (!available) {
    console.log("准备固定版本的本地动画引擎");
    const response = await fetch(
      `https://nodejs.org/dist/v${nodeVersion}/win-${process.arch}/node.exe`,
    );
    if (!response.ok) throw new Error(`下载动画 Node 运行时失败：${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== checksum)
      throw new Error("动画 Node 运行时校验失败");
    await mkdir(nodeDirectory, { recursive: true });
    await writeFile(executable, bytes);
  }
  const code = await new Promise((resolve, reject) => {
    const child = spawn(executable, [fileURLToPath(import.meta.url)], {
      cwd: root,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", resolve);
  });
  process.exit(typeof code === "number" ? code : 1);
}
const destination = path.join(root, "src-tauri", "resources", "remotion-runtime");
const fileNames = [
  "package.json",
  "pnpm-lock.yaml",
  "plan.mjs",
  "Composition.tsx",
  "index.tsx",
  "render.mjs",
];
const hash = createHash("sha256");
for (const name of fileNames) hash.update(await readFile(path.join(source, name)));
hash.update(await readFile(fileURLToPath(import.meta.url)));
hash.update(process.version + process.platform + process.arch);
const fingerprint = hash.digest("hex");
const manifestPath = path.join(destination, "runtime-manifest.json");
const nodeName = process.platform === "win32" ? "node.exe" : "node";
let oldManifest;
try {
  oldManifest = JSON.parse(await readFile(manifestPath, "utf8"));
} catch {
  /* First preparation. */
}
const readyPaths = [
  nodeName,
  "render.mjs",
  "plan.mjs",
  "Composition.tsx",
  "bundle/index.html",
  "node_modules/@remotion/renderer/package.json",
  oldManifest?.browserExecutable ?? "missing",
];
if (
  oldManifest?.fingerprint === fingerprint &&
  readyPaths.every((file) => existsSync(path.join(destination, file)))
) {
  console.log("动画渲染运行时已就绪");
  process.exit(0);
}

async function pnpmInstall(directory, production = false) {
  const args = ["install", "--frozen-lockfile", "--no-fund", ...(production ? ["--prod"] : [])];
  await new Promise((resolve, reject) => {
    const child =
      process.platform === "win32"
        ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `pnpm ${args.join(" ")}`], {
            cwd: directory,
            stdio: "inherit",
            windowsHide: true,
          })
        : spawn("pnpm", args, { cwd: directory, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`动画依赖安装失败：${code}`)),
    );
  });
}
console.log("准备本地动画渲染运行时");
const lockHash = createHash("sha256")
  .update(await readFile(path.join(source, "pnpm-lock.yaml")))
  .digest("hex");
let installedHash;
try {
  installedHash = await readFile(path.join(source, "node_modules", ".canvas-lock"), "utf8");
} catch {
  /* Install the pinned package. */
}
if (
  installedHash !== lockHash ||
  !existsSync(path.join(source, "node_modules", "@remotion", "bundler", "package.json"))
) {
  await pnpmInstall(source);
  await writeFile(path.join(source, "node_modules", ".canvas-lock"), lockHash);
}
await mkdir(destination, { recursive: true });
for (const name of [
  "package.json",
  "pnpm-lock.yaml",
  "plan.mjs",
  "Composition.tsx",
  "render.mjs",
])
  await copyFile(path.join(source, name), path.join(destination, name));
if (
  oldManifest?.lockHash !== lockHash ||
  !existsSync(path.join(destination, "node_modules", "@remotion", "renderer", "package.json"))
)
  await pnpmInstall(destination, true);
await copyFile(process.execPath, path.join(destination, nodeName));
if (!existsSync(path.join(destination, "NODE-LICENSE.txt"))) {
  const response = await fetch(
    `https://raw.githubusercontent.com/nodejs/node/v${nodeVersion}/LICENSE`,
  );
  if (!response.ok) throw new Error(`无法准备 Node 运行时许可文件：${response.status}`);
  await writeFile(path.join(destination, "NODE-LICENSE.txt"), await response.text());
}
const originalWorkingDirectory = process.cwd();
process.chdir(source);
try {
  const { bundle } = await import(
    pathToFileURL(path.join(source, "node_modules", "@remotion", "bundler", "dist", "index.js"))
      .href
  );
  const { ensureBrowser } = await import(
    pathToFileURL(path.join(source, "node_modules", "@remotion", "renderer", "dist", "index.js"))
      .href
  );
  const status = await ensureBrowser({ chromeMode: "headless-shell", logLevel: "info" });
  if (!status.path || !(await stat(status.path)).isFile())
    throw new Error("无法准备动画渲染浏览器");
  const browserDirectory = path.join(destination, "browser");
  await cp(path.dirname(status.path), browserDirectory, { recursive: true });
  const browserExecutable = `browser/${path.basename(status.path)}`;
  await bundle({
    entryPoint: path.join(source, "index.tsx"),
    outDir: path.join(destination, "bundle"),
    rootDir: source,
    enableCaching: false,
    publicDir: null,
    gitSource: null,
    askAIEnabled: false,
  });
  const packageJson = JSON.parse(await readFile(path.join(source, "package.json"), "utf8"));
  await writeFile(
    manifestPath,
    JSON.stringify(
      {
        schemaVersion: 1,
        fingerprint,
        lockHash,
        nodeVersion: process.version,
        remotionVersion: packageJson.dependencies.remotion,
        browserExecutable,
      },
      null,
      2,
    ),
  );
  console.log(`动画渲染运行时已准备：${destination}`);
} finally {
  process.chdir(originalWorkingDirectory);
}
