import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { CanvasSelect } from "../../components/CanvasSelect";
import { ErrorAlert } from "../../components/ErrorAlert";
import type { ProviderCatalogEntry } from "../../lib/backend";
import { toast } from "../../lib/toast";
import { useCanvasCommands, useCanvasStore } from "../canvas/canvasStore";
import { atlasLayerProviders } from "./CanvasLayerSeparation";
import { CanvasOpeningLayerEditor } from "./CanvasOpeningLayerEditor";
import { CanvasOpeningTemplates, OPENING_DEFAULT_STYLE, type OpeningTab, type OpeningTextStyle } from "./CanvasOpeningTemplates";
import { saveCanvasDerivedImages, type CanvasLocalEditSource } from "./canvasDerivedImage";
import { captureFrame, captureOpeningFilmstrip } from "./CanvasVideoResultActions";
import { LibTVMediaIcon } from "./LibTVMediaIcon";
import { copyOpeningFrame, paintOpeningLayers, waitForOpeningLayers, type OpeningLayer, type OpeningTextLayer } from "./openingLayers";
import "./CanvasOpeningTools.css";

export interface VideoOpeningDraft {
  readonly firstFrameKey: string;
  readonly title: string;
  readonly motion: string;
}

export type StartOpeningLayerSplit = (assetKey: string, providerId: string) => Promise<string>;

interface OpeningVersion {
  readonly id: string;
  readonly base: HTMLCanvasElement;
  readonly layers: readonly OpeningLayer[];
  readonly cover: string;
  readonly name: string;
}

const PRIMARY_TITLE = "opening-title";
const DEFAULT_MOTION = "文字缓慢清晰显现，背景自然过渡。";
const clamp = (value: number, max: number) => Math.max(0, Math.min(value, max));
function textLayer(id: string, text: string, style: OpeningTextStyle, y = .5): OpeningTextLayer {
  return { id, kind: "text", text, x: .5, y, visible: true, ...style };
}

