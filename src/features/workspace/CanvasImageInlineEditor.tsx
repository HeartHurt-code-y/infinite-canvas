import { readFile } from "@tauri-apps/plugin-fs";
import { getBezierPath, Position, useReactFlow, ViewportPortal } from "@xyflow/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { CanvasSelect } from "../../components/CanvasSelect";
import { ErrorAlert } from "../../components/ErrorAlert";
import { useEscapeHandler } from "../../components/escapeArbiter";
import { useModalFocusTrap } from "../../components/useModalFocusTrap";
import { useCanvasCommands, useCanvasStore } from "../canvas/canvasStore";
import { planCanvasDerivedImage, saveCanvasDerivedImage, type CanvasLocalEditSource } from "./canvasDerivedImage";
import { LibTVMediaIcon } from "./LibTVMediaIcon";
import { fitMediaNodeDimensions } from "./workspaceModel";
import "./CanvasImageInlineEditor.css";

export type CanvasImageTransform = "crop" | "rotate" | "outpaint" | "repaint";
type CropRect = { x: number; y: number; width: number; height: number };
const FULL_IMAGE: CropRect = { x: 0, y: 0, width: 1, height: 1 };
export const IMAGE_EDIT_RATIOS = [
  { label: "原图比例", value: -1, icon: "image-crop-original" },
  { label: "1:1", value: 1, icon: "image-crop-1-1" },
  { label: "4:3", value: 4 / 3, icon: "image-crop-4-3" },
  { label: "3:4", value: 3 / 4, icon: "image-crop-3-4" },
  { label: "16:9", value: 16 / 9, icon: "image-crop-16-9" },
  { label: "9:16", value: 9 / 16, icon: "image-crop-9-16" },
] as const;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function cropToRatio(ratio: number): CropRect {
  if (ratio <= 0) return FULL_IMAGE;
  const width = Math.min(1, ratio);
  const height = Math.min(1, 1 / ratio);
  return { x: (1 - width) / 2, y: (1 - height) / 2, width, height };
}

function canvasContext(canvas: HTMLCanvasElement, width: number, height: number) {
  if (width > 16_384 || height > 16_384 || width * height > 64_000_000) {
    throw new Error("编辑后的图片尺寸过大，请先缩小原图。");
  }
  canvas.width = Math.max(1, Math.ceil(width - 1e-8));
  canvas.height = Math.max(1, Math.ceil(height - 1e-8));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建图片编辑画布。");
  return context;
}

function rotatedBounds(bitmap: ImageBitmap, angle: number) {
  const cos = Math.abs(Math.cos(angle));
  const sin = Math.abs(Math.sin(angle));
  return {
    width: bitmap.width * cos + bitmap.height * sin,
    height: bitmap.width * sin + bitmap.height * cos,
  };
}

function paintRotated(
  canvas: HTMLCanvasElement,
  bitmap: ImageBitmap,
  degrees: number,
  flipX: boolean,
  flipY: boolean,
  preview = false,
) {
  const angle = degrees % 360 * Math.PI / 180;
  const { width, height } = rotatedBounds(bitmap, angle);
  const scale = preview ? Math.min(1, 960 / Math.max(width, height)) : 1;
  const context = canvasContext(canvas, width * scale, height * scale);
  context.translate(canvas.width / 2, canvas.height / 2);
  context.scale(flipX ? -scale : scale, flipY ? -scale : scale);
  context.rotate(angle);
  context.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
}

function paintCropped(canvas: HTMLCanvasElement, bitmap: ImageBitmap, crop: CropRect) {
  const left = Math.min(bitmap.width - 1, Math.round(crop.x * bitmap.width));
  const top = Math.min(bitmap.height - 1, Math.round(crop.y * bitmap.height));
  const width = Math.max(1, Math.min(bitmap.width - left, Math.round(crop.width * bitmap.width)));
  const height = Math.max(1, Math.min(bitmap.height - top, Math.round(crop.height * bitmap.height)));
  const context = canvasContext(canvas, width, height);
  context.drawImage(bitmap, left, top, width, height, 0, 0, width, height);
}

