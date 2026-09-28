import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  cacheControlForFileName,
  collectPublishFilePaths,
  contentTypeForFileName,
  isRetryableTosNetworkError,
  parseTosUploadId,
  normalizeTosEtag,
  buildCompleteMultipartJson,
  readTosPublishEnv,
  resolvePublishChannel,
  collectFullOfflineFiles,
  collectMacFullOfflineFiles,
  compareReleaseVersions,
  checkChannelManifest,
  checkLegacyPlatformFeeds,
  collectLegacyChannelPlatforms,
  immutableObjectMatches,
  collectRuntimeResourceObjects,
  collectMacDeltaObjects,
  macDeltaTransferIsSmaller,
  assertMacDeltaMatchesFullArchive,
  inventoryMacFullArchive,
  tosFetch,
} from "./publish-tos-updates.mjs";
import { tosPlatformLatestJsonUrl } from "./tos-updates-config.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("latest.json stays uncached while installers can be cached", () => {
  assert.equal(contentTypeForFileName("latest.json"), "application/json");
  assert.equal(cacheControlForFileName("latest.json"), "no-cache");
  assert.match(cacheControlForFileName("无限画布.app.tar.gz"), /immutable/);
});

test("publish file picker keeps updater artifacts, signatures and first-install helpers", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "infinite-canvas-publish-"));
  try {
    mkdirSync(path.join(dir, "macos"));
    mkdirSync(path.join(dir, "nsis"));
    mkdirSync(path.join(dir, "helper"));
    mkdirSync(path.join(dir, "dmg"));
    mkdirSync(path.join(dir, "resources", "0.1.1", "windows-x86_64"), { recursive: true });
    mkdirSync(path.join(dir, "mac-delta", "objects"), { recursive: true });
    writeFileSync(path.join(dir, "macos", "无限画布.app.tar.gz"), "pkg");
    writeFileSync(path.join(dir, "macos", "无限画布.app.tar.gz.sig"), "sig");
    writeFileSync(path.join(dir, "nsis", "无限画布_0.1.1_x64-setup.exe"), "exe");
    writeFileSync(path.join(dir, "helper", "install-macos.sh"), "#!/bin/sh\n");
    writeFileSync(path.join(dir, "dmg", "无限画布_0.1.1_aarch64.dmg"), "dmg");
    writeFileSync(path.join(dir, "latest.json"), "{}\n");
    writeFileSync(path.join(dir, "notes.txt"), "skip me");
    writeFileSync(
      path.join(dir, "resources", "0.1.1", "windows-x86_64", "manifest.json.sig"),
      "resource-sig",
    );
    writeFileSync(path.join(dir, "mac-delta", "manifest.json.sig"), "delta-sig");
    writeFileSync(path.join(dir, "mac-delta", "objects", "a".repeat(64)), "object");
    const picked = collectPublishFilePaths(dir).map((filePath) => path.basename(filePath));
    assert.deepEqual(
      new Set(picked),
      new Set([
        "install-macos.sh",
        "latest.json",
        "无限画布.app.tar.gz",
        "无限画布.app.tar.gz.sig",
        "无限画布_0.1.1_x64-setup.exe",
      ]),
    );
    assert.equal(picked.at(-1), "latest.json");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TOS credentials are required from the environment and never defaulted", () => {
  assert.throws(() => readTosPublishEnv({}), /TOS_ACCESS_KEY/);
  const parsed = readTosPublishEnv({
    TOS_ACCESS_KEY: "AKEXAMPLE",
    TOS_SECRET_KEY: "SKEXAMPLE",
  });
  assert.equal(parsed.bucket, "sd20-zq");
  assert.equal(parsed.region, "cn-beijing");
});

test("bridge and later apps use the per-platform TOS manifest", () => {
  const conf = JSON.parse(
    readFileSync(path.join(REPO_ROOT, "src-tauri", "tauri.conf.json"), "utf8"),
  );
  assert.deepEqual(conf.plugins.updater.endpoints, [tosPlatformLatestJsonUrl()]);
});

