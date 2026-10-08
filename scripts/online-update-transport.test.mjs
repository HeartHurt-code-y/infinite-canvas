import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import {
  assertOnlineObjectKey,
  createOnlineUpdateTransport,
  loadOnlinePublishConfig,
  onlineObjectUrl,
  requestOnlineObject,
} from "./online-update-transport.mjs";
import { componentBytesSha256 } from "./runtime-component-catalog.mjs";
import {
  TOS_UPDATES_BUCKET,
  TOS_UPDATES_ENDPOINT,
  TOS_UPDATES_PREFIX,
  TOS_UPDATES_REGION,
} from "./tos-updates-config.mjs";

const PREFIX = `${TOS_UPDATES_PREFIX}/windows-x86_64-online/`;
const FEED = `${PREFIX}latest.json`;
const INSTALLER = `${PREFIX}无限画布_0.2.1_x64-online-setup.exe`;
const FIXTURE_CONFIG = {
  bucket: TOS_UPDATES_BUCKET,
  endpoint: TOS_UPDATES_ENDPOINT,
  prefix: TOS_UPDATES_PREFIX,
  region: TOS_UPDATES_REGION,
  accessKey: "FIXTURE_ONLY_ACCESS",
  secretKey: "FIXTURE_ONLY_SECRET",
};

async function privateRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ic-online-transport-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function reply({
  status = 200,
  body = "",
  headers = {},
  etag = '"fixture-etag"',
  size,
  sha256,
} = {}) {
  const bytes = Buffer.from(body);
  return {
    status,
    body: bytes,
    etag,
    headers: { etag, ...headers },
    size: size ?? bytes.length,
    ...(sha256 ? { sha256 } : {}),
  };
}

async function injectedTransport(t, handler = async () => reply(), options = {}) {
  const root = await privateRoot(t);
  const calls = [];
  const progress = [];
  const transport = await createOnlineUpdateTransport({
    ...options,
    root,
    configLoader: () => ({ ...FIXTURE_CONFIG }),
    request: async (request) => {
      const parsed = new URL(request.url);
      const objectKey = parsed.pathname.split("/").map(decodeURIComponent).join("/").slice(1);
      const call = { ...request, objectKey, query: parsed.searchParams };
      calls.push(call);
      if (calls.length === 1) return reply({ status: 404 }); // signed authentication HEAD
      return handler(call);
    },
    onProgress: (message) => progress.push(message),
  });
  return { root, transport, calls, progress };
}

function mockedHttps({ status = 200, chunks = [], headers = {}, error, aborted = false }) {
  let destroyed = 0;
  const implementation = (options, callback) => {
    const req = new EventEmitter();
    req.destroy = () => {
      destroyed++;
    };
    req.end = () =>
      queueMicrotask(() => {
        if (error) {
          req.emit("error", error);
          return;
        }
        const res = Readable.from(chunks);
        res.statusCode = status;
        res.headers = headers;
        callback(res);
        if (aborted)
          queueMicrotask(() => {
            res.emit("aborted");
            res.destroy();
          });
      });
    return req;
  };
  return { implementation, destroyed: () => destroyed };
}

test("environment credentials take precedence and fixed-origin guards reject every override", () => {
  const environment = { TOS_ACCESS_KEY: " fixture-access ", TOS_SECRET_KEY: " fixture-secret " };
  const config = loadOnlinePublishConfig({
    environment,
    executeFile: () => {
      throw new Error("fallback must not run");
    },
  });
  assert.equal(config.accessKey, "fixture-access");
  assert.equal(config.secretKey, "fixture-secret");
  for (const override of [
    { TOS_BUCKET: "another-bucket" },
    { TOS_REGION: "cn-shanghai" },
    { TOS_ENDPOINT: "example.com" },
    { TOS_UPDATES_PREFIX: "other-prefix" },
  ])
    assert.throws(
      () => loadOnlinePublishConfig({ environment: { ...environment, ...override } }),
      /fixed trusted TOS/,
    );
  for (const partial of [{ TOS_ACCESS_KEY: "one" }, { TOS_SECRET_KEY: "one" }])
    assert.throws(
      () =>
        loadOnlinePublishConfig({
          environment: partial,
          executeFile: () => {
            throw new Error("no credential fallback after partial env");
          },
        }),
      /TOS_ACCESS_KEY/,
    );
});

