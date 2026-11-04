import { useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CanvasSelect } from "../../components/CanvasSelect";
import { useModalFocusTrap } from "../../components/useModalFocusTrap";
import type { PromptContentEditorSession, PromptContentDocumentV1 } from "../../lib/promptContent";
import type { ModelParameterCapability } from "../../lib/modelCapabilities";
import type { CanvasVideoMode } from "../../lib/canvasVideoMode";
import { videoCameraPresetsMuted, videoPromptForMode } from "../../lib/videoCameraPresets";
import { emptyStoryboardDocument, storyboardIssue, storyboardPromptIssue, storyboardPromptText, type VideoStoryboardConfig, type VideoStoryboardShot } from "../../lib/videoStoryboard";
import { PromptMentionInput } from "./PromptNodeViews";
import { LibTVMediaIcon } from "./LibTVMediaIcon";
import { generationInputMentionCandidate, type ConnectedAssetInput, type InheritedAssetInput } from "./workspaceModel";
import "./VideoStoryboardPanel.css";

export function VideoStoryboardPanel({ initial, document: sourceDocument, totalSeconds, durationCapability, unavailableReason, mode, inputs, onSave, onClose }: {
  readonly initial?: VideoStoryboardConfig | undefined;
  readonly document: PromptContentDocumentV1;
  readonly totalSeconds: number;
  readonly durationCapability?: ModelParameterCapability | undefined;
  readonly unavailableReason?: string | null | undefined;
  readonly mode?: CanvasVideoMode | undefined;
  readonly inputs: readonly (ConnectedAssetInput | InheritedAssetInput)[];
  readonly onSave: (config: VideoStoryboardConfig, totalSeconds: number) => void;
  readonly onClose: () => void;
}) {
  const [duration, setDuration] = useState(totalSeconds);
  const [shots, setShots] = useState<readonly VideoStoryboardShot[]>(() => initial?.shots.length ? initial.shots : [{ id: crypto.randomUUID(), duration: totalSeconds, document: emptyStoryboardDocument() }]);
  const sessions = useRef(new Map<string, PromptContentEditorSession>());
  const documents = useRef(new Map(shots.map(shot => [shot.id, shot.document])));
  const [enabled, setEnabled] = useState(initial?.enabled ?? false);
  const [dirty, setDirty] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const requestClose = useCallback(() => dirty ? setDiscard(true) : onClose(), [dirty, onClose]);
  const trap = useModalFocusTrap({ active: true, onEscape: requestClose });
  const register = useCallback((key: string, session: PromptContentEditorSession | null) => {
    const old = sessions.current.get(key);
    if (old === session) return;
    if (old) documents.current.set(key, old.snapshot());
    if (session) { session.restore(documents.current.get(key) ?? emptyStoryboardDocument()); sessions.current.set(key, session); }
    else sessions.current.delete(key);
  }, []);
  const snapshot = (shot: VideoStoryboardShot) => sessions.current.get(shot.id)?.snapshot() ?? documents.current.get(shot.id) ?? shot.document;
  const changed = () => { setDirty(true); setSaveError(null); };
  const candidates = inputs.filter(input => input.target).map(input => generationInputMentionCandidate({ key: input.key, name: input.name, kind: input.kind, target: input.target!, previewUrl: input.previewUrl }));
  const durationMin = Math.max(3, Math.ceil(durationCapability?.minimum ?? 3));
  const durationMax = Math.min(15, Math.floor(durationCapability?.maximum ?? 15));
  const advertisedDurations = (durationCapability?.options ?? []).map(option => Number(option.value)).filter(value => Number.isInteger(value) && value >= durationMin && value <= durationMax);
  const durations = advertisedDurations.length ? advertisedDurations : Array.from({ length: Math.max(0, durationMax - durationMin + 1) }, (_, index) => durationMin + index);
  const issue = enabled ? unavailableReason || storyboardIssue({ enabled, shots }, duration) : null;
  const sum = shots.reduce((total, shot) => total + shot.duration, 0);
  const durationMismatch = enabled && sum !== duration;
  const editable = enabled && !unavailableReason;
  const toggle = (next: boolean) => {
    if (next && unavailableReason) return;
    const frozen = shots.map(shot => ({ ...shot, document: snapshot(shot) }));
    // 原站开启单镜头分镜时沿用外层正文；canonical 素材身份一并保留。
    const nextShots = next && frozen.length === 1 ? [{ ...frozen[0]!, duration, document: sourceDocument }] : frozen;
    for (const shot of nextShots) documents.current.set(shot.id, shot.document);
    setShots(nextShots); setEnabled(next); setErrors({}); changed();
  };
  const clear = () => {
    const shot = { id: crypto.randomUUID(), duration, document: emptyStoryboardDocument() };
    documents.current.set(shot.id, shot.document);
    setShots([shot]); setErrors({}); changed();
  };
  const save = () => {
    const next = shots.map(shot => ({ ...shot, document: snapshot(shot) }));
    const nextErrors: Record<string, string> = {};
    if (enabled) for (const shot of next) {
      const message = storyboardPromptIssue(storyboardPromptText(videoPromptForMode(shot.document, mode)));
      if (message) nextErrors[shot.id] = message;
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length || issue) { setSaveError(issue); setDiscard(false); return; }
    // 切到不支持分镜的模型后，仍必须允许关闭历史分镜，不能被旧时长挡住。
    if (enabled && !durations.includes(duration)) { setSaveError("请选择当前模型支持的视频总时长。"); setDiscard(false); return; }
    onSave({ enabled, shots: next }, duration); onClose();
  };
  return <>
    {createPortal(<div className="canvas-video-modal-scrim"><div ref={trap.ref} {...trap.containerProps} className="canvas-video-modal canvas-video-storyboard" role="dialog" aria-modal="true" aria-label="智能分镜" tabIndex={-1}>
      <header>
        <label className="canvas-video-storyboard__toggle"><strong>智能分镜</strong><input type="checkbox" role="switch" aria-label="启用智能分镜" checked={enabled} disabled={!!unavailableReason && !enabled} onChange={event => toggle(event.target.checked)} /></label>
        <button type="button" aria-label="关闭智能分镜" onClick={requestClose}><LibTVMediaIcon name="close" size={14} /></button>
      </header>
      <div className="canvas-video-storyboard__shots" data-video-camera-muted={videoCameraPresetsMuted(mode) ? "true" : undefined}>
        {unavailableReason ? <p role="status" className="canvas-video-storyboard__notice">{unavailableReason}。可关闭智能分镜后保存。</p> : null}
        {shots.map((shot, index) => <section key={shot.id}>
          <header>
            <strong id={"shot-title-" + shot.id}>镜头 {index + 1}</strong>
            {enabled ? <label className="canvas-video-storyboard__duration" data-invalid={durationMismatch || !Number.isInteger(shot.duration) || shot.duration < 1 ? "true" : undefined}>
              <input aria-label={"镜头 " + (index + 1) + " 时长"} type="number" min={1} step={1} disabled={!editable} value={shot.duration || ""} onChange={event => { setShots(items => items.map(item => item.id === shot.id ? { ...item, duration: Number(event.target.value) } : item)); changed(); }} /><span>s</span>
            </label> : null}
            {errors[shot.id] ? <span role="alert" className="canvas-video-storyboard__shot-error">{errors[shot.id]}</span> : null}
            {editable && shots.length > 1 ? <button type="button" aria-label={"删除镜头 " + (index + 1)} onClick={() => { setShots(items => items.filter(item => item.id !== shot.id)); changed(); }}><LibTVMediaIcon name="trash" size={16} /></button> : null}
          </header>
          {editable ? <div className="canvas-video-storyboard__prompt" data-invalid={errors[shot.id] ? "true" : undefined}><PromptMentionInput nodeKey={shot.id} candidates={candidates} registerInput={register} labelledBy={"shot-title-" + shot.id} expandable={false} placeholder="描述这个镜头的画面、动作与运镜，输入 @ 引用素材" onTextChange={() => { changed(); setErrors(current => { if (!current[shot.id]) return current; const next = { ...current }; delete next[shot.id]; return next; }); }} /></div>
            : <textarea aria-labelledby={"shot-title-" + shot.id} disabled readOnly value={storyboardPromptText(snapshot(shot))} placeholder="描述这个镜头的画面、动作与运镜" />}
        </section>)}
        {editable && shots.length < 6 ? <button type="button" className="canvas-video-storyboard__add" onClick={() => { const shot = { id: crypto.randomUUID(), duration: 2, document: emptyStoryboardDocument() }; documents.current.set(shot.id, shot.document); setShots(items => [...items, shot]); changed(); }}><LibTVMediaIcon name="plus-s" size={12} />镜头</button> : null}
      </div>
      {saveError ? <p role="alert" className="canvas-video-storyboard__notice">{saveError}</p> : null}
      <footer>
        <button type="button" className="canvas-video-storyboard__clear" onClick={clear}><LibTVMediaIcon name="trash" size={16} />清空所有镜头</button>
        <div className="canvas-video-storyboard__total" data-invalid={durationMismatch ? "true" : undefined}>
          <span>{durationMismatch ? (sum > duration ? "总时长超出" : "总时长不足") : "总时长"}</span>
          <CanvasSelect ariaLabel="视频总时长" value={String(duration)} options={durations.map(value => ({ value: String(value), label: value + "s" }))} disabled={!!unavailableReason} onChange={value => { setDuration(Number(value)); changed(); }} />
        </div>
        <button type="button" onClick={requestClose}>取消</button><button type="button" className="canvas-video-storyboard__save" onClick={save}>保存</button>
      </footer>
    </div></div>, document.body)}
    {discard ? <DiscardStoryboard onContinue={() => setDiscard(false)} onDiscard={onClose} onSave={save} /> : null}
  </>;
}

function DiscardStoryboard({ onContinue, onDiscard, onSave }: { readonly onContinue: () => void; readonly onDiscard: () => void; readonly onSave: () => void }) {
  const trap = useModalFocusTrap({ active: true, onEscape: onContinue });
  return createPortal(<div className="canvas-video-modal-scrim"><div ref={trap.ref} {...trap.containerProps} className="canvas-video-storyboard-discard" role="alertdialog" aria-modal="true" aria-label="放弃分镜修改" tabIndex={-1}>
    <strong>有未保存的分镜</strong><p>是否放弃本次修改？</p><div><button type="button" onClick={onContinue}>继续编辑</button><button type="button" onClick={onDiscard}>放弃修改</button><button type="button" onClick={onSave}>保存</button></div>
  </div></div>, document.body);
}
