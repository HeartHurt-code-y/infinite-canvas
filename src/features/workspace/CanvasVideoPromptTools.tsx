import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { CanvasSelect } from "../../components/CanvasSelect";
import { ErrorAlert } from "../../components/ErrorAlert";
import { useModalFocusTrap } from "../../components/useModalFocusTrap";
import { backendErrorMessage, promptNodeClient, type PromptOptimizationMode, type ProviderCatalogEntry } from "../../lib/backend";
import type { PromptContentEditorSession } from "../../lib/promptContent";
import { compileCanvasVideoMode, videoModeLabel } from "../../lib/canvasVideoMode";
import { isMinimaxH3VideoModel, isSeedance25VideoModel, isWan30VideoModel, modelParameterCapabilities, resolvedParameterValue } from "../../lib/modelCapabilities";
import { resolveLongVideoSegmentSeconds, resolveLongVideoSettings } from "../../lib/longVideo";
import { toast } from "../../lib/toast";
import { LibTVMediaIcon } from "./LibTVMediaIcon";
import { CanvasImageTranslation } from "./CanvasImageTranslation";
import { VideoStoryboardPanel } from "./VideoStoryboardPanel";
import { emptyStoryboardDocument, supportsVideoStoryboard } from "../../lib/videoStoryboard";
import { rewriteVideoPrompt } from "../../lib/videoPromptRewrite";
import { copyTextToDesktopClipboard } from "./desktopActions";
import type { ConnectedAssetInput, GenNodeData, InheritedAssetInput, VideoNodeConfig } from "./workspaceModel";
import directorCatalog from "../../../shared/video-director-styles.json";

type VideoNode = Extract<GenNodeData, { kind: "video" }>;
type OptimizationResult = { readonly text: string; readonly source: string };

function optimizationMode(modelId: string): PromptOptimizationMode | "video_prompt" {
  if (isSeedance25VideoModel(modelId)) return "seedance_2_5";
  if (isMinimaxH3VideoModel(modelId)) return "minimax_h3";
  if (isWan30VideoModel(modelId)) return "wan_3_0";
  if (/seedance.*2[._-]0(?:\D|$)/i.test(modelId)) return "seedance_2_0";
  return "video_prompt";
}

