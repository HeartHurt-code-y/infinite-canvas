// Build provenance covers editable compilation inputs. Prepared runtime payloads
// stay bound by the executable's catalogue/manifest pins and release verifier.
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  assertComponentRoot,
  COMPONENT_REPO_ROOT,
  componentBytesSha256,
  componentPathIsValid,
} from "./runtime-component-catalog.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/;
const REQUIRED_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "index.html",
  "tsconfig.json",
  "tsconfig.node.json",
  "vite.config.ts",
  "src-tauri/build.rs",
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock",
  "src-tauri/tauri.conf.json",
];
const OPTIONAL_FILES = [
  "vitest.config.ts",
  ".npmrc",
  "pnpm-workspace.yaml",
  "rust-toolchain",
  "rust-toolchain.toml",
  ".env",
  ".env.local",
  ".env.production",
  ".env.production.local",
  "scripts/tauri-build.mjs",
  "scripts/tauri-build-edition.mjs",
  "scripts/edition-source-fingerprint.mjs",
  "scripts/install-macos.sh",
  "scripts/unlock-installed-macos-app.sh",
];
const OPTIONAL_TREES = [
  "public",
  "src-tauri/capabilities",
  "src-tauri/icons",
  "src-tauri/windows",
  ".cargo",
  "src-tauri/.cargo",
];
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}
function exactKeys(value, keys, label) {
  requireValue(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()),
    `${label} has unexpected or missing fields`,
  );
}
function relativeSourcePath(filename, root) {
  const relative = path.relative(root, path.resolve(filename)).replaceAll(path.sep, "/");
  requireValue(componentPathIsValid(relative), `Source path escapes the workspace: ${filename}`);
  return relative;
}
async function stableFile(filename, root) {
  await assertComponentRoot(path.dirname(filename), root);
  const before = await lstat(filename);
  requireValue(
    before.isFile() && !before.isSymbolicLink(),
    `Source must be a regular file: ${filename}`,
  );
  requireValue(before.size <= MAX_FILE_BYTES, `Source exceeds fingerprint budget: ${filename}`);
  const bytes = await readFile(filename);
  const after = await lstat(filename);
  requireValue(
    after.isFile() &&
      !after.isSymbolicLink() &&
      before.size === bytes.length &&
      before.size === after.size &&
      before.mtimeMs === after.mtimeMs &&
      before.ctimeMs === after.ctimeMs &&
      before.ino === after.ino,
    `Source changed while being fingerprinted: ${filename}`,
  );
  return bytes;
}
function snapshotDigest({ applicationVersion, edition, files }) {
  return componentBytesSha256(
    Buffer.from(JSON.stringify({ schemaVersion: 1, applicationVersion, edition, files })),
  );
}