export function CanvasVideoOpeningEditor({ src, source, nodeKey, providers, onSplit, onSave }: {
  readonly src: string;
  readonly source: CanvasLocalEditSource;
  readonly nodeKey: string;
  readonly providers: readonly ProviderCatalogEntry[];
  readonly onSplit: StartOpeningLayerSplit;
  readonly onSave: (draft: VideoOpeningDraft) => void;
}) {
  const store = useCanvasStore();
  const commands = useCanvasCommands();
  const video = useRef<HTMLVideoElement>(null);
  const preview = useRef<HTMLCanvasElement>(null);
  const busy = useRef<AbortController | null>(null);
  const [working, setWorking] = useState(false);
  const [frame, setFrame] = useState<HTMLCanvasElement | null>(null);
  const [base, setBase] = useState<HTMLCanvasElement | null>(null);
  const [title, setTitle] = useState("");
  const [style, setStyle] = useState(OPENING_DEFAULT_STYLE);
  const [designTemplate, setDesignTemplate] = useState("default");
  const [motionTemplate, setMotionTemplate] = useState("default");
  const [motion, setMotion] = useState(DEFAULT_MOTION);
  const [layers, setLayers] = useState<readonly OpeningLayer[]>([]);
  const [selectedLayer, setSelectedLayer] = useState<string | null>(null);
  const [tool, setTool] = useState<"design" | "layers" | "split">("design");
  const [providerId, setProviderId] = useState("");
  const [versions, setVersions] = useState<readonly OpeningVersion[]>([]);
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
  const drag = useRef<{ id: number; x: number; y: number; layer: OpeningLayer } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [videoReady, setVideoReady] = useState(false);
  const [ratio, setRatio] = useState(16 / 9);
  const [duration, setDuration] = useState(0);
  const [time, setTime] = useState(0);
  const [thumbnails, setThumbnails] = useState<readonly string[]>([]);
  const [tab, setTab] = useState<OpeningTab>("design");
  const titleEditable = base === frame || layers.some(layer => layer.id === PRIMARY_TITLE);
  const layerProviders = atlasLayerProviders(providers);
  const layerProvider = layerProviders.find(({ provider }) => provider.id === providerId) ?? layerProviders[0];
  const reference = useMemo(() => {
    return frame ? copyOpeningFrame(frame, 200).toDataURL("image/jpeg", .8) : undefined;
  }, [frame]);
  useEffect(() => () => busy.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    void captureOpeningFilmstrip(src, controller.signal).then(images => {
      if (!controller.signal.aborted) setThumbnails(images);
    }, () => { /* The main preview remains seekable if a thumbnail cannot be decoded. */ });
    return () => controller.abort();
  }, [src]);
  useLayoutEffect(() => {
    const canvas = preview.current;
    if (base && canvas) paintOpeningLayers(canvas, base, layers);
  }, [base, layers]);

  async function run(action: (signal: AbortSignal) => Promise<void>) {
    if (busy.current) return;
    const controller = new AbortController();
    busy.current = controller;
    setWorking(true);
    setError(null);
    try {
      await action(controller.signal);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure);
    } finally {
      busy.current = null;
      if (!controller.signal.aborted) setWorking(false);
    }
  }

  function openDesign() {
    void run(async signal => {
      const selectedFrame = await captureFrame(src, "current", time, signal);
      signal.throwIfAborted();
      setTab("design");
      setFrame(selectedFrame);
      setBase(selectedFrame);
      setLayers([textLayer(PRIMARY_TITLE, title.trim(), style)]);
      setTool("design");
      setVersions([]);
      setSelectedVersion(null);
    });
  }

  async function saveStage(canvas: HTMLCanvasElement, name: string, signal: AbortSignal) {
    const keys = await saveCanvasDerivedImages({ images: [{ canvas, name }], store, commands, nodeKey, output: source, signal });
    const key = keys[0];
    if (!key) throw new Error("未能保存片头画面。");
    return key;
  }

  function saveDesign(asMotion: boolean) {
    void run(async signal => {
      const canvas = preview.current;
      if (!canvas) return;
      const firstFrameKey = await saveStage(copyOpeningFrame(canvas), title.trim() + " · 片名设计", signal);
      if (asMotion) onSave({ firstFrameKey, title: title.trim(), motion });
      else toast.success("片名设计已添加到画布");
    });
  }

  function rememberVersion(versionBase: HTMLCanvasElement, versionLayers: readonly OpeningLayer[], name: string) {
    const full = document.createElement("canvas");
    paintOpeningLayers(full, versionBase, versionLayers);
    const version = { id: crypto.randomUUID(), base: versionBase, layers: versionLayers, name,
      cover: copyOpeningFrame(full, 80).toDataURL("image/jpeg", .8) };
    setVersions(current => [...current, version].slice(-8));
    setSelectedVersion(version.id);
  }

  function replaceLayer(layer: OpeningLayer) {
    setLayers(current => current.map(item => item.id === layer.id ? layer : item));
    if (layer.kind === "text" && layer.id === PRIMARY_TITLE) setTitle(layer.text.slice(0, 60));
  }

  function applyStyle(nextStyle: OpeningTextStyle) {
    setStyle(nextStyle);
    setLayers(current => current.some(layer => layer.id === PRIMARY_TITLE) ?
      current.map(layer => layer.id === PRIMARY_TITLE ? { ...layer, ...nextStyle } : layer)
      : [...current, textLayer(PRIMARY_TITLE, title, nextStyle)]);
  }

  function splitLayers() {
    if (!layerProvider) return;
    void run(async signal => {
      const canvas = preview.current;
      if (!canvas || !base) return;
      const image = copyOpeningFrame(canvas);
      const assetKey = await saveStage(image, title.trim() + " · 分层源图", signal);
      signal.throwIfAborted();
      const taskId = await onSplit(assetKey, layerProvider.provider.id);
      const split = await waitForOpeningLayers(taskId, image, signal);
      signal.throwIfAborted();
      rememberVersion(base, layers, "分离前");
      const blank = document.createElement("canvas");
      blank.width = image.width;
      blank.height = image.height;
      setBase(blank);
      setLayers(split);
      rememberVersion(blank, split, "图层分离");
      setSelectedLayer(split.at(-1)?.id ?? null);
      setTool("layers");
    });
  }

  return (
    <div className="canvas-feature-opening" data-phase={frame ? "editor" : "keyframe"}>
      {frame ? (
        <div className="canvas-feature-opening__editor">
          <aside className="canvas-feature-opening__sidebar">
            {tool === "layers" ? <CanvasOpeningLayerEditor layers={layers} selectedId={selectedLayer}
              onSelect={setSelectedLayer} onChange={replaceLayer}
              onRemove={id => { setLayers(current => current.filter(layer => layer.id !== id)); setSelectedLayer(null); }}
              onReorder={(id, direction) => setLayers(current => {
                const index = current.findIndex(item => item.id === id);
                if (index < 0 || !current[index + direction]) return current;
                const next = [...current];
                [next[index], next[index + direction]] = [next[index + direction]!, next[index]!];
                return next;
              })}
              onClose={() => setTool("design")} onMerge={() => {
                if (!preview.current || !base) return;
                const combined = copyOpeningFrame(preview.current);
                rememberVersion(base, layers, "合并前");
                rememberVersion(combined, [], "合并图层");
                setBase(combined);
                setLayers([]);
                setTool("design");
              }} /> : <>
            <div className="canvas-opening-sidebar__scroll">
            <div className="canvas-feature-opening__reference">
              <img src={reference} alt="所选关键帧" />
              <button type="button" disabled={working} onClick={() => { setVideoReady(false); setFrame(null); }}>重新截帧</button>
            </div>
            <div className="canvas-feature-opening__tabs" role="group" aria-label="片头编辑">
              <button type="button" aria-pressed={tab === "design"} disabled={working} onClick={() => setTab("design")}>
                <LibTVMediaIcon name="text-tag" size={18} />片名设计
              </button>
              <button type="button" aria-pressed={tab === "motion"} disabled={working} onClick={() => setTab("motion")}>
                <LibTVMediaIcon name="animation" size={18} />文字动效
              </button>
            </div>
            {tab === "design" ? <div className="canvas-feature-edit__title-controls">
              <h3>片头标题</h3>
              <input aria-label="片名" value={title} maxLength={60} disabled={working || !titleEditable} onChange={event => {
                const text = event.target.value;
                setTitle(text);
                setLayers(current => current.some(layer => layer.id === PRIMARY_TITLE) ?
                  current.map(layer => layer.id === PRIMARY_TITLE ? { ...layer, text } : layer)
                  : [...current, textLayer(PRIMARY_TITLE, text, style)]);
              }} />
              {!titleEditable ? <p className="canvas-opening-sidebar__hint">切回合并前或分离前的版本可编辑片名。</p> : null}
            </div> : null}
            <CanvasOpeningTemplates key={tab} tab={tab} selected={tab === "design" ? designTemplate : motionTemplate}
              disabled={working || (tab === "design" && !titleEditable)}
              onSelect={template => {
                if (tab === "design") {
                  setDesignTemplate(template.id);
                  applyStyle(template.style ?? OPENING_DEFAULT_STYLE);
                } else {
                  setMotionTemplate(template.id);
                  setMotion(template.motion ?? DEFAULT_MOTION);
                }
              }} />
            </div>
            <button type="button" className="canvas-opening-templates__primary" disabled={working || !title.trim()}
              onClick={() => {
                if (tab === "motion") saveDesign(true);
                else if (base) rememberVersion(base, layers, "片名设计");
              }}>
              {tab === "design" ? "设计片名" : "创建动效草稿"}
            </button>
            </>}
          </aside>
          <div className="canvas-feature-opening__stage">
            <div className="canvas-opening-stage__media" style={{ "--opening-ratio": frame.width / frame.height } as CSSProperties}>
              <canvas ref={preview} className="canvas-feature-edit__title-preview" aria-label="片名设计预览" />
              {tool === "layers" ? layers.filter(layer => layer.visible).map(layer => (
                <button key={layer.id} type="button" className="canvas-opening-stage__layer"
                  aria-label={layer.kind === "image" ? layer.name : layer.text || "文字图层"}
                  data-selected={selectedLayer === layer.id || undefined}
                  style={layer.kind === "image" ? { left: layer.x * 100 + "%", top: layer.y * 100 + "%",
                    width: layer.width * 100 + "%", height: layer.height * 100 + "%" }
                    : { left: layer.x * 100 + "%", top: layer.y * 100 + "%",
                      width: Math.min(88, Math.max(10, layer.size * (layer.text.length || 1) / (frame.width / frame.height))) + "%",
                      height: Math.max(6, layer.size * 1.3) + "%", transform: "translate(-50%, -50%)" }}
                  onClick={() => setSelectedLayer(layer.id)} onPointerDown={event => {
                    if (event.button !== 0) return;
                    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, layer };
                    setSelectedLayer(layer.id);
                    event.currentTarget.setPointerCapture(event.pointerId);
                  }} onPointerMove={event => {
                    const gesture = drag.current;
                    const bounds = event.currentTarget.parentElement?.getBoundingClientRect();
                    if (!gesture || !bounds || gesture.id !== event.pointerId) return;
                    const original = gesture.layer;
                    replaceLayer({ ...original,
                      x: clamp(original.x + (event.clientX - gesture.x) / bounds.width, original.kind === "image" ? 1 - original.width : 1),
                      y: clamp(original.y + (event.clientY - gesture.y) / bounds.height, original.kind === "image" ? 1 - original.height : 1),
                    });
                  }} onLostPointerCapture={() => { drag.current = null; }}
                  onKeyDown={event => {
                    const dx = Number(event.key === "ArrowRight") - Number(event.key === "ArrowLeft");
                    const dy = Number(event.key === "ArrowDown") - Number(event.key === "ArrowUp");
                    if (!dx && !dy) return;
                    event.preventDefault();
                    event.stopPropagation();
                    setSelectedLayer(layer.id);
                    replaceLayer({ ...layer, x: clamp(layer.x + dx * .01, layer.kind === "image" ? 1 - layer.width : 1),
                      y: clamp(layer.y + dy * .01, layer.kind === "image" ? 1 - layer.height : 1) });
                  }} />
              )) : null}
              {tool === "split" ? <div className="canvas-opening-stage__split">
                <LibTVMediaIcon name="icon-element" size={42} />
                <h3>图层分离</h3>
                <p>将当前画面拆为可移动、缩放和重新合并的图层。</p>
                {layerProviders.length > 1 && layerProvider ? <CanvasSelect ariaLabel="图层分离供应商" value={layerProvider.provider.id}
                  disabled={working} options={layerProviders.map(({ provider }) => ({ value: provider.id, label: provider.displayName }))}
                  onChange={setProviderId} /> : null}
                {!layerProvider ? <p>请在全局设置启用 Atlas Cloud。</p> : null}
                <button type="button" className="canvas-opening-templates__primary" disabled={!layerProvider || working}
                  onClick={splitLayers} data-tooltip="由所选供应商计费">
                  <LibTVMediaIcon name={working ? "icon-loading" : "icon-lightning-filled"} size={14} className={working ? "spin-icon" : ""} />
                  {working ? "正在分离图层…" : "分离图层"}
                </button>
                <button type="button" disabled={working} onClick={() => setTool("design")}>返回</button>
              </div> : null}
            </div>
            {tool === "design" ? <div className="canvas-opening-stage__top-tools">
              <button type="button" disabled={working || !title.trim()} aria-label="发送片名设计到画布" data-tooltip="发送到画布"
                onClick={() => saveDesign(false)}><LibTVMediaIcon name="icon-canvas-add" size={18} /></button>
            </div> : null}
            {tool === "design" ? <div className="canvas-opening-stage__tools">
              <button type="button" disabled={working} onClick={() => {
                const id = crypto.randomUUID();
                setLayers(current => [...current, textLayer(id, "", style, .72)]);
                setSelectedLayer(id);
                setTool("layers");
              }}><LibTVMediaIcon name="text-edit" size={18} />添加文字</button>
              {layers.length ? <button type="button" disabled={working} onClick={() => {
                setSelectedLayer(layers.at(-1)?.id ?? null);
                setTool("layers");
              }}><LibTVMediaIcon name="layer-n" size={18} />编辑图层</button> : null}
              <button type="button" disabled={working} onClick={() => setTool("split")}>
                <LibTVMediaIcon name="icon-element" size={18} />图层分离
              </button>
            </div> : null}
            {versions.length && tool === "design" ? <div className="canvas-opening-stage__versions" aria-label="片头版本">
              {versions.map(version => <button type="button" key={version.id} aria-label={version.name} data-tooltip={version.name}
                aria-pressed={selectedVersion === version.id} disabled={working} onClick={() => {
                  setBase(version.base);
                  setLayers(version.layers);
                  const primary = version.layers.find(layer => layer.id === PRIMARY_TITLE);
                  if (primary?.kind === "text") setTitle(primary.text.slice(0, 60));
                  setSelectedVersion(version.id);
                }}><img src={version.cover} alt="" /></button>)}
            </div> : null}
          </div>
        </div>
      ) : <>
        <div className="canvas-feature-opening__intro">
          <h3>从这一刻，开始你的片头</h3>
          <p>从视频中选择你喜欢的一帧，再为你的作品取个名字</p>
        </div>
        <div className="canvas-feature-opening__keyframe-body">
          <div className="canvas-feature-opening__frame"
            style={{ width: `min(${Math.min(550, 400 * ratio) + 8}px, 100%, ${46 * ratio}dvh)`, aspectRatio: ratio }}>
            <video ref={video} src={src} muted playsInline preload="auto" onLoadedData={event => {
              const player = event.currentTarget;
              if (!Number.isFinite(player.duration)) return;
              if (player.videoWidth && player.videoHeight) setRatio(player.videoWidth / player.videoHeight);
              const lastTime = Math.max(0, player.duration - .05);
              setDuration(lastTime);
              player.currentTime = Math.min(time, lastTime);
              setVideoReady(true);
            }} onError={() => setError(new Error("无法播放源视频。"))} />
            <div className="canvas-feature-opening__strip">
              <div className="canvas-feature-opening__thumbs" aria-hidden="true">
                {Array.from({ length: 11 }, (_, index) => (
                  <span key={index}>{thumbnails[index] ? <img src={thumbnails[index]} alt="" /> : null}</span>
                ))}
              </div>
              <input type="range" min={0} max={duration} step={.001} value={time} disabled={!videoReady || working}
                aria-label="拖动定位到选择的帧" onChange={event => {
                  const seconds = event.target.valueAsNumber;
                  setTime(seconds);
                  if (video.current) video.current.currentTime = seconds;
                }} />
            </div>
          </div>
          <div className="canvas-feature-opening__title-input">
            <input aria-label="片名" placeholder="写下你的片名" value={title} maxLength={60} disabled={working}
              onChange={event => setTitle(event.target.value)} />
          </div>
        </div>
        <button type="button" className="canvas-feature-opening__primary"
          disabled={!videoReady || !title.trim() || working} onClick={openDesign}>
          {working ? <LibTVMediaIcon name="icon-loading" size={16} className="spin-icon" /> : "进入设计"}
        </button>
      </>}
      {error ? <ErrorAlert error={error} /> : null}
    </div>
  );
}
