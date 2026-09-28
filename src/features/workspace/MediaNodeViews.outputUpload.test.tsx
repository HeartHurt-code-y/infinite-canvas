import { fireEvent, render, screen } from "@testing-library/react";
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

function renderHarness(node: OutputNodeData) {
  const onUploadToCloud = vi.fn();
  const onUploadToLocal = vi.fn();
  const onUploadToObjectStorage = vi.fn();
  const onNodeDragStart = vi.fn();
  const { unmount } = render(
    <QueryClientProvider client={createQueryClient()}>
      <CanvasOutputNode
        node={node}
        dragging={false}
        onNodeDragStart={onNodeDragStart}
        onRemove={vi.fn()}
        onAspectRatioChange={vi.fn()}
        onPreview={vi.fn()}
        onConnectionStart={vi.fn()}
        onUploadToCloud={onUploadToCloud}
        onUploadToLocal={onUploadToLocal}
        onUploadToObjectStorage={onUploadToObjectStorage}
        task={null}
        retryInfo={null}
        results={[]}
        rawResponse={null}
        modelLabel={null}
      />
    </QueryClientProvider>,
  );
  return { onUploadToCloud, onUploadToLocal, onUploadToObjectStorage, onNodeDragStart, unmount };
}

describe("CanvasOutputNode 保存素材菜单", () => {
  it("图片产物只显示一个入口，三个目标复用原回调且不触发节点拖动", () => {
    const callbacks = renderHarness(makeOutputNode());
    const trigger = screen.getByRole("button", { name: "保存产物：sample.png" });
    fireEvent.mouseDown(trigger);
    fireEvent.click(trigger);
    expect(screen.getByRole("group", { name: "保存素材：sample.png" })).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole("button", { name: "保存到本地素材库" }));
    fireEvent.click(screen.getByRole("button", { name: "保存到本地素材库" }));
    expect(callbacks.onUploadToLocal).toHaveBeenCalledExactlyOnceWith("output-upload-test");
    expect(callbacks.onNodeDragStart).not.toHaveBeenCalled();

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "保存到云端素材库" }));
    expect(callbacks.onUploadToCloud).toHaveBeenCalledExactlyOnceWith("output-upload-test");

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "保存到对象存储" }));
    expect(callbacks.onUploadToObjectStorage).toHaveBeenCalledExactlyOnceWith("output-upload-test");
  });

  it("旧文档未设置上传标记时三个目标都可保存", () => {
    renderHarness(makeOutputNode());
    fireEvent.click(screen.getByRole("button", { name: "保存产物：sample.png" }));
    expect(screen.getByRole("button", { name: "保存到本地素材库" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "保存到云端素材库" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "保存到对象存储" })).toBeEnabled();
    expect(document.querySelector(".canvas-asset-node__cloud-badge")).toBeNull();
  });

  it("曾保存到云端时名称旁保留标记，切换供应商后仍可保存", () => {
    renderHarness(makeOutputNode({ uploadedToCloud: true, name: "annotation.png" }));
    const badge = document.querySelector(".canvas-asset-node__cloud-badge");
    expect(badge).toHaveAttribute("title", "已在云端素材库");
    expect(badge?.previousElementSibling).toHaveClass("canvas-asset-node__name");
    expect(badge?.previousElementSibling).toHaveTextContent("annotation.png");
    fireEvent.click(screen.getByRole("button", { name: "保存产物：annotation.png" }));
    expect(screen.getByRole("button", { name: "保存到云端素材库" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "保存到本地素材库" })).toBeEnabled();
  });

  it("本地与对象存储的保存状态分别保留", () => {
    renderHarness(makeOutputNode({ uploadedToLocal: true, uploadedToObjectStorage: true }));
    expect(document.querySelector(".canvas-asset-node__local-badge")).toHaveAttribute(
      "title",
      "已在本地素材库",
    );
    expect(document.querySelector(".canvas-asset-node__object-storage-badge")).toHaveAttribute(
      "title",
      "已在对象存储",
    );
    fireEvent.click(screen.getByRole("button", { name: "保存产物：sample.png" }));
    expect(screen.getByRole("button", { name: "保存到本地素材库" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "保存到对象存储" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "保存到云端素材库" })).toBeEnabled();
  });

  it("视频产物可保存，文本产物没有保存入口", () => {
    const { unmount } = renderHarness(
      makeOutputNode({
        mediaType: "video",
        finalPath: "C:/outputs/sample.mp4",
        name: "sample.mp4",
      }),
    );
    expect(screen.getByRole("button", { name: "保存产物：sample.mp4" })).toBeInTheDocument();
    unmount();
    renderHarness(makeOutputNode({ mediaType: "text", finalPath: null, textContent: "hello" }));
    expect(screen.queryByRole("button", { name: /保存产物：/ })).not.toBeInTheDocument();
  });
});
