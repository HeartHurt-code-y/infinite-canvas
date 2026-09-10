import { describe, expect, it } from "vitest";

import { isVideoSourceUrl } from "./mediaPreview";

describe("isVideoSourceUrl", () => {
  it("识别常见视频后缀（大小写不敏感，允许查询串）", () => {
    expect(isVideoSourceUrl("C:\\clips\\take-01.mp4")).toBe(true);
    expect(isVideoSourceUrl("https://cdn.example.com/train.MOV")).toBe(true);
    expect(isVideoSourceUrl("https://cdn.example.com/live/index.m3u8?token=1")).toBe(true);
  });

  it("解开本地文件地址与媒体代理的 src 参数后判断", () => {
    expect(isVideoSourceUrl("asset://localhost/C%3A%5Cclips%5Ctake-01.mp4")).toBe(true);
    expect(
      isVideoSourceUrl(
        `http://assetproxy.localhost/video?src=${encodeURIComponent(
          "https://cdn.example.com/task_rwR3Fpg.mp4?sign=abc",
        )}`,
      ),
    ).toBe(true);
    // 代理指向封面图时不误判为视频。
    expect(
      isVideoSourceUrl(
        `http://assetproxy.localhost/video?src=${encodeURIComponent(
          "https://cdn.example.com/cover.jpg",
        )}`,
      ),
    ).toBe(false);
  });

  it("图片、音频、空值与无后缀地址都不算视频", () => {
    expect(isVideoSourceUrl("https://cdn.example.com/cover.jpg")).toBe(false);
    expect(isVideoSourceUrl("https://cdn.example.com/voice.wav")).toBe(false);
    expect(isVideoSourceUrl("asset://localhost/C%3A%5Cclips%5Ctake-01")).toBe(false);
    expect(isVideoSourceUrl("")).toBe(false);
    expect(isVideoSourceUrl(null)).toBe(false);
    expect(isVideoSourceUrl(undefined)).toBe(false);
  });
});
