// Signed, content-addressed Windows runtime resources. The signed manifest is
// created from the same source tree that the full NSIS file table must contain.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveUpdaterSigningEnv } from "./tauri-build.mjs";
import { tosUpdatesPublicBaseUrl } from "./tos-updates-config.mjs";
import { verifyUpdaterSignature } from "./verify-updater-signature.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 200_000;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024 * 1024;
const WINDOWS_RESERVED_STEMS = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
]);
export const RESOURCE_COMPONENTS = [
  {
    name: "blender",
    source: "src-tauri/resources/blender",
    manifestPath: "manifest.json",
    installed: "blender",
  },
  {
    name: "remotion-runtime",
    source: "src-tauri/resources/remotion-runtime",
    manifestPath: "runtime-manifest.json",
    installed: "remotion-runtime",
  },
  {
    name: "ffmpeg",
    source: "src-tauri/resources/ffmpeg",
    manifestPath: "manifest.json",
    installed: "ffmpeg",
  },
  {
    name: "gpt-image-2-style-library",
    source: "src-tauri/skills/gpt-image-2-style-library",
    manifestPath: "data/manifest.json",
    installed: "skills/gpt-image-2-style-library",
  },
];

const asciiLower = (value) => value.replace(/[A-Z]/g, (character) => character.toLowerCase());

export function validRuntimeResourcePath(value) {
  if (
    typeof value !== "string" ||
    value === "" ||
    Buffer.byteLength(value, "utf8") > 1024 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes(":") ||
    /[<>"|?*\x00-\x1f]/.test(value)
  )
    return false;
  const segments = value.split("/");
  if (segments.length > 32) return false;
  return segments.every(
    (segment) =>
      segment !== "" &&
      segment !== "." &&
      segment !== ".." &&
      !segment.endsWith(".") &&
      !segment.endsWith(" ") &&
      !WINDOWS_RESERVED_STEMS.has(segment.split(".")[0].toUpperCase()),
  );
}
const inside = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
};

async function hashFile(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

export async function inventoryComponent(root, definition) {
  const source = path.join(root, definition.source);
  const canonicalRoot = await realpath(source);
  const active = new Set();
  const discovered = [];
  async function visit(directory, relativeDirectory) {
    const canonical = await realpath(directory);
    if (!inside(canonicalRoot, canonical) || active.has(canonical)) {
      throw new Error(`资源链接越界或成环：${definition.name}/${relativeDirectory}`);
    }
    active.add(canonical);
    try {
      const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name, "en"),
      );
      for (const entry of entries) {
        const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
        const current = path.join(directory, entry.name);
        const real = await realpath(current);
        if (!inside(canonicalRoot, real))
          throw new Error(`资源链接越界：${definition.name}/${relative}`);
        const info = await stat(current);
        if (info.isDirectory()) await visit(current, relative);
        else if (info.isFile())
          discovered.push({
            path: relative,
            sourcePath: current,
            size: info.size,
            canonical: real,
          });
        else throw new Error(`资源文件类型不支持：${definition.name}/${relative}`);
      }
    } finally {
      active.delete(canonical);
    }
  }
  await visit(source, "");
  const knownHashes = new Map();
  let cursor = 0;
  async function worker() {
    while (cursor < discovered.length) {
      const item = discovered[cursor++];
      let digest = knownHashes.get(item.canonical);
      if (!digest) {
        digest = hashFile(item.sourcePath);
        knownHashes.set(item.canonical, digest);
      }
      item.sha256 = await digest;
    }
  }
  await Promise.all(Array.from({ length: Math.min(12, discovered.length) }, () => worker()));
  const files = discovered.map(({ path: relative, size, sha256: digest }) => ({
    path: relative,
    size,
    sha256: digest,
  }));
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const manifestFile = files.find((file) => file.path === definition.manifestPath);
  if (!manifestFile)
    throw new Error(`组件缺少内部清单：${definition.name}/${definition.manifestPath}`);
  return {
    name: definition.name,
    manifestPath: definition.manifestPath,
    manifestSha256: manifestFile.sha256,
    files,
  };
}

