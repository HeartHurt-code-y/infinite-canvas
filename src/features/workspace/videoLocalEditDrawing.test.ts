import { afterEach, describe, expect, it, vi } from "vitest";
import {
  VIDEO_EDIT_THUMBNAIL_RESOLUTION,
  captureVideoEditFrameThumbnail,
  describeVideoEditMark,
  sameVideoEditFrame,
  drawVideoEditMarks,
  exportVideoLocalEditFrame,
  formatVideoEditTime,
  isVisibleVideoEditMark,
  newVideoEditMarkId,
  videoEditMarkBadge,
  videoEditMarkBounds,
  videoEditMarkLabel,
  videoEditMarkThumbnailGeometry,
  videoEditMarkThumbnailResolution,
  videoEditPointFromClient,
  type VideoEditMark,
} from "./videoLocalEditDrawing";

const rectangle: VideoEditMark = {
  id: "mark-rectangle",
  timeSeconds: 0,
  kind: "rectangle",
  color: "#ff4865",
  points: [
    { x: 0.75, y: 0.8 },
    { x: 0.25, y: 0.2 },
  ],
};

function drawingContext() {
  return {
    save: vi.fn(),
    restore: vi.fn(),
    drawImage: vi.fn(),
    strokeRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    fillText: vi.fn(),
  };
}

afterEach(() => vi.restoreAllMocks());

