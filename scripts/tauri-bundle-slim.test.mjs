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
  assertReleaseExecutableFreshness,
  assertReusableFullVersions,
  assertSlimNsisScript,
  expectedWindowsBundleNames,
  prepareSlimBundleResources,
  slimBundleCliArgs,
  writeSlimOverrideConfig,
} from "./tauri-bundle-slim.mjs";
import {
  buildRuntimeComponentCatalog,
  componentBytesSha256,
  describeRuntimeComponent,
  RUNTIME_COMPONENTS,
  runtimeComponentArchiveUrl,
} from "./runtime-component-catalog.mjs";

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

test("slim-only reuse requires a signed full release between the bridge and target", () => {
  assert.doesNotThrow(() => assertReusableFullVersions("0.1.12", "0.2.0", "0.1.10"));
  for (const [source, target, bridge] of [
    ["0.1.10", "0.1.10", "0.1.10"],
    ["0.2.0", "0.2.0", "0.1.10"],
    ["0.1.9", "0.2.0", "0.1.10"],
    ["not-a-version", "0.2.0", "0.1.10"],
  ]) {
    assert.throws(() => assertReusableFullVersions(source, target, bridge), /复用的完整包版本/);
  }
});

test("slim-only rejects an executable older than current source or frontend output", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "slim-exe-freshness-"));
  try {
    const exe = path.join(root, "release.exe");
    const source = path.join(root, "app.tsx");
    writeFileSync(exe, "built executable");
    writeFileSync(source, "source");
    const before = new Date("2026-01-01T00:00:00Z");
    const after = new Date("2026-01-02T00:00:00Z");
    utimesSync(source, before, before);
    utimesSync(exe, after, after);
    assert.doesNotThrow(() => assertReleaseExecutableFreshness(exe, [source]));
    utimesSync(source, new Date("2026-01-03T00:00:00Z"), new Date("2026-01-03T00:00:00Z"));
    assert.throws(() => assertReleaseExecutableFreshness(exe, [source]), /请重新构建程序/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function poseUpdateFixture(t, { catalogPinned = true } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "slim-pose-update-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const poseRoot = path.join(root, "src-tauri/resources/pose-runtime");
  mkdirSync(poseRoot, { recursive: true });
  const license = Buffer.from("verified fixture pose runtime");
  writeFileSync(path.join(poseRoot, "LICENSE.txt"), license);
  const inventory = Buffer.from(
    JSON.stringify([
      { path: "LICENSE.txt", size: license.length, sha256: componentBytesSha256(license) },
    ]),
  );
  writeFileSync(path.join(poseRoot, "files-manifest.json"), inventory);
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      component: "pose-runtime",
      runtime: { version: "1.0.0" },
      inventory: { path: "files-manifest.json", sha256: componentBytesSha256(inventory), count: 1 },
    }),
  );
  writeFileSync(path.join(poseRoot, "runtime-manifest.json"), manifest);
  const pose = await describeRuntimeComponent(
    RUNTIME_COMPONENTS.find(({ id }) => id === "pose-runtime"),
    { root },
  );
  const components = RUNTIME_COMPONENTS.map((definition) => {
    const data = Buffer.from(`manifest ${definition.id}`);
    const description =
      definition.id === "pose-runtime"
        ? pose
        : {
            id: definition.id,
            title: definition.title,
            description: definition.description,
            version: "1.0.0",
            manifestPath: definition.manifestPath,
            manifestSha256: componentBytesSha256(data),
            bundlePath: definition.bundlePath,
            dependencies: [...definition.dependencies],
            files: [
              {
                path: definition.manifestPath,
                size: data.length,
                sha256: componentBytesSha256(data),
                mode: 0o644,
              },
            ],
          };
    const sha256 = componentBytesSha256(Buffer.from(`archive ${definition.id}`));
    return {
      ...description,
      archive: {
        format: "zip",
        size: 100,
        sha256,
        url: runtimeComponentArchiveUrl(definition.id, sha256, { applicationVersion: "0.2.1" }),
      },
    };
  });
  const catalog = buildRuntimeComponentCatalog({ applicationVersion: "0.2.1", components });
  const catalogBytes = Buffer.from(JSON.stringify(catalog));
  const catalogPath = path.join(root, "src-tauri/resources/component-catalog.json");
  writeFileSync(catalogPath, catalogBytes);
  const executable = path.join(root, "release.exe");
  writeFileSync(executable, "release executable fixture");
  utimesSync(executable, new Date("2099-01-01T00:00:00Z"), new Date("2099-01-01T00:00:00Z"));
  const pins = {
    schemaVersion: 1,
    applicationVersion: "0.2.1",
    edition: "offline",
    catalogSha256: catalogPinned ? componentBytesSha256(catalogBytes) : "",
    manifestPins: Object.fromEntries(
      components.map(({ id, manifestSha256 }) => [id, manifestSha256]),
    ),
  };
  const options = {
    executable,
    applicationVersion: "0.2.1",
    root,
    readCompiledPins: async () => pins,
  };
  return { root, poseRoot, pose, catalogPath, catalog, pins, options };
}