test("legacy promotion requires both signed platforms, while new feeds are isolated", () => {
  const windows = {
    "windows-x86_64": {
      url: "https://cdn.example/无限画布_0.1.8_x64-setup.exe",
      signature: "win-sig",
    },
  };
  const mac = {
    "darwin-aarch64": {
      url: "https://cdn.example/无限画布_0.1.8_aarch64-full.app.tar.gz",
      signature: "mac-sig",
    },
  };
  assert.throws(
    () => resolvePublishChannel("legacy", windows, undefined, "0.1.8"),
    /Windows x64.*macOS arm64/,
  );
  assert.equal(
    resolvePublishChannel("legacy", { ...windows, ...mac }, undefined, "0.1.8"),
    "infinite-canvas/updates",
  );
  assert.throws(
    () =>
      resolvePublishChannel(
        "legacy",
        {
          ...windows,
          ...mac,
          "windows-x86_64": {
            ...windows["windows-x86_64"],
            url: "https://cdn.example/无限画布_0.1.8_x64-slim-setup.exe",
          },
        },
        undefined,
        "0.1.8",
      ),
    /禁止瘦包/,
  );
  assert.equal(
    resolvePublishChannel("windows-x86_64", windows),
    "infinite-canvas/updates/windows-x86_64",
  );
  assert.throws(() => resolvePublishChannel("windows-x86_64", { ...windows, ...mac }), /只能发布/);
});

test("promotion requires matching platform feeds and never rolls a channel back", () => {
  const windows = { url: "https://cdn.example/无限画布_0.1.8_x64-setup.exe", signature: "win-sig" };
  const mac = {
    url: "https://cdn.example/无限画布_0.1.8_aarch64-full.app.tar.gz",
    signature: "mac-sig",
  };
  const platforms = { "windows-x86_64": windows, "darwin-aarch64": mac };
  const feeds = {
    "windows-x86_64": { version: "0.1.8", platforms: { "windows-x86_64": windows } },
    "darwin-aarch64": { version: "0.1.8", platforms: { "darwin-aarch64": mac } },
  };
  assert.doesNotThrow(() => checkLegacyPlatformFeeds("0.1.8", platforms, feeds));
  assert.throws(
    () => checkLegacyPlatformFeeds("0.1.8", platforms, { ...feeds, "darwin-aarch64": null }),
    /初始化同版/,
  );
  const latest = { version: "0.1.8", notes: "", pub_date: "2026-09-24T00:00:00Z", platforms };
  assert.deepEqual(checkChannelManifest(latest, latest), {
    sameVersion: true,
    pubDate: latest.pub_date,
  });
  assert.throws(() => checkChannelManifest(latest, { ...latest, version: "0.1.7" }), /拒绝回退/);
  assert.throws(
    () =>
      checkChannelManifest(latest, {
        ...latest,
        platforms: { ...platforms, "windows-x86_64": { ...windows, signature: "different" } },
      }),
    /同版覆盖/,
  );
  assert.throws(
    () =>
      checkChannelManifest(latest, {
        ...latest,
        macDeltaManifest: {
          url: "https://cdn.example/mac-delta/manifest.json",
          signature: "signed",
        },
      }),
    /同版覆盖/,
  );
  assert.throws(
    () =>
      checkChannelManifest(latest, {
        ...latest,
        resourceManifest: {
          url: "https://cdn.example/resources/manifest.json",
          signature: "signed",
        },
      }),
    /同版覆盖/,
  );
  assert.deepEqual(checkChannelManifest(latest, { ...latest, version: "0.1.9" }), {
    sameVersion: false,
    pubDate: undefined,
  });
  assert.equal(compareReleaseVersions("0.1.10", "0.1.9"), 1);
});

