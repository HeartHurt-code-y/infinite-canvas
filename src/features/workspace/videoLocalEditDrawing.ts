export interface VideoEditPoint {
  readonly x: number;
  readonly y: number;
}

export interface VideoEditMark {
  /**
   * 标记的稳定身份。编号会随列表变化（删掉一处后同帧其余标记重新编号），
   * 提示词里的引用必须按 id 而不是编号对齐，否则会指向另一处区域。
   */
  readonly id: string;
  /**
   * 绘制时所在的原视频时间点。标记属于它自己的那一帧，切换时间点不会删除它；
   * 只有当前画面的标记才会画在叠加层上、才会进入本次提交。
   */
  readonly timeSeconds: number;
  readonly kind: "rectangle" | "freehand";
  readonly color: string;
  readonly points: readonly VideoEditPoint[];
}

export const VIDEO_EDIT_COLORS = [
  { label: "红色", value: "#ff4865" },
  { label: "黄色", value: "#ffd65a" },
  { label: "蓝色", value: "#5caeff" },
] as const;

/**
 * 认定「同一帧」的时间容差。回跳到某个标注时间点时，浏览器会把 currentTime
 * 落到帧边界上（与记录值有亚帧级误差），严格相等会让标注在自己那帧上判不出归属。
 *
 * 它只用于把标记归到某一帧（决定哪些标记画在画面上、进入本次提交），
 * 不参与编号：编号是全片唯一的，否则四帧上的第一处标记会全是「标注1」。
 */
export const VIDEO_EDIT_FRAME_TOLERANCE_SECONDS = 0.04;

export function sameVideoEditFrame(first: number, second: number): boolean {
  return Math.abs(first - second) <= VIDEO_EDIT_FRAME_TOLERANCE_SECONDS;
}

export function newVideoEditMarkId(): string {
  return `mark-${globalThis.crypto.randomUUID()}`;
}

/**
 * 标记在清单与提示词里的显示编号（从 1 开始）。
 *
 * 编号按整份标记清单的顺序计算，因此全片唯一：同一帧上多处标记是「标注1、标注2」，
 * 换到另一帧接着标就是「标注3」。画面上的序号、清单、@ 候选与提示词正文共用它，
 * 引用任何一处都不会指向另一帧的同名区域。
 */
export function videoEditMarkLabel(index: number): string {
  return `标注${index + 1}`;
}

export interface VideoEditMarkBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** 标记覆盖的画面范围（归一化坐标），矩形取对角、画笔取轨迹包围盒。 */
export function videoEditMarkBounds(mark: VideoEditMark): VideoEditMarkBounds | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of mark.points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  if (minX === Number.POSITIVE_INFINITY) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * 把标记描述成自述文本，作为提示词里「标注N（…）」括号内的内容。
 * 描述必须自带颜色与工具，因为模型只看到导出帧上的彩色线条和序号。
 *
 * 传入 frameSeconds 时描述里带上「视频 X 处」：引用其它时间点的标注时，提示词里
 * 必须有时间读数，否则模型无法把这条描述落到正确的画面上（导出帧只含当前帧）。
 */
export function describeVideoEditMark(mark: VideoEditMark, frameSeconds?: number): string {
  const color = VIDEO_EDIT_COLORS.find((entry) => entry.value === mark.color)?.label ?? "自定义色";
  const tool = mark.kind === "rectangle" ? "框选" : "画笔";
  const frame =
    frameSeconds == null || !Number.isFinite(frameSeconds)
      ? ""
      : `视频 ${formatVideoEditTime(frameSeconds)} 处：`;
  const bounds = videoEditMarkBounds(mark);
  if (bounds == null) return `${frame}${color}${tool}轨迹`;
  const percent = (value: number) => `${Math.round(value * 100)}%`;
  return `${frame}${color}${tool}，画面左侧 ${percent(bounds.x)}、顶部 ${percent(
    bounds.y,
  )} 至右侧 ${percent(bounds.x + bounds.width)}、底部 ${percent(bounds.y + bounds.height)}`;
}

const clampUnit = (value: number) => Math.min(1, Math.max(0, value));

