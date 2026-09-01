export type VideoSamplingPhase = "overview" | "tail";

export interface VideoSamplingPoint {
  readonly time: number;
  readonly phase: VideoSamplingPhase;
}

export interface VideoContactSheet {
  readonly dataUrl: string;
  readonly displayName: string;
  readonly phase: VideoSamplingPhase;
  readonly firstTime: number;
  readonly lastTime: number;
  readonly frameCount: number;
}

export interface VideoContactSheetResult {
  readonly duration: number;
  readonly overviewFrameCount: number;
  readonly tailFrameCount: number;
  readonly sheets: readonly VideoContactSheet[];
}

const DENSE_THRESHOLD_SECONDS = 30;
const DENSE_INTERVAL_SECONDS = 0.5;
const LONG_VIDEO_OVERVIEW_FRAMES = 12;
const TAIL_SECONDS = 5;
const TAIL_FPS = 6;
const FRAMES_PER_SHEET = 12;
const SEEK_EPSILON_SECONDS = 0.001;

function safeLastTime(duration: number): number {
  return Math.max(0, duration - SEEK_EPSILON_SECONDS);
}

function roundedTime(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function intervalTimes(start: number, end: number, interval: number): number[] {
  const values: number[] = [];
  for (let value = start; value <= end + 0.0001; value += interval) {
    values.push(roundedTime(Math.min(value, end)));
  }
  if (values.length === 0 || Math.abs(values.at(-1)! - end) > interval / 3) {
    values.push(roundedTime(end));
  }
  return values;
}

/**
 * Mirrors douyin-reverse-prompt V1.1: short videos use 0.5 s overview sampling,
 * long videos use about 12 evenly spaced frames, and every video gets a separate
 * 6 fps pass over its final five seconds.
 */
export function videoSamplingTimeline(duration: number): readonly VideoSamplingPoint[] {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const end = safeLastTime(duration);
  const overviewTimes =
    duration <= DENSE_THRESHOLD_SECONDS
      ? intervalTimes(0, end, DENSE_INTERVAL_SECONDS)
      : Array.from({ length: LONG_VIDEO_OVERVIEW_FRAMES }, (_, index) =>
          roundedTime((end * index) / Math.max(1, LONG_VIDEO_OVERVIEW_FRAMES - 1)),
        );
  const tailStart = Math.max(0, duration - TAIL_SECONDS);
  const tailTimes = intervalTimes(tailStart, end, 1 / TAIL_FPS);
  return [
    ...overviewTimes.map((time) => ({ time, phase: "overview" as const })),
    ...tailTimes.map((time) => ({ time, phase: "tail" as const })),
  ];
}

function waitForEvent(
  element: HTMLMediaElement,
  successEvent: "loadedmetadata" | "loadeddata" | "seeked",
  timeoutMs = 15_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      window.clearTimeout(timer);
      element.removeEventListener(successEvent, handleSuccess);
      element.removeEventListener("error", handleError);
    };
    const handleSuccess = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error("视频无法解码，无法生成复刻联系表。"));
    };
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error(`等待视频 ${successEvent} 超时。`));
    }, timeoutMs);
    element.addEventListener(successEvent, handleSuccess, { once: true });
    element.addEventListener("error", handleError, { once: true });
  });
}

async function seekVideo(video: HTMLVideoElement, time: number): Promise<void> {
  const target = Math.min(Math.max(0, time), safeLastTime(video.duration));
  if (
    video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
    Math.abs(video.currentTime - target) < 0.002
  ) {
    return;
  }
  const ready = waitForEvent(video, "seeked");
  video.currentTime = target;
  await ready;
}

