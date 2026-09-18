import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssetFlow } from "./AssetLibraryViews";
import { resetMissingPreviewUrlAttempts } from "./assetPreviewRecovery";
import { AssetSourceDialog } from "./AssetDialogs";
import { clearMediaByteCache } from "./mediaByteCache";
import type { AssetItem } from "./workspaceModel";
import * as backend from "../../lib/backend";
import { toMediaProxyUrl } from "../../lib/mediaProxy";

/**
 * 云端素材预览地址：素材库缩略图能显示、点进详情却「预览不可用」的成因。
 *
 * 同一个供应商签名地址在三条渲染路径上被要求做三件不同的事：
 * - 素材库卡片与画布素材节点把地址交给 `assetproxy` 原生取字节（绕开 WebView 跨域限制），
 *   并按素材身份复用会话内已下载的字节；
 * - 素材详情弹窗却把原始地址直接交给 `<img>`，于是弹出时该地址可能已经取不到（供应商
 *   失效签名、WebView 直接请求被拦），同一份素材在缩略图里可见、在弹窗里报「预览不可用」。
 *
 * 这里锁定统一语义：详情弹窗必须走与卡片完全相同的地址解析，且在会话内已下载过这份
 * 素材时直接复用本地字节，不再因为签名失效而失败。
 */

const mocks = vi.hoisted(() => ({ convertFileSrc: vi.fn(), refreshMedia: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: mocks.convertFileSrc }));
// 只替换预览恢复入口这一条命令；`isDesktopRuntime` 等运行时判定保持真实实现
// （由下面注入的 Tauri 全局决定），避免测出一套与生产不同的地址解析。
vi.mock("../../lib/backend", { spy: true });

const SIGNED_URL = "https://cdn.example.com/a.png?X-Tos-Signature=expired";
const ASSET_ID = "asset-20260914103421-82xww";
const ASSET_NAME = "ScreenShot_2026-09-07_192951_026.png";

function proxyUrl(source: string | null = SIGNED_URL): string {
  const proxied = toMediaProxyUrl(source, { assetId: ASSET_ID });
  if (proxied == null) throw new Error("expected desktop proxy url");
  return proxied;
}

function cloudImageAsset(): AssetItem {
  return {
    id: ASSET_ID,
    kind: "image",
    name: ASSET_NAME,
    meta: "已就绪",
    visual: "portrait",
    previewUrl: SIGNED_URL,
    coverUrl: null,
    videoUrl: null,
    cloudStatus: "ready",
    source: "cloud",
    providerConnectionId: "moyu-prod",
  };
}

/** 素材库卡片渲染的图片地址（图片预览 `src` 或视频封面 `poster`）。 */
function cardMediaSrc(): string | null {
  return (
    document.querySelector<HTMLImageElement>(".asset-card__preview")?.getAttribute("src") ??
    document.querySelector<HTMLVideoElement>(".asset-card video")?.getAttribute("poster") ??
    null
  );
}

function dialogPreview(): HTMLImageElement | null {
  return document.querySelector<HTMLImageElement>(".asset-source-dialog__media");
}

beforeEach(() => {
  clearMediaByteCache();
  resetMissingPreviewUrlAttempts();
  // 生产里预览地址只在桌面 WebView 中经 `assetproxy` 取字节，这里还原该运行时前提。
  (window as unknown as Record<string, unknown>)["__TAURI_INTERNALS__"] = {
    convertFileSrc: mocks.convertFileSrc,
  };
  mocks.convertFileSrc
    .mockReset()
    .mockImplementation((path: string) => `asset://localhost/${path}`);
  mocks.refreshMedia.mockReset().mockResolvedValue(null);
  vi.spyOn(backend, "refreshMediaUrlWithStagingFallback").mockImplementation(mocks.refreshMedia);
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>)["__TAURI_INTERNALS__"];
  vi.unstubAllGlobals();
});

