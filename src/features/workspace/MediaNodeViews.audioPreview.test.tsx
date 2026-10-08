import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import {
  CanvasAssetLightbox,
  CanvasAssetNode,
  CanvasOutputLightbox,
  CanvasOutputNode,
} from "./MediaNodeViews";
import {
  outputGenerationInput,
  outputNodeReferenceTarget,
  type AssetNodeData,
  type OutputNodeData,
} from "./workspaceModel";

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
  const preparedAudio: OutputNodeData = {
    key: "prepared-audio",
    resultKey: null,
    taskId: "video-preparation-stable-job",
    sourceNodeId: "video-source",
    origin: "video_preparation",
    mediaType: "audio",
    finalPath: "C:/media/jobs/stable-job/voice.wav",
    name: "第01集_对白.wav",
    x: 0,
    y: 0,
  };
  it("视频准备音频沿用本地稳定引用，改名后仍可作为音频输入", () => {
    const renamed = { ...preparedAudio, name: "第01集_新版对白.wav" };
    expect(outputNodeReferenceTarget(renamed)).toEqual({
      kind: "local_file",
      path: preparedAudio.finalPath,
      mediaType: "audio",
      canvasNodeKey: preparedAudio.key,
    });
    expect(outputGenerationInput(renamed)).toMatchObject({
      name: renamed.name,
      kind: "audio",
      target: { path: preparedAudio.finalPath },
    });
  });
  it("音频产物使用波形卡片与音频播放器，不解码为图片", () => {
    const onPreview = vi.fn();
    const { unmount } = render(
      <QueryClientProvider client={new QueryClient()}>
        <CanvasOutputNode
          node={preparedAudio}
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
    fireEvent.click(screen.getByRole("button", { name: "全屏浏览产物：第01集_对白.wav" }));
    expect(onPreview).toHaveBeenCalledExactlyOnceWith(preparedAudio.key);
    expect(document.querySelector(".canvas-asset-node--output img")).toBeNull();
    unmount();
    render(<CanvasOutputLightbox node={preparedAudio} onClose={vi.fn()} />);
    expect(screen.getByLabelText(preparedAudio.name!, { selector: "audio" })).toHaveAttribute(
      "controls",
    );
    expect(document.querySelector(".history-lightbox img")).toBeNull();
  });
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
