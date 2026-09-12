import { Icon } from "../../components/Icon";
import { useEffect, useMemo, useRef, useState } from "react";

import { ImeInput, ImeTextarea } from "../../components/ImeTextField";
import { toMediaSrc, type ProviderCatalogEntry } from "../../lib/backend";
import type {
  CanvasNodeDimensions,
  KnowledgeVideoWorkflowConfig,
  KnowledgeVideoWorkflowNodeData,
  KnowledgeVideoWorkflowPhase,
  KnowledgeVideoWorkflowRunState,
  NodeModelSelection,
} from "./workspaceModel";
import { isTextGenerationModel, isVideoGenerationModel } from "./workspaceModel";
import { AI_FILM_STAGES, AI_FILM_STAGE_LABELS, type AiFilmStage } from "./aiFilmWorkflowModel";
import { ComicDramaConfiguration, ComicDramaDeliverables } from "./ComicDramaWorkflowSections";
import { CommerceConfiguration, CommerceDeliverables } from "./CommerceWorkflowSections";
import { commerceInputReady } from "./commerceWorkflowModel";
import { RemotionConfiguration, RemotionDeliverables } from "./RemotionWorkflowSections";
import { XhsCoverConfiguration, XhsCoverDeliverables } from "./XhsCoverWorkflowSections";
import { xhsCoverInputReady } from "./xhsCoverWorkflowModel";
import {
  ReverseVideoConfiguration,
  ReverseVideoDeliverables,
} from "./ReverseVideoWorkflowSections";
import { reverseVideoInputReady } from "./reverseVideoWorkflowModel";
import { WorkflowReferenceMaterials } from "./WorkflowReferenceMaterials";
import { withCanvasWorkflowMaterials, type WorkflowCanvasInput } from "./workflowCanvasInputs";
import type { ConnectedCanvasTextInput } from "./canvasInputs";
import {
  workflowReferenceMaterials,
  workflowMaterialQuota,
  removeWorkflowHistoricalText,
} from "./workflowMaterials";

const REVERSE_VIDEO_WORKFLOW_STAGES = [
  { phase: "planning", label: "下载与抽帧" },
  { phase: "generating", label: "反推与二创" },
  { phase: "qc", label: "校验" },
  { phase: "composing", label: "入库" },
  { phase: "done", label: "交付" },
] as const;

const REVERSE_VIDEO_PHASE_LABELS: Partial<Record<KnowledgeVideoWorkflowPhase, string>> = {
  planning: "下载与抽帧",
  generating: "反推与二创",
  qc: "正在校验",
  composing: "案例入库",
};

const COVER_WORKFLOW_STAGES = [
  { phase: "planning", label: "标题与风格" },
  { phase: "generating", label: "生成封面" },
  { phase: "qc", label: "检查与修订" },
  { phase: "done", label: "封面交付" },
] as const;

const ANIMATION_WORKFLOW_STAGES = [
  { phase: "planning", label: "方案与检查" },
  { phase: "generating", label: "本地渲染" },
  { phase: "done", label: "动画交付" },
] as const;

const WORKFLOW_STAGES = [
  { phase: "planning", label: "策划" },
  { phase: "generating", label: "生成" },
  { phase: "qc", label: "质检" },
  { phase: "composing", label: "合成" },
  { phase: "done", label: "交付" },
] as const;

const PHASE_LABELS: Record<KnowledgeVideoWorkflowPhase, string> = {
  idle: "等待开始",
  planning: "正在策划",
  awaiting_approval: "等待确认",
  generating: "正在生成",
  qc: "自动质检",
  composing: "正在合成",
  done: "制作完成",
  failed: "需要处理",
  paused: "已暂停",
};

const PHASE_PROGRESS: Record<KnowledgeVideoWorkflowPhase, number> = {
  idle: 0,
  planning: 16,
  awaiting_approval: 28,
  generating: 52,
  qc: 76,
  composing: 90,
  done: 100,
  failed: 0,
  paused: 0,
};

type ModelFilter = (model: ProviderCatalogEntry["models"][number]) => boolean;
const TEXT_MODEL_FILTER: ModelFilter = isTextGenerationModel;
const IMAGE_MODEL_FILTER: ModelFilter = (model) => model.operations.includes("text_to_image");
const COVER_IMAGE_MODEL_FILTER: ModelFilter = (model) =>
  model.operations.includes("image_to_image");
const VIDEO_MODEL_FILTER: ModelFilter = isVideoGenerationModel;

interface ModelSlotProps {
  readonly label: string;
  readonly selection: NodeModelSelection;
  readonly providerCatalog: readonly ProviderCatalogEntry[];
  readonly filter: ModelFilter;
  readonly disabled?: boolean;
  readonly onChange: (selection: NodeModelSelection) => void;
}

