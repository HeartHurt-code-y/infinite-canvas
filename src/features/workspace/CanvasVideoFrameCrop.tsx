import { createContext, useContext, useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { useEscapeHandler } from "../../components/escapeArbiter";
import { ErrorAlert } from "../../components/ErrorAlert";
import type { MediaReferenceTarget } from "../../lib/backend";
import { prepareCanvasMediaSource } from "../../lib/videoLocalEdit";
import { isVideoPreparationActive, videoPreparationClient, type VideoPreparationCrop, type VideoPreparationJob,
  type VideoPreparationOutput, type VideoPreparationProbe } from "../../lib/videoPreparation";
import { LibTVMediaIcon } from "./LibTVMediaIcon";
import "./CanvasVideoFrameCrop.css";

export interface VideoFrameCropSession {
  readonly key: string;
  readonly name: string;
  readonly target: MediaReferenceTarget;
  readonly onClose: () => void;
  readonly onResult: (output: VideoPreparationOutput, job: VideoPreparationJob) => void;
}

export const CanvasVideoFrameCropContext = createContext<VideoFrameCropSession | null>(null);

type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
type Gesture = Handle | "draw" | "move";
const HANDLES: readonly Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const INITIAL_CROP = { x: .1, y: .1, width: .8, height: .8 };
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function updateRect(rect: VideoPreparationCrop, mode: Gesture, dx: number, dy: number, minX: number, minY: number) {
  const { x, y, width, height } = rect;
  const right = x + width;
  const bottom = y + height;
  if (mode === "draw") {
    const w = Math.max(minX, Math.abs(dx));
    const h = Math.max(minY, Math.abs(dy));
    return { x: clamp(x + Math.min(0, dx), 0, 1 - w), y: clamp(y + Math.min(0, dy), 0, 1 - h), width: w, height: h };
  }
  if (mode === "move") return { ...rect, x: clamp(x + dx, 0, 1 - width), y: clamp(y + dy, 0, 1 - height) };
  const west = mode.includes("w");
  const east = mode.includes("e");
  const north = mode.includes("n");
  const south = mode.includes("s");
  if ((west || east) && (north || south)) {
    const maxWidth = west ? right : 1 - x;
    const maxHeight = north ? bottom : 1 - y;
    const scale = clamp(1 + (west ? -dx : dx) / width, Math.max(minX / width, minY / height),
      Math.min(maxWidth / width, maxHeight / height));
    return { x: west ? right - width * scale : x, y: north ? bottom - height * scale : y, width: width * scale, height: height * scale };
  }
  const nextX = west ? clamp(x + dx, 0, right - minX) : x;
  const nextY = north ? clamp(y + dy, 0, bottom - minY) : y;
  return {
    x: nextX, y: nextY,
    width: (east ? clamp(right + dx, x + minX, 1) : right) - nextX,
    height: (south ? clamp(bottom + dy, y + minY, 1) : bottom) - nextY,
  };
}

export function CanvasVideoFrameCrop({ nodeKey }: { readonly nodeKey: string }) {
  const session = useContext(CanvasVideoFrameCropContext);
  return session?.key === nodeKey ? <VideoFrameCrop key={nodeKey} session={session} /> : null;
}

function VideoFrameCrop({ session }: { readonly session: VideoFrameCropSession }) {
  const stage = useRef<HTMLDivElement>(null);
  const lifetime = useRef<AbortController | null>(null);
  const submitting = useRef(false);
  const gesture = useRef<{ id: number; x: number; y: number; rect: VideoPreparationCrop; mode: Gesture } | null>(null);
  const [probe, setProbe] = useState<VideoPreparationProbe | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [crop, setCrop] = useState<VideoPreparationCrop>(INITIAL_CROP);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);
  const playhead = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    const original = stage.current?.parentElement?.querySelector("video:not(.canvas-video-frame-crop__player)");
    if (original instanceof HTMLVideoElement) {
      playhead.current = original.currentTime;
      original.pause();
    }
    let release: (() => Promise<void>) | undefined;
    void videoPreparationClient.probe(session.target).then(value => {
      if (!controller.signal.aborted) setProbe(value);
    }, failure => { if (!controller.signal.aborted) setError(failure); });
    void prepareCanvasMediaSource(session.target).then(preview => {
      if (controller.signal.aborted) { void preview.release(); return; }
      release = preview.release;
      setSrc(preview.src);
    }, failure => { if (!controller.signal.aborted) setError(failure); });
    return () => { controller.abort(); void release?.(); };
  }, [session.target]);

  useEscapeHandler({ canHandle: () => !submitting.current, handle: session.onClose });
  const sourceWidth = probe?.width ?? 0;
  const sourceHeight = probe?.height ?? 0;
  const outputWidth = Math.floor(crop.width * sourceWidth / 2) * 2;
  const outputHeight = Math.floor(crop.height * sourceHeight / 2) * 2;
  const valid = ready && Math.min(outputWidth, outputHeight) >= 2 &&
    Math.min(crop.width, crop.height) * Math.min(sourceWidth, sourceHeight) >= 2;

  function startGesture(event: PointerEvent<HTMLDivElement>) {
    if (busy || !valid || event.button !== 0 || (event.target as Element).closest("button")) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const y = clamp((event.clientY - rect.top) / rect.height, 0, 1);
    const mode = ((event.target as HTMLElement).closest<HTMLElement>("[data-crop-gesture]")?.dataset["cropGesture"] ?? "draw") as Gesture;
    gesture.current = { id: event.pointerId, x, y, mode, rect: mode === "draw" ? { x, y, width: 0, height: 0 } : crop };
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  async function applyCrop() {
    const signal = lifetime.current?.signal;
    if (!probe || !valid || !signal || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    let job: VideoPreparationJob | undefined;
    try {
      const name = session.name.replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|]/g, "_").trim().slice(0, 64) || "视频";
      job = await videoPreparationClient.start({ source: session.target, sourceIdentity: probe.sourceIdentity,
        name: name + " · 裁切", operation: "clip_video", startSeconds: 0, endSeconds: probe.durationSeconds, crop });
      while (isVideoPreparationActive(job)) {
        signal.throwIfAborted();
        setProgress(job.progress ?? null);
        await new Promise<void>(resolve => window.setTimeout(resolve, 700));
        signal.throwIfAborted();
        job = await videoPreparationClient.get(job.jobId);
      }
      signal.throwIfAborted();
      if (job.status !== "completed" || !job.output) throw new Error(job.error ?? "画面裁切未完成。");
      session.onResult(job.output, job);
    } catch (failure) {
      if (signal.aborted) {
        if (job && isVideoPreparationActive(job)) void videoPreparationClient.cancel(job.jobId).catch(() => {});
      } else setError(failure);
    } finally {
      submitting.current = false;
      if (!signal.aborted) { setBusy(false); setProgress(null); }
    }
  }

  return <div ref={stage} className="canvas-video-frame-crop nodrag nopan nowheel"
    role="group" aria-label="画面裁切"
    onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()}
    onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
    <div className="canvas-video-frame-crop__surface"
      style={{ "--crop-ratio": sourceWidth && sourceHeight ? sourceWidth / sourceHeight : 16 / 9 } as CSSProperties}
      onPointerDown={startGesture} onPointerMove={event => {
        const start = gesture.current;
        if (!start || event.pointerId !== start.id) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        const x = clamp((event.clientX - bounds.left) / bounds.width, 0, 1);
        const y = clamp((event.clientY - bounds.top) / bounds.height, 0, 1);
        const min = Math.max(.03, 2 / Math.min(sourceWidth, sourceHeight));
        setCrop(updateRect(start.rect, start.mode, x - start.x, y - start.y,
          Math.min(.5, Math.max(min, 28 / bounds.width)), Math.min(.5, Math.max(min, 28 / bounds.height))));
      }} onLostPointerCapture={() => { gesture.current = null; }}>
      {src ? <video className="canvas-video-frame-crop__player" src={src} muted playsInline preload="auto"
        onLoadedData={event => {
          const element = event.currentTarget;
          element.currentTime = Math.min(playhead.current, Math.max(0, element.duration - .05));
          setReady(true);
        }} onError={() => { setReady(false); setError(new Error("无法读取视频预览。")); }} /> : null}
      {ready && probe ? <div className="canvas-video-frame-crop__rect" data-crop-gesture="move" tabIndex={0}
        aria-label="裁切选区，方向键移动，Shift 加方向键调整尺寸"
        onKeyDown={event => {
          const dx = Number(event.key === "ArrowRight") - Number(event.key === "ArrowLeft");
          const dy = Number(event.key === "ArrowDown") - Number(event.key === "ArrowUp");
          if (busy || (!dx && !dy)) return;
          event.preventDefault();
          event.stopPropagation();
          const mode = event.shiftKey ? dx ? "e" : "s" : "move";
          setCrop(rect => updateRect(rect, mode, dx * .01, dy * .01, .03, .03));
        }}
        style={{ left: crop.x * 100 + "%", top: crop.y * 100 + "%", width: crop.width * 100 + "%", height: crop.height * 100 + "%" }}>
        <span className="canvas-video-frame-crop__size">{outputWidth} × {outputHeight}</span>
        {HANDLES.map(handle => <span key={handle} data-crop-gesture={handle} className="canvas-video-frame-crop__handle" />)}
      </div> : null}
    </div>
    {error ? <div className="canvas-video-frame-crop__status"><ErrorAlert error={error} /></div> :
      !ready || busy ? <span role="status" className="canvas-video-frame-crop__status">
        {busy ? `正在裁切${progress == null ? "…" : " " + Math.round(progress) + "%"}` : "正在读取视频…"}
      </span> : null}
    <div className="canvas-video-frame-crop__actions">
      <button type="button" aria-label="取消画面裁切" data-tooltip="取消" disabled={busy} onClick={session.onClose}>
        <LibTVMediaIcon name="close-n" size={16} />
      </button>
      <button type="button" aria-label="应用画面裁切" data-tooltip="应用裁切" disabled={busy || !valid} onClick={() => void applyCrop()}>
        <LibTVMediaIcon name={busy ? "icon-loading" : "check"} className={busy ? "spin-icon" : ""} size={16} />
      </button>
    </div>
  </div>;
}
