import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as BackendModule from "../../lib/backend";
import { RUNTIME_COMPONENTS_REQUEST_EVENT } from "../../lib/runtimeComponents";
import { CanvasVideoDownloaderNode } from "./MediaNodeViews";

const desktop = vi.hoisted(() => vi.fn(() => true));
vi.mock("../../lib/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof BackendModule>()),
  isDesktopRuntime: desktop,
}));

function renderDownloader(error?: string) {
  const start = vi.fn();
  render(
    <CanvasVideoDownloaderNode
      node={{
        key: "download-1",
        kind: "video_downloader",
        x: 0,
        y: 0,
        config: { url: "https://example.com/video.mp4" },
      }}
      selected
      dragging={false}
      runState={
        error
          ? {
              jobId: "download-job",
              status: "error",
              preparingEngine: false,
              progress: null,
              qualityHint: null,
              watermarkRemoved: false,
              error,
            }
          : undefined
      }
      engineStatus={null}
      enginePreparing={false}
      onSelect={vi.fn()}
      onNodeDragStart={vi.fn()}
      onRemove={vi.fn()}
      onConfigChange={vi.fn()}
      onStartDownload={start}
      onCancelDownload={vi.fn()}
      onPrepareEngine={vi.fn()}
      onUpdateEngine={vi.fn()}
      onImportCookies={vi.fn()}
      onSelectCookieBrowser={vi.fn()}
      onClearCookies={vi.fn()}
      onRevealResult={vi.fn()}
      onConnectionStart={vi.fn()}
    />,
  );
  return { start };
}

describe("download browser component entry", () => {
  beforeEach(() => desktop.mockReturnValue(true));
  it("opens optional browser preparation while ordinary downloads remain available", () => {
    const event = vi.fn();
    window.addEventListener(RUNTIME_COMPONENTS_REQUEST_EVENT, event);
    try {
      const { start } = renderDownloader();
      fireEvent.click(screen.getByRole("button", { name: "网页解析组件" }));
      expect((event.mock.calls[0]![0] as CustomEvent).detail).toEqual({
        featureId: "browser-download",
      });
      expect(start).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "开始下载视频" }));
      expect(start).toHaveBeenCalledExactlyOnceWith("download-1");
    } finally {
      window.removeEventListener(RUNTIME_COMPONENTS_REQUEST_EVENT, event);
    }
  });

  it("offers preparation after missing-browser failure without retrying the download", () => {
    const event = vi.fn();
    window.addEventListener(RUNTIME_COMPONENTS_REQUEST_EVENT, event);
    try {
      const { start } = renderDownloader("网页解析组件尚未就绪，请先安装。");
      fireEvent.click(screen.getByRole("button", { name: "准备网页解析组件" }));
      expect(event).toHaveBeenCalledOnce();
      expect(start).not.toHaveBeenCalled();
      expect(screen.getByRole("alert")).toHaveTextContent("网页解析组件尚未就绪");
    } finally {
      window.removeEventListener(RUNTIME_COMPONENTS_REQUEST_EVENT, event);
    }
  });

  it("keeps desktop component actions out of browser previews", () => {
    desktop.mockReturnValue(false);
    renderDownloader();
    expect(screen.queryByRole("button", { name: "网页解析组件" })).not.toBeInTheDocument();
  });
});
