import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { placeTooltip } from "../../components/floatingLayer";
import type { MediaType } from "../../lib/backend";
import { promptReferencePreview } from "../../lib/promptReferencePreview";
import type { PromptReferenceCandidate } from "../../lib/promptReferences";
import { toMediaProxyUrl } from "../../lib/mediaProxy";
import { useMediaByteSource } from "./mediaByteCache";
import "./ReferenceMediaPreview.css";

export interface ReferencePreviewMedia {
  readonly key: string;
  readonly name: string;
  readonly kind: MediaType;
  readonly url: string | null;
  readonly assetId?: string | undefined;
}

export function candidatePreview(candidate: PromptReferenceCandidate): ReferencePreviewMedia {
  return { key: candidate.canvasNodeKey, name: candidate.name, kind: candidate.kind,
    assetId: candidate.assetId,
    url: promptReferencePreview(candidate) };
}

function Preview({ anchor, media, onClose }: {
  readonly anchor: HTMLElement;
  readonly media: ReferencePreviewMedia;
  readonly onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const bytes = useMediaByteSource(media.assetId ?? "", media.kind, media.url);
  const src = bytes.url ?? media.url;
  useEffect(() => {
    if (media.kind !== "video") return;
    const player = video.current;
    void player?.play().catch(() => {});
    return () => player?.pause();
  }, [media.kind, src]);
  useLayoutEffect(() => {
    const layer = ref.current;
    if (!layer) return;
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      if (!anchor.isConnected || !rect.width || !rect.height || anchor.closest("[inert], [hidden]")) {
        onClose(); return;
      }
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (hit && !anchor.contains(hit) && !hit.contains(anchor)) { onClose(); return; }
      const box = layer.getBoundingClientRect();
      const pos = placeTooltip(anchor, { anchorRect: rect, measuredWidth: box.width,
        measuredHeight: box.height, preferAbove: true, gap: 8 });
      layer.style.transform = `translate3d(${pos.left}px, ${pos.top}px, 0)`;
    };
    place();
    const observer = new ResizeObserver(place); observer.observe(layer);
    const timer = window.setInterval(place, 150);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { observer.disconnect(); window.clearInterval(timer);
      window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [anchor, onClose]);
  if (!src) return null;
  return createPortal(<div ref={ref} className="reference-media-preview" aria-hidden="true">
    {media.kind === "video" ? <video ref={video} src={toMediaProxyUrl(src) ?? src} muted loop playsInline />
      : <img src={toMediaProxyUrl(src) ?? src} alt="" draggable={false} />}
  </div>, document.body);
}

/** One preview per reference surface; never mounts a video until the hover delay expires. */
export function useReferenceMediaPreview() {
  const [shown, setShown] = useState<{ anchor: HTMLElement; media: ReferencePreviewMedia } | null>(null);
  const pending = useRef<number | null>(null);
  const anchor = useRef<HTMLElement | null>(null);
  const escapeListener = useRef<((event: KeyboardEvent) => void) | null>(null);
  const hide = useCallback(() => {
    if (pending.current != null) window.clearTimeout(pending.current);
    pending.current = null; anchor.current = null; setShown(null);
    if (escapeListener.current) document.removeEventListener("keydown", escapeListener.current);
    escapeListener.current = null;
  }, []);
  const show = useCallback((element: HTMLElement, media: ReferencePreviewMedia) => {
    if (!media.url || (media.kind !== "image" && media.kind !== "video")) return;
    if (anchor.current === element) return;
    hide(); anchor.current = element;
    escapeListener.current = event => {
      if (!event.defaultPrevented && event.key === "Escape" && !event.isComposing && event.keyCode !== 229) hide();
    };
    document.addEventListener("keydown", escapeListener.current);
    pending.current = window.setTimeout(() => {
      pending.current = null;
      if (element.isConnected && anchor.current === element) setShown({ anchor: element, media });
    }, 200);
  }, [hide]);
  useEffect(() => () => {
    if (pending.current != null) window.clearTimeout(pending.current);
    if (escapeListener.current) document.removeEventListener("keydown", escapeListener.current);
  }, []);
  return { show, hide, layer: shown ? <Preview anchor={shown.anchor} media={shown.media} onClose={hide} /> : null };
}
