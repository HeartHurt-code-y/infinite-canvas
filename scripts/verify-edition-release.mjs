// Read-only verification of the native edition hand-off. No credentials or network are used.
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertComponentRoot,
  COMPONENT_PLATFORM,
  COMPONENT_REPO_ROOT,
  componentFileSha256,
  componentPathIsValid,
  inventoryComponentFiles,
} from "./runtime-resources.mjs";
import {
  assertWindowsInstallerProductVersion,
  readWindowsInstallerProductVersion,
} from "./publish-tos-updates.mjs";
import { verifyNsisEditionResourceTable } from "./verify-nsis-edition-resources.mjs";
import { verifyUpdaterSignature } from "./verify-updater-signature.mjs";
import { tosUpdatesObjectKey, tosUpdatesPublicBaseUrl } from "./tos-updates-config.mjs";
import { assertEditionBuildSourceFreshness } from "./edition-source-fingerprint.mjs";
import {
  assertMacAppInventories,
  inventoryMacUpdateArchive,
  verifyMacDmgApplication,
  verifyMacNativeApp,
} from "./verify-macos-edition.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/;
const MAX_JSON_BYTES = 32 * 1024 * 1024;

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}
function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value, expected, label) {
  requireValue(
    object(value) &&
      JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort()),
    `${label} has unexpected or missing fields`,
  );
}
function sameArray(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}
async function regularFile(filename, root) {
  await assertComponentRoot(path.dirname(filename), root);
  const info = await lstat(filename);
  requireValue(info.isFile() && !info.isSymbolicLink(), `Expected a regular file: ${filename}`);
  return info;
}
async function readJson(filename, root) {
  const info = await regularFile(filename, root);
  requireValue(info.size <= MAX_JSON_BYTES, `JSON file exceeds verification budget: ${filename}`);
  return JSON.parse(await readFile(filename, "utf8"));
}

async function listRegularFiles(directory, root, prefix = "") {
  const files = [];
  for (const name of (await readdir(directory)).sort()) {
    const relative = prefix ? `${prefix}/${name}` : name;
    requireValue(componentPathIsValid(relative), `Unsafe distribution path: ${relative}`);
    const filename = path.join(directory, name);
    const info = await lstat(filename);
    requireValue(!info.isSymbolicLink(), `Distribution cannot contain links: ${relative}`);
    if (info.isDirectory()) files.push(...(await listRegularFiles(filename, root, relative)));
    else {
      requireValue(info.isFile(), `Distribution cannot contain special files: ${relative}`);
      await regularFile(filename, root);
      files.push(relative);
    }
  }
  return files;
}