test("legacy slim carries pinned pose and catalog without changing the four-component protocol", async (t) => {
  const fixture = await poseUpdateFixture(t);
  const prepared = await prepareSlimBundleResources(fixture.options);
  assert.deepEqual(prepared.resources, {
    "resources/pose-runtime/": "pose-runtime/",
    "resources/component-catalog.json": "component-catalog.json",
  });
  assert.deepEqual(prepared.expected, [
    ...fixture.pose.files.map(({ path: filename }) => `pose-runtime/${filename}`),
    "component-catalog.json",
  ]);
  assert.equal(prepared.inputs.length, 4);
  const protocol = readFileSync(
    path.join(repoRoot, "scripts/runtime-resource-release.mjs"),
    "utf8",
  );
  assert.doesNotMatch(
    protocol.slice(
      protocol.indexOf("export const RESOURCE_COMPONENTS"),
      protocol.indexOf("const asciiLower"),
    ),
    /pose-runtime|component-catalog/,
  );
});

test("an executable without a catalog pin still carries its pinned native pose", async (t) => {
  const fixture = await poseUpdateFixture(t, { catalogPinned: false });
  rmSync(fixture.catalogPath);
  const prepared = await prepareSlimBundleResources(fixture.options);
  assert.deepEqual(prepared.resources, { "resources/pose-runtime/": "pose-runtime/" });
});

test("legacy slim rejects missing or mismatched catalog and pose, and online executables", async (t) => {
  const fixture = await poseUpdateFixture(t);
  const originalCatalog = readFileSync(fixture.catalogPath);
  writeFileSync(fixture.catalogPath, Buffer.from("changed catalog"));
  await assert.rejects(prepareSlimBundleResources(fixture.options), /组件目录与程序内置摘要不一致/);
  rmSync(fixture.catalogPath);
  await assert.rejects(prepareSlimBundleResources(fixture.options), /ENOENT/);
  writeFileSync(fixture.catalogPath, originalCatalog);
  const manifestPin = fixture.pins.manifestPins["pose-runtime"];
  fixture.pins.manifestPins["pose-runtime"] = "f".repeat(64);
  await assert.rejects(prepareSlimBundleResources(fixture.options), /动捕清单与程序内置摘要不一致/);
  fixture.pins.manifestPins["pose-runtime"] = manifestPin;
  writeFileSync(path.join(fixture.poseRoot, "LICENSE.txt"), "damaged payload");
  await assert.rejects(prepareSlimBundleResources(fixture.options), /inventory entry mismatch/);
  rmSync(path.join(fixture.poseRoot, "LICENSE.txt"));
  await assert.rejects(prepareSlimBundleResources(fixture.options), /inventory count mismatch/);
  fixture.pins.edition = "online";
  await assert.rejects(prepareSlimBundleResources(fixture.options), /当前离线程序/);
});

