// The optional component catalog is independent of the existing signed v1 delta protocol.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, readlink, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { tosUpdatesPublicBaseUrl } from "./tos-updates-config.mjs";

export const COMPONENT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export function componentPlatform(platform = process.platform, arch = process.arch) {
  if (platform === "win32" && arch === "x64") return "windows-x86_64";
  if (platform === "darwin" && arch === "arm64") return "darwin-aarch64";
  if (platform === "darwin" && arch === "x64") return "darwin-x86_64";
  return null;
}
export const COMPONENT_PLATFORM = componentPlatform();
const COMPONENT_PLATFORMS = new Set(["windows-x86_64", "darwin-aarch64", "darwin-x86_64"]);
const execFileAsync = promisify(execFile);
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
  const identity = componentPlatform(platform, arch);
  const targets =
    platform === "win32"
      ? ["x86_64-pc-windows-msvc", "x86_64-pc-windows-gnu"]
      : [arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin"];
  if (!identity || (target && !targets.includes(target)))
    throw new Error(
      "Optional component ZIP/catalog requires native Windows x86_64 or macOS arm64/x64; cross-compilation and universal targets are not supported.",
    );
  return identity;
}

function pathIsContained(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

export function componentSymlinkTargetIsValid(relative, target) {
  if (
    !componentPathIsValid(relative) ||
    typeof target !== "string" ||
    target.length === 0 ||
    Buffer.byteLength(target) > 1024 ||
    /[\\:\x00-\x1f<>"|?*]/.test(target) ||
    path.posix.isAbsolute(target) ||
    target.split("/").some((part) => part === "")
  )
    return false;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relative), target));
  return resolved !== ".." && !resolved.startsWith("../") && componentPathIsValid(resolved);
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

export async function inventoryComponentFiles(
  root,
  { workspaceRoot, platform = process.platform } = {},
) {
  const absolute = await assertComponentRoot(root, workspaceRoot);
  const canonicalRoot = await realpath(absolute);
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
      if (info.isSymbolicLink()) {
        if (platform !== "darwin")
          throw new Error(`Component ZIP cannot contain a symlink or junction: ${relative}`);
        const target = await readlink(filename);
        if (!componentSymlinkTargetIsValid(relative, target))
          throw new Error(`Unsafe component symlink target: ${relative}`);
        let resolved;
        try {
          resolved = await realpath(filename);
        } catch {
          throw new Error(`Component symlink is dangling or cyclic: ${relative}`);
        }
        if (!pathIsContained(canonicalRoot, resolved))
          throw new Error(`Component symlink resolves outside root: ${relative}`);
        const targetInfo = await stat(filename);
        if (
          (!targetInfo.isDirectory() && !targetInfo.isFile()) ||
          (targetInfo.isDirectory() &&
            pathIsContained(resolved, await realpath(path.dirname(filename))))
        )
          throw new Error(`Component symlink target is special or cyclic: ${relative}`);
        const bytes = Buffer.from(target, "utf8");
        entries.push({
          path: relative,
          type: "symlink",
          target,
          size: bytes.length,
          sha256: componentBytesSha256(bytes),
          mode: 0o755,
        });
      } else if (info.isDirectory()) await visit(filename, relative);
      else if (info.isFile()) {
        if (relative === ".complete.json") continue;
        entries.push({
          path: relative,
          size: info.size,
          sha256: await componentFileSha256(filename),
          mode:
            platform === "darwin"
              ? info.mode & 0o777
              : /\.(exe|cmd|bat)$/i.test(name)
                ? 0o755
                : 0o644,
        });
      } else throw new Error(`Component ZIP cannot contain a special file: ${relative}`);
    }
  }
  await visit(absolute, "");
  for (const entry of entries.filter((candidate) => candidate.type === "symlink")) {
    const destination = path
      .relative(canonicalRoot, await realpath(path.join(absolute, entry.path)))
      .split(path.sep)
      .join("/");
    if (
      !entries.some(
        (candidate) =>
          candidate.path === destination || candidate.path.startsWith(`${destination}/`),
      )
    )
      throw new Error(`Component symlink target is absent from archive: ${entry.path}`);
  }
  return entries.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

