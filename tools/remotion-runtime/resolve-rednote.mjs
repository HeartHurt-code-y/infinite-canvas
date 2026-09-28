// Read a Xiaohongshu note through its official Xiaohongshu/RedNote web pages.
// Input: one share URL or a scoped-cookie JSON envelope on stdin.
// Output: exactly one JSON line on stdout.
// The caller must treat mediaUrls as private signed URLs and must validate each
// one again before download. This script never reads a user's browser profile.

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const MAX_INPUT = 2048;
const MAX_STDIN_BYTES = 64 * 1024;
const MAX_OUTPUT = 16 * 1024;
const NOTE_ID = /^[0-9a-f]{24}$/i;
const SHORT_PATH = /^\/(?:o|a|m)\/[A-Za-z0-9]{4,64}$/i;
const NOTE_PATH = /^\/(?:explore|discovery\/item)\/([0-9a-f]{24})$/i;
const NOTE_HOSTS = new Set([
  "xiaohongshu.com",
  "www.xiaohongshu.com",
  "rednote.com",
  "www.rednote.com",
]);
const SHORT_HOSTS = new Set([
  "xhslink.com",
  "www.xhslink.com",
  "xhslink.cn",
  "www.xhslink.cn",
]);
const COOKIE_APEXES = ["xiaohongshu.com", "rednote.com"];
const COOKIE_KEYS = new Set([
  "name", "value", "domain", "path", "secure", "httpOnly", "sameSite", "expires",
]);
const COOKIE_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

class InputError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

function output(value) {
  const json = JSON.stringify(value);
  process.stdout.write((json.length <= MAX_OUTPUT ? json : '{"ok":false,"reason":"output_too_large"}') + "\n");
}

function checkedUrl(raw, allowedHosts) {
  if (typeof raw !== "string" || raw !== raw.trim() || /[\r\n]/.test(raw)) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !allowedHosts.has(url.hostname.toLowerCase()) ||
    url.username ||
    url.password ||
    url.port
  ) {
    return null;
  }
  url.protocol = "https:";
  url.hash = "";
  return url;
}

function noteUrl(raw) {
  const url = checkedUrl(raw, NOTE_HOSTS);
  if (!url) return null;
  const match = NOTE_PATH.exec(url.pathname);
  return match && NOTE_ID.test(match[1]) ? { url, noteId: match[1].toLowerCase() } : null;
}

function parseShareInput(raw) {
  const direct = noteUrl(raw);
  if (direct) return direct;
  const short = checkedUrl(raw, SHORT_HOSTS);
  if (!short || !SHORT_PATH.test(short.pathname)) return null;
  return { shortUrl: short };
}

function scopedCookies(value) {
  if (!Array.isArray(value) || value.length > 64) throw new InputError("invalid_cookies");
  return value.map((cookie) => {
    if (!cookie || typeof cookie !== "object" || Array.isArray(cookie) ||
        Object.keys(cookie).some((key) => !COOKIE_KEYS.has(key)) ||
        typeof cookie.name !== "string" || !COOKIE_NAME.test(cookie.name) ||
        Buffer.byteLength(cookie.name) > 256 ||
        typeof cookie.value !== "string" || Buffer.byteLength(cookie.value) > 4096 ||
        /[\x00-\x1f\x7f]/.test(cookie.value) ||
        typeof cookie.domain !== "string" || cookie.domain.length > 128) {
      throw new InputError("invalid_cookies");
    }
    const domain = cookie.domain.toLowerCase();
    const host = domain.replace(/^\./, "");
    if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/.test(host) ||
        !COOKIE_APEXES.some((apex) => host === apex || host.endsWith(`.${apex}`))) {
      throw new InputError("invalid_cookies");
    }
    const cookiePath = cookie.path ?? "/";
    if (typeof cookiePath !== "string" || !cookiePath.startsWith("/") ||
        cookiePath.length > 256 || /[\x00-\x1f\x7f]/.test(cookiePath)) {
      throw new InputError("invalid_cookies");
    }
    if ((cookie.secure !== undefined && typeof cookie.secure !== "boolean") ||
        (cookie.httpOnly !== undefined && typeof cookie.httpOnly !== "boolean") ||
        (cookie.sameSite !== undefined && !["Strict", "Lax", "None"].includes(cookie.sameSite)) ||
        (cookie.expires !== undefined && (!Number.isInteger(cookie.expires) ||
          cookie.expires < -1 || cookie.expires > 4102444800)) ||
        (cookie.sameSite === "None" && cookie.secure !== true)) {
      throw new InputError("invalid_cookies");
    }
    return {
      name: cookie.name,
      value: cookie.value,
      domain,
      path: cookiePath,
      ...(cookie.secure === undefined ? {} : { secure: cookie.secure }),
      ...(cookie.httpOnly === undefined ? {} : { httpOnly: cookie.httpOnly }),
      ...(cookie.sameSite === undefined ? {} : { sameSite: cookie.sameSite }),
      ...(cookie.expires === undefined ? {} : { expires: cookie.expires }),
    };
  });
}

