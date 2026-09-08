import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CanvasOutputNode } from "./MediaNodeViews";
import type { OutputNodeData } from "./workspaceModel";

function makeOutputNode(overrides: Partial<OutputNodeData> = {}): OutputNodeData {
  return {
    key: "output-upload-test",
    resultKey: "task-1#0",
    sourceNodeId: "gen-1",
    taskId: "task-1",
    mediaType: "image",
    origin: "generation",
    finalPath: "C:/outputs/sample.png",
    previewSrc: null,
    name: "sample.png",
    x: 0,
    y: 0,
    ...overrides,
  };
}

function renderHarness(
  node: OutputNodeData,
  options: { uploadedToCloud?: boolean; onUploadToCloud?: (key: string) => void } = {},
) {
  render(
    <CanvasOutputNode
      node={node}
      dragging={false}
      onNodeDragStart={vi.fn()}
      onRemove={vi.fn()}
      onAspectRatioChange={vi.fn()}
      onPreview={vi.fn()}
      onConnectionStart={vi.fn()}
      onUploadToCloud={options.onUploadToCloud ?? vi.fn()}
      uploadedToCloud={options.uploadedToCloud ?? false}
      task={null}
      retryInfo={null}
      results={[]}
      rawResponse={null}
      modelLabel={null}
    />,
  );
}

describe("CanvasOutputNode 上传到云端素材库绿色小点", () => {
  it("未上传时上传按钮不显示绿色小点", () => {
    renderHarness(makeOutputNode(), { uploadedToCloud: false });
    const button = screen.getByRole("button", { name: /上传图片产物到云端素材库/ });
    expect(button).not.toHaveClass("is-uploaded");
    expect(button.querySelector(".canvas-asset-node__upload-dot")).toBeNull();
  });

  it("已上传时上传按钮显示绿色小点和已上传样式", () => {
    renderHarness(makeOutputNode(), { uploadedToCloud: true });
    const button = screen.getByRole("button", { name: /已上传到云端素材库/ });
    expect(button).toHaveClass("is-uploaded");
    expect(button.querySelector(".canvas-asset-node__upload-dot")).not.toBeNull();
    expect(button).toHaveAttribute("title", "已上传到云端素材库");
  });

  it("视频产物已上传时也显示绿色小点", () => {
    renderHarness(
      makeOutputNode({
        mediaType: "video",
        finalPath: "C:/outputs/sample.mp4",
        name: "sample.mp4",
      }),
      { uploadedToCloud: true },
    );
    const button = screen.getByRole("button", { name: /已上传到云端素材库/ });
    expect(button).toHaveClass("is-uploaded");
    expect(button.querySelector(".canvas-asset-node__upload-dot")).not.toBeNull();
  });

  it("文本产物不显示上传按钮", () => {
    renderHarness(makeOutputNode({ mediaType: "text", finalPath: null, textContent: "hello" }), {
      uploadedToCloud: true,
    });
    expect(screen.queryByRole("button", { name: /上传|已上传到云端素材库/ })).toBeNull();
  });
});
