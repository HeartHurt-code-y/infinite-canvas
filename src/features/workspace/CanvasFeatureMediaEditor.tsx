import { readFile } from "@tauri-apps/plugin-fs";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ErrorAlert } from "../../components/ErrorAlert";
import { useModalFocusTrap } from "../../components/useModalFocusTrap";
import { toMediaSrc, type MediaReferenceTarget, type ProviderCatalogEntry } from "../../lib/backend";
import { toMediaProxyUrl } from "../../lib/mediaProxy";
import { prepareCanvasMediaSource } from "../../lib/videoLocalEdit";
import { useCanvasCommands, useCanvasStore } from "../canvas/canvasStore";
import { CanvasAudioResultEdit } from "./CanvasAudioResultEdit";
import { saveCanvasDerivedImages, type CanvasLocalEditSource } from "./canvasDerivedImage";
import type { CanvasFeatureAction, CanvasInlineFeatureRequest } from "./canvasFeatureCatalog";
import { CanvasImageTransformEditor } from "./CanvasImageInlineEditor";
import { CanvasImageRegionEditor, type StartImageRegionEdit } from "./CanvasImageRegionEditor";
import { captureFrame } from "./CanvasVideoResultActions";
import { CanvasVideoOpeningEditor, type StartOpeningLayerSplit, type VideoOpeningDraft } from "./CanvasVideoOpeningEditor";
import { LibTVMediaIcon } from "./LibTVMediaIcon";
import type { OutputNodeData } from "./workspaceModel";

type MediaAction = Extract<CanvasFeatureAction, { kind: "image" | "image-local" | "audio" | "frame" | "video-opening" }>;
export interface CanvasFeatureMediaSession {
  readonly action: MediaAction;
  readonly label: string;
  readonly nodeKey: string;
  readonly source: OutputNodeData | { readonly key: string; readonly name: string; readonly target: MediaReferenceTarget };
}

async function splitGrid(path: string, columns: number) {
  const bytes = await readFile(path);
  const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)]));
  try {
    if (bitmap.width < columns || bitmap.height < columns) throw new Error("图片太小，无法按所选宫格切分。");
    return Array.from({ length: columns * columns }, (_, index) => {
      const x = index % columns;
      const y = Math.floor(index / columns);
      const left = Math.floor(x * bitmap.width / columns);
      const top = Math.floor(y * bitmap.height / columns);
      const width = Math.floor((x + 1) * bitmap.width / columns) - left;
      const height = Math.floor((y + 1) * bitmap.height / columns) - top;
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("无法创建图片画布。");
      context.drawImage(bitmap, left, top, width, height, 0, 0, width, height);
      return { canvas, name: "宫格切分 " + (index + 1) };
    });
  } finally {
    bitmap.close();
  }
}

export function CanvasFeatureMediaEditor({ session, providers, onImageRegion, onVideoOpening, onOpeningLayerSplit, onClose }: {
  readonly session: CanvasFeatureMediaSession;
  readonly providers: readonly ProviderCatalogEntry[];
  readonly onImageRegion: StartImageRegionEdit;
  readonly onVideoOpening: (draft: VideoOpeningDraft) => void;
  readonly onOpeningLayerSplit: StartOpeningLayerSplit;
  readonly onClose: () => void;
}) {
  const { action, label, source, nodeKey } = session;
  const [original, setOriginal] = useState<{ source: CanvasLocalEditSource; src: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let disposed = false;
    let release: (() => Promise<void>) | undefined;
    void (async () => {
      try {
        if ("target" in source) {
          const local = await prepareCanvasMediaSource(source.target);
          if (disposed) {
            await local.release();
            return;
          }
          release = local.release;
          setOriginal({ source: { ...source, finalPath: local.path }, src: toMediaProxyUrl(local.src) ?? local.src });
        } else {
          if (!source.finalPath) throw new Error("等待素材保存后重试。");
          const src = toMediaSrc(source.finalPath);
          setOriginal({ source, src: toMediaProxyUrl(src) ?? src });
        }
      } catch (failure) {
        if (!disposed) setError(failure);
      }
    })();
    return () => { disposed = true; void release?.(); };
  }, [source]);
  const titleId = useId();
  const opening = action.kind === "video-opening";
  const childHandlesEscape = original != null && (action.kind === "image" || (action.kind === "image-local" && action.mode !== "grid"));
  const trap = useModalFocusTrap({ active: true, onEscape: childHandlesEscape ? undefined : onClose });
  return createPortal(
    <div className="canvas-all-features-scrim">
      <section ref={trap.ref} {...trap.containerProps}
        className={opening ? "canvas-feature-edit canvas-feature-edit--opening" : "canvas-feature-edit"}
        role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header><h2 id={titleId} className={opening ? "sr-only" : undefined}>{label}</h2>{childHandlesEscape ? null : (
          <button type="button" aria-label="关闭" onClick={onClose}>
            <LibTVMediaIcon name={opening ? "close-n" : "library-q4-close"} size={opening ? 18 : 16} />
          </button>
        )}</header>
        {error ? <ErrorAlert error={error} /> : original ? action.kind === "video-opening" ? (
          <CanvasVideoOpeningEditor src={original.src} source={original.source} nodeKey={nodeKey} providers={providers}
            onSplit={onOpeningLayerSplit}
            onSave={draft => { onVideoOpening(draft); onClose(); }} />
        ) : (
          <FeatureEditorBody action={action} label={label} nodeKey={nodeKey} original={original}
            providers={providers} onImageRegion={onImageRegion} onClose={onClose} />
        ) : <p role="status">正在读取原素材…</p>}
      </section>
    </div>, document.body,
  );
}

