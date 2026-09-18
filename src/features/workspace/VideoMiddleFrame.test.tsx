import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { AutoSizeThumb } from "./MediaNodeViews";
import { VideoMiddleFrame } from "./VideoMiddleFrame";

/** 本地视频绝对路径：JSX 属性值不做反斜杠转义，统一用表达式传入。 */
const LOCAL_VIDEO_PATH = "C:\\clips\\take-01.mp4";
const BROKEN_VIDEO_PATH = "C:\\clips\\broken.mp4";
const OTHER_VIDEO_PATH = "C:\\clips\\other.mp4";

/** jsdom 的 HTMLMediaElement 读数恒为 0/NaN，按帧尺寸与时长覆写只读属性。 */
function stubVideoReadings(
  video: HTMLVideoElement,
  readings: { readonly duration: number; readonly width: number; readonly height: number },
): void {
  Object.defineProperties(video, {
    duration: { value: readings.duration, configurable: true },
    videoWidth: { value: readings.width, configurable: true },
    videoHeight: { value: readings.height, configurable: true },
  });
}

/** 挂载带角色名的容器包裹的被测缩略图，把查询范围限制在被测子树内。 */
function mountMediaThumb(ui: ReactElement): HTMLElement {
  render(
    <div role="group" aria-label="媒体缩略图">
      {ui}
    </div>,
  );
  return screen.getByRole("group", { name: "媒体缩略图" });
}

describe("VideoMiddleFrame", () => {
  it("元数据就绪后 seek 到中间帧，并向调用方上报宽高比", () => {
    const onAspectRatioChange = vi.fn();
    const thumb = mountMediaThumb(
      <VideoMiddleFrame
        src="https://cdn.example.com/task_rwR3Fpg.mp4"
        placeholder={<span>占位</span>}
        onAspectRatioChange={onAspectRatioChange}
      />,
    );
    // 占位内容与视频同帧渲染：中间帧定位前用户先看到占位。
    expect(screen.getByText("占位")).toBeInTheDocument();
    const video = thumb.querySelector<HTMLVideoElement>("video");
    expect(video).not.toBeNull();

    stubVideoReadings(video!, { duration: 8, width: 1920, height: 1080 });
    fireEvent.loadedMetadata(video!);

    expect(video!.currentTime).toBe(4);
    expect(onAspectRatioChange).toHaveBeenCalledWith(1920 / 1080);
    expect(video).not.toHaveClass("is-frame-ready");
    expect(screen.getByText("占位")).toBeInTheDocument();

    fireEvent.seeked(video!);
    expect(video).toHaveClass("is-frame-ready");
    expect(screen.queryByText("占位")).not.toBeInTheDocument();
  });

  it("视频不可读时回调调用方回退占位", () => {
    const onLoadError = vi.fn();
    const thumb = mountMediaThumb(
      <VideoMiddleFrame src="https://cdn.example.com/expired.mp4" onLoadError={onLoadError} />,
    );
    const video = thumb.querySelector("video")!;
    stubVideoReadings(video, { duration: 6, width: 1280, height: 720 });
    fireEvent.loadedMetadata(video);
    fireEvent.seeked(video);
    expect(video).toHaveClass("is-frame-ready");

    fireEvent.error(video);
    expect(onLoadError).toHaveBeenCalledTimes(1);
  });

  it("时长不可用（直播流等）时退回首帧，不停留在占位态", () => {
    const thumb = mountMediaThumb(<VideoMiddleFrame src="https://cdn.example.com/live.mp4" />);
    const video = thumb.querySelector("video")!;
    stubVideoReadings(video, { duration: Number.NaN, width: 1280, height: 720 });

    fireEvent.loadedMetadata(video);
    expect(video).toHaveClass("is-frame-ready");
  });

  it("seek 未完成但已有可绘帧时也揭开封面，避免历史卡片一直灰底", () => {
    const thumb = mountMediaThumb(
      <VideoMiddleFrame src="https://cdn.example.com/seedance.mp4" placeholder={<span>占位</span>} />,
    );
    const video = thumb.querySelector("video")!;
    stubVideoReadings(video, { duration: 12, width: 1280, height: 720 });
    fireEvent.loadedMetadata(video);
    expect(video!.currentTime).toBe(6);
    expect(video).not.toHaveClass("is-frame-ready");

    fireEvent.loadedData(video);
    expect(video).toHaveClass("is-frame-ready");
    expect(screen.queryByText("占位")).not.toBeInTheDocument();
  });
});

