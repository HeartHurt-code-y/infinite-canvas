import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  parseOnlinePublishArgs,
  prepareOnlinePublication,
  publishOnlineEdition,
} from "./publish-online-updates.mjs";
import {
  componentBytesSha256,
  RUNTIME_COMPONENTS,
  runtimeComponentArchiveUrl,
} from "./runtime-component-catalog.mjs";
import { tosUpdatesObjectKey, tosUpdatesPublicBaseUrl } from "./tos-updates-config.mjs";

const PLATFORM = "windows-x86_64";
const CHANNEL = `${PLATFORM}-online`;
const FEED_KEY = tosUpdatesObjectKey(`${CHANNEL}/latest.json`);
function encode(value) {
  return Buffer.from(JSON.stringify(value, null, 2) + "\n");
}
function url(objectKey) {
  return `https://sd20-zq.tos-cn-beijing.volces.com/${objectKey.split("/").map(encodeURIComponent).join("/")}`;
}

async function fixture(t, version = "0.2.1", platform = PLATFORM) {
  const channel = `${platform}-online`;
  const feedKey = tosUpdatesObjectKey(`${channel}/latest.json`);
  const isMac = platform.startsWith("darwin-");
  const root = await mkdtemp(path.join(os.tmpdir(), "ic-online-publish-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, `.cache/tauri-editions/online/artifacts/${version}`);
  const packages = path.join(root, ".cache/runtime-components/packages");
  await mkdir(path.join(directory, isMac ? "macos" : "nsis"), { recursive: true });
  await mkdir(packages, { recursive: true });
  const components = [];
  for (const { id } of RUNTIME_COMPONENTS) {
    const body = Buffer.from(`compressed fixture ${id}`);
    const sha256 = componentBytesSha256(body);
    const localPath = path.join(packages, `${sha256}.zip`);
    await writeFile(localPath, body);
    components.push({
      id,
      localPath,
      format: "zip",
      url: runtimeComponentArchiveUrl(id, sha256, { applicationVersion: version, platform }),
      size: body.length,
      sha256,
    });
  }
  const artifacts = [];
  const arch = platform === "darwin-aarch64" ? "aarch64" : "x64";
  const updater = isMac
    ? `macos/无限画布_${version}_${arch}-online.app.tar.gz`
    : `nsis/无限画布_${version}_x64-online-setup.exe`;
  const paths = [
    [updater, Buffer.from("verified fixture installer")],
    [`${updater}.sig`, Buffer.from("verified updater signature\n")],
  ];
  if (isMac)
    paths.push(
      [`dmg/无限画布_${version}_${arch}-online.dmg`, Buffer.from("verified disk image")],
      ["helper/install-macos.sh", Buffer.from("verified installation helper")],
    );
  for (const [relative, body] of paths) {
    const basename = path.basename(relative);
    const localPath = path.join(directory, relative);
    const objectKey = tosUpdatesObjectKey(`${channel}/${basename}`);
    await mkdir(path.dirname(localPath), { recursive: true });
    await writeFile(localPath, body);
    artifacts.push({
      path: relative,
      size: body.length,
      sha256: componentBytesSha256(body),
      localPath,
      objectKey,
      url: url(objectKey),
    });
  }
  const feed = {
    version,
    notes: "online",
    pub_date: "2026-10-08T00:00:00.000Z",
    platforms: { [platform]: { url: artifacts[0].url, signature: "verified updater signature" } },
  };
  const manifest = {
    schemaVersion: 1,
    edition: "online",
    applicationVersion: version,
    platform,
    channel,
    catalogSha256: "a".repeat(64),
    feed: {
      localPath: path.join(directory, "latest.json"),
      objectKey: feedKey,
      url: url(feedKey),
    },
    artifacts,
    componentArchives: components,
  };
  await writeFile(manifest.feed.localPath, encode(feed));
  const manifestPath = path.join(directory, "publish-manifest.json");
  await writeFile(manifestPath, encode(manifest));
  const verification = {
    verified: true,
    edition: "online",
    applicationVersion: version,
    platform,
    channel,
    catalogSha256: manifest.catalogSha256,
    installer: { sha256: artifacts[0].sha256, updaterSignatureVerified: true },
    executable: { compiledPinsVerified: true, sha256: "c".repeat(64) },
    ...(isMac
      ? {
          bundleResourceCount: 107,
          macos: {
            codeSignatureVerified: true,
            architectureVerified: true,
            updateArchiveBytesVerified: true,
              dmg: { dmgVerified: true, applicationBytesVerified: true, codeSignatureVerified: true, sha256: artifacts[2].sha256 },
          },
        }
      : { nsisResourceCount: 107 }),
    componentArchiveCount: 7,
    publishManifestVerified: true,
    sourceFreshnessVerified: true,
    sourceFingerprint: "b".repeat(64),
  };
  let verificationCalls = 0;
  const verifyRelease = async (options) => {
    assert.equal(options.requireSourceFreshness, true);
    verificationCalls++;
    return structuredClone(verification);
  };
  return {
    root,
    directory,
    manifest,
    manifestPath,
    feed,
    verification,
    verifyRelease,
    verificationCalls: () => verificationCalls,
    writeManifest: () => writeFile(manifestPath, encode(manifest)),
    options: { root, distributionDirectory: directory, platform, verifyRelease },
  };
}

function mockTransport(initial = new Map()) {
  const objects = new Map(initial);
  const calls = [];
  let etagIndex = 0;
  const state = {
    objects,
    calls,
    seed(objectKey, body, sha256 = componentBytesSha256(body)) {
      objects.set(objectKey, { body: Buffer.from(body), etag: `"etag-${++etagIndex}"`, sha256 });
    },
    async headObject({ objectKey }) {
      calls.push({ method: "head", objectKey });
      const entry = objects.get(objectKey);
      return entry ? { size: entry.body.length, etag: entry.etag, sha256: entry.sha256 } : null;
    },
    async readObject({ objectKey, maxBytes }) {
      calls.push({ method: "read", objectKey });
      const entry = objects.get(objectKey);
      if (!entry) return null;
      assert.ok(entry.body.length <= maxBytes);
      return { body: Buffer.from(entry.body), etag: entry.etag };
    },
    async putObject(request) {
      calls.push({ method: "put", ...request });
      const existing = objects.get(request.objectKey);
      if (
        (request.ifNoneMatch === "*" && existing) ||
        (request.ifMatch && request.ifMatch !== existing?.etag)
      ) {
        const failure = new Error("conditional create failed");
        failure.code = "PRECONDITION_FAILED";
        throw failure;
      }
      const body = request.body ?? (await readFile(request.localPath));
      state.seed(request.objectKey, body, request.metadata.sha256);
      return { etag: objects.get(request.objectKey).etag };
    },
    async verifyPublicObject(request) {
      const objectKey = new URL(request.url).pathname
        .split("/")
        .map(decodeURIComponent)
        .join("/")
        .slice(1);
      calls.push({ method: "public-get", objectKey });
      const entry = objects.get(objectKey);
      if (!entry) throw new Error("public object missing");
      return { size: entry.body.length, sha256: componentBytesSha256(entry.body) };
    },
  };
  return state;
}

function oldFeed(version = "0.2.0") {
  return encode({
    version,
    notes: "old online",
    pub_date: "2026-10-07T00:00:00.000Z",
    platforms: {
      [PLATFORM]: {
        url: `${tosUpdatesPublicBaseUrl()}/${CHANNEL}/${encodeURIComponent(`无限画布_${version}_x64-online-setup.exe`)}`,
        signature: "old signature",
      },
    },
  });
}
const writes = (transport) => transport.calls.filter(({ method }) => method === "put");
const feedWrites = (transport) =>
  writes(transport).filter(({ objectKey }) => objectKey === FEED_KEY);

test("dry-run verifies complete local objects without creating a transport or reading credentials", async (t) => {
  const f = await fixture(t);
  const report = await publishOnlineEdition({
    ...f.options,
    dryRun: true,
    transportFactory: () => {
      throw new Error("must not load transport");
    },
  });
  assert.equal(report.localReleaseVerified, true);
  assert.equal(report.published, false);
  assert.equal(report.objects.length, 9);
  assert.equal(f.verificationCalls(), 1);
});

test("both Mac channels publish their DMG, updater/signature, installation helper and seven components before the feed", async (t) => {
  for (const platform of ["darwin-aarch64", "darwin-x86_64"]) {
    const f = await fixture(t, "0.2.2", platform);
    const transport = mockTransport();
    const report = await publishOnlineEdition({ ...f.options, transportFactory: () => transport });
    assert.equal(report.published, true);
    assert.equal(report.platform, platform);
    assert.equal(report.channel, `${platform}-online`);
    assert.equal(report.objects.length, 11);
    assert.equal(report.publicObjectsVerified, true);
    const mutations = writes(transport);
    assert.equal(mutations.length, 12);
    assert.equal(mutations.at(-1).objectKey, tosUpdatesObjectKey(`${platform}-online/latest.json`));
    assert.ok(report.objects.some(({ objectKey }) => objectKey.endsWith(".dmg")));
    assert.ok(report.objects.some(({ objectKey }) => objectKey.endsWith("/install-macos.sh")));
    assert.equal(
      report.objects.some(({ objectKey }) => objectKey.includes("windows-x86_64")),
      false,
    );
    assert.ok(f.feed.platforms[platform].url.endsWith(".app.tar.gz"));
  }
});

test("Mac publication refuses incomplete native/DMG/resource validation and component URLs from another platform before credentials", async (t) => {
  const f = await fixture(t, "0.2.2", "darwin-aarch64");
  for (const change of [
    { macos: { ...f.verification.macos, architectureVerified: false } },
    { macos: { ...f.verification.macos, updateArchiveBytesVerified: false } },
    { macos: { ...f.verification.macos, dmg: { dmgVerified: true } } },
    { bundleResourceCount: 0 },
  ])
    await assert.rejects(
      publishOnlineEdition({
        ...f.options,
        verifyRelease: async () => ({ ...f.verification, ...change }),
        transportFactory: () => {
          throw new Error("must not read credentials");
        },
      }),
      /full online release verification/,
    );
  f.manifest.componentArchives[0].url = f.manifest.componentArchives[0].url.replace(
    "darwin-aarch64",
    "windows-x86_64",
  );
  await f.writeManifest();
  await assert.rejects(prepareOnlinePublication(f.options), /trusted catalog\/cache contract/);
});

test("failed signature/compiled pin verification stops before transport construction", async (t) => {
  const f = await fixture(t);
  for (const change of [
    { installer: { updaterSignatureVerified: false } },
    { executable: { compiledPinsVerified: false } },
    { verified: false },
  ]) {
    await assert.rejects(
      publishOnlineEdition({
        ...f.options,
        verifyRelease: async () => ({ ...f.verification, ...change }),
        transportFactory: () => {
          throw new Error("not reached");
        },
      }),
      /full online release verification/,
    );
  }
});

test("publishes all nine immutable objects, validates public bytes, and commits only the dedicated feed last", async (t) => {
  const f = await fixture(t);
  const transport = mockTransport();
  const progress = [];
  const report = await publishOnlineEdition({
    ...f.options,
    transportFactory: ({ root }) => {
      assert.equal(root, f.root);
      return transport;
    },
    onProgress: (event) => progress.push(event),
  });
  assert.equal(report.published, true);
  assert.equal(report.feedChanged, true);
  assert.equal(report.uploadedObjectCount, 9);
  assert.equal(report.publicObjectsVerified, true);
  assert.equal(f.verificationCalls(), 2);
  assert.equal(writes(transport).at(-1).objectKey, FEED_KEY);
  assert.equal(feedWrites(transport)[0].ifNoneMatch, "*");
  const feedAt = transport.calls.findIndex(
    ({ method, objectKey }) => method === "put" && objectKey === FEED_KEY,
  );
  assert.equal(
    transport.calls.slice(0, feedAt).filter(({ method }) => method === "public-get").length,
    9,
  );
  assert.equal(progress.at(-1).phase, "feed-committed");
  assert.equal(
    writes(transport).some(
      ({ objectKey }) =>
        objectKey === tosUpdatesObjectKey("latest.json") ||
        objectKey.startsWith(tosUpdatesObjectKey(`${PLATFORM}/`)),
    ),
    false,
  );
});

test("an identical second release fully GET-verifies all objects and performs no writes", async (t) => {
  const f = await fixture(t);
  const transport = mockTransport();
  await publishOnlineEdition({ ...f.options, transportFactory: () => transport });
  transport.calls.length = 0;
  const report = await publishOnlineEdition({ ...f.options, transportFactory: () => transport });
  assert.equal(report.feedChanged, false);
  assert.equal(report.reusedObjectCount, 9);
  assert.equal(writes(transport).length, 0);
  assert.equal(transport.calls.filter(({ method }) => method === "public-get").length, 10);
});

test("previous online feed is backed up and GET-verified before conditional commit", async (t) => {
  const f = await fixture(t);
  const transport = mockTransport();
  const previousBody = oldFeed();
  transport.seed(FEED_KEY, previousBody);
  const previousEtag = transport.objects.get(FEED_KEY).etag;
  const report = await publishOnlineEdition({ ...f.options, transportFactory: () => transport });
  const backupKey = tosUpdatesObjectKey(
    `${CHANNEL}/backups/${componentBytesSha256(previousBody)}.json`,
  );
  assert.equal(report.previousFeedBackup.objectKey, backupKey);
  assert.ok(transport.objects.get(backupKey).body.equals(previousBody));
  assert.equal(feedWrites(transport)[0].ifMatch, previousEtag);
  assert.equal(writes(transport).at(-2).objectKey, backupKey);
  assert.equal(writes(transport).at(-1).objectKey, FEED_KEY);
});

test("same version with different feed bytes is rejected before immutable uploads", async (t) => {
  const f = await fixture(t);
  const transport = mockTransport();
  transport.seed(FEED_KEY, oldFeed("0.2.1"));
  await assert.rejects(
    publishOnlineEdition({ ...f.options, transportFactory: () => transport }),
    /same-version online feed/,
  );
  assert.equal(writes(transport).length, 0);
});

test("downgrades, including release-to-prerelease downgrades, are rejected", async (t) => {
  for (const [local, remote] of [
    ["0.2.1", "0.2.2"],
    ["0.2.1-alpha.2", "0.2.1"],
    ["0.2.1-alpha.2", "0.2.1-alpha.10"],
  ]) {
    const f = await fixture(t, local);
    const transport = mockTransport();
    transport.seed(FEED_KEY, oldFeed(remote));
    await assert.rejects(
      publishOnlineEdition({ ...f.options, transportFactory: () => transport }),
      /downgrade/,
    );
    assert.equal(writes(transport).length, 0);
  }
});

test("immutable installer conflicts are refused rather than overwritten", async (t) => {
  const f = await fixture(t);
  const transport = mockTransport();
  transport.seed(f.manifest.artifacts[0].objectKey, Buffer.from("other same-version installer"));
  await assert.rejects(
    publishOnlineEdition({ ...f.options, transportFactory: () => transport }),
    /Immutable same-version object conflicts/,
  );
  assert.equal(feedWrites(transport).length, 0);
  assert.equal(
    writes(transport).some(({ objectKey }) => objectKey === f.manifest.artifacts[0].objectKey),
    false,
  );
});

test("metadata alone is insufficient: corrupt public bytes prevent feed commit", async (t) => {
  const f = await fixture(t);
  const transport = mockTransport();
  const component = f.manifest.componentArchives[0];
  const key = new URL(component.url).pathname.slice(1);
  transport.seed(key, Buffer.alloc(component.size), component.sha256);
  await assert.rejects(
    publishOnlineEdition({ ...f.options, transportFactory: () => transport }),
    /Public object SHA\/size mismatch/,
  );
  assert.equal(feedWrites(transport).length, 0);
});

test("upload failure and public GET failure each preserve the previous feed", async (t) => {
  for (const failureAt of ["putObject", "verifyPublicObject"]) {
    const f = await fixture(t);
    const transport = mockTransport();
    const previous = oldFeed();
    transport.seed(FEED_KEY, previous);
    transport[failureAt] = async () => {
      throw new Error("simulated payload failure");
    };
    await assert.rejects(
      publishOnlineEdition({ ...f.options, transportFactory: () => transport }),
      /simulated payload failure/,
    );
    assert.ok(transport.objects.get(FEED_KEY).body.equals(previous));
    assert.equal(feedWrites(transport).length, 0);
  }
});

test("failed backup verification leaves the previous feed untouched", async (t) => {
  const f = await fixture(t);
  const transport = mockTransport();
  const previous = oldFeed();
  transport.seed(FEED_KEY, previous);
  const get = transport.verifyPublicObject;
  transport.verifyPublicObject = async (request) =>
    request.url.includes("/backups/")
      ? { size: previous.length, sha256: "f".repeat(64) }
      : get(request);
  await assert.rejects(
    publishOnlineEdition({ ...f.options, transportFactory: () => transport }),
    /Public object SHA\/size mismatch/,
  );
  assert.ok(transport.objects.get(FEED_KEY).body.equals(previous));
  assert.equal(feedWrites(transport).length, 0);
});

test("a concurrent feed change during payload publication cannot be overwritten", async (t) => {
  const f = await fixture(t);
  const transport = mockTransport();
  let reads = 0;
  const read = transport.readObject;
  transport.readObject = async (request) => {
    if (++reads === 2) transport.seed(FEED_KEY, oldFeed("0.2.2"));
    return read(request);
  };
  await assert.rejects(
    publishOnlineEdition({ ...f.options, transportFactory: () => transport }),
    /feed changed concurrently/,
  );
  assert.equal(feedWrites(transport).length, 0);
  assert.equal(JSON.parse(transport.objects.get(FEED_KEY).body).version, "0.2.2");
});

test("a feed race after the second read is blocked by compare-and-swap", async (t) => {
  const f = await fixture(t);
  const transport = mockTransport();
  const put = transport.putObject;
  transport.putObject = async (request) => {
    if (request.objectKey === FEED_KEY) transport.seed(FEED_KEY, oldFeed("0.2.2"));
    return put(request);
  };
  await assert.rejects(
    publishOnlineEdition({ ...f.options, transportFactory: () => transport }),
    /conditional commit was rejected/,
  );
  assert.equal(JSON.parse(transport.objects.get(FEED_KEY).body).version, "0.2.2");
});

test("a conditional immutable create race is reused only after matching public GET", async (t) => {
  const f = await fixture(t);
  const transport = mockTransport();
  const put = transport.putObject;
  let raced = false;
  transport.putObject = async (request) => {
    if (!raced && request.objectKey.endsWith(".zip")) {
      raced = true;
      transport.seed(request.objectKey, await readFile(request.localPath), request.metadata.sha256);
    }
    return put(request);
  };
  const report = await publishOnlineEdition({ ...f.options, transportFactory: () => transport });
  assert.equal(report.reusedObjectCount, 1);
  assert.equal(report.uploadedObjectCount, 8);
});

test("a release that becomes stale during upload is rejected before feed or backup writes", async (t) => {
  const f = await fixture(t);
  const transport = mockTransport();
  let verified = 0;
  await assert.rejects(
    publishOnlineEdition({
      ...f.options,
      verifyRelease: async () => {
        if (++verified === 2) throw new Error("source fingerprint changed");
        return f.verification;
      },
      transportFactory: () => transport,
    }),
    /source fingerprint changed/,
  );
  assert.equal(feedWrites(transport).length, 0);
});

test("feed read-back failure explicitly reports an uncertain commit instead of false success", async (t) => {
  const f = await fixture(t);
  const transport = mockTransport();
  const get = transport.verifyPublicObject;
  transport.verifyPublicObject = async (request) => {
    if (request.url === f.manifest.feed.url) throw new Error("read back timeout");
    return get(request);
  };
  await assert.rejects(
    publishOnlineEdition({ ...f.options, transportFactory: () => transport }),
    (error) => error.code === "FEED_COMMIT_UNCONFIRMED" && error.feedUrl === f.manifest.feed.url,
  );
  assert.equal(feedWrites(transport).length, 1);
});

test("untrusted object URLs, old channel keys, cache escapes, duplicates, and missing components fail before credentials", async (t) => {
  const changes = [
    (manifest) => {
      manifest.componentArchives[0].url = "https://example.com/evil.zip";
    },
    (manifest) => {
      manifest.artifacts[0].objectKey = tosUpdatesObjectKey(`${PLATFORM}/old.exe`);
    },
    (manifest) => {
      manifest.feed.objectKey = tosUpdatesObjectKey("latest.json");
    },
    (manifest) => {
      manifest.componentArchives[0].localPath += "/../../evil.zip";
    },
    (manifest) => {
      manifest.componentArchives[1] = manifest.componentArchives[0];
    },
    (manifest) => {
      manifest.componentArchives.pop();
    },
    (manifest) => {
      manifest.edition = "offline";
    },
  ];
  for (const change of changes) {
    const f = await fixture(t);
    change(f.manifest);
    await f.writeManifest();
    let constructed = false;
    await assert.rejects(
      publishOnlineEdition({
        ...f.options,
        transportFactory: () => {
          constructed = true;
          return mockTransport();
        },
      }),
    );
    assert.equal(constructed, false);
  }
});

test("changed local archive or feed signature stops before transport", async (t) => {
  const f = await fixture(t);
  await writeFile(f.manifest.componentArchives[0].localPath, "mutated local archive");
  await assert.rejects(prepareOnlinePublication(f.options), /Local upload object changed/);
  await writeFile(
    f.manifest.componentArchives[0].localPath,
    `compressed fixture ${f.manifest.componentArchives[0].id}`,
  );
  f.feed.platforms[PLATFORM].signature = "another signature";
  await writeFile(f.manifest.feed.localPath, encode(f.feed));
  await assert.rejects(prepareOnlinePublication(f.options), /Feed signature changed/);
});

test("parse args accepts only one distribution directory and optional dry-run", () => {
  assert.deepEqual(parseOnlinePublishArgs(["--distribution-dir", "directory", "--dry-run"]), {
    distributionDirectory: "directory",
    dryRun: true,
  });
  assert.deepEqual(parseOnlinePublishArgs(["--dry-run", "--distribution-dir", "directory"]), {
    distributionDirectory: "directory",
    dryRun: true,
  });
  for (const args of [
    [],
    ["--distribution-dir", "--dry-run"],
    ["--distribution-dir", "directory", "--bucket", "other"],
    ["--distribution-dir", "directory", "--dry-run", "--dry-run"],
  ])
    assert.throws(() => parseOnlinePublishArgs(args), /Usage/);
});