export async function collectEditionSourceFingerprint({
  root = COMPONENT_REPO_ROOT,
  edition,
} = {}) {
  requireValue(edition === "online" || edition === "offline", "Invalid source fingerprint edition");
  root = path.resolve(root);
  await assertComponentRoot(root, root);
  const sources = new Map();
  const folded = new Set();
  const rustSources = [];
  async function addFile(relative) {
    requireValue(componentPathIsValid(relative), `Unsafe source input path: ${relative}`);
    if (sources.has(relative)) return;
    requireValue(!folded.has(relative.toLowerCase()), `Case-ambiguous source path: ${relative}`);
    const bytes = await stableFile(path.join(root, relative), root);
    requireValue(sources.size < MAX_FILES, "Source fingerprint file count exceeds budget");
    sources.set(relative, {
      path: relative,
      size: bytes.length,
      sha256: componentBytesSha256(bytes),
    });
    folded.add(relative.toLowerCase());
    if (relative.endsWith(".rs")) rustSources.push({ relative, source: bytes.toString("utf8") });
    return bytes;
  }
  async function optionalFile(relative) {
    try {
      await addFile(relative);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  async function visit(relative, optional = false) {
    const directory = path.join(root, relative);
    try {
      await assertComponentRoot(directory, root);
    } catch (error) {
      if (optional && error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of (await readdir(directory)).sort()) {
      const child = `${relative}/${entry}`;
      const info = await lstat(path.join(root, child));
      requireValue(!info.isSymbolicLink(), `Source input must not be a symbolic link: ${child}`);
      if (info.isDirectory()) await visit(child);
      else await addFile(child);
    }
  }
  for (const relative of [...REQUIRED_FILES, `src-tauri/tauri.${edition}.conf.json`])
    await addFile(relative);
  for (const relative of OPTIONAL_FILES) await optionalFile(relative);
  for (const relative of ["src", "src-tauri/src"]) {
    const before = sources.size;
    await visit(relative);
    requireValue(sources.size > before, `Source tree must not be empty: ${relative}`);
  }
  for (const relative of OPTIONAL_TREES) await visit(relative, true);
  // include_str!/include_bytes! resolve relative to the declaring Rust source,
  // including multiline literals and files outside src (methods, Python, JSON).
  for (let index = 0; index < rustSources.length; index++) {
    const { relative, source } = rustSources[index];
    const literals = [...source.matchAll(/\binclude_(?:str|bytes)!\s*\(\s*"([^"\\]*)"\s*,?\s*\)/g)];
    requireValue(
      literals.length === [...source.matchAll(/\binclude_(?:str|bytes)!\s*\(/g)].length,
      `Unsupported nonliteral Rust include in ${relative}; extend the fingerprint collector first`,
    );
    for (const match of literals) {
      const filename = path.resolve(root, path.dirname(relative), match[1]);
      await addFile(relativeSourcePath(filename, root));
    }
  }
  const files = [...sources.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  const packageBytes = await stableFile(path.join(root, "package.json"), root);
  requireValue(
    componentBytesSha256(packageBytes) === sources.get("package.json").sha256,
    "package.json changed while being fingerprinted",
  );
  const packageJson = JSON.parse(packageBytes);
  const applicationVersion = packageJson.version;
  requireValue(
    VERSION.test(applicationVersion),
    "Invalid application version for source fingerprint",
  );
  const snapshot = { schemaVersion: 1, applicationVersion, edition, files };
  return { ...snapshot, fingerprint: snapshotDigest(snapshot) };
}

export function assertEditionSourcesUnchanged(before, after) {
  requireValue(
    before.applicationVersion === after.applicationVersion &&
      before.edition === after.edition &&
      before.fingerprint === after.fingerprint &&
      JSON.stringify(before.files) === JSON.stringify(after.files),
    "Compilation sources changed during edition build; refusing to archive a mixed or stale release",
  );
}

export async function createEditionBuildSource({
  snapshot,
  executablePath,
  root = COMPONENT_REPO_ROOT,
}) {
  root = path.resolve(root);
  const bytes = await stableFile(executablePath, root);
  return {
    schemaVersion: 1,
    applicationVersion: snapshot.applicationVersion,
    edition: snapshot.edition,
    sourceFingerprint: snapshot.fingerprint,
    sourceFiles: snapshot.files,
    nativeExecutable: {
      path: relativeSourcePath(executablePath, root),
      size: bytes.length,
      sha256: componentBytesSha256(bytes),
    },
  };
}

export async function assertEditionBuildSourceFreshness(
  record,
  { root = COMPONENT_REPO_ROOT, edition, applicationVersion, executablePath },
) {
  exactKeys(
    record,
    [
      "schemaVersion",
      "applicationVersion",
      "edition",
      "sourceFingerprint",
      "sourceFiles",
      "nativeExecutable",
    ],
    "Build source record",
  );
  requireValue(
    record.schemaVersion === 1 &&
      record.applicationVersion === applicationVersion &&
      record.edition === edition &&
      SHA256.test(record.sourceFingerprint) &&
      Array.isArray(record.sourceFiles) &&
      record.sourceFiles.length > 0 &&
      record.sourceFiles.length <= MAX_FILES,
    "Build source record identity is invalid",
  );
  let previous = "";
  const folded = new Set();
  for (const file of record.sourceFiles) {
    exactKeys(file, ["path", "size", "sha256"], "Build source file");
    requireValue(
      componentPathIsValid(file.path) &&
        file.path > previous &&
        !folded.has(file.path.toLowerCase()) &&
        Number.isSafeInteger(file.size) &&
        file.size >= 0 &&
        file.size <= MAX_FILE_BYTES &&
        SHA256.test(file.sha256),
      "Build source files must have sorted, unique, controlled paths and valid digests",
    );
    previous = file.path;
    folded.add(file.path.toLowerCase());
  }
  requireValue(
    record.sourceFingerprint ===
      snapshotDigest({ applicationVersion, edition, files: record.sourceFiles }),
    "Build source fingerprint does not match its file inventory",
  );
  exactKeys(record.nativeExecutable, ["path", "size", "sha256"], "Build native executable");
  const relative = relativeSourcePath(executablePath, path.resolve(root));
  let macPath = false;
  if (
    /^\.cache\/tauri-editions\/(online|offline)\/target\/(?:aarch64-apple-darwin\/|x86_64-apple-darwin\/)?release\/bundle\/macos\/[^/]+\.app\/Contents\/MacOS\/infinite-canvas$/.test(
      relative,
    )
  ) {
    const tauriConfig = JSON.parse(
      await stableFile(path.join(root, "src-tauri/tauri.conf.json"), path.resolve(root)),
    );
    const appName = `${tauriConfig.productName}.app`;
    macPath =
      typeof tauriConfig.productName === "string" &&
      !tauriConfig.productName.includes("/") &&
      componentPathIsValid(appName) &&
      ["", "aarch64-apple-darwin/", "x86_64-apple-darwin/"].some(
        (target) =>
          relative ===
          `.cache/tauri-editions/${edition}/target/${target}release/bundle/macos/${appName}/Contents/MacOS/infinite-canvas`,
      );
  }
  requireValue(
    record.nativeExecutable.path === relative &&
      (macPath ||
        /^\.cache\/tauri-editions\/(online|offline)\/target\/(?:x86_64-pc-windows-(?:msvc|gnu)\/)?release\/infinite-canvas\.exe$/.test(
          relative,
        )) &&
      relative.startsWith(`.cache/tauri-editions/${edition}/target/`) &&
      Number.isSafeInteger(record.nativeExecutable.size) &&
      record.nativeExecutable.size > 0 &&
      SHA256.test(record.nativeExecutable.sha256),
    "Build native executable path/identity is invalid",
  );
  const bytes = await stableFile(executablePath, path.resolve(root));
  requireValue(
    bytes.length === record.nativeExecutable.size &&
      componentBytesSha256(bytes) === record.nativeExecutable.sha256,
    "Build source record is bound to a different native executable",
  );
  const current = await collectEditionSourceFingerprint({ root, edition });
  requireValue(
    current.applicationVersion === applicationVersion &&
      current.fingerprint === record.sourceFingerprint &&
      JSON.stringify(current.files) === JSON.stringify(record.sourceFiles),
    "Build source freshness failed: compilation inputs changed; rebuild this edition before publishing",
  );
  return {
    sourceFreshnessVerified: true,
    sourceFingerprint: current.fingerprint,
    sourceFileCount: current.files.length,
  };
}
