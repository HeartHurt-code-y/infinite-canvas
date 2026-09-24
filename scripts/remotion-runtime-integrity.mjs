import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export function remotionCriticalPaths(nodeName, browserExecutable) {
  return [nodeName, browserExecutable, "render.mjs", "plan.mjs", "bundle/index.html"];
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

export async function hashRemotionCriticalFiles(root, nodeName, browserExecutable) {
  /** @type {Record<string, string>} */
  const hashes = {};
  for (const relativePath of remotionCriticalPaths(nodeName, browserExecutable)) {
    hashes[relativePath] = await sha256File(path.join(root, relativePath));
  }
  return hashes;
}

export async function remotionCriticalFilesMatch(root, nodeName, browserExecutable, expected) {
  if (!expected || typeof expected !== "object") return false;
  try {
    const actual = await hashRemotionCriticalFiles(root, nodeName, browserExecutable);
    return Object.entries(actual).every(([name, hash]) => expected[name] === hash);
  } catch {
    return false;
  }
}

const INVENTORY_FILE = "files-manifest.json";
const OMIT_FROM_INVENTORY = new Set([INVENTORY_FILE, "runtime-manifest.json"]);

function insideRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function comparePath(left, right) {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

/**
 * Build the logical installed tree, including every path reached through an
 * internal pnpm junction. The installer/copy step materializes those aliases
 * as ordinary directories, so the manifest must describe both paths.
 */
export async function buildRemotionFileInventory(root) {
  const canonicalRoot = await realpath(root);
  /** @type {Array<{path:string,type:"file",size:number,sha256:string}>} */
  const files = [];
  /** @type {Array<{logicalPath:string,physicalPath:string}>} */
  const pending = [];
  const activeDirectories = new Set();

  async function visit(directory, logicalDirectory) {
    const canonicalDirectory = await realpath(directory);
    if (!insideRoot(canonicalRoot, canonicalDirectory)) {
      throw new Error(`Remotion 运行时链接越出根目录：${logicalDirectory || "."}`);
    }
    if (activeDirectories.has(canonicalDirectory)) {
      throw new Error(`Remotion 运行时目录链接形成循环：${logicalDirectory || "."}`);
    }
    activeDirectories.add(canonicalDirectory);
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
      for (const entry of entries) {
        const logicalPath = logicalDirectory ? `${logicalDirectory}/${entry.name}` : entry.name;
        if (OMIT_FROM_INVENTORY.has(logicalPath)) continue;
        const physicalPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(physicalPath, logicalPath);
        } else if (entry.isFile()) {
          pending.push({ logicalPath, physicalPath });
        } else if (entry.isSymbolicLink()) {
          const target = await realpath(physicalPath);
          if (!insideRoot(canonicalRoot, target)) {
            throw new Error(`Remotion 运行时链接越出根目录：${logicalPath}`);
          }
          const targetStat = await stat(physicalPath);
          if (targetStat.isDirectory()) await visit(physicalPath, logicalPath);
          else if (targetStat.isFile()) pending.push({ logicalPath, physicalPath });
          else throw new Error(`Remotion 运行时含不支持的链接：${logicalPath}`);
        } else {
          throw new Error(`Remotion 运行时含不支持的文件类型：${logicalPath}`);
        }
      }
    } finally {
      activeDirectories.delete(canonicalDirectory);
    }
  }

  await visit(root, "");
  const hashes = new Map();
  let next = 0;
  async function hashNext() {
    while (next < pending.length) {
      const item = pending[next++];
      const canonicalFile = await realpath(item.physicalPath);
      if (!insideRoot(canonicalRoot, canonicalFile)) {
        throw new Error(`Remotion 运行时链接越出根目录：${item.logicalPath}`);
      }
      let result = hashes.get(canonicalFile);
      if (!result) {
        result = (async () => ({
          size: (await stat(item.physicalPath)).size,
          sha256: await sha256File(item.physicalPath),
        }))();
        hashes.set(canonicalFile, result);
      }
      files.push({ path: item.logicalPath, type: "file", ...(await result) });
    }
  }
  await Promise.all(Array.from({ length: Math.min(12, pending.length) }, () => hashNext()));
  files.sort(comparePath);
  return files;
}

