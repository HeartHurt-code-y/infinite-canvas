import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ClipEdit, ClipTimelineSettings } from "../../lib/videoClipEditing";
import { prepareVideoEditSource } from "../../lib/videoLocalEdit";
import type { VideoClipParams } from "./videoClipModes";
import { clipTimelineLayout } from "./clipTimelineLayout";
import { ClipTextOverlay } from "./ClipTextOverlay";
import { loadClipFont } from "../../lib/clipTypography";

const timeLabel = (seconds: number) => `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(2).padStart(5, "0")}`;
type Layout = ReturnType<typeof clipTimelineLayout>[number];

function VideoLayer({ item, position, playing, active, opacity, gain, muted, onReady, onError }: {
  item: Layout; position: number; playing: boolean; active: boolean; opacity: number; gain: number; muted: boolean;
  onReady: (key: string, ready: boolean) => void; onError: (error: unknown) => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [src, setSrc] = useState("");
  const key = JSON.stringify([item.index, item.clip.target]);
  useEffect(() => {
    let disposed = false;
    let release: (() => Promise<void>) | undefined;
    setSrc(""); onReady(key, false);
    void prepareVideoEditSource(item.clip.target, "").then(source => {
      if (disposed) { void source.release(); return; }
      release = source.release; setSrc(source.src);
    }).catch(error => { if (!disposed) onError(error); });
    return () => { disposed = true; onReady(key, false); if (release) void release(); };
  }, [key, onReady, onError]); // The serialized key freezes exactly this media identity.
  useEffect(() => {
    const video = ref.current;
    if (!video || !src) return;
    const desired = Math.max(item.clip.start, Math.min(item.clip.end - 0.001, item.clip.start + position - item.start));
    if (!playing || Math.abs(video.currentTime - desired) > 0.22) video.currentTime = desired;
    video.volume = Math.max(0, Math.min(1, item.clip.volume * gain));
    video.muted = muted;
    if (playing && active) { if (video.paused) void video.play().catch(onError); }
    else video.pause();
  }, [src, position, playing, active, item, gain, muted, onError]);
  return src ? <video ref={ref} src={src} preload="auto" playsInline aria-hidden="true"
    style={{ opacity: active ? opacity : 0 }}
    onLoadedMetadata={() => { if (ref.current) ref.current.currentTime = item.clip.start; }}
    onCanPlay={() => onReady(key, true)} onWaiting={() => onReady(key, false)}
    onError={() => onError(new Error(`无法预览“${item.clip.name}”，请检查原文件。`))} /> : null;
}

/** One project clock drives both sides of a transition, captions, seeking and source previews. */
export function ClipTimelinePlayer({ clips, settings, params, seek, onPosition, onError }: {
  clips: readonly ClipEdit[]; settings: ClipTimelineSettings; params: VideoClipParams;
  seek: { readonly index: number; readonly nonce: number; readonly time?: number };
  onPosition: (index: number, sourceSeconds: number, timelineSeconds: number) => void;
  onError: (error: unknown) => void;
}) {
  const layout = useMemo(() => clipTimelineLayout(clips), [clips]);
  const total = layout.at(-1)?.end ?? 0;
  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [ready, setReady] = useState<ReadonlySet<string>>(new Set());
  const [fontsReady, setFontsReady] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const [stageHeight, setStageHeight] = useState(350);
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const stage = stageRef.current; if (!stage) return;
    const observer = new ResizeObserver(entries => setStageHeight(entries[0]?.contentRect.height ?? 350));
    observer.observe(stage); return () => observer.disconnect();
  }, []);
  const callbackRef = useRef({ onError, onPosition });
  useEffect(() => { callbackRef.current = { onError, onPosition }; }, [onError, onPosition]);
  const report = useCallback((error: unknown) => { setPlaying(false); callbackRef.current.onError(error); }, []);
  const prepared = useCallback((key: string, value: boolean) => setReady(current => {
    if (current.has(key) === value) return current;
    const next = new Set(current); if (value) next.add(key); else next.delete(key); return next;
  }), []);
  const fontKeys = JSON.stringify(settings.overlays.map(item => item.font?.id ?? ""));
  useEffect(() => {
    let disposed = false; setFontsReady(false);
    void Promise.all(settings.overlays.flatMap(item => item.font ? [loadClipFont(item.font)] : [])).then(() => { if (!disposed) setFontsReady(true); }).catch(error => { if (!disposed) report(error); });
    return () => { disposed = true; };
  }, [fontKeys, report]);
  useEffect(() => { setPosition(Math.max(0, Math.min(total, seek.time ?? layout[seek.index]?.start ?? 0))); }, [seek.nonce, seek.index, seek.time]);
  useEffect(() => { setPlaying(false); setPosition(current => Math.min(current, total)); }, [clips, settings, total]);
  const now = Math.min(Math.max(0, position), Math.max(0, total - 0.001));
  const visible = layout.filter(item => now >= item.start && now < item.end);
  const current = visible[0] ?? layout[0];
  const upcoming = current ? layout[current.index + (visible.length > 1 ? 2 : 1)] : undefined;
  const layers = upcoming && upcoming.start - now < 1 ? [...visible, upcoming] : visible;
  const buffered = visible.length > 0 && visible.every(item => ready.has(JSON.stringify([item.index, item.clip.target])));
  const tick = playing && buffered && fontsReady;
  useEffect(() => {
    if (!tick) return;
    let frame = 0; let previous = performance.now(); let pending = 0;
    const advance = (time: number) => {
      pending += Math.min(0.1, (time - previous) / 1000); previous = time;
      if (pending >= 0.035) { const elapsed = pending; pending = 0; setPosition(current => Math.min(total, current + elapsed)); }
      frame = requestAnimationFrame(advance);
    };
    frame = requestAnimationFrame(advance);
    return () => cancelAnimationFrame(frame);
  }, [tick, total]);
  useEffect(() => { if (position >= total && total > 0) setPlaying(false); }, [position, total]);
  useEffect(() => {
    if (current) callbackRef.current.onPosition(current.index, Math.min(current.clip.end, current.clip.start + now - current.start), now);
  }, [current?.index, now]);
  const ratio = params.aspectRatio.split(":").map(Number);
  const aspect = (ratio[0] ?? 16) / (ratio[1] ?? 9);
  const shortSide = Number(params.resolution.replace("P", ""));
  const outputHeight = aspect >= 1 ? shortSide : Math.round(shortSide / aspect / 2) * 2;
  const pixelRatio = stageHeight / outputHeight;
  const transition = visible.length === 2 ? visible[0]?.clip.transition : null;
  const phase = visible.length === 2 ? (now - visible[1]!.start) / visible[0]!.overlap : 0;
  const captions = settings.subtitles === "hidden" ? [] : visible.filter(item => item.clip.caption.trim()).map(item => item.clip.caption);
  return <section className="clip-timeline__project-preview" aria-label="整片预览">
    <div ref={stageRef} className="clip-timeline__stage" style={{ aspectRatio: aspect, maxWidth: `${350 * aspect}px`, background: transition?.kind === "white" ? "white" : "black" }}>
      {layers.map(item => {
        const isIncoming = visible.length === 2 && visible[1]?.index === item.index;
        const isOutgoing = visible.length === 2 && visible[0]?.index === item.index;
        let opacity = 1; let gain = 1;
        if (transition) {
          if (transition.kind === "fade") { if (isIncoming) opacity = phase; }
          else { if (isOutgoing) opacity = Math.max(0, 1 - phase * 2); if (isIncoming) opacity = Math.max(0, phase * 2 - 1); }
          if (isOutgoing) gain = 1 - phase; if (isIncoming) gain = phase;
        }
        if (item.clip.fade) {
          const fade = Math.min(0.3, (item.clip.end - item.clip.start) / 2);
          const factor = Math.max(0, Math.min(1, (now - item.start) / fade, (item.end - now) / fade));
          opacity *= factor; gain *= factor;
        }
        return <VideoLayer key={JSON.stringify([item.index, item.clip.target])} item={item} position={now} playing={tick}
          active={visible.includes(item)} opacity={opacity} gain={gain} muted={settings.muted} onReady={prepared} onError={report} />;
      })}
      {settings.overlays.filter(item => now >= item.start && now < item.end && (item.kind === "text" || settings.subtitles !== "hidden")).map(item => <ClipTextOverlay key={item.id} overlay={item} seconds={now} width={pixelRatio} height={pixelRatio} reducedMotion={reducedMotion} onError={report} />)}
      {captions.length > 0 ? <span className="clip-timeline__overlay" style={{ left: "50%", top: "88%", fontSize: "4.5cqh", color: "white" }}>{captions.join("\n")}</span> : null}
    </div>
    <div className="clip-timeline__transport">
      <button type="button" aria-label={playing ? "暂停整片预览" : "播放整片预览"} disabled={!clips.length || !fontsReady} onClick={() => { if (position >= total) setPosition(0); setPlaying(value => !value); }}>{playing ? "暂停" : "播放整片"}</button>
      <output aria-live="off">{timeLabel(position)} / {timeLabel(total)}</output>
      <button type="button" onClick={() => { void stageRef.current?.requestFullscreen().catch(report); }}>全屏预览</button>
    </div>
    <input type="range" aria-label="整片播放位置" min={0} max={Math.max(total, 0.001)} step={0.01} value={Math.min(position, total)} onChange={event => setPosition(event.target.valueAsNumber)} />
    {settings.overlays.some(item => item.animation && item.animation.type !== "none") ? <label className="clip-timeline__check"><input type="checkbox" checked={reducedMotion} onChange={event => setReducedMotion(event.target.checked)} />减少预览动效（导出保留动画）</label> : null}
    {playing && !buffered ? <p role="status">正在准备下一段预览…</p> : null}
    {!fontsReady ? <p role="status">正在准备预览字体…</p> : null}
  </section>;
}
