import { BookOpenText } from "@phosphor-icons/react/BookOpenText";
import { CircleNotch } from "@phosphor-icons/react/CircleNotch";
import { DownloadSimple } from "@phosphor-icons/react/DownloadSimple";
import { FilmSlate } from "@phosphor-icons/react/FilmSlate";
import { FilmStrip } from "@phosphor-icons/react/FilmStrip";
import { FileText } from "@phosphor-icons/react/FileText";
import { ImageSquare } from "@phosphor-icons/react/ImageSquare";
import { MagnifyingGlass } from "@phosphor-icons/react/MagnifyingGlass";
import { MusicNotes } from "@phosphor-icons/react/MusicNotes";
import { Paperclip } from "@phosphor-icons/react/Paperclip";
import { PaperPlaneRight } from "@phosphor-icons/react/PaperPlaneRight";
import { Sparkle } from "@phosphor-icons/react/Sparkle";
import { VideoCamera } from "@phosphor-icons/react/VideoCamera";
import { X } from "@phosphor-icons/react/X";
import { useEffect, useRef, useState } from "react";
import {
  formatBytes,
  type PromptMaterialKind,
  type PromptOptimizationMode,
  type ProviderCatalogEntry,
} from "../../lib/backend";

import { MarkdownView } from "../../components/MarkdownView";

import { NodeTypeIcon, PromptAuditPanel } from "./PromptNodeViews";
import type {
  AssetKind,
  CanvasNodeDimensions,
  ConnectedScreenplayInput,
  DocumentSkillNodeData,
  GenNodeData,
  PromptNodeConfig,
  PromptOptimizationPanelState,
  ScreenplayNodeConfig,
  StaticNodeDescriptor,
  ViralRemixNodeConfig,
  ViralRemixNodeData,
  ViralRemixVideoInput,
} from "./workspaceModel";
import {
  DOCUMENT_SKILL_NODE_COPY,
  PROMPT_OPTIMIZATION_MODE_LABELS,
  documentSkillRoleLabel,
  isTextGenerationModel,
} from "./workspaceModel";

function ScreenplayMaterialIcon({ kind }: { readonly kind: PromptMaterialKind }) {
  const props = { size: 15, weight: "bold" as const, "aria-hidden": true as const };
  if (kind === "image") return <ImageSquare {...props} />;
  if (kind === "audio") return <MusicNotes {...props} />;
  if (kind === "video") return <VideoCamera {...props} />;
  return <FileText {...props} />;
}

function screenplayMaterialKindLabel(kind: PromptMaterialKind): string {
  if (kind === "image") return "图片";
  if (kind === "audio") return "音频";
  if (kind === "video") return "视频";
  return "文档";
}

function screenplayMaterialCompatibilityHint(remoteModelId: string | undefined): string {
  const identity = remoteModelId?.toLowerCase() ?? "";
  if (identity.startsWith("gemini")) return "当前 Gemini 接口可读取全部受支持格式。";
  if (identity.startsWith("claude")) return "当前 Claude 接口可读取图片、PDF 与文本。";
  if (identity.includes("audio")) {
    return "当前接口可读取图片、MP3 / WAV 与文本；视频或 PDF 请切换 Gemini。";
  }
  return "当前接口可读取图片与文本；音视频或 PDF 建议切换 Gemini。";
}

