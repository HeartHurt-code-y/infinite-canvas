import { render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { createQueryClient } from "../../lib/queryClient";
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
  options: { onUploadToCloud?: (key: string) => void } = {},
) {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <CanvasOutputNode
        node={node}
        dragging={false}
        onNodeDragStart={vi.fn()}
        onRemove={vi.fn()}
        onAspectRatioChange={vi.fn()}
        onPreview={vi.fn()}
        onConnectionStart={vi.fn()}
        onUploadToCloud={options.onUploadToCloud ?? vi.fn()}
        task={null}
        retryInfo={null}
        results={[]}
        rawResponse={null}
        modelLabel={null}
      />
    </QueryClientProvider>,
  );
}

describe("CanvasOutputNode 上传到云端素材库绿色小点（持久化到节点数据）", () => {
  it("未上传时上传按钮不显示绿色小点", () => {
    renderHarness(makeOutputNode({ uploadedToCloud: false }));
    const button = screen.getByRole("button", { name: /上传图片产物到云端素材库/ });
    expect(button).not.toHaveClass("is-uploaded");
    expect(button.querySelector(".canvas-asset-node__upload-dot")).toBeNull();
    expect(document.querySelector(".canvas-asset-node__cloud-badge")).toBeNull();
  });

  it("未设置 uploadedToCloud 时视为未上传（旧文档兼容）", () => {
    renderHarness(makeOutputNode());
    const button = screen.getByRole("button", { name: /上传图片产物到云端素材库/ });
    expect(button).not.toHaveClass("is-uploaded");
    expect(button.querySelector(".canvas-asset-node__upload-dot")).toBeNull();
    expect(document.querySelector(".canvas-asset-node__cloud-badge")).toBeNull();
  });

  it("已上传时上传按钮显示绿色小点和已上传样式", () => {
    renderHarness(makeOutputNode({ uploadedToCloud: true }));
    const button = screen.getByRole("button", { name: /已上传到云端素材库/ });
    expect(button).toHaveClass("is-uploaded");
    expect(button.querySelector(".canvas-asset-node__upload-dot")).not.toBeNull();
    expect(button).toHaveAttribute("title", "已上传到云端素材库");
  });

  it("已上传时名称旁常显绿色小点：上传按钮只在悬停时出现，状态不能只跟着按钮走", () => {
    renderHarness(makeOutputNode({ uploadedToCloud: true, name: "annotation.png" }));
    const badge = document.querySelector(".canvas-asset-node__cloud-badge");
    expect(badge).not.toBeNull();
    expect(badge).toHaveAttribute("title", "已在云端素材库");
    // 小绿点挂在名称行里、紧跟在名称之后，而不是卡片角落。
    expect(badge?.previousElementSibling).toHaveClass("canvas-asset-node__name");
    expect(badge?.previousElementSibling).toHaveTextContent("annotation.png");
  });

  it("视频产物已上传时也显示绿色小点", () => {
    renderHarness(
      makeOutputNode({
        mediaType: "video",
        finalPath: "C:/outputs/sample.mp4",
        name: "sample.mp4",
        uploadedToCloud: true,
      }),
    );
    const button = screen.getByRole("button", { name: /已上传到云端素材库/ });
    expect(button).toHaveClass("is-uploaded");
    expect(button.querySelector(".canvas-asset-node__upload-dot")).not.toBeNull();
  });

  it("文本产物不显示上传按钮", () => {
    renderHarness(
      makeOutputNode({
        mediaType: "text",
        finalPath: null,
        textContent: "hello",
        uploadedToCloud: true,
      }),
    );
    expect(
      screen.queryByRole("button", { name: /上传|已上传到云端素材库/ }),
    ).not.toBeInTheDocument();
  });
});
