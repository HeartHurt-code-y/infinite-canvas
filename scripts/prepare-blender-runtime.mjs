// Build-time only: ship the complete, verified official Blender distribution.
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

export const BLENDER_VERSION = "4.5.13";
const BASE_URL = "https://download.blender.org/release/Blender4.5/";
const CHECKSUM_URL = `${BASE_URL}blender-${BLENDER_VERSION}.sha256`;
// Official manifest checked on 2026-09-14; do not accept an unverified replacement archive.
const DISTRIBUTIONS = {
  "win32/x64": {
    filename: "blender-4.5.13-windows-x64.zip",
    sha256: "b5fdf800ce65fa2f209e8f68d02667e4d720fa1c42f247c72d1882ab04decba6",
    size: 398648740,
  },
  "win32/arm64": {
    filename: "blender-4.5.13-windows-arm64.zip",
    sha256: "7008ebe76f7aa6e4062253fe3d485191954869f6baad9f11f438a41da1c2a58b",
    size: 254746929,
  },
  "darwin/x64": {
    filename: "blender-4.5.13-macos-x64.dmg",
    sha256: "43caddd07d0917cb5bac288180e6bcb0374fac4fdc31cca9dc230a2e3dec752f",
    size: 340092751,
  },
  "darwin/arm64": {
    filename: "blender-4.5.13-macos-arm64.dmg",
    sha256: "663ce944257c61ff1d6aa09e15c8f57bbd8d59023adb2fa7edde33a9ed960b53",
    size: 311910354,
  },
  "linux/x64": {
    filename: "blender-4.5.13-linux-x64.tar.xz",
    sha256: "da4e69b06b75b9e642d106496c50e7e240218b411d2f6e18271c1d1d819cef91",
    size: 378033952,
  },
};
const SOURCE = {
  filename: "blender-4.5.13.tar.xz",
  url: "https://download.blender.org/source/blender-4.5.13.tar.xz",
  checksumUrl: "https://download.blender.org/source/blender-4.5.13.tar.xz.md5sum",
  // The official source archive publishes MD5, not a SHA-256 manifest. Record both honestly.
  md5: "ff006e90a288fc82cee21578372bc034",
  size: 85105684,
};
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function platformDistribution(platform, arch) {
  const distribution = DISTRIBUTIONS[`${platform}/${arch}`];
  if (!distribution)
    throw new Error(
      `Blender ${BLENDER_VERSION} 没有可用的官方便携发行包：${platform}/${arch}。构建已停止。`,
    );
  return {
    ...distribution,
    platform,
    arch,
    url: BASE_URL + distribution.filename,
    executable:
      platform === "win32"
        ? "runtime/blender.exe"
        : platform === "darwin"
          ? "runtime/Blender.app/Contents/MacOS/Blender"
          : "runtime/blender",
  };
}

function contained(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

function safeBundlePath(root, relative) {
  if (
    typeof relative !== "string" ||
    relative.includes("\\") ||
    path.posix.isAbsolute(relative) ||
    /^[a-z]:/i.test(relative)
  ) {
    throw new Error("运行时清单包含无效路径");
  }
  const candidate = path.resolve(root, relative);
  if (!contained(root, candidate)) throw new Error("运行时清单路径越界");
  return candidate;
}

export function assertArchiveEntries(listing) {
  const entries = listing.split(/\r?\n/).filter(Boolean);
  if (!entries.length) throw new Error("Blender 归档为空");
  for (const name of entries) {
    const normalized = name.replaceAll("\\", "/");
    if (
      normalized.startsWith("/") ||
      /^[a-z]:/i.test(normalized) ||
      normalized.split("/").includes("..")
    ) {
      throw new Error(`Blender 归档包含越界路径：${name}`);
    }
  }
}

export async function fileDigest(filename, algorithm = "sha256") {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

export async function verifyArchive(filename, metadata) {
  const info = await stat(filename);
  if (!info.isFile() || info.size !== metadata.size)
    throw new Error(`Blender 归档大小不匹配：${filename}`);
  const algorithm = metadata.sha256 ? "sha256" : "md5";
  const digest = await fileDigest(filename, algorithm);
  if (digest !== metadata[algorithm])
    throw new Error(`Blender 归档 ${algorithm.toUpperCase()} 校验失败：${filename}`);
}

export async function snapshotFiles(root) {
  const files = [];
  const rootReal = await realpath(root);
  async function walk(directory, prefix = "") {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name, "en"),
    );
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (relative === "manifest.json" || relative === "files-manifest.json") continue;
      const full = safeBundlePath(root, relative);
      const info = await lstat(full);
      if (info.isSymbolicLink()) {
        const target = await readlink(full);
        if (path.isAbsolute(target) || !contained(rootReal, await realpath(full)))
          throw new Error(`运行时符号链接指向包外：${relative}`);
        files.push({ path: relative, type: "symlink", target });
      } else if (info.isDirectory()) {
        await walk(full, relative);
      } else if (info.isFile()) {
        files.push({
          path: relative,
          type: "file",
          size: info.size,
          mode: info.mode & 0o777,
          sha256: await fileDigest(full),
        });
      } else {
        throw new Error(`运行时包含不支持的文件类型：${relative}`);
      }
    }
  }
  await walk(root);
  return files;
}

