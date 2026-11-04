import { readFile } from "@tauri-apps/plugin-fs";
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { CanvasSelect } from "../../components/CanvasSelect";
import { useEscapeHandler } from "../../components/escapeArbiter";
import { backendErrorMessage, type ProviderCatalogEntry } from "../../lib/backend";
import { IMAGE_EDIT_RATIOS } from "./CanvasImageInlineEditor";
import { LibTVMediaIcon } from "./LibTVMediaIcon";
import { useCanvasCommands, useCanvasStore } from "../canvas/canvasStore";
import { saveCanvasDerivedImage, type CanvasLocalEditSource } from "./canvasDerivedImage";
import "./CanvasImageRegionEditor.css";

type Pads = { top: number; right: number; bottom: number; left: number };
type Edge = keyof Pads;
const EMPTY_PADS: Pads = { top: 0, right: 0, bottom: 0, left: 0 };
const HANDLES: readonly (readonly Edge[])[] = [
  ["top", "left"], ["top"], ["top", "right"], ["right"],
  ["bottom", "right"], ["bottom"], ["bottom", "left"], ["left"],
];
type Point = { x: number; y: number };
type MaskTool = "brush" | "rect" | "eraser";
type Stroke = { tool: MaskTool; points: readonly Point[]; width: number };
export type ImageRegionRequest = {
  readonly mode: "outpaint" | "repaint" | "erase" | "elements";
  readonly providerId: string;
  readonly prompt: string;
  readonly count: number;
  readonly image: HTMLCanvasElement;
  readonly mask: HTMLCanvasElement;
  readonly signal: AbortSignal;
};
export type StartImageRegionEdit = (nodeKey: string, source: CanvasLocalEditSource, request: ImageRegionRequest) => Promise<void>;
const TOOLS = [
  { value: "brush", label: "画笔", icon: "image-region-brush" },
  { value: "rect", label: "矩形", icon: "image-region-rectangle" },
  { value: "eraser", label: "橡皮擦", icon: "image-region-eraser" },
] as const;
const SELECT_ICONS = {
  chevronIcon: <LibTVMediaIcon name="icon-chevron-down-small" size={12} />,
  selectedIcon: <LibTVMediaIcon name="check" size={12} />,
};

function pointInStage(event: PointerEvent<HTMLElement>): Point {
  const bounds = event.currentTarget.getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)),
    y: Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height)),
  };
}

function paintStroke(context: CanvasRenderingContext2D, stroke: Stroke, color: string) {
  const { width, height } = context.canvas;
  const first = stroke.points[0];
  const last = stroke.points.at(-1);
  if (!first || !last) return;
  context.globalCompositeOperation = stroke.tool === "eraser" ? "destination-out" : "source-over";
  context.fillStyle = color;
  context.strokeStyle = color;
  if (stroke.tool === "rect") {
    context.fillRect(first.x * width, first.y * height, (last.x - first.x) * width, (last.y - first.y) * height);
    return;
  }
  context.lineCap = "round";
  context.lineJoin = "round";
  context.lineWidth = stroke.width * width;
  context.beginPath();
  if (stroke.points.length === 1) {
    context.arc(first.x * width, first.y * height, context.lineWidth / 2, 0, Math.PI * 2);
    context.fill();
    return;
  }
  context.moveTo(first.x * width, first.y * height);
  for (const point of stroke.points.slice(1)) context.lineTo(point.x * width, point.y * height);
  context.stroke();
}

function outputSize(width: number, height: number) {
  const scale = Math.min(1, 1024 / Math.max(width, height));
  return { width: Math.max(32, Math.round(width * scale / 32) * 32),
    height: Math.max(32, Math.round(height * scale / 32) * 32) };
}

function imageContext(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建图片编辑画布。");
  return context;
}

