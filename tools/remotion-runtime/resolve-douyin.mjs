import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const DETAIL_PATH = "/aweme/v1/web/aweme/detail/";
const VIDEO_ID = "[0-9]{12,22}";
const DIRECT_VIDEO = new RegExp(`^/video/(${VIDEO_ID})/?$`);
const JINGXUAN_VIDEO = new RegExp(`^/m/video/(${VIDEO_ID})/?$`);
const IESDOUYIN_VIDEO = new RegExp(`^/share/video/(${VIDEO_ID})/?$`);
const MAX_STDIN_BYTES = 64 * 1024;
const COOKIE_APEXES = ["douyin.com", "iesdouyin.com"];
const COOKIE_KEYS = new Set([
  "name", "value", "domain", "path", "secure", "httpOnly", "sameSite", "expires",
]);
const COOKIE_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

class ResolverError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function trustedInputUrl(value) {
  if (typeof value !== "string" || value.length > 4096 ||
      value !== value.trim() || /[\r\n]/.test(value)) throw new ResolverError("invalid_input");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ResolverError("invalid_input");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443")
  ) {
    throw new ResolverError("unsupported_url");
  }
  url.protocol = "https:";
  url.hash = "";
  return url;
}

export function parseDouyinInput(value) {
  const url = trustedInputUrl(value);
  const host = url.hostname.toLowerCase();
  if (host === "v.douyin.com") {
    if (!/^\/[A-Za-z0-9_-]{3,80}\/?$/.test(url.pathname))
      throw new ResolverError("unsupported_url");
    return { kind: "short", url: url.href };
  }
  const direct =
    host === "douyin.com" || host === "www.douyin.com"
      ? DIRECT_VIDEO.exec(url.pathname)
      : host === "jingxuan.douyin.com"
        ? JINGXUAN_VIDEO.exec(url.pathname)
        : host === "iesdouyin.com" || host === "www.iesdouyin.com"
          ? IESDOUYIN_VIDEO.exec(url.pathname)
          : null;
  if (!direct) throw new ResolverError("unsupported_url");
  return { kind: "direct", id: direct[1] };
}

function scopedCookies(value) {
  if (!Array.isArray(value) || value.length > 64) throw new ResolverError("invalid_cookies");
  return value.map((cookie) => {
    if (!cookie || typeof cookie !== "object" || Array.isArray(cookie) ||
        Object.keys(cookie).some((key) => !COOKIE_KEYS.has(key)) ||
        typeof cookie.name !== "string" || !COOKIE_NAME.test(cookie.name) ||
        Buffer.byteLength(cookie.name) > 256 ||
        typeof cookie.value !== "string" || Buffer.byteLength(cookie.value) > 4096 ||
        /[\x00-\x1f\x7f]/.test(cookie.value) ||
        typeof cookie.domain !== "string" || cookie.domain.length > 128) {
      throw new ResolverError("invalid_cookies");
    }
    const domain = cookie.domain.toLowerCase();
    const host = domain.replace(/^\./, "");
    if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/.test(host) ||
        !COOKIE_APEXES.some((apex) => host === apex || host.endsWith(`.${apex}`))) {
      throw new ResolverError("invalid_cookies");
    }
    const path = cookie.path ?? "/";
    if (typeof path !== "string" || !path.startsWith("/") || path.length > 256 ||
        /[\x00-\x1f\x7f]/.test(path)) throw new ResolverError("invalid_cookies");
    if ((cookie.secure !== undefined && typeof cookie.secure !== "boolean") ||
        (cookie.httpOnly !== undefined && typeof cookie.httpOnly !== "boolean") ||
        (cookie.sameSite !== undefined && !["Strict", "Lax", "None"].includes(cookie.sameSite)) ||
        (cookie.expires !== undefined && (!Number.isInteger(cookie.expires) ||
          cookie.expires < -1 || cookie.expires > 4102444800)) ||
        (cookie.sameSite === "None" && cookie.secure !== true)) {
      throw new ResolverError("invalid_cookies");
    }
    return {
      name: cookie.name,
      value: cookie.value,
      domain,
      path,
      ...(cookie.secure === undefined ? {} : { secure: cookie.secure }),
      ...(cookie.httpOnly === undefined ? {} : { httpOnly: cookie.httpOnly }),
      ...(cookie.sameSite === undefined ? {} : { sameSite: cookie.sameSite }),
      ...(cookie.expires === undefined ? {} : { expires: cookie.expires }),
    };
  });
}

export function parseDouyinRequest(value) {
  if (typeof value !== "string" || value.length === 0 || /[\r\n]/.test(value))
    throw new ResolverError("invalid_input");
  if (!value.startsWith("{")) {
    if (value.length > 2048) throw new ResolverError("invalid_input");
    parseDouyinInput(value);
    return { url: value, cookies: [] };
  }
  let request;
  try {
    request = JSON.parse(value);
  } catch {
    throw new ResolverError("invalid_input");
  }
  if (!request || typeof request !== "object" || Array.isArray(request) ||
      Object.keys(request).some((key) => !["url", "cookies"].includes(key)) ||
      typeof request.url !== "string" || request.url.length > 2048 ||
      request.url !== request.url.trim()) throw new ResolverError("invalid_input");
  parseDouyinInput(request.url);
  return { url: request.url, cookies: scopedCookies(request.cookies ?? []) };
}

function idFromFinalBrowserUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.hostname === "www.douyin.com" || url.hostname === "douyin.com")
    return DIRECT_VIDEO.exec(url.pathname)?.[1] ?? null;
  if (url.hostname === "jingxuan.douyin.com")
    return JINGXUAN_VIDEO.exec(url.pathname)?.[1] ?? null;
  return null;
}

function isAllowedNavigation(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      [
        "v.douyin.com",
        "www.douyin.com",
        "douyin.com",
        "jingxuan.douyin.com",
        "www.iesdouyin.com",
        "iesdouyin.com",
      ].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

export function isAllowedMediaUrl(value) {
  if (typeof value !== "string" || value.length > 4096) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === "443") &&
      (url.hostname === "douyinvod.com" || url.hostname.endsWith(".douyinvod.com"))
    );
  } catch {
    return false;
  }
}

export function selectH264MediaUrls(awemeDetail, expectedId) {
  if (awemeDetail?.aweme_id !== expectedId) throw new ResolverError("id_mismatch");
  const video = awemeDetail.video;
  if (!video || !Number.isSafeInteger(video.duration) || video.duration <= 0)
    throw new ResolverError("media_unavailable");
  const groups = [video.play_addr_h264];
  if (Array.isArray(video.bit_rate)) {
    for (const rate of video.bit_rate) {
      if ((rate?.is_h265 === false || rate?.is_h265 === 0) && rate.play_addr)
        groups.push(rate.play_addr);
    }
  }
  const mediaUrls = [];
  const seen = new Set();
  for (const group of groups) {
    for (const value of group?.url_list ?? []) {
      if (!isAllowedMediaUrl(value) || seen.has(value)) continue;
      seen.add(value);
      mediaUrls.push(value);
      if (mediaUrls.length === 4) break;
    }
    if (mediaUrls.length === 4) break;
  }
  if (!mediaUrls.length) throw new ResolverError("media_unavailable");
  return { videoId: expectedId, durationMs: video.duration, mediaUrls };
}

async function resolveWithBrowser(request, executablePath) {
  const parsed = parseDouyinInput(request.url);
  if (typeof executablePath !== "string" || !path.isAbsolute(executablePath))
    throw new ResolverError("browser_unavailable");
  let browser;
  try {
    browser = await chromium.launch({ executablePath, headless: true, timeout: 20000 });
  } catch {
    throw new ResolverError("browser_unavailable");
  }
  try {
    const context = await browser.newContext();
    if (request.cookies.length) {
      try {
        await context.addCookies(request.cookies);
      } catch {
        throw new ResolverError("invalid_cookies");
      }
    }
    const page = await context.newPage();
    await page.route("**/*", (route) => {
      const request = route.request();
      if (
        request.isNavigationRequest() &&
        request.frame() === page.mainFrame() &&
        !isAllowedNavigation(request.url())
      ) {
        return route.abort();
      }
      return route.continue();
    });
    let expectedId = parsed.id;
    if (parsed.kind === "short") {
      try {
        await page.goto(parsed.url, { waitUntil: "domcontentloaded", timeout: 20000 });
      } catch {
        throw new ResolverError("short_link_unresolved");
      }
      expectedId = idFromFinalBrowserUrl(page.url());
      if (!expectedId) throw new ResolverError("short_link_unresolved");
    }
    let resolveDetail;
    const detailPromise = new Promise((resolve) => {
      resolveDetail = resolve;
    });
    async function onResponse(response) {
      let responseUrl;
      try {
        responseUrl = new URL(response.url());
      } catch {
        return;
      }
      if (
        responseUrl.protocol !== "https:" ||
        responseUrl.hostname !== "www.douyin.com" ||
        responseUrl.pathname !== DETAIL_PATH ||
        response.status() !== 200
      )
        return;
      try {
        const body = await response.json();
        if (body?.aweme_detail?.aweme_id !== expectedId) return;
        resolveDetail(body.aweme_detail);
      } catch {
        // An empty response is common when site verification fails; keep waiting.
      }
    }
    page.on("response", onResponse);
    let timer;
    try {
      try {
        await page.goto(`https://jingxuan.douyin.com/m/video/${expectedId}`, {
          waitUntil: "domcontentloaded",
          timeout: 25000,
        });
      } catch {
        throw new ResolverError("detail_unavailable");
      }
      if (idFromFinalBrowserUrl(page.url()) !== expectedId)
        throw new ResolverError("id_mismatch");
      const detail = await Promise.race([
        detailPromise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new ResolverError("detail_unavailable")), 35000);
        }),
      ]);
      return selectH264MediaUrls(detail, expectedId);
    } finally {
      clearTimeout(timer);
      page.off("response", onResponse);
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

async function readInputRequest() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_STDIN_BYTES) throw new ResolverError("invalid_input");
    chunks.push(chunk);
  }
  const value = Buffer.concat(chunks).toString("utf8").trim();
  return parseDouyinRequest(value);
}

async function main() {
  try {
    const data = await resolveWithBrowser(await readInputRequest(), process.argv[2]);
    process.stdout.write(`${JSON.stringify({ ok: true, ...data })}\n`);
  } catch (error) {
    const code = error instanceof ResolverError ? error.code : "unexpected_error";
    process.stdout.write(`${JSON.stringify({ ok: false, code })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
