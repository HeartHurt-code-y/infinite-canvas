// The optional component catalog is independent of the existing signed v1 delta protocol.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tosUpdatesPublicBaseUrl } from "./tos-updates-config.mjs";

export const COMPONENT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const COMPONENT_PLATFORM = "windows-x86_64";
export const COMPONENT_CATALOG_RESOURCE = "src-tauri/resources/component-catalog.json";
export const RUNTIME_COMPONENTS = Object.freeze([
  {
    id: "blender",
    title: "白模渲染组件",
    description: "Blender 白模场景与镜头渲染",
    sourcePath: "src-tauri/resources/blender",
    manifestPath: "manifest.json",
    bundlePath: "blender",
    dependencies: ["ffmpeg"],
  },
  {
    id: "remotion-runtime",
    title: "动画与网页解析组件",
    description: "动画渲染及抖音、小红书网页解析",
    sourcePath: "src-tauri/resources/remotion-runtime",
    manifestPath: "runtime-manifest.json",
    bundlePath: "remotion-runtime",
    dependencies: [],
  },
  {
    id: "ffmpeg",
    title: "媒体处理组件",
    description: "视频剪辑、抽帧、音频与格式处理",
    sourcePath: "src-tauri/resources/ffmpeg",
    manifestPath: "manifest.json",
    bundlePath: "ffmpeg",
    dependencies: [],
  },
  {
    id: "pose-runtime",
    title: "动作捕捉组件",
    description: "MediaPipe 姿态识别 WASM 与模型",
    sourcePath: "src-tauri/resources/pose-runtime",
    manifestPath: "runtime-manifest.json",
    bundlePath: "pose-runtime",
    dependencies: [],
  },
  {
    id: "gpt-image-2-style-library",
    title: "图片风格库",
    description: "图片风格参考与原图素材",
    sourcePath: "src-tauri/skills/gpt-image-2-style-library",
    manifestPath: "data/manifest.json",
    bundlePath: "skills/gpt-image-2-style-library",
    dependencies: [],
  },
  {
    id: "ai-media-runtime",
    title: "AI 媒体轻量组件",
    description: "本地深度、音频分离与媒体分析",
    sourcePath: "src-tauri/resources/ai-media-runtime",
    manifestPath: "runtime-manifest.json",
    bundlePath: "ai-media-runtime",
    dependencies: ["ffmpeg"],
  },
  {
    id: "ai-media-quality-runtime",
    title: "AI 媒体质量组件",
    description: "本地高质量深度与音频分离模型",
    sourcePath: "src-tauri/resources/ai-media-quality-runtime",
    manifestPath: "runtime-manifest.json",
    bundlePath: "ai-media-quality-runtime",
    dependencies: ["ffmpeg"],
  },
]);
export const COMPONENT_FEATURES = Object.freeze([
  { id: "white-model-render", title: "白模渲染", components: ["blender", "ffmpeg"] },
  { id: "motion-capture", title: "动作捕捉", components: ["pose-runtime"] },
  { id: "image-style-library", title: "图片风格库", components: ["gpt-image-2-style-library"] },
  { id: "animation-render", title: "动画渲染", components: ["remotion-runtime"] },
  { id: "browser-download", title: "网页视频解析", components: ["remotion-runtime"] },
  { id: "media-processing", title: "媒体处理", components: ["ffmpeg"] },
  { id: "ai-media-lite", title: "AI 媒体轻量功能", components: ["ai-media-runtime", "ffmpeg"] },
  {
    id: "ai-media-quality",
    title: "AI 媒体质量功能",
    components: ["ai-media-quality-runtime", "ffmpeg"],
  },
]);

export function componentPathIsValid(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value) > 1024 ||
    /[\\:\x00-\x1f<>"|?*]/.test(value)
  )
    return false;
  const segments = value.split("/");
  return (
    segments.length <= 32 &&
    segments.every(
      (segment) =>
        segment !== "" &&
        segment !== "." &&
        segment !== ".." &&
        !/[. ]$/.test(segment) &&
        !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment),
    )
  );
}

export function componentBytesSha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
export async function componentFileSha256(filename) {
  const digest = createHash("sha256");
  for await (const bytes of createReadStream(filename)) digest.update(bytes);
  return digest.digest("hex");
}

