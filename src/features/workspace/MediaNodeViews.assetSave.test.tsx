import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { createQueryClient } from "../../lib/queryClient";
import { CanvasAssetNode } from "./MediaNodeViews";
import type { AssetNodeData } from "./workspaceModel";

function makeAssetNode(overrides: Partial<AssetNodeData> = {}): AssetNodeData {
  return {
    key: "asset-save-test",
    assetId: "local-b64-1",
    providerConnectionId: "",
    source: "local",
    kind: "image",
    name: "sample.png",
    previewUrl: null,
    videoUrl: null,
    x: 0,
    y: 0,
    ...overrides,
  };
}

function renderAsset(node: AssetNodeData, targetCloudProviderConnectionId: string | null = null) {
  const onSaveToLibrary = vi.fn();
  const onNodeDragStart = vi.fn();
  render(
    <QueryClientProvider client={createQueryClient()}>
      <CanvasAssetNode
        node={node}
        edgeCount={0}
        dragging={false}
        onNodeDragStart={onNodeDragStart}
        onConnectionStart={vi.fn()}
        onRemove={vi.fn()}
        onAspectRatioChange={vi.fn()}
        onRefreshMediaUrls={vi.fn()}
        onSaveToLibrary={onSaveToLibrary}
        targetCloudProviderConnectionId={targetCloudProviderConnectionId}
      />
    </QueryClientProvider>,
  );
  const trigger = screen.getByRole("button", { name: /保存素材：/ });
  fireEvent.mouseDown(trigger);
  fireEvent.click(trigger);
  return { onSaveToLibrary, onNodeDragStart, trigger };
}

describe("CanvasAssetNode 保存素材菜单", () => {
  it("本地 Base64 素材可保存到本库，由保存层复用，且不触发节点拖动", () => {
    const { onSaveToLibrary, onNodeDragStart, trigger } = renderAsset(makeAssetNode());
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const local = screen.getByRole("button", { name: "保存到本地素材库" });
    fireEvent.mouseDown(local);
    fireEvent.click(local);
    expect(onSaveToLibrary).toHaveBeenCalledExactlyOnceWith("asset-save-test", "local");
    expect(onNodeDragStart).not.toHaveBeenCalled();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("云端素材也能保存到当前分组，由保存层判断是否复用", () => {
    const { onSaveToLibrary } = renderAsset(
      makeAssetNode({ assetId: "cloud-1", source: "cloud", providerConnectionId: "provider-1" }),
      "provider-1",
    );
    const cloud = screen.getByRole("button", { name: "保存到云端素材库" });
    expect(cloud).toBeEnabled();
    fireEvent.click(cloud);
    expect(onSaveToLibrary).toHaveBeenCalledExactlyOnceWith("asset-save-test", "cloud");
  });

  it("云端素材来自另一供应商时允许保存到当前云端库", () => {
    const { onSaveToLibrary } = renderAsset(
      makeAssetNode({ assetId: "cloud-2", source: "cloud", providerConnectionId: "provider-2" }),
      "provider-1",
    );
    const cloud = screen.getByRole("button", { name: "保存到云端素材库" });
    expect(cloud).toBeEnabled();
    fireEvent.click(cloud);
    expect(onSaveToLibrary).toHaveBeenCalledExactlyOnceWith("asset-save-test", "cloud");
  });

  it("对象存储素材可保存回当前桶，音频卡片也提供保存入口", () => {
    const { onSaveToLibrary } = renderAsset(
      makeAssetNode({ assetId: "staging-job-1", kind: "audio", name: "voice.mp3" }),
    );
    const objectStorage = screen.getByRole("button", { name: "保存到对象存储" });
    expect(objectStorage).toBeEnabled();
    fireEvent.click(objectStorage);
    expect(onSaveToLibrary).toHaveBeenCalledExactlyOnceWith("asset-save-test", "object_storage");
  });

  it("按 Escape 关闭保存菜单并把焦点还给触发按钮", () => {
    const { trigger } = renderAsset(makeAssetNode());
    expect(screen.getByRole("group", { name: /保存素材/ })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("group", { name: /保存素材/ })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