function ModelSlot({
  label,
  selection,
  providerCatalog,
  filter,
  disabled = false,
  onChange,
}: ModelSlotProps) {
  const providers = providerCatalog
    .map((entry) => ({
      provider: entry.provider,
      models: entry.models.filter(filter),
    }))
    .filter((entry) => entry.provider.enabled && entry.models.length > 0);
  const selectedProvider = providers.find((entry) => entry.provider.id === selection.providerId);
  const models = selectedProvider?.models ?? [];
  const selectedModel = models.find((model) => model.definitionId === selection.modelDefinitionId);

  return (
    <fieldset className="canvas-knowledge-workflow__model-slot">
      <legend>{label}</legend>
      <label>
        <span>项目供应商</span>
        <select
          aria-label={`${label}供应商`}
          disabled={disabled}
          value={selection.providerId}
          onChange={(event) => {
            const providerId = event.target.value;
            const modelDefinitionId =
              providers.find((entry) => entry.provider.id === providerId)?.models[0]
                ?.definitionId ?? "";
            onChange({ providerId, modelDefinitionId });
          }}
        >
          {!selection.providerId ? <option value="">请选择供应商</option> : null}
          {selection.providerId && !selectedProvider ? (
            <option value={selection.providerId}>{selection.providerId}（不可用）</option>
          ) : null}
          {providers.map((entry) => (
            <option key={entry.provider.id} value={entry.provider.id}>
              {entry.provider.displayName}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>模型</span>
        <select
          aria-label={`${label}模型`}
          disabled={disabled}
          value={selection.modelDefinitionId}
          onChange={(event) => onChange({ ...selection, modelDefinitionId: event.target.value })}
        >
          {!selection.modelDefinitionId ? (
            <option value="">{models.length ? "请选择模型" : "没有可用模型"}</option>
          ) : null}
          {selection.modelDefinitionId && !selectedModel ? (
            <option value={selection.modelDefinitionId}>
              {selection.modelDefinitionId}（不可用）
            </option>
          ) : null}
          {models.map((model) => (
            <option key={model.definitionId} value={model.definitionId}>
              {model.displayName}
            </option>
          ))}
        </select>
      </label>
    </fieldset>
  );
}

function configuredModelLabel(
  selection: NodeModelSelection,
  providerCatalog: readonly ProviderCatalogEntry[],
  filter: ModelFilter,
): string {
  const provider = providerCatalog.find(
    (entry) => entry.provider.enabled && entry.provider.id === selection.providerId,
  );
  const model = provider?.models.find(
    (entry) => entry.definitionId === selection.modelDefinitionId && filter(entry),
  );
  return model ? model.displayName : "待配置";
}

function isActivePhase(phase: KnowledgeVideoWorkflowPhase): boolean {
  return ["planning", "generating", "qc", "composing"].includes(phase);
}

function stageIndexFor(phase: KnowledgeVideoWorkflowPhase): number {
  if (phase === "idle") return -1;
  if (phase === "planning" || phase === "awaiting_approval") return 0;
  if (phase === "generating") return 1;
  if (phase === "qc") return 2;
  if (phase === "composing") return 3;
  if (phase === "done") return 4;
  return -1;
}

export interface KnowledgeVideoWorkflowNodeProps {
  readonly node: KnowledgeVideoWorkflowNodeData;
  readonly connectedInputs?: readonly WorkflowCanvasInput[];
  readonly connectedTexts?: readonly ConnectedCanvasTextInput[];
  readonly onUnlink?: (edgeId: string) => void;
  readonly onRemoveHistoricalReference?: (index: number) => void;
  readonly providerCatalog: readonly ProviderCatalogEntry[];
  readonly runState?: KnowledgeVideoWorkflowRunState | null;
  readonly selected?: boolean;
  readonly dragging?: boolean;
  readonly onSelect?: (key: string) => void;
  readonly onNodeDragStart?: (
    key: string,
    x: number,
    y: number,
    clientX: number,
    clientY: number,
  ) => void;
  readonly onSizeChange?: (key: string, dimensions: CanvasNodeDimensions) => void;
  readonly onChange: (config: KnowledgeVideoWorkflowConfig) => void;
  readonly onExecute: (key: string) => void;
  readonly onContinue: (key: string, resolution?: string) => void;
  readonly onCancel: (key: string) => void;
  readonly onRedoShot?: (key: string, shotId: string) => void;
  readonly onRemove: (key: string) => void;
  readonly onRevealResult: (key: string) => void;
  readonly onOpenHistory?: (key: string) => void;
  readonly onExportFilmDocuments?: (key: string) => void;
  readonly onExportComicDramaDocuments?: (key: string) => void;
  readonly onExportCommerceDocuments?: (key: string) => void;
  readonly onExportRemotionDocuments?: (key: string) => void;
  readonly onRevealRemotionProject?: (key: string) => void;
  readonly onPickMaterials?: (key: string) => Promise<void>;
  readonly onRemoveMaterial?: (key: string, localPath: string) => void;
  readonly onPickCommerceMaterials?: (key: string) => Promise<void>;
  readonly onRemoveCommerceMaterial?: (key: string, localPath: string) => void;
  readonly onPickCoverImages?: (key: string, role: "portrait" | "material") => Promise<void>;
  readonly onRemoveCoverImage?: (key: string, role: "portrait" | "material", path: string) => void;
  readonly onExportCoverDocuments?: (key: string) => void;
  readonly onPickReverseVideo?: (key: string) => Promise<void> | void;
  readonly onRemoveReverseVideo?: (key: string) => void;
  readonly onOpenDownloadSettings?: (key: string) => void;
}

export function KnowledgeVideoWorkflowNode({
  node,
  connectedInputs = [],
  connectedTexts = [],
  onUnlink,
  onRemoveHistoricalReference,
  providerCatalog,
  runState,
  selected = false,
  dragging = false,
  onSelect,
  onNodeDragStart,
  onSizeChange,
  onChange,
  onExecute,
  onContinue,
  onCancel,
  onRedoShot,
  onRemove,
  onRevealResult,
  onOpenHistory,
  onExportFilmDocuments,
  onExportComicDramaDocuments,
  onExportCommerceDocuments,
  onExportRemotionDocuments,
  onRevealRemotionProject,
  onPickMaterials,
  onRemoveMaterial,
  onPickCommerceMaterials,
  onRemoveCommerceMaterial,
  onPickCoverImages,
  onRemoveCoverImage,
  onExportCoverDocuments,
  onPickReverseVideo,
  onRemoveReverseVideo,
  onOpenDownloadSettings,
}: KnowledgeVideoWorkflowNodeProps) {
  const nodeElementRef = useRef<HTMLDivElement>(null);
  const pickingMaterialsRef = useRef(false);
  const [pickingMaterials, setPickingMaterials] = useState(false);
  const [editingShotId, setEditingShotId] = useState<string | null>(null);
  const [shotDraft, setShotDraft] = useState<{
    videoPrompt: string;
    visual: string;
    narration: string;
    durationSeconds: number;
  } | null>(null);
  const filmOptions = node.config.film;
  const comicDramaOptions = node.config.comicDrama;
  const commerceOptions = node.config.commerce;
  const remotionOptions = node.config.remotion;
  const coverOptions = node.config.xhsCover;
  const reverseOptions = node.config.reverseVideo;
  const isReverse = reverseOptions != null;
  const isCover = !isReverse && coverOptions != null;
  const isRemotion = !isReverse && !isCover && remotionOptions != null;
  const isCommerce = !isReverse && !isCover && !isRemotion && commerceOptions != null;
  const isComicDrama =
    !isReverse && !isCover && !isRemotion && !isCommerce && comicDramaOptions != null;
  const isFilm =
    !isReverse && !isCover && !isRemotion && !isCommerce && !isComicDrama && filmOptions != null;
  const workflowTitle = isReverse
    ? "短视频反推工作流"
    : isCover
      ? "小红书封面工作流"
      : isRemotion
        ? "动画逻辑图工作流"
        : isCommerce
          ? "剧情带货工作流"
          : isComicDrama
            ? "漫剧自动工作流"
            : isFilm
              ? "AI影视工作流"
              : "知识视频工作流";
  const phase = runState?.phase ?? node.config.checkpoint.phase;
  const displayPhase =
    phase === "paused" || phase === "failed"
      ? (node.config.checkpoint.lastActivePhase ?? phase)
      : phase;
  const error = runState?.error ?? node.config.checkpoint.error;
  const progress = Math.min(100, Math.max(0, runState?.progress ?? PHASE_PROGRESS[displayPhase]));
  const runtimeMessage = runState?.message.trim();
  const phaseLabel = isReverse
    ? (REVERSE_VIDEO_PHASE_LABELS[phase] ?? PHASE_LABELS[phase])
    : isRemotion && phase === "planning"
      ? "方案与检查"
      : isRemotion && phase === "generating"
        ? "本地渲染中"
        : PHASE_LABELS[phase];
  const message = runtimeMessage && runtimeMessage.length > 0 ? runtimeMessage : phaseLabel;
  const decision = node.config.checkpoint.decision;
  const decisionKey = decision
    ? `${node.config.checkpoint.planRevision}:${decision.kind}:${decision.question}`
    : "";
  const [decisionDraft, setDecisionDraft] = useState({ key: "", value: "" });
  const decisionResolution = decisionDraft.key === decisionKey ? decisionDraft.value : "";
  const finalPath = node.config.checkpoint.finalPath;
  const checkpoint = node.config.checkpoint;
  const workflowStages = isReverse
    ? REVERSE_VIDEO_WORKFLOW_STAGES
    : isCover
      ? COVER_WORKFLOW_STAGES
      : isRemotion
        ? ANIMATION_WORKFLOW_STAGES
        : WORKFLOW_STAGES;
  const activeStageIndex = isReverse
    ? phase === "idle"
      ? -1
      : phase === "done"
        ? 4
        : { download: 0, sampling: 0, analysis: 1, review: 2, archive: 3, done: 4 }[
            node.config.checkpoint.reverseVideo?.step ?? "download"
          ]
    : isCover
      ? displayPhase === "done"
        ? 3
        : displayPhase === "qc"
          ? 2
          : displayPhase === "generating" || displayPhase === "composing"
            ? 1
            : 0
      : isRemotion
        ? displayPhase === "done"
          ? 2
          : displayPhase === "planning" || displayPhase === "awaiting_approval"
            ? 0
            : ["generating", "qc", "composing"].includes(displayPhase)
              ? 1
              : -1
        : stageIndexFor(displayPhase);
  const configurationLocked =
    pickingMaterials ||
    isActivePhase(phase) ||
    ((isReverse || isCover || isRemotion || isCommerce || isComicDrama) &&
      phase === "awaiting_approval");

  const configuredModels = useMemo(
    () => ({
      text: configuredModelLabel(node.config.models.text, providerCatalog, TEXT_MODEL_FILTER),
      image: configuredModelLabel(
        node.config.models.image,
        providerCatalog,
        isCover ? COVER_IMAGE_MODEL_FILTER : IMAGE_MODEL_FILTER,
      ),
      video: configuredModelLabel(node.config.models.video, providerCatalog, VIDEO_MODEL_FILTER),
    }),
    [node.config.models, providerCatalog, isCover],
  );
  const documentsOnly =
    (commerceOptions ?? comicDramaOptions ?? filmOptions)?.deliverable === "documents";
  const modelsReady = isCover
    ? configuredModels.text !== "待配置" &&
      (coverOptions.deliverable === "prompt" || configuredModels.image !== "待配置")
    : isReverse || isRemotion || documentsOnly
      ? configuredModels.text !== "待配置"
      : Object.values(configuredModels).every((label) => label !== "待配置");
  const effectiveConfig = withCanvasWorkflowMaterials(node, {
    media: connectedInputs,
    texts: connectedTexts,
  }).config;
  const inputReady = isReverse
    ? reverseVideoInputReady(effectiveConfig.brief, reverseOptions)
    : isCover
      ? xhsCoverInputReady(effectiveConfig.brief, coverOptions)
      : isRemotion
        ? Boolean(effectiveConfig.brief.trim())
        : commerceOptions
          ? commerceInputReady(commerceOptions)
          : comicDramaOptions
            ? comicDramaOptions.episodes.length > 0 &&
              comicDramaOptions.episodes.length <= 10 &&
              comicDramaOptions.episodes.every(
                (episode) => episode.title.trim() && episode.script.trim(),
              )
            : Boolean(effectiveConfig.brief.trim());
  const allMaterials = workflowReferenceMaterials(effectiveConfig);
  const materialQuota = workflowMaterialQuota(effectiveConfig);
  const materialsValid = allMaterials.every(
    (material) => Number.isFinite(material.byteSize) && material.byteSize > 0,
  );
  const readyToExecute = inputReady && modelsReady && materialsValid && !pickingMaterials;

  async function pickReferenceMaterials(pick: () => Promise<void> | void) {
    if (pickingMaterialsRef.current || configurationLocked || phase === "awaiting_approval") return;
    pickingMaterialsRef.current = true;
    setPickingMaterials(true);
    try {
      await pick();
    } finally {
      pickingMaterialsRef.current = false;
      setPickingMaterials(false);
    }
  }

  useEffect(() => {
    const element = nodeElementRef.current;
    if (element == null || onSizeChange == null) return;
    const reportSize = () => {
      if (element.offsetWidth > 0 && element.offsetHeight > 0) {
        onSizeChange(node.key, { width: element.offsetWidth, height: element.offsetHeight });
      }
    };
    reportSize();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(reportSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, [node.key, onSizeChange]);

  const patchModels = (
    kind: keyof KnowledgeVideoWorkflowConfig["models"],
    selection: NodeModelSelection,
  ) => {
    onChange({
      ...node.config,
      models: { ...node.config.models, [kind]: selection },
    });
  };

  return (
    <div
      ref={nodeElementRef}
      className={`canvas-knowledge-workflow${isReverse ? " canvas-reverse-video-workflow" : ""}${isCover ? " canvas-xhs-cover-workflow" : ""}${isRemotion ? " canvas-remotion-workflow" : ""}${isFilm ? " canvas-ai-film-workflow" : ""}${isComicDrama ? " canvas-comic-drama-workflow" : ""}${isCommerce ? " canvas-commerce-workflow" : ""}${selected ? " is-selected" : ""}${dragging ? " is-dragging" : ""}`}
      aria-busy={isActivePhase(phase) || pickingMaterials}
      onMouseDown={(event) => {
        onSelect?.(node.key);
        const target = event.target as HTMLElement;
        if (target.closest("input, textarea, select, button, details, video")) return;
        onNodeDragStart?.(node.key, node.x, node.y, event.clientX, event.clientY);
      }}
    >
      <header className="canvas-knowledge-workflow__header">
        <span className="canvas-knowledge-workflow__identity">
          <span className="canvas-knowledge-workflow__mark" aria-hidden="true">
            <Icon name="film-slate" size="xl" />
          </span>
          <span>
            <strong>{workflowTitle}</strong>
            <small>
              {isReverse
                ? "原片自动转为反推提示词、二创路线与可复用案例"
                : isCover
                  ? "人物参考图与选题自动转为 3:4 封面和配套提示词"
                  : isRemotion
                    ? "描述或草图自动转为动图、视频与可编辑工程"
                    : isCommerce
                      ? "商品资料自动转为剧情、镜头与成片交付"
                      : isComicDrama
                        ? "分集剧本自动完成导演、服化道、分镜与交付"
                        : isFilm
                          ? "八个制作阶段封装执行，支持已有资料接力"
                          : "一个节点自动完成策划、生成、质检与交付"}
            </small>
          </span>
        </span>
        <span className={`canvas-knowledge-workflow__status is-${phase}`} role="status">
          {isActivePhase(phase) ? (
            <Icon name="circle-notch" className="spin-icon" aria-hidden="true" size="sm" />
          ) : phase === "done" ? (
            <Icon name="check-circle" aria-hidden="true" size="sm" />
          ) : phase === "failed" || phase === "awaiting_approval" ? (
            <Icon name="warning-circle" aria-hidden="true" size="sm" />
          ) : null}
          {phaseLabel}
        </span>
        {onOpenHistory ? (
          <button
            type="button"
            className="canvas-knowledge-workflow__remove"
            aria-label={`查看${workflowTitle}历史记录`}
            title="查看工作流历史记录"
            onClick={(event) => {
              event.stopPropagation();
              onOpenHistory(node.key);
            }}
          >
            <Icon name="clock" aria-hidden="true" size="md" />
          </button>
        ) : null}
        <button
          type="button"
          className="canvas-knowledge-workflow__remove"
          aria-label={`移除${workflowTitle}节点`}
          onClick={(event) => {
            event.stopPropagation();
            onRemove(node.key);
          }}
        >
          <Icon name="x" aria-hidden="true" size="sm" />
        </button>
      </header>

      <div className="canvas-knowledge-workflow__body">
        {!isReverse && !isCommerce && !isComicDrama ? (
          <label className="canvas-knowledge-workflow__brief">
            <span>这次要制作什么？</span>
            <ImeTextarea
              aria-label={
                isCover
                  ? "封面内容"
                  : isRemotion
                    ? "动画制作要求"
                    : isFilm
                      ? "影视制作要求"
                      : "知识视频制作要求"
              }
              rows={4}
              value={node.config.brief}
              disabled={configurationLocked || phase === "awaiting_approval"}
              placeholder={
                isCover
                  ? "粘贴选题、文章或视频脚本，例如：面向新手介绍如何搭建自己的 AI 工作流。"
                  : isRemotion
                    ? "例如：用循环流程图展示“提出问题 → 尝试解决 → 收集反馈 → 改进”，清晰呈现每一步的关系。也可以直接粘贴 ASCII 草图。"
                    : isFilm
                      ? "例如：制作一部 60 秒温暖现实主义短片，讲述一位修表匠和女儿的和解。也可以写：只做视频提示词，以已有剧本为准。"
                      : "例如：为第一次接触大模型的销售团队，制作一条 60 秒竖屏视频，解释 RAG 为什么能减少知识问答幻觉。"
              }
              onValueChange={(brief) => onChange({ ...node.config, brief })}
            />
          </label>
        ) : null}

        <WorkflowReferenceMaterials
          materials={node.config.materials ?? []}
          allMaterials={allMaterials}
          totalCount={materialQuota.count}
          connectedInputs={connectedInputs}
          connectedTexts={connectedTexts}
          historicalTexts={node.config.connectedTexts ?? []}
          onRemoveHistoricalText={(key) => onChange(removeWorkflowHistoricalText(node.config, key))}
          historicalReferences={node.config.connectedMaterials ?? []}
          {...(onUnlink ? { onUnlink } : {})}
          {...(onRemoveHistoricalReference ? { onRemoveHistoricalReference } : {})}
          disabled={configurationLocked || phase === "awaiting_approval"}
          picking={pickingMaterials}
          {...(onPickMaterials
            ? { onPick: () => pickReferenceMaterials(() => onPickMaterials(node.key)) }
            : {})}
          {...(onRemoveMaterial
            ? { onRemove: (localPath: string) => onRemoveMaterial(node.key, localPath) }
            : {})}
        />

        {isReverse && reverseOptions ? (
          <ReverseVideoConfiguration
            options={reverseOptions}
            brief={node.config.brief}
            disabled={configurationLocked}
            onChange={(reverseVideo) => onChange({ ...node.config, reverseVideo })}
            onBriefChange={(brief) => onChange({ ...node.config, brief })}
            {...(onPickReverseVideo
              ? { onPickVideo: () => pickReferenceMaterials(() => onPickReverseVideo(node.key)) }
              : {})}
            {...(onRemoveReverseVideo
              ? { onRemoveVideo: () => onRemoveReverseVideo(node.key) }
              : {})}
            {...(onOpenDownloadSettings
              ? { onOpenDownloadSettings: () => onOpenDownloadSettings(node.key) }
              : {})}
          />
        ) : null}

        {isCover && coverOptions ? (
          <XhsCoverConfiguration
            options={coverOptions}
            disabled={configurationLocked}
            onChange={(xhsCover) => onChange({ ...node.config, xhsCover })}
            {...(onPickCoverImages
              ? {
                  onPickImages: (role: "portrait" | "material") =>
                    pickReferenceMaterials(() => onPickCoverImages(node.key, role)),
                }
              : {})}
            {...(onRemoveCoverImage
              ? {
                  onRemoveImage: (role: "portrait" | "material", path: string) =>
                    onRemoveCoverImage(node.key, role, path),
                }
              : {})}
          />
        ) : null}

        {isRemotion && remotionOptions ? (
          <RemotionConfiguration
            options={remotionOptions}
            disabled={configurationLocked}
            onChange={(remotion) => onChange({ ...node.config, remotion })}
          />
        ) : null}

        {isCommerce && commerceOptions ? (
          <CommerceConfiguration
            options={commerceOptions}
            brief={node.config.brief}
            disabled={configurationLocked}
            onChange={(commerce) => onChange({ ...node.config, commerce })}
            onBriefChange={(brief) => onChange({ ...node.config, brief })}
            {...(onPickCommerceMaterials
              ? {
                  onPickMaterials: () =>
                    pickReferenceMaterials(() => onPickCommerceMaterials(node.key)),
                }
              : {})}
            {...(onRemoveCommerceMaterial
              ? {
                  onRemoveMaterial: (localPath: string) =>
                    onRemoveCommerceMaterial(node.key, localPath),
                }
              : {})}
          />
        ) : null}

        {isComicDrama && comicDramaOptions ? (
          <ComicDramaConfiguration
            options={comicDramaOptions}
            brief={node.config.brief}
            disabled={configurationLocked}
            onChange={(comicDrama) => onChange({ ...node.config, comicDrama })}
            onBriefChange={(brief) => onChange({ ...node.config, brief })}
          />
        ) : null}

        {isFilm && filmOptions ? (
          <details className="canvas-knowledge-workflow__models canvas-ai-film-workflow__scope">
            <summary>
              <span className="canvas-knowledge-workflow__models-title">已有资料与制作范围</span>
              <span />
              <Icon name="caret-down" aria-hidden="true" size="md" />
            </summary>
            <div className="canvas-knowledge-workflow__body">
              <label className="canvas-knowledge-workflow__brief">
                <span>已有剧本、角色资料与本次修改要求</span>
                <ImeTextarea
                  aria-label="影视已有资料"
                  rows={4}
                  value={filmOptions.sourceText}
                  disabled={configurationLocked}
                  placeholder="粘贴本次使用的权威资料。已有资料可直接接力；修订时写清需要修改的场景或阶段。"
                  onValueChange={(sourceText) =>
                    onChange({
                      ...node.config,
                      film: { ...filmOptions, sourceText },
                    })
                  }
                />
              </label>
              <label>
                起始阶段
                <select
                  aria-label="影视起始阶段"
                  disabled={configurationLocked}
                  value={filmOptions.entryStage}
                  onChange={(event) =>
                    onChange({
                      ...node.config,
                      film: {
                        ...filmOptions,
                        entryStage: event.target.value as "auto" | AiFilmStage,
                      },
                    })
                  }
                >
                  <option value="auto">根据制作要求自动判断</option>
                  {AI_FILM_STAGES.map((item) => (
                    <option key={item} value={item}>
                      {AI_FILM_STAGE_LABELS[item]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                交付方式
                <select
                  aria-label="影视交付方式"
                  disabled={configurationLocked}
                  value={filmOptions.deliverable}
                  onChange={(event) =>
                    onChange({
                      ...node.config,
                      film: {
                        ...filmOptions,
                        deliverable: event.target.value as "video" | "documents",
                      },
                    })
                  }
                >
                  <option value="video">自动制作成片（含配套文档）</option>
                  <option value="documents">仅制作文档与提示词</option>
                </select>
              </label>
              <p>指定“只做某阶段”时直接交付该阶段；常规制作自动继续，关键冲突才请求确认。</p>
            </div>
          </details>
        ) : null}

        <details className="canvas-knowledge-workflow__models">
          <summary>
            <span className="canvas-knowledge-workflow__models-title">
              <Icon name="gear-six" aria-hidden="true" size="md" />
              模型配置
            </span>
            <span className="canvas-knowledge-workflow__model-summary" aria-label="已选模型">
              <span>
                {isReverse ? "视觉反推" : "策划"} · {configuredModels.text}
              </span>
              {!isReverse && !isRemotion ? (
                <>
                  <span>图片 · {configuredModels.image}</span>
                  {!isCover ? <span>视频 · {configuredModels.video}</span> : null}
                </>
              ) : null}
            </span>
            <Icon name="caret-down" aria-hidden="true" size="md" />
          </summary>
          <div className="canvas-knowledge-workflow__model-grid">
            <ModelSlot
              label={isReverse ? "视觉反推与审核" : "策划与审核"}
              selection={node.config.models.text}
              providerCatalog={providerCatalog}
              filter={TEXT_MODEL_FILTER}
              disabled={configurationLocked}
              onChange={(selection) => patchModels("text", selection)}
            />
            {!isReverse && !isRemotion ? (
              <>
                <ModelSlot
                  label="图片生成"
                  selection={node.config.models.image}
                  providerCatalog={providerCatalog}
                  filter={isCover ? COVER_IMAGE_MODEL_FILTER : IMAGE_MODEL_FILTER}
                  disabled={configurationLocked}
                  onChange={(selection) => patchModels("image", selection)}
                />
                {!isCover ? (
                  <ModelSlot
                    label="视频生成"
                    selection={node.config.models.video}
                    providerCatalog={providerCatalog}
                    filter={VIDEO_MODEL_FILTER}
                    disabled={configurationLocked}
                    onChange={(selection) => patchModels("video", selection)}
                  />
                ) : null}
              </>
            ) : null}
          </div>
          <p>这里仅显示当前项目中已启用的供应商和模型。</p>
          {isReverse ? <p>请选择能识别图片的文本模型，用于分析带时间戳的真实视频联系表。</p> : null}
          {isCover ? (
            <p>策划与审核请选择能识别图片的文本模型，图片生成请选择支持参考图的模型。</p>
          ) : null}
        </details>

        {phase !== "idle" ? (
          <section className="canvas-knowledge-workflow__progress" aria-label="制作进度">
            <div className="canvas-knowledge-workflow__progress-head">
              <strong>{message}</strong>
              <span>{Math.round(progress)}%</span>
            </div>
            <span
              className="canvas-knowledge-workflow__progress-track"
              role="progressbar"
              aria-label={
                isReverse
                  ? "短视频反推进度"
                  : isCover
                    ? "封面制作进度"
                    : isRemotion
                      ? "动画制作进度"
                      : isCommerce
                        ? "带货制作进度"
                        : isComicDrama
                          ? "漫剧制作进度"
                          : isFilm
                            ? "影视制作进度"
                            : "知识视频制作进度"
              }
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(progress)}
            >
              <i style={{ width: `${progress}%` }} />
            </span>
            <ol className="canvas-knowledge-workflow__stages">
              {workflowStages.map((stage, index) => {
                const complete = phase === "done" || index < activeStageIndex;
                const current = index === activeStageIndex && phase !== "done";
                return (
                  <li
                    key={stage.phase}
                    className={`${complete ? "is-complete" : ""}${current ? " is-current" : ""}`}
                    aria-current={current ? "step" : undefined}
                  >
                    <span aria-hidden="true">
                      {complete ? <Icon name="check-circle" size="sm" /> : index + 1}
                    </span>
                    {stage.label}
                  </li>
                );
              })}
            </ol>
          </section>
        ) : null}

        {phase === "awaiting_approval" ? (
          <section
            className="canvas-knowledge-workflow__decision"
            aria-label="需要确认"
            tabIndex={-1}
          >
            <span className="canvas-knowledge-workflow__decision-icon" aria-hidden="true">
              <Icon name="warning-circle" size="xl" />
            </span>
            <div>
              <small>继续前需要你决定</small>
              <strong>{decision?.question ?? "自动流程遇到一个需要确认的选择。"}</strong>
              <p>{decision?.recommendation ?? "采用系统推荐方案后，工作流会继续自动完成。"}</p>
              {decision?.kind === "planning" || isCover || isReverse ? (
                <label className="canvas-knowledge-workflow__decision-answer">
                  <span>你的回答（可选）</span>
                  <ImeInput
                    type="text"
                    name="knowledge-video-decision-resolution"
                    autoComplete="off"
                    maxLength={240}
                    value={decisionResolution}
                    placeholder={
                      isReverse
                        ? "例如：确认手持的是水杯，二创改为厨房场景"
                        : isCover
                          ? "例如：使用第二个标题，保留原图中的人物发型"
                          : isRemotion
                            ? "例如：采用循环布局，保留原文中的数值"
                            : isCommerce
                              ? "例如：采用职场救场剧情，删除未确认的优惠信息"
                              : isComicDrama
                                ? "例如：采用第二版人物造型，保留原剧本对白"
                                : "例如：面向管理者，强调决策价值"
                    }
                    onValueChange={(value) => setDecisionDraft({ key: decisionKey, value })}
                  />
                </label>
              ) : null}
            </div>
            <button
              type="button"
              disabled={pickingMaterials || !materialsValid}
              onClick={() => {
                const resolution = decisionResolution.trim();
                setDecisionDraft({ key: "", value: "" });
                if ((decision?.kind === "planning" || isCover || isReverse) && resolution) {
                  onContinue(node.key, resolution);
                  return;
                }
                onContinue(node.key);
              }}
            >
              {(isCover || isReverse) && decision?.kind === "qc"
                ? "确认后修订并重检"
                : decision?.kind === "qc"
                  ? "采用当前结果并继续"
                  : decisionResolution.trim()
                    ? "确认并继续"
                    : "采用推荐并继续"}
            </button>
          </section>
        ) : null}

        {error ? (
          <div className="canvas-knowledge-workflow__error" role="alert">
            <Icon name="warning-circle" aria-hidden="true" size="lg" />
            <span>{error}</span>
          </div>
        ) : null}

        {isReverse &&
        error &&
        reverseOptions?.sourceUrl.trim() &&
        node.config.checkpoint.reverseVideo?.step === "download" ? (
          <p className="canvas-reverse-video__download-hint">
            下载未完成。可使用上方“导入下载登录凭据”，再重试当前步骤。
          </p>
        ) : null}

        {isReverse ? <ReverseVideoDeliverables checkpoint={node.config.checkpoint} /> : null}

        {isCover ? (
          <XhsCoverDeliverables
            checkpoint={node.config.checkpoint}
            onRevealResult={() => onRevealResult(node.key)}
            {...(onExportCoverDocuments
              ? { onExportDocuments: () => onExportCoverDocuments(node.key) }
              : {})}
          />
        ) : null}

        {isRemotion ? (
          <RemotionDeliverables
            checkpoint={node.config.checkpoint}
            onRevealResult={() => onRevealResult(node.key)}
            {...(onExportRemotionDocuments
              ? { onExport: () => onExportRemotionDocuments(node.key) }
              : {})}
            {...(onRevealRemotionProject
              ? { onRevealProject: () => onRevealRemotionProject(node.key) }
              : {})}
          />
        ) : null}

        {isCommerce ? (
          <CommerceDeliverables
            checkpoint={node.config.checkpoint}
            {...(onExportCommerceDocuments
              ? { onExport: () => onExportCommerceDocuments(node.key) }
              : {})}
          />
        ) : null}

        {isComicDrama ? (
          <ComicDramaDeliverables
            checkpoint={node.config.checkpoint}
            {...(onExportComicDramaDocuments
              ? { onExport: () => onExportComicDramaDocuments(node.key) }
              : {})}
          />
        ) : null}

        {isFilm && node.config.checkpoint.film?.artifacts.length ? (
          <section className="canvas-ai-film-workflow__artifacts" aria-label="影视阶段交付物">
            <strong>{phase === "done" ? "影视交付物已就绪" : "已完成的制作阶段"}</strong>
            {onExportFilmDocuments ? (
              <button type="button" onClick={() => onExportFilmDocuments(node.key)}>
                导出影视制作文档
              </button>
            ) : null}
            {AI_FILM_STAGES.flatMap((item) => {
              const artifact = node.config.checkpoint.film!.artifacts.find(
                (entry) => entry.stage === item,
              );
              return artifact
                ? [
                    <details className="canvas-knowledge-workflow__deliverables" key={item}>
                      <summary>
                        {AI_FILM_STAGE_LABELS[item]} · v{artifact.version}
                        {artifact.stale ? " · 待更新" : ""}
                      </summary>
                      <div>
                        <small>依据：{artifact.inputSummary}</small>
                        <pre>{artifact.content}</pre>
                      </div>
                    </details>,
                  ]
                : [];
            })}
            {node.config.checkpoint.film.assets.some((asset) => asset.path) ? (
              <details className="canvas-knowledge-workflow__deliverables">
                <summary>角色、场景与道具图</summary>
                <div className="canvas-ai-film-workflow__assets">
                  {node.config.checkpoint.film.assets
                    .filter((asset) => asset.path)
                    .map((asset) => (
                      <figure key={asset.id}>
                        <img src={toMediaSrc(asset.path!)} alt={asset.name} loading="lazy" />
                        <figcaption>{asset.name}</figcaption>
                      </figure>
                    ))}
                </div>
              </details>
            ) : null}
            {node.config.checkpoint.film.history.length ? (
              <details className="canvas-knowledge-workflow__deliverables">
                <summary>历史版本（{node.config.checkpoint.film.history.length}）</summary>
                <div>
                  {node.config.checkpoint.film.history.map((artifact, index) => (
                    <details key={`${artifact.stage}-${artifact.version}-${index}`}>
                      <summary>
                        {AI_FILM_STAGE_LABELS[artifact.stage]} · v{artifact.version}
                      </summary>
                      <pre>{artifact.content}</pre>
                    </details>
                  ))}
                </div>
              </details>
            ) : null}
          </section>
        ) : null}

        {!isReverse && !isCover && !isRemotion && phase === "done" && finalPath ? (
          <section className="canvas-knowledge-workflow__result" aria-label="最终交付物">
            {node.config.checkpoint.coverImagePath ? (
              <img
                src={toMediaSrc(node.config.checkpoint.coverImagePath)}
                alt={
                  isCommerce
                    ? "带货主视觉"
                    : isComicDrama
                      ? "漫剧主视觉"
                      : isFilm
                        ? "影视主视觉"
                        : "知识视频封面"
                }
              />
            ) : null}
            <video controls preload="metadata" src={toMediaSrc(finalPath)} />
            <div>
              <span>
                <Icon name="check-circle" aria-hidden="true" size="lg" />
                <span>
                  <strong>完整成片已就绪</strong>
                  <small>脚本、分镜和质检记录已保存在工作流中</small>
                </span>
              </span>
              <button type="button" onClick={() => onRevealResult(node.key)}>
                <Icon name="folder-open" aria-hidden="true" size="md" />
                查看成片
              </button>
            </div>
            <details className="canvas-knowledge-workflow__deliverables">
              <summary>查看脚本、分镜与质检记录</summary>
              <div>
                <h4>
                  {isCommerce
                    ? "带货剧本"
                    : isComicDrama
                      ? "分集剧本"
                      : isFilm
                        ? "完整剧本"
                        : "讲述脚本"}
                </h4>
                <pre>{node.config.checkpoint.script}</pre>
                <h4>
                  {isCommerce
                    ? "带货镜头设计"
                    : isComicDrama
                      ? "漫剧镜头设计"
                      : isFilm
                        ? "影视镜头设计"
                        : "六段式分镜"}
                </h4>
                <pre>{node.config.checkpoint.storyboard}</pre>
                <h4>逐镜质检</h4>
                <ol>
                  {node.config.checkpoint.shots.map((shot) => (
                    <li key={shot.id}>
                      <strong>
                        {String(shot.sequence).padStart(2, "0")} ·{" "}
                        {isCommerce || isFilm || isComicDrama ? shot.title : shot.section}
                      </strong>
                      <span>{node.config.checkpoint.shotRuns[shot.id]?.qcReport ?? "未记录"}</span>
                    </li>
                  ))}
                </ol>
              </div>
            </details>
          </section>
        ) : null}

        {!isReverse && !isCover && !isRemotion && checkpoint.shots.length > 0 ? (
          <section className="canvas-knowledge-workflow__shots" aria-label="分镜视频">
            <h4>分镜视频</h4>
            <ol>
              {checkpoint.shots.map((shot) => {
                const run = checkpoint.shotRuns[shot.id];
                const clipPath = run?.clipPath ?? null;
                const canRedo = Boolean(onRedoShot) && Boolean(clipPath) && !isActivePhase(phase);
                const canEdit = !isActivePhase(phase);
                const isEditing = editingShotId === shot.id;
                return (
                  <li
                    key={shot.id}
                    className={
                      run?.redoRequested
                        ? "canvas-knowledge-workflow__shot--redo"
                        : run?.promptEdited && clipPath
                          ? "canvas-knowledge-workflow__shot--edited"
                          : undefined
                    }
                  >
                    <div className="canvas-knowledge-workflow__shot-head">
                      <strong>
                        {String(shot.sequence).padStart(2, "0")} ·{" "}
                        {isCommerce || isFilm || isComicDrama ? shot.title : shot.section}
                      </strong>
                      <span className="canvas-knowledge-workflow__shot-state">
                        {run?.redoRequested && !clipPath
                          ? "待重做"
                          : run?.promptEdited && clipPath
                            ? "提示词已修改"
                            : clipPath && run?.qcStatus === "passed"
                              ? "已通过质检"
                              : clipPath && run?.qcStatus === "failed"
                                ? "质检未通过"
                                : clipPath
                                  ? "待质检"
                                  : run?.videoTaskId
                                    ? "生成中"
                                    : "未生成"}
                      </span>
                    </div>
                    {clipPath ? (
                      <video
                        controls
                        preload="metadata"
                        src={toMediaSrc(clipPath)}
                        aria-label={`镜头 ${shot.sequence} 视频预览`}
                      />
                    ) : null}
                    {shot.referenceAssetIds && shot.referenceAssetIds.length > 0 ? (
                      <p className="canvas-knowledge-workflow__shot-meta">
                        参考素材：{shot.referenceAssetIds.length} 项
                      </p>
                    ) : null}
                    <div className="canvas-knowledge-workflow__shot-actions">
                      {canEdit ? (
                        <button
                          type="button"
                          className="canvas-knowledge-workflow__secondary"
                          onClick={() => {
                            if (isEditing) {
                              setEditingShotId(null);
                              setShotDraft(null);
                            } else {
                              setEditingShotId(shot.id);
                              setShotDraft({
                                videoPrompt: shot.videoPrompt,
                                visual: shot.visual,
                                narration: shot.narration,
                                durationSeconds: shot.durationSeconds,
                              });
                            }
                          }}
                        >
                          {isEditing ? "收起编辑" : "编辑分镜"}
                        </button>
                      ) : null}
                      {canRedo ? (
                        <button
                          type="button"
                          className="canvas-knowledge-workflow__secondary"
                          onClick={() => onRedoShot!(node.key, shot.id)}
                        >
                          重做此镜头
                        </button>
                      ) : null}
                    </div>
                    {isEditing && shotDraft ? (
                      <div className="canvas-knowledge-workflow__shot-editor">
                        <label>
                          <span>视频提示词</span>
                          <textarea
                            value={shotDraft.videoPrompt}
                            onChange={(event) =>
                              setShotDraft({ ...shotDraft, videoPrompt: event.target.value })
                            }
                            rows={4}
                          />
                        </label>
                        <label>
                          <span>分镜画面描述</span>
                          <textarea
                            value={shotDraft.visual}
                            onChange={(event) =>
                              setShotDraft({ ...shotDraft, visual: event.target.value })
                            }
                            rows={2}
                          />
                        </label>
                        <label>
                          <span>旁白台词</span>
                          <textarea
                            value={shotDraft.narration}
                            onChange={(event) =>
                              setShotDraft({ ...shotDraft, narration: event.target.value })
                            }
                            rows={2}
                          />
                        </label>
                        <label>
                          <span>时长（秒，4–15）</span>
                          <input
                            type="number"
                            min={4}
                            max={15}
                            value={shotDraft.durationSeconds}
                            onChange={(event) =>
                              setShotDraft({
                                ...shotDraft,
                                durationSeconds: Number(event.target.value),
                              })
                            }
                          />
                        </label>
                        <div className="canvas-knowledge-workflow__shot-editor-actions">
                          <button
                            type="button"
                            className="canvas-knowledge-workflow__primary"
                            onClick={() => {
                              const duration = Math.min(
                                15,
                                Math.max(4, Math.round(shotDraft.durationSeconds) || 5),
                              );
                              onChange({
                                ...node.config,
                                checkpoint: {
                                  ...checkpoint,
                                  shots: checkpoint.shots.map((candidate) =>
                                    candidate.id === shot.id
                                      ? {
                                          ...candidate,
                                          videoPrompt: shotDraft.videoPrompt,
                                          visual: shotDraft.visual,
                                          narration: shotDraft.narration,
                                          durationSeconds: duration,
                                        }
                                      : candidate,
                                  ),
                                  shotRuns: {
                                    ...checkpoint.shotRuns,
                                    [shot.id]: {
                                      ...(run ?? {
                                        shotId: shot.id,
                                        qcStatus: "pending" as const,
                                        retryCount: 0,
                                      }),
                                      promptEdited: true,
                                    },
                                  },
                                },
                              });
                              setEditingShotId(null);
                              setShotDraft(null);
                            }}
                          >
                            保存修改
                          </button>
                          <button
                            type="button"
                            className="canvas-knowledge-workflow__secondary"
                            onClick={() => {
                              setEditingShotId(null);
                              setShotDraft(null);
                            }}
                          >
                            取消
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          </section>
        ) : null}

        <footer className="canvas-knowledge-workflow__actions">
          {phase === "idle" ? (
            <>
              <span>
                {pickingMaterials
                  ? "参考素材选择完成后即可开始"
                  : !inputReady
                    ? isReverse
                      ? "请粘贴一条有效视频分享链接，或选择本地视频"
                      : isCover
                        ? "请填写封面内容并添加 1–3 张人物参考图"
                        : isCommerce
                          ? commerceOptions?.deliverable === "video" &&
                            !commerceOptions.materials.some((material) => material.kind === "image")
                            ? "请添加真实商品图后开始制作"
                            : "请填写商品资料后开始制作"
                          : isComicDrama
                            ? "请填写每集剧本，至少添加一集"
                            : "填写制作要求后即可开始"
                    : !modelsReady
                      ? isCover
                        ? "请配置文本模型与支持参考图的图片模型"
                        : isReverse || isRemotion || documentsOnly
                          ? "请先配置文本模型"
                          : "请先完成三个模型配置"
                      : "其余步骤将自动完成"}
              </span>
              <button
                type="button"
                className="canvas-knowledge-workflow__primary"
                disabled={!readyToExecute}
                onClick={() => onExecute(node.key)}
              >
                <Icon name="play" aria-hidden="true" size="md" />
                {isReverse ? "开始反推" : "开始制作"}
              </button>
            </>
          ) : isActivePhase(phase) ? (
            <>
              <span>
                {isReverse || isRemotion
                  ? "可暂停制作，并从已保存的进度继续"
                  : "暂停后续步骤，已提交的生成任务可能继续完成"}
              </span>
              <button
                type="button"
                className="canvas-knowledge-workflow__secondary"
                onClick={() => onCancel(node.key)}
              >
                <Icon name="pause" aria-hidden="true" size="md" />
                暂停后续步骤
              </button>
            </>
          ) : phase === "paused" ? (
            <>
              <span>从已保存的进度继续，不会重复提交已完成任务</span>
              <button
                type="button"
                className="canvas-knowledge-workflow__primary"
                disabled={pickingMaterials || !materialsValid}
                onClick={() => onContinue(node.key)}
              >
                <Icon name="play" aria-hidden="true" size="md" />
                继续制作
              </button>
            </>
          ) : phase === "failed" ? (
            <>
              <span>已完成的结果会保留</span>
              <button
                type="button"
                className="canvas-knowledge-workflow__primary"
                disabled={pickingMaterials || !materialsValid}
                onClick={() => onContinue(node.key)}
              >
                重试当前步骤
              </button>
            </>
          ) : phase === "awaiting_approval" ? (
            <span>确认后会从当前步骤继续</span>
          ) : phase === "done" ? (
            <>
              <span>可修改制作要求后重新生成一版</span>
              <button
                type="button"
                className="canvas-knowledge-workflow__primary"
                disabled={!readyToExecute}
                onClick={() => onExecute(node.key)}
              >
                <Icon name="play" aria-hidden="true" size="md" />
                重新制作
              </button>
            </>
          ) : (
            <span>本次工作流已完成</span>
          )}
          {phase === "paused" || phase === "failed" ? (
            <button
              type="button"
              className="canvas-knowledge-workflow__secondary"
              disabled={!readyToExecute}
              onClick={() => onExecute(node.key)}
            >
              按当前资料重新制作
            </button>
          ) : null}
        </footer>
      </div>
    </div>
  );
}
