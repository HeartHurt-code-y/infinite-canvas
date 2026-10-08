// Publish only the verified Windows online edition. The public feed is the final mutation.
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertComponentRoot,
  COMPONENT_PLATFORM,
  COMPONENT_REPO_ROOT,
  componentBytesSha256,
  componentFileSha256,
  RUNTIME_COMPONENTS,
  runtimeComponentArchiveUrl,
} from "./runtime-component-catalog.mjs";
import { verifyEditionRelease } from "./verify-edition-release.mjs";
import { tosUpdatesObjectKey, tosUpdatesPublicBaseUrl } from "./tos-updates-config.mjs";

const CHANNEL = `${COMPONENT_PLATFORM}-online`;
const SHA256 = /^[a-f0-9]{64}$/;
const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const JSON_BUDGET = 1024 * 1024;

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, expected, label) {
  requireValue(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort()),
    `${label} has unexpected or missing fields`,
  );
}

async function regularBytes(filename, root, budget = JSON_BUDGET) {
  await assertComponentRoot(path.dirname(filename), root);
  const info = await lstat(filename);
  requireValue(
    info.isFile() && !info.isSymbolicLink() && info.size <= budget,
    `Invalid local file: ${filename}`,
  );
  return readFile(filename);
}

function urlForKey(objectKey) {
  const prefix = `${tosUpdatesObjectKey("")}`;
  requireValue(objectKey.startsWith(prefix), "Object is outside the trusted updates prefix");
  return `${tosUpdatesPublicBaseUrl()}/${objectKey.slice(prefix.length).split("/").map(encodeURIComponent).join("/")}`;
}

function compareVersions(left, right) {
  const a = VERSION.exec(left);
  const b = VERSION.exec(right);
  requireValue(a && b, "Online feed contains an invalid semantic version");
  for (let index = 1; index <= 3; index++) {
    const delta = BigInt(a[index]) - BigInt(b[index]);
    if (delta) return delta > 0n ? 1 : -1;
  }
  if (a[4] === b[4]) return 0;
  if (!a[4]) return 1;
  if (!b[4]) return -1;
  const ai = a[4].split(".");
  const bi = b[4].split(".");
  requireValue(
    [...ai, ...bi].every(
      (value) => value && (!/^\d+$/.test(value) || value === "0" || value[0] !== "0"),
    ),
    "Invalid prerelease version",
  );
  for (let index = 0; index < Math.max(ai.length, bi.length); index++) {
    if (ai[index] === bi[index]) continue;
    if (ai[index] === undefined) return -1;
    if (bi[index] === undefined) return 1;
    const an = /^\d+$/.test(ai[index]);
    const bn = /^\d+$/.test(bi[index]);
    if (an && bn) return BigInt(ai[index]) > BigInt(bi[index]) ? 1 : -1;
    if (an !== bn) return an ? -1 : 1;
    return ai[index] > bi[index] ? 1 : -1;
  }
  return 0;
}

function assertFeed(feed, version) {
  exactKeys(feed, ["version", "notes", "pub_date", "platforms"], "Online feed");
  requireValue(
    VERSION.test(feed.version) &&
      (!version || feed.version === version) &&
      typeof feed.notes === "string" &&
      typeof feed.pub_date === "string" &&
      Number.isFinite(Date.parse(feed.pub_date)),
    "Invalid online feed identity",
  );
  exactKeys(feed.platforms, [COMPONENT_PLATFORM], "Online feed platforms");
  const platform = feed.platforms[COMPONENT_PLATFORM];
  exactKeys(platform, ["url", "signature"], "Online feed platform");
  requireValue(
    platform.url ===
      `${tosUpdatesPublicBaseUrl()}/${CHANNEL}/${encodeURIComponent(`无限画布_${feed.version}_x64-online-setup.exe`)}` &&
      typeof platform.signature === "string" &&
      platform.signature.length > 0 &&
      !platform.resourceManifest &&
      !platform.requiresRuntimeComponents,
    "Feed does not reference the dedicated online installer",
  );
}

