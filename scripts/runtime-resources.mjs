// Shared helpers for the runtime resources that ship inside the installer
// (currently the FFmpeg engine prepared by scripts/prepare-ffmpeg.mjs).
// These helpers only deal with paths, hashes and file inventories; the
// on-demand "feature component" catalog no longer exists.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readlink, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const COMPONENT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export function componentPlatform(platform = process.platform, arch = process.arch) {
  if (platform === "win32" && arch === "x64") return "windows-x86_64";
  if (platform === "darwin" && arch === "arm64") return "darwin-aarch64";
  if (platform === "darwin" && arch === "x64") return "darwin-x86_64";
  return null;
}
export const COMPONENT_PLATFORM = componentPlatform();

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
      "Bundled runtime resources require a native build: this release requires native Windows x86_64 or macOS arm64/x64; cross-compilation and universal targets are not supported.",
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