test(
  "Windows fallback reads only private child IPC and rejects untrusted or malformed configuration",
  { skip: process.platform !== "win32" },
  async (t) => {
    const root = await privateRoot(t);
    const python = path.join(root, "python.exe");
    await writeFile(python, "fixture Python path, never executed");
    let invocation;
    const config = loadOnlinePublishConfig({
      root,
      environment: { IC_COMPONENT_PYTHON: python },
      executeFile: (filename, args, options) => {
        invocation = { filename, args, options };
        return JSON.stringify(FIXTURE_CONFIG);
      },
    });
    assert.equal(config.secretKey, FIXTURE_CONFIG.secretKey);
    assert.equal(invocation.filename, python);
    assert.deepEqual(invocation.args.slice(0, 3), ["-I", "-B", "-c"]);
    assert.equal(invocation.options.windowsHide, true);
    assert.deepEqual(invocation.options.stdio, ["ignore", "pipe", "pipe"]);
    assert.match(invocation.args[3], /WHERE key='tos_staging'/);
    assert.match(invocation.args[3], /mode=ro/);
    assert.match(invocation.args[3], /INFINITE_CANVAS_CREDENTIAL_BACKEND/);
    assert.throws(
      () =>
        loadOnlinePublishConfig({
          root,
          environment: { IC_COMPONENT_PYTHON: python },
          executeFile: () => JSON.stringify({ ...FIXTURE_CONFIG, bucket: "other" }),
        }),
      /fixed trusted/,
    );
    assert.throws(
      () =>
        loadOnlinePublishConfig({
          root,
          environment: { IC_COMPONENT_PYTHON: python },
          executeFile: () => {
            throw new Error(`untrusted stderr ${FIXTURE_CONFIG.secretKey}`);
          },
        }),
      (error) =>
        !error.message.includes(FIXTURE_CONFIG.secretKey) &&
        /credentials are unavailable/.test(error.message),
    );
  },
);

