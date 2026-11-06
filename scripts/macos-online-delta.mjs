import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { inventoryMacApp, MAC_DELTA_OBJECT_BASE_URL, stageMacDelta, validateMacDeltaManifest } from "./mac-delta-manifest.mjs";
import { requestOnlineObject } from "./online-update-transport.mjs";
import { compareReleaseVersions, inventoryMacFullArchive, verifyStagedMacDeltaRelease } from "./publish-tos-updates.mjs";
import { resolveResourceManifestSignerEnv } from "./runtime-resource-release.mjs";
import { assertComponentRoot, COMPONENT_REPO_ROOT, componentBytesSha256, componentFileSha256 } from "./runtime-resources.mjs";
import { tosUpdatesObjectKey, tosUpdatesPublicBaseUrl } from "./tos-updates-config.mjs";
import { verifyMacNativeApp } from "./verify-macos-edition.mjs";
import { verifyUpdaterSignature, verifyUpdaterSignatureBytes } from "./verify-updater-signature.mjs";

const run = promisify(execFile);
const platform = "darwin-aarch64";
const appName = "无限画布.app";
const versionPattern = /^\d+\.\d+\.\d+$/;
const maxArchiveBytes = 2 * 1024 ** 3;
const maxDeltaBytes = 400_000_000;
const baseUrl = tosUpdatesPublicBaseUrl();

export function macOnlineDeltaManifestUrl(version) {
  assert(versionPattern.test(version), "Invalid macOS delta version");
  return `${baseUrl}/mac-delta/${version}/${platform}/manifest.json`;
}

function archiveUrl(version) {
  assert(versionPattern.test(version), "Invalid macOS archive version");
  return `${baseUrl}/${platform}-online/${encodeURIComponent(`无限画布_${version}_aarch64-online.app.tar.gz`)}`;
}

async function readPublic(url, maxBytes) {
  const response = await requestOnlineObject({ url, maxBytes, headers: { "cache-control": "no-cache" } });
  assert.equal(response.status, 200, `Could not read public macOS release input (HTTP ${response.status})`);
  return response.body;
}

async function readPublishedArchive(version) {
  const url = archiveUrl(version);
  return { version, url, signature: (await readPublic(`${url}.sig`)).toString("utf8").trim() };
}

async function downloadArchive(source, filename) {
  assert.equal(source.url, archiveUrl(source.version));
  await run("/usr/bin/curl", [
    "--fail", "--silent", "--show-error", "--retry", "3", "--max-time", "600",
    "--max-filesize", String(maxArchiveBytes), "--output", filename, source.url,
  ], { timeout: 15 * 60_000 });
  assert((await stat(filename)).size <= maxArchiveBytes, "macOS updater archive exceeds the release budget");
  await writeFile(`${filename}.sig`, source.signature);
  return filename;
}

async function unpackSignedArchive(archive, directory, pubkey) {
  await verifyUpdaterSignature(archive, `${archive}.sig`, pubkey);
  await inventoryMacFullArchive(archive, appName);
  await mkdir(directory);
  await run("/usr/bin/tar", ["-xpf", archive, "-C", directory], { timeout: 120_000 });
  return path.join(directory, appName);
}

async function verifyReconstruction(baseApp, stage, rebuilt, config) {
  await mkdir(rebuilt);
  for (const entry of stage.manifest.files) {
    const destination = path.join(rebuilt, entry.path);
    if (entry.kind === "dir") await mkdir(destination);
    else if (entry.kind === "symlink") await symlink(entry.target, destination);
    else {
      const source = entry.source === "base" ? path.join(baseApp, entry.path) : path.join(stage.objectDir, entry.sha256);
      await copyFile(source, destination);
      await chmod(destination, entry.mode);
    }
  }
  for (const entry of [...stage.manifest.files].reverse()) {
    if (entry.kind === "dir") await chmod(path.join(rebuilt, entry.path), entry.mode);
  }
  assert.deepEqual(await inventoryMacApp(rebuilt), stage.manifest.files.map(({ source: _source, ...entry }) => entry));
  const prefix = "Contents/Resources/";
  const expectedResources = stage.manifest.files
    .filter((entry) => entry.kind === "file" && entry.path.startsWith(prefix))
    .map((entry) => ({ ...entry, path: entry.path.slice(prefix.length) }));
  await verifyMacNativeApp(rebuilt, {
    applicationVersion: stage.manifest.version, platform, identifier: config.identifier, expectedResources,
  });
}

