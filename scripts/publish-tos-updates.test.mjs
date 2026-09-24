import assert from "node:assert/strict";
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
  compareReleaseVersions,
  checkChannelManifest,
  checkLegacyPlatformFeeds,
  collectLegacyChannelPlatforms,
  immutableObjectMatches,
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
    writeFileSync(path.join(dir, "macos", "无限画布.app.tar.gz"), "pkg");
    writeFileSync(path.join(dir, "macos", "无限画布.app.tar.gz.sig"), "sig");
    writeFileSync(path.join(dir, "nsis", "无限画布_0.1.1_x64-setup.exe"), "exe");
    writeFileSync(path.join(dir, "helper", "install-macos.sh"), "#!/bin/sh\n");
    writeFileSync(path.join(dir, "dmg", "无限画布_0.1.1_aarch64.dmg"), "dmg");
    writeFileSync(path.join(dir, "latest.json"), "{}\n");
    writeFileSync(path.join(dir, "notes.txt"), "skip me");
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
  assert.deepEqual(checkChannelManifest(latest, { ...latest, version: "0.1.9" }), {
    sameVersion: false,
    pubDate: undefined,
  });
  assert.equal(compareReleaseVersions("0.1.10", "0.1.9"), 1);
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
