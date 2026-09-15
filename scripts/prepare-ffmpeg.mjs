// 预置内置 FFmpeg 引擎：把官方构建下载并解包到
// src-tauri/resources/ffmpeg/，随安装包分发给客户，使视频合成/转码/抽帧
// 等能力离线可用（无需首次运行时联网下载）。
//
// 下载源与 ffmpeg-sidecar 2.5.2 的 ffmpeg_download_url() 保持一致，
// 保证“内置优先、运行时下载回退”两条路径拿到的是同一类官方构建。
//
// 平台策略：Windows（x64/arm64）、macOS（x64/arm64）、Linux（x64/arm64）
// 都在构建期预置 ffmpeg 引擎；ffmpeg 下载失败会中断构建（与 remotion:prepare
// 一致）。macOS 的 ffmpeg 发行包不含 ffprobe，因此额外做一次**非致命**的
// ffprobe 补下载：拿到就是完整引擎，拿不到只告警——应用侧会用
// `ffmpeg -i` 解析时长/分辨率兜底（见 src-tauri/src/backend/composer.rs）。

import { createHash } from "node:crypto";
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

function requireFFprobeBundle() {
  return process.platform !== "darwin";
}

/// macOS 的 ffmpeg 发行包（evermeet.cx / osxexperts.net）里只有 ffmpeg，没有 ffprobe，
/// 因此需要单独补一份。两个源都按架构区分：
///   - darwin/x64   → evermeet.cx（Intel 原生）
///   - darwin/arm64 → osxexperts.net（Apple Silicon 原生）
/// 补下载是**非致命**的：失败只告警，不中断安装包构建；应用侧会用
/// `ffmpeg -i` 解析媒体元数据兜底（见 src-tauri/src/backend/composer.rs）。
function ffprobeDownloadUrl() {
  if (process.platform !== "darwin") {
    return null;
  }
  if (process.arch === "arm64") {
    return "https://www.osxexperts.net/ffprobe80arm.zip";
  }
  if (process.arch === "x64") {
    return "https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip";
  }
  return null;
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

/// 校验任意 ffmpeg / ffprobe 二进制可执行，返回 `-version` 首行。
function probeBinary(binaryPath, expectedPrefix) {
  const result = spawnSync(binaryPath, ["-version"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0 || !result.stdout) {
    throw new Error(`无法执行 ${path.basename(binaryPath)} -version（exit=${result.status}）`);
  }
  const firstLine = result.stdout.split(/\r?\n/)[0];
  if (!firstLine.startsWith(expectedPrefix)) {
    throw new Error(`无法识别的版本输出：${firstLine}`);
  }
  return firstLine;
}

/// macOS：单独补一份 ffprobe（非致命）。
///
/// 任何失败都只告警：ffmpeg 已经可用，为了一个第三方源不可用就中断整个
/// 安装包构建是不划算的；应用侧会退回 `ffmpeg -i` 解析元数据。
async function fetchDarwinFFprobe(ffprobePath) {
  const url = ffprobeDownloadUrl();
  if (!url) {
    console.warn(
      `[ffmpeg:prepare] 未为 darwin/${process.arch} 配置 ffprobe 源，跳过（应用将用 ffmpeg -i 兜底）`,
    );
    return false;
  }
  const tempRoot = path.join(destination, ".prepare-ffprobe");
  const archivePath = path.join(tempRoot, "ffprobe.zip");
  const extractDir = path.join(tempRoot, "out");
  try {
    console.log(`[ffmpeg:prepare] 补下载 macOS ffprobe：${url}`);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`下载失败：HTTP ${response.status}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0) {
      throw new Error("下载内容为空");
    }
    rmSync(tempRoot, { recursive: true, force: true });
    mkdirSync(extractDir, { recursive: true });
    writeFileSync(archivePath, bytes);
    extractArchive(archivePath, extractDir);
    const candidate = path.join(extractDir, ffprobeName());
    if (!existsSync(candidate)) {
      throw new Error(`压缩包中缺少 ${ffprobeName()}`);
    }
    cpSync(candidate, ffprobePath);
    chmodSync(ffprobePath, 0o755);
    console.log(
      `[ffmpeg:prepare] macOS ffprobe 就绪：${probeBinary(ffprobePath, "ffprobe version")}`,
    );
    return true;
  } catch (error) {
    rmSync(ffprobePath, { force: true });
    console.warn(
      `[ffmpeg:prepare] macOS ffprobe 补下载失败，降级为仅 ffmpeg（合成改用 ffmpeg -i 解析元数据）：${error.message}`,
    );
    return false;
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function zipEntryBinaries(extractDir) {
  // gyan.dev zip 内部布局：ffmpeg-7.1-essentials_build/bin/ffmpeg.exe
  const inner = readdirSync(extractDir, { withFileTypes: true }).find((entry) =>
    entry.isDirectory(),
  );
  if (!inner) {
    throw new Error("解压目录中没有预期的顶层目录");
  }
  const binDir = path.join(extractDir, inner.name, "bin");
  const ffmpeg = path.join(binDir, ffmpegName());
  const ffprobe = path.join(binDir, ffprobeName());
  if (!existsSync(ffmpeg)) {
    throw new Error(`压缩包中缺少 ${path.basename(ffmpeg)}`);
  }
  if (!existsSync(ffprobe) && requireFFprobeBundle()) {
    throw new Error(`压缩包中缺少 ${path.basename(ffprobe)}`);
  }
  return { ffmpeg, ffprobe: existsSync(ffprobe) ? ffprobe : null };
}

function linuxEntryBinaries(extractDir) {
  const inner = readdirSync(extractDir, { withFileTypes: true }).find((entry) =>
    entry.isDirectory(),
  );
  if (!inner) {
    throw new Error("解压目录中没有预期的顶层目录");
  }
  const ffmpeg = path.join(extractDir, inner.name, ffmpegName());
  const ffprobe = path.join(extractDir, inner.name, ffprobeName());
  if (!existsSync(ffmpeg)) {
    throw new Error(`压缩包中缺少 ${path.basename(ffmpeg)}`);
  }
  if (!existsSync(ffprobe) && requireFFprobeBundle()) {
    throw new Error(`压缩包中缺少 ${path.basename(ffprobe)}`);
  }
  return { ffmpeg, ffprobe: existsSync(ffprobe) ? ffprobe : null };
}

function macEntryBinaries(extractDir) {
  const ffmpeg = path.join(extractDir, ffmpegName());
  const ffprobe = path.join(extractDir, ffprobeName());
  if (!existsSync(ffmpeg)) {
    throw new Error(`压缩包中缺少 ${path.basename(ffmpeg)}`);
  }
  return {
    ffmpeg,
    ffprobe: existsSync(ffprobe) ? ffprobe : null,
  };
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
  const isDarwin = process.platform === "darwin";
  // macOS 上 ffprobe 是「补下载」而非随包附带，可能拿不到。把「试过但没成功」
  // 记进 manifest，避免每次构建都为了它重下整个 ffmpeg 归档；
  // `--force` 仍会重新尝试。
  const ffprobeSettled = existsSync(ffprobePath) || existing?.ffprobeUnavailable === true;
  const ready =
    !force &&
    existing?.schemaVersion === 1 &&
    existing?.version &&
    existsSync(ffmpegPath) &&
    (isDarwin ? ffprobeSettled : existsSync(ffprobePath));
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
    if (ffprobe) {
      cpSync(ffprobe, ffprobePath);
    } else if (existsSync(ffprobePath)) {
      rmSync(ffprobePath, { force: true });
    }
    if (process.platform !== "win32") {
      chmodSync(ffmpegPath, 0o755);
      if (existsSync(ffprobePath)) {
        chmodSync(ffprobePath, 0o755);
      }
    }

    const { version, firstLine } = probeVersion(ffmpegPath);
    console.log(`[ffmpeg:prepare] 引擎就绪：${firstLine}`);

    // macOS：发行包不含 ffprobe，单独补一次；失败仅告警，不中断构建。
    if (isDarwin && !existsSync(ffprobePath)) {
      await fetchDarwinFFprobe(ffprobePath);
    }

    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          schemaVersion: 1,
          version,
          source: ffmpegDownloadUrlValue,
          ffmpegSha256: sha256(ffmpegPath),
          ffprobeSha256: existsSync(ffprobePath) ? sha256(ffprobePath) : null,
          ffprobeUnavailable: !existsSync(ffprobePath),
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