test("object scope accepts the Windows installer and both matching Mac DMGs/updaters/helpers, feeds, backups and seven components", () => {
  assert.equal(assertOnlineObjectKey(FEED), FEED);
  assert.equal(assertOnlineObjectKey(INSTALLER), INSTALLER);
  assert.equal(assertOnlineObjectKey(`${INSTALLER}.sig`), `${INSTALLER}.sig`);
  assert.equal(
    assertOnlineObjectKey(`${PREFIX}backups/${"a".repeat(64)}.json`),
    `${PREFIX}backups/${"a".repeat(64)}.json`,
  );
  for (const platform of ["windows-x86_64", "darwin-aarch64", "darwin-x86_64"]) {
    const prefix = `${TOS_UPDATES_PREFIX}/${platform}-online/`;
    for (const suffix of ["latest.json", `backups/${"a".repeat(64)}.json`])
      assert.equal(assertOnlineObjectKey(`${prefix}${suffix}`), `${prefix}${suffix}`);
    if (platform.startsWith("darwin-")) {
      const arch = platform === "darwin-aarch64" ? "aarch64" : "x64";
      for (const suffix of [".dmg", ".app.tar.gz", ".app.tar.gz.sig"])
        assertOnlineObjectKey(`${prefix}无限画布_0.2.1_${arch}-online${suffix}`);
      assertOnlineObjectKey(`${prefix}install-macos.sh`);
      assertOnlineObjectKey(`${prefix}install-macos-0.2.1.sh`);
    }
    for (const id of [
      "blender",
      "remotion-runtime",
      "ffmpeg",
      "pose-runtime",
      "gpt-image-2-style-library",
      "ai-media-runtime",
      "ai-media-quality-runtime",
    ])
      assertOnlineObjectKey(
        `${TOS_UPDATES_PREFIX}/components/${platform}/0.2.1/${id}-${"a".repeat(64)}.zip`,
      );
  }
  for (const key of [
    `${TOS_UPDATES_PREFIX}/latest.json`,
    `${TOS_UPDATES_PREFIX}/windows-x86_64/latest.json`,
    `${PREFIX}../latest.json`,
    `${PREFIX}backups/other.json`,
    `${PREFIX}extra.exe`,
    `${PREFIX}无限画布_0.2.1_x64-offline-setup.exe`,
    `${TOS_UPDATES_PREFIX}/components/windows-x86_64/0.2.1/arbitrary-${"a".repeat(64)}.zip`,
    `${TOS_UPDATES_PREFIX}/components/darwin-universal/0.2.1/blender-${"a".repeat(64)}.zip`,
    `${TOS_UPDATES_PREFIX}/components/darwin-aarch64/0.2.1/arbitrary-${"a".repeat(64)}.zip`,
    `${TOS_UPDATES_PREFIX}/components/darwin-x86_64/0.2.1/blender.zip`,
    `${TOS_UPDATES_PREFIX}/components/darwin-aarch64/../blender-${"a".repeat(64)}.zip`,
    `${TOS_UPDATES_PREFIX}/darwin-aarch64/latest.json`,
    `${TOS_UPDATES_PREFIX}/darwin-x86_64/latest.json`,
    `${TOS_UPDATES_PREFIX}/darwin-aarch64-online/无限画布_0.2.1_x64-online.dmg`,
    `${TOS_UPDATES_PREFIX}/darwin-x86_64-online/无限画布_0.2.1_aarch64-online.app.tar.gz`,
    `${TOS_UPDATES_PREFIX}/darwin-aarch64-online/无限画布_0.2.1_aarch64-full.app.tar.gz`,
    `${TOS_UPDATES_PREFIX}/darwin-x86_64-online/无限画布_0.2.1_x64-delta.app.tar.gz`,
    `${TOS_UPDATES_PREFIX}/darwin-aarch64-online/无限画布_0.2.1_aarch64-online.dmg.sig`,
    `${TOS_UPDATES_PREFIX}/darwin-aarch64-online/无限画布_0.2.1_x64-online-setup.exe`,
    `${TOS_UPDATES_PREFIX}/darwin-x86_64-online/resources/manifest.json`,
    `${TOS_UPDATES_PREFIX}/darwin-x86_64-online/helper/install-macos.sh`,
    `${TOS_UPDATES_PREFIX}/darwin-x86_64-online/install-macos.sh.sig`,
    `${TOS_UPDATES_PREFIX}/darwin-x86_64-online/install-macos-latest.sh`,
    `${TOS_UPDATES_PREFIX}/darwin-x86_64-online/install-macos-0.2.1.sh.sig`,
    `${TOS_UPDATES_PREFIX}/darwin-x86_64-online/extra.app.tar.gz`,
    `${PREFIX}无限画布_0.2.1_x64-online.dmg`,
    `${PREFIX}install-macos.sh`,
    `${PREFIX}install-macos-0.2.1.sh`,
    `${PREFIX}%2e%2e/latest.json`,
    `${PREFIX}backups\\${"a".repeat(64)}.json`,
  ])
    assert.throws(() => assertOnlineObjectKey(key));
  assert.equal(onlineObjectUrl(INSTALLER).includes("%E6%97%A0"), true);
});

test("Mac authentication probes the selected feed and feed CAS retains conditional mutable caching", async (t) => {
  const body = Buffer.from("fixture Mac feed");
  const metadata = { sha256: componentBytesSha256(body) };
  for (const platform of ["darwin-aarch64", "darwin-x86_64"]) {
    const feed = `${TOS_UPDATES_PREFIX}/${platform}-online/latest.json`;
    const f = await injectedTransport(t, async () => reply(), { platform });
    assert.equal(f.calls[0].method, "HEAD");
    assert.equal(f.calls[0].objectKey, feed);
    await f.transport.putObject({
      objectKey: feed,
      body,
      metadata,
      ifMatch: '"previous-Mac-feed"',
    });
    const request = f.calls.at(-1);
    assert.equal(request.objectKey, feed);
    assert.equal(request.headers["if-match"], '"previous-Mac-feed"');
    assert.match(request.query.get("X-Tos-SignedHeaders"), /if-match/i);
    assert.equal(request.headers["cache-control"], "no-cache, no-store");
    await f.transport.putObject({ objectKey: feed, body, metadata, ifNoneMatch: "*" });
    assert.equal(f.calls.at(-1).headers["cache-control"], "no-cache, no-store");
    const helper = `${TOS_UPDATES_PREFIX}/${platform}-online/install-macos-0.2.1.sh`;
    await f.transport.putObject({ objectKey: helper, body, metadata, ifNoneMatch: "*" });
    assert.match(f.calls.at(-1).headers["cache-control"], /immutable/);
    const before = f.calls.length;
    await assert.rejects(
      f.transport.putObject({ objectKey: helper, body, metadata, ifMatch: "old-helper" }),
      /immutable/,
    );
    assert.equal(f.calls.length, before);
  }
  await assert.rejects(
    createOnlineUpdateTransport({
      platform: "darwin-universal",
      configLoader: () => {
        throw new Error("credentials must not be read for an unsupported platform");
      },
    }),
    /Unsupported online transport platform/,
  );
});