describe("云端素材预览地址在缩略图与详情之间的解析一致性", () => {
  it("卡片按素材身份取字节，详情弹窗不得退回裸供应商地址", async () => {
    const fetched: string[] = [];
    const objectUrl = "blob:asset-image-1";
    vi.stubGlobal("fetch", (input: string) => {
      fetched.push(input);
      return Promise.resolve({
        ok: true,
        headers: { get: () => null },
        blob: () => Promise.resolve({ size: 4 }),
      } as unknown as Response);
    });
    // jsdom 没有 object URL 实现；只替掉这两个静态方法，不能用对象覆盖整个 URL
    // 构造器（代理地址解析依赖 `new URL(...)`）。
    vi.spyOn(URL, "createObjectURL").mockReturnValue(objectUrl);
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);

    render(
      <>
        <AssetFlow
          assets={[cloudImageAsset()]}
          onPreview={() => undefined}
          onDropToCanvas={vi.fn()}
        />
        <AssetSourceDialog
          asset={cloudImageAsset()}
          onClose={() => undefined}
          onDelete={null}
          onRename={null}
        />
      </>,
    );

    // 卡片把供应商签名地址交给原生代理取字节，拿到本地字节后换成稳定地址。
    await waitFor(() => expect(fetched).toEqual([proxyUrl()]));
    await waitFor(() => expect(cardMediaSrc()).toBe(objectUrl));

    // 详情弹窗渲染的就是卡片那一份地址：不再是裸的供应商签名地址，也不再另发请求。
    await waitFor(() => expect(dialogPreview()?.getAttribute("src")).toBe(objectUrl));
    expect(fetched).toHaveLength(1);
  });

  it("详情弹窗的预览失败时仍会按素材身份续签一次", async () => {
    const freshUrl = "https://cdn.example.com/a.png?X-Tos-Signature=fresh";
    mocks.refreshMedia.mockResolvedValue(freshUrl);
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));

    render(
      <AssetSourceDialog
        asset={cloudImageAsset()}
        onClose={() => undefined}
        onDelete={null}
        onRename={null}
      />,
    );
    // 没有可用字节时回落到同一个原生代理地址，而不是裸的供应商地址。
    expect(dialogPreview()?.getAttribute("src")).toBe(proxyUrl());

    fireEvent.error(dialogPreview()!);
    await waitFor(() =>
      expect(mocks.refreshMedia).toHaveBeenCalledWith(cloudImageAsset(), "image", SIGNED_URL),
    );
    await waitFor(() =>
      expect(dialogPreview()?.getAttribute("src")).toBe(proxyUrl(freshUrl)),
    );
  });

  it("素材库卡片的图片预览失败时走同一条恢复入口", async () => {
    const freshUrl = "https://cdn.example.com/a.png?X-Tos-Signature=fresh";
    mocks.refreshMedia.mockResolvedValue(freshUrl);
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));

    render(
      <AssetFlow
        assets={[cloudImageAsset()]}
        onPreview={() => undefined}
        onDropToCanvas={vi.fn()}
      />,
    );
    // 供应商签名地址经原生代理取字节：取不到时回落到代理地址，由代理按对象键兜底。
    await waitFor(() => expect(cardMediaSrc()).toBe(proxyUrl()));

    fireEvent.error(document.querySelector<HTMLImageElement>(".asset-card__preview")!);
    // 卡片与画布节点、详情弹窗共用同一个恢复入口：上游回放导入时的死地址时，
    // 由它继续按对象键重签暂存副本，而不是停在「预览不可用」。
    await waitFor(() =>
      expect(mocks.refreshMedia).toHaveBeenCalledWith(cloudImageAsset(), "image", SIGNED_URL),
    );
    await waitFor(() => expect(cardMediaSrc()).toBe(proxyUrl(freshUrl)));
  });

  it("列表项没有预览地址时按素材身份补取一次", async () => {
    const freshUrl = "https://cdn.example.com/a.png?X-Tos-Signature=fresh";
    mocks.refreshMedia.mockResolvedValue(freshUrl);
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));

    render(
      <AssetFlow
        assets={[{ ...cloudImageAsset(), previewUrl: null }]}
        onPreview={() => undefined}
        onDropToCanvas={vi.fn()}
      />,
    );

    // 直接按「没有地址」渲染会让这类素材永远没有预览：必须先补取一次。
    await waitFor(() =>
      expect(mocks.refreshMedia).toHaveBeenCalledWith(expect.anything(), "image", null),
    );
    await waitFor(() => expect(cardMediaSrc()).toBe(proxyUrl(freshUrl)));
  });

  it("刚入库、列表还没有预览地址时按素材身份取本地副本，不立刻显示预览不可用", async () => {
    const objectUrl = "blob:imported-preview";
    vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
      expect(String(input)).toContain(ASSET_ID);
      expect(String(input)).not.toContain("src=");
      return Promise.resolve({
        ok: true,
        headers: { get: () => null },
        blob: () => Promise.resolve({ size: 4 }),
      } as unknown as Response);
    });
    vi.spyOn(URL, "createObjectURL").mockReturnValue(objectUrl);

    render(
      <AssetFlow
        assets={[{ ...cloudImageAsset(), previewUrl: null }]}
        onPreview={() => undefined}
        onDropToCanvas={vi.fn()}
      />,
    );

    expect(screen.queryByText("预览不可用")).not.toBeInTheDocument();
    await waitFor(() => expect(cardMediaSrc()).toBe(objectUrl));
  });

  it("预览地址加载失败后本地字节到达时不再停在预览不可用", async () => {
    let release: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:recovered-preview");

    render(
      <AssetFlow
        assets={[cloudImageAsset()]}
        onPreview={() => undefined}
        onDropToCanvas={vi.fn()}
      />,
    );
    await waitFor(() => expect(cardMediaSrc()).toBe(proxyUrl()));

    fireEvent.error(document.querySelector<HTMLImageElement>(".asset-card__preview")!);
    release?.({
      ok: true,
      headers: { get: () => null },
      blob: () => Promise.resolve({ size: 4 }),
    } as unknown as Response);

    await waitFor(() => expect(cardMediaSrc()).toBe("blob:recovered-preview"));
    expect(screen.queryByText("预览不可用")).not.toBeInTheDocument();
  });
});
