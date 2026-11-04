import { useEffect, useId, useRef, useState, type MouseEvent } from "react";
import { LibTVMediaIcon } from "./LibTVMediaIcon";
import { CHARACTER_MARKS, type CharacterMark, type CharacterVisual } from "./characterStudioModel";

const DEFAULT_FACE = { x: 0.5, y: 0.28, radius: 0.24 };

export function CharacterMannequin() {
  const id = useId();
  const body = "M71 6C51 6 49 25 52 42l6 17-1 12c-7 7-25 8-33 17-9 11-9 37-10 53l-4 31-5 23c-3 13 0 24 3 24 3 0 2-11 4-13l2 9c1 5 5 4 5-2l2-24 9-32 7-33 3 29-2 30c-3 22-3 41 3 66l6 39 1 32-3 16-12 9c-4 5-1 7 5 7h18l7-5 1-13-1-36 3-31 4-45 3-15 4 15 4 45 3 31-1 36 1 13 7 5h18c6 0 9-2 5-7l-12-9-3-16 1-32 6-39c6-25 6-44 3-66l-2-30 3-29 7 33 9 32 2 24c0 6 4 7 5 2l2-9c2 2 1 13 4 13 3 0 6-11 3-24l-5-23-4-31c-1-16-1-42-10-53-8-9-26-10-33-17l-1-12 6-17C93 25 91 6 71 6Z";
  return <svg viewBox="0 0 146 358" aria-hidden="true" className="character-studio__mannequin">
    <defs>
      <linearGradient id={id + "-shade"} x2="1" y2="0">
        <stop stopColor="#232323" /><stop offset=".42" stopColor="#393939" /><stop offset=".72" stopColor="#2b2b2b" /><stop offset="1" stopColor="#1b1b1b" />
      </linearGradient>
      <clipPath id={id + "-outline"}><path d={body} /></clipPath>
    </defs>
    <path d={body} fill={`url(#${id}-shade)`} stroke="#454545" strokeWidth=".6" />
    <g clipPath={`url(#${id}-outline)`} fill="none" stroke="#a5a5a5" strokeOpacity=".14" strokeWidth=".5">
      {Array.from({ length: 33 }, (_, index) => {
        const y = 8 + index * 11;
        return <path key={index} d={`M0 ${y - 4} Q73 ${y + (index < 7 ? 17 : 7)} 146 ${y - 4}`} />;
      })}
      {Array.from({ length: 14 }, (_, index) => {
        const x = index * 11;
        return <path key={index} d={`M${x} 0 C${x - 3} 58 ${x + 4} 116 ${x} 175 S${x + 3} 280 ${x} 358`} />;
      })}
    </g>
  </svg>;
}

function influence(x: number, y: number, cx: number, cy: number, rx: number, ry: number) {
  const weight = Math.max(0, 1 - ((x - cx) / rx) ** 2 - ((y - cy) / ry) ** 2);
  return weight * weight;
}

function drawCharacter(canvas: HTMLCanvasElement, source: ImageData, visual: CharacterVisual, original: boolean) {
  const context = canvas.getContext("2d");
  if (!context) return;
  context.putImageData(source, 0, 0);
  if (original) return;
  const { width, height, data } = source;
  const { adjustments, marks } = visual;
  const face = visual.face ?? DEFAULT_FACE;
  const unit = Math.min(width, height);
  const radius = unit * face.radius;
  const cx = face.x * width;
  const cy = face.y * height;
  const eye = (adjustments.eyeSize ?? 0) / 260;
  const nose = (adjustments.noseWidth ?? 0) / 220;
  const lips = (adjustments.lipWidth ?? 0) / 220;
  const faceWidth = (adjustments.faceWidth ?? 0) / 230;
  const complexion = (adjustments.complexion ?? 0) / 4;
  const bodyWidth = (adjustments.bodyWidth ?? 0) / 350;
  if (eye || nose || lips || faceWidth || complexion || bodyWidth) {
    const output = context.createImageData(width, height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const dx = x - cx;
        const faceWeight = influence(x, y, cx, cy, radius * 1.35, radius * 1.65);
        let sx = x - faceWidth * dx * faceWeight;
        let sy = y;
        if (bodyWidth) sx -= bodyWidth * (x - width / 2) * influence(x, y, width / 2, height * .67, width * .53, height * .42);
        if (faceWeight) {
          if (nose) sx -= nose * dx * influence(x, y, cx, cy + radius * .12, radius * .42, radius * .43);
          if (lips) sx -= lips * dx * influence(x, y, cx, cy + radius * .63, radius * .66, radius * .27);
          if (eye) {
            const ey = cy - radius * .27;
            const ex = cx + (dx < 0 ? -.45 : .45) * radius;
            const weight = eye * influence(x, y, ex, ey, radius * .42, radius * .35);
            sx -= (x - ex) * weight;
            sy -= (y - ey) * weight;
          }
        }
        const from = (Math.min(height - 1, Math.max(0, Math.round(sy))) * width +
          Math.min(width - 1, Math.max(0, Math.round(sx)))) * 4;
        const to = (y * width + x) * 4;
        const tone = complexion * faceWeight;
        output.data[to] = data[from]! + tone;
        output.data[to + 1] = data[from + 1]! + tone;
        output.data[to + 2] = data[from + 2]! + tone;
        output.data[to + 3] = data[from + 3]!;
      }
    }
    context.putImageData(output, 0, 0);
  }
  for (const mark of marks) {
    const x = mark.x * width;
    const y = mark.y * height;
    context.fillStyle = "#4c241ccb";
    if (mark.kind === "scar") {
      context.beginPath();
      context.moveTo(x - unit * .022, y + unit * .012);
      context.quadraticCurveTo(x, y, x + unit * .026, y - unit * .017);
      context.strokeStyle = "#864f42c7";
      context.lineWidth = Math.max(1, unit * .004);
      context.stroke();
      continue;
    }
    if (mark.kind === "freckles") {
      for (const [dx, dy] of [[-.027, .003], [-.017, -.007], [-.005, .005], [.009, -.004], [.02, .005], [.026, -.008]] as const) {
        context.beginPath();
        context.arc(x + dx * unit, y + dy * unit, Math.max(0.7, unit * .0022), 0, Math.PI * 2);
        context.fill();
      }
    } else {
      context.beginPath();
      context.arc(x, y, Math.max(1.2, unit * .004), 0, Math.PI * 2);
      context.fill();
    }
  }
}

