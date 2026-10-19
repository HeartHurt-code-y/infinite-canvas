import { isDesktopRuntime } from "./ipc";
import { copyTextToDesktopClipboard } from "../features/workspace/desktopActions";

/*
 * 报错一键复制的剪贴板入口：ErrorCopyButton 与错误 toast 都走这里。
 *
 * 桌面端走 Tauri 系统剪贴板插件（可跨应用粘贴）；浏览器预览与组件测试
 * 退回 Web Clipboard API。两套都不可用时报错交给调用方决定如何呈现。
 */

/** 把一段报错文本写进系统剪贴板；桌面端与浏览器预览都能用。 */
export async function copyErrorTextToClipboard(text: string): Promise<void> {
  if (isDesktopRuntime()) {
    await copyTextToDesktopClipboard(text);
  } else if (navigator.clipboard != null) {
    await navigator.clipboard.writeText(text);
  } else {
    throw new Error("当前环境不支持剪贴板写入。");
  }
}

/** 摘要之外还有原始报错时一并复制：求助时完整 payload 才有用。 */
export function errorCopyText(summary: string, details?: string | null): string {
  return details ? `${summary}\n\n${details}` : summary;
}
