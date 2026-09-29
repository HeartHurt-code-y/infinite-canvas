// 把 updater 产物和 latest.json 发到火山引擎 TOS 公开前缀。
// 凭据只从环境变量读：TOS_ACCESS_KEY / TOS_SECRET_KEY。不要写进仓库。
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import https from "node:https";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  REPO_ROOT,
  buildLatestManifest,
  collectUpdaterPlatforms,
  listFilesRecursive,
  parseArgs,
  readAppVersion,
  writeLatestJson,
} from "./write-latest-json.mjs";
import {
  TOS_UPDATES_BUCKET,
  TOS_UPDATES_ENDPOINT,
  TOS_UPDATES_PREFIX,
  TOS_UPDATES_REGION,
  tosUpdatesHost,
  tosUpdatesLatestJsonUrl,
  tosUpdatesObjectKey,
  tosUpdatesPublicBaseUrl,
} from "./tos-updates-config.mjs";
import { candidateSecretKeys, presignUrl } from "./tos-v4.mjs";
import {
  RESOURCE_COMPONENTS,
  assertRuntimeReleaseShape,
  verifyRuntimeResourceRelease,
} from "./runtime-resource-release.mjs";
import { assertRuntimeBaseline, createRuntimeBaseline } from "./runtime-resource-baseline.mjs";
import { validateMacDeltaManifest } from "./mac-delta-manifest.mjs";
import {
  verifyUpdaterSignature,
  verifyUpdaterSignatureBytes,
} from "./verify-updater-signature.mjs";

const PROBE_FILE = ".public-probe.txt";
const PUT_EXPIRES_SECS = 3600;
export const TOS_FETCH_MAX_ATTEMPTS = 5;
/** 单次 PUT 会被 TOS 408 掐掉（约 700MB 安装包）。大于该体积改走分片。 */
export const TOS_MULTIPART_THRESHOLD_BYTES = 32 * 1024 * 1024;
export const TOS_MULTIPART_PART_SIZE_BYTES = 8 * 1024 * 1024;
export const TOS_MULTIPART_CONCURRENCY = 3;
export const TOS_HTTP_REQUEST_DEADLINE_MS = 180_000;

/**
 * Node 全局 fetch（undici）默认 headersTimeout=300s，计时从**发出请求**开始，
 * 不含「等响应头」的本意。海外 CI 把 700MB+ DMG PUT 到 tos-cn-beijing 时，
 * 请求体还没传完就会抛 Headers Timeout Error。
 * 鉴权失败走 HTTP 状态码，不会走这条。
 *
 * @param {unknown} error
 */
export function isRetryableTosNetworkError(error) {
  /** @type {string[]} */
  const parts = [];
  for (let current = error; current != null;) {
    if (current instanceof Error) {
      parts.push(current.name, current.message);
      if ("code" in current && current.code != null) parts.push(String(current.code));
      current = "cause" in current ? current.cause : undefined;
      continue;
    }
    parts.push(String(current));
    break;
  }
  return /headers timeout|body timeout|connect timeout|und_err_|econnreset|econnaborted|epipe|etimedout|enotfound|eai_again|econnrefused|err_stream_premature_close|socket hang up|fetch failed|other side closed|network socket/.test(
    parts.join(" ").toLowerCase(),
  );
}

export function wrapTosFetchError(error) {
  const cause =
    error instanceof Error && "cause" in error && error.cause instanceof Error
      ? error.cause.message
      : "";
  return new Error(
    `请求 TOS 失败：${error instanceof Error ? error.message : String(error)}${cause ? ` (${cause})` : ""}`,
  );
}

/**
 * 用 node:https，避免 undici headersTimeout 把大文件上传误判成超时。
 * 每次请求有总时限；即使套接字持续写入或服务端始终不结束响应，也不能无限等待。
 *
 * @param {{
 *   url: string,
 *   method: string,
 *   headers: Record<string, string>,
 *   body?: Buffer | string | null,
 *   timeoutMs?: number,
 * }} request
 * @param {typeof https.request} [requestImpl]
 * @returns {Promise<{ status: number, text: string, url: string }>}
 */
export function performTosHttpRequest(request, requestImpl = https.request) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let deadline;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) reject(error);
      else resolve(result);
    };
    const connectionError = (message) => {
      const error = new Error(message);
      error.code = "ECONNRESET";
      return error;
    };
    const parsed = new URL(request.url);
    const req = requestImpl(
      {
        hostname: parsed.hostname,
        port: parsed.port === "" ? 443 : Number(parsed.port),
        path: `${parsed.pathname}${parsed.search}`,
        method: request.method,
        headers: request.headers,
      },
      (res) => {
        /** @type {Buffer[]} */
        const chunks = [];
        res.on("error", (error) => {
          const wrapped = connectionError("TOS 响应读取失败");
          wrapped.cause = error;
          finish(wrapped);
        });
        res.on("aborted", () => finish(connectionError("TOS 响应被中止")));
        res.on("close", () => finish(connectionError("TOS 响应提前关闭")));
        res.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on("end", () => {
          const etagHeader = res.headers.etag;
          finish(null, {
            status: res.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf8"),
            url: request.url,
            etag: Array.isArray(etagHeader) ? etagHeader[0] : etagHeader,
            headers: res.headers,
          });
        });
      },
    );
    req.on("error", (error) => finish(error));
    deadline = setTimeout(() => {
      const error = new Error("TOS 请求超过总时限");
      error.code = "ETIMEDOUT";
      finish(error);
      req.destroy(error);
    }, request.timeoutMs ?? TOS_HTTP_REQUEST_DEADLINE_MS);
    try {
      req.end(request.body ?? undefined);
    } catch (error) {
      finish(error);
      req.destroy();
    }
  });
}

export function contentTypeForFileName(fileName) {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".txt") || lower.endsWith(".sig")) return "text/plain; charset=utf-8";
  if (lower.endsWith(".sh")) return "text/x-shellscript";
  if (lower.endsWith(".tar.gz")) return "application/gzip";
  if (lower.endsWith(".dmg")) return "application/x-apple-diskimage";
  if (lower.endsWith(".exe")) return "application/vnd.microsoft.portable-executable";
  return "application/octet-stream";
}

export function cacheControlForFileName(fileName) {
  return fileName.toLowerCase() === "latest.json"
    ? "no-cache"
    : "public, max-age=31536000, immutable";
}

/**
 * @param {string} bundleDir
 * @returns {string[]}
 */
export function collectPublishFilePaths(bundleDir) {
  const files = listFilesRecursive(bundleDir);
  /** @type {string[]} */
  const selected = [];
  /** @type {string[]} */
  const manifests = [];
  for (const filePath of files) {
    // Runtime resources have their own immutable object/manifest publishing path.
    // Their .sig must not be mistaken for an updater installer signature.
    const relative = path.relative(bundleDir, filePath).replaceAll("\\", "/");
    if (relative.startsWith("resources/")) continue;
    // macOS delta objects and signed manifest are published to immutable keys separately.
    if (relative.startsWith("mac-delta/")) continue;
    const fileName = path.basename(filePath);
    const lower = fileName.toLowerCase();
    if (lower === "latest.json") {
      manifests.push(filePath);
      continue;
    }
    if (lower.endsWith(".sig")) {
      selected.push(filePath);
      continue;
    }
    if (
      lower.endsWith(".app.tar.gz") ||
      lower.endsWith("-setup.exe") ||
      lower.endsWith(".appimage")
    ) {
      selected.push(filePath);
      continue;
    }
    // 平台更新包只用 .app.tar.gz；完整 DMG 从 --full-bundle-dir 单独上传到离线前缀。
    if (lower === "install-macos.sh") {
      selected.push(filePath);
    }
  }
  return [...selected, ...manifests];
}

