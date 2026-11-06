// Publish the signed update-only installer after an actual baseline upgrade.
import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertEditionBuildSourceFreshness } from "./edition-source-fingerprint.mjs";
import {
  publishVerifiedOnlinePlan,
  windowsOnlineUpdateName,
} from "./publish-online-updates.mjs";
import { readWindowsInstallerProductVersion } from "./publish-tos-updates.mjs";
import {
  assertComponentRoot,
  componentBytesSha256,
  componentFileSha256,
  COMPONENT_REPO_ROOT,
} from "./runtime-resources.mjs";
import { tosUpdatesObjectKey, tosUpdatesPublicBaseUrl } from "./tos-updates-config.mjs";
import { verifyUpdaterSignature } from "./verify-updater-signature.mjs";

const platform = "windows-x86_64";
const channel = `${platform}-online`;
const root = COMPONENT_REPO_ROOT;
const readJson = async (file) => JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));

assert.equal(process.platform, "win32");
assert(process.argv.slice(2).every((argument) => argument === "--dry-run") && process.argv.length <= 3);
const config = await readJson(path.join(root, "src-tauri/tauri.conf.json"));
const applicationVersion = config.version;
const name = windowsOnlineUpdateName(applicationVersion);
const directory = path.join(root, ".cache/tauri-editions/online/artifacts", applicationVersion);
const updateDirectory = path.join(directory, "windows-update");
await assertComponentRoot(updateDirectory, root);
const installer = path.join(updateDirectory, name);
const signature = installer + ".sig";
const receipt = await readJson(path.join(updateDirectory, "acceptance.json"));
const record = await readJson(path.join(directory, "build-source.json"));
const fullManifest = await readJson(path.join(directory, "publish-manifest.json"));
const fullEntry = fullManifest.artifacts.find((entry) => entry.path.endsWith("-online-setup.exe"));
assert(fullEntry, "Expected the signed full installer from the native build");
const fullInstaller = path.join(directory, "nsis", path.basename(fullEntry.path));
assert.match(receipt.baseline, /^\d+\.\d+\.\d+$/);
assert.equal(fullManifest.platform, platform);
assert.equal(fullManifest.applicationVersion, applicationVersion);
assert.equal(receipt.version, applicationVersion);
assert.equal(receipt.installExit, 0);
assert.equal(receipt.missingBaseExit, 2);
assert.equal(receipt.desktopStartupVerified, true);
assert(receipt.preservedResourceFiles > 0);
assert.equal(receipt.uninstallerPreserved, true);
assert.equal(receipt.reusedResourcesVerified, true);
assert.equal(receipt.installerSha256, await componentFileSha256(installer));
assert.equal(receipt.packageBytes, (await stat(installer)).size);
assert(receipt.packageBytes < fullEntry.size / 2, "The update must be substantially smaller than the full installer");
assert.equal(await componentFileSha256(fullInstaller), fullEntry.sha256);
const pubkey = config.plugins.updater.pubkey;
await verifyUpdaterSignature(fullInstaller, fullInstaller + ".sig", pubkey);

async function verifyRelease() {
  const provenance = await assertEditionBuildSourceFreshness(record, {
    root,
    edition: "online",
    applicationVersion,
    executablePath: path.join(root, record.nativeExecutable.path),
  });
  assert.equal(readWindowsInstallerProductVersion(installer), applicationVersion);
  await verifyUpdaterSignature(installer, signature, pubkey);
  const sha256 = await componentFileSha256(installer);
  assert.equal(sha256, receipt.installerSha256);
  return {
    verified: true, edition: "online", applicationVersion, platform, ...provenance,
    installer: { sha256, updaterSignatureVerified: true }, executable: record.nativeExecutable,
  };
}

const verification = await verifyRelease();
const location = (filename) => ({
  objectKey: tosUpdatesObjectKey(`${channel}/${filename}`),
  url: `${tosUpdatesPublicBaseUrl()}/${channel}/${encodeURIComponent(filename)}`,
});
const localObject = async (filename, contentType) => {
  const localPath = path.join(updateDirectory, filename);
  return { ...location(filename), localPath, contentType, size: (await stat(localPath)).size, sha256: await componentFileSha256(localPath) };
};
const feedPath = path.join(directory, "latest.json");
const fullFeed = await readJson(feedPath);
assert.equal(fullFeed.version, applicationVersion);
const feed = {
  ...fullFeed,
  notes: `无限画布 ${applicationVersion}。此增量更新适用于 ${receipt.baseline} 在线版。`,
  platforms: { [platform]: { url: location(name).url, signature: (await readFile(signature, "utf8")).trim() } },
};
const feedBody = Buffer.from(JSON.stringify(feed, null, 2) + "\n");
const localPath = path.join(updateDirectory, "latest.json");
await writeFile(localPath, feedBody);
const plan = {
  edition: "online", applicationVersion, platform, channel, directory, root, verification,
  requiredPreviousVersion: receipt.baseline,
  objects: [await localObject(name, "application/octet-stream"), await localObject(name + ".sig", "text/plain")],
  feed: { ...location("latest.json"), localPath, size: feedBody.length, sha256: componentBytesSha256(feedBody) },
  feedBody,
};
console.log(JSON.stringify(await publishVerifiedOnlinePlan({
  plan,
  verifyRelease,
  dryRun: process.argv.includes("--dry-run"),
  onProgress: (event) => console.log(JSON.stringify(event)),
}), null, 2));
