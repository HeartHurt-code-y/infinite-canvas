import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { afterEach, describe, expect, it } from "vitest";
import "./VideoPreparationDialog.css";
import "../../App.css";
import "../../styles/studio.css";

const urls: string[] = [];
afterEach(() => {
  urls.splice(0).forEach((url) => URL.revokeObjectURL(url));
});

// Real decoded metadata is essential: before metadata, a video has a small default
// intrinsic size and does not reproduce the overflowing grid track in this dialog.
async function videoUrl(width: number, height: number): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#246080";
  context.fillRect(0, 0, width, height);
  context.strokeStyle = "#ffffff";
  context.lineWidth = 20;
  context.strokeRect(10, 10, width - 20, height - 20);
  const stream = canvas.captureStream(25);
  const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8" });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => chunks.push(event.data);
  const finished = new Promise<Blob>((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: "video/webm" }));
  });
  recorder.start();
  await new Promise((resolve) => setTimeout(resolve, 100));
  recorder.stop();
  const blob = await finished;
  stream.getTracks().forEach((track) => track.stop());
  const url = URL.createObjectURL(blob);
  urls.push(url);
  return url;
}

function expectFullVideoInsideViewport(video: HTMLVideoElement) {
  const viewport = video.parentElement!;
  const videoBox = video.getBoundingClientRect();
  const viewportBox = viewport.getBoundingClientRect();
  const detail = JSON.stringify({
    source: [video.videoWidth, video.videoHeight],
    video: [videoBox.width, videoBox.height],
    viewport: [viewportBox.width, viewportBox.height],
  });
  expect(getComputedStyle(video).objectFit, detail).toBe("contain");
  expect(videoBox.left, detail).toBeGreaterThanOrEqual(viewportBox.left - 1);
  expect(videoBox.top, detail).toBeGreaterThanOrEqual(viewportBox.top - 1);
  expect(videoBox.right, detail).toBeLessThanOrEqual(viewportBox.right + 1);
  expect(videoBox.bottom, detail).toBeLessThanOrEqual(viewportBox.bottom + 1);
  expect(videoBox.width, detail).toBeCloseTo(viewportBox.width, 0);
  expect(videoBox.height, detail).toBeCloseTo(viewportBox.height, 0);
  expect(viewport.scrollHeight, detail).toBeLessThanOrEqual(viewport.clientHeight + 1);
}

describe("视频准备预览的真实布局", () => {
  it.each([
    [496, 864],
    [854, 480],
    [640, 640],
  ])("完整显示 %i × %i 视频，窗口缩小时仍按比例适配", async (width, height) => {
    await page.viewport(1600, 1000);
    const src = await videoUrl(width, height);
    // Keep the dialog's real grid/viewport structure and production styles;
    // native source preparation and task polling do not participate in layout.
    await render(
      <dialog className="video-preparation" open aria-label="视频准备">
        <header className="video-preparation__header">
          <h2>视频准备</h2>
        </header>
        <div className="video-preparation__body">
          <section className="video-preparation__source" aria-label="原视频与选区">
            <div className="video-preparation__viewport">
              <video src={src} preload="metadata" playsInline aria-label="原视频：布局测试.webm" />
            </div>
            <div className="video-preparation__playback">
              <button type="button">播放</button>
            </div>
          </section>
          <form className="video-preparation__form">
            <label>
              处理方式
              <select>
                <option>准确裁切片段</option>
              </select>
            </label>
          </form>
        </div>
      </dialog>,
    );
    const video = page.getByLabelText("原视频：布局测试.webm").element() as HTMLVideoElement;
    await expect.poll(() => video.videoWidth).toBe(width);
    expect(video.videoHeight).toBe(height);
    expectFullVideoInsideViewport(video);

    for (const [viewportWidth, viewportHeight] of [
      [480, 800],
      [1280, 520],
    ] as const) {
      await page.viewport(viewportWidth, viewportHeight);
      expectFullVideoInsideViewport(video);
      const dialog = page.getByRole("dialog", { name: "视频准备" }).element();
      expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth + 1);
    }
  });
});
