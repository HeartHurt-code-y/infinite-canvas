import { describe, expect, it } from "vitest";
import {
  composedVideoFileName,
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
});
