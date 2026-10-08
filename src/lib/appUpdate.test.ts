// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  APP_UPDATE_CHECK_INTERVAL_MS,
  APP_UPDATE_FOCUS_THROTTLE_MS,
  checkForAppUpdate,
  createDesktopAppUpdateClient,
  describeUpdateError,
  dismissAvailableAppUpdate,
  downloadPercent,
  formatByteSize,
  formatDownloadProgress,
  getAppUpdateState,
  installAvailableAppUpdate,
  loadCurrentAppVersion,
  readResourceUpdateManifest,
  registerAppUpdateBeforeInstallFlush,
  relaunchAfterAppUpdate,
  resetAppUpdateStateForTests,
  setAppUpdateClientForTests,
  shouldShowUpdateBanner,
  SKIPPED_UPDATE_STORAGE_KEY,
  startAutomaticAppUpdateChecks,
  type AppUpdateClient,
  type AppUpdateProgressEvent,
  type PrepareRuntimeResourcesRequest,
  type RuntimeComponentMigrationStatus,
  windowsUpdatePackageKind,
} from "./appUpdate";

const desktopMocks = vi.hoisted(() => ({
  check: vi.fn(),
  invoke: vi.fn(),
  getVersion: vi.fn(() => Promise.resolve("0.2.0")),
  relaunch: vi.fn(() => Promise.resolve()),
}));

vi.mock("@tauri-apps/plugin-updater", () => ({ check: desktopMocks.check }));
vi.mock("@tauri-apps/plugin-os", () => ({
  type: () => "windows",
  arch: () => "x86_64",
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: desktopMocks.invoke }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: desktopMocks.getVersion }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: desktopMocks.relaunch }));

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