export function assertFullNsisCoversResourceRelease(script, manifest) {
  const onames = [...script.matchAll(/File \/a "\/oname=([^"]+)"/g)].map((match) =>
    match[1].replaceAll("\\", "/"),
  );
  const counts = new Map();
  for (const name of onames) counts.set(name, (counts.get(name) ?? 0) + 1);
  for (const component of manifest.components) {
    const definition = RESOURCE_COMPONENTS.find((entry) => entry.name === component.name);
    if (!definition) throw new Error(`未知资源组件：${component.name}`);
    for (const file of component.files) {
      const installed = `${definition.installed}/${file.path}`;
      if (counts.get(installed) !== 1)
        throw new Error(`完整 NSIS 文件表未唯一包含资源：${installed}`);
    }
    const prefix = `${definition.installed}/`;
    const expected = new Set(component.files.map((file) => `${prefix}${file.path}`));
    const extra = [...counts].filter(([name]) => name.startsWith(prefix) && !expected.has(name));
    if (extra.length) throw new Error(`完整 NSIS 文件表有未签名资源：${extra[0][0]}`);
  }
}

export function assertRuntimeReleaseShape(manifest) {
  let objectUrl;
  try {
    objectUrl = new URL(manifest?.objectBaseUrl);
  } catch {
    /* Report the same manifest error below. */
  }
  if (
    manifest?.schemaVersion !== 1 ||
    !/^\d+\.\d+\.\d+$/.test(manifest.version ?? "") ||
    manifest.platform !== "windows-x86_64" ||
    objectUrl?.protocol !== "https:" ||
    objectUrl.pathname !== "/infinite-canvas/updates/resources/objects/" ||
    objectUrl.username !== "" ||
    objectUrl.password !== "" ||
    objectUrl.search !== "" ||
    objectUrl.hash !== "" ||
    objectUrl.href !== manifest.objectBaseUrl ||
    !Array.isArray(manifest.components) ||
    manifest.components.length !== RESOURCE_COMPONENTS.length
  ) {
    throw new Error("资源发布清单格式无效");
  }
  const hashes = new Set();
  let totalFiles = 0;
  let totalBytes = 0;
  for (const [index, component] of manifest.components.entries()) {
    const definition = RESOURCE_COMPONENTS[index];
    if (
      !component ||
      typeof component !== "object" ||
      component.name !== definition.name ||
      component.manifestPath !== definition.manifestPath ||
      !/^[a-f0-9]{64}$/.test(component.manifestSha256 ?? "") ||
      !Array.isArray(component.files) ||
      component.files.length === 0
    ) {
      throw new Error(`资源组件清单格式无效：${definition.name}`);
    }
    const paths = new Set();
    for (const file of component.files) {
      if (
        !file ||
        typeof file !== "object" ||
        !validRuntimeResourcePath(file.path) ||
        asciiLower(file.path) === ".complete.json" ||
        !Number.isSafeInteger(file.size) ||
        file.size < 0 ||
        file.size > MAX_FILE_BYTES ||
        !/^[a-f0-9]{64}$/.test(file.sha256 ?? "") ||
        paths.has(asciiLower(file.path))
      ) {
        throw new Error(`资源文件清单格式无效：${definition.name}/${file.path}`);
      }
      paths.add(asciiLower(file.path));
      hashes.add(file.sha256);
      totalFiles += 1;
      totalBytes += file.size;
    }
    if (
      component.files.find((file) => file.path === definition.manifestPath)?.sha256 !==
      component.manifestSha256
    ) {
      throw new Error(`组件内部清单哈希不一致：${definition.name}`);
    }
  }
  if (totalFiles > MAX_FILES || totalBytes > MAX_TOTAL_BYTES) {
    throw new Error("资源清单超出允许的文件数量或容量");
  }
  return hashes.size;
}

export async function assertRuntimeReleaseCoversResources(manifest, root = REPO_ROOT) {
  assertRuntimeReleaseShape(manifest);
  for (const [index, definition] of RESOURCE_COMPONENTS.entries()) {
    const actual = await inventoryComponent(root, definition);
    if (JSON.stringify(actual) !== JSON.stringify(manifest.components[index])) {
      throw new Error(`签名清单与当前构建资源不一致：${definition.name}`);
    }
  }
}

export function resolveResourceManifestSignerEnv(sourceEnv, defaultKeyPath) {
  const env = resolveUpdaterSigningEnv(sourceEnv, defaultKeyPath);
  if (!env.TAURI_SIGNING_PRIVATE_KEY) throw new Error("缺少 updater 私钥，不能签资源清单");
  // Tauri's `signer sign` treats these as mutually exclusive CLI options even
  // when they come from environment variables. The build helper loads a local
  // key file into the inline value, so keep that value for this signer call.
  delete env.TAURI_SIGNING_PRIVATE_KEY_PATH;
  return env;
}

