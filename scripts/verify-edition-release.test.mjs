import assert from "node:assert/strict";
import { copyFile, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertCompiledEditionPins,
  assertEditionCatalog,
  assertOfflineSuiteReceipt,
  parseCompiledEditionPinsOutput,
  parseEditionVerificationArgs,
  verifyEditionRelease,
} from "./verify-edition-release.mjs";
import {
  buildRuntimeComponentCatalog,
  COMPONENT_FEATURES,
  COMPONENT_PLATFORM,
  COMPONENT_REPO_ROOT,
  componentBytesSha256,
  componentFileSha256,
  RUNTIME_COMPONENTS,
  runtimeComponentArchiveUrl,
} from "./runtime-component-catalog.mjs";
import { buildLatestManifest } from "./write-latest-json.mjs";
import { tosUpdatesObjectKey, tosUpdatesPublicBaseUrl } from "./tos-updates-config.mjs";
import {
  collectEditionSourceFingerprint,
  createEditionBuildSource,
} from "./edition-source-fingerprint.mjs";

const VERSION = "0.2.1";
async function writeJson(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, JSON.stringify(value, null, 2) + "\n");
}

async function fixture(t, edition = "online", target = "") {
  const root = await mkdtemp(path.join(os.tmpdir(), "ic-edition-verification-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const components = [];
  const nativeManifests = new Map();
  const packageDirectory = path.join(root, ".cache/runtime-components/packages");
  await mkdir(packageDirectory, { recursive: true });
  for (const definition of RUNTIME_COMPONENTS) {
    const license = Buffer.from(`License ${definition.id}`);
    const isAi = ["ai-media-runtime", "ai-media-quality-runtime"].includes(definition.id);
    const inventoryBytes = Buffer.from(
      JSON.stringify([
        {
          path: "LICENSE.txt",
          type: "file",
          size: license.length,
          sha256: componentBytesSha256(license),
        },
      ]),
    );
    const manifest = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        component: definition.id,
        ...(isAi
          ? {
              inventory: {
                path: "files-manifest.json",
                sha256: componentBytesSha256(inventoryBytes),
                count: 1,
              },
            }
          : {}),
      }),
    );
    nativeManifests.set(definition.id, manifest);
    const files = [
      {
        path: definition.manifestPath,
        size: manifest.length,
        sha256: componentBytesSha256(manifest),
        mode: 0o644,
      },
      {
        path: "LICENSE.txt",
        size: license.length,
        sha256: componentBytesSha256(license),
        mode: 0o644,
      },
    ];
    if (isAi)
      files.push({
        path: "files-manifest.json",
        size: inventoryBytes.length,
        sha256: componentBytesSha256(inventoryBytes),
        mode: 0o644,
      });
    const archiveBytes = Buffer.from(`Fixture archive ${definition.id}`);
    const archiveSha256 = componentBytesSha256(archiveBytes);
    await writeFile(path.join(packageDirectory, `${archiveSha256}.zip`), archiveBytes);
    components.push({
      id: definition.id,
      title: definition.title,
      description: definition.description,
      version: "1.0.0",
      manifestPath: definition.manifestPath,
      manifestSha256: componentBytesSha256(manifest),
      bundlePath: definition.bundlePath,
      dependencies: [...definition.dependencies],
      files,
      archive: {
        format: "zip",
        size: archiveBytes.length,
        sha256: archiveSha256,
        url: runtimeComponentArchiveUrl(definition.id, archiveSha256, {
          applicationVersion: VERSION,
        }),
      },
    });
  }
  const catalog = buildRuntimeComponentCatalog({ applicationVersion: VERSION, components });
  const catalogPath = path.join(root, "src-tauri/resources/component-catalog.json");
  await writeJson(catalogPath, catalog);
  const catalogSha256 = await componentFileSha256(catalogPath);
  const tauriConfig = {
    version: VERSION,
    productName: "无限画布",
    plugins: {
      updater: {
        pubkey: "synthetic test public key",
        endpoints: [`${tosUpdatesPublicBaseUrl()}/{{target}}-{{arch}}/latest.json`],
      },
    },
  };
  await writeJson(path.join(root, "package.json"), { version: VERSION });
  await writeJson(path.join(root, "src-tauri/tauri.conf.json"), tauriConfig);
  const editionConfigPath = path.join(root, `src-tauri/tauri.${edition}.conf.json`);
  await copyFile(
    path.join(COMPONENT_REPO_ROOT, `src-tauri/tauri.${edition}.conf.json`),
    editionConfigPath,
  );
  const editionConfig = JSON.parse(await readFile(editionConfigPath));
  const targetDirectory = path.join(root, ".cache/tauri-editions", edition, "target");
  await writeJson(path.join(targetDirectory, "distribution.json"), {
    schemaVersion: 1,
    applicationVersion: VERSION,
    edition,
    platform: COMPONENT_PLATFORM,
  });
  const releaseDirectory = path.join(targetDirectory, target, "release");
  const executablePath = path.join(releaseDirectory, "infinite-canvas.exe");
  await mkdir(releaseDirectory, { recursive: true });
  await writeFile(executablePath, "compiled release executable fixture");
  const resourcePaths = [];
  for (const [source, destination] of Object.entries(editionConfig.bundle.resources)) {
    if (source === "resources/component-catalog.json") resourcePaths.push(destination);
    else {
      const component = components.find(({ bundlePath }) => `${bundlePath}/` === destination);
      if (component)
        resourcePaths.push(
          ...component.files.map(({ path: filename }) => `${destination}${filename}`),
        );
      else {
        await mkdir(path.join(root, "src-tauri", source), { recursive: true });
        await writeFile(
          path.join(root, "src-tauri", source, "SKILL.md"),
          "packaged skill documentation",
        );
        resourcePaths.push(`${destination}SKILL.md`);
      }
    }
  }
  const nsisPath = path.join(releaseDirectory, "nsis/x64/installer.nsi");
  const script = [
    `!define MAINBINARYNAME "infinite-canvas"`,
    `!define MAINBINARYSRCPATH "${executablePath}"`,
    '  File "${MAINBINARYSRCPATH}"',
    ...resourcePaths.map(
      (filename) => `File /a "/oname=${filename.replaceAll("/", "\\")}" "fixture source"`,
    ),
  ].join("\n");
  await mkdir(path.dirname(nsisPath), { recursive: true });
  await writeFile(nsisPath, script);
  const distributionDirectory = path.join(
    root,
    ".cache/tauri-editions",
    edition,
    "artifacts",
    VERSION,
  );
  const installerName = `无限画布_${VERSION}_x64-${edition}-setup.exe`;
  const installerPath = `nsis/${installerName}`;
  await mkdir(path.join(distributionDirectory, "nsis"), { recursive: true });
  await writeFile(path.join(distributionDirectory, installerPath), "signed NSIS installer fixture");
  await writeFile(path.join(distributionDirectory, `${installerPath}.sig`), "signature fixture\n");
  const artifacts = [];
  for (const filename of [installerPath, `${installerPath}.sig`]) {
    const bytes = await readFile(path.join(distributionDirectory, filename));
    artifacts.push({ path: filename, size: bytes.length, sha256: componentBytesSha256(bytes) });
  }
  if (edition === "offline") {
    const receiptComponents = [];
    await mkdir(path.join(distributionDirectory, "components"));
    for (const id of ["ai-media-runtime", "ai-media-quality-runtime"]) {
      const component = components.find((entry) => entry.id === id);
      const relative = `components/${id}-${component.archive.sha256}.zip`;
      await copyFile(
        path.join(packageDirectory, `${component.archive.sha256}.zip`),
        path.join(distributionDirectory, relative),
      );
      artifacts.push({
        path: relative,
        size: component.archive.size,
        sha256: component.archive.sha256,
      });
      receiptComponents.push({
        id,
        path: relative,
        size: component.archive.size,
        sha256: component.archive.sha256,
        manifestPath: component.manifestPath,
        manifestSha256: component.manifestSha256,
        nativeManifestBase64: nativeManifests.get(id).toString("base64"),
      });
    }
    await writeJson(path.join(distributionDirectory, "offline-components.json"), {
      schemaVersion: 1,
      applicationVersion: VERSION,
      edition: "offline",
      platform: COMPONENT_PLATFORM,
      catalogSha256,
      components: receiptComponents,
    });
  }
  const markerPath = path.join(distributionDirectory, "distribution.json");
  const marker = {
    schemaVersion: 1,
    applicationVersion: VERSION,
    edition,
    platform: COMPONENT_PLATFORM,
    catalogSha256,
    artifacts,
  };
  await writeJson(markerPath, marker);
  const channel = `${COMPONENT_PLATFORM}${edition === "online" ? "-online" : ""}`;
  const baseUrl = `${tosUpdatesPublicBaseUrl()}/${channel}`;
  if (edition === "online") {
    await writeJson(
      path.join(distributionDirectory, "latest.json"),
      buildLatestManifest({
        version: VERSION,
        pubDate: "2026-10-07T03:00:00.000Z",
        notes: "fixture",
        platforms: {
          [COMPONENT_PLATFORM]: {
            url: `${baseUrl}/${encodeURIComponent(installerName)}`,
            signature: "signature fixture",
          },
        },
      }),
    );
    await writeJson(path.join(distributionDirectory, "publish-manifest.json"), {
      schemaVersion: 1,
      edition,
      applicationVersion: VERSION,
      platform: COMPONENT_PLATFORM,
      channel,
      catalogSha256,
      feed: {
        localPath: path.join(distributionDirectory, "latest.json"),
        objectKey: tosUpdatesObjectKey(`${channel}/latest.json`),
        url: `${baseUrl}/latest.json`,
      },
      artifacts: artifacts.map((artifact) => ({
        ...artifact,
        localPath: path.join(distributionDirectory, artifact.path),
        objectKey: tosUpdatesObjectKey(`${channel}/${path.basename(artifact.path)}`),
        url: `${baseUrl}/${encodeURIComponent(path.basename(artifact.path))}`,
      })),
      componentArchives: components.map((component) => ({
        id: component.id,
        localPath: path.join(packageDirectory, `${component.archive.sha256}.zip`),
        ...component.archive,
      })),
    });
  }
  const pins = {
    schemaVersion: 1,
    applicationVersion: VERSION,
    edition,
    catalogSha256,
    manifestPins: Object.fromEntries(
      components.map(({ id, manifestSha256 }) => [id, manifestSha256]),
    ),
  };
  const calls = { pins: [], signatures: [] };
  const options = {
    root,
    distributionDirectory,
    readCompiledPins: (filename) => {
      calls.pins.push(filename);
      assert.equal(filename, executablePath);
      return structuredClone(pins);
    },
    readProductVersion: (filename) => {
      assert.equal(filename, path.join(distributionDirectory, installerPath));
      return VERSION;
    },
    verifySignature: (filename, signaturePath, key) => {
      calls.signatures.push(filename);
      assert.equal(signaturePath, `${filename}.sig`);
      assert.equal(key, tauriConfig.plugins.updater.pubkey);
    },
  };
  return {
    root,
    catalog,
    catalogPath,
    pins,
    calls,
    options,
    marker,
    markerPath,
    nsisPath,
    script,
    executablePath,
    distributionDirectory,
    targetDirectory,
    editionConfigPath,
    installerPath,
    packageDirectory,
  };
}

