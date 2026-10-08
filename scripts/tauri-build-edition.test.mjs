import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  archiveEditionBundles,
  buildTauriEdition,
  editionArtifactBasename,
  editionBuildPlan,
  writeEditionTargetMarker,
  writeEditionOverrideConfig,
} from "./tauri-build-edition.mjs";
import {
  COMPONENT_REPO_ROOT,
  componentBytesSha256,
  componentFileSha256,
} from "./runtime-component-catalog.mjs";
import { verifyNsisEditionResourceTable } from "./verify-nsis-edition-resources.mjs";
import { collectEditionSourceFingerprint } from "./edition-source-fingerprint.mjs";

async function sourceFixture(root) {
  for (const relative of [
    "pnpm-lock.yaml",
    "index.html",
    "tsconfig.json",
    "tsconfig.node.json",
    "vite.config.ts",
    "src-tauri/build.rs",
    "src-tauri/Cargo.toml",
    "src-tauri/Cargo.lock",
    "src/main.ts",
    "src-tauri/src/lib.rs",
  ]) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), "fixture compilation input");
  }
  await writeFile(path.join(root, "package.json"), '{"version":"0.2.1"}');
  for (const filename of ["tauri.conf.json", "tauri.online.conf.json"])
    await writeFile(
      path.join(root, "src-tauri", filename),
      await readFile(path.join(COMPONENT_REPO_ROOT, "src-tauri", filename)),
    );
}

test("edition arguments use one generated merge patch with isolated Windows output", async () => {
  const online = editionBuildPlan("online", ["--bundles", "nsis"], {
    platform: "win32",
    arch: "x64",
    environment: {},
  });
  const offline = editionBuildPlan("offline", [], {
    platform: "win32",
    arch: "x64",
    environment: {},
  });
  assert.notEqual(online.targetDirectory, offline.targetDirectory);
  assert.equal(online.env.IC_DISTRIBUTION_EDITION, "online");
  assert.equal(online.args.filter((argument) => argument === "--config").length, 1);
  assert.equal(online.args[2], online.generatedConfigPath);
  assert.ok(
    online.generatedConfigPath.endsWith(path.join("online", "tauri-edition.generated.json")),
  );
  const readConfig = async (filename) =>
    JSON.parse(await readFile(path.join(COMPONENT_REPO_ROOT, "src-tauri", filename)));
  const onlineConfig = await readConfig("tauri.online.conf.json");
  const offlineConfig = await readConfig("tauri.offline.conf.json");
  assert.deepEqual(Object.keys(onlineConfig.bundle.resources), [
    "resources/ffmpeg/",
    "skills/anime-drama-v23/",
    "skills/music-video-workflow/",
    "resources/component-catalog.json",
  ]);
  assert.equal(Object.keys(offlineConfig.bundle.resources).length, 8);
  assert.equal(offlineConfig.bundle.resources["resources/ai-media-runtime/"], undefined);
  assert.equal(offlineConfig.bundle.resources["resources/ai-media-quality-runtime/"], undefined);
  assert.match(onlineConfig.plugins.updater.endpoints[0], /-online\/latest\.json$/);
  assert.equal(offlineConfig.plugins, undefined);
  assert.throws(
    () => editionBuildPlan("online", [], { platform: "darwin", arch: "arm64" }),
    /only native Windows/,
  );
  assert.throws(
    () =>
      editionBuildPlan("online", ["--target", "aarch64-pc-windows-msvc"], {
        platform: "win32",
        arch: "x64",
      }),
    /only native Windows/,
  );
  assert.throws(
    () =>
      editionBuildPlan("online", ["--config", "other.json"], { platform: "win32", arch: "x64" }),
    /fixed/,
  );
  assert.throws(
    () =>
      editionBuildPlan("offline", ["-t", "aarch64-pc-windows-msvc"], {
        platform: "win32",
        arch: "x64",
        environment: {},
      }),
    /only native Windows/,
  );
});

test("generated merge patch deletes every base resource outside the selected map, including future additions", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ic-edition-override-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src-tauri"));
  const base = JSON.parse(
    await readFile(path.join(COMPONENT_REPO_ROOT, "src-tauri/tauri.conf.json")),
  );
  base.bundle.resources["resources/future-large-runtime/"] = "future-large-runtime/";
  await writeFile(path.join(root, "src-tauri/tauri.conf.json"), JSON.stringify(base));
  const selected = JSON.parse(
    await readFile(path.join(COMPONENT_REPO_ROOT, "src-tauri/tauri.online.conf.json")),
  );
  await writeFile(path.join(root, "src-tauri/tauri.online.conf.json"), JSON.stringify(selected));
  const plan = editionBuildPlan("online", [], {
    root,
    platform: "win32",
    arch: "x64",
    environment: {},
  });
  const generated = await writeEditionOverrideConfig(plan, root);
  assert.deepEqual(JSON.parse(await readFile(plan.generatedConfigPath)), generated);
  for (const key of Object.keys(base.bundle.resources))
    assert.equal(
      generated.bundle.resources[key],
      Object.hasOwn(selected.bundle.resources, key) ? selected.bundle.resources[key] : null,
      key,
    );
  assert.equal(generated.bundle.resources["resources/future-large-runtime/"], null);
  assert.deepEqual(generated.build, selected.build);
  assert.deepEqual(generated.plugins, selected.plugins);
  // Apply the RFC 7396 object-member semantics to the actual generated patch.
  const mergedResources = { ...base.bundle.resources };
  for (const [key, value] of Object.entries(generated.bundle.resources)) {
    if (value === null) delete mergedResources[key];
    else mergedResources[key] = value;
  }
  assert.deepEqual(mergedResources, selected.bundle.resources);
  assert.equal(base.bundle.resources["resources/blender/"], "blender/");
});