async function signManifest(root, manifestPath) {
  const env = resolveResourceManifestSignerEnv(process.env, path.join(root, "src-tauri/.updater-key"));
  env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= "";
  try {
    await run(process.execPath, [path.join(root, "node_modules/@tauri-apps/cli/tauri.js"), "signer", "sign", manifestPath],
      { cwd: root, env, timeout: 30_000, maxBuffer: 64 * 1024 });
  } catch {
    throw new Error("macOS delta manifest signing failed");
  }
}

async function buildDelta({ root, directory, baseline, version, targetArchive, existingSignature }) {
  assert(versionPattern.test(baseline.version) && versionPattern.test(version) &&
    compareReleaseVersions(baseline.version, version) < 0, "macOS delta requires a newer version than its signed baseline");
  const config = JSON.parse(await readFile(path.join(root, "src-tauri/tauri.conf.json"), "utf8"));
  const pubkey = config.plugins.updater.pubkey;
  const baseArchive = await downloadArchive(baseline, path.join(directory, "base.app.tar.gz"));
  const [baseApp, targetApp] = await Promise.all([
    unpackSignedArchive(baseArchive, path.join(directory, "base"), pubkey),
    unpackSignedArchive(targetArchive, path.join(directory, "target"), pubkey),
  ]);
  const stage = await stageMacDelta({
    baseAppDir: baseApp, targetAppDir: targetApp, baseVersion: baseline.version, version,
    outDir: path.join(directory, "delta"),
  });
  const fullArchiveBytes = (await stat(targetArchive)).size;
  const transferBytes = stage.changedBytes + (await stat(stage.manifestPath)).size;
  assert(transferBytes < fullArchiveBytes && transferBytes < maxDeltaBytes,
    `macOS delta is too large (${transferBytes} bytes); the online feed was not changed`);
  if (existingSignature) await writeFile(`${stage.manifestPath}.sig`, existingSignature);
  else await signManifest(root, stage.manifestPath);
  const verified = await verifyStagedMacDeltaRelease({
    manifestPath: stage.manifestPath, version, expectedObjectBaseUrl: MAC_DELTA_OBJECT_BASE_URL,
    fullArchivePath: targetArchive, pubkey,
  });
  const rebuilt = path.join(directory, appName);
  await verifyReconstruction(baseApp, stage, rebuilt, config);
  return { ...verified, manifestPath: stage.manifestPath, transferBytes, fullArchiveBytes };
}

async function macDeltaWorkspace(root) {
  assert(process.platform === "darwin" && process.arch === "arm64", "Online macOS delta requires a native Apple Silicon build host");
  const parent = path.join(root, ".cache/macos-online-delta");
  await mkdir(parent, { recursive: true });
  await assertComponentRoot(parent, root);
  return mkdtemp(path.join(parent, "release-"));
}

