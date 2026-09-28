// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDesktopAppUpdateClient, type AppUpdateProgressEvent } from "./appUpdate";

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  invoke: vi.fn(),
  type: vi.fn(() => "macos"),
  arch: vi.fn(() => "aarch64"),
}));

vi.mock("@tauri-apps/plugin-updater", () => ({ check: mocks.check }));
vi.mock("@tauri-apps/plugin-os", () => ({ type: mocks.type, arch: mocks.arch }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

beforeEach(() => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {},
  });
  mocks.check.mockReset();
  mocks.invoke.mockReset();
});

afterEach(() => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

function updaterResult() {
  const download = vi.fn(async (onProgress: (event: AppUpdateProgressEvent) => void) => {
    onProgress({ event: "Started", data: { contentLength: 100 } });
    onProgress({ event: "Progress", data: { chunkLength: 100 } });
    onProgress({ event: "Finished" });
  });
  const install = vi.fn(async () => undefined);
  mocks.check.mockResolvedValue({
    version: "0.1.11",
    body: "",
    rawJson: {
      macDeltaManifest: {
        url: "https://updates.example/mac-delta/0.1.11/manifest.json",
        signature: "signed",
      },
    },
    download,
    install,
    downloadAndInstall: vi.fn(),
  });
  return { download, install };
}

describe("macOS delta update client", () => {
  it("prepares a delta in the background and installs it only after restart is requested", async () => {
    const full = updaterResult();
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "prepare_macos_delta_update") return true;
      if (command === "get_macos_delta_update_status") {
        return {
          preparing: false,
          ready: true,
          downloadedBytes: 20,
          totalBytes: 20,
          reusedBytes: 80,
        };
      }
      if (command === "install_prepared_macos_delta_update") return undefined;
      throw new Error(`unexpected command: ${command}`);
    });
    const result = await createDesktopAppUpdateClient().check();
    expect(result.available).toBe(true);
    const events: AppUpdateProgressEvent[] = [];
    await result.download?.((event) => events.push(event));
    expect(events).toEqual([
      { event: "Started", data: { contentLength: 20 } },
      { event: "Progress", data: { chunkLength: 20 } },
      { event: "Finished" },
    ]);
    expect(full.download).not.toHaveBeenCalled();
    expect(full.install).not.toHaveBeenCalled();
    await result.install?.();
    expect(mocks.invoke).toHaveBeenCalledWith("install_prepared_macos_delta_update", {
      version: "0.1.11",
    });
  });

  it("falls back to the signed full updater when delta preparation fails", async () => {
    const full = updaterResult();
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "prepare_macos_delta_update") throw new Error("base hash mismatch");
      if (command === "get_macos_delta_update_status") {
        return {
          preparing: false,
          ready: false,
          downloadedBytes: 0,
          totalBytes: 0,
          reusedBytes: 0,
        };
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const result = await createDesktopAppUpdateClient().check();
    const events: AppUpdateProgressEvent[] = [];
    await result.download?.((event) => events.push(event));
    await result.install?.();
    expect(full.download).toHaveBeenCalledTimes(1);
    expect(full.install).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual({ event: "Started", data: { contentLength: 100 } });
  });

  it("uses the full updater if the prepared delta changes before installation", async () => {
    const full = updaterResult();
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "prepare_macos_delta_update") return true;
      if (command === "get_macos_delta_update_status") {
        return {
          preparing: false,
          ready: true,
          downloadedBytes: 20,
          totalBytes: 20,
          reusedBytes: 80,
        };
      }
      if (command === "install_prepared_macos_delta_update") {
        throw new Error("MAC_DELTA_PREINSTALL: macOS 更新清单已变化，请重新检查更新");
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const result = await createDesktopAppUpdateClient().check();
    await result.download?.(() => undefined);
    await result.install?.(() => undefined);
    expect(full.download).toHaveBeenCalledTimes(1);
    expect(full.install).toHaveBeenCalledTimes(1);
  });

  it("does not start a second installer after an unknown native install failure", async () => {
    const full = updaterResult();
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "prepare_macos_delta_update") return true;
      if (command === "get_macos_delta_update_status") {
        return {
          preparing: false,
          ready: true,
          downloadedBytes: 20,
          totalBytes: 20,
          reusedBytes: 80,
        };
      }
      if (command === "install_prepared_macos_delta_update") throw new Error("IPC disconnected");
      throw new Error(`unexpected command: ${command}`);
    });
    const result = await createDesktopAppUpdateClient().check();
    await result.download?.(() => undefined);
    await expect(result.install?.()).rejects.toThrow("IPC disconnected");
    expect(full.download).not.toHaveBeenCalled();
    expect(full.install).not.toHaveBeenCalled();
  });
});