test("macOS delta publication accepts only a signed-version target tree and changed objects", () => {
  const url =
    "https://sd20-zq.tos-cn-beijing.volces.com/infinite-canvas/updates/mac-delta/objects/";
  const digest = "a".repeat(64);
  const manifest = {
    schemaVersion: 1,
    baseVersion: "0.1.10",
    version: "0.1.11",
    platform: "darwin-aarch64",
    appName: "无限画布.app",
    objectBaseUrl: url,
    files: [
      { path: "Contents", kind: "dir", mode: 0o755 },
      { path: "Contents/MacOS", kind: "dir", mode: 0o755 },
      {
        path: "Contents/MacOS/无限画布",
        kind: "file",
        size: 3,
        sha256: digest,
        mode: 0o755,
        source: "object",
      },
    ],
  };
  assert.deepEqual(collectMacDeltaObjects(manifest, "0.1.11", url), [{ sha256: digest, size: 3 }]);
  assert.throws(() => collectMacDeltaObjects(manifest, "0.1.12", url), /版本/);
  assert.throws(() => collectMacDeltaObjects(manifest, "0.1.11", `${url}wrong/`), /地址/);
  assert.throws(
    () =>
      collectMacDeltaObjects(
        { ...manifest, files: [...manifest.files, { ...manifest.files[2], path: "../escape" }] },
        "0.1.11",
        url,
      ),
    /路径/,
  );
});

test("macOS delta sidecar is omitted when changed objects cost at least a full archive", () => {
  const changed = [{ size: 90 }, { size: 5 }];
  assert.equal(macDeltaTransferIsSmaller(changed, 3, 1, 100), true);
  assert.equal(macDeltaTransferIsSmaller(changed, 4, 1, 100), false);
  assert.equal(macDeltaTransferIsSmaller(changed, 4, 2, 100), false);
});

