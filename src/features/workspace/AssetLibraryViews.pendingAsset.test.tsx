// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AssetFlow } from "./AssetLibraryViews";
import type { AssetItem } from "./workspaceModel";

function asset(overrides: Partial<AssetItem> = {}): AssetItem {
  return {
    id: "asset-ready",
    kind: "image",
    name: "已就绪封面",
    meta: "已就绪",
    visual: "portrait",
    previewUrl: "https://cdn.example/ready.png",
    source: "cloud",
    cloudStatus: "ready",
    providerConnectionId: "provider",
    ...overrides,
  };
}

describe("素材 ID 尚未返回的云端素材", () => {
  it("显示云端处理中，并且不能预览、拖入或点选", () => {
    const onPreview = vi.fn();
    const onDrop = vi.fn();
    const onTogglePick = vi.fn();
    const pending = asset({
      id: "task-20260922091628-d59f46b5",
      reviewTaskId: "task-20260922091628-d59f46b5",
      name: "审核中的封面",
      cloudStatus: "processing",
      kind: "video",
      videoUrl: "https://cdn.example/pending.mp4",
    });

    render(
      <AssetFlow
        assets={[pending, asset()]}
        multiSelect
        onPreview={onPreview}
        onDropToCanvas={onDrop}
        onTogglePick={onTogglePick}
      />,
    );

    const blocked = screen.getByRole("button", { name: "云端处理中，暂不可用：审核中的封面" });
    expect(blocked).toBeDisabled();
    expect(blocked.querySelector(".asset-card__status")).toHaveTextContent("云端处理中");
    expect(blocked.querySelector(".asset-card__status")).toHaveAttribute(
      "data-state",
      "processing",
    );
    expect(
      screen.queryByRole("button", { name: "预览视频素材详情：审核中的封面" }),
    ).not.toBeInTheDocument();

    fireEvent.click(blocked);
    fireEvent.pointerDown(blocked, { clientX: 0, clientY: 0, button: 0, isPrimary: true });
    expect(onPreview).not.toHaveBeenCalled();
    expect(onTogglePick).not.toHaveBeenCalled();
    expect(onDrop).not.toHaveBeenCalled();

    const ready = screen.getByRole("button", { name: "选择图片素材：已就绪封面" });
    expect(ready).toBeEnabled();
    expect(ready.querySelector(".asset-card__status")).toBeNull();
  });
});
