import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer, normalizePath, optimizeDeps, resolveConfig } from "vite";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configFile = path.join(projectRoot, "vite.config.ts");
const generatedDirectories = [
  ".cache/tauri-editions/offline/target/release/build/native-fixture/out",
  "src-tauri/resources/ai-media-runtime/python/Lib/site-packages/runtime-fixture",
  "tools/remotion-runtime/.remotion/render-cache",
  "tools/remotion-runtime/.smoke/relocated runtime/bundle",
  "tools/remotion-runtime/.build-node/win-node",
];

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ic-dev-startup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  async function put(relative, contents) {
    const filename = path.join(root, relative);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, contents);
  }
  await put("package.json", JSON.stringify({ type: "module" }));
  await put(
    "index.html",
    '<div id="root"></div><script type="module" src="/src/main.ts"></script>',
  );
  await put("src/main.ts", 'import { answer } from "./answer"; console.log(answer);');
  await put("src/answer.ts", "export const answer = 42;");
  await put("public/brand.svg", '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await put("tools/remotion-runtime/index.tsx", "export const composition = 'fixture';");
  for (const directory of generatedDirectories) await put(`${directory}/generated.txt`, "fixture");
  return { root, put };
}

function inlineConfig(root) {
  return {
    configFile,
    root,
    logLevel: "silent",
    cacheDir: path.join(root, "node_modules/.vite"),
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false },
  };
}

function watchedPaths(server) {
  return Object.entries(server.watcher.getWatched()).flatMap(([directory, entries]) => [
    normalizePath(directory),
    ...entries.map((entry) => normalizePath(path.join(directory, entry))),
  ]);
}

async function waitForWatchRegistration(server, root) {
  const deadline = Date.now() + 5_000;
  const source = normalizePath(path.join(root, "src/main.ts"));
  let previous = "";
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    const paths = watchedPaths(server).sort();
    const snapshot = JSON.stringify(paths);
    if (snapshot !== previous) {
      previous = snapshot;
      stableSince = Date.now();
    }
    // Chokidar can emit ready for an external config file before registering root.
    // Wait for source registration and the small fixture tree to stop changing.
    if (paths.includes(source) && Date.now() - stableSince >= 200) return paths;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("development fixture watcher did not finish registering source files");
}

test(
  "development watcher keeps source and public assets live without registering generated runtime/build trees",
  { timeout: 20_000 },
  async (t) => {
    const { root } = await fixture(t);
    let ready;
    const server = await createServer({
      ...inlineConfig(root),
      plugins: [
        {
          name: "startup-watch-readiness",
          configureServer(current) {
            ready = once(current.watcher, "ready", { signal: AbortSignal.timeout(10_000) });
          },
        },
      ],
    });
    t.after(() => server.close());
    await ready;
    const registeredPaths = await waitForWatchRegistration(server, root);
    for (const directory of generatedDirectories) {
      const prefix = normalizePath(path.join(root, directory));
      assert.equal(
        registeredPaths.some(
          (filename) => filename === prefix || filename.startsWith(`${prefix}/`),
        ),
        false,
        `generated tree must not be watched: ${directory}`,
      );
    }
    for (const filename of [
      "src/main.ts",
      "src/answer.ts",
      "public/brand.svg",
      "tools/remotion-runtime/index.tsx",
    ]) {
      assert.ok(
        registeredPaths.includes(normalizePath(path.join(root, filename))),
        `${filename} remains watched`,
      );
    }
    const changed = once(server.watcher, "change", { signal: AbortSignal.timeout(5_000) });
    await writeFile(path.join(root, "src/answer.ts"), "export const answer = 43;");
    const [filename] = await changed;
    assert.equal(normalizePath(filename), normalizePath(path.join(root, "src/answer.ts")));
  },
);

test(
  "dependency scanner discovers application imports without treating component HTML as application entries",
  { timeout: 20_000 },
  async (t) => {
    const { root, put } = await fixture(t);
    for (const name of ["startup-app-dep", "startup-component-dep"]) {
      await put(
        `node_modules/${name}/package.json`,
        JSON.stringify({ name, type: "module", exports: "./index.js" }),
      );
      await put(`node_modules/${name}/index.js`, `export const name = ${JSON.stringify(name)};`);
    }
    await put("src/main.ts", 'import { name } from "startup-app-dep"; console.log(name);');
    await put(
      "src-tauri/resources/component/index.html",
      '<script type="module" src="./component.js"></script>',
    );
    await put(
      "src-tauri/resources/component/component.js",
      'import { name } from "startup-component-dep"; console.log(name);',
    );
    const config = await resolveConfig(inlineConfig(root), "serve");
    const metadata = await optimizeDeps(config);
    assert.ok(metadata.optimized["startup-app-dep"], "the real application entry is scanned");
    assert.equal(
      metadata.optimized["startup-component-dep"],
      undefined,
      "component HTML is outside the application dependency scan",
    );
  },
);