test("legacy slim rejects an unpinned pose file inventory even if the catalog is self-consistent", async (t) => {
  const fixture = await poseUpdateFixture(t);
  fixture.catalog.components.find(({ id }) => id === "pose-runtime").files[0].sha256 = "e".repeat(
    64,
  );
  const bytes = Buffer.from(JSON.stringify(fixture.catalog));
  writeFileSync(fixture.catalogPath, bytes);
  fixture.pins.catalogSha256 = componentBytesSha256(bytes);
  await assert.rejects(prepareSlimBundleResources(fixture.options), /动捕文件清单与编译绑定/);
});

test("legacy slim rejects pose and catalog inputs newer than the executable", async (t) => {
  const fixture = await poseUpdateFixture(t);
  utimesSync(
    fixture.options.executable,
    new Date("2000-01-01T00:00:00Z"),
    new Date("2000-01-01T00:00:00Z"),
  );
  await assert.rejects(prepareSlimBundleResources(fixture.options), /早于当前源码或前端产物/);
});

function mergePatch(target, patch) {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const next = target && typeof target === "object" && !Array.isArray(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = mergePatch(next[key], value);
  }
  return next;
}

test("single slim overlay keeps resource tombstones through Tauri's pre-merge and signing", async (t) => {
  const fixture = await poseUpdateFixture(t);
  const base = {
    bundle: {
      resources: {
        "resources/blender/": "blender/",
        "resources/pose-runtime/": "pose-runtime/",
        "future-heavy/": "future-heavy/",
      },
    },
  };
  writeFileSync(path.join(fixture.root, "src-tauri/tauri.conf.json"), JSON.stringify(base));
  writeFileSync(
    path.join(fixture.root, "src-tauri/tauri.slim.conf.json"),
    readFileSync(path.join(repoRoot, "src-tauri/tauri.slim.conf.json")),
  );
  const prepared = await prepareSlimBundleResources(fixture.options);
  const { configPath, config } = await writeSlimOverrideConfig(prepared, { root: fixture.root });
  const args = slimBundleCliArgs(configPath);
  assert.equal(args.filter((argument) => argument === "--config").length, 1);
  assert.equal(config.bundle.createUpdaterArtifacts, true);
  assert.deepEqual(mergePatch(base, config).bundle.resources, prepared.resources);
  assert.equal(config.bundle.resources["future-heavy/"], null);
  assert.deepEqual(
    mergePatch(base, mergePatch({}, config)).bundle.resources["future-heavy/"],
    "future-heavy/",
  );
  base.bundle.resources = ["resources/blender/"];
  writeFileSync(path.join(fixture.root, "src-tauri/tauri.conf.json"), JSON.stringify(base));
  const second = await writeSlimOverrideConfig(prepared, { root: fixture.root });
  assert.deepEqual(mergePatch(base, second.config).bundle.resources, prepared.resources);
  await assert.rejects(
    writeSlimOverrideConfig(prepared, {
      root: fixture.root,
      configPath: path.join(fixture.root, "arbitrary.json"),
    }),
    /单一受控/,
  );
});

test("generated legacy slim table must contain exactly pose and catalog, never missing or extra files", () => {
  const header =
    '!include "slim-installer-hooks.nsh"\nFunction .onInit\n!insertmacro NSIS_HOOK_PREFLIGHT\nFunctionEnd\n';
  const expected = ["pose-runtime/runtime-manifest.json", "component-catalog.json"];
  const script =
    header +
    expected
      .map((filename) => `File /a "/oname=${filename.replaceAll("/", "\\")}" "source"`)
      .join("\n");
  assert.equal(assertSlimNsisScript(script, expected), 2);
  assert.throws(() => assertSlimNsisScript(header, expected), /exact edition map/);
  assert.throws(
    () =>
      assertSlimNsisScript(`${script}\nFile /a "/oname=unexpected-large.dat" "source"`, expected),
    /exact edition map/,
  );
  assert.throws(
    () =>
      assertSlimNsisScript(`${script}\nFile /a "/oname=component-catalog.json" "source"`, expected),
    /exact edition map/,
  );
});