describe("AutoSizeThumb 视频参考素材", () => {
  it("视频本体按中间帧显示，容器宽度按原始宽高比自适应", async () => {
    const thumb = mountMediaThumb(
      <AutoSizeThumb previewUrl={LOCAL_VIDEO_PATH} kind="video" height="2.5rem" maxWidth="6rem" />,
    );
    const frame = thumb.querySelector<HTMLElement>(".auto-size-thumb")!;
    const video = frame.querySelector("video")!;
    // 视频本体不再当作图片加载：中间帧定位前先显示类型图标占位。
    expect(frame.querySelector("img")).toBeNull();
    expect(frame.querySelector("svg")).not.toBeNull();
    // 元数据未就绪时保持正方形占位宽度。
    expect(frame.style.getPropertyValue("width")).toBe("2.5rem");

    stubVideoReadings(video, { duration: 10, width: 1280, height: 720 });
    fireEvent.loadedMetadata(video);
    await waitFor(() => {
      expect(parseFloat(frame.style.aspectRatio)).toBeCloseTo(1280 / 720, 3);
    });
    expect(video.currentTime).toBe(5);

    fireEvent.seeked(video);
    expect(video).toHaveClass("is-frame-ready");
    expect(frame.querySelector("svg")).toBeNull();
  });

  it("封面图地址仍按图片加载，失败时回退为类型图标", async () => {
    const thumb = mountMediaThumb(
      <AutoSizeThumb previewUrl="https://cdn.example.com/cover.jpg" kind="video" />,
    );
    const frame = thumb.querySelector<HTMLElement>(".auto-size-thumb")!;
    const image = frame.querySelector("img")!;
    expect(frame.querySelector("video")).toBeNull();

    Object.defineProperties(image, {
      naturalWidth: { value: 800, configurable: true },
      naturalHeight: { value: 800, configurable: true },
    });
    fireEvent.load(image);
    await waitFor(() => {
      expect(parseFloat(frame.style.aspectRatio)).toBeCloseTo(1, 3);
    });

    fireEvent.error(image);
    expect(frame.querySelector("img")).toBeNull();
    expect(frame.querySelector("svg")).not.toBeNull();
  });

  it("视频不可读时回退为类型图标", async () => {
    const thumb = mountMediaThumb(<AutoSizeThumb previewUrl={BROKEN_VIDEO_PATH} kind="video" />);
    const frame = thumb.querySelector<HTMLElement>(".auto-size-thumb")!;
    const video = frame.querySelector("video")!;
    await waitFor(() => {
      expect(video).toHaveAttribute("src", BROKEN_VIDEO_PATH);
    });

    fireEvent.error(video);
    expect(frame.querySelector("video")).toBeNull();
    expect(frame.querySelector("svg")).not.toBeNull();
  });

  it("换源后不再沿用上一份媒体的宽高比", async () => {
    const view = (url: string) => (
      <div role="group" aria-label="媒体缩略图">
        <AutoSizeThumb previewUrl={url} kind="video" />
      </div>
    );
    const { rerender } = render(view(LOCAL_VIDEO_PATH));
    const frame = screen
      .getByRole("group", { name: "媒体缩略图" })
      .querySelector<HTMLElement>(".auto-size-thumb")!;
    stubVideoReadings(frame.querySelector("video")!, {
      duration: 4,
      width: 1600,
      height: 900,
    });
    fireEvent.loadedMetadata(frame.querySelector("video")!);
    await waitFor(() => {
      expect(parseFloat(frame.style.aspectRatio)).toBeCloseTo(1600 / 900, 3);
    });

    rerender(view(OTHER_VIDEO_PATH));
    expect(frame.style.getPropertyValue("aspectRatio")).toBe("");
    expect(frame.style.getPropertyValue("width")).toBe("2rem");
  });
});
