import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { backendErrorMessage, isDesktopRuntime } from "../../lib/backend";
import { toast } from "../../lib/toast";
import { useCanvasCommands, useCanvasStore } from "../canvas/canvasStore";
import { artifactFileName, validateArtifactName } from "./artifactNames";
import { exportArtifactToDesktop } from "./desktopActions";
import { CanvasNodeActionsMenu } from "./CanvasNodeActionsMenu";
import { saveCanvasDerivedImage } from "./canvasDerivedImage";
import type { CanvasInlineFeatureRequest } from "./canvasFeatureCatalog";
import { LibTVMediaIcon } from "./LibTVMediaIcon";
import type { OutputNodeData } from "./workspaceModel";

type FrameKind = "current" | "first" | "last";
const FRAME_ACTIONS = [
  { kind: "current", label: "截取当前帧", name: "截图" },
  { kind: "first", label: "截取首帧", name: "首帧" },
  { kind: "last", label: "截取尾帧", name: "尾帧" },
] as const;

function formatTime(seconds: number) {
  const elapsed = Math.floor(seconds);
  return Math.floor(elapsed / 60) + ":" + String(elapsed % 60).padStart(2, "0");
}

function waitForVideo(
  video: HTMLVideoElement,
  event: "loadeddata" | "seeked",
  start: () => void,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const finish = (error?: unknown) => {
      clearTimeout(timer);
      video.removeEventListener(event, ready);
      video.removeEventListener("error", failed);
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const ready = () => finish();
    const failed = () => finish(new Error("无法解码当前视频。"));
    const abort = () => finish(signal.reason);
    const timer = window.setTimeout(() => finish(new Error("读取视频帧超时。")), 10_000);
    video.addEventListener(event, ready);
    video.addEventListener("error", failed);
    signal.addEventListener("abort", abort, { once: true });
    try { start(); } catch (error) { finish(error); }
  });
}

async function withVideoFrames<T>(
  src: string, signal: AbortSignal, read: (video: HTMLVideoElement, lastTime: number) => Promise<T>,
): Promise<T> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.crossOrigin = "anonymous";
  video.preload = "auto";
  try {
    await waitForVideo(video, "loadeddata", () => { video.src = src; }, signal);
    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("无法读取视频时长。");
    return await read(video, Math.max(duration - 0.05, 0));
  } finally {
    video.removeAttribute("src");
    video.load();
  }
}

/** 在独立视频元素上定位，不移动画布播放器的进度。 */
export function captureFrame(src: string, kind: FrameKind, currentTime: number, signal: AbortSignal) {
  return withVideoFrames(src, signal, async (video, lastTime) => {
    const target = kind === "first" ? 0 : kind === "last" ? lastTime
      : Math.max(0, Math.min(lastTime, currentTime));
    if (target !== video.currentTime) {
      await waitForVideo(video, "seeked", () => { video.currentTime = target; }, signal);
    }
    signal.throwIfAborted();
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context || !canvas.width || !canvas.height) throw new Error("无法读取视频画面。");
    context.drawImage(video, 0, 0);
    return canvas;
  });
}

export function captureOpeningFilmstrip(src: string, signal: AbortSignal) {
  return withVideoFrames(src, signal, async (video, lastTime) => {
    if (!video.videoWidth || !video.videoHeight) return [];
    const canvas = document.createElement("canvas");
    canvas.width = 96;
    canvas.height = Math.max(1, Math.round(96 * video.videoHeight / video.videoWidth));
    const context = canvas.getContext("2d");
    if (!context) return [];
    const thumbnails: string[] = [];
    for (let index = 0; index < 11; index += 1) {
      signal.throwIfAborted();
      const time = lastTime * index / 10;
      if (Math.abs(time - video.currentTime) > .001) {
        await waitForVideo(video, "seeked", () => { video.currentTime = time; }, signal);
      }
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      thumbnails.push(canvas.toDataURL("image/jpeg", .75));
    }
    return thumbnails;
  });
}