export function parseRednoteRequest(value) {
  if (typeof value !== "string" || !value || /[\r\n]/.test(value))
    throw new InputError("invalid_input");
  if (!value.startsWith("{")) {
    if (value.length > MAX_INPUT) throw new InputError("invalid_input");
    return { url: value, cookies: [] };
  }
  let request;
  try {
    request = JSON.parse(value);
  } catch {
    throw new InputError("invalid_input");
  }
  if (!request || typeof request !== "object" || Array.isArray(request) ||
      Object.keys(request).some((key) => !["url", "cookies"].includes(key)) ||
      typeof request.url !== "string" || request.url.length > MAX_INPUT ||
      request.url !== request.url.trim()) throw new InputError("invalid_input");
  return { url: request.url, cookies: scopedCookies(request.cookies ?? []) };
}

export function selectSiteCookies(cookies, apex) {
  return cookies.filter((cookie) => {
    const domain = cookie.domain.replace(/^\./, "");
    return domain === apex || domain.endsWith(`.${apex}`);
  });
}

async function addSiteCookies(context, cookies) {
  if (!cookies.length) return;
  try {
    await context.addCookies(cookies);
  } catch {
    throw new InputError("invalid_cookies");
  }
}

function allowedShareNavigation(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" &&
      (SHORT_HOSTS.has(url.hostname) || NOTE_HOSTS.has(url.hostname));
  } catch {
    return false;
  }
}

async function resolveShortWithBrowser(shortUrl, browser, cookies, apex) {
  const context = await browser.newContext();
  try {
    await addSiteCookies(context, selectSiteCookies(cookies, apex));
    const page = await context.newPage();
    let redirected = null;
    page.on("response", (response) => {
      try {
        if (![301, 302, 303, 307, 308].includes(response.status()) ||
            !SHORT_HOSTS.has(new URL(response.url()).hostname)) return;
        const location = response.headers().location;
        if (location) redirected = noteUrl(new URL(location, response.url()).href) ?? redirected;
      } catch {
        // Ignore a malformed redirect rather than exposing its address.
      }
    });
    await page.route("**/*", (route) => {
      const request = route.request();
      if (request.isNavigationRequest() && request.frame() === page.mainFrame() &&
          !allowedShareNavigation(request.url())) return route.abort();
      return route.continue();
    });
    try {
      await page.goto(shortUrl.href, { waitUntil: "domcontentloaded", timeout: 15000 });
    } catch {
      // The redirect itself can still identify the note when a login page fails.
    }
    return noteUrl(page.url()) ?? redirected;
  } finally {
    await context.close().catch(() => {});
  }
}

function checkedMediaUrl(raw) {
  if (typeof raw !== "string") return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !(host.endsWith(".xhscdn.com") || host.endsWith(".rednotecdn.com")) ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  ) {
    return null;
  }
  url.protocol = "https:";
  return url.href;
}

async function readInput() {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > MAX_STDIN_BYTES) throw new InputError("invalid_input");
    chunks.push(chunk);
  }
  const value = Buffer.concat(chunks).toString("utf8").trim();
  return parseRednoteRequest(value);
}

