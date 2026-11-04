import { useEffect, useRef, useState, type PointerEvent } from "react";
import { CanvasSelect } from "../../components/CanvasSelect";
import { ErrorAlert } from "../../components/ErrorAlert";
import type { ProviderCatalogEntry } from "../../lib/backend";
import { LibTVMediaIcon } from "./LibTVMediaIcon";
import "./CanvasLayerSeparation.css";

interface Region {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export function atlasLayerProviders(providers: readonly ProviderCatalogEntry[]) {
  return providers.filter(({ provider }) => provider.enabled && provider.adapterId === "atlascloud_v1");
}

function layerPrompt(prompt: string, regions: readonly Region[]) {
  if (!regions.length) return prompt.trim();
  const scale = (number: number) => Math.round(number * 1000);
  const boxes = regions.map(region =>
    `<bbox>${scale(region.x)} ${scale(region.y)} ${scale(region.x + region.width)} ${scale(region.y + region.height)}</bbox>`);
  return [prompt.trim(), `Extract individual transparent layers for the objects in ${boxes.join(" and ")}. Preserve the background as the base layer.`]
    .filter(Boolean).join("\n");
}

export function CanvasLayerSeparation({ src, providers, pending, error, onClose, onSubmit }: {
  readonly src: string;
  readonly providers: readonly ProviderCatalogEntry[];
  readonly pending: boolean;
  readonly error: unknown;
  readonly onClose: () => void;
  readonly onSubmit: (providerId: string, prompt: string) => void;
}) {
  const [ratio, setRatio] = useState<number | null>(null);
  const [imageFailed, setImageFailed] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [providerId, setProviderId] = useState("");
  const [timeline, setTimeline] = useState<{ past: readonly (readonly Region[])[]; current: readonly Region[]; next: readonly (readonly Region[])[] }>({
    past: [], current: [], next: [],
  });
  const [draft, setDraft] = useState<Region | null>(null);
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const providersForTool = atlasLayerProviders(providers);
  const provider = providersForTool.find(entry => entry.provider.id === providerId) ?? providersForTool[0];

  const change = (current: readonly Region[]) => setTimeline(state => ({ past: [...state.past, state.current], current, next: [] }));
  const undo = () => setTimeline(state => {
    const previous = state.past.at(-1);
    return previous ? { past: state.past.slice(0, -1), current: previous, next: [state.current, ...state.next] } : state;
  });
  const redo = () => setTimeline(state => {
    const next = state.next[0];
    return next ? { past: [...state.past, state.current], current: next, next: state.next.slice(1) } : state;
  });
  const point = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)) };
  };
  const selection = (event: PointerEvent<HTMLDivElement>) => {
    const origin = start.current;
    if (!origin || event.pointerId !== origin.id) return null;
    const end = point(event);
    return { x: Math.min(origin.x, end.x), y: Math.min(origin.y, end.y),
      width: Math.abs(end.x - origin.x), height: Math.abs(end.y - origin.y) };
  };

  useEffect(() => {
    function handle(event: KeyboardEvent) {
      if (pending || event.defaultPrevented || event.isComposing || event.keyCode === 229 ||
          !(event.ctrlKey || event.metaKey) || event.altKey ||
          (event.target instanceof HTMLElement && event.target.closest("input, textarea, [contenteditable=true]"))) return;
      const key = event.key.toLowerCase();
      if (key !== "z" && key !== "y") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (key === "y" || event.shiftKey) redo();
      else undo();
    }
    window.addEventListener("keydown", handle, true);
    return () => window.removeEventListener("keydown", handle, true);
  }, [pending]);

  const regions = timeline.current;
  return <div className="canvas-layer-separation">
    <div className="canvas-layer-separation__toolbar" role="group" aria-label="图层分离操作">
      <button type="button" aria-label="撤销框选" data-tooltip="撤销" disabled={pending || !timeline.past.length} onClick={undo}>
        <LibTVMediaIcon name="undo" size={16} />
      </button>
      <button type="button" aria-label="重做框选" data-tooltip="重做" disabled={pending || !timeline.next.length} onClick={redo}>
        <LibTVMediaIcon name="redo" size={16} />
      </button>
      <button type="button" aria-label="关闭图层分离" data-tooltip="关闭" disabled={pending} onClick={onClose}>
        <LibTVMediaIcon name="close-n" size={16} />
      </button>
    </div>
    <div className="canvas-layer-separation__image" role="group" aria-label="拖拽框选要分离的元素"
      style={ratio ? { aspectRatio: ratio, width: `min(100%, ${Math.min(640, ratio * 420)}px, ${ratio * 51}dvh)` } : undefined}
      onPointerDown={event => {
        if (pending || !ratio || event.button !== 0 || regions.length >= 16) return;
        event.preventDefault();
        start.current = { ...point(event), id: event.pointerId };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={event => { const region = selection(event); if (region) setDraft(region); }}
      onPointerUp={event => {
        const region = selection(event);
        if (region && region.width >= .005 && region.height >= .005) change([...regions, region]);
        start.current = null;
        setDraft(null);
      }}
      onLostPointerCapture={() => { start.current = null; setDraft(null); }}>
      <img src={src} alt="待分离的图片" draggable={false}
        onLoad={event => setRatio(event.currentTarget.naturalWidth / event.currentTarget.naturalHeight)}
        onError={() => { setImageFailed(true); setRatio(null); }} />
      {regions.length || draft ? [...regions, ...(draft ? [draft] : [])].map((region, index) =>
        <span className="canvas-layer-separation__box" key={index} data-draft={index === regions.length || undefined}
          style={{ left: region.x * 100 + "%", top: region.y * 100 + "%", width: region.width * 100 + "%", height: region.height * 100 + "%" }}
          aria-hidden="true">{index + 1}</span>)
        : ratio ? <span className="canvas-layer-separation__hint">拖拽框选要分离的元素</span> : null}
    </div>
    <section className="canvas-layer-separation__parameters" aria-label="图层分离参数">
      <h3>图层分离</h3>
      <div className="canvas-layer-separation__prompt">
        {regions.map((region, index) =>
          <button key={index} type="button" disabled={pending} aria-label={`移除选区 ${index + 1}`}
            data-tooltip="移除选区" onClick={() => change(regions.filter((_, i) => i !== index))}>
            <span className="canvas-layer-separation__thumb" aria-hidden="true"><img src={src} alt=""
              style={{ width: 100 / region.width + "%", height: 100 / region.height + "%",
                left: -100 * region.x / region.width + "%", top: -100 * region.y / region.height + "%" }} /></span>
            选区 {index + 1}
          </button>)}
        <textarea aria-label="图层分离提示词" placeholder="描述要分离的元素，留空自动识别"
          value={prompt} onChange={event => setPrompt(event.target.value)} disabled={pending}
          onKeyDown={event => {
            if (event.key !== "Backspace" || prompt || !regions.length || event.nativeEvent.isComposing) return;
            event.preventDefault();
            change(regions.slice(0, -1));
          }} />
      </div>
      {providersForTool.length > 1 && provider ? <CanvasSelect ariaLabel="图层分离供应商" value={provider.provider.id}
        disabled={pending} options={providersForTool.map(({ provider }) => ({ value: provider.id, label: provider.displayName }))}
        onChange={setProviderId} /> : null}
      {!provider ? <p role="status">请在全局设置启用 Atlas Cloud。</p> : null}
      {imageFailed ? <ErrorAlert error="无法读取待分离的图片。" /> : null}
      {error ? <ErrorAlert error={error} /> : null}
      <div className="canvas-layer-separation__footer">
        <button type="button" onClick={onClose} disabled={pending}>取消</button>
        <button type="button" onClick={() => {
          if (provider) onSubmit(provider.provider.id, layerPrompt(prompt, regions));
        }} disabled={pending || !provider || !ratio} data-tooltip="由所选供应商计费">
          <LibTVMediaIcon name={pending ? "icon-loading" : "icon-lightning-filled"} size={14}
            className={pending ? "spin-icon" : ""} />
          {pending ? "正在提交…" : "分离图层"}
        </button>
      </div>
    </section>
  </div>;
}
