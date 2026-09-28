import { Icon } from "../../components/Icon";
import { useEffect } from "react";
import { isDesktopRuntime } from "../../lib/backend";
import {
  dismissAvailableAppUpdate,
  downloadPercent,
  formatByteSize,
  formatDownloadProgress,
  installAvailableAppUpdate,
  relaunchAfterAppUpdate,
  shouldShowUpdateBanner,
  startAutomaticAppUpdateChecks,
  useAppUpdate,
  type AppUpdateState,
} from "../../lib/appUpdate";

export function AppUpdateBanner() {
  const snapshot = useAppUpdate();

  useEffect(() => {
    if (!import.meta.env.PROD || !isDesktopRuntime()) return;
    return startAutomaticAppUpdateChecks();
  }, []);

  if (!shouldShowUpdateBanner(snapshot)) return null;

  return (
    <div className="app-update-banner" role="status">
      <Icon
        name={
          snapshot.status === "ready"
            ? "check-circle"
            : snapshot.status === "preparing" ||
                snapshot.status === "downloading" ||
                snapshot.status === "restarting"
              ? "circle-notch"
              : "cloud-arrow-down"
        }
        aria-hidden="true"
        size="md"
        data-spin={
          snapshot.status === "preparing" ||
          snapshot.status === "downloading" ||
          snapshot.status === "restarting"
            ? "true"
            : undefined
        }
      />
      <div className="app-update-banner__copy">
        <strong>{bannerTitle(snapshot.status, snapshot.availableVersion)}</strong>
        <span>{bannerDetail(snapshot)}</span>
      </div>
      {bannerActions(snapshot)}
    </div>
  );
}

function bannerTitle(status: AppUpdateState["status"], availableVersion: string | null): string {
  if (status === "error") return "更新失败";
  if (status === "preparing") return "正在校验并准备运行资源";
  if (status === "downloading") return "正在下载更新";
  if (status === "ready") return "更新已下载完成";
  if (status === "restarting") return "正在完成安装";
  return availableVersion ? `发现新版本 ${availableVersion}` : "发现新版本";
}

function bannerDetail(snapshot: AppUpdateState): string {
  if (snapshot.status === "error" && snapshot.error) return snapshot.error;
  if (snapshot.status === "preparing") {
    return snapshot.totalPreparationBytes > 0
      ? `${formatDownloadProgress(snapshot.preparedBytes, snapshot.totalPreparationBytes)}；复用 ${formatByteSize(snapshot.reusedResourceBytes)}，下载 ${formatByteSize(snapshot.downloadedResourceBytes)}。`
      : "正在校验和复用本地资源文件。";
  }
  if (snapshot.status === "downloading") {
    return formatDownloadProgress(snapshot.downloadedBytes, snapshot.totalBytes);
  }
  if (snapshot.status === "ready") return "更新已准备好，点击安装并重启后使用新版本。";
  if (snapshot.status === "restarting") return "安装程序会自动重启应用。";
  return "直接升级，不必卸载重装。";
}

function bannerActions(snapshot: AppUpdateState) {
  if (snapshot.status === "preparing") {
    return snapshot.totalPreparationBytes > 0 ? (
      <progress
        max={snapshot.totalPreparationBytes}
        value={snapshot.preparedBytes}
        aria-label="本地运行组件准备进度"
      />
    ) : (
      <button type="button" disabled>
        正在准备…
      </button>
    );
  }
  if (snapshot.status === "downloading") {
    return (
      <progress
        max={100}
        value={downloadPercent(snapshot.downloadedBytes, snapshot.totalBytes)}
        aria-label="更新下载进度"
      />
    );
  }
  if (snapshot.status === "ready") {
    return (
      <button
        type="button"
        onClick={() => {
          void relaunchAfterAppUpdate();
        }}
      >
        安装并重启
      </button>
    );
  }
  if (snapshot.status === "restarting") {
    return (
      <button type="button" disabled>
        正在重启…
      </button>
    );
  }
  return (
    <>
      <button
        type="button"
        onClick={() => {
          void installAvailableAppUpdate();
        }}
      >
        {snapshot.status === "error" ? "重试更新" : "立即更新"}
      </button>
      <button
        type="button"
        className="app-update-banner__dismiss"
        onClick={dismissAvailableAppUpdate}
      >
        稍后
      </button>
    </>
  );
}
