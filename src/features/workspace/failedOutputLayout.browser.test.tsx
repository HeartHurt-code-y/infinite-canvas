import { QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import "../../App.css";
import "../../styles/studio.css";
import type { GenerationTaskSummary } from "../../lib/backend";
import { createQueryClient } from "../../lib/queryClient";
import { CanvasOutputNode } from "./MediaNodeViews";
import type { OutputNodeData } from "./workspaceModel";

const node: OutputNodeData = {
  key: "failed-output-layout",
  resultKey: null,
  sourceNodeId: "source-generation",
  taskId: "original-failed-task",
  mediaType: "video",
  origin: "generation",
  finalPath: null,
  name: null,
  x: 0,
  y: 0,
};

const task: GenerationTaskSummary = {
  id: node.taskId,
  canvasId: "layout-canvas",
  sourceNodeId: node.sourceNodeId,
  operation: "video_generation",
  status: "failed",
  queryHealth: "healthy",
  providerConnectionId: "layout-provider",
  providerDisplayNameSnapshot: "布局测试",
  modelDefinitionId: "layout-model",
  remoteModelIdSnapshot: "doubao-seedance-2-0-260128",
  remoteTaskId: null,
  progress: null,
  tokens: null,
  createdAt: 1,
  updatedAt: 1,
  completedAt: 1,
};

function expectSeparate(first: Element, second: Element) {
  const a = first.getBoundingClientRect();
  const b = second.getBoundingClientRect();
  const overlapWidth = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const overlapHeight = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  expect(overlapWidth <= 0 || overlapHeight <= 0).toBe(true);
}

describe("失败产物卡片的操作与完整错误布局", () => {
  it.each([
    { width: 500, zoom: 1, longError: false },
    { width: 220, zoom: 0.64, longError: true },
    { width: 500, zoom: 1.5, longError: true },
  ])("宽度 $width、缩放 $zoom 时按钮不覆盖标题或原始错误", async ({ width, zoom, longError }) => {
    const rawResponse =
      'HTTP 503\n\n{"error":{"code":"model_not_found","message":"分组 asset 下模型 doubao-seedance-2-0-260128 无可用渠道 (distributor) (request id: 20260928111425325725980vavm7M17)","type":"moyu_api_error"}}' +
      (longError ? `\n${"完整原始错误详情 ".repeat(1000)}\n错误末尾` : "");
    const onOpenHistory = vi.fn();
    const onNodeDragStart = vi.fn();
    await render(
      <QueryClientProvider client={createQueryClient()}>
        <div
          className="react-flow__node"
          data-testid="failed-output-layout"
          style={{ transform: `scale(${zoom})`, transformOrigin: "top left" }}
        >
          <CanvasOutputNode
            node={node}
            dragging={false}
            onNodeDragStart={onNodeDragStart}
            onRemove={vi.fn()}
            onAspectRatioChange={vi.fn()}
            onPreview={vi.fn()}
            onConnectionStart={vi.fn()}
            task={task}
            retryInfo={null}
            results={[]}
            rawResponse={rawResponse}
            modelLabel="doubao-seedance-2-0-260128"
            onOpenHistory={onOpenHistory}
          />
        </div>
      </QueryClientProvider>,
    );

    const fixture = page.getByTestId("failed-output-layout").element();
    const card = fixture.querySelector<HTMLElement>(".canvas-asset-node")!;
    card.style.width = `${width}px`;
    const error = page.getByLabelText("完整原始返回").element() as HTMLPreElement;
    const history = page.getByRole("button", { name: "原任务", exact: true });
    const copy = page.getByRole("button", { name: "复制错误信息" });
    const remove = page.getByRole("button", { name: /移除产物卡片/ });
    const title = card.querySelector(".canvas-output-node__state-title")!;
    const metadata = card.querySelector(".canvas-asset-node__meta")!;

    expectSeparate(history.element(), error);
    expectSeparate(history.element(), title);
    expectSeparate(history.element(), metadata);
    expectSeparate(copy.element(), remove.element());
    expectSeparate(copy.element(), error);
    expect(error).toHaveTextContent(rawResponse, {
      normalizeWhitespace: false,
    });
    expect(error.clientHeight).toBeGreaterThan(0);
    expect(error.scrollWidth).toBeLessThanOrEqual(error.clientWidth + 1);
    await expect.element(copy).toBeEnabled();

    if (longError) {
      expect(error.scrollHeight).toBeGreaterThan(error.clientHeight);
      error.scrollTop = error.scrollHeight;
      expect(error.scrollTop + error.clientHeight).toBeGreaterThanOrEqual(error.scrollHeight - 1);
      expectSeparate(history.element(), error);
    }

    await history.click();
    expect(onOpenHistory).toHaveBeenCalledExactlyOnceWith(node.taskId);
    expect(onNodeDragStart).not.toHaveBeenCalled();
  });
});
