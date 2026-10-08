import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

export const REMOTION_DISTRIBUTION_VERSION = "production-closure-v1";

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

async function digest(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

function dependencyNames(manifest) {
  return [
    ...new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]),
  ].sort();
}

async function resolvePackage(root, owner, name) {
  if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(name))
    throw new Error(`动画依赖名称无效：${name}`);
  // Search from the canonical owner, just as Node does without --preserve-symlinks.
  // Reading package.json directly also works when package exports hide that subpath.
  const canonicalOwner = await realpath(owner);
  const search = createRequire(path.join(canonicalOwner, "package.json")).resolve.paths(name) ?? [];
  for (const directory of search) {
    const candidate = path.join(directory, ...name.split("/"));
    if (!inside(root, candidate)) continue;
    try {
      await stat(path.join(candidate, "package.json"));
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") continue;
      throw error;
    }
    const canonical = await realpath(candidate);
    if (!inside(root, canonical)) throw new Error(`动画依赖链接越出运行时：${name}`);
    return canonical;
  }
  return null;
}

async function packagePayload(root, directory) {
  const files = [];
  const active = new Set();
  async function visit(current, relative = "") {
    const canonical = await realpath(current);
    if (!inside(root, canonical)) throw new Error("动画依赖文件链接越出运行时");
    if (active.has(canonical)) throw new Error("动画依赖文件链接形成循环");
    active.add(canonical);
    try {
      for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name, "en"),
      )) {
        // Each declared dependency is copied separately from its actual Node resolution.
        if (!relative && entry.name === "node_modules") continue;
        const filename = path.join(current, entry.name);
        const logical = relative ? `${relative}/${entry.name}` : entry.name;
        const resolved = await realpath(filename);
        if (!inside(root, resolved)) throw new Error("动画依赖文件链接越出运行时");
        const metadata = await stat(filename);
        if (metadata.isDirectory()) await visit(filename, logical);
        else if (metadata.isFile())
          files.push({
            path: logical,
            source: filename,
            size: metadata.size,
            sha256: await digest(filename),
          });
        else throw new Error("动画依赖包含不支持的文件类型");
      }
    } finally {
      active.delete(canonical);
    }
  }
  await visit(directory);
  const hash = createHash("sha256");
  for (const file of files) hash.update(JSON.stringify([file.path, file.size, file.sha256]));
  return { files, sha256: hash.digest("hex") };
}

class LayoutConflict extends Error {}

async function collectProductionGraph(root) {
  const rootManifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const packages = new Map();
  const nodes = new Map();
  const visited = new Set();
  const runtime = {
    directory: root,
    name: null,
    identity: "runtime",
    manifest: rootManifest,
    dependencies: [],
  };
  const queue = [runtime];
  while (queue.length) {
    const owner = queue.shift();
    if (visited.has(owner.directory)) continue;
    visited.add(owner.directory);
    const manifest =
      owner.manifest ??
      JSON.parse(await readFile(path.join(owner.directory, "package.json"), "utf8"));
    for (const name of dependencyNames(manifest)) {
      const directory = await resolvePackage(root, owner.directory, name);
      if (!directory) {
        if (
          Object.hasOwn(manifest.optionalDependencies ?? {}, name) ||
          manifest.peerDependenciesMeta?.[name]?.optional === true
        )
          continue;
        throw new Error(`动画生产依赖缺失：${owner.name ?? "runtime"} → ${name}`);
      }
      let dependency = nodes.get(directory);
      if (!dependency) {
        const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
        const payload = await packagePayload(root, directory);
        dependency = {
          name,
          directory,
          manifest,
          identity: `${manifest.name}@${manifest.version}:${payload.sha256}`,
          dependencies: [],
          ...payload,
        };
        nodes.set(directory, dependency);
      }
      if (!packages.has(name)) packages.set(name, dependency);
      owner.dependencies.push({ name, node: dependency });
      queue.push(dependency);
    }
  }
  const contexts = new Map();
  for (const node of [runtime, ...nodes.values()]) {
    const signature = JSON.stringify(
      node.dependencies.map(({ name, node }) => [name, node.identity]),
    );
    const previous = contexts.get(node.identity);
    // Equal package bytes with different peer/dependency resolutions cannot share a copy.
    // Preserve that uncommon layout rather than changing its runtime semantics.
    if (previous && previous !== signature)
      throw new LayoutConflict(`相同动画依赖存在不同解析上下文：${node.name}`);
    contexts.set(node.identity, signature);
  }
  return { packages, nodes, runtime, contexts };
}