test("macOS delta target tree must exactly match the independently built full archive", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mac-delta-full-bind-"));
  try {
    const app = path.join(root, "无限画布.app");
    mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
    const executable = path.join(app, "Contents", "MacOS", "无限画布");
    writeFileSync(executable, "release-A");
    const archive = path.join(root, "full.app.tar.gz");
    const python = process.platform === "win32" ? "python" : "python3";
    const create = spawnSync(
      python,
      [
        "-c",
        "import tarfile,sys\nwith tarfile.open(sys.argv[2], 'w:gz') as archive:\n    archive.add(sys.argv[1], arcname='无限画布.app')\n",
        app,
        archive,
      ],
      { encoding: "utf8" },
    );
    assert.equal(create.status, 0, create.stderr);
    const files = (await inventoryMacFullArchive(archive, "无限画布.app")).map((entry) =>
      entry.kind === "file" ? { ...entry, source: "object" } : entry,
    );
    await assert.doesNotReject(
      assertMacDeltaMatchesFullArchive(archive, { appName: "无限画布.app", files }),
    );
    writeFileSync(executable, "release-B");
    const changedArchive = path.join(root, "changed.app.tar.gz");
    const changed = spawnSync(
      python,
      [
        "-c",
        "import tarfile,sys\nwith tarfile.open(sys.argv[2], 'w:gz') as archive:\n    archive.add(sys.argv[1], arcname='无限画布.app')\n",
        app,
        changedArchive,
      ],
      { encoding: "utf8" },
    );
    assert.equal(changed.status, 0, changed.stderr);
    await assert.rejects(
      assertMacDeltaMatchesFullArchive(changedArchive, { appName: "无限画布.app", files }),
      /目标文件树与完整 updater 包不一致/,
    );
    const extraArchive = path.join(root, "extra.app.tar.gz");
    const extra = spawnSync(
      python,
      [
        "-c",
        "import tarfile,sys\nwith tarfile.open(sys.argv[2], 'w:gz') as archive:\n    archive.add(sys.argv[1], arcname='无限画布.app')\n    archive.add(sys.argv[3], arcname='other.app/escape')\n",
        app,
        extraArchive,
        executable,
      ],
      { encoding: "utf8" },
    );
    assert.equal(extra.status, 0, extra.stderr);
    await assert.rejects(inventoryMacFullArchive(extraArchive, "无限画布.app"), /意外顶层路径/);
    const privilegedArchive = path.join(root, "privileged.app.tar.gz");
    const privileged = spawnSync(
      python,
      [
        "-c",
        "import tarfile,sys\ndef mark(info):\n    if info.name.endswith('/Contents/MacOS/无限画布'): info.mode |= 0o4000\n    return info\nwith tarfile.open(sys.argv[2], 'w:gz') as archive:\n    archive.add(sys.argv[1], arcname='无限画布.app', filter=mark)\n",
        app,
        privilegedArchive,
      ],
      { encoding: "utf8" },
    );
    assert.equal(privileged.status, 0, privileged.stderr);
    await assert.rejects(inventoryMacFullArchive(privilegedArchive, "无限画布.app"), /特权权限位/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("content-addressed objects deduplicate identical bytes without losing component paths", () => {
  const shared = "a".repeat(64);
  const manifest = {
    components: [
      { files: [{ path: "manifest.json", sha256: shared, size: 8 }] },
      { files: [{ path: "runtime-manifest.json", sha256: shared, size: 8 }] },
      { files: [] },
      { files: [] },
    ],
  };
  const objects = collectRuntimeResourceObjects(manifest, REPO_ROOT);
  assert.equal(objects.length, 1);
  assert.equal(objects[0].sha256, shared);
});

test("legacy manifest promotion only references full same-version artifacts from this bucket", () => {
  const base = "https://sd20-zq.tos-cn-beijing.volces.com/infinite-canvas/updates";
  const windows = {
    url: `${base}/windows-x86_64/${encodeURIComponent("无限画布_0.1.8_x64-setup.exe")}`,
    signature: "win-sig",
  };
  const mac = {
    url: `${base}/darwin-aarch64/${encodeURIComponent("无限画布_0.1.8_aarch64-full.app.tar.gz")}`,
    signature: "mac-sig",
  };
  const feeds = {
    "windows-x86_64": { version: "0.1.8", platforms: { "windows-x86_64": windows } },
    "darwin-aarch64": { version: "0.1.8", platforms: { "darwin-aarch64": mac } },
  };
  assert.deepEqual(collectLegacyChannelPlatforms("0.1.8", feeds, base), {
    "windows-x86_64": windows,
    "darwin-aarch64": mac,
  });
  assert.throws(
    () => collectLegacyChannelPlatforms("0.1.8", { ...feeds, "darwin-aarch64": null }, base),
    /darwin-aarch64/,
  );
  assert.throws(
    () =>
      collectLegacyChannelPlatforms(
        "0.1.8",
        {
          ...feeds,
          "windows-x86_64": {
            ...feeds["windows-x86_64"],
            platforms: {
              "windows-x86_64": { ...windows, url: windows.url.replace("setup", "slim-setup") },
            },
          },
        },
        base,
      ),
    /完整 windows-x86_64/,
  );
  assert.throws(
    () =>
      collectLegacyChannelPlatforms(
        "0.1.8",
        {
          ...feeds,
          "darwin-aarch64": {
            ...feeds["darwin-aarch64"],
            platforms: {
              "darwin-aarch64": { ...mac, url: mac.url.replace(base, "https://other.example") },
            },
          },
        },
        base,
      ),
    /预期 TOS 前缀/,
  );
});

test("immutable versioned objects require matching SHA-256 metadata and length", () => {
  const digest = "a".repeat(64);
  assert.equal(
    immutableObjectMatches(
      { status: 200, headers: { "x-tos-meta-sha256": digest, "content-length": "42" } },
      digest,
      42,
    ),
    true,
  );
  assert.equal(
    immutableObjectMatches({ status: 200, headers: { "content-length": "42" } }, digest, 42),
    false,
  );
  assert.equal(
    immutableObjectMatches(
      { status: 200, headers: { "x-tos-meta-sha256": digest, "content-length": "41" } },
      digest,
      42,
    ),
    false,
  );
});

test("offline staging selects only same-version full NSIS and MSI", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "infinite-canvas-offline-"));
  try {
    const full = path.join(dir, "无限画布_0.1.8_x64-setup.exe");
    const msi = path.join(dir, "无限画布_0.1.8_x64_zh-CN.msi");
    writeFileSync(full, "full");
    writeFileSync(`${full}.sig`, "sig");
    writeFileSync(msi, "msi");
    writeFileSync(path.join(dir, "无限画布_0.1.7_x64-setup.exe"), "old");
    assert.deepEqual(
      new Set(collectFullOfflineFiles(dir, "0.1.8")),
      new Set([full, `${full}.sig`, msi]),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("macOS offline staging selects one same-version arm64 DMG and optional install helper", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "infinite-canvas-mac-offline-"));
  try {
    const dmg = path.join(dir, "无限画布_0.1.10_aarch64.dmg");
    const helper = path.join(dir, "install-macos.sh");
    writeFileSync(dmg, "current");
    writeFileSync(helper, "#!/bin/sh\n");
    writeFileSync(path.join(dir, "无限画布_0.1.9_aarch64.dmg"), "old");
    writeFileSync(path.join(dir, "无限画布_0.1.10_x64.dmg"), "other-arch");
    assert.deepEqual(collectMacFullOfflineFiles(dir, "0.1.10"), [dmg, helper]);
    rmSync(helper);
    assert.deepEqual(collectMacFullOfflineFiles(dir, "0.1.10"), [dmg]);
    assert.throws(() => collectMacFullOfflineFiles(dir, "0.1.11"), /恰好一个本版 aarch64 DMG/);
    mkdirSync(path.join(dir, "duplicate"));
    writeFileSync(path.join(dir, "duplicate", path.basename(dmg)), "duplicate");
    assert.throws(() => collectMacFullOfflineFiles(dir, "0.1.10"), /恰好一个本版 aarch64 DMG/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function headersTimeoutError() {
  const error = new TypeError("fetch failed");
  error.cause = Object.assign(new Error("Headers Timeout Error"), {
    code: "UND_ERR_HEADERS_TIMEOUT",
  });
  return error;
}

test("Headers Timeout Error from undici fetch is retryable", () => {
  assert.equal(isRetryableTosNetworkError(headersTimeoutError()), true);
  assert.equal(
    isRetryableTosNetworkError(new Error("TOS 鉴权失败（ListObjects HTTP 403）")),
    false,
  );
});

test("tosFetch retries Headers Timeout then succeeds", async () => {
  let calls = 0;
  const result = await tosFetch({
    method: "GET",
    host: "sd20-zq.tos-cn-beijing.volces.com",
    objectKey: "infinite-canvas/updates/latest.json",
    region: "cn-beijing",
    accessKey: "ak",
    secretKey: "sk",
    anonymous: true,
    attempts: 3,
    sleep: async () => {},
    requestImpl: async () => {
      calls += 1;
      if (calls < 3) throw headersTimeoutError();
      return {
        status: 200,
        text: "{}",
        url: "https://sd20-zq.tos-cn-beijing.volces.com/infinite-canvas/updates/latest.json",
      };
    },
  });
  assert.equal(calls, 3);
  assert.equal(result.status, 200);
  assert.equal(result.text, "{}");
});

test("tosFetch surfaces the original Headers Timeout after retries are exhausted", async () => {
  await assert.rejects(
    () =>
      tosFetch({
        method: "GET",
        host: "sd20-zq.tos-cn-beijing.volces.com",
        objectKey: "probe",
        region: "cn-beijing",
        accessKey: "ak",
        secretKey: "sk",
        anonymous: true,
        attempts: 2,
        sleep: async () => {},
        requestImpl: async () => {
          throw headersTimeoutError();
        },
      }),
    /请求 TOS 失败：fetch failed \(Headers Timeout Error\)/,
  );
});

test("parses TOS multipart upload id and complete XML", () => {
  assert.equal(
    parseTosUploadId(
      `<?xml version="1.0"?><InitiateMultipartUploadResult><UploadId>abc+123==</UploadId></InitiateMultipartUploadResult>`,
    ),
    "abc+123==",
  );
  assert.equal(
    parseTosUploadId(
      `{"Bucket":"sd20-zq","Key":"infinite-canvas/updates/setup.exe","UploadId":"2c38cf561063d3c3592a07ad7c75ae396aad7c75"}`,
    ),
    "2c38cf561063d3c3592a07ad7c75ae396aad7c75",
  );
  assert.equal(normalizeTosEtag('"abc+123=="'), "abc+123==");
  assert.equal(
    buildCompleteMultipartJson([
      { partNumber: 1, etag: '"etag-a"' },
      { partNumber: 2, etag: '"etag-b"' },
    ]),
    '{"Parts":[{"PartNumber":1,"ETag":"etag-a"},{"PartNumber":2,"ETag":"etag-b"}]}',
  );
});
