// Build a signed-manifest input for a macOS app-tree delta. The release process
// signs manifest.json with the same Minisign key as the full Tauri updater.
// This is deliberately a tree manifest, not a reconstructed .app.tar.gz: the
// installed app does not retain the original tar/gzip headers or entry order.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readlink,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { tosUpdatesPublicBaseUrl } from "./tos-updates-config.mjs";

export const MAC_DELTA_PLATFORM = "darwin-aarch64";
export const MAC_DELTA_OBJECT_BASE_URL = `${tosUpdatesPublicBaseUrl()}/mac-delta/objects/`;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 200_000;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024 * 1024;
const VERSION = /^\d+\.\d+\.\d+$/;

function laterVersion(base, target) {
  if (!VERSION.test(base ?? "") || !VERSION.test(target ?? "")) return false;
  const old = base.split(".").map(Number);
  const next = target.split(".").map(Number);
  if ([...old, ...next].some((part) => !Number.isSafeInteger(part))) return false;
  for (let i = 0; i < 3; i += 1) {
    if (next[i] !== old[i]) return next[i] > old[i];
  }
  return false;
}

function contained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function assertPath(relative) {
  if (
    typeof relative !== "string" ||
    relative.length === 0 ||
    Buffer.byteLength(relative, "utf8") > 1024 ||
    relative.includes("\\") ||
    relative.includes(":") ||
    /[\x00-\x1f]/.test(relative)
  ) {
    throw new Error(`macOS 差分清单路径无效：${relative}`);
  }
  const segments = relative.split("/");
  if (
    segments.length > 32 ||
    segments.some((part) => !part || part === "." || part === ".." || part.endsWith(" "))
  ) {
    throw new Error(`macOS 差分清单路径无效：${relative}`);
  }
}

function assertSymlink(root, linkPath, linkTarget) {
  if (
    path.isAbsolute(linkTarget) ||
    Buffer.byteLength(linkTarget, "utf8") > 1024 ||
    linkTarget.includes("\\") ||
    linkTarget.includes(":") ||
    /[\x00-\x1f]/.test(linkTarget)
  ) {
    throw new Error(`macOS 差分清单符号链接不可信：${linkPath}`);
  }
  const resolved = path.resolve(path.dirname(linkPath), linkTarget);
  if (!contained(root, resolved) || resolved === root) {
    throw new Error(`macOS 差分清单符号链接越界：${linkPath}`);
  }
}

async function hashFile(filePath) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) digest.update(chunk);
  return digest.digest("hex");
}

function comparePaths(left, right) {
  return Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8"));
}

