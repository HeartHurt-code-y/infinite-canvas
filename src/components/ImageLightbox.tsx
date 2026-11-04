import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";
import { useModalFocusTrap } from "./useModalFocusTrap";
import { toMediaProxyUrl } from "../lib/mediaProxy";
import "./ImageLightbox.css";

export interface ImageLightboxItem {
  readonly id: string;
  readonly src: string;
  readonly name: string;
}

/** LibTV's image viewer: Ctrl/wheel zooms, wheel/drag pans, double click resets. */
function ZoomableImage({ item, onError }: {
  readonly item: ImageLightboxItem;
  readonly onError?: (() => void) | undefined;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const [failed, setFailed] = useState(false);
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
  const transformRef = useRef(transform);
  const update = useCallback((x: number, y: number, scale: number) => {
    const frame = frameRef.current?.getBoundingClientRect();
    const image = imageRef.current;
    if (!frame || !image?.naturalWidth || !image.naturalHeight) return;
    const fit = Math.min(frame.width / image.naturalWidth, frame.height / image.naturalHeight);
    const boundX = Math.abs(frame.width - image.naturalWidth * fit * scale) / 2;
    const boundY = Math.abs(frame.height - image.naturalHeight * fit * scale) / 2;
    const next = { x: Math.max(-boundX, Math.min(boundX, x)), y: Math.max(-boundY, Math.min(boundY, y)), scale };
    transformRef.current = next;
    setTransform(next);
  }, []);
  const zoom = useCallback((scale: number, clientX: number, clientY: number) => {
    const frame = frameRef.current?.getBoundingClientRect();
    if (!frame) return;
    const current = transformRef.current;
    const nextScale = Math.min(5, Math.max(0.5, scale));
    const ratio = nextScale / current.scale;
    const x = clientX - frame.left - frame.width / 2;
    const y = clientY - frame.top - frame.height / 2;
    update(current.x + (x - current.x) * (1 - ratio), current.y + (y - current.y) * (1 - ratio), nextScale);
  }, [update]);
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const current = transformRef.current;
      if (event.ctrlKey || event.metaKey) {
        zoom(current.scale + (event.deltaY > 0 ? -0.06 : 0.06), event.clientX, event.clientY);
      } else update(current.x - event.deltaX, current.y - event.deltaY, current.scale);
    };
    frame.addEventListener("wheel", wheel, { passive: false });
    const observer = new ResizeObserver(() => {
      const current = transformRef.current;
      update(current.x, current.y, current.scale);
    });
    observer.observe(frame);
    return () => { frame.removeEventListener("wheel", wheel); observer.disconnect(); };
  }, [update, zoom]);
  return <div ref={frameRef} className="image-lightbox__frame"
    onDoubleClick={() => update(0, 0, 1)}
    onPointerDown={event => {
      if (event.button !== 0) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }}
    onPointerMove={event => {
      const previous = pointers.current.get(event.pointerId);
      if (!previous) return;
      const other = [...pointers.current.entries()].find(([id]) => id !== event.pointerId)?.[1];
      if (other) {
        const before = Math.hypot(previous.x - other.x, previous.y - other.y);
        const after = Math.hypot(event.clientX - other.x, event.clientY - other.y);
        if (before > 0) zoom(transformRef.current.scale * after / before,
          (event.clientX + other.x) / 2, (event.clientY + other.y) / 2);
      } else {
        const current = transformRef.current;
        update(current.x + event.clientX - previous.x, current.y + event.clientY - previous.y, current.scale);
      }
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }}
    onPointerUp={event => pointers.current.delete(event.pointerId)}
    onPointerCancel={event => pointers.current.delete(event.pointerId)}
    onLostPointerCapture={event => pointers.current.delete(event.pointerId)}>
    <img ref={imageRef} src={toMediaProxyUrl(item.src) ?? item.src} alt={item.name} draggable={false}
      style={{ transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})` }}
      onLoad={() => setFailed(false)} onError={() => { setFailed(true); onError?.(); }} />
    {failed ? <span className="image-lightbox__error" role="status">图片暂时无法显示</span> : null}
  </div>;
}

export function ImageLightbox({ items, initialItemId, index, onIndexChange, onClose, onImageError }: {
  readonly items: readonly ImageLightboxItem[];
  readonly initialItemId?: string | undefined;
  readonly index?: number | undefined;
  readonly onIndexChange?: ((index: number) => void) | undefined;
  readonly onClose: () => void;
  readonly onImageError?: (() => void) | undefined;
}) {
  const [activeId, setActiveId] = useState(initialItemId ?? items[0]?.id);
  const currentIndex = index ?? Math.max(0, items.findIndex(item => item.id === activeId));
  const item = items[currentIndex];
  const closeRef = useRef<HTMLButtonElement>(null);
  const trap = useModalFocusTrap({ active: true, onEscape: onClose, initialFocusRef: closeRef });
  useEffect(() => {
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = overflow; };
  }, []);
  const navigate = (next: number) => {
    const target = items[next];
    if (!target) return;
    setActiveId(target.id);
    onIndexChange?.(next);
  };
  if (!item) return null;
  return createPortal(<div className="image-lightbox" ref={trap.ref} {...trap.containerProps}
    role="dialog" aria-modal="true" aria-label="图片预览"
    onClick={event => { event.stopPropagation(); if (event.target === event.currentTarget) onClose(); }}
    onPointerDown={event => event.stopPropagation()}
    onContextMenu={event => event.preventDefault()}
    onKeyDown={event => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        navigate(currentIndex + (event.key === "ArrowLeft" ? -1 : 1));
      }
      if (event.key !== "Escape" && event.key !== "Tab") event.stopPropagation();
    }}>
    {currentIndex > 0 ? <button type="button" className="image-lightbox__nav image-lightbox__nav--prev"
      aria-label="上一张图片" onClick={() => navigate(currentIndex - 1)}><Icon name="caret-left" size="lg" /></button> : null}
    <div className="image-lightbox__content">
      <button ref={closeRef} type="button" className="image-lightbox__close" aria-label="关闭图片预览" onClick={onClose}>
        <Icon name="x" size="sm" />
      </button>
      <ZoomableImage key={`${item.id}:${item.src}`} item={item} onError={onImageError} />
      <span className="sr-only" aria-live="polite">图片 {currentIndex + 1}，共 {items.length} 张。按左右方向键切换，Ctrl 加滚轮缩放，拖动平移，双击复位。</span>
    </div>
    {currentIndex < items.length - 1 ? <button type="button" className="image-lightbox__nav image-lightbox__nav--next"
      aria-label="下一张图片" onClick={() => navigate(currentIndex + 1)}><Icon name="caret-right" size="lg" /></button> : null}
  </div>, document.body);
}
