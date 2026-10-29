import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ErrorAlert } from "../../components/ErrorAlert";
import { type MediaReferenceTarget } from "../../lib/backend";
import { prepareVideoEditSource } from "../../lib/videoLocalEdit";
import { videoPreparationClient } from "../../lib/videoPreparation";
import { CLIP_JOB_LABEL, clipJobActive, importClipProject, type ClipEdit, type ClipRenderJob } from "../../lib/videoClipEditing";
import type { VideoClipParams } from "./videoClipModes";
import { exportArtifactToDesktop, revealDesktopItem } from "./desktopActions";
import type { VideoClipInput } from "./workspaceModel";
import "./VideoClipTimeline.css";

export interface VideoClipTimelineProps {
  readonly name: string;
  readonly inputs: readonly VideoClipInput[];
  readonly saved: readonly ClipEdit[] | undefined;
  readonly jobs: readonly ClipRenderJob[];
  readonly autoStart: boolean;
  readonly onSave: (clips: readonly ClipEdit[]) => void;
  readonly onRender: (clips: readonly ClipEdit[], intelligent: boolean) => Promise<void>;
  readonly onCancelJob: (id: string) => Promise<void>;
  readonly onClose: () => void;
  readonly readError?: unknown;
  readonly onRefresh: () => void;
  readonly onImportParams: (params: VideoClipParams) => void;
}
const formatTime = (time: number) => {
  if (!Number.isFinite(time)) return "—";
  const ticks = Math.max(0, Math.round(time * 100));
  return `${Math.floor(ticks / 6000)}:${((ticks % 6000) / 100).toFixed(2).padStart(5, "0")}`;
};