/**
 * Match object-fit: contain, including portrait video and letterbox margins.
 *
 * 落在黑边上的坐标夹到画面边缘而不是判废：框选常从贴边处起手，直接丢弃会让用户
 * 以为「这一处标不上」。真正的误点（点一下没拖动）由 isVisibleVideoEditMark 兜底。
 */
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
): VideoEditPoint | null {
  if (!(bounds.width > 0 && bounds.height > 0 && videoWidth > 0 && videoHeight > 0)) return null;
  const scale = Math.min(bounds.width / videoWidth, bounds.height / videoHeight);
  const width = videoWidth * scale;
  const height = videoHeight * scale;
  const x = (point.x - bounds.left - (bounds.width - width) / 2) / width;
  const y = (point.y - bounds.top - (bounds.height - height) / 2) / height;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
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

export interface VideoEditMarkBadge {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
}

/**
 * 序号徽标的位置与半径（画面像素坐标）：横置于区域上边缘居中处。
 * 叠加层与导出帧必须用同一份计算，否则屏幕上看到的编号与模型看到的对不上。
 */
export function videoEditMarkBadge(
  mark: VideoEditMark,
  width: number,
  height: number,
): VideoEditMarkBadge | null {
  const bounds = videoEditMarkBounds(mark);
  if (bounds == null) return null;
  const radius = Math.max(9, Math.min(width, height) * 0.022);
  const clampAxis = (value: number, extent: number) =>
    Math.min(Math.max(value, radius), Math.max(radius, extent - radius));
  return {
    x: clampAxis((bounds.x + bounds.width / 2) * width, width),
    y: clampAxis(bounds.y * height, height),
    radius,
  };
}

/** 序号徽标：白底 + 标记色描边与数字，浅色与深色画面上都能看清。 */
function drawVideoEditMarkIndex(
  context: CanvasRenderingContext2D,
  mark: VideoEditMark,
  ordinal: number,
  width: number,
  height: number,
): void {
  const badge = videoEditMarkBadge(mark, width, height);
  if (badge == null) return;
  context.beginPath();
  context.arc(badge.x, badge.y, badge.radius, 0, Math.PI * 2);
  context.fillStyle = "#ffffff";
  context.fill();
  context.lineWidth = Math.max(1.5, badge.radius * 0.14);
  context.strokeStyle = mark.color;
  context.stroke();
  context.fillStyle = mark.color;
  context.font = `bold ${Math.round(badge.radius * 1.32)}px sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(String(ordinal), badge.x, badge.y);
}

/** 只画标记本身（矩形或画笔轨迹），不带任何编号徽标。 */
function drawVideoEditMarkPath(
  context: CanvasRenderingContext2D,
  mark: VideoEditMark,
  width: number,
  height: number,
): void {
  const first = mark.points[0];
  const last = mark.points.at(-1);
  if (!first || !last || !isVisibleVideoEditMark(mark)) return;
  context.strokeStyle = mark.color;
  if (mark.kind === "rectangle") {
    context.strokeRect(
      Math.min(first.x, last.x) * width,
      Math.min(first.y, last.y) * height,
      Math.abs(last.x - first.x) * width,
      Math.abs(last.y - first.y) * height,
    );
    return;
  }
  context.beginPath();
  context.moveTo(first.x * width, first.y * height);
  for (const point of mark.points.slice(1)) context.lineTo(point.x * width, point.y * height);
  context.stroke();
}

export function drawVideoEditMarks(
  context: CanvasRenderingContext2D,
  marks: readonly VideoEditMark[],
  width: number,
  height: number,
  options: { readonly showOrdinal?: boolean } = {},
): void {
  context.save();
  context.lineWidth = videoEditStrokeWidth(width, height);
  context.lineCap = "round";
  context.lineJoin = "round";
  // 默认沿用导出帧的既有语义：只有一处标记时不存在歧义，不画编号。
  const showOrdinal = options.showOrdinal ?? marks.filter(isVisibleVideoEditMark).length > 1;
  let ordinal = 1;
  for (const mark of marks) {
    const first = mark.points[0];
    const last = mark.points.at(-1);
    if (!first || !last || !isVisibleVideoEditMark(mark)) continue;
    drawVideoEditMarkPath(context, mark, width, height);
    // 编号只在有歧义时画出：只有一处标记时保持画面与导出帧干净。
    if (showOrdinal) drawVideoEditMarkIndex(context, mark, ordinal, width, height);
    ordinal += 1;
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
  // 只允许导出当前画面自己的标注：把别的时间点的标记画在这一帧上，会得到一张错误的定位图。
  if (marks.some((mark) => !sameVideoEditFrame(mark.timeSeconds, video.currentTime)))
    throw new Error("标注属于另一个时间点，请回到该时间点后再添加标注帧。");
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建标注画布，请关闭后重试。");
  try {
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    // 编号只在本次提交含多处标记时才画：单处标记不存在歧义，画面保持干净。
    drawVideoEditMarks(context, marks, canvas.width, canvas.height, {
      showOrdinal: marks.filter(isVisibleVideoEditMark).length > 1,
    });
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

export interface VideoEditMarkThumbnailArea {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface VideoEditMarkThumbnailGeometry {
  /** 画面在叠加层坐标系里的位置（叠加层与视频同盒，因此可直接用作 CSS 定位）。 */
  readonly display: VideoEditMarkThumbnailArea;
  /** 缩略图覆盖的画面区域（原视频像素），已经夹进画面内。 */
  readonly crop: VideoEditMarkThumbnailArea;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** 缩略图覆盖范围比标记区域外扩的比例，让标记周围留出可辨认的上下文。 */
const THUMBNAIL_MARGIN_RATIO = 0.24;
/** 外扩的绝对上限（画面短边的比例）：极小区域也不该把缩略图撑成一整屏。 */
const THUMBNAIL_MARGIN_MAX_RATIO = 0.25;
/** 缩略图短边下限与长边上限：太小看不清标记，太大就成了第二块屏幕。 */
export const VIDEO_EDIT_THUMBNAIL_MIN_EDGE = 48;
export const VIDEO_EDIT_THUMBNAIL_MAX_EDGE = 128;
/** 缩略图源分辨率上限：只裁一小块画面，256px 足够清晰又不会让整体体积失控。 */
export const VIDEO_EDIT_THUMBNAIL_RESOLUTION = 256;
const THUMBNAIL_GAP = 6;

const clampAxis = (value: number, extent: number) => Math.min(Math.max(value, 0), extent);

/**
 * 标记缩略图在叠加层里的位置与尺寸：按标记区域外扩一圈后取整块画面，
 * 缩略图尺寸随该区域的宽高比自适应（长边封顶），并保持与画面同比例，
 * 因此竖构图、横构图与窄条区域都不会被拉变形。
 *
 * 尺寸一律用叠加层的 CSS 像素计算：叠加层与视频同盒（inset: 0），
 * SVG 的 preserveAspectRatio 会把画面按 contain 放进同一个盒子里，
 * 于是「画面坐标 × scale + 居中偏移」就是可直接定位的像素值。
 */
export function videoEditMarkThumbnailGeometry(
  mark: VideoEditMark,
  options: {
    readonly videoWidth: number;
    readonly videoHeight: number;
    readonly displayWidth: number;
    readonly displayHeight: number;
    readonly maxEdge?: number;
    readonly minEdge?: number;
  },
): VideoEditMarkThumbnailGeometry | null {
  const { videoWidth, videoHeight, displayWidth, displayHeight } = options;
  if (!(videoWidth > 0 && videoHeight > 0 && displayWidth > 0 && displayHeight > 0)) return null;
  const bounds = videoEditMarkBounds(mark);
  if (bounds == null) return null;
  const maxEdge = options.maxEdge ?? VIDEO_EDIT_THUMBNAIL_MAX_EDGE;
  const minEdge = Math.min(options.minEdge ?? VIDEO_EDIT_THUMBNAIL_MIN_EDGE, maxEdge);
  const scale = Math.min(displayWidth / videoWidth, displayHeight / videoHeight);
  const display: VideoEditMarkThumbnailArea = {
    x: (displayWidth - videoWidth * scale) / 2,
    y: (displayHeight - videoHeight * scale) / 2,
    width: videoWidth * scale,
    height: videoHeight * scale,
  };
  // 归一化边界 → 原视频像素边界，再外扩一圈（有绝对上限）并夹进画面。
  const rawWidth = bounds.width * videoWidth;
  const rawHeight = bounds.height * videoHeight;
  const marginCap = Math.min(videoWidth, videoHeight) * THUMBNAIL_MARGIN_MAX_RATIO;
  const marginX = Math.min(rawWidth * THUMBNAIL_MARGIN_RATIO, marginCap);
  const marginY = Math.min(rawHeight * THUMBNAIL_MARGIN_RATIO, marginCap);
  const cropLeft = clampAxis(bounds.x * videoWidth - marginX, videoWidth);
  const cropTop = clampAxis(bounds.y * videoHeight - marginY, videoHeight);
  const cropRight = clampAxis(bounds.x * videoWidth + rawWidth + marginX, videoWidth);
  const cropBottom = clampAxis(bounds.y * videoHeight + rawHeight + marginY, videoHeight);
  const crop: VideoEditMarkThumbnailArea = {
    x: cropLeft,
    y: cropTop,
    width: Math.max(1, cropRight - cropLeft),
    height: Math.max(1, cropBottom - cropTop),
  };
  // 自适应尺寸：先按区域比例缩到长边不超过上限，再保证短边不小于下限。
  const fit = Math.min(1, maxEdge / Math.max(crop.width, crop.height));
  let width = crop.width * fit;
  let height = crop.height * fit;
  if (Math.min(width, height) < minEdge) {
    const grow = minEdge / Math.max(1e-6, Math.min(width, height));
    width *= grow;
    height *= grow;
  }
  width = Math.max(1, Math.round(width));
  height = Math.max(1, Math.round(height));
  // 横置于标记区域上边缘居中处（与原来的序号圆圈同一处），贴顶时翻到区域下方。
  const centerX = (bounds.x + bounds.width / 2) * videoWidth;
  const topEdge = bounds.y * videoHeight;
  const left =
    display.x + clampAxis(centerX * scale - width / 2, Math.max(0, display.width - width));
  const above = display.y + topEdge * scale - height - THUMBNAIL_GAP;
  const below = display.y + (bounds.y + bounds.height) * videoHeight * scale + THUMBNAIL_GAP;
  const maxTop = Math.max(0, displayHeight - height);
  const preferred = above >= display.y ? above : below;
  return { display, crop, left, top: clampAxis(preferred, maxTop), width, height };
}

/** 缩略图的实际像素尺寸：保持裁剪区域的宽高比，只把长边缩到上限。 */
export function videoEditMarkThumbnailResolution(crop: VideoEditMarkThumbnailArea): {
  readonly width: number;
  readonly height: number;
} {
  const { width, height } = crop;
  if (!(width >= 1 && height >= 1)) return { width: 1, height: 1 };
  const scale = Math.min(1, VIDEO_EDIT_THUMBNAIL_RESOLUTION / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 等后台 video 走到目标时间点，并且真的有一帧可画。
 *
 * seeked 落下即认为可画（此刻 currentTime 就是目标时间，drawImage 取到的正是那一帧）；
 * 若此刻 readyState 还没到 HAVE_CURRENT_DATA，则等 loadeddata 或一小段延迟后再确认。
 * requestVideoFrameCallback 只作为更早的提前信号 —— 暂停且离屏的元素不保证派发它。
 * 超时返回 false：那一刻的画面可能还是第 0 帧，画出来的缩略图会张冠李戴，
 * 宁可这一处暂时没有缩略图。
 */
function seekVideoElementToFrame(
  video: HTMLVideoElement,
  timeSeconds: number,
  waitMs: number,
): Promise<boolean> {
  const retryMs = 250;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let seekLanded = false;
    let requestId: number | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const detach = () => {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("loadeddata", onLoadedData);
      if (requestId != null) video.cancelVideoFrameCallback?.(requestId);
      if (timer != null) clearTimeout(timer);
      if (retryTimer != null) clearTimeout(retryTimer);
    };
    function finish(ok: boolean) {
      if (settled) return;
      settled = true;
      detach();
      resolve(ok);
    }
    /** 只要 seek 已落下，就直接取当前帧：此刻的画面就是目标时间点的那一帧。 */
    function settle() {
      if (seekLanded) finish(true);
    }
    function onSeeked() {
      seekLanded = true;
      if (video.readyState >= 2) {
        finish(true);
        return;
      }
      if (typeof video.requestVideoFrameCallback === "function") {
        requestId = video.requestVideoFrameCallback(() => finish(true));
      }
      // 兜底轮询：loadeddata 或帧回调都不可靠时，也别把这一处永久卡住。
      retryTimer = setTimeout(settle, retryMs);
    }
    function onLoadedData() {
      settle();
    }
    /*
     * 这里刻意不监听 error：seek 过程中元素可能派发一次与取帧无关的错误事件
     * （源还在切换、解码器重启），把它当成「这一帧取不到」会让缩略图凭空消失。
     * 真正的失败由超时兜底，画不出画面时 drawImage/toDataURL 也会各自返回空结果。
     */
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("loadeddata", onLoadedData);
    // 已经停在目标时间点且当前帧可画时直接就用它，连 seek 都不需要。
    if (
      Math.abs(video.currentTime - timeSeconds) <= VIDEO_EDIT_FRAME_TOLERANCE_SECONDS &&
      video.readyState >= 2
    ) {
      finish(true);
      return;
    }
    timer = setTimeout(() => finish(false), waitMs);
    try {
      video.currentTime = timeSeconds;
    } catch {
      finish(false);
      return;
    }
    // 目标时间点已经是当前时间点时不会有 seeked：直接按当前帧可用性判断。
    if (Math.abs(video.currentTime - timeSeconds) <= VIDEO_EDIT_FRAME_TOLERANCE_SECONDS) {
      seekLanded = true;
      if (video.readyState >= 2) finish(true);
      else retryTimer = setTimeout(settle, retryMs);
    }
  });
}

/**
 * 用主预览取一处标记的缩略图：先 seek 到它所属的那一帧，裁完立刻跳回原位。
 *
 * 这是后台取帧元素的最后兜底。主预览就是用户此刻正在看的画面，导出标注帧早已证明它
 * 可读可画；后台元素在部分 WebView 里会因为不可见而拿不到解码帧（seek 超时或画不出内容）。
 *
 * 代价是画面会短暂跳到被取帧的那一屏，所以：
 * - 取完立刻 seek 回原位（不经过 React 状态，标注与播放头都不动）；
 * - 调用方先用 isInternalSeek 置位，让暂停/seeked 回调不要把这次内部跳转当成用户换帧；
 * - 只有 alreadyAtTargetFrame 会把「当前就停在这一帧」也算作可用，避免白跳一次。
 */
export async function capturePreviewSeekFrame(
  preview: HTMLVideoElement,
  mark: VideoEditMark,
  crop: VideoEditMarkThumbnailArea,
  width: number,
  height: number,
  options: {
    readonly alreadyAtTargetFrame: boolean;
    readonly waitMs?: number;
  },
): Promise<string | null> {
  const waitMs = options.waitMs ?? 3_000;
  const restoreTime = preview.currentTime;
  const wasPlaying = !preview.paused;
  if (wasPlaying) preview.pause();
  try {
    if (!options.alreadyAtTargetFrame) {
      if (!(await seekVideoElementToFrame(preview, mark.timeSeconds, waitMs))) return null;
    }
    return previewVideoEditMarkThumbnail(preview, mark, crop, width, height);
  } finally {
    if (options.alreadyAtTargetFrame) {
      if (wasPlaying) void preview.play().catch(() => undefined);
    } else {
      // 恢复用户原来停留的那一帧；不恢复播放状态会让「取缩略图」变成一次意外暂停。
      await seekVideoElementToFrame(preview, restoreTime, waitMs);
      if (wasPlaying) void preview.play().catch(() => undefined);
    }
  }
}

/** 把一帧画面按标记区域裁成缩略图；标记本身会被重画一遍（不含序号）。 */
function encodeVideoEditMarkThumbnail(
  video: HTMLVideoElement,
  mark: VideoEditMark,
  crop: VideoEditMarkThumbnailArea,
  width: number,
  height: number,
): string | null {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(height));
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.save();
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(
      video,
      crop.x,
      crop.y,
      crop.width,
      crop.height,
      0,
      0,
      canvas.width,
      canvas.height,
    );
    context.restore();
    // 缩略图上重画一遍标记本身（不含序号）：一眼能认出这一处框住的是什么。
    context.save();
    context.lineWidth = Math.max(1.5, videoEditStrokeWidth(canvas.width, canvas.height));
    context.lineCap = "round";
    context.lineJoin = "round";
    drawVideoEditMarkPath(context, mark, canvas.width, canvas.height);
    context.restore();
    return canvas.toDataURL("image/png");
  } catch {
    // 跨域画面（来源不允许截图）会在这里抛 SecurityError：缩略图只是展示增强，不向上抛。
    return null;
  }
}

/**
 * 用弹窗正在显示的主预览取缩略图：只在该标记就属于当前画面、且预览已暂停时成立。
 *
 * 这是后台取帧的兜底路径 —— 主预览就是用户此刻看到的画面，导出标注帧早已证明它可读，
 * 因此「当前帧上的标注」永远拿得到缩略图，不依赖第二个 video 元素能否解码。
 */
export function previewVideoEditMarkThumbnail(
  video: HTMLVideoElement,
  mark: VideoEditMark,
  crop: VideoEditMarkThumbnailArea,
  width: number,
  height: number,
): string | null {
  if (
    video.readyState < 2 ||
    video.seeking ||
    !video.paused ||
    video.videoWidth < 1 ||
    video.videoHeight < 1
  )
    return null;
  if (!sameVideoEditFrame(mark.timeSeconds, video.currentTime)) return null;
  return encodeVideoEditMarkThumbnail(video, mark, crop, width, height);
}

/**
 * 取「标记所在那一帧」的自适应缩略图：把该时间点的画面按标记区域裁剪成 data URL。
 *
 * 用独立的后台 video 元素取帧，绝不动弹窗正在播放/暂停的主预览：
 * 缩略图是纯展示件，取帧失败（来源不允许截图、设备不支持该编码）只是没有缩略图，
 * 不改变标注本身的有效性，因此这里宁可返回 null 也不抛错。
 *
 * `crop` 是 videoEditMarkThumbnailGeometry 算出的画面区域（原视频像素），
 * `width`/`height` 沿用同一宽高比，只决定缩略图分辨率，因此画面不会被拉伸。
 */
export async function captureVideoEditFrameThumbnail(
  video: HTMLVideoElement,
  mark: VideoEditMark,
  options: {
    readonly timeSeconds: number;
    readonly crop: VideoEditMarkThumbnailArea;
    readonly width: number;
    readonly height: number;
    readonly settleMs?: number;
    readonly waitMs?: number;
  },
): Promise<string | null> {
  const { timeSeconds, crop, width, height, settleMs = 60, waitMs = 3_000 } = options;
  if (!(width >= 1 && height >= 1 && crop.width >= 1 && crop.height >= 1)) return null;
  if (video.readyState < 2 || video.videoWidth < 1 || video.videoHeight < 1) return null;
  const target = Math.max(
    0,
    Math.min(Number.isFinite(video.duration) ? video.duration : timeSeconds, timeSeconds),
  );
  if (!(await seekVideoElementToFrame(video, target, waitMs))) return null;
  if (video.readyState < 2 || video.videoWidth < 1 || video.videoHeight < 1) return null;
  // 让合成器把这一帧真正稳定下来，避免刚 seek 完就抓到上一帧的残留。
  if (settleMs > 0) await wait(settleMs);
  return encodeVideoEditMarkThumbnail(video, mark, crop, width, height);
}