/** 视频正文辅助只调用文本模型，结果由用户明确应用到当前文档。 */
export function CanvasVideoPromptTools({ canvasId, node, active, inputs, sessionRef, providerCatalog, onChange, hasLinkedEffects }: {
  readonly canvasId: string;
  readonly node: VideoNode;
  readonly active: boolean;
  readonly inputs: readonly (ConnectedAssetInput | InheritedAssetInput)[];
  readonly sessionRef: RefObject<PromptContentEditorSession | null>;
  readonly providerCatalog: readonly ProviderCatalogEntry[];
  readonly onChange: (config: VideoNodeConfig) => void;
  readonly hasLinkedEffects: boolean;
}) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [panel, setPanel] = useState<"optimize" | "translate" | "storyboard" | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [result, setResult] = useState<OptimizationResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const models = providerCatalog.filter(entry => entry.provider.enabled).flatMap(entry =>
    entry.models.filter(model => model.operations.includes("text_generation")).map(model => ({
      value: JSON.stringify([entry.provider.id, model.definitionId]),
      label: `${entry.provider.displayName} · ${model.displayName}`,
      providerId: entry.provider.id,
      modelId: model.definitionId,
    })));
  const savedModel = node.config.promptOptimizationModelSelection;
  const videoModel = providerCatalog.find(entry => entry.provider.id === node.config.modelSelection.providerId)?.models.find(item => item.definitionId === node.config.modelSelection.modelDefinitionId);
  const durationCapability = videoModel ? modelParameterCapabilities(videoModel.operationSchema, "video_generation", videoModel.remoteModelId).find(item => /^(duration|duration_seconds|seconds)$/.test(item.key)) : undefined;
  const storyboardDuration = Number(durationCapability ? resolvedParameterValue(durationCapability, node.config.parameterValues) : node.config.parameterValues["duration"] ?? 5);
  const storyboardSupported = supportsVideoStoryboard(videoModel?.remoteModelId ?? "");
  const storyboardUnavailable = !storyboardSupported ? "当前模型不支持智能分镜"
    : node.config.videoMode === "longVideo2video" ? "超长视频使用镜头规划，不启用智能分镜"
    : hasLinkedEffects || node.config.effectVersionIds?.length ? "请先移除特效，再启用智能分镜"
    : node.config.greenScreen?.enabled || node.config.whiteModelControl?.enabled ? "当前控制模式不能与智能分镜同时使用"
    : inputs.some(input => input.kind === "video") ? "智能分镜暂不支持参考视频"
    : null;
  const selectedValue = savedModel ? JSON.stringify([savedModel.providerId, savedModel.modelDefinitionId])
    : models.find(item => item.providerId === node.config.modelSelection.providerId)?.value || models[0]?.value || "";
  const setModel = (value: string) => {
    const selected = models.find(item => item.value === value);
    if (selected) onChange({ ...node.config, promptOptimizationModelSelection: { providerId: selected.providerId, modelDefinitionId: selected.modelId } });
  };
  const latest = useRef({ config: node.config, onChange });
  latest.current = { config: node.config, onChange };
  const close = useCallback(() => setPanel(null), []);
  useLayoutEffect(() => { setHost(document.getElementById(`video-tools-${node.key}`)); }, [node.key, active]);

  const optimize = async () => {
    if (busyRef.current) return;
    const session = sessionRef.current;
    const selected = models.find(item => item.value === selectedValue);
    const text = session?.read().plainText.trim() ?? "";
    if (!session || !text) { setError("请先输入需要优化的提示词。"); return; }
    if (!selected) { setError("请先配置可用的文本模型。"); return; }
    const source = JSON.stringify(session.snapshot());
    const directorImages = new Map(inputs.filter(input => input.kind === "image" && input.target).map(input => [JSON.stringify(input.target), { target: input.target!, displayName: input.name }]));
    for (const item of session.snapshot().items) {
      if (item.kind === "media_reference" && item.target.mediaType === "image") directorImages.set(JSON.stringify(item.target), { target: item.target, displayName: item.displayNameSnapshot });
    }
    const videoModel = providerCatalog.find(entry => entry.provider.id === node.config.modelSelection.providerId)?.models.find(item => item.definitionId === node.config.modelSelection.modelDefinitionId);
    const capabilities = videoModel ? modelParameterCapabilities(videoModel.operationSchema, "video_generation", videoModel.remoteModelId) : [];
    // 与视频参数面板使用同一套默认值解析；只传创作参数和素材显示名，不传本地路径、URL 或凭据。
    const parameters = Object.fromEntries(capabilities.filter(item => /^(duration|duration_seconds|seconds|ratio|aspect_ratio|resolution|quality|generate_audio|audio|generate_audio_switch)$/.test(item.key))
      .map(item => [item.key, resolvedParameterValue(item, node.config.parameterValues)]));
    const mode = node.config.videoMode ?? node.config.seedanceTaskMode ?? "auto";
    const roles = compileCanvasVideoMode(mode, inputs, node.config.mediaRoles).mediaRoles;
    const displayName = (name: string) => name.split(/[\\/]/).at(-1) ?? name;
    const references = inputs.map((input, index) => ({ index: index + 1, name: displayName(input.name), type: input.kind, role: roles[input.key] ?? `reference_${input.kind}` }));
    const promptReferences = session.snapshot().items.flatMap(item => item.kind === "media_reference"
      ? [{ type: item.target.mediaType, name: displayName(item.displayNameSnapshot) }]
      : item.kind === "attachment" ? [{ type: item.mediaType, name: displayName(item.name) }]
      : item.kind === "mark_reference" ? [{ type: "mark", name: item.labelSnapshot }] : []);
    const longSettings = mode === "longVideo2video" ? resolveLongVideoSettings(node.config.longVideo, providerCatalog) : null;
    const confirmedSettings = {
      model: videoModel?.displayName ?? "视频生成", mode: videoModeLabel(mode, inputs), parameters,
      references, promptReferences,
      longVideo: longSettings ? {
        targetSeconds: longSettings.targetSeconds,
        segmentSeconds: resolveLongVideoSegmentSeconds(capabilities.find(item => /^(duration|duration_seconds|seconds)$/.test(item.key)), longSettings.segmentSeconds),
        linkPreviousFrame: longSettings.linkPreviousFrame,
      } : null,
    };
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response = await promptNodeClient.run({
        canvasId, sourceNodeId: `${node.key}:prompt-optimization`,
        providerConnectionId: selected.providerId, modelDefinitionId: selected.modelId,
        mode: optimizationMode(videoModel?.remoteModelId ?? ""), task: "optimize", userPrompt: text,
        ...(node.config.directorStyleKey ? { directorStyleKey: node.config.directorStyleKey, visionImages: [...directorImages.values()] } : {}),
        contextHistory: [{ role: "用户已确认的当前视频设置（必须遵守）", content: `${JSON.stringify(confirmedSettings)}\n保持原意和素材名称。优化只补充画面与运镜，不得擅自改变时长、画幅、分辨率、音频开关、模式或长视频目标；正文若与这些当前设置冲突，以这些设置为准。时长 -1 / adaptive 表示自动，不得自行编造固定数值。未给定的参数不要自行补成模型默认值。关闭音频时不要新增配音、音乐或音效要求。不执行视频生成。` }],
      });
      const optimized = response.optimizedPrompt.trim();
      if (!optimized) throw new Error("优化结果为空，原提示词已保留。");
      setResult({ text: optimized, source });
    } catch (failure) { setError(failure); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const apply = () => {
    const session = sessionRef.current;
    if (!session || !result) return;
    if (JSON.stringify(session.snapshot()) !== result.source) {
      setError("原提示词已发生变化，未覆盖当前内容。可以复制结果，或按当前内容重新生成。");
      return;
    }
    // 保留确切的 target / mentionId / attachmentId，不按显示名称重新绑定素材。
    session.restore(rewriteVideoPrompt(session.snapshot(), result.text));
    // 模态在画布视口外，显式更新配置以排期保存正文快照。
    latest.current.onChange({ ...latest.current.config });
    close();
    toast.success("已填充优化后的提示词");
  };

  return <>
    {host ? createPortal(<>
      {storyboardSupported || node.config.storyboard?.enabled ? <button type="button" aria-label="智能分镜" data-tooltip={storyboardUnavailable ?? "智能分镜"} disabled={!!storyboardUnavailable && !node.config.storyboard?.enabled} aria-pressed={node.config.storyboard?.enabled ?? false} onClick={() => setPanel("storyboard")}><LibTVMediaIcon name="storyboard" size={16} /></button> : null}
      <button type="button" aria-label="提示词优化" data-tooltip="提示词优化" disabled={busy}
        onClick={() => setPanel("optimize")}>
        <LibTVMediaIcon name="prompt-optimize" size={16} />
      </button>
      <button type="button" aria-label="翻译提示词" data-tooltip="翻译提示词" onClick={() => setPanel("translate")}>
        <LibTVMediaIcon name="translate" size={16} />
      </button>
    </>, host) : null}
    {active && panel === "translate" ? <CanvasImageTranslation canvasId={canvasId} node={node} sessionRef={sessionRef} providerCatalog={providerCatalog} onChange={onChange} onClose={close} /> : null}
    {active && panel === "storyboard" ? <VideoStoryboardPanel mode={node.config.videoMode ?? node.config.seedanceTaskMode} initial={node.config.storyboard} document={sessionRef.current?.snapshot() ?? emptyStoryboardDocument()} totalSeconds={storyboardDuration} durationCapability={durationCapability} unavailableReason={storyboardUnavailable} inputs={inputs} onSave={(storyboard, duration) => onChange({
      ...node.config, storyboard,
      ...(!storyboardUnavailable && duration !== storyboardDuration ? { parameterValues: { ...node.config.parameterValues, [durationCapability?.key ?? "duration"]: durationCapability?.type === "string" ? String(duration) : duration } } : {}),
    })} onClose={close} /> : null}
    {active && panel === "optimize" ? <VideoPromptOptimizationDialog busy={busy} error={error} result={result}
      directorStyle={node.config.directorStyleKey ?? ""} onDirectorChange={directorStyleKey => { onChange({ ...node.config, directorStyleKey }); setResult(null); setError(null); }}
      model={selectedValue} models={selectedValue && !models.some(item => item.value === selectedValue) ? [{ value: selectedValue, label: "原文本模型（不可用）" }, ...models] : models} onModelChange={setModel} onClose={close} onOptimize={() => { void optimize(); }} onApply={apply} /> : null}
  </>;
}

