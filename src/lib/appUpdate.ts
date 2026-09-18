import { useSyncExternalStore } from "react";
import { formatRawBackendError, frontendLog, isDesktopRuntime } from "./backend";

export const SKIPPED_UPDATE_STORAGE_KEY = "infinite-canvas:skipped-app-update-version";

export type AppUpdateStatus =
  "idle" | "checking" | "current" | "available" | "downloading" | "ready" | "restarting" | "error";

export interface AppUpdateProgressEvent {
  readonly event: "Started" | "Progress" | "Finished";
  readonly data?: {
    readonly contentLength?: number | undefined;
    readonly chunkLength?: number | undefined;
  };
}

export interface AppUpdateCheckResult {
  readonly available: boolean;
  readonly version?: string | undefined;
  readonly notes?: string | null | undefined;
  readonly downloadAndInstall?:
    ((onProgress: (event: AppUpdateProgressEvent) => void) => Promise<void>) | undefined;
}

export interface AppUpdateClient {
  getCurrentVersion(): Promise<string>;
  check(): Promise<AppUpdateCheckResult>;
  relaunch(): Promise<void>;
  needsManualRelaunch(): Promise<boolean>;
}

export interface AppUpdateState {
  readonly status: AppUpdateStatus;
  readonly currentVersion: string;
  readonly availableVersion: string | null;
  readonly notes: string | null;
  readonly downloadedBytes: number;
  readonly totalBytes: number;
  readonly error: string | null;
}

const INITIAL_STATE: AppUpdateState = {
  status: "idle",
  currentVersion: "",
  availableVersion: null,
  notes: null,
  downloadedBytes: 0,
  totalBytes: 0,
  error: null,
};

const listeners = new Set<() => void>();
let state: AppUpdateState = INITIAL_STATE;
let client: AppUpdateClient = createDesktopAppUpdateClient();
let checkGeneration = 0;
let downloadGeneration = 0;
let pendingDownload: AppUpdateCheckResult["downloadAndInstall"];

function emit(): void {
  for (const listener of listeners) listener();
}

function patch(partial: Partial<AppUpdateState>): void {
  state = { ...state, ...partial };
  emit();
}

export function subscribeAppUpdate(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getAppUpdateState(): AppUpdateState {
  return state;
}

export function useAppUpdate(): AppUpdateState {
  return useSyncExternalStore(subscribeAppUpdate, getAppUpdateState, getAppUpdateState);
}

export function setAppUpdateClientForTests(next: AppUpdateClient | null): void {
  client = next ?? createDesktopAppUpdateClient();
}

export function resetAppUpdateStateForTests(): void {
  checkGeneration += 1;
  downloadGeneration += 1;
  pendingDownload = undefined;
  state = INITIAL_STATE;
  emit();
}

export async function loadCurrentAppVersion(): Promise<string> {
  try {
    const version = await client.getCurrentVersion();
    patch({ currentVersion: version, error: state.status === "error" ? state.error : null });
    return version;
  } catch (error) {
    const message = describeUpdateError(error);
    frontendLog("warn", `[app-update] 读取当前版本失败：${message}`);
    patch({ error: state.status === "idle" ? null : message });
    return "";
  }
}

export async function checkForAppUpdate(options?: {
  readonly quiet?: boolean | undefined;
}): Promise<void> {
  const quiet = options?.quiet === true;
  const generation = ++checkGeneration;
  patch({
    status: "checking",
    error: null,
  });
  try {
    const currentVersion = state.currentVersion || (await client.getCurrentVersion());
    const result = await client.check();
    if (generation !== checkGeneration) return;
    if (!result.available) {
      pendingDownload = undefined;
      patch({
        status: "current",
        currentVersion,
        availableVersion: null,
        notes: null,
        downloadedBytes: 0,
        totalBytes: 0,
        error: null,
      });
      return;
    }
    const availableVersion = result.version?.trim() ?? "";
    if (availableVersion === "") {
      throw new Error("更新源返回了空版本号。");
    }
    pendingDownload = result.downloadAndInstall ?? undefined;
    patch({
      status: "available",
      currentVersion,
      availableVersion,
      notes: result.notes ?? null,
      downloadedBytes: 0,
      totalBytes: 0,
      error: null,
    });
  } catch (error) {
    if (generation !== checkGeneration) return;
    const message = describeUpdateError(error);
    if (quiet) {
      frontendLog("warn", `[app-update] 自动检查更新失败：${message}`);
      patch({
        status: state.availableVersion ? "available" : "idle",
        error: null,
      });
      return;
    }
    patch({ status: "error", error: message });
  }
}

export async function installAvailableAppUpdate(): Promise<void> {
  const download = pendingDownload;
  if (download == null) {
    patch({ status: "error", error: "没有可安装的更新，请先检查更新。" });
    return;
  }
  if (state.status === "downloading" || state.status === "restarting") return;
  const generation = ++downloadGeneration;
  patch({
    status: "downloading",
    downloadedBytes: 0,
    totalBytes: 0,
    error: null,
  });
  let downloadedBytes = 0;
  let totalBytes = 0;
  try {
    await download((event) => {
      if (generation !== downloadGeneration) return;
      if (event.event === "Started") {
        totalBytes = event.data?.contentLength ?? 0;
        downloadedBytes = 0;
        patch({ status: "downloading", downloadedBytes, totalBytes });
        return;
      }
      if (event.event === "Progress") {
        downloadedBytes += event.data?.chunkLength ?? 0;
        patch({ status: "downloading", downloadedBytes, totalBytes });
        return;
      }
      patch({ status: "downloading", downloadedBytes, totalBytes });
    });
    if (generation !== downloadGeneration) return;
    const needsManualRelaunch = await client.needsManualRelaunch();
    if (generation !== downloadGeneration) return;
    patch({
      status: needsManualRelaunch ? "ready" : "restarting",
      downloadedBytes: totalBytes > 0 ? totalBytes : downloadedBytes,
      totalBytes,
      error: null,
    });
  } catch (error) {
    if (generation !== downloadGeneration) return;
    patch({ status: "error", error: describeUpdateError(error) });
  }
}

export async function relaunchAfterAppUpdate(): Promise<void> {
  if (state.status !== "ready") return;
  patch({ status: "restarting", error: null });
  try {
    await client.relaunch();
  } catch (error) {
    patch({ status: "ready", error: describeUpdateError(error) });
  }
}

export function dismissAvailableAppUpdate(): void {
  if (state.availableVersion) {
    writeSkippedVersion(state.availableVersion);
  }
  if (state.status === "available" || state.status === "error") {
    patch({ status: state.currentVersion ? "current" : "idle", error: null });
  }
}

export function readSkippedVersion(
  storage: Pick<Storage, "getItem"> | null = availableStorage(),
): string | null {
  if (storage == null) return null;
  const value = storage.getItem(SKIPPED_UPDATE_STORAGE_KEY);
  return value && value.trim() !== "" ? value : null;
}

export function writeSkippedVersion(
  version: string,
  storage: Pick<Storage, "setItem"> | null = availableStorage(),
): void {
  storage?.setItem(SKIPPED_UPDATE_STORAGE_KEY, version);
}

export function shouldShowUpdateBanner(
  snapshot: AppUpdateState,
  skippedVersion: string | null = readSkippedVersion(),
): boolean {
  if (
    snapshot.status === "downloading" ||
    snapshot.status === "ready" ||
    snapshot.status === "restarting"
  ) {
    return true;
  }
  if (snapshot.status !== "available") return false;
  return snapshot.availableVersion != null && snapshot.availableVersion !== skippedVersion;
}

export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"] as const;
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = unitIndex === 0 ? 0 : value >= 10 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

export function formatDownloadProgress(downloadedBytes: number, totalBytes: number): string {
  if (totalBytes > 0) {
    return `${formatByteSize(downloadedBytes)} / ${formatByteSize(totalBytes)}`;
  }
  return formatByteSize(downloadedBytes);
}

export function downloadPercent(downloadedBytes: number, totalBytes: number): number {
  if (totalBytes <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)));
}