function cropPoint(event: PointerEvent<HTMLDivElement>) {
  const bounds = event.currentTarget.getBoundingClientRect();
  return {
    x: clamp((event.clientX - bounds.left) / bounds.width, 0, 1),
    y: clamp((event.clientY - bounds.top) / bounds.height, 0, 1),
  };
}

const CROP_HANDLES = ["n", "ne", "e", "se", "s", "sw", "w", "nw"] as const;
type CropHandle = typeof CROP_HANDLES[number] | "move";

function dragCrop(rect: CropRect, handle: CropHandle, dx: number, dy: number, ratio: number, minX: number, minY: number): CropRect {
  if (handle === "move") return {
    ...rect,
    x: clamp(rect.x + dx, 0, 1 - rect.width),
    y: clamp(rect.y + dy, 0, 1 - rect.height),
  };

  const west = handle.includes("w");
  const east = handle.includes("e");
  const north = handle.includes("n");
  const south = handle.includes("s");
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  if (handle.length === 2 && ratio > 0) {
    const max = Math.min(west ? right : 1 - rect.x, (north ? bottom : 1 - rect.y) * ratio);
    const min = Math.min(max, Math.max(minX, minY * ratio));
    const width = clamp(rect.width + (west ? -dx : dx), min, max);
    const height = width / ratio;
    return { x: west ? right - width : rect.x, y: north ? bottom - height : rect.y, width, height };
  }

  const left = west ? clamp(rect.x + dx, 0, right - minX) : rect.x;
  const top = north ? clamp(rect.y + dy, 0, bottom - minY) : rect.y;
  const endX = east ? clamp(right + dx, left + minX, 1) : right;
  const endY = south ? clamp(bottom + dy, top + minY, 1) : bottom;
  return { x: left, y: top, width: endX - left, height: endY - top };
}

function ConfirmRotateExit({ onBack, onDiscard, onSave }: {
  readonly onBack: () => void;
  readonly onDiscard: () => void;
  readonly onSave: () => void;
}) {
  const trap = useModalFocusTrap({ active: true, onEscape: onBack });
  return createPortal(
    <div className="canvas-video-modal-scrim" onMouseDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
      <section ref={trap.ref} {...trap.containerProps} className="canvas-video-modal canvas-image-inline__confirm-exit"
        role="dialog" aria-modal="true" aria-label="退出旋转" tabIndex={-1}>
        <header>
          <strong>退出旋转</strong>
          <button type="button" aria-label="关闭" onClick={onBack}><LibTVMediaIcon name="close" size={16} /></button>
        </header>
        <p>您对图像做了旋转或镜像调整，退出前是否保存？</p>
        <footer>
          <button type="button" onClick={onDiscard}>不保存</button>
          <button type="button" className="canvas-image-inline__confirm" onClick={onSave}>保存</button>
        </footer>
      </section>
    </div>, document.body,
  );
}

interface CanvasImageEditProps {
  readonly mode: "crop" | "rotate";
  readonly nodeKey: string;
  readonly output: CanvasLocalEditSource;
  readonly mediaHost: HTMLDivElement | null;
  readonly onClose: () => void;
}

export function CanvasImageInlineEditor(props: CanvasImageEditProps) {
  const flow = useReactFlow();
  const centerDraft = useCallback((placement: ReturnType<typeof planCanvasDerivedImage>) => {
    void flow.setCenter(placement.x + placement.width / 2, placement.y + placement.height / 2, {
      zoom: flow.getZoom(), duration: 240,
    });
  }, [flow]);
  return <CanvasImageTransformEditor {...props} centerDraft={centerDraft} />;
}

