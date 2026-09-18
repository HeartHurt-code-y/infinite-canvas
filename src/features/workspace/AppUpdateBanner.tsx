import { Icon } from "../../components/Icon";
import { useEffect } from "react";
import { isDesktopRuntime } from "../../lib/backend";
import {
  checkForAppUpdate,
  dismissAvailableAppUpdate,
  downloadPercent,
  formatDownloadProgress,
  installAvailableAppUpdate,
  relaunchAfterAppUpdate,
  shouldShowUpdateBanner,
  useAppUpdate,
  type AppUpdateState,
} from "../../lib/appUpdate";

export function AppUpdateBanner() {
  const snapshot = useAppUpdate();

  useEffect(() => {
    if (!import.meta.env.PROD || !isDesktopRuntime()) return;
    void checkForAppUpdate({ quiet: true });
  }, []);

  if (!shouldShowUpdateBanner(snapshot)) return null;

  return (
    <div className="app-update-banner" role="status">
      <Icon
        name={
          snapshot.status === "ready"
            ? "check-circle"
            : snapshot.status === "downloading" || snapshot.status === "restarting"
              ? "circle-notch"
              : "cloud-arrow-down"
        }
        aria-hidden="true"
        size="md"
        data-spin={
          snapshot.status === "downloading" || snapshot.status === "restarting" ? "true" : undefined
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
  if (status === "downloading") return "正在下载更新";
  if (status === "ready") return "更新已就绪";
  if (status === "restarting") return "正在完成安装";
  return availableVersion ? `发现新版本 ${availableVersion}` : "发现新版本";
}

function bannerDetail(snapshot: AppUpdateState): string {
  if (snapshot.status === "downloading") {
    return formatDownloadProgress(snapshot.downloadedBytes, snapshot.totalBytes);
  }
  if (snapshot.status === "ready") return "重启后即可使用新版本，画布会自动保存。";
  if (snapshot.status === "restarting") return "安装程序会自动重启应用。";
  return "直接升级，不必卸载重装。";
}

function bannerActions(snapshot: AppUpdateState) {
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
        立即重启
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
        立即更新
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
