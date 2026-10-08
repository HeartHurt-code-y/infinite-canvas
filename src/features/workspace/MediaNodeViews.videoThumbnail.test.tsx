import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mediaClient } from "../../lib/backend";
import { createQueryClient } from "../../lib/queryClient";
import { CanvasOutputNode } from "./MediaNodeViews";
import type { OutputNodeData } from "./workspaceModel";
import { flushCanvasMediaVisibility } from "./mediaPreview";

const originalPath = "C:/outputs/dreamina-original.mp4";
const posterPath = "C:/cache/dreamina-poster.jpg";

function outputNode(finalPath = originalPath): OutputNodeData {
  return {
    key: "output-video-poster",
    resultKey: "task-video#0",
    sourceNodeId: "gen-video",
    taskId: "task-video",
    mediaType: "video",
    origin: "generation",
    finalPath,
    previewSrc: null,
    name: "dreamina-original.mp4",
    x: 0,
    y: 0,
  };
}

function outputElement(node = outputNode(), onPreview = vi.fn()) {
  return (
    <QueryClientProvider client={createQueryClient()}>
      <CanvasOutputNode
        node={node}
        dragging={false}
        onNodeDragStart={vi.fn()}
        onRemove={vi.fn()}
        onAspectRatioChange={vi.fn()}
        onPreview={onPreview}
        onConnectionStart={vi.fn()}
        task={null}
        retryInfo={null}
        results={[]}
        rawResponse={null}
        modelLabel={null}
      />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
  (window as unknown as Record<string, unknown>)["__TAURI_INTERNALS__"] = {
    convertFileSrc: (path: string) => `asset://localhost/${path}`,
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as Record<string, unknown>)["__TAURI_INTERNALS__"];
});

