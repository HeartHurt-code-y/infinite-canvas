import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  RESOURCE_COMPONENTS,
  assertFullNsisCoversResourceRelease,
  assertRuntimeReleaseCoversResources,
  assertRuntimeReleaseShape,
  inventoryComponent,
  resolveResourceManifestSignerEnv,
  validRuntimeResourcePath,
} from "./runtime-resource-release.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");

test("resource manifest signer passes exactly one private key source to Tauri", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "resource-signing-env-"));
  try {
    const keyPath = path.join(root, ".updater-key");
    writeFileSync(keyPath, "example-test-key\n");
    const local = resolveResourceManifestSignerEnv({}, keyPath);
    assert.equal(local.TAURI_SIGNING_PRIVATE_KEY, "example-test-key");
    assert.equal(local.TAURI_SIGNING_PRIVATE_KEY_PATH, undefined);
    assert.equal(local.TAURI_SIGNING_PRIVATE_KEY_PASSWORD, "");

    const inline = resolveResourceManifestSignerEnv(
      {
        TAURI_SIGNING_PRIVATE_KEY: "explicit-test-key",
        TAURI_SIGNING_PRIVATE_KEY_PATH: keyPath,
        TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "test-password",
      },
      keyPath,
    );
    assert.equal(inline.TAURI_SIGNING_PRIVATE_KEY, "explicit-test-key");
    assert.equal(inline.TAURI_SIGNING_PRIVATE_KEY_PATH, undefined);
    assert.equal(inline.TAURI_SIGNING_PRIVATE_KEY_PASSWORD, "test-password");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("signed release inventory covers all four logical component trees and full NSIS paths", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "resource-release-"));
  try {
    for (const definition of RESOURCE_COMPONENTS) {
      const directory = path.join(root, definition.source);
      mkdirSync(path.dirname(path.join(directory, definition.manifestPath)), { recursive: true });
      writeFileSync(path.join(directory, definition.manifestPath), "manifest");
      writeFileSync(path.join(directory, "payload.bin"), definition.name);
    }
    const components = await Promise.all(
      RESOURCE_COMPONENTS.map((definition) => inventoryComponent(root, definition)),
    );
    const manifest = {
      schemaVersion: 1,
      version: "0.2.0",
      platform: "windows-x86_64",
      objectBaseUrl: "https://example.com/infinite-canvas/updates/resources/objects/",
      components,
    };
    assert.equal(
      assertRuntimeReleaseShape(manifest),
      components.reduce((sum, item) => sum + item.files.length, 0) -
        (RESOURCE_COMPONENTS.length - 1),
    );
    await assertRuntimeReleaseCoversResources(manifest, root);
    const script = components
      .flatMap((component, index) =>
        component.files.map(
          (file) =>
            `File /a "/oname=${RESOURCE_COMPONENTS[index].installed.replaceAll("/", "\\")}\\${file.path.replaceAll("/", "\\")}" "source"`,
        ),
      )
      .join("\n");
    assert.doesNotThrow(() => assertFullNsisCoversResourceRelease(script, manifest));
    assert.throws(
      () => assertFullNsisCoversResourceRelease(script.replace(/^File[^\n]*\n/, ""), manifest),
      /未唯一包含/,
    );
    assert.throws(
      () =>
        assertFullNsisCoversResourceRelease(
          `${script}\nFile /a "/oname=ffmpeg\\rogue.bin" "source"`,
          manifest,
        ),
      /未签名资源/,
    );
    writeFileSync(path.join(root, RESOURCE_COMPONENTS[0].source, "payload.bin"), "changed");
    await assert.rejects(assertRuntimeReleaseCoversResources(manifest, root), /不一致/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("publisher rejects every path class the Windows client cannot install", () => {
  for (const value of [
    "../outside",
    "a/../b",
    "C:/outside",
    "a\\b",
    "CON.txt",
    "nul.bin",
    "a./b",
    "a /b",
    "a/",
    "/root",
    "a//b",
    "a:b",
    "file?.json",
    "deep/".repeat(32) + "file",
    "界".repeat(342),
  ]) {
    assert.equal(validRuntimeResourcePath(value), false, value);
  }
  assert.equal(validRuntimeResourcePath("data/manifest.json"), true);
  assert.equal(validRuntimeResourcePath("folder/".repeat(31) + "file"), true);
});

test("release manifest rejects traversal, duplicate paths, and tampered component pin", () => {
  const components = RESOURCE_COMPONENTS.map((definition) => ({
    name: definition.name,
    manifestPath: definition.manifestPath,
    manifestSha256: digest("manifest"),
    files: [{ path: definition.manifestPath, size: 8, sha256: digest("manifest") }],
  }));
  const manifest = {
    schemaVersion: 1,
    version: "0.2.0",
    platform: "windows-x86_64",
    objectBaseUrl: "https://example.com/infinite-canvas/updates/resources/objects/",
    components,
  };
  assert.equal(assertRuntimeReleaseShape(manifest), 1);
  assert.throws(
    () =>
      assertRuntimeReleaseShape({
        ...manifest,
        components: [
          { ...components[0], files: [{ path: "../escape", size: 1, sha256: digest("a") }] },
          ...components.slice(1),
        ],
      }),
    /清单格式无效/,
  );
  assert.throws(
    () =>
      assertRuntimeReleaseShape({
        ...manifest,
        components: [{ ...components[0], manifestSha256: digest("wrong") }, ...components.slice(1)],
      }),
    /哈希不一致/,
  );
  for (const variant of [".complete.json", ".Complete.JSON"]) {
    assert.throws(
      () =>
        assertRuntimeReleaseShape({
          ...manifest,
          components: [
            {
              ...components[0],
              files: [...components[0].files, { path: variant, size: 1, sha256: digest("a") }],
            },
            ...components.slice(1),
          ],
        }),
      /清单格式无效/,
    );
  }
  assert.throws(
    () =>
      assertRuntimeReleaseShape({
        ...manifest,
        components: [
          {
            ...components[0],
            files: [
              ...components[0].files,
              { path: "MANIFEST.JSON", size: 1, sha256: digest("a") },
            ],
          },
          ...components.slice(1),
        ],
      }),
    /清单格式无效/,
  );
  assert.throws(
    () =>
      assertRuntimeReleaseShape({
        ...manifest,
        components: [
          { ...components[0], files: [{ ...components[0].files[0], size: 8 * 1024 ** 3 + 1 }] },
          ...components.slice(1),
        ],
      }),
    /清单格式无效/,
  );
  assert.throws(
    () =>
      assertRuntimeReleaseShape({
        ...manifest,
        components: components.map((component) => ({
          ...component,
          files: [{ ...component.files[0], size: 6 * 1024 ** 3 }],
        })),
      }),
    /容量/,
  );
  const manyFiles = Array.from({ length: 200_000 }, (_, index) => ({
    path: `file-${index}`,
    size: 0,
    sha256: digest("empty"),
  }));
  assert.throws(
    () =>
      assertRuntimeReleaseShape({
        ...manifest,
        components: [
          { ...components[0], files: [components[0].files[0], ...manyFiles] },
          ...components.slice(1),
        ],
      }),
    /数量/,
  );
});
