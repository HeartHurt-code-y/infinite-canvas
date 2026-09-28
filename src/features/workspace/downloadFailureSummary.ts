import type { VideoDownloadCredentialSource, VideoDownloadJobRecord } from "../../lib/backend";

const SOURCE_LABELS: Record<VideoDownloadCredentialSource, string> = {
  chrome: "Chrome 浏览器",
  edge: "Edge 浏览器",
  firefox: "Firefox 浏览器",
  brave: "Brave 浏览器",
  manual: "已导入 Cookies 文件",
  site_session: "站点会话（不代表已登录）",
  none: "未使用 Cookies（不代表已登录）",
};

export function downloadFailureSummary(job: VideoDownloadJobRecord, fallback: string): string {
  const source = job.credentialSource;
  const label = source == null ? "未记录" : SOURCE_LABELS[source];
  return `本次任务凭据来源：${label}。\n${job.error ?? fallback}`;
}
