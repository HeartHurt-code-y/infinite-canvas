// The slim updater may reuse installed resources only if they are byte-for-byte
// the same as the previously published full bridge. Snapshot every bundled
// stable resource, including skills and the prepared engines.
import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readAppVersion } from "./write-latest-json.mjs";
import { verifyUpdaterSignature } from "./verify-updater-signature.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const STABLE_RESOURCE_DIRS = [
  "src-tauri/resources/blender",
  "src-tauri/resources/remotion-runtime",
  "src-tauri/resources/ffmpeg",
  "src-tauri/skills/anime-drama-v23",
  "src-tauri/skills/music-video-workflow",
  "src-tauri/skills/gpt-image-2-style-library",
];

async function fileSha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

export async function hashResourceTree(directory) {
  if (!existsSync(directory)) throw new Error(`稳定资源目录不存在：${directory}`);
  const canonicalRoot = realpathSync(directory);
  const hash = createHash("sha256");
  let files = 0;
  let bytes = 0;
  const activeDirectories = new Set();
  const fileHashes = new Map();
  function insideRoot(candidate) {
    const relative = path.relative(canonicalRoot, candidate);
    return (
      relative === "" ||
      (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  }
  async function visit(current, relative) {
    const canonicalDirectory = realpathSync(current);
    if (!insideRoot(canonicalDirectory)) throw new Error(`稳定资源链接越出目录：${relative}`);
    if (activeDirectories.has(canonicalDirectory))
      throw new Error(`稳定资源链接形成循环：${relative}`);
    activeDirectories.add(canonicalDirectory);
    try {
      for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      )) {
        const child = path.join(current, entry.name);
        const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
        const info = lstatSync(child);
        const canonicalChild = realpathSync(child);
        if (!insideRoot(canonicalChild)) throw new Error(`稳定资源链接越出目录：${childRelative}`);
        const type = info.isSymbolicLink() ? statSync(child) : info;
        if (type.isDirectory()) {
          hash.update(`D\0${childRelative}\0`);
          await visit(child, childRelative);
        } else if (type.isFile()) {
          let digest = fileHashes.get(canonicalChild);
          if (!digest) {
            digest = await fileSha256(child);
            fileHashes.set(canonicalChild, digest);
          }
          hash.update(`F\0${childRelative}\0${type.size}\0${digest}\0`);
          files += 1;
          bytes += type.size;
        } else {
          throw new Error(`稳定资源含不支持的文件类型：${childRelative}`);
        }
      }
    } finally {
      activeDirectories.delete(canonicalDirectory);
    }
  }
  await visit(directory, "");
  return { sha256: hash.digest("hex"), files, bytes };
}

export async function createRuntimeBaseline(root = REPO_ROOT, provenance) {
  /** @type {Record<string, {sha256: string, files: number, bytes: number}>} */
  const resources = {};
  for (const relativePath of STABLE_RESOURCE_DIRS) {
    resources[relativePath] = await hashResourceTree(path.join(root, relativePath));
  }
  return {
    schemaVersion: 2,
    platform: "windows-x86_64",
    ...(provenance
      ? {
          bridgeVersion: provenance.bridgeVersion,
          fullNsisSha256: await fileSha256(provenance.fullNsisPath),
          fullNsisSignatureSha256: await fileSha256(`${provenance.fullNsisPath}.sig`),
        }
      : {}),
    resources,
  };
}

export function assertRuntimeBaseline(expected, actual, currentVersion) {
  const validHash = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
  if (
    expected?.schemaVersion !== 2 ||
    expected.platform !== "windows-x86_64" ||
    typeof expected.bridgeVersion !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(expected.bridgeVersion) ||
    !validHash(expected.fullNsisSha256) ||
    !validHash(expected.fullNsisSignatureSha256)
  ) {
    throw new Error("过渡版稳定资源基线格式不正确");
  }
  if (
    currentVersion &&
    expected.bridgeVersion
      .split(".")
      .map(Number)
      .some((part, index) => {
        const current = currentVersion.split(".").map(Number);
        const bridge = expected.bridgeVersion.split(".").map(Number);
        return (
          bridge[index] > current[index] &&
          bridge.slice(0, index).every((value, earlier) => value === current[earlier])
        );
      })
  ) {
    throw new Error("稳定资源基线的过渡版高于当前版本");
  }
  if (currentVersion && expected.bridgeVersion === currentVersion) {
    throw new Error("瘦包版本必须高于完整过渡版");
  }
  for (const relativePath of STABLE_RESOURCE_DIRS) {
    const old = expected.resources?.[relativePath];
    const now = actual.resources?.[relativePath];
    if (
      !old ||
      !now ||
      old.sha256 !== now.sha256 ||
      old.files !== now.files ||
      old.bytes !== now.bytes
    ) {
      throw new Error(`资源 ${relativePath} 相比已发布完整过渡版有变化；不能制作瘦包`);
    }
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  try {
    if (
      process.argv[2] !== "--out" ||
      !process.argv[3] ||
      process.argv[4] !== "--full-nsis" ||
      !process.argv[5] ||
      process.argv.length !== 6
    ) {
      throw new Error(
        "用法：node scripts/runtime-resource-baseline.mjs --out <基线文件> --full-nsis <已签名完整 NSIS 包>",
      );
    }
    if (!existsSync(`${process.argv[5]}.sig`)) throw new Error("完整 NSIS 包缺少 .sig 签名");
    const config = JSON.parse(
      readFileSync(path.join(REPO_ROOT, "src-tauri", "tauri.conf.json"), "utf8"),
    );
    await verifyUpdaterSignature(
      process.argv[5],
      `${process.argv[5]}.sig`,
      config.plugins.updater.pubkey,
    );
    const baseline = await createRuntimeBaseline(REPO_ROOT, {
      bridgeVersion: readAppVersion(),
      fullNsisPath: process.argv[5],
    });
    writeFileSync(process.argv[3], `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`[runtime-baseline] 已写入 ${process.argv[3]}`);
  } catch (error) {
    console.error(`[runtime-baseline] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