/** Reject a malformed release before it reaches the signed feed or client. */
export function validateMacDeltaManifest(manifest) {
  if (
    manifest == null ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    manifest.schemaVersion !== 1 ||
    !laterVersion(manifest.baseVersion, manifest.version) ||
    manifest.platform !== MAC_DELTA_PLATFORM ||
    manifest.appName !== "无限画布.app" ||
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0 ||
    manifest.files.length > MAX_ENTRIES ||
    Object.keys(manifest).sort().join(",") !==
      "appName,baseVersion,files,objectBaseUrl,platform,schemaVersion,version"
  ) {
    throw new Error("macOS 差分清单结构或版本无效");
  }
  let baseUrl;
  try {
    baseUrl = new URL(manifest.objectBaseUrl);
  } catch {
    throw new Error("macOS 差分对象地址无效");
  }
  if (
    baseUrl.protocol !== "https:" ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash ||
    !baseUrl.pathname.endsWith("/") ||
    baseUrl.href !== manifest.objectBaseUrl ||
    manifest.objectBaseUrl !== MAC_DELTA_OBJECT_BASE_URL
  ) {
    throw new Error("macOS 差分对象地址无效");
  }
  const byPath = new Map();
  const normalized = new Set();
  let previous = null;
  let totalBytes = 0;
  for (const entry of manifest.files) {
    if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("macOS 差分清单条目无效");
    }
    assertPath(entry.path);
    if (previous && comparePaths(previous, entry) >= 0) {
      throw new Error("macOS 差分清单路径未排序或重复");
    }
    previous = entry;
    const folded = entry.path.normalize("NFC").toLowerCase();
    if (normalized.has(folded)) throw new Error("macOS 差分清单路径大小写或 Unicode 冲突");
    normalized.add(folded);
    byPath.set(entry.path, entry);
    if (entry.kind === "dir") {
      if (
        !Number.isInteger(entry.mode) ||
        entry.mode < 0 ||
        entry.mode > 0o777 ||
        Object.keys(entry).sort().join(",") !== "kind,mode,path"
      ) {
        throw new Error(`macOS 差分目录条目无效：${entry.path}`);
      }
    } else if (entry.kind === "file") {
      if (
        !Number.isSafeInteger(entry.size) ||
        entry.size < 0 ||
        entry.size > MAX_FILE_BYTES ||
        !/^[a-f0-9]{64}$/.test(entry.sha256 ?? "") ||
        !Number.isInteger(entry.mode) ||
        entry.mode < 0 ||
        entry.mode > 0o777 ||
        !["base", "object"].includes(entry.source) ||
        Object.keys(entry).sort().join(",") !== "kind,mode,path,sha256,size,source"
      ) {
        throw new Error(`macOS 差分文件条目无效：${entry.path}`);
      }
      totalBytes += entry.size;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_TOTAL_BYTES) {
        throw new Error("macOS 差分清单文件总量过大");
      }
    } else if (entry.kind === "symlink") {
      if (
        typeof entry.target !== "string" ||
        entry.target === "" ||
        Buffer.byteLength(entry.target, "utf8") > 1024 ||
        path.posix.isAbsolute(entry.target) ||
        entry.target.includes("\\") ||
        entry.target.includes(":") ||
        /[\x00-\x1f]/.test(entry.target) ||
        Object.keys(entry).sort().join(",") !== "kind,path,target"
      ) {
        throw new Error(`macOS 差分符号链接无效：${entry.path}`);
      }
      const resolved = path.posix.normalize(
        path.posix.join(path.posix.dirname(entry.path), entry.target),
      );
      if (resolved === "." || resolved === ".." || resolved.startsWith("../")) {
        throw new Error(`macOS 差分符号链接越界：${entry.path}`);
      }
    } else {
      throw new Error(`macOS 差分文件类型无效：${entry.path}`);
    }
  }
  if (byPath.get("Contents")?.kind !== "dir") {
    throw new Error("macOS 差分清单缺少 Contents 目录");
  }
  for (const entry of manifest.files) {
    const parent = path.posix.dirname(entry.path);
    if (parent !== "." && byPath.get(parent)?.kind !== "dir") {
      throw new Error(`macOS 差分清单父目录缺失：${entry.path}`);
    }
  }
  // A link can point through another link. Check the final target, not just
  // the first hop, so a signed manifest cannot create a dangling/cyclic tree.
  function resolveLink(pathValue) {
    let current = pathValue;
    const followed = new Set();
    for (;;) {
      const parts = current.split("/");
      let prefix = "";
      let expanded = false;
      for (let index = 0; index < parts.length; index += 1) {
        prefix = prefix ? `${prefix}/${parts[index]}` : parts[index];
        const node = byPath.get(prefix);
        if (!node) throw new Error(`macOS 差分符号链接目标缺失：${prefix}`);
        if (node.kind === "symlink") {
          if (followed.has(prefix)) throw new Error(`macOS 差分符号链接成环：${prefix}`);
          followed.add(prefix);
          const rest = parts.slice(index + 1);
          const next = path.posix.normalize(
            path.posix.join(path.posix.dirname(prefix), node.target, ...rest),
          );
          if (next === "." || next === ".." || next.startsWith("../")) {
            throw new Error(`macOS 差分符号链接越界：${prefix}`);
          }
          current = next;
          expanded = true;
          break;
        }
        if (index < parts.length - 1 && node.kind !== "dir") {
          throw new Error(`macOS 差分符号链接穿过非目录：${prefix}`);
        }
      }
      if (!expanded) return;
    }
  }
  for (const entry of manifest.files) {
    if (entry.kind === "symlink") resolveLink(entry.path);
  }
  return manifest;
}

/** Inventory every filesystem entry below a signed .app, including empty dirs. */
export async function inventoryMacApp(appDir) {
  const root = path.resolve(appDir);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || !root.endsWith(".app")) {
    throw new Error(`macOS 差分输入必须是实体 .app 目录：${root}`);
  }
  const canonicalRoot = await realpath(root);
  const entries = [];
  const names = new Set();
  async function visit(directory, relativeDirectory) {
    for (const name of await readdir(directory)) {
      const relative = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      assertPath(relative);
      const normalized = relative.normalize("NFC").toLowerCase();
      if (names.has(normalized))
        throw new Error(`macOS 差分清单路径大小写或 Unicode 冲突：${relative}`);
      names.add(normalized);
      const absolute = path.join(directory, name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        const target = await readlink(absolute);
        assertSymlink(root, absolute, target);
        const resolved = await realpath(absolute);
        if (!contained(canonicalRoot, resolved)) {
          throw new Error(`macOS 差分清单符号链接越界：${relative}`);
        }
        entries.push({ path: relative, kind: "symlink", target });
      } else if (info.isDirectory()) {
        entries.push({ path: relative, kind: "dir", mode: info.mode & 0o7777 });
        await visit(absolute, relative);
      } else if (info.isFile()) {
        entries.push({
          path: relative,
          kind: "file",
          size: info.size,
          sha256: await hashFile(absolute),
          mode: info.mode & 0o7777,
        });
      } else {
        throw new Error(`macOS 差分清单不支持的文件类型：${relative}`);
      }
      if (entries.length > MAX_ENTRIES) throw new Error("macOS 差分清单条目过多");
    }
  }
  await visit(root, "");
  entries.sort(comparePaths);
  return entries;
}