/** The editor stores decisions and stable identities. Preview leases never enter the canvas document. */
export function VideoClipTimeline({ name, inputs, saved, jobs, autoStart, onSave, onRender, onCancelJob, onClose, readError, onRefresh, onImportParams }: VideoClipTimelineProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [clips, setClips] = useState<readonly ClipEdit[]>(autoStart ? [] : saved ?? []);
  const [durations, setDurations] = useState<ReadonlyMap<string, number>>(new Map());
  const identitiesRef = useRef(new Map<string, string>());
  const [selected, setSelected] = useState(0);
  const [src, setSrc] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const sendingRef = useRef(false);
  const autoStartedRef = useRef(false);
  const initialRef = useRef({ inputs, saved: autoStart ? undefined : saved });
  const onSaveRef = useRef(onSave);
  useEffect(() => { onSaveRef.current = onSave; }, [onSave]);
  const job = jobs[0];
  const running = jobs.some(clipJobActive);
  const selectedClip = clips[selected];
  const targetToken = JSON.stringify(selectedClip?.target ?? null);

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
        const available = initialRef.current.inputs.filter((input) => input.nodeType === "video" && input.target);
        if (!available.length && !initialRef.current.saved?.length) throw new Error("请先连接一段已保存的视频素材。");
        const existing = initialRef.current.saved ?? [];
        const existingTargets = new Set(existing.map(clip => JSON.stringify(clip.target)));
        const additions = available.filter(input => !existingTargets.has(JSON.stringify(input.target))).map(input => ({ target: input.target!, name: input.name }));
        const targets = [...existing.map(clip => ({ target: clip.target, name: clip.name })), ...additions];
        const values = new Map<string, number>();
        for (const input of targets) {
          const token = JSON.stringify(input.target);
          if (values.has(token)) continue;
          const probe = await videoPreparationClient.probe(input.target as MediaReferenceTarget);
          if (disposed) return;
          values.set(token, probe.durationSeconds);
          identitiesRef.current.set(token, probe.sourceIdentity);
        }
        if (disposed) return;
        setDurations(values);
        if (additions.length) {
          const next = [...existing, ...additions.map((input) => ({ ...input, start: 0, end: values.get(JSON.stringify(input.target))!, volume: 1, fade: false, caption: "" }))];
          setClips(next); onSaveRef.current(next);
        }
      } catch (failure) { if (!disposed) setError(failure); }
      finally { if (!disposed) setLoading(false); }
    };
    void read();
    return () => { disposed = true; };
  }, []);

  useEffect(() => {
    if (targetToken === "null") return;
    let disposed = false;
    let release: (() => Promise<void>) | undefined;
    setSrc("");
    void prepareVideoEditSource(JSON.parse(targetToken) as MediaReferenceTarget, "").then((source) => {
      if (disposed) { void source.release(); return; }
      release = source.release; setSrc(source.src);
    }).catch((failure: unknown) => { if (!disposed) setError(failure); });
    return () => { disposed = true; if (release) void release(); };
  }, [targetToken]);

  const total = clips.reduce((time, clip) => time + clip.end - clip.start, 0);
  const validation = clips.find((clip) => !Number.isFinite(clip.start) || !Number.isFinite(clip.end) || clip.start < 0 || clip.end <= clip.start
    || clip.end > (durations.get(JSON.stringify(clip.target)) ?? Infinity) + 0.01);
  function change(next: readonly ClipEdit[], index = selected) {
    if (running || sending) return;
    setClips(next); setSelected(Math.max(0, Math.min(index, next.length - 1)));
    if (next.every(clip => Number.isFinite(clip.start) && Number.isFinite(clip.end))) onSave(next);
  }
  function patch(patch: Partial<ClipEdit>) { change(clips.map((clip, index) => index === selected ? { ...clip, ...patch } : clip)); }
  async function render(intelligent: boolean) {
    if (sendingRef.current || running || loading || !clips.length) return;
    if (validation) { setError(new Error("裁切时间无效，请检查每段的开始和结束时间。")); return; }
    if (!intelligent && total > 300.1) { setError(new Error("手动剪辑总时长不能超过300秒，请裁短素材。")); return; }
    sendingRef.current = true; setSending(true); setError(null);
    try { await onRender(clips.map(clip => ({ ...clip, sourceIdentity: clip.sourceIdentity ?? identitiesRef.current.get(JSON.stringify(clip.target)) ?? null })), intelligent); }
    catch (failure) { setError(failure); }
    finally { sendingRef.current = false; setSending(false); }
  }
  const renderRef = useRef(render);
  useEffect(() => { renderRef.current = render; });
  useEffect(() => {
    if (!autoStart || loading || !clips.length || error || autoStartedRef.current) return;
    autoStartedRef.current = true;
    void renderRef.current(true);
  }, [autoStart, loading, clips.length, error]);

  async function exportFile(path: string, fileName: string) {
    try { await exportArtifactToDesktop(path, fileName); }
    catch (failure) { setError(failure); }
  }
  async function importProject() {
    if (running || sendingRef.current) return;
    sendingRef.current = true; setSending(true); setError(null);
    try {
      const project = await importClipProject();
      if (!project) return;
      const nextDurations = new Map(durations);
      for (const clip of project.clips) {
        const token = JSON.stringify(clip.target);
        if (!nextDurations.has(token)) {
          const probe = await videoPreparationClient.probe(clip.target as MediaReferenceTarget);
          nextDurations.set(token, probe.durationSeconds); identitiesRef.current.set(token, probe.sourceIdentity);
        }
      }
      setDurations(nextDurations); setClips(project.clips); setSelected(0); onSave(project.clips); onImportParams(project.params);
    } catch (failure) { setError(failure); }
    finally { sendingRef.current = false; setSending(false); }
  }
  const duration = selectedClip ? durations.get(targetToken) ?? selectedClip.end : 0;
  return createPortal(
    <dialog ref={dialogRef} className="clip-timeline" aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); }}
      onKeyDown={(event) => { if (event.key === "Escape" && !event.defaultPrevented && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); event.stopPropagation(); onClose(); } }}>
      <header className="clip-timeline__header"><div><h2 id={titleId}>智能剪辑 · {name}</h2><p>裁切、排序、声音与字幕 · 本地导出</p></div><button type="button" onClick={onClose} aria-label="关闭智能剪辑">×</button></header>
      <div className="clip-timeline__body">
        <section className="clip-timeline__preview" aria-label="片段预览">
          {src ? <video key={src} ref={videoRef} src={src} controls preload="metadata"
            onPlay={() => { if (videoRef.current && selectedClip && (videoRef.current.currentTime < selectedClip.start || videoRef.current.currentTime >= selectedClip.end)) videoRef.current.currentTime = selectedClip.start; }}
            onLoadedMetadata={() => { if (videoRef.current && selectedClip) { videoRef.current.currentTime = selectedClip.start; videoRef.current.volume = Math.min(1, selectedClip.volume); } }}
            onTimeUpdate={() => { if (!videoRef.current || !selectedClip) return; setPlayhead(videoRef.current.currentTime); if (videoRef.current.currentTime >= selectedClip.end && !videoRef.current.paused) videoRef.current.pause(); }}
            onError={() => setError(new Error("视频预览无法播放，请检查原文件格式。"))} /> : <p role="status">{loading ? "正在读取原视频…" : "选择一个片段预览"}</p>}
          {selectedClip?.caption && <p className="clip-timeline__caption">{selectedClip.caption}</p>}
          <output>{formatTime(playhead)} / {formatTime(duration)}</output>
        </section>
        <section className="clip-timeline__inspector" aria-label="片段设置">
          {selectedClip ? <fieldset disabled={running || sending || loading}>
            <legend>{selectedClip.name}</legend>
            <label>开始（秒）<input type="number" min={0} max={duration} step={0.01} value={Number.isFinite(selectedClip.start) ? selectedClip.start : ""} onChange={(event) => patch({ start: event.target.valueAsNumber })} /></label>
            <label>结束（秒）<input type="number" min={0} max={duration} step={0.01} value={Number.isFinite(selectedClip.end) ? selectedClip.end : ""} onChange={(event) => patch({ end: event.target.valueAsNumber })} /></label>
            <label>音量 {Math.round(selectedClip.volume * 100)}%<input type="range" min={0} max={2} step={0.01} value={selectedClip.volume} onChange={(event) => { patch({ volume: event.target.valueAsNumber }); if (videoRef.current) videoRef.current.volume = Math.min(1, event.target.valueAsNumber); }} /></label>
            <label className="clip-timeline__check"><input type="checkbox" checked={selectedClip.fade} onChange={(event) => patch({ fade: event.target.checked })} />淡入淡出（画面与声音）</label>
            <label>字幕轨<textarea value={selectedClip.caption} maxLength={2000} rows={3} onChange={(event) => patch({ caption: event.target.value })} placeholder="本片段的字幕" /></label>
            <p>字幕以独立可关闭轨道写入 MP4，并另存 SRT。</p>
            <div className="clip-timeline__actions">
              <button type="button" disabled={playhead <= selectedClip.start + 0.04 || playhead >= selectedClip.end - 0.04} onClick={() => { const next = [...clips]; next.splice(selected, 1, { ...selectedClip, end: playhead }, { ...selectedClip, start: playhead }); change(next); }}>在播放头分割</button>
              <button type="button" disabled={clips.length < 2} onClick={() => change(clips.filter((_, index) => index !== selected))}>删除片段</button>
            </div>
          </fieldset> : null}
        </section>
        <section className="clip-timeline__sequence" aria-label="视频轨道">
          <div className="clip-timeline__sequence-title"><strong>视频轨道</strong><output>{clips.length} 段 · {Number.isFinite(total) ? formatTime(total) : "时间待修正"}</output><button type="button" disabled={loading || running || sending} onClick={() => { void importProject(); }}>导入剪辑工程</button></div>
          <ol>{clips.map((clip, index) => <li key={index} className={index === selected ? "is-selected" : ""}>
            <button type="button" aria-pressed={index === selected} onClick={() => { setSelected(index); setPlayhead(clip.start); if (videoRef.current && JSON.stringify(clip.target) === targetToken) { videoRef.current.currentTime = clip.start; videoRef.current.volume = Math.min(1, Math.max(0, clip.volume)); } }}><span>{index + 1}. {clip.name}</span><small>{formatTime(clip.start)}—{formatTime(clip.end)} {clip.caption ? "· 字幕" : ""}</small></button>
            <div><button type="button" aria-label={`前移片段${index + 1}`} disabled={index === 0 || running || sending} onClick={() => { const next = [...clips]; [next[index - 1], next[index]] = [next[index]!, next[index - 1]!]; change(next, index - 1); }}>←</button><button type="button" aria-label={`后移片段${index + 1}`} disabled={index === clips.length - 1 || running || sending} onClick={() => { const next = [...clips]; [next[index], next[index + 1]] = [next[index + 1]!, next[index]!]; change(next, index + 1); }}>→</button></div>
          </li>)}</ol>
        </section>
        {error ? <ErrorAlert error={error} hint="调整片段后重试。回执不明确时先重新读取任务记录，避免重复规划计费。" /> : null}
        {readError ? <ErrorAlert error={readError} label="读取剪辑记录失败" hint="重新读取仅查询原任务，不会提交新的剪辑或产生规划费用。" /> : null}
        <button type="button" onClick={onRefresh}>重新读取任务记录</button>
        {job ? <section className="clip-timeline__job" aria-live="polite"><strong>{CLIP_JOB_LABEL[job.status]} · {Math.round(job.progress)}%{job.durationSeconds != null ? ` · 实际 ${job.durationSeconds.toFixed(2)} 秒` : ""}</strong>
          {clipJobActive(job) ? <button type="button" onClick={() => { void onCancelJob(job.id).catch((failure: unknown) => setError(failure)); }}>取消剪辑</button> : null}
          {job.error && <ErrorAlert error={job.error} hint="原任务和诊断保留在历史中；手动导出不会重复调用文本模型。" />}
          {job.status === "completed" ? <div className="clip-timeline__actions">
            <button type="button" onClick={() => { if (job.outputPath) void exportFile(job.outputPath, `${name}.mp4`); }}>导出 MP4</button>
            <button type="button" onClick={() => { if (job.subtitlePath) void exportFile(job.subtitlePath, `${name}.srt`); }}>导出字幕</button>
            <button type="button" onClick={() => { if (job.projectPath) void exportFile(job.projectPath, `${name}.timeline.json`); }}>导出剪辑工程</button>
            <button type="button" onClick={() => { if (job.outputPath) void revealDesktopItem(job.outputPath).catch((failure: unknown) => setError(failure)); }}>打开文件位置</button>
            <button type="button" onClick={() => change(job.clips)}>载入这次剪辑方案</button>
          </div> : null}
        </section> : null}
      </div>
      <footer><span>{loading ? "正在读取素材…" : "智能编排使用中点抽帧与文本模型；手动导出在本机完成"}</span><button type="button" disabled={loading || running || sending || !clips.length} onClick={() => { void render(false); }}>按当前轨道导出</button><button type="button" disabled={loading || running || sending || !clips.length} onClick={() => { void render(true); }}>{sending ? "正在提交…" : "智能剪辑并导出"}</button></footer>
    </dialog>, document.body,
  );
}
