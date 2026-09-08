export interface VideoEditPoint {
  readonly x: number;
  readonly y: number;
}

export interface VideoEditMark {
  readonly kind: "rectangle" | "freehand";
  readonly color: string;
  readonly points: readonly VideoEditPoint[];
}

export const VIDEO_EDIT_COLORS = [
  { label: "红色", value: "#ff4865" },
  { label: "黄色", value: "#ffd65a" },
  { label: "蓝色", value: "#5caeff" },
] as const;

const clampUnit = (value: number) => Math.min(1, Math.max(0, value));

/** Match object-fit: contain, including portrait video and letterbox margins. */
export function videoEditPointFromClient(
  point: VideoEditPoint,
  bounds: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  },
  videoWidth: number,
  videoHeight: number,
  clamp = false,
): VideoEditPoint | null {
  if (!(bounds.width > 0 && bounds.height > 0 && videoWidth > 0 && videoHeight > 0)) return null;
  const scale = Math.min(bounds.width / videoWidth, bounds.height / videoHeight);
  const width = videoWidth * scale;
  const height = videoHeight * scale;
  const x = (point.x - bounds.left - (bounds.width - width) / 2) / width;
  const y = (point.y - bounds.top - (bounds.height - height) / 2) / height;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (!clamp && (x < 0 || x > 1 || y < 0 || y > 1)) return null;
  return { x: clampUnit(x), y: clampUnit(y) };
}

export function isVisibleVideoEditMark(mark: VideoEditMark): boolean {
  const first = mark.points[0];
  const last = mark.points.at(-1);
  if (
    !first ||
    !last ||
    mark.points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))
  )
    return false;
  if (mark.kind === "rectangle")
    return Math.abs(first.x - last.x) >= 0.005 && Math.abs(first.y - last.y) >= 0.005;
  return mark.points.some((point) => Math.hypot(point.x - first.x, point.y - first.y) >= 0.01);
}

export function videoEditStrokeWidth(width: number, height: number): number {
  return Math.max(2, Math.min(width, height) * 0.007);
}

export function drawVideoEditMarks(
  context: CanvasRenderingContext2D,
  marks: readonly VideoEditMark[],
  width: number,
  height: number,
): void {
  context.save();
  context.lineWidth = videoEditStrokeWidth(width, height);
  context.lineCap = "round";
  context.lineJoin = "round";
  for (const mark of marks) {
    const first = mark.points[0];
    const last = mark.points.at(-1);
    if (!first || !last || !isVisibleVideoEditMark(mark)) continue;
    context.strokeStyle = mark.color;
    if (mark.kind === "rectangle") {
      context.strokeRect(
        Math.min(first.x, last.x) * width,
        Math.min(first.y, last.y) * height,
        Math.abs(last.x - first.x) * width,
        Math.abs(last.y - first.y) * height,
      );
    } else {
      context.beginPath();
      context.moveTo(first.x * width, first.y * height);
      for (const point of mark.points.slice(1)) context.lineTo(point.x * width, point.y * height);
      context.stroke();
    }
  }
  context.restore();
}

/** Export pixels from the paused source frame, with the same marks shown in the overlay. */
export function exportVideoLocalEditFrame(
  video: HTMLVideoElement,
  marks: readonly VideoEditMark[],
): string {
  if (
    video.readyState < 2 ||
    video.seeking ||
    !video.paused ||
    video.videoWidth < 1 ||
    video.videoHeight < 1
  ) {
    throw new Error("请等待视频画面加载完成并暂停后，再添加标注帧。");
  }
  if (!marks.some(isVisibleVideoEditMark))
    throw new Error("请先在画面中框选或圈选需要编辑的区域。");
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建标注画布，请关闭后重试。");
  try {
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    drawVideoEditMarks(context, marks, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
  } catch (error) {
    if (error instanceof DOMException && error.name === "SecurityError") {
      throw new Error("当前预览无法截取画面，请重新打开局部编辑以读取原视频。", {
        cause: error,
      });
    }
    throw new Error("截取标注帧失败，请等待视频画面加载后重试。", { cause: error });
  }
}

export function formatVideoEditTime(seconds: number): string {
  const centiseconds = Math.round(Math.max(0, Number.isFinite(seconds) ? seconds : 0) * 100);
  return `${Math.floor(centiseconds / 6000)}:${String(Math.floor(centiseconds / 100) % 60).padStart(2, "0")}.${String(centiseconds % 100).padStart(2, "0")}`;
}