export async function writeRemotionFileInventory(root) {
  const files = await buildRemotionFileInventory(root);
  const bytes = Buffer.from(`${JSON.stringify(files, null, 2)}\n`);
  await writeFile(path.join(root, INVENTORY_FILE), bytes);
  return {
    path: INVENTORY_FILE,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    count: files.length,
  };
}

export async function remotionInventoryManifestMatches(root, expected) {
  if (
    expected?.path !== INVENTORY_FILE ||
    !/^[0-9a-f]{64}$/.test(expected.sha256 ?? "") ||
    !Number.isSafeInteger(expected.count)
  ) {
    return false;
  }
  try {
    const bytes = await readFile(path.join(root, INVENTORY_FILE));
    if (createHash("sha256").update(bytes).digest("hex") !== expected.sha256) return false;
    const entries = JSON.parse(bytes.toString("utf8"));
    return Array.isArray(entries) && entries.length === expected.count;
  } catch {
    return false;
  }
}

export async function remotionInventoryFilesMatch(root, expected) {
  if (!(await remotionInventoryManifestMatches(root, expected))) return false;
  try {
    const recorded = await readFile(path.join(root, INVENTORY_FILE), "utf8");
    const current = `${JSON.stringify(await buildRemotionFileInventory(root), null, 2)}\n`;
    return recorded === current;
  } catch {
    return false;
  }
}

export async function remotionTreeIsMaterialized(root) {
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) return false;
      if (entry.isDirectory() && !(await visit(path.join(directory, entry.name)))) return false;
    }
    return true;
  }
  try {
    return await visit(root);
  } catch {
    return false;
  }
}

/**
 * Tauri's resource enumerator ignores Windows junction entries. Prepare an
 * ordinary directory tree with every logical file before handing it to NSIS.
 */
export async function materializeRemotionRuntime(root, expectedInventory) {
  if (!(await remotionInventoryFilesMatch(root, expectedInventory))) {
    throw new Error("Remotion 清单与源文件不一致，不能物化安装资源");
  }
  if (await remotionTreeIsMaterialized(root)) return;
  const parent = path.dirname(root);
  const base = path.basename(root);
  const staging = await mkdtemp(path.join(parent, `.${base}-materialize-`));
  const backup = path.join(parent, `.${base}-previous-${randomUUID()}`);
  function assertOwnedTemporary(candidate) {
    if (
      path.dirname(path.resolve(candidate)) !== path.resolve(parent) ||
      !path.basename(candidate).startsWith(`.${base}-`)
    ) {
      throw new Error("Remotion 临时目录越出资源父目录");
    }
  }
  assertOwnedTemporary(staging);
  assertOwnedTemporary(backup);
  let renamedOriginal = false;
  try {
    const entries = await buildRemotionFileInventory(root);
    let next = 0;
    async function copyNext() {
      while (next < entries.length) {
        const entry = entries[next++];
        const destination = path.join(staging, ...entry.path.split("/"));
        await mkdir(path.dirname(destination), { recursive: true });
        await copyFile(path.join(root, ...entry.path.split("/")), destination);
      }
    }
    await Promise.all(Array.from({ length: Math.min(12, entries.length) }, () => copyNext()));
    await copyFile(path.join(root, INVENTORY_FILE), path.join(staging, INVENTORY_FILE));
    await copyFile(
      path.join(root, "runtime-manifest.json"),
      path.join(staging, "runtime-manifest.json"),
    );
    if (
      !(await remotionInventoryFilesMatch(staging, expectedInventory)) ||
      !(await remotionTreeIsMaterialized(staging))
    ) {
      throw new Error("物化后的 Remotion 安装资源未通过完整清单校验");
    }
    await rename(root, backup);
    renamedOriginal = true;
    try {
      await rename(staging, root);
    } catch (error) {
      await rename(backup, root);
      renamedOriginal = false;
      throw error;
    }
    await rm(backup, { recursive: true, force: true });
    renamedOriginal = false;
  } finally {
    await rm(staging, { recursive: true, force: true });
    if (renamedOriginal) {
      // The replacement is already live. Leave an undeleted backup for repair.
      console.warn(`Remotion 旧资源未清理：${backup}`);
    }
  }
}
