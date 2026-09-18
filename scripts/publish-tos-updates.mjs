// 把 updater 产物和 latest.json 发到火山引擎 TOS 公开前缀。
// 凭据只从环境变量读：TOS_ACCESS_KEY / TOS_SECRET_KEY。不要写进仓库。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import https from "node:https";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  collectUpdaterPlatforms,
  DEFAULT_BUNDLE_DIR,
  listFilesRecursive,
  parseArgs,
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
          resolve({
            status: res.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf8"),
            url: request.url,
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
  for (const filePath of files) {
    const fileName = path.basename(filePath);
    const lower = fileName.toLowerCase();
    if (lower === "latest.json") {
      selected.push(filePath);
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
    if (lower.endsWith(".dmg") || lower === "install-macos.sh") {
      selected.push(filePath);
    }
  }
  return selected;
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
      return await send({
        url,
        method: options.method,
        headers: extraHeaders,
        body: options.body ?? null,
      });
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

export async function putPublicObject(config, objectKey, body, fileName) {
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
    },
    body,
  });
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`上传 ${objectKey} 失败：HTTP ${result.status} ${result.text.slice(0, 300)}`);
  }
  return result;
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

async function downloadExistingLatestJson(config) {
  const result = await getAnonymousObject(
    config,
    tosUpdatesObjectKey("latest.json", config.prefix),
  );
  if (result.status === 200 && result.text.trim() !== "") {
    return JSON.parse(result.text);
  }
  return {};
}

export async function publishUpdaterArtifacts(options) {
  const envConfig = readTosPublishEnv(options.env ?? process.env);
  const secretKey = await findWorkingSecretKey(envConfig);
  const config = { ...envConfig, secretKey };
  const bundleDir =
    typeof options["bundle-dir"] === "string" ? options["bundle-dir"] : DEFAULT_BUNDLE_DIR;
  const publicBase = tosUpdatesPublicBaseUrl({
    bucket: config.bucket,
    endpoint: config.endpoint,
    prefix: config.prefix,
  });
  const existing = await downloadExistingLatestJson(config);
  const out = path.join(bundleDir, "latest.json");
  if (existing.platforms) {
    writeFileSync(out, `${JSON.stringify(existing, null, 2)}\n`);
  }
  const incoming = collectUpdaterPlatforms(bundleDir, {
    baseUrl: publicBase,
    fallbackPlatform: typeof options.platform === "string" ? options.platform : undefined,
  });
  if (Object.keys(incoming).length === 0) {
    throw new Error(`在 ${bundleDir} 里没有找到 updater 产物`);
  }
  const written = writeLatestJson({
    "bundle-dir": bundleDir,
    "base-url": publicBase,
    out,
    version: typeof options.version === "string" ? options.version : undefined,
    notes: typeof options.notes === "string" ? options.notes : "",
    platform: typeof options.platform === "string" ? options.platform : undefined,
  });
  const uploads = collectPublishFilePaths(bundleDir);
  if (!uploads.includes(out) && existsSync(out)) uploads.push(out);
  /** @type {string[]} */
  const uploadedKeys = [];
  for (const filePath of uploads) {
    const fileName = path.basename(filePath);
    const objectKey = tosUpdatesObjectKey(fileName, config.prefix);
    await putPublicObject(config, objectKey, readFileSync(filePath), fileName);
    uploadedKeys.push(objectKey);
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