test("legacy unversioned Mac helpers remain readable but cannot start any upload", async (t) => {
  const body = Buffer.from("legacy installation helper");
  const metadata = { sha256: componentBytesSha256(body) };
  for (const platform of ["darwin-aarch64", "darwin-x86_64"]) {
    const f = await injectedTransport(t, async () => reply({ body }), { platform });
    const objectKey = `${TOS_UPDATES_PREFIX}/${platform}-online/install-macos.sh`;
    assert.deepEqual((await f.transport.readObject({ objectKey })).body, body);
    const before = f.calls.length;
    for (const condition of [{ ifNoneMatch: "*" }, { ifMatch: "old-helper" }])
      await assert.rejects(
        f.transport.putObject({ objectKey, body, metadata, ...condition }),
        /read-only; publish a versioned helper/,
      );
    assert.equal(f.calls.length, before);
  }
});

test("native HTTPS response hashing is complete, constant-memory, and bounded", async () => {
  const chunks = [Buffer.alloc(3, 1), Buffer.alloc(5, 2), Buffer.alloc(9, 3)];
  const body = Buffer.concat(chunks);
  const mock = mockedHttps({ chunks, headers: { "content-length": String(body.length) } });
  const result = await requestOnlineObject(
    { url: onlineObjectUrl(INSTALLER), maxBytes: body.length, hash: true },
    mock.implementation,
  );
  assert.equal(result.size, body.length);
  assert.equal(result.sha256, componentBytesSha256(body));
  assert.equal("body" in result, false);
  const exceeded = mockedHttps({ chunks: [body, Buffer.alloc(1)] });
  await assert.rejects(
    requestOnlineObject(
      { url: onlineObjectUrl(INSTALLER), maxBytes: body.length, hash: true },
      exceeded.implementation,
    ),
    /exact byte budget/,
  );
  assert.ok(exceeded.destroyed() > 0);
});

test("native HTTPS refuses redirects and foreign origins instead of following them", async () => {
  const mock = mockedHttps({ status: 302, headers: { location: "https://example.com/evil" } });
  await assert.rejects(
    requestOnlineObject({ url: onlineObjectUrl(FEED) }, mock.implementation),
    /redirects are not allowed/,
  );
  for (const value of [
    "http://sd20-zq.tos-cn-beijing.volces.com/test",
    "https://example.com/test",
    "https://user:secret@sd20-zq.tos-cn-beijing.volces.com/test",
    "https://sd20-zq.tos-cn-beijing.volces.com:444/test",
  ])
    await assert.rejects(
      requestOnlineObject({ url: value }, () => {
        throw new Error("request must not start");
      }),
      /trusted TOS HTTPS origin/,
    );
});

test("network errors and synchronous HTTPS construction errors never expose signed URLs or credentials", async () => {
  const sensitive = `https://signed.invalid/?access=${FIXTURE_CONFIG.accessKey}&secret=${FIXTURE_CONFIG.secretKey}`;
  const mock = mockedHttps({ error: Object.assign(new Error(sensitive), { code: "ECONNRESET" }) });
  await assert.rejects(
    requestOnlineObject({ url: onlineObjectUrl(FEED) }, mock.implementation),
    (error) =>
      error.code === "ECONNRESET" &&
      !error.message.includes(FIXTURE_CONFIG.secretKey) &&
      !error.message.includes(FIXTURE_CONFIG.accessKey),
  );
  await assert.rejects(
    requestOnlineObject({ url: onlineObjectUrl(FEED) }, () => {
      throw Object.assign(new Error(sensitive), { code: "ERR_INVALID_CHAR" });
    }),
    (error) =>
      error.code === "ERR_INVALID_CHAR" &&
      !error.message.includes(FIXTURE_CONFIG.secretKey) &&
      !error.message.includes(FIXTURE_CONFIG.accessKey),
  );
});