function VideoPromptOptimizationDialog({ busy, error, result, model, models, directorStyle, onDirectorChange, onModelChange, onClose, onOptimize, onApply }: {
  readonly busy: boolean;
  readonly error: unknown;
  readonly result: OptimizationResult | null;
  readonly model: string;
  readonly models: readonly { readonly value: string; readonly label: string }[];
  readonly directorStyle: string;
  readonly onDirectorChange: (value: string) => void;
  readonly onModelChange: (value: string) => void;
  readonly onClose: () => void;
  readonly onOptimize: () => void;
  readonly onApply: () => void;
}) {
  const trap = useModalFocusTrap({ active: true, onEscape: onClose });
  const copy = async () => {
    if (!result) return;
    try { await copyTextToDesktopClipboard(result.text); toast.success("优化后的提示词已复制"); }
    catch (failure) { toast.error("复制失败", { description: backendErrorMessage(failure) }); }
  };
  return createPortal(<div className="canvas-video-modal-scrim"><div ref={trap.ref} {...trap.containerProps}
    className="canvas-video-modal canvas-video-prompt-result" role="dialog" aria-modal="true" aria-label="提示词优化" tabIndex={-1}>
    <header><strong>提示词优化</strong><button type="button" aria-label="关闭提示词优化" onClick={onClose}><LibTVMediaIcon name="close" size={16} /></button></header>
    <label>导演风格<CanvasSelect chevronIcon={<LibTVMediaIcon name="icon-chevron-down-small" size={12} />} selectedIcon={<LibTVMediaIcon name="check" size={12} />} ariaLabel="导演风格" value={directorStyle}
      options={[{ value: "", label: "通用优化" }, ...directorCatalog.roles.map(role => ({ value: role.roleKey, label: role.name }))]}
      disabled={busy} onChange={onDirectorChange} /></label>
    <label>文本模型<CanvasSelect chevronIcon={<LibTVMediaIcon name="icon-chevron-down-small" size={12} />} selectedIcon={<LibTVMediaIcon name="check" size={12} />} ariaLabel="提示词优化使用的文本模型" value={model} options={models.length ? models : [{ value: "", label: "请先配置文本模型" }]} disabled={busy} onChange={onModelChange} /></label>
    {busy ? <p role="status">正在优化提示词…</p> : null}
    {result ? <textarea aria-label="优化结果" readOnly value={result.text} /> : null}
    {error ? <ErrorAlert error={error} hint="原提示词保留；结果可在任务历史中查看。" /> : null}
    <footer>
      <button type="button" disabled={!result} onClick={() => { void copy(); }}>复制</button>
      <button type="button" disabled={busy || !models.length} onClick={onOptimize}>{result ? "重新生成" : directorStyle ? "生成提示词" : "开始优化"}</button>
      <button type="button" disabled={busy || !result} onClick={onApply}>填充到输入框内</button>
    </footer>
  </div></div>, document.body);
}
