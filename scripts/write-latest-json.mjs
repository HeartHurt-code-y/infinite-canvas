// 把本次构建出的 updater 产物收成 Tauri 读取的 latest.json。
//
// 清单必须和安装包一起放到**客户能匿名访问的 HTTPS**。私有 GitHub 仓库的
// Releases 默认不够：安装包里的检查请求带不上你的登录态。
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tosUpdatesPublicBaseUrl } from "./tos-updates-config.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
export const DEFAULT_BUNDLE_DIR = path.join(REPO_ROOT, "src-tauri", "target", "release", "bundle");
export const DEFAULT_TAURI_CONF = path.join(REPO_ROOT, "src-tauri", "tauri.conf.json");

const ARCH_FROM_FILENAME = [
  [/(?:^|[_-])(aarch64|arm64)(?:[_-]|$)/i, "aarch64"],
  [/(?:^|[_-])(x86_64|x64)(?:[_-]|$)/i, "x86_64"],
  [/(?:^|[_-])(i686|x86)(?:[_-]|$)/i, "i686"],
];

/**
 * @param {string} fileName
 * @param {string | null | undefined} fallbackPlatform
 */
export function detectPlatformFromArtifact(fileName, fallbackPlatform) {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".app.tar.gz")) {
    return withArch("darwin", fileName, fallbackPlatform);
  }
  if (lower.endsWith("-setup.exe") || lower.endsWith("-setup.nsis.exe")) {
    return withArch("windows", fileName, fallbackPlatform);
  }
  if (lower.endsWith(".appimage")) {
    return withArch("linux", fileName, fallbackPlatform);
  }
  return null;
}

/**
 * @param {string} os
 * @param {string} fileName
 * @param {string | null | undefined} fallbackPlatform
 */
function withArch(os, fileName, fallbackPlatform) {
  for (const [pattern, arch] of ARCH_FROM_FILENAME) {
    if (pattern.test(fileName)) return `${os}-${arch}`;
  }
  if (typeof fallbackPlatform === "string" && fallbackPlatform.startsWith(`${os}-`)) {
    return fallbackPlatform;
  }
  return `${os}-${defaultArch()}`;
}

export function defaultArch() {
  if (process.arch === "arm64") return "aarch64";
  if (process.arch === "ia32") return "i686";
  return "x86_64";
}

export function defaultPlatform() {
  if (process.platform === "darwin") return `darwin-${defaultArch()}`;
  if (process.platform === "win32") return `windows-${defaultArch()}`;
  return `linux-${defaultArch()}`;
}

/**
 * @param {string} dir
 * @returns {string[]}
 */
export function listFilesRecursive(dir) {
  if (!existsSync(dir)) return [];
  /** @type {string[]} */
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) files.push(...listFilesRecursive(full));
    else files.push(full);
  }
  return files;
}

/**
 * @param {string} bundleDir
 * @param {{ fallbackPlatform?: string, baseUrl: string, version?: string }} options
 */
export function collectUpdaterPlatforms(bundleDir, options) {
  /** @type {Record<string, { url: string, signature: string }>} */
  const platforms = {};
  const files = listFilesRecursive(bundleDir);
  for (const filePath of files) {
    const fileName = path.basename(filePath);
    if (fileName.endsWith(".sig")) continue;
    const platform = detectPlatformFromArtifact(fileName, options.fallbackPlatform);
    if (platform === null) continue;
    if (options.version && !fileName.includes(`_${options.version}_`)) {
      throw new Error(`发现无版本号或非本版 updater 产物：${filePath}`);
    }
    if (platforms[platform]) {
      throw new Error(`同一平台存在多个 updater 产物（${platform}）：请只传入本次发布的产物目录`);
    }
    const signaturePath = `${filePath}.sig`;
    if (!existsSync(signaturePath)) {
      throw new Error(`缺少签名文件：${signaturePath}`);
    }
    const signature = readFileSync(signaturePath, "utf8").trim();
    if (signature === "") throw new Error(`签名文件为空：${signaturePath}`);
    platforms[platform] = {
      url: joinDownloadUrl(options.baseUrl, fileName),
      signature,
    };
  }
  return platforms;
}

/**
 * @param {string} baseUrl
 * @param {string} fileName
 */
export function joinDownloadUrl(baseUrl, fileName) {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return `${trimmed}/${encodeURIComponent(fileName)}`;
}

/**
 * @param {unknown} existing
 * @param {Record<string, { url: string, signature: string }>} incoming
 * @param {string} version
 */
export function mergeLatestManifest(existing, incoming, version) {
  const current =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? /** @type {Record<string, unknown>} */ (existing)
      : {};
  const currentPlatforms =
    current.version === version &&
    current.platforms &&
    typeof current.platforms === "object" &&
    !Array.isArray(current.platforms)
      ? /** @type {Record<string, unknown>} */ (current.platforms)
      : {};
  return {
    ...current,
    platforms: {
      ...currentPlatforms,
      ...incoming,
    },
  };
}

/**
 * @param {{
 *   version: string,
 *   notes?: string,
 *   pubDate?: string,
 *   platforms: Record<string, { url: string, signature: string }>,
 * }} input
 */
export function buildLatestManifest(input) {
  return {
    version: input.version,
    notes: input.notes ?? "",
    pub_date: input.pubDate ?? new Date().toISOString(),
    platforms: input.platforms,
  };
}

export function readAppVersion(confPath = DEFAULT_TAURI_CONF) {
  const parsed = JSON.parse(readFileSync(confPath, "utf8"));
  if (typeof parsed.version !== "string" || parsed.version.trim() === "") {
    throw new Error(`无法从 ${confPath} 读取 version`);
  }
  return parsed.version;
}

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || !token.startsWith("--")) {
      throw new Error(`未知参数：${token ?? ""}`);
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      options[key] = true;
      continue;
    }
    options[key] = next;
    index += 1;
  }
  return options;
}

export function writeLatestJson(options) {
  const bundleDir =
    typeof options["bundle-dir"] === "string" ? options["bundle-dir"] : DEFAULT_BUNDLE_DIR;
  const baseUrl =
    typeof options["base-url"] === "string" && options["base-url"].trim() !== ""
      ? options["base-url"]
      : tosUpdatesPublicBaseUrl();
  const out = typeof options.out === "string" ? options.out : path.join(bundleDir, "latest.json");
  const version = typeof options.version === "string" ? options.version : readAppVersion();
  const notes = typeof options.notes === "string" ? options.notes : "";
  const fallbackPlatform =
    typeof options.platform === "string" ? options.platform : defaultPlatform();
  const incoming = collectUpdaterPlatforms(bundleDir, { baseUrl, fallbackPlatform, version });
  if (Object.keys(incoming).length === 0) {
    throw new Error(
      `在 ${bundleDir} 里没有找到 updater 产物（.app.tar.gz / NSIS -setup.exe / AppImage）`,
    );
  }
  const existing =
    options["merge-same-version"] === true && existsSync(out)
      ? JSON.parse(readFileSync(out, "utf8"))
      : {};
  const merged = mergeLatestManifest(existing, incoming, version);
  const manifest = buildLatestManifest({
    version,
    notes,
    pubDate: typeof options["pub-date"] === "string" ? options["pub-date"] : undefined,
    platforms: /** @type {Record<string, { url: string, signature: string }>} */ (merged.platforms),
  });
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
  return { out, manifest };
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const result = writeLatestJson(parsed);
  console.log(`[update-manifest] 已写入 ${result.out}`);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  try {
    await main();
  } catch (error) {
    console.error(`[update-manifest] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
