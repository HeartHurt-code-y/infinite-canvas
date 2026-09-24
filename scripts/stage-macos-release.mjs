// Stage a versioned macOS updater archive without changing any live feed.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readAppVersion, writeLatestJson } from "./write-latest-json.mjs";
import { tosUpdatesPublicBaseUrl } from "./tos-updates-config.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE_ROOT = path.join(REPO_ROOT, "src-tauri", "target", "release", "bundle");

export function stagedMacArchiveName(productName, version, arch) {
  return `${productName}_${version}_${arch}-full.app.tar.gz`;
}

export function stageMacosRelease({
  bundleRoot = BUNDLE_ROOT,
  version = readAppVersion(),
  arch = process.arch,
} = {}) {
  if (arch !== "arm64" && arch !== "x64") throw new Error(`不支持 macOS 架构：${arch}`);
  const platform = arch === "arm64" ? "darwin-aarch64" : "darwin-x86_64";
  const conf = JSON.parse(
    readFileSync(path.join(REPO_ROOT, "src-tauri", "tauri.conf.json"), "utf8"),
  );
  const sourceDir = path.join(bundleRoot, "macos");
  const archives = readdirSync(sourceDir).filter((file) => file.endsWith(".app.tar.gz"));
  if (archives.length !== 1 || !existsSync(path.join(sourceDir, `${archives[0]}.sig`))) {
    throw new Error("macOS 暂存需要恰好一个已签名的 .app.tar.gz");
  }
  const outputDir = path.join(bundleRoot, "release-staging", version, platform, "full");
  mkdirSync(outputDir, { recursive: true });
  const outputName = stagedMacArchiveName(
    conf.productName,
    version,
    arch === "arm64" ? "aarch64" : "x64",
  );
  copyFileSync(path.join(sourceDir, archives[0]), path.join(outputDir, outputName));
  copyFileSync(
    path.join(sourceDir, `${archives[0]}.sig`),
    path.join(outputDir, `${outputName}.sig`),
  );
  writeLatestJson({
    "bundle-dir": outputDir,
    "base-url": `${tosUpdatesPublicBaseUrl()}/${platform}`,
    out: path.join(outputDir, "latest.json"),
    version,
    platform,
  });
  return { outputDir, outputName, platform };
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  try {
    const staged = stageMacosRelease();
    console.log(`[stage-macos] 已暂存 ${staged.outputDir}；未发布到 TOS`);
  } catch (error) {
    console.error(`[stage-macos] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
