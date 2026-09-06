// 预置内置 FFmpeg 引擎：把官方 Windows 构建下载并解包到
// src-tauri/resources/ffmpeg/，随安装包分发给客户，使视频合成/转码/抽帧
// 等能力离线可用（无需首次运行时联网下载）。
//
// 下载源与 ffmpeg-sidecar 2.5.2 的 ffmpeg_download_url() 保持一致，
// 保证“内置优先、运行时下载回退”两条路径拿到的是同一类官方构建。
//
// 平台策略：Windows（x64/arm64）、macOS（x64/arm64）、Linux（x64/arm64）
// 都在构建期预置内置引擎；失败会中断构建（与 remotion:prepare 一致），
// 避免产出“宣称内置但实际缺失”的安装包。

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
  chmodSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destination = path.join(root, "src-tauri", "resources", "ffmpeg");
const manifestPath = path.join(destination, "manifest.json");

function ffmpegDownloadUrl() {
  if (process.platform === "win32") {
    return "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";
  }
  if (process.platform === "darwin" && process.arch === "x64") {
    return "https://evermeet.cx/ffmpeg/getrelease/zip";
  }
  if (process.platform === "darwin" && process.arch === "arm64") {
    return "https://www.osxexperts.net/ffmpeg80arm.zip";
  }
  if (process.platform === "linux" && process.arch === "x64") {
    return "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz";
  }
  if (process.platform === "linux" && process.arch === "arm64") {
    return "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-arm64-static.tar.xz";
  }
  throw new Error(`当前平台不支持自动内置 ffmpeg：${process.platform}/${process.arch}`);
}

function isArchivePath(filepath) {
  return filepath.endsWith(".zip") || filepath.endsWith(".tar.xz");
}

function commandResultToError(name, result) {
  if (result.status === 0) {
    return;
  }
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  throw new Error(`${name} 失败（exit=${result.status}）：${stderr}`);
}

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

function linuxEntryBinaries(extractDir) {
  const inner = readdirSync(extractDir, { withFileTypes: true })
    .find((entry) => entry.isDirectory());
  if (!inner) {
    throw new Error("解压目录中没有预期的顶层目录");
  }
  const ffmpeg = path.join(extractDir, inner.name, ffmpegName());
  const ffprobe = path.join(extractDir, inner.name, ffprobeName());
  for (const file of [ffmpeg, ffprobe]) {
    if (!existsSync(file)) {
      throw new Error(`压缩包中缺少 ${path.basename(file)}`);
    }
  }
  return { ffmpeg, ffprobe };
}

function macEntryBinaries(extractDir) {
  const ffmpeg = path.join(extractDir, ffmpegName());
  const ffprobe = path.join(extractDir, ffprobeName());
  for (const file of [ffmpeg, ffprobe]) {
    if (!existsSync(file)) {
      throw new Error(`压缩包中缺少 ${path.basename(file)}`);
    }
  }
  return { ffmpeg, ffprobe };
}

function entryBinaries(extractDir) {
  if (process.platform === "win32") {
    return zipEntryBinaries(extractDir);
  }
  if (process.platform === "linux") {
    return linuxEntryBinaries(extractDir);
  }
  if (process.platform === "darwin") {
    return macEntryBinaries(extractDir);
  }
  throw new Error(`当前平台不支持：${process.platform}`);
}

function extractZip(zipPath, extractDir) {
  if (process.platform === "win32") {
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
    commandResultToError("Expand-Archive", result);
    return;
  }
  const result = spawnSync("unzip", ["-q", zipPath, "-d", extractDir], {
    stdio: "inherit",
  });
  commandResultToError("unzip", result);
}

function extractTarXz(archivePath, extractDir) {
  const result = spawnSync("tar", ["-xJf", archivePath, "-C", extractDir], {
    stdio: "inherit",
  });
  commandResultToError("tar", result);
}

function extractArchive(archivePath, extractDir) {
  if (!isArchivePath(archivePath)) {
    throw new Error(`不支持的归档格式：${archivePath}`);
  }
  if (archivePath.endsWith(".zip")) {
    extractZip(archivePath, extractDir);
    return;
  }
  extractTarXz(archivePath, extractDir);
}

async function prepare() {
  const ffmpegDownloadUrlValue = ffmpegDownloadUrl();
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

  console.log("[ffmpeg:prepare] 准备内置 FFmpeg 引擎");
  const tempRoot = path.join(destination, ".prepare");
  const archiveName = new URL(ffmpegDownloadUrlValue).pathname.split("/").pop() || "ffmpeg-archive";
  const archivePath = path.join(tempRoot, archiveName);
  const extractDir = path.join(tempRoot, "out");
  try {
    rmSync(tempRoot, { recursive: true, force: true });
    mkdirSync(extractDir, { recursive: true });

    console.log(`[ffmpeg:prepare] 下载 ${ffmpegDownloadUrlValue}`);
    // Node 22+ 全局 fetch；下载失败会抛错并中断构建。
    const response = await fetch(ffmpegDownloadUrlValue);
    if (!response.ok) {
      throw new Error(`下载失败：HTTP ${response.status}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0) {
      throw new Error("下载内容为空");
    }
    writeFileSync(archivePath, bytes);
    console.log(`[ffmpeg:prepare] 下载完成：${(bytes.length / 1024 / 1024).toFixed(1)} MiB`);

    extractArchive(archivePath, extractDir);
    const { ffmpeg, ffprobe } = entryBinaries(extractDir);

    mkdirSync(destination, { recursive: true });
    cpSync(ffmpeg, ffmpegPath);
    cpSync(ffprobe, ffprobePath);
    if (process.platform !== "win32") {
      chmodSync(ffmpegPath, 0o755);
      chmodSync(ffprobePath, 0o755);
    }

    const { version, firstLine } = probeVersion(ffmpegPath);
    console.log(`[ffmpeg:prepare] 引擎就绪：${firstLine}`);

    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          schemaVersion: 1,
          version,
          source: ffmpegDownloadUrlValue,
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
