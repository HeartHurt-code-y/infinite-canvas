// TOS transport for the dedicated online channel. Secrets stay in process memory.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import { candidateSecretKeys, presignUrl } from "./tos-v4.mjs";
import {
  readTosPublishEnv,
  parseTosUploadId,
  buildCompleteMultipartJson,
} from "./publish-tos-updates.mjs";
import { assertComponentRoot, COMPONENT_REPO_ROOT } from "./runtime-component-catalog.mjs";
import { resolveComponentPython } from "./package-runtime-components.mjs";
import {
  TOS_UPDATES_BUCKET,
  TOS_UPDATES_REGION,
  TOS_UPDATES_ENDPOINT,
  TOS_UPDATES_PREFIX,
  tosUpdatesHost,
} from "./tos-updates-config.mjs";

const PART_SIZE = 8 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_SMALL_BYTES = 1024 * 1024;
const ONLINE_PREFIX = `${TOS_UPDATES_PREFIX}/windows-x86_64-online/`;
const COMPONENT_PREFIX = `${TOS_UPDATES_PREFIX}/components/windows-x86_64/`;

export function assertOnlineObjectKey(key) {
  if (typeof key !== "string" || key.includes("\\") || key.includes("%"))
    throw new Error("Invalid online object key");
  const relative = key.startsWith(ONLINE_PREFIX) ? key.slice(ONLINE_PREFIX.length) : "";
  const version = "[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?";
  if (
    relative === "latest.json" ||
    /^backups\/[a-f0-9]{64}\.json$/.test(relative) ||
    new RegExp(`^无限画布_${version}_x64-online-setup\\.exe(?:\\.sig)?$`).test(relative)
  )
    return key;
  if (
    new RegExp(
      `^${COMPONENT_PREFIX}${version}/(?:blender|remotion-runtime|ffmpeg|pose-runtime|gpt-image-2-style-library|ai-media-runtime|ai-media-quality-runtime)-[a-f0-9]{64}\\.zip$`,
    ).test(key)
  )
    return key;
  throw new Error("Object is outside the dedicated online/component release scope");
}