export function assertComponentPlatform(
  platform = process.platform,
  arch = process.arch,
  target = process.env.TAURI_ENV_TARGET_TRIPLE,
) {
  if (
    platform !== "win32" ||
    arch !== "x64" ||
    (target && target !== "x86_64-pc-windows-msvc" && target !== "x86_64-pc-windows-gnu")
  )
    throw new Error(
      "Optional component ZIP/catalog and online edition currently support only native Windows x86_64; use the existing full build on macOS.",
    );
}

export async function assertComponentRoot(root, workspaceRoot) {
  const absolute = path.resolve(root);
  if (workspaceRoot) {
    const relative = path.relative(path.resolve(workspaceRoot), absolute);
    if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative))
      throw new Error(`Component root is outside workspace: ${root}`);
    let cursor = path.resolve(workspaceRoot);
    for (const segment of ["", ...relative.split(path.sep).filter(Boolean)]) {
      if (segment) cursor = path.join(cursor, segment);
      const info = await lstat(cursor);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error(`Component ancestor must be a materialized directory: ${cursor}`);
    }
    const actualRelative = path.relative(await realpath(workspaceRoot), await realpath(absolute));
    if (
      actualRelative.startsWith(`..${path.sep}`) ||
      actualRelative === ".." ||
      path.isAbsolute(actualRelative)
    )
      throw new Error(`Component root resolves outside workspace: ${root}`);
  } else {
    const info = await lstat(absolute);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error(`Component root must be a materialized directory: ${root}`);
  }
  return absolute;
}

