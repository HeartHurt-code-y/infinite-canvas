import { describe, expect, it } from "vitest";
import { videoDownloadInputs } from "./videoDownloadInputs";

describe("videoDownloadInputs", () => {
  it("preserves a single manual share phrase for the existing downloader", () => {
    const share = "复制打开抖音 https://v.douyin.com/example/ 查看视频";
    expect(videoDownloadInputs(share, [])).toEqual([share]);
  });

  it("keeps every URL across manual and connected texts in input order", () => {
    expect(
      videoDownloadInputs("https://example.com/1 https://example.com/2", [
        "第一段 https://example.com/2\n第二段 https://example.com/3。",
        "https://example.com/4",
      ]),
    ).toEqual([
      "https://example.com/1",
      "https://example.com/2",
      "https://example.com/3",
      "https://example.com/4",
    ]);
  });

  it("does not treat ordinary connected prose as a URL", () => {
    expect(videoDownloadInputs("", ["沿用第一段视频的风格", "C:/local/video.mp4"])).toEqual([]);
  });
});
