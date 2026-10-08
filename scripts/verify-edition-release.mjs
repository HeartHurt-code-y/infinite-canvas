// Read-only verification of the local Windows edition hand-off. No credentials or network are used.
import { lstat, readFile, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertComponentRoot,
  COMPONENT_CATALOG_RESOURCE,
  COMPONENT_FEATURES,
  COMPONENT_PLATFORM,
  COMPONENT_REPO_ROOT,
  componentFileSha256,
  componentBytesSha256,
  componentPathIsValid,
  inventoryComponentFiles,
  RUNTIME_COMPONENTS,
  runtimeComponentArchiveUrl,
} from "./runtime-component-catalog.mjs";
import {
  assertWindowsInstallerProductVersion,
  readWindowsInstallerProductVersion,
} from "./publish-tos-updates.mjs";
import { verifyNsisEditionResourceTable } from "./verify-nsis-edition-resources.mjs";
import { verifyUpdaterSignature } from "./verify-updater-signature.mjs";
import { tosUpdatesObjectKey, tosUpdatesPublicBaseUrl } from "./tos-updates-config.mjs";
import { assertEditionBuildSourceFreshness } from "./edition-source-fingerprint.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/;
const MAX_JSON_BYTES = 32 * 1024 * 1024;
const COMPILED_PINS_PREFIX = "IC_COMPONENT_CATALOG_PINS_V1 ";
const executeFile = promisify(execFile);
const OFFLINE_ARCHIVE_IDS = ["ai-media-runtime", "ai-media-quality-runtime"];

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

export function parseCompiledEditionPinsOutput(output) {
  requireValue(
    typeof output === "string" && Buffer.byteLength(output) <= 64 * 1024,
    "Invalid compiled edition pins output",
  );
  const records = output.split(/\r?\n/).filter((line) => line.startsWith(COMPILED_PINS_PREFIX));
  requireValue(
    records.length === 1,
    "Executable must emit exactly one IC_COMPONENT_CATALOG_PINS_V1 record",
  );
  return JSON.parse(records[0].slice(COMPILED_PINS_PREFIX.length));
}

export async function readWindowsCompiledEditionPins(filename) {
  const { stdout } = await executeFile(filename, ["--print-component-catalog-pins"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 64 * 1024,
  });
  return parseCompiledEditionPinsOutput(stdout);
}

export function assertCompiledEditionPins(
  pins,
  { catalog, catalogSha256, edition, applicationVersion },
) {
  exactKeys(
    pins,
    ["schemaVersion", "applicationVersion", "edition", "catalogSha256", "manifestPins"],
    "Compiled edition pins",
  );
  requireValue(
    pins.schemaVersion === 1 &&
      pins.applicationVersion === applicationVersion &&
      pins.edition === edition &&
      pins.catalogSha256 === catalogSha256,
    "Executable edition/version/catalog SHA does not match this distribution",
  );
  exactKeys(
    pins.manifestPins,
    RUNTIME_COMPONENTS.map(({ id }) => id),
    "Compiled manifest pins",
  );
  for (const component of catalog.components)
    requireValue(
      SHA256.test(pins.manifestPins[component.id]) &&
        pins.manifestPins[component.id] === component.manifestSha256,
      `Executable manifest pin is stale or mismatched: ${component.id}`,
    );
}