export function readTosPublishEnv(env = process.env) {
  const accessKey = typeof env.TOS_ACCESS_KEY === "string" ? env.TOS_ACCESS_KEY.trim() : "";
  const secretKey = typeof env.TOS_SECRET_KEY === "string" ? env.TOS_SECRET_KEY.trim() : "";
  if (accessKey === "" || secretKey === "") {
    throw new Error("缺少 TOS_ACCESS_KEY / TOS_SECRET_KEY，无法上传到公开桶。");
  }
  return {
    accessKey,
    secretKey,
    bucket:
      typeof env.TOS_BUCKET === "string" && env.TOS_BUCKET.trim() !== ""
        ? env.TOS_BUCKET.trim()
        : TOS_UPDATES_BUCKET,
    region:
      typeof env.TOS_REGION === "string" && env.TOS_REGION.trim() !== ""
        ? env.TOS_REGION.trim()
        : TOS_UPDATES_REGION,
    endpoint:
      typeof env.TOS_ENDPOINT === "string" && env.TOS_ENDPOINT.trim() !== ""
        ? env.TOS_ENDPOINT.trim()
        : TOS_UPDATES_ENDPOINT,
    prefix:
      typeof env.TOS_UPDATES_PREFIX === "string" && env.TOS_UPDATES_PREFIX.trim() !== ""
        ? env.TOS_UPDATES_PREFIX.trim()
        : TOS_UPDATES_PREFIX,
  };
}

/**
 * @param {{
 *   method: string,
 *   host: string,
 *   objectKey: string,
 *   region: string,
 *   accessKey: string,
 *   secretKey: string,
 *   extraQuery?: Array<[string, string]>,
 *   extraHeaders?: Record<string, string>,
 *   body?: Buffer | string | null,
 *   anonymous?: boolean,
 *   attempts?: number,
 *   sleep?: (ms: number) => Promise<void>,
 *   requestImpl?: typeof performTosHttpRequest,
 * }} options
 */
export async function tosFetch(options) {
  const extraHeaders = { ...(options.extraHeaders ?? {}) };
  let url;
  if (options.anonymous) {
    url = `https://${options.host}/${options.objectKey
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/")}`;
  } else {
    const signed = presignUrl({
      method: options.method,
      host: options.host,
      objectKey: options.objectKey,
      region: options.region,
      accessKey: options.accessKey,
      secretKey: options.secretKey,
      expiresSecs: PUT_EXPIRES_SECS,
      now: new Date(),
      extraQuery: options.extraQuery,
      extraHeaders,
    });
    url = signed.url;
    for (const [name, value] of Object.entries(signed.signedHeaders)) {
      if (name !== "host") extraHeaders[name] = value;
    }
  }
  const send = options.requestImpl ?? performTosHttpRequest;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const attempts = options.attempts ?? TOS_FETCH_MAX_ATTEMPTS;
  let lastError = /** @type {unknown} */ (undefined);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await send({
        url,
        method: options.method,
        headers: extraHeaders,
        body: options.body ?? null,
      });
      if ((result.status === 408 || result.status === 503) && attempt < attempts) {
        const delayMs = 1000 * 2 ** (attempt - 1);
        console.warn(
          `[tos-publish] HTTP ${result.status}；${delayMs}ms 后重试 (${attempt}/${attempts})`,
        );
        await sleep(delayMs);
        continue;
      }
      return result;
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetryableTosNetworkError(error)) {
        throw wrapTosFetchError(error);
      }
      const delayMs = 1000 * 2 ** (attempt - 1);
      const wrapped = wrapTosFetchError(error);
      console.warn(
        `[tos-publish] ${wrapped.message}；${delayMs}ms 后重试 (${attempt}/${attempts})`,
      );
      await sleep(delayMs);
    }
  }
  throw wrapTosFetchError(lastError);
}

async function findWorkingSecretKey(config) {
  const host = tosUpdatesHost(config.bucket, config.endpoint);
  let lastError = "";
  for (const secretKey of candidateSecretKeys(config.secretKey)) {
    const result = await tosFetch({
      method: "GET",
      host,
      objectKey: "",
      region: config.region,
      accessKey: config.accessKey,
      secretKey,
      extraQuery: [
        ["list-type", "2"],
        ["max-keys", "1"],
        ["prefix", `${config.prefix.replace(/\/+$/, "")}/`],
      ],
    });
    if (result.status >= 200 && result.status < 300) {
      return secretKey;
    }
    lastError = `ListObjects HTTP ${result.status} ${result.text.slice(0, 240)}`;
  }
  throw new Error(`TOS 鉴权失败（${lastError}）。请核对 AK/SK、桶名和地域。`);
}

export async function putPublicObject(config, objectKey, body, fileName, digest) {
  const host = tosUpdatesHost(config.bucket, config.endpoint);
  const result = await tosFetch({
    method: "PUT",
    host,
    objectKey,
    region: config.region,
    accessKey: config.accessKey,
    secretKey: config.secretKey,
    extraHeaders: {
      "content-type": contentTypeForFileName(fileName),
      "cache-control": cacheControlForFileName(fileName),
      "x-tos-acl": "public-read",
      ...(digest ? { "x-tos-meta-sha256": digest } : {}),
    },
    body,
  });
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`上传 ${objectKey} 失败：HTTP ${result.status} ${result.text.slice(0, 300)}`);
  }
  return result;
}

export function parseTosUploadId(payload) {
  const text = String(payload).trim();
  if (text.startsWith("{")) {
    const parsed = JSON.parse(text);
    if (typeof parsed.UploadId === "string" && parsed.UploadId.trim() !== "") {
      return parsed.UploadId.trim();
    }
  }
  const match = text.match(/<UploadId>([^<]+)<\/UploadId>/i);
  if (match?.[1]) return match[1].trim();
  throw new Error(`TOS 分片初始化未返回 UploadId：${text.slice(0, 240)}`);
}

export function normalizeTosEtag(etag) {
  return String(etag ?? "")
    .trim()
    .replace(/^W\//i, "")
    .replaceAll('"', "");
}

export function buildCompleteMultipartJson(parts) {
  return JSON.stringify({
    Parts: parts.map((part) => ({
      PartNumber: part.partNumber,
      ETag: normalizeTosEtag(part.etag),
    })),
  });
}

function multipartProgressPath(filePath) {
  return `${filePath}.multipart.json`;
}

export function readMultipartProgress(filePath, objectKey, size, digest) {
  const progressPath = multipartProgressPath(filePath);
  if (!existsSync(progressPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(progressPath, "utf8"));
    if (
      parsed &&
      parsed.objectKey === objectKey &&
      parsed.size === size &&
      parsed.partSize === TOS_MULTIPART_PART_SIZE_BYTES &&
      parsed.digest === (digest ?? null) &&
      typeof parsed.uploadId === "string" &&
      parsed.uploadId !== "" &&
      Array.isArray(parsed.parts)
    ) {
      return parsed;
    }
  } catch {
    // 进度文件损坏就重新初始化。
  }
  return null;
}

function writeMultipartProgress(filePath, progress) {
  writeFileSync(`${filePath}.multipart.json`, `${JSON.stringify(progress)}\n`);
}

function clearMultipartProgress(filePath) {
  const progressPath = multipartProgressPath(filePath);
  if (existsSync(progressPath)) unlinkSync(progressPath);
}

function readFileSlice(filePath, offset, length) {
  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(fd, buffer, 0, length, offset);
    return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

function listMultipartSlices(size) {
  /** @type {Array<{ partNumber: number, offset: number, length: number }>} */
  const slices = [];
  let offset = 0;
  let partNumber = 1;
  while (offset < size) {
    const length = Math.min(TOS_MULTIPART_PART_SIZE_BYTES, size - offset);
    slices.push({ partNumber, offset, length });
    offset += length;
    partNumber += 1;
  }
  return slices;
}

async function runWithConcurrency(items, concurrency, worker) {
  let nextIndex = 0;
  async function runNext() {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      await worker(items[current], current);
    }
  }
  const poolSize = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: poolSize }, () => runNext()));
}

