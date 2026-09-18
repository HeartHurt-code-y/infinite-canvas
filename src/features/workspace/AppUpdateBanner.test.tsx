import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkForAppUpdate,
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

  it("offers an in-place update without asking the user to reinstall", async () => {
    setAppUpdateClientForTests(
      mockClient({
        check: vi.fn(() =>
          Promise.resolve({
            available: true,
            version: "0.1.3",
            downloadAndInstall: vi.fn(() => Promise.resolve()),
          }),
        ),
      }),
    );
    render(<AppUpdateBanner />);
    await checkForAppUpdate();

    expect(screen.getByText("发现新版本 0.1.3")).toBeInTheDocument();
    expect(screen.getByText("直接升级，不必卸载重装。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "立即更新" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "稍后" }));
    expect(screen.queryByText("发现新版本 0.1.3")).not.toBeInTheDocument();
  });
});
