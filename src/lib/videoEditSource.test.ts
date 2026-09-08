import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { isDesktopRuntime, toMediaSrc } from "./backend";
import type { ExplicitMediaTarget } from "./backend";
import { prepareVideoEditSource } from "./videoLocalEdit";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./backend", () => ({
  isDesktopRuntime: vi.fn(() => true),
  toMediaSrc: vi.fn((path: string) => `asset-preview:${path}`),
  frontendLog: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(isDesktopRuntime).mockReturnValue(true);
  vi.mocked(invoke)
    .mockReset()
    .mockResolvedValue({ previewId: "owned-preview", path: "C:/cache/video.mp4" });
});

describe("native video edit sources", () => {
  const targets: ExplicitMediaTarget[] = [
    {
      kind: "asset",
      providerConnectionId: "source-provider",
      assetId: "asset-video",
      mediaType: "video",
    },
    { kind: "local_asset", stagingJobId: "staging-video", mediaType: "video" },
    { kind: "local_result", generationTaskId: "generation", resultIndex: 2, mediaType: "video" },
    { kind: "local_file", path: "D:/用户视频/clip.mp4", mediaType: "video" },
    {
      kind: "url",
      url: "https://cdn.example.test/no-cors.mp4?signature=preserved",
      mediaType: "video",
    },
  ];

  it.each(targets)(
    "prepares $kind using original identity rather than an expired thumbnail URL",
    async (target) => {
      const prepared = await prepareVideoEditSource(
        target,
        "https://cdn.example.test/expired-cover.jpg",
      );
      expect(invoke).toHaveBeenCalledWith("prepare_video_edit_source", { target });
      expect(toMediaSrc).toHaveBeenCalledWith("C:/cache/video.mp4");
      expect(prepared.src).toBe("asset-preview:C:/cache/video.mp4");
      await prepared.release();
      await prepared.release();
      expect(
        vi.mocked(invoke).mock.calls.filter(([command]) => command === "release_video_edit_source"),
      ).toEqual([["release_video_edit_source", { previewId: "owned-preview" }]]);
    },
  );

  it("reads a direct HTTP source natively even without a canvas asset identity", async () => {
    await prepareVideoEditSource(undefined, "https://cdn.example.test/no-cors.mp4");
    expect(invoke).toHaveBeenCalledWith("prepare_video_edit_source", {
      target: {
        kind: "url",
        url: "https://cdn.example.test/no-cors.mp4",
        mediaType: "video",
      },
    });
  });

  it("rejects an invalid IPC preview instead of loading an undefined media path", async () => {
    vi.mocked(invoke).mockResolvedValue({ previewId: "preview", path: "" });
    await expect(prepareVideoEditSource(targets[0], "")).rejects.toThrow();
  });

  it("retains blob previews in browser mode and never claims native preparation occurred", async () => {
    vi.mocked(isDesktopRuntime).mockReturnValue(false);
    const prepared = await prepareVideoEditSource(undefined, "blob:demo");
    expect(prepared.src).toBe("blob:demo");
    await prepared.release();
    expect(invoke).not.toHaveBeenCalled();
    await expect(prepareVideoEditSource(targets[0], "")).rejects.toThrow("桌面应用");
  });
});