async function assertPreparedRuntimeResources(root, mapped) {
  const resourcesRoot = path.join(root, "src-tauri", "resources");
  let prepared = [];
  try {
    prepared = (await readdir(resourcesRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => `resources/${entry.name}/`)
      .sort();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  requireValue(
    sameArray([...mapped].sort(), prepared),
    "Edition resource map does not match the prepared runtime resources",
  );
}

/**
 * The edition resource map only ships prepared runtime resource directories.
 * The installer must embed exactly those files: no missing payload, no extra.
 */
async function editionRuntimeResourceFiles(root, config, platform = process.platform) {
  const expected = [];
  const mapped = [];
  for (const [source, destination] of Object.entries(config.bundle.resources)) {
    requireValue(
      componentPathIsValid(source.replace(/\/$/, "")) &&
        componentPathIsValid(destination.replace(/\/$/, "")) &&
        source.endsWith("/") &&
        destination.endsWith("/"),
      "Unsafe edition resource mapping",
    );
    requireValue(
      source.startsWith("resources/"),
      `Edition resource mapping must ship a prepared runtime resource: ${source}`,
    );
    mapped.push(source);
  }
  await assertPreparedRuntimeResources(root, mapped);
  for (const [source, destination] of Object.entries(config.bundle.resources)) {
    const files = await inventoryComponentFiles(path.join(root, "src-tauri", source), {
      workspaceRoot: root,
      platform,
    });
    requireValue(files.length > 0, `Edition runtime resource is empty: ${source}`);
    expected.push(...files.map((entry) => `${destination}${entry.path}`));
  }
  return expected;
}

async function verifyResourceTable(root, edition, { version, platform }) {
  const config = await readJson(path.join(root, `src-tauri/tauri.${edition}.conf.json`), root);
  const expected = await editionRuntimeResourceFiles(root, config);
  const targetDirectory = path.join(root, ".cache/tauri-editions", edition, "target");
  const candidates = ["", "x86_64-pc-windows-msvc", "x86_64-pc-windows-gnu"].map((target) =>
    path.join(targetDirectory, target, "release/nsis/x64/installer.nsi"),
  );
  const scripts = [];
  for (const filename of candidates) {
    try {
      await regularFile(filename, root);
      scripts.push(filename);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  requireValue(
    scripts.length === 1,
    "Expected exactly one release NSIS script in this edition target",
  );
  const script = await readFile(scripts[0], "utf8");
  const count = verifyNsisEditionResourceTable(script, expected, edition);
  const executablePath = path.resolve(path.dirname(scripts[0]), "../../infinite-canvas.exe");
  await regularFile(executablePath, root);
  const mainSources = [...script.matchAll(/^!define MAINBINARYSRCPATH "([^"]+)"\s*$/gm)];
  const mainNames = [...script.matchAll(/^!define MAINBINARYNAME "([^"]+)"\s*$/gm)];
  requireValue(
    mainSources.length === 1 &&
      path.resolve(mainSources[0][1]) === executablePath &&
      mainNames.length === 1 &&
      mainNames[0][1] === "infinite-canvas" &&
      [...script.matchAll(/^\s*File "\$\{MAINBINARYSRCPATH\}"\s*$/gm)].length === 1,
    "NSIS recipe does not embed the verified release/infinite-canvas.exe",
  );
  const targetMarker = await readJson(path.join(targetDirectory, "distribution.json"), root);
  exactKeys(
    targetMarker,
    ["schemaVersion", "applicationVersion", "edition", "platform"],
    "Edition target marker",
  );
  requireValue(
    targetMarker.schemaVersion === 1 &&
      targetMarker.applicationVersion === version &&
      targetMarker.edition === edition &&
      targetMarker.platform === platform,
    "Raw edition target marker does not match this distribution",
  );
  return { count, config, executablePath };
}

function verifyOnlineFeed(
  latest,
  { version, installer, signature, baseUrl, platform: platformId },
) {
  exactKeys(latest, ["version", "notes", "pub_date", "platforms"], "Online latest feed");
  requireValue(
    latest.version === version &&
      typeof latest.notes === "string" &&
      typeof latest.pub_date === "string" &&
      Number.isFinite(Date.parse(latest.pub_date)),
    "Online latest feed identity is invalid",
  );
  exactKeys(latest.platforms, [platformId], "Online updater platforms");
  const platform = latest.platforms[platformId];
  exactKeys(platform, ["url", "signature"], "Online updater platform");
  requireValue(
    platform.url === `${baseUrl}/${encodeURIComponent(path.basename(installer.path))}` &&
      platform.signature === signature,
    "Online updater must point to the signed installer in its independent channel",
  );
}

async function verifyMacEditionResources(
  root,
  edition,
  tauriConfig,
  verifyMacApp,
  { version, platform },
) {
  requireValue(
    edition === "online",
    "macOS resource editions currently support only online builds",
  );
  const config = await readJson(path.join(root, "src-tauri/tauri.online.conf.json"), root);
  const expected = [];
  const mapped = [];
  for (const [source, destination] of Object.entries(config.bundle.resources)) {
    requireValue(
      source.endsWith("/") &&
        destination.endsWith("/") &&
        componentPathIsValid(source.slice(0, -1)) &&
        componentPathIsValid(destination.slice(0, -1)),
      "Unsafe macOS edition resource mapping",
    );
    mapped.push(source);
  }
  await assertPreparedRuntimeResources(root, mapped);
  for (const [source, destination] of Object.entries(config.bundle.resources)) {
    const files = await inventoryComponentFiles(path.join(root, "src-tauri", source), {
      workspaceRoot: root,
      platform: "darwin",
    });
    requireValue(files.length > 0, `macOS edition runtime resource is empty: ${source}`);
    expected.push(...files.map((entry) => ({ ...entry, path: `${destination}${entry.path}` })));
  }
  requireValue(
    Object.keys(config.bundle.resources).length === 1 &&
      expected.some(({ path: filename }) => filename.startsWith("ffmpeg/")),
    "macOS online resource map must contain the bundled FFmpeg runtime",
  );
  const icons = tauriConfig.bundle?.icon?.filter((filename) => filename.endsWith(".icns")) ?? [];
  requireValue(
    icons.length === 1 && componentPathIsValid(icons[0]),
    "macOS app requires exactly one configured .icns icon",
  );
  const icon = path.join(root, "src-tauri", icons[0]);
  expected.push({
    path: path.basename(icons[0]),
    size: (await regularFile(icon, root)).size,
    sha256: await componentFileSha256(icon),
  });
  const files = tauriConfig.bundle.macOS?.files;
  exactKeys(files, ["Resources/unlock-installed-macos-app.sh"], "macOS supporting files");
  requireValue(
    files["Resources/unlock-installed-macos-app.sh"] === "../scripts/unlock-installed-macos-app.sh",
    "macOS installation support mapping changed",
  );
  const unlock = path.join(root, "scripts/unlock-installed-macos-app.sh");
  expected.push({
    path: "unlock-installed-macos-app.sh",
    size: (await regularFile(unlock, root)).size,
    sha256: await componentFileSha256(unlock),
  });
  const targetDirectory = path.join(root, ".cache/tauri-editions", edition, "target");
  const triple = platform === "darwin-aarch64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  const candidates = ["", triple].map((target) =>
    path.join(targetDirectory, target, "release/bundle/macos", `${tauriConfig.productName}.app`),
  );
  const apps = [];
  for (const app of candidates) {
    try {
      await assertComponentRoot(app, root);
      requireValue((await lstat(app)).isDirectory(), "macOS app must be a directory");
      apps.push(app);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  requireValue(apps.length === 1, "Expected exactly one native release app in this edition target");
  const targetMarker = await readJson(path.join(targetDirectory, "distribution.json"), root);
  exactKeys(
    targetMarker,
    ["schemaVersion", "applicationVersion", "edition", "platform"],
    "Edition target marker",
  );
  requireValue(
    targetMarker.schemaVersion === 1 &&
      targetMarker.applicationVersion === version &&
      targetMarker.edition === edition &&
      targetMarker.platform === platform,
    "Raw edition target marker does not match this distribution",
  );
  const native = await verifyMacApp(apps[0], {
    applicationVersion: version,
    platform,
    identifier: tauriConfig.identifier,
    expectedResources: expected,
  });
  requireValue(
    native.codeSignatureVerified === true &&
      native.architectureVerified === true &&
      native.bundleResourceCount === expected.length &&
      native.executablePath === path.join(apps[0], "Contents/MacOS/infinite-canvas") &&
      Array.isArray(native.inventory),
    "macOS native app verification is incomplete",
  );
  await regularFile(native.executablePath, root);
  return { ...native, config, appName: `${tauriConfig.productName}.app` };
}

export async function verifyEditionRelease({
  distributionDirectory,
  root = COMPONENT_REPO_ROOT,
  platform = COMPONENT_PLATFORM,
  readProductVersion = readWindowsInstallerProductVersion,
  verifySignature = verifyUpdaterSignature,
  verifyMacApp = verifyMacNativeApp,
  verifyMacDmg = verifyMacDmgApplication,
  verifyMacPackage = async (...args) =>
    (await import("./verify-macos-edition.mjs")).verifyMacInstallerPackage(...args),
  inventoryMacArchive = inventoryMacUpdateArchive,
  requireSourceFreshness = false,
} = {}) {
  requireValue(typeof distributionDirectory === "string", "--distribution-dir is required");
  requireValue(
    ["windows-x86_64", "darwin-aarch64", "darwin-x86_64"].includes(platform),
    "Unsupported edition release platform",
  );
  const isMac = platform.startsWith("darwin-");
  root = path.resolve(root);
  const directory = path.resolve(root, distributionDirectory);
  const relative = path.relative(root, directory).replaceAll(path.sep, "/");
  const match = /^\.cache\/tauri-editions\/(online|offline)\/artifacts\/([^/]+)$/.exec(relative);
  requireValue(
    match && VERSION.test(match[2]),
    "Distribution directory must be an exact edition/version artifact directory inside the workspace",
  );
  const [, edition, version] = match;
  await assertComponentRoot(directory, root);
  const packageJson = await readJson(path.join(root, "package.json"), root);
  const tauriConfig = await readJson(path.join(root, "src-tauri/tauri.conf.json"), root);
  requireValue(
    version === packageJson.version && version === tauriConfig.version,
    "Distribution version does not match package.json and tauri.conf.json",
  );
  const marker = await readJson(path.join(directory, "distribution.json"), root);
  exactKeys(
    marker,
    ["schemaVersion", "applicationVersion", "edition", "platform", "artifacts"],
    "Distribution marker",
  );
  requireValue(
    marker.schemaVersion === 1 &&
      marker.applicationVersion === version &&
      marker.edition === edition &&
      marker.platform === platform,
    "Distribution marker does not match its edition/version directory",
  );
  requireValue(
    Array.isArray(marker.artifacts) && marker.artifacts.length > 0 && marker.artifacts.length <= 16,
    "Invalid distribution artifact list",
  );
  const artifactPaths = new Set();
  for (const artifact of marker.artifacts) {
    exactKeys(artifact, ["path", "size", "sha256"], "Distribution artifact");
    requireValue(
      componentPathIsValid(artifact.path) &&
        (isMac
          ? edition === "online" &&
            (/\.(dmg|pkg|app\.tar\.gz)(?:\.sig)?$/.test(artifact.path) ||
              artifact.path === "helper/install-macos.sh")
          : /\.(exe|msi)(?:\.sig)?$/i.test(artifact.path)) &&
        !artifactPaths.has(artifact.path.toLowerCase()) &&
        Number.isSafeInteger(artifact.size) &&
        artifact.size > 0 &&
        SHA256.test(artifact.sha256),
      "Invalid or duplicate distribution artifact path/identity",
    );
    artifactPaths.add(artifact.path.toLowerCase());
    const filename = path.join(directory, artifact.path);
    const info = await regularFile(filename, root);
    requireValue(
      info.size === artifact.size && (await componentFileSha256(filename)) === artifact.sha256,
      `Artifact hash/size mismatch: ${artifact.path}`,
    );
  }
  const metadataFiles =
    edition === "online"
      ? ["distribution.json", "latest.json", "publish-manifest.json"]
      : ["distribution.json"];
  const sourceRecordPath = path.join(directory, "build-source.json");
  let hasSourceRecord = false;
  try {
    await regularFile(sourceRecordPath, root);
    hasSourceRecord = true;
    metadataFiles.push("build-source.json");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  requireValue(
    !requireSourceFreshness || hasSourceRecord,
    "Publishing requires a build-source.json provenance record; rebuild this edition first",
  );
  requireValue(
    sameArray(
      (await listRegularFiles(directory, root)).sort(),
      [...marker.artifacts.map(({ path: filename }) => filename), ...metadataFiles].sort(),
    ),
    "Distribution contains missing or unregistered files",
  );
  const macArch = platform === "darwin-aarch64" ? "aarch64" : "x64";
  const installerName = isMac
    ? `${tauriConfig.productName}_${version}_${macArch}-${edition}.app.tar.gz`
    : `${tauriConfig.productName}_${version}_x64-${edition}-setup.exe`;
  const installers = marker.artifacts.filter(({ path: filename }) =>
    filename.endsWith(isMac ? ".app.tar.gz" : ".exe"),
  );
  requireValue(
    installers.length === 1 && path.basename(installers[0].path) === installerName,
    "Expected exactly one current-version edition updater package",
  );
  const installer = installers[0];
  requireValue(
    artifactPaths.has(`${installer.path}.sig`.toLowerCase()),
    "Edition updater package is missing its updater signature",
  );
  for (const artifact of marker.artifacts.filter(({ path: filename }) =>
    isMac ? filename.endsWith(".app.tar.gz") : /\.(exe|msi)$/.test(filename),
  )) {
    requireValue(
      artifactPaths.has(`${artifact.path}.sig`.toLowerCase()),
      `Unsigned distribution package: ${artifact.path}`,
    );
    await verifySignature(
      path.join(directory, artifact.path),
      path.join(directory, `${artifact.path}.sig`),
      tauriConfig.plugins.updater.pubkey,
    );
  }
  const productVersion = isMac
    ? version
    : await readProductVersion(path.join(directory, installer.path));
  if (!isMac) assertWindowsInstallerProductVersion(productVersion, version);
  const nativeResources = isMac
    ? await verifyMacEditionResources(root, edition, tauriConfig, verifyMacApp, {
        version,
        platform,
      })
    : await verifyResourceTable(root, edition, { version, platform });
  const { config: editionConfig, executablePath } = nativeResources;
  let macDmg = null;
  let macPackage = null;
  if (isMac) {
    const dmgPath = `dmg/${tauriConfig.productName}_${version}_${macArch}-${edition}.dmg`;
    const packagePath = `pkg/${tauriConfig.productName}_${version}_${macArch}-${edition}.pkg`;
    requireValue(
      installer.path === `macos/${installerName}` &&
        sameArray(
          [...artifactPaths].sort(),
          [
            dmgPath,
            packagePath,
            `macos/${installerName}`,
            `macos/${installerName}.sig`,
            "helper/install-macos.sh",
          ]
            .map((filename) => filename.toLowerCase())
            .sort(),
        ),
      "macOS distribution requires exactly the versioned DMG, PKG, updater archive/signature and installation helper",
    );
    assertMacAppInventories(
      await inventoryMacArchive(path.join(directory, installer.path), nativeResources.appName),
      nativeResources.inventory,
      "Updater archive",
    );
    const dmgVerification = await verifyMacDmg(
      path.join(directory, dmgPath),
      nativeResources.appName,
      nativeResources.inventory,
      { sourceRoot: root },
    );
    requireValue(
      dmgVerification?.dmgVerified === true &&
        dmgVerification.applicationBytesVerified === true &&
        dmgVerification.codeSignatureVerified === true &&
        dmgVerification.installationHelpersVerified === true,
      "macOS DMG verification is incomplete",
    );
    const helperPath = path.join(directory, "helper/install-macos.sh");
    const sourceHelper = path.join(root, "scripts/install-macos.sh");
    await regularFile(sourceHelper, root);
    requireValue(
      (await readFile(helperPath)).equals(await readFile(sourceHelper)),
      "macOS installation helper differs from the verified project source",
    );
    macDmg = {
      ...marker.artifacts.find(({ path: filename }) => filename === dmgPath),
      ...dmgVerification,
    };
    const packageVerification = await verifyMacPackage(
      path.join(directory, packagePath),
      nativeResources.appName,
      nativeResources.inventory,
      { applicationVersion: version, identifier: tauriConfig.identifier, sourceRoot: root },
    );
    requireValue(
      packageVerification?.pkgVerified === true &&
        packageVerification.applicationBytesVerified === true &&
        packageVerification.codeSignatureVerified === true &&
        packageVerification.postinstallVerified === true &&
        packageVerification.packageIdentifier === `${tauriConfig.identifier}.online-installer` &&
        packageVerification.packageVersion === version,
      "macOS installation PKG verification is incomplete",
    );
    macPackage = {
      ...marker.artifacts.find(({ path: filename }) => filename === packagePath),
      ...packageVerification,
    };
  }
  const executable = {
    path: path.relative(root, executablePath).replaceAll(path.sep, "/"),
    size: (await regularFile(executablePath, root)).size,
    sha256: await componentFileSha256(executablePath),
  };
  const sourceFreshness = hasSourceRecord
    ? await assertEditionBuildSourceFreshness(await readJson(sourceRecordPath, root), {
        root,
        edition,
        applicationVersion: version,
        executablePath,
      })
    : { sourceFreshnessVerified: false, sourceFingerprint: null, sourceFileCount: 0 };
  const channel = edition === "online" ? `${platform}-online` : platform;
  const baseUrl = `${tosUpdatesPublicBaseUrl()}/${channel}`;
  requireValue(
    sameArray(
      edition === "online"
        ? editionConfig.plugins?.updater?.endpoints
        : tauriConfig.plugins.updater.endpoints,
      [
        `${tosUpdatesPublicBaseUrl()}/{{target}}-{{arch}}${edition === "online" ? "-online" : ""}/latest.json`,
      ],
    ),
    "Edition updater endpoint does not match its independent channel",
  );
  if (edition === "online") {
    const signature = (
      await readFile(path.join(directory, `${installer.path}.sig`), "utf8")
    ).trim();
    verifyOnlineFeed(await readJson(path.join(directory, "latest.json"), root), {
      version,
      installer,
      signature,
      baseUrl,
      platform,
    });
    const publish = await readJson(path.join(directory, "publish-manifest.json"), root);
    exactKeys(
      publish,
      [
        "schemaVersion",
        "edition",
        "applicationVersion",
        "platform",
        "channel",
        "feed",
        "artifacts",
      ],
      "Publish manifest",
    );
    requireValue(
      publish.schemaVersion === 1 &&
        publish.edition === edition &&
        publish.applicationVersion === version &&
        publish.platform === platform &&
        publish.channel === channel,
      "Publish manifest identity does not match the edition",
    );
    exactKeys(publish.feed, ["localPath", "objectKey", "url"], "Publish feed");
    requireValue(
      publish.feed.localPath === path.join(directory, "latest.json") &&
        publish.feed.objectKey === tosUpdatesObjectKey(`${channel}/latest.json`) &&
        publish.feed.url === `${baseUrl}/latest.json`,
      "Publish feed escapes its edition channel or local artifact directory",
    );
    requireValue(
      Array.isArray(publish.artifacts) && publish.artifacts.length === marker.artifacts.length,
      "Publish artifact count mismatch",
    );
    for (const [index, artifact] of publish.artifacts.entries()) {
      exactKeys(
        artifact,
        ["path", "size", "sha256", "localPath", "objectKey", "url"],
        "Publish artifact",
      );
      const expected = marker.artifacts[index];
      const publicName =
        isMac && expected.path === "helper/install-macos.sh"
          ? `install-macos-${version}.sh`
          : path.basename(expected.path);
      requireValue(
        artifact.path === expected.path &&
          artifact.size === expected.size &&
          artifact.sha256 === expected.sha256 &&
          artifact.localPath === path.join(directory, expected.path) &&
          artifact.objectKey === tosUpdatesObjectKey(`${channel}/${publicName}`) &&
          artifact.url === `${baseUrl}/${encodeURIComponent(publicName)}`,
        "Publish artifact identity/path/channel mismatch",
      );
    }
  }
  return {
    schemaVersion: 1,
    verified: true,
    edition,
    applicationVersion: version,
    platform,
    channel,
    ...sourceFreshness,
    executable,
    installer: {
      path: installer.path,
      size: installer.size,
      sha256: installer.sha256,
      productVersion,
      updaterSignatureVerified: true,
    },
    artifactCount: marker.artifacts.length,
    ...(isMac
      ? {
          bundleResourceCount: nativeResources.bundleResourceCount,
          macos: {
            codeSignatureVerified: true,
            signingIdentity: nativeResources.signingIdentity,
            architectureVerified: true,
            updateArchiveBytesVerified: true,
            dmg: macDmg,
            pkg: macPackage,
          },
        }
      : { nsisResourceCount: nativeResources.count }),
    publishManifestVerified: edition === "online",
  };
}

export function parseEditionVerificationArgs(args) {
  requireValue(
    args.length === 2 && args[0] === "--distribution-dir" && args[1] && !args[1].startsWith("--"),
    "Usage: node scripts/verify-edition-release.mjs --distribution-dir .cache/tauri-editions/{online|offline}/artifacts/{version}",
  );
  return { distributionDirectory: args[1] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyEditionRelease(parseEditionVerificationArgs(process.argv.slice(2)))
    .then((report) => console.log(JSON.stringify(report, null, 2)))
    .catch((error) => {
      console.error(`[verify-edition-release] ${error.message}`);
      process.exitCode = 1;
    });
}
