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
  readTosPublishEnv,
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