test("an array-based base resource configuration is replaced by the exact selected object", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ic-edition-array-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src-tauri"));
  await writeFile(
    path.join(root, "src-tauri/tauri.conf.json"),
    JSON.stringify({ bundle: { resources: ["resources/large/**"] } }),
  );
  const selected = {
    bundle: {
      resources: {
        "resources/ffmpeg/": "ffmpeg/",
        "resources/component-catalog.json": "component-catalog.json",
      },
    },
  };
  await writeFile(path.join(root, "src-tauri/tauri.online.conf.json"), JSON.stringify(selected));
  const plan = editionBuildPlan("online", [], {
    root,
    platform: "win32",
    arch: "x64",
    environment: {},
  });
  assert.deepEqual(
    (await writeEditionOverrideConfig(plan, root)).bundle.resources,
    selected.bundle.resources,
  );
});

test("raw bundle ancestors carry the edition marker before an installer exists", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ic-edition-marker-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const plan = editionBuildPlan("online", [], {
    root,
    platform: "win32",
    arch: "x64",
    environment: {},
  });
  await writeEditionTargetMarker(plan, "0.2.1", root);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(plan.targetDirectory, "distribution.json"))),
    {
      schemaVersion: 1,
      applicationVersion: "0.2.1",
      edition: "online",
      platform: "windows-x86_64",
    },
  );
});

test("edition names keep signed installer bytes and updater filename convention", () => {
  assert.equal(
    editionArtifactBasename("无限画布_0.2.1_x64-setup.exe", "online"),
    "无限画布_0.2.1_x64-online-setup.exe",
  );
  assert.equal(
    editionArtifactBasename("无限画布_0.2.1_x64-setup.exe.sig", "offline"),
    "无限画布_0.2.1_x64-offline-setup.exe.sig",
  );
});

test("staging writes an online-only standard feed and local publish plan without v1 optional-resource directives", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ic-edition-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const plan = editionBuildPlan("online", ["--bundles", "nsis"], {
    root,
    platform: "win32",
    arch: "x64",
    environment: {},
  });
  const bundle = path.join(plan.targetDirectory, "release/bundle/nsis");
  await mkdir(bundle, { recursive: true });
  await mkdir(path.join(root, "src-tauri/resources"), { recursive: true });
  const originalPath = path.join(bundle, "无限画布_0.2.1_x64-setup.exe");
  await sourceFixture(root);
  const sourceSnapshot = await collectEditionSourceFingerprint({ root, edition: "online" });
  const executablePath = path.join(plan.targetDirectory, "release/infinite-canvas.exe");
  await writeFile(executablePath, "verified compiled binary");
  await writeFile(originalPath, "same installer bytes");
  await writeFile(`${originalPath}.sig`, "public updater signature");
  await writeFile(
    path.join(root, "src-tauri/resources/component-catalog.json"),
    JSON.stringify({
      components: [
        {
          id: "pose-runtime",
          archive: {
            format: "zip",
            sha256: "a".repeat(64),
            size: 123,
            url: "https://trusted.invalid/pose.zip",
          },
        },
      ],
    }),
  );
  const artifacts = await archiveEditionBundles(plan, {
    applicationVersion: "0.2.1",
    root,
    sourceSnapshot,
  });
  assert.equal(artifacts.length, 2);
  const staged = path.join(root, ".cache/tauri-editions/online/artifacts/0.2.1");
  assert.equal(
    await componentFileSha256(path.join(staged, artifacts[0].path)),
    await componentFileSha256(originalPath),
  );
  const distribution = JSON.parse(await readFile(path.join(staged, "distribution.json")));
  assert.equal(distribution.edition, "online");
  const provenance = JSON.parse(await readFile(path.join(staged, "build-source.json")));
  assert.equal(provenance.sourceFingerprint, sourceSnapshot.fingerprint);
  assert.equal(provenance.nativeExecutable.sha256, await componentFileSha256(executablePath));
  assert.equal(
    provenance.nativeExecutable.path,
    ".cache/tauri-editions/online/target/release/infinite-canvas.exe",
  );
  const latest = JSON.parse(await readFile(path.join(staged, "latest.json")));
  assert.match(
    latest.platforms["windows-x86_64"].url,
    /windows-x86_64-online\/.*x64-online-setup\.exe$/,
  );
  assert.equal(latest.resourceManifest, undefined);
  assert.equal(latest.requiresRuntimeComponents, undefined);
  assert.equal(
    JSON.parse(await readFile(path.join(staged, "publish-manifest.json"))).channel,
    "windows-x86_64-online",
  );
});

