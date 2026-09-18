import { render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import type { GenerationResultSaveProgress } from "../../lib/backend";
import { createQueryClient } from "../../lib/queryClient";
import { CanvasOutputNode } from "./MediaNodeViews";
import type { OutputNodeData } from "./workspaceModel";

/**
 * 生成产物卡片先以「无媒体」的占位形态落卡（任务进行中），结果返回后才在原地渲染媒体区
 * （WorkspaceApp 用 patchNodes 填充 previewSrc / finalPath，组件实例不重建）。
 * 视口懒挂载的 IntersectionObserver 因此必须在媒体区元素出现时建立：漏建会让卡片永远停在
 * 灰底懒挂载占位（.canvas-asset-node__video-lazy），用户看不到任何视频预览。
 */
function makeVideoOutputNode(overrides: Partial<OutputNodeData> = {}): OutputNodeData {
  return {
    key: "output-lazy",
    resultKey: null,
    sourceNodeId: "gen-lazy",
    taskId: "task-lazy",
    mediaType: "video",
    origin: "generation",
    finalPath: null,
    previewSrc: null,
    name: null,
    x: 0,
    y: 0,
    ...overrides,
  };
}

function outputNodeElement(
  client: QueryClient,
  node: OutputNodeData,
  saveProgress: GenerationResultSaveProgress | null = null,
) {
  return (
    <QueryClientProvider client={client}>
      <CanvasOutputNode
        node={node}
        dragging={false}
        onNodeDragStart={vi.fn()}
        onRemove={vi.fn()}
        onAspectRatioChange={vi.fn()}
        onPreview={vi.fn()}
        onConnectionStart={vi.fn()}
        task={null}
        retryInfo={null}
        results={[]}
        saveProgress={saveProgress}
        rawResponse={null}
        modelLabel={null}
      />
    </QueryClientProvider>
  );
}

describe("画布产物卡片的视口懒挂载", () => {
  it("占位卡片收到结果后挂载视频元素，不再停留在灰底懒挂载占位", async () => {
    const client = createQueryClient();
    const { rerender } = render(outputNodeElement(client, makeVideoOutputNode()));

    // 任务刚提交：只有占位卡片，媒体区还没出现（此时不能建立 IO）。
    expect(screen.queryByRole("button", { name: /全屏浏览产物/ })).not.toBeInTheDocument();

    // 结果返回：同一张卡片原地填充会话内预览地址。
    rerender(
      outputNodeElement(
        client,
        makeVideoOutputNode({ previewSrc: "https://cdn.example.com/out.mp4", name: "out.mp4" }),
      ),
    );

    const visual = screen.getByRole("button", { name: "全屏浏览产物：out.mp4" });
    await waitFor(() =>
      expect(visual.querySelector("video")).toHaveAttribute(
        "src",
        "https://cdn.example.com/out.mp4",
      ),
    );
    expect(visual.querySelector(".canvas-asset-node__video-lazy")).toBeNull();
  });

  it("应用重启后已落盘的视频产物卡片直接挂载本地视频", async () => {
    const client = createQueryClient();
    render(
      outputNodeElement(
        client,
        makeVideoOutputNode({ finalPath: "C:/outputs/saved.mp4", name: "saved.mp4" }),
      ),
    );

    const visual = screen.getByRole("button", { name: "全屏浏览产物：saved.mp4" });
    await waitFor(() => expect(visual.querySelector("video")).not.toBeNull());
    expect(visual.querySelector(".canvas-asset-node__video-lazy")).toBeNull();
  });
});

describe("画布产物卡片的本地保存进度", () => {
  it("远程预览卡片顶栏显示已下/总量/速度/剩余时间，不再只靠底部一行小字", () => {
    render(
      outputNodeElement(
        createQueryClient(),
        makeVideoOutputNode({
          previewSrc: "https://cdn.example.com/out.mp4",
          name: "out.mp4",
        }),
        {
          taskId: "task-lazy",
          resultIndex: 1,
          received: 848 * 1024,
          total: 10 * 1024 * 1024,
          bytesPerSec: 12.8 * 1024,
        },
      ),
    );

    expect(
      screen.getByText("正在保存 848.0 KB / 10.0 MB · 12.8 KB/s · 约 12 分钟"),
    ).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "结果保存进度" })).toHaveAttribute(
      "aria-valuenow",
      "8",
    );
  });

  it("远程预览尚未收到进度事件时也明确显示正在保存", () => {
    render(
      outputNodeElement(
        createQueryClient(),
        makeVideoOutputNode({
          previewSrc: "https://cdn.example.com/out.mp4",
          name: "out.mp4",
        }),
      ),
    );

    expect(screen.getByText("正在保存本地副本")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "结果保存进度" })).toHaveClass(
      "canvas-output-node__progress--indeterminate",
    );
  });
});
