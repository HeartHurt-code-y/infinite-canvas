import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { ErrorAlert } from "../../components/ErrorAlert";
import { CanvasSelect } from "../../components/CanvasSelect";
import { type MediaReferenceTarget } from "../../lib/backend";
import { ClipTimelinePlayer } from "./ClipTimelinePlayer";
import { clipOverlap, clipTimelineLayout } from "./clipTimelineLayout";
import { toMediaSrc } from "../../lib/backend";
import { videoPreparationClient } from "../../lib/videoPreparation";
import { CLIP_JOB_LABEL, clipJobActive, importClipProject, readClipProject, DEFAULT_CLIP_SETTINGS, type ClipTimelineSettings, type ClipOverlay, type ClipEdit, type ClipRenderJob, type ClipAgentModels, type ClipAgentModelOption, type ClipAgentModelChoice } from "../../lib/videoClipEditing";
import { VIDEO_CLIP_ASPECT_RATIOS, VIDEO_CLIP_RESOLUTIONS, type VideoClipParams } from "./videoClipModes";
import { exportArtifactToDesktop, revealDesktopItem } from "./desktopActions";
import type { VideoClipInput } from "./workspaceModel";
import "./VideoClipTimeline.css";

export interface VideoClipTimelineProps {
  readonly name: string;
  readonly inputs: readonly VideoClipInput[];
  readonly saved: readonly ClipEdit[] | undefined;
  readonly savedSettings: ClipTimelineSettings | undefined;
  readonly params: VideoClipParams;
  readonly jobs: readonly ClipRenderJob[];
  readonly autoStart: boolean;
  readonly onSave: (clips: readonly ClipEdit[], settings: ClipTimelineSettings) => void;
  readonly onRender: (clips: readonly ClipEdit[], intelligent: boolean, settings: ClipTimelineSettings, instructions: string) => Promise<void>;
  readonly onCancelJob: (id: string) => Promise<void>;
  readonly onResumeJob: (id: string) => Promise<void>;
  readonly onClose: () => void;
  readonly readError?: unknown;
  readonly onRefresh: () => void;
  readonly onImportParams: (params: VideoClipParams) => void;
  readonly models: ClipAgentModels;
  readonly modelOptions: Readonly<Record<keyof ClipAgentModels, readonly ClipAgentModelOption[]>>;
  readonly onModelChange: (kind: keyof ClipAgentModels, model: ClipAgentModelChoice) => void;
  readonly onRunAgent?: (() => Promise<void>) | undefined;
  readonly nodeError?: unknown;
}
const formatTime = (time: number) => {
  if (!Number.isFinite(time)) return "—";
  const ticks = Math.max(0, Math.round(time * 100));
  return `${Math.floor(ticks / 6000)}:${((ticks % 6000) / 100).toFixed(2).padStart(5, "0")}`;
};

function agentFailureSummary(error: string): string | undefined {
  let payload: unknown;
  try { payload = JSON.parse(error) as unknown; } catch { return undefined; /* Legacy plain text uses ErrorAlert's normal summary. */ }
  function messageFrom(value: unknown, depth = 0): string | undefined {
    if (!value || typeof value !== "object" || depth > 8) return undefined;
    const record = value as Record<string, unknown>;
    for (const key of ["error", "source", "details"]) {
      const nested = messageFrom(record[key], depth + 1);
      if (nested) return nested;
    }
    if (typeof record["rawResponse"] === "string") {
      try {
        const upstream = messageFrom(JSON.parse(record["rawResponse"]) as unknown, depth + 1);
        if (upstream) return upstream;
      } catch { /* The full non-JSON provider diagnostic remains expandable. */ }
    }
    return typeof record["message"] === "string" ? record["message"].replace(/^protocol error:\s*/, "") : undefined;
  }
  const message = messageFrom(payload);
  return message ? `Agent 调用失败：${message.slice(0, 400)}` : undefined;
}