export function CharacterStudioPreview({
  src, visual, mode, mark, onChange, onPick, onSavePreview, disabled,
}: {
  readonly src?: string | null | undefined;
  readonly visual: CharacterVisual;
  readonly mode: "body" | "face";
  readonly mark: CharacterMark | null;
  readonly onChange: (value: CharacterVisual) => void;
  readonly onPick: () => void;
  readonly onSavePreview: (png: string) => void;
  readonly disabled: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [source, setSource] = useState<{ src: string; pixels: ImageData } | null>(null);
  const [unreadable, setUnreadable] = useState<string | null>(null);
  const [original, setOriginal] = useState(false);
  const [locating, setLocating] = useState(false);
  const pixels = source?.src === src ? source?.pixels : undefined;
  const changed = Object.values(visual.adjustments).some(Boolean) || visual.marks.length > 0;
  const face = visual.face ?? DEFAULT_FACE;
  const faceView = mode === "face" && !locating;

  useEffect(() => {
    if (!src) return;
    let active = true;
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      if (!active) return;
      const buffer = document.createElement("canvas");
      const scale = Math.min(1, 720 / Math.max(image.naturalWidth, image.naturalHeight));
      buffer.width = Math.max(1, Math.round(image.naturalWidth * scale));
      buffer.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = buffer.getContext("2d");
      try {
        if (!context) throw new Error();
        context.drawImage(image, 0, 0, buffer.width, buffer.height);
        setSource({ src, pixels: context.getImageData(0, 0, buffer.width, buffer.height) });
        setUnreadable(null);
      } catch {
        setUnreadable(src);
      }
    };
    image.onerror = () => { if (active) setUnreadable(src); };
    image.src = src;
    return () => { active = false; image.onload = null; image.onerror = null; };
  }, [src]);

  useEffect(() => {
    const element = canvas.current;
    if (!pixels || !element) return;
    const frame = requestAnimationFrame(() => drawCharacter(element, pixels, visual, original));
    return () => cancelAnimationFrame(frame);
  }, [pixels, visual, original]);

  function place(event: MouseEvent<HTMLCanvasElement>) {
    if (mode !== "face" || original || disabled || (!mark && !locating)) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    if (locating) {
      onChange({ ...visual, face: { ...(visual.face ?? DEFAULT_FACE), x, y } });
      setLocating(false);
    } else if (mark && visual.marks.length < 12) {
      onChange({ ...visual, marks: [...visual.marks, { kind: mark, x, y }] });
    }
  }

  return <div className="character-studio__preview">
    <div className="character-studio__preview-picture">
      {pixels ? <canvas ref={canvas} width={pixels.width} height={pixels.height}
        className="character-studio__pixels" data-place={mode === "face" && !original && (locating || !!mark)} onClick={place}
        style={faceView ? {
          transformOrigin: `${face.x * 100}% ${face.y * 100}%`,
          transform: `translate(${(0.5 - face.x) * 100}%, ${(0.5 - face.y) * 100}%) scale(2.25)`,
        } : undefined}
        aria-label={original ? "原始参考图" : "角色造型预览"} /> :
        src ? <img src={src} alt="角色参考图" /> : <CharacterMannequin />}
    </div>
    <p role="status">{!src ? "选一张参考图，即可预览造型" :
      unreadable === src ? "此图可用于生成，实时预览需要可读的本机参考图" :
      mode === "face" && !original && pixels && locating ? "在原图上点击脸部中心" :
      mode === "face" && !original && pixels && mark ? `在预览上点击放置${CHARACTER_MARKS[mark]}` :
      mode === "face" ? "脸部预览" : "全身预览"}</p>
    <div className="character-studio__actions">
      {!src ? <button type="button" onClick={onPick}>选择参考图</button> : null}
      {pixels && mode === "face" ? <button type="button" aria-pressed={locating} disabled={disabled || original}
        onClick={() => setLocating(value => !value)}>{locating ? "返回脸部预览" : "定位脸部"}</button> : null}
      {pixels && changed ? <>
        <button type="button" aria-pressed={original} onClick={() => setOriginal(value => !value)}>
          <LibTVMediaIcon name="character-studio-compare" size={18} />对比原图
        </button>
        <button type="button" disabled={disabled || original} onClick={() => {
          if (!canvas.current) return;
          drawCharacter(canvas.current, pixels, visual, false);
          onSavePreview(canvas.current.toDataURL("image/png"));
        }}>保存预览为参考图</button>
      </> : null}
    </div>
  </div>;
}
