import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { MarkdownView } from "./MarkdownView";

/**
 * 外链是 MarkdownView 最危险的能力：Tauri 主窗口没有返回键，站外链接一旦
 * 原地导航就会把整个应用顶掉。这里钉住三件事——外链交给系统浏览器、
 * 裸域名升级为 https、与全局守卫互不重复打开。
 */

const externalUrl = "https://www.douyin.com/video/123";
let openSpy: MockInstance<typeof window.open>;

beforeEach(() => {
  openSpy = vi.spyOn(window, "open").mockReturnValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

function queryLink(content: string) {
  render(<MarkdownView content={content} />);
  return document.querySelector(".markdown-view a");
}

describe("MarkdownView 外链", () => {
  it("站外链接渲染为 target=_blank + noopener noreferrer", () => {
    const anchor = queryLink(`看这个[视频](${externalUrl})。`);
    expect(anchor).toHaveAttribute("href", externalUrl);
    expect(anchor).toHaveAttribute("target", "_blank");
    expect(anchor).toHaveAttribute("rel", expect.stringContaining("noopener"));
    expect(anchor).toHaveAttribute("rel", expect.stringContaining("noreferrer"));
  });

  it("裸域名升级为 https 后仍按外链处理", () => {
    const anchor = queryLink("[官网](douyin.com)");
    expect(anchor).toHaveAttribute("href", "https://douyin.com");
    expect(anchor).toHaveAttribute("target", "_blank");
  });

  it("同源与锚点链接保持普通行为", () => {
    const anchor = queryLink("[设置](/settings) 和 [回到顶部](#top)");
    expect(anchor).toHaveAttribute("href", "/settings");
    expect(anchor).not.toHaveAttribute("target");
  });

  it("点击外链取消原地导航并交给系统浏览器", () => {
    const anchor = queryLink(`[视频](${externalUrl})`)!;
    const event = fireEvent.click(anchor);
    expect(event).toBe(false);
    expect(openSpy).toHaveBeenCalledWith(externalUrl, "_blank", "noopener,noreferrer");
  });

  it("全局守卫已 preventDefault 时不再重复打开", () => {
    render(<MarkdownView content={`[视频](${externalUrl})`} />);
    const capture = (event: Event) => event.preventDefault();
    document.addEventListener("click", capture, true);
    try {
      fireEvent.click(screen.getByRole("link", { name: "视频" }));
      expect(openSpy).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("click", capture, true);
    }
  });
});
