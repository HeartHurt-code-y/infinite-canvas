import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertCompiledManifestPinsOutput,
  assertFullNsisNewerThanInputs,
  assertPinnedTauriCli,
  assertSlimNsisScript,
  expectedWindowsBundleNames,
} from "./tauri-bundle-slim.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("full Windows bundles retain every signed style-library file at its runtime path", () => {
  const tauriRoot = path.join(repoRoot, "src-tauri");
  const config = JSON.parse(readFileSync(path.join(tauriRoot, "tauri.conf.json"), "utf8"));
  const sourcePrefix = "skills/gpt-image-2-style-library/";
  const manifest = JSON.parse(
    readFileSync(path.join(tauriRoot, sourcePrefix, "data/manifest.json"), "utf8"),
  );
  const signedFiles = new Set(manifest.files.map((file) => file.path));

  assert.equal(config.bundle.resources[sourcePrefix], sourcePrefix);
  assert.ok(signedFiles.has("LICENSE"));
  for (const file of signedFiles) {
    assert.ok(existsSync(path.join(tauriRoot, sourcePrefix, file)), `missing source: ${file}`);
  }
  for (const source of Object.keys(config.bundle.resources)) {
    if (source === sourcePrefix || !source.startsWith(sourcePrefix)) continue;
    assert.ok(
      !signedFiles.has(source.slice(sourcePrefix.length)),
      `separate resource mapping removes a signed file from the bundled style tree: ${source}`,
    );
  }
});

test("slim override replaces the resource map and uses its own uninstall hook", () => {
  const base = JSON.parse(
    readFileSync(path.join(repoRoot, "src-tauri", "tauri.conf.json"), "utf8"),
  );
  const slim = JSON.parse(
    readFileSync(path.join(repoRoot, "src-tauri", "tauri.slim.conf.json"), "utf8"),
  );
  assert.ok(Object.keys(base.bundle.resources).length > 0);
  assert.deepEqual(slim.bundle.resources, []);
  assert.equal(slim.bundle.windows.nsis.installerHooks, "windows/slim-installer-hooks.nsh");
  assert.equal(slim.bundle.windows.nsis.template, "windows/slim-installer.nsi");
  const template = readFileSync(
    path.join(repoRoot, "src-tauri", "windows", "slim-installer.nsi"),
    "utf8",
  );
  const hook = readFileSync(
    path.join(repoRoot, "src-tauri", "windows", "slim-installer-hooks.nsh"),
    "utf8",
  );
  assert.match(
    template,
    /Function \.onInit\b[\s\S]*?!insertmacro NSIS_HOOK_PREFLIGHT[\s\S]*?FunctionEnd/,
  );
  assert.match(hook, /ExecWait '[^']+--check-runtime-components'/);
});

test("staged slim name stays distinct from full installer and remains Tauri-detectable", () => {
  const names = expectedWindowsBundleNames("0.1.8");
  assert.notEqual(names.slim, names.nsis);
  assert.match(names.slim, /_0\.1\.8_x64-slim-setup\.exe$/);
});

test("vendored NSIS template rejects a changed Tauri CLI version", () => {
  assert.doesNotThrow(() => assertPinnedTauriCli("2.11.4"));
  assert.throws(() => assertPinnedTauriCli("2.11.5"), /请先审查并同步模板/);
});

test("generated slim NSIS script must contain hook and no heavy resources", () => {
  const safe =
    '!include "slim-installer-hooks.nsh"\nFunction .onInit\n!insertmacro NSIS_HOOK_PREFLIGHT\nFunctionEnd\nFile "app.exe"';
  assert.doesNotThrow(() => assertSlimNsisScript(safe));
  assert.throws(
    () => assertSlimNsisScript(`${safe}\nFile /a "/oname=blender\\runtime\\blender.exe"`),
    /瘦包仍包含 blender/,
  );
  assert.throws(() => assertSlimNsisScript('File "app.exe"'), /缺少卸载/);
  assert.throws(
    () =>
      assertSlimNsisScript('!include "slim-installer-hooks.nsh"\nFunction .onInit\nFunctionEnd'),
    /缺少安装前/,
  );
});

test("slim executable must pin exactly the signed target component manifests", () => {
  const pins = {
    blender: "a".repeat(64),
    "remotion-runtime": "b".repeat(64),
    ffmpeg: "c".repeat(64),
    "gpt-image-2-style-library": "d".repeat(64),
  };
  const manifest = {
    components: Object.entries(pins).map(([name, manifestSha256]) => ({
      name,
      manifestSha256,
    })),
  };
  const output = `IC_RUNTIME_COMPONENT_PINS_V1 ${JSON.stringify(pins)}\n`;
  assert.doesNotThrow(() => assertCompiledManifestPinsOutput(output, manifest));
  assert.throws(
    () =>
      assertCompiledManifestPinsOutput(output.replace("a".repeat(64), "e".repeat(64)), manifest),
    /不一致/,
  );
  assert.throws(() => assertCompiledManifestPinsOutput(`${output}${output}`, manifest), /唯一/);
  assert.throws(
    () => assertCompiledManifestPinsOutput("IC_RUNTIME_COMPONENT_PINS_V1 {}\n", manifest),
    /不一致/,
  );
});

test("slim build rejects a full NSIS older than any signed resource or release executable", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "slim-build-freshness-"));
  try {
    const source = path.join(root, "src-tauri", "resources", "blender", "manifest.json");
    const executable = path.join(root, "release.exe");
    const fullNsis = path.join(root, "full-setup.exe");
    mkdirSync(path.dirname(source), { recursive: true });
    for (const file of [source, executable, fullNsis]) writeFileSync(file, "fixture");
    const before = new Date("2026-01-01T00:00:00Z");
    const bundleTime = new Date("2026-01-02T00:00:00Z");
    const after = new Date("2026-01-03T00:00:00Z");
    for (const file of [source, executable]) utimesSync(file, before, before);
    utimesSync(fullNsis, bundleTime, bundleTime);
    const manifest = {
      components: [{ name: "blender", files: [{ path: "manifest.json" }] }],
    };
    assert.doesNotThrow(() => assertFullNsisNewerThanInputs(fullNsis, executable, manifest, root));
    utimesSync(source, after, after);
    assert.throws(
      () => assertFullNsisNewerThanInputs(fullNsis, executable, manifest, root),
      /重新构建完整安装包/,
    );
    utimesSync(source, before, before);
    const nearBundleTime = new Date(bundleTime.getTime() + 120);
    utimesSync(source, nearBundleTime, nearBundleTime);
    assert.throws(
      () => assertFullNsisNewerThanInputs(fullNsis, executable, manifest, root),
      /重新构建完整安装包/,
    );
    utimesSync(source, before, before);
    utimesSync(executable, nearBundleTime, nearBundleTime);
    assert.doesNotThrow(() => assertFullNsisNewerThanInputs(fullNsis, executable, manifest, root));
    const tooFarAfterBundle = new Date(bundleTime.getTime() + 1_000);
    utimesSync(executable, tooFarAfterBundle, tooFarAfterBundle);
    assert.throws(
      () => assertFullNsisNewerThanInputs(fullNsis, executable, manifest, root),
      /重新构建完整安装包/,
    );
    utimesSync(executable, after, after);
    assert.throws(
      () => assertFullNsisNewerThanInputs(fullNsis, executable, manifest, root),
      /重新构建完整安装包/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
