// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkForAppUpdate,
  describeUpdateError,
  dismissAvailableAppUpdate,
  downloadPercent,
  formatByteSize,
  formatDownloadProgress,
  getAppUpdateState,
  installAvailableAppUpdate,
  loadCurrentAppVersion,
  relaunchAfterAppUpdate,
  resetAppUpdateStateForTests,
  setAppUpdateClientForTests,
  shouldShowUpdateBanner,
  SKIPPED_UPDATE_STORAGE_KEY,
  type AppUpdateClient,
  type AppUpdateProgressEvent,
} from "./appUpdate";

function mockClient(overrides: Partial<AppUpdateClient> = {}): AppUpdateClient {
  return {
    getCurrentVersion: vi.fn(() => Promise.resolve("0.1.1")),
    check: vi.fn(() => Promise.resolve({ available: false })),
    relaunch: vi.fn(() => Promise.resolve()),
    needsManualRelaunch: vi.fn(() => Promise.resolve(true)),
    ...overrides,
  };
}

function completeDownload(
  onProgress: (event: AppUpdateProgressEvent) => void,
  totalBytes = 100,
): Promise<void> {
  onProgress({ event: "Started", data: { contentLength: totalBytes } });
  onProgress({ event: "Progress", data: { chunkLength: 40 } });
  onProgress({ event: "Progress", data: { chunkLength: totalBytes - 40 } });
  onProgress({ event: "Finished" });
  return Promise.resolve();
}

afterEach(() => {
  resetAppUpdateStateForTests();
  setAppUpdateClientForTests(null);
  window.localStorage.removeItem(SKIPPED_UPDATE_STORAGE_KEY);
});

describe("appUpdate helpers", () => {
  it("formats download sizes in binary units", () => {
    expect(formatByteSize(0)).toBe("0 B");
    expect(formatByteSize(512)).toBe("512 B");
    expect(formatByteSize(1024)).toBe("1.0 KB");
    expect(formatByteSize(1536)).toBe("1.5 KB");
    expect(formatByteSize(10 * 1024)).toBe("10 KB");
    expect(formatByteSize(1024 * 1024)).toBe("1.0 MB");
  });

  it("renders progress even when the server omits a total size", () => {
    expect(formatDownloadProgress(2048, 0)).toBe("2.0 KB");
    expect(formatDownloadProgress(512, 1024)).toBe("512 B / 1.0 KB");
    expect(downloadPercent(25, 100)).toBe(25);
    expect(downloadPercent(10, 0)).toBe(0);
  });

  it("only nags about a skipped version before the user starts downloading", () => {
    expect(
      shouldShowUpdateBanner(
        {
          status: "available",
          currentVersion: "0.1.1",
          availableVersion: "0.1.2",
          notes: null,
          downloadedBytes: 0,
          totalBytes: 0,
          error: null,
        },
        "0.1.2",
      ),
    ).toBe(false);
    expect(
      shouldShowUpdateBanner(
        {
          status: "downloading",
          currentVersion: "0.1.1",
          availableVersion: "0.1.2",
          notes: null,
          downloadedBytes: 10,
          totalBytes: 20,
          error: null,
        },
        "0.1.2",
      ),
    ).toBe(true);
  });

  it("turns updater transport failures into operator-facing Chinese", () => {
    expect(describeUpdateError(new Error("NOT_DESKTOP"))).toMatch(/已安装的桌面应用/);
    expect(describeUpdateError(new Error("Could not fetch a valid response json"))).toMatch(/TOS/);
    expect(describeUpdateError(new Error("signature verification failed"))).toMatch(/校验失败/);
  });
});

describe("appUpdate store", () => {
  it("loads the current version and reports that the install is up to date", async () => {
    const client = mockClient();
    setAppUpdateClientForTests(client);

    await expect(loadCurrentAppVersion()).resolves.toBe("0.1.1");
    await checkForAppUpdate();

    expect(getAppUpdateState()).toMatchObject({
      status: "current",
      currentVersion: "0.1.1",
      availableVersion: null,
    });
  });

  it("downloads an available update then relaunches", async () => {
    const downloadAndInstall = vi.fn((onProgress: (event: AppUpdateProgressEvent) => void) =>
      completeDownload(onProgress),
    );
    const relaunch = vi.fn(() => Promise.resolve());
    setAppUpdateClientForTests(
      mockClient({
        check: vi.fn(() =>
          Promise.resolve({
            available: true,
            version: "0.1.2",
            notes: "修复升级",
            downloadAndInstall,
          }),
        ),
        relaunch,
      }),
    );

    await checkForAppUpdate();
    expect(getAppUpdateState()).toMatchObject({
      status: "available",
      availableVersion: "0.1.2",
      notes: "修复升级",
    });

    await installAvailableAppUpdate();
    expect(downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(getAppUpdateState()).toMatchObject({
      status: "ready",
      downloadedBytes: 100,
      totalBytes: 100,
    });

    await relaunchAfterAppUpdate();
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it("lets the Windows installer restart the app without a second relaunch", async () => {
    setAppUpdateClientForTests(
      mockClient({
        check: vi.fn(() =>
          Promise.resolve({
            available: true,
            version: "0.1.2",
            downloadAndInstall: vi.fn(() => Promise.resolve()),
          }),
        ),
        needsManualRelaunch: vi.fn(() => Promise.resolve(false)),
      }),
    );

    await checkForAppUpdate();
    await installAvailableAppUpdate();
    expect(getAppUpdateState().status).toBe("restarting");
  });

  it("remembers a skipped version so the banner can stay quiet", async () => {
    setAppUpdateClientForTests(
      mockClient({
        check: vi.fn(() =>
          Promise.resolve({
            available: true,
            version: "0.2.0",
            downloadAndInstall: vi.fn(() => Promise.resolve()),
          }),
        ),
      }),
    );

    await checkForAppUpdate();
    dismissAvailableAppUpdate();

    expect(window.localStorage.getItem(SKIPPED_UPDATE_STORAGE_KEY)).toBe("0.2.0");
    expect(
      shouldShowUpdateBanner({
        ...getAppUpdateState(),
        status: "available",
        availableVersion: "0.2.0",
      }),
    ).toBe(false);
  });

  it("does not surface a quiet startup check failure as a blocking error", async () => {
    setAppUpdateClientForTests(
      mockClient({
        check: vi.fn(() => Promise.reject(new Error("Could not fetch a valid response json"))),
      }),
    );

    await checkForAppUpdate({ quiet: true });
    expect(getAppUpdateState()).toMatchObject({ status: "idle", error: null });
  });
});
