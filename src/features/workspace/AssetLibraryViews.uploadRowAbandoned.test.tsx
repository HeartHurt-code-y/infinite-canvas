import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssetUploadRow } from "./AssetLibraryViews";
import {
  UPLOAD_ABANDONED_MS,
  UPLOAD_ABANDONED_TICK_MS,
  type AssetUploadEntry,
} from "./workspaceModel";

function entry(overrides: Partial<AssetUploadEntry> = {}): AssetUploadEntry {
  return {
    jobId: "job-1",
    name: "卡住的上传.png",
    kind: "image",
    status: "importing",
    bytesUploaded: 2048,
    bytesTotal: 2048,
    error: null,
    lastAdvancedAt: 1_000,
    stalled: false,
    destination: "cloud",
    adjustment: null,
    ...overrides,
  };
}

/**
 * 挂载行并推进系统时钟越过僵尸判定窗口，让行内的自检计时器真的跑起来。
 * 用假计时器而不是 mock setInterval：行的判定依据是时间，测的正是"时间到了会怎样"。
 */
function renderRowPastAbandonWindow(overrides: Partial<AssetUploadEntry> = {}) {
  vi.useFakeTimers();
  vi.setSystemTime(1_000 + UPLOAD_ABANDONED_MS + 60_000);
  render(<AssetUploadRow entry={entry(overrides)} onDismiss={vi.fn()} />);
  act(() => {
    vi.advanceTimersByTime(UPLOAD_ABANDONED_TICK_MS);
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("AssetUploadRow 僵尸在途行判定", () => {
  it("长时间无推进的在途行自行落地为已中断，并给出移除入口", () => {
    renderRowPastAbandonWindow();

    const row = screen.getByText("卡住的上传.png").closest(".asset-upload")!;
    expect(row).toHaveAttribute("data-state", "interrupted");
    expect(
      screen.getByRole("button", { name: "移除上传记录：卡住的上传.png" }),
    ).toBeInTheDocument();
  });

  it("仍在窗口内的在途行保持原状，不显示移除入口", () => {
    vi.useFakeTimers();
    // 距离最后一次推进只过了判定窗口的一半：自检跑过也不该落地为中断。
    vi.setSystemTime(1_000 + UPLOAD_ABANDONED_MS / 2);
    render(<AssetUploadRow entry={entry()} onDismiss={vi.fn()} />);
    act(() => {
      vi.advanceTimersByTime(UPLOAD_ABANDONED_TICK_MS * 3);
    });

    const row = screen.getByText("卡住的上传.png").closest(".asset-upload")!;
    expect(row).toHaveAttribute("data-state", "importing");
    expect(
      screen.queryByRole("button", { name: "移除上传记录：卡住的上传.png" }),
    ).not.toBeInTheDocument();
  });

  it("刚开始的上传（preparing）不参与僵尸判定", () => {
    renderRowPastAbandonWindow({ status: "preparing" });

    expect(screen.getByText("卡住的上传.png").closest(".asset-upload")).toHaveAttribute(
      "data-state",
      "preparing",
    );
  });
});