test("public digest verification is anonymous, rejects wrong digest/encoding/length, and enforces exact scope", async (t) => {
  const body = Buffer.from("exact public payload");
  const sha256 = componentBytesSha256(body);
  let response = reply({
    headers: { "content-length": String(body.length) },
    size: body.length,
    sha256,
  });
  const f = await injectedTransport(t, async () => response);
  assert.deepEqual(
    await f.transport.verifyPublicObject({
      url: onlineObjectUrl(INSTALLER),
      expectedSize: body.length,
      expectedSha256: sha256,
    }),
    { size: body.length, sha256 },
  );
  const request = f.calls.at(-1);
  assert.equal(new URL(request.url).search, "");
  assert.equal(request.hash, true);
  assert.equal(request.maxBytes, body.length);
  assert.equal(request.headers["accept-encoding"], "identity");
  for (const bad of [
    reply({ headers: { "content-length": String(body.length + 1) }, size: body.length, sha256 }),
    reply({ headers: { "content-length": String(body.length) }, size: body.length - 1, sha256 }),
    reply({
      headers: { "content-length": String(body.length) },
      size: body.length,
      sha256: "a".repeat(64),
    }),
    reply({
      headers: { "content-length": String(body.length), "content-encoding": "gzip" },
      size: body.length,
      sha256,
    }),
    reply({ status: 404 }),
  ]) {
    response = bad;
    await assert.rejects(
      f.transport.verifyPublicObject({
        url: onlineObjectUrl(INSTALLER),
        expectedSize: body.length,
        expectedSha256: sha256,
      }),
    );
  }
  for (const invalid of [
    {
      url: `${onlineObjectUrl(INSTALLER)}?signed=value`,
      expectedSize: body.length,
      expectedSha256: sha256,
    },
    { url: onlineObjectUrl(INSTALLER), expectedSize: 0, expectedSha256: sha256 },
    { url: onlineObjectUrl(INSTALLER), expectedSize: Infinity, expectedSha256: sha256 },
    { url: onlineObjectUrl(INSTALLER), expectedSize: body.length, expectedSha256: "bad" },
    {
      url: `https://sd20-zq.tos-cn-beijing.volces.com/${TOS_UPDATES_PREFIX}/windows-x86_64/latest.json`,
      expectedSize: body.length,
      expectedSha256: sha256,
    },
  ])
    await assert.rejects(f.transport.verifyPublicObject(invalid));
});

test("small PUT and feed CAS include signed conditional headers and sanitize HTTP failure details", async (t) => {
  const f = await injectedTransport(t, async () => reply());
  const body = Buffer.from("fixture body");
  const digest = componentBytesSha256(body);
  await f.transport.putObject({
    objectKey: FEED,
    body,
    contentType: "application/json",
    metadata: { sha256: digest },
    ifMatch: '"old-etag"',
  });
  const request = f.calls.at(-1);
  assert.equal(request.headers["if-match"], '"old-etag"');
  assert.match(new URL(request.url).searchParams.get("X-Tos-SignedHeaders"), /if-match/i);
  assert.equal(request.headers["cache-control"], "no-cache, no-store");
  assert.equal(request.headers["x-tos-meta-sha256"], digest);
  assert.equal(request.headers["x-tos-acl"], "public-read");
  assert.equal(request.headers["content-length"], String(body.length));
  await f.transport.putObject({
    objectKey: `${INSTALLER}.sig`,
    body,
    metadata: { sha256: digest },
    ifNoneMatch: "*",
  });
  assert.equal(f.calls.at(-1).headers["if-none-match"], "*");
  assert.match(f.calls.at(-1).headers["cache-control"], /immutable/);
  const failure = await injectedTransport(t, async () =>
    reply({ status: 412, body: FIXTURE_CONFIG.secretKey }),
  );
  await assert.rejects(
    failure.transport.putObject({
      objectKey: FEED,
      body,
      metadata: { sha256: digest },
      ifMatch: '"old-etag"',
    }),
    (error) =>
      error.code === "PRECONDITION_FAILED" && !error.message.includes(FIXTURE_CONFIG.secretKey),
  );
});