export function assertEditionCatalog(catalog, applicationVersion) {
  exactKeys(
    catalog,
    ["schemaVersion", "applicationVersion", "platform", "components", "features"],
    "Component catalog",
  );
  requireValue(
    catalog.schemaVersion === 1 &&
      catalog.applicationVersion === applicationVersion &&
      catalog.platform === COMPONENT_PLATFORM,
    "Component catalog identity does not match this release",
  );
  requireValue(
    Array.isArray(catalog.components) && catalog.components.length === RUNTIME_COMPONENTS.length,
    "Component catalog must contain exactly seven components",
  );
  const ids = new Set();
  for (const component of catalog.components) {
    exactKeys(
      component,
      [
        "id",
        "title",
        "description",
        "version",
        "manifestPath",
        "manifestSha256",
        "bundlePath",
        "dependencies",
        "files",
        "archive",
      ],
      "Catalog component",
    );
    const definition = RUNTIME_COMPONENTS.find(({ id }) => id === component.id);
    requireValue(definition && !ids.has(component.id), "Unknown or duplicate component identity");
    ids.add(component.id);
    requireValue(
      component.title === definition.title &&
        component.description === definition.description &&
        typeof component.version === "string" &&
        component.version.length > 0 &&
        component.manifestPath === definition.manifestPath &&
        component.bundlePath === definition.bundlePath &&
        sameArray(component.dependencies, definition.dependencies) &&
        SHA256.test(component.manifestSha256),
      `Component metadata/dependencies do not match the distribution contract: ${component.id}`,
    );
    requireValue(
      Array.isArray(component.files) &&
        component.files.length > 0 &&
        component.files.length <= 100_000,
      `Invalid component inventory count: ${component.id}`,
    );
    const paths = new Set();
    let payloadBytes = 0;
    for (const entry of component.files) {
      exactKeys(
        entry,
        entry.mode === undefined ? ["path", "size", "sha256"] : ["path", "size", "sha256", "mode"],
        "Catalog file",
      );
      requireValue(
        componentPathIsValid(entry.path) &&
          entry.path !== ".complete.json" &&
          !paths.has(entry.path.toLowerCase()) &&
          Number.isSafeInteger(entry.size) &&
          entry.size >= 0 &&
          SHA256.test(entry.sha256) &&
          (entry.mode === undefined || entry.mode === 0o644 || entry.mode === 0o755),
        `Invalid or duplicate component file: ${component.id}/${entry.path}`,
      );
      paths.add(entry.path.toLowerCase());
      payloadBytes += entry.size;
    }
    requireValue(
      Number.isSafeInteger(payloadBytes) && payloadBytes <= 16 * 1024 ** 3,
      `Component uncompressed size exceeds budget: ${component.id}`,
    );
    requireValue(
      component.files.find(({ path: entryPath }) => entryPath === component.manifestPath)
        ?.sha256 === component.manifestSha256,
      `Component manifest is not pinned in its exact inventory: ${component.id}`,
    );
    exactKeys(component.archive, ["format", "url", "size", "sha256"], "Component archive");
    requireValue(
      component.archive.format === "zip" &&
        SHA256.test(component.archive.sha256) &&
        Number.isSafeInteger(component.archive.size) &&
        component.archive.size > 0 &&
        component.archive.size <= 8 * 1024 ** 3 &&
        component.archive.url ===
          runtimeComponentArchiveUrl(component.id, component.archive.sha256, {
            applicationVersion,
          }),
      `Component archive does not use its trusted content-addressed URL: ${component.id}`,
    );
  }
  requireValue(
    sameArray(catalog.features, COMPONENT_FEATURES),
    "Feature dependencies do not match the distribution contract",
  );
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

async function verifyResourceTable(root, edition, catalog) {
  const config = await readJson(path.join(root, `src-tauri/tauri.${edition}.conf.json`), root);
  const expected = [];
  for (const [source, destination] of Object.entries(config.bundle.resources)) {
    if (source === "resources/component-catalog.json") {
      requireValue(destination === "component-catalog.json", "Catalog resource mapping changed");
      expected.push(destination);
      continue;
    }
    requireValue(
      componentPathIsValid(source.replace(/\/$/, "")) &&
        componentPathIsValid(destination.replace(/\/$/, "")) &&
        source.endsWith("/") &&
        destination.endsWith("/"),
      "Unsafe edition resource mapping",
    );
    const component = catalog.components.find(({ bundlePath }) => `${bundlePath}/` === destination);
    if (component) {
      const definition = RUNTIME_COMPONENTS.find(({ id }) => id === component.id);
      requireValue(
        `${definition.sourcePath.replace(/^src-tauri\//, "")}/` === source,
        "Edition component source mapping changed",
      );
      expected.push(...component.files.map((entry) => `${destination}${entry.path}`));
    } else {
      requireValue(
        source === destination &&
          ["skills/anime-drama-v23/", "skills/music-video-workflow/"].includes(source),
        `Unexpected edition resource mapping: ${source}`,
      );
      const files = await inventoryComponentFiles(path.join(root, "src-tauri", source), {
        workspaceRoot: root,
      });
      expected.push(...files.map((entry) => `${destination}${entry.path}`));
    }
  }
  const required =
    edition === "online"
      ? ["ffmpeg"]
      : RUNTIME_COMPONENTS.map(({ id }) => id).filter((id) => !OFFLINE_ARCHIVE_IDS.includes(id));
  requireValue(
    sameArray(
      catalog.components
        .filter(({ bundlePath }) =>
          Object.values(config.bundle.resources).includes(`${bundlePath}/`),
        )
        .map(({ id }) => id)
        .sort(),
      [...required].sort(),
    ) && Object.keys(config.bundle.resources).length === required.length + 3,
    "Edition resource map includes missing or unexpected components",
  );
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
      targetMarker.applicationVersion === catalog.applicationVersion &&
      targetMarker.edition === edition &&
      targetMarker.platform === COMPONENT_PLATFORM,
    "Raw edition target marker does not match this distribution",
  );
  return { count, config, executablePath };
}