export function onlineObjectUrl(key) {
  assertOnlineObjectKey(key);
  return `https://${tosUpdatesHost()}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

function safeNetworkError(error) {
  const code = /^[A-Z0-9_]+$/.test(error?.code ?? "") ? error.code : "NETWORK_ERROR";
  return Object.assign(
    new Error(`TOS request failed (${code}); credentials and signed URLs are omitted`),
    { code },
  );
}

/** A bounded small response or a constant-memory, complete anonymous SHA read. */
export function requestOnlineObject(
  {
    url,
    method = "GET",
    headers = {},
    body,
    maxBytes = MAX_SMALL_BYTES,
    hash = false,
    timeoutMs = 180000,
  },
  requestImpl = https.request,
) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(result);
    };
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return reject(new Error("Invalid trusted origin URL"));
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== tosUpdatesHost() ||
      parsed.username ||
      parsed.password ||
      parsed.port
    )
      return reject(new Error("Transport requires the trusted TOS HTTPS origin"));
    let req;
    try {
      req = requestImpl(
        { hostname: parsed.hostname, path: `${parsed.pathname}${parsed.search}`, method, headers },
        (res) => {
          let size = 0;
          const chunks = [];
          const digest = createHash("sha256");
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            res.resume();
            finish(new Error("TOS redirects are not allowed"));
            return;
          }
          res.on("data", (value) => {
            const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
            size += chunk.length;
            if (size > maxBytes) {
              finish(new Error("TOS response exceeded its exact byte budget"));
              req?.destroy();
              res.destroy();
              return;
            }
            if (hash) digest.update(chunk);
            else chunks.push(chunk);
          });
          res.on("error", (error) => finish(safeNetworkError(error)));
          res.on("aborted", () => finish(safeNetworkError({ code: "ECONNRESET" })));
          res.on("end", () =>
            finish(null, {
              status,
              headers: res.headers,
              etag: res.headers.etag,
              size,
              ...(hash ? { sha256: digest.digest("hex") } : { body: Buffer.concat(chunks) }),
            }),
          );
        },
      );
    } catch (error) {
      return finish(safeNetworkError(error));
    }
    req.on("error", (error) => finish(safeNetworkError(error)));
    timer = setTimeout(() => {
      finish(safeNetworkError({ code: "ETIMEDOUT" }));
      req.destroy();
    }, timeoutMs);
    try {
      req.end(body);
    } catch (error) {
      finish(safeNetworkError(error));
      req.destroy();
    }
  });
}

// Private child IPC: only the selected TOS credential is read, never enumerated.
const LOCAL_CONFIG_READER = String.raw`
import ctypes, json, os, sqlite3, sys
from ctypes import wintypes
from pathlib import Path
try:
    data = Path(os.environ['LOCALAPPDATA']) / 'com.infinitecanvas.desktop'
    database = data / 'infinite-canvas.sqlite3'
    connection = sqlite3.connect(database.as_uri() + '?mode=ro', uri=True)
    row = connection.execute("SELECT value_json FROM application_settings WHERE key='tos_staging'").fetchone()
    connection.close()
    if not row: raise RuntimeError()
    config = json.loads(row[0])
    ref = config.get('credentialRef', config.get('credential_ref'))
    if not isinstance(ref, str) or not ref.strip(): raise RuntimeError()
    if os.environ.get('INFINITE_CANVAS_CREDENTIAL_BACKEND', '').lower() == 'file':
        secret = json.loads((data / 'credentials.json').read_text(encoding='utf-8'))[ref]
    else:
        class Credential(ctypes.Structure):
            _fields_ = [('Flags', wintypes.DWORD), ('Type', wintypes.DWORD), ('TargetName', wintypes.LPWSTR),
                ('Comment', wintypes.LPWSTR), ('LastWritten', wintypes.FILETIME), ('CredentialBlobSize', wintypes.DWORD),
                ('CredentialBlob', ctypes.POINTER(ctypes.c_ubyte)), ('Persist', wintypes.DWORD),
                ('AttributeCount', wintypes.DWORD), ('Attributes', ctypes.c_void_p), ('TargetAlias', wintypes.LPWSTR), ('UserName', wintypes.LPWSTR)]
        api = ctypes.WinDLL('Advapi32.dll', use_last_error=True)
        pointer = ctypes.POINTER(Credential)()
        api.CredReadW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(ctypes.POINTER(Credential))]
        api.CredReadW.restype = wintypes.BOOL
        api.CredFree.argtypes = [ctypes.c_void_p]
        if not api.CredReadW(ref + '.com.infinitecanvas.desktop', 1, 0, ctypes.byref(pointer)): raise RuntimeError()
        try:
            raw = ctypes.string_at(pointer.contents.CredentialBlob, pointer.contents.CredentialBlobSize)
            secret = raw.decode('utf-16-le')
        finally:
            ctypes.memset(pointer.contents.CredentialBlob, 0, pointer.contents.CredentialBlobSize)
            api.CredFree(pointer)
    credentials = json.loads(secret)
    result = {'accessKey': credentials['accessKey'].strip(), 'secretKey': credentials['secretKey'].strip(),
        'bucket': config['bucket'], 'region': config.get('region', 'cn-beijing'), 'endpoint': config.get('endpoint', 'tos-cn-beijing.volces.com'), 'prefix': 'infinite-canvas/updates'}
    if not result['accessKey'] or not result['secretKey']: raise RuntimeError()
    sys.stdout.write(json.dumps(result))
except Exception:
    sys.stderr.write('Configured application TOS credentials are unavailable; supply TOS_ACCESS_KEY and TOS_SECRET_KEY.\n')
    sys.exit(1)