function FeatureEditorBody({ action, label, nodeKey, original, providers, onImageRegion, onClose }: {
  readonly action: Exclude<MediaAction, { kind: "video-opening" }>;
  readonly label: string;
  readonly nodeKey: string;
  readonly original: { source: CanvasLocalEditSource; src: string };
  readonly providers: readonly ProviderCatalogEntry[];
  readonly onImageRegion: StartImageRegionEdit;
  readonly onClose: () => void;
}) {
  const [mediaHost, setMediaHost] = useState<HTMLDivElement | null>(null);
  const [pixelSize, setPixelSize] = useState<{ width: number; height: number } | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const player = useRef<HTMLAudioElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [audioRequest, setAudioRequest] = useState<CanvasInlineFeatureRequest | undefined>(() =>
    action.kind === "audio" && original.source.finalPath ? {
      nodeKey, sourcePath: original.source.finalPath, action, onHandled: () => setAudioRequest(undefined),
    } : undefined);
  const commands = useCanvasCommands();
  const store = useCanvasStore();
  useEffect(() => () => pending.current?.abort(), []);
  const save = async () => {
    if (pending.current || !original.source.finalPath) return;
    const controller = new AbortController();
    pending.current = controller;
    setSaving(true);
    setFailure(null);
    try {
      const images = action.kind === "frame" ? [{
        canvas: await captureFrame(original.src, action.mode, video.current?.currentTime ?? 0, controller.signal), name: label,
      }] : action.kind === "image-local" && action.mode === "grid" ? await splitGrid(original.source.finalPath, action.columns) : [];
      await saveCanvasDerivedImages({ images, store, commands, nodeKey, output: original.source, signal: controller.signal });
      if (!controller.signal.aborted) onClose();
    } catch (error) {
      if (!controller.signal.aborted) setFailure(error);
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) setSaving(false);
    }
  };
  if (action.kind === "audio") return <>
    <audio ref={player} src={original.src} preload="metadata" onLoadedMetadata={event => {
      const seconds = event.currentTarget.duration;
      if (Number.isFinite(seconds) && seconds > 0) setDuration(seconds);
    }} onError={() => setFailure(new Error("无法播放这份音频。"))} />
    {failure ? <ErrorAlert error={failure} /> : <CanvasAudioResultEdit nodeKey={nodeKey} output={original.source}
      duration={duration} playerRef={player} providerCatalog={providers} exporting={false}
      featureRequest={audioRequest} />}
  </>;
  if (action.kind === "frame") return <>
    <video ref={video} src={original.src} controls playsInline preload="metadata" />
    {failure ? <ErrorAlert error={failure} /> : null}
    <footer><button type="button" disabled={saving} onClick={() => void save()}>{saving ? "保存中…" : "保存截图"}</button></footer>
  </>;

  const ratio = pixelSize ? pixelSize.width / pixelSize.height : 1.5;
  const mode = action.mode;
  const isGrid = action.kind === "image-local" && action.mode === "grid";
  return <>
    <div className="canvas-feature-edit__image-stage" ref={setMediaHost}
      style={{ width: `min(72vw, 640px, ${38 * ratio}vh, ${360 * ratio}px)`, aspectRatio: ratio }}>
      <img src={original.src} alt={original.source.name ?? "源图片"}
        className={action.mode === "rotate" ? "canvas-feature-edit__hidden-image" : undefined}
        onLoad={event => setPixelSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
        onError={() => setFailure(new Error("无法读取图片预览。"))} />
      {mode === "crop" || mode === "rotate" ? (
        <CanvasImageTransformEditor mode={mode} nodeKey={nodeKey} output={original.source} mediaHost={mediaHost} onClose={onClose} />
      ) : mode !== "grid" ? (
        <CanvasImageRegionEditor mode={mode} mediaHost={mediaHost} pixelSize={pixelSize} source={original.source}
          nodeKey={nodeKey} providers={providers} onStart={onImageRegion} onClose={onClose} />
      ) : null}
    </div>
    {failure ? <ErrorAlert error={failure} /> : null}
    {isGrid ? <footer><button type="button" disabled={saving || !pixelSize} onClick={() => void save()}>
      {saving ? "保存中…" : `切分为 ${action.columns ** 2} 张图片`}
    </button></footer> : null}
  </>;
}