export async function verifyManifestFiles(root, expected) {
  if (!Array.isArray(expected) || !expected.length) throw new Error("运行时内容清单为空");
  const names = new Set();
  for (const entry of expected) {
    safeBundlePath(root, entry.path);
    if (names.has(entry.path)) throw new Error("运行时清单存在重复路径");
    names.add(entry.path);
  }
  const actual = await snapshotFiles(root);
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error("运行时文件缺失、增加、权限变化或内容校验失败");
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${path.basename(executable)} 执行失败：${result.error?.message ?? result.stderr?.trim() ?? result.status}`,
    );
  }
  return result.stdout ?? "";
}

function probeVersion(root, distribution) {
  const executable = safeBundlePath(root, distribution.executable);
  const versionText = run(executable, ["--version"], { timeout: 60_000 });
  if (!new RegExp(`^Blender ${BLENDER_VERSION.replaceAll(".", "\\.")}\\b`, "m").test(versionText)) {
    throw new Error(`内置 Blender 版本不匹配：${versionText.split(/\r?\n/)[0]}`);
  }
  return versionText.split(/\r?\n/)[0];
}

async function verifyLayout(root, distribution) {
  const base =
    distribution.platform === "darwin" ? "runtime/Blender.app/Contents/Resources" : "runtime";
  const text = distribution.platform === "darwin" ? `${base}/text` : base;
  const required = [
    distribution.executable,
    `${base}/4.5/scripts/modules/bpy/__init__.py`,
    `${text}/copyright.txt`,
    `${text}/license/license.md`,
    `${text}/license/spdx/GPL-3.0-or-later.txt`,
  ];
  if (distribution.platform === "win32") {
    required.push(
      "runtime/blender.crt/blender.crt.manifest",
      "runtime/blender.crt/vcruntime140.dll",
      "runtime/blender.shared/blender.shared.manifest",
      "runtime/python311.dll",
      "runtime/4.5/python/bin/python.exe",
    );
  } else {
    required.push(`${base}/4.5/python/bin/python3.11`);
  }
  for (const name of required) {
    const info = await stat(safeBundlePath(root, name));
    if (!info.isFile() || info.size === 0)
      throw new Error(`Blender 完整运行时缺少关键文件：${name}`);
  }
  for (const name of [
    `${base}/4.5/datafiles`,
    distribution.platform === "win32" ? "runtime/blender.shared" : `${base}/lib`,
  ]) {
    if (!(await readdir(safeBundlePath(root, name))).length)
      throw new Error(`Blender 运行时目录为空：${name}`);
  }
}

// download.blender.org 对无 UA 的大文件请求与数据中心出口 IP 会限流/拒绝
// （CircleCI 上实测 HTTP 403，家庭宽带无 UA 亦 206）；下载统一带浏览器 UA 并
// 对 403/网络错误退避重试，避免一次限流把整条构建链打挂。
const DOWNLOAD_USER_AGENT =
  "Mozilla/5.0 (compatible; infinite-canvas/0.1; +https://github.com/HeartHurt-code-y/infinite-canvas)";

async function cachedDownload(cache, metadata, override) {
  if (override) {
    const supplied = path.resolve(override);
    await verifyArchive(supplied, metadata);
    console.log(`[blender:prepare] 已验证本地归档：${path.basename(supplied)}`);
    return supplied;
  }
  const filename = path.join(cache, metadata.filename);
  if (existsSync(filename)) {
    try {
      await verifyArchive(filename, metadata);
      return filename;
    } catch {
      console.log(`[blender:prepare] 缓存归档损坏，将重新下载：${metadata.filename}`);
    }
  }
  console.log(
    `[blender:prepare] 下载 ${metadata.url} (${(metadata.size / 1024 / 1024).toFixed(1)} MiB)`,
  );
  const temporary = path.join(cache, `${metadata.filename}.${randomUUID()}.part`);
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(metadata.url, {
        signal: AbortSignal.timeout(15 * 60_000),
        headers: {
          "user-agent": DOWNLOAD_USER_AGENT,
          accept: "application/octet-stream,*/*",
        },
      });
      if (!response.ok || !response.body)
        throw new Error(`下载 Blender 失败：HTTP ${response.status}`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: "wx" }));
      await verifyArchive(temporary, metadata);
      await rename(temporary, filename);
      return filename;
    } catch (error) {
      lastError = error;
      await rm(temporary, { force: true }).catch(() => {});
      if (attempt < 3) {
        const delay = 2 ** attempt * 1000;
        console.log(
          `[blender:prepare] 下载失败（第 ${attempt} 次）：${error.message}，${delay / 1000}s 后重试`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

async function unpackRuntime(archive, stage, distribution) {
  const extracted = path.join(stage, ".extract");
  const runtime = path.join(stage, "runtime");
  await mkdir(extracted);
  if (distribution.platform === "darwin") {
    const mount = path.join(extracted, "mount");
    await mkdir(mount);
    run("/usr/bin/hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mount, archive]);
    try {
      await mkdir(runtime);
      run("/usr/bin/ditto", [
        "--rsrc",
        "--extattr",
        path.join(mount, "Blender.app"),
        path.join(runtime, "Blender.app"),
      ]);
    } finally {
      run("/usr/bin/hdiutil", ["detach", mount]);
    }
  } else {
    // Native tar avoids the PowerShell/native filesystem visibility issue seen in this host.
    const tar =
      distribution.platform === "win32"
        ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
        : "tar";
    assertArchiveEntries(run(tar, ["-tf", archive]));
    run(tar, ["-xf", archive, "-C", extracted], { timeout: 10 * 60_000 });
    const folderName = distribution.filename.replace(/\.(zip|tar\.xz)$/, "");
    const officialRoot = path.join(extracted, folderName);
    if (!(await stat(officialRoot)).isDirectory()) throw new Error("Blender 归档缺少官方顶层目录");
    await rename(officialRoot, runtime);
  }
  // This is only our newly allocated staging directory, never an existing user install.
  await rm(extracted, { recursive: true, force: true });
}

async function writeSources(stage, projectRoot, sourceArchive, distribution) {
  const sources = path.join(stage, "sources");
  await mkdir(sources);
  await copyFile(sourceArchive, path.join(sources, SOURCE.filename));
  await copyFile(
    path.join(projectRoot, "tools/blender/white_model.py"),
    path.join(sources, "white_model.py"),
  );
  await copyFile(
    path.join(projectRoot, "tools/blender/LICENSE"),
    path.join(sources, "white_model.LICENSE.txt"),
  );
  const sha256 = await fileDigest(sourceArchive);
  const sourceInfo = {
    archive: `sources/${SOURCE.filename}`,
    url: SOURCE.url,
    checksumUrl: SOURCE.checksumUrl,
    md5: SOURCE.md5,
    sha256,
    size: SOURCE.size,
  };
  const licensePath =
    distribution.platform === "darwin"
      ? "runtime/Blender.app/Contents/Resources/text/license"
      : "runtime/license";
  await writeFile(
    path.join(stage, "SOURCE.txt"),
    [
      `This application redistributes the unmodified official Blender ${BLENDER_VERSION} binary distribution.`,
      "Blender and its bundled libraries retain their upstream copyright notices and licenses.",
      `Official license information: https://www.blender.org/about/license/`,
      `Bundled license directory: ${licensePath}`,
      `Official binary: ${distribution.url}`,
      `Official binary SHA-256 manifest: ${CHECKSUM_URL}`,
      `Binary SHA-256: ${distribution.sha256}`,
      `Included matching Blender source archive: sources/${SOURCE.filename}`,
      `Official source: ${SOURCE.url}`,
      `Official source MD5: ${SOURCE.md5} (${SOURCE.checksumUrl})`,
      `Locally computed source SHA-256: ${sha256}`,
      "The included source archive contains Blender's build files, dependency download URLs/checksums, and source license notices.",
      `Dependency source information is also identified in ${licensePath}/license.md.`,
      "The application uses the original binary without modifications; no Blender patches are applied.",
      "Fixed Blender bridge source: sources/white_model.py; license: sources/white_model.LICENSE.txt (GPL-3.0-or-later).",
      "That bridge license applies to the bridge script; this notice does not change the license of other application files.",
      "Keep this source archive and all upstream license notices with the binary distribution.",
      "",
    ].join("\n"),
  );
  return sourceInfo;
}

