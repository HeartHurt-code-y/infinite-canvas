import { BookOpenText } from "@phosphor-icons/react/BookOpenText";
import { CircleNotch } from "@phosphor-icons/react/CircleNotch";
import { DownloadSimple } from "@phosphor-icons/react/DownloadSimple";
import { FilmSlate } from "@phosphor-icons/react/FilmSlate";
import { FilmStrip } from "@phosphor-icons/react/FilmStrip";
import { FileText } from "@phosphor-icons/react/FileText";
import { ImageSquare } from "@phosphor-icons/react/ImageSquare";
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

import { NodeTypeIcon } from "./PromptNodeViews";
import type {
  AssetKind,
  CanvasNodeDimensions,
  ConnectedScreenplayInput,
  DocumentSkillNodeData,
  GenNodeData,
  PromptNodeConfig,
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
  promptConversationRoleLabel,
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
  if (identity.startsWith("gemini")) return "当前所选模型接口可读取全部受支持格式。";
  if (identity.startsWith("claude")) return "当前所选模型接口可读取图片、PDF 与文本。";
  if (identity.includes("audio")) {
    return "当前所选模型接口可读取图片、MP3 / WAV 与文本；视频或 PDF 请在项目供应商中选择支持该格式的模型。";
  }
  return "当前所选模型接口可读取图片与文本；音视频或 PDF 请在项目供应商中选择支持该格式的模型。";
}

