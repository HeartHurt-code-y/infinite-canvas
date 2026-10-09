import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { AI_MEDIA_PRUNING_POLICY } from "./ai-media-runtime-prune.mjs";
import {
  downloadVerified,
  prepareDepthCode,
  DEPTH_COMMIT,
  fileInventory,
  safeRelative,
  torchVersions,
  MODELS,
  LITE_DEPENDENCIES,
  OPEN_UNMIX_CHECKPOINT,
  reusePrepared,
  sha256,
} from "./prepare-ai-media-runtime.mjs";

test("default lightweight dependencies exclude Torch and licensed model pins are complete", () => {
  assert.equal(
    Object.keys(LITE_DEPENDENCIES).some((name) => name.startsWith("torch")),
    false,
  );
  assert.equal(MODELS[0].license, "Apache-2.0");
  assert.equal(OPEN_UNMIX_CHECKPOINT.license, "MIT");
  for (const model of [...MODELS, OPEN_UNMIX_CHECKPOINT]) {
    assert.match(model.sha256, /^[0-9a-f]{64}$/);
    assert.equal(safeRelative(model.path), true);
  }
  assert.equal(
    torchVersions("win32", "x64", "cuda").index,
    "https://download.pytorch.org/whl/cu128",
  );
  assert.throws(() => torchVersions("darwin", "arm64", "cuda"));
});

test("component paths cannot escape their verified directory", () => {
  for (const filename of [
    "../worker.py",
    "python/../../worker.py",
    "/tmp/x",
    "C:/x",
    "python\\python.exe",
    "x/./y",
    "a//b",
    "x\0y",
  ])
    assert.equal(safeRelative(filename), false);
  assert.equal(safeRelative("python/Lib/site-packages/onnxruntime/capi/runtime.dll"), true);
});

test("complete file inventory hashes nested runtime files and excludes its own manifest", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-media-integrity-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, "worker"));
  await writeFile(path.join(directory, "worker/worker.py"), "offline-worker");
  await writeFile(path.join(directory, "runtime-manifest.json"), "manifest");
  const entries = await fileInventory(directory);
  assert.deepEqual(entries, [
    {
      type: "file",
      path: "worker/worker.py",
      bytes: 14,
      sha256: createHash("sha256").update("offline-worker").digest("hex"),
    },
  ]);
});

test("corrupted cached artifacts are rejected without publishing downloaded bytes", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-media-download-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "model.pth");
  await writeFile(target, "old");
  await assert.rejects(
    downloadVerified("data:application/octet-stream;base64,YmFk", target, {
      bytes: 3,
      sha256: "0".repeat(64),
    }),
    /校验失败/,
  );
  assert.equal(await readFile(target, "utf8"), "old");
});

test("artifact downloads identify the project and verify complete response bytes", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-media-download-agent-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from("pinned-official-model-payload");
  let accepted = 0;
  const server = createServer((request, response) => {
    if (
      !/^infinite-canvas-build\/\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(
        request.headers["user-agent"] ?? "",
      ) ||
      request.headers.accept !== "application/octet-stream"
    ) {
      response.writeHead(403);
      response.end("Project download identity required");
      return;
    }
    accepted += 1;
    response.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": bytes.length,
    });
    response.end(bytes);
  });
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/model.pth`;
  const anonymous = await fetch(url);
  assert.equal(anonymous.status, 403);
  await anonymous.arrayBuffer();
  const target = path.join(directory, "model.pth");
  const pin = { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  await downloadVerified(url, target, pin);
  assert.deepEqual(await readFile(target), bytes);
  assert.equal(await sha256(target), pin.sha256);
  await downloadVerified(url, target, pin);
  assert.equal(accepted, 1, "a verified cache entry does not need another network request");
});

async function depthCodeFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-media-depth-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "licenses"));
  const files = new Map([
    ["LICENSE", Buffer.from("Apache-2.0 fixture")],
    ["video_depth_anything/__init__.py", Buffer.from("# fixed depth code\n")],
  ]);
  const tree = [...files].map(([filename, bytes]) => ({
    path: filename,
    type: "blob",
    size: bytes.length,
    sha: createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"),
  }));
  const requests = [];
  const fetchFn = async (url, options) => {
    requests.push({ url, headers: new Headers(options.headers) });
    if (new URL(url).origin === "https://api.github.com") return Response.json({ tree });
    const prefix = `https://raw.githubusercontent.com/DepthAnything/Video-Depth-Anything/${DEPTH_COMMIT}/`;
    assert.ok(url.startsWith(prefix), "raw files stay at the fixed commit");
    const bytes = files.get(url.slice(prefix.length));
    assert.ok(bytes, "only selected source files are downloaded");
    return new Response(bytes);
  };
  return {
    root,
    destination: path.join(root, "code/video-depth-anything"),
    tree,
    files,
    requests,
    fetchFn,
  };
}

