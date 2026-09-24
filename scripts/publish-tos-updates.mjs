// 把 updater 产物和 latest.json 发到火山引擎 TOS 公开前缀。
// 凭据只从环境变量读：TOS_ACCESS_KEY / TOS_SECRET_KEY。不要写进仓库。
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import https from "node:https";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
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

const PROBE_FILE = ".public-probe.txt";
const PUT_EXPIRES_SECS = 3600;
export const TOS_FETCH_MAX_ATTEMPTS = 5;
/** 单次 PUT 会被 TOS 408 掐掉（约 700MB 安装包）。大于该体积改走分片。 */
export const TOS_MULTIPART_THRESHOLD_BYTES = 32 * 1024 * 1024;
export const TOS_MULTIPART_PART_SIZE_BYTES = 32 * 1024 * 1024;
export const TOS_MULTIPART_CONCURRENCY = 3;

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
  return /headers timeout|body timeout|connect timeout|und_err_|econnreset|etimedout|enotfound|eai_again|econnrefused|socket hang up|fetch failed|other side closed|network socket/.test(
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
 * 不设 req.setTimeout：上传期间套接字一直在写，空闲超时会误伤。
 *
 * @param {{
 *   url: string,
 *   method: string,
 *   headers: Record<string, string>,
 *   body?: Buffer | string | null,
 * }} request
 * @returns {Promise<{ status: number, text: string, url: string }>}
 */
export function performTosHttpRequest(request) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(request.url);
    const req = https.request(
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
        res.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on("end", () => {
          const etagHeader = res.headers.etag;
          resolve({
            status: res.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf8"),
            url: request.url,
            etag: Array.isArray(etagHeader) ? etagHeader[0] : etagHeader,
            headers: res.headers,
          });
        });
      },
    );
    req.on("error", reject);
    if (request.body == null) {
      req.end();
      return;
    }
    req.end(request.body);
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
    // 不上传 .dmg：海外 CI 传到 tos-cn-beijing 约 700MB×2 会超过 Codemagic 时限，
    // 自动更新只用 .app.tar.gz。首次安装脚本仍随包发布。
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

function readMultipartProgress(filePath, objectKey, size) {
  const progressPath = multipartProgressPath(filePath);
  if (!existsSync(progressPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(progressPath, "utf8"));
    if (
      parsed &&
      parsed.objectKey === objectKey &&
      parsed.size === size &&
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
  let progress = readMultipartProgress(filePath, objectKey, size);
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

async function putImmutableFile(config, objectKey, filePath) {
  const size = statSync(filePath).size;
  const digest = await sha256File(filePath);
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
    JSON.stringify(existing.platforms) !== JSON.stringify(proposed.platforms)
  ) {
    throw new Error(`频道 ${proposed.version} 已发布不同产物，拒绝同版覆盖`);
  }
  return { sameVersion: true, pubDate: existing.pub_date };
}

export function checkLegacyPlatformFeeds(version, platforms, feeds) {
  for (const platform of ["windows-x86_64", "darwin-aarch64"]) {
    const feed = feeds[platform];
    if (
      feed?.version !== version ||
      feed.platforms?.[platform]?.signature !== platforms[platform]?.signature
    ) {
      throw new Error(`旧版频道发布前必须初始化同版 ${platform} 平台频道`);
    }
  }
  if (artifactName(feeds["windows-x86_64"].platforms["windows-x86_64"].url).includes("-slim-")) {
    throw new Error("旧版频道发布前 Windows 平台频道必须指向完整包");
  }
}

export function collectLegacyChannelPlatforms(version, feeds, publicBase) {
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
        ? `无限画布_${version}_x64-setup.exe`
        : `无限画布_${version}_aarch64-full.app.tar.gz`;
    if (fileName !== expectedName) {
      throw new Error(`旧版频道只能引用本版完整 ${platform} 更新包`);
    }
    const expectedUrl = `${publicBase}/${platform}/${encodeURIComponent(fileName)}`;
    if (entry.url !== expectedUrl) {
      throw new Error(`旧版频道 ${platform} 的下载地址不在预期 TOS 前缀`);
    }
    platforms[platform] = { url: entry.url, signature: entry.signature };
  }
  return platforms;
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

export async function promoteLegacyFromPlatformFeeds(options = {}) {
  const version = typeof options.version === "string" ? options.version : readAppVersion();
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
  const platforms = collectLegacyChannelPlatforms(version, feeds, publicBase);
  checkLegacyPlatformFeeds(version, platforms, feeds);
  for (const [platform, entry] of Object.entries(platforms)) {
    const fileName = artifactName(entry.url);
    const objectKey = tosUpdatesObjectKey(fileName, `${config.prefix}/${platform}`);
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
    const signature = await getAnonymousObject(config, `${objectKey}.sig`);
    if (signature.status !== 200 || signature.text.trim() !== entry.signature.trim()) {
      throw new Error(`旧版频道发布前 ${platform} 更新签名不匹配`);
    }
  }
  const manifest = buildLatestManifest({
    version,
    notes: typeof options.notes === "string" ? options.notes : "",
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

export async function publishUpdaterArtifacts(options) {
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
  const secretKey = await findWorkingSecretKey(envConfig);
  const config = { ...envConfig, secretKey, prefix };
  const fullBundleDir = options["full-bundle-dir"];
  const offlineFiles =
    typeof fullBundleDir === "string" && fullBundleDir.trim() !== ""
      ? collectFullOfflineFiles(path.resolve(fullBundleDir), version)
      : [];
  if (channel.startsWith("windows-") && offlineFiles.length === 0) {
    throw new Error("平台瘦包发布需要 --full-bundle-dir 提供同版完整离线安装包");
  }
  const publicBase = tosUpdatesPublicBaseUrl({
    bucket: config.bucket,
    endpoint: config.endpoint,
    prefix: config.prefix,
  });
  const out = path.join(bundlePath, "latest.json");
  const written = writeLatestJson({
    "bundle-dir": bundlePath,
    "base-url": publicBase,
    out,
    version,
    notes: typeof options.notes === "string" ? options.notes : "",
    platform: typeof options.platform === "string" ? options.platform : undefined,
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
  if (previous.sameVersion) {
    writeLatestJson({
      "bundle-dir": bundlePath,
      "base-url": publicBase,
      out,
      version,
      notes: typeof options.notes === "string" ? options.notes : "",
      platform: typeof options.platform === "string" ? options.platform : undefined,
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
  if (parsed["promote-legacy"] === true) {
    const result = await promoteLegacyFromPlatformFeeds(parsed);
    console.log(`[tos-publish] 已发布 ${result.uploadedKeys.length} 个对象`);
    console.log(`[tos-publish] latest.json ${result.latestJsonUrl}`);
    return;
  }
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
