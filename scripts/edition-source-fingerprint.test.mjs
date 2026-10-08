import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertEditionBuildSourceFreshness,
  assertEditionSourcesUnchanged,
  collectEditionSourceFingerprint,
  createEditionBuildSource,
} from "./edition-source-fingerprint.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ic-source-fingerprint-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  async function put(relative, text) {
    const filename = path.join(root, relative);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, text);
  }
  for (const relative of [
    "package.json",
    "pnpm-lock.yaml",
    "index.html",
    "tsconfig.json",
    "tsconfig.node.json",
    "vite.config.ts",
    "src-tauri/build.rs",
    "src-tauri/Cargo.toml",
    "src-tauri/Cargo.lock",
    "src-tauri/tauri.conf.json",
    "src-tauri/tauri.online.conf.json",
    "src-tauri/tauri.offline.conf.json",
  ])
    await put(relative, relative === "package.json" ? '{"version":"0.2.1"}' : "fixture source");
  await put("src/main.ts", "export const version = 1;");
  await put(
    "src-tauri/src/lib.rs",
    'const METHODS: &str = include_str!(\n "../skills/methods.md",\n);',
  );
  await put("src-tauri/skills/methods.md", "embedded method");
  await put("public/brand.svg", "frontend static image");
  const executablePath = path.join(
    root,
    ".cache/tauri-editions/online/target/release/infinite-canvas.exe",
  );
  await put(path.relative(root, executablePath), "native executable fixture");
  return { root, put, executablePath };
}

test("deterministic compilation fingerprint includes source, public assets and literal native methods but excludes generated runtimes/output", async (t) => {
  const { root, put } = await fixture(t);
  const before = await collectEditionSourceFingerprint({ root, edition: "online" });
  assert.ok(before.files.some(({ path: filename }) => filename === "src-tauri/skills/methods.md"));
  assert.ok(before.files.some(({ path: filename }) => filename === "public/brand.svg"));
  assert.equal(
    before.files.some(({ path: filename }) => filename.endsWith("tauri.offline.conf.json")),
    false,
  );
  for (const relative of [
    "dist/assets/app.js",
    ".cache/tauri-editions/online/tauri-edition.generated.json",
    "src-tauri/gen/schemas/desktop-schema.json",
    "src-tauri/resources/blender/runtime.bin",
    "src-tauri/skills/library/images/example.jpg",
    "docs/release.md",
    "scripts/publish-online-updates.mjs",
  ])
    await put(relative, "generated or unrelated release material");
  assertEditionSourcesUnchanged(
    before,
    await collectEditionSourceFingerprint({ root, edition: "online" }),
  );
  for (const relative of [
    "src/main.ts",
    "src-tauri/skills/methods.md",
    "public/brand.svg",
    "pnpm-lock.yaml",
    "src-tauri/tauri.online.conf.json",
  ]) {
    await put(relative, `changed ${relative}`);
    const after = await collectEditionSourceFingerprint({ root, edition: "online" });
    assert.notEqual(before.fingerprint, after.fingerprint);
    assert.throws(
      () => assertEditionSourcesUnchanged(before, after),
      /changed during edition build/,
    );
  }
});

test("freshness receipt binds exact native executable and rejects changed, added and removed compilation sources", async (t) => {
  const { root, put, executablePath } = await fixture(t);
  const snapshot = await collectEditionSourceFingerprint({ root, edition: "online" });
  const record = await createEditionBuildSource({ snapshot, executablePath, root });
  const options = { root, edition: "online", applicationVersion: "0.2.1", executablePath };
  assert.equal(
    (await assertEditionBuildSourceFreshness(record, options)).sourceFreshnessVerified,
    true,
  );
  await put("src/new-feature.ts", "new feature");
  await assert.rejects(assertEditionBuildSourceFreshness(record, options), /freshness failed/);
  await rm(path.join(root, "src/new-feature.ts"));
  await put("src/main.ts", "changed feature");
  await assert.rejects(assertEditionBuildSourceFreshness(record, options), /freshness failed/);
  await put("src/main.ts", "export const version = 1;");
  await rm(path.join(root, "src-tauri/skills/methods.md"));
  await assert.rejects(assertEditionBuildSourceFreshness(record, options), /ENOENT/);
  await put("src-tauri/skills/methods.md", "embedded method");
  await put(path.relative(root, executablePath), "different native executable");
  await assert.rejects(
    assertEditionBuildSourceFreshness(record, options),
    /different native executable/,
  );
});

test("receipt rejects malformed, unsorted, duplicate, escaped paths and wrong edition/version/native location", async (t) => {
  const { root, executablePath } = await fixture(t);
  const record = await createEditionBuildSource({
    snapshot: await collectEditionSourceFingerprint({ root, edition: "online" }),
    executablePath,
    root,
  });
  const options = { root, edition: "online", applicationVersion: "0.2.1", executablePath };
  for (const change of [
    { edition: "offline" },
    { applicationVersion: "0.2.0" },
    { sourceFingerprint: "f".repeat(64) },
    { sourceFiles: [...record.sourceFiles].reverse() },
    {
      sourceFiles: [
        { ...record.sourceFiles[0], path: "../escape" },
        ...record.sourceFiles.slice(1),
      ],
    },
    { sourceFiles: [record.sourceFiles[0], ...record.sourceFiles] },
    {
      nativeExecutable: {
        ...record.nativeExecutable,
        path: ".cache/tauri-editions/offline/target/release/infinite-canvas.exe",
      },
    },
    { unexpectedField: true },
  ])
    await assert.rejects(assertEditionBuildSourceFreshness({ ...record, ...change }, options));
});

test("collector fails closed for missing mandatory input, nonliteral or escaping Rust include and symlink sources", async (t) => {
  const { root, put } = await fixture(t);
  await rm(path.join(root, "pnpm-lock.yaml"));
  await assert.rejects(collectEditionSourceFingerprint({ root, edition: "online" }), /ENOENT/);
  await put("pnpm-lock.yaml", "restored lock");
  await put("src-tauri/src/lib.rs", 'const X: &str = include_str!(concat!("../", "escape"));');
  await assert.rejects(
    collectEditionSourceFingerprint({ root, edition: "online" }),
    /nonliteral Rust include/,
  );
  await put(
    "src-tauri/src/lib.rs",
    'const X: &str = include_str!("../../../outside-workspace.md");',
  );
  await assert.rejects(
    collectEditionSourceFingerprint({ root, edition: "online" }),
    /escapes the workspace/,
  );
  await put("src-tauri/src/lib.rs", "fn main() {}");
  try {
    await symlink(
      path.join(root, "public"),
      path.join(root, "src/external"),
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if (["EPERM", "EACCES"].includes(error.code)) return t.skip("Host disallows symbolic links");
    throw error;
  }
  await assert.rejects(
    collectEditionSourceFingerprint({ root, edition: "online" }),
    /symbolic link/,
  );
});
