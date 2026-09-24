import { Icon } from "../../components/Icon";
import { useEffect } from "react";
import { isDesktopRuntime } from "../../lib/backend";
import {
  checkForAppUpdate,
  dismissAvailableAppUpdate,
  downloadPercent,
  formatDownloadProgress,
  installAvailableAppUpdate,
  loadCurrentAppVersion,
  relaunchAfterAppUpdate,
  useAppUpdate,
  type AppUpdateState,
} from "../../lib/appUpdate";

export function AppUpdateSettings() {
  const snapshot = useAppUpdate();

  useEffect(() => {
    void loadCurrentAppVersion();
  }, []);

  const desktop = isDesktopRuntime();
  const badge = statusBadge(snapshot, desktop);

  return (
    <section className="app-update-settings" aria-labelledby="app-update-settings-title">
      <div className="provider-form__heading">
        <span className="settings-step">04</span>
        <div>
          <strong id="app-update-settings-title">应用升级</strong>
          <p>
            新版本可以直接安装，不必手动卸载。画布、密钥和素材库在用户数据目录，升级不会清掉。
            首次安装与迁移版包含完整本地引擎；准备好本地组件后，后续常规更新只需下载较小的程序包。
          </p>
        </div>
        <span className="tos-status-badge" data-state={badge.state}>
          {badge.state === "loading" ? (
            <Icon name="circle-notch" aria-hidden="true" size="sm" />
          ) : (
            <Icon name="cloud-arrow-down" aria-hidden="true" size="sm" />
          )}
          {badge.text}
        </span>
      </div>

      <p className="app-update-settings__version">
        当前版本 {snapshot.currentVersion || (desktop ? "读取中…" : "仅安装版显示")}
        {snapshot.availableVersion ? ` · 可升级到 ${snapshot.availableVersion}` : null}
      </p>

      {snapshot.status === "preparing" || snapshot.status === "downloading" ? (
        <div className="app-update-settings__progress">
          <progress
            max={100}
            value={
              snapshot.status === "preparing"
                ? downloadPercent(snapshot.preparedBytes, snapshot.totalPreparationBytes)
                : downloadPercent(snapshot.downloadedBytes, snapshot.totalBytes)
            }
            aria-label={snapshot.status === "preparing" ? "本地运行组件准备进度" : "更新下载进度"}
          />
          <span>
            {snapshot.status === "preparing"
              ? snapshot.totalPreparationBytes > 0
                ? formatDownloadProgress(snapshot.preparedBytes, snapshot.totalPreparationBytes)
                : "正在准备本地运行组件…"
              : formatDownloadProgress(snapshot.downloadedBytes, snapshot.totalBytes)}
          </span>
        </div>
      ) : null}

      {snapshot.notes ? <p className="app-update-settings__notes">{snapshot.notes}</p> : null}

      <div className="app-update-settings__actions">{actionButtons(snapshot, desktop)}</div>

      {snapshot.error ? (
        <p className="settings-error" role="alert">
          <Icon name="warning-circle" aria-hidden="true" size="md" />
          {snapshot.error}
        </p>
      ) : null}
    </section>
  );
}

function statusBadge(
  snapshot: AppUpdateState,
  desktop: boolean,
): { readonly state: "loading" | "unconfigured" | "enabled"; readonly text: string } {
  if (!desktop) return { state: "unconfigured", text: "仅安装版" };
  if (
    snapshot.status === "checking" ||
    snapshot.status === "preparing" ||
    snapshot.status === "downloading"
  ) {
    return {
      state: "loading",
      text:
        snapshot.status === "checking"
          ? "正在检查"
          : snapshot.status === "preparing"
            ? "正在准备"
            : "正在下载",
    };
  }
  if (snapshot.status === "ready" || snapshot.status === "restarting") {
    return { state: "enabled", text: "待重启" };
  }
  if (snapshot.status === "available") return { state: "enabled", text: "有新版本" };
  if (snapshot.status === "current") return { state: "enabled", text: "已是最新" };
  return { state: "unconfigured", text: "未检查" };
}

function actionButtons(snapshot: AppUpdateState, desktop: boolean) {
  if (!desktop) {
    return (
      <p className="app-update-settings__hint">
        浏览器预览不能升级安装包。请打开已经安装的无限画布，在这里检查更新。
      </p>
    );
  }
  if (snapshot.status === "preparing" || snapshot.status === "downloading") {
    return (
      <button type="button" className="provider-fetch-action" disabled data-state="loading">
        <Icon name="circle-notch" aria-hidden="true" size="md" />
        {snapshot.status === "preparing" ? "正在准备本地运行组件…" : "正在下载更新…"}
      </button>
    );
  }
  if (snapshot.status === "ready" || snapshot.status === "restarting") {
    return (
      <button
        type="button"
        className="provider-fetch-action"
        data-state={snapshot.status === "restarting" ? "loading" : undefined}
        disabled={snapshot.status === "restarting"}
        onClick={() => {
          void relaunchAfterAppUpdate();
        }}
      >
        {snapshot.status === "restarting" ? (
          <Icon name="circle-notch" aria-hidden="true" size="md" />
        ) : (
          <Icon name="arrow-clockwise" aria-hidden="true" size="md" />
        )}
        {snapshot.status === "restarting" ? "正在重启…" : "立即重启以完成更新"}
      </button>
    );
  }
  if (snapshot.status === "available" || (snapshot.status === "error" && snapshot.availableVersion)) {
    return (
      <>
        <button
          type="button"
          className="provider-fetch-action"
          onClick={() => {
            void installAvailableAppUpdate();
          }}
        >
          <Icon name="download-simple" aria-hidden="true" size="md" />
          {snapshot.status === "error" ? "重试更新" : "立即更新"}
        </button>
        <button
          type="button"
          className="app-update-settings__secondary"
          onClick={dismissAvailableAppUpdate}
        >
          稍后
        </button>
      </>
    );
  }
  return (
    <button
      type="button"
      className="provider-fetch-action"
      data-state={snapshot.status === "checking" ? "loading" : undefined}
      disabled={snapshot.status === "checking"}
      onClick={() => {
        void checkForAppUpdate();
      }}
    >
      {snapshot.status === "checking" ? (
        <Icon name="circle-notch" aria-hidden="true" size="md" />
      ) : (
        <Icon name="cloud-arrow-down" aria-hidden="true" size="md" />
      )}
      {snapshot.status === "checking" ? "正在检查…" : "检查更新"}
    </button>
  );
}