function timestampLabel(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${remainder.toFixed(3).padStart(6, "0")}`;
}

interface CapturedFrame {
  readonly canvas: HTMLCanvasElement;
  readonly point: VideoSamplingPoint;
  readonly index: number;
}

function drawFrameIntoSheet(
  context: CanvasRenderingContext2D,
  frame: CapturedFrame,
  cellX: number,
  cellY: number,
  cellWidth: number,
  cellHeight: number,
): void {
  const labelHeight = 30;
  const padding = 8;
  context.fillStyle = "#101318";
  context.fillRect(cellX, cellY, cellWidth, cellHeight);
  const sourceWidth = frame.canvas.width;
  const sourceHeight = frame.canvas.height;
  const availableWidth = cellWidth - padding * 2;
  const availableHeight = cellHeight - labelHeight - padding;
  const scale = Math.min(availableWidth / sourceWidth, availableHeight / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  const drawX = cellX + (cellWidth - drawWidth) / 2;
  const drawY = cellY + labelHeight + (availableHeight - drawHeight) / 2;
  context.drawImage(frame.canvas, drawX, drawY, drawWidth, drawHeight);
  context.fillStyle = frame.point.phase === "tail" ? "#ffb454" : "#f5f7fb";
  context.font = "600 15px sans-serif";
  context.textBaseline = "middle";
  const phase = frame.point.phase === "tail" ? "结尾加密" : "全片";
  context.fillText(
    `${phase} ${String(frame.index + 1).padStart(3, "0")} · ${timestampLabel(frame.point.time)}`,
    cellX + 10,
    cellY + labelHeight / 2,
  );
}

function makeContactSheets(frames: readonly CapturedFrame[]): readonly VideoContactSheet[] {
  const sheets: VideoContactSheet[] = [];
  for (const phase of ["overview", "tail"] as const) {
    const phaseFrames = frames.filter((frame) => frame.point.phase === phase);
    for (let offset = 0; offset < phaseFrames.length; offset += FRAMES_PER_SHEET) {
      const batch = phaseFrames.slice(offset, offset + FRAMES_PER_SHEET);
      const columns = 3;
      const rows = Math.ceil(batch.length / columns);
      const cellWidth = 320;
      const cellHeight = 240;
      const canvas = document.createElement("canvas");
      canvas.width = columns * cellWidth;
      canvas.height = rows * cellHeight;
      const context = canvas.getContext("2d");
      if (context == null) throw new Error("当前 WebView 不支持联系表画布。 ");
      context.fillStyle = "#101318";
      context.fillRect(0, 0, canvas.width, canvas.height);
      batch.forEach((frame, index) => {
        drawFrameIntoSheet(
          context,
          frame,
          (index % columns) * cellWidth,
          Math.floor(index / columns) * cellHeight,
          cellWidth,
          cellHeight,
        );
      });
      const first = batch[0]!;
      const last = batch.at(-1)!;
      const sheetNumber = Math.floor(offset / FRAMES_PER_SHEET) + 1;
      sheets.push({
        dataUrl: canvas.toDataURL("image/jpeg", 0.82),
        displayName: `${phase === "tail" ? "结尾加密联系表" : "全片联系表"} ${sheetNumber}（${timestampLabel(first.point.time)}—${timestampLabel(last.point.time)}）`,
        phase,
        firstTime: first.point.time,
        lastTime: last.point.time,
        frameCount: batch.length,
      });
    }
  }
  return sheets;
}

/** Decode a video inside the Tauri WebView and return compact timestamped contact sheets. */
export async function buildVideoContactSheets(videoSrc: string): Promise<VideoContactSheetResult> {
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  video.src = videoSrc;
  try {
    if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
      video.load();
      await waitForEvent(video, "loadedmetadata");
    }
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      await waitForEvent(video, "loadeddata");
    }
    const duration = video.duration;
    const timeline = videoSamplingTimeline(duration);
    if (timeline.length === 0 || video.videoWidth <= 0 || video.videoHeight <= 0) {
      throw new Error("视频元数据无效，无法生成复刻联系表。 ");
    }
    // 联系表单格最终只有约 320×210；把长边限制在 480px，避免 90 余张竖屏帧
    // 同时驻留时占用数百 MiB，又保留足够的服饰、构图与动作细节。
    const captureScale = Math.min(1, 480 / Math.max(video.videoWidth, video.videoHeight));
    const captureWidth = Math.max(1, Math.round(video.videoWidth * captureScale));
    const captureHeight = Math.max(1, Math.round(video.videoHeight * captureScale));
    const frames: CapturedFrame[] = [];
    for (const [index, point] of timeline.entries()) {
      await seekVideo(video, point.time);
      const canvas = document.createElement("canvas");
      canvas.width = captureWidth;
      canvas.height = captureHeight;
      const context = canvas.getContext("2d");
      if (context == null) throw new Error("当前 WebView 不支持视频抽帧画布。 ");
      context.drawImage(video, 0, 0, captureWidth, captureHeight);
      frames.push({ canvas, point, index });
    }
    const sheets = makeContactSheets(frames);
    return {
      duration,
      overviewFrameCount: timeline.filter((point) => point.phase === "overview").length,
      tailFrameCount: timeline.filter((point) => point.phase === "tail").length,
      sheets,
    };
  } finally {
    video.removeAttribute("src");
    video.load();
  }
}
