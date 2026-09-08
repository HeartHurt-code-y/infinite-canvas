import { afterEach, describe, expect, it, vi } from "vitest";
import {
  drawVideoEditMarks,
  exportVideoLocalEditFrame,
  formatVideoEditTime,
  isVisibleVideoEditMark,
  videoEditPointFromClient,
  type VideoEditMark,
} from "./videoLocalEditDrawing";

const rectangle: VideoEditMark = {
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
  };
}

afterEach(() => vi.restoreAllMocks());

describe("video local edit drawing", () => {
  it("maps contained landscape and portrait frames, rejecting letterbox pointer starts", () => {
    const bounds = { left: 10, top: 20, width: 400, height: 400 };
    expect(videoEditPointFromClient({ x: 210, y: 220 }, bounds, 1920, 1080)).toEqual({
      x: 0.5,
      y: 0.5,
    });
    expect(videoEditPointFromClient({ x: 210, y: 30 }, bounds, 1920, 1080)).toBeNull();
    expect(videoEditPointFromClient({ x: 20, y: 220 }, bounds, 1080, 1920)).toBeNull();
    expect(videoEditPointFromClient({ x: 153.75, y: 120 }, bounds, 1080, 1920)).toEqual({
      x: 0.25,
      y: 0.25,
    });
    expect(videoEditPointFromClient({ x: 999, y: -20 }, bounds, 1920, 1080, true)).toEqual({
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
    expect(context.stroke).toHaveBeenCalledOnce();
    expect(context.restore).toHaveBeenCalledOnce();
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
});