/** 内置技能文档节点：完整多轮对话、可编辑稿件、审计确认和 Markdown 导出。 */
export function CanvasDocumentSkillNode({
  node,
  selected,
  dragging,
  running,
  error,
  providerCatalog,
  audit,
  sourceInput,
  onSelect,
  onNodeDragStart,
  onRemove,
  onUnlink,
  onSizeChange,
  onChange,
  onPickMaterials,
  onRemoveMaterial,
  onSend,
  onAudit,
  onApplyAudit,
  onDiscardAudit,
  onExport,
}: {
  readonly node: DocumentSkillNodeData;
  readonly selected: boolean;
  readonly dragging: boolean;
  readonly running: boolean;
  readonly error: string | null;
  readonly providerCatalog: readonly ProviderCatalogEntry[];
  readonly audit: PromptOptimizationPanelState | undefined;
  readonly sourceInput: ConnectedScreenplayInput | null;
  readonly onSelect: (key: string) => void;
  readonly onNodeDragStart: (
    key: string,
    x: number,
    y: number,
    clientX: number,
    clientY: number,
  ) => void;
  readonly onRemove: (key: string) => void;
  readonly onUnlink: (edgeId: string) => void;
  readonly onSizeChange: (key: string, dimensions: CanvasNodeDimensions) => void;
  readonly onChange: (config: ScreenplayNodeConfig) => void;
  readonly onPickMaterials?: (key: string) => Promise<void>;
  readonly onRemoveMaterial?: (key: string, materialId: string) => void;
  readonly onSend: (key: string) => void;
  readonly onAudit: (key: string) => void;
  readonly onApplyAudit: (key: string) => void;
  readonly onDiscardAudit: (key: string) => void;
  readonly onExport: (key: string) => Promise<void>;
}) {
  const nodeElementRef = useRef<HTMLDivElement>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const composerComposingRef = useRef(false);
  const publishedComposerRef = useRef(node.config.composer);
  const [exporting, setExporting] = useState(false);
  const [pickingMaterials, setPickingMaterials] = useState(false);
  const [composerInitialValue] = useState(node.config.composer);
  const copy = DOCUMENT_SKILL_NODE_COPY[node.kind];
  const textModelProviders = providerCatalog
    .map((entry) => ({
      provider: entry.provider,
      models: entry.models.filter(isTextGenerationModel),
    }))
    .filter((entry) => entry.provider.enabled && entry.models.length > 0);
  const selectedProvider = textModelProviders.find(
    (entry) => entry.provider.id === node.config.modelSelection.providerId,
  );
  const availableModels = selectedProvider?.models ?? [];
  const selectedModel = availableModels.find(
    (model) => model.definitionId === node.config.modelSelection.modelDefinitionId,
  );
  const selectionReady = Boolean(selectedProvider && selectedModel);
  const materials = node.config.materials ?? [];
  const screenplayHasMaterials = node.kind === "screenplay" && materials.length > 0;
  const sourceDocumentReady = node.kind === "storyboard" && Boolean(sourceInput?.document.trim());
  const auditBusy = audit?.status === "running";
  const auditUnavailableReason = auditBusy
    ? `正在审计当前${copy.documentName}`
    : running
      ? "请等待本轮对话完成"
      : !node.config.currentDocument.trim()
        ? `生成或粘贴${copy.documentName}后才能审计`
        : !selectionReady
          ? "请先选择可用的文本模型"
          : null;

  useEffect(() => {
    const element = nodeElementRef.current;
    if (element == null) return;
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

  useEffect(() => {
    const conversation = conversationRef.current;
    if (conversation) conversation.scrollTop = conversation.scrollHeight;
  }, [node.config.conversation]);

  useEffect(() => {
    publishedComposerRef.current = node.config.composer;
    const composer = composerRef.current;
    if (
      composer == null ||
      composerComposingRef.current ||
      composer.value === node.config.composer
    ) {
      return;
    }

    const focused = document.activeElement === composer;
    const selectionStart = composer.selectionStart;
    const selectionEnd = composer.selectionEnd;
    const selectionDirection = composer.selectionDirection;
    composer.value = node.config.composer;
    if (focused) {
      const valueLength = composer.value.length;
      composer.setSelectionRange(
        Math.min(selectionStart, valueLength),
        Math.min(selectionEnd, valueLength),
        selectionDirection,
      );
    }
  }, [node.config.composer]);

  const publishComposer = (value: string) => {
    if (value === publishedComposerRef.current) return;
    publishedComposerRef.current = value;
    onChange({ ...node.config, composer: value });
  };

  return (
    <div
      ref={nodeElementRef}
      className={`canvas-screenplay-node canvas-screenplay-node--${node.kind}${selected ? " is-selected" : ""}${dragging ? " is-dragging" : ""}`}
      aria-busy={running || auditBusy || exporting}
      onMouseDown={(event) => {
        const target = event.target as HTMLElement;
        onSelect(node.key);
        if (target.closest("textarea, select, button, .canvas-screenplay-node__body")) return;
        onNodeDragStart(node.key, node.x, node.y, event.clientX, event.clientY);
      }}
    >
      <div className="canvas-gen-node__header">
        <span className={`canvas-gen-node__type canvas-gen-node__type--${node.kind}`}>
          <span className="canvas-gen-node__type-icon" aria-hidden="true">
            <NodeTypeIcon kind={node.kind} size={16} />
          </span>
          <span className="canvas-gen-node__type-copy">
            <strong>{copy.descriptor.kindLabel}</strong>
            <small>{selectedModel?.displayName ?? "文本模型待配置"}</small>
          </span>
        </span>
        <span className="canvas-gen-node__actions">
          <button
            type="button"
            className="canvas-screenplay-node__export"
            aria-label={copy.exportAriaLabel}
            disabled={exporting || !node.config.currentDocument.trim()}
            title={
              node.config.currentDocument.trim() ? copy.exportReadyTitle : copy.exportEmptyTitle
            }
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              setExporting(true);
              void onExport(node.key).finally(() => setExporting(false));
            }}
          >
            {exporting ? (
              <CircleNotch size={14} weight="bold" aria-hidden="true" className="spin-icon" />
            ) : (
              <DownloadSimple size={14} weight="bold" aria-hidden="true" />
            )}
            <span>{exporting ? "导出中" : "导出 MD"}</span>
          </button>
          <button
            type="button"
            className="canvas-gen-node__remove"
            aria-label={copy.removeAriaLabel}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onRemove(node.key);
            }}
          >
            <X size={12} weight="bold" aria-hidden="true" />
          </button>
        </span>
      </div>

      <div className="canvas-screenplay-node__body">
        {node.kind === "storyboard" ? (
          <div className={`canvas-screenplay-node__source${sourceInput ? " is-connected" : ""}`}>
            <span className="canvas-screenplay-node__source-copy">
              <BookOpenText size={16} weight="bold" aria-hidden="true" />
              <span>
                <small>输入剧本</small>
                <strong>{sourceInput?.name ?? "尚未连接剧本节点"}</strong>
              </span>
            </span>
            {sourceInput ? (
              <button
                type="button"
                aria-label={`解除剧本连线：${sourceInput.name}`}
                title="解除剧本连线"
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  onUnlink(sourceInput.edgeId);
                }}
              >
                <X size={14} weight="bold" aria-hidden="true" />
              </button>
            ) : (
              <span className="canvas-screenplay-node__source-hint">从剧本节点右侧端口连入</span>
            )}
          </div>
        ) : null}
        <div className="canvas-screenplay-node__skill-badge">
          {node.kind === "storyboard" ? (
            <FilmSlate size={16} weight="bold" aria-hidden="true" />
          ) : (
            <BookOpenText size={16} weight="bold" aria-hidden="true" />
          )}
          <span>
            <strong>{copy.skillTitle}</strong>
            <small>{copy.skillDetail}</small>
          </span>
        </div>

        <div className="canvas-prompt-node__fields">
          <label className="canvas-prompt-node__field">
            <span>文本模型供应商</span>
            <select
              aria-label={copy.providerAriaLabel}
              value={node.config.modelSelection.providerId}
              onChange={(event) => {
                const providerId = event.target.value;
                const modelDefinitionId =
                  textModelProviders.find((entry) => entry.provider.id === providerId)?.models[0]
                    ?.definitionId ?? "";
                onChange({ ...node.config, modelSelection: { providerId, modelDefinitionId } });
              }}
            >
              {!node.config.modelSelection.providerId ? (
                <option value="">请选择供应商</option>
              ) : null}
              {node.config.modelSelection.providerId && !selectedProvider ? (
                <option value={node.config.modelSelection.providerId}>
                  {node.config.modelSelection.providerId}（不可用）
                </option>
              ) : null}
              {textModelProviders.map((entry) => (
                <option key={entry.provider.id} value={entry.provider.id}>
                  {entry.provider.displayName}
                </option>
              ))}
            </select>
          </label>
          <label className="canvas-prompt-node__field">
            <span>文本模型</span>
            <select
              aria-label={copy.modelAriaLabel}
              value={node.config.modelSelection.modelDefinitionId}
              onChange={(event) =>
                onChange({
                  ...node.config,
                  modelSelection: {
                    ...node.config.modelSelection,
                    modelDefinitionId: event.target.value,
                  },
                })
              }
            >
              {!node.config.modelSelection.modelDefinitionId ? (
                <option value="">
                  {availableModels.length ? "请选择文本模型" : "没有可用文本模型"}
                </option>
              ) : null}
              {node.config.modelSelection.modelDefinitionId && !selectedModel ? (
                <option value={node.config.modelSelection.modelDefinitionId}>
                  {node.config.modelSelection.modelDefinitionId}（不可用）
                </option>
              ) : null}
              {availableModels.map((model) => (
                <option key={model.definitionId} value={model.definitionId}>
                  {model.displayName}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div
          ref={conversationRef}
          className="canvas-screenplay-node__conversation"
          role="log"
          aria-label={copy.conversationAriaLabel}
          aria-live="polite"
        >
          {node.config.conversation.length === 0 ? (
            <div className="canvas-screenplay-node__empty">
              <strong>{copy.emptyTitle}</strong>
              <span>{copy.emptyDescription}</span>
            </div>
          ) : (
            node.config.conversation.map((entry) => (
              <article
                key={entry.id}
                className={`canvas-screenplay-node__message is-${entry.role}`}
              >
                <span>{documentSkillRoleLabel(entry.role, node.kind)}</span>
                <MarkdownView content={entry.content} />
              </article>
            ))
          )}
          {running ? (
            <div className="canvas-screenplay-node__thinking" role="status">
              <CircleNotch size={14} weight="bold" aria-hidden="true" className="spin-icon" />
              {copy.loadingLabel}
            </div>
          ) : null}
        </div>

        <label className="canvas-prompt-node__field">
          <span>本轮消息</span>
          <textarea
            ref={composerRef}
            className="canvas-screenplay-node__composer"
            aria-label={copy.composerAriaLabel}
            placeholder={
              sourceDocumentReady
                ? "可留空直接生成，或输入画幅、时长、平台等拆镜要求"
                : copy.composerPlaceholder
            }
            defaultValue={composerInitialValue}
            disabled={running || auditBusy}
            onCompositionStart={() => {
              composerComposingRef.current = true;
            }}
            onCompositionEnd={(event) => {
              composerComposingRef.current = false;
              publishComposer(event.currentTarget.value);
            }}
            onChange={(event) => {
              if (composerComposingRef.current || (event.nativeEvent as InputEvent).isComposing) {
                return;
              }
              publishComposer(event.currentTarget.value);
            }}
            onKeyDown={(event) => {
              if (composerComposingRef.current || event.nativeEvent.isComposing) return;
              if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                event.preventDefault();
                onSend(node.key);
              }
            }}
          />
        </label>
        {node.kind === "screenplay" ? (
          <div className="canvas-screenplay-node__materials" aria-label="剧本参考素材">
            <div className="canvas-screenplay-node__materials-heading">
              <span>
                <strong>参考素材</strong>
                <small>{materials.length ? `已添加 ${materials.length} 项` : "可选"}</small>
              </span>
              <button
                type="button"
                className="canvas-screenplay-node__materials-add"
                aria-label="添加多模态参考素材"
                disabled={running || auditBusy || pickingMaterials || materials.length >= 8}
                title={materials.length >= 8 ? "每个剧本节点最多添加 8 项素材" : undefined}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  if (!onPickMaterials) return;
                  setPickingMaterials(true);
                  void onPickMaterials(node.key).finally(() => setPickingMaterials(false));
                }}
              >
                {pickingMaterials ? (
                  <CircleNotch size={15} weight="bold" aria-hidden="true" className="spin-icon" />
                ) : (
                  <Paperclip size={15} weight="bold" aria-hidden="true" />
                )}
                {pickingMaterials ? "读取中" : "添加素材"}
              </button>
            </div>
            {materials.length ? (
              <ul className="canvas-screenplay-node__material-list">
                {materials.map((material) => (
                  <li key={material.id}>
                    <span className="canvas-screenplay-node__material-icon" aria-hidden="true">
                      <ScreenplayMaterialIcon kind={material.kind} />
                    </span>
                    <span className="canvas-screenplay-node__material-copy">
                      <strong title={material.displayName}>{material.displayName}</strong>
                      <small>
                        {screenplayMaterialKindLabel(material.kind)}
                        {formatBytes(material.byteSize)
                          ? ` · ${formatBytes(material.byteSize)}`
                          : ""}
                      </small>
                    </span>
                    <button
                      type="button"
                      aria-label={`移除参考素材：${material.displayName}`}
                      title="移除素材"
                      disabled={running || auditBusy}
                      onMouseDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        onRemoveMaterial?.(node.key, material.id);
                      }}
                    >
                      <X size={13} weight="bold" aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p>图片、音频、视频、PDF、TXT / Markdown；发送和审计时会一并读取。</p>
            )}
            <p className="canvas-screenplay-node__materials-hint">
              {screenplayMaterialCompatibilityHint(selectedModel?.remoteModelId)}
            </p>
          </div>
        ) : null}
        <div className="canvas-screenplay-node__composer-actions">
          <span>Ctrl / ⌘ + Enter 发送</span>
          <button
            type="button"
            disabled={
              running ||
              auditBusy ||
              !selectionReady ||
              (!node.config.composer.trim() && !sourceDocumentReady && !screenplayHasMaterials)
            }
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onSend(node.key);
            }}
          >
            {running ? (
              <CircleNotch size={14} weight="bold" aria-hidden="true" className="spin-icon" />
            ) : (
              <PaperPlaneRight size={14} weight="fill" aria-hidden="true" />
            )}
            {running ? "生成中" : "发送"}
          </button>
        </div>

        <div className="canvas-screenplay-node__document">
          <div className="canvas-screenplay-node__document-heading">
            <label htmlFor={`document-skill-document-${node.key}`}>
              {copy.currentDocumentLabel}
            </label>
            <button
              type="button"
              className="canvas-prompt-node__audit-button"
              disabled={auditUnavailableReason != null}
              title={auditUnavailableReason ?? `用内置技能与全部历史审计当前${copy.documentName}`}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onAudit(node.key);
              }}
            >
              {auditBusy ? (
                <CircleNotch size={13} weight="bold" aria-hidden="true" className="spin-icon" />
              ) : (
                <MagnifyingGlass size={13} weight="bold" aria-hidden="true" />
              )}
              {auditBusy ? "审计中" : "审计"}
            </button>
          </div>
          <textarea
            id={`document-skill-document-${node.key}`}
            aria-label={copy.currentDocumentLabel}
            placeholder={copy.documentPlaceholder}
            value={node.config.currentDocument}
            disabled={running || auditBusy}
            onChange={(event) => onChange({ ...node.config, currentDocument: event.target.value })}
          />
        </div>

        {audit && audit.status !== "idle" ? (
          <PromptAuditPanel
            state={audit}
            subject={copy.documentName}
            originalLabel={`当前${copy.documentName}`}
            optimizedLabel="审计修订稿"
            onAudit={() => onAudit(node.key)}
            onApply={() => onApplyAudit(node.key)}
            onDiscard={() => onDiscardAudit(node.key)}
          />
        ) : null}
        {error ? (
          <pre className="raw-error canvas-prompt-node__error" role="alert" tabIndex={0}>
            {error}
          </pre>
        ) : null}
      </div>
    </div>
  );
}