export function CanvasVideoResultActions({ nodeKey, output, src, playerRef, onPreview, featureRequest }: {
  readonly featureRequest?: CanvasInlineFeatureRequest | undefined;
  readonly nodeKey: string;
  readonly output: OutputNodeData;
  readonly src: string;
  readonly playerRef: RefObject<HTMLVideoElement | null>;
  readonly onPreview: (key: string) => void;
}) {
  const store = useCanvasStore();
  const commands = useCanvasCommands();
  const operation = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [playback, setPlayback] = useState({ time: 0, duration: 0, playing: false, muted: false, volume: 1 });
  useEffect(() => () => { operation.current?.abort(); }, []);
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    const update = () => setPlayback({
      time: player.currentTime, duration: Number.isFinite(player.duration) ? player.duration : 0,
      playing: !player.paused && !player.ended, muted: player.muted, volume: player.volume,
    });
    const events = ["loadedmetadata", "durationchange", "timeupdate", "play", "pause", "ended", "emptied", "volumechange"];
    for (const event of events) player.addEventListener(event, update);
    update();
    return () => { for (const event of events) player.removeEventListener(event, update); };
  }, [playerRef, src]);

  const localPath = output.finalPath;
  const capture = useCallback(async (action: typeof FRAME_ACTIONS[number], fromCatalog = false) => {
    if (operation.current || !isDesktopRuntime() || !localPath) return;
    const player = playerRef.current;
    if (!fromCatalog && action.kind === "current" && (!player || player.readyState < 2)) {
      toast.error("请先加载视频，再截取当前帧。");
      return;
    }
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    try {
      const canvas = await captureFrame(src, action.kind, player?.currentTime ?? 0, controller.signal);
      await saveCanvasDerivedImage({
        canvas, name: action.name, store, commands, nodeKey, output, signal: controller.signal,
      });
    } catch (error) {
      if (!controller.signal.aborted) toast.error("截帧失败：" + backendErrorMessage(error));
    } finally {
      if (operation.current === controller) operation.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }, [commands, localPath, nodeKey, output, playerRef, src, store]);
  useEffect(() => {
    if (featureRequest?.action.kind !== "frame") return;
    featureRequest.onHandled();
    if (featureRequest.sourcePath !== localPath) return;
    const mode = featureRequest.action.mode;
    const action = FRAME_ACTIONS.find(entry => entry.kind === mode);
    if (action) void capture(action, true);
  }, [capture, featureRequest, localPath]);

  if (!isDesktopRuntime() || !localPath) return null;

  const download = async () => {
    if (exporting) return;
    const name = output.name?.trim() || "视频";
    setExporting(true);
    try {
      const saved = await exportArtifactToDesktop(localPath, artifactFileName(validateArtifactName(name) ? "视频" : name, localPath));
      if (saved) toast.success("视频已保存");
    } catch (error) {
      toast.error("下载失败：" + backendErrorMessage(error));
    } finally {
      setExporting(false);
    }
  };

  const togglePlayback = () => {
    const player = playerRef.current;
    if (!player) return;
    if (player.paused) void player.play().catch(error => toast.error("播放失败：" + backendErrorMessage(error)));
    else player.pause();
  };
  const muted = playback.muted || playback.volume === 0;
  const progress = playback.duration > 0 ? playback.time / playback.duration * 100 : 0;

  return <>
    <div className="canvas-video-result-actions nodrag nopan" role="group" aria-label="视频操作"
      onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()}
      onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
      <button type="button" aria-label={exporting ? "下载中" : "下载视频"} data-tooltip="下载视频"
        disabled={exporting} onClick={() => { void download(); }}>
        <LibTVMediaIcon name={exporting ? "icon-loading" : "download"} size={16} className={exporting ? "spin-icon" : ""} />
      </button>
      <button type="button" aria-label="全屏预览" data-tooltip="全屏预览" onClick={() => {
        playerRef.current?.pause();
        onPreview(output.key);
      }}>
        <LibTVMediaIcon name="broad-picture" size={16} />
      </button>
    </div>
    <div className="canvas-video-transport nodrag nopan" role="group" aria-label="视频播放"
      onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()}
      onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
      <button type="button" aria-label={playback.playing ? "暂停视频" : "播放视频"}
        disabled={!playback.duration} onClick={togglePlayback}>
        <LibTVMediaIcon name={playback.playing ? "icon-pause-filled-small" : "icon-play-filled-small"} size={16} />
      </button>
      <span>{formatTime(playback.time)}</span>
      <input className="canvas-video-transport__seek" type="range" aria-label="视频播放位置"
        disabled={!playback.duration} min={0} max={playback.duration} step="any" value={playback.time}
        style={{ backgroundSize: progress + "% 3px, 100% 3px" }} onChange={event => {
          const player = playerRef.current;
          if (player) player.currentTime = event.currentTarget.valueAsNumber;
        }} />
      <span>{playback.duration ? formatTime(playback.duration) : "--:--"}</span>
      <div className="canvas-video-transport__volume">
        <button type="button" aria-label={muted ? "取消静音" : "静音"} disabled={!playback.duration} onClick={() => {
          const player = playerRef.current;
          if (!player) return;
          if (player.volume === 0) player.volume = 1;
          player.muted = !muted;
        }}><LibTVMediaIcon name={muted ? "off-audio" : "audio"} size={14} /></button>
        <label className="canvas-video-transport__volume-popover">
          <span>{Math.round((muted ? 0 : playback.volume) * 100)}</span>
          <input type="range" aria-label="视频音量" min={0} max={1} step={0.01} value={muted ? 0 : playback.volume}
            onChange={event => {
              const player = playerRef.current;
              if (!player) return;
              player.volume = event.currentTarget.valueAsNumber;
              player.muted = player.volume === 0;
            }} />
        </label>
      </div>
      <CanvasNodeActionsMenu label="截帧" tooltip={busy ? "正在截帧" : "截帧"} preferAbove
        icon={<LibTVMediaIcon name={busy ? "icon-loading" : "icon-group-storyboard"} size={16} className={busy ? "spin-icon" : ""} />}>
        {FRAME_ACTIONS.map(action => (
          <button key={action.kind} type="button" disabled={busy} onClick={() => { void capture(action); }}>{action.label}</button>
        ))}
      </CanvasNodeActionsMenu>
    </div>
  </>;
}