/** 内置技能文档节点：完整多轮对话、可编辑稿件和 Markdown 导出。 */
export function CanvasDocumentSkillNode({
  node,
  selected,
  dragging,
  running,
  error,
  providerCatalog,
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
  onExport,
}: {
  readonly node: DocumentSkillNodeData;
  readonly selected: boolean;
  readonly dragging: boolean;
  readonly running: boolean;
  readonly error: string | null;
  readonly providerCatalog: readonly ProviderCatalogEntry[];
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
  /** 文档区视图：默认「预览」渲染 Markdown；无内容或用户主动编辑时切回「编辑」。 */
  const [documentMode, setDocumentMode] = useState<"edit" | "preview">("preview");
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
  // 文档区视图：无稿件时始终落在「编辑」，方便粘贴；有稿件时按用户选择的 预览/编辑 展示。
  const hasDocument = node.config.currentDocument.trim().length > 0;
  const effectiveDocumentMode = hasDocument ? documentMode : "edit";

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
      aria-busy={running || exporting}
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
          className="canvas-screenplay-node__conversation nodrag"
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
            disabled={running}
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
                disabled={running || pickingMaterials || materials.length >= 8}
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
                      disabled={running}
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
              <p>图片、音频、视频、PDF、TXT / Markdown；最多 8 项、合计 14 MB。</p>
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
            <span className="canvas-screenplay-node__document-tools">
              <span
                className="canvas-screenplay-node__document-mode"
                role="group"
                aria-label={`${copy.currentDocumentLabel}视图`}
              >
                <button
                  type="button"
                  aria-pressed={effectiveDocumentMode === "edit"}
                  title="切换到 Markdown 源码编辑"
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={() => setDocumentMode("edit")}
                >
                  编辑
                </button>
                <button
                  type="button"
                  aria-pressed={effectiveDocumentMode === "preview"}
                  title="切换到 Markdown 渲染预览"
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={() => setDocumentMode("preview")}
                >
                  预览
                </button>
              </span>
            </span>
          </div>
          {effectiveDocumentMode === "preview" ? (
            <div
              className="canvas-screenplay-node__document-preview nodrag"
              role="region"
              aria-label={`${copy.currentDocumentLabel}预览`}
            >
              <MarkdownView content={node.config.currentDocument} />
            </div>
          ) : (
            <textarea
              id={`document-skill-document-${node.key}`}
              aria-label={copy.currentDocumentLabel}
              placeholder={copy.documentPlaceholder}
              value={node.config.currentDocument}
              disabled={running}
              onChange={(event) => {
                setDocumentMode("edit");
                onChange({ ...node.config, currentDocument: event.target.value });
              }}
            />
          )}
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
  /** 文档区视图：默认「预览」渲染 Markdown；无内容或用户主动编辑时切回「编辑」。 */
  const [documentMode, setDocumentMode] = useState<"edit" | "preview">("preview");
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
  // 文档区视图：无稿件时始终落在「编辑」，方便粘贴；有稿件时按用户选择的 预览/编辑 展示。
  const hasDocument = node.config.currentDocument.trim().length > 0;
  const effectiveDocumentMode = hasDocument ? documentMode : "edit";

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
            <label htmlFor={`viral-remix-document-${node.key}`}>当前复刻方案</label>
            <span className="canvas-screenplay-node__document-tools">
              <span
                className="canvas-screenplay-node__document-mode"
                role="group"
                aria-label="当前复刻方案视图"
              >
                <button
                  type="button"
                  aria-pressed={effectiveDocumentMode === "edit"}
                  title="切换到 Markdown 源码编辑"
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={() => setDocumentMode("edit")}
                >
                  编辑
                </button>
                <button
                  type="button"
                  aria-pressed={effectiveDocumentMode === "preview"}
                  title="切换到 Markdown 渲染预览"
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={() => setDocumentMode("preview")}
                >
                  预览
                </button>
              </span>
              <span className="canvas-screenplay-node__document-hint">可编辑 · 可导出</span>
            </span>
          </div>
          {effectiveDocumentMode === "preview" ? (
            <div
              className="canvas-screenplay-node__document-preview nodrag"
              role="region"
              aria-label="当前复刻方案预览"
            >
              <MarkdownView content={node.config.currentDocument} />
            </div>
          ) : (
            <textarea
              id={`viral-remix-document-${node.key}`}
              aria-label="当前爆款视频复刻方案"
              placeholder="连接视频并运行后，将在这里生成逐秒复刻提示词、爆点诊断和三条二创路线。"
              value={node.config.currentDocument}
              disabled={running}
              onChange={(event) => {
                setDocumentMode("edit");
                onChange({ ...node.config, currentDocument: event.target.value });
              }}
            />
          )}
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
  onSelect,
  onNodeDragStart,
  onRemove,
  onUnlink,
  onConnectionStart,
  onSizeChange,
  onChange,
  onRun,
}: {
  readonly node: Extract<GenNodeData, { kind: "prompt" }>;
  readonly descriptor: StaticNodeDescriptor;
  readonly selected: boolean;
  readonly dragging: boolean;
  readonly running: boolean;
  readonly error: string | null;
  readonly providerCatalog: readonly ProviderCatalogEntry[];
  /** 连入本节点的图片素材与图片/视频产物（多模态理解参考，按连线建立顺序）。 */
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
  const isFpvPath = node.config.mode === "fpv_path";
  const isFightPromptMaster = node.config.mode === "fight_prompt_master";
  const isMultiGridStoryboard = node.config.mode === "multi_grid_storyboard";
  const isStoryboardPrompt = node.config.mode === "storyboard_prompt";
  const hasModeHint =
    isFpvPath || isFightPromptMaster || isMultiGridStoryboard || isStoryboardPrompt;
  const modeHintId = `prompt-mode-hint-${node.key}`;
  const conversation = node.config.conversation ?? [];
  const conversationRef = useRef<HTMLDivElement>(null);
  const promptOutputId = `prompt-output-${node.key}`;
  const promptStatusText = node.config.generatedPrompt
    ? `已生成 ${node.config.generatedPrompt.length} 字${conversation.length > 0 ? `，累计 ${conversation.length} 条对话` : ""}${sourceConnections.length > 0 ? `，并携带 ${sourceConnections.length} 个参考素材` : ""}`
    : "输出会作为下游节点的提示词请求参数";

  // 新消息出现时把对话区滚动到底部。
  useEffect(() => {
    const element = conversationRef.current;
    if (element == null) return;
    element.scrollTop = element.scrollHeight;
  }, [conversation.length, running]);

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
      aria-busy={running}
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
            disabled={running || !selectionReady}
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
          <strong>
            {isFpvPath ? "沿参考路径规划第一人称飞行镜头" : "把创意变成可执行的提示词"}
          </strong>
          <span>
            {isFpvPath
              ? "连接带红线或箭头的场景图，保留路径标记用于分析；也可直接描述路线。生成参考图版、纯文字版提示词，以及时长建议、运镜时间线和速度节奏。"
              : "支持多轮对话：每次生成或优化都会携带之前的全部对话；连入图片素材或已生成的图片/视频产物辅助多模态理解，最新输出自动下发到连接的图片或视频节点。"}
          </span>
        </div>
        {sourceConnections.length > 0 ? (
          <div className="canvas-prompt-node__connections">
            <span>参考素材（多模态理解）</span>
            <ul aria-label="已连入的参考素材">
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
        <div
          ref={conversationRef}
          className="canvas-screenplay-node__conversation canvas-prompt-node__conversation nodrag"
          role="log"
          aria-label="提示词多轮对话"
          aria-live="polite"
        >
          {conversation.length === 0 ? (
            <div className="canvas-screenplay-node__empty">
              <strong>
                {isFpvPath
                  ? "连接路径图，或写下起点、途经点和终点"
                  : isFightPromptMaster
                    ? "描述一场打斗，或连接角色、场景与动作参考素材"
                    : isMultiGridStoryboard
                      ? "提供剧情，或连接角色、场景与视频参考素材"
                      : isStoryboardPrompt
                        ? "描述故事与用途，或连接角色、场景与风格参考素材"
                        : "从一句创意或待优化提示词开始"}
              </strong>
              <span>每一轮都会带上之前的全部对话；最新输出会自动下发给连接的图片或视频节点。</span>
            </div>
          ) : (
            conversation.map((entry) => (
              <article
                key={entry.id}
                className={`canvas-screenplay-node__message is-${entry.role}`}
              >
                <span>{promptConversationRoleLabel(entry.role)}</span>
                <MarkdownView content={entry.content} />
              </article>
            ))
          )}
          {running ? (
            <div className="canvas-screenplay-node__thinking" role="status">
              <CircleNotch size={14} weight="bold" aria-hidden="true" className="spin-icon" />
              正在调用文本模型…
            </div>
          ) : null}
        </div>
        <label className="canvas-prompt-node__field">
          <span>{node.config.task === "generate" ? "创意 / 需求" : "待优化提示词"}</span>
          <textarea
            aria-label={node.config.task === "generate" ? "创意或需求" : "待优化提示词"}
            aria-describedby={hasModeHint ? modeHintId : undefined}
            placeholder={
              isFpvPath
                ? node.config.task === "generate"
                  ? "例如：沿红线贴地切入，绕过塔楼后拉升到屋顶，15 秒一镜到底；已连接路径图时可直接生成"
                  : "粘贴飞行提示词或填写修改要求，例如：保留路线，放慢环绕；留空可优化当前输出"
                : isFightPromptMaster
                  ? node.config.task === "generate"
                    ? "例如：SD2.5，15 秒，超高速；雨夜站台双人近战。已连接参考素材时可直接生成"
                    : "粘贴打斗提示词或填写修改要求，例如：加强攻防因果，减少镜头切换；留空可优化当前输出"
                  : isMultiGridStoryboard
                    ? node.config.task === "generate"
                      ? "例如：6 宫格，12 秒，电影写实；女孩走进雨夜站台，发现遗落的信封。已连接参考素材时可直接生成"
                      : "粘贴分镜方案或填写修改要求，例如：保留角色与总时长，强化最后一格；留空可优化当前输出"
                    : isStoryboardPrompt
                      ? node.config.task === "generate"
                        ? "例如：咖啡品牌广告，6 格故事板，清晨出发到温暖重逢，16:9，手绘风格；已连接参考素材时可直接生成"
                        : "粘贴故事板提示词或填写修改要求，例如：保留角色与版式，加强最后一格的情绪；留空可优化当前输出"
                      : node.config.task === "generate"
                        ? "例如：雨夜站台，女孩撑伞等候列车，电影感"
                        : "粘贴一段已有提示词，补充镜头、主体和风格细节"
            }
            value={node.config.sourcePrompt}
            disabled={running}
            onChange={(event) => onChange({ ...node.config, sourcePrompt: event.target.value })}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                event.preventDefault();
                onRun(node.key);
              }
            }}
          />
        </label>
        <div className="canvas-screenplay-node__composer-actions canvas-prompt-node__composer-actions">
          <span>Ctrl / ⌘ + Enter 发送 · 每轮自动携带全部对话上下文</span>
        </div>
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
            aria-describedby={hasModeHint ? modeHintId : undefined}
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
        {isFpvPath ? (
          <div id={modeHintId} className="canvas-prompt-node__intro">
            <span>
              读图请使用支持图片理解的文本模型。默认按 15
              秒规划，可在需求中调整；复杂路线会建议分段并保留关键途经点。路径图仅用于分析；视频需要参考图时，请将干净场景图直接连接到视频节点。
            </span>
          </div>
        ) : isFightPromptMaster ? (
          <div id={modeHintId} className="canvas-prompt-node__intro">
            <span>
              在对话中指定目标视频模型（SD2.0 / SD2.5 /
              H3）、时长和速度档，缺失时会先补问；默认交付高强度、中间型、慢节奏三套方案。参考图片与视频画面需使用支持图片理解的文本模型。
            </span>
          </div>
        ) : isMultiGridStoryboard ? (
          <div id={modeHintId} className="canvas-prompt-node__intro">
            <span>
              在对话中指定 4 / 6 / 9
              宫格、目标时长和风格，已填写的参数会继续沿用；生成图片与视频两套提示词。参考图片与视频画面需使用支持图片理解的文本模型。
            </span>
          </div>
        ) : isStoryboardPrompt ? (
          <div id={modeHintId} className="canvas-prompt-node__intro">
            <span>
              按电影、广告、短剧、动画、漫画、品牌、MV、游戏、社交、教程、体育或国漫视觉开发场景组织画面，输出可直接交给图片节点的整张故事板提示词。可指定格数、画幅与风格；参考图片与视频画面需使用支持图片理解的文本模型。
            </span>
          </div>
        ) : null}
        <div className="canvas-prompt-node__field">
          <label htmlFor={promptOutputId}>输出提示词</label>
          <div className="canvas-prompt-node__output-editor">
            <textarea
              id={promptOutputId}
              aria-label="生成提示词输出"
              className="canvas-prompt-node__output"
              placeholder="调用文本模型后，生成结果会出现在这里；也可以直接编辑"
              value={node.config.generatedPrompt}
              onChange={(event) =>
                onChange({ ...node.config, generatedPrompt: event.target.value })
              }
            />
          </div>
        </div>
        <div className="canvas-prompt-node__status" role="status" aria-live="polite">
          <span className={node.config.generatedPrompt ? "is-ready" : ""}>{promptStatusText}</span>
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
        title={
          isFpvPath
            ? "拖到图片或视频生成节点，自动导入输出提示词；FPV 路径图仅用于分析，视频参考图请直接连接"
            : "拖到图片或视频生成节点，自动导入输出提示词；视频节点同时继承视觉参考图"
        }
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
