import { useId, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as v from "valibot";
import { CanvasSelect } from "../../components/CanvasSelect";
import { ErrorAlert } from "../../components/ErrorAlert";
import { useModalFocusTrap } from "../../components/useModalFocusTrap";
import { generationClient, type ProviderCatalogEntry, type StartGenerationCommand } from "../../lib/backend";
import { canvasImageClient, type CanvasImageTranslationTask } from "../../lib/canvasImage";
import type { PromptContentDocumentV1, PromptContentEditorSession } from "../../lib/promptContent";
import { isRunningTaskStatus, type GenNodeData, type ImageNodeConfig } from "./workspaceModel";

function fingerprint(document: PromptContentDocumentV1): string {
  const text = JSON.stringify(document);
  let first = 2166136261;
  let second = 5381;
  for (let index = 0; index < text.length; index += 1) {
    first = Math.imul(first ^ text.charCodeAt(index), 16777619);
    second = Math.imul(second, 33) ^ text.charCodeAt(index);
  }
  return `${text.length}:${first >>> 0}:${second >>> 0}`;
}

const translationSchema = v.array(v.object({ index: v.pipe(v.number(), v.integer()), text: v.string() }));

function translatedDocument(source: PromptContentDocumentV1, raw: string): PromptContentDocumentV1 {
  const text = raw.trim().replace(/^```(?:json)?\s*/u, "").replace(/\s*```$/u, "");
  const output = v.parse(translationSchema, JSON.parse(text));
  const expected = source.items.flatMap((item, index) => item.kind === "text" && item.text.trim() ? [index] : []);
  const texts = new Map(output.map(item => [item.index, item.text]));
  if (output.length !== expected.length || texts.size !== expected.length || expected.some(index => !texts.get(index)?.trim())) {
    throw new Error("翻译返回的文字条目不完整，原提示词已保留；请查看原任务结果。");
  }
  // 只替换原位置的文字；所有媒体、附件、标记、块类型与行内样式保持原身份。
  return { ...source, items: source.items.map((item, index) => item.kind === "text" && texts.has(index) ? { ...item, text: texts.get(index) ?? item.text } : item) };
}

export function CanvasImageTranslation({ canvasId, node, sessionRef, providerCatalog, onChange, onClose }: {
  readonly canvasId: string;
  readonly node: Extract<GenNodeData, { kind: "image" }>;
  readonly sessionRef: RefObject<PromptContentEditorSession | null>;
  readonly providerCatalog: readonly ProviderCatalogEntry[];
  readonly onChange: (config: ImageNodeConfig) => void;
  readonly onClose: () => void;
}) {
  const trap = useModalFocusTrap({ active: true, onEscape: onClose });
  const id = useId();
  const queryClient = useQueryClient();
  const models = providerCatalog.filter(entry => entry.provider.enabled).flatMap(entry => entry.models.filter(model => model.operations.includes("text_generation")).map(model => ({
    value: JSON.stringify([entry.provider.id, model.definitionId]),
    label: `${entry.provider.displayName} · ${model.displayName}`,
    providerId: entry.provider.id,
    modelId: model.definitionId,
  })));
  const [model, setModel] = useState(models[0]?.value ?? "");
  const selectedModelValue = model || models[0]?.value || "";
  const [language, setLanguage] = useState<"English" | "Chinese">("English");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<unknown>(null);
  const latest = useRef({ config: node.config, onChange });
  latest.current = { config: node.config, onChange };
  const job = node.config.translationTask;
  const foreignTask = Boolean(job && (job.generation.canvasId !== canvasId || job.generation.sourceNodeId !== `${node.key}:prompt-translation`));
  const queryKey = ["canvas-image-translation", job?.taskId] as const;
  const query = useQuery({
    queryKey,
    queryFn: () => generationClient.get(job?.taskId ?? ""),
    enabled: Boolean(job?.taskId) && !foreignTask,
    retry: false,
    refetchInterval: query => query.state.error ? false : query.state.data && isRunningTaskStatus(query.state.data.summary.status) ? 1500 : false,
  });
  const source = sessionRef.current?.snapshot();
  const output = query.data?.textOutput?.rawModelOutput ?? "";
  const preview = useMemo(() => {
    if (!output || !source) return null;
    try { return { document: translatedDocument(source, output), error: null }; }
    catch (error) { return { document: null, error }; }
  }, [output, source]);
  const changed = Boolean(job && source && fingerprint(source) !== job.sourceFingerprint);
  const status = query.data?.summary.status;
  const terminal = status === "succeeded" || status === "failed" || status === "cancelled";

  const submit = async (pending: CanvasImageTranslationTask) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await canvasImageClient.translate({ taskId: pending.taskId, generation: pending.generation });
      await queryClient.invalidateQueries({ queryKey: ["canvas-image-translation", pending.taskId] });
    } catch (failure) { setError(failure); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const start = () => {
    if (busyRef.current || latest.current.config.translationTask) return;
    const session = sessionRef.current;
    const selected = models.find(item => item.value === selectedModelValue);
    if (!session || !selected) { setError("请选择可用的文本模型，并等待提示词编辑器就绪。"); return; }
    const document = session.snapshot();
    const items = document.items.flatMap((item, index) => item.kind === "text" && item.text.trim() ? [{ index, text: item.text }] : []);
    if (!items.length) { setError("请先输入需要翻译的提示词文字。"); return; }
    const generation: StartGenerationCommand = {
      canvasId, sourceNodeId: `${node.key}:prompt-translation`, outputName: "图片提示词翻译",
      operation: "text_generation", providerConnectionId: selected.providerId, modelDefinitionId: selected.modelId,
      prompt: [{ kind: "text", text: JSON.stringify({ language, items }) }], explicitMedia: [], parameters: {}, generationCount: 1,
    };
    const pending: CanvasImageTranslationTask = { taskId: crypto.randomUUID(), sourceFingerprint: fingerprint(document), language, generation };
    latest.current.onChange({ ...latest.current.config, translationTask: pending });
    void submit(pending);
  };
  return createPortal(<div className="canvas-video-modal-scrim"><div ref={trap.ref} {...trap.containerProps} className="canvas-video-modal" role="dialog" aria-modal="true" aria-label="翻译提示词" tabIndex={-1}>
    <header><strong>翻译提示词</strong><button type="button" onClick={onClose}>关闭</button></header>
    <p>仅翻译文字，保留 @ 素材身份、标记、附件和段落结构。翻译结果预览后再应用。</p>
    {foreignTask ? <><ErrorAlert error="这份翻译属于原画布或原节点。" tone="warning" hint="副本保留当前提示词；可以为当前节点新建翻译。" /><button type="button" onClick={() => onChange({ ...node.config, translationTask: null })}>为当前节点新建翻译</button></> : !job ? <>
      <label>文本模型<CanvasSelect ariaLabel="翻译使用的文本模型" value={selectedModelValue} options={models.length ? [...(selectedModelValue && !models.some(item => item.value === selectedModelValue) ? [{ value: selectedModelValue, label: "原文本模型（不可用）" }] : []), ...models] : [{ value: "", label: "请先配置文本模型" }]} onChange={setModel} /></label>
      <label>目标语言<CanvasSelect ariaLabel="目标语言" value={language} options={[{ value: "English", label: "英语" }, { value: "Chinese", label: "中文" }]} onChange={value => setLanguage(value === "Chinese" ? "Chinese" : "English")} /></label>
      <small>将调用所选文本模型，按供应商计费；不会提交图片生成。</small>
      <button type="button" disabled={busy || !models.some(item => item.value === selectedModelValue)} onClick={start}>开始翻译</button>
    </> : <>
      <p role="status">{status === "succeeded" ? "翻译已完成" : status === "failed" ? "翻译失败" : status === "cancelled" ? "翻译已取消" : status === "unknown" ? "请求结果不明确，请核对原任务" : "正在读取或执行原翻译任务…"}</p>
      <small>任务：{job.taskId}</small>
      <button type="button" disabled={query.isFetching || busy} onClick={() => { void query.refetch(); }}>重新读取原任务</button>
      {query.error ? <><ErrorAlert error={query.error} hint="读取失败不会再次提交；可以用同一任务身份核对并继续。" /><button type="button" disabled={busy} onClick={() => { void submit(job); }}>核对并继续原翻译</button></> : null}
      {query.data?.finalError ? <ErrorAlert error={query.data.finalError} hint="请检查原任务与文本模型配置。需要重新翻译时显式新建任务。" /> : null}
      {preview?.error && !changed ? <ErrorAlert error={preview.error} hint="原提示词未改动，请在任务历史中查看完整返回。" /> : null}
      {changed ? <ErrorAlert error="翻译期间原提示词已发生变化。" tone="warning" hint="请保留当前内容；本次翻译不会覆盖新的提示词。" /> : null}
      {preview?.document ? <><label>翻译预览<textarea readOnly value={preview.document.items.map(item => item.kind === "text" ? item.text : item.kind === "media_reference" ? `@${item.displayNameSnapshot}` : item.kind === "mark_reference" ? `@${item.labelSnapshot}` : "").join("")} /></label>
        <button type="button" disabled={changed || foreignTask || status !== "succeeded"} onClick={() => {
          const session = sessionRef.current;
          if (!session || fingerprint(session.snapshot()) !== job.sourceFingerprint || !preview.document) { setError("原提示词已变化，未应用翻译。"); return; }
          session.restore(preview.document);
          latest.current.onChange({ ...latest.current.config, translationTask: null });
          onClose();
        }}>应用翻译</button>
      </> : null}
      {terminal ? <button type="button" onClick={() => { onChange({ ...node.config, translationTask: null }); setError(null); }}>新建翻译</button> : null}
    </>}
    {error ? <ErrorAlert id={`${id}-error`} error={error} hint="原提示词未改动；回执不明确时请读取原任务，勿重复新建。" /> : null}
  </div></div>, document.body);
}
