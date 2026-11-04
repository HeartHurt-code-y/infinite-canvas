export type AudioRange = { start: number; end: number };
export type AudioSplitPlan = readonly (readonly AudioRange[])[];
export type TimedAudioWord = { text: string; start: number; end: number };

export const MIN_AUDIO_CLIP = 0.05;

const TIME = /^(\d+(?:\.\d+)?|\d+:[0-5]?\d(?:\.\d+)?|\d+:[0-5]?\d:[0-5]?\d(?:\.\d+)?)$/u;
const RANGE = /^(.*?)\s*[-~～至到–—]\s*(.*?)$/u;

function seconds(value: string): number | null {
  const clean = value.trim().replace(/^(?:在|第)+\s*/u, "").replace(/\s*(?:秒钟?|s|处)+$/iu, "");
  if (!TIME.test(clean)) return null;
  return clean.split(":").reduce((total, part) => total * 60 + Number(part), 0);
}

function checkPlan(plan: AudioSplitPlan, duration: number): AudioSplitPlan | null {
  const ranges = plan.flat();
  return ranges.length > 0 && ranges.length <= 64 && ranges.every(({ start, end }) =>
    Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end <= duration && end - start >= MIN_AUDIO_CLIP - 1e-8,
  ) ? plan : null;
}

export function splitAtTimes(points: readonly number[], duration: number): AudioSplitPlan | null {
  const edges = [0, ...new Set(points), duration].sort((a, b) => a - b);
  if (edges.length <= 2 || edges[0] !== 0 || edges.at(-1) !== duration) return null;
  return checkPlan(edges.slice(1).map((end, index) => [{ start: edges[index]!, end }]), duration);
}

export function parseAudioSplit(description: string, duration: number): AudioSplitPlan | null {
  const value = description.trim().normalize("NFKC").replace(/[。！!]$/u, "");
  const extract = value.match(/^(?:分别)?(截取|保留|删除)\s*(.+)$/u);
  if (extract) {
    const ranges: AudioRange[] = [];
    for (const part of extract[2]!.split(/\s*(?:、|,|;|和|与|以及)\s*/u)) {
      const match = part.match(RANGE);
      if (!match) return null;
      const start = seconds(match[1]!);
      const end = seconds(match[2]!);
      if (start == null || end == null) return null;
      ranges.push({ start, end });
    }
    if (extract[1] !== "删除") return checkPlan(ranges.map(range => [range]), duration);
    if (!checkPlan([ranges], duration)) return null;
    const kept: AudioRange[] = [];
    let cursor = 0;
    for (const range of ranges.sort((a, b) => a.start - b.start)) {
      if (range.start > cursor) kept.push({ start: cursor, end: range.start });
      cursor = Math.max(cursor, range.end);
    }
    if (cursor < duration) kept.push({ start: cursor, end: duration });
    return checkPlan([kept], duration);
  }
  const split = value.match(/^(?:在\s*)?(.+?)\s*(?:处)?(?:切开|切分|分割)$/u);
  if (!split) return null;
  const points = split[1]!.split(/\s*(?:、|,|;|和|与|以及)\s*/u).map(seconds);
  return points.every(point => point != null && point > 0 && point < duration)
    ? splitAtTimes(points as number[], duration) : null;
}

export function proposeAudioCuts(words: readonly TimedAudioWord[], onsets: readonly number[], duration: number): number[] {
  const ordered = words.filter(word => word.start < duration).sort((a, b) => a.start - b.start);
  const cuts: number[] = [];
  let boundary = 0;
  let onsetIndex = -1;
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]!;
    const next = ordered[index]!;
    const gap = next.start - previous.end;
    if (gap < 0.45 && !/[。！？；.!?;]$/u.test(previous.text)) continue;
    const anchor = gap >= 0.18 ? (previous.end + next.start) / 2 : next.start;
    while (onsetIndex + 1 < onsets.length && onsets[onsetIndex + 1]! <= anchor) onsetIndex += 1;
    const onset = onsets[onsetIndex];
    const cut = Math.round((onset != null && onset >= Math.max(previous.end, anchor - 0.16) ? onset : anchor) * 100) / 100;
    if (cut - boundary >= 0.5 && duration - cut >= 0.5) {
      cuts.push(cut);
      boundary = cut;
      if (cuts.length === 63) break;
    }
  }
  return cuts;
}
