import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import type { ClipOverlay } from "../../lib/videoClipEditing";
import { loadClipFont, sampleTextMotion } from "../../lib/clipTypography";

export function ClipTextOverlay({ overlay, seconds, width, height, reducedMotion, onError }: { overlay: ClipOverlay; seconds: number; width: number; height: number; reducedMotion: boolean; onError: (error: unknown) => void }) {
  const [family, setFamily] = useState<string>();
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let disposed = false; setFamily(undefined);
    if (!overlay.font) { setLoading(false); return; }
    setLoading(true);
    void loadClipFont(overlay.font).then(value => { if (!disposed) { setFamily(value); setLoading(false); } }).catch(error => { if (!disposed) { setLoading(false); onError(error); } });
    return () => { disposed = true; };
  }, [overlay.font?.id, onError]);
  const motion = sampleTextMotion(reducedMotion ? undefined : overlay.animation, seconds - overlay.start);
  const highlight = overlay.highlight;
  return <span className="clip-timeline__overlay" aria-label={overlay.text} data-font-loading={loading || undefined} style={{
    left: `${overlay.x}%`, top: `${overlay.y}%`, fontSize: `${overlay.size}cqh`, color: overlay.color,
    fontFamily: family ? `"${family}"` : undefined, fontWeight: overlay.weight ?? (overlay.bold ? 700 : 400),
    background: overlay.background ? "#000a" : "transparent", opacity: loading || overlay.font && !family ? 0 : motion.opacity,
    transform: `translate(calc(-50% + ${motion.x * width}px), calc(-100% + ${motion.y * height}px)) scale(${motion.scale})`,
    filter: motion.blur > 0 ? `blur(${motion.blur * height}px)` : undefined,
    clipPath: motion.reveal < 0.9999 ? `inset(0 ${(1 - motion.reveal) * 100}% 0 0)` : undefined,
  } as CSSProperties}>{highlight?.enabled ? highlight.words.map((word, index) => {
    const active = seconds - overlay.start >= word.start && seconds - overlay.start < word.end && Boolean(word.text.trim());
    return <span key={index} aria-hidden="true" style={active ? { color: highlight.textColor, backgroundColor: highlight.backgroundColor } : undefined}>{word.text}</span>;
  }) : overlay.text}</span>;
}
