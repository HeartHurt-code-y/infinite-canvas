import type { ClipEdit } from "../../lib/videoClipEditing";

export function clipOverlap(left: ClipEdit, right: ClipEdit): number {
  if (!left.transition) return 0;
  const duration = Math.min(left.transition.seconds, (left.end - left.start) / 2, (right.end - right.start) / 2);
  return Number.isFinite(duration) ? Math.max(0, duration) : 0;
}

export function clipTimelineLayout(clips: readonly ClipEdit[]) {
  let cursor = 0;
  return clips.map((clip, index) => {
    const start = cursor;
    const end = start + Math.max(0, clip.end - clip.start || 0);
    const next = clips[index + 1];
    const overlap = next ? clipOverlap(clip, next) : 0;
    cursor = end - overlap;
    return { clip, index, start, end, overlap };
  });
}