function verifyOnlineFeed(latest, { version, installer, signature, baseUrl }) {
  exactKeys(latest, ["version", "notes", "pub_date", "platforms"], "Online latest feed");
  requireValue(
    latest.version === version &&
      typeof latest.notes === "string" &&
      typeof latest.pub_date === "string" &&
      Number.isFinite(Date.parse(latest.pub_date)),
    "Online latest feed identity is invalid",
  );
  exactKeys(latest.platforms, [COMPONENT_PLATFORM], "Online updater platforms");
  const platform = latest.platforms[COMPONENT_PLATFORM];
  exactKeys(platform, ["url", "signature"], "Online updater platform");
  requireValue(
    platform.url === `${baseUrl}/${encodeURIComponent(path.basename(installer.path))}` &&
      platform.signature === signature,
    "Online updater must point to the signed installer in its independent channel",
  );
}

export function assertOfflineSuiteReceipt(
  receipt,
  { catalog, catalogSha256, artifacts, applicationVersion },
) {
  exactKeys(
    receipt,
    ["schemaVersion", "applicationVersion", "edition", "platform", "catalogSha256", "components"],
    "Offline component receipt",
  );
  requireValue(
    receipt.schemaVersion === 1 &&
      receipt.applicationVersion === applicationVersion &&
      receipt.edition === "offline" &&
      receipt.platform === COMPONENT_PLATFORM &&
      receipt.catalogSha256 === catalogSha256,
    "Offline receipt catalog/version identity mismatch",
  );
  const zips = artifacts.filter(({ path: filename }) => filename.endsWith(".zip"));
  requireValue(
    zips.length === 2 && Array.isArray(receipt.components) && receipt.components.length === 2,
    "Offline suite must include exactly the two AI component archives",
  );
  for (const [index, id] of OFFLINE_ARCHIVE_IDS.entries()) {
    const expected = catalog.components.find((component) => component.id === id);
    const entry = receipt.components[index];
    exactKeys(
      entry,
      ["id", "path", "size", "sha256", "manifestPath", "manifestSha256", "nativeManifestBase64"],
      "Offline component receipt entry",
    );
    const expectedPath = `components/${id}-${expected.archive.sha256}.zip`;
    const artifact = zips.find(({ path: filename }) => filename === expectedPath);
    requireValue(
      artifact &&
        artifact.size === expected.archive.size &&
        artifact.sha256 === expected.archive.sha256 &&
        entry.id === id &&
        entry.path === expectedPath &&
        entry.size === expected.archive.size &&
        entry.sha256 === expected.archive.sha256 &&
        entry.manifestPath === expected.manifestPath &&
        entry.manifestSha256 === expected.manifestSha256,
      `Offline archive identity does not match the compiled catalog: ${id}`,
    );
    requireValue(
      typeof entry.nativeManifestBase64 === "string" &&
        entry.nativeManifestBase64.length > 0 &&
        entry.nativeManifestBase64.length <= 4 * 1024 * 1024,
      `Offline native manifest encoding is invalid: ${id}`,
    );
    const nativeBytes = Buffer.from(entry.nativeManifestBase64, "base64");
    requireValue(
      nativeBytes.toString("base64") === entry.nativeManifestBase64 &&
        componentBytesSha256(nativeBytes) === expected.manifestSha256 &&
        nativeBytes.length ===
          expected.files.find((file) => file.path === expected.manifestPath)?.size,
      `Offline native manifest hash/encoding mismatch: ${id}`,
    );
    const native = JSON.parse(nativeBytes);
    requireValue(
      native.schemaVersion === 1 &&
        native.component === id &&
        native.inventory?.path === "files-manifest.json" &&
        native.inventory.sha256 ===
          expected.files.find((file) => file.path === "files-manifest.json")?.sha256 &&
        Number.isSafeInteger(native.inventory.count) &&
        native.inventory.count === expected.files.length - 2,
      `Offline native manifest inventory does not match the compiled catalog: ${id}`,
    );
  }
}