describe("video local edit drawing", () => {
  it("maps contained landscape and portrait frames, clamping letterbox points to the frame edge", () => {
    const bounds = { left: 10, top: 20, width: 400, height: 400 };
    expect(videoEditPointFromClient({ x: 210, y: 220 }, bounds, 1920, 1080)).toEqual({
      x: 0.5,
      y: 0.5,
    });
    expect(videoEditPointFromClient({ x: 210, y: 30 }, bounds, 1920, 1080)).toEqual({
      x: 0.5,
      y: 0,
    });
    expect(videoEditPointFromClient({ x: 20, y: 220 }, bounds, 1080, 1920)).toEqual({
      x: 0,
      y: 0.5,
    });
    expect(videoEditPointFromClient({ x: 153.75, y: 120 }, bounds, 1080, 1920)).toEqual({
      x: 0.25,
      y: 0.25,
    });
    expect(videoEditPointFromClient({ x: 999, y: -20 }, bounds, 1920, 1080)).toEqual({
      x: 1,
      y: 0,
    });
    expect(videoEditPointFromClient({ x: 1, y: 1 }, bounds, 0, 1080)).toBeNull();
  });

  it("rejects clicks and degenerate marks while accepting rectangles and curved strokes", () => {
    expect(isVisibleVideoEditMark(rectangle)).toBe(true);
    expect(
      isVisibleVideoEditMark({
        ...rectangle,
        points: [
          { x: 0.1, y: 0.1 },
          { x: 0.1, y: 0.8 },
        ],
      }),
    ).toBe(false);
    expect(
      isVisibleVideoEditMark({ ...rectangle, kind: "freehand", points: [{ x: 0.1, y: 0.1 }] }),
    ).toBe(false);
    expect(
      isVisibleVideoEditMark({
        ...rectangle,
        kind: "freehand",
        points: [
          { x: 0.1, y: 0.1 },
          { x: 0.5, y: 0.5 },
          { x: 0.1, y: 0.1 },
        ],
      }),
    ).toBe(true);
  });

  it("renders reversed rectangles and freehand paths at original video pixel coordinates", () => {
    const context = drawingContext();
    drawVideoEditMarks(
      context as unknown as CanvasRenderingContext2D,
      [
        rectangle,
        {
          id: "mark-freehand",
          timeSeconds: 0,
          kind: "freehand",
          color: "#5caeff",
          points: [
            { x: 0.1, y: 0.2 },
            { x: 0.4, y: 0.6 },
          ],
        },
      ],
      1000,
      500,
    );
    expect(context.strokeRect).toHaveBeenCalledWith(250, 100, 500, expect.closeTo(300));
    expect(context.moveTo).toHaveBeenCalledWith(100, 100);
    expect(context.lineTo).toHaveBeenCalledWith(400, 300);
    // 1 次画笔轨迹 + 2 个序号徽标的圆环描边。
    expect(context.stroke).toHaveBeenCalledTimes(3);
    expect(context.restore).toHaveBeenCalledOnce();
  });

  it("numbers every region only when more than one mark needs disambiguating", () => {
    const single = drawingContext();
    drawVideoEditMarks(single as unknown as CanvasRenderingContext2D, [rectangle], 1000, 500);
    expect(single.fillText).not.toHaveBeenCalled();
    expect(single.arc).not.toHaveBeenCalled();

    const multiple = drawingContext();
    drawVideoEditMarks(
      multiple as unknown as CanvasRenderingContext2D,
      [
        rectangle,
        {
          id: "mark-freehand",
          timeSeconds: 0,
          kind: "freehand",
          color: "#5caeff",
          points: [
            { x: 0.1, y: 0.6 },
            { x: 0.4, y: 0.7 },
          ],
        },
      ],
      1000,
      500,
    );
    // 序号画在各自区域的上边缘居中处：与清单、提示词里的「标注N」一一对应。
    expect(multiple.arc).toHaveBeenCalledTimes(2);
    expect(multiple.fillText).toHaveBeenNthCalledWith(1, "1", 500, 100);
    expect(multiple.fillText).toHaveBeenNthCalledWith(2, "2", 250, 300);
    // 叠加层与导出帧共用同一份几何；贴边的区域被夹进画面内，编号不会跑出边界。
    expect(videoEditMarkBadge(rectangle, 1000, 500)).toEqual({ x: 500, y: 100, radius: 11 });
    expect(
      videoEditMarkBadge(
        {
          ...rectangle,
          points: [
            { x: 0, y: 0 },
            { x: 1, y: 1 },
          ],
        },
        1000,
        500,
      ),
    ).toEqual({ x: 500, y: 11, radius: 11 });
    expect(videoEditMarkBadge({ ...rectangle, points: [] }, 1000, 500)).toBeNull();
  });

  it("describes each region as self-contained prompt text and gives it a stable identity", () => {
    expect(videoEditMarkLabel(0)).toBe("标注1");
    expect(videoEditMarkLabel(2)).toBe("标注3");
    expect(describeVideoEditMark(rectangle)).toBe(
      "红色框选，画面左侧 25%、顶部 20% 至右侧 75%、底部 80%",
    );
    expect(
      describeVideoEditMark({
        id: "mark-freehand",
        timeSeconds: 12.5,
        kind: "freehand",
        color: "#5caeff",
        points: [
          { x: 0.4, y: 0.7 },
          { x: 0.1, y: 0.2 },
        ],
      }),
    ).toBe("蓝色画笔，画面左侧 10%、顶部 20% 至右侧 40%、底部 70%");
    // 调色板外的颜色不能退化成空描述：提示词必须始终带得走工具与范围。
    expect(describeVideoEditMark({ ...rectangle, color: "#123456", points: [] })).toBe(
      "自定义色框选轨迹",
    );
    expect(videoEditMarkBounds({ ...rectangle, points: [{ x: Number.NaN, y: 0.5 }] })).toBeNull();
    expect(newVideoEditMarkId()).not.toBe(newVideoEditMarkId());
  });

  it("exports a PNG with the actual video pixels followed by the visible annotation", () => {
    const context = drawingContext();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      context as unknown as CanvasRenderingContext2D,
    );
    const encode = vi
      .spyOn(HTMLCanvasElement.prototype, "toDataURL")
      .mockReturnValue("data:image/png;base64,frame");
    const video = document.createElement("video");
    Object.defineProperties(video, {
      videoWidth: { value: 1920 },
      videoHeight: { value: 1080 },
      readyState: { value: 2 },
    });
    expect(exportVideoLocalEditFrame(video, [rectangle])).toBe("data:image/png;base64,frame");
    expect(context.drawImage).toHaveBeenCalledWith(video, 0, 0, 1920, 1080);
    expect(context.strokeRect).toHaveBeenCalledWith(480, 216, 960, expect.closeTo(648));
    expect(context.drawImage.mock.invocationCallOrder[0]).toBeLessThan(
      context.strokeRect.mock.invocationCallOrder[0]!,
    );
    expect(encode).toHaveBeenCalledWith("image/png");
  });

  it("treats sub-frame drift as the same frame and refuses to draw another frame's marks", () => {
    // 回跳到标注帧时 currentTime 会落到帧边界上：0.03 秒的漂移必须仍算同一帧。
    expect(sameVideoEditFrame(2, 2.03)).toBe(true);
    expect(sameVideoEditFrame(2, 2.2)).toBe(false);

    const video = document.createElement("video");
    Object.defineProperties(video, {
      videoWidth: { value: 1920 },
      videoHeight: { value: 1080 },
      readyState: { value: 2 },
      currentTime: { configurable: true, value: 2 },
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      drawingContext() as unknown as CanvasRenderingContext2D,
    );
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,x");
    // 别的时间点的标记画在这一帧上会得到一张错误的定位图，必须挡住而不是照画。
    expect(() => exportVideoLocalEditFrame(video, [{ ...rectangle, timeSeconds: 8 }])).toThrow(
      "另一个时间点",
    );
    expect(exportVideoLocalEditFrame(video, [{ ...rectangle, timeSeconds: 2 }])).toBe(
      "data:image/png;base64,x",
    );
  });

  it("blocks undecoded or playing frames, and explains cross-origin capture failures", () => {
    const video = document.createElement("video");
    expect(() => exportVideoLocalEditFrame(video, [rectangle])).toThrow("加载完成并暂停");
    Object.defineProperties(video, {
      videoWidth: { value: 1920 },
      videoHeight: { value: 1080 },
      readyState: { value: 2 },
      paused: { configurable: true, value: false },
    });
    expect(() => exportVideoLocalEditFrame(video, [rectangle])).toThrow("加载完成并暂停");
    Object.defineProperty(video, "paused", { value: true });
    expect(() => exportVideoLocalEditFrame(video, [])).toThrow("框选或圈选");
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      drawingContext() as unknown as CanvasRenderingContext2D,
    );
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(() => {
      throw new DOMException("tainted", "SecurityError");
    });
    expect(() => exportVideoLocalEditFrame(video, [rectangle])).toThrow("重新打开局部编辑");
  });

  it("formats selected frame time without overflowing seconds at minute boundaries", () => {
    expect(formatVideoEditTime(59.999)).toBe("1:00.00");
    expect(formatVideoEditTime(5.12)).toBe("0:05.12");
    expect(formatVideoEditTime(Number.NaN)).toBe("0:00.00");
  });

  it("sizes each mark thumbnail to its own region aspect ratio inside the contained frame", () => {
    // 1280×800 的叠加层里 contain 1920×1080：上下各留 40px 黑边。
    const geometry = videoEditMarkThumbnailGeometry(rectangle, {
      videoWidth: 1920,
      videoHeight: 1080,
      displayWidth: 1280,
      displayHeight: 800,
    })!;
    // 区域 0.25–0.75 × 0.2–0.8 外扩 24% 后裁剪，裁剪区域落在画面内且比区域本身大。
    expect(Math.round(geometry.crop.x)).toBe(250);
    expect(Math.round(geometry.crop.y)).toBe(60);
    expect(Math.round(geometry.crop.width)).toBe(1421);
    expect(geometry.crop.x + geometry.crop.width).toBeLessThanOrEqual(1920);
    // 长边封顶 128：缩略图跟随裁剪区域的比例，不会被拉成正方形。
    expect({ left: geometry.left, top: geometry.top }).toEqual({ left: 576, top: 92 });
    expect(geometry.width).toBe(128);
    // 取整会带来不足 1% 的偏差，比例本身仍然一致。
    expect(geometry.width / geometry.height).toBeCloseTo(
      geometry.crop.width / geometry.crop.height,
      1,
    );
    expect(geometry.display).toEqual({ x: 0, y: 40, width: 1280, height: 720 });

    // 竖构图视频里的窄条区域：短边被抬到下限，比例仍然不变。
    const portrait = videoEditMarkThumbnailGeometry(
      {
        ...rectangle,
        points: [
          { x: 0.4, y: 0.1 },
          { x: 0.5, y: 0.9 },
        ],
      },
      { videoWidth: 1080, videoHeight: 1920, displayWidth: 800, displayHeight: 800 },
    )!;
    expect(portrait.width).toBeLessThan(portrait.height);
    expect(portrait.width / portrait.height).toBeCloseTo(
      portrait.crop.width / portrait.crop.height,
      1,
    );
    // 贴顶区域把缩略图翻到区域下方，始终留在画面内。
    const nearTop = videoEditMarkThumbnailGeometry(
      {
        ...rectangle,
        points: [
          { x: 0.25, y: 0 },
          { x: 0.75, y: 0.2 },
        ],
      },
      { videoWidth: 1920, videoHeight: 1080, displayWidth: 1280, displayHeight: 800 },
    )!;
    expect(nearTop.top).toBeGreaterThanOrEqual(40);
    expect(nearTop.top + nearTop.height).toBeLessThanOrEqual(760);
    // 画面尺寸未知时不产出几何：调用方据此退回序号标记。
    expect(
      videoEditMarkThumbnailGeometry(rectangle, {
        videoWidth: 0,
        videoHeight: 0,
        displayWidth: 1280,
        displayHeight: 800,
      }),
    ).toBeNull();
  });

  it("caps thumbnail resolution at the long edge while keeping the crop ratio", () => {
    expect(videoEditMarkThumbnailResolution({ x: 0, y: 0, width: 1498, height: 842 })).toEqual({
      width: VIDEO_EDIT_THUMBNAIL_RESOLUTION,
      height: 144,
    });
    // 小于上限的裁剪区域不放大：缩略图不浪费体积，也不会糊。
    expect(videoEditMarkThumbnailResolution({ x: 0, y: 0, width: 120, height: 90 })).toEqual({
      width: 120,
      height: 90,
    });
    expect(videoEditMarkThumbnailResolution({ x: 0, y: 0, width: 0, height: 0 })).toEqual({
      width: 1,
      height: 1,
    });
  });

  it("captures a thumbnail from the mark's own frame and draws the mark without an ordinal", async () => {
    const context = drawingContext();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      context as unknown as CanvasRenderingContext2D,
    );
    const encode = vi
      .spyOn(HTMLCanvasElement.prototype, "toDataURL")
      .mockReturnValue("data:image/png;base64,crop");
    const video = document.createElement("video");
    Object.defineProperties(video, {
      videoWidth: { value: 1920 },
      videoHeight: { value: 1080 },
      readyState: { configurable: true, value: 2 },
      currentTime: { configurable: true, value: 2 },
      duration: { value: 15 },
    });
    await expect(
      captureVideoEditFrameThumbnail(video, rectangle, {
        timeSeconds: 2,
        crop: { x: 211, y: 119, width: 1498, height: 842 },
        width: 256,
        height: 144,
      }),
    ).resolves.toBe("data:image/png;base64,crop");
    // 只裁剪标记区域，不整帧缩放：缩略图里就是标记周围那一块画面。
    expect(context.drawImage).toHaveBeenCalledWith(video, 211, 119, 1498, 842, 0, 0, 256, 144);
    expect(context.strokeRect).toHaveBeenCalledTimes(1);
    // 缩略图里的标记不带序号：编号由界面上的徽标承担，画进图里只会重复。
    expect(context.fillText).not.toHaveBeenCalled();
    expect(encode).toHaveBeenCalledWith("image/png");

    // 跨域画面取不出来时返回 null：缩略图只是展示增强，绝不因此中断标注流程。
    encode.mockImplementation(() => {
      throw new DOMException("tainted", "SecurityError");
    });
    await expect(
      captureVideoEditFrameThumbnail(video, rectangle, {
        timeSeconds: 2,
        crop: { x: 211, y: 119, width: 1498, height: 842 },
        width: 256,
        height: 144,
      }),
    ).resolves.toBeNull();
    // 还没解码的源同样不产出缩略图。
    Object.defineProperty(video, "readyState", { configurable: true, value: 0 });
    await expect(
      captureVideoEditFrameThumbnail(video, rectangle, {
        timeSeconds: 2,
        crop: { x: 0, y: 0, width: 100, height: 100 },
        width: 100,
        height: 100,
      }),
    ).resolves.toBeNull();
  });
});
