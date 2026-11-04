import { useEffect, useMemo, useRef, useState } from "react";
import { CanvasSelect } from "../../components/CanvasSelect";
import { ErrorAlert } from "../../components/ErrorAlert";
import { generationClient, isDesktopRuntime, toMediaSrc, type GenerationTaskProgress, type ProviderCatalogEntry } from "../../lib/backend";
import { toMediaProxyUrl } from "../../lib/mediaProxy";
import { modelParameterCapabilities, resolvedParameterValue, type ModelParameterValue } from "../../lib/modelCapabilities";
import { isImageGenerationModel, isVideoGenerationModel, type ScreenplayNodeData } from "./workspaceModel";
import type { ScriptBatchFrame, ScriptBatchKind, ScriptBatchStartRequest } from "./scriptGeneratorModel";
import type { StoryboardFilmSource } from "./storyboardProject";

const ACTIVE_STATUSES = new Set(["created", "submitting", "retry_wait", "queued", "running"]);
const STATUS_LABELS: Readonly<Record<string, string>> = {
  created: "已创建", submitting: "正在提交", retry_wait: "等待重试", queued: "排队中", running: "生成中",
  succeeded: "已完成", failed: "失败", unknown: "状态待核对", interrupted: "已中断", cancelled: "已取消",
};

function frameKey(frame: ScriptBatchFrame): string {
  return frame.kind === "canvas" ? `node:${frame.sourceKey}` : `result:${frame.taskId}#${frame.resultIndex}`;
}

