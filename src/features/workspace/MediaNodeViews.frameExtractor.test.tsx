import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CanvasVideoFrameExtractorNode } from "./MediaNodeViews";
import type {
  FrameExtractorVideoInput,
  OutputNodeData,
  VideoFrameExtractorNodeData,
} from "./workspaceModel";

function makeNode(
  overrides: Partial<VideoFrameExtractorNodeData["config"]> = {},
): VideoFrameExtractorNodeData {
  return {
    key: "frame-extractor-test",
    kind: "frame_extractor",
    x: 0,
    y: 0,
    config: { timestamps: [], videoPath: "", ...overrides },
  };
}

const videoInput: FrameExtractorVideoInput = {
  key: "asset-video",
  name: "sample.mp4",
  src: "sample.mp4",
  finalPath: "C:/videos/sample.mp4",
  sourceLabel: "素材",
  edgeId: "edge-1",
};

const producedFrame: OutputNodeData = {
  key: "output-frame-1",
  resultKey: null,
  sourceNodeId: "frame-extractor-test",
  taskId: "frame-extract-x",
  mediaType: "image",
  origin: "frame_extract",
  finalPath: "C:/下载/抽帧/sample@3.jpg",
  previewSrc: null,
  name: "sample@3.jpg",
  x: 0,
  y: 0,
};

function renderHarness(
  node: VideoFrameExtractorNodeData,
  options: {
    inputs?: readonly FrameExtractorVideoInput[];
    producedFrames?: readonly OutputNodeData[];
    runState?: { status: "running" | "done" | "error" | "cancelled"; progress: number | null; error: string | null };
  } = {},
) {
  const onConfigChange = vi.fn();
  const onStartExtraction = vi.fn();
  const onCancelExtraction = vi.fn();
  const onRemove = vi.fn();
  const onSelect = vi.fn();
  const onNodeDragStart = vi.fn();
  render(
    <CanvasVideoFrameExtractorNode
      node={node}
      inputs={options.inputs ?? []}
      producedFrames={options.producedFrames ?? []}
      selected
      dragging={false}
      runState={
        options.runState
          ? { jobId: "frame-extract-x", preparingEngine: false, ...options.runState }
          : undefined
      }
      onSelect={onSelect}
      onNodeDragStart={onNodeDragStart}
      onRemove={onRemove}
      onConfigChange={onConfigChange}
      onStartExtraction={onStartExtraction}
      onCancelExtraction={onCancelExtraction}
    />,
  );
  return { onConfigChange, onStartExtraction, onCancelExtraction, onRemove };
}

describe("CanvasVideoFrameExtractorNode", () => {
  it("没有视频输入时禁用开始按钮并提示连线", () => {
    renderHarness(makeNode({ timestamps: [3] }));
    const start = screen.getByRole("button", { name: "开始视频抽帧" });
    expect(start).toBeDisabled();
    expect(screen.getByText(/请连入视频或填写视频文件路径/)).toBeTruthy();
  });

  it("输入秒数后实时解析并写回配置", () => {
    const { onConfigChange } = renderHarness(makeNode());
    const input = screen.getByLabelText("抽帧秒数，多个秒数用逗号分隔");
    fireEvent.change(input, { target: { value: "3, 8.5, 3, 0" } });
    // 去重、排序后为 [0, 3, 8.5]
    expect(onConfigChange).toHaveBeenLastCalledWith("frame-extractor-test", {
      timestamps: [0, 3, 8.5],
      videoPath: "",
    });
  });

  it("连接视频且秒数有效时开始按钮可用，点击触发启动回调", () => {
    const { onStartExtraction } = renderHarness(makeNode({ timestamps: [5] }), {
      inputs: [videoInput],
    });
    const start = screen.getByRole("button", { name: "开始视频抽帧" });
    expect(start).toBeEnabled();
    fireEvent.click(start);
    expect(onStartExtraction).toHaveBeenCalledWith("frame-extractor-test");
  });

  it("运行中展示进度并允许取消", () => {
    const { onCancelExtraction } = renderHarness(makeNode({ timestamps: [5] }), {
      inputs: [videoInput],
      runState: { status: "running", progress: 66, error: null },
    });
    expect(screen.getByText(/正在抽帧/)).toBeTruthy();
    const cancel = screen.getByRole("button", { name: "取消视频抽帧" });
    fireEvent.click(cancel);
    expect(onCancelExtraction).toHaveBeenCalledWith("frame-extractor-test");
  });

  it("完成态展示抽出的帧缩略图", () => {
    renderHarness(makeNode({ timestamps: [3] }), {
      inputs: [videoInput],
      producedFrames: [producedFrame],
      runState: { status: "done", progress: 100, error: null },
    });
    expect(screen.getByText(/sample@3\.jpg/)).toBeTruthy();
  });

  it("失败态展示错误信息", () => {
    renderHarness(makeNode({ timestamps: [99] }), {
      inputs: [videoInput],
      runState: { status: "error", progress: null, error: "抽帧秒数超出视频时长" },
    });
    expect(screen.getByText("抽帧秒数超出视频时长")).toBeTruthy();
  });

  it("手动填写视频路径也可作为来源", () => {
    renderHarness(makeNode({ timestamps: [2], videoPath: "C:/videos/other.mp4" }));
    const start = screen.getByRole("button", { name: "开始视频抽帧" });
    expect(start).toBeEnabled();
    expect(screen.getAllByText(/other\.mp4/).length).toBeGreaterThan(0);
  });
});
