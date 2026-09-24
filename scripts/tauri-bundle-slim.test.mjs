import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertPinnedTauriCli,
  assertSlimNsisScript,
  expectedWindowsBundleNames,
} from "./tauri-bundle-slim.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
