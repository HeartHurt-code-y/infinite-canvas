// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  composedVideoFileName,
  composeVideosInOrder,
  compositionCanvasSize,
  normalizeVideoInputOrder,
  preferredVideoCompositionFormat,
} from "./videoComposer";

describe("视频拼接与合成工具", () => {
  it("保留用户顺序、移除断线项，并把新连线追加到末尾", () => {
    expect(
      normalizeVideoInputOrder(["clip-b", "stale", "clip-b"], ["clip-a", "clip-b", "clip-c"]),
    ).toEqual(["clip-b", "clip-a", "clip-c"]);
  });

  it("优先选择 MP4，系统不支持时回退 WebM", () => {
    expect(
      preferredVideoCompositionFormat({
        isTypeSupported: (mimeType) => mimeType === "video/webm;codecs=vp8,opus",
      }),
    ).toEqual({ mimeType: "video/webm;codecs=vp8,opus", extension: "webm" });
  });

  it("输出尺寸跟随首段并限制在 1080p 以内", () => {
    expect(compositionCanvasSize(3840, 2160)).toEqual({ width: 1920, height: 1080 });
    expect(compositionCanvasSize(1080, 1920)).toEqual({ width: 608, height: 1080 });
  });

  it("生成安全且带时间戳的输出文件名", () => {
    expect(composedVideoFileName("成片:第一版?.mp4", "webm", new Date(2026, 7, 28, 16, 8, 9))).toBe(
      "成片-第一版--20260828-160809.webm",
    );
  });

  it("缺少尺寸时回退到 1280×720", () => {
    expect(compositionCanvasSize(0, 0)).toEqual({ width: 1280, height: 720 });
  });

  it("输入不足两段时拒绝合成", async () => {
    await expect(composeVideosInOrder([])).rejects.toThrow("至少连接 2 段视频后才能合成。");
    await expect(
      composeVideosInOrder([{ key: "clip-a", name: "A", src: "blob:clip-a" }]),
    ).rejects.toThrow("至少连接 2 段视频后才能合成。");
  });

  it("已经取消的信号立刻以 AbortError 退出", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      composeVideosInOrder(
        [
          { key: "clip-a", name: "A", src: "blob:clip-a" },
          { key: "clip-b", name: "B", src: "blob:clip-b" },
        ],
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("系统没有 MediaRecorder 时拒绝合成", async () => {
    vi.stubGlobal("MediaRecorder", undefined);
    await expect(
      composeVideosInOrder([
        { key: "clip-a", name: "A", src: "blob:clip-a" },
        { key: "clip-b", name: "B", src: "blob:clip-b" },
      ]),
    ).rejects.toThrow("当前系统 WebView 不支持视频录制");
  });
});
