/*
 * 打开创作台独立窗口。
 *
 * 创作台是同一份前端产物的另一个入口（独立窗口、极简模式）。
 * 桌面端走 Tauri 命令开新窗口；浏览器预览里没有多窗口，就退化成
 * 打开一个带 `?view=create` 的新标签页——两条路径的入口判定一致
 * （见 createEntry.ts）。
 */
import { invokeDesktopVoid, isDesktopRuntime } from "../../lib/ipc";

export async function openCreateStudio(): Promise<void> {
  if (!isDesktopRuntime()) {
    const url = new URL(window.location.href);
    url.searchParams.set("view", "create");
    window.open(url.toString(), "_blank", "noopener");
    return;
  }
  await invokeDesktopVoid("open_create_window");
}