async function assertLocalObject(entry, root) {
  await assertComponentRoot(path.dirname(entry.localPath), root);
  const info = await lstat(entry.localPath);
  requireValue(
    info.isFile() &&
      !info.isSymbolicLink() &&
      info.size === entry.size &&
      (await componentFileSha256(entry.localPath)) === entry.sha256,
    `Local upload object changed or is invalid: ${entry.objectKey}`,
  );
}

/** Build a reviewable plan after the full installer/signature/native pins/resource-table verifier. */
export async function prepareOnlinePublication({
  distributionDirectory,
  root = COMPONENT_REPO_ROOT,
  verifyRelease = verifyEditionRelease,
}) {
  root = path.resolve(root);
  const directory = path.resolve(root, distributionDirectory);
  const relative = path.relative(root, directory).split(path.sep).join("/");
  const matched = /^\.cache\/tauri-editions\/online\/artifacts\/([^/]+)$/.exec(relative);
  requireValue(
    matched && VERSION.test(matched[1]),
    "Online publication requires the exact online/version artifact directory",
  );
  const version = matched[1];
  const manifestPath = path.join(directory, "publish-manifest.json");
  const originalManifest = await regularBytes(manifestPath, root);
  const verification = await verifyRelease({
    distributionDirectory: directory,
    root,
    requireSourceFreshness: true,
  });
  requireValue(
    verification?.verified === true &&
      verification.edition === "online" &&
      verification.applicationVersion === version &&
      verification.platform === COMPONENT_PLATFORM &&
      verification.channel === CHANNEL &&
      verification.publishManifestVerified === true &&
      verification.sourceFreshnessVerified === true &&
      SHA256.test(verification.sourceFingerprint) &&
      verification.executable?.compiledPinsVerified === true &&
      Number.isSafeInteger(verification.nsisResourceCount) &&
      verification.nsisResourceCount > 0 &&
      verification.componentArchiveCount === RUNTIME_COMPONENTS.length &&
      verification.installer?.updaterSignatureVerified === true,
    "Publication requires successful full online release verification",
  );
  requireValue(
    originalManifest.equals(await regularBytes(manifestPath, root)),
    "Publish manifest changed during release verification",
  );
  const manifest = JSON.parse(originalManifest);
  exactKeys(
    manifest,
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
    manifest.schemaVersion === 1 &&
      manifest.edition === "online" &&
      manifest.applicationVersion === version &&
      manifest.platform === COMPONENT_PLATFORM &&
      manifest.channel === CHANNEL &&
      SHA256.test(manifest.catalogSha256) &&
      manifest.catalogSha256 === verification.catalogSha256,
    "Publish manifest identity changed or does not match the verified catalog",
  );
  exactKeys(manifest.feed, ["localPath", "objectKey", "url"], "Publish feed");
  requireValue(
    manifest.feed.localPath === path.join(directory, "latest.json") &&
      manifest.feed.objectKey === tosUpdatesObjectKey(`${CHANNEL}/latest.json`) &&
      manifest.feed.url === urlForKey(manifest.feed.objectKey),
    "Feed path escapes the dedicated online channel",
  );
  requireValue(
    Array.isArray(manifest.artifacts) &&
      manifest.artifacts.length === 2 &&
      Array.isArray(manifest.componentArchives) &&
      manifest.componentArchives.length === RUNTIME_COMPONENTS.length,
    "Publish exactly the NSIS installer/signature and seven ZIP components",
  );
  const objects = [];
  const ids = new Set();
  for (const archive of manifest.componentArchives) {
    exactKeys(
      archive,
      ["id", "localPath", "format", "url", "size", "sha256"],
      "Publish component archive",
    );
    requireValue(
      RUNTIME_COMPONENTS.some(({ id }) => id === archive.id) &&
        !ids.has(archive.id) &&
        archive.format === "zip" &&
        SHA256.test(archive.sha256) &&
        Number.isSafeInteger(archive.size) &&
        archive.size > 0 &&
        archive.size <= 8 * 1024 ** 3 &&
        archive.localPath ===
          path.join(root, ".cache/runtime-components/packages", `${archive.sha256}.zip`) &&
        archive.url ===
          runtimeComponentArchiveUrl(archive.id, archive.sha256, { applicationVersion: version }),
      "Component upload is outside the trusted catalog/cache contract",
    );
    ids.add(archive.id);
    const objectKey = tosUpdatesObjectKey(
      `components/${COMPONENT_PLATFORM}/${version}/${archive.id}-${archive.sha256}.zip`,
    );
    objects.push({ ...archive, objectKey, contentType: "application/zip" });
  }
  const installerName = `无限画布_${version}_x64-online-setup.exe`;
  for (const artifact of manifest.artifacts) {
    exactKeys(
      artifact,
      ["path", "size", "sha256", "localPath", "objectKey", "url"],
      "Publish artifact",
    );
    const expectedName = path.basename(artifact.path);
    requireValue(
      [installerName, `${installerName}.sig`].includes(expectedName) &&
        artifact.path === `nsis/${expectedName}` &&
        artifact.localPath === path.join(directory, artifact.path) &&
        artifact.objectKey === tosUpdatesObjectKey(`${CHANNEL}/${expectedName}`) &&
        artifact.url === urlForKey(artifact.objectKey) &&
        SHA256.test(artifact.sha256) &&
        Number.isSafeInteger(artifact.size) &&
        artifact.size > 0,
      "Artifact upload is outside the dedicated online channel",
    );
    objects.push({
      ...artifact,
      contentType: expectedName.endsWith(".sig") ? "text/plain" : "application/octet-stream",
    });
  }
  requireValue(
    new Set(objects.map(({ objectKey }) => objectKey)).size === objects.length &&
      objects.some(({ objectKey }) => objectKey.endsWith(`/${installerName}`)) &&
      objects.some(({ objectKey }) => objectKey.endsWith(`/${installerName}.sig`)),
    "Duplicate or missing online publication objects",
  );
  const feedBody = await regularBytes(manifest.feed.localPath, root);
  const feed = JSON.parse(feedBody);
  assertFeed(feed, version);
  const signature = (await regularBytes(path.join(directory, `nsis/${installerName}.sig`), root))
    .toString("utf8")
    .trim();
  requireValue(
    feed.platforms[COMPONENT_PLATFORM].signature === signature,
    "Feed signature changed after verification",
  );
  for (const entry of objects) await assertLocalObject(entry, root);
  return {
    schemaVersion: 1,
    edition: "online",
    applicationVersion: version,
    platform: COMPONENT_PLATFORM,
    channel: CHANNEL,
    catalogSha256: manifest.catalogSha256,
    directory,
    root,
    objects,
    feed: { ...manifest.feed, size: feedBody.length, sha256: componentBytesSha256(feedBody) },
    feedBody,
    verification,
  };
}

