import type { VideoDownloaderCookieBrowser, VideoDownloaderEngineStatus } from "../../lib/backend";
import "./DownloadCookieSourceControls.css";

const BROWSER_NAMES: Record<Exclude<VideoDownloaderCookieBrowser, "auto">, string> = {
  chrome: "Chrome",
  edge: "Edge",
  firefox: "Firefox",
  brave: "Brave",
};

export interface DownloadCookieSourceControlsProps {
  readonly status: VideoDownloaderEngineStatus | null;
  readonly busy?: boolean;
  readonly onSelectBrowser?: ((browser: VideoDownloaderCookieBrowser | null) => void) | undefined;
  readonly onImportCookies: () => void;
  readonly onClearCookies?: (() => void) | undefined;
  readonly importLabel?: string;
}

export function DownloadCookieSourceControls({
  status,
  busy = false,
  onSelectBrowser,
  onImportCookies,
  onClearCookies,
  importLabel = "导入 Cookies 文件",
}: DownloadCookieSourceControlsProps) {
  const browser = status?.cookieBrowser ?? null;
  const sourceLabel =
    browser === "auto"
      ? `下载时自动逐源预检 · ${status?.cookiesInstalled ? "已导入文件可用于站点解析和后备" : "未导入后备文件"} · 实际下载结果待验证`
      : browser
        ? `下载时尝试读取 ${BROWSER_NAMES[browser]} Cookies · 目标视频能否访问待实际下载验证`
        : status?.cookiesInstalled
          ? "已导入 cookies.txt · 目标视频能否访问待实际下载验证"
          : "未选择浏览器，也未导入 cookies.txt";

  return (
    <div className="download-cookie-source" aria-label="下载登录 Cookies 设置">
      {onSelectBrowser ? (
        <label className="download-cookie-source__select">
          <span>Cookies 来源</span>
          <select
            aria-label="下载 Cookies 来源"
            value={browser ?? ""}
            disabled={busy || status == null}
            onChange={(event) =>
              onSelectBrowser(
                event.currentTarget.value
                  ? (event.currentTarget.value as VideoDownloaderCookieBrowser)
                  : null,
              )
            }
          >
            <option value="">已导入文件或不使用</option>
            <option value="auto">
              自动尝试 Chrome、Edge、Firefox，必要时用已导入文件或无 Cookies
            </option>
            {Object.entries(BROWSER_NAMES).map(([value, label]) => (
              <option key={value} value={value}>
                下载时读取 {label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <div className="download-cookie-source__actions">
        <span role="status">{status == null ? "正在检查下载登录设置…" : sourceLabel}</span>
        <button type="button" aria-label={importLabel} disabled={busy} onClick={onImportCookies}>
          {importLabel}
        </button>
        {status?.cookiesInstalled && onClearCookies ? (
          <button type="button" disabled={busy} onClick={onClearCookies}>
            清除文件
          </button>
        ) : null}
      </div>
      {browser === "auto" ? (
        <small>
          抖音和小红书的官方页面解析会先尝试已导入的 cookies.txt；原站提取器再按
          Chrome、Edge、Firefox、已导入文件、无 Cookies
          的顺序逐源预检。浏览器加密或占用导致读取失败时会尝试下一来源。预检通过不代表视频已下载，也不代表账号已登录；只有真实视频文件下载完成才算成功。项目只保存来源设置，不导出浏览器
          Cookie 值。
        </small>
      ) : browser ? (
        <small>
          下载时会临时载入所选浏览器默认或最近使用配置档的 Cookie
          jar，按请求站点使用；项目只保存浏览器名，不导出 Cookie
          值。浏览器加密或数据库占用可能导致读取失败。抖音和小红书的隔离页面解析需导入
          cookies.txt，并将来源选为“已导入文件或不使用”或“自动尝试”；单选浏览器不会把登录态注入该解析器。
        </small>
      ) : (
        <small>
          抖音和小红书的受限视频可导入当前账号的 cookies.txt，应用会按站点限制解析时使用的
          Cookies；账号仍须有观看权限。
        </small>
      )}
    </div>
  );
}
