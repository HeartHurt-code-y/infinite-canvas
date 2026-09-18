import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as BackendModule from "../../lib/backend";
import {
  resetAppUpdateStateForTests,
  setAppUpdateClientForTests,
  SKIPPED_UPDATE_STORAGE_KEY,
  type AppUpdateClient,
  type AppUpdateProgressEvent,
} from "../../lib/appUpdate";
import { AppUpdateSettings } from "./AppUpdateSettings";

vi.mock("../../lib/backend", async (importOriginal) => {
  const actual = await importOriginal<typeof BackendModule>();
  return { ...actual, isDesktopRuntime: () => true };
});

function mockClient(overrides: Partial<AppUpdateClient> = {}): AppUpdateClient {
  return {
    getCurrentVersion: vi.fn(() => Promise.resolve("0.1.1")),
    check: vi.fn(() => Promise.resolve({ available: false })),
    relaunch: vi.fn(() => Promise.resolve()),
    needsManualRelaunch: vi.fn(() => Promise.resolve(true)),
    ...overrides,
  };
}

afterEach(() => {
  resetAppUpdateStateForTests();
  setAppUpdateClientForTests(null);
  window.localStorage.removeItem(SKIPPED_UPDATE_STORAGE_KEY);
});

describe("AppUpdateSettings", () => {
  it("shows the installed version and a check action", async () => {
    setAppUpdateClientForTests(mockClient());
    render(<AppUpdateSettings />);

    expect(await screen.findByText(/当前版本 0\.1\.1/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "检查更新" })).toBeEnabled();
  });

  it("lets the user install an available update from settings", async () => {
    const downloadAndInstall = vi.fn((onProgress: (event: AppUpdateProgressEvent) => void) => {
      onProgress({ event: "Started", data: { contentLength: 50 } });
      onProgress({ event: "Progress", data: { chunkLength: 50 } });
      onProgress({ event: "Finished" });
      return Promise.resolve();
    });
    setAppUpdateClientForTests(
      mockClient({
        check: vi.fn(() =>
          Promise.resolve({
            available: true,
            version: "0.1.2",
            notes: "升级说明",
            downloadAndInstall,
          }),
        ),
      }),
    );
    render(<AppUpdateSettings />);
    await screen.findByText(/当前版本 0\.1\.1/);

    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
    expect(await screen.findByText(/可升级到 0\.1\.2/)).toBeInTheDocument();
    expect(screen.getByText("升级说明")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "立即更新" }));
    expect(await screen.findByRole("button", { name: "立即重启以完成更新" })).toBeEnabled();
    expect(downloadAndInstall).toHaveBeenCalledTimes(1);
  });
});