describe("本地视频产物封面", () => {
  it("静止卡片使用原视频生成的 JPEG 封面，悬浮时才打开原视频解码器", async () => {
    const createThumbnail = vi
      .spyOn(mediaClient, "createThumbnail")
      .mockResolvedValue({ path: posterPath, width: 288, height: 512 });
    render(outputElement());
    const visual = screen.getByRole("button", { name: "全屏浏览产物：dreamina-original.mp4" });

    await waitFor(() => expect(createThumbnail).toHaveBeenCalledWith(originalPath, 512));
    await waitFor(() =>
      expect(visual.querySelector("img")).toHaveAttribute("src", `asset://localhost/${posterPath}`),
    );
    expect(visual.querySelector("video")).toBeNull();

    fireEvent.mouseEnter(visual.closest("article") ?? visual.parentElement!);
    await waitFor(() =>
      expect(visual.querySelector("video")).toHaveAttribute(
        "src",
        `asset://localhost/${originalPath}`,
      ),
    );
    fireEvent.mouseLeave(visual.closest("article") ?? visual.parentElement!);
    expect(visual.querySelector("video")).toBeNull();
    expect(visual.querySelector("img")).toHaveAttribute("src", `asset://localhost/${posterPath}`);
  });

  it("换源时丢弃迟到的旧封面，并保持点击原产物的身份", async () => {
    let finishOld!: (value: { path: string; width: number; height: number }) => void;
    const newPath = "C:/outputs/replaced.mp4";
    vi.spyOn(mediaClient, "createThumbnail")
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOld = resolve;
          }),
      )
      .mockResolvedValueOnce({ path: "C:/cache/replaced.jpg", width: 512, height: 288 });
    const onPreview = vi.fn();
    const { rerender } = render(outputElement(outputNode(), onPreview));
    const visual = screen.getByRole("button", { name: "全屏浏览产物：dreamina-original.mp4" });

    rerender(outputElement(outputNode(newPath), onPreview));
    await waitFor(() =>
      expect(visual.querySelector("img")).toHaveAttribute(
        "src",
        "asset://localhost/C:/cache/replaced.jpg",
      ),
    );
    finishOld({ path: posterPath, width: 288, height: 512 });
    await waitFor(() =>
      expect(visual.querySelector("img")).toHaveAttribute(
        "src",
        "asset://localhost/C:/cache/replaced.jpg",
      ),
    );
    fireEvent.click(visual);
    expect(onPreview).toHaveBeenCalledWith("output-video-poster");
  });

  it("原生封面不可用时从本地首帧降级，不再强行定位中点", async () => {
    vi.spyOn(mediaClient, "createThumbnail").mockResolvedValue(null);
    render(outputElement());
    const visual = screen.getByRole("button", { name: "全屏浏览产物：dreamina-original.mp4" });
    await waitFor(() => expect(visual.querySelector("video")).not.toBeNull());
    const video = visual.querySelector("video")!;
    Object.defineProperties(video, {
      duration: { value: 12, configurable: true },
      videoWidth: { value: 720, configurable: true },
      videoHeight: { value: 1280, configurable: true },
    });
    fireEvent.loadedMetadata(video);
    expect(video.currentTime).toBe(0);
    expect(video).toHaveAttribute("preload", "auto");
    fireEvent.loadedData(video);
    expect(visual).not.toHaveTextContent("正在加载预览");
  });

  it("远程临时预览换源后重新等待当前帧，不沿用旧视频就绪状态", () => {
    const first = {
      ...outputNode(),
      finalPath: null,
      previewSrc: "https://cdn.example.com/first.mp4",
    };
    const { rerender } = render(outputElement(first));
    const visual = screen.getByRole("button", { name: "全屏浏览产物：dreamina-original.mp4" });
    fireEvent.loadedData(visual.querySelector("video")!);
    expect(visual).not.toHaveTextContent("正在加载预览");

    rerender(outputElement({ ...first, previewSrc: "https://cdn.example.com/second.mp4" }));
    expect(visual).toHaveTextContent("正在加载预览");
  });

  it("悬浮退出、换源和离开视口时，在移除元素前显式暂停并释放视频来源", async () => {
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause");
    vi.spyOn(mediaClient, "createThumbnail").mockResolvedValue({
      path: posterPath,
      width: 288,
      height: 512,
    });
    const released: Array<{ element: HTMLMediaElement; connected: boolean; src: string | null }> =
      [];
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(function (
      this: HTMLMediaElement,
    ) {
      released.push({ element: this, connected: this.isConnected, src: this.getAttribute("src") });
    });
    const { rerender } = render(outputElement());
    const visual = screen.getByRole("button", { name: "全屏浏览产物：dreamina-original.mp4" });
    await waitFor(() => expect(visual.querySelector("img")).not.toBeNull());

    fireEvent.mouseEnter(visual.parentElement!);
    const firstVideo = visual.querySelector("video")!;
    fireEvent.mouseLeave(visual.parentElement!);
    expect(released).toContainEqual({ element: firstVideo, connected: true, src: null });
    expect(firstVideo).not.toHaveAttribute("src");
    expect(pause).toHaveBeenCalled();

    fireEvent.mouseEnter(visual.parentElement!);
    const oldVideo = visual.querySelector("video")!;
    rerender(outputElement(outputNode("C:/outputs/next.mp4")));
    expect(released).toContainEqual({ element: oldVideo, connected: true, src: null });
    expect(oldVideo).not.toHaveAttribute("src");
    const nextVideo = visual.querySelector("video")!;

    const pane = document.createElement("div");
    pane.className = "canvas-viewport";
    document.body.append(pane);
    const box = (left: number) =>
      ({
        x: left,
        y: 0,
        left,
        top: 0,
        right: left + 800,
        bottom: 600,
        width: 800,
        height: 600,
        toJSON: () => ({}),
      }) as DOMRect;
    const rectangles = vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: Element) {
        return box(this === pane ? 0 : 4000);
      });
    try {
      act(() => flushCanvasMediaVisibility());
      await waitFor(() => expect(visual.querySelector("video")).toBeNull());
      expect(released).toContainEqual({ element: nextVideo, connected: true, src: null });
      expect(nextVideo).not.toHaveAttribute("src");
    } finally {
      rectangles.mockRestore();
      pane.remove();
    }
  });

  it("复制的卡片共享同一个进行中的封面请求，完成后再次请求允许检查文件变化", async () => {
    let finish!: (value: { path: string; width: number; height: number }) => void;
    const request = new Promise<{ path: string; width: number; height: number }>((resolve) => {
      finish = resolve;
    });
    const createThumbnail = vi
      .spyOn(mediaClient, "createThumbnail")
      .mockReturnValueOnce(request)
      .mockResolvedValue({ path: posterPath, width: 288, height: 512 });
    const { unmount } = render(
      <>
        {outputElement()}
        {outputElement({ ...outputNode(), key: "copied-video" })}
      </>,
    );
    expect(createThumbnail).toHaveBeenCalledTimes(1);
    finish({ path: posterPath, width: 288, height: 512 });
    await waitFor(() =>
      expect(
        screen
          .getAllByRole("button", { name: "全屏浏览产物：dreamina-original.mp4" })
          .every((visual) => visual.querySelector("img") != null),
      ).toBe(true),
    );
    unmount();
    render(outputElement());
    await waitFor(() => expect(createThumbnail).toHaveBeenCalledTimes(2));
  });

  it("同一视口的第九张本地 JPEG 视频封面不占视频解码器名额", async () => {
    const createThumbnail = vi
      .spyOn(mediaClient, "createThumbnail")
      .mockImplementation((path) =>
        Promise.resolve({ path: `${path}.jpg`, width: 288, height: 512 }),
      );
    const pane = document.createElement("div");
    pane.className = "canvas-viewport";
    document.body.append(pane);
    const rectangles = vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 800,
      bottom: 600,
      width: 800,
      height: 600,
      toJSON: () => ({}),
    });
    try {
      render(
        <>
          {Array.from({ length: 9 }, (_, index) => (
            <div key={index}>
              {outputElement({
                ...outputNode(`C:/outputs/video-${index}.mp4`),
                key: `video-${index}`,
              })}
            </div>
          ))}
        </>,
      );
      act(() => flushCanvasMediaVisibility());
      await waitFor(() => expect(createThumbnail).toHaveBeenCalledTimes(9));
      const visuals = screen.getAllByRole("button", {
        name: "全屏浏览产物：dreamina-original.mp4",
      });
      expect(visuals.every((visual) => visual.querySelector("video") == null)).toBe(true);
      visuals.forEach((visual) => fireEvent.mouseEnter(visual.parentElement!));
      await waitFor(() =>
        expect(visuals.filter((visual) => visual.querySelector("video") != null)).toHaveLength(8),
      );
      expect(visuals.every((visual) => visual.querySelector("img") != null)).toBe(true);
    } finally {
      rectangles.mockRestore();
      pane.remove();
    }
  });

  it("第九张远程临时预览落盘后释放旧预算登记并立即显示本地封面", async () => {
    const createThumbnail = vi
      .spyOn(mediaClient, "createThumbnail")
      .mockResolvedValue({ path: posterPath, width: 288, height: 512 });
    const pane = document.createElement("div");
    pane.className = "canvas-viewport";
    document.body.append(pane);
    const rectangles = vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 800,
      bottom: 600,
      width: 800,
      height: 600,
      toJSON: () => ({}),
    });
    const view = (saved: boolean) => (
      <>
        {Array.from({ length: 9 }, (_, index) => (
          <div key={index}>
            {outputElement({
              ...outputNode(),
              key: `remote-${index}`,
              finalPath: saved && index === 8 ? originalPath : null,
              previewSrc: `https://cdn.example.com/remote-${index}.mp4`,
            })}
          </div>
        ))}
      </>
    );
    try {
      const { rerender } = render(view(false));
      act(() => flushCanvasMediaVisibility());
      const visuals = screen.getAllByRole("button", {
        name: "全屏浏览产物：dreamina-original.mp4",
      });
      await waitFor(() =>
        expect(visuals.slice(0, 8).every((visual) => visual.querySelector("video") != null)).toBe(
          true,
        ),
      );
      expect(visuals[8]!.querySelector("video")).toBeNull();
      expect(createThumbnail).not.toHaveBeenCalled();

      rerender(view(true));
      await waitFor(() =>
        expect(visuals[8]!.querySelector("img")).toHaveAttribute(
          "src",
          `asset://localhost/${posterPath}`,
        ),
      );
      expect(createThumbnail).toHaveBeenCalledWith(originalPath, 512);
    } finally {
      rectangles.mockRestore();
      pane.remove();
    }
  });
});