async function addSourceRecord(value) {
  for (const relative of [
    "pnpm-lock.yaml",
    "index.html",
    "tsconfig.json",
    "tsconfig.node.json",
    "vite.config.ts",
    "src-tauri/build.rs",
    "src-tauri/Cargo.toml",
    "src-tauri/Cargo.lock",
    "src/main.ts",
    "src-tauri/src/lib.rs",
  ]) {
    const filename = path.join(value.root, relative);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, "synthetic compilation input");
  }
  const snapshot = await collectEditionSourceFingerprint({
    root: value.root,
    edition: value.marker.edition,
  });
  const record = await createEditionBuildSource({
    snapshot,
    executablePath: value.executablePath,
    root: value.root,
  });
  await writeJson(path.join(value.distributionDirectory, "build-source.json"), record);
  return record;
}

test("online hand-off verifies the exact release executable's seven pins, signatures, channel, archives and NSIS file table", async (t) => {
  const value = await fixture(t);
  const report = await verifyEditionRelease(value.options);
  assert.equal(report.verified, true);
  assert.equal(report.edition, "online");
  assert.equal(report.componentArchiveCount, 7);
  assert.equal(report.executable.compiledPinsVerified, true);
  assert.equal(report.executable.sha256, await componentFileSha256(value.executablePath));
  assert.deepEqual(value.calls.pins, [value.executablePath]);
  assert.equal(value.calls.signatures.length, 1);
  assert.equal(report.channel, "windows-x86_64-online");
  assert.equal(report.nsisResourceCount, 5);
  assert.equal(report.sourceFreshnessVerified, false);
});

