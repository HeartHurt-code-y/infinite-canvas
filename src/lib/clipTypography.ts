import * as v from "valibot";
import { invokeDesktop } from "./ipc";
import { toMediaSrc } from "./backend";

export const fontRefSchema = v.object({ id: v.string(), family: v.string(), sourceId: v.nullable(v.string()), weight: v.number(), variable: v.boolean(), weights: v.optional(v.array(v.number()), []) });
export type ClipFontRef = v.InferOutput<typeof fontRefSchema>;
const fontSchema = v.object({ id: v.string(), family: v.string(), chinese: v.boolean(), cached: v.boolean(), local: v.boolean(), bundled: v.optional(v.boolean(), false) });
const preparedSchema = v.object({ font: fontRefSchema, path: v.string() });
export type ClipFont = v.InferOutput<typeof fontSchema>;
export const clipFontClient = {
  list: () => invokeDesktop("list_clip_fonts", v.array(fontSchema)),
  prepare: (id: string, weight?: number) => invokeDesktop("prepare_clip_font", preparedSchema, { id, weight: weight ?? null }),
  import: (path: string) => invokeDesktop("import_clip_font", preparedSchema, { path }),
};
const loaded = new Map<string, Promise<string>>();
export function loadClipFont(font: ClipFontRef): Promise<string> {
  const existing = loaded.get(font.id); if (existing) return existing;
  const result = clipFontClient.prepare(font.id).catch(async (error: unknown) => {
    if (!font.sourceId) throw error;
    const prepared = await clipFontClient.prepare(font.sourceId);
    if (prepared.font.id !== font.id) throw new Error("线上字体版本已变化，请重新选择字体。");
    return prepared;
  }).then(async prepared => {
    const family = `ClipFont-${font.id}`;
    const face = new FontFace(family, `url("${toMediaSrc(prepared.path)}")`, { weight: font.variable ? "100 900" : String(font.weight) });
    await face.load(); document.fonts.add(face); return family;
  }).catch((error: unknown) => { loaded.delete(font.id); throw error; });
  loaded.set(font.id, result); return result;
}
export const TEXT_ANIMATIONS = [
  { value: "none", label: "无动画", duration: 600 }, { value: "fade", label: "淡入", duration: 300 },
  { value: "spring-up", label: "弹起", duration: 550 }, { value: "blur-in", label: "虚化浮现", duration: 300 },
  { value: "zoom-in", label: "放大进入", duration: 600 }, { value: "slide-left", label: "向左滑入", duration: 500 },
  { value: "slide-right", label: "向右滑入", duration: 500 }, { value: "wipe-in", label: "擦除显现", duration: 600 },
  { value: "pulse", label: "脉冲", duration: 450 }, { value: "wave", label: "波浪", duration: 600 },
] as const;
export const animationSchema = v.object({ type: v.picklist(["none", "fade", "spring-up", "blur-in", "zoom-in", "slide-left", "slide-right", "wipe-in", "pulse", "wave"]), durationMs: v.pipe(v.number(), v.finite(), v.minValue(100), v.maxValue(10000)), delayMs: v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(30000)), iterations: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10)), amplitudePx: v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(100)) });
export type ClipTextAnimation = v.InferOutput<typeof animationSchema>;
export const DEFAULT_TEXT_ANIMATION: ClipTextAnimation = { type: "none", durationMs: 600, delayMs: 0, iterations: 1, amplitudePx: 8 };
export const wordSchema = v.object({ text: v.string(), start: v.pipe(v.number(), v.finite(), v.minValue(0)), end: v.pipe(v.number(), v.finite(), v.minValue(0)) });
export type ClipWord = v.InferOutput<typeof wordSchema>;
export const rgbaSchema = v.pipe(v.string(), v.regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/));
export const highlightSchema = v.object({ enabled: v.boolean(), textColor: rgbaSchema, backgroundColor: rgbaSchema, words: v.pipe(v.array(wordSchema), v.maxLength(1000)) });
export type ClipWordHighlight = v.InferOutput<typeof highlightSchema>;
export function clipTypographyIssue(item: { text: string; start: number; end: number; animation?: ClipTextAnimation; highlight?: ClipWordHighlight }): string | null {
  if (item.animation && !v.safeParse(animationSchema, item.animation).success) return "文字动画参数无效：时长100至10000毫秒、延迟0至30000毫秒、重复1至10次。";
  if (item.highlight) {
    if (!v.safeParse(highlightSchema, item.highlight).success) return "逐词时间或高亮颜色无效，请检查词级时间。";
    let previous = 0;
    for (const word of item.highlight.words) {
      if (!word.text || word.start < previous - 0.001 || word.end <= word.start || word.end > item.end - item.start + 0.001) return "逐词时间须按顺序排列、互不重叠，并在文字持续时间内；可点击「重新均分时间」修复。";
      previous = word.end;
    }
    if (item.highlight.enabled && item.highlight.words.map(word => word.text).join("") !== item.text) return "逐词文本与正文不一致，请重新分词并调整时间。";
  }
  return null;
}
/** Estimated timing is explicit and editable; it is never presented as speech recognition. */
export function estimateClipWords(text: string, duration: number): ClipWord[] {
  const segments = Array.from(new Intl.Segmenter("zh-CN", { granularity: "word" }).segment(text), item => item.segment);
  const weights = segments.map(word => Math.max(1, Array.from(word).length));
  const total = weights.reduce((a, b) => a + b, 0); let cursor = 0;
  return segments.map((word, index) => { const start = cursor; cursor += duration * weights[index]! / total; return { text: word, start: Math.round(start * 1000) / 1000, end: Math.round(cursor * 1000) / 1000 }; });
}
/** The same Bezier curves and project-relative clock are used by native ASS export. */
function bezier(progress: number, x1: number, y1: number, x2: number, y2: number): number {
  const curve = (t: number, a: number, b: number) => 3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t ** 2 * b + t ** 3;
  let low = 0, high = 1;
  for (let i = 0; i < 16; i++) { const middle = (low + high) / 2; if (curve(middle, x1, x2) < progress) low = middle; else high = middle; }
  return curve((low + high) / 2, y1, y2);
}
export function sampleTextMotion(animation: ClipTextAnimation | undefined, seconds: number) {
  const neutral = { opacity: 1, x: 0, y: 0, scale: 1, blur: 0, reveal: 1 };
  if (!animation || animation.type === "none") return neutral;
  const elapsed = seconds * 1000 - animation.delayMs;
  const finished = elapsed >= animation.durationMs * animation.iterations;
  const p = finished ? 1 : Math.max(0, elapsed % animation.durationMs / animation.durationMs);
  const ease = bezier(p, 0, 0, 0.58, 1);
  switch (animation.type) {
    case "fade": return { ...neutral, opacity: ease };
    case "spring-up": { const spring = bezier(p, 0.18, 0.89, 0.32, 1.28); return { ...neutral, opacity: Math.min(1, spring), y: 28 * (1 - spring) }; }
    case "blur-in": return { ...neutral, opacity: ease, blur: 14 * (1 - ease), scale: 1 + 0.06 * (1 - ease) };
    case "zoom-in": return { ...neutral, opacity: ease, scale: 1 + 0.12 * (1 - ease) };
    case "slide-left": return { ...neutral, opacity: ease, x: 64 * (1 - ease) };
    case "slide-right": return { ...neutral, opacity: ease, x: -64 * (1 - ease) };
    case "wipe-in": return { ...neutral, reveal: bezier(p, 0.42, 0, 0.58, 1) };
    case "pulse": { const scale = p < 0.7 ? 0.92 + 0.14 * bezier(p / 0.7, 0, 0, 0.58, 1) : 1.06 - 0.06 * bezier((p - 0.7) / 0.3, 0, 0, 0.58, 1); return { ...neutral, opacity: Math.min(1, p / 0.7), scale }; }
    case "wave": return { ...neutral, y: -animation.amplitudePx * Math.sin(Math.PI * p) ** 2 };
    default: return neutral;
  }
}