test("invalid write conditions, mutated local payloads, and out-of-workspace paths cannot send a PUT", async (t) => {
  const f = await injectedTransport(t);
  const body = Buffer.from("body");
  const metadata = { sha256: componentBytesSha256(body) };
  for (const condition of [
    {},
    { ifMatch: "etag", ifNoneMatch: "*" },
    { ifNoneMatch: "other" },
    { ifMatch: "etag" },
  ])
    await assert.rejects(
      f.transport.putObject({ objectKey: INSTALLER, body, metadata, ...condition }),
    );
  await assert.rejects(
    f.transport.putObject({
      objectKey: INSTALLER,
      body,
      metadata: { sha256: "a".repeat(64) },
      ifNoneMatch: "*",
    }),
    /changed before upload/,
  );
  const file = path.join(f.root, "fixture.exe");
  await writeFile(file, body);
  await assert.rejects(
    f.transport.putObject({
      objectKey: INSTALLER,
      localPath: file,
      body,
      metadata,
      ifNoneMatch: "*",
    }),
    /one file/,
  );
  await assert.rejects(
    f.transport.putObject({
      objectKey: INSTALLER,
      localPath: path.join(f.root, "../outside.exe"),
      metadata,
      ifNoneMatch: "*",
    }),
    /outside workspace/,
  );
  assert.equal(
    f.calls.some(({ method }) => method === "PUT"),
    false,
  );
});

async function largeFixture(t, handler) {
  const f = await injectedTransport(t, handler);
  const sourceDirectory = path.join(f.root, ".cache/tauri-editions/online/artifacts/0.2.1/nsis");
  await mkdir(sourceDirectory, { recursive: true });
  const localPath = path.join(sourceDirectory, "fixture-online.exe");
  const bytes = Buffer.alloc(32 * 1024 * 1024 + 1, 7);
  await writeFile(localPath, bytes);
  const digest = componentBytesSha256(bytes);
  const progressPath = path.join(
    f.root,
    ".cache/online-publish/uploads",
    `${createHash("sha256").update(INSTALLER).digest("hex")}.json`,
  );
  return {
    ...f,
    localPath,
    digest,
    progressPath,
    sourceDirectory,
    size: bytes.length,
    put: () =>
      f.transport.putObject({
        objectKey: INSTALLER,
        localPath,
        metadata: { sha256: digest },
        ifNoneMatch: "*",
        contentType: "application/octet-stream",
      }),
  };
}

test("multipart completion carries immutable CAS and exact sorted parts, keeping progress outside installer stage", async (t) => {
  const f = await largeFixture(t, async (request) => {
    if (request.query.has("uploads"))
      return reply({ body: JSON.stringify({ UploadId: "fixture-upload" }) });
    if (request.query.has("partNumber"))
      return reply({ etag: `"part-${request.query.get("partNumber")}"` });
    return reply({ etag: '"complete-etag"' });
  });
  await f.put();
  const initial = f.calls.find(({ query }) => query.has("uploads"));
  assert.equal(initial.headers["if-none-match"], undefined);
  const complete = f.calls.find(
    ({ method, query }) => method === "POST" && query.has("uploadId") && !query.has("partNumber"),
  );
  assert.equal(complete.headers["if-none-match"], "*");
  assert.equal(complete.headers["x-tos-forbid-overwrite"], "true");
  assert.match(complete.query.get("X-Tos-SignedHeaders"), /if-none-match/i);
  assert.deepEqual(JSON.parse(complete.body), {
    Parts: [1, 2, 3, 4, 5].map((PartNumber) => ({ PartNumber, ETag: `part-${PartNumber}` })),
  });
  assert.equal(f.calls.filter(({ query }) => query.has("partNumber")).length, 5);
  assert.deepEqual(await readdir(f.sourceDirectory), ["fixture-online.exe"]);
  await assert.rejects(readFile(f.progressPath), (error) => error.code === "ENOENT");
  assert.ok(
    f.progress.every(
      (entry) =>
        !entry.includes(FIXTURE_CONFIG.accessKey) && !entry.includes(FIXTURE_CONFIG.secretKey),
    ),
  );
});