export function CanvasImageTransformEditor({ mode, nodeKey, output, mediaHost, onClose, centerDraft }: CanvasImageEditProps & {
  readonly centerDraft?: (placement: ReturnType<typeof planCanvasDerivedImage>) => void;
}) {
  const store = useCanvasStore();
  const commands = useCanvasCommands();
  const toolbarRef = useRef<HTMLDivElement>(null);
  const preview = useRef<HTMLCanvasElement>(null);
  const lifetime = useRef<AbortController | null>(null);
  const saving = useRef(false);
  const drag = useRef<{ id: number; x: number; y: number; before: CropRect; handle: CropHandle } | null>(null);
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null);
  const [angleText, setAngleText] = useState("0");
  const [flipX, setFlipX] = useState(false);
  const [flipY, setFlipY] = useState(false);
  const [cropRatio, setCropRatio] = useState(-1);
  const [crop, setCrop] = useState(FULL_IMAGE);
  const [cropWidth, setCropWidth] = useState(0);
  const [draft, setDraft] = useState<ReturnType<typeof planCanvasDerivedImage> | null>(null);
  const [confirmExit, setConfirmExit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const angle = Number(angleText);
  const ratio = bitmap && cropRatio > 0 ? cropRatio * bitmap.height / bitmap.width : cropRatio === -1 ? 1 : 0;
  const hasChanges = mode === "rotate" && (angle % 360 !== 0 || flipX || flipY);
  const canApply = mode === "crop" || hasChanges;

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    let decoded: ImageBitmap | null = null;
    void (async () => {
      try {
        if (!output.finalPath) throw new Error("请等图片保存完成。");
        const bytes = await readFile(output.finalPath);
        controller.signal.throwIfAborted();
        decoded = await createImageBitmap(new Blob([new Uint8Array(bytes)]));
        if (controller.signal.aborted) {
          decoded.close();
          return;
        }
        if (mode === "rotate") {
          const placement = planCanvasDerivedImage(store, nodeKey, output, decoded.width / decoded.height);
          setDraft(placement);
          centerDraft?.(placement);
        }
        setBitmap(decoded);
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure);
      }
    })();
    return () => {
      controller.abort();
      decoded?.close();
    };
  }, [centerDraft, mode, nodeKey, output, store]);

  useLayoutEffect(() => {
    if (!mediaHost || !bitmap || mode !== "crop") return;
    const measure = () => setCropWidth(Math.min(mediaHost.clientWidth, mediaHost.clientHeight * bitmap.width / bitmap.height));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(mediaHost);
    return () => observer.disconnect();
  }, [bitmap, mediaHost, mode]);

  useLayoutEffect(() => {
    if (!preview.current || !bitmap || !Number.isFinite(angle)) return;
    try {
      paintRotated(preview.current, bitmap, mode === "rotate" ? angle : 0, flipX, flipY, true);
    } catch (failure) {
      setError(failure);
    }
  }, [angle, bitmap, cropWidth, flipX, flipY, mode]);

  useLayoutEffect(() => {
    toolbarRef.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
  }, [draft]);

  const closeAndRestoreFocus = () => {
    onClose();
    requestAnimationFrame(() => {
      mediaHost?.querySelector<HTMLButtonElement>('[data-image-transform-trigger="' + mode + '"]')
        ?.focus({ preventScroll: true });
    });
  };
  const requestClose = () => {
    if (saving.current) return;
    if (mode === "rotate" && hasChanges) setConfirmExit(true);
    else closeAndRestoreFocus();
  };
  useEscapeHandler({ canHandle: () => !confirmExit, handle: requestClose }, !confirmExit);

  useEffect(() => {
    if (confirmExit) return;
    const handleOtherNodeClick = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || event.target.closest("[data-canvas-image-tool]")) return;
      const targetNode = event.target.closest(".react-flow__node");
      if (!targetNode || targetNode.contains(mediaHost)) return;
      if (saving.current || (mode === "rotate" && hasChanges)) {
        event.preventDefault();
        event.stopPropagation();
        if (!saving.current) setConfirmExit(true);
        return;
      }
      onClose();
    };
    document.addEventListener("click", handleOtherNodeClick, true);
    return () => document.removeEventListener("click", handleOtherNodeClick, true);
  }, [confirmExit, hasChanges, mediaHost, mode, onClose]);

  const selectRatio = (value: number) => {
    if (!bitmap) return;
    setCropRatio(value);
    if (value !== 0) setCrop(cropToRatio(value < 0 ? 1 : value * bitmap.height / bitmap.width));
  };
  const onCropMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start || start.id !== event.pointerId || !bitmap) return;
    const point = cropPoint(event);
    setCrop(dragCrop(start.before, start.handle, point.x - start.x, point.y - start.y, ratio, 1 / bitmap.width, 1 / bitmap.height));
  };
  const onCropKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!bitmap || busy || event.nativeEvent.isComposing || event.keyCode === 229) return;
    const horizontal = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    const vertical = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (!horizontal && !vertical) return;
    event.preventDefault();
    event.stopPropagation();
    const handle = event.shiftKey ? horizontal ? "e" : "s" : "move";
    if (event.shiftKey) setCropRatio(0);
    setCrop(rect => dragCrop(rect, handle, horizontal * 0.01, vertical * 0.01, 0, 1 / bitmap.width, 1 / bitmap.height));
  };

  const apply = async () => {
    const signal = lifetime.current?.signal;
    if (!bitmap || !signal || saving.current || !canApply || !Number.isFinite(angle)) return;
    saving.current = true;
    setBusy(true);
    setError(null);
    try {
      const canvas = document.createElement("canvas");
      if (mode === "crop") paintCropped(canvas, bitmap, crop);
      else paintRotated(canvas, bitmap, angle, flipX, flipY);
      await saveCanvasDerivedImage({
        canvas, name: mode === "crop" ? "裁剪" : "旋转与镜像", store, commands, nodeKey, output, signal,
        ...(draft ? { position: draft } : {}),
      });
      if (!signal.aborted) onClose();
    } catch (failure) {
      if (!signal.aborted) setError(failure);
    } finally {
      saving.current = false;
      if (!signal.aborted) setBusy(false);
    }
  };

  const toolbar = (
    <div ref={toolbarRef} className="canvas-image-inline__toolbar nodrag nopan nowheel" data-canvas-image-tool=""
      role="group" aria-label={mode === "crop" ? "裁剪" : "旋转与镜像"} aria-busy={busy}
      onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()}
      onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
      <button type="button" className="canvas-image-inline__close" aria-label="关闭" data-tooltip="关闭" disabled={busy} onClick={requestClose}>
        <LibTVMediaIcon name="close" size={12} />
        {mode === "rotate" ? <span>旋转与镜像</span> : null}
      </button>
      <span className="canvas-image-inline__divider" aria-hidden="true" />
      {mode === "crop" ? (
        <CanvasSelect ariaLabel="裁剪比例" value={String(cropRatio)} disabled={!bitmap || busy} preferAbove
          triggerValue={cropRatio === 0 ? { label: "自定义", icon: <LibTVMediaIcon name="image-crop-custom" size={16} /> } : undefined}
          options={IMAGE_EDIT_RATIOS.map(option => ({
            label: option.label, value: String(option.value),
            icon: <LibTVMediaIcon name={option.icon} size={16} />,
          }))}
          chevronIcon={<LibTVMediaIcon name="icon-chevron-down-small" size={12} />}
          selectedIcon={<LibTVMediaIcon name="check" size={12} />}
          onChange={value => selectRatio(Number(value))} />
      ) : (
        <>
          <label className="canvas-image-inline__angle">角度
            <input type="number" aria-label="旋转角度" value={angleText} disabled={!bitmap || busy}
              onChange={event => setAngleText(event.target.value)} />°
          </label>
          <span className="canvas-image-inline__divider" aria-hidden="true" />
          <button type="button" aria-label="顺时针旋转90°" data-tooltip="顺时针旋转90°"
            disabled={!bitmap || busy} onClick={() => setAngleText(String((angle + 90) % 360))}>
            <LibTVMediaIcon name="image-rotate-90" size={16} />
          </button>
          <button type="button" aria-label="水平镜像" data-tooltip="水平镜像" aria-pressed={flipX}
            disabled={!bitmap || busy} onClick={() => setFlipX(value => !value)}>
            <LibTVMediaIcon name="image-flip-horizontal" size={16} />
          </button>
          <button type="button" aria-label="垂直镜像" data-tooltip="垂直镜像" aria-pressed={flipY}
            disabled={!bitmap || busy} onClick={() => setFlipY(value => !value)}>
            <LibTVMediaIcon name="image-flip-vertical" size={16} />
          </button>
        </>
      )}
      <button type="button" className="canvas-image-inline__submit"
        disabled={busy || !bitmap || !canApply || !Number.isFinite(angle)} onClick={() => { void apply(); }}>
        <span>{busy ? "保存中…" : mode === "crop" ? "确定" : "保存"}</span>
        <span className="canvas-image-inline__submit-icon">
          <LibTVMediaIcon name={busy ? "icon-loading" : "up-arrow"} size={16} className={busy ? "spin-icon" : ""} />
        </span>
      </button>
    </div>
  );

  if (mode === "crop") return (
    <>
      {toolbar}
      {error ? <div className="canvas-image-inline__error"><ErrorAlert error={error} /></div> : null}
      {mediaHost && bitmap && cropWidth > 0 ? createPortal(
        <div className="canvas-image-inline__crop-stage nodrag nopan" data-canvas-image-tool=""
          role="group" tabIndex={busy ? -1 : 0}
          aria-label="裁剪区域。拖动选区或边框。方向键移动，Shift 加方向键缩放。"
          style={{ width: cropWidth, height: cropWidth * bitmap.height / bitmap.width }}
          onKeyDown={onCropKeys}
          onPointerDown={event => {
            event.stopPropagation();
            const handle = (event.target as HTMLElement).closest<HTMLElement>("[data-crop-handle]")?.dataset["cropHandle"] as CropHandle | undefined;
            if (busy || event.button !== 0 || !handle) return;
            event.preventDefault();
            event.currentTarget.focus({ preventScroll: true });
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = { id: event.pointerId, ...cropPoint(event), before: crop, handle };
          }}
          onMouseDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
          onDoubleClick={event => event.stopPropagation()}
          onPointerMove={onCropMove}
          onPointerUp={event => {
            onCropMove(event);
            const start = drag.current;
            if (start?.id !== event.pointerId) return;
            const point = cropPoint(event);
            if (start.handle.length === 1 && (point.x !== start.x || point.y !== start.y)) setCropRatio(0);
            drag.current = null;
          }}
          onLostPointerCapture={event => {
            if (drag.current?.id !== event.pointerId) return;
            setCrop(drag.current.before);
            drag.current = null;
          }}>
          <canvas ref={preview} />
          <div className="canvas-image-inline__selection" data-crop-handle="move" aria-hidden="true" style={{
            left: crop.x * 100 + "%", top: crop.y * 100 + "%",
            width: crop.width * 100 + "%", height: crop.height * 100 + "%",
          }}>
            {CROP_HANDLES.map(handle => <span key={handle} data-crop-handle={handle} />)}
          </div>
        </div>, mediaHost,
      ) : null}
    </>
  );

  const confirm = confirmExit ? <ConfirmRotateExit onBack={() => setConfirmExit(false)} onDiscard={closeAndRestoreFocus}
    onSave={() => { setConfirmExit(false); void apply(); }} /> : null;
  if (!centerDraft) return (
    <>
      {toolbar}
      <canvas className="canvas-feature-edit__rotate-preview" ref={preview} aria-label="旋转与镜像预览" />
      {error ? <div className="canvas-image-inline__error"><ErrorAlert error={error} /></div> : null}
      {confirm}
    </>
  );

  if (!draft || !bitmap) return (
    <>
      {toolbar}
      {error ? <div className="canvas-image-inline__error"><ErrorAlert error={error} /></div> : null}
    </>
  );

  const bounds = rotatedBounds(bitmap, Number.isFinite(angle) ? angle % 360 * Math.PI / 180 : 0);
  const size = fitMediaNodeDimensions(bounds.width / bounds.height);
  const [edge] = getBezierPath({
    sourceX: draft.sourceRect.x + draft.sourceRect.width,
    sourceY: draft.sourceRect.y + draft.sourceRect.height / 2,
    sourcePosition: Position.Right,
    targetX: draft.x,
    targetY: draft.y + size.height / 2,
    targetPosition: Position.Left,
  });
  return (
    <>
      <ViewportPortal>
        <svg className="canvas-image-inline__draft-edge" aria-hidden="true"><path d={edge} /></svg>
        <div className="canvas-image-inline__draft nodrag nopan" data-canvas-image-tool=""
          style={{ left: draft.x, top: draft.y, ...size }}
          onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()}
          onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
          {toolbar}
          <canvas ref={preview} aria-label="旋转与镜像预览" />
          {error ? <div className="canvas-image-inline__error"><ErrorAlert error={error} /></div> : null}
        </div>
      </ViewportPortal>
      {confirm}
    </>
  );
}
