// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  installExternalLinkGuard,
  isExternalHttpUrl,
  openExternalLink,
  resolveMarkdownLinkHref,
} from "./externalLinks";

const isDesktopRuntimeMock = vi.hoisted(() => vi.fn<() => boolean>(() => false));

vi.mock("./ipc", () => ({ isDesktopRuntime: isDesktopRuntimeMock }));
vi.mock("../features/workspace/desktopActions", () => ({
  openExternalUrl: vi.fn().mockResolvedValue(undefined),
}));

import { openExternalUrl } from "../features/workspace/desktopActions";

/** jsdom 的 location 源（同源判定基准）。 */
const ORIGIN = window.location.origin;
const externalUrl = "https://www.douyin.com/video/123";
let openSpy: MockInstance<typeof window.open>;

function clickAnchor(href: string, type: "click" | "auxclick" = "click", button = 0): MouseEvent {
  const anchor = document.createElement("a");
  anchor.setAttribute("href", href);
  anchor.textContent = "链接";
  document.body.append(anchor);
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button });
  anchor.dispatchEvent(event);
  anchor.remove();
  return event;
}

beforeEach(() => {
  isDesktopRuntimeMock.mockReturnValue(false);
  vi.mocked(openExternalUrl).mockClear();
  openSpy = vi.spyOn(window, "open").mockReturnValue(null);
});

describe("resolveMarkdownLinkHref", () => {
  it("把裸域名升级为 https，避免被当成站内相对链接原地导航", () => {
    expect(resolveMarkdownLinkHref("douyin.com")).toBe("https://douyin.com");
    expect(resolveMarkdownLinkHref("www.douyin.com/video?x=1")).toBe(
      "https://www.douyin.com/video?x=1",
    );
  });

  it("保留带协议地址、相对路径、锚点，空白与空值返回 null", () => {
    expect(resolveMarkdownLinkHref("https://a.example.com/x")).toBe("https://a.example.com/x");
    expect(resolveMarkdownLinkHref("/settings")).toBe("/settings");
    expect(resolveMarkdownLinkHref("#top")).toBe("#top");
    expect(resolveMarkdownLinkHref("  https://a.example.com  ")).toBe("https://a.example.com");
    expect(resolveMarkdownLinkHref("")).toBeNull();
    expect(resolveMarkdownLinkHref(null)).toBeNull();
  });
});

describe("isExternalHttpUrl", () => {
  it("站外 http(s) 为真，同源/相对/非 http 协议为假", () => {
    expect(isExternalHttpUrl(externalUrl)).toBe(true);
    expect(isExternalHttpUrl(`${ORIGIN}/workspace`)).toBe(false);
    expect(isExternalHttpUrl("/workspace")).toBe(false);
    expect(isExternalHttpUrl("#top")).toBe(false);
    expect(isExternalHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isExternalHttpUrl("douyin.com")).toBe(false);
  });
});

describe("openExternalLink", () => {
  it("浏览器预览里退回 window.open 新窗口", async () => {
    await openExternalLink(externalUrl);
    expect(openSpy).toHaveBeenCalledWith(externalUrl, "_blank", "noopener,noreferrer");
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it("桌面端走系统浏览器 opener", async () => {
    isDesktopRuntimeMock.mockReturnValue(true);
    await openExternalLink(externalUrl);
    expect(openExternalUrl).toHaveBeenCalledWith(externalUrl);
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("桌面端 opener 失败时回退 window.open，而不是让点击无声失效", async () => {
    isDesktopRuntimeMock.mockReturnValue(true);
    vi.mocked(openExternalUrl).mockRejectedValueOnce(new Error("opener unavailable"));
    await openExternalLink(externalUrl);
    expect(openSpy).toHaveBeenCalledWith(externalUrl, "_blank", "noopener,noreferrer");
  });
});

describe("installExternalLinkGuard", () => {
  let uninstall: (() => void) | null = null;

  afterEach(() => {
    uninstall?.();
    uninstall = null;
  });

  it("拦截站外链接点击：取消原地导航并改用系统浏览器", () => {
    uninstall = installExternalLinkGuard();
    const event = clickAnchor(externalUrl);
    expect(event.defaultPrevented).toBe(true);
    expect(openSpy).toHaveBeenCalledWith(externalUrl, "_blank", "noopener,noreferrer");
  });

  it("裸域名 href 同样拦截并升级为 https", () => {
    uninstall = installExternalLinkGuard();
    const event = clickAnchor("douyin.com");
    expect(event.defaultPrevented).toBe(true);
    expect(openSpy).toHaveBeenCalledWith("https://douyin.com/", "_blank", "noopener,noreferrer");
  });

  it("放行同源、相对与锚点链接", () => {
    uninstall = installExternalLinkGuard();
    for (const href of [`${ORIGIN}/workspace`, "/settings", "#top"]) {
      expect(clickAnchor(href).defaultPrevented).toBe(false);
    }
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("中键 auxclick 拦截、右键 auxclick 不劫持", () => {
    uninstall = installExternalLinkGuard();
    expect(clickAnchor(externalUrl, "auxclick", 1).defaultPrevented).toBe(true);
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(clickAnchor(externalUrl, "auxclick", 2).defaultPrevented).toBe(false);
  });

  it("尊重已被前置处理的 defaultPrevented 事件", () => {
    uninstall = installExternalLinkGuard();
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    // 派发前即已 preventDefault：守卫必须早退，不得再次打开。
    event.preventDefault();
    const anchor = document.createElement("a");
    anchor.setAttribute("href", externalUrl);
    document.body.append(anchor);
    anchor.dispatchEvent(event);
    anchor.remove();
    expect(event.defaultPrevented).toBe(true);
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("返回卸载函数，卸载后不再拦截", () => {
    uninstall = installExternalLinkGuard();
    uninstall?.();
    uninstall = null;
    const event = clickAnchor(externalUrl);
    expect(event.defaultPrevented).toBe(false);
    expect(openSpy).not.toHaveBeenCalled();
  });
});