test("edition build refuses to archive if an editable compilation input changes during its child build", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ic-edition-source-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await sourceFixture(root);
  const options = {
    root,
    platform: "win32",
    arch: "x64",
    environment: {},
    runBuild: async (plan) => {
      const bundle = path.join(plan.targetDirectory, "release/bundle/nsis");
      await mkdir(bundle, { recursive: true });
      await writeFile(path.join(bundle, "无限画布_0.2.1_x64-setup.exe"), "mixed build output");
      await writeFile(path.join(root, "src/main.ts"), "changed during compilation");
      return 0;
    },
  };
  await assert.rejects(
    buildTauriEdition("online", ["--bundles", "nsis"], options),
    /changed during edition build/,
  );
  await assert.rejects(
    readFile(path.join(root, ".cache/tauri-editions/online/artifacts/0.2.1/distribution.json")),
    /ENOENT/,
  );
});

test("NSIS resource verification catches implicit heavy resources and missing/duplicate catalog", () => {
  const script =
    'File /a "/oname=ffmpeg\\ffmpeg.exe" "source"\nFile /a "/oname=component-catalog.json" "catalog"';
  const expected = ["ffmpeg/ffmpeg.exe", "component-catalog.json"];
  assert.equal(verifyNsisEditionResourceTable(script, expected, "online"), 2);
  assert.throws(
    () =>
      verifyNsisEditionResourceTable(
        `${script}\nFile /a "/oname=blender\\runtime\\blender.exe" "large"`,
        expected,
        "online",
      ),
    /exact edition map/,
  );
  assert.throws(
    () =>
      verifyNsisEditionResourceTable(
        `${script}\nFile /a "/oname=component-catalog.json" "duplicate"`,
        expected,
        "online",
      ),
    /exact edition map/,
  );
  assert.throws(
    () =>
      verifyNsisEditionResourceTable(
        `${script}\nFile /a "/oname=unregistered\\large.bin" "unexpected"`,
        expected,
        "online",
      ),
    /exact edition map/,
  );
});

test("offline staging delivers two catalog-pinned AI ZIPs and a portable receipt without signing or recompressing them", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ic-offline-suite-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const plan = editionBuildPlan("offline", ["--bundles", "nsis"], {
    root,
    platform: "win32",
    arch: "x64",
    environment: {},
  });
  const bundle = path.join(plan.targetDirectory, "release/bundle/nsis");
  await mkdir(bundle, { recursive: true });
  await writeFile(path.join(bundle, "无限画布_0.2.1_x64-setup.exe"), "offline installer");
  await writeFile(path.join(bundle, "无限画布_0.2.1_x64-setup.exe.sig"), "installer signature");
  const packages = path.join(root, ".cache/runtime-components/packages");
  await mkdir(packages, { recursive: true });
  const components = [];
  for (const id of ["ai-media-runtime", "ai-media-quality-runtime"]) {
    const nativeBytes = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        component: id,
        buildInputs: { worker: "trusted source fingerprint" },
      }),
    );
    const archiveBytes = Buffer.from(`original compressed archive bytes for ${id}`);
    const archiveHash = componentBytesSha256(archiveBytes);
    const source = path.join(root, "src-tauri/resources", id);
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "runtime-manifest.json"), nativeBytes);
    await writeFile(path.join(packages, `${archiveHash}.zip`), archiveBytes);
    components.push({
      id,
      manifestPath: "runtime-manifest.json",
      manifestSha256: componentBytesSha256(nativeBytes),
      archive: { sha256: archiveHash, size: archiveBytes.length },
    });
  }
  const catalogPath = path.join(root, "src-tauri/resources/component-catalog.json");
  await writeFile(
    catalogPath,
    JSON.stringify({
      schemaVersion: 1,
      applicationVersion: "0.2.1",
      platform: "windows-x86_64",
      components,
    }),
  );
  const artifacts = await archiveEditionBundles(plan, { root, applicationVersion: "0.2.1" });
  assert.equal(artifacts.length, 4);
  const output = path.join(root, ".cache/tauri-editions/offline/artifacts/0.2.1");
  const receipt = JSON.parse(await readFile(path.join(output, "offline-components.json")));
  assert.equal(receipt.catalogSha256, await componentFileSha256(catalogPath));
  assert.equal(receipt.components.length, 2);
  for (const entry of receipt.components) {
    assert.match(entry.path, /^components\/ai-media(?:-quality)?-runtime-[a-f0-9]{64}\.zip$/);
    assert.equal(await componentFileSha256(path.join(output, entry.path)), entry.sha256);
    assert.equal(
      componentBytesSha256(Buffer.from(entry.nativeManifestBase64, "base64")),
      entry.manifestSha256,
    );
    assert.equal(
      artifacts.some((artifact) => artifact.path === `${entry.path}.sig`),
      false,
    );
  }
  assert.equal(
    JSON.parse(await readFile(path.join(output, "distribution.json"))).artifacts.length,
    4,
  );
});