async function signManifest(manifestPath, root) {
  const env = resolveResourceManifestSignerEnv(
    process.env,
    path.join(root, "src-tauri", ".updater-key"),
  );
  await new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["exec", "tauri", "signer", "sign", manifestPath], {
      cwd: root,
      env,
      shell: process.platform === "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`资源清单签名失败：${stderr.slice(0, 500)}`)),
    );
  });
  if (!existsSync(`${manifestPath}.sig`)) throw new Error("Tauri 未生成资源清单 .sig");
}

export async function verifyRuntimeResourceRelease(
  manifestPath,
  signaturePath = `${manifestPath}.sig`,
  root = REPO_ROOT,
) {
  const config = JSON.parse(
    await readFile(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"),
  );
  await verifyUpdaterSignature(manifestPath, signaturePath, config.plugins.updater.pubkey);
  const manifestBytes = await readFile(manifestPath);
  if (manifestBytes.length > MAX_MANIFEST_BYTES) throw new Error("资源清单超过客户端允许的 16 MiB");
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  await assertRuntimeReleaseCoversResources(manifest, root);
  return {
    manifest,
    sha256: await hashFile(manifestPath),
    signature: (await readFile(signaturePath, "utf8")).trim(),
  };
}

export async function stageRuntimeResourceRelease({
  root = REPO_ROOT,
  version,
  outDir,
  nsisScriptPath,
  objectBaseUrl = `${tosUpdatesPublicBaseUrl()}/resources/objects/`,
}) {
  if (!version || !outDir || !nsisScriptPath)
    throw new Error("暂存资源发布清单需要版本、输出目录和完整 NSIS 文件表");
  const components = [];
  for (const definition of RESOURCE_COMPONENTS)
    components.push(await inventoryComponent(root, definition));
  const manifest = {
    schemaVersion: 1,
    version,
    platform: "windows-x86_64",
    objectBaseUrl,
    components,
  };
  assertRuntimeReleaseShape(manifest);
  assertFullNsisCoversResourceRelease(readFileSync(nsisScriptPath, "utf8"), manifest);
  return stageSignedRuntimeResourceManifest(root, outDir, manifest);
}

async function stageSignedRuntimeResourceManifest(root, outDir, manifest) {
  await mkdir(outDir, { recursive: true });
  const manifestPath = path.join(outDir, "manifest.json");
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  if (manifestBytes.length > MAX_MANIFEST_BYTES) throw new Error("资源清单超过客户端允许的 16 MiB");
  await writeFile(manifestPath, manifestBytes);
  await signManifest(manifestPath, root);
  const verified = await verifyRuntimeResourceRelease(manifestPath, `${manifestPath}.sig`, root);
  return { ...verified, manifestPath, signaturePath: `${manifestPath}.sig` };
}

/** Only for a slim release whose resources were independently proven to match
 * an earlier signed full bridge. The source manifest must itself be signed and
 * every listed file must still match the current resource tree. */
export async function stageRuntimeResourceReleaseFromSignedManifest({
  root = REPO_ROOT,
  version,
  outDir,
  sourceManifestPath,
  sourceVersion,
  objectBaseUrl = `${tosUpdatesPublicBaseUrl()}/resources/objects/`,
}) {
  if (!version || !outDir || !sourceManifestPath || !sourceVersion) {
    throw new Error("复用签名资源清单需要新旧版本、输出目录和旧版清单路径");
  }
  const source = await verifyRuntimeResourceRelease(
    sourceManifestPath,
    `${sourceManifestPath}.sig`,
    root,
  );
  if (source.manifest.version !== sourceVersion || sourceVersion === version) {
    throw new Error("复用版本的签名资源清单版本不匹配");
  }
  if (source.manifest.objectBaseUrl !== objectBaseUrl) {
    throw new Error("旧版签名资源清单的对象地址与当前发布地址不一致");
  }
  const manifest = { ...source.manifest, version };
  assertRuntimeReleaseShape(manifest);
  return stageSignedRuntimeResourceManifest(root, outDir, manifest);
}