test("publishing requires source provenance while ordinary verification remains compatible with older hand-offs", async (t) => {
  const value = await fixture(t);
  await assert.rejects(
    verifyEditionRelease({ ...value.options, requireSourceFreshness: true }),
    /requires a build-source.json/,
  );
  const record = await addSourceRecord(value);
  const report = await verifyEditionRelease({ ...value.options, requireSourceFreshness: true });
  assert.equal(report.sourceFreshnessVerified, true);
  assert.equal(report.sourceFingerprint, record.sourceFingerprint);
  assert.equal(report.sourceFileCount, record.sourceFiles.length);
  await writeFile(path.join(value.root, "src/main.ts"), "new Seedance feature after this build");
  await assert.rejects(verifyEditionRelease(value.options), /source freshness failed/);
});

test("offline provenance supports explicit target layout and rejects native rebinding and nonregular metadata", async (t) => {
  const value = await fixture(t, "offline", "x86_64-pc-windows-msvc");
  const record = await addSourceRecord(value);
  assert.equal(
    (await verifyEditionRelease({ ...value.options, requireSourceFreshness: true }))
      .sourceFreshnessVerified,
    true,
  );
  const filename = path.join(value.distributionDirectory, "build-source.json");
  await writeJson(filename, {
    ...record,
    nativeExecutable: { ...record.nativeExecutable, sha256: "f".repeat(64) },
  });
  await assert.rejects(verifyEditionRelease(value.options), /different native executable/);
  await rm(filename);
  await mkdir(filename);
  await assert.rejects(verifyEditionRelease(value.options), /regular file/);
});