export async function describeRuntimeComponent(
  definition,
  { root = COMPONENT_REPO_ROOT, platform = process.platform, arch = process.arch } = {},
) {
  assertComponentPlatform(platform, arch);
  const directory = path.resolve(root, definition.sourcePath);
  const files = await inventoryComponentFiles(directory, { workspaceRoot: root, platform });
  const manifestEntry = files.find((entry) => entry.path === definition.manifestPath);
  if (!manifestEntry || manifestEntry.type === "symlink")
    throw new Error(`Missing ${definition.id} manifest: ${definition.manifestPath}`);
  const manifest = JSON.parse(
    await readFile(path.join(directory, definition.manifestPath), "utf8"),
  );
  const requiresNativeIdentity = [
    "blender",
    "ai-media-runtime",
    "ai-media-quality-runtime",
  ].includes(definition.id);
  if ((requiresNativeIdentity || manifest.platform !== undefined) && manifest.platform !== platform)
    throw new Error(`Prepared component platform mismatch: ${definition.id}`);
  if ((requiresNativeIdentity || manifest.arch !== undefined) && manifest.arch !== arch)
    throw new Error(`Prepared component architecture mismatch: ${definition.id}`);
  if (manifest.inventory) {
    if (manifest.inventory.path !== "files-manifest.json")
      throw new Error(`Unexpected native inventory path: ${definition.id}`);
    const inventoryEntry = files.find((entry) => entry.path === "files-manifest.json");
    if (
      !inventoryEntry ||
      inventoryEntry.type === "symlink" ||
      inventoryEntry.sha256 !== manifest.inventory.sha256
    )
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
      const matches =
        current?.type === "symlink"
          ? entry.type === "symlink" && entry.target === current.target
          : (!entry.type || entry.type === "file") &&
            current?.size === (aiInventory ? entry.bytes : entry.size) &&
            current?.sha256 === entry.sha256 &&
            (platform !== "darwin" || entry.mode === undefined || entry.mode === current?.mode);
      if (!current || seen.has(entry.path) || !matches)
        throw new Error(`Native inventory entry mismatch: ${definition.id}/${entry.path}`);
      seen.add(entry.path);
    }
  }
  const actualFiles = new Map(files.map((entry) => [entry.path, entry]));
  if (definition.id === "remotion-runtime") {
    const binaries = [platform === "win32" ? "node.exe" : "node", manifest.browserExecutable];
    for (const binary of binaries) {
      const current = actualFiles.get(binary);
      if (
        !componentPathIsValid(binary) ||
        !current ||
        current.type === "symlink" ||
        !manifest.criticalSha256?.[binary] ||
        current.sha256 !== manifest.criticalSha256[binary] ||
        (platform === "darwin" && !(current.mode & 0o111))
      )
        throw new Error(`Native Remotion executable checksum or permission mismatch: ${binary}`);
    }
  }
  if (definition.id === "ffmpeg") {
    for (const binary of ["ffmpeg", "ffprobe"]) {
      const current = actualFiles.get(`${binary}${platform === "win32" ? ".exe" : ""}`);
      if (
        platform === "darwin" &&
        binary === "ffprobe" &&
        manifest.ffprobeUnavailable === true &&
        manifest.ffprobeSha256 === null &&
        !current
      )
        continue;
      if (
        !current ||
        current.type === "symlink" ||
        current.sha256 !== manifest[`${binary}Sha256`] ||
        (platform === "darwin" && !(current.mode & 0o111))
      )
        throw new Error(`Native FFmpeg checksum mismatch: ${binary}`);
    }
    if (
      platform === "win32" &&
      (manifest.license?.spdx !== "GPL-3.0-or-later" ||
        manifest.license.path !== "COPYING.GPLv3" ||
        actualFiles.get("COPYING.GPLv3")?.sha256 !== manifest.license.sha256 ||
        !actualFiles.has("SOURCE.txt") ||
        !actualFiles.has("LICENSE-NOTICE.txt"))
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

// Native preparation manifests predate platform fields for FFmpeg and Remotion.
// Verify their actual Mach-O architecture before packaging on a real macOS host.
export async function validateMacRuntimeComponent(
  definition,
  { root = COMPONENT_REPO_ROOT, arch = process.arch, run = execFileAsync } = {},
) {
  assertComponentPlatform("darwin", arch);
  const directory = await assertComponentRoot(path.resolve(root, definition.sourcePath), root);
  const manifest = JSON.parse(
    await readFile(path.join(directory, definition.manifestPath), "utf8"),
  );
  const binaries =
    definition.id === "blender"
      ? [manifest.executable]
      : definition.id === "remotion-runtime"
        ? ["node", manifest.browserExecutable]
        : definition.id === "ffmpeg"
          ? ["ffmpeg", ...(manifest.ffprobeUnavailable === true ? [] : ["ffprobe"])]
          : ["ai-media-runtime", "ai-media-quality-runtime"].includes(definition.id)
            ? [manifest.pythonPath]
            : [];
  const expectedArch = arch === "arm64" ? "arm64" : "x86_64";
  for (const relative of binaries) {
    if (!componentPathIsValid(relative))
      throw new Error(`Unsafe native macOS executable path: ${definition.id}`);
    const filename = path.join(directory, relative);
    if (!pathIsContained(await realpath(directory), await realpath(filename)))
      throw new Error(`Native macOS executable resolves outside component: ${relative}`);
    const result = await run("/usr/bin/lipo", ["-archs", filename]);
    if (!result.stdout.trim().split(/\s+/).includes(expectedArch))
      throw new Error(
        `Native macOS executable architecture mismatch: ${definition.id}/${relative}`,
      );
    try {
      await run("/usr/bin/codesign", ["--verify", "--strict", filename]);
    } catch (error) {
      if (
        definition.id === "ffmpeg" ||
        !String(error.stderr).includes("code object is not signed at all")
      )
        throw error;
    }
  }
  if (definition.id === "blender")
    await run("/usr/bin/codesign", [
      "--verify",
      "--deep",
      "--strict",
      path.join(directory, "runtime/Blender.app"),
    ]);
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
    !COMPONENT_PLATFORMS.has(platform)
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
  if (!COMPONENT_PLATFORMS.has(platform)) throw new Error("Unsupported component catalog platform");
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
