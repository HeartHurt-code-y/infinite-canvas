import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
}));

/**
 * 会话内素材预览字节缓存的行为：同一素材只下载一次、并发合并、失败不留负缓存、
 * 缓存身份只跟素材身份走（签名变化不改变身份），且视频正文不进缓存。
 *
 * 每个用例重新 import 模块：缓存是模块级内存，避免用例之间相互污染。
 */
async function loadCacheModule() {
  vi.resetModules();
  return import("./mediaByteCache");
}

function okBytes(): Response {
  return new Response("bytes", { status: 200 });
}

describe("素材预览字节缓存", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("同一素材第二次请求直接命中缓存，不再下载", async () => {
    const cache = await loadCacheModule();
    const fetchMock = vi.fn(() => Promise.resolve(okBytes()));
    vi.stubGlobal("fetch", fetchMock);

    const first = await cache.loadMediaBytes(
      "id-1",
      "image",
      "https://cdn.example.com/a.png?sig=1",
    );
    const second = await cache.loadMediaBytes(
      "id-1",
      "image",
      "https://cdn.example.com/a.png?sig=1",
    );

    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cache.getMediaByteUrl("id-1", "image")).toBe(first);
  });

  it("并发请求同一素材只下载一次", async () => {
    const cache = await loadCacheModule();
    const releases: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          releases.push(resolve);
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const pending = [
      cache.loadMediaBytes("id-2", "image", "https://cdn.example.com/b.png?sig=1"),
      cache.loadMediaBytes("id-2", "image", "https://cdn.example.com/b.png?sig=1"),
    ];
    releases[0]?.(okBytes());
    const [first, second] = await Promise.all(pending);

    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("当前地址加载失败时按来源重试一次：本地副本失败就回到远端，且不会反复重试", async () => {
    const cache = await loadCacheModule();
    const fetchMock = vi.fn(() => Promise.resolve(okBytes()));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() =>
      cache.useMediaByteSource("id-retry", "image", "https://cdn.example.com/r.png?sig=1"),
    );
    await waitFor(() => expect(result.current.fromCache).toBe(true));
    const cachedObjectUrl = cache.getMediaByteUrl("id-retry", "image");
    expect(result.current.url).toBe(cachedObjectUrl);

    // 本地副本渲染失败：先屏蔽这份副本（回到远端地址），并重新下载一次。
    act(() => result.current.retry());
    expect(result.current.fromCache).toBe(false);
    expect(result.current.url).toBe("https://cdn.example.com/r.png?sig=1");

    // 同一个素材不会因为再次点击“重试”而无限触发下载。
    const downloadsAfterFirstRetry = fetchMock.mock.calls.length;
    act(() => result.current.retry());
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(downloadsAfterFirstRetry + 1);
  });

  it("下载失败不写缓存，也不留下永久失败标记", async () => {
    const cache = await loadCacheModule();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("denied", { status: 403 }))
      .mockResolvedValueOnce(okBytes());
    vi.stubGlobal("fetch", fetchMock);

    expect(
      await cache.loadMediaBytes("id-3", "image", "https://cdn.example.com/c.png?sig=stale"),
    ).toBeNull();
    expect(cache.getMediaByteUrl("id-3", "image")).toBeNull();

    // 续签得到新地址后必须能重新下载（负缓存会让素材永久停在「预览不可用」）。
    const recovered = await cache.loadMediaBytes(
      "id-3",
      "image",
      "https://cdn.example.com/c.png?sig=fresh",
    );
    expect(recovered).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("缓存身份只跟素材身份走：签名变化仍命中同一份字节", async () => {
    const cache = await loadCacheModule();
    const fetchMock = vi.fn(() => Promise.resolve(okBytes()));
    vi.stubGlobal("fetch", fetchMock);

    const first = await cache.loadMediaBytes("local-9", "image", "https://cdn/a.png?sig=old");
    const second = await cache.loadMediaBytes("local-9", "image", "https://cdn/a.png?sig=new");

    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("同一素材的图片正文与视频封面是两份不同内容，互不串用", async () => {
    const cache = await loadCacheModule();
    const fetchMock = vi.fn(() => Promise.resolve(okBytes()));
    vi.stubGlobal("fetch", fetchMock);

    const image = await cache.loadMediaBytes("local-9", "image", "https://cdn/a.png");
    const cover = await cache.loadMediaBytes("local-9", "video", "https://cdn/a-cover.jpg");

    expect(image).not.toBe(cover);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(cache.getMediaByteUrl("local-9", "image")).toBe(image);
    expect(cache.getMediaByteUrl("local-9", "video")).toBe(cover);
  });

  it("素材库卡片按素材身份命中，清空后回到未缓存状态", async () => {
    const cache = await loadCacheModule();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(okBytes())),
    );
    const identity = cache.assetMediaByteIdentity({ id: "asset-1", kind: "image" });
    expect(identity).not.toBeNull();

    expect(cache.getMediaByteUrl(identity!.assetId, identity!.kind)).toBeNull();
    const loaded = await cache.loadMediaBytes(
      identity!.assetId,
      identity!.kind,
      "https://cdn/x.jpg",
    );
    expect(cache.getMediaByteUrl(identity!.assetId, identity!.kind)).toBe(loaded);

    cache.clearMediaByteCache();
    expect(cache.getMediaByteUrl(identity!.assetId, identity!.kind)).toBeNull();
    // 缺 ID 的占位条目没有缓存身份。
    expect(cache.assetMediaByteIdentity({ id: "", kind: "image" })).toBeNull();
  });

  it("视频正文不进字节缓存：地址指向视频本体时只服务播放", async () => {
    const cache = await loadCacheModule();
    const fetchMock = vi.fn(() => Promise.resolve(okBytes()));
    vi.stubGlobal("fetch", fetchMock);

    expect(
      await cache.loadMediaBytes("video-1", "video", "https://cdn.example.com/movie.mp4?sig=1"),
    ).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(cache.getMediaByteUrl("video-1", "video")).toBeNull();
    // 封面图（非视频本体）仍然缓存。
    expect(
      await cache.loadMediaBytes("video-1", "video", "https://cdn.example.com/cover.jpg"),
    ).not.toBeNull();
  });

  it("没有素材身份时，空地址不发起请求", async () => {
    const cache = await loadCacheModule();
    const fetchMock = vi.fn(() => Promise.resolve(okBytes()));
    vi.stubGlobal("fetch", fetchMock);

    expect(await cache.loadMediaBytes("", "image", "https://cdn/x.jpg")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("有素材身份但列表没给预览地址时仍按身份取本地导入副本", async () => {
    const cache = await loadCacheModule();
    (window as unknown as Record<string, unknown>)["__TAURI_INTERNALS__"] = {
      convertFileSrc: (path: string) => `asset://localhost/${path}`,
    };
    const fetchMock = vi.fn(() => Promise.resolve(okBytes()));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:imported");

    expect(await cache.loadMediaBytes("asset-1", "image", null)).toBe("blob:imported");
    expect(fetchMock).toHaveBeenCalledWith(
      "asset://localhost/asset-1",
      expect.anything(),
    );
    delete (window as unknown as Record<string, unknown>)["__TAURI_INTERNALS__"];
  });

  it("几十 MB 的大图只走直连渲染：不读进内存，也不再重复探测", async () => {
    const cache = await loadCacheModule();
    const bigImage = () =>
      new Response("bytes", {
        status: 200,
        headers: { "content-length": String(36_852_238) },
      });
    const fetchMock = vi.fn(() => Promise.resolve(bigImage()));
    vi.stubGlobal("fetch", fetchMock);

    // 手机原图级别的素材：响应头一到就判定体积，正文一个字节都不读。
    expect(
      await cache.loadMediaBytes("big-1", "image", "https://cdn.example.com/big.jpg?sig=1"),
    ).toBeNull();
    expect(cache.getMediaByteUrl("big-1", "image")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 已判定太大：同素材不再探第二次，`<img>` 自己直接取这个地址。
    expect(
      await cache.loadMediaBytes("big-1", "image", "https://cdn.example.com/big.jpg?sig=2"),
    ).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const { result } = renderHook(() =>
      cache.useMediaByteSource("big-1", "image", "https://cdn.example.com/big.jpg?sig=2"),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(result.current.fromCache).toBe(false);
    expect(result.current.url).toBe("https://cdn.example.com/big.jpg?sig=2");
  });

  it("恰好在上限内的图片照常进缓存（阈值不能误伤正常素材）", async () => {
    const cache = await loadCacheModule();
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response("bytes", { status: 200, headers: { "content-length": "8388608" } }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const objectUrl = await cache.loadMediaBytes(
      "edge-1",
      "image",
      "https://cdn.example.com/edge.jpg",
    );

    expect(objectUrl).not.toBeNull();
    expect(cache.getMediaByteUrl("edge-1", "image")).toBe(objectUrl);
  });
});
