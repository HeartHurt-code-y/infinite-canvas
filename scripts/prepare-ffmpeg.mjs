// 预置内置 FFmpeg 引擎：把官方 Windows 构建下载并解包到
// src-tauri/resources/ffmpeg/，随安装包分发给客户，使视频合成/转码/抽帧
// 等能力离线可用（无需首次运行时联网下载）。
//
// 下载源与 ffmpeg-sidecar 2.5.2 的 ffmpeg_download_url() 保持一致
// （gyan.dev essentials 构建），保证"内置优先、运行时下载回退"两条路径
// 拿到的是同一类官方构建。
//
// 平台策略：仅 Windows（x64/arm64）预置内置引擎；macOS/Linux 跳过并在
// 运行时回退到下载（这些平台的 ffmpeg-sidecar 使用各自官方源）。
// 失败会中断构建（与 remotion:prepare 一致），避免产出"宣称内置但实际
// 缺失"的安装包。

import {
  createHash,
} from "node:crypto";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  readdirSync,
  cpSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destination = path.join(root, "src-tauri", "resources", "ffmpeg");
const manifestPath = path.join(destination, "manifest.json");

// 与 ffmpeg-sidecar::download::ffmpeg_download_url() 的 Windows 返回值一致。
const FFMPEG_URL = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";

function ffmpegName() {
  return process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
}
function ffprobeName() {
  return process.platform === "win32" ? "ffprobe.exe" : "ffprobe";
}

function probeVersion(binaryPath) {
  const result = spawnSync(binaryPath, ["-version"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0 || !result.stdout) {
    throw new Error(`无法执行 ffmpeg -version（exit=${result.status}）`);
  }
  const firstLine = result.stdout.split(/\r?\n/)[0];
  const match = /^ffmpeg version (\S+)/.exec(firstLine);
  if (!match) {
    throw new Error(`无法解析 ffmpeg 版本：${firstLine}`);
  }
  return { version: match[1], firstLine };
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function zipEntryBinaries(extractDir) {
  // gyan.dev zip 内部布局：ffmpeg-7.1-essentials_build/bin/ffmpeg.exe
  const inner = readdirSync(extractDir, { withFileTypes: true })
    .find((entry) => entry.isDirectory());
  if (!inner) {
    throw new Error("解压目录中没有预期的顶层目录");
  }
  const binDir = path.join(extractDir, inner.name, "bin");
  const ffmpeg = path.join(binDir, ffmpegName());
  const ffprobe = path.join(binDir, ffprobeName());
  for (const file of [ffmpeg, ffprobe]) {
    if (!existsSync(file)) {
      throw new Error(`压缩包中缺少 ${path.basename(file)}`);
    }
  }
  return { ffmpeg, ffprobe };
}

function extractZip(zipPath, extractDir) {
  // Windows 自带 PowerShell Expand-Archive，避免为构建脚本引入第三方依赖。
  const result = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${extractDir}' -Force`,
    ],
    { stdio: "inherit", windowsHide: true },
  );
  if (result.status !== 0) {
    throw new Error("PowerShell Expand-Archive 解压失败");
  }
}

async function prepare() {
  if (process.platform !== "win32") {
    console.log(
      "[ffmpeg:prepare] 非 Windows 平台跳过内置 FFmpeg 预置，运行时将回退到 ffmpeg-sidecar 下载。",
    );
    process.exit(0);
  }

  const force = process.argv.includes("--force");
  const ffmpegPath = path.join(destination, ffmpegName());
  const ffprobePath = path.join(destination, ffprobeName());
  let existing;
  try {
    existing = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    existing = null;
  }
  const ready =
    !force &&
    existing?.schemaVersion === 1 &&
    existing?.version &&
    existsSync(ffmpegPath) &&
    existsSync(ffprobePath);
  if (ready) {
    console.log(`[ffmpeg:prepare] 内置 FFmpeg 已就绪：v${existing.version}`);
    process.exit(0);
  }

  console.log("[ffmpeg:prepare] 准备内置 FFmpeg 引擎（gyan.dev essentials）");
  const tempRoot = path.join(destination, ".prepare");
  const zipPath = path.join(tempRoot, "ffmpeg-essentials.zip");
  const extractDir = path.join(tempRoot, "out");
  try {
    rmSync(tempRoot, { recursive: true, force: true });
    mkdirSync(extractDir, { recursive: true });

    console.log(`[ffmpeg:prepare] 下载 ${FFMPEG_URL}`);
    // Node 22+ 全局 fetch；下载失败会抛错并中断构建。
    const response = await fetch(FFMPEG_URL);
    if (!response.ok) {
      throw new Error(`下载失败：HTTP ${response.status}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0) {
      throw new Error("下载内容为空");
    }
    writeFileSync(zipPath, bytes);
    console.log(`[ffmpeg:prepare] 下载完成：${(bytes.length / 1024 / 1024).toFixed(1)} MiB`);

    extractZip(zipPath, extractDir);
    const { ffmpeg, ffprobe } = zipEntryBinaries(extractDir);

    mkdirSync(destination, { recursive: true });
    cpSync(ffmpeg, ffmpegPath);
    cpSync(ffprobe, ffprobePath);

    const { version, firstLine } = probeVersion(ffmpegPath);
    console.log(`[ffmpeg:prepare] 引擎就绪：${firstLine}`);

    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          schemaVersion: 1,
          version,
          source: FFMPEG_URL,
          ffmpegSha256: sha256(ffmpegPath),
          ffprobeSha256: sha256(ffprobePath),
          preparedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    console.log(`[ffmpeg:prepare] 已写入 ${path.relative(root, manifestPath)}`);
  } catch (error) {
    console.error(`[ffmpeg:prepare] 失败：${error.message}`);
    rmSync(tempRoot, { recursive: true, force: true });
    process.exit(1);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

prepare().catch((error) => {
  console.error(`[ffmpeg:prepare] 失败：${error.message}`);
  process.exit(1);
});
