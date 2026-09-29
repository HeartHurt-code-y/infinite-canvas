import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mediaClient } from "../../lib/backend";
import { createQueryClient } from "../../lib/queryClient";
import { CanvasOutputNode } from "./MediaNodeViews";
import type { OutputNodeData } from "./workspaceModel";

const originalPath = "C:/outputs/full-size.png";
const thumbnailPath = "C:/cache/full-size-thumb.jpg";

function outputNode(): OutputNodeData {
  return {
    key: "output-image-thumbnail",
    resultKey: "task-image#0",
    sourceNodeId: "gen-image",
    taskId: "task-image",
    mediaType: "image",
    origin: "generation",
    finalPath: originalPath,
    previewSrc: null,
    name: "full-size.png",
    x: 0,
    y: 0,
  };
}

function renderOutput(onPreview = vi.fn()) {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <CanvasOutputNode
        node={outputNode()}
        dragging={false}
        onNodeDragStart={vi.fn()}
        onRemove={vi.fn()}
        onAspectRatioChange={vi.fn()}
        onPreview={onPreview}
        onConnectionStart={vi.fn()}
        task={null}
        retryInfo={null}
        results={[]}
        rawResponse={null}
        modelLabel={null}
      />
    </QueryClientProvider>,
  );
  return { onPreview, visual: screen.getByRole("button", { name: "全屏浏览产物：full-size.png" }) };
}

beforeEach(() => {
  (window as unknown as Record<string, unknown>)["__TAURI_INTERNALS__"] = {
    convertFileSrc: (path: string) => `asset://localhost/${path}`,
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as Record<string, unknown>)["__TAURI_INTERNALS__"];
});

describe("画布图片产物缩略图", () => {
  it("缩略图尚未完成时不让卡片解码原图，完成后只显示小图", async () => {
    let finish!: (value: { path: string; width: number; height: number }) => void;
    const request = new Promise<{ path: string; width: number; height: number }>((resolve) => {
      finish = resolve;
    });
    const createThumbnail = vi.spyOn(mediaClient, "createThumbnail").mockReturnValue(request);
    const { visual } = renderOutput();

    await waitFor(() => expect(createThumbnail).toHaveBeenCalledWith(originalPath, 512));
    expect(visual.querySelector("img")).toBeNull();
    expect(visual).toHaveTextContent("正在加载预览");

    finish({ path: thumbnailPath, width: 512, height: 384 });
    await waitFor(() =>
      expect(visual.querySelector("img")).toHaveAttribute(
        "src",
        `asset://localhost/${thumbnailPath}`,
      ),
    );
    expect(visual.querySelector("img")?.getAttribute("src")).not.toContain(originalPath);
  });

  it("不支持缩放时保持卡片可点开原图，但卡片自身不加载原图", async () => {
    vi.spyOn(mediaClient, "createThumbnail").mockResolvedValue(null);
    const { onPreview, visual } = renderOutput();

    await waitFor(() => expect(visual).toHaveTextContent("预览不可用"));
    expect(visual.querySelector("img")).toBeNull();
    fireEvent.click(visual);
    expect(onPreview).toHaveBeenCalledWith("output-image-thumbnail");
  });
});