/** The editor stores decisions and stable identities. Preview leases never enter the canvas document. */
export function VideoClipTimeline({ name, inputs, saved, savedSettings, params, jobs, autoStart, onSave, onRender, onCancelJob, onResumeJob, onClose, readError, onRefresh, onImportParams, models, modelOptions, onModelChange, onRunAgent, nodeError }: VideoClipTimelineProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [clips, setClips] = useState<readonly ClipEdit[]>(autoStart ? [] : saved ?? []);
  const [settings, setSettings] = useState<ClipTimelineSettings>({ ...DEFAULT_CLIP_SETTINGS, ...savedSettings });
  const [durations, setDurations] = useState<ReadonlyMap<string, number>>(new Map());
  const identitiesRef = useRef(new Map<string, string>());
  const [selected, setSelected] = useState(0);
  const [selectedOverlay, setSelectedOverlay] = useState<string | null>(null);
  const [seek, setSeek] = useState({ index: 0, nonce: 0 });
  const [timelineTime, setTimelineTime] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [chosenJob, setChosenJob] = useState("");
  const [outputPreview, setOutputPreview] = useState<{ path: string; name: string } | null>(null);
  const [zoom, setZoom] = useState(1);
  const sendingRef = useRef(false);
  const autoStartedRef = useRef(false);
  const newestRef = useRef(jobs[0]?.id);
  const initialRef = useRef({ inputs, saved: autoStart ? undefined : saved, agent: Boolean(onRunAgent) || jobs.some(job => job.agent != null) });
  const onSaveRef = useRef(onSave);
  const settingsRef = useRef(settings);
  const undoRef = useRef<{ clips: readonly ClipEdit[]; settings: ClipTimelineSettings }[]>([]);
  const redoRef = useRef<{ clips: readonly ClipEdit[]; settings: ClipTimelineSettings }[]>([]);
  const draggedRef = useRef<{ index: number; x: number; y: number } | null>(null);
  const suppressDragClickRef = useRef(false);
  const [dragging, setDragging] = useState<number | null>(null);
  useEffect(() => { onSaveRef.current = onSave; settingsRef.current = settings; }, [onSave, settings]);
  const job = jobs.find(item => item.id === chosenJob) ?? jobs[0];
  const running = jobs.some(clipJobActive);
  const blocked = running || sending || loading;
  const selectedClip = clips[selected];
  const overlay = settings.overlays.find(item => item.id === selectedOverlay);
  const layout = useMemo(() => clipTimelineLayout(clips), [clips]);
  const total = layout.at(-1)?.end ?? 0;
  const playhead = selectedClip ? selectedClip.start + timelineTime - (layout[selected]?.start ?? 0) : 0;
  const duration = selectedClip ? durations.get(JSON.stringify(selectedClip.target)) ?? selectedClip.end : 0;
  useEffect(() => {
    if (newestRef.current !== jobs[0]?.id) { setChosenJob(jobs[0]?.id ?? ""); newestRef.current = jobs[0]?.id; }
  }, [jobs[0]?.id]);
  useEffect(() => {
    const dialog = dialogRef.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.showModal();
    return () => { dialog?.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => {
    let disposed = false;
    const read = async () => {
      try {
        const available = initialRef.current.inputs.filter(input => input.nodeType === "video" && input.target);
        if (!available.length && !initialRef.current.saved?.length && !initialRef.current.agent) throw new Error("请先连接一段已保存的视频素材。");
        const existing = initialRef.current.saved ?? [];
        const additions = initialRef.current.saved ? [] : available.map(input => ({ target: input.target!, name: input.name }));
        const values = new Map<string, number>();
        for (const input of [...existing, ...additions]) {
          const token = JSON.stringify(input.target);
          if (values.has(token)) continue;
          const probe = await videoPreparationClient.probe(input.target as MediaReferenceTarget);
          if (disposed) return;
          values.set(token, probe.durationSeconds); identitiesRef.current.set(token, probe.sourceIdentity);
        }
        if (disposed) return;
        setDurations(values);
        if (additions.length) {
          const next = additions.map(input => ({ ...input, start: 0, end: values.get(JSON.stringify(input.target))!, volume: 1, fade: false, caption: "" }));
          setClips(next); onSaveRef.current(next, settingsRef.current);
        }
      } catch (failure) { if (!disposed) setError(failure); }
      finally { if (!disposed) setLoading(false); }
    };
    void read(); return () => { disposed = true; };
  }, []);

  function valid(next: readonly ClipEdit[], options: ClipTimelineSettings) {
    return next.every(clip => Number.isFinite(clip.start) && Number.isFinite(clip.end) && clip.start >= 0 && clip.end - clip.start >= 0.04
      && (!clip.transition || Number.isFinite(clip.transition.seconds) && clip.transition.seconds >= 0.04 && clip.transition.seconds <= 2))
      && options.overlays.every(item => Number.isFinite(item.start) && Number.isFinite(item.end) && item.start >= 0 && item.end - item.start >= 0.04 && item.end <= 300.1);
  }
  function chooseClip(index: number) {
    setSelected(index); setSelectedOverlay(null); setOutputPreview(null); setSeek(current => ({ index, nonce: current.nonce + 1 }));
  }
  function change(next: readonly ClipEdit[], index = selected, options = settings) {
    if (blocked) return;
    undoRef.current = [...undoRef.current.slice(-59), { clips, settings }]; redoRef.current = [];
    setClips(next); setSettings(options); setSelected(Math.max(0, Math.min(index, next.length - 1))); setOutputPreview(null);
    if (valid(next, options)) onSave(next, options);
  }
  function patch(value: Partial<ClipEdit>) { change(clips.map((clip, index) => index === selected ? { ...clip, ...value } : clip)); }
  function changeSettings(value: Partial<ClipTimelineSettings>) { change(clips, selected, { ...settings, ...value }); }
  function patchOverlay(value: Partial<ClipOverlay>) { changeSettings({ overlays: settings.overlays.map(item => item.id === selectedOverlay ? { ...item, ...value } : item) }); }
  function history(direction: "undo" | "redo") {
    if (blocked) return;
    const source = direction === "undo" ? undoRef : redoRef;
    const target = direction === "undo" ? redoRef : undoRef;
    const snapshot = source.current.pop(); if (!snapshot) return;
    target.current.push({ clips, settings }); setClips(snapshot.clips); setSettings(snapshot.settings); setOutputPreview(null);
    setSelectedOverlay(null); setSeek(current => ({ index: Math.min(selected, snapshot.clips.length - 1), nonce: current.nonce + 1 }));
    if (valid(snapshot.clips, snapshot.settings)) onSave(snapshot.clips, snapshot.settings);
  }
  function addOverlay(kind: ClipOverlay["kind"]) {
    const start = Math.min(timelineTime, Math.max(0, total - 0.04));
    const item: ClipOverlay = { id: crypto.randomUUID(), kind, text: kind === "text" ? "输入文字" : "输入字幕", start, end: Math.min(total, start + 3), x: 50, y: kind === "text" ? 20 : 88, size: 4.5, color: "#ffffff", background: false, bold: kind === "text" };
    changeSettings({ overlays: [...settings.overlays, item] }); setSelectedOverlay(item.id);
  }
  function detachCaptions() {
    const additions: ClipOverlay[] = layout.filter(item => item.clip.caption.trim()).map(item => ({ id: crypto.randomUUID(), kind: "subtitle", text: item.clip.caption, start: item.start, end: item.end, x: 50, y: 88, size: 4.5, color: "#ffffff", background: false, bold: false }));
    change(clips.map(clip => ({ ...clip, caption: "" })), selected, { ...settings, overlays: [...settings.overlays, ...additions] });
  }
  function moveClip(from: number, to: number) {
    if (from === to || from < 0 || to < 0 || from >= clips.length || to >= clips.length) return;
    const next = [...clips]; const [moved] = next.splice(from, 1); if (!moved) return; next.splice(to, 0, moved); change(next, to); chooseClip(to);
  }
  function dragStart(event: ReactPointerEvent<HTMLLIElement>, index: number) {
    if (blocked || event.button !== 0) return;
    draggedRef.current = { index, x: event.clientX, y: event.clientY }; suppressDragClickRef.current = false;
  }
  function dragMove(event: ReactPointerEvent<HTMLLIElement>) {
    const gesture = draggedRef.current;
    if (!gesture || Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < 4) return;
    event.currentTarget.setPointerCapture(event.pointerId); setDragging(gesture.index); event.preventDefault();
  }
  function dragEnd(event: ReactPointerEvent<HTMLLIElement>) {
    const gesture = draggedRef.current; draggedRef.current = null; setDragging(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!gesture || Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < 4) return;
    suppressDragClickRef.current = true; event.preventDefault(); event.stopPropagation();
    const hit = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-clip-order]");
    const index = hit?.dataset["clipOrder"];
    if (index != null && hit?.closest("dialog") === dialogRef.current) moveClip(gesture.index, Number(index));
  }
  async function render(intelligent: boolean) {
    if (sendingRef.current || blocked || !clips.length) return;
    if (!valid(clips, settings) || clips.some(clip => clip.end > (durations.get(JSON.stringify(clip.target)) ?? Infinity) + 0.01)) { setError(new Error("裁切或文字轨时间无效，请检查开始和结束时间。")); return; }
    if (!intelligent && total > 300.1) { setError(new Error("手动剪辑总时长不能超过300秒，请裁短素材。")); return; }
    sendingRef.current = true; setSending(true); setError(null);
    try { await onRender(clips.map(clip => ({ ...clip, sourceIdentity: clip.sourceIdentity ?? identitiesRef.current.get(JSON.stringify(clip.target)) ?? null })), intelligent, settings, settings.instructions); }
    catch (failure) { setError(failure); }
    finally { sendingRef.current = false; setSending(false); }
  }
  const renderRef = useRef(render);
  useEffect(() => { renderRef.current = render; });
  useEffect(() => {
    if (!autoStart || loading || !clips.length || error || autoStartedRef.current) return;
    autoStartedRef.current = true; void renderRef.current(true);
  }, [autoStart, loading, clips.length, error]);
  async function exportFile(path: string, fileName: string) {
    try { await exportArtifactToDesktop(path, fileName); } catch (failure) { setError(failure); }
  }
  async function loadProject(path?: string) {
    if (running || sendingRef.current) return;
    sendingRef.current = true; setSending(true); setError(null);
    try {
      const project = path ? await readClipProject(path) : await importClipProject();
      if (!project) return;
      const values = new Map(durations);
      for (const clip of project.clips) {
        const token = JSON.stringify(clip.target);
        const probe = await videoPreparationClient.probe(clip.target as MediaReferenceTarget);
        if (clip.sourceIdentity && probe.sourceIdentity !== clip.sourceIdentity) throw new Error(`“${clip.name}”的原文件内容已变化，请重新连接素材。`);
        values.set(token, probe.durationSeconds); identitiesRef.current.set(token, probe.sourceIdentity);
      }
      undoRef.current.push({ clips, settings }); redoRef.current = [];
      setDurations(values); setClips(project.clips); setSettings(project.settings); setSelected(0); setSelectedOverlay(null); setOutputPreview(null);
      setSeek(current => ({ index: 0, nonce: current.nonce + 1 })); onSave(project.clips, project.settings); onImportParams(project.params);
      dialogRef.current?.querySelector(".clip-timeline__body")?.scrollTo({ top: 0, behavior: "smooth" });
    } catch (failure) { setError(failure); }
    finally { sendingRef.current = false; setSending(false); }
  }
  async function addConnectedVideo(input: VideoClipInput) {
    if (blocked || sendingRef.current || !input.target || clips.length >= 60) return;
    sendingRef.current = true; setSending(true); setError(null);
    try {
      const probe = await videoPreparationClient.probe(input.target as MediaReferenceTarget);
      const token = JSON.stringify(input.target);
      identitiesRef.current.set(token, probe.sourceIdentity);
      setDurations(current => new Map(current).set(token, probe.durationSeconds));
      const next = [...clips, { target: input.target, name: input.name, sourceIdentity: probe.sourceIdentity, start: 0, end: probe.durationSeconds, volume: 1, fade: false, caption: "" }];
      undoRef.current = [...undoRef.current.slice(-59), { clips, settings }]; redoRef.current = [];
      setClips(next); setSelected(next.length - 1); setSelectedOverlay(null); setOutputPreview(null);
      setSeek(current => ({ index: next.length - 1, nonce: current.nonce + 1 })); onSave(next, settings);
    } catch (failure) { setError(failure); }
    finally { sendingRef.current = false; setSending(false); }
  }
  const onPosition = useCallback((_index: number, _sourceSeconds: number, timelineSeconds: number) => { setTimelineTime(timelineSeconds); }, []);
  function outputActions(path: string, subtitlePath: string, projectPath: string, outputName: string) {
    const extension = path.toLowerCase().endsWith(".webm") ? "webm" : "mp4";
    return <div className="clip-timeline__actions">
      <button type="button" onClick={() => { setOutputPreview({ path, name: outputName }); dialogRef.current?.querySelector(".clip-timeline__body")?.scrollTo({ top: 0, behavior: "smooth" }); }}>预览成片</button>
      <button type="button" disabled={blocked} onClick={() => { void loadProject(projectPath); }}>载入此产物编辑</button>
      <button type="button" onClick={() => { void exportFile(path, `${outputName}.${extension}`); }}>导出 {extension.toUpperCase()}</button>
      <button type="button" onClick={() => { void exportFile(subtitlePath, `${outputName}.srt`); }}>导出字幕</button>
      <button type="button" onClick={() => { void exportFile(projectPath, `${outputName}.timeline.json`); }}>导出工程</button>
      <button type="button" onClick={() => { void revealDesktopItem(path).catch((failure: unknown) => setError(failure)); }}>打开文件位置</button>
    </div>;
  }
  return createPortal(<dialog ref={dialogRef} className="clip-timeline" aria-labelledby={titleId} onCancel={event => event.preventDefault()}
    onKeyDown={event => {
      if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); return; }
      const editable = event.target instanceof HTMLElement && Boolean(event.target.closest("input,textarea,[contenteditable='true']"));
      if (!editable && (event.ctrlKey || event.metaKey) && ["z", "y"].includes(event.key.toLowerCase())) {
        event.preventDefault(); event.stopPropagation(); history(event.key.toLowerCase() === "y" || event.shiftKey ? "redo" : "undo");
      }
    }}>
    <header className="clip-timeline__header"><div><h2 id={titleId}>智能剪辑 · {name}</h2><p>整片预览 · 视频、文字与字幕轨 · 本地导出</p></div><button type="button" onClick={onClose} aria-label="关闭智能剪辑">×</button></header>
    <div className="clip-timeline__body">
      <div className="clip-timeline__topbar">
        {jobs.length > 0 ? <label>任务历史<CanvasSelect ariaLabel="智能剪辑任务历史" value={job?.id ?? ""} options={jobs.map((item, index) => ({ value: item.id, label: `${jobs.length - index}. ${item.name} · ${CLIP_JOB_LABEL[item.status]}` }))} onChange={value => { setChosenJob(value); setOutputPreview(null); }} /></label> : null}
        <div className="clip-timeline__actions"><button type="button" disabled={blocked || !undoRef.current.length} onClick={() => history("undo")}>撤销</button><button type="button" disabled={blocked || !redoRef.current.length} onClick={() => history("redo")}>重做</button><button type="button" disabled={blocked} onClick={() => { void loadProject(); }}>导入剪辑工程</button></div>
      </div>
      <details className="clip-timeline__models"><summary>Agent 模型</summary><div>{(["text", "video", "speech"] as const).map(kind => <label key={kind}>{kind === "text" ? "规划模型" : kind === "video" ? "画面模型" : "语音模型"}
        <CanvasSelect ariaLabel={kind === "text" ? "规划模型" : kind === "video" ? "画面模型" : "语音模型"} disabled={running || sending} value={JSON.stringify([models[kind].providerId, models[kind].modelDefinitionId])}
          options={[{ value: "", label: "请选择模型" }, ...modelOptions[kind].map(option => ({ value: JSON.stringify([option.providerId, option.modelDefinitionId]), label: option.label }))]}
          onChange={value => { const choice = modelOptions[kind].find(option => JSON.stringify([option.providerId, option.modelDefinitionId]) === value); if (choice) onModelChange(kind, choice); }} /></label>)}</div><p>按本节点保存；已有任务使用受理时的模型。</p></details>
      {outputPreview ? <section className="clip-timeline__render-preview" aria-label="成片预览"><strong>{outputPreview.name}</strong><video src={toMediaSrc(outputPreview.path)} controls preload="metadata" onError={() => setError(new Error("成片无法播放，请检查本地文件。"))} /><button type="button" onClick={() => setOutputPreview(null)}>返回轨道预览</button></section>
        : clips.length ? <ClipTimelinePlayer clips={clips} settings={settings} params={params} seek={seek} onPosition={onPosition} onError={setError} />
        : <section className="clip-timeline__preview" role="status">{loading ? "正在读取原视频…" : job?.status === "completed" ? "成片已完成，可在下方预览或载入任一产物编辑" : running ? "Agent 正在处理，成片会自动保存到画布" : "连接素材，或在下方发起 Agent 创作"}</section>}
      <section className="clip-timeline__inspector" aria-label="轨道设置">
        {overlay ? <fieldset disabled={blocked}><legend>{overlay.kind === "text" ? "独立文字轨" : "独立字幕轨"}</legend>
          <label>内容<textarea aria-label="轨道文字内容" rows={3} maxLength={2000} value={overlay.text} onChange={event => patchOverlay({ text: event.target.value })} /></label>
          <div className="clip-timeline__field-pair"><label>出现（秒）<input aria-label="文字出现时间" type="number" min={0} max={300} step={0.01} value={Number.isFinite(overlay.start) ? overlay.start : ""} onChange={event => patchOverlay({ start: event.target.valueAsNumber })} /></label><label>结束（秒）<input aria-label="文字结束时间" type="number" min={0} max={300} step={0.01} value={Number.isFinite(overlay.end) ? overlay.end : ""} onChange={event => patchOverlay({ end: event.target.valueAsNumber })} /></label></div>
          <div className="clip-timeline__field-pair"><label>水平位置 %<input aria-label="文字水平位置" type="range" min={0} max={100} value={overlay.x} onChange={event => patchOverlay({ x: event.target.valueAsNumber })} /></label><label>垂直位置 %<input aria-label="文字垂直位置" type="range" min={0} max={100} value={overlay.y} onChange={event => patchOverlay({ y: event.target.valueAsNumber })} /></label></div>
          <label>字号（画面高度 %）<input aria-label="文字字号" type="range" min={1} max={20} step={0.5} value={overlay.size} onChange={event => patchOverlay({ size: event.target.valueAsNumber })} /></label>
          <label>文字颜色<input type="color" value={overlay.color} onChange={event => patchOverlay({ color: event.target.value })} /></label>
          <label className="clip-timeline__check"><input type="checkbox" checked={overlay.bold} onChange={event => patchOverlay({ bold: event.target.checked })} />粗体</label><label className="clip-timeline__check"><input type="checkbox" checked={overlay.background} onChange={event => patchOverlay({ background: event.target.checked })} />半透明背景</label>
          {overlay.kind === "subtitle" && settings.subtitles === "soft" ? <p>当前导出可关闭字幕。位置与颜色需选择「烧录字幕」后写入画面。</p> : null}
          <button type="button" onClick={() => { changeSettings({ overlays: settings.overlays.filter(item => item.id !== overlay.id) }); setSelectedOverlay(null); }}>删除这条文字</button><button type="button" onClick={() => setSelectedOverlay(null)}>返回片段设置</button>
        </fieldset> : selectedClip ? <fieldset disabled={blocked}><legend>{selectedClip.name}</legend>
          <label>开始（秒）<input type="number" min={0} max={duration} step={0.01} value={Number.isFinite(selectedClip.start) ? selectedClip.start : ""} onChange={event => patch({ start: event.target.valueAsNumber })} /></label>
          <label>结束（秒）<input type="number" min={0} max={duration} step={0.01} value={Number.isFinite(selectedClip.end) ? selectedClip.end : ""} onChange={event => patch({ end: event.target.valueAsNumber })} /></label>
          <label>音量 {Math.round(selectedClip.volume * 100)}%<input type="range" min={0} max={2} step={0.01} value={selectedClip.volume} onChange={event => patch({ volume: event.target.valueAsNumber })} /></label>
          <label className="clip-timeline__check"><input type="checkbox" checked={selectedClip.fade} onChange={event => patch({ fade: event.target.checked })} />片段首尾淡入淡出</label>
          {selected < clips.length - 1 ? <><label>与下一段的转场<CanvasSelect ariaLabel="片段转场" value={selectedClip.transition?.kind ?? "none"} options={[{ value: "none", label: "无转场" }, { value: "fade", label: "淡入淡出" }, { value: "black", label: "黑场过渡" }, { value: "white", label: "白场过渡" }]} onChange={value => patch({ transition: value === "none" ? null : { kind: value as "fade" | "black" | "white", seconds: selectedClip.transition?.seconds ?? 0.3 } })} /></label>
            {selectedClip.transition ? <label>转场时长（秒）<input type="number" min={0.04} max={2} step={0.01} value={Number.isFinite(selectedClip.transition.seconds) ? selectedClip.transition.seconds : ""} onChange={event => patch({ transition: { ...selectedClip.transition!, seconds: event.target.valueAsNumber } })} /><small>实际重叠 {clipOverlap(selectedClip, clips[selected + 1]!).toFixed(2)} 秒，不超过相邻片段的一半。</small></label> : null}</> : null}
          <label>片段字幕<textarea value={selectedClip.caption} maxLength={2000} rows={2} onChange={event => patch({ caption: event.target.value })} /></label>
          <div className="clip-timeline__actions"><button type="button" disabled={playhead <= selectedClip.start + 0.04 || playhead >= selectedClip.end - 0.04} onClick={() => { const next = [...clips]; next.splice(selected, 1, { ...selectedClip, end: playhead, transition: null }, { ...selectedClip, start: playhead }); change(next); }}>在播放头分割</button><button type="button" disabled={clips.length < 2} onClick={() => change(clips.filter((_, index) => index !== selected))}>删除片段</button></div>
        </fieldset> : null}
      </section>
      {inputs.some(input => input.nodeType === "video" && input.target) ? <details className="clip-timeline__connected"><summary>加入已连接视频</summary><div>{inputs.filter(input => input.nodeType === "video" && input.target).map(input => <button key={input.key} type="button" disabled={blocked || clips.length >= 60} onClick={() => { void addConnectedVideo(input); }}>加入轨道：{input.name}</button>)}</div><p>明确加入所选素材；不会重置已有剪辑。每次加入可用撤销恢复。</p></details> : null}
      <section className="clip-timeline__sequence" aria-label="视频轨道">
        <div className="clip-timeline__sequence-title"><strong>视频轨道</strong><output>{clips.length} 段 · {Number.isFinite(total) ? formatTime(total) : "时间待修正"}</output><label>时间轴缩放<input aria-label="时间轴缩放" type="range" min={1} max={5} step={0.5} value={zoom} onChange={event => setZoom(event.target.valueAsNumber)} /></label></div>
        <div className="clip-timeline__track-scroll"><ol style={{ width: `${zoom * 100}%`, minWidth: `${clips.length * 110}px` }}>{layout.map(item => <li key={item.index} className={[item.index === selected && !selectedOverlay ? "is-selected" : "", dragging === item.index ? "is-dragging" : ""].join(" ")} data-clip-order={item.index} onPointerDown={event => dragStart(event, item.index)} onPointerMove={dragMove} onPointerUp={dragEnd} onPointerCancel={() => { draggedRef.current = null; setDragging(null); }} onClickCapture={event => { if (suppressDragClickRef.current) { event.preventDefault(); event.stopPropagation(); suppressDragClickRef.current = false; } }}
          style={{ left: `${total > 0 ? item.start / total * 100 : 0}%`, width: `${total > 0 ? (item.end - item.start) / total * 100 : 100}%` }}>
          <button type="button" aria-pressed={item.index === selected && !selectedOverlay} onClick={() => chooseClip(item.index)}><span>{item.index + 1}. {item.clip.name}</span><small>{formatTime(item.start)}—{formatTime(item.end)}</small>{item.overlap > 0 ? <small>转场 {item.overlap.toFixed(2)}s</small> : null}</button>
          <div><button type="button" aria-label={`前移片段${item.index + 1}`} disabled={item.index === 0 || blocked} onClick={() => moveClip(item.index, item.index - 1)}>←</button><button type="button" aria-label={`后移片段${item.index + 1}`} disabled={item.index === clips.length - 1 || blocked} onClick={() => moveClip(item.index, item.index + 1)}>→</button></div>
        </li>)}</ol></div>
        <div className="clip-timeline__actions"><button type="button" disabled={blocked || !clips.length || settings.overlays.length >= 200} onClick={() => addOverlay("text")}>添加文字</button><button type="button" disabled={blocked || !clips.length || settings.overlays.length >= 200} onClick={() => addOverlay("subtitle")}>添加字幕</button><button type="button" disabled={blocked || !clips.some(clip => clip.caption.trim()) || settings.overlays.length + clips.filter(clip => clip.caption.trim()).length > 200} onClick={detachCaptions}>分离片段字幕到独立轨</button></div>
      </section>
      {(["text", "subtitle"] as const).map(kind => <section key={kind} className="clip-timeline__text-track" aria-label={kind === "text" ? "独立文字轨" : "独立字幕轨"}><strong>{kind === "text" ? "文字轨" : "字幕轨"}</strong>{settings.overlays.filter(item => item.kind === kind).length ? <ol>{settings.overlays.filter(item => item.kind === kind).map(item => <li key={item.id}><button type="button" aria-pressed={selectedOverlay === item.id} onClick={() => { setSelectedOverlay(item.id); setOutputPreview(null); }}><span>{formatTime(item.start)}—{formatTime(item.end)}</span><span>{item.text || "空白内容"}</span></button></li>)}</ol> : <p>{kind === "text" ? "可添加标题，独立设置出现时间与位置" : "可添加字幕，或将片段字幕分离后独立调整时间"}</p>}</section>)}
      <section className="clip-timeline__export-settings" aria-label="导出设置"><strong>导出设置</strong><div>
        <label>视频格式<CanvasSelect ariaLabel="视频导出格式" disabled={blocked} value={settings.format} options={[{ value: "mp4", label: "MP4 · H.264" }, { value: "webm", label: "WEBM · VP9" }]} onChange={value => changeSettings({ format: value as "mp4" | "webm" })} /></label>
        <label>字幕方式<CanvasSelect ariaLabel="字幕导出方式" disabled={blocked} value={settings.subtitles} options={[{ value: "soft", label: "可关闭字幕" }, { value: "burn", label: "烧录字幕" }, { value: "hidden", label: "隐藏字幕" }]} onChange={value => changeSettings({ subtitles: value as ClipTimelineSettings["subtitles"] })} /></label>
        <label>画面比例<CanvasSelect ariaLabel="剪辑导出比例" disabled={blocked} value={params.aspectRatio} options={VIDEO_CLIP_ASPECT_RATIOS.map(value => ({ value, label: value }))} onChange={value => onImportParams({ ...params, aspectRatio: value as VideoClipParams["aspectRatio"] })} /></label>
        <label>清晰度<CanvasSelect ariaLabel="剪辑导出清晰度" disabled={blocked} value={params.resolution} options={VIDEO_CLIP_RESOLUTIONS.map(value => ({ value, label: value }))} onChange={value => onImportParams({ ...params, resolution: value as VideoClipParams["resolution"] })} /></label>
        <label className="clip-timeline__check"><input type="checkbox" disabled={blocked} checked={settings.muted} onChange={event => changeSettings({ muted: event.target.checked })} />静音视频原声</label>
      </div><p>文字始终写入画面；独立轨与转场随本项目工程保存。SRT 另存一份，隐藏字幕时也可单独导出。</p></section>
      <section className="clip-timeline__revision"><label>本次改剪要求<textarea disabled={blocked} rows={2} maxLength={20000} value={settings.instructions} placeholder="例如：缩短开头，保留第二段，把最后一段移到片尾" onChange={event => changeSettings({ instructions: event.target.value })} /></label><p>按当前轨道智能改剪会发起新的规划调用，原素材与历史任务保留。</p></section>
      {error ? <ErrorAlert error={error} hint="请检查素材、时间与导出设置。重新读取任务不会提交新请求。" /> : null}
      {nodeError ? <ErrorAlert error={nodeError} hint="在上方 Agent 模型中调整后重新开始。" /> : null}
      {readError ? <ErrorAlert error={readError} label="读取剪辑记录失败" hint="重新读取只查询已有任务。" /> : null}
      <button type="button" onClick={onRefresh}>重新读取任务记录</button>
      {job ? <section className="clip-timeline__job" aria-live="polite"><strong>{CLIP_JOB_LABEL[job.status]} · {Math.round(job.progress)}%{job.durationSeconds != null ? ` · 实际 ${job.durationSeconds.toFixed(2)} 秒` : ""}</strong>
        {clipJobActive(job) ? <button type="button" onClick={() => { void onCancelJob(job.id).catch((failure: unknown) => setError(failure)); }}>取消剪辑</button> : null}
        {job.error ? <ErrorAlert error={job.error} summaryText={job.agent ? agentFailureSummary(job.error) : undefined} hint="原调用与诊断已保留。继续原任务只复用已有结果，不会重发失败的模型调用。" /> : null}
        {job.status === "failed" || job.status === "interrupted" ? <button type="button" disabled={sending} onClick={() => { setSending(true); void onResumeJob(job.id).catch((failure: unknown) => setError(failure)).finally(() => setSending(false)); }}>继续原任务（复用已有结果）</button> : null}
        {job.agent ? <div className="clip-timeline__agent"><p>{job.agent.summary}</p><p>已保留 {job.agent.steps.filter(step => step.taskId).length} 个模型任务 · 最多 {job.agent.planningRoundLimit} 轮规划、{job.agent.modelCallLimit} 次模型调用</p>
          <ol aria-label="Agent执行步骤">{job.agent.steps.map(step => <li key={step.key} data-status={step.status}><span>{step.status === "succeeded" ? "已完成" : step.status === "failed" ? "失败" : "进行中"}</span><div><strong>{step.label}</strong>{step.detail ? <small>{step.detail}</small> : null}{step.taskId ? <small>任务 {step.taskId}</small> : null}</div></li>)}</ol>
          {job.agent.outputs.map(output => <div key={output.id} className="clip-timeline__agent-output"><strong>{output.name} · {output.durationSeconds.toFixed(2)}秒</strong>{outputActions(output.path, output.subtitlePath, output.projectPath, output.name)}</div>)}
        </div> : null}
        {job.status === "completed" && !job.agent?.outputs.length && job.outputPath && job.subtitlePath && job.projectPath ? outputActions(job.outputPath, job.subtitlePath, job.projectPath, job.name) : null}
      </section> : null}
    </div>
    <footer><span>{loading ? "正在读取素材…" : running ? "任务进行中，可切换历史查看已有产物" : "编辑已随画布保存 · 手动导出在本机完成"}</span>
      <button type="button" disabled={blocked || !clips.length} onClick={() => { void render(false); }}>按当前轨道导出 {settings.format.toUpperCase()}</button>
      <button type="button" disabled={blocked || !clips.length} onClick={() => { void render(true); }}>按当前轨道智能改剪</button>
      {onRunAgent ? <button type="button" disabled={blocked} onClick={() => { if (sendingRef.current) return; sendingRef.current = true; setSending(true); void onRunAgent().catch((failure: unknown) => setError(failure)).finally(() => { sendingRef.current = false; setSending(false); }); }}>开始 Agent 创作</button> : null}
    </footer>
  </dialog>, document.body);
}
