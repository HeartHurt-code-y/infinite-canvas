import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  optimizeRemotionDependencies,
  REMOTION_DISTRIBUTION_VERSION,
} from "./remotion-runtime-distribution.mjs";
import { remotionTreeIsMaterialized } from "./remotion-runtime-integrity.mjs";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "remotion-production-"));
  mkdirSync(path.join(root, "node_modules"));
  return root;
}

function packageAt(root, relative, name, extra = {}) {
  const directory = path.join(root, relative);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({ name, version: "1.0.0", main: "index.cjs", ...extra }),
  );
  writeFileSync(path.join(directory, "index.cjs"), `module.exports = ${JSON.stringify(name)}`);
  writeFileSync(path.join(directory, "LICENSE"), `license:${name}`);
  return directory;
}

test("production layout keeps native files, licenses and maps while removing pnpm aliases and stale dependencies", async () => {
  const root = fixture();
  try {
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        dependencies: { renderer: "1.0.0", playwright: "1.0.0" },
        devDependencies: { bundler: "1.0.0" },
      }),
    );
    const renderer = packageAt(
      root,
      "node_modules/.pnpm/renderer/node_modules/renderer",
      "renderer",
      {
        dependencies: { compositor: "1.0.0" },
        peerDependencies: { playwright: "1.0.0" },
        optionalDependencies: { unavailable: "1.0.0" },
      },
    );
    const compositor = packageAt(
      root,
      "node_modules/.pnpm/compositor/node_modules/compositor",
      "compositor",
    );
    const playwright = packageAt(root, "node_modules/playwright", "playwright");
    writeFileSync(
      path.join(renderer, "index.cjs"),
      "module.exports = require('compositor') + ':' + require('playwright')",
    );
    writeFileSync(path.join(compositor, "native.dll"), Buffer.from([0, 1, 2, 3]));
    writeFileSync(path.join(renderer, "index.cjs.map"), "error stack map");
    packageAt(root, "node_modules/.ignored_playwright", "playwright");
    packageAt(root, "node_modules/bundler", "bundler");
    for (const [target, link] of [
      [renderer, "node_modules/renderer"],
      [compositor, "node_modules/.pnpm/renderer/node_modules/compositor"],
      [playwright, "node_modules/.pnpm/renderer/node_modules/playwright"],
    ])
      symlinkSync(target, path.join(root, link), process.platform === "win32" ? "junction" : "dir");
    const requireOriginal = createRequire(path.join(root, "package.json"));
    assert.equal(requireOriginal("renderer"), "compositor:playwright");
    const result = await optimizeRemotionDependencies(root);
    assert.equal(result.version, REMOTION_DISTRIBUTION_VERSION);
    assert.equal(result.layout, "flat");
    assert.equal(result.packages, 3);
    assert.equal(existsSync(path.join(root, "node_modules/.pnpm")), false);
    assert.equal(existsSync(path.join(root, "node_modules/.ignored_playwright")), false);
    assert.equal(existsSync(path.join(root, "node_modules/bundler")), false);
    assert.equal(
      readFileSync(path.join(root, "node_modules/compositor/native.dll")).equals(
        Buffer.from([0, 1, 2, 3]),
      ),
      true,
    );
    assert.equal(
      readFileSync(path.join(root, "node_modules/renderer/LICENSE"), "utf8"),
      "license:renderer",
    );
    assert.equal(
      readFileSync(path.join(root, "node_modules/renderer/index.cjs.map"), "utf8"),
      "error stack map",
    );
    assert.equal(await remotionTreeIsMaterialized(root), true);
    // A new runtime process has a fresh module/realpath cache after the migration.
    assert.deepEqual(
      JSON.parse(
        execFileSync(
          process.execPath,
          [
            "-e",
            "process.stdout.write(JSON.stringify([require.resolve('renderer'), require('renderer')]))",
          ],
          { cwd: root, encoding: "utf8" },
        ),
      ),
      [path.join(root, "node_modules/renderer/index.cjs"), "compositor:playwright"],
    );
    const again = await optimizeRemotionDependencies(root);
    assert.equal(again.layout, "flat");
    assert.equal(again.packages, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("conflicting transitive versions keep exact local resolutions without duplicating the rest of the closure", async () => {
  const root = fixture();
  try {
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ dependencies: { first: "1.0.0", second: "1.0.0" } }),
    );
    for (const name of ["first", "second"])
      packageAt(root, `node_modules/${name}`, name, { dependencies: { shared: "*" } });
    packageAt(root, "node_modules/first/node_modules/shared", "shared", { version: "1.0.0" });
    packageAt(root, "node_modules/second/node_modules/shared", "shared", { version: "2.0.0" });
    packageAt(root, "node_modules/.ignored_first", "first");
    const result = await optimizeRemotionDependencies(root);
    assert.equal(result.layout, "nested");
    assert.equal(result.packages, 3);
    assert.equal(result.copies, 4);
    assert.equal(existsSync(path.join(root, "node_modules/first/node_modules/shared")), false);
    assert.equal(existsSync(path.join(root, "node_modules/second/node_modules/shared")), true);
    assert.equal(existsSync(path.join(root, "node_modules/.ignored_first")), false);
    assert.deepEqual(
      JSON.parse(
        execFileSync(
          process.execPath,
          [
            "-e",
            "const {createRequire}=require('node:module');const path=require('node:path');process.stdout.write(JSON.stringify(['first','second'].map(name=>createRequire(path.resolve('node_modules',name,'package.json'))('shared/package.json').version)))",
          ],
          { cwd: root, encoding: "utf8" },
        ),
      ),
      ["1.0.0", "2.0.0"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("same version with different native package bytes gets an exact nested copy", async () => {
  const root = fixture();
  try {
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ dependencies: { first: "1.0.0", second: "1.0.0" } }),
    );
    for (const name of ["first", "second"]) {
      packageAt(root, `node_modules/${name}`, name, { dependencies: { shared: "1.0.0" } });
      packageAt(root, `node_modules/${name}/node_modules/shared`, "shared");
    }
    writeFileSync(
      path.join(root, "node_modules/second/node_modules/shared/native.dll"),
      "different native build",
    );
    assert.equal((await optimizeRemotionDependencies(root)).layout, "nested");
    assert.equal(
      existsSync(path.join(root, "node_modules/second/node_modules/shared/native.dll")),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("equal package bytes with different dependency contexts preserve the original layout", async () => {
  const root = fixture();
  try {
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ dependencies: { first: "1.0.0", second: "1.0.0" } }),
    );
    for (const [index, name] of ["first", "second"].entries()) {
      packageAt(root, `node_modules/${name}`, name, { dependencies: { shared: "1.0.0" } });
      packageAt(root, `node_modules/${name}/node_modules/shared`, "shared", {
        dependencies: { leaf: "*" },
      });
      packageAt(root, `node_modules/${name}/node_modules/shared/node_modules/leaf`, "leaf", {
        version: `${index + 1}.0.0`,
      });
    }
    packageAt(root, "node_modules/.ignored_first", "first");
    const result = await optimizeRemotionDependencies(root);
    assert.equal(result.layout, "preserved");
    assert.deepEqual(result.removed, ["node_modules/.ignored_first"]);
    assert.equal(
      existsSync(path.join(root, "node_modules/first/node_modules/shared/node_modules/leaf")),
      true,
    );
    assert.equal(
      existsSync(path.join(root, "node_modules/second/node_modules/shared/node_modules/leaf")),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dependency cycles resolve to existing ancestors instead of expanding copies", async () => {
  const root = fixture();
  try {
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ dependencies: { first: "1.0.0" } }),
    );
    packageAt(root, "node_modules/first", "first", { dependencies: { second: "1.0.0" } });
    packageAt(root, "node_modules/second", "second", { dependencies: { first: "1.0.0" } });
    const result = await optimizeRemotionDependencies(root);
    assert.equal(result.layout, "flat");
    assert.equal(result.copies, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("required dependencies missing from the self-contained runtime fail without changing installed files", async () => {
  const root = fixture();
  try {
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ dependencies: { missing: "1.0.0" } }),
    );
    packageAt(root, "node_modules/.ignored_unused", "unused");
    await assert.rejects(() => optimizeRemotionDependencies(root), /生产依赖缺失/);
    assert.equal(existsSync(path.join(root, "node_modules/.ignored_unused")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("production package links outside the runtime are rejected", async () => {
  const root = fixture();
  const outside = fixture();
  try {
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ dependencies: { external: "1.0.0" } }),
    );
    const external = packageAt(outside, "node_modules/external", "external");
    symlinkSync(
      external,
      path.join(root, "node_modules/external"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(() => optimizeRemotionDependencies(root), /越出运行时/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a linked runtime root is rejected before modifying the external component", async () => {
  const workspace = fixture();
  const outside = fixture();
  try {
    writeFileSync(
      path.join(outside, "package.json"),
      JSON.stringify({ dependencies: { shared: "1.0.0" } }),
    );
    packageAt(outside, "node_modules/shared", "shared");
    packageAt(outside, "node_modules/.ignored_shared", "shared");
    const link = path.join(workspace, "runtime-link");
    symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(() => optimizeRemotionDependencies(link), /运行时根目录必须是实际目录/);
    assert.equal(await remotionTreeIsMaterialized(link), false);
    assert.equal(existsSync(path.join(outside, "node_modules/.ignored_shared")), true);
    assert.equal(
      readFileSync(path.join(outside, "node_modules/shared/LICENSE"), "utf8"),
      "license:shared",
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a linked node_modules root is rejected before moving or pruning external dependencies", async () => {
  const root = fixture();
  const outside = fixture();
  try {
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ dependencies: { shared: "1.0.0" } }),
    );
    packageAt(outside, "node_modules/shared", "shared");
    packageAt(outside, "node_modules/.ignored_shared", "shared");
    rmSync(path.join(root, "node_modules"), { recursive: true });
    symlinkSync(
      path.join(outside, "node_modules"),
      path.join(root, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(() => optimizeRemotionDependencies(root), /依赖根目录必须是实际目录/);
    assert.equal(await remotionTreeIsMaterialized(root), false);
    assert.equal(existsSync(path.join(outside, "node_modules/.ignored_shared")), true);
    assert.equal(
      readFileSync(path.join(outside, "node_modules/shared/LICENSE"), "utf8"),
      "license:shared",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
