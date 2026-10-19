import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeComponentManagerStatus } from "../../lib/runtimeComponents";
import { RuntimeComponentsPanel } from "./RuntimeComponentsPanel";
import "../../App.css";
import "../../styles/studio.css";

const mocks = { invoke: vi.fn() };

const entries = [
  ["blender", "白模渲染组件"],
  ["remotion-runtime", "动画与网页解析组件"],
  ["ffmpeg", "媒体处理组件"],
  ["gpt-image-2-style-library", "图片风格库"],
  ["pose-runtime", "动作捕捉组件"],
  ["ai-media-runtime", "AI 媒体轻量组件"],
  ["ai-media-quality-runtime", "AI 媒体质量组件"],
] as const;

function status(catalogReady: boolean): RuntimeComponentManagerStatus {
  return {
    edition: "offline",
    catalogReady,
    catalogError: catalogReady ? null : "组件目录文件缺失",
    components: entries.map(([id, title]) => ({
      id,
      title,
      description: "按需准备本地功能，安装后可离线使用。",
      version: "1.0",
      state: id.startsWith("ai-media") ? "damaged" : "ready",
      rootPath: null,
      installedBytes: 900 * 1024 * 1024,
      downloadBytes: 300 * 1024 * 1024,
      dependencies: id.startsWith("ai-media") ? ["ffmpeg"] : [],
      error: id.startsWith("ai-media") ? "组件文件校验失败。" : null,
    })),
    transfer: {
      active: false,
      componentId: null,
      phase: "idle",
      completedBytes: 0,
      totalBytes: 0,
      reusedBytes: 0,
      downloadedBytes: 0,
      error: null,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("__TAURI_INTERNALS__", { invoke: mocks.invoke });
});

describe("功能组件面板的真实窗口布局", () => {
  it.each([true, false])("目录可用=%s：窄窗口和滚动后仍可读懂错误并操作", async (catalogReady) => {
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "get_runtime_component_manager_status")
        return Promise.resolve(status(catalogReady));
      return Promise.reject(new Error(`Unexpected native invocation: ${command}`));
    });
    await page.viewport(1440, 900);
    await render(<RuntimeComponentsPanel onClose={vi.fn()} />);
    await expect
      .element(page.getByRole("heading", { name: "AI 媒体质量组件" }))
      .toBeInTheDocument();
    const dialog = page.getByRole("dialog", { name: "功能组件" }).element() as HTMLDialogElement;
    const body = dialog.querySelector<HTMLElement>(".runtime-components__body")!;
    const footer = dialog.querySelector("footer")!;
    const close = page.getByRole("button", { name: "关闭组件管理" });
    for (const [width, height] of [
      [1440, 900],
      [390, 844],
      [1024, 480],
    ]) {
      await page.viewport(width!, height!);
      body.scrollTop = body.scrollHeight;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth + 1);
      expect(body.scrollWidth).toBeLessThanOrEqual(body.clientWidth + 1);
      expect(dialog.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
      expect(footer.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight);
      await expect.element(close).toBeVisible();
      const row = page.getByRole("heading", { name: "AI 媒体质量组件" }).element().closest("li")!;
      const alert = row.querySelector<HTMLElement>("[role=alert]")!;
      expect(alert.querySelector("svg[aria-hidden=true]")).not.toBeNull();
      const recoveryMessage = alert.textContent;
      expect(recoveryMessage).toContain(catalogReady ? "修复组件" : "恢复组件目录");
      for (const button of row.querySelectorAll("button")) {
        const bounds = button.getBoundingClientRect();
        const parent = body.getBoundingClientRect();
        expect(bounds.left).toBeGreaterThanOrEqual(parent.left);
        expect(bounds.right).toBeLessThanOrEqual(parent.right);
      }
      if (!catalogReady) {
        const catalog = dialog.querySelector<HTMLElement>(".runtime-components__catalog")!;
        const catalogMessage = catalog.textContent;
        expect(catalogMessage).toContain("在线安装和离线导入均不可用");
        expect(catalog.getBoundingClientRect().bottom).toBeLessThanOrEqual(
          body.getBoundingClientRect().top,
        );
        expect(catalog.getBoundingClientRect().top).toBeGreaterThanOrEqual(
          dialog.getBoundingClientRect().top,
        );
      }
      await page.screenshot({
        element: dialog,
        path: `../../../.cache/runtime-components-ui/${catalogReady ? "repair" : "blocked"}-${width}.png`,
      });
    }
  });
});
