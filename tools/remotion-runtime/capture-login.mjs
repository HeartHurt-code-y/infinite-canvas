import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

// 登录捕获：下载遇到登录/验证墙时，弹出「可见」的系统 Chromium 系浏览器，
// 用户在窗口里完成登录或站点验证；脚本轮询该站点的 Cookie，满足完成条件后
// 把结果写到 stdout 并自动关闭浏览器。站点、Cookie 允许域与登录标记固定在
// 本脚本内；URL 与 profileDir 走 stdin，绝不进入 argv 或日志。
//
// 输入（stdin JSON，≤64KB）：{"url":"https://...","profileDir":"<绝对路径>"}
// 输出（stdout 单行 JSON）：
//   {"ok":true,"reason":"login_marker|stable|browser_closed|timeout","cookies":[...]}
//   {"ok":false,"code":"...","detail":"<可选，首行异常摘要>"}（并置 exitCode=1）

const MAX_STDIN_BYTES = 64 * 1024;
const MAX_COOKIES = 64;
const POLL_INTERVAL_MS = 2000;
const LOGIN_SETTLE_MS = 3000;
const ANONYMOUS_STABLE_MS = 25000;
const STABLE_POLLS = 3;
const TOTAL_TIMEOUT_MS = 330000;

const SITES = {
  douyin: {
    urlApexes: ["douyin.com", "iesdouyin.com"],
    cookieApexes: ["douyin.com", "iesdouyin.com"],
    loginMarkers: ["sessionid", "sessionid_ss"],
  },
  rednote: {
    urlApexes: ["xiaohongshu.com"],
    cookieApexes: ["xiaohongshu.com"],
    loginMarkers: ["web_session"],
  },
  bilibili: {
    urlApexes: ["bilibili.com", "b23.tv"],
    cookieApexes: ["bilibili.com"],
    loginMarkers: ["sessdata", "bili_jct"],
  },
};

const COOKIE_KEYS = new Set([
  "name", "value", "domain", "path", "secure", "httpOnly", "sameSite", "expires",
]);
const COOKIE_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