export async function prepareMacOnlineDelta(plan) {
  const targetFeed = JSON.parse(plan.feedBody);
  const previousBody = await readPublic(plan.feed.url);
  const previousFeed = JSON.parse(previousBody);
  const directory = await macDeltaWorkspace(plan.root);
  const dispose = () => rm(directory, { recursive: true, force: true });
  try {
    const version = plan.applicationVersion;
    const previousRelease = previousFeed.platforms?.[platform];
    let baseline = { version: previousFeed.version, url: previousRelease?.url, signature: previousRelease?.signature };
    let existingSignature;
    if (previousFeed.version === version) {
      const { macDeltaManifest, ...publishedTarget } = previousFeed;
      assert.deepEqual(publishedTarget, targetFeed, "Published macOS version belongs to a different artifact");
      assert.equal(macDeltaManifest?.url, macOnlineDeltaManifestUrl(version), "macOS delta publication requires a newer version");
      const bytes = await readPublic(macDeltaManifest.url, 16 * 1024 ** 2);
      const config = JSON.parse(await readFile(path.join(plan.root, "src-tauri/tauri.conf.json"), "utf8"));
      verifyUpdaterSignatureBytes(bytes, macDeltaManifest.signature, config.plugins.updater.pubkey);
      const manifest = JSON.parse(bytes);
      validateMacDeltaManifest(manifest);
      assert.equal(manifest.version, version);
      baseline = await readPublishedArchive(manifest.baseVersion);
      existingSignature = macDeltaManifest.signature;
    }
    const targetArchive = plan.objects.find((entry) => entry.url === archiveUrl(version))?.localPath;
    assert(targetArchive, "macOS delta requires the verified native updater archive");
    const delta = await buildDelta({ root: plan.root, directory, baseline, version, targetArchive, existingSignature });
    const url = macOnlineDeltaManifestUrl(version);
    const feedBody = existingSignature ? previousBody : Buffer.from(`${JSON.stringify({
      ...targetFeed, macDeltaManifest: { url, signature: delta.signature },
    }, null, 2)}\n`);
    const feedFile = path.join(directory, "latest.json");
    await writeFile(feedFile, feedBody);
    const deltaObjects = delta.objects.map(({ sha256, size, sourcePath }) => ({
      objectKey: tosUpdatesObjectKey(`mac-delta/objects/${sha256}`),
      url: `${MAC_DELTA_OBJECT_BASE_URL}${sha256}`, size, sha256, localPath: sourcePath,
      contentType: "application/octet-stream",
    }));
    deltaObjects.push({
      objectKey: tosUpdatesObjectKey(`mac-delta/${version}/${platform}/manifest.json`),
      url, localPath: delta.manifestPath, contentType: "application/json",
      size: (await stat(delta.manifestPath)).size, sha256: await componentFileSha256(delta.manifestPath),
    });
    return {
      dispose,
      plan: {
        ...plan, deltaObjects, feedBody, requiredPreviousFeedSha256: componentBytesSha256(previousBody),
        feed: { ...plan.feed, localPath: feedFile, size: feedBody.length, sha256: componentBytesSha256(feedBody) },
        macDelta: { baseVersion: baseline.version, transferBytes: delta.transferBytes, fullArchiveBytes: delta.fullArchiveBytes },
      },
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [mode, baselineFeedSha256, version, ...extra] = process.argv.slice(2);
  assert(mode === "--verify-published" && /^[a-f0-9]{64}$/.test(baselineFeedSha256) && versionPattern.test(version) && extra.length === 0);
  const root = COMPONENT_REPO_ROOT;
  const directory = await macDeltaWorkspace(root);
  try {
    const feedUrl = `${baseUrl}/${platform}-online/latest.json`;
    const { macDeltaManifest: _delta, ...targetFeed } = JSON.parse(await readPublic(feedUrl));
    assert.equal(targetFeed.version, version, "The published target version has changed");
    const target = { version, ...targetFeed.platforms[platform] };
    const targetArchive = await downloadArchive(target, path.join(directory, "target.app.tar.gz"));
    const staged = await prepareMacOnlineDelta({
      root, applicationVersion: version, feedBody: Buffer.from(JSON.stringify(targetFeed)),
      feed: { url: `${baseUrl}/${platform}-online/backups/${baselineFeedSha256}.json` },
      objects: [{ url: target.url, localPath: targetArchive }],
    });
    try {
      assert.equal(staged.plan.requiredPreviousFeedSha256, baselineFeedSha256, "Baseline backup digest mismatch");
      console.log(JSON.stringify({
        version, ...staged.plan.macDelta, objectCount: staged.plan.deltaObjects.length - 1,
        reconstructionVerified: true, nativeCodeSignatureVerified: true,
      }, null, 2));
    } finally {
      await staged.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
