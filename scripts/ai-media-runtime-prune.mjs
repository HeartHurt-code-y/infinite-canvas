// Distribution-only pruning. Inference uses prebuilt DLLs/shared libraries; the
// application never builds CPython or Torch C/C++ extensions in its runtime.
import { lstat, readdir, realpath, unlink } from "node:fs/promises";
import path from "node:path";

export const AI_MEDIA_PRUNING_POLICY = "inference-development-files-v1";

// Keep this allowlist narrow. In particular, preserve Python sources (including
// tests), models, package metadata, licences and all dynamic/runtime libraries.
export function aiMediaDevelopmentArtifact(relative) {
  if (typeof relative !== "string" || relative.includes("\\") || relative.includes(":"))
    return false;
  if (relative.split("/").some((part) => part === "" || part === "." || part === ".."))
    return false;
  const name = relative.toLowerCase();
  if (name.split("/").some((part) => /license|licence|copying|notice|copyright/.test(part)))
    return false;
  if (/^python\/libs\/[^/]+\.(lib|a)$/.test(name)) return true;
  const packages = /^python\/(?:lib\/python\d+\.\d+|lib)\/site-packages\//;
  const packagePath = name.replace(packages, "");
  if (packagePath !== name && /^torch\/lib\/[^/]+\.(lib|a)$/.test(packagePath)) return true;
  if (!/\.(h|hpp|hxx|cuh)$/.test(name)) return false;
  return (
    name.startsWith("python/include/") ||
    (packagePath !== name &&
      (packagePath.startsWith("torch/include/") ||
        /^numpy\/(?:core|_core)\/include\//.test(packagePath)))
  );
}

function contained(root, filename) {
  const relative = path.relative(root, filename);
  return (
    relative !== "" &&
    !path.isAbsolute(relative) &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`)
  );
}

export async function planAiMediaRuntimePruning(directory) {
  const absolute = path.resolve(directory);
  if (!(await lstat(absolute)).isDirectory() || (await lstat(absolute)).isSymbolicLink())
    throw new Error("AI 组件精简目录必须是实际目录");
  const root = await realpath(absolute);
  const files = [];
  async function walk(relative = "") {
    for (const name of (await readdir(path.join(root, relative))).sort()) {
      const child = relative ? `${relative}/${name}` : name;
      const filename = path.join(root, child);
      const info = await lstat(filename);
      if (info.isSymbolicLink() || !contained(root, await realpath(filename)))
        throw new Error(`AI 组件精简不能跟随链接或越界路径: ${child}`);
      if (info.isDirectory()) await walk(child);
      else if (info.isFile() && aiMediaDevelopmentArtifact(child))
        files.push({ path: child, bytes: info.size });
    }
  }
  await walk();
  return {
    root,
    policyVersion: AI_MEDIA_PRUNING_POLICY,
    removedFiles: files.length,
    removedBytes: files.reduce((total, file) => total + file.bytes, 0),
    files,
  };
}

export async function pruneAiMediaRuntime(directory) {
  const plan = await planAiMediaRuntimePruning(directory);
  for (const file of plan.files) {
    const filename = path.join(plan.root, file.path);
    // Recheck each target immediately before unlinking; never recursively delete
    // a guessed directory or traverse a junction supplied by the source tree.
    const info = await lstat(filename);
    if (
      !aiMediaDevelopmentArtifact(file.path) ||
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size !== file.bytes ||
      !contained(plan.root, await realpath(filename))
    )
      throw new Error(`AI 组件精简文件发生变化或路径不可信: ${file.path}`);
    await unlink(filename);
  }
  return {
    policyVersion: plan.policyVersion,
    removedFiles: plan.removedFiles,
    removedBytes: plan.removedBytes,
  };
}
