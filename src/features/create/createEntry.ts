import { getCurrentWindow } from "@tauri-apps/api/window";
import { isDesktopRuntime } from "../../lib/backend";
import { resolveAppEntry, type AppEntry } from "./createModel";

/**
 * 当前窗口的 Tauri 标签。
 *
 * 打包后没有地址栏，URL 里的 `?view=create` 进不来；独立窗口只能靠标签识别。
 * 浏览器预览（vite dev）里没有 Tauri 运行时，这里返回 null，入口改由 URL 决定。
 */
export function currentWindowLabel(): string | null {
  if (!isDesktopRuntime()) return null;
  try {
    return getCurrentWindow().label;
  } catch {
    return null;
  }
}

/** 判定当前应该渲染哪个入口。 */
export function resolveCurrentEntry(): AppEntry {
  if (typeof window === "undefined") return "studio";
  return resolveAppEntry(window.location, currentWindowLabel());
}