async function defaultTransportFactory(options) {
  const { createOnlineUpdateTransport } = await import("./online-update-transport.mjs");
  return createOnlineUpdateTransport(options);
}

function assertRemoteFeed(remote) {
  if (!remote) return;
  requireValue(
    Buffer.isBuffer(remote.body) &&
      remote.body.length > 0 &&
      remote.body.length <= JSON_BUDGET &&
      typeof remote.etag === "string" &&
      remote.etag.length > 0,
    "Existing online feed lacks a bounded body or concurrency ETag",
  );
  assertFeed(JSON.parse(remote.body));
}

function sameRemoteFeed(a, b) {
  return (!a && !b) || Boolean(a && b && a.etag === b.etag && a.body.equals(b.body));
}

async function verifiedPublicObject(transport, entry) {
  const actual = await transport.verifyPublicObject({
    url: entry.url,
    expectedSize: entry.size,
    expectedSha256: entry.sha256,
  });
  requireValue(
    actual?.size === entry.size && actual.sha256 === entry.sha256,
    `Public object SHA/size mismatch: ${entry.objectKey}`,
  );
}

async function publishImmutable(transport, entry, onProgress) {
  const existing = await transport.headObject({ objectKey: entry.objectKey });
  if (existing) {
    requireValue(
      existing.size === entry.size && (!existing.sha256 || existing.sha256 === entry.sha256),
      `Immutable same-version object conflicts with this release: ${entry.objectKey}`,
    );
    await verifiedPublicObject(transport, entry);
    onProgress({ phase: "reused", objectKey: entry.objectKey, size: entry.size });
    return "reused";
  }
  try {
    await transport.putObject({
      objectKey: entry.objectKey,
      ...(entry.localPath ? { localPath: entry.localPath } : { body: entry.body }),
      contentType: entry.contentType,
      metadata: { sha256: entry.sha256 },
      ifNoneMatch: "*",
    });
  } catch (error) {
    // A concurrent identical immutable upload may win the conditional create.
    if (error.code !== "PRECONDITION_FAILED") throw error;
    const winner = await transport.headObject({ objectKey: entry.objectKey });
    requireValue(
      winner && winner.size === entry.size && (!winner.sha256 || winner.sha256 === entry.sha256),
      `Concurrent immutable upload conflicts: ${entry.objectKey}`,
    );
    await verifiedPublicObject(transport, entry);
    onProgress({ phase: "reused", objectKey: entry.objectKey, size: entry.size });
    return "reused";
  }
  await verifiedPublicObject(transport, entry);
  onProgress({ phase: "uploaded", objectKey: entry.objectKey, size: entry.size });
  return "uploaded";
}