test("offline and explicit Windows target layouts verify the matching native executable without online feed metadata", async (t) => {
  const value = await fixture(t, "offline", "x86_64-pc-windows-msvc");
  const report = await verifyEditionRelease(value.options);
  assert.equal(report.edition, "offline");
  assert.equal(report.publishManifestVerified, false);
  assert.equal(report.nsisResourceCount, 13);
  assert.equal(report.offlineSuiteVerified, true);
  assert.equal(report.offlineArchiveCount, 2);
  assert.equal(report.artifactCount, 4);
  assert.equal(value.calls.signatures.length, 1);
  assert.match(report.executable.path, /x86_64-pc-windows-msvc\/release\/infinite-canvas\.exe$/);
});

test("offline suite rejects missing, corrupt and extra component archives while online rejects all ZIP artifacts", async (t) => {
  const value = await fixture(t, "offline");
  const zip = value.marker.artifacts.find((artifact) => artifact.path.endsWith(".zip"));
  const filename = path.join(value.distributionDirectory, zip.path);
  const original = await readFile(filename);
  await rm(filename);
  await assert.rejects(verifyEditionRelease(value.options), /ENOENT/);
  await writeFile(filename, "corrupt archive");
  await assert.rejects(verifyEditionRelease(value.options), /Artifact hash\/size mismatch/);
  await writeFile(filename, original);
  const extra = Buffer.from("extra component ZIP");
  const extraArtifact = {
    path: "components/extra-runtime.zip",
    size: extra.length,
    sha256: componentBytesSha256(extra),
  };
  await writeFile(path.join(value.distributionDirectory, extraArtifact.path), extra);
  await writeJson(value.markerPath, {
    ...value.marker,
    artifacts: [...value.marker.artifacts, extraArtifact],
  });
  await assert.rejects(verifyEditionRelease(value.options), /exactly the two AI/);
  const online = await fixture(t, "online");
  await writeFile(path.join(online.distributionDirectory, "extra.zip"), extra);
  await writeJson(online.markerPath, {
    ...online.marker,
    artifacts: [...online.marker.artifacts, { ...extraArtifact, path: "extra.zip" }],
  });
  await assert.rejects(
    verifyEditionRelease(online.options),
    /Invalid or duplicate distribution artifact/,
  );
});