class ResolverError extends Error {
  constructor(code, detail) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

/** 错误首行截断成可展示的 detail；不含 Cookie 数据，只来自启动/运行异常。 */
export function summarizeErrorDetail(error) {
  if (!error) return undefined;
  const firstLine = String(error.message ?? error)
    .split("\n", 1)[0]
    .trim();
  if (!firstLine) return undefined;
  return firstLine.length > 200 ? firstLine.slice(0, 200) : firstLine;
}

function hostMatchesApex(host, apexes) {
  return apexes.some((apex) => host === apex || host.endsWith(`.${apex}`));
}

export function siteForHost(host) {
  const value = String(host ?? "").toLowerCase();
  for (const [key, site] of Object.entries(SITES)) {
    if (hostMatchesApex(value, site.urlApexes)) return key;
  }
  return null;
}

export function matchesCookieApex(domain, site) {
  const host = String(domain ?? "").toLowerCase().replace(/^\./, "");
  return Boolean(host) && hostMatchesApex(host, SITES[site].cookieApexes);
}

export function parseLoginRequest(value) {
  let request;
  try {
    request = JSON.parse(value);
  } catch {
    throw new ResolverError("invalid_input");
  }
  if (
    !request ||
    typeof request !== "object" ||
    Array.isArray(request) ||
    Object.keys(request).some((key) => !["url", "profileDir"].includes(key)) ||
    typeof request.url !== "string" ||
    typeof request.profileDir !== "string" ||
    request.url.length > 2048 ||
    request.url !== request.url.trim() ||
    /[\r\n]/.test(request.url) ||
    /[\x00-\x1f\x7f]/.test(request.profileDir) ||
    request.profileDir.length > 400 ||
    !path.isAbsolute(request.profileDir)
  ) {
    throw new ResolverError("invalid_input");
  }
  let url;
  try {
    url = new URL(request.url);
  } catch {
    throw new ResolverError("invalid_input");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443")
  ) {
    throw new ResolverError("unsupported_url");
  }
  const site = siteForHost(url.hostname);
  if (!site) throw new ResolverError("unsupported_url");
  url.hash = "";
  return { url: url.href, profileDir: request.profileDir, site };
}

/** 只保留目标站点的 Cookie；字段校验失败的逐条丢弃而不是整体失败。 */
export function filterSiteCookies(rawCookies, site) {
  if (!Array.isArray(rawCookies)) return [];
  const cookies = [];
  for (const cookie of rawCookies) {
    if (cookies.length >= MAX_COOKIES) break;
    if (
      !cookie ||
      typeof cookie !== "object" ||
      Array.isArray(cookie) ||
      Object.keys(cookie).some((key) => !COOKIE_KEYS.has(key)) ||
      typeof cookie.name !== "string" ||
      !COOKIE_NAME.test(cookie.name) ||
      Buffer.byteLength(cookie.name) > 256 ||
      typeof cookie.value !== "string" ||
      Buffer.byteLength(cookie.value) > 4096 ||
      /[\x00-\x1f\x7f]/.test(cookie.value) ||
      typeof cookie.domain !== "string" ||
      cookie.domain.length > 128 ||
      !matchesCookieApex(cookie.domain, site) ||
      !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/.test(cookie.domain.toLowerCase().replace(/^\./, ""))
    ) {
      continue;
    }
    const cookiePath = cookie.path ?? "/";
    if (
      typeof cookiePath !== "string" ||
      !cookiePath.startsWith("/") ||
      cookiePath.length > 256 ||
      /[\x00-\x1f\x7f]/.test(cookiePath)
    ) {
      continue;
    }
    if (
      (cookie.secure !== undefined && typeof cookie.secure !== "boolean") ||
      (cookie.httpOnly !== undefined && typeof cookie.httpOnly !== "boolean") ||
      (cookie.sameSite !== undefined &&
        !["Strict", "Lax", "None"].includes(cookie.sameSite)) ||
      (cookie.expires !== undefined &&
        (!Number.isInteger(cookie.expires) ||
          cookie.expires < -1 ||
          cookie.expires > 4102444800))
    ) {
      continue;
    }
    cookies.push({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain.toLowerCase(),
      path: cookiePath,
      ...(cookie.secure === undefined ? {} : { secure: cookie.secure }),
      ...(cookie.httpOnly === undefined ? {} : { httpOnly: cookie.httpOnly }),
      ...(cookie.sameSite === undefined ? {} : { sameSite: cookie.sameSite }),
      ...(cookie.expires === undefined ? {} : { expires: cookie.expires }),
    });
  }
  return cookies;
}

function hasMarker(cookies, markers) {
  const names = new Set(cookies.map((cookie) => cookie.name.toLowerCase()));
  return markers.some((marker) => names.has(marker));
}

function cookieSignature(cookies) {
  return cookies
    .map((cookie) => `${cookie.name}=${cookie.value.length}`)
    .sort()
    .join("|");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 弹出可见浏览器并轮询 Cookie。完成条件（按优先级）：
 * 1. 登录标记出现（等 3 秒稳定后抓取）；
 * 2. 匿名会话 Cookie 已出现至少 25 秒且连续 3 轮无变化（用户可能只是
 *    通过了验证而没有账号）；
 * 3. 用户直接关闭浏览器窗口；
 * 4. 总超时（约 5.5 分钟，留出 Rust 侧外层超时的余量）。
 * 3/4 时只要已有站点 Cookie 就照常交付，交由真实下载验证是否足够。
 */
export async function captureWithBrowser(request, executablePath) {
  if (
    typeof executablePath !== "string" ||
    !path.isAbsolute(executablePath)
  ) {
    throw new ResolverError("browser_unavailable");
  }
  let context;
  try {
    context = await chromium.launchPersistentContext(request.profileDir, {
      executablePath,
      headless: false,
      viewport: null,
      timeout: 30000,
      args: [
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-session-crashed-bubble",
        "--hide-crash-restore-bubble",
      ],
    });
  } catch (error) {
    throw new ResolverError("browser_unavailable", summarizeErrorDetail(error));
  }
  const site = SITES[request.site];
  let lastSiteCookies = [];
  let finished = null;
  let disconnected = false;
  context.on("disconnected", () => {
    disconnected = true;
  });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    // 打开原始视频页：站点验证与二维码登录都发生在这一页上。
    await page
      .goto(request.url, { waitUntil: "domcontentloaded", timeout: 45000 })
      .catch(() => {});
    const deadline = Date.now() + TOTAL_TIMEOUT_MS;
    let firstSiteCookieAt = null;
    let stablePolls = 0;
    let lastSignature = "";
    while (Date.now() < deadline && !disconnected) {
      let all = [];
      try {
        all = await context.cookies();
      } catch {
        break;
      }
      const siteCookies = filterSiteCookies(all, request.site);
      if (siteCookies.length) {
        lastSiteCookies = siteCookies;
        if (hasMarker(siteCookies, site.loginMarkers)) {
          await sleep(LOGIN_SETTLE_MS).catch(() => {});
          try {
            const settled = filterSiteCookies(await context.cookies(), request.site);
            if (settled.length) lastSiteCookies = settled;
          } catch {
            /* 浏览器已关闭：沿用最后一次快照。 */
          }
          finished = "login_marker";
          break;
        }
        const now = Date.now();
        firstSiteCookieAt ??= now;
        const signature = cookieSignature(siteCookies);
        stablePolls = signature === lastSignature ? stablePolls + 1 : 0;
        lastSignature = signature;
        if (
          now - firstSiteCookieAt >= ANONYMOUS_STABLE_MS &&
          stablePolls >= STABLE_POLLS
        ) {
          finished = "stable";
          break;
        }
      } else {
        firstSiteCookieAt = null;
        stablePolls = 0;
        lastSignature = "";
        lastSiteCookies = [];
      }
      await sleep(POLL_INTERVAL_MS);
    }
  } finally {
    await context.close().catch(() => {});
  }
  if (!lastSiteCookies.length) {
    // 窗口被提前关闭与等满超时是两种不同的失败，分开上报便于给用户提示。
    throw new ResolverError(
      disconnected ? "browser_closed" : finished ? "unexpected_state" : "login_timeout",
    );
  }
  return {
    reason: finished ?? (disconnected ? "browser_closed" : "timeout"),
    cookies: lastSiteCookies,
  };
}

export function browserCandidates() {
  if (process.platform === "win32") {
    const roots = [
      process.env.ProgramFiles,
      process.env["ProgramFiles(x86)"],
      process.env.LocalAppData,
    ].filter(Boolean);
    return roots.flatMap((root) =>
      [
        "Microsoft/Edge/Application/msedge.exe",
        "Google/Chrome/Application/chrome.exe",
        "BraveSoftware/Brave-Browser/Application/brave.exe",
        "Chromium/Application/chrome.exe",
      ].map((relative) => path.join(root, ...relative.split("/"))),
    );
  }
  if (process.platform === "darwin") {
    return [
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
  }
  const directories = (process.env.PATH ?? "").split(":").filter(Boolean);
  const names = [
    "msedge",
    "microsoft-edge",
    "microsoft-edge-stable",
    "google-chrome",
    "google-chrome-stable",
    "brave-browser",
    "brave",
    "chromium",
    "chromium-browser",
  ];
  return [
    ...directories.flatMap((directory) =>
      names.map((name) => path.join(directory, name)),
    ),
    "/opt/google/chrome/chrome",
    "/opt/microsoft/msedge/msedge",
  ];
}

async function readInputRequest() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_STDIN_BYTES) throw new ResolverError("invalid_input");
    chunks.push(chunk);
  }
  return parseLoginRequest(Buffer.concat(chunks).toString("utf8").trim());
}

async function main() {
  try {
    const request = await readInputRequest();
    const executablePath = browserCandidates().find((candidate) => {
      try {
        return existsSync(candidate);
      } catch {
        return false;
      }
    });
    if (!executablePath) throw new ResolverError("browser_unavailable");
    const data = await captureWithBrowser(request, executablePath);
    process.stdout.write(`${JSON.stringify({ ok: true, ...data })}\n`);
  } catch (error) {
    // ResolverError 的 message 就是 code，detail 只认构造时显式携带的；
    // 其余异常才从 message 摘要，避免 detail 与 code 重复。
    const code = error instanceof ResolverError ? error.code : "unexpected_error";
    const detail =
      error instanceof ResolverError ? error.detail : summarizeErrorDetail(error);
    process.stdout.write(`${JSON.stringify({ ok: false, code, detail })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