export async function inventoryComponentFiles(root, { workspaceRoot } = {}) {
  const absolute = await assertComponentRoot(root, workspaceRoot);
  const entries = [];
  const keys = new Set();
  async function visit(directory, prefix) {
    for (const name of (await readdir(directory)).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name;
      if (!componentPathIsValid(relative)) throw new Error(`Unsafe component path: ${relative}`);
      const key = relative.toLowerCase();
      if (keys.has(key)) throw new Error(`Case-colliding component path: ${relative}`);
      keys.add(key);
      const filename = path.join(directory, name);
      const info = await lstat(filename);
      if (info.isSymbolicLink())
        throw new Error(`Component ZIP cannot contain a symlink or junction: ${relative}`);
      if (info.isDirectory()) await visit(filename, relative);
      else if (info.isFile()) {
        if (relative === ".complete.json") continue;
        entries.push({
          path: relative,
          size: info.size,
          sha256: await componentFileSha256(filename),
          mode: /\.(exe|cmd|bat)$/i.test(name) ? 0o755 : 0o644,
        });
      } else throw new Error(`Component ZIP cannot contain a special file: ${relative}`);
    }
  }
  await visit(absolute, "");
  return entries.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

export async function describeRuntimeComponent(definition, { root = COMPONENT_REPO_ROOT } = {}) {
  const directory = path.resolve(root, definition.sourcePath);
  const files = await inventoryComponentFiles(directory, { workspaceRoot: root });
  const manifestEntry = files.find((entry) => entry.path === definition.manifestPath);
  if (!manifestEntry)
    throw new Error(`Missing ${definition.id} manifest: ${definition.manifestPath}`);
  const manifest = JSON.parse(
    await readFile(path.join(directory, definition.manifestPath), "utf8"),
  );
  if (manifest.platform && manifest.platform !== "win32")
    throw new Error(`Cannot catalog non-Windows prepared component: ${definition.id}`);
  if (manifest.arch && manifest.arch !== "x64")
    throw new Error(`Cannot catalog non-x86_64 prepared component: ${definition.id}`);
  if (manifest.inventory) {
    if (manifest.inventory.path !== "files-manifest.json")
      throw new Error(`Unexpected native inventory path: ${definition.id}`);
    const inventoryEntry = files.find((entry) => entry.path === "files-manifest.json");
    if (!inventoryEntry || inventoryEntry.sha256 !== manifest.inventory.sha256)
      throw new Error(`Native inventory hash mismatch: ${definition.id}`);
    const recorded = JSON.parse(
      await readFile(path.join(directory, "files-manifest.json"), "utf8"),
    );
    const payload = files.filter(
      (entry) => entry.path !== definition.manifestPath && entry.path !== "files-manifest.json",
    );
    if (
      !Array.isArray(recorded) ||
      recorded.length !== manifest.inventory.count ||
      recorded.length !== payload.length
    )
      throw new Error(`Native inventory count mismatch: ${definition.id}`);
    const actual = new Map(payload.map((entry) => [entry.path, entry]));
    const seen = new Set();
    const aiInventory = ["ai-media-runtime", "ai-media-quality-runtime"].includes(definition.id);
    for (const entry of recorded) {
      const current = actual.get(entry.path);
      if (
        !current ||
        seen.has(entry.path) ||
        (entry.type && entry.type !== "file") ||
        current.size !== (aiInventory ? entry.bytes : entry.size) ||
        current.sha256 !== entry.sha256
      )
        throw new Error(`Native inventory entry mismatch: ${definition.id}/${entry.path}`);
      seen.add(entry.path);
    }
  }
  const actualFiles = new Map(files.map((entry) => [entry.path, entry]));
  if (definition.id === "ffmpeg") {
    for (const binary of ["ffmpeg", "ffprobe"])
      if (actualFiles.get(`${binary}.exe`)?.sha256 !== manifest[`${binary}Sha256`])
        throw new Error(`Native FFmpeg checksum mismatch: ${binary}`);
    if (
      manifest.license?.spdx !== "GPL-3.0-or-later" ||
      manifest.license.path !== "COPYING.GPLv3" ||
      actualFiles.get("COPYING.GPLv3")?.sha256 !== manifest.license.sha256 ||
      !actualFiles.has("SOURCE.txt") ||
      !actualFiles.has("LICENSE-NOTICE.txt")
    )
      throw new Error(
        "Windows FFmpeg component requires its verified license and source notices; run ffmpeg:prepare",
      );
  }
  if (definition.id === "gpt-image-2-style-library") {
    if (!Array.isArray(manifest.files))
      throw new Error("Style library manifest has no asset inventory");
    const seen = new Set();
    for (const entry of manifest.files) {
      const actual = actualFiles.get(entry.path);
      if (
        seen.has(entry.path) ||
        !actual ||
        actual.size !== entry.bytes ||
        actual.sha256 !== entry.sha256
      )
        throw new Error(`Style library asset mismatch: ${entry.path}`);
      seen.add(entry.path);
    }
  }
  const version = String(
    manifest.remotionVersion ??
      manifest.runtimeVersion ??
      manifest.runtime?.version ??
      manifest.sourceCommit ??
      manifest.version ??
      "1",
  );
  return {
    id: definition.id,
    title: definition.title,
    description: definition.description,
    version,
    manifestPath: definition.manifestPath,
    manifestSha256: manifestEntry.sha256,
    bundlePath: definition.bundlePath,
    dependencies: [...definition.dependencies],
    files,
  };
}

export function runtimeComponentArchiveUrl(
  id,
  sha256,
  { applicationVersion, platform = COMPONENT_PLATFORM, publicBaseUrl = tosUpdatesPublicBaseUrl() },
) {
  if (
    !/^[a-z0-9-]+$/.test(id) ||
    !/^[a-f0-9]{64}$/.test(sha256) ||
    !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(applicationVersion) ||
    platform !== COMPONENT_PLATFORM
  )
    throw new Error("Invalid component archive identity");
  const base = new URL(publicBaseUrl);
  const trusted = new URL(tosUpdatesPublicBaseUrl());
  if (
    base.protocol !== "https:" ||
    base.host !== trusted.host ||
    base.pathname.replace(/\/$/, "") !== trusted.pathname ||
    base.search ||
    base.hash ||
    base.username ||
    base.password
  )
    throw new Error("Component archive URLs must use the trusted updater host and prefix");
  return `${publicBaseUrl.replace(/\/$/, "")}/components/${platform}/${applicationVersion}/${id}-${sha256}.zip`;
}

export function buildRuntimeComponentCatalog({
  applicationVersion,
  components,
  platform = COMPONENT_PLATFORM,
}) {
  if (platform !== COMPONENT_PLATFORM)
    throw new Error("Component catalog currently supports only windows-x86_64");
  if (
    components.length !== RUNTIME_COMPONENTS.length ||
    new Set(components.map((component) => component.id)).size !== RUNTIME_COMPONENTS.length ||
    !RUNTIME_COMPONENTS.every(({ id }) => components.some((component) => component.id === id))
  )
    throw new Error("Catalog must contain each of the seven runtime components exactly once");
  return {
    schemaVersion: 1,
    applicationVersion,
    platform,
    components,
    features: COMPONENT_FEATURES.map((feature) => ({
      ...feature,
      components: [...feature.components],
    })),
  };
}
