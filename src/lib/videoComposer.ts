export interface VideoCompositionInput {
  readonly key: string;
  readonly name: string;
  readonly src: string;
}

export interface VideoCompositionFormat {
  readonly mimeType: string;
  readonly extension: "mp4" | "webm";
}

export interface VideoCompositionResult {
  readonly blob: Blob;
  readonly format: VideoCompositionFormat;
  readonly width: number;
  readonly height: number;
  readonly duration: number;
}

export interface ComposeVideosOptions {
  readonly onProgress?: (progress: number) => void;
  readonly signal?: AbortSignal;
}

const RECORDING_FORMAT_CANDIDATES: readonly VideoCompositionFormat[] = [
  { mimeType: 'video/mp4;codecs="avc1.42E01E,mp4a.40.2"', extension: "mp4" },
  { mimeType: "video/mp4", extension: "mp4" },
  { mimeType: "video/webm;codecs=vp9,opus", extension: "webm" },
  { mimeType: "video/webm;codecs=vp8,opus", extension: "webm" },
  { mimeType: "video/webm", extension: "webm" },
];

/** 让已保存的用户顺序与当前连线集合对齐：保留仍存在的项，新连线按建立顺序追加。 */
export function normalizeVideoInputOrder(
  savedOrder: readonly string[],
  connectedKeys: readonly string[],
): readonly string[] {
  const connected = new Set(connectedKeys);
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const key of savedOrder) {
    if (!connected.has(key) || seen.has(key)) continue;
    normalized.push(key);
    seen.add(key);
  }
  for (const key of connectedKeys) {
    if (seen.has(key)) continue;
    normalized.push(key);
    seen.add(key);
  }
  return normalized;
}

/** 选择当前 WebView 能稳定录制的容器；优先 MP4，不可用时回退 WebM。 */
export function preferredVideoCompositionFormat(
  recorder: Pick<typeof MediaRecorder, "isTypeSupported"> | undefined = typeof MediaRecorder ===
  "undefined"
    ? undefined
    : MediaRecorder,
): VideoCompositionFormat | null {
  if (recorder == null) return null;
  return (
    RECORDING_FORMAT_CANDIDATES.find((candidate) => recorder.isTypeSupported(candidate.mimeType)) ??
    null
  );
}

/** 输出分辨率跟随首段视频，同时钳制到 1920×1080 并保持偶数像素，兼容常见编码器。 */
export function compositionCanvasSize(
  sourceWidth: number,
  sourceHeight: number,
): { width: number; height: number } {
  const safeWidth = Number.isFinite(sourceWidth) && sourceWidth > 0 ? sourceWidth : 1280;
  const safeHeight = Number.isFinite(sourceHeight) && sourceHeight > 0 ? sourceHeight : 720;
  const scale = Math.min(1, 1920 / safeWidth, 1080 / safeHeight);
  const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
  return { width: even(safeWidth * scale), height: even(safeHeight * scale) };
}

export function composedVideoFileName(
  requestedName: string,
  extension: VideoCompositionFormat["extension"],
  now = new Date(),
): string {
  const printableName = Array.from(requestedName)
    .filter((character) => character.charCodeAt(0) >= 32)
    .join("");
  const base = printableName
    .trim()
    .replace(/\.(?:mp4|webm)$/i, "")
    .replace(/[<>:"/\\|?*]/g, "-")
    .replace(/[. ]+$/g, "")
    .slice(0, 80);
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
  return `${base || "合成视频"}-${stamp}.${extension}`;
}

function abortError(): DOMException {
  return new DOMException("视频合成已取消。", "AbortError");
}

function waitForVideoMetadata(video: HTMLVideoElement, signal?: AbortSignal): Promise<void> {
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener("loadedmetadata", handleLoaded);
      video.removeEventListener("error", handleError);
      signal?.removeEventListener("abort", handleAbort);
    };
    const handleLoaded = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error("视频元数据读取失败，源媒体可能已失效或格式不受支持。"));
    };
    const handleAbort = () => {
      cleanup();
      reject(abortError());
    };
    video.addEventListener("loadedmetadata", handleLoaded, { once: true });
    video.addEventListener("error", handleError, { once: true });
    signal?.addEventListener("abort", handleAbort, { once: true });
  });
}

function waitForRecorderStop(recorder: MediaRecorder): Promise<void> {
  return new Promise((resolve, reject) => {
    recorder.addEventListener("stop", () => resolve(), { once: true });
    recorder.addEventListener("error", () => reject(new Error("浏览器视频编码器运行失败。")), {
      once: true,
    });
  });
}

function drawContainedVideo(
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  width: number,
  height: number,
): void {
  context.fillStyle = "#000";
  context.fillRect(0, 0, width, height);
  const videoRatio = video.videoWidth / video.videoHeight;
  const canvasRatio = width / height;
  const drawWidth = videoRatio > canvasRatio ? width : height * videoRatio;
  const drawHeight = videoRatio > canvasRatio ? width / videoRatio : height;
  context.drawImage(
    video,
    (width - drawWidth) / 2,
    (height - drawHeight) / 2,
    drawWidth,
    drawHeight,
  );
}