test("offline receipt binds relative paths, catalog/version, exact native bytes and inventory recipe", async (t) => {
  const value = await fixture(t, "offline");
  const filename = path.join(value.distributionDirectory, "offline-components.json");
  const original = JSON.parse(await readFile(filename));
  for (const change of [{ catalogSha256: "0".repeat(64) }, { applicationVersion: "0.2.0" }]) {
    await writeJson(filename, { ...original, ...change });
    await assert.rejects(verifyEditionRelease(value.options), /Offline receipt catalog\/version/);
  }
  for (const change of [
    { path: path.join(value.root, "external.zip") },
    { manifestSha256: "f".repeat(64) },
    { sha256: "f".repeat(64) },
  ]) {
    const receipt = structuredClone(original);
    Object.assign(receipt.components[0], change);
    await writeJson(filename, receipt);
    await assert.rejects(verifyEditionRelease(value.options), /Offline archive identity/);
  }
  const receipt = structuredClone(original);
  receipt.components[0].nativeManifestBase64 += "\n";
  await writeJson(filename, receipt);
  await assert.rejects(verifyEditionRelease(value.options), /hash\/encoding mismatch/);
  receipt.components[0].nativeManifestBase64 = Buffer.from(
    '{"schemaVersion":1,"component":"ai-media-runtime"}',
  ).toString("base64");
  await writeJson(filename, receipt);
  await assert.rejects(verifyEditionRelease(value.options), /hash\/encoding mismatch/);
  const wrongRecipe = structuredClone(original);
  const wrongCatalog = structuredClone(value.catalog);
  const native = JSON.parse(Buffer.from(wrongRecipe.components[0].nativeManifestBase64, "base64"));
  native.inventory.path = "../wrong-inventory.json";
  const bytes = Buffer.from(JSON.stringify(native));
  const hash = componentBytesSha256(bytes);
  wrongRecipe.components[0].nativeManifestBase64 = bytes.toString("base64");
  wrongRecipe.components[0].manifestSha256 = hash;
  const component = wrongCatalog.components.find(({ id }) => id === "ai-media-runtime");
  component.manifestSha256 = hash;
  Object.assign(
    component.files.find((file) => file.path === component.manifestPath),
    { size: bytes.length, sha256: hash },
  );
  assert.throws(
    () =>
      assertOfflineSuiteReceipt(wrongRecipe, {
        catalog: wrongCatalog,
        catalogSha256: value.marker.catalogSha256,
        artifacts: value.marker.artifacts,
        applicationVersion: VERSION,
      }),
    /native manifest inventory/,
  );
});

test("stale native edition, app version, catalog hash and any component manifest pin fail closed", async (t) => {
  const value = await fixture(t);
  for (const change of [
    { edition: "offline" },
    { applicationVersion: "0.2.0" },
    { catalogSha256: "0".repeat(64) },
  ]) {
    await assert.rejects(
      verifyEditionRelease({
        ...value.options,
        readCompiledPins: () => ({ ...value.pins, ...change }),
      }),
      /Executable edition\/version\/catalog SHA/,
    );
  }
  for (const { id } of RUNTIME_COMPONENTS)
    await assert.rejects(
      verifyEditionRelease({
        ...value.options,
        readCompiledPins: () => ({
          ...value.pins,
          manifestPins: { ...value.pins.manifestPins, [id]: "f".repeat(64) },
        }),
      }),
      new RegExp(`manifest pin is stale or mismatched: ${id}`),
    );
  const missing = structuredClone(value.pins);
  delete missing.manifestPins["pose-runtime"];
  assert.throws(
    () =>
      assertCompiledEditionPins(missing, {
        catalog: value.catalog,
        catalogSha256: value.pins.catalogSha256,
        edition: "online",
        applicationVersion: VERSION,
      }),
    /Compiled manifest pins/,
  );
});

test("NSIS must embed the exact executable chosen for pin inspection, and parallel target scripts are ambiguous", async (t) => {
  const value = await fixture(t);
  await writeFile(
    value.nsisPath,
    value.script.replace(value.executablePath, path.join(value.root, "old/infinite-canvas.exe")),
  );
  await assert.rejects(verifyEditionRelease(value.options), /NSIS recipe does not embed/);
  await writeFile(value.nsisPath, value.script);
  const duplicate = path.join(
    value.targetDirectory,
    "x86_64-pc-windows-gnu/release/nsis/x64/installer.nsi",
  );
  await mkdir(path.dirname(duplicate), { recursive: true });
  await writeFile(duplicate, value.script);
  await assert.rejects(verifyEditionRelease(value.options), /exactly one release NSIS script/);
});