async function removeIgnoredDependencies(root) {
  const modules = path.join(root, "node_modules");
  const removed = [];
  for (const entry of await readdir(modules, { withFileTypes: true })) {
    if (!entry.name.startsWith(".ignored_")) continue;
    const candidate = path.join(modules, entry.name);
    if (path.dirname(candidate) !== modules) throw new Error("动画旧依赖目录越界");
    // pnpm's .ignored_* directories are installer leftovers, never package names.
    await rm(candidate, { recursive: true, force: true });
    removed.push(`node_modules/${entry.name}`);
  }
  return removed;
}

/**
 * Produce an ordinary, self-contained production closure. Every package keeps
 * all of its own files, including licenses, native binaries and error maps.
 * Distinct versions/content get local nested copies. Equal package payloads
 * with conflicting resolution contexts keep the original layout instead.
 */
export async function optimizeRemotionDependencies(runtimeRoot) {
  const rootInfo = await lstat(runtimeRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    throw new Error("动画运行时根目录必须是实际目录，不能是链接");
  const root = await realpath(runtimeRoot);
  const modules = path.join(root, "node_modules");
  const modulesInfo = await lstat(modules);
  if (!modulesInfo.isDirectory() || modulesInfo.isSymbolicLink())
    throw new Error("动画依赖根目录必须是实际目录，不能是链接");
  let graph;
  try {
    graph = await collectProductionGraph(root);
  } catch (error) {
    if (!(error instanceof LayoutConflict)) throw error;
    return {
      version: REMOTION_DISTRIBUTION_VERSION,
      layout: "preserved",
      reason: error.message,
      removed: await removeIgnoredDependencies(root),
    };
  }
  const staging = path.join(root, `.node_modules-distribution-${randomUUID()}`);
  const stagedModules = path.join(staging, "node_modules");
  const backup = path.join(root, `.node_modules-previous-${randomUUID()}`);
  if (path.dirname(staging) !== root || path.dirname(backup) !== root)
    throw new Error("动画依赖临时目录越界");
  await mkdir(stagedModules, { recursive: true });
  await copyFile(path.join(root, "package.json"), path.join(staging, "package.json"));
  let replaced = false;
  try {
    const placements = new Map(
      [...graph.packages].map(([name, node]) => [
        path.join(stagedModules, ...name.split("/")),
        node,
      ]),
    );
    const queue = [
      { output: staging, node: graph.runtime },
      ...[...placements].map(([output, node]) => ({ output, node })),
    ];
    while (queue.length) {
      const owner = queue.shift();
      for (const { name, node } of owner.node.dependencies) {
        const search =
          createRequire(path.join(owner.output, "package.json")).resolve.paths(name) ?? [];
        const resolved = search
          .map((directory) => path.join(directory, ...name.split("/")))
          .find((candidate) => inside(staging, candidate) && placements.has(candidate));
        if (resolved && placements.get(resolved).identity === node.identity) continue;
        const target = path.join(owner.output, "node_modules", ...name.split("/"));
        if (placements.has(target)) throw new Error("动画依赖嵌套布局冲突");
        placements.set(target, node);
        queue.push({ output: target, node });
      }
    }
    for (const [output, item] of placements) {
      for (const file of item.files) {
        const target = path.join(output, ...file.path.split("/"));
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(file.source, target);
      }
      const copied = await packagePayload(root, output);
      if (copied.sha256 !== item.sha256) throw new Error(`动画依赖在复制时发生变化：${item.name}`);
    }
    // Re-resolve from each copied package; global/user module paths are excluded.
    const stagedGraph = await collectProductionGraph(staging);
    if (
      stagedGraph.contexts.size !== graph.contexts.size ||
      [...graph.contexts].some(
        ([identity, signature]) => stagedGraph.contexts.get(identity) !== signature,
      )
    )
      throw new LayoutConflict("精简布局不能保持动画依赖解析图");
    await rename(modules, backup);
    try {
      await rename(stagedModules, modules);
    } catch (error) {
      await rename(backup, modules);
      throw error;
    }
    replaced = true;
    await rm(backup, { recursive: true, force: true });
    return {
      version: REMOTION_DISTRIBUTION_VERSION,
      layout: placements.size === graph.packages.size ? "flat" : "nested",
      packages: graph.packages.size,
      copies: placements.size,
    };
  } catch (error) {
    if (!(error instanceof LayoutConflict) || replaced) throw error;
    return {
      version: REMOTION_DISTRIBUTION_VERSION,
      layout: "preserved",
      reason: error.message,
      removed: await removeIgnoredDependencies(root),
    };
  } finally {
    await rm(staging, { recursive: true, force: true });
    if (!replaced && (await lstat(backup).catch(() => null))) {
      throw new Error(`动画依赖迁移失败，旧依赖保留在 ${backup}`);
    }
  }
}
