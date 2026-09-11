import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AssetUploadRow } from "./AssetLibraryViews";
import type { AssetUploadEntry } from "./workspaceModel";

function buildEntry(overrides: Partial<AssetUploadEntry> = {}): AssetUploadEntry {
  return {
    jobId: "job-1",
    name: "ScreenShot_2026-09-07_192951_026.png",
    kind: "image",
    status: "uploading",
    bytesUploaded: 512,
    bytesTotal: 1024,
    error: null,
    lastAdvancedAt: 1,
    stalled: false,
    destination: "cloud",
    adjustment: null,
    ...overrides,
  };
}

describe("上传行的自动调整说明", () => {
  it("后端归一化过尺寸时展示调整说明，且与报错区分（status 而非 alert）", () => {
    render(
      <AssetUploadRow
        entry={buildEntry({
          adjustment:
            "原图 8000×400 超出平台边长限制，已自动等比缩放为 6000×300（平台要求边长 300–6000px）。",
        })}
        onDismiss={() => undefined}
      />,
    );

    const note = screen.getByText(/已自动等比缩放为 6000×300/);
    expect(note).toBeInTheDocument();
    expect(note).toHaveAttribute("role", "status");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("未做调整时不出现任何说明", () => {
    render(<AssetUploadRow entry={buildEntry()} onDismiss={() => undefined} />);

    expect(screen.getByText("ScreenShot_2026-09-07_192951_026.png")).toBeInTheDocument();
    expect(screen.queryByText(/已自动/)).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