test("multipart failure keeps validated resume state and next attempt sends only missing parts", async (t) => {
  let fail = true;
  const f = await largeFixture(t, async (request) => {
    if (request.query.has("uploads"))
      return reply({ body: JSON.stringify({ UploadId: "resumable-upload" }) });
    if (request.query.has("partNumber")) {
      const part = Number(request.query.get("partNumber"));
      if (fail && part === 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return reply({ status: 403 });
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
      return reply({ etag: `"part-${part}"` });
    }
    return reply();
  });
  await assert.rejects(f.put(), /HTTP 403/);
  const saved = JSON.parse(await readFile(f.progressPath, "utf8"));
  assert.equal(saved.sha256, f.digest);
  assert.equal(saved.uploadId, "resumable-upload");
  assert.ok(saved.parts.length > 0);
  assert.ok(saved.parts.every(({ PartNumber }) => PartNumber !== 1));
  assert.deepEqual(await readdir(f.sourceDirectory), ["fixture-online.exe"]);
  const previousParts = new Set(saved.parts.map(({ PartNumber }) => PartNumber));
  const resumedAt = f.calls.length;
  fail = false;
  await f.put();
  assert.equal(
    f.calls.slice(resumedAt).some(({ query }) => query.has("uploads")),
    false,
  );
  assert.ok(
    f.calls
      .slice(resumedAt)
      .filter(({ query }) => query.has("partNumber"))
      .every(({ query }) => !previousParts.has(Number(query.get("partNumber")))),
  );
  await assert.rejects(readFile(f.progressPath), (error) => error.code === "ENOENT");
});

test("multipart expired part state cannot be resurrected by other in-flight successful parts", async (t) => {
  const f = await largeFixture(t, async (request) => {
    if (request.query.has("uploads"))
      return reply({ body: JSON.stringify({ UploadId: "expired-upload" }) });
    if (request.query.has("partNumber")) {
      if (request.query.get("partNumber") === "1") return reply({ status: 404 });
      await new Promise((resolve) => setTimeout(resolve, 15));
      return reply({ etag: `"part-${request.query.get("partNumber")}"` });
    }
    return reply();
  });
  await assert.rejects(f.put(), /expired/);
  assert.equal(
    f.calls.some(
      ({ method, query }) => method === "POST" && query.has("uploadId") && !query.has("partNumber"),
    ),
    false,
  );
  await assert.rejects(readFile(f.progressPath), (error) => error.code === "ENOENT");
});

test("multipart conditional completion conflict preserves cache, never overwrites, and never writes stage sidecars", async (t) => {
  const f = await largeFixture(t, async (request) => {
    if (request.query.has("uploads"))
      return reply({ body: JSON.stringify({ UploadId: "conflicting-upload" }) });
    if (request.query.has("partNumber"))
      return reply({ etag: `"part-${request.query.get("partNumber")}"` });
    return reply({ status: 412 });
  });
  await assert.rejects(f.put(), (error) => error.code === "PRECONDITION_FAILED");
  const saved = JSON.parse(await readFile(f.progressPath, "utf8"));
  assert.equal(saved.parts.length, 5);
  assert.deepEqual(await readdir(f.sourceDirectory), ["fixture-online.exe"]);
});

test("expired completion clears fully cached parts so the next retry can create a fresh upload", async (t) => {
  let expire = true;
  const f = await largeFixture(t, async (request) => {
    if (request.query.has("uploads"))
      return reply({ body: JSON.stringify({ UploadId: "completion-upload" }) });
    if (request.query.has("partNumber"))
      return reply({ etag: `"part-${request.query.get("partNumber")}"` });
    return reply({ status: expire ? 404 : 200 });
  });
  await assert.rejects(f.put(), /completion expired/);
  await assert.rejects(readFile(f.progressPath), (error) => error.code === "ENOENT");
  const retryAt = f.calls.length;
  expire = false;
  await f.put();
  assert.equal(f.calls.slice(retryAt).filter(({ query }) => query.has("uploads")).length, 1);
  assert.equal(f.calls.slice(retryAt).filter(({ query }) => query.has("partNumber")).length, 5);
});

test("multipart refuses foreign or tampered receipt before starting/resuming any upload", async (t) => {
  const f = await largeFixture(t, async () => {
    throw new Error("network must not start");
  });
  await mkdir(path.dirname(f.progressPath), { recursive: true });
  await writeFile(
    f.progressPath,
    JSON.stringify({
      schemaVersion: 1,
      objectKey: INSTALLER,
      size: f.size,
      sha256: "f".repeat(64),
      uploadId: "wrong-receipt",
      parts: [],
    }),
  );
  await assert.rejects(f.put(), /does not match/);
  assert.equal(f.calls.length, 1);
});
