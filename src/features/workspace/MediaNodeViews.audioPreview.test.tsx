import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CanvasAssetLightbox, CanvasAssetNode } from "./MediaNodeViews";
import type { AssetNodeData } from "./workspaceModel";

function audioNode(overrides: Partial<AssetNodeData> = {}): AssetNodeData {
  return {
    key: "audio-node",
    assetId: "local-audio-1",
    providerConnectionId: "",
    source: "local",
    kind: "audio",
    name: "voice.mp3",
    previewUrl: "http://localbase64.localhost/local-audio-1",
    videoUrl: null,
    x: 0,
    y: 0,
    ...overrides,
  };
}

describe("画布音频素材试听", () => {
  it("点击音频素材卡片会打开试听，且不会触发图片放大语义", () => {
    const onPreview = vi.fn();
    render(
      <CanvasAssetNode
        node={audioNode()}
        edgeCount={0}
        dragging={false}
        onNodeDragStart={vi.fn()}
        onConnectionStart={vi.fn()}
        onRemove={vi.fn()}
        onAspectRatioChange={vi.fn()}
        onRefreshMediaUrls={vi.fn()}
        onPreview={onPreview}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "试听音频voice.mp3" }));
    expect(onPreview).toHaveBeenCalledExactlyOnceWith("audio-node");
  });

  it.each([
    ["local", "http://localbase64.localhost/local-audio-1"],
    ["cloud", "https://cdn.example.com/voice.mp3"],
  ] as const)("%s 音频在预览中使用播放器，而不是图片标签", (source, previewUrl) => {
    render(<CanvasAssetLightbox node={audioNode({ source, previewUrl })} onClose={vi.fn()} />);

    const player = screen.getByLabelText("voice.mp3", { selector: "audio" });
    expect(player).toHaveAttribute("src", previewUrl);
    expect(player).toHaveAttribute("controls");
    expect(player).toHaveAttribute("autoplay");
    expect(document.querySelector(".history-lightbox img")).not.toBeInTheDocument();
  });
});
