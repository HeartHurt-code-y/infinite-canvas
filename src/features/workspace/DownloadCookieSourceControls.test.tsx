import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { VideoDownloaderEngineStatus } from "../../lib/backend";
import { DownloadCookieSourceControls } from "./DownloadCookieSourceControls";

const engine: VideoDownloaderEngineStatus = {
  state: "ready",
  version: "2026.09.27",
  binaryPath: "C:/app/yt-dlp.exe",
  cookieBrowser: null,
  cookiesInstalled: false,
  bilibiliLoggedIn: false,
  lastError: null,
};

describe("DownloadCookieSourceControls", () => {
  it("offers automatic fallback without treating a successful preflight as a downloaded video or login", () => {
    const onSelectBrowser = vi.fn();
    const { rerender } = render(
      <DownloadCookieSourceControls
        status={engine}
        onSelectBrowser={onSelectBrowser}
        onImportCookies={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByRole("combobox", { name: "下载 Cookies 来源" }), {
      target: { value: "auto" },
    });
    expect(onSelectBrowser).toHaveBeenCalledWith("auto");
    rerender(
      <DownloadCookieSourceControls
        status={{ ...engine, cookieBrowser: "auto", cookiesInstalled: true }}
        onSelectBrowser={onSelectBrowser}
        onImportCookies={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("已导入文件可用于站点解析和后备");
    expect(screen.getByText(/浏览器加密或占用导致读取失败时会尝试下一来源/)).toBeInTheDocument();
    expect(screen.getByText(/预检通过不代表视频已下载，也不代表账号已登录/)).toBeInTheDocument();
    expect(screen.getByText(/只有真实视频文件下载完成才算成功/)).toBeInTheDocument();
  });

  it("selects a browser while making download-time verification explicit", () => {
    const onSelectBrowser = vi.fn();
    render(
      <DownloadCookieSourceControls
        status={{ ...engine, cookieBrowser: "chrome" }}
        onSelectBrowser={onSelectBrowser}
        onImportCookies={vi.fn()}
      />,
    );

    expect(screen.getByRole("combobox", { name: "下载 Cookies 来源" })).toHaveValue("chrome");
    expect(screen.getByRole("status")).toHaveTextContent("目标视频能否访问待实际下载验证");
    expect(screen.getByText(/默认或最近使用配置档的 Cookie jar/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "下载 Cookies 来源" }), {
      target: { value: "edge" },
    });
    expect(onSelectBrowser).toHaveBeenCalledWith("edge");
  });

  it("keeps manual file import available and reports its unverified state", () => {
    const onSelectBrowser = vi.fn();
    const onImportCookies = vi.fn();
    const onClearCookies = vi.fn();
    render(
      <DownloadCookieSourceControls
        status={{ ...engine, cookiesInstalled: true, bilibiliLoggedIn: true }}
        onSelectBrowser={onSelectBrowser}
        onImportCookies={onImportCookies}
        onClearCookies={onClearCookies}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("目标视频能否访问待实际下载验证");
    fireEvent.click(screen.getByRole("button", { name: "导入 Cookies 文件" }));
    fireEvent.click(screen.getByRole("button", { name: "清除文件" }));
    expect(onImportCookies).toHaveBeenCalledOnce();
    expect(onClearCookies).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByRole("combobox", { name: "下载 Cookies 来源" }), {
      target: { value: "" },
    });
    expect(onSelectBrowser).toHaveBeenCalledWith(null);
  });

  it("prevents changing the source or importing a file while an operation is running", () => {
    render(
      <DownloadCookieSourceControls
        status={engine}
        busy
        onSelectBrowser={vi.fn()}
        onImportCookies={vi.fn()}
      />,
    );

    expect(screen.getByRole("combobox", { name: "下载 Cookies 来源" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "导入 Cookies 文件" })).toBeDisabled();
  });
});