test("catalog/output drift, unknown artifact files and failed updater signature are rejected", async (t) => {
  const value = await fixture(t);
  await writeFile(path.join(value.distributionDirectory, "unexpected.txt"), "unregistered");
  await assert.rejects(verifyEditionRelease(value.options), /unregistered files/);
  await rm(path.join(value.distributionDirectory, "unexpected.txt"));
  await assert.rejects(
    verifyEditionRelease({
      ...value.options,
      verifySignature: () => {
        throw new Error("signature mismatch");
      },
    }),
    /signature mismatch/,
  );
  await writeJson(value.catalogPath, {
    ...value.catalog,
    features: COMPONENT_FEATURES,
    components: value.catalog.components.map((component, index) =>
      index === 0 ? { ...component, version: "2.0.0" } : component,
    ),
  });
  await assert.rejects(verifyEditionRelease(value.options), /catalog hash is stale/);
});

test("online updater and publish plan cannot point to the legacy shared/offline channel", async (t) => {
  const value = await fixture(t);
  const latestPath = path.join(value.distributionDirectory, "latest.json");
  const latest = JSON.parse(await readFile(latestPath));
  latest.platforms[COMPONENT_PLATFORM].url = latest.platforms[COMPONENT_PLATFORM].url.replace(
    "windows-x86_64-online",
    "windows-x86_64",
  );
  await writeJson(latestPath, latest);
  await assert.rejects(verifyEditionRelease(value.options), /independent channel/);
});

test("archive corruption and root junctions are detected without resolving external release data", async (t) => {
  const value = await fixture(t);
  const archivePath = path.join(
    value.packageDirectory,
    `${value.catalog.components[0].archive.sha256}.zip`,
  );
  await writeFile(archivePath, "corrupt ZIP");
  await assert.rejects(verifyEditionRelease(value.options), /archive hash\/size mismatch/);
  const external = path.join(value.root, "external");
  await mkdir(external);
  await rm(value.distributionDirectory, { recursive: true });
  await symlink(
    external,
    value.distributionDirectory,
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(verifyEditionRelease(value.options), /materialized/);
});

test("compiled pin CLI output requires one explicit v1 record and cannot fall back to old four-component CLI", () => {
  const pins = { schemaVersion: 1 };
  assert.deepEqual(
    parseCompiledEditionPinsOutput(
      `banner\nIC_COMPONENT_CATALOG_PINS_V1 ${JSON.stringify(pins)}\r\n`,
    ),
    pins,
  );
  assert.throws(
    () => parseCompiledEditionPinsOutput("IC_RUNTIME_COMPONENT_PINS_V1 {}\n"),
    /exactly one/,
  );
  assert.throws(
    () =>
      parseCompiledEditionPinsOutput(
        "IC_COMPONENT_CATALOG_PINS_V1 {}\nIC_COMPONENT_CATALOG_PINS_V1 {}",
      ),
    /exactly one/,
  );
  assert.throws(
    () => parseCompiledEditionPinsOutput("IC_COMPONENT_CATALOG_PINS_V1 not-json"),
    SyntaxError,
  );
});

test("catalog schema/path/channel identities and verification directory are strict", async (t) => {
  const value = await fixture(t);
  const wrongCatalog = structuredClone(value.catalog);
  wrongCatalog.components[0].files[0].path = "../outside";
  assert.throws(
    () => assertEditionCatalog(wrongCatalog, VERSION),
    /Invalid or duplicate component file/,
  );
  const wrongArchive = structuredClone(value.catalog);
  wrongArchive.components[0].archive.url = "https://example.com/blender.zip";
  assert.throws(() => assertEditionCatalog(wrongArchive, VERSION), /trusted content-addressed URL/);
  await assert.rejects(
    verifyEditionRelease({
      ...value.options,
      distributionDirectory: path.join(value.root, "other"),
    }),
    /exact edition\/version/,
  );
  assert.deepEqual(
    parseEditionVerificationArgs([
      "--distribution-dir",
      ".cache/tauri-editions/online/artifacts/0.2.1",
    ]),
    { distributionDirectory: ".cache/tauri-editions/online/artifacts/0.2.1" },
  );
  assert.throws(
    () => parseEditionVerificationArgs(["--distribution-dir", "x", "--skip-pins"]),
    /Usage/,
  );
});