export async function putPublicObjectFromFile(config, objectKey, filePath, fileName, digest) {
  const size = statSync(filePath).size;
  if (size <= TOS_MULTIPART_THRESHOLD_BYTES) {
    return putPublicObject(config, objectKey, readFileSync(filePath), fileName, digest);
  }
  const host = tosUpdatesHost(config.bucket, config.endpoint);
  const contentType = contentTypeForFileName(fileName);
  let progress = readMultipartProgress(filePath, objectKey, size, digest);
  if (!progress) {
    const initiated = await tosFetch({
      method: "POST",
      host,
      objectKey,
      region: config.region,
      accessKey: config.accessKey,
      secretKey: config.secretKey,
      extraQuery: [["uploads", ""]],
      extraHeaders: {
        "content-type": contentType,
        "cache-control": cacheControlForFileName(fileName),
        "x-tos-acl": "public-read",
        ...(digest ? { "x-tos-meta-sha256": digest } : {}),
      },
    });
    if (initiated.status < 200 || initiated.status >= 300) {
      throw new Error(
        `初始化分片上传 ${objectKey} 失败：HTTP ${initiated.status} ${initiated.text.slice(0, 300)}`,
      );
    }
    progress = {
      objectKey,
      size,
      partSize: TOS_MULTIPART_PART_SIZE_BYTES,
      digest: digest ?? null,
      uploadId: parseTosUploadId(initiated.text),
      parts: [],
    };
    writeMultipartProgress(filePath, progress);
  } else {
    console.log(
      `[tos-publish] 续传 ${objectKey}，已有 ${progress.parts.length} 个分片，uploadId=${progress.uploadId}`,
    );
  }
  const uploadId = progress.uploadId;
  /** @type {Array<{ partNumber: number, etag: string }>} */
  const parts = [...progress.parts];
  const doneParts = new Set(parts.map((part) => part.partNumber));
  const pending = listMultipartSlices(size).filter((slice) => !doneParts.has(slice.partNumber));
  let abortOnFailure = pending.length > 0;
  try {
    let persistLock = Promise.resolve();
    await runWithConcurrency(pending, TOS_MULTIPART_CONCURRENCY, async (slice) => {
      const body = readFileSlice(filePath, slice.offset, slice.length);
      const startedAt = Date.now();
      console.log(
        `[tos-publish] 分片 ${slice.partNumber} ${objectKey} ${slice.offset}-${slice.offset + slice.length - 1}/${size}`,
      );
      const uploaded = await tosFetch({
        method: "PUT",
        host,
        objectKey,
        region: config.region,
        accessKey: config.accessKey,
        secretKey: config.secretKey,
        extraQuery: [
          ["partNumber", String(slice.partNumber)],
          ["uploadId", uploadId],
        ],
        extraHeaders: {
          "content-type": "application/octet-stream",
        },
        body,
      });
      if (uploaded.status < 200 || uploaded.status >= 300 || !uploaded.etag) {
        throw new Error(
          `上传分片 ${slice.partNumber} ${objectKey} 失败：HTTP ${uploaded.status} ${uploaded.text.slice(0, 300)}`,
        );
      }
      console.log(
        `[tos-publish] 分片 ${slice.partNumber} ${objectKey} 上传完成，耗时 ${Date.now() - startedAt}ms`,
      );
      const previous = persistLock;
      let release = () => {};
      persistLock = new Promise((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        parts.push({ partNumber: slice.partNumber, etag: uploaded.etag });
        writeMultipartProgress(filePath, {
          objectKey,
          size,
          partSize: TOS_MULTIPART_PART_SIZE_BYTES,
          digest: digest ?? null,
          uploadId,
          parts: [...parts].sort((left, right) => left.partNumber - right.partNumber),
        });
      } finally {
        release();
      }
    });
    abortOnFailure = false;
    parts.sort((left, right) => left.partNumber - right.partNumber);
    const completeBody = buildCompleteMultipartJson(parts);
    const completed = await tosFetch({
      method: "POST",
      host,
      objectKey,
      region: config.region,
      accessKey: config.accessKey,
      secretKey: config.secretKey,
      extraQuery: [["uploadId", uploadId]],
      extraHeaders: {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(completeBody)),
      },
      body: completeBody,
    });
    if (completed.status < 200 || completed.status >= 300) {
      throw new Error(
        `完成分片上传 ${objectKey} 失败：HTTP ${completed.status} ${completed.text.slice(0, 300)}`,
      );
    }
    clearMultipartProgress(filePath);
    return completed;
  } catch (error) {
    if (abortOnFailure) {
      clearMultipartProgress(filePath);
      await tosFetch({
        method: "DELETE",
        host,
        objectKey,
        region: config.region,
        accessKey: config.accessKey,
        secretKey: config.secretKey,
        extraQuery: [["uploadId", uploadId]],
      }).catch(() => {});
    }
    throw error;
  }
}