export async function verifyEditionRelease({
  distributionDirectory,
  root = COMPONENT_REPO_ROOT,
  readProductVersion = readWindowsInstallerProductVersion,
  verifySignature = verifyUpdaterSignature,
  readCompiledPins = readWindowsCompiledEditionPins,
  requireSourceFreshness = false,
} = {}) {
  requireValue(typeof distributionDirectory === "string", "--distribution-dir is required");
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
    ["schemaVersion", "applicationVersion", "edition", "platform", "catalogSha256", "artifacts"],
    "Distribution marker",
  );
  requireValue(
    marker.schemaVersion === 1 &&
      marker.applicationVersion === version &&
      marker.edition === edition &&
      marker.platform === COMPONENT_PLATFORM &&
      SHA256.test(marker.catalogSha256),
    "Distribution marker does not match its edition/version directory",
  );
  const catalogPath = path.join(root, COMPONENT_CATALOG_RESOURCE);
  const catalog = await readJson(catalogPath, root);
  assertEditionCatalog(catalog, version);
  requireValue(
    (await componentFileSha256(catalogPath)) === marker.catalogSha256,
    "Distribution catalog hash is stale or mismatched",
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
        (/\.(exe|msi)(?:\.sig)?$/i.test(artifact.path) ||
          (edition === "offline" && artifact.path.endsWith(".zip"))) &&
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
      : ["distribution.json", "offline-components.json"];
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
  const installerName = `${tauriConfig.productName}_${version}_x64-${edition}-setup.exe`;
  const installers = marker.artifacts.filter(({ path: filename }) => filename.endsWith(".exe"));
  requireValue(
    installers.length === 1 && path.basename(installers[0].path) === installerName,
    "Expected exactly one current-version edition NSIS installer",
  );
  const installer = installers[0];
  requireValue(
    artifactPaths.has(`${installer.path}.sig`.toLowerCase()),
    "NSIS installer is missing its updater signature",
  );
  for (const artifact of marker.artifacts.filter(({ path: filename }) =>
    /\.(exe|msi)$/.test(filename),
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
  const productVersion = await readProductVersion(path.join(directory, installer.path));
  assertWindowsInstallerProductVersion(productVersion, version);
  const {
    count: nsisResources,
    config: editionConfig,
    executablePath,
  } = await verifyResourceTable(root, edition, catalog);
  const compiledPins = await readCompiledPins(executablePath);
  assertCompiledEditionPins(compiledPins, {
    catalog,
    catalogSha256: marker.catalogSha256,
    edition,
    applicationVersion: version,
  });
  if (edition === "offline")
    assertOfflineSuiteReceipt(
      await readJson(path.join(directory, "offline-components.json"), root),
      {
        catalog,
        catalogSha256: marker.catalogSha256,
        artifacts: marker.artifacts,
        applicationVersion: version,
      },
    );
  const executable = {
    path: path.relative(root, executablePath).replaceAll(path.sep, "/"),
    size: (await regularFile(executablePath, root)).size,
    sha256: await componentFileSha256(executablePath),
    compiledPinsVerified: true,
  };
  const sourceFreshness = hasSourceRecord
    ? await assertEditionBuildSourceFreshness(await readJson(sourceRecordPath, root), {
        root,
        edition,
        applicationVersion: version,
        executablePath,
      })
    : { sourceFreshnessVerified: false, sourceFingerprint: null, sourceFileCount: 0 };
  const channel = edition === "online" ? `${COMPONENT_PLATFORM}-online` : COMPONENT_PLATFORM;
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
  let archiveBytes = 0;
  for (const component of catalog.components) {
    const filename = path.join(
      root,
      ".cache/runtime-components/packages",
      `${component.archive.sha256}.zip`,
    );
    const info = await regularFile(filename, root);
    requireValue(
      info.size === component.archive.size &&
        (await componentFileSha256(filename)) === component.archive.sha256,
      `Component archive hash/size mismatch: ${component.id}`,
    );
    archiveBytes += info.size;
  }
  if (edition === "online") {
    const signature = (
      await readFile(path.join(directory, `${installer.path}.sig`), "utf8")
    ).trim();
    verifyOnlineFeed(await readJson(path.join(directory, "latest.json"), root), {
      version,
      installer,
      signature,
      baseUrl,
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
        "catalogSha256",
        "feed",
        "artifacts",
        "componentArchives",
      ],
      "Publish manifest",
    );
    requireValue(
      publish.schemaVersion === 1 &&
        publish.edition === edition &&
        publish.applicationVersion === version &&
        publish.platform === COMPONENT_PLATFORM &&
        publish.channel === channel &&
        publish.catalogSha256 === marker.catalogSha256,
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
      requireValue(
        artifact.path === expected.path &&
          artifact.size === expected.size &&
          artifact.sha256 === expected.sha256 &&
          artifact.localPath === path.join(directory, expected.path) &&
          artifact.objectKey ===
            tosUpdatesObjectKey(`${channel}/${path.basename(expected.path)}`) &&
          artifact.url === `${baseUrl}/${encodeURIComponent(path.basename(expected.path))}`,
        "Publish artifact identity/path/channel mismatch",
      );
    }
    requireValue(
      Array.isArray(publish.componentArchives) &&
        publish.componentArchives.length === catalog.components.length,
      "Publish component archive count mismatch",
    );
    for (const [index, archive] of publish.componentArchives.entries()) {
      exactKeys(
        archive,
        ["id", "localPath", "format", "url", "size", "sha256"],
        "Publish component archive",
      );
      const expected = catalog.components[index];
      requireValue(
        archive.id === expected.id &&
          archive.localPath ===
            path.join(
              root,
              ".cache/runtime-components/packages",
              `${expected.archive.sha256}.zip`,
            ) &&
          Object.entries(expected.archive).every(([key, value]) => archive[key] === value),
        "Publish component archive does not match trusted catalog/cache identity",
      );
    }
  }
  return {
    schemaVersion: 1,
    verified: true,
    edition,
    applicationVersion: version,
    platform: COMPONENT_PLATFORM,
    channel,
    catalogSha256: marker.catalogSha256,
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
    nsisResourceCount: nsisResources,
    componentArchiveCount: catalog.components.length,
    componentArchiveBytes: archiveBytes,
    publishManifestVerified: edition === "online",
    offlineSuiteVerified: edition === "offline",
    offlineArchiveCount: edition === "offline" ? OFFLINE_ARCHIVE_IDS.length : 0,
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