`;

export function loadOnlinePublishConfig({
  root = COMPONENT_REPO_ROOT,
  environment = process.env,
  executeFile = execFileSync,
} = {}) {
  let config;
  if (environment.TOS_ACCESS_KEY || environment.TOS_SECRET_KEY)
    config = readTosPublishEnv(environment);
  else {
    if (process.platform !== "win32")
      throw new Error("Provide TOS_ACCESS_KEY and TOS_SECRET_KEY in the publishing environment");
    try {
      const output = executeFile(
        resolveComponentPython(root, environment),
        ["-I", "-B", "-c", LOCAL_CONFIG_READER],
        {
          env: environment,
          encoding: "utf8",
          maxBuffer: 16384,
          timeout: 15000,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      config = JSON.parse(output);
    } catch {
      throw new Error(
        "Configured application TOS credentials are unavailable; provide TOS_ACCESS_KEY and TOS_SECRET_KEY",
      );
    }
  }
  if (
    config.bucket !== TOS_UPDATES_BUCKET ||
    config.region !== TOS_UPDATES_REGION ||
    config.endpoint !== TOS_UPDATES_ENDPOINT ||
    config.prefix !== TOS_UPDATES_PREFIX ||
    !config.accessKey?.trim() ||
    !config.secretKey?.trim()
  )
    throw new Error("Publishing configuration must match the fixed trusted TOS updates origin");
  return config;
}

function httpFailure(result, operation) {
  if (result.status === 412)
    throw Object.assign(new Error(`${operation}: concurrent object change (HTTP 412)`), {
      code: "PRECONDITION_FAILED",
    });
  if (result.status < 200 || result.status >= 300)
    throw new Error(`${operation}: TOS HTTP ${result.status}`);
}

export async function createOnlineUpdateTransport({
  root = COMPONENT_REPO_ROOT,
  environment = process.env,
  configLoader = loadOnlinePublishConfig,
  request = requestOnlineObject,
  onProgress = console.log,
} = {}) {
  const config = configLoader({ root, environment });
  // Try the same base64-console compatibility as the existing project publisher.
  let authenticated = false;
  for (const candidate of candidateSecretKeys(config.secretKey)) {
    const signed = presignUrl({
      method: "HEAD",
      host: tosUpdatesHost(),
      objectKey: `${ONLINE_PREFIX}latest.json`,
      region: config.region,
      accessKey: config.accessKey,
      secretKey: candidate,
      expiresSecs: 3600,
      now: new Date(),
    });
    const result = await request({ url: signed.url, method: "HEAD" });
    if (result.status === 200 || result.status === 404) {
      config.secretKey = candidate;
      authenticated = true;
      break;
    }
  }
  if (!authenticated) throw new Error("TOS authentication failed for the dedicated online channel");

  async function signedRequest(
    method,
    objectKey,
    { headers = {}, body, query, maxBytes = MAX_SMALL_BYTES, retry = false } = {},
  ) {
    assertOnlineObjectKey(objectKey);
    for (let attempt = 1; ; attempt++) {
      try {
        const signed = presignUrl({
          method,
          host: tosUpdatesHost(),
          objectKey,
          region: config.region,
          accessKey: config.accessKey,
          secretKey: config.secretKey,
          expiresSecs: 3600,
          now: new Date(),
          extraQuery: query,
          extraHeaders: headers,
        });
        const result = await request({
          url: signed.url,
          method,
          headers: signed.signedHeaders,
          body,
          maxBytes,
        });
        if (retry && [408, 429, 500, 503].includes(result.status) && attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
          continue;
        }
        return result;
      } catch (error) {
        if (
          !retry ||
          attempt >= 3 ||
          !["ETIMEDOUT", "ECONNRESET", "EAI_AGAIN", "ENOTFOUND", "EPIPE"].includes(error.code)
        )
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      }
    }
  }
  async function readObject({ objectKey, maxBytes = MAX_SMALL_BYTES }) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_SMALL_BYTES)
      throw new Error("Invalid JSON byte budget");
    const result = await signedRequest("GET", objectKey, { maxBytes, retry: true });
    if (result.status === 404) return null;
    httpFailure(result, "Read online object");
    return { body: result.body, etag: result.etag };
  }
  async function headObject({ objectKey }) {
    const result = await signedRequest("HEAD", objectKey, { retry: true });
    if (result.status === 404) return null;
    httpFailure(result, "Inspect online object");
    const size = Number(result.headers["content-length"]);
    if (!Number.isSafeInteger(size) || size < 0)
      throw new Error("TOS object size metadata is invalid");
    return { size, etag: result.etag, sha256: result.headers["x-tos-meta-sha256"] };
  }
  async function verifyPublicObject({ url, expectedSize, expectedSha256 }) {
    const parsed = new URL(url);
    if (parsed.search || parsed.hash || parsed.hostname !== tosUpdatesHost())
      throw new Error("Public verification must be anonymous at the trusted origin");
    const key = decodeURIComponent(parsed.pathname.slice(1));
    if (
      onlineObjectUrl(key) !== url ||
      !Number.isSafeInteger(expectedSize) ||
      expectedSize <= 0 ||
      !SHA256.test(expectedSha256)
    )
      throw new Error("Invalid exact public verification identity");
    const result = await request({
      url,
      method: "GET",
      headers: { "accept-encoding": "identity", "cache-control": "no-cache" },
      maxBytes: expectedSize,
      hash: true,
      timeoutMs: 30 * 60 * 1000,
    });
    httpFailure(result, "Verify public object");
    if (result.headers["content-encoding"] && result.headers["content-encoding"] !== "identity")
      throw new Error("Public payload must not be content-encoded");
    if (
      Number(result.headers["content-length"]) !== expectedSize ||
      result.size !== expectedSize ||
      result.sha256 !== expectedSha256
    )
      throw new Error("Public object SHA-256 or size mismatch");
    return { size: result.size, sha256: result.sha256 };
  }
  async function putObject({
    objectKey,
    localPath,
    body,
    contentType,
    metadata,
    ifNoneMatch,
    ifMatch,
  }) {
    assertOnlineObjectKey(objectKey);
    if (
      Boolean(ifNoneMatch) === Boolean(ifMatch) ||
      (ifNoneMatch && ifNoneMatch !== "*") ||
      (ifMatch && typeof ifMatch !== "string")
    )
      throw new Error(
        "Every online write requires exactly one conditional creation or replacement",
      );
    const bytes = localPath ? undefined : Buffer.from(body ?? "");
    if ((localPath && body !== undefined) || (!localPath && !bytes.length))
      throw new Error("Online write requires one file or nonempty body");
    const isFeed = objectKey === `${ONLINE_PREFIX}latest.json`;
    if (!isFeed && ifNoneMatch !== "*")
      throw new Error("Release payloads and backups are immutable");
    const digest = metadata?.sha256;
    if (!SHA256.test(digest ?? ""))
      throw new Error("Online write needs an exact SHA-256 metadata value");
    const headers = {
      "content-type": contentType || "application/octet-stream",
      "cache-control": isFeed ? "no-cache, no-store" : "public, max-age=31536000, immutable",
      "x-tos-acl": "public-read",
      "x-tos-meta-sha256": digest,
      ...(ifNoneMatch
        ? { "if-none-match": ifNoneMatch, "x-tos-forbid-overwrite": "true" }
        : { "if-match": ifMatch }),
    };
    let size;
    if (localPath) {
      await assertComponentRoot(path.dirname(localPath), root);
      const info = await lstat(localPath);
      if (!info.isFile() || info.isSymbolicLink())
        throw new Error("Online payload must be a regular workspace file");
      size = info.size;
    } else size = bytes.length;
    const hash = createHash("sha256");
    if (localPath) for await (const chunk of createReadStream(localPath)) hash.update(chunk);
    else hash.update(bytes);
    if (hash.digest("hex") !== digest) throw new Error("Online payload changed before upload");
    if (size <= 32 * 1024 * 1024 || !localPath) {
      if (!localPath && size > MAX_SMALL_BYTES)
        throw new Error("Online JSON write exceeds its byte budget");
      const result = await signedRequest("PUT", objectKey, {
        headers: { ...headers, "content-length": String(size) },
        body: bytes ?? (await readFile(localPath)),
      });
      httpFailure(result, "Create or commit online object");
      return { etag: result.etag };
    }
    const progressRoot = path.join(root, ".cache/online-publish/uploads");
    await mkdir(progressRoot, { recursive: true });
    await assertComponentRoot(progressRoot, root);
    const progressPath = path.join(
      progressRoot,
      `${createHash("sha256").update(objectKey).digest("hex")}.json`,
    );
    let progress;
    const count = Math.ceil(size / PART_SIZE);
    try {
      const info = await lstat(progressPath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SMALL_BYTES)
        throw new Error("Multipart progress path is untrusted");
      const value = JSON.parse(await readFile(progressPath, "utf8"));
      if (
        value.schemaVersion !== 1 ||
        value.objectKey !== objectKey ||
        value.size !== size ||
        value.sha256 !== digest ||
        typeof value.uploadId !== "string" ||
        !value.uploadId ||
        !Array.isArray(value.parts) ||
        value.parts.length > count ||
        new Set(value.parts.map((part) => part.PartNumber)).size !== value.parts.length ||
        value.parts.some(
          (part) =>
            !Number.isSafeInteger(part.PartNumber) ||
            part.PartNumber < 1 ||
            part.PartNumber > count ||
            typeof part.ETag !== "string" ||
            !part.ETag,
        )
      )
        throw new Error("Multipart progress does not match this immutable payload");
      progress = value;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const persist = async () => {
      const temporary = `${progressPath}.tmp-${process.pid}`;
      await writeFile(temporary, JSON.stringify(progress) + "\n", { flag: "wx" });
      await rename(temporary, progressPath);
    };
    if (!progress) {
      const initHeaders = { ...headers };
      delete initHeaders["if-none-match"];
      delete initHeaders["if-match"];
      const result = await signedRequest("POST", objectKey, {
        headers: initHeaders,
        query: [["uploads", ""]],
      });
      httpFailure(result, "Start immutable multipart object");
      progress = {
        schemaVersion: 1,
        objectKey,
        size,
        sha256: digest,
        uploadId: parseTosUploadId(result.body.toString("utf8")),
        parts: [],
      };
      await persist();
    }
    const done = new Set(progress.parts.map((part) => part.PartNumber));
    const pending = Array.from({ length: count }, (_, index) => index + 1).filter(
      (part) => !done.has(part),
    );
    let at = 0;
    let failed;
    let expired = false;
    let persistence = Promise.resolve();
    const file = await open(localPath, "r");
    try {
      await Promise.all(
        Array.from({ length: Math.min(3, pending.length) }, async () => {
          while (!failed && at < pending.length) {
            const number = pending[at++];
            try {
              const offset = (number - 1) * PART_SIZE;
              const buffer = Buffer.alloc(Math.min(PART_SIZE, size - offset));
              let read = 0;
              while (read < buffer.length) {
                const result = await file.read(buffer, read, buffer.length - read, offset + read);
                if (!result.bytesRead) throw new Error("Immutable upload source truncated");
                read += result.bytesRead;
              }
              const result = await signedRequest("PUT", objectKey, {
                headers: {
                  "content-type": "application/octet-stream",
                  "content-length": String(buffer.length),
                },
                body: buffer,
                query: [
                  ["partNumber", String(number)],
                  ["uploadId", progress.uploadId],
                ],
                retry: true,
              });
              if (result.status === 404) {
                expired = true;
                throw new Error("Multipart upload expired; retry starts a fresh upload");
              }
              httpFailure(result, "Upload immutable part");
              if (!result.etag) throw new Error("TOS part response lacks ETag");
              progress.parts.push({ PartNumber: number, ETag: result.etag });
              persistence = persistence.then(persist);
              await persistence;
              onProgress(
                `[online-upload] ${path.posix.basename(objectKey)}: ${progress.parts.length}/${count} parts`,
              );
            } catch (error) {
              failed = error;
            }
          }
        }),
      );
    } finally {
      await file.close();
    }
    if (expired) {
      await unlink(progressPath);
      throw new Error("Multipart upload expired; retry starts a fresh upload");
    }
    if (failed) throw failed;
    progress.parts.sort((a, b) => a.PartNumber - b.PartNumber);
    const completeBody = buildCompleteMultipartJson(
      progress.parts.map((part) => ({ partNumber: part.PartNumber, etag: part.ETag })),
    );
    const result = await signedRequest("POST", objectKey, {
      headers: {
        ...headers,
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(completeBody)),
      },
      body: completeBody,
      query: [["uploadId", progress.uploadId]],
    });
    if (result.status === 404) {
      await unlink(progressPath);
      throw new Error(
        "Multipart completion expired; retry inspects the object and starts a fresh upload if absent",
      );
    }
    httpFailure(result, "Publish immutable multipart object");
    await unlink(progressPath);
    return { etag: result.etag };
  }
  return { readObject, headObject, verifyPublicObject, putObject };
}