export async function getAnonymousObject(config, objectKey) {
  return tosFetch({
    method: "GET",
    host: tosUpdatesHost(config.bucket, config.endpoint),
    objectKey,
    region: config.region,
    accessKey: config.accessKey,
    secretKey: config.secretKey,
    anonymous: true,
  });
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

export function immutableObjectMatches(remote, digest, size) {
  const headers = remote.headers ?? {};
  return (
    remote.status === 200 &&
    headers["x-tos-meta-sha256"] === digest &&
    Number(headers["content-length"]) === size
  );
}

async function putImmutableFile(config, objectKey, filePath, expectedDigest) {
  const size = statSync(filePath).size;
  const digest = await sha256File(filePath);
  if (expectedDigest && digest !== expectedDigest) {
    throw new Error(`资源文件在清单验证后发生变化：${filePath}`);
  }
  const probe = await tosFetch({
    method: "HEAD",
    host: tosUpdatesHost(config.bucket, config.endpoint),
    objectKey,
    region: config.region,
    accessKey: config.accessKey,
    secretKey: config.secretKey,
    anonymous: true,
  });
  if (probe.status === 200) {
    if (!immutableObjectMatches(probe, digest, size)) {
      throw new Error(`版本化对象已存在且内容不同或缺少校验元数据，拒绝覆盖：${objectKey}`);
    }
    return false;
  }
  if (probe.status !== 404) {
    throw new Error(`检查版本化对象失败：${objectKey} HTTP ${probe.status}`);
  }
  await putPublicObjectFromFile(config, objectKey, filePath, path.basename(filePath), digest);
  const confirmed = await tosFetch({
    method: "HEAD",
    host: tosUpdatesHost(config.bucket, config.endpoint),
    objectKey,
    region: config.region,
    accessKey: config.accessKey,
    secretKey: config.secretKey,
    anonymous: true,
  });
  if (!immutableObjectMatches(confirmed, digest, size)) {
    throw new Error(`上传后对象校验失败，未发布 latest.json：${objectKey}`);
  }
  return true;
}

export async function deleteObject(config, objectKey) {
  return tosFetch({
    method: "DELETE",
    host: tosUpdatesHost(config.bucket, config.endpoint),
    objectKey,
    region: config.region,
    accessKey: config.accessKey,
    secretKey: config.secretKey,
  });
}

export async function probePublicPrefix(config) {
  const objectKey = tosUpdatesObjectKey(PROBE_FILE, config.prefix);
  const payload = Buffer.from("infinite-canvas updater public probe\n", "utf8");
  await putPublicObject(config, objectKey, payload, PROBE_FILE);
  try {
    const anonymous = await getAnonymousObject(config, objectKey);
    if (anonymous.status !== 200) {
      throw new Error(
        `对象已上传，但匿名读取 ${objectKey} 返回 HTTP ${anonymous.status}。请在 TOS 控制台确认未开启「阻止公共访问」。`,
      );
    }
    return {
      objectKey,
      publicUrl: `${tosUpdatesPublicBaseUrl({
        bucket: config.bucket,
        endpoint: config.endpoint,
        prefix: config.prefix,
      })}/${PROBE_FILE}`,
    };
  } finally {
    await deleteObject(config, objectKey);
  }
}

function artifactName(url) {
  return decodeURIComponent(new URL(url).pathname.split("/").at(-1) ?? "");
}

export function resolvePublishChannel(
  channel,
  platforms,
  basePrefix = TOS_UPDATES_PREFIX,
  version,
) {
  if (channel === "legacy") {
    if (!platforms["windows-x86_64"] || !platforms["darwin-aarch64"]) {
      throw new Error(
        "旧版共用 latest.json 只能在同版 Windows x64 和 macOS arm64 签名包都齐备时发布",
      );
    }
    const name = artifactName(platforms["windows-x86_64"].url);
    const suffix = `_${version}_x64-setup.exe`;
    if (typeof version !== "string" || !name.endsWith(suffix) || name.includes("-slim-")) {
      throw new Error("旧版共用 latest.json 只能发布本版完整 Windows NSIS 包，禁止瘦包");
    }
    return basePrefix;
  }
  if (!/^(windows|darwin|linux)-(x86_64|aarch64|i686|armv7)$/.test(channel ?? "")) {
    throw new Error("必须明确指定 --channel legacy 或平台名（如 windows-x86_64）");
  }
  if (Object.keys(platforms).length !== 1 || !platforms[channel]) {
    throw new Error(`平台频道 ${channel} 只能发布自己的一个签名包`);
  }
  return `${basePrefix}/${channel}`;
}

export function compareReleaseVersions(left, right) {
  const parse = (value) => {
    if (typeof value !== "string" || !/^\d+\.\d+\.\d+$/.test(value)) {
      throw new Error(`发布版本格式不正确：${value}`);
    }
    return value.split(".").map(Number);
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

export function checkChannelManifest(existing, proposed) {
  if (!existing) return { sameVersion: false, pubDate: undefined };
  const comparison = compareReleaseVersions(proposed.version, existing.version);
  if (comparison < 0)
    throw new Error(`频道已有更高版本 ${existing.version}，拒绝回退到 ${proposed.version}`);
  if (comparison > 0) return { sameVersion: false, pubDate: undefined };
  if (
    existing.notes !== proposed.notes ||
    JSON.stringify(existing.platforms) !== JSON.stringify(proposed.platforms) ||
    JSON.stringify(existing.resourceManifest ?? null) !==
      JSON.stringify(proposed.resourceManifest ?? null) ||
    JSON.stringify(existing.macDeltaManifest ?? null) !==
      JSON.stringify(proposed.macDeltaManifest ?? null)
  ) {
    throw new Error(`频道 ${proposed.version} 已发布不同产物，拒绝同版覆盖`);
  }
  return { sameVersion: true, pubDate: existing.pub_date };
}

export function collectRuntimeResourceObjects(manifest, root) {
  const sources = new Map();
  for (const [index, component] of manifest.components.entries()) {
    const definition = RESOURCE_COMPONENTS[index];
    for (const file of component.files) {
      const sourcePath = path.join(root, definition.source, ...file.path.split("/"));
      const previous = sources.get(file.sha256);
      if (!previous) sources.set(file.sha256, { sha256: file.sha256, size: file.size, sourcePath });
      else if (previous.size !== file.size)
        throw new Error(`相同资源哈希有不同大小：${file.sha256}`);
    }
  }
  return [...sources.values()];
}

/** Only identical component/path/size/hash entries from a signed prior release
 * or unchanged trees from a verified full bridge can omit object publication. */
export function collectChangedRuntimeResourceObjects(
  manifest,
  root,
  previousManifest = null,
  unchangedBridgeComponents = [],
) {
  assertRuntimeReleaseShape(manifest);
  if (previousManifest) assertRuntimeReleaseShape(previousManifest);
  const bridgeNames = new Set(unchangedBridgeComponents);
  const changed = new Set();
  for (const [index, component] of manifest.components.entries()) {
    const prior = previousManifest?.components[index];
    const priorFiles = new Map(prior?.files.map((file) => [file.path, file]) ?? []);
    if (bridgeNames.has(component.name)) continue;
    for (const file of component.files) {
      const previous = priorFiles.get(file.path);
      if (previous?.sha256 !== file.sha256 || previous.size !== file.size) {
        changed.add(file.sha256);
      }
    }
  }
  return collectRuntimeResourceObjects(manifest, root).filter((object) =>
    changed.has(object.sha256),
  );
}

/** Validate publication inputs before touching a live feed. The signed manifest is
 * also checked by the client, but the publisher must not upload a broken release. */
export function collectMacDeltaObjects(manifest, version, expectedObjectBaseUrl) {
  validateMacDeltaManifest(manifest);
  if (
    compareReleaseVersions(manifest.baseVersion, version) >= 0 ||
    manifest.version !== version ||
    manifest.platform !== "darwin-aarch64" ||
    manifest.appName !== "无限画布.app" ||
    manifest.objectBaseUrl !== expectedObjectBaseUrl
  )
    throw new Error("macOS 差分清单版本、平台或对象地址无效");

  const objects = new Map();
  let totalBytes = 0;
  for (const entry of manifest.files) {
    if (entry.kind === "file") {
      if (entry.size > 8 * 1024 ** 3) throw new Error(`macOS 差分文件超限：${entry.path}`);
      totalBytes += entry.size;
      if (entry.source === "object") {
        const previous = objects.get(entry.sha256);
        if (previous != null && previous !== entry.size) {
          throw new Error(`macOS 差分对象哈希大小冲突：${entry.sha256}`);
        }
        objects.set(entry.sha256, entry.size);
      }
    }
  }
  if (totalBytes > 20 * 1024 ** 3) throw new Error("macOS 差分清单总大小超限");
  return [...objects].map(([sha256, size]) => ({ sha256, size }));
}

export function macDeltaTransferIsSmaller(
  objects,
  manifestBytes,
  signatureBytes,
  fullArchiveBytes,
) {
  const deltaBytes = objects.reduce(
    (total, object) => total + object.size,
    manifestBytes + signatureBytes,
  );
  return Number.isSafeInteger(deltaBytes) && deltaBytes < fullArchiveBytes;
}

function macDeltaEntryIdentity(entry) {
  if (entry.kind === "file") {
    return [entry.path, entry.kind, entry.size, entry.sha256, entry.mode];
  }
  if (entry.kind === "dir") return [entry.path, entry.kind, entry.mode];
  return [entry.path, entry.kind, entry.target];
}

/** Read a signed macOS full updater as a stream; never extract archive entries. */
export async function inventoryMacFullArchive(archivePath, appName) {
  const script = path.join(REPO_ROOT, "scripts", "inventory-macos-updater-archive.py");
  const python = process.platform === "win32" ? "python" : "python3";
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script, archivePath, appName], {
      cwd: REPO_ROOT,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = [];
    let outputBytes = 0;
    let stderr = "";
    let oversized = false;
    child.stdout.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > 32 * 1024 * 1024) {
        oversized = true;
        child.kill();
      } else {
        output.push(chunk);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString()}`.slice(0, 2_000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (oversized) return reject(new Error("macOS 完整包文件树清单输出超限"));
      if (code !== 0) return reject(new Error(`读取 macOS 完整包文件树失败：${stderr}`));
      try {
        resolve(JSON.parse(Buffer.concat(output).toString("utf8")));
      } catch {
        reject(new Error("macOS 完整包文件树输出格式无效"));
      }
    });
  });
}

export async function assertMacDeltaMatchesFullArchive(archivePath, manifest) {
  const actual = await inventoryMacFullArchive(archivePath, manifest.appName);
  const expected = manifest.files;
  if (!Array.isArray(actual) || actual.length !== expected.length) {
    throw new Error("macOS 差分目标文件树与完整 updater 包不一致：文件数量不同");
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (
      JSON.stringify(macDeltaEntryIdentity(actual[index])) !==
      JSON.stringify(macDeltaEntryIdentity(expected[index]))
    ) {
      throw new Error(`macOS 差分目标文件树与完整 updater 包不一致：${expected[index].path}`);
    }
  }
}

async function verifyStagedMacDeltaRelease({
  manifestPath,
  version,
  expectedObjectBaseUrl,
  fullArchivePath,
  pubkey,
}) {
  if (statSync(manifestPath).size > 16 * 1024 * 1024) {
    throw new Error("macOS 差分清单超过客户端允许的 16 MiB");
  }
  await verifyUpdaterSignature(manifestPath, `${manifestPath}.sig`, pubkey);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const objects = collectMacDeltaObjects(manifest, version, expectedObjectBaseUrl);
  const objectDir = path.join(path.dirname(manifestPath), "objects");
  const expected = new Set(objects.map((object) => object.sha256));
  const actual = new Set(readdirSync(objectDir));
  if (expected.size !== actual.size || [...expected].some((name) => !actual.has(name))) {
    throw new Error("macOS 差分暂存对象与已签名清单不一致");
  }
  for (const object of objects) {
    const sourcePath = path.join(objectDir, object.sha256);
    const source = lstatSync(sourcePath);
    if (
      !source.isFile() ||
      source.isSymbolicLink() ||
      source.size !== object.size ||
      (await sha256File(sourcePath)) !== object.sha256
    ) {
      throw new Error(`macOS 差分对象哈希或大小不匹配：${object.sha256}`);
    }
  }
  await verifyUpdaterSignature(fullArchivePath, `${fullArchivePath}.sig`, pubkey);
  await assertMacDeltaMatchesFullArchive(fullArchivePath, manifest);
  return {
    manifest,
    signature: readFileSync(`${manifestPath}.sig`, "utf8").trim(),
    objects: objects.map((object) => ({
      ...object,
      sourcePath: path.join(objectDir, object.sha256),
    })),
  };
}

export function checkLegacyPlatformFeeds(version, platforms, feeds, windowsFullOffline = false) {
  for (const platform of ["windows-x86_64", "darwin-aarch64"]) {
    const feed = feeds[platform];
    if (
      feed?.version !== version ||
      ((!windowsFullOffline || platform !== "windows-x86_64") &&
        feed.platforms?.[platform]?.signature !== platforms[platform]?.signature)
    ) {
      throw new Error(`旧版频道发布前必须初始化同版 ${platform} 平台频道`);
    }
  }
  const windowsName = artifactName(feeds["windows-x86_64"].platforms["windows-x86_64"].url);
  if (windowsFullOffline ? !windowsName.includes("-slim-") : windowsName.includes("-slim-")) {
    throw new Error(
      windowsFullOffline
        ? "离线完整包晋升前 Windows 平台频道必须指向瘦包"
        : "旧版频道发布前 Windows 平台频道必须指向完整包",
    );
  }
}

export function collectLegacyChannelPlatforms(version, feeds, publicBase, windowsFullSignature) {
  const windowsFullOffline = typeof windowsFullSignature === "string";
  if (windowsFullOffline && windowsFullSignature.trim() === "") {
    throw new Error("旧版频道离线完整 Windows 包签名为空");
  }
  const platforms = {};
  for (const platform of ["windows-x86_64", "darwin-aarch64"]) {
    const feed = feeds[platform];
    const entry = feed?.platforms?.[platform];
    if (
      feed?.version !== version ||
      Object.keys(feed.platforms ?? {}).length !== 1 ||
      typeof entry?.url !== "string" ||
      typeof entry?.signature !== "string" ||
      entry.signature.trim() === ""
    ) {
      throw new Error(`旧版频道发布前必须初始化同版 ${platform} 平台频道`);
    }
    const fileName = artifactName(entry.url);
    const expectedName =
      platform === "windows-x86_64"
        ? `无限画布_${version}_x64${windowsFullOffline ? "-slim" : ""}-setup.exe`
        : `无限画布_${version}_aarch64-full.app.tar.gz`;
    if (fileName !== expectedName) {
      throw new Error(`旧版频道只能引用本版完整 ${platform} 更新包`);
    }
    const expectedUrl = `${publicBase}/${platform}/${encodeURIComponent(fileName)}`;
    if (entry.url !== expectedUrl) {
      throw new Error(`旧版频道 ${platform} 的下载地址不在预期 TOS 前缀`);
    }
    platforms[platform] =
      platform === "windows-x86_64" && windowsFullOffline
        ? {
            url: `${publicBase}/offline/${version}/${encodeURIComponent(`无限画布_${version}_x64-setup.exe`)}`,
            signature: windowsFullSignature,
          }
        : { url: entry.url, signature: entry.signature };
  }
  return platforms;
}

export function collectLegacyWindowsFullFile(directory, version) {
  const name = `无限画布_${version}_x64-setup.exe`;
  const matches = listFilesRecursive(directory).filter(
    (filePath) => path.basename(filePath) === name,
  );
  if (matches.length !== 1) throw new Error("旧版频道需要恰好一个本版完整 Windows NSIS 包");
  const filePath = matches[0];
  if (
    !lstatSync(filePath).isFile() ||
    statSync(filePath).size === 0 ||
    !existsSync(`${filePath}.sig`) ||
    !lstatSync(`${filePath}.sig`).isFile() ||
    statSync(`${filePath}.sig`).size === 0
  ) {
    throw new Error("旧版频道完整 Windows NSIS 包或签名文件无效");
  }
  return filePath;
}

export function assertReleaseVersionMatchesSource(version, sourceVersion) {
  if (version !== sourceVersion) {
    throw new Error(`发布版本 ${version} 与当前源码版本 ${sourceVersion} 不一致`);
  }
}

export function assertWindowsInstallerProductVersion(productVersion, version) {
  if (productVersion !== version) {
    throw new Error(
      `完整 Windows NSIS 内部 ProductVersion ${productVersion || "<空>"} 与 ${version} 不一致`,
    );
  }
}

export function readWindowsInstallerProductVersion(filePath) {
  if (process.platform !== "win32") {
    throw new Error("离线完整 Windows NSIS 内部版本校验必须在 Windows 发布机执行");
  }
  const powershell = path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  return execFileSync(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[System.Diagnostics.FileVersionInfo]::GetVersionInfo($env:IC_NSIS_PATH).ProductVersion",
    ],
    {
      encoding: "utf8",
      env: { ...process.env, IC_NSIS_PATH: filePath },
      timeout: 30_000,
      maxBuffer: 4096,
      windowsHide: true,
    },
  ).trim();
}

export async function verifyStagedWindowsSlimUpdater(bundleDir, version, pubkey) {
  const expectedName = `无限画布_${version}_x64-slim-setup.exe`;
  const matches = listFilesRecursive(bundleDir).filter(
    (filePath) => path.basename(filePath) === expectedName,
  );
  if (matches.length !== 1) {
    throw new Error("Windows 瘦包暂存目录需要恰好一个本版 NSIS 安装包");
  }
  await verifyUpdaterSignature(matches[0], `${matches[0]}.sig`, pubkey);
  assertWindowsInstallerProductVersion(readWindowsInstallerProductVersion(matches[0]), version);
  return matches[0];
}

async function readPublicManifest(config, objectKey) {
  const result = await getAnonymousObject(config, objectKey);
  if (result.status === 404) return null;
  if (result.status !== 200) {
    throw new Error(`读取频道清单失败：${objectKey} HTTP ${result.status}`);
  }
  try {
    return JSON.parse(result.text);
  } catch {
    throw new Error(`频道清单不是有效 JSON：${objectKey}`);
  }
}

export function assertLegacyRetirementTarget(config, expectedVersion, backupFile) {
  if (
    config.bucket !== TOS_UPDATES_BUCKET ||
    config.endpoint !== TOS_UPDATES_ENDPOINT ||
    config.prefix !== TOS_UPDATES_PREFIX ||
    !/^\d+\.\d+\.\d+$/.test(expectedVersion ?? "") ||
    typeof backupFile !== "string" ||
    backupFile.trim() === ""
  ) {
    throw new Error("停用旧共享频道需要精确桶、前缀、预期版本和本地备份路径");
  }
  return tosUpdatesObjectKey("latest.json", TOS_UPDATES_PREFIX);
}

export async function retireLegacyFeed(options = {}) {
  const expectedVersion = options["expected-version"];
  const backupFile = options["backup-file"];
  const requiredWindowsVersion = options["require-windows-version"];
  const envConfig = readTosPublishEnv(options.env ?? process.env);
  const key = assertLegacyRetirementTarget(envConfig, expectedVersion, backupFile);
  if (!/^\d+\.\d+\.\d+$/.test(requiredWindowsVersion ?? "")) {
    throw new Error("停用旧共享频道需要 --require-windows-version 指定已发布的 Windows 平台版本");
  }
  const secretKey = await findWorkingSecretKey(envConfig);
  const config = { ...envConfig, secretKey };
  const windowsFeed = await readPublicManifest(
    config,
    tosUpdatesObjectKey("latest.json", `${TOS_UPDATES_PREFIX}/windows-x86_64`),
  );
  const windowsArtifact = windowsFeed?.platforms?.["windows-x86_64"]?.url;
  if (
    windowsFeed?.version !== requiredWindowsVersion ||
    windowsArtifact !==
      `${tosUpdatesPublicBaseUrl()}/windows-x86_64/${encodeURIComponent(`无限画布_${requiredWindowsVersion}_x64-slim-setup.exe`)}` ||
    !windowsFeed.resourceManifest
  ) {
    throw new Error("目标 Windows 瘦包平台频道尚未验证发布，拒绝停用旧共享频道");
  }
  const pubkey = JSON.parse(
    readFileSync(path.join(REPO_ROOT, "src-tauri", "tauri.conf.json"), "utf8"),
  ).plugins.updater.pubkey;
  await readSignedPreviousResourceManifest(config, windowsFeed, pubkey, TOS_UPDATES_PREFIX);
  const current = await getAnonymousObject(config, key);
  if (current.status !== 200) {
    throw new Error(`旧共享频道清单无法备份：HTTP ${current.status}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(current.text);
  } catch {
    throw new Error("旧共享频道清单不是有效 JSON");
  }
  if (parsed.version !== expectedVersion) {
    throw new Error(`旧共享频道版本 ${parsed.version} 与预期 ${expectedVersion} 不一致`);
  }
  writeFileSync(path.resolve(backupFile), current.text, { flag: "wx" });
  const removed = await deleteObject(config, key);
  if (removed.status < 200 || removed.status >= 300) {
    throw new Error(`停用旧共享频道失败：HTTP ${removed.status}`);
  }
  const verified = await getAnonymousObject(config, key);
  if (verified.status !== 404) {
    throw new Error(`旧共享频道删除后匿名读取仍返回 HTTP ${verified.status}`);
  }
  return { key, backupFile: path.resolve(backupFile) };
}

async function readSignedPreviousResourceManifest(config, feed, pubkey, basePrefix) {
  const previousVersion = feed?.version;
  const reference = feed?.resourceManifest;
  const base = tosUpdatesPublicBaseUrl({ ...config, prefix: basePrefix });
  const expectedUrl = `${base}/resources/${previousVersion}/windows-x86_64/manifest.json`;
  if (
    typeof previousVersion !== "string" ||
    reference?.url !== expectedUrl ||
    typeof reference.signature !== "string" ||
    reference.signature.trim() === ""
  ) {
    throw new Error("上一版 Windows 频道缺少可信的签名资源清单");
  }
  const key = tosUpdatesObjectKey(
    "manifest.json",
    `${basePrefix}/resources/${previousVersion}/windows-x86_64`,
  );
  const response = await getAnonymousObject(config, key);
  if (response.status !== 200 || Buffer.byteLength(response.text, "utf8") > 16 * 1024 * 1024) {
    throw new Error(`上一版签名资源清单无法读取：HTTP ${response.status}`);
  }
  verifyUpdaterSignatureBytes(Buffer.from(response.text), reference.signature, pubkey);
  const previousManifest = JSON.parse(response.text);
  assertRuntimeReleaseShape(previousManifest);
  if (
    previousManifest.version !== previousVersion ||
    previousManifest.objectBaseUrl !== `${base}/resources/objects/`
  ) {
    throw new Error("上一版签名资源清单的版本或对象地址不匹配");
  }
  return previousManifest;
}

export async function verifyResourceBridgeBaseline(
  baselinePath,
  previousFeed,
  targetVersion,
  pubkey,
  basePrefix,
  config,
) {
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  if (compareReleaseVersions(baseline.bridgeVersion, targetVersion) >= 0) {
    throw new Error("资源基线的过渡版必须早于待发布版本");
  }
  const actual = await createRuntimeBaseline();
  assertRuntimeBaseline(baseline, actual, targetVersion, {
    signedResourceReleaseVerified: true,
  });
  const installer = collectLegacyWindowsFullFile(
    path.dirname(baselinePath),
    baseline.bridgeVersion,
  );
  const signaturePath = `${installer}.sig`;
  await verifyUpdaterSignature(installer, signaturePath, pubkey);
  assertWindowsInstallerProductVersion(
    readWindowsInstallerProductVersion(installer),
    baseline.bridgeVersion,
  );
  if (
    (await sha256File(installer)) !== baseline.fullNsisSha256 ||
    (await sha256File(signaturePath)) !== baseline.fullNsisSignatureSha256
  ) {
    throw new Error("完整过渡版安装包与资源基线的签名来源不匹配");
  }
  const expectedUrl = `${tosUpdatesPublicBaseUrl({ ...config, prefix: basePrefix })}/windows-x86_64/${encodeURIComponent(path.basename(installer))}`;
  if (
    previousFeed?.version !== baseline.bridgeVersion ||
    previousFeed.platforms?.["windows-x86_64"]?.url !== expectedUrl ||
    previousFeed.platforms["windows-x86_64"].signature !==
      readFileSync(signaturePath, "utf8").trim()
  ) {
    throw new Error("资源基线安装包与线上上一版 Windows 频道不一致");
  }
  return RESOURCE_COMPONENTS.filter((component) => {
    const old = baseline.resources[component.source];
    const now = actual.resources[component.source];
    return old.sha256 === now.sha256 && old.files === now.files && old.bytes === now.bytes;
  }).map((component) => component.name);
}

export function assertRetiredSharedChannelWrite(options = {}) {
  if (options["promote-legacy"] === true || options.channel === "legacy") {
    throw new Error("旧共享更新频道已永久停用；禁止重新发布 updates/latest.json");
  }
}

export async function promoteLegacyFromPlatformFeeds(options = {}) {
  assertRetiredSharedChannelWrite({ ...options, "promote-legacy": true });
  const version = typeof options.version === "string" ? options.version : readAppVersion();
  assertReleaseVersionMatchesSource(version, readAppVersion());
  const windowsFullDir = options["windows-full-bundle-dir"];
  const windowsFullOffline = typeof windowsFullDir === "string" && windowsFullDir.trim() !== "";
  let windowsFull = null;
  if (windowsFullOffline) {
    const filePath = collectLegacyWindowsFullFile(path.resolve(windowsFullDir), version);
    const appConfig = JSON.parse(
      readFileSync(path.join(REPO_ROOT, "src-tauri", "tauri.conf.json"), "utf8"),
    );
    await verifyUpdaterSignature(filePath, `${filePath}.sig`, appConfig.plugins.updater.pubkey);
    assertWindowsInstallerProductVersion(readWindowsInstallerProductVersion(filePath), version);
    windowsFull = {
      signature: readFileSync(`${filePath}.sig`, "utf8").trim(),
      sha256: await sha256File(filePath),
      size: statSync(filePath).size,
    };
  }
  const envConfig = readTosPublishEnv(options.env ?? process.env);
  const secretKey = await findWorkingSecretKey(envConfig);
  const config = { ...envConfig, secretKey };
  const publicBase = tosUpdatesPublicBaseUrl(config);
  const feeds = {};
  for (const platform of ["windows-x86_64", "darwin-aarch64"]) {
    feeds[platform] = await readPublicManifest(
      config,
      tosUpdatesObjectKey("latest.json", `${config.prefix}/${platform}`),
    );
  }
  const platforms = collectLegacyChannelPlatforms(
    version,
    feeds,
    publicBase,
    windowsFull?.signature,
  );
  checkLegacyPlatformFeeds(version, platforms, feeds, windowsFullOffline);
  const artifacts = windowsFullOffline
    ? [
        ["windows-x86_64", feeds["windows-x86_64"].platforms["windows-x86_64"]],
        ["offline", platforms["windows-x86_64"]],
        ["darwin-aarch64", platforms["darwin-aarch64"]],
      ]
    : Object.entries(platforms);
  for (const [platform, entry] of artifacts) {
    const fileName = artifactName(entry.url);
    const objectKey = tosUpdatesObjectKey(
      fileName,
      platform === "offline"
        ? `${config.prefix}/offline/${version}`
        : `${config.prefix}/${platform}`,
    );
    const artifact = await tosFetch({
      method: "HEAD",
      host: tosUpdatesHost(config.bucket, config.endpoint),
      objectKey,
      region: config.region,
      accessKey: config.accessKey,
      secretKey: config.secretKey,
      anonymous: true,
    });
    if (
      artifact.status !== 200 ||
      !Number.isSafeInteger(Number(artifact.headers?.["content-length"])) ||
      Number(artifact.headers?.["content-length"]) <= 0 ||
      !/^[a-f0-9]{64}$/i.test(artifact.headers?.["x-tos-meta-sha256"] ?? "")
    ) {
      throw new Error(`旧版频道发布前 ${platform} 更新包未通过公开对象校验`);
    }
    if (
      platform === "offline" &&
      !immutableObjectMatches(artifact, windowsFull.sha256, windowsFull.size)
    ) {
      throw new Error("旧版频道发布前离线完整 Windows 包与本地已验签产物不一致");
    }
    const signature = await getAnonymousObject(config, `${objectKey}.sig`);
    if (signature.status !== 200 || signature.text.trim() !== entry.signature.trim()) {
      throw new Error(`旧版频道发布前 ${platform} 更新签名不匹配`);
    }
  }
  const manifest = buildLatestManifest({
    version,
    notes: typeof options.notes === "string" ? options.notes : `升级到 ${version}。`,
    platforms,
  });
  const objectKey = tosUpdatesObjectKey("latest.json", config.prefix);
  const current = await readPublicManifest(config, objectKey);
  const previous = checkChannelManifest(current, manifest);
  if (previous.sameVersion) {
    return { latestJsonUrl: tosUpdatesLatestJsonUrl(config), uploadedKeys: [], version };
  }
  const body = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await putPublicObject(
    config,
    objectKey,
    body,
    "latest.json",
    createHash("sha256").update(body).digest("hex"),
  );
  const published = await readPublicManifest(config, objectKey);
  if (JSON.stringify(published) !== JSON.stringify(manifest)) {
    throw new Error("旧版共用更新清单发布后读取内容不一致");
  }
  return {
    latestJsonUrl: tosUpdatesLatestJsonUrl(config),
    uploadedKeys: [objectKey],
    version,
  };
}

export function collectFullOfflineFiles(directory, version) {
  const files = listFilesRecursive(directory);
  const installers = files.filter((filePath) => {
    const name = path.basename(filePath);
    return (
      name.endsWith(`_${version}_x64-setup.exe`) ||
      (name.includes(`_${version}_`) && name.endsWith(".msi"))
    );
  });
  if (!installers.some((filePath) => filePath.endsWith("-setup.exe"))) {
    throw new Error("完整离线暂存目录缺少本版 NSIS 安装包");
  }
  for (const filePath of installers) {
    if (filePath.endsWith("-setup.exe") && !existsSync(`${filePath}.sig`)) {
      throw new Error(`完整离线 NSIS 包缺少签名：${filePath}`);
    }
  }
  return installers.flatMap((filePath) =>
    filePath.endsWith("-setup.exe") ? [filePath, `${filePath}.sig`] : [filePath],
  );
}

export function assertFullOfflinePublishOptions(
  channel,
  slimWindows,
  hasFullBundleDir,
  noFullOffline,
) {
  if (noFullOffline) {
    if (channel !== "windows-x86_64" || !slimWindows || hasFullBundleDir) {
      throw new Error(
        "--no-full-offline 只能用于 Windows 瘦包平台发布，且不能同时提供完整离线目录",
      );
    }
    return;
  }
  if ((channel.startsWith("windows-") || channel === "darwin-aarch64") && !hasFullBundleDir) {
    throw new Error(`平台频道 ${channel} 发布需要 --full-bundle-dir 提供同版完整离线安装包`);
  }
}

export function collectMacFullOfflineFiles(directory, version) {
  const files = listFilesRecursive(directory);
  const dmgs = files.filter((filePath) =>
    path.basename(filePath).endsWith(`_${version}_aarch64.dmg`),
  );
  if (dmgs.length !== 1) {
    throw new Error(
      `macOS 完整离线暂存目录需要恰好一个本版 aarch64 DMG，实际找到 ${dmgs.length} 个`,
    );
  }
  const helpers = files.filter((filePath) => path.basename(filePath) === "install-macos.sh");
  if (helpers.length > 1) {
    throw new Error("macOS 完整离线暂存目录不能包含多个 install-macos.sh");
  }
  return [...dmgs, ...helpers];
}

export async function publishUpdaterArtifacts(options) {
  assertRetiredSharedChannelWrite(options);
  const bundleDir = options["bundle-dir"];
  if (typeof bundleDir !== "string" || bundleDir.trim() === "") {
    throw new Error("发布前必须用 --bundle-dir 指定只含本版产物的暂存目录");
  }
  const version = typeof options.version === "string" ? options.version : readAppVersion();
  const bundlePath = path.resolve(bundleDir);
  const incoming = collectUpdaterPlatforms(bundlePath, {
    baseUrl: "https://placeholder.invalid",
    fallbackPlatform: typeof options.platform === "string" ? options.platform : undefined,
    version,
  });
  if (Object.keys(incoming).length === 0) {
    throw new Error(`在 ${bundlePath} 里没有找到 updater 产物`);
  }
  const envConfig = readTosPublishEnv(options.env ?? process.env);
  const channel = typeof options.channel === "string" ? options.channel : "";
  const prefix = resolvePublishChannel(channel, incoming, envConfig.prefix, version);
  const slimWindows = Object.values(incoming).some(({ url }) =>
    artifactName(url).includes("-slim-"),
  );
  if (slimWindows) {
    if (channel !== "windows-x86_64") {
      throw new Error("Windows 瘦包只能发布到 windows-x86_64 平台频道");
    }
    if (artifactName(incoming["windows-x86_64"].url) !== `无限画布_${version}_x64-slim-setup.exe`) {
      throw new Error("Windows 瘦包文件名与本版预期产物不符");
    }
    const appConfig = JSON.parse(
      readFileSync(path.join(REPO_ROOT, "src-tauri", "tauri.conf.json"), "utf8"),
    );
    await verifyStagedWindowsSlimUpdater(bundlePath, version, appConfig.plugins.updater.pubkey);
  }
  const stagedResourceManifest = path.join(
    bundlePath,
    "resources",
    version,
    "windows-x86_64",
    "manifest.json",
  );
  const resourceManifestPath =
    typeof options["resource-manifest"] === "string"
      ? path.resolve(options["resource-manifest"])
      : existsSync(stagedResourceManifest)
        ? stagedResourceManifest
        : null;
  if (slimWindows && !resourceManifestPath) throw new Error("Windows 瘦包必须附带已签名资源清单");
  let release = null;
  let resourcePubkey = null;
  if (resourceManifestPath) {
    release = await verifyRuntimeResourceRelease(
      resourceManifestPath,
      `${resourceManifestPath}.sig`,
    );
    if (release.manifest.version !== version || release.manifest.platform !== "windows-x86_64") {
      throw new Error("资源清单与当前 Windows 发布版本不符");
    }
    const expectedObjects = `${tosUpdatesPublicBaseUrl(envConfig)}/resources/objects/`;
    if (release.manifest.objectBaseUrl !== expectedObjects) {
      throw new Error("签名资源清单对象地址与当前 TOS 发布前缀不同");
    }
    const appConfig = JSON.parse(
      readFileSync(path.join(REPO_ROOT, "src-tauri", "tauri.conf.json"), "utf8"),
    );
    resourcePubkey = appConfig.plugins.updater.pubkey;
    const updaterEndpoint = new URL(appConfig.plugins.updater.endpoints[0]);
    if (new URL(expectedObjects).origin !== updaterEndpoint.origin) {
      throw new Error("资源对象地址与已构建客户端的更新源不同");
    }
  }
  const stagedMacDeltaManifest = path.join(bundlePath, "mac-delta", "manifest.json");
  const macDeltaManifestPath =
    typeof options["mac-delta-manifest"] === "string"
      ? path.resolve(options["mac-delta-manifest"])
      : existsSync(stagedMacDeltaManifest)
        ? stagedMacDeltaManifest
        : null;
  if (macDeltaManifestPath && channel !== "darwin-aarch64") {
    throw new Error("macOS 差分清单只能随 darwin-aarch64 平台频道发布");
  }
  let macDeltaRelease = null;
  if (macDeltaManifestPath) {
    const fullName = artifactName(incoming["darwin-aarch64"].url);
    const fullArchives = listFilesRecursive(bundlePath).filter(
      (filePath) => path.basename(filePath) === fullName,
    );
    if (fullArchives.length !== 1 || fullName !== `无限画布_${version}_aarch64-full.app.tar.gz`) {
      throw new Error("macOS 差分发布需要恰好一个同版完整 updater 包");
    }
    const appConfig = JSON.parse(
      readFileSync(path.join(REPO_ROOT, "src-tauri", "tauri.conf.json"), "utf8"),
    );
    const expectedObjects = `${tosUpdatesPublicBaseUrl(envConfig)}/mac-delta/objects/`;
    const updaterEndpoint = new URL(appConfig.plugins.updater.endpoints[0]);
    if (new URL(expectedObjects).origin !== updaterEndpoint.origin) {
      throw new Error("macOS 差分对象地址与已构建客户端更新源不同");
    }
    macDeltaRelease = await verifyStagedMacDeltaRelease({
      manifestPath: macDeltaManifestPath,
      version,
      expectedObjectBaseUrl: expectedObjects,
      fullArchivePath: fullArchives[0],
      pubkey: appConfig.plugins.updater.pubkey,
    });
    if (
      !macDeltaTransferIsSmaller(
        macDeltaRelease.objects,
        statSync(macDeltaManifestPath).size,
        statSync(`${macDeltaManifestPath}.sig`).size,
        statSync(fullArchives[0]).size,
      )
    ) {
      console.warn(
        "[tos-publish] macOS 差分传输量不小于完整 updater 包；本版只发布完整包，不附加 macDeltaManifest",
      );
      macDeltaRelease = null;
    }
  }
  const secretKey = await findWorkingSecretKey(envConfig);
  const config = { ...envConfig, secretKey, prefix };
  const fullBundleDir = options["full-bundle-dir"];
  const hasFullBundleDir = typeof fullBundleDir === "string" && fullBundleDir.trim() !== "";
  assertFullOfflinePublishOptions(
    channel,
    slimWindows,
    hasFullBundleDir,
    options["no-full-offline"] === true,
  );
  let offlineFiles = [];
  if (hasFullBundleDir) {
    const offlineDir = path.resolve(fullBundleDir);
    offlineFiles =
      channel === "darwin-aarch64"
        ? collectMacFullOfflineFiles(offlineDir, version)
        : collectFullOfflineFiles(offlineDir, version);
  }
  const publicBase = tosUpdatesPublicBaseUrl({
    bucket: config.bucket,
    endpoint: config.endpoint,
    prefix: config.prefix,
  });
  const resourceManifest = release
    ? {
        url: `${tosUpdatesPublicBaseUrl(envConfig)}/resources/${version}/windows-x86_64/manifest.json`,
        signature: release.signature,
      }
    : undefined;
  const macDeltaManifest = macDeltaRelease
    ? {
        url: `${tosUpdatesPublicBaseUrl(envConfig)}/mac-delta/${version}/darwin-aarch64/manifest.json`,
        signature: macDeltaRelease.signature,
      }
    : undefined;
  const out = path.join(bundlePath, "latest.json");
  const written = writeLatestJson({
    "bundle-dir": bundlePath,
    "base-url": publicBase,
    out,
    version,
    notes: typeof options.notes === "string" ? options.notes : "",
    platform: typeof options.platform === "string" ? options.platform : undefined,
    resourceManifest,
    macDeltaManifest,
  });
  if (channel === "legacy") {
    const feeds = {};
    for (const platform of ["windows-x86_64", "darwin-aarch64"]) {
      feeds[platform] = await readPublicManifest(
        config,
        tosUpdatesObjectKey("latest.json", `${envConfig.prefix}/${platform}`),
      );
    }
    checkLegacyPlatformFeeds(version, written.manifest.platforms, feeds);
  }
  const remoteLatest = await readPublicManifest(
    config,
    tosUpdatesObjectKey("latest.json", config.prefix),
  );
  const previous = checkChannelManifest(remoteLatest, written.manifest);
  let changedResourceObjects = [];
  if (release) {
    let previousManifest = null;
    let unchangedBridgeComponents = [];
    if (remoteLatest?.resourceManifest) {
      previousManifest = await readSignedPreviousResourceManifest(
        config,
        remoteLatest,
        resourcePubkey,
        envConfig.prefix,
      );
    } else {
      const baselinePath = options["resource-baseline"];
      if (typeof baselinePath !== "string" || baselinePath.trim() === "") {
        throw new Error("首次 Windows 资源差分发布需要 --resource-baseline 指定完整过渡版基线");
      }
      unchangedBridgeComponents = await verifyResourceBridgeBaseline(
        path.resolve(baselinePath),
        remoteLatest,
        version,
        resourcePubkey,
        envConfig.prefix,
        config,
      );
    }
    changedResourceObjects = collectChangedRuntimeResourceObjects(
      release.manifest,
      REPO_ROOT,
      previousManifest,
      unchangedBridgeComponents,
    );
    console.log(
      `[tos-publish] Windows 资源清单含 ${collectRuntimeResourceObjects(release.manifest, REPO_ROOT).length} 个去重对象；本版需上传 ${changedResourceObjects.length} 个变化对象`,
    );
  }
  if (previous.sameVersion) {
    writeLatestJson({
      "bundle-dir": bundlePath,
      "base-url": publicBase,
      out,
      version,
      notes: typeof options.notes === "string" ? options.notes : "",
      platform: typeof options.platform === "string" ? options.platform : undefined,
      resourceManifest,
      macDeltaManifest,
      "pub-date": previous.pubDate,
    });
  }
  const uploads = collectPublishFilePaths(bundlePath);
  const expectedNames = new Set(
    Object.values(written.manifest.platforms).flatMap(({ url }) => {
      const fileName = decodeURIComponent(new URL(url).pathname.split("/").at(-1) ?? "");
      return [fileName, `${fileName}.sig`];
    }),
  );
  for (const filePath of uploads) {
    const fileName = path.basename(filePath);
    if (
      fileName !== "latest.json" &&
      fileName !== "install-macos.sh" &&
      !expectedNames.has(fileName)
    ) {
      throw new Error(`暂存目录含非本频道产物：${filePath}`);
    }
  }
  if (!uploads.includes(out) && existsSync(out)) uploads.push(out);
  uploads.sort((left, right) => {
    const leftManifest = path.basename(left).toLowerCase() === "latest.json" ? 1 : 0;
    const rightManifest = path.basename(right).toLowerCase() === "latest.json" ? 1 : 0;
    return leftManifest - rightManifest;
  });
  /** @type {string[]} */
  const uploadedKeys = [];
  if (release) {
    await runWithConcurrency(changedResourceObjects, 8, async (object) => {
      const objectKey = tosUpdatesObjectKey(object.sha256, `${envConfig.prefix}/resources/objects`);
      if (await putImmutableFile(config, objectKey, object.sourcePath, object.sha256))
        uploadedKeys.push(objectKey);
    });
    const manifestKey = tosUpdatesObjectKey(
      "manifest.json",
      `${envConfig.prefix}/resources/${version}/windows-x86_64`,
    );
    if (await putImmutableFile(config, manifestKey, resourceManifestPath))
      uploadedKeys.push(manifestKey);
    if (await putImmutableFile(config, `${manifestKey}.sig`, `${resourceManifestPath}.sig`))
      uploadedKeys.push(`${manifestKey}.sig`);
  }
  if (macDeltaRelease) {
    await runWithConcurrency(macDeltaRelease.objects, 2, async (object) => {
      const objectKey = tosUpdatesObjectKey(object.sha256, `${envConfig.prefix}/mac-delta/objects`);
      if (await putImmutableFile(config, objectKey, object.sourcePath, object.sha256)) {
        uploadedKeys.push(objectKey);
      }
    });
    const manifestKey = tosUpdatesObjectKey(
      "manifest.json",
      `${envConfig.prefix}/mac-delta/${version}/darwin-aarch64`,
    );
    if (await putImmutableFile(config, manifestKey, macDeltaManifestPath)) {
      uploadedKeys.push(manifestKey);
    }
    if (await putImmutableFile(config, `${manifestKey}.sig`, `${macDeltaManifestPath}.sig`)) {
      uploadedKeys.push(`${manifestKey}.sig`);
    }
  }
  for (const filePath of offlineFiles) {
    const fileName = path.basename(filePath);
    const objectKey = tosUpdatesObjectKey(fileName, `${envConfig.prefix}/offline/${version}`);
    if (await putImmutableFile(config, objectKey, filePath)) uploadedKeys.push(objectKey);
  }
  for (const filePath of uploads) {
    const fileName = path.basename(filePath);
    const objectKey = tosUpdatesObjectKey(fileName, config.prefix);
    if (fileName === "latest.json") {
      if (!previous.sameVersion) {
        await putPublicObjectFromFile(config, objectKey, filePath, fileName);
        uploadedKeys.push(objectKey);
      }
    } else if (await putImmutableFile(config, objectKey, filePath)) {
      uploadedKeys.push(objectKey);
    }
  }
  return {
    latestJsonUrl: tosUpdatesLatestJsonUrl({
      bucket: config.bucket,
      endpoint: config.endpoint,
      prefix: config.prefix,
    }),
    uploadedKeys,
    version: written.manifest.version,
  };
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed["retire-legacy"] === true) {
    const retired = await retireLegacyFeed(parsed);
    console.log(`[tos-publish] 已停用旧共享频道 ${retired.key}；备份 ${retired.backupFile}`);
    return;
  }
  assertRetiredSharedChannelWrite(parsed);
  const envConfig = readTosPublishEnv();
  const secretKey = await findWorkingSecretKey(envConfig);
  const config = { ...envConfig, secretKey };
  if (parsed.probe === true) {
    const probed = await probePublicPrefix(config);
    console.log(`[tos-publish] 匿名读探测成功 ${probed.publicUrl}`);
    return;
  }
  const result = await publishUpdaterArtifacts(parsed);
  console.log(`[tos-publish] 已发布 ${result.uploadedKeys.length} 个对象`);
  console.log(`[tos-publish] latest.json ${result.latestJsonUrl}`);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  try {
    await main();
  } catch (error) {
    console.error(`[tos-publish] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
