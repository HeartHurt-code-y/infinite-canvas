import { useEffect, useMemo, useRef, useState } from "react";
import { CanvasSelect } from "../../components/CanvasSelect";
import { ErrorAlert } from "../../components/ErrorAlert";
import type { ClipOverlay } from "../../lib/videoClipEditing";
import { clipFontClient, loadClipFont, estimateClipWords, TEXT_ANIMATIONS, DEFAULT_TEXT_ANIMATION, type ClipFont } from "../../lib/clipTypography";

const PIN_KEY = "clip-font-favorites-v1";
const WEIGHT_LABELS: Readonly<Record<number, string>> = { 100: "Thin", 200: "ExtraLight", 300: "Light", 400: "Regular", 500: "Medium", 600: "SemiBold", 700: "Bold", 800: "ExtraBold", 900: "Black" };
function readPins(): string[] { try { const value: unknown = JSON.parse(localStorage.getItem(PIN_KEY) ?? "[]"); return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; } catch { return []; } }
function RgbaInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const alpha = value.length === 9 ? parseInt(value.slice(7), 16) : 255;
  return <div className="clip-text__rgba"><label>{label}<input aria-label={label} type="color" value={value.slice(0, 7)} onChange={event => onChange(event.target.value + alpha.toString(16).padStart(2, "0"))} /></label><label>不透明度 {Math.round(alpha / 255 * 100)}%<input aria-label={`${label}不透明度`} type="range" min={0} max={255} step={1} value={alpha} onChange={event => onChange(value.slice(0, 7) + event.target.valueAsNumber.toString(16).padStart(2, "0"))} /></label></div>;
}
export function ClipTextControls({ overlay, onChange, onSeek, onPickingChange }: { overlay: ClipOverlay; onChange: (patch: Partial<ClipOverlay>) => void; onSeek: (seconds: number) => void; onPickingChange: (active: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const [fonts, setFonts] = useState<readonly ClipFont[]>([]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [limit, setLimit] = useState(40);
  const [pins, setPins] = useState(readPins);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState<unknown>(null);
  const request = useRef(0);
  useEffect(() => () => { request.current++; }, []);
  function refresh() { void clipFontClient.list().then(setFonts).catch(setError); }
  useEffect(() => { if (open) refresh(); }, [open]);
  const filtered = useMemo(() => fonts.filter(font => (!query.trim() || font.family.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) && (category === "all" || category === "chinese" && font.chinese || category === "cached" && font.cached || category === "pinned" && pins.includes(font.id) || category === "local" && font.local || category === "bundled" && font.bundled)).sort((a, b) => Number(b.bundled) - Number(a.bundled) || Number(b.chinese) - Number(a.chinese) || a.family.localeCompare(b.family)), [fonts, query, category, pins]);
  const animation = overlay.animation ?? DEFAULT_TEXT_ANIMATION;
  const highlight = overlay.highlight ?? { enabled: false, textColor: "#fff36aff", backgroundColor: "#7148e680", words: [] };
  const duration = Math.max(0.04, overlay.end - overlay.start);
  async function choose(id: string, requestedWeight?: number) {
    const nonce = ++request.current; setBusy(id); setError(null);
    try {
      const prepared = await clipFontClient.prepare(id, requestedWeight); await loadClipFont(prepared.font);
      if (nonce !== request.current) return;
      const weight = prepared.font.variable ? (overlay.bold ? 700 : 400) : prepared.font.weight;
      onChange({ font: prepared.font, weight, bold: weight >= 700 }); refresh(); setOpen(false);
    } catch (failure) { if (nonce === request.current) setError(failure); }
    finally { if (nonce === request.current) setBusy(""); }
  }
  async function importFont() {
    onPickingChange(true);
    try {
    const { open: pick } = await import("@tauri-apps/plugin-dialog");
    const path = await pick({ title: "导入本地字体", multiple: false, filters: [{ name: "字体", extensions: ["ttf", "otf"] }] });
    if (typeof path !== "string") return;
    const nonce = ++request.current; setBusy("import"); setError(null);
    try { const prepared = await clipFontClient.import(path); await loadClipFont(prepared.font); if (nonce !== request.current) return; onChange({ font: prepared.font, weight: prepared.font.weight, bold: prepared.font.weight >= 700 }); refresh(); setOpen(false); }
    catch (failure) { if (nonce === request.current) setError(failure); }
    finally { if (nonce === request.current) setBusy(""); }
    } finally { onPickingChange(false); }
  }
  function pin(id: string) { const next = pins.includes(id) ? pins.filter(item => item !== id) : [...pins, id]; setPins(next); try { localStorage.setItem(PIN_KEY, JSON.stringify(next)); } catch { /* Favorites are optional; the selected font is saved in the project. */ } }
  return <div className="clip-text-controls">
    <label>字体库<button type="button" aria-label="打开字体库" aria-expanded={open} onClick={() => setOpen(value => !value)}>{overlay.font?.family ?? "系统默认字体"}</button></label>
    {busy && !open ? <p role="status">正在准备所选字重…</p> : null}
    {open ? <section className="clip-text__fonts" aria-label="字体库">
      <input type="search" autoFocus aria-label="搜索字体" placeholder="搜索字体" value={query} onChange={event => { setQuery(event.target.value); setLimit(40); }} />
      <CanvasSelect ariaLabel="字体分类" value={category} options={[{ value: "all", label: "全部字体" }, { value: "bundled", label: "内置扩展字体 · 136" }, { value: "chinese", label: "中文字体" }, { value: "pinned", label: "收藏" }, { value: "cached", label: "已下载" }, { value: "local", label: "本地导入" }]} onChange={value => { setCategory(value); setLimit(40); }} />
      <p role="status">{busy ? "正在读取字体并准备预览…" : `${filtered.length} 个字体 · 内置和已缓存字体可离线使用`}</p>
      <div className="clip-text__font-list">{filtered.slice(0, limit).map(font => <div key={font.id}><button type="button" disabled={Boolean(busy)} aria-pressed={overlay.font?.sourceId?.split("@")[0] === font.id || overlay.font?.id === font.id} onClick={() => { void choose(font.id); }}>{font.family}<small>{font.bundled ? "内置" : font.local ? "本地" : font.cached ? "已下载" : font.chinese ? "中文 · 下载" : "下载"}</small></button><button type="button" aria-label={`${pins.includes(font.id) ? "取消收藏" : "收藏"}${font.family}`} aria-pressed={pins.includes(font.id)} onClick={() => pin(font.id)}>{pins.includes(font.id) ? "★" : "☆"}</button></div>)}</div>
      {!fonts.length && !busy ? <button type="button" onClick={refresh}>重新读取字体库</button> : null}
      {filtered.length > limit ? <button type="button" onClick={() => setLimit(value => value + 40)}>显示更多字体</button> : null}
      <button type="button" disabled={Boolean(busy)} onClick={() => { void importFont().catch(setError); }}>导入 TTF / OTF 字体</button>
      <button type="button" disabled={Boolean(busy)} onClick={() => { onChange({ font: null }); setOpen(false); }}>使用系统默认字体</button>
    </section> : null}
    {error ? <ErrorAlert error={error} hint="可重试下载，或导入本地 TTF / OTF 字体。当前文字样式已保留。" /> : null}
    <label>字重<CanvasSelect ariaLabel="文字字重" disabled={Boolean(busy)} value={String(overlay.weight ?? (overlay.bold ? 700 : 400))} options={(overlay.font?.weights?.length ? overlay.font.weights : [100, 200, 300, 400, 500, 600, 700, 800, 900]).map(value => ({ value: String(value), label: `${WEIGHT_LABELS[value] ?? "字重"} · ${value}` }))} onChange={value => { if (overlay.font) { void choose(overlay.font.sourceId ?? overlay.font.id, Number(value)); } else onChange({ weight: Number(value), bold: Number(value) >= 700 }); }} /></label>
    <label className="clip-timeline__check"><input type="checkbox" checked={highlight.enabled} onChange={event => onChange({ highlight: { ...highlight, enabled: event.target.checked, words: highlight.words.map(word => word.text).join("") === overlay.text && highlight.words.length ? highlight.words : estimateClipWords(overlay.text, duration) } })} />逐词高亮</label>
    {highlight.enabled ? <>
      <RgbaInput label="高亮文字" value={highlight.textColor} onChange={value => onChange({ highlight: { ...highlight, textColor: value } })} />
      <RgbaInput label="高亮背景" value={highlight.backgroundColor} onChange={value => onChange({ highlight: { ...highlight, backgroundColor: value } })} />
      <details className="clip-text__timing"><summary>词级时间 · {highlight.words.filter(word => word.text.trim()).length} 个词</summary>
        <p>时间相对于这条文字的开始位置。初始时间按文本长度估算，可按语音逐词校准。</p>
        <button type="button" onClick={() => onChange({ highlight: { ...highlight, words: estimateClipWords(overlay.text, duration) } })}>重新均分时间</button>
        <ol>{highlight.words.map((word, index) => word.text.trim() ? <li key={index}><button type="button" aria-label={`定位到词语${word.text}`} onClick={() => onSeek(overlay.start + word.start)}>{word.text}</button><label>开始<input aria-label={`${word.text}开始秒数`} type="number" step={0.01} min={0} max={duration} value={Number.isFinite(word.start) ? word.start : ""} onChange={event => onChange({ highlight: { ...highlight, words: highlight.words.map((item, i) => i === index ? { ...item, start: event.target.valueAsNumber } : item) } })} /></label><label>结束<input aria-label={`${word.text}结束秒数`} type="number" step={0.01} min={0} max={duration} value={Number.isFinite(word.end) ? word.end : ""} onChange={event => onChange({ highlight: { ...highlight, words: highlight.words.map((item, i) => i === index ? { ...item, end: event.target.valueAsNumber } : item) } })} /></label></li> : null)}</ol>
      </details>
    </> : null}
    <label>文字动画<CanvasSelect ariaLabel="文字动画" value={animation.type} options={TEXT_ANIMATIONS} onChange={value => { const preset = TEXT_ANIMATIONS.find(item => item.value === value); if (preset) onChange({ animation: { ...animation, type: preset.value, durationMs: preset.duration } }); }} /></label>
    {animation.type !== "none" ? <>
      <div className="clip-timeline__field-pair"><label>时长（毫秒）<input aria-label="动画时长" type="number" min={100} max={10000} step={50} value={Number.isFinite(animation.durationMs) ? animation.durationMs : ""} onChange={event => onChange({ animation: { ...animation, durationMs: event.target.valueAsNumber } })} /></label><label>延迟（毫秒）<input aria-label="动画延迟" type="number" min={0} max={30000} step={50} value={Number.isFinite(animation.delayMs) ? animation.delayMs : ""} onChange={event => onChange({ animation: { ...animation, delayMs: event.target.valueAsNumber } })} /></label></div>
      <label>重复次数<input aria-label="动画重复次数" type="number" min={1} max={10} step={1} value={Number.isFinite(animation.iterations) ? animation.iterations : ""} onChange={event => onChange({ animation: { ...animation, iterations: event.target.valueAsNumber } })} /></label>
      {animation.type === "wave" ? <label>波浪幅度（像素）<input aria-label="波浪幅度" type="range" min={0} max={100} value={animation.amplitudePx} onChange={event => onChange({ animation: { ...animation, amplitudePx: event.target.valueAsNumber } })} /></label> : null}
    </> : null}
  </div>;
}
