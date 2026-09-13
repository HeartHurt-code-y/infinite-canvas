import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetNodeData } from "./workspaceModel";

/**
 * 本地素材预览续签登记表的行为：纯函数判定过期、批量续签去重并回写、渲染期取新地址，
 * 以及「续签在途时把预览失败推迟为加载中」。
 *
 * 用 `vi.resetModules()` 在每个用例前重新 import 模块，登记表是模块级内存，
 * 这样无需在测试间手工清理（生产代码只在切换画布时清空）。
 */
async function loadModules(
  refresh: (
    asset: { readonly id: string; readonly source?: string | null },
    mediaType: string,
  ) => Promise<string | null>,
) {
  vi.resetModules();
  vi.doMock("../../lib/backend", () => ({ refreshAssetItemMediaUrl: refresh }));
  const media = await import("./localAssetMedia");
  return { media };
}

function assetNode(overrides: Partial<AssetNodeData> = {}): AssetNodeData {
  return {
    key: "node-1",
    assetId: "local-asset-1",
    providerConnectionId: "",
    source: "local",
    kind: "image",
    name: "本地素材.png",
    previewUrl: null,
    videoUrl: null,
    x: 0,
    y: 0,
    ...overrides,
  };
}

const TOS_DATE = "X-Tos-Date=20260912T100000Z";
const TOS_SIGN = "X-Tos-Algorithm=TOS4-HMAC-SHA256&X-Tos-Signature=abc";
const now = Date.UTC(2026, 8, 13, 5, 0, 0);

describe("本地素材预览续签登记表", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("只按 TOS 签名参数判定过期，无法识别的地址不当作过期", async () => {
    const { media } = await loadModules(() => Promise.resolve(null));
    // 签发 2026-09-12T10:00:00Z、有效期 1 小时 → 2026-09-13T05:00:00Z 已过期。
    expect(
      media.signedUrlExpired(
        `https://tos.example.com/a.png?${TOS_DATE}&X-Tos-Expires=3600&${TOS_SIGN}`,
        now,
      ),
    ).toBe(true);
    expect(
      media.signedUrlExpired(
        `https://tos.example.com/a.png?X-Tos-Date=20260913T040000Z&X-Tos-Expires=3600&${TOS_SIGN}`,
        now,
      ),
    ).toBe(true);
    // 有效期边界按「到达即过期」处理；还差 1 秒时仍可用。
    expect(
      media.signedUrlExpired(
        `https://tos.example.com/a.png?X-Tos-Date=20260913T040001Z&X-Tos-Expires=3600&${TOS_SIGN}`,
        now,
      ),
    ).toBe(false);
    // 其他供应商 / 无签名地址：不猜语义，交给 onError 自愈路径。
    expect(media.signedUrlExpired("https://cdn.example.com/a.png?sign=stale", now)).toBe(false);
    expect(media.signedUrlExpired("https://cdn.example.com/a.png", now)).toBe(false);
    expect(media.signedUrlExpired(null, now)).toBe(false);
    expect(media.signedUrlExpired("", now)).toBe(false);
  });

  it("按素材身份批量续签：同一素材只请求一次，成功结果一次性回写", async () => {
    const refresh = vi.fn(
      (asset: { readonly id: string; readonly source?: string | null }, kind: string) =>
        Promise.resolve(`https://tos.example.com/${asset.id}-${kind}.png?X-Tos-Date=fresh`),
    );
    const { media } = await loadModules(refresh);

    const resolved: Array<ReadonlyMap<string, string>> = [];
    media.prefetchLocalAssetMedia(
      [
        { assetId: "local-1", kind: "image" },
        { assetId: "local-1", kind: "image" },
        { assetId: "local-2", kind: "video" },
        { assetId: "", kind: "image" },
      ],
      (fresh) => resolved.push(fresh),
    );

    await waitFor(() => expect(resolved).toHaveLength(1));
    expect(refresh).toHaveBeenCalledTimes(2);
    // 本地素材必须带 source=local，否则会被当成云端素材去回读供应商记录。
    expect(refresh.mock.calls.map(([asset, kind]) => [asset.id, asset.source, kind])).toEqual([
      ["local-1", "local", "image"],
      ["local-2", "local", "video"],
    ]);
    expect([...resolved[0]!.entries()].sort()).toEqual([
      ["local-1:image", "https://tos.example.com/local-1-image.png?X-Tos-Date=fresh"],
      ["local-2:video", "https://tos.example.com/local-2-video.png?X-Tos-Date=fresh"],
    ]);
    // 登记表已生效：节点里那份过期地址被替换。
    expect(
      media.localAssetNodeMediaUrl(
        assetNode({
          assetId: "local-1",
          previewUrl: "https://tos.example.com/stale.png?X-Tos-Expires=3600",
        }),
      ),
    ).toBe("https://tos.example.com/local-1-image.png?X-Tos-Date=fresh");
    // 未登记（例如未续签成功）的素材仍用节点自带地址。
    expect(
      media.localAssetNodeMediaUrl(
        assetNode({ assetId: "local-unknown", previewUrl: "https://tos.example.com/other.png" }),
      ),
    ).toBe("https://tos.example.com/other.png");
  });

  it("没有本地素材节点时不发请求，也不回调", async () => {
    const refresh = vi.fn(() => Promise.resolve("https://tos.example.com/x.png"));
    const { media } = await loadModules(refresh);
    const resolved = vi.fn();
    const cancel = media.prefetchLocalAssetMedia([{ assetId: "", kind: "image" }], resolved);
    cancel();
    await Promise.resolve();
    expect(refresh).not.toHaveBeenCalled();
    expect(resolved).not.toHaveBeenCalled();
  });

  it("续签失败时不写登记表，节点继续用自带地址（交给 onError 自愈路径）", async () => {
    const { media } = await loadModules(() => Promise.reject(new Error("offline")));
    const resolved = vi.fn();
    media.prefetchLocalAssetMedia([{ assetId: "local-3", kind: "image" }], resolved);
    await waitFor(() => expect(media.localAssetMediaRefreshing("local-3", "image")).toBe(false));
    expect(resolved).not.toHaveBeenCalled();
    expect(
      media.localAssetNodeMediaUrl(
        assetNode({ assetId: "local-3", previewUrl: "https://x/stale" }),
      ),
    ).toBe("https://x/stale");
  });

  it("续签在途时报告 pending，完成后回落为 false", async () => {
    const releasers: Array<(url: string) => void> = [];
    const { media } = await loadModules(
      () =>
        new Promise<string>((resolve) => {
          releasers.push(resolve);
        }),
    );
    const { result } = renderHook(() => media.useLocalAssetMediaRefreshState("local-4", "image"));
    expect(result.current).toBe(false);

    const pending = media.refreshLocalAssetPreviewUrl("local-4", "image");
    await waitFor(() => expect(result.current).toBe(true));

    releasers[0]?.("https://tos.example.com/local-4.png?X-Tos-Date=fresh");
    await pending;
    await waitFor(() => expect(result.current).toBe(false));
    expect(media.localAssetNodeMediaUrl(assetNode({ assetId: "local-4" }))).toBe(
      "https://tos.example.com/local-4.png?X-Tos-Date=fresh",
    );
  });
});