/** 爆款视频复刻节点：消费已存在的视频，在本地抽帧后调用内置纯复刻技能。 */
export function CanvasViralRemixNode({
  node,
  input,
  selected,
  dragging,
  running,
  error,
  providerCatalog,
  onSelect,
  onNodeDragStart,
  onRemove,
  onUnlink,
  onSizeChange,
  onChange,
  onRun,
  onExport,
}: {
  readonly node: ViralRemixNodeData;
  readonly input: ViralRemixVideoInput | null;
  readonly selected: boolean;
  readonly dragging: boolean;
  readonly running: boolean;
  readonly error: string | null;
  readonly providerCatalog: readonly ProviderCatalogEntry[];
  readonly onSelect: (key: string) => void;
  readonly onNodeDragStart: (
    key: string,
    x: number,
    y: number,
    clientX: number,
    clientY: number,
  ) => void;
  readonly onRemove: (key: string) => void;
  readonly onUnlink: (edgeId: string) => void;
  readonly onSizeChange: (key: string, dimensions: CanvasNodeDimensions) => void;
  readonly onChange: (config: ViralRemixNodeConfig) => void;
  readonly onRun: (key: string) => void;
  readonly onExport: (key: string) => Promise<void>;
}) {
  const nodeElementRef = useRef<HTMLDivElement>(null);
  const [exporting, setExporting] = useState(false);
  const textModelProviders = providerCatalog
    .map((entry) => ({
      provider: entry.provider,
      models: entry.models.filter(isTextGenerationModel),
    }))
    .filter((entry) => entry.provider.enabled && entry.models.length > 0);
  const selectedProvider = textModelProviders.find(
    (entry) => entry.provider.id === node.config.modelSelection.providerId,
  );
  const availableModels = selectedProvider?.models ?? [];
  const selectedModel = availableModels.find(
    (model) => model.definitionId === node.config.modelSelection.modelDefinitionId,
  );
  const selectionReady = Boolean(selectedProvider && selectedModel);

  useEffect(() => {
    const element = nodeElementRef.current;
    if (element == null) return;
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

  const unavailableReason = !input
    ? "请先连接一个视频或网络爆款视频下载节点"
    : !input.src
      ? "已连接下载节点，请先完成视频下载"
      : !selectionReady
        ? "请先选择可用的多模态文本模型"
        : null;

  return (
    <div
      ref={nodeElementRef}
      className={`canvas-screenplay-node canvas-screenplay-node--viral_remix${selected ? " is-selected" : ""}${dragging ? " is-dragging" : ""}`}
      data-connection-target={node.key}
      aria-busy={running || exporting}
      onMouseDown={(event) => {
        const target = event.target as HTMLElement;
        onSelect(node.key);
        if (target.closest("textarea, select, button, .canvas-viral-remix-node__body")) return;
        onNodeDragStart(node.key, node.x, node.y, event.clientX, event.clientY);
      }}
    >
      <div className="canvas-gen-node__header">
        <span className="canvas-gen-node__type canvas-gen-node__type--viral_remix">
          <span className="canvas-gen-node__type-icon" aria-hidden="true">
            <NodeTypeIcon kind="viral_remix" size={16} />
          </span>
          <span className="canvas-gen-node__type-copy">
            <strong>爆款视频复刻</strong>
            <small>{selectedModel?.displayName ?? "多模态文本模型待配置"}</small>
          </span>
        </span>
        <span className="canvas-gen-node__actions">
          <button
            type="button"
            className="canvas-screenplay-node__export"
            aria-label="导出 Markdown 爆款视频复刻方案"
            disabled={exporting || !node.config.currentDocument.trim()}
            title={node.config.currentDocument.trim() ? "导出当前复刻方案" : "暂无可导出的复刻方案"}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              setExporting(true);
              void onExport(node.key).finally(() => setExporting(false));
            }}
          >
            {exporting ? (
              <CircleNotch size={14} weight="bold" aria-hidden="true" className="spin-icon" />
            ) : (
              <DownloadSimple size={14} weight="bold" aria-hidden="true" />
            )}
            <span>{exporting ? "导出中" : "导出 MD"}</span>
          </button>
          <button
            type="button"
            className="canvas-gen-node__remove"
            aria-label="移除爆款视频复刻节点"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onRemove(node.key);
            }}
          >
            <X size={12} weight="bold" aria-hidden="true" />
          </button>
        </span>
      </div>

      <div className="canvas-viral-remix-node__body">
        <div className="canvas-screenplay-node__skill-badge">
          <FilmStrip size={16} weight="bold" aria-hidden="true" />
          <span>
            <strong>V1.1 复刻技能已内置</strong>
            <small>只分析与二创 · 不包含下载能力</small>
          </span>
        </div>

        <div className={`canvas-viral-remix-node__input${input ? " is-connected" : ""}`}>
          <span className="node-port node-port--left" aria-hidden="true" />
          <div>
            <strong>{input ? input.name : "连接待复刻视频"}</strong>
            <small>
              {!input
                ? "可直接连接“网络爆款视频下载”节点、视频素材或本地视频产物"
                : input.src
                  ? `${input.sourceLabel}已就绪 · 运行时本地密集抽帧`
                  : `${input.sourceLabel}已连接 · 等待下载完成`}
            </small>
          </div>
          {input ? (
            <button
              type="button"
              aria-label={`解除复刻视频连线：${input.name}`}
              title="解除视频连线"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onUnlink(input.edgeId);
              }}
            >
              <X size={12} weight="bold" aria-hidden="true" />
            </button>
          ) : null}
        </div>

        <div className="canvas-prompt-node__fields">
          <label className="canvas-prompt-node__field">
            <span>多模态文本模型供应商</span>
            <select
              aria-label="复刻文本模型供应商"
              value={node.config.modelSelection.providerId}
              onChange={(event) => {
                const providerId = event.target.value;
                const modelDefinitionId =
                  textModelProviders.find((entry) => entry.provider.id === providerId)?.models[0]
                    ?.definitionId ?? "";
                onChange({ ...node.config, modelSelection: { providerId, modelDefinitionId } });
              }}
            >
              {!node.config.modelSelection.providerId ? (
                <option value="">请选择供应商</option>
              ) : null}
              {node.config.modelSelection.providerId && !selectedProvider ? (
                <option value={node.config.modelSelection.providerId}>
                  {node.config.modelSelection.providerId}（不可用）
                </option>
              ) : null}
              {textModelProviders.map((entry) => (
                <option key={entry.provider.id} value={entry.provider.id}>
                  {entry.provider.displayName}
                </option>
              ))}
            </select>
          </label>
          <label className="canvas-prompt-node__field">
            <span>多模态文本模型</span>
            <select
              aria-label="复刻文本模型"
              value={node.config.modelSelection.modelDefinitionId}
              onChange={(event) =>
                onChange({
                  ...node.config,
                  modelSelection: {
                    ...node.config.modelSelection,
                    modelDefinitionId: event.target.value,
                  },
                })
              }
            >
              {!node.config.modelSelection.modelDefinitionId ? (
                <option value="">
                  {availableModels.length ? "请选择文本模型" : "没有可用文本模型"}
                </option>
              ) : null}
              {node.config.modelSelection.modelDefinitionId && !selectedModel ? (
                <option value={node.config.modelSelection.modelDefinitionId}>
                  {node.config.modelSelection.modelDefinitionId}（不可用）
                </option>
              ) : null}
              {availableModels.map((model) => (
                <option key={model.definitionId} value={model.definitionId}>
                  {model.displayName}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="canvas-prompt-node__field">
          <span>补充复刻方向（可选）</span>
          <textarea
            className="canvas-viral-remix-node__instructions"
            aria-label="爆款视频复刻方向"
            placeholder="例如：保留节奏与运镜，改成国风美妆题材；为空则自动给出忠实复刻与三条二创路线。"
            value={node.config.instructions}
            disabled={running}
            onChange={(event) => onChange({ ...node.config, instructions: event.target.value })}
          />
        </label>

        <button
          type="button"
          className="canvas-viral-remix-node__run"
          disabled={running || unavailableReason != null}
          title={unavailableReason ?? "密集抽帧并用内置 V1.1 复刻技能分析"}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onRun(node.key);
          }}
        >
          {running ? (
            <CircleNotch size={15} weight="bold" aria-hidden="true" className="spin-icon" />
          ) : (
            <Sparkle size={15} weight="fill" aria-hidden="true" />
          )}
          {running ? "正在密集抽帧与复刻…" : "开始复刻"}
        </button>

        <div className="canvas-screenplay-node__document canvas-viral-remix-node__document">
          <div className="canvas-screenplay-node__document-heading">
            <label htmlFor={`viral-remix-document-${node.key}`}>当前 Markdown 复刻方案</label>
            <span>可编辑 · 可导出</span>
          </div>
          <textarea
            id={`viral-remix-document-${node.key}`}
            aria-label="当前 Markdown 爆款视频复刻方案"
            placeholder="连接视频并运行后，将在这里生成逐秒复刻提示词、爆点诊断和三条二创路线。"
            value={node.config.currentDocument}
            disabled={running}
            onChange={(event) => onChange({ ...node.config, currentDocument: event.target.value })}
          />
        </div>

        {error ? (
          <pre className="raw-error canvas-prompt-node__error" role="alert" tabIndex={0}>
            {error}
          </pre>
        ) : null}
      </div>
    </div>
  );
}