export function CanvasImageRegionEditor({ mode, mediaHost, pixelSize, source, nodeKey, providers, onStart, onClose }: {
  readonly mode: "outpaint" | "repaint" | "erase" | "annotate" | "elements";
  readonly mediaHost: HTMLDivElement | null;
  readonly pixelSize: { readonly width: number; readonly height: number } | null;
  readonly source: CanvasLocalEditSource;
  readonly nodeKey: string;
  readonly providers: readonly ProviderCatalogEntry[];
  readonly onStart: StartImageRegionEdit;
  readonly onClose: () => void;
}) {
  const outpaint = mode === "outpaint";
  const annotate = mode === "annotate";
  const erase = mode === "erase";
  const title = { outpaint: "扩图", repaint: "重绘", erase: "擦除", annotate: "标注", elements: "元素编辑" }[mode];
  const store = useCanvasStore();
  const commands = useCanvasCommands();
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [ratio, setRatio] = useState(-1);
  const [pads, setPads] = useState<Pads>(EMPTY_PADS);
  const [count, setCount] = useState("1");
  const [providerId, setProviderId] = useState("");
  const atlasProviders = providers.filter(entry => entry.provider.enabled && entry.provider.adapterId === "atlascloud_v1");
  const provider = atlasProviders.find(entry => entry.provider.id === providerId) ?? atlasProviders[0];
  const [prompt, setPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submission = useRef<AbortController | null>(null);
  const [tool, setTool] = useState<MaskTool>("brush");
  const [brushSize, setBrushSize] = useState(24);
  const [history, setHistory] = useState<{ strokes: readonly Stroke[]; cursor: number }>({ strokes: [], cursor: 0 });
  const [stroke, setStroke] = useState<Stroke | null>(null);
  const pointer = useRef<{ id: number; stroke: Stroke } | null>(null);
  const resize = useRef<{ id: number; edges: readonly Edge[]; start: Point; pads: Pads; scale: number } | null>(null);
  const mask = useRef<HTMLCanvasElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);

  useEscapeHandler({ canHandle: () => true, handle: onClose }, true);
  useEffect(() => () => submission.current?.abort(), []);
  useLayoutEffect(() => {
    if (!mediaHost) return;
    const measure = () => setSize({ width: mediaHost.clientWidth, height: mediaHost.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(mediaHost);
    return () => observer.disconnect();
  }, [mediaHost]);
  useLayoutEffect(() => { toolbar.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true }); }, []);
  useEffect(() => {
    const context = mask.current?.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, context.canvas.width, context.canvas.height);
    const color = annotate ? "#ff5147" : "#09caf5";
    for (const mark of history.strokes.slice(0, history.cursor)) paintStroke(context, mark, color);
    if (stroke) paintStroke(context, stroke, color);
  }, [annotate, history, size, stroke]);

  useEffect(() => {
    const leaveNode = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || event.target.closest("[data-canvas-image-tool]")) return;
      const target = event.target.closest(".react-flow__node");
      if (target && !target.contains(mediaHost)) onClose();
    };
    document.addEventListener("click", leaveNode, true);
    return () => document.removeEventListener("click", leaveNode, true);
  }, [mediaHost, onClose]);

  const selectRatio = (value: string) => {
    const next = Number(value);
    setRatio(next);
    if (!outpaint) return;
    if (next < 0) { setPads(EMPTY_PADS); return; }
    const x = Math.max(0, (size.height * next - size.width) / 2);
    const y = Math.max(0, (size.width / next - size.height) / 2);
    setPads({ top: y, bottom: y, left: x, right: x });
  };
  const updatePadding = (event: PointerEvent<HTMLSpanElement>) => {
    const drag = resize.current;
    if (!drag || drag.id !== event.pointerId) return;
    const dx = (event.clientX - drag.start.x) / drag.scale;
    const dy = (event.clientY - drag.start.y) / drag.scale;
    const next = { ...drag.pads };
    for (const edge of drag.edges) {
      const delta = edge === "top" ? -dy : edge === "bottom" ? dy : edge === "left" ? -dx : dx;
      next[edge] = Math.max(0, drag.pads[edge] + delta);
    }
    if (drag.edges.length === 2 && ratio !== 0 && size.height > 0) {
      const aspect = ratio < 0 ? size.width / size.height : ratio;
      const vertical = drag.edges.find(edge => edge === "top" || edge === "bottom")!;
      const horizontal = drag.edges.find(edge => edge === "left" || edge === "right")!;
      const fixedWidth = size.width + next[horizontal === "left" ? "right" : "left"];
      const fixedHeight = size.height + next[vertical === "top" ? "bottom" : "top"];
      const target = Math.max(fixedWidth + next[horizontal], (fixedHeight + next[vertical]) * aspect);
      next[horizontal] = target - fixedWidth;
      next[vertical] = target / aspect - fixedHeight;
    }
    setPads(next);
  };
  const advanceStroke = (event: PointerEvent<HTMLDivElement>) => {
    const current = pointer.current;
    if (!current || current.id !== event.pointerId) return null;
    const point = pointInStage(event);
    const points = current.stroke.points;
    const previous = points.at(-1);
    if (previous && Math.hypot(point.x - previous.x, point.y - previous.y) < 0.001) return current.stroke;
    current.stroke = {
      ...current.stroke,
      points: current.stroke.tool === "rect" ? [points[0]!, point] : [...points, point],
    };
    setStroke(current.stroke);
    return current.stroke;
  };
  const width = size.width + pads.left + pads.right;
  const height = size.height + pads.top + pads.bottom;
  const sourceScale = pixelSize && size.width ? pixelSize.width / size.width : null;
  const sourcePads = sourceScale ? {
    left: Math.round(pads.left * sourceScale), right: Math.round(pads.right * sourceScale),
    top: Math.round(pads.top * sourceScale), bottom: Math.round(pads.bottom * sourceScale),
  } : EMPTY_PADS;
  const targetWidth = (pixelSize?.width ?? 0) + sourcePads.left + sourcePads.right;
  const targetHeight = (pixelSize?.height ?? 0) + sourcePads.top + sourcePads.bottom;
  const targetSize = targetWidth && targetHeight ? outputSize(targetWidth, targetHeight) : null;
  const hasPadding = Object.values(sourcePads).some(value => value > 0);
  const submitHint = !annotate && !provider ? "请在全局设置中启用 Atlas Cloud" :
    !source.finalPath || !targetSize ? "等待原图落盘" :
      outpaint && !hasPadding ? "向外拖动扩图边框" :
        !outpaint && !history.cursor ? "请在图片上标出区域" :
          !outpaint && !annotate && !erase && !prompt.trim() ? "请输入编辑描述" : null;
  const submit = async () => {
    if (submission.current || submitHint || !source.finalPath || !targetSize) return;
    const controller = new AbortController();
    submission.current = controller;
    setSubmitting(true);
    setError(null);
    try {
      const bytes = await readFile(source.finalPath);
      controller.signal.throwIfAborted();
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)]));
      try {
        controller.signal.throwIfAborted();
        if (bitmap.width !== pixelSize?.width || bitmap.height !== pixelSize.height) {
          throw new Error("原图尺寸已变化，请重新打开工具。");
        }
        if (annotate) {
          const image = imageContext(bitmap.width, bitmap.height);
          const marks = imageContext(bitmap.width, bitmap.height);
          for (const mark of history.strokes.slice(0, history.cursor)) paintStroke(marks, mark, "#ff5147");
          image.drawImage(bitmap, 0, 0);
          image.drawImage(marks.canvas, 0, 0);
          await saveCanvasDerivedImage({ canvas: image.canvas, name: title, store, commands, nodeKey, output: source, signal: controller.signal });
          if (!controller.signal.aborted) onClose();
          return;
        }
        if (!provider) return;
        const image = imageContext(targetSize.width, targetSize.height);
        const mask = imageContext(targetSize.width, targetSize.height);
        const x = Math.round(sourcePads.left * targetSize.width / targetWidth);
        const y = Math.round(sourcePads.top * targetSize.height / targetHeight);
        const w = targetSize.width - x - Math.round(sourcePads.right * targetSize.width / targetWidth);
        const h = targetSize.height - y - Math.round(sourcePads.bottom * targetSize.height / targetHeight);
        if (w < 1 || h < 1) throw new Error("扩图范围过大，请缩小边框。");
        if (outpaint) {
          if (x === 0 && y === 0 && w === targetSize.width && h === targetSize.height) {
            throw new Error("扩图范围太小，请继续向外拖动边框。");
          }
          image.fillStyle = "#fff";
          image.fillRect(0, 0, targetSize.width, targetSize.height);
          mask.fillStyle = "#fff";
          mask.fillRect(0, 0, targetSize.width, targetSize.height);
          mask.fillStyle = "#000";
          mask.fillRect(x, y, w, h);
        } else {
          for (const mark of history.strokes.slice(0, history.cursor)) paintStroke(mask, mark, "#fff");
          const pixels = mask.getImageData(0, 0, targetSize.width, targetSize.height);
          let painted = false;
          for (let index = 0; index < pixels.data.length; index += 4) {
            const value = pixels.data[index + 3] ? 255 : 0;
            painted ||= value > 0;
            pixels.data[index] = pixels.data[index + 1] = pixels.data[index + 2] = value;
            pixels.data[index + 3] = 255;
          }
          if (!painted) throw new Error("蒙版是空的，请涂抹需要重绘的区域。");
          mask.putImageData(pixels, 0, 0);
        }
        image.drawImage(bitmap, x, y, w, h);
        await onStart(nodeKey, source, {
          mode, providerId: provider.provider.id, count: Number(count), image: image.canvas, mask: mask.canvas,
          prompt: outpaint ? "Seamlessly extend the original scene into the surrounding blank areas. Match its content, lighting and composition."
            : erase ? "Remove the objects in the masked area and fill the gap with matching background. Preserve all unmasked content."
            : prompt.trim(),
          signal: controller.signal,
        });
        if (!controller.signal.aborted) onClose();
      } finally {
        bitmap.close();
      }
    } catch (failure) {
      if (!controller.signal.aborted) setError(backendErrorMessage(failure));
    } finally {
      submission.current = null;
      if (!controller.signal.aborted) setSubmitting(false);
    }
  };
  const ratioOptions = IMAGE_EDIT_RATIOS.map(option => ({
    value: String(option.value), label: option.label, icon: <LibTVMediaIcon name={option.icon} size={16} />,
  }));
  const settings = (
    <div className="canvas-image-region__settings nodrag nopan nowheel" data-canvas-image-tool=""
      style={{ top: (outpaint ? height - pads.top : size.height) + 8, left: outpaint ? -pads.left : 0 }}
      onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
      {!outpaint && !annotate && !erase ? <textarea aria-label={title + "提示词"} placeholder="描述要编辑的内容" rows={2} disabled={submitting}
        value={prompt} onChange={event => setPrompt(event.target.value)} /> : null}
      <div className="canvas-image-region__parameters">
        {outpaint ? <CanvasSelect ariaLabel="图片比例" value={String(ratio)} options={ratioOptions} preferAbove {...SELECT_ICONS}
          triggerValue={ratio === 0 ? { label: "自定义", icon: <LibTVMediaIcon name="image-crop-custom" size={16} /> } : undefined}
          disabled={submitting} onChange={selectRatio} /> : null}
        {!annotate && provider ? <CanvasSelect ariaLabel="编辑模型" value={provider.provider.id} disabled={submitting} {...SELECT_ICONS}
          options={atlasProviders.map(({ provider }) => ({ value: provider.id, label: "FLUX Dev · " + provider.displayName }))}
          preferAbove onChange={setProviderId} /> : null}
        {!annotate ? <CanvasSelect ariaLabel="生成数量" value={count} {...SELECT_ICONS} options={["1", "2", "3", "4"].map(value => ({ value, label: value + "张" }))}
          preferAbove disabled={submitting} onChange={setCount} /> : null}
        {targetSize && !annotate ? <small>{targetSize.width} × {targetSize.height}</small> : null}
        <button type="button" disabled={submitting || Boolean(submitHint)} data-tooltip={submitHint ?? (annotate ? "保存标注" : "提交 Atlas Cloud 生成，按张计费")}
          aria-label={submitting ? "正在准备" + title : annotate ? "保存标注" : "生成" + title} onClick={() => void submit()}>
          <LibTVMediaIcon name={submitting ? "icon-loading" : annotate ? "check" : "up-arrow"} {...(submitting ? { className: "spin-icon" } : {})} size={16} />
        </button>
      </div>
      {error ? <small role="alert">{error}</small> : submitHint ? <small>{submitHint}</small> : null}
    </div>
  );
  return (
    <>
      <div ref={toolbar} className="canvas-image-inline__toolbar nodrag nopan" data-canvas-image-tool=""
        role="group" aria-label={title}
        style={outpaint ? { bottom: "calc(100% + " + (pads.top + 8) + "px)", left: -pads.left } : undefined}
        onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()}
        onClick={event => event.stopPropagation()}>
        <button type="button" aria-label={"关闭" + title} onClick={onClose}>
          <LibTVMediaIcon name="close" size={12} />{title}
        </button>
        {!outpaint ? <>
          <span className="canvas-image-inline__divider" />
          {TOOLS.map(option => (
            <button key={option.value} type="button" aria-label={option.label} data-tooltip={option.label} disabled={submitting}
              aria-pressed={tool === option.value} onClick={() => setTool(option.value)}>
              <LibTVMediaIcon name={option.icon} size={16} />
            </button>
          ))}
          <label className="canvas-image-region__brush-size" data-tooltip="笔刷大小">
            <LibTVMediaIcon name="image-region-brush-size" size={16} />
            <input type="range" min={2} max={80} value={brushSize} aria-label="笔刷大小" disabled={submitting}
              onChange={event => setBrushSize(event.target.valueAsNumber)} />
          </label>
          <span className="canvas-image-inline__divider" />
          <button type="button" aria-label="撤销" data-tooltip="撤销" disabled={submitting || !history.cursor}
            onClick={() => setHistory(value => ({ ...value, cursor: Math.max(0, value.cursor - 1) }))}><LibTVMediaIcon name="undo" size={16} /></button>
          <button type="button" aria-label="重做" data-tooltip="重做" disabled={submitting || history.cursor >= history.strokes.length}
            onClick={() => setHistory(value => ({ ...value, cursor: Math.min(value.strokes.length, value.cursor + 1) }))}><LibTVMediaIcon name="redo" size={16} /></button>
        </> : null}
      </div>
      {outpaint && size.width > 0 ? (
        <div className="canvas-image-region__outpaint" data-canvas-image-tool=""
          style={{ top: -pads.top, left: -pads.left, width, height }}>
          {HANDLES.map(edges => (
            <span key={edges.join("-")} className="canvas-image-region__handle nodrag nopan"
              data-edges={edges.join("-")}
              onPointerDown={event => {
                if (submitting || event.button !== 0 || !mediaHost) return;
                event.preventDefault();
                event.stopPropagation();
                event.currentTarget.setPointerCapture(event.pointerId);
                resize.current = {
                  id: event.pointerId, edges, pads, start: { x: event.clientX, y: event.clientY },
                  scale: mediaHost.getBoundingClientRect().width / size.width || 1,
                };
              }}
              onMouseDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
              onPointerMove={updatePadding}
              onPointerUp={event => {
                if (resize.current?.id !== event.pointerId) return;
                updatePadding(event);
                if (edges.length === 1) setRatio(0);
                resize.current = null;
              }}
              onLostPointerCapture={() => { resize.current = null; }} />
          ))}
        </div>
      ) : !outpaint && mediaHost && size.width > 0 ? createPortal(
        <div className="canvas-image-region__mask nodrag nopan" data-canvas-image-tool=""
          onPointerDown={event => {
            if (submitting || event.button !== 0 || pointer.current) return;
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.setPointerCapture(event.pointerId);
            const next = { tool, width: brushSize / size.width, points: [pointInStage(event)] };
            pointer.current = { id: event.pointerId, stroke: next };
            setStroke(next);
          }}
          onMouseDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
          onPointerMove={advanceStroke}
          onPointerUp={event => {
            const completed = advanceStroke(event);
            if (!completed) return;
            setHistory(value => {
              const strokes = [...value.strokes.slice(0, value.cursor), completed];
              return { strokes, cursor: strokes.length };
            });
            pointer.current = null;
            setStroke(null);
          }}
          onLostPointerCapture={() => { pointer.current = null; setStroke(null); }}>
          <canvas ref={mask} width={size.width} height={size.height} aria-label="重绘蒙版" />
        </div>, mediaHost,
      ) : null}
      {settings}
    </>
  );
}
