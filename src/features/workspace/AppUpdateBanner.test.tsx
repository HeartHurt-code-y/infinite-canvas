import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkForAppUpdate,
  registerAppUpdateBeforeInstallFlush,
  resetAppUpdateStateForTests,
  setAppUpdateClientForTests,
  SKIPPED_UPDATE_STORAGE_KEY,
  type AppUpdateClient,
} from "../../lib/appUpdate";
import { AppUpdateBanner } from "./AppUpdateBanner";

function mockClient(overrides: Partial<AppUpdateClient> = {}): AppUpdateClient {
  return {
    getCurrentVersion: vi.fn(() => Promise.resolve("0.1.1")),
    check: vi.fn(() => Promise.resolve({ available: false })),
    relaunch: vi.fn(() => Promise.resolve()),
    needsManualRelaunch: vi.fn(() => Promise.resolve(true)),
    ...overrides,
  };
}

beforeEach(() => {
  registerAppUpdateBeforeInstallFlush(() => Promise.resolve());
});

afterEach(() => {
  resetAppUpdateStateForTests();
  setAppUpdateClientForTests(null);
  window.localStorage.removeItem(SKIPPED_UPDATE_STORAGE_KEY);
});

describe("AppUpdateBanner", () => {
  it("stays hidden when the install is already current", async () => {
    setAppUpdateClientForTests(mockClient());
    const view = render(<AppUpdateBanner />);
    await checkForAppUpdate();
    expect(view.container).toBeEmptyDOMElement();
  });

  it("shows automatic update progress without requiring an install click", async () => {
    let finishDownload: (() => void) | undefined;
    const download = new Promise<void>((resolve) => {
      finishDownload = resolve;
    });
    setAppUpdateClientForTests(
      mockClient({
        check: vi.fn(() =>
          Promise.resolve({
            available: true,
            version: "0.1.3",
            downloadAndInstall: vi.fn(() => download),
          }),
        ),
      }),
    );
    render(<AppUpdateBanner />);
    await checkForAppUpdate();

    expect(screen.getByText("正在下载更新")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "更新下载进度" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "立即更新" })).not.toBeInTheDocument();

    finishDownload?.();
    expect(await screen.findByText("正在完成安装")).toBeInTheDocument();
  });

  it("keeps an uncertain installation failure visible without offering another install", async () => {
    const install = vi.fn(() => Promise.reject(new Error("安装前校验失败")));
    setAppUpdateClientForTests(
      mockClient({
        check: vi.fn(() =>
          Promise.resolve({
            available: true,
            version: "0.1.3",
            download: vi.fn(() => Promise.resolve()),
            install,
          }),
        ),
      }),
    );
    render(<AppUpdateBanner />);
    await checkForAppUpdate({ quiet: true });

    expect(await screen.findByText(/安装结果尚不确定/)).toBeInTheDocument();
    expect(screen.getByText("更新失败")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重启应用后检查" })).toBeEnabled();
    expect(install).toHaveBeenCalledTimes(1);
  });
});