function assertNativeTarget(environment, platform, arch) {
  const target = environment.CARGO_BUILD_TARGET ?? environment.TAURI_ENV_TARGET_TRIPLE;
  if (!target) return;
  const targetPlatform = target.includes("windows")
    ? "win32"
    : target.includes("apple-darwin")
      ? "darwin"
      : target.includes("linux")
        ? "linux"
        : null;
  const targetArch = target.startsWith("aarch64-")
    ? "arm64"
    : target.startsWith("x86_64-")
      ? "x64"
      : null;
  if (platform !== targetPlatform || arch !== targetArch)
    throw new Error(
      `Blender 运行时需要在目标平台原生执行验证，不能将 ${platform}/${arch} 的包用于 ${target}`,
    );
}

export async function prepareBlender({
  projectRoot = PROJECT_ROOT,
  environment = process.env,
  force = process.argv.includes("--force"),
} = {}) {
  const distribution = platformDistribution(process.platform, process.arch);
  assertNativeTarget(environment, process.platform, process.arch);
  const destination = path.join(projectRoot, "src-tauri/resources/blender");
  const cache = path.join(
    projectRoot,
    "node_modules/.cache/infinite-canvas/blender",
    BLENDER_VERSION,
  );
  await mkdir(cache, { recursive: true });
  const fingerprint = createHash("sha256");
  for (const filename of [
    fileURLToPath(import.meta.url),
    path.join(projectRoot, "tools/blender/white_model.py"),
    path.join(projectRoot, "tools/blender/LICENSE"),
  ])
    fingerprint.update(await readFile(filename));
  fingerprint.update(JSON.stringify(distribution));
  const buildFingerprint = fingerprint.digest("hex");
  if (!force) {
    try {
      const manifest = JSON.parse(await readFile(path.join(destination, "manifest.json"), "utf8"));
      if (
        manifest.schemaVersion !== 1 ||
        manifest.fingerprint !== buildFingerprint ||
        manifest.version !== BLENDER_VERSION ||
        manifest.platform !== distribution.platform ||
        manifest.arch !== distribution.arch ||
        manifest.executable !== distribution.executable ||
        manifest.archive?.sha256 !== distribution.sha256 ||
        manifest.sources?.md5 !== SOURCE.md5
      )
        throw new Error("运行时版本或构建清单已变化");
      await verifyLayout(destination, distribution);
      if (manifest.inventory?.path !== "files-manifest.json")
        throw new Error("缺少完整运行时内容清单");
      const inventoryPath = safeBundlePath(destination, manifest.inventory.path);
      if ((await fileDigest(inventoryPath)) !== manifest.inventory.sha256)
        throw new Error("运行时内容清单校验失败");
      const files = JSON.parse(await readFile(inventoryPath, "utf8"));
      await verifyManifestFiles(destination, files);
      probeVersion(destination, distribution);
      console.log(
        `[blender:prepare] 完整内置引擎已校验：${BLENDER_VERSION} ${distribution.platform}/${distribution.arch}, ${files.length} 个文件/链接`,
      );
      return manifest;
    } catch (error) {
      console.log(`[blender:prepare] 重新准备内置引擎：${error.message}`);
    }
  }
  const archive = await cachedDownload(cache, distribution, environment.BLENDER_ARCHIVE_PATH);
  const sourceArchive = await cachedDownload(
    cache,
    SOURCE,
    environment.BLENDER_SOURCE_ARCHIVE_PATH,
  );
  const stage = path.join(cache, `stage-${randomUUID()}`);
  await mkdir(stage);
  await unpackRuntime(archive, stage, distribution);
  await verifyLayout(stage, distribution);
  const versionText = probeVersion(stage, distribution);
  const sources = await writeSources(stage, projectRoot, sourceArchive, distribution);
  const files = await snapshotFiles(stage);
  const totalBytes = files.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
  const inventoryPath = path.join(stage, "files-manifest.json");
  await writeFile(inventoryPath, JSON.stringify(files, null, 2) + "\n");
  const manifest = {
    schemaVersion: 1,
    version: BLENDER_VERSION,
    platform: distribution.platform,
    arch: distribution.arch,
    executable: distribution.executable,
    fingerprint: buildFingerprint,
    versionText,
    archive: {
      filename: distribution.filename,
      url: distribution.url,
      checksumUrl: CHECKSUM_URL,
      sha256: distribution.sha256,
      size: distribution.size,
    },
    sources,
    totalBytes,
    inventory: {
      path: "files-manifest.json",
      sha256: await fileDigest(inventoryPath),
      count: files.length,
    },
  };
  await writeFile(path.join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  await mkdir(path.dirname(destination), { recursive: true });
  const previous = path.join(cache, `previous-${randomUUID()}`);
  const hadPrevious = existsSync(destination);
  if (hadPrevious) await rename(destination, previous);
  let published = false;
  try {
    await rename(stage, destination);
    published = true;
    probeVersion(destination, distribution);
  } catch (error) {
    try {
      if (published) await rename(destination, stage);
      if (hadPrevious) await rename(previous, destination);
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        `Blender 准备失败且旧包恢复失败；原包保留于 ${previous}`,
      );
    }
    throw error;
  }
  if (hadPrevious) await rm(previous, { recursive: true, force: true });
  console.log(
    `[blender:prepare] 已内置 ${versionText}：${files.length} 个文件/链接，总计 ${(totalBytes / 1024 / 1024).toFixed(1)} MiB（含对应源码）`,
  );
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await prepareBlender();
}