beforeEach(() => {
  registerAppUpdateBeforeInstallFlush(() => Promise.resolve());
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  desktopMocks.check.mockReset();
  desktopMocks.invoke.mockReset();
  desktopMocks.getVersion.mockClear();
  desktopMocks.relaunch.mockClear();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
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
          preparedBytes: 0,
          totalPreparationBytes: 0,
          reusedResourceBytes: 0,
          downloadedResourceBytes: 0,
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
          preparedBytes: 0,
          totalPreparationBytes: 0,
          reusedResourceBytes: 0,
          downloadedResourceBytes: 0,
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
    expect(describeUpdateError(new Error("本地运行组件准备失败：风格库资源不完整"))).toMatch(
      /完整安装包修复/,
    );
  });

  it("identifies the selected Windows installer from the updater platform URL", () => {
    const platform = (url: string) => ({
      platforms: { "windows-x86_64": { url } },
    });
    expect(
      windowsUpdatePackageKind(
        platform("https://updates.example/无限画布_0.1.9_x64-slim-setup.exe?download=1"),
        "windows-x86_64",
      ),
    ).toBe("slim");
    expect(
      windowsUpdatePackageKind(
        platform("https://updates.example/无限画布_0.1.9_x64-setup.exe"),
        "windows-x86_64",
      ),
    ).toBe("full");
    expect(() =>
      windowsUpdatePackageKind(
        { platforms: { "windows-aarch64": { url: "https://updates.example/a-slim-setup.exe" } } },
        "windows-x86_64",
      ),
    ).toThrow(/无法识别 Windows 更新包类型/);
    expect(() =>
      windowsUpdatePackageKind(platform("https://updates.example/update.zip"), "windows-x86_64"),
    ).toThrow(/无法识别 Windows 更新包类型/);
  });

  it("accepts only HTTPS resource manifests with a signature", () => {
    expect(
      readResourceUpdateManifest({
        resourceManifest: {
          url: "https://updates.example/resources/manifest.json",
          signature: "sig",
        },
      }),
    ).toEqual({ url: "https://updates.example/resources/manifest.json", signature: "sig" });
    expect(readResourceUpdateManifest({})).toBeNull();
    expect(() =>
      readResourceUpdateManifest({
        resourceManifest: { url: "http://updates.example/manifest.json", signature: "sig" },
      }),
    ).toThrow(/补丁地址无效/);
    expect(() =>
      readResourceUpdateManifest({
        resourceManifest: { url: "https://updates.example/manifest.json", signature: "" },
      }),
    ).toThrow(/补丁信息无效/);
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

  it("automatically downloads an available update and relaunches", async () => {
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
    await vi.waitFor(() => expect(getAppUpdateState().status).toBe("restarting"));
    expect(downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(getAppUpdateState()).toMatchObject({
      status: "restarting",
      availableVersion: "0.1.2",
      notes: "修复升级",
      downloadedBytes: 100,
      totalBytes: 100,
    });
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it("quietly downloads changed resources, installs, and lets Windows restart the app", async () => {
    const order: string[] = [];
    const prepareRuntimeComponents = vi.fn(() => {
      order.push("resources");
      return Promise.resolve();
    });
    const download = vi.fn(async (onProgress: (event: AppUpdateProgressEvent) => void) => {
      order.push("download");
      await completeDownload(onProgress);
    });
    const install = vi.fn(() => {
      order.push("install");
      return Promise.resolve();
    });
    const relaunch = vi.fn(() => Promise.resolve());
    setAppUpdateClientForTests(
      mockClient({
        check: vi.fn(() =>
          Promise.resolve({
            available: true,
            version: "0.1.10",
            requiresRuntimeComponents: true,
            resourceManifest: { url: "https://updates.example/manifest.json", signature: "signed" },
            download,
            install,
          }),
        ),
        prepareRuntimeComponents,
        needsManualRelaunch: vi.fn(() => Promise.resolve(false)),
        relaunch,
      }),
    );

    await checkForAppUpdate({ quiet: true });
    await vi.waitFor(() => expect(getAppUpdateState().status).toBe("restarting"));
    expect(order).toEqual(["resources", "download", "install"]);
    expect(relaunch).not.toHaveBeenCalled();
  });

  it("automatically installs a split macOS update and relaunches once", async () => {
    const order: string[] = [];
    const download = vi.fn(async (onProgress: (event: AppUpdateProgressEvent) => void) => {
      order.push("download");
      await completeDownload(onProgress);
    });
    const install = vi.fn(() => {
      order.push("install");
      return Promise.resolve();
    });
    const relaunch = vi.fn(() => {
      order.push("relaunch");
      return Promise.resolve();
    });
    setAppUpdateClientForTests(
      mockClient({
        check: vi.fn(() =>
          Promise.resolve({ available: true, version: "0.1.11", download, install }),
        ),
        relaunch,
      }),
    );

    await checkForAppUpdate({ quiet: true });
    await vi.waitFor(() => expect(relaunch).toHaveBeenCalledTimes(1));
    expect(order).toEqual(["download", "install", "relaunch"]);
    expect(getAppUpdateState().status).toBe("restarting");
    await checkForAppUpdate({ quiet: true });
    expect(download).toHaveBeenCalledTimes(1);
    expect(install).toHaveBeenCalledTimes(1);
  });

  it("flushes the canvas after download and immediately before native install", async () => {
    const order: string[] = [];
    registerAppUpdateBeforeInstallFlush(() => {
      order.push("flush");
      return Promise.resolve();
    });
    const relaunch = vi.fn(() => {
      order.push("relaunch");
      return Promise.resolve();
    });
    setAppUpdateClientForTests(
      mockClient({
        check: vi.fn(() =>
          Promise.resolve({
            available: true,
            version: "0.1.11",
            download: () => {
              order.push("download");
              return Promise.resolve();
            },
            install: async (
              _progress?: (event: AppUpdateProgressEvent) => void,
              beforeInstall?: () => Promise<void>,
            ) => {
              await beforeInstall?.();
              order.push("install");
            },
          }),
        ),
        relaunch,
      }),
    );
    await checkForAppUpdate({ quiet: true });
    await vi.waitFor(() => expect(relaunch).toHaveBeenCalledTimes(1));
    expect(order).toEqual(["download", "flush", "flush", "install", "relaunch"]);
  });

  it("aborts installation and restart when the canvas flush fails", async () => {
    registerAppUpdateBeforeInstallFlush(() => Promise.reject(new Error("画布保存失败")));
    const install = vi.fn(() => Promise.resolve());
    const relaunch = vi.fn(() => Promise.resolve());
    setAppUpdateClientForTests(
      mockClient({
        check: vi.fn(() =>
          Promise.resolve({
            available: true,
            version: "0.1.11",
            download: vi.fn(() => Promise.resolve()),
            install,
          }),
        ),
        relaunch,
      }),
    );
    await checkForAppUpdate({ quiet: true });
    await vi.waitFor(() => expect(getAppUpdateState().error).toBe("画布保存失败"));
    expect(getAppUpdateState()).toMatchObject({ status: "ready", recoveryAction: "retry-install" });
    expect(install).not.toHaveBeenCalled();
    expect(relaunch).not.toHaveBeenCalled();
  });

  it("never enters a combined Windows installer when the canvas flush fails", async () => {
    registerAppUpdateBeforeInstallFlush(() => Promise.reject(new Error("画布保存失败")));
    const downloadAndInstall = vi.fn(() => Promise.resolve());
    const relaunch = vi.fn(() => Promise.resolve());
    setAppUpdateClientForTests(
      mockClient({
        check: vi.fn(() =>
          Promise.resolve({ available: true, version: "0.1.11", downloadAndInstall }),
        ),
        relaunch,
      }),
    );
    await checkForAppUpdate({ quiet: true });
    await vi.waitFor(() => expect(getAppUpdateState().error).toBe("画布保存失败"));
    expect(downloadAndInstall).not.toHaveBeenCalled();
    expect(relaunch).not.toHaveBeenCalled();
  });

  it("retries only relaunch after installation succeeds", async () => {
    const install = vi.fn(() => Promise.resolve());
    const relaunch = vi
      .fn()
      .mockRejectedValueOnce(new Error("重启失败"))
      .mockResolvedValueOnce(undefined);
    setAppUpdateClientForTests(
      mockClient({
        check: vi.fn(() =>
          Promise.resolve({
            available: true,
            version: "0.1.11",
            download: vi.fn(() => Promise.resolve()),
            install,
          }),
        ),
        relaunch,
      }),
    );
    await checkForAppUpdate({ quiet: true });
    await vi.waitFor(() => expect(getAppUpdateState().error).toBe("重启失败"));
    expect(getAppUpdateState().recoveryAction).toBe("restart-only");
    await loadCurrentAppVersion();
    expect(getAppUpdateState().error).toBe("重启失败");
    registerAppUpdateBeforeInstallFlush(() => Promise.reject(new Error("二次保存失败")));
    await relaunchAfterAppUpdate();
    expect(getAppUpdateState().error).toBe("二次保存失败");
    expect(relaunch).toHaveBeenCalledTimes(1);
    registerAppUpdateBeforeInstallFlush(() => Promise.resolve());
    await relaunchAfterAppUpdate();
    expect(install).toHaveBeenCalledTimes(1);
    expect(relaunch).toHaveBeenCalledTimes(2);
  });

  it("does not repeat an uncertain split installer on the next quiet check", async () => {
    const install = vi.fn(() => Promise.reject(new Error("MAC_DELTA_INSTALL: 安装器返回错误")));
    const relaunch = vi.fn(() => Promise.resolve());
    const check = vi.fn(() =>
      Promise.resolve({
        available: true,
        version: "0.1.11",
        download: vi.fn(() => Promise.resolve()),
        install,
      }),
    );
    setAppUpdateClientForTests(mockClient({ check, relaunch }));

    await checkForAppUpdate({ quiet: true });
    await vi.waitFor(() => expect(getAppUpdateState().status).toBe("error"));
    expect(getAppUpdateState().error).toContain("安装结果尚不确定");
    expect(getAppUpdateState().recoveryAction).toBe("restart-to-recheck");
    await checkForAppUpdate({ quiet: true });
    expect(check).toHaveBeenCalledTimes(2);
    expect(install).toHaveBeenCalledTimes(1);
    expect(getAppUpdateState().error).toContain("安装结果尚不确定");
    registerAppUpdateBeforeInstallFlush(() => Promise.reject(new Error("二次保存失败")));
    await relaunchAfterAppUpdate();
    expect(relaunch).not.toHaveBeenCalled();
    expect(getAppUpdateState().recoveryAction).toBe("restart-to-recheck");
  });

  it("automatically updates even if the same version was previously postponed", async () => {
    window.localStorage.setItem(SKIPPED_UPDATE_STORAGE_KEY, "0.1.10");
    const download = vi.fn(() => Promise.resolve());
    setAppUpdateClientForTests(
      mockClient({
        check: vi.fn(() =>
          Promise.resolve({ available: true, version: "0.1.10", download, install: vi.fn() }),
        ),
      }),
    );
    await checkForAppUpdate({ quiet: true });
    await vi.waitFor(() => expect(getAppUpdateState().status).toBe("restarting"));
    expect(download).toHaveBeenCalledTimes(1);
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
    await vi.waitFor(() => expect(getAppUpdateState().status).toBe("restarting"));
  });

  it("waits for persistent runtimes before downloading a small installer", async () => {
    let finishMigration: (() => void) | undefined;
    const migration = new Promise<void>((resolve) => {
      finishMigration = resolve;
    });
    const downloadAndInstall = vi.fn(() => Promise.resolve());
    const waitForRuntimeComponents = vi.fn(
      async (
        onProgress: (status: {
          ready: boolean;
          preparing: boolean;
          error: string | null;
          completedBytes: number;
          totalBytes: number;
          completedComponents: number;
          totalComponents: number;
        }) => void,
      ) => {
        onProgress({
          ready: false,
          preparing: true,
          error: null,
          completedBytes: 2,
          totalBytes: 4,
          completedComponents: 0,
          totalComponents: 4,
        });
        await migration;
        onProgress({
          ready: true,
          preparing: false,
          error: null,
          completedBytes: 4,
          totalBytes: 4,
          completedComponents: 4,
          totalComponents: 4,
        });
      },
    );
    setAppUpdateClientForTests(
      mockClient({
        check: vi.fn(() =>
          Promise.resolve({
            available: true,
            version: "0.1.9",
            requiresRuntimeComponents: true,
            downloadAndInstall,
          }),
        ),
        waitForRuntimeComponents,
      }),
    );

    await checkForAppUpdate();
    expect(getAppUpdateState()).toMatchObject({
      status: "preparing",
      preparedBytes: 2,
      totalPreparationBytes: 4,
    });
    expect(downloadAndInstall).not.toHaveBeenCalled();
    finishMigration?.();
    await vi.waitFor(() => expect(downloadAndInstall).toHaveBeenCalledTimes(1));
    expect(waitForRuntimeComponents).toHaveBeenCalledTimes(1);
  });

  it("keeps the existing install when runtime migration fails", async () => {
    const downloadAndInstall = vi.fn(() => Promise.resolve());
    setAppUpdateClientForTests(
      mockClient({
        check: vi.fn(() =>
          Promise.resolve({
            available: true,
            version: "0.1.9",
            requiresRuntimeComponents: true,
            downloadAndInstall,
          }),
        ),
        waitForRuntimeComponents: vi.fn(() => Promise.reject(new Error("磁盘空间不足"))),
      }),
    );

    await checkForAppUpdate();
    await vi.waitFor(() => expect(getAppUpdateState().status).toBe("error"));
    expect(downloadAndInstall).not.toHaveBeenCalled();
    expect(getAppUpdateState()).toMatchObject({ status: "error", error: "磁盘空间不足" });
    expect(shouldShowUpdateBanner(getAppUpdateState())).toBe(true);
  });

  it("installs a full updater package even if old runtime migration failed", async () => {
    const downloadAndInstall = vi.fn(() => Promise.resolve());
    const waitForRuntimeComponents = vi.fn(() => Promise.reject(new Error("风格库资源缺失")));
    setAppUpdateClientForTests(
      mockClient({
        check: vi.fn(() =>
          Promise.resolve({
            available: true,
            version: "0.1.9",
            requiresRuntimeComponents: false,
            downloadAndInstall,
          }),
        ),
        waitForRuntimeComponents,
      }),
    );

    await checkForAppUpdate();
    await vi.waitFor(() => expect(getAppUpdateState().status).toBe("restarting"));
    expect(waitForRuntimeComponents).not.toHaveBeenCalled();
    expect(downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(getAppUpdateState().status).toBe("restarting");
  });

  it("installs the online feed without legacy runtime migration or a resource manifest", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    const feed = {
      version: "0.2.1",
      notes: "轻量联网版：需要时可安装对应功能组件，也支持离线组件包。",
      pub_date: "2026-10-07T14:59:14.512Z",
      platforms: {
        "windows-x86_64": {
          url: "https://sd20-zq.tos-cn-beijing.volces.com/infinite-canvas/updates/windows-x86_64-online/%E6%97%A0%E9%99%90%E7%94%BB%E5%B8%83_0.2.1_x64-online-setup.exe",
          signature: "fixture-updater-signature",
        },
      },
    };
    const order: string[] = [];
    const download = vi.fn((onProgress: (event: AppUpdateProgressEvent) => void) => {
      order.push("download");
      return completeDownload(onProgress);
    });
    const install = vi.fn(() => {
      order.push("install");
      return Promise.resolve();
    });
    const flush = vi.fn(() => {
      order.push("save-canvas");
      return Promise.resolve();
    });
    registerAppUpdateBeforeInstallFlush(flush);
    desktopMocks.check.mockResolvedValue({
      version: feed.version,
      body: feed.notes,
      rawJson: feed,
      download,
      install,
    });
    desktopMocks.invoke.mockRejectedValue(new Error("旧四组件尚未安装，迁移无法完成"));
    setAppUpdateClientForTests(createDesktopAppUpdateClient());

    await checkForAppUpdate();
    await vi.waitFor(() => expect(install).toHaveBeenCalledTimes(1));

    expect(desktopMocks.check).toHaveBeenCalledTimes(1);
    expect(download).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalled();
    expect(order[0]).toBe("download");
    expect(order.at(-2)).toBe("save-canvas");
    expect(order.at(-1)).toBe("install");
    expect(desktopMocks.invoke).not.toHaveBeenCalled();
    expect(desktopMocks.relaunch).not.toHaveBeenCalled();
    expect(getAppUpdateState()).toMatchObject({
      status: "restarting",
      availableVersion: "0.2.1",
      preparedBytes: 0,
      totalPreparationBytes: 0,
      error: null,
    });
  });

  it("prepares signed changed resources before downloading the small installer", async () => {
    const order: string[] = [];
    const waitForRuntimeComponents = vi.fn(() => Promise.resolve());
    const prepareRuntimeComponents = vi.fn(
      (
        _request: PrepareRuntimeResourcesRequest,
        onProgress: (status: RuntimeComponentMigrationStatus) => void,
      ) => {
        order.push("resources");
        onProgress({
          ready: true,
          preparing: false,
          error: null,
          completedBytes: 12,
          totalBytes: 12,
          completedComponents: 4,
          totalComponents: 4,
          reusedBytes: 10,
          downloadedBytes: 2,
        });
        return Promise.resolve();
      },
    );
    const downloadAndInstall = vi.fn(() => {
      order.push("installer");
      return Promise.resolve();
    });
    setAppUpdateClientForTests(
      mockClient({
        check: vi.fn(() =>
          Promise.resolve({
            available: true,
            version: "0.1.10",
            requiresRuntimeComponents: true,
            resourceManifest: {
              url: "https://updates.example/resources/0.1.10/manifest.json",
              signature: "signed",
            },
            downloadAndInstall,
          }),
        ),
        waitForRuntimeComponents,
        prepareRuntimeComponents,
      }),
    );
    await checkForAppUpdate();
    await vi.waitFor(() => expect(order).toEqual(["resources", "installer"]));
    expect(prepareRuntimeComponents).toHaveBeenCalledWith(
      {
        version: "0.1.10",
        url: "https://updates.example/resources/0.1.10/manifest.json",
        signature: "signed",
      },
      expect.any(Function),
    );
    expect(waitForRuntimeComponents).not.toHaveBeenCalled();
    expect(order).toEqual(["resources", "installer"]);
    expect(getAppUpdateState()).toMatchObject({
      preparedBytes: 12,
      totalPreparationBytes: 12,
      reusedResourceBytes: 10,
      downloadedResourceBytes: 2,
    });
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

  it("finds a new version while the app stays open and stops checking after cleanup", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-23T12:00:00Z"));
    let latestAvailable = false;
    const check = vi.fn(() =>
      Promise.resolve(
        latestAvailable
          ? { available: true, version: "0.1.8", downloadAndInstall: vi.fn() }
          : { available: false },
      ),
    );
    setAppUpdateClientForTests(mockClient({ check }));

    const stop = startAutomaticAppUpdateChecks();
    await vi.advanceTimersByTimeAsync(0);
    expect(check).toHaveBeenCalledTimes(1);
    expect(getAppUpdateState().status).toBe("current");

    latestAvailable = true;
    await vi.advanceTimersByTimeAsync(APP_UPDATE_CHECK_INTERVAL_MS);
    expect(check).toHaveBeenCalledTimes(2);
    expect(getAppUpdateState()).toMatchObject({
      status: "restarting",
      availableVersion: "0.1.8",
    });

    stop();
    await vi.advanceTimersByTimeAsync(APP_UPDATE_CHECK_INTERVAL_MS);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("checks on foreground return and network recovery without rapid duplicate requests", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-23T12:00:00Z"));
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    const check = vi.fn(() => Promise.resolve({ available: false }));
    setAppUpdateClientForTests(mockClient({ check }));

    const stop = startAutomaticAppUpdateChecks();
    await vi.advanceTimersByTimeAsync(APP_UPDATE_CHECK_INTERVAL_MS);
    expect(check).not.toHaveBeenCalled();

    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(check).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(check).toHaveBeenCalledTimes(1);

    online.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(APP_UPDATE_FOCUS_THROTTLE_MS);
    window.dispatchEvent(new Event("focus"));
    expect(check).toHaveBeenCalledTimes(1);
    online.mockReturnValue(true);
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(check).toHaveBeenCalledTimes(2);
    stop();
  });

  it("does not loop an automatic install after failure but allows a manual retry", async () => {
    const download = vi
      .fn()
      .mockRejectedValueOnce(new Error("网络中断"))
      .mockResolvedValueOnce(undefined);
    const check = vi.fn(() =>
      Promise.resolve({ available: true, version: "0.1.8", download, install: vi.fn() }),
    );
    setAppUpdateClientForTests(mockClient({ check }));

    await checkForAppUpdate({ quiet: true });
    await vi.waitFor(() => expect(getAppUpdateState().status).toBe("error"));
    expect(getAppUpdateState().error).toBe("网络中断");
    await checkForAppUpdate({ quiet: true });
    expect(check).toHaveBeenCalledTimes(2);
    expect(download).toHaveBeenCalledTimes(1);
    expect(getAppUpdateState().error).toBe("网络中断");

    await installAvailableAppUpdate();
    expect(download).toHaveBeenCalledTimes(2);
    expect(getAppUpdateState().status).toBe("restarting");
  });
});
