import { useEffect, useRef, useState, type PointerEvent, type RefObject } from "react";
import { ErrorAlert } from "../../components/ErrorAlert";
import { LibTVMediaIcon } from "./LibTVMediaIcon";
import type { AudioRange } from "./audioSplitPlan";

export function audioClock(seconds: number) {
  const whole = Math.floor(Math.max(0, seconds));
  return Math.floor(whole / 60) + ":" + String(whole % 60).padStart(2, "0");
}

type TrimControl = {
  readonly range: AudioRange;
  readonly disabled: boolean;
  readonly onChange: (range: AudioRange) => void;
};
type DragPart = "start" | "end" | "body";
const MIN_TRIM = 0.5;

export function CanvasAudioWaveform({ playerRef, duration, peaks, loading, waveError, cutPoints, trim }: {
  readonly playerRef: RefObject<HTMLAudioElement | null>;
  readonly duration: number | null;
  readonly peaks: readonly number[];
  readonly loading: boolean;
  readonly waveError: unknown;
  readonly cutPoints: readonly number[];
  readonly trim: TrimControl | null;
}) {
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; part: DragPart; x: number; range: AudioRange } | null>(null);
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    let frame = 0;
    const tick = () => {
      setTime(player.currentTime);
      frame = requestAnimationFrame(tick);
    };
    const start = () => {
      setPlaying(true);
      if (!frame) frame = requestAnimationFrame(tick);
    };
    const stop = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      setPlaying(false);
      setTime(player.currentTime);
    };
    const seeked = () => setTime(player.currentTime);
    const failed = () => setError(new Error("无法播放此音频。"));
    player.addEventListener("play", start);
    player.addEventListener("pause", stop);
    player.addEventListener("ended", stop);
    player.addEventListener("seeking", seeked);
    player.addEventListener("error", failed);
    if (!player.paused) start();
    return () => {
      cancelAnimationFrame(frame);
      player.removeEventListener("play", start);
      player.removeEventListener("pause", stop);
      player.removeEventListener("ended", stop);
      player.removeEventListener("seeking", seeked);
      player.removeEventListener("error", failed);
    };
  }, [playerRef]);

  const length = duration ?? 0;
  const progress = length > 0 ? Math.max(0, Math.min(1, time / length)) : 0;
  const seek = (position: number) => {
    const player = playerRef.current;
    if (!player || !length) return;
    const lower = trim?.range.start ?? 0;
    const upper = trim?.range.end ?? length;
    player.currentTime = Math.max(lower, Math.min(upper, position));
    setTime(player.currentTime);
  };
  const toggle = () => {
    const player = playerRef.current;
    if (!player) return;
    if (!player.paused) { player.pause(); return; }
    setError(null);
    void player.play().catch(setError);
  };
  const startDrag = (event: PointerEvent<HTMLElement>, part: DragPart) => {
    if (event.button !== 0 || !trim || trim.disabled) return;
    event.stopPropagation();
    drag.current = { pointerId: event.pointerId, part, x: event.clientX, range: trim.range };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const changeTrim = (part: DragPart, initial: AudioRange, delta: number) => {
    if (!trim || trim.disabled) return;
    let { start, end } = initial;
    if (part === "start") start = Math.max(0, Math.min(end - MIN_TRIM, start + delta));
    else if (part === "end") end = Math.min(length, Math.max(start + MIN_TRIM, end + delta));
    else {
      const width = end - start;
      start = Math.max(0, Math.min(length - width, start + delta));
      end = start + width;
    }
    trim.onChange({ start, end });
    const player = playerRef.current;
    if (player) {
      player.pause();
      player.currentTime = part === "end" ? end : start;
      setTime(player.currentTime);
    }
  };

  return (
    <div className="canvas-audio-waveform nodrag nopan" onPointerDown={event => event.stopPropagation()}
      onMouseDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
      <div className="canvas-audio-waveform__track" ref={track} aria-busy={loading}
        onPointerMove={event => {
          const current = drag.current;
          const width = track.current?.getBoundingClientRect().width;
          if (!current || current.pointerId !== event.pointerId || !width) return;
          changeTrim(current.part, current.range, (event.clientX - current.x) / width * length);
        }}
        onLostPointerCapture={event => {
          if (drag.current?.pointerId === event.pointerId) drag.current = null;
        }}>
        <div className="canvas-audio-waveform__bars" aria-hidden="true">
          {peaks.map((peak, index) => (
            <span key={index} data-played={index / peaks.length <= progress || undefined}
              style={{ height: Math.max(2, peak * 54) + "px" }} />
          ))}
        </div>
        <input className="canvas-audio-waveform__seek" type="range" aria-label="播放位置"
          min={trim?.range.start ?? 0} max={trim?.range.end ?? length} step="any"
          disabled={!length} value={time} onChange={event => seek(event.currentTarget.valueAsNumber)} />
        {length > 0 ? <span className="canvas-audio-waveform__playhead" aria-hidden="true" style={{ left: progress * 100 + "%" }}>
          {trim ? <span className="canvas-audio-waveform__playhead-grip"
            onPointerDown={event => {
              if (event.button !== 0 || trim.disabled) return;
              event.stopPropagation();
              playerRef.current?.pause();
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={event => {
              const bounds = track.current?.getBoundingClientRect();
              if (bounds?.width && event.currentTarget.hasPointerCapture(event.pointerId)) {
                seek((event.clientX - bounds.left) / bounds.width * length);
              }
            }} /> : null}
        </span> : null}
        {length > 0 ? cutPoints.map(point => (
          <button key={point} type="button" className="canvas-audio-waveform__cut"
            style={{ left: point / length * 100 + "%" }} aria-label={"定位切点 " + point.toFixed(2) + " 秒"}
            onClick={() => seek(point)} />
        )) : null}
        {trim && length > 0 ? <>
          <span className="canvas-audio-waveform__outside is-start" style={{ width: trim.range.start / length * 100 + "%" }} />
          <span className="canvas-audio-waveform__outside is-end" style={{ width: (length - trim.range.end) / length * 100 + "%" }} />
          <div className="canvas-audio-waveform__selection"
            style={{ left: trim.range.start / length * 100 + "%", width: (trim.range.end - trim.range.start) / length * 100 + "%" }}
            onPointerDown={event => startDrag(event, "body")}>
            <output className="canvas-audio-waveform__selection-length">{(trim.range.end - trim.range.start).toFixed(2)} s</output>
            {(["start", "end"] as const).map(part => (
              <button key={part} type="button" role="slider" aria-label={part === "start" ? "裁剪起点" : "裁剪终点"}
                aria-valuemin={part === "start" ? 0 : trim.range.start + MIN_TRIM}
                aria-valuemax={part === "start" ? trim.range.end - MIN_TRIM : length}
                aria-valuenow={trim.range[part]} aria-valuetext={trim.range[part].toFixed(2) + " 秒"}
                className={"canvas-audio-waveform__handle is-" + part} disabled={trim.disabled}
                onPointerDown={event => startDrag(event, part)}
                onKeyDown={event => {
                  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                  event.preventDefault();
                  event.stopPropagation();
                  changeTrim(part, trim.range, (event.shiftKey ? 0.5 : 0.05) * (event.key === "ArrowRight" ? 1 : -1));
                }} />
            ))}
          </div>
        </> : null}
        {loading ? <LibTVMediaIcon name="icon-loading" className="canvas-audio-waveform__spinner spin-icon" size={20} /> : null}
      </div>
      <div className="canvas-audio-waveform__transport">
        <span>{audioClock(time)}</span>
        <button type="button" aria-label={playing ? "暂停音频" : "播放音频"} disabled={!length} onClick={toggle}>
          <LibTVMediaIcon name={playing ? "icon-pause-filled-small" : "icon-play-filled-small"} size={16} />
        </button>
        <span>{audioClock(length)}</span>
      </div>
      {error != null || waveError != null ? (
        <ErrorAlert error={error ?? waveError} variant="inline" hint="可重新加载节点或检查音频文件。" />
      ) : null}
    </div>
  );
}