test("fixed depth sources authenticate only GitHub API and preserve the checked source bytes", async (t) => {
  for (const token of ["", "fixture-private-github-token"]) {
    const fixture = await depthCodeFixture(t);
    await prepareDepthCode(fixture.destination, {
      fetchFn: fixture.fetchFn,
      environment: { GITHUB_TOKEN: token },
    });
    assert.equal(fixture.requests.length, 3);
    const api = fixture.requests[0];
    assert.equal(
      api.url,
      `https://api.github.com/repos/DepthAnything/Video-Depth-Anything/git/trees/${DEPTH_COMMIT}?recursive=1`,
    );
    assert.equal(api.headers.get("authorization"), token ? `Bearer ${token}` : null);
    assert.equal(api.headers.get("accept"), "application/vnd.github+json");
    for (const request of fixture.requests) {
      assert.match(request.headers.get("user-agent"), /^infinite-canvas-build\//);
      if (new URL(request.url).origin !== "https://api.github.com") {
        assert.equal(request.headers.get("authorization"), null);
        assert.equal(request.headers.get("accept"), "application/octet-stream");
      }
    }
    for (const [filename, bytes] of fixture.files)
      assert.deepEqual(await readFile(path.join(fixture.destination, filename)), bytes);
    assert.deepEqual(
      await readFile(path.join(fixture.root, "licenses/video-depth-anything-Apache-2.0.txt")),
      fixture.files.get("LICENSE"),
    );
  }
});

test("fixed depth sources reject changed Git blob hashes and sizes", async (t) => {
  for (const changedField of ["sha", "size"]) {
    const fixture = await depthCodeFixture(t);
    const code = fixture.tree.find((entry) => entry.path.endsWith("__init__.py"));
    code[changedField] = changedField === "sha" ? "0".repeat(40) : code.size + 1;
    await assert.rejects(
      prepareDepthCode(fixture.destination, { fetchFn: fixture.fetchFn, environment: {} }),
      /深度源码 Git 内容校验失败/,
    );
    await assert.rejects(readFile(path.join(fixture.destination, code.path)), { code: "ENOENT" });
  }
});

test("GitHub source errors report only known public messages and numeric rate limits", async (t) => {
  const fixture = await depthCodeFixture(t);
  const token = "fixture-never-log-this-secret";
  for (const message of [`API rate limit exceeded: ${token}`, `Unknown ${token}`]) {
    await assert.rejects(
      prepareDepthCode(fixture.destination, {
        environment: { GITHUB_TOKEN: token },
        fetchFn: async () =>
          Response.json(
            { message, Authorization: `Bearer ${token}`, sensitive: token },
            { status: 403, headers: { "x-ratelimit-remaining": "0" } },
          ),
      }),
      (error) => {
        assert.match(error.message, /深度源码: 403/);
        assert.match(error.message, /rate remaining=0/);
        assert.equal(error.message.includes(token), false);
        assert.equal(error.message.includes("Authorization"), false);
        assert.equal(error.message.includes("Unknown"), false);
        if (message.startsWith("API rate limit exceeded"))
          assert.match(error.message, /API rate limit exceeded/);
        return true;
      },
    );
  }
});

test("prepared components reuse only unchanged build inputs and every recorded file", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-media-reuse-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const inputs = {
    sha256: "1".repeat(64),
    platform: "win32",
    arch: "x64",
    runtimeProfile: "lite",
    profile: "cpu",
  };
  await writeFile(path.join(directory, "worker.py"), "verified-worker");
  const recorded = await fileInventory(directory);
  await writeFile(path.join(directory, "files-manifest.json"), JSON.stringify(recorded));
  const manifest = {
    ...inputs,
    buildInputs: inputs,
    pruning: { policyVersion: AI_MEDIA_PRUNING_POLICY },
    inventory: {
      path: "files-manifest.json",
      count: recorded.length,
      sha256: await sha256(path.join(directory, "files-manifest.json")),
    },
  };
  await writeFile(path.join(directory, "runtime-manifest.json"), JSON.stringify(manifest));
  assert.deepEqual(await reusePrepared(directory, inputs), manifest);
  const oldManifest = { ...manifest };
  delete oldManifest.pruning;
  await writeFile(path.join(directory, "runtime-manifest.json"), JSON.stringify(oldManifest));
  assert.equal(await reusePrepared(directory, inputs), null);
  await writeFile(path.join(directory, "runtime-manifest.json"), JSON.stringify(manifest));
  assert.equal(await reusePrepared(directory, { ...inputs, sha256: "2".repeat(64) }), null);
  await writeFile(path.join(directory, "worker.py"), "modified-worker");
  assert.equal(await reusePrepared(directory, inputs), null);
  await writeFile(path.join(directory, "worker.py"), "verified-worker");
  await writeFile(path.join(directory, "unrecorded.py"), "extra-code");
  assert.equal(await reusePrepared(directory, inputs), null);
});
