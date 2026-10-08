// Produce a separately distributed offline component. Models never enter the main installer.
import { createReadStream, existsSync } from "node:fs";
import { readFile, lstat, readdir, realpath, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hash = async (filename) => {
  const digest = createHash("sha256");
  for await (const bytes of createReadStream(filename)) digest.update(bytes);
  return digest.digest("hex");
};

export async function inspectAiMediaPack(rootPath) {
  const root = await realpath(rootPath);
  const manifestPath = path.join(root, "runtime-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (
    !["lite", "quality"].includes(manifest.runtimeProfile) ||
    manifest.inventory?.path !== "files-manifest.json"
  )
    throw new Error("AI 组件清单无效。");
  const inventoryPath = path.join(root, "files-manifest.json");
  if ((await hash(inventoryPath)) !== manifest.inventory.sha256)
    throw new Error("AI 组件文件清单校验失败。");
  const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  if (!Array.isArray(inventory) || inventory.length !== manifest.inventory.count)
    throw new Error("AI 组件文件数量不匹配。");
  const expected = new Map();
  let totalBytes = 0;
  for (const entry of inventory) {
    if (
      entry.type !== "file" ||
      typeof entry.path !== "string" ||
      entry.path.includes("\\") ||
      entry.path.includes(":") ||
      entry.path.split("/").some((part) => !part || part === "." || part === "..") ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      expected.has(entry.path)
    )
      throw new Error("AI 组件含无效或重复路径。");
    const filename = path.join(root, entry.path);
    const info = await lstat(filename);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size !== entry.bytes ||
      (await hash(filename)) !== entry.sha256
    )
      throw new Error(`AI 组件文件校验失败：${entry.path}`);
    expected.set(entry.path, entry);
    totalBytes += info.size;
  }
  async function checkDirectory(directory, prefix = "") {
    for (const name of await readdir(directory)) {
      const relative = prefix + name;
      const filename = path.join(directory, name);
      const info = await lstat(filename);
      if (info.isSymbolicLink()) throw new Error("AI 组件含符号链接。");
      if (info.isDirectory()) await checkDirectory(filename, relative + "/");
      else if (
        !expected.has(relative) &&
        !["runtime-manifest.json", "files-manifest.json"].includes(relative)
      )
        throw new Error(`AI 组件含未登记文件：${relative}`);
    }
  }
  await checkDirectory(root);
  if (!expected.has(manifest.pythonPath)) throw new Error("AI 组件 Python 未登记。");
  return {
    root,
    manifest,
    manifestSha256: await hash(manifestPath),
    totalBytes,
    fileCount: inventory.length,
  };
}

export async function packageAiMedia(profile = "lite") {
  if (!["lite", "quality"].includes(profile)) throw new Error("profile 必须为 lite 或 quality");
  const directory = profile === "lite" ? "ai-media-runtime" : "ai-media-quality-runtime";
  const inspected = await inspectAiMediaPack(path.join(project, "src-tauri/resources", directory));
  if (inspected.manifest.runtimeProfile !== profile) throw new Error("AI 组件模式不匹配。");
  const destination = path.join(project, ".cache/ai-media/packages");
  await mkdir(destination, { recursive: true });
  const name = `infinite-canvas-ai-media-${profile}-${inspected.manifest.platform}-${inspected.manifest.arch}-${inspected.manifestSha256.slice(0, 12)}.zip`;
  const output = path.join(destination, name);
  if (existsSync(output)) throw new Error(`离线组件包已存在：${output}`);
  await new Promise((resolve, reject) => {
    const child = spawn(
      path.join(inspected.root, inspected.manifest.pythonPath),
      [
        "-I",
        "-B",
        "-X",
        "utf8",
        path.join(project, "scripts/ai-media/package_runtime.py"),
        "--root",
        inspected.root,
        "--output",
        output,
        "--manifest-sha256",
        inspected.manifestSha256,
      ],
      { windowsHide: true, stdio: "inherit" },
    );
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`打包 AI 组件失败：${code}`)),
    );
  });
  return { ...inspected, output };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const index = process.argv.indexOf("--profile");
  packageAiMedia(index >= 0 ? process.argv[index + 1] : "lite")
    .then(({ output, totalBytes, fileCount }) =>
      console.log(JSON.stringify({ output, totalBytes, fileCount })),
    )
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