async function readOfficialNote(browser, targetUrl, expectedId, cookies, apex) {
  const allowedHosts = new Set([apex, `www.${apex}`]);
  const context = await browser.newContext();
  try {
    await addSiteCookies(context, selectSiteCookies(cookies, apex));
    const page = await context.newPage();
    await page.route("**/*", (route) => {
      const request = route.request();
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        let original;
        try {
          original = new URL(request.url());
        } catch {
          return route.abort();
        }
        const destination = checkedUrl(request.url(), allowedHosts);
        if (!destination || original.protocol !== "https:") return route.abort();
      }
      return route.continue();
    });
    let response;
    try {
      response = await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
    } catch {
      return { ok: false, reason: "note_page_unavailable" };
    }
    const finalRaw = new URL(page.url());
    const finalUrl = noteUrl(page.url());
    if (!response || response.status() !== 200 || !finalUrl ||
        finalRaw.protocol !== "https:" || !allowedHosts.has(finalRaw.hostname) ||
        finalUrl.noteId !== expectedId) return { ok: false, reason: "note_page_unavailable" };
    if (apex === "xiaohongshu.com") {
      await page.waitForFunction((id) => Boolean(
        window.__INITIAL_STATE__?.note?.noteDetailMap?.[id]?.note,
      ), expectedId, { timeout: 5000 }).catch(() => {});
    }
    const data = await page.evaluate((expectedId) => {
      const state = window.__INITIAL_STATE__;
      const note = state?.note?.noteDetailMap?.[expectedId]?.note;
      if (!note || note.noteId !== expectedId || note.type !== "video") {
        return { noteType: note?.type ?? null, candidates: [] };
      }
      const streams = note.video?.media?.stream?.h264;
      if (!Array.isArray(streams)) return { noteType: "video", candidates: [] };
      const candidates = streams
        .filter((entry) => entry && typeof entry === "object")
        .map((entry) => ({
          height: Number(entry.height) || 0,
          size: Number(entry.size) || 0,
          urls: [entry.masterUrl, ...(Array.isArray(entry.backupUrls) ? entry.backupUrls : [])],
        }))
        .sort((a, b) => b.height - a.height || b.size - a.size)
        .flatMap((entry) => entry.urls)
        .slice(0, 16);
      return { noteType: "video", candidates };
    }, expectedId);
    if (data.noteType && data.noteType !== "video") return { ok: false, reason: "not_video" };
    const mediaUrls = [...new Set(data.candidates.map(checkedMediaUrl).filter(Boolean))].slice(0, 8);
    if (mediaUrls.length === 0) return { ok: false, reason: "no_video_stream" };
    return { ok: true, noteId: expectedId, mediaUrls };
  } finally {
    await context.close().catch(() => {});
  }
}

async function main() {
  const chromePath = process.argv[2];
  if (!chromePath || !path.isAbsolute(chromePath) || !existsSync(chromePath))
    return { ok: false, reason: "browser_unavailable" };
  const request = await readInput();
  const parsed = parseShareInput(request.url);
  if (!parsed) return { ok: false, reason: "invalid_share_link" };
  let browser;
  try {
    browser = await chromium.launch({ executablePath: chromePath, headless: true, timeout: 20000 });
    let shared = parsed;
    if (parsed.shortUrl) {
      shared = await resolveShortWithBrowser(
        parsed.shortUrl, browser, request.cookies, "xiaohongshu.com",
      );
      if (!shared && selectSiteCookies(request.cookies, "rednote.com").length) {
        shared = await resolveShortWithBrowser(
          parsed.shortUrl, browser, request.cookies, "rednote.com",
        );
      }
    }
    if (!shared) return { ok: false, reason: "invalid_share_link" };
    const xhsCookies = selectSiteCookies(request.cookies, "xiaohongshu.com");
    if (shared.url.hostname.endsWith("xiaohongshu.com") && xhsCookies.length) {
      const original = await readOfficialNote(
        browser, shared.url.href, shared.noteId, xhsCookies, "xiaohongshu.com",
      );
      if (original.ok || original.reason === "not_video") return original;
    }
    const rednoteUrl = new URL(shared.url.href);
    rednoteUrl.hostname = "www.rednote.com";
    rednoteUrl.protocol = "https:";
    return await readOfficialNote(browser, rednoteUrl.href, shared.noteId,
      request.cookies, "rednote.com");
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    output(await main());
  } catch (error) {
    output({ ok: false, reason: error instanceof InputError ? error.reason : "resolve_failed" });
  }
}