async function playAndDrawVideo(
  video: HTMLVideoElement,
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  elapsedBefore: number,
  totalDuration: number,
  options: ComposeVideosOptions,
): Promise<void> {
  video.currentTime = 0;
  await video.play();
  await new Promise<void>((resolve, reject) => {
    let animationFrame = 0;
    const cleanup = () => {
      window.cancelAnimationFrame(animationFrame);
      video.removeEventListener("ended", handleEnded);
      video.removeEventListener("error", handleError);
      options.signal?.removeEventListener("abort", handleAbort);
    };
    const finish = () => {
      drawContainedVideo(context, video, width, height);
      cleanup();
      resolve();
    };
    const handleEnded = () => finish();
    const handleError = () => {
      cleanup();
      reject(new Error("视频播放失败，无法继续合成。"));
    };
    const handleAbort = () => {
      video.pause();
      cleanup();
      reject(abortError());
    };
    const draw = () => {
      if (video.ended) {
        finish();
        return;
      }
      drawContainedVideo(context, video, width, height);
      const elapsed = elapsedBefore + Math.min(video.duration, video.currentTime);
      options.onProgress?.(Math.min(96, Math.round((elapsed / totalDuration) * 96)));
      animationFrame = window.requestAnimationFrame(draw);
    };
    video.addEventListener("ended", handleEnded, { once: true });
    video.addEventListener("error", handleError, { once: true });
    options.signal?.addEventListener("abort", handleAbort, { once: true });
    draw();
  });
}

/**
 * 在 WebView 内实时重放各段视频并录制为单一文件。画面按首段比例完整适配（不裁切），
 * 音频通过 Web Audio 汇入同一录制流；不同分辨率或编码的输入也能顺序合成。
 */
export async function composeVideosInOrder(
  inputs: readonly VideoCompositionInput[],
  options: ComposeVideosOptions = {},
): Promise<VideoCompositionResult> {
  if (inputs.length < 2) throw new Error("至少连接 2 段视频后才能合成。");
  if (options.signal?.aborted) throw abortError();
  const format = preferredVideoCompositionFormat();
  if (format == null) throw new Error("当前系统 WebView 不支持视频录制，请升级系统后重试。");

  const videos = inputs.map((input) => {
    const video = document.createElement("video");
    video.preload = "auto";
    video.playsInline = true;
    if (/^https?:\/\//i.test(input.src)) video.crossOrigin = "anonymous";
    video.src = input.src;
    return video;
  });
  let audioContext: AudioContext | null = null;
  let capturedStream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  try {
    options.onProgress?.(1);
    await Promise.all(videos.map((video) => waitForVideoMetadata(video, options.signal)));
    const totalDuration = videos.reduce((sum, video) => {
      if (!Number.isFinite(video.duration) || video.duration <= 0) {
        throw new Error("输入视频时长无效，无法确定合成顺序。");
      }
      return sum + video.duration;
    }, 0);
    const { width, height } = compositionCanvasSize(
      videos[0]?.videoWidth ?? 0,
      videos[0]?.videoHeight ?? 0,
    );
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    if (context == null || typeof canvas.captureStream !== "function") {
      throw new Error("当前系统 WebView 不支持画布视频流录制。请升级系统后重试。");
    }
    context.fillStyle = "#000";
    context.fillRect(0, 0, width, height);

    const canvasStream = canvas.captureStream(30);
    const AudioContextConstructor = window.AudioContext;
    if (AudioContextConstructor == null) throw new Error("当前系统不支持音频合成。");
    audioContext = new AudioContextConstructor();
    await audioContext.resume();
    const audioDestination = audioContext.createMediaStreamDestination();
    const audioSources = videos.map((video) => {
      const source = audioContext!.createMediaElementSource(video);
      source.connect(audioDestination);
      return source;
    });
    capturedStream = new MediaStream([
      ...canvasStream.getVideoTracks(),
      ...audioDestination.stream.getAudioTracks(),
    ]);
    recorder = new MediaRecorder(capturedStream, {
      mimeType: format.mimeType,
      videoBitsPerSecond: width * height >= 1920 * 1080 ? 10_000_000 : 6_000_000,
      audioBitsPerSecond: 192_000,
    });
    const chunks: BlobPart[] = [];
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    });
    recorder.start(1_000);

    let elapsed = 0;
    try {
      for (const video of videos) {
        await playAndDrawVideo(video, context, width, height, elapsed, totalDuration, options);
        elapsed += video.duration;
      }
    } finally {
      for (const source of audioSources) source.disconnect();
    }
    options.onProgress?.(98);
    const stopped = waitForRecorderStop(recorder);
    recorder.stop();
    await stopped;
    const blob = new Blob(chunks, { type: format.mimeType });
    if (blob.size === 0) throw new Error("视频编码器没有产生可保存的数据。");
    options.onProgress?.(100);
    return { blob, format, width, height, duration: totalDuration };
  } finally {
    if (recorder != null && recorder.state !== "inactive") recorder.stop();
    for (const video of videos) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
    capturedStream?.getTracks().forEach((track) => track.stop());
    if (audioContext != null && audioContext.state !== "closed") await audioContext.close();
  }
}