export function describeUpdateError(error: unknown): string {
  const raw = error instanceof Error ? error.message : formatRawBackendError(error);
  const text = raw.toLowerCase();
  if (text.includes("not_desktop") || text.includes("not a tauri")) {
    return "请在已安装的桌面应用中检查更新。浏览器预览不能升级安装包。";
  }
  if (text.includes("404") || text.includes("not found") || text.includes("could not fetch")) {
    return "没有检查到可安装的更新。若刚发版，请确认 latest.json 已上传到 TOS 公开目录。";
  }
  if (text.includes("signature") || text.includes("checksum") || text.includes("minisign")) {
    return "更新包校验失败，已取消安装。请重新发布签名后的安装包。";
  }
  if (text.includes("network") || text.includes("failed to fetch") || text.includes("dns")) {
    return "检查更新需要网络连接，请联网后重试。";
  }
  return raw.trim() === "" ? "检查或安装更新失败。" : raw;
}

function availableStorage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

export function createDesktopAppUpdateClient(): AppUpdateClient {
  return {
    async getCurrentVersion() {
      if (!isDesktopRuntime()) return "";
      const { getVersion } = await import("@tauri-apps/api/app");
      return getVersion();
    },
    async check() {
      if (!isDesktopRuntime()) {
        throw new Error("NOT_DESKTOP");
      }
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (update == null) return { available: false };
      return {
        available: true,
        version: update.version,
        notes: update.body,
        downloadAndInstall: async (onProgress) => {
          await update.downloadAndInstall((event) => {
            switch (event.event) {
              case "Started":
                onProgress({
                  event: "Started",
                  data: { contentLength: event.data.contentLength },
                });
                break;
              case "Progress":
                onProgress({
                  event: "Progress",
                  data: { chunkLength: event.data.chunkLength },
                });
                break;
              case "Finished":
                onProgress({ event: "Finished" });
                break;
            }
          });
        },
      };
    },
    async relaunch() {
      if (!isDesktopRuntime()) {
        throw new Error("NOT_DESKTOP");
      }
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    },
    async needsManualRelaunch() {
      if (!isDesktopRuntime()) return false;
      const { type } = await import("@tauri-apps/plugin-os");
      return type() !== "windows";
    },
  };
}