/** 独立提示词节点：用文本模型生成/优化结果，并通过右侧端口下发给媒体生成节点。 */
export function CanvasPromptNode({
  node,
  descriptor,
  selected,
  dragging,
  running,
  error,
  providerCatalog,
  sourceConnections,
  targetConnections,
  audit,
  onSelect,
  onNodeDragStart,
  onRemove,
  onUnlink,
  onConnectionStart,
  onSizeChange,
  onChange,
  onRun,
  onAudit,
  onApplyAudit,
  onDiscardAudit,
}: {
  readonly node: Extract<GenNodeData, { kind: "prompt" }>;
  readonly descriptor: StaticNodeDescriptor;
  readonly selected: boolean;
  readonly dragging: boolean;
  readonly running: boolean;
  readonly error: string | null;
  readonly providerCatalog: readonly ProviderCatalogEntry[];
  /** 连入本节点的图片素材（视觉理解参考图，按连线建立顺序）。 */
  readonly sourceConnections: readonly {
    readonly key: string;
    readonly name: string;
    readonly kind: AssetKind;
    readonly edgeId: string;
  }[];
  readonly targetConnections: readonly {
    readonly key: string;
    readonly name: string;
    readonly kind: "image" | "video";
    readonly edgeId: string;
  }[];
  readonly audit: PromptOptimizationPanelState | undefined;
  readonly onSelect: (key: string) => void;
  readonly onNodeDragStart: (
    key: string,
    x: number,
    y: number,
    clientX: number,
    clientY: number,
  ) => void;
  readonly onRemove: (key: string) => void;
  readonly onUnlink: (edgeId: string) => void;
  readonly onConnectionStart: (key: string) => void;
  readonly onSizeChange: (key: string, dimensions: CanvasNodeDimensions) => void;
  readonly onChange: (config: PromptNodeConfig) => void;
  readonly onRun: (key: string) => void;
  readonly onAudit: (key: string) => void;
  readonly onApplyAudit: (key: string) => void;
  readonly onDiscardAudit: (key: string) => void;
}) {
  const nodeElementRef = useRef<HTMLDivElement>(null);
  const textModelProviders = providerCatalog
    .map((entry) => ({
      provider: entry.provider,
      models: entry.models.filter(isTextGenerationModel),
    }))
    .filter((entry) => entry.provider.enabled && entry.models.length > 0);
  const selectedProvider = textModelProviders.find(
    (entry) => entry.provider.id === node.config.modelSelection.providerId,
  );
  const availableModels = selectedProvider?.models ?? [];
  const selectedModel = availableModels.find(
    (model) => model.definitionId === node.config.modelSelection.modelDefinitionId,
  );
  const selectionReady = Boolean(selectedProvider && selectedModel);
  const taskLabel = node.config.task === "generate" ? "生成提示词" : "优化提示词";
  const auditBusy = audit?.status === "running";
  const auditStatusId = `prompt-audit-status-${node.key}`;
  const promptOutputId = `prompt-output-${node.key}`;
  const auditUnavailableReason = auditBusy
    ? "正在审计当前输出"
    : running
      ? "请等待提示词生成完成后再进行审计"
      : !node.config.generatedPrompt.trim()
        ? "请先生成或输入输出提示词，再进行审计"
        : !selectionReady
          ? "请先选择可用的文本模型"
          : null;
  const auditHelpText =
    auditUnavailableReason ?? "使用完整技能上下文审计当前输出，并生成 Diff 建议";
  const promptStatusText =
    auditUnavailableReason ??
    (node.config.generatedPrompt
      ? `已生成 ${node.config.generatedPrompt.length} 字${sourceConnections.length > 0 ? `，并携带 ${sourceConnections.length} 张视觉参考图` : ""}`
      : "输出会作为下游节点的提示词请求参数");

  useEffect(() => {
    const element = nodeElementRef.current;
    if (element == null) return;
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

  return (
    <div
      ref={nodeElementRef}
      className={`canvas-gen-node canvas-gen-node--prompt${selected ? " is-selected" : ""}${dragging ? " is-dragging" : ""}`}
      data-connection-target={node.key}
      aria-busy={running || auditBusy}
      onMouseDown={(event) => {
        const target = event.target as HTMLElement;
        if (target.closest("textarea, select, button, .canvas-prompt-node__body")) {
          onSelect(node.key);
          return;
        }
        onSelect(node.key);
        onNodeDragStart(node.key, node.x, node.y, event.clientX, event.clientY);
      }}
    >
      <div className="canvas-gen-node__header">
        <span className="canvas-gen-node__type canvas-gen-node__type--prompt">
          <span className="canvas-gen-node__type-icon" aria-hidden="true">
            <NodeTypeIcon kind="prompt" size={16} />
          </span>
          <span className="canvas-gen-node__type-copy">
            <strong>{descriptor.kindLabel}</strong>
            <small>{selectedModel?.displayName ?? "文本模型待配置"}</small>
          </span>
        </span>
        <span className="canvas-gen-node__actions">
          <button
            type="button"
            className="canvas-gen-node__start canvas-gen-node__start--labeled canvas-prompt-node__run"
            aria-label={taskLabel}
            data-state={running ? "loading" : undefined}
            disabled={running || auditBusy || !selectionReady}
            title={!selectionReady ? "请先选择可用的文本模型" : `调用文本模型${taskLabel}`}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onSelect(node.key);
              onRun(node.key);
            }}
          >
            {running ? (
              <CircleNotch size={15} weight="bold" aria-hidden="true" className="spin-icon" />
            ) : (
              <Sparkle size={15} weight="fill" aria-hidden="true" />
            )}
            <span>{running ? "调用中" : taskLabel}</span>
          </button>
          <button
            type="button"
            className="canvas-gen-node__remove"
            aria-label="移除提示词生成与优化节点"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onRemove(node.key);
            }}
          >
            <X size={12} weight="bold" aria-hidden="true" />
          </button>
        </span>
      </div>

      <div className="canvas-prompt-node__body">
        <div className="canvas-prompt-node__intro">
          <strong>把创意变成可执行的提示词</strong>
          <span>
            选择生成或优化；连入图片辅助视觉理解，连接视频节点后参考图会随提示词自动传递。
          </span>
        </div>
        {sourceConnections.length > 0 ? (
          <div className="canvas-prompt-node__connections">
            <span>参考图片（视觉理解）</span>
            <ul aria-label="已连入的参考图片素材">
              {sourceConnections.map((connection) => (
                <li key={connection.edgeId}>
                  <span>{connection.name}</span>
                  <button
                    type="button"
                    aria-label={`解除连线：${connection.name}`}
                    onMouseDown={(event) => event.stopPropagation()}
                    onClick={() => onUnlink(connection.edgeId)}
                  >
                    <X size={12} weight="bold" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="canvas-prompt-node__task" role="group" aria-label="提示词操作">
          <button
            type="button"
            aria-pressed={node.config.task === "generate"}
            className={node.config.task === "generate" ? "is-active" : ""}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => onChange({ ...node.config, task: "generate" })}
          >
            生成
          </button>
          <button
            type="button"
            aria-pressed={node.config.task === "optimize"}
            className={node.config.task === "optimize" ? "is-active" : ""}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => onChange({ ...node.config, task: "optimize" })}
          >
            优化
          </button>
        </div>
        <label className="canvas-prompt-node__field">
          <span>{node.config.task === "generate" ? "创意 / 需求" : "待优化提示词"}</span>
          <textarea
            aria-label={node.config.task === "generate" ? "创意或需求" : "待优化提示词"}
            placeholder={
              node.config.task === "generate"
                ? "例如：雨夜站台，女孩撑伞等候列车，电影感"
                : "粘贴一段已有提示词，补充镜头、主体和风格细节"
            }
            value={node.config.sourcePrompt}
            onChange={(event) => onChange({ ...node.config, sourcePrompt: event.target.value })}
          />
        </label>
        <div className="canvas-prompt-node__fields">
          <label className="canvas-prompt-node__field">
            <span>文本模型供应商</span>
            <select
              aria-label="提示词文本模型供应商"
              value={node.config.modelSelection.providerId}
              onChange={(event) => {
                const providerId = event.target.value;
                const modelDefinitionId =
                  textModelProviders.find((entry) => entry.provider.id === providerId)?.models[0]
                    ?.definitionId ?? "";
                onChange({
                  ...node.config,
                  modelSelection: { providerId, modelDefinitionId },
                });
              }}
            >
              {!node.config.modelSelection.providerId ? (
                <option value="">请选择供应商</option>
              ) : null}
              {node.config.modelSelection.providerId && !selectedProvider ? (
                <option value={node.config.modelSelection.providerId}>
                  {node.config.modelSelection.providerId}（不可用）
                </option>
              ) : null}
              {textModelProviders.map((entry) => (
                <option key={entry.provider.id} value={entry.provider.id}>
                  {entry.provider.displayName}
                </option>
              ))}
            </select>
          </label>
          <label className="canvas-prompt-node__field">
            <span>文本模型</span>
            <select
              aria-label="提示词文本模型"
              value={node.config.modelSelection.modelDefinitionId}
              onChange={(event) =>
                onChange({
                  ...node.config,
                  modelSelection: {
                    ...node.config.modelSelection,
                    modelDefinitionId: event.target.value,
                  },
                })
              }
            >
              {!node.config.modelSelection.modelDefinitionId ? (
                <option value="">
                  {availableModels.length > 0 ? "请选择文本模型" : "没有可用文本模型"}
                </option>
              ) : null}
              {node.config.modelSelection.modelDefinitionId && !selectedModel ? (
                <option value={node.config.modelSelection.modelDefinitionId}>
                  {node.config.modelSelection.modelDefinitionId}（不可用）
                </option>
              ) : null}
              {availableModels.map((model) => (
                <option key={model.definitionId} value={model.definitionId}>
                  {model.displayName}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="canvas-prompt-node__field">
          <span>提示词技能模式</span>
          <select
            aria-label="提示词技能模式"
            value={node.config.mode}
            onChange={(event) =>
              onChange({
                ...node.config,
                mode: event.target.value as PromptOptimizationMode,
              })
            }
          >
            {(Object.keys(PROMPT_OPTIMIZATION_MODE_LABELS) as PromptOptimizationMode[]).map(
              (mode) => (
                <option key={mode} value={mode}>
                  {PROMPT_OPTIMIZATION_MODE_LABELS[mode]}
                </option>
              ),
            )}
          </select>
        </label>
        <div className="canvas-prompt-node__field">
          <label htmlFor={promptOutputId}>输出提示词</label>
          <div className="canvas-prompt-node__output-editor">
            <textarea
              id={promptOutputId}
              aria-label="生成提示词输出"
              className="canvas-prompt-node__output"
              placeholder="调用文本模型后，生成结果会出现在这里；也可以直接编辑"
              value={node.config.generatedPrompt}
              disabled={auditBusy}
              onChange={(event) =>
                onChange({ ...node.config, generatedPrompt: event.target.value })
              }
            />
          </div>
          <div className="canvas-prompt-node__output-actions">
            <button
              type="button"
              className="canvas-prompt-node__audit-button"
              aria-label="审计当前输出提示词"
              aria-describedby={auditStatusId}
              data-visual="solid"
              data-state={
                auditBusy ? "loading" : auditUnavailableReason ? "unavailable" : undefined
              }
              disabled={auditUnavailableReason != null}
              title={auditHelpText}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onSelect(node.key);
                onAudit(node.key);
              }}
            >
              {auditBusy ? (
                <CircleNotch size={13} weight="bold" aria-hidden="true" className="spin-icon" />
              ) : (
                <MagnifyingGlass size={13} weight="bold" aria-hidden="true" />
              )}
              <span>{auditBusy ? "审计中" : "审计"}</span>
            </button>
          </div>
        </div>
        {audit && audit.status !== "idle" ? (
          <PromptAuditPanel
            state={audit}
            onAudit={() => onAudit(node.key)}
            onApply={() => onApplyAudit(node.key)}
            onDiscard={() => onDiscardAudit(node.key)}
          />
        ) : null}
        <div
          id={auditStatusId}
          className="canvas-prompt-node__status"
          role="status"
          aria-live="polite"
        >
          <span
            className={
              auditUnavailableReason == null && node.config.generatedPrompt ? "is-ready" : ""
            }
          >
            {promptStatusText}
          </span>
        </div>
        {error ? (
          <pre className="raw-error canvas-prompt-node__error" role="alert" tabIndex={0}>
            {error}
          </pre>
        ) : null}
        {targetConnections.length > 0 ? (
          <div className="canvas-prompt-node__connections">
            <span>已连接目标</span>
            <ul aria-label="已连接的生成节点">
              {targetConnections.map((connection) => (
                <li key={connection.edgeId}>
                  <span>
                    {connection.kind === "image" ? "图片" : "视频"}节点 · {connection.name}
                  </span>
                  <button
                    type="button"
                    aria-label={`解除连线：${connection.name}`}
                    onMouseDown={(event) => event.stopPropagation()}
                    onClick={() => onUnlink(connection.edgeId)}
                  >
                    <X size={12} weight="bold" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
      <button
        type="button"
        className="node-port node-port--right node-port--prompt canvas-prompt-node__port"
        aria-label="拖出提示词连线"
        title="拖到图片或视频生成节点，自动导入输出提示词；视频节点同时继承视觉参考图"
        onMouseDown={(event) => {
          event.stopPropagation();
          onConnectionStart(node.key);
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <span className="sr-only">拖出提示词连线</span>
      </button>
    </div>
  );
}
