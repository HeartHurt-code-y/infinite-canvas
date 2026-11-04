import { useCallback, useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import * as v from "valibot";
import { CanvasSelect } from "../../components/CanvasSelect";
import { ErrorAlert } from "../../components/ErrorAlert";
import { useEscapeHandler } from "../../components/escapeArbiter";
import type { ProviderCatalogEntry } from "../../lib/backend";
import { localBase64AssetRecordSchema } from "../../lib/backendSchemas";
import { invokeDesktop } from "../../lib/ipc";
import { toast } from "../../lib/toast";
import { useCanvasCommands, useCanvasStore } from "../canvas/canvasStore";
import { CanvasAudioWaveform } from "./CanvasAudioWaveform";
import type { CanvasInlineFeatureRequest } from "./canvasFeatureCatalog";
import { findCanvasLocalEditSource, type CanvasLocalEditSource } from "./canvasDerivedImage";
import { LibTVMediaIcon } from "./LibTVMediaIcon";
import { parseAudioSplit, proposeAudioCuts, type AudioRange } from "./audioSplitPlan";
import { assetNodeDimensions, assetNodeKey, genNodeDimensions, nearestAvailableNodePosition,
  NEW_NODE_GAP, outputNodeDimensions, type AssetNodeData } from "./workspaceModel";

const SPEED_STEPS = [0.1, 0.5, 1, 1.5, 2, 3, 4] as const;
const waveSchema = v.object({ peaks: v.array(v.number()), onsets: v.array(v.number()) });
const timingSchema = v.variant("status", [
  v.object({ status: v.literal("idle") }),
  v.object({ status: v.literal("unknown") }),
  v.object({ status: v.literal("pending"), id: v.string() }),
  v.object({ status: v.literal("ready"), words: v.array(v.object({ text: v.string(), start: v.number(), end: v.number() })) }),
  v.object({ status: v.literal("failed"), message: v.string() }),
]);
type Timing = v.InferOutput<typeof timingSchema>;
type Edit = ({ mode: "trim" } & AudioRange) | { mode: "speed"; rate: number } | { mode: "custom" | "smart" };
const EDIT_LABEL = { trim: "裁剪音频", speed: "音频变速", smart: "智能切分", custom: "自定义切分" } as const;

export function CanvasAudioResultEdit({ nodeKey, output, duration, playerRef, providerCatalog, exporting, onDownload, onOpen, featureRequest }: {
  readonly featureRequest?: CanvasInlineFeatureRequest | undefined;
  readonly nodeKey: string;
  readonly output: CanvasLocalEditSource | null;
  readonly duration: number | null;
  readonly playerRef: RefObject<HTMLAudioElement | null>;
  readonly providerCatalog: readonly ProviderCatalogEntry[];
  readonly exporting: boolean;
  readonly onDownload?: (() => void) | undefined;
  readonly onOpen?: (() => void) | undefined;
}) {
  const store = useCanvasStore();
  const commands = useCanvasCommands();
  const [edit, setEdit] = useState<Edit | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [description, setDescription] = useState("");
  const [cutDraft, setCutDraft] = useState<string | null>(null);
  const [wave, setWave] = useState<v.InferOutput<typeof waveSchema> | null>(null);
  const [waveError, setWaveError] = useState<unknown>(null);
  const [providerId, setProviderId] = useState("");
  const [timing, setTiming] = useState<{ providerId: string; receipt: Timing } | null>(null);
  const [timingBusy, setTimingBusy] = useState(false);
  const [timingError, setTimingError] = useState<unknown>(null);
  const [lookupVersion, setLookupVersion] = useState(0);
  const errorId = useId();
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const pending = useRef<AbortController | null>(null);
  const submittingTiming = useRef(false);
  const sourcePath = output?.finalPath ?? null;
  const providers = providerCatalog.filter(entry => entry.provider.enabled && entry.provider.adapterId === "atlascloud_v1");
  const provider = providers.find(entry => entry.provider.id === providerId) ?? providers[0];
  const selectedProviderId = provider?.provider.id ?? "";
  const receipt = timing?.providerId === selectedProviderId ? timing.receipt : null;

  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => {
    if (!sourcePath) return;
    let current = true;
    void invokeDesktop("read_canvas_audio_waveform", waveSchema, { path: sourcePath }).then(
      result => { if (current) setWave(result); },
      failure => { if (current) setWaveError(failure); },
    );
    return () => { current = false; };
  }, [sourcePath]);
  const rate = edit?.mode === "speed" ? edit.rate : 1;
  useEffect(() => {
    const audio = playerRef.current;
    if (!audio || rate === 1) return;
    const previous = audio.playbackRate;
    audio.playbackRate = rate;
    return () => { audio.playbackRate = previous; };
  }, [playerRef, rate]);
  const trimStart = edit?.mode === "trim" ? edit.start : null;
  const trimEnd = edit?.mode === "trim" ? edit.end : null;
  useEffect(() => {
    const audio = playerRef.current;
    if (!audio || trimStart == null || trimEnd == null) return;
    const startPreview = () => {
      if (audio.currentTime < trimStart || audio.currentTime >= trimEnd) audio.currentTime = trimStart;
    };
    const stopPreview = () => {
      if (!audio.paused && audio.currentTime >= trimEnd) {
        audio.pause();
        audio.currentTime = trimEnd;
      }
    };
    audio.addEventListener("play", startPreview);
    audio.addEventListener("timeupdate", stopPreview);
    return () => {
      audio.removeEventListener("play", startPreview);
      audio.removeEventListener("timeupdate", stopPreview);
    };
  }, [playerRef, trimEnd, trimStart]);
  const mode = edit?.mode;
  useEffect(() => {
    if (!mode) return;
    const focus = mode === "trim" ? root.current?.querySelector<HTMLElement>("[role=slider]") :
      panel.current?.querySelector<HTMLElement>("textarea, input, button:not(:disabled)");
    focus?.focus({ preventScroll: true });
    const dismiss = (event: PointerEvent) => {
      if (pending.current || !(event.target instanceof Element) || root.current?.contains(event.target) ||
          event.target.closest(".canvas-select__menu")) return;
      setEdit(null);
      setError(null);
    };
    document.addEventListener("pointerdown", dismiss, true);
    return () => document.removeEventListener("pointerdown", dismiss, true);
  }, [mode]);
  useEffect(() => {
    if (mode !== "smart" || !sourcePath || !selectedProviderId || timingBusy) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const result = await invokeDesktop("read_canvas_audio_timing", timingSchema, { path: sourcePath, providerId: selectedProviderId });
        if (disposed) return;
        setTiming({ providerId: selectedProviderId, receipt: result });
        if (result.status === "pending") timer = setTimeout(() => { void read(); }, 3000);
      } catch (failure) {
        if (!disposed) setTimingError(failure);
      }
    };
    void read();
    return () => { disposed = true; clearTimeout(timer); };
  }, [mode, sourcePath, selectedProviderId, timingBusy, lookupVersion]);
  const close = () => { if (!pending.current) { setEdit(null); setError(null); } };
  useEscapeHandler({ canHandle: () => !pending.current, handle: close }, edit != null);
  const open = useCallback((draft: Edit) => {
    if (pending.current) return;
    onOpen?.();
    setEdit(draft);
    setError(null);
  }, [onOpen]);
  useEffect(() => {
    if (featureRequest?.action.kind !== "audio") return;
    if (featureRequest.sourcePath !== sourcePath) {
      featureRequest.onHandled();
      return;
    }
    const { mode } = featureRequest.action;
    if (mode === "trim" && duration == null) return;
    featureRequest.onHandled();
    if (mode === "trim") {
      if (duration == null || duration <= 0.5) {
        toast.error("裁剪需要时长超过 0.5 秒的音频。");
        return;
      }
      open({ mode, start: 0, end: duration });
    } else if (mode === "speed") open({ mode, rate: 1 });
    else open({ mode });
  }, [duration, featureRequest, open, sourcePath]);

  const propose = useMemo(() => receipt?.status === "ready" && duration != null
    ? proposeAudioCuts(receipt.words, wave?.onsets ?? [], duration).map(point => point.toFixed(2)).join("、") : "",
    [receipt, wave, duration]);
  const editableCuts = cutDraft ?? propose;
  const splitPlan = useMemo(() => duration != null ? (
    mode === "custom" ? parseAudioSplit(description, duration) :
      mode === "smart" && receipt?.status === "ready" ? parseAudioSplit("在" + editableCuts + "切开", duration) : null
  ) : null, [description, duration, editableCuts, mode, receipt?.status]);
  const cutPoints = useMemo(() => Array.from(new Set((splitPlan?.flat() ?? [])
    .flatMap(range => [range.start, range.end]).filter(point => point > 0 && point < (duration ?? 0)))), [splitPlan, duration]);

  const recognize = async () => {
    if (!sourcePath || !selectedProviderId || receipt?.status !== "idle" || submittingTiming.current) return;
    submittingTiming.current = true;
    setTimingBusy(true);
    setTimingError(null);
    try {
      const result = await invokeDesktop("start_canvas_audio_timing", timingSchema, { path: sourcePath, providerId: selectedProviderId });
      setTiming({ providerId: selectedProviderId, receipt: result });
    } catch (failure) {
      setTimingError(failure);
    } finally {
      submittingTiming.current = false;
      setTimingBusy(false);
    }
  };

  const unchanged = edit?.mode === "trim" ? edit.start === 0 && edit.end === duration :
    edit?.mode === "speed" ? rate === 1 : !splitPlan;
  const submit = async () => {
    if (!edit || !output || !sourcePath || pending.current || unchanged) return;
    const controller = new AbortController();
    pending.current = controller;
    setSaving(true);
    setError(null);
    const originalName = output.name?.trim().replace(/\.[a-z0-9]+$/i, "") || "音频";
    const name = originalName + (edit.mode === "trim" ? "_裁剪" : edit.mode === "speed" ? "_" + edit.rate + "x" : "_切分");
    try {
      const records = edit.mode === "trim" || edit.mode === "speed" ? [
        await invokeDesktop("edit_canvas_audio", localBase64AssetRecordSchema, { path: sourcePath, name: name + ".wav", operation: edit }),
      ] : await invokeDesktop("split_canvas_audio", v.array(localBase64AssetRecordSchema), { path: sourcePath, name, clips: splitPlan });
      controller.signal.throwIfAborted();
      const live = findCanvasLocalEditSource(store, nodeKey, output);
      if (!live) {
        throw new Error("来源已变化，编辑后的音频已保存在素材库。");
      }
      const { state, source, owner } = live;
      const rectangles = Object.values(state.nodesById).map(entry => ({
        x: entry.data.x, y: entry.data.y,
        ...(entry.type === "gen" ? entry.data.measured ?? genNodeDimensions(entry.data.kind) :
          entry.type === "asset" ? assetNodeDimensions(entry.data) :
            entry.type === "output" ? outputNodeDimensions(entry.data) : { width: 622, height: 400 }),
      }));
      const sourceWidth = (owner.type === "asset" ? assetNodeDimensions(owner.data) :
        owner.type === "output" ? outputNodeDimensions(owner.data) :
          owner.data.measured ?? genNodeDimensions("audio")).width;
      let nextY = owner.data.y;
      const assets = records.map((record, index) => {
        const asset: AssetNodeData = {
          key: assetNodeKey(), assetId: record.id, providerConnectionId: "", source: "local", kind: "audio",
          name: records.length === 1 ? name : name + "_" + String(index + 1).padStart(2, "0"),
          previewUrl: record.previewUrl, videoUrl: null, x: 0, y: 0,
        };
        const size = assetNodeDimensions(asset);
        const position = nearestAvailableNodePosition({ x: owner.data.x + sourceWidth + NEW_NODE_GAP, y: nextY, ...size }, rectangles);
        rectangles.push({ ...position, ...size });
        nextY = position.y + size.height + NEW_NODE_GAP;
        return { ...asset, x: position.x, y: position.y };
      });
      const fromKey = source.data.key;
      if (!assets.length || commands.insertSubgraph(assets.map(data => ({ type: "asset", data })), assets.map(asset => ({
        id: fromKey + "->" + asset.key, fromKey, toKey: asset.key,
      })), { selectNodeKey: assets[0]!.key }) !== "applied") {
        throw new Error("音频已保存在素材库，请从素材库添加到画布。");
      }
      setEdit(null);
      toast.success(records.length > 1 ? "已保存 " + records.length + " 个音频片段" : "编辑后的音频已保存");
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure);
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) setSaving(false);
    }
  };

  return (
    <div className="canvas-audio-result nodrag nopan" ref={root} onPointerDown={event => event.stopPropagation()}
      onMouseDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
      <CanvasAudioWaveform playerRef={playerRef} duration={duration} peaks={wave?.peaks ?? []}
        loading={Boolean(sourcePath && !wave && !waveError)} waveError={waveError} cutPoints={cutPoints}
        trim={edit?.mode === "trim" ? { range: edit, disabled: saving, onChange: range => setEdit({ mode: "trim", ...range }) } : null} />
      {!sourcePath ? null : edit ? (
        <div ref={panel} className="canvas-audio-result-edit__panel" role="group" aria-label={EDIT_LABEL[edit.mode]}>
          {edit.mode === "trim" ? <p className="canvas-audio-result-edit__range">{edit.start.toFixed(2)} – {edit.end.toFixed(2)} 秒</p> : null}
          {edit.mode === "speed" ? <>
            <label>变速 <input type="range" min={0.1} max={4} step={0.01} value={edit.rate}
              disabled={saving} onChange={event => setEdit({ mode: "speed", rate: event.target.valueAsNumber })} />
              <output>{edit.rate.toFixed(2)}×</output></label>
            <div className="canvas-audio-result-edit__speeds">{SPEED_STEPS.map(step => (
              <button key={step} type="button" aria-pressed={edit.rate === step} disabled={saving}
                onClick={() => setEdit({ mode: "speed", rate: step })}>{step}×</button>
            ))}</div>
          </> : null}
          {edit.mode === "custom" ? (
            <textarea aria-label="切分要求" rows={3} value={description} disabled={saving} maxLength={500}
              placeholder="例如：截取0-2秒、删除10-15秒、在第5秒和第12秒处切开"
              onChange={event => setDescription(event.currentTarget.value)} />
          ) : null}
          {edit.mode === "smart" ? <>
            {provider ? <CanvasSelect ariaLabel="识别供应商" value={selectedProviderId} disabled={timingBusy || saving}
              options={providers.map(entry => ({ value: entry.provider.id, label: entry.provider.displayName + " · Seed ASR 2.0" }))}
              chevronIcon={<LibTVMediaIcon name="icon-chevron-down-small" size={12} />}
              onChange={id => { setProviderId(id); setCutDraft(null); setTimingError(null); }} /> : <p>启用 Atlas Cloud 连接后可识别歌词和语句。</p>}
            {receipt?.status === "idle" && provider ? (
              <button type="button" disabled={timingBusy || !duration || duration < 0.5 || duration > 1800} onClick={() => void recognize()}>
                {timingBusy ? "正在提交…" : "开始识别（供应商计费）"}
              </button>
            ) : null}
            {duration != null && (duration < 0.5 || duration > 1800) ? <p>智能切分支持 0.5 秒至 30 分钟的音频。</p> : null}
            {receipt?.status === "pending" ? <p role="status">正在识别歌词和语句…</p> : null}
            {receipt?.status === "unknown" ? <p role="status">提交回执待确认，请先到 Atlas Cloud 核对任务。</p> : null}
            {receipt?.status === "ready" ? <>
              <textarea aria-label="建议切点（秒）" rows={2} disabled={saving} value={editableCuts}
                placeholder="未找到建议切点，可输入秒数，例如 5、12"
                onChange={event => setCutDraft(event.currentTarget.value)} />
              <small>点波形上的标记可试听。导出前可调整切点。</small>
            </> : null}
            {receipt?.status === "failed" || timingError != null ? (
              <ErrorAlert error={timingError ?? (receipt?.status === "failed" ? receipt.message : null)}
                variant="inline" hint="可检查供应商任务，或改用自定义切分。" />
            ) : null}
            {timingError != null ? <button type="button" onClick={() => {
              setTimingError(null);
              setLookupVersion(value => value + 1);
            }}>重新查询</button> : null}
          </> : null}
          {splitPlan ? <p role="status">将导出 {splitPlan.length} 个音频片段</p> : null}
          {edit.mode === "custom" && description.trim() && !splitPlan ? <small>请输入音频内的有效时间或区间，支持秒和分:秒。</small> : null}
          <div className="canvas-audio-result-edit__confirm">
            <button type="button" aria-label="取消" data-tooltip="取消" disabled={saving} onClick={close}>
              <LibTVMediaIcon name="close" size={14} />
            </button>
            <button type="button" aria-label="确认" data-tooltip="保存为新音频" disabled={saving || unchanged}
              aria-describedby={error != null ? errorId : undefined} onClick={() => void submit()}>
              <LibTVMediaIcon name={saving ? "icon-loading" : "check"} size={14} className={saving ? "spin-icon" : ""} />
            </button>
          </div>
          {error != null ? <ErrorAlert id={errorId} error={error} variant="inline" hint="请检查源音频和选中的时间区间。" /> : null}
        </div>
      ) : (
        <div className="canvas-audio-result-edit__actions" role="group" aria-label="音频工具">
          <button type="button" aria-label="裁剪音频" data-tooltip="裁剪音频" disabled={duration == null || duration <= 0.5}
            onClick={() => duration != null && open({ mode: "trim", start: 0, end: duration })}>
            <LibTVMediaIcon name="cut" size={16} />
          </button>
          <button type="button" aria-label="音频变速" data-tooltip="音频变速" disabled={duration == null}
            onClick={() => open({ mode: "speed", rate: 1 })}><LibTVMediaIcon name="clip-speed-gauge" size={16} /></button>
          <button type="button" aria-label="智能切分" data-tooltip="按歌词或语句识别切点"
            disabled={duration == null} onClick={() => open({ mode: "smart" })}><LibTVMediaIcon name="smart-split" size={16} /></button>
          <button type="button" aria-label="自定义切分" data-tooltip="自定义切分"
            disabled={duration == null} onClick={() => open({ mode: "custom" })}><LibTVMediaIcon name="audio-custom-split" size={16} /></button>
          {onDownload ? <button type="button" aria-label="下载音频" data-tooltip="下载音频" disabled={exporting} onClick={onDownload}>
            <LibTVMediaIcon name={exporting ? "icon-loading" : "download"} size={16} className={exporting ? "spin-icon" : ""} />
          </button> : null}
        </div>
      )}
    </div>
  );
}