/**
 * Stage changed content-addressed objects and the full target-tree manifest.
 * The caller must Minisign-sign the returned manifestPath before publication.
 *
 * A `base` entry is safe to copy only after the client verifies its old-app
 * bytes and mode. A missing/corrupt base entry must trigger full-update fallback.
 */
export async function stageMacDelta({
  baseAppDir,
  targetAppDir,
  baseVersion,
  version,
  outDir,
  objectBaseUrl = MAC_DELTA_OBJECT_BASE_URL,
}) {
  if (!laterVersion(baseVersion, version)) {
    throw new Error("macOS 差分需要较新的目标版本和有效的基线版本");
  }
  if (!baseAppDir || !targetAppDir || !outDir) throw new Error("macOS 差分输入目录不完整");
  const base = path.resolve(baseAppDir);
  const target = path.resolve(targetAppDir);
  const output = path.resolve(outDir);
  if (contained(base, output) || contained(target, output)) {
    throw new Error("macOS 差分暂存目录不能位于输入 .app 内");
  }
  if (path.basename(base) !== path.basename(target)) {
    throw new Error("macOS 差分基线和目标 .app 名称不一致");
  }
  if (path.basename(target) !== "无限画布.app") {
    throw new Error("macOS 差分目标 .app 名称不匹配产品");
  }
  const baseUrl = new URL(objectBaseUrl);
  if (
    baseUrl.protocol !== "https:" ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash ||
    !baseUrl.pathname.endsWith("/") ||
    baseUrl.href !== MAC_DELTA_OBJECT_BASE_URL
  ) {
    throw new Error("macOS 差分对象地址必须是无鉴权的 HTTPS 目录");
  }
  const [baseFiles, targetFiles] = await Promise.all([
    inventoryMacApp(base),
    inventoryMacApp(target),
  ]);
  const baseByPath = new Map(baseFiles.map((entry) => [entry.path, entry]));
  const files = targetFiles.map((entry) => {
    if (entry.kind !== "file") return entry;
    const old = baseByPath.get(entry.path);
    const source =
      old?.kind === "file" &&
      old.sha256 === entry.sha256 &&
      old.size === entry.size &&
      old.mode === entry.mode
        ? "base"
        : "object";
    return { ...entry, source };
  });
  const manifest = {
    schemaVersion: 1,
    baseVersion,
    version,
    platform: MAC_DELTA_PLATFORM,
    appName: path.basename(target),
    objectBaseUrl: baseUrl.href,
    files,
  };
  validateMacDeltaManifest(manifest);
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  if (bytes.length > MAX_MANIFEST_BYTES) throw new Error("macOS 差分清单超过 16 MiB");
  await mkdir(output, { recursive: true });
  if ((await readdir(output)).length !== 0)
    throw new Error(`macOS 差分暂存目录必须为空：${output}`);
  const objectDir = path.join(output, "objects");
  await mkdir(objectDir);
  let changedBytes = 0;
  const seen = new Set();
  for (const file of files) {
    if (file.kind !== "file" || file.source !== "object" || seen.has(file.sha256)) continue;
    seen.add(file.sha256);
    const object = path.join(objectDir, file.sha256);
    await copyFile(path.join(target, ...file.path.split("/")), object);
    const copied = await stat(object);
    if (copied.size !== file.size || (await hashFile(object)) !== file.sha256) {
      throw new Error(`macOS 差分对象校验失败：${file.path}`);
    }
    changedBytes += file.size;
  }
  const manifestPath = path.join(output, "manifest.json");
  await writeFile(manifestPath, bytes, { flag: "wx" });
  return { manifestPath, objectDir, manifest, changedBytes };
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  try {
    const [baseAppDir, targetAppDir, baseVersion, version, outDir] = process.argv.slice(2);
    const result = await stageMacDelta({ baseAppDir, targetAppDir, baseVersion, version, outDir });
    console.log(
      `[mac-delta] 已暂存 ${result.manifestPath}；对象字节 ${result.changedBytes}；尚未签名或发布`,
    );
  } catch (error) {
    console.error(`[mac-delta] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