export function ScriptBatchPanel({ canvasId, node, active, running, providerCatalog, connectedMedia, onUpdate, onStart, onResume, onFilm }: {
  readonly canvasId: string;
  readonly node: ScreenplayNodeData;
  readonly active: boolean;
  readonly running: boolean;
  readonly providerCatalog: readonly ProviderCatalogEntry[];
  readonly connectedMedia: readonly { sourceKey: string; name: string; kind: string }[];
  readonly onUpdate: (update: (config: ScreenplayNodeData["config"]) => ScreenplayNodeData["config"]) => void;
  readonly onStart: (key: string, request: ScriptBatchStartRequest) => void;
  readonly onResume: (key: string, batchId: string) => void;
  readonly onFilm?: (sources: readonly StoryboardFilmSource[]) => Promise<void>;
}) {
  const state = node.config.scriptGenerator;
  const batches = useMemo(() => state?.batches ?? [], [state?.batches]);
  const [kind, setKind] = useState<ScriptBatchKind>("image");
  const [selectedModelByKind, setSelectedModelByKind] = useState<Record<ScriptBatchKind, string>>({ image: "", video: "" });
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(() => new Set());
  const [paramsByModel, setParamsByModel] = useState<Record<string, Record<string, ModelParameterValue>>>({});
  const [useFrames, setUseFrames] = useState(true);
  const [useShotDuration, setUseShotDuration] = useState(true);
  const [details, setDetails] = useState<Record<string, GenerationTaskProgress>>({});
  const [loadError, setLoadError] = useState<unknown>(null);
  const [reload, setReload] = useState(0);
  const [approval, setApproval] = useState<string | null>(null);
  const [filmChoices, setFilmChoices] = useState<Readonly<Record<string, string>>>({});
  const [filmError, setFilmError] = useState<unknown>(null);
  const [openingFilm, setOpeningFilm] = useState(false);
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;
  const batchIdentity = JSON.stringify(batches.map((batch) => ({ id: batch.id, kind: batch.kind,
    providerId: batch.providerId, modelDefinitionId: batch.modelDefinitionId,
    items: batch.items.map((item) => ({ id: item.id, nodeKey: item.nodeKey, taskId: item.taskId, phase: item.phase })) })));

  useEffect(() => {
    if (!active || !isDesktopRuntime()) return;
    const tasks = batches.flatMap((batch) => batch.items
      .filter((item) => item.phase === "submitting" || item.phase === "submitted" || item.phase === "uncertain")
      .map((item) => ({ batch, item })));
    if (!tasks.length) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      /*
       * 轮询只走状态轻量接口（`get_progress`）：这个循环每 5 秒跑一轮，
       * 每轮都要读全部批次项的任务。详情接口会把每次供应商调用的请求/响应
       * 原样搬回前端（单个任务可达数 MB），批量轮询时会把 UI 线程堆满，
       * 表现就是「生成时界面卡住、按钮点不动」。
       * 这里只需要状态、错误与产物落盘信息，`get_progress` 已经带全。
       */
      const results = await Promise.allSettled(tasks.map(({ item }) => generationClient.getProgress(item.taskId)));
      if (cancelled) return;
      const next: Record<string, GenerationTaskProgress> = {};
      const recovered: { batchId: string; itemId: string }[] = [];
      let incomplete = false;
      let failure: unknown = null;
      results.forEach((result, index) => {
        const entry = tasks[index]!;
        if (result.status === "rejected") {
          // 提交回执缺失时查不到任务是待核对状态，不能据此新建另一笔任务。
          if (entry.item.phase === "submitted") failure ??= result.reason;
          if (entry.item.phase !== "submitted") incomplete = true;
          return;
        }
        const detail = result.value;
        const summary = detail.summary;
        if (summary.id !== entry.item.taskId || summary.canvasId !== canvasId ||
          summary.sourceNodeId !== entry.item.nodeKey || summary.providerConnectionId !== entry.batch.providerId ||
          summary.modelDefinitionId !== entry.batch.modelDefinitionId ||
          (entry.batch.kind === "video" ? summary.operation !== "video_generation" :
            summary.operation !== "text_to_image" && summary.operation !== "image_to_image")) {
          failure ??= new Error("任务身份与批次记录不一致，请在任务历史中核对。");
          return;
        }
        next[summary.id] = detail;
        if (entry.item.phase !== "submitted") recovered.push({ batchId: entry.batch.id, itemId: entry.item.id });
        if (ACTIVE_STATUSES.has(summary.status) || detail.results.some((resultItem) =>
          resultItem.saveStatus === "pending" || resultItem.saveStatus === "writing")) incomplete = true;
      });
      setDetails((current) => ({ ...current, ...next }));
      setLoadError(failure);
      if (recovered.length) onUpdateRef.current((config) => {
        if (!config.scriptGenerator) return config;
        return { ...config, scriptGenerator: { ...config.scriptGenerator, batches: (config.scriptGenerator.batches ?? []).map((batch) => ({
          ...batch, items: batch.items.map((item) => recovered.some((entry) => entry.batchId === batch.id && entry.itemId === item.id)
            ? { ...item, phase: "submitted" as const, error: null } : item),
        })) } };
      });
      if (incomplete) timer = setTimeout(() => { void read(); }, 5000);
    };
    void read();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
    // batchIdentity freezes the identity and phase used by this polling pass.
  }, [active, canvasId, batchIdentity, reload]);

  const models = providerCatalog.flatMap((provider) => provider.provider.enabled ? provider.models
    .filter(kind === "image" ? isImageGenerationModel : isVideoGenerationModel)
    .map((model) => ({ provider, model, value: JSON.stringify([provider.provider.id, model.definitionId]) })) : []);
  const chosenModel = models.find((entry) => entry.value === selectedModelByKind[kind]) ?? models[0];
  const chosenValue = chosenModel?.value ?? "";
  const parameters = paramsByModel[chosenValue] ?? {};
  const capabilities = chosenModel ? modelParameterCapabilities(chosenModel.model.operationSchema,
    kind === "video" ? "video_generation" : chosenModel.model.operations.includes("text_to_image") ? "text_to_image" : "image_to_image",
    chosenModel.model.remoteModelId).filter((capability) => capability.key !== "n") : [];
  const shots = state?.shots ?? [];
  const selected = shots.filter((shot) => !excluded.has(shot.id));
  const invalid = selected.filter((shot) => shot.unresolvedAssetRefs?.length ||
    (shot.assetIds ?? []).some((id) => !state?.assets.some((asset) => asset.id === id)) ||
    !(kind === "image" ? shot.imagePrompt.trim() : (shot.videoPrompt || shot.imageToVideoPrompt).trim()));
  const imageResults = batches.filter((batch) => batch.kind === "image").flatMap((batch) => batch.items.flatMap((item) => {
    const detail = details[item.taskId];
    return (detail?.results ?? []).filter((result) => result.mediaType === "image" && result.saveStatus === "succeeded" && result.finalPath)
      .map((result) => ({ shotId: item.shotId, frame: { kind: "result" as const, taskId: item.taskId, resultIndex: result.resultIndex },
        label: `分镜图 · ${new Date(batch.createdAt).toLocaleString()} · 结果 ${result.resultIndex}` }));
  }));
  const choicesFor = (shotId: string) => [
    ...imageResults.filter((candidate) => candidate.shotId === shotId),
    ...connectedMedia.filter((media) => media.kind === "image").map((media) => ({
      shotId, frame: { kind: "canvas" as const, sourceKey: media.sourceKey }, label: `画布参考图 · ${media.name}`,
    })),
  ];
  const frameFor = (shotId: string): ScriptBatchFrame | undefined => {
    const choices = choicesFor(shotId);
    const saved = state?.frameSelections?.[shotId];
    if (saved) return choices.find((choice) => frameKey(choice.frame) === frameKey(saved))?.frame;
    const generated = choices.filter((choice) => choice.frame.kind === "result");
    return generated.length === 1 ? generated[0]?.frame : undefined;
  };
  const missingFrames = kind === "video" && useFrames ? selected.filter((shot) => !frameFor(shot.id)) : [];
  const setParam = (key: string, value: ModelParameterValue) => setParamsByModel((current) => ({
    ...current, [chosenValue]: { ...(current[chosenValue] ?? {}), [key]: value },
  }));
  const pendingRequest = (): ScriptBatchStartRequest | null => {
    if (!chosenModel || !selected.length || invalid.length || missingFrames.length) return null;
    const frames: Record<string, ScriptBatchFrame> = {};
    if (kind === "video" && useFrames) for (const shot of selected) {
      const frame = frameFor(shot.id);
      if (frame) frames[shot.id] = frame;
    }
    return { kind, shotIds: selected.map(shot => shot.id), providerId: chosenModel.provider.provider.id,
      modelDefinitionId: chosenModel.model.definitionId, parameters, frames, useShotDuration };
  };
  const request = pendingRequest();
  const fingerprint = request ? JSON.stringify([request, selected, state?.assets, connectedMedia, node.config.materials]) : null;
  const confirmed = fingerprint !== null && approval === fingerprint;
  const filmRows = onFilm && kind === "video" ? selected.map(shot => {
    const shotNumber = shots.indexOf(shot) + 1;
    const choices = batches.filter(batch => batch.kind === "video").flatMap(batch =>
      batch.items.filter(item => item.shotId === shot.id && details[item.taskId]?.summary.status === "succeeded")
        .flatMap(item => (details[item.taskId]?.results ?? [])
          .filter(result => result.mediaType === "video" && result.saveStatus === "succeeded" && result.finalPath)
          .map(result => ({
            value: `${result.taskId}#${result.resultIndex}`,
            label: `${new Date(batch.createdAt).toLocaleString()} · 结果 ${result.resultIndex}`,
            source: {
              key: item.nodeKey, name: `镜头 ${shotNumber}`,
              target: { kind: "local_result", generationTaskId: result.taskId, resultIndex: result.resultIndex,
                mediaType: "video", canvasNodeKey: item.nodeKey },
            } satisfies StoryboardFilmSource,
          }))));
    const saved = filmChoices[shot.id];
    const choice = saved ? choices.find(item => item.value === saved) : choices.length === 1 ? choices[0] : undefined;
    return { shot, shotNumber, choices, choice };
  }) : [];

  return <section className="canvas-script-batch" aria-label="批量生成与结果">
    <div className="canvas-script-editor__section-head"><strong>批量生成与结果</strong><span>每个镜头对应独立任务，结果按镜头归集。</span></div>
    <div className="canvas-script-editor__actions">
      <button type="button" aria-pressed={kind === "image"} disabled={running} onClick={() => setKind("image")}>批量生图</button>
      <button type="button" aria-pressed={kind === "video"} disabled={running} onClick={() => setKind("video")}>批量生视频</button>
      <button type="button" disabled={running || !shots.length} onClick={() => setExcluded(new Set())}>全选镜头</button>
      <button type="button" disabled={running || !shots.length} onClick={() => setExcluded(new Set(shots.map((shot) => shot.id)))}>取消全选</button>
    </div>
    <CanvasSelect ariaLabel={kind === "image" ? "批量生图模型" : "批量生视频模型"} value={chosenValue}
      options={models.map((entry) => ({ value: entry.value, label: `${entry.provider.provider.displayName} · ${entry.model.displayName}` }))}
      disabled={running || !models.length} onChange={(value) => setSelectedModelByKind((current) => ({ ...current, [kind]: value }))} />
    {!models.length ? <p>请先在设置中配置可用的{kind === "image" ? "图片" : "视频"}模型。</p> : null}
    {capabilities.length ? <details><summary>模型参数</summary><div className="canvas-script-batch__parameters">
      {capabilities.map((capability) => <label key={capability.key}>{capability.label}
        {capability.options.length ? <CanvasSelect ariaLabel={capability.label} value={String(resolvedParameterValue(capability, parameters))}
          options={capability.options.map((option) => ({ value: String(option.value), label: option.label }))} disabled={running}
          onChange={(value) => { const option = capability.options.find((entry) => String(entry.value) === value); if (option) setParam(capability.key, option.value); }} />
          : capability.type === "boolean" ? <input type="checkbox" disabled={running}
              checked={Boolean(resolvedParameterValue(capability, parameters))} onChange={(event) => setParam(capability.key, event.target.checked)} />
            : <input type={capability.type === "integer" || capability.type === "number" ? "number" : "text"} disabled={running}
                value={String(resolvedParameterValue(capability, parameters))} onChange={(event) => {
                  const value = event.currentTarget.value;
                  if (capability.type === "integer" || capability.type === "number") { if (value !== "" && Number.isFinite(Number(value))) setParam(capability.key, Number(value)); }
                  else setParam(capability.key, value);
                }} />}
      </label>)}
    </div></details> : null}
    {kind === "video" ? <div className="canvas-script-editor__actions">
      <label><input type="checkbox" checked={useFrames} disabled={running} onChange={(event) => setUseFrames(event.target.checked)} /> 使用分镜图作为首帧</label>
      <label><input type="checkbox" checked={useShotDuration} disabled={running} onChange={(event) => setUseShotDuration(event.target.checked)} /> 使用每镜时长</label>
    </div> : null}
    <div className="canvas-script-batch__shots">{shots.map((shot, index) => {
      const choices = choicesFor(shot.id);
      const selectedFrame = frameFor(shot.id);
      const saved = state?.frameSelections?.[shot.id];
      const options = [{ value: "", label: saved && !selectedFrame ? "已选首帧不可用，请重新选择" : "选择首帧" },
        ...choices.map((choice) => ({ value: frameKey(choice.frame), label: choice.label }))];
      return <div className="canvas-script-batch__shot" key={shot.id}>
        <label><input type="checkbox" checked={!excluded.has(shot.id)} disabled={running} onChange={(event) => setExcluded((current) => {
          const next = new Set(current); if (event.target.checked) next.delete(shot.id); else next.add(shot.id); return next;
        })} /> 镜头 {index + 1}</label>
        <span>{shot.plot || "未填写画面描述"}</span>
        {kind === "video" && useFrames ? <CanvasSelect ariaLabel={`镜头 ${index + 1} 首帧`} value={selectedFrame ? frameKey(selectedFrame) : ""}
          options={options} disabled={running} onChange={(value) => {
            const chosen = choices.find((choice) => frameKey(choice.frame) === value)?.frame;
            onUpdate((config) => {
              if (!config.scriptGenerator) return config;
              const selections = { ...(config.scriptGenerator.frameSelections ?? {}) };
              if (chosen) selections[shot.id] = chosen; else delete selections[shot.id];
              return { ...config, scriptGenerator: { ...config.scriptGenerator, frameSelections: selections } };
            });
          }} /> : null}
      </div>;
    })}</div>
    {invalid.length ? <p>有 {invalid.length} 个已选镜头缺少提示词或需要核对资产关联。</p> : null}
    {missingFrames.length ? <p>有 {missingFrames.length} 个已选镜头需要选择已保存的首帧。</p> : null}
    {confirmed ? <div className="canvas-script-editor__actions">
      <span>将提交 {selected.length} 个任务，按 {chosenModel?.model.displayName} 的实际用量计费。</span>
      <button type="button" disabled={running || !request} onClick={() => {
        if (!request) return;
        setApproval(null);
        onStart(node.key, request);
      }}>确认生成</button>
      <button type="button" onClick={() => setApproval(null)}>取消</button>
    </div> : <button type="button" disabled={running || !request}
      onClick={() => setApproval(fingerprint)}>{running ? "处理中…" : kind === "image" ? "批量生成分镜图" : "批量生成视频"}</button>}
    {onFilm && filmRows.some(row => row.choices.length) ? <div className="canvas-script-batch__film">
      <div className="canvas-script-editor__section-head">
        <strong>剪辑成片</strong><span>按当前分镜表顺序使用已保存的片段，进入时间轴后可调整。</span>
      </div>
      {filmRows.map(({ shot, shotNumber, choices, choice }) => <label key={shot.id}>
        镜头 {shotNumber}
        <CanvasSelect ariaLabel={`镜头 ${shotNumber} 成片片段`} value={choice?.value ?? ""}
          options={[{ value: "", label: choices.length ? "选择视频结果" : "等待片段保存" }, ...choices]}
          disabled={!choices.length || openingFilm} onChange={value => setFilmChoices(previous => ({ ...previous, [shot.id]: value }))} />
      </label>)}
      {filmError ? <ErrorAlert error={filmError} /> : null}
      <button type="button" disabled={openingFilm || filmRows.some(row => !row.choice)}
        onClick={() => {
          setOpeningFilm(true);
          setFilmError(null);
          void onFilm(filmRows.flatMap(row => row.choice ? [row.choice.source] : [])).catch(setFilmError).finally(() => setOpeningFilm(false));
        }}>{openingFilm ? "正在读取片段…" : "打开剪辑时间轴"}</button>
    </div> : null}
    {loadError ? <ErrorAlert error={loadError} hint="请重试读取；查看结果不会再次生成。" /> : null}
    {batches.length ? <button type="button" onClick={() => setReload((value) => value + 1)}>刷新任务与结果</button> : null}
    {batches.slice().reverse().map((batch) => <details key={batch.id} className="canvas-script-batch__run" open>
      <summary>{batch.kind === "image" ? "生图" : "生视频"} · {batch.modelLabel} · {new Date(batch.createdAt).toLocaleString()} · {batch.items.length} 镜</summary>
      {batch.items.some((item) => item.phase !== "submitted") ? <button type="button" disabled={running}
        onClick={() => onResume(node.key, batch.id)}>继续或核对未完成提交</button> : null}
      {batch.items.map((item) => {
        const detail = details[item.taskId];
        const currentIndex = shots.findIndex((shot) => shot.id === item.shotId);
        return <div className="canvas-script-batch__result" key={item.id}>
          <strong>{currentIndex >= 0 ? `镜头 ${currentIndex + 1}` : `原镜头 ${item.shotNumber}（已移除）`}</strong>
          <span>{detail ? STATUS_LABELS[detail.summary.status] ?? detail.summary.status : item.phase === "prepared" ? "待提交"
            : item.phase === "blocked" ? "需处理" : "任务状态待核对"}</span>
          {item.error ? <p>{item.error}</p> : null}
          {item.note ? <p>{item.note}</p> : null}
          {detail?.finalError && detail.summary.status !== "succeeded" ? <ErrorAlert error={detail.finalError} hint="请查看任务历史；重新查询不会重复提交。" /> : null}
          <div className="canvas-script-batch__media">{detail?.results.map((result) => {
            if (!result.finalPath || result.saveStatus !== "succeeded" || (result.mediaType !== "image" && result.mediaType !== "video")) return null;
            const source = toMediaSrc(result.finalPath);
            const src = toMediaProxyUrl(source) ?? source;
            return <figure key={`${result.taskId}#${result.resultIndex}`}>
              {result.mediaType === "image" ? <img src={src} alt={`镜头 ${item.shotNumber} 结果 ${result.resultIndex}`} />
                : <video src={src} controls preload="metadata" />}
              <figcaption>结果 {result.resultIndex}</figcaption>
            </figure>;
          })}</div>
        </div>;
      })}
    </details>)}
  </section>;
}
