import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertUpdaterEditionChannel } from "./write-latest-json.mjs";
import { publishUpdaterArtifacts } from "./publish-tos-updates.mjs";

function fixture(run) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "canvas-edition-channel-"));
  try {
    return run(directory);
  } finally {
    // Only the freshly allocated test fixture is removed.
    rmSync(directory, { recursive: true, force: true });
  }
}

test("online filename cannot enter the existing updater channel", () => {
  fixture((directory) => {
    writeFileSync(path.join(directory, "无限画布_0.2.1_x64-online-setup.exe"), "fixture");
    assert.throws(
      () => assertUpdaterEditionChannel(directory, "https://example.com/updates/windows-x86_64"),
      /独立频道/,
    );
    assert.doesNotThrow(() =>
      assertUpdaterEditionChannel(directory, "https://example.com/updates/windows-x86_64-online/"),
    );
  });
});

test("renaming a light installer does not bypass the distribution marker", () => {
  fixture((directory) => {
    mkdirSync(path.join(directory, "nsis"));
    writeFileSync(path.join(directory, "nsis", "无限画布_0.2.1_x64-setup.exe"), "fixture");
    writeFileSync(path.join(directory, "distribution.json"), JSON.stringify({ edition: "online" }));
    assert.throws(
      () => assertUpdaterEditionChannel(directory, "https://example.com", { rejectOnline: true }),
      /禁止写入/,
    );
  });
});

test("raw Cargo bundle subdirectories inherit the online target marker", () => {
  fixture((directory) => {
    const target = path.join(directory, "native-target");
    const nsis = path.join(target, "release", "bundle", "nsis");
    mkdirSync(nsis, { recursive: true });
    writeFileSync(path.join(nsis, "无限画布_0.2.1_x64-setup.exe"), "fixture");
    writeFileSync(path.join(target, "distribution.json"), JSON.stringify({ edition: "online" }));
    assert.throws(
      () => assertUpdaterEditionChannel(nsis, "https://example.com", { rejectOnline: true }),
      /禁止写入/,
    );
  });
});

test("the conventional online target path is rejected even after a failed unmarked build", () => {
  fixture((directory) => {
    const bundle = path.join(
      directory,
      ".cache",
      "tauri-editions",
      "online",
      "target",
      "release",
      "bundle",
    );
    mkdirSync(bundle, { recursive: true });
    writeFileSync(path.join(bundle, "无限画布_0.2.1_x64-setup.exe"), "fixture");
    assert.throws(
      () => assertUpdaterEditionChannel(bundle, "https://example.com", { rejectOnline: true }),
      /禁止写入/,
    );
  });
});

test("the old publisher rejects light edition before reading credentials or making requests", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "canvas-edition-publish-"));
  try {
    writeFileSync(path.join(directory, "无限画布_0.2.1_x64-online-setup.exe"), "fixture");
    await assert.rejects(
      publishUpdaterArtifacts({ "bundle-dir": directory, channel: "windows-x86_64", env: {} }),
      /独立发布流程/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("existing full and slim releases retain their existing channel behavior", () => {
  fixture((directory) => {
    writeFileSync(path.join(directory, "无限画布_0.2.1_x64-slim-setup.exe"), "fixture");
    writeFileSync(
      path.join(directory, "distribution.json"),
      JSON.stringify({ edition: "offline" }),
    );
    assert.doesNotThrow(() => assertUpdaterEditionChannel(directory, "https://example.com"));
  });
});
