import { isDesktopRuntime } from "./ipc";

/**
 * 外链收口：应用外壳（Tauri 主窗口）绝不允许被站外页面原地接管。
 *
 * 背景：Tauri 主窗口没有浏览器地址栏和返回键，webview 里一个普通的
 * `<a href="https://…">` 点击就是原地导航——整窗被外站顶掉后用户只能杀进程。
 * 因此所有离开应用来源的链接必须改走系统浏览器：
 * - 桌面端经 opener 插件（desktopActions.openExternalUrl）；
 * - 浏览器预览退回 `window.open(_blank, noopener)`。
 *
 * 两道前端防线 + 一道 Rust 防线（见 src-tauri lib.rs 的 on_navigation）：
 * 1. `installExternalLinkGuard` 在 document 捕获阶段拦下全应用所有链接点击；
 * 2. MarkdownView 渲染外链时自带 target/rel/onClick，父级 stopPropagation 也兜得住；
 * 3. Rust 拦截一切漏网的站内 webview 导航，改用系统浏览器打开。
 */

const EXTERNAL_PROTOCOLS = new Set(["http:", "https:"]);

/** `[文本](douyin.com)` 这类裸域名按 Markdown 规范是相对链接，会原地导航到 404；升级成 https。 */
const BARE_DOMAIN_URL = /^([a-z0-9][a-z0-9-]*\.)+[a-z]{2,}([/?#].*)?$/i;

/**
 * 规范化 Markdown 里出现的链接：裸域名升级为 https，其余原样返回。
 * 返回 null 表示没有可用的链接地址。
 */
export function resolveMarkdownLinkHref(href: string | null | undefined): string | null {
  const trimmed = href?.trim();
  if (!trimmed) return null;
  if (BARE_DOMAIN_URL.test(trimmed)) return `https://${trimmed}`;
  return trimmed;
}

/** 是否为离开应用来源的 http(s) 链接（相对与同源链接交给应用自身处理）。 */
export function isExternalHttpUrl(href: string, base: string = window.location.href): boolean {
  try {
    const url = new URL(href, base);
    return EXTERNAL_PROTOCOLS.has(url.protocol) && url.origin !== new URL(base).origin;
  } catch {
    return false;
  }
}

/** 用系统浏览器打开链接；浏览器预览环境退回新窗口。失败时再退一次 window.open。 */
export async function openExternalLink(url: string): Promise<void> {
  const openInNewWindow = () => window.open(url, "_blank", "noopener,noreferrer");
  if (!isDesktopRuntime()) {
    openInNewWindow();
    return;
  }
  try {
    const { openExternalUrl } = await import("../features/workspace/desktopActions");
    await openExternalUrl(url);
  } catch {
    openInNewWindow();
  }
}

/**
 * 在捕获阶段拦截全应用的站外链接点击（含中键）。挂在 document 上意味着
 * 任何组件里的链接（含 React portal）都先经过这里，组件自身的
 * stopPropagation 无法绕过。返回卸载函数。
 */
export function installExternalLinkGuard(target: Document = document): () => void {
  const handle = (event: MouseEvent) => {
    if (event.defaultPrevented) return;
    if (event.type === "auxclick" && event.button !== 1) return;
    const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!anchor) return;
    const href = resolveMarkdownLinkHref(anchor.getAttribute("href"));
    if (!href || !isExternalHttpUrl(href)) return;
    event.preventDefault();
    void openExternalLink(new URL(href, window.location.href).href);
  };
  target.addEventListener("click", handle, true);
  target.addEventListener("auxclick", handle, true);
  return () => {
    target.removeEventListener("click", handle, true);
    target.removeEventListener("auxclick", handle, true);
  };
}
