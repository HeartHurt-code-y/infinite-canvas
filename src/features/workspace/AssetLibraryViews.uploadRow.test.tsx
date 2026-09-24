import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AssetUploadRow } from "./AssetLibraryViews";
import { stagingErrorFullText, type AssetUploadEntry } from "./workspaceModel";

function buildEntry(overrides: Partial<AssetUploadEntry> = {}): AssetUploadEntry {
  return {
    jobId: "job-1",
    name: "ScreenShot_2026-09-07_192951_026.png",
    kind: "image",
    assetId: null,
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

describe("上传行的素材库导入结论", () => {
  /**
   * 「上传素材库」这一段自己的结论，不看对象存储那一段（后者对任何非上传中的
   * 阶段都显示「已完成」，拿整行文本断言会测错东西）。
   */
  const frameName = "ScreenShot_2026-09-07_192951_026.png";

  function uploadRow(): Element | null {
    return screen.getByText(frameName).closest(".asset-upload");
  }

  function assetImportPhase(): HTMLElement {
    return screen.getByText("上传素材库").closest(".asset-upload__phase") as HTMLElement;
  }

  it("拿到素材身份后即使停在 cleaning 也算导入完成", () => {
    // 素材已经入库，只是清理暂存对象没走完：这一行不能一直转圈、更不能报失败。
    render(
      <AssetUploadRow
        entry={buildEntry({
          status: "cleaning",
          assetId: "asset-42",
          error: { kind: "transport", message: "清理暂存对象失败" },
        })}
        onDismiss={() => undefined}
      />,
    );

    expect(uploadRow()).toHaveAttribute("data-state", "cleaning");
    expect(within(assetImportPhase()).getByText("已完成")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /移除上传记录/ })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("没有素材身份的 cleaning 仍是未完成的上传，不给移除入口", () => {
    render(
      <AssetUploadRow
        entry={buildEntry({ status: "cleaning", assetId: null, lastAdvancedAt: Date.now() })}
        onDismiss={() => undefined}
      />,
    );

    expect(uploadRow()).toHaveAttribute("data-state", "cleaning");
    expect(within(assetImportPhase()).getByText("等待中")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /移除上传记录/ })).not.toBeInTheDocument();
  });
});

describe("上传失败提示", () => {
  it("连接超时给出可操作摘要，展开后保留完整原始错误", () => {
    const signedUrl =
      "https://bucket.tos-cn-beijing.volces.com/staging/example.png?X-Tos-Credential=private-key&X-Tos-Signature=secret-marker";
    const originalError = {
      kind: "transport",
      message: `HTTP transport error: error sending request for url (${signedUrl})`,
      details: {
        isConnect: true,
        isTimeout: true,
        source: `error sending request for url (${signedUrl})`,
        rawDebug: `reqwest::Error { url: ${signedUrl}, source: ConnectError }`,
        causes: ["connection refused by proxy"],
      },
    };
    render(
      <AssetUploadRow
        entry={buildEntry({
          status: "failed",
          bytesUploaded: 0,
          error: originalError,
        })}
        onDismiss={() => undefined}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("网络连接超时，请检查网络或代理后重试。");
    expect(stagingErrorFullText(originalError)).toBe(JSON.stringify(originalError, null, 2));
    fireEvent.click(screen.getByRole("button", { name: "展开完整报错" }));
    expect(screen.getByRole("alert")).toHaveTextContent("secret-marker");
    expect(screen.getByRole("alert")).toHaveTextContent("private-key");
    expect(screen.getByRole("alert")).toHaveTextContent('"isTimeout": true');
    expect(screen.getByRole("alert")).toHaveTextContent("connection refused by proxy");
    expect(screen.getByRole("alert")).toHaveTextContent("ConnectError");
  });
});