/** The factory is not invoked until all local artifacts pass; dry-run never reads credentials. */
export async function publishOnlineEdition({
  distributionDirectory,
  root = COMPONENT_REPO_ROOT,
  transportFactory = defaultTransportFactory,
  verifyRelease = verifyEditionRelease,
  dryRun = false,
  onProgress = () => {},
}) {
  const plan = await prepareOnlinePublication({ distributionDirectory, root, verifyRelease });
  const report = {
    schemaVersion: 1,
    edition: plan.edition,
    applicationVersion: plan.applicationVersion,
    platform: plan.platform,
    channel: plan.channel,
    catalogSha256: plan.catalogSha256,
    dryRun,
    objects: plan.objects.map(({ objectKey, url, size, sha256 }) => ({
      objectKey,
      url,
      size,
      sha256,
    })),
    feed: {
      objectKey: plan.feed.objectKey,
      url: plan.feed.url,
      size: plan.feed.size,
      sha256: plan.feed.sha256,
    },
  };
  if (dryRun) return { ...report, published: false, localReleaseVerified: true };
  const transport = await transportFactory({ root: plan.root });
  for (const method of ["readObject", "headObject", "putObject", "verifyPublicObject"])
    requireValue(typeof transport?.[method] === "function", `Online transport lacks ${method}`);
  const previous = await transport.readObject({
    objectKey: plan.feed.objectKey,
    maxBytes: JSON_BUDGET,
  });
  assertRemoteFeed(previous);
  if (previous) {
    const comparison = compareVersions(plan.applicationVersion, JSON.parse(previous.body).version);
    requireValue(comparison >= 0, "Refusing to downgrade the online update channel");
    requireValue(
      comparison !== 0 || previous.body.equals(plan.feedBody),
      "Existing same-version online feed has different content; release a new version",
    );
  }
  const outcomes = [];
  for (const entry of plan.objects) {
    await assertLocalObject(entry, plan.root);
    outcomes.push(await publishImmutable(transport, entry, onProgress));
  }
  // Uploading the large components can take time. Re-run source freshness and
  // installer verification before the only mutable release pointer is touched.
  const finalVerification = await verifyRelease({
    distributionDirectory: plan.directory,
    root: plan.root,
    requireSourceFreshness: true,
  });
  requireValue(
    finalVerification?.verified === true &&
      finalVerification.edition === "online" &&
      finalVerification.applicationVersion === plan.applicationVersion &&
      finalVerification.catalogSha256 === plan.catalogSha256 &&
      finalVerification.installer?.sha256 === plan.verification.installer.sha256 &&
      finalVerification.installer?.updaterSignatureVerified === true &&
      finalVerification.executable?.compiledPinsVerified === true &&
      finalVerification.executable.sha256 === plan.verification.executable.sha256 &&
      finalVerification.sourceFreshnessVerified === true &&
      finalVerification.sourceFingerprint === plan.verification.sourceFingerprint,
    "Release changed during upload; online feed was not modified",
  );
  // The original feed bytes stay fixed even if a local build runs concurrently.
  requireValue(
    plan.feedBody.equals(await regularBytes(plan.feed.localPath, plan.root)),
    "Local feed changed during publication",
  );
  const current = await transport.readObject({
    objectKey: plan.feed.objectKey,
    maxBytes: JSON_BUDGET,
  });
  assertRemoteFeed(current);
  requireValue(
    sameRemoteFeed(previous, current),
    "Online feed changed concurrently; payloads are safe but the channel was not modified",
  );
  if (previous?.body.equals(plan.feedBody)) {
    await verifiedPublicObject(transport, plan.feed);
    return {
      ...report,
      published: true,
      feedChanged: false,
      uploadedObjectCount: outcomes.filter((value) => value === "uploaded").length,
      reusedObjectCount: outcomes.filter((value) => value === "reused").length,
      publicObjectsVerified: true,
    };
  }
  let backup = null;
  if (previous) {
    const sha256 = componentBytesSha256(previous.body);
    const objectKey = tosUpdatesObjectKey(`${CHANNEL}/backups/${sha256}.json`);
    backup = {
      objectKey,
      url: urlForKey(objectKey),
      size: previous.body.length,
      sha256,
      body: previous.body,
      contentType: "application/json",
    };
    await publishImmutable(transport, backup, onProgress);
  }
  // Compare-and-swap protects another publisher even after the pre-commit re-read.
  let commitStarted = false;
  try {
    commitStarted = true;
    await transport.putObject({
      objectKey: plan.feed.objectKey,
      body: plan.feedBody,
      contentType: "application/json",
      metadata: { sha256: plan.feed.sha256 },
      ...(previous ? { ifMatch: previous.etag } : { ifNoneMatch: "*" }),
    });
    await verifiedPublicObject(transport, plan.feed);
    const confirmed = await transport.readObject({
      objectKey: plan.feed.objectKey,
      maxBytes: JSON_BUDGET,
    });
    assertRemoteFeed(confirmed);
    requireValue(
      confirmed && confirmed.body.equals(plan.feedBody),
      "Online feed origin read-back does not match the committed release",
    );
  } catch (error) {
    if (error.code === "PRECONDITION_FAILED")
      throw new Error("Online feed changed concurrently; conditional commit was rejected", {
        cause: error,
      });
    const failure = new Error(
      "Online feed commit could not be confirmed; inspect the dedicated channel before retrying or restoring its backup",
      { cause: error },
    );
    failure.code = commitStarted ? "FEED_COMMIT_UNCONFIRMED" : "FEED_NOT_COMMITTED";
    failure.feedUrl = plan.feed.url;
    failure.backup = backup
      ? { objectKey: backup.objectKey, url: backup.url, sha256: backup.sha256 }
      : null;
    throw failure;
  }
  onProgress({ phase: "feed-committed", objectKey: plan.feed.objectKey, size: plan.feed.size });
  return {
    ...report,
    published: true,
    feedChanged: true,
    uploadedObjectCount: outcomes.filter((value) => value === "uploaded").length,
    reusedObjectCount: outcomes.filter((value) => value === "reused").length,
    publicObjectsVerified: true,
    previousFeedBackup: backup
      ? { objectKey: backup.objectKey, url: backup.url, size: backup.size, sha256: backup.sha256 }
      : null,
  };
}

export function parseOnlinePublishArgs(args) {
  const distributionAt = args.indexOf("--distribution-dir");
  const dryRun = args.includes("--dry-run");
  requireValue(
    distributionAt >= 0 &&
      args[distributionAt + 1] &&
      !args[distributionAt + 1].startsWith("--") &&
      args.length === (dryRun ? 3 : 2) &&
      args.filter((argument) => argument === "--distribution-dir").length === 1 &&
      args.filter((argument) => argument === "--dry-run").length <= 1,
    "Usage: node scripts/publish-online-updates.mjs --distribution-dir .cache/tauri-editions/online/artifacts/{version} [--dry-run]",
  );
  return { distributionDirectory: args[distributionAt + 1], dryRun };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  publishOnlineEdition({
    ...parseOnlinePublishArgs(process.argv.slice(2)),
    onProgress: (event) => console.log(JSON.stringify(event)),
  })
    .then((report) => console.log(JSON.stringify(report, null, 2)))
    .catch((error) => {
      console.error(`[online-publish] ${error.message}`);
      process.exitCode = 1;
    });
}
