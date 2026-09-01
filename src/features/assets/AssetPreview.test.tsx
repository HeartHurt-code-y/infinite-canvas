import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssetPreview, PREVIEW_REFRESH_LEAD_MS, type ResolveAssetPreview } from "./AssetPreview";

describe("AssetPreview", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("refreshes an expired preview URL instead of leaving a broken image", async () => {
    const resolvePreview = vi
      .fn<ResolveAssetPreview>()
      .mockResolvedValueOnce({ url: "https://example.test/expired", expiresAt: null })
      .mockResolvedValueOnce({ url: "https://example.test/fresh", expiresAt: null });

    render(<AssetPreview assetId="asset-1" alt="参考图片" resolvePreview={resolvePreview} />);

    const expiredImage = await screen.findByRole("img", { name: "参考图片" });
    fireEvent.error(expiredImage);

    await waitFor(() => {
      expect(resolvePreview).toHaveBeenCalledTimes(2);
    });
    expect(resolvePreview).toHaveBeenLastCalledWith("asset-1", true);
    expect(screen.getByRole("img", { name: "参考图片" })).toHaveAttribute(
      "src",
      "https://example.test/fresh",
    );
  });

  it("stops automatic retries when refresh returns the same broken URL", async () => {
    const brokenPreview = { url: "https://example.test/broken", expiresAt: null };
    const resolvePreview = vi
      .fn<ResolveAssetPreview>()
      .mockResolvedValueOnce(brokenPreview)
      .mockResolvedValueOnce(brokenPreview);

    render(<AssetPreview assetId="asset-1" alt="参考图片" resolvePreview={resolvePreview} />);

    fireEvent.error(await screen.findByRole("img", { name: "参考图片" }));

    expect(
      await screen.findByText("素材预览暂时不可用，素材和画布连线仍然安全。"),
    ).toBeInTheDocument();
    expect(resolvePreview).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("img", { name: "参考图片" })).not.toBeInTheDocument();
  });

  it("allows a manual retry after automatic refresh fails", async () => {
    const resolvePreview = vi
      .fn<ResolveAssetPreview>()
      .mockResolvedValueOnce({ url: "https://example.test/expired", expiresAt: null })
      .mockRejectedValueOnce(new Error("temporary network failure"))
      .mockResolvedValueOnce({ url: "https://example.test/recovered", expiresAt: null });

    render(<AssetPreview assetId="asset-1" alt="参考图片" resolvePreview={resolvePreview} />);

    fireEvent.error(await screen.findByRole("img", { name: "参考图片" }));
    fireEvent.click(await screen.findByRole("button", { name: "重试预览" }));

    expect(await screen.findByRole("img", { name: "参考图片" })).toHaveAttribute(
      "src",
      "https://example.test/recovered",
    );
    expect(resolvePreview).toHaveBeenCalledTimes(3);
  });

  it("refreshes shortly before a signed URL expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T10:00:00Z"));

    const resolvePreview = vi
      .fn<ResolveAssetPreview>()
      .mockResolvedValueOnce({
        url: "https://example.test/expiring",
        expiresAt: Date.now() + PREVIEW_REFRESH_LEAD_MS + 1_000,
      })
      .mockResolvedValueOnce({ url: "https://example.test/renewed", expiresAt: null });

    render(<AssetPreview assetId="asset-1" alt="参考图片" resolvePreview={resolvePreview} />);

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole("img", { name: "参考图片" })).toHaveAttribute(
      "src",
      "https://example.test/expiring",
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(resolvePreview).toHaveBeenLastCalledWith("asset-1", true);
    expect(screen.getByRole("img", { name: "参考图片" })).toHaveAttribute(
      "src",
      "https://example.test/renewed",
    );
  });
});
