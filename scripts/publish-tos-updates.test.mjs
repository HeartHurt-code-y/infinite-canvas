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
  readTosPublishEnv,
  tosFetch,
} from "./publish-tos-updates.mjs";
import { tosUpdatesLatestJsonUrl } from "./tos-updates-config.mjs";

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
    writeFileSync(path.join(dir, "macos", "无限画布.app.tar.gz"), "pkg");
    writeFileSync(path.join(dir, "macos", "无限画布.app.tar.gz.sig"), "sig");
    writeFileSync(path.join(dir, "nsis", "无限画布_0.1.1_x64-setup.exe"), "exe");
    writeFileSync(path.join(dir, "helper", "install-macos.sh"), "#!/bin/sh\n");
    writeFileSync(path.join(dir, "notes.txt"), "skip me");
    const picked = new Set(collectPublishFilePaths(dir).map((filePath) => path.basename(filePath)));
    assert.deepEqual(
      picked,
      new Set([
        "install-macos.sh",
        "无限画布.app.tar.gz",
        "无限画布.app.tar.gz.sig",
        "无限画布_0.1.1_x64-setup.exe",
      ]),
    );
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

test("tauri updater endpoint points at the public TOS latest.json", () => {
  const conf = JSON.parse(
    readFileSync(path.join(REPO_ROOT, "src-tauri", "tauri.conf.json"), "utf8"),
  );
  assert.deepEqual(conf.plugins.updater.endpoints, [tosUpdatesLatestJsonUrl()]);
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
