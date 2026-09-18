import { beforeEach, describe, expect, it, vi } from "vitest";
import { toMediaProxyUrl } from "./mediaProxy";

const mocks = vi.hoisted(() => ({ desktop: true, convertFileSrc: vi.fn() }));
vi.mock("./backend", () => ({ isDesktopRuntime: () => mocks.desktop }));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: mocks.convertFileSrc }));

describe("media proxy URLs", () => {
  beforeEach(() => {
    mocks.desktop = true;
    mocks.convertFileSrc
      .mockReset()
      .mockImplementation(
        (path: string, scheme: string) => `http://${scheme}.localhost/${encodeURIComponent(path)}`,
      );
  });

  it.each([
    "https://cdn.example.com/video.mp4",
    "https://api.example.com/assets/content/video?token=a%2Bb&download=1",
    "https://tos-cn-example.com/video?X-Tos-Signature=a%2Bb",
    "http://127.0.0.1:1234/video.mp4",
  ])("proxies desktop HTTP media without altering signed URL: %s", (source) => {
    const result = toMediaProxyUrl(source);
    expect(mocks.convertFileSrc).toHaveBeenCalledWith("video", "assetproxy");
    expect(result).toBe(`http://assetproxy.localhost/video?src=${encodeURIComponent(source)}`);
  });

  it("normalizes legacy protocol URLs and does not double-wrap converted URLs", () => {
    const source = "https://cdn.example.com/video.mp4?token=a%2Bb";
    const encoded = encodeURIComponent(source);
    expect(toMediaProxyUrl(`assetproxy://video?src=${encoded}`)).toBe(
      `http://assetproxy.localhost/video?src=${encoded}`,
    );
    for (const protocol of ["http", "https"]) {
      const existing = `${protocol}://assetproxy.localhost/video?src=${encoded}`;
      expect(toMediaProxyUrl(existing)).toBe(existing);
    }
  });

  it.each([
    "asset://localhost/C%3A/video.mp4",
    "http://asset.localhost/C%3A%2Fvideo.mp4",
    "https://asset.localhost/C%3A%2Fvideo.mp4",
    "blob:http://localhost/123",
    "data:video/mp4;base64,AAAA",
    "C:/videos/local.mp4",
  ])("keeps local media unchanged: %s", (source) => {
    expect(toMediaProxyUrl(source)).toBe(source);
    expect(mocks.convertFileSrc).not.toHaveBeenCalled();
  });

  it("leaves ordinary browser media URLs usable without native protocols", () => {
    mocks.desktop = false;
    const source = "https://tos-cn-example.com/video?X-Tos-Signature=abc";
    expect(toMediaProxyUrl(source)).toBe(source);
    expect(mocks.convertFileSrc).not.toHaveBeenCalled();
  });

  it("preserves empty source semantics without an asset identity", () => {
    expect(toMediaProxyUrl(null)).toBeNull();
    expect(toMediaProxyUrl(undefined)).toBeNull();
    expect(toMediaProxyUrl("")).toBeNull();
  });

  it("builds an identity-only proxy URL when the supplier list has no preview address", () => {
    expect(toMediaProxyUrl(null, { assetId: "asset-1" })).toBe(
      "http://assetproxy.localhost/video?assetId=asset-1",
    );
    expect(toMediaProxyUrl("https://cdn.example.com/a.png", { assetId: "asset-1" })).toBe(
      `http://assetproxy.localhost/video?src=${encodeURIComponent("https://cdn.example.com/a.png")}&assetId=asset-1`,
    );
  });
});
