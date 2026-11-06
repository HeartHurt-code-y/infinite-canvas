import { ImageLightbox } from "../../components/ImageLightbox";
import { CanvasNodeActionsMenu } from "./CanvasNodeActionsMenu";
import { useReferenceMediaPreview } from "./ReferenceMediaPreview";
import { Icon } from "../../components/Icon";
import { ErrorAlert } from "../../components/ErrorAlert";
import { useModalFocusTrap } from "../../components/useModalFocusTrap";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { toast } from "../../lib/toast";
import { toMediaProxyUrl } from "../../lib/mediaProxy";
import { prepareCanvasMediaSource } from "../../lib/videoLocalEdit";
import { CanvasChromeIcon } from "./CanvasChromeIcons";
import { LibTVMediaIcon } from "./LibTVMediaIcon";
import { CanvasVideoTools } from "./CanvasVideoTools";
import { videoCameraPresetsMuted } from "../../lib/videoCameraPresets";
import { CanvasVideoPromptTools } from "./CanvasVideoPromptTools";
import { CanvasReferenceTools, type CanvasReferenceToolsHandle } from "./CanvasReferenceTools";
import { CanvasImageTools } from "./CanvasImageTools";
import { CanvasImagePresetBadge } from "./CanvasImagePresetMenu";
import { CanvasCameraControlBadge } from "./CanvasCameraControl";
import { saveCanvasCameraPreferences } from "../../lib/canvasCameraControl";
import { canvasImagePreset, CANVAS_IMAGE_PROMPT_PLACEHOLDER } from "../../lib/canvasImagePresets";
import { compileCanvasVideoMode } from "../../lib/canvasVideoMode";
import { DEFAULT_LONG_VIDEO } from "../../lib/longVideo";
import { isSeedreamProImageModel, seedreamProParameterIssue } from "../../lib/seedreamPro";
import { GPT_IMAGE_25_PROFILE, gptImage25Size, gptImage25SizeIssue } from "../../lib/gptImage25";
import { LongVideoProcess } from "./LongVideoProcess";
import "./CanvasGenEditor.css";
import {
  backendErrorMessage,
  formatBytes,
  formatRawBackendError,
  formatSaveProgress,
  frontendLog,
  isDesktopRuntime,
  mediaClient,
  refreshMediaUrlWithStagingFallback,
  resumeGenerationResult,
  toMediaSrc,
  type GenerationResultRecord,
  type GenerationResultSaveProgress,
  type GenerationTaskSummary,
  type MediaReferenceTarget,
  type ProviderCatalogEntry,
} from "../../lib/backend";
import type { PromptContentEditorSession, PromptContentModule } from "../../lib/promptContent";

import { AssetMediaState } from "./AssetLibraryViews";
import {
  copyTextToDesktopClipboard,
  revealDesktopItem,
  exportArtifactToDesktop,
} from "./desktopActions";
import { NodeNameEditor } from "./NodeNameEditor";
import { artifactFileName } from "./artifactNames";
import { localAssetNodeMediaUrl, signedUrlExpired } from "./localAssetMedia";
import { useMediaByteSource } from "./mediaByteCache";
import { VideoMiddleFrame } from "./VideoMiddleFrame";
import { CanvasVideoFrameCrop } from "./CanvasVideoFrameCrop";
import { CanvasMediaNodeTitle, MediaGenerationPreview, MediaNodeTaskStatus, generationTaskNeedsAttention, nodeStatusTasks } from "./VideoGenerationNode";
import type { CanvasInlineFeatureRequest } from "./canvasFeatureCatalog";
import { CanvasNodeEditorShell } from "./CanvasNodeEditor";
import { CanvasLibraryResourceInputs } from "./CanvasLibraryResourceCard";
import type { ConnectedLibraryResource } from "./canvasLibraryResources";
import { useLocalVideoPoster, useMediaFileFingerprint } from "./localVideoPoster";
import { isVideoSourceUrl, useNodeInView } from "./mediaPreview";
import {
  AssetKindIcon,
  ImageNodeSettings,
  NodeTypeIcon,
  PromptMentionInput,
  VideoNodeSettings,
} from "./PromptNodeViews";
import type {
  AssetKind,
  AssetNodeData,
  CanvasNodeDimensions,
  ConnectedAssetInput,
  GenNodeData,
  ImageNodeConfig,
  InheritedAssetInput,
  MentionCandidate,
  OutputNodeData,
  ResultNodeData,
  RetryInfo,
  StaticNodeDescriptor,
  VideoNodeConfig,
} from "./workspaceModel";
import {
  ASSET_KIND_LABELS,
  SAVE_STATUS_LABELS,
  TASK_STATUS_LABELS,
  assetNodeDimensions,
  assetNodeReferenceTarget,
  fileBaseName,
  fileNameFromPath,
  formatTaskClock,
  isReviewTaskId,
  isRunningTaskStatus,
  measuredAspectRatio,
  outputNodeDimensions,
  outputNodeReferenceTarget,
  shortenTaskId,
  textResultFromSource,
} from "./workspaceModel";

import type { GreenScreenResult } from "./GreenScreenSection";

export function CanvasGenNode({
  canvasId,
  node,
  descriptor,
  selected,
  starting,
  activeTask,
  latestTask,
  tasks,
  onOpenTask,
  onPromoteSeedanceDraft,
  connectedInputs,
  libraryResources,
  inheritedInputs,
  inputSlotPositions,
  mentionCandidates,
  aliveCanvasNodeKeys,
  promptSourceName,
  registerPromptInput,
  providerCatalog,
  onSelect,
  onEdit,
  onNodeDragStart,
  onRemove,
  onUnlink,
  onReorderInput,
  onSizeChange,
  onImageConfigChange,
  onOpenCharacterStudio,
  onVideoConfigChange,
  onAnnotateVideo,
  greenScreenResults,
  onGreenScreenUseResult,
  onImportGreenScreenVideo,
  onStartGeneration,
  startError,
  onRename,
  presentation = "card",
  editorOpen = selected,
  onCloseEditor,
  promptContents,
  previewOutput,
  onSelectImageResult,
  onPreviewImage,
  onEnhanceImage,
  onEditImageRegion,
  featureRequest,
}: {
  readonly featureRequest?: CanvasInlineFeatureRequest | undefined;
  readonly canvasId: string;
  readonly node: Extract<GenNodeData, { kind: "image" | "video" }>;
  readonly descriptor: StaticNodeDescriptor;
  readonly selected: boolean;
  readonly dragging: boolean;
  readonly starting: boolean;
  readonly startError: string | null;
  readonly activeTask: GenerationTaskSummary | null;
  readonly latestTask?: GenerationTaskSummary | null | undefined;
  readonly tasks: readonly GenerationTaskSummary[];
  readonly onOpenTask: (taskId: string) => void;
  readonly onPromoteSeedanceDraft: (taskId: string) => Promise<string>;
  readonly connectedInputs: readonly ConnectedAssetInput[];
  readonly libraryResources: readonly ConnectedLibraryResource[];
  readonly inheritedInputs: readonly InheritedAssetInput[];
  /** 直连素材在其槽位表里的位置；参考清单据此保留空位、不自动上移。 */
  readonly inputSlotPositions?: ReadonlyMap<string, number> | undefined;
  readonly mentionCandidates: readonly MentionCandidate[];
  /** 画布上仍然存在的节点 key；用于把已删除素材的失效引用按同源身份重连。 */
  readonly aliveCanvasNodeKeys?: ReadonlySet<string> | undefined;
  readonly promptSourceName?: string | undefined;
  readonly registerPromptInput: (
    nodeKey: string,
    session: PromptContentEditorSession | null,
  ) => void;
  readonly providerCatalog: readonly ProviderCatalogEntry[];
  readonly onSelect: (key: string) => void;
  readonly onEdit?: ((key: string) => void) | undefined;
  readonly onNodeDragStart: (
    key: string,
    x: number,
    y: number,
    clientX: number,
    clientY: number,
  ) => void;
  readonly onRemove: (key: string) => void;
  readonly onUnlink: (edgeId: string) => void;
  readonly onReorderInput: (nodeKey: string, sourceKey: string, targetKey: string) => void;
  readonly onSizeChange: (key: string, dimensions: CanvasNodeDimensions) => void;
  readonly onImageConfigChange: (key: string, config: ImageNodeConfig) => void;
  readonly onOpenCharacterStudio: (key: string) => void;
  readonly onVideoConfigChange: (key: string, config: VideoNodeConfig) => void;
  readonly greenScreenResults?: readonly GreenScreenResult[] | undefined;
  readonly onGreenScreenUseResult?: ((nodeKey: string, key: string) => void) | undefined;
  readonly onImportGreenScreenVideo?: ((nodeKey: string) => void) | undefined;
  readonly onAnnotateVideo?: (
    nodeKey: string,
    input: ConnectedAssetInput | InheritedAssetInput,
  ) => void;
  readonly onStartGeneration: (key: string) => void;
  readonly onRename?: ((key: string, name: string) => void) | undefined;
  readonly presentation?: "card" | "editor";
  readonly editorOpen?: boolean;
  readonly onCloseEditor?: (() => void) | undefined;
  readonly promptContents?: PromptContentModule | undefined;
  readonly previewOutput?: OutputNodeData | null | undefined;
  readonly onSelectImageResult: (key: string, resultKey: string) => void;
  readonly onPreviewImage: (key: string) => void;
  readonly onEnhanceImage: (key: string, preview: OutputNodeData) => void;
  readonly onEditImageRegion: import("./CanvasImageRegionEditor").StartImageRegionEdit;
}) {
  const isVideo = node.kind === "video";
  const submissionBusy = starting || (isVideo && activeTask != null);
  const statusTasks = node.kind === "image" && node.imageGeneration
    ? tasks.filter(task => node.imageGeneration?.taskIds.includes(task.id))
    : nodeStatusTasks(tasks, latestTask);
  const effectiveInputs = [...connectedInputs, ...inheritedInputs];
  const linkedEffects = libraryResources.flatMap(({ resource }) => resource.kind === "effect" ? [resource.versionId] : []);
  const linkedStyle = libraryResources.some(({ resource }) => resource.kind === "style");
  /** 提示词编辑会话：参考瓦片上的「@」按钮要靠它往提示词里插引用。 */
  const promptSessionRef = useRef<PromptContentEditorSession | null>(null);
  const presetReferenceRef = useRef<CanvasReferenceToolsHandle>(null);
  const imagePresetTriggerRef = useRef<HTMLButtonElement>(null);
  const imageCameraTriggerRef = useRef<HTMLButtonElement>(null);
  const [cameraOpenRequestId, setCameraOpenRequestId] = useState(0);
  const handlePromptSession = useCallback((session: PromptContentEditorSession | null) => {
    promptSessionRef.current = session;
  }, []);
  const reorderableKeys = new Set(
    connectedInputs
      .filter((input) => input.edgeId === `${input.key}->${node.key}`)
      .map((input) => input.key),
  );
  const referenceInputCount = effectiveInputs.length;
  const imageModel = !isVideo ? providerCatalog.find(entry => entry.provider.id === node.config.modelSelection.providerId)?.models.find(model => model.definitionId === node.config.modelSelection.modelDefinitionId) : undefined;
  const seedreamProContract = imageModel && Object.values(imageModel.operationSchema).some(operation =>
    (operation as Record<string, unknown> | undefined)?.["requestProfileId"] === "moyu_seedream_image_v1");
  const imageParameterIssue = !isVideo && node.config.imageMode !== "upscale" && imageModel && seedreamProContract && isSeedreamProImageModel(imageModel.remoteModelId)
    ? seedreamProParameterIssue(node.config.parameterValues)
    : !isVideo && node.config.imageMode !== "upscale" && imageModel && Object.values(imageModel.operationSchema).some(operation => (operation as Record<string, unknown> | undefined)?.["requestProfileId"] === GPT_IMAGE_25_PROFILE)
      ? gptImage25SizeIssue(gptImage25Size(node.config.parameterValues)) : null;
  const promptLabelId = `${node.kind}-prompt-label-${node.key}`;
  const promptHintId = `${node.kind}-prompt-hint-${node.key}`;
  const selectionReady = !isVideo && node.config.imageMode === "upscale"
    ? providerCatalog.some(entry => entry.provider.enabled && entry.provider.adapterId === "atlascloud_v1" && (!node.config.upscaleProviderId || node.config.upscaleProviderId === entry.provider.id))
    : Boolean(node.config.modelSelection.providerId && node.config.modelSelection.modelDefinitionId);
  if (presentation === "card") {
    return (
      <><MediaGenerationPreview
        featureRequest={featureRequest}
        node={node}
        selected={selected}
        editing={editorOpen}
        starting={starting}
        activeTask={activeTask}
        latestTask={latestTask}
        tasks={tasks}
        onOpenTask={onOpenTask}
        onPromoteSeedanceDraft={onPromoteSeedanceDraft}
        inputs={effectiveInputs}
        output={previewOutput}
        onPreviewResult={onPreviewImage}
        onEnhanceImage={onEnhanceImage}
        onEditImageRegion={onEditImageRegion}
        providerCatalog={providerCatalog}
        onCloseEditor={onCloseEditor}
        onSelectImageResult={onSelectImageResult}
        promptContents={promptContents}
        startError={startError}
        onSelect={onSelect}
        onEdit={onEdit}
        onNodeDragStart={onNodeDragStart}
        onSizeChange={onSizeChange}
        onRemove={onRemove}
        onRename={onRename}
        onVideoPreset={isVideo ? (preset) => {
          if (preset === "long") {
            onVideoConfigChange(node.key, { ...node.config, videoMode: "longVideo2video", generationCount: 1, longVideo: node.config.longVideo ?? { ...DEFAULT_LONG_VIDEO } });
            (onEdit ?? onSelect)(node.key);
            return;
          }
          const videoMode = preset === "frames" ? "first_last_frame" : "first_frame";
          const intent = compileCanvasVideoMode(videoMode, effectiveInputs, node.config.mediaRoles);
          onVideoConfigChange(node.key, { ...node.config, videoMode, seedanceTaskMode: intent.taskMode, mediaRoles: intent.mediaRoles });
          (onEdit ?? onSelect)(node.key);
          if (!effectiveInputs.some(input => input.kind === "image")) {
            void presetReferenceRef.current?.addVideoFrames(videoMode);
          }
        } : undefined}
        onImagePreset={!isVideo ? (mode) => {
          onImageConfigChange(node.key, { ...node.config, imageMode: mode === "upscale" ? "upscale" : "auto" });
          (onEdit ?? onSelect)(node.key);
          void presetReferenceRef.current?.addFiles();
        } : undefined}
      />
      <CanvasReferenceTools ref={presetReferenceRef} node={node} active={false} headless disabled={submissionBusy} />
      {isVideo ? <LongVideoProcess canvasId={canvasId} nodeKey={node.key} /> : null}</>
    );
  }

  const referenceChips = (
    <GenerationInputChips
        inputs={effectiveInputs}
        imageOnly={!isVideo}
        {...(isVideo && inputSlotPositions ? { positions: inputSlotPositions } : {})}
        onUnlink={onUnlink}
        onInsertReference={(input) => {
          // 原站的 @ 在参考瓦片上：点一下把这份参考插进提示词。
          const session = promptSessionRef.current;
          if (session == null) return;
          const candidate = mentionCandidates.find((item) => item.canvasNodeKey === input.key);
          if (candidate == null) return;
          session.insertReference(candidate);
        }}
        reorderableKeys={reorderableKeys}
        onReorder={(sourceKey, targetKey) => onReorderInput(node.key, sourceKey, targetKey)}
      />
  );
  const form = (
    <div className="video-node-editor__form" aria-busy={submissionBusy}
      data-video-camera-muted={isVideo && videoCameraPresetsMuted(node.config.videoMode ?? node.config.seedanceTaskMode) ? "true" : undefined}>
      {/*
        原站 liblib 编辑区（实测 2026-10-22，1707×898 / DPR 1.5）：
          面板根    flex flex-col gap-2 p-2（间隙 8 / 内边距 8）
          工具行    flex flex-wrap items-center gap-1 pl-1 pt-1
          缩略图行  nopan flex w-full min-w-0 flex-wrap items-start gap-2 pl-1
          提示词区  relative flex-1 overflow-hidden rounded-xl p-2 min-h-20
          底栏      flex w-full items-start gap-1
        本项目原来把「提示词」标签行放在最上面、素材缩略图排在提示词之后，
        这里按原站重排；标签行降级为仅供读屏使用（label / description 仍要挂上）。
      */}
      <div className="canvas-gen-node__tool-chips" role="group" aria-label="创作工具">
        {isVideo ? <CanvasVideoTools node={node} active={editorOpen} inputs={effectiveInputs} linkedEffects={linkedEffects} sessionRef={promptSessionRef} onAnnotateVideo={onAnnotateVideo} onOpenCharacterStudio={() => onOpenCharacterStudio(node.key)} onPromptChange={() => onVideoConfigChange(node.key, { ...node.config })} onEffectsChange={effectVersionIds => onVideoConfigChange(node.key, { ...node.config, effectVersionIds })} /> : <>
          <CanvasImageTools canvasId={canvasId} node={node} active={editorOpen} inputs={effectiveInputs} linkedStyle={linkedStyle} sessionRef={promptSessionRef} presetTriggerRef={imagePresetTriggerRef} cameraTriggerRef={imageCameraTriggerRef} cameraOpenRequestId={cameraOpenRequestId} providerCatalog={providerCatalog} onChange={config => onImageConfigChange(node.key, config)} />
          {node.config.imageMode !== "upscale" ? <button type="button" className="canvas-gen-node__tool-chip" aria-haspopup="dialog"
            onClick={() => onOpenCharacterStudio(node.key)}><LibTVMediaIcon name="asset-character" size={13} /><span>角色库</span></button> : null}
        </>}
      </div>
      {isVideo ? <div className="canvas-video-inputs" hidden={effectiveInputs.length === 0 && !node.config.effectVersionIds?.length}>
        {referenceChips}<div id={`video-effects-${node.key}`} className="canvas-video-effect-references" aria-label="已选特效" />
      </div> : referenceChips}
      <CanvasLibraryResourceInputs inputs={libraryResources} onUnlink={onUnlink} />
      <div className="canvas-gen-node__prompt-area">
        {/* 提示词是生成节点的唯一必填输入；原站编辑区没有可见标题，
            这里保留读屏用的标签与提示（aria-labelledby / aria-describedby 指向它们）。*/}
        <span id={promptLabelId} className="sr-only">
          提示词输入框，输入 @ 引用素材
        </span>
        <span id={promptHintId} className="sr-only">
          {promptSourceName
            ? inheritedInputs.length > 0
              ? `已接入提示词输出 · 自动继承 ${inheritedInputs.length} 张参考图`
              : `已接入 ${promptSourceName} 的输出`
            : referenceInputCount > 0
              ? `${referenceInputCount} 个参考素材已连接`
              : "输入 @ 引用素材"}
          {isVideo && videoCameraPresetsMuted(node.config.videoMode ?? node.config.seedanceTaskMode) ? "。当前模式下运镜标记暂不参与生成，切换模式后恢复。" : ""}
        </span>
        {!isVideo && node.config.imageMode !== "upscale" ? <CanvasCameraControlBadge config={node.config} onOpen={() => setCameraOpenRequestId(value => value + 1)} onDisable={() => {
          if (!node.config.cameraControl) return;
          const cameraControl = { ...node.config.cameraControl, enabled: false };
          onImageConfigChange(node.key, { ...node.config, cameraControl });
          saveCanvasCameraPreferences(cameraControl);
          imageCameraTriggerRef.current?.focus({ preventScroll: true });
        }} /> : null}
        {!isVideo && !linkedStyle && node.config.imageMode !== "upscale" && node.config.styleReference ? <div className="canvas-image-style-reference"><img src={node.config.styleReference.imageUrl} alt="" referrerPolicy="no-referrer" /><span>风格参考 · {node.config.styleReference.name}</span><button type="button" aria-label="移除风格参考" onClick={() => onImageConfigChange(node.key, { ...node.config, styleReference: undefined })}><LibTVMediaIcon name="close" size={12} /></button></div> : null}
        {!isVideo && node.config.imageMode === "upscale" && effectiveInputs.length === 0 ? <p className="canvas-image-upscale-hint">上传或连接一张需要放大的图片</p> : null}
        <div className="canvas-gen-node__prompt-input" hidden={!isVideo && node.config.imageMode === "upscale"}><PromptMentionInput
          nodeKey={node.key}
          candidates={mentionCandidates}
          aliveCanvasNodeKeys={aliveCanvasNodeKeys}
          registerInput={registerPromptInput}
          labelledBy={promptLabelId}
          describedBy={promptHintId}
          expandable={false}
          autoLink={node.config.autoLink !== false}
          leadingContent={!isVideo && node.config.imageMode !== "upscale" && node.config.imagePreset ? <CanvasImagePresetBadge config={node.config} active={editorOpen}
            onChange={config => onImageConfigChange(node.key, config)} onReopen={() => imagePresetTriggerRef.current?.click()}
            onClear={() => { onImageConfigChange(node.key, { ...node.config, imagePreset: undefined }); imagePresetTriggerRef.current?.focus({ preventScroll: true }); }} /> : null}
          placeholder={isVideo ? "描述你想要生成的画面内容，@引用素材" : canvasImagePreset(node.config.imagePreset?.scene)?.placeholder ?? CANVAS_IMAGE_PROMPT_PLACEHOLDER}
          onSession={handlePromptSession}
        /></div>
      </div>

      {startError ? (
        <div aria-label="发起任务失败">
          <ErrorAlert
            id={`generation-start-error-${node.key}`}
            error={startError}
            hint="检查提示词、素材和模型设置后重试；提交回执不明确时请在历史中核对原任务。"
          />
        </div>
      ) : null}

      <div className="canvas-gen-node__footer">
        {isVideo ? (
          <VideoNodeSettings
            active={editorOpen}
            advancedHostId={`video-advanced-${node.key}`}
            greenScreenResults={greenScreenResults}
            greenScreenBusy={starting || activeTask != null}
            onGreenScreenGenerate={() => onStartGeneration(node.key)}
            onGreenScreenUseResult={
              onGreenScreenUseResult ? (key) => onGreenScreenUseResult(node.key, key) : undefined
            }
            onImportGreenScreenVideo={
              onImportGreenScreenVideo ? () => onImportGreenScreenVideo(node.key) : undefined
            }
            config={node.config}
            providerCatalog={providerCatalog}
            mediaInputs={effectiveInputs}
            promptContents={promptContents}
            nodeKey={node.key}
            onChange={(config) => onVideoConfigChange(node.key, config)}
          />
        ) : (
          <div className="canvas-image-model-controls"><ImageNodeSettings
            presentation="compact"
            active={editorOpen}
            advancedHostId={`image-advanced-${node.key}`}
            config={node.config}
            providerCatalog={providerCatalog}
            hasMediaInputs={linkedStyle || effectiveInputs.some(
              (input) => input.kind === "image" || input.kind === "video",
            )}
            onChange={(config) => onImageConfigChange(node.key, config)}
          /><div id={`image-tools-${node.key}`} className="canvas-image-toolbar-actions canvas-image-creation-tools" /></div>
        )}
        <div className="canvas-gen-node__footer-actions">
          {isVideo ? <CanvasVideoPromptTools canvasId={canvasId} node={node} active={editorOpen} inputs={effectiveInputs} hasLinkedEffects={linkedEffects.length > 0} sessionRef={promptSessionRef} providerCatalog={providerCatalog} onChange={config => onVideoConfigChange(node.key, config)} /> : <div id={`image-translation-${node.key}`} className="canvas-image-toolbar-actions" />}
          {!isVideo ? <div id={`image-settings-${node.key}`} className="canvas-image-toolbar-actions" /> : null}
          <button
            type="button"
            className={`canvas-gen-node__start${starting ? " is-busy" : ""}`}
            data-canvas-generate=""
            aria-label={isVideo ? "开始视频生成" : node.config.imageMode === "upscale" ? "开始图片高清" : "开始图片生成"}
            aria-describedby={startError ? `generation-start-error-${node.key}` : undefined}
            data-state={starting ? "loading" : undefined}
            title={
              !selectionReady
                ? `请先选择可用的供应商和${isVideo ? "视频" : "图片"}模型`
                : isVideo
                  ? "点击开始视频生成"
                  : activeTask
                    ? "提交新的图片生成任务"
                    : "点击开始图片生成"
            }
            data-tooltip={imageParameterIssue ?? undefined}
            disabled={submissionBusy || !selectionReady || imageParameterIssue != null}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onSelect(node.key);
              onStartGeneration(node.key);
            }}
          >
            {starting ? (
              <LibTVMediaIcon name="icon-loading" className="spin-icon" size={20} />
            ) : (
              <CanvasChromeIcon name="arrow-up" size={14} />
            )}
          </button>
        </div>
      </div>
      <div id={`${isVideo ? "video" : "image"}-advanced-${node.key}`} hidden={!node.config.advancedOpen} />
      {starting || activeTask || statusTasks.some(generationTaskNeedsAttention) ? (
        <MediaNodeTaskStatus kind={node.kind} task={activeTask ?? latestTask ?? null} starting={starting}
          tasks={statusTasks}
          onOpenTask={onOpenTask} />
      ) : null}
    </div>
  );
  return (
    <CanvasNodeEditorShell
      nodeKey={node.key}
      kindLabel={isVideo ? "视频生成" : "图片生成"}
      anchor={{
        x: node.x,
        y: node.y,
        width: node.measured?.width ?? 622,
        height: node.measured?.height ?? 400,
      }}
      name={node.name ?? descriptor.kindLabel}
      open={editorOpen}
      onClose={() => onCloseEditor?.()}
    >
      {form}
    </CanvasNodeEditorShell>
  );
}

/** 本地图片缩略图：后端磁盘缓存（sha256 键）。卡片不能在等待或失败时解码原图。 */
const MEDIA_THUMBNAIL_MAX_DIMENSION = 512;

/**
 * 缩略图结果的存活时长：必须是**有限值**。
 *
 * 之前是 `staleTime: Infinity` —— 同一个路径在整个会话里只会问后端一次。
 * 于是后端「路径 + 大小 + 修改时间 + 边长」这套缓存键形同虚设：只要路径不变，
 * 前端永不再次调用 `create_media_thumbnail`，后端永远没机会重算 → 同路径内容被覆写后
 * 界面一直显示旧缩略图，而且整个会话不自愈。
 *
 * 取 5 分钟：内容变化主要由「内容指纹进查询键」发现（指纹变了就是新键），
 * 这个有限值只负责让「节点重新进入视口」这类事件能触发一次重新核对，不是轮询。
 */
const MEDIA_THUMBNAIL_STALE_TIME = 5 * 60 * 1000;

function useMediaThumbnailSrc(
  finalPath: string | null,
  visible = true,
): {
  readonly src: string | null;
  readonly unavailable: boolean;
} {
  const enabled = isDesktopRuntime() && finalPath != null && visible;
  /*
   * 内容指纹进查询键：查询键因此反映「内容身份」而不只是路径。
   * 同一路径的文件被改写（产物还在落盘、或被外部替换）→ 大小/修改时间变化 → 指纹变 →
   * 查询键变 → React Query 认为是另一条查询 → 重新向后端要一次缩略图。
   * 后端那边也按同一组数据建缓存键，于是两边的身份判定是一致的。
   */
  const fingerprint = useMediaFileFingerprint(finalPath, enabled);
  const { data, isError, isPending } = useQuery({
    queryKey: ["media-thumbnail", finalPath, MEDIA_THUMBNAIL_MAX_DIMENSION, fingerprint],
    queryFn: () => mediaClient.createThumbnail(finalPath as string, MEDIA_THUMBNAIL_MAX_DIMENSION),
    enabled: enabled && fingerprint != null,
    staleTime: MEDIA_THUMBNAIL_STALE_TIME,
    gcTime: 30 * 60 * 1000,
    retry: false,
  });
  /*
   * 三种状态必须分开：
   * · 还在问（指纹没算出来，或后端正在跑 ffmpeg 出首帧）→ 加载中；
   * · 后端明确答「这张缩不出来」（Ok(None)）或调用失败 → 确实不可用；
   * · 拿到缩略图 → 可用。
   *
   * 之前 `unavailable: enabled && (isError || data === null)` 把「还没问出结果」也算成
   * 不可用：产物还在落盘时后端会先答 None（源文件还不完整），节点于是先显示
   * 「预览不可用」，而那条 None 又因为 staleTime: Infinity 永远不会被推翻。
   */
  const loading = enabled && (isPending || fingerprint == null);
  return {
    src: data == null || finalPath == null ? null : toMediaSrc(data.path),
    unavailable: enabled && !loading && (isError || data === null),
  };
}

/**
 * 画布视频素材节点的可视化区域：
 * - 元数据加载后把视频 seek 到中点，用中间帧作为静止封面；
 * - 悬浮时从封面位置静音循环播放，移开后暂停并回到中间帧；
 * - `mountMedia` 为 false（节点滚出视口）时卸载 `<video>` 释放解码器，仅留占位。
 */
function CanvasAssetNodeVideoVisual({
  videoUrl,
  finalPath = null,
  localTarget = null,
  previewing,
  isRealAsset,
  mountMedia,
  onAspectRatioChange,
  onPixelSize,
  onLoadError,
}: {
  readonly videoUrl: string | null;
  /** 已保存的原视频路径：静止封面走原生缓存，只在悬浮时播放原文件。 */
  readonly finalPath?: string | null;
  readonly localTarget?: MediaReferenceTarget | null;
  readonly previewing: boolean;
  readonly isRealAsset: boolean;
  /** 节点是否在视口内（含余量）；false 时卸载视频元素。 */
  readonly mountMedia: boolean;
  readonly onAspectRatioChange: (aspectRatio: number) => void;
  readonly onPixelSize: (width: number, height: number) => void;
  /** 视频加载失败（签名过期等）：向上冒泡给节点触发一次性续签。 */
  readonly onLoadError?: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const wasPreviewingRef = useRef(false);
  const previewingRef = useRef(previewing);
  previewingRef.current = previewing;
  /** 中间帧时间戳（loadedmetadata 后记录），作为封面帧与悬浮复播/复位位置。 */
  const coverTimeRef = useRef(0);
  const [readyVideoUrl, setReadyVideoUrl] = useState<string | null>(null);
  // 云端 TOS 签名 URL 走本地代理，避免 2 小时过期后画布视频节点加载失败。
  const primarySrc = toMediaProxyUrl(videoUrl) ?? videoUrl;
  const [failedVideoUrl, setFailedVideoUrl] = useState<string | null>(null);
  const [failedPrimarySrc, setFailedPrimarySrc] = useState<string | null>(null);
  const [localPreview, setLocalPreview] = useState<{
    input: string | null; src: string | null; path: string | null;
  } | null>(null);
  // 本机导入素材优先用文件封面。WebView 的自定义协议可能只读到元数据，停在黑帧。
  const needsLocalPreview = isDesktopRuntime() && localTarget != null &&
    (localTarget.kind === "local_base64_asset" || primarySrc == null || failedPrimarySrc === primarySrc);
  const fallback = needsLocalPreview && localPreview?.input === primarySrc ? localPreview : null;
  const proxiedVideoUrl = needsLocalPreview && !fallback ? null : fallback?.src ?? primarySrc;
  const attachVideo = useCallback((video: HTMLVideoElement | null) => {
    const previous = videoRef.current;
    videoRef.current = video;
    if (previous != null && previous !== video) {
      // 先摘掉引用，再释放旧解码器，清理事件不能把当前预览标成失败。
      previous.pause();
      previous.removeAttribute("src");
      previous.load();
    }
    // StrictMode 会清理 ref 后重挂同一个 DOM；React 不会重新写回被清理的 src。
    if (video != null && proxiedVideoUrl != null && video.getAttribute("src") !== proxiedVideoUrl) {
      video.setAttribute("src", proxiedVideoUrl);
      video.load();
    }
  }, [proxiedVideoUrl]);
  const coverReady = proxiedVideoUrl != null && readyVideoUrl === proxiedVideoUrl;
  const videoFailed = proxiedVideoUrl != null ? failedVideoUrl === proxiedVideoUrl
    : needsLocalPreview ? fallback != null : true;
  const posterPath = finalPath ?? fallback?.path ?? null;
  const localVideo = isDesktopRuntime() && posterPath != null;
  const poster = useLocalVideoPoster(localVideo ? posterPath : null, mountMedia);
  const [failedPosterSrc, setFailedPosterSrc] = useState<string | null>(null);
  const posterSrc = poster.src !== failedPosterSrc ? poster.src : null;
  const posterFailed = poster.unavailable || (poster.src != null && posterSrc == null);
  // JPEG 封面按几何可见性展示；只有实际悬浮播放或首帧降级时才申请视频解码器名额。
  const { containerRef: decoderRef, inView: decoderInView } = useNodeInView<HTMLSpanElement>({
    heavy: true,
  });
  const needsLocalDecoder = localVideo && (previewing || posterFailed);
  const mountVideo = mountMedia && (!localVideo || (needsLocalDecoder && decoderInView));
  const refreshOnError = useRef(onLoadError);
  refreshOnError.current = onLoadError;

  useEffect(() => {
    if (!mountMedia || !needsLocalPreview || !localTarget) return;
    setLocalPreview(null);
    let active = true;
    let release: (() => Promise<void>) | undefined;
    void prepareCanvasMediaSource(localTarget).then(preview => {
      if (!active) { void preview.release(); return; }
      release = preview.release;
      setLocalPreview({ input: primarySrc, src: preview.src, path: preview.path });
    }, () => { if (active) setLocalPreview({ input: primarySrc, src: null, path: null }); });
    return () => { active = false; void release?.(); };
  }, [localTarget, needsLocalPreview, primarySrc, mountMedia]);

  const markVideoFailed = useCallback((src: string) => {
    setReadyVideoUrl(null);
    setFailedVideoUrl(src);
    if (src === primarySrc) setFailedPrimarySrc(src);
    refreshOnError.current?.();
  }, [primarySrc]);

  useEffect(() => {
    if (!mountVideo || !proxiedVideoUrl || coverReady || videoFailed) return;
    const timer = window.setTimeout(() => {
      if ((videoRef.current?.readyState ?? 0) < HTMLMediaElement.HAVE_CURRENT_DATA) markVideoFailed(proxiedVideoUrl);
      else setReadyVideoUrl(proxiedVideoUrl);
    }, 6000);
    return () => window.clearTimeout(timer);
  }, [coverReady, markVideoFailed, mountVideo, proxiedVideoUrl, videoFailed]);

  const seekToCover = (video: HTMLVideoElement) => {
    video.currentTime = coverTimeRef.current;
  };

  useEffect(() => {
    const video = videoRef.current;
    if (video == null) return;
    if (previewing) {
      wasPreviewingRef.current = true;
      if (!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
        // 从当前（封面）位置续播，循环播放避免悬浮时播完黑屏。
        void video.play().catch(() => undefined);
      }
    } else if (wasPreviewingRef.current) {
      wasPreviewingRef.current = false;
      video.pause();
      seekToCover(video);
    } else if (!localVideo && video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      // WebView 可以忽略 preload。显式请求首帧，拿到画面后立刻暂停在封面。
      void video.play().then(() => {
        if (videoRef.current === video && !previewingRef.current) {
          video.pause();
          seekToCover(video);
        }
      }).catch(() => undefined);
    }
  }, [previewing, mountVideo, proxiedVideoUrl, localVideo]);

  return (
    <span className="media-frame-host" ref={needsLocalDecoder ? decoderRef : undefined}>
      {!mountMedia ? (
        // 节点滚出视口：卸载 <video>，留轻量占位（用户此时看不见该节点）。
        <span className="canvas-asset-node__video-lazy" aria-hidden="true" />
      ) : (
        <>
          {posterSrc != null ? (
            <img
              src={posterSrc}
              alt=""
              draggable={false}
              decoding="async"
              onLoad={() => {
                if (poster.width != null && poster.height != null) {
                  onAspectRatioChange(poster.width / poster.height);
                }
              }}
              onError={() => setFailedPosterSrc(posterSrc)}
            />
          ) : null}
          {posterSrc == null && (!coverReady || !mountVideo) && isRealAsset ? (
            <AssetMediaState kind="video" state={videoFailed && (!localVideo || posterFailed) ? "unavailable" : "loading"} />
          ) : null}
          {mountVideo && proxiedVideoUrl && !videoFailed ? (
            <video
              key={proxiedVideoUrl}
              ref={attachVideo}
              className={`canvas-asset-node__video${coverReady ? " is-ready" : ""}`}
              src={proxiedVideoUrl}
              poster={posterSrc ?? undefined}
              muted
              loop
              playsInline
              preload="auto"
              aria-hidden="true"
              tabIndex={-1}
              onLoadedMetadata={(event) => {
                const video = event.currentTarget;
                const aspectRatio = measuredAspectRatio(video.videoWidth, video.videoHeight);
                if (aspectRatio != null) {
                  onAspectRatioChange(aspectRatio);
                  onPixelSize(video.videoWidth, video.videoHeight);
                }
                coverTimeRef.current =
                  !localVideo && Number.isFinite(video.duration) && video.duration > 0
                    ? video.duration / 2
                    : 0;
              }}
              onSeeked={() => setReadyVideoUrl(proxiedVideoUrl)}
              onLoadedData={event => {
                setReadyVideoUrl(proxiedVideoUrl);
                if (!localVideo && !previewing && coverTimeRef.current > 0 && event.currentTarget.currentTime === 0) {
                  seekToCover(event.currentTarget);
                }
              }}
              onError={(event) => {
                if (videoRef.current === event.currentTarget && event.currentTarget.getAttribute("src") === proxiedVideoUrl) {
                  markVideoFailed(proxiedVideoUrl);
                }
              }}
            />
          ) : null}
        </>
      )}
    </span>
  );
}

/** 画布上的素材节点：展示素材预览，输出端口可拖出连线到生成节点或其他素材节点。 */
function refreshAssetNodeMediaUrl(
  node: AssetNodeData,
  failedUrl: string | null,
): Promise<string | null> {
  return refreshMediaUrlWithStagingFallback(
    { id: node.assetId, source: node.source, providerConnectionId: node.providerConnectionId },
    node.kind,
    failedUrl,
  );
}

type CanvasSaveDestination = "local" | "cloud" | "object_storage";

const CANVAS_SAVE_TARGETS = [
  { destination: "local", label: "本地素材库", icon: "folder-simple-plus" },
  { destination: "cloud", label: "云端素材库", icon: "cloud-arrow-up" },
  { destination: "object_storage", label: "对象存储", icon: "stack-simple" },
] as const;

const ALL_CANVAS_SAVE_DESTINATIONS: readonly CanvasSaveDestination[] = [
  "local",
  "cloud",
  "object_storage",
];

function CanvasMediaSaveMenu({ triggerLabel, availableDestinations = ALL_CANVAS_SAVE_DESTINATIONS, onSave }: {
  readonly triggerLabel: string;
  readonly availableDestinations?: readonly CanvasSaveDestination[];
  readonly onSave: (destination: CanvasSaveDestination) => void;
}) {
  return <CanvasNodeActionsMenu label={triggerLabel} tooltip="选择保存位置"
    triggerClassName="canvas-node-actions__trigger--save" icon={<LibTVMediaIcon name="library-q4-saved" size={14} />}>
    {CANVAS_SAVE_TARGETS.filter(({ destination }) => availableDestinations.includes(destination)).map(({ destination, label, icon }) => (
      <button key={destination} type="button" onClick={() => onSave(destination)}>
        <Icon name={icon} aria-hidden="true" size="xs" />
        <span>保存到{label}</span>
      </button>
    ))}
  </CanvasNodeActionsMenu>;
}

export function CanvasAssetNode({
  node,
  edgeCount,
  dragging,
  onNodeDragStart,
  onConnectionStart,
  onAspectRatioChange,
  onRefreshMediaUrls,
  onPreview,
  onSaveToLibrary,
  onPrepareVideo,
}: {
  readonly node: AssetNodeData;
  readonly edgeCount: number;
  /** 该节点正在被拖动（视觉反馈）。 */
  readonly dragging: boolean;
  /** 节点主体按下：开始拖动节点（端口与操作按钮已阻止冒泡）。 */
  readonly onNodeDragStart: (
    key: string,
    x: number,
    y: number,
    clientX: number,
    clientY: number,
  ) => void;
  readonly onConnectionStart: (key: string) => void;
  /**
   * 删除节点。原站卡片上没有删除按钮（删除走「选中后按 Delete」），
   * 这里保留 prop 只是为了不改动调用方的插槽契约，组件本身不再渲染删除入口。
   */
  readonly onRemove: (key: string) => void;
  readonly onAspectRatioChange: (key: string, aspectRatio: number) => void;
  /** 云端素材预览续签成功：用新签名地址回写节点数据（持久化到画布文档）。 */
  readonly onRefreshMediaUrls: (key: string, freshPreviewUrl: string) => void;
  /** 点击素材卡片视觉区域：查看图片、视频或试听音频。 */
  readonly onPreview?: (key: string) => void;
  /** 将现有素材另存到指定素材库；保存及去重由调用方处理。 */
  readonly onSaveToLibrary?:
    ((key: string, destination: "local" | "cloud" | "object_storage") => void) | undefined;
  /** 兼容调用方的云端连接信息；目标范围与判重在保存操作中处理。 */
  readonly targetCloudProviderConnectionId?: string | null;
  readonly onPrepareVideo?: ((key: string) => void) | undefined;
}) {
  const typeLabel = ASSET_KIND_LABELS[node.kind];
  const awaitingCloudId = node.source !== "local" && isReviewTaskId(node.assetId);
  const isVideo = node.kind === "video";
  const mediaCard = node.kind === "image" || isVideo;
  const [previewing, setPreviewing] = useState(false);
  const [pixelSize, setPixelSize] = useState<{ width: number; height: number } | null>(null);
  const [loadedImageUrl, setLoadedImageUrl] = useState<string | null>(null);
  const [failedImageUrl, setFailedImageUrl] = useState<string | null>(null);
  const { containerRef: visualRef, inView: visualInView } = useNodeInView<HTMLSpanElement>({
    heavy: isVideo,
  });
  // 画布水合后会批量重签本地素材签名；已下载过的素材则直接复用会话内字节，
  // 既不必再等一次续签往返，也不受签名是否过期影响。
  const localMediaUrl = localAssetNodeMediaUrl(node);
  const videoTarget = useMemo(() => isVideo && node.source === "local" && node.assetId
    ? assetNodeReferenceTarget(node) : null, [isVideo, node.source, node.assetId, node.key, node.providerConnectionId]);
  const imageBytes = useMediaByteSource(node.assetId, node.kind, localMediaUrl);
  const effectivePreviewUrl = imageBytes.url ?? localMediaUrl;
  const imageReady = effectivePreviewUrl != null && loadedImageUrl === effectivePreviewUrl;
  const imageFailed = effectivePreviewUrl == null || failedImageUrl === effectivePreviewUrl;
  const isRealAsset = node.source != null || isDesktopRuntime();
  const dimensions = assetNodeDimensions(node);
  // 素材签名地址过期后预览失败：同一地址只向后端续签一次，新地址回写节点数据持久化；
  // 续签失败保持置灰，不反复请求（与素材库卡片一致）。
  // 云端素材回读供应商记录，旧本地素材重签对象存储；本机 Base64 素材按 ID 重新读取。
  // 记录「已为哪个地址续签过」而不是布尔标记：画布水合批量重签、其他实例续签或后端重读
  // 都可能换成新地址，新地址失败时理应还能自愈一次。实例内最多两次，杜绝地址反复变化时的循环请求。
  const mediaRefreshAttemptedRef = useRef<{ urls: string[]; count: number }>({
    urls: [],
    count: 0,
  });
  const attemptMediaRefresh = useCallback(
    (failedUrl: string | null) => {
      if (failedUrl == null || node.assetId === "") return;
      const attempted = mediaRefreshAttemptedRef.current;
      if (attempted.count >= 2 || attempted.urls.includes(failedUrl)) return;
      if (node.source === "cloud" && node.providerConnectionId === "") return;
      attempted.urls.push(failedUrl);
      attempted.count += 1;
      void refreshAssetNodeMediaUrl(node, failedUrl).then((freshUrl) => {
        if (freshUrl == null || freshUrl === "") return;
        if (freshUrl !== failedUrl) {
          onRefreshMediaUrls(node.key, freshUrl);
        }
        setFailedImageUrl(null);
        imageBytes.reload();
      });
    },
    [node, onRefreshMediaUrls, imageBytes],
  );
  /*
   * 签名地址过期 → 渲染前就续签，不等 onError。
   *
   * 之前只有「加载失败」才触发续签：用户先看到一帧「预览不可用」，才知道要去点重试。
   * 但对象存储预签名地址本身写着有效期（`X-Tos-Date` + `X-Tos-Expires`），
   * 渲染前就能判断它已经过期 —— 这时直接续签，界面不会先坏一次。
   *
   * 只认火山 TOS 的签名格式（`signedUrlExpired` 对认不出的地址一律返回 false），
   * 不去猜其他供应商的签名语义；那些地址仍然走 onError 自愈路径。
   *
   * 检查的是**原始地址**（localMediaUrl / node.videoUrl），不是渲染时用的代理地址：
   * 代理地址是 `assetproxy://...?v=…` 或把源地址塞进 `src=` 查询串，签名参数已被转义，
   * 在上面判断不出有效期。
   *
   * `attemptMediaRefresh` 自带「同一地址只续签一次、实例内最多两次」的闸门，
   * 所以本 effect 反复触发也不会打出重复请求。
   */
  useEffect(() => {
    for (const url of [localMediaUrl, node.videoUrl]) {
      if (url == null || url === "") continue;
      if (!signedUrlExpired(url)) continue;
      attemptMediaRefresh(url);
    }
  }, [localMediaUrl, node.videoUrl, attemptMediaRefresh]);
  return (
    <div
      className={`canvas-asset-node${mediaCard ? " canvas-asset-node--media canvas-node-preview" : ""}${node.assetGroupId ? " is-grouped" : ""}${dragging ? " is-dragging" : ""}`}
      style={{ ...dimensions }}
      data-connection-target={node.key}
      onMouseDown={(event) =>
        onNodeDragStart(node.key, node.x, node.y, event.clientX, event.clientY)
      }
      onMouseEnter={() => {
        if (isVideo) setPreviewing(true);
      }}
      onMouseLeave={() => {
        if (isVideo) setPreviewing(false);
      }}
    >
      {mediaCard ? <CanvasMediaNodeTitle kind={node.kind} title={node.name} pixelSize={pixelSize}
        processing={awaitingCloudId} /> : null}
      {isVideo ? <CanvasVideoFrameCrop nodeKey={node.key} /> : null}
      <span
        className={`canvas-asset-node__visual${onPreview ? " canvas-asset-node__preview-button" : ""}`}
        ref={visualRef}
        onClick={(event) => {
          if (onPreview) {
            event.stopPropagation();
            onPreview(node.key);
          }
        }}
        onKeyDown={
          onPreview
            ? (event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                event.stopPropagation();
                onPreview(node.key);
              }
            : undefined
        }
        role={onPreview ? "button" : undefined}
        tabIndex={onPreview ? 0 : undefined}
        aria-label={
          onPreview ? `${node.kind === "audio" ? "试听音频" : "放大查看"}${node.name}` : undefined
        }
        title={
          onPreview
            ? node.kind === "audio"
              ? "点击试听音频"
              : "点击放大查看原图或视频"
            : undefined
        }
      >
        {isVideo ? (
          <CanvasAssetNodeVideoVisual
            videoUrl={localMediaUrl}
            localTarget={videoTarget}
            previewing={previewing}
            isRealAsset={isRealAsset}
            mountMedia={visualInView}
            onAspectRatioChange={(aspectRatio) => onAspectRatioChange(node.key, aspectRatio)}
            onPixelSize={(width, height) => setPixelSize({ width, height })}
            onLoadError={() => attemptMediaRefresh(localMediaUrl)}
          />
        ) : node.kind === "image" ? (
          <>
            {isRealAsset && !imageReady ? (
              <AssetMediaState kind="image" state={imageFailed ? "unavailable" : "loading"} />
            ) : null}
            {effectivePreviewUrl != null && !imageFailed ? (
              <img
                src={effectivePreviewUrl}
                alt=""
                draggable={false}
                decoding="async"
                onLoad={(event) => {
                  const image = event.currentTarget;
                  const aspectRatio = measuredAspectRatio(image.naturalWidth, image.naturalHeight);
                  if (aspectRatio != null) onAspectRatioChange(node.key, aspectRatio);
                  setPixelSize({ width: image.naturalWidth, height: image.naturalHeight });
                  setLoadedImageUrl(effectivePreviewUrl);
                  setFailedImageUrl(null);
                }}
                onError={() => {
                  setLoadedImageUrl(null);
                  setFailedImageUrl(effectivePreviewUrl);
                  // 当前地址加载失败：本地副本坏了就重下一次，远端地址失败则先在本地字节里
                  // 找一次（重启后本地通常已有副本），都没命中才回到续签自愈路径。
                  imageBytes.retry();
                  if (imageBytes.fromCache) return;
                  attemptMediaRefresh(effectivePreviewUrl);
                }}
              />
            ) : null}
          </>
        ) : node.kind === "audio" ? (
          <span className="waveform waveform--node" aria-hidden="true">
            {Array.from({ length: 14 }, (_, index) => (
              <i key={index} style={{ "--bar": (index % 5) + 2 } as CSSProperties} />
            ))}
          </span>
        ) : null}
      </span>
      {!mediaCard ? <span className="canvas-asset-node__header">
        <span className="canvas-asset-node__identity">
          <AssetKindIcon kind={node.kind} />
          <span className="canvas-asset-node__name" title={node.name}>
            {node.name}
          </span>
          {node.source !== "local" ? (
            <span
              className="canvas-asset-node__cloud-badge"
              data-state={awaitingCloudId ? "processing" : "ready"}
              title={awaitingCloudId ? "云端处理中" : "已在云端素材库"}
              aria-label={awaitingCloudId ? "云端处理中" : "已在云端素材库"}
            />
          ) : null}
        </span>
        <span className="canvas-asset-node__meta">
          {awaitingCloudId
            ? `${typeLabel} · 云端处理中`
            : `${typeLabel} · ${edgeCount > 0 ? `${edgeCount} 条连线` : "未连接"}`}
        </span>
      </span> : null}
      {isVideo && onPrepareVideo && !awaitingCloudId ? (
        <CanvasNodeActionsMenu label="视频素材操作" icon={<LibTVMediaIcon name="more-s" size={16} />}>
          <button type="button" onClick={() => onPrepareVideo(node.key)}>
            视频准备
          </button>
        </CanvasNodeActionsMenu>
      ) : null}
      {onSaveToLibrary && !awaitingCloudId && !(mediaCard && node.kind === "image") ? (
        <CanvasMediaSaveMenu
          triggerLabel={`保存素材：${node.name}`}
          onSave={(destination) => onSaveToLibrary(node.key, destination)}
        />
      ) : null}
      <button
        type="button"
        className="canvas-asset-node__port"
        disabled={awaitingCloudId}
        aria-label={
          awaitingCloudId ? `云端处理中，暂不可连线：${node.name}` : `从 ${node.name} 拖出连线`
        }
        title={
          awaitingCloudId ? "云端处理中，素材 ID 尚未返回" : "拖到生成节点或其他素材节点建立连线"
        }
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (awaitingCloudId) return;
          onConnectionStart(node.key);
        }}
      />
    </div>
  );
}

/** 画布产物的全屏源媒体浏览器：优先使用本地最终文件，否则使用会话内预览地址。 */
export function CanvasOutputLightbox({
  node,
  onClose,
}: {
  readonly node: OutputNodeData;
  readonly onClose: () => void;
}) {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const finalPath = node.finalPath;

  // 模态焦点陷阱：焦点锁在预览里（Tab 不会跑到背后的画布上），Esc 关闭，
  // 关闭后焦点回到打开预览的那个元素。
  const trap = useModalFocusTrap({
    active: node.mediaType !== "image",
    onEscape: onClose,
    initialFocusRef: closeButtonRef,
  });

  const mediaSrc = finalPath != null ? toMediaSrc(finalPath) : (node.previewSrc ?? null);
  if (mediaSrc == null) return null;
  const mediaName =
    node.name ??
    (finalPath != null ? fileNameFromPath(finalPath) : null) ??
    (node.mediaType === "video"
      ? "生成视频"
      : node.mediaType === "audio"
        ? "音频产物"
        : "生成图片");

  if (node.mediaType === "image") return <ImageLightbox items={[{ id: node.key, src: mediaSrc, name: mediaName }]} onClose={onClose} />;

  return createPortal(
    <div
      className="history-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="媒体预览"
      ref={trap.ref}
      {...trap.containerProps}
    >
      <button
        ref={closeButtonRef}
        type="button"
        className="history-lightbox__close"
        aria-label="关闭媒体预览"
        onClick={onClose}
      >
        <Icon name="x" aria-hidden="true" size="xl" />
      </button>
      <div
        className="history-lightbox__stage"
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        {node.mediaType === "video" ? (
          <video
            className="history-lightbox__media"
            src={mediaSrc}
            aria-label={mediaName}
            controls
            autoPlay
            muted
            playsInline
          />
        ) : node.mediaType === "audio" ? (
          <audio
            className="history-lightbox__media"
            src={mediaSrc}
            aria-label={mediaName}
            controls
            autoPlay
          />
        ) : (
          <img
            className="history-lightbox__media"
            src={mediaSrc}
            alt={mediaName}
            draggable={false}
          />
        )}
      </div>
    </div>,
    document.body,
  );
}

/** 画布素材节点的全屏媒体浏览器：查看原图、视频或试听音频。 */
export function CanvasAssetLightbox({
  node,
  onClose,
}: {
  readonly node: AssetNodeData;
  readonly onClose: () => void;
}) {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  // 模态焦点陷阱：焦点锁在预览里（Tab 不会跑到背后的画布上），Esc 关闭，
  // 关闭后焦点回到打开预览的那个元素。
  const trap = useModalFocusTrap({
    active: node.kind !== "image",
    onEscape: onClose,
    initialFocusRef: closeButtonRef,
  });

  // 大图同样优先用会话内已下载的字节：放大查看不必等一次远端往返，签名过期也照常显示。
  // 地址取与节点视觉区同一份（本地素材续签登记表优先），避免「节点里已是新签名、放大后
  // 反而拿旧签名」；视频和音频不读整包字节（按 Range 播放），交给媒体代理直连。
  const [refreshedUrl, setRefreshedUrl] = useState<string | null>(null);
  const refreshAttemptedRef = useRef(false);
  const listedUrl = localAssetNodeMediaUrl(node);
  const candidateUrl = refreshedUrl ?? listedUrl ?? null;
  const lightboxBytes = useMediaByteSource(
    node.kind === "video" ? "" : node.assetId,
    node.kind,
    node.kind === "video" ? null : candidateUrl,
  );
  const mediaSrc = node.kind === "video" ? toMediaProxyUrl(candidateUrl) : lightboxBytes.url;
  // 放大后的地址同样能自愈一次：本地副本坏了就重下一次，远端地址失败则续签一次
  // （上游回放导入时的死地址时按对象键重签暂存副本，暂存对象已清理则由媒体代理
  // 用导入时留存的原始文件接管）。每个实例只尝试一次，不形成重试循环。
  const handleMediaError = () => {
    lightboxBytes.retry();
    if (lightboxBytes.fromCache || refreshAttemptedRef.current) return;
    refreshAttemptedRef.current = true;
    void refreshAssetNodeMediaUrl(node, candidateUrl).then((freshUrl) => {
      if (freshUrl == null || freshUrl === "") return;
      if (freshUrl !== candidateUrl) {
        setRefreshedUrl(freshUrl);
      }
      lightboxBytes.reload();
    });
  };
  if (mediaSrc == null) return null;
  if (node.kind === "image") return <ImageLightbox items={[{ id: node.key, src: mediaSrc, name: node.name }]} onClose={onClose} onImageError={handleMediaError} />;

  return createPortal(
    <div
      className="history-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="素材预览"
      ref={trap.ref}
      {...trap.containerProps}
    >
      <button
        ref={closeButtonRef}
        type="button"
        className="history-lightbox__close"
        aria-label="关闭素材预览"
        onClick={onClose}
      >
        <Icon name="x" aria-hidden="true" size="xl" />
      </button>
      <div
        className="history-lightbox__stage"
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        {node.kind === "video" ? (
          <video
            className="history-lightbox__media"
            src={mediaSrc}
            aria-label={node.name}
            controls
            autoPlay
            muted
            playsInline
            onError={handleMediaError}
          />
        ) : node.kind === "audio" ? (
          <audio
            className="history-lightbox__media"
            src={mediaSrc}
            aria-label={node.name}
            controls
            autoPlay
            onError={handleMediaError}
          />
        ) : (
          <img
            className="history-lightbox__media"
            src={mediaSrc}
            alt={node.name}
            draggable={false}
            onError={handleMediaError}
          />
        )}
      </div>
    </div>,
    document.body,
  );
}

/**
 * 画布上的生成产物卡片：任务启动时自动创建，承担原任务状态栏的职责：
 * - 进行中：展示任务状态（排队/生成中/重试等待）与进度；
 * - 成功：先展示供应商预览，保存完成后展示本地产物（图片直接显示，视频中间帧封面 + 悬浮播放）；
 * - 失败：展示完整原始返回（rawResponse），以虚线连回来源生成节点。
 */
export function CanvasOutputNode({
  node,
  dragging,
  onNodeDragStart,
  onAspectRatioChange,
  onPreview,
  onConnectionStart,
  onUploadToCloud,
  onUploadToLocal,
  onUploadToObjectStorage,
  task,
  retryInfo,
  results,
  saveProgress = null,
  rawResponse,
  modelLabel,
  onRename,
  onOpenHistory,
  onPrepareVideo,
}: {
  readonly node: OutputNodeData;
  /** 该节点正在被拖动（视觉反馈）。 */
  readonly dragging: boolean;
  /** 节点主体按下：开始拖动节点（操作按钮已阻止冒泡）。
   * activateOnTap 可选：按在媒体区域上且未拖动的抬起触发（全屏预览）。 */
  readonly onNodeDragStart: (
    key: string,
    x: number,
    y: number,
    clientX: number,
    clientY: number,
    activateOnTap?: () => void,
  ) => void;
  /**
   * 删除节点。原站卡片上没有删除按钮（删除走「选中后按 Delete」），
   * 这里保留 prop 只是为了不改动调用方的插槽契约，组件本身不再渲染删除入口。
   */
  readonly onRemove: (key: string) => void;
  readonly onAspectRatioChange: (key: string, aspectRatio: number) => void;
  readonly onPreview: (key: string) => void;
  readonly onConnectionStart: (key: string) => void;
  /** 已保存的图片或视频产物上传到云端素材库。 */
  readonly onUploadToCloud?: (key: string) => void;
  /** 已保存的图片或视频产物上传到本地素材库。 */
  readonly onUploadToLocal?: ((key: string) => void) | undefined;
  /** 已保存的图片或视频产物仅上传到对象存储。 */
  readonly onUploadToObjectStorage?: ((key: string) => void) | undefined;
  /** 卡片对应任务的最新摘要（任务列表查不到时为 null）。 */
  readonly task: GenerationTaskSummary | null;
  /** 重试等待信息（generation:retry 事件驱动）。 */
  readonly retryInfo: RetryInfo | null;
  /** 该任务的全部结果记录（判断保存失败等边缘状态）。 */
  readonly results: readonly GenerationResultRecord[];
  /** 正在把远程结果写入本机时的下载进度。 */
  readonly saveProgress?: GenerationResultSaveProgress | null;
  /** 失败任务的完整原始返回（按需加载）。 */
  readonly rawResponse: string | null;
  /** 模型展示名（进行中/失败态展示）。 */
  readonly modelLabel: string | null;
  readonly onRename?: ((key: string, name: string) => Promise<void>) | undefined;
  readonly onOpenHistory?: ((taskId: string) => void) | undefined;
  readonly onPrepareVideo?: ((key: string) => void) | undefined;
}) {
  const isImage = node.mediaType === "image";
  const isTextResult = node.mediaType === "text";
  const isVideo = node.mediaType === "video";
  const isAudio = node.mediaType === "audio";
  const mediaLabel = isVideo ? "视频" : isAudio ? "音频" : "图片";
  const [previewing, setPreviewing] = useState(false);
  const [pixelSize, setPixelSize] = useState<{ width: number; height: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [exporting, setExporting] = useState(false);
  const copyResetTimerRef = useRef<number | undefined>(undefined);
  // 视口懒挂载与本地图片缩略图：离屏不启动缩略图任务，也不解码原图。
  const { containerRef: previewButtonRef, inView: previewInView } =
    useNodeInView<HTMLButtonElement>({
      heavy: isVideo && (node.finalPath == null || !isDesktopRuntime()),
    });
  const imageThumbnail = useMediaThumbnailSrc(
    !isVideo && !isAudio && !isTextResult ? node.finalPath : null,
    previewInView,
  );
  const mediaSrc = node.finalPath != null ? toMediaSrc(node.finalPath) : (node.previewSrc ?? null);

  // 供应商结果已返回 → 立即展示媒体/文本；本地 finalPath 到达后再切换为长期引用。
  // 文本产物（Context-IR）以内联正文为准，不依赖 finalPath。
  const hasArtifact = isTextResult ? node.textContent != null : mediaSrc != null;
  const mediaCard = (isImage || isVideo) && hasArtifact;
  const hasLocalArtifact = node.finalPath != null;
  const isPreviewOnly = !hasLocalArtifact && hasArtifact;
  const canUseAsGenerationReference = outputNodeReferenceTarget(node) != null;
  const canConnectToComposer = isVideo && hasArtifact;
  const dimensions = outputNodeDimensions(node);
  const taskTypeLabel = isTextResult
    ? "智能扩写"
    : isAudio
      ? "音频处理"
      : isVideo
        ? "视频生成"
        : "图片生成";

  // 未落卡时按任务状态派生展示阶段。
  const progress =
    task?.progress != null ? Math.min(100, Math.max(0, Math.round(task.progress))) : null;
  const statusText = (() => {
    // 任务记录尚未出现在任务列表（提交后瞬时/列表刷新延迟）：视为进行中。
    if (task == null) return "任务记录同步中";
    if (task.status === "retry_wait") {
      if (retryInfo) {
        return `${Math.max(1, Math.round(retryInfo.delayMs / 1000))} 秒后第 ${retryInfo.retry} 次请求`;
      }
      return "重试等待中";
    }
    if (task.status === "running" && progress != null) {
      return `生成中 · ${progress}%`;
    }
    return TASK_STATUS_LABELS[task.status] ?? task.status;
  })();
  const failedSaveResult = results.find((result) =>
    ["failed", "interrupted", "local_missing", "conflict"].includes(result.saveStatus),
  );
  // 后端其实已经落盘、但卡片还没拿到本地路径的结果：事件漏投时卡片会短暂停在
  // 「正在保存本地副本」，而后端的任务详情里 finalPath 已经写好。补发逻辑会自动补齐，
  // 这里先把真实情况显示出来，避免让用户误以为保存卡死。
  // 文件名在组件体里算好再进 JSX：把 fileNameFromPath 调用留在 JSX 里会让 React Compiler
  // 放弃本组件的记忆化（preserve-manual-memoization 报错）。
  const savedResultName = (() => {
    const saved = results.find(
      (result) => result.saveStatus === "succeeded" && result.finalPath != null,
    );
    return saved?.finalPath == null ? null : fileNameFromPath(saved.finalPath);
  })();
  // 展示阶段：running = 任务进行中（含任务记录同步中）；failed = 任务失败/保存失败；saving = 任务成功但结果尚未落卡。
  const phase: "running" | "failed" | "saving" = (() => {
    if (task == null) return "running";
    if (isRunningTaskStatus(task.status) || task.status === "retry_wait") return "running";
    if (task.status === "succeeded") return failedSaveResult ? "failed" : "saving";
    return "failed";
  })();
  const isRunning = !hasArtifact && phase === "running";
  const isSaving = !hasLocalArtifact && phase === "saving";
  const isFailed = !hasArtifact && phase === "failed";
  const savePercent =
    saveProgress != null && saveProgress.total != null && saveProgress.total > 0
      ? Math.min(100, Math.max(0, Math.round((saveProgress.received / saveProgress.total) * 100)))
      : null;
  const saveProgressLabel = saveProgress != null ? formatSaveProgress(saveProgress) : null;
  const showSaveOverlay = isPreviewOnly && failedSaveResult == null && savedResultName == null;
  const failedTitle = (() => {
    if (task != null && task.status === "succeeded" && failedSaveResult) {
      return SAVE_STATUS_LABELS[failedSaveResult.saveStatus] ?? "结果保存失败";
    }
    return statusText;
  })();
  const failedDetail = (() => {
    if (task != null && task.status === "succeeded" && failedSaveResult) {
      const saveError =
        failedSaveResult.error == null ? null : JSON.stringify(failedSaveResult.error, null, 2);
      return saveError ?? rawResponse;
    }
    return rawResponse;
  })();

  // 一键复制完整错误信息：桌面端走系统剪贴板插件，复制成功后短暂反馈「已复制」。
  const copyFailedDetail = useCallback(async () => {
    if (failedDetail == null) return;
    try {
      if (isDesktopRuntime()) {
        await copyTextToDesktopClipboard(failedDetail);
      } else if (navigator.clipboard != null) {
        await navigator.clipboard.writeText(failedDetail);
      } else {
        throw new Error("当前环境不支持剪贴板写入。");
      }
      setCopied(true);
      toast.success("错误信息已复制");
      window.clearTimeout(copyResetTimerRef.current);
      copyResetTimerRef.current = window.setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      // 完整原文只进日志；用户看到的是提过摘要的一句话。
      frontendLog("error", `[canvas] 复制错误信息失败: ${formatRawBackendError(error)}`);
      toast.error("复制失败", { description: backendErrorMessage(error) });
    }
  }, [failedDetail]);

  // 手动重试保存失败的生成结果（图片/视频）：走后端 resume_generation_result 命令，
  // 内部复用指数退避重试下载 + 校验 + 原子落盘；成功后后端 emit generation:result-saved
  // 事件，前端结果卡片自动刷新为已保存状态。
  const handleResumeSave = useCallback(async () => {
    if (failedSaveResult == null || resuming) return;
    setResuming(true);
    try {
      await resumeGenerationResult({
        taskId: node.taskId,
        resultIndex: failedSaveResult.resultIndex,
      });
      toast.success("已重新保存到本机");
    } catch (error) {
      // 完整原文只进日志；用户看到的是提过摘要的一句话。
      frontendLog(
        "error",
        `[canvas] 手动重试保存失败: taskId=${node.taskId}, resultIndex=${failedSaveResult.resultIndex}, ${formatRawBackendError(error)}`,
      );
      toast.error("重试保存失败", { description: backendErrorMessage(error) });
    } finally {
      setResuming(false);
    }
  }, [failedSaveResult, node.taskId, resuming]);

  // 一键复制扩写正文（Context-IR 文本产物）。
  const copyTextContent = useCallback(async () => {
    if (node.textContent == null) return;
    try {
      if (isDesktopRuntime()) {
        await copyTextToDesktopClipboard(node.textContent);
      } else if (navigator.clipboard != null) {
        await navigator.clipboard.writeText(node.textContent);
      } else {
        throw new Error("当前环境不支持剪贴板写入。");
      }
      setCopied(true);
      window.clearTimeout(copyResetTimerRef.current);
      copyResetTimerRef.current = window.setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      // 完整原文只进日志；用户看到的是提过摘要的一句话。
      frontendLog("error", `[canvas] 复制扩写正文失败: ${formatRawBackendError(error)}`);
      toast.error("复制失败", { description: backendErrorMessage(error) });
    }
  }, [node.textContent]);

  // 卸载时清理「已复制」回退计时器，避免对已卸载组件 setState。
  useEffect(() => {
    return () => window.clearTimeout(copyResetTimerRef.current);
  }, []);
  const metaLine =
    node.origin === "long_video"
      ? "超长视频成片 · 本地视频"
      : node.origin === "ai_media"
      ? `AI 媒体处理 · 本地${mediaLabel}`
      : node.origin === "video_preparation"
        ? `视频准备 · 本地${mediaLabel}`
        : node.origin === "composition"
          ? "视频拼接与合成 · 本地结果"
          : node.origin === "download"
            ? "网络爆款视频下载 · 本地结果"
            : node.origin === "white_model"
              ? "白模动画 · 本地结果"
              : node.origin === "white_model_still"
                ? "白模站位图 · 本地结果"
                : node.origin === "green_screen"
                  ? "绿幕流程 · 本地视频"
                  : node.origin === "video_edit"
                    ? "视频局部编辑 · 标注参考帧"
                    : task
                      ? `${taskTypeLabel} · ${modelLabel ?? ""} · ${
                          isFailed
                            ? formatTaskClock(task.completedAt ?? task.updatedAt)
                            : formatTaskClock(task.createdAt)
                        }`
                      : `${taskTypeLabel} · ${shortenTaskId(node.taskId)}`;

  const mediaTitle = node.layer
    ? `${node.layer.isBaseLayer ? "底图" : `图层 ${node.layer.zIndex}`}${node.layer.name ? ` · ${node.layer.name}` : ""}`
    : node.name ?? savedResultName ?? (isVideo ? "视频节点" : "图片节点");
  const availableSaveDestinations: CanvasSaveDestination[] = [];
  if (onUploadToLocal) availableSaveDestinations.push("local");
  if (onUploadToCloud) availableSaveDestinations.push("cloud");
  if (onUploadToObjectStorage) availableSaveDestinations.push("object_storage");

  return (
    <div
      className={`canvas-asset-node canvas-asset-node--output canvas-asset-node--output--${node.mediaType}${mediaCard ? " canvas-asset-node--media canvas-node-preview" : ""}${isFailed ? " canvas-asset-node--output--failed" : ""}${node.assetGroupId ? " is-grouped" : ""}${dragging ? " is-dragging" : ""}`}
      style={{ ...dimensions }}
      aria-busy={
        !(isTextResult && node.textContent != null) && (isRunning || isSaving || showSaveOverlay)
          ? "true"
          : undefined
      }
      onMouseDown={(event) => {
        // 整卡任意位置可自由拖动；按在媒体区域上且未发生位移的抬起视为点按，
        // React Flow 负责整卡拖动；媒体按钮自身的 click 负责打开全屏预览。
        const activateOnTap =
          (event.target as HTMLElement).closest(".canvas-asset-node__preview-button") != null
            ? () => onPreview(node.key)
            : undefined;
        onNodeDragStart(node.key, node.x, node.y, event.clientX, event.clientY, activateOnTap);
      }}
      onMouseEnter={() => {
        if (isVideo && hasArtifact) setPreviewing(true);
      }}
      onMouseLeave={() => {
        if (isVideo && hasArtifact) setPreviewing(false);
      }}
    >
      {isTextResult && node.textContent != null ? (
        <>
          <span className="canvas-output-node__state canvas-output-node__state--saved">
            <Icon name="text-t" aria-hidden="true" size="sm" />
            <span className="canvas-output-node__status">
              {isSaving ? "智能扩写完成 · 等待文本保存" : "智能扩写完成"}
            </span>
            <button
              type="button"
              className="canvas-output-node__copy"
              aria-label="复制扩写正文"
              title="复制扩写正文"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                void copyTextContent();
              }}
            >
              {copied ? (
                <Icon name="check" aria-hidden="true" size="sm" />
              ) : (
                <Icon name="copy-simple" aria-hidden="true" size="sm" />
              )}
              {copied ? "已复制" : "复制"}
            </button>
          </span>
          <pre className="canvas-output-node__text" aria-label="智能扩写正文" tabIndex={0}>
            {node.textContent}
          </pre>
          <span className="canvas-asset-node__identity">
            <Icon name="text-t" aria-hidden="true" size="md" />
            <span className="canvas-asset-node__name" title={node.name ?? undefined}>
              {node.name ?? "智能扩写结果"}
            </span>
          </span>
          <span className="canvas-asset-node__meta">
            智能扩写 · 文本产物 · {isPreviewOnly ? "正在保存本地副本" : "已保存到本机"}
          </span>
        </>
      ) : mediaSrc != null ? (
        <>
          {mediaCard ? <CanvasMediaNodeTitle kind={isVideo ? "video" : "image"} title={mediaTitle} pixelSize={pixelSize}
            onRename={onRename && hasLocalArtifact ? name => {
              void onRename(node.key, name).catch((error: unknown) => toast.error(`改名失败：${backendErrorMessage(error)}`));
            } : undefined} /> : null}
          {isVideo ? <CanvasVideoFrameCrop nodeKey={node.key} /> : null}
          <button
            type="button"
            ref={previewButtonRef}
            className="canvas-asset-node__visual canvas-asset-node__preview-button"
            aria-label={`全屏浏览产物：${node.name ?? mediaLabel}`}
            title="拖动移动卡片 · 点击全屏浏览源媒体"
            onClick={(event) => {
              // 指针点按由拖动结束的激活回调处理（捕获层接管了 mouseup）；
              // 这里保留键盘 Enter/Space 激活路径。
              event.stopPropagation();
              onPreview(node.key);
            }}
          >
            {mediaCard && node.origin === "generation" ? <span className="canvas-media-ai-badge">AI 生成</span> : null}
            {isVideo ? (
              <CanvasAssetNodeVideoVisual
                videoUrl={mediaSrc}
                finalPath={node.finalPath}
                previewing={previewing}
                isRealAsset
                mountMedia={previewInView}
                onAspectRatioChange={(aspectRatio) => onAspectRatioChange(node.key, aspectRatio)}
                onPixelSize={(width, height) => setPixelSize({ width, height })}
              />
            ) : isAudio ? (
              <span className="waveform waveform--node" aria-hidden="true">
                {Array.from({ length: 14 }, (_, index) => (
                  <i key={index} style={{ "--bar": (index % 5) + 2 } as CSSProperties} />
                ))}
              </span>
            ) : !previewInView ? (
              <span className="canvas-asset-node__video-lazy" aria-hidden="true" />
            ) : node.finalPath != null && isDesktopRuntime() && imageThumbnail.src == null ? (
              <AssetMediaState
                kind="image"
                state={imageThumbnail.unavailable ? "unavailable" : "loading"}
              />
            ) : (
              <img
                src={imageThumbnail.src ?? mediaSrc}
                alt=""
                draggable={false}
                decoding="async"
                onLoad={(event) => {
                  const image = event.currentTarget;
                  const aspectRatio = measuredAspectRatio(image.naturalWidth, image.naturalHeight);
                  if (aspectRatio != null) onAspectRatioChange(node.key, aspectRatio);
                  if (!imageThumbnail.src) setPixelSize({ width: image.naturalWidth, height: image.naturalHeight });
                }}
              />
            )}
          </button>
          {!mediaCard ? <span className="canvas-asset-node__identity">
            <AssetKindIcon kind={node.mediaType} />
            <span
              className="canvas-asset-node__name"
              title={node.layer?.description ?? node.name ?? undefined}
            >
              {node.layer != null
                ? node.layer.isBaseLayer
                  ? `底图${node.layer.name ? ` · ${node.layer.name}` : ""}`
                  : `图层 ${node.layer.zIndex}${node.layer.name ? ` · ${node.layer.name}` : ""}`
                : (node.name ?? savedResultName ?? (isPreviewOnly ? "生成结果（正在保存）" : ""))}
            </span>
            {/* 已入库的产物在名称旁常显绿色小点：上传按钮只在悬停时出现，
                状态若只跟着按钮走，用户扫一眼卡片根本看不出这张产物已经在素材库里。 */}
            {node.uploadedToCloud ? (
              <span
                className="canvas-asset-node__cloud-badge"
                title="已在云端素材库"
                aria-label="已在云端素材库"
              />
            ) : null}
            {node.uploadedToLocal ? (
              <span
                className="canvas-asset-node__local-badge"
                title="已在本地素材库"
                aria-label="已在本地素材库"
              />
            ) : null}
            {node.uploadedToObjectStorage ? (
              <span
                className="canvas-asset-node__object-storage-badge"
                title="已在对象存储"
                aria-label="已在对象存储"
              />
            ) : null}
          </span> : null}
          {!mediaCard ? <span className="canvas-asset-node__meta">
            {node.origin === "composition"
              ? `合成视频 · ${isPreviewOnly ? "已导出浏览器下载" : "已保存到本机"}`
              : `${mediaLabel}产物 · ${
                  isPreviewOnly
                    ? failedSaveResult
                      ? "本地保存失败"
                      : savedResultName != null
                        ? "已保存到本机 · 正在补齐卡片"
                        : "正在保存到本机"
                    : node.origin === "video_preparation" || node.origin === "ai_media" || node.origin === "long_video"
                      ? "已保存到本机 · 可作为参考输入"
                      : "已连线来源节点 · 可作为参考输入"
                }`}
          </span> : null}
          {showSaveOverlay ? (
            <div className="canvas-output-node__save-overlay" aria-live="polite">
              <span className="canvas-output-node__save-overlay-label">
                {saveProgressLabel ?? "正在保存本地副本"}
              </span>
              {savePercent != null ? (
                <span
                  className="canvas-output-node__progress"
                  role="progressbar"
                  aria-label="结果保存进度"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={savePercent}
                >
                  <i style={{ width: `${savePercent}%` }} />
                </span>
              ) : (
                <span
                  className="canvas-output-node__progress canvas-output-node__progress--indeterminate"
                  role="progressbar"
                  aria-label="结果保存进度"
                >
                  <i />
                </span>
              )}
            </div>
          ) : null}
          {isPreviewOnly && failedSaveResult != null ? (
            <span className="canvas-output-node__actions">
              <button
                type="button"
                className="canvas-output-node__copy"
                aria-label="重试保存到本机"
                disabled={resuming}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  void handleResumeSave();
                }}
              >
                {resuming ? (
                  <>
                    <Icon name="circle-notch" className="spin-icon" aria-hidden="true" size="xs" />
                    正在保存…
                  </>
                ) : (
                  <>
                    <Icon name="arrow-clockwise" aria-hidden="true" size="xs" />
                    重试保存
                  </>
                )}
              </button>
            </span>
          ) : null}
        </>
      ) : isFailed ? (
        <>
          <span className="canvas-output-node__state canvas-output-node__state--failed">
            <Icon name="warning-circle" aria-hidden="true" size="sm" />
            <span className="canvas-output-node__state-title">{failedTitle}</span>
            <button
              type="button"
              className="canvas-output-node__copy"
              aria-label="复制错误信息"
              disabled={failedDetail == null}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                void copyFailedDetail();
              }}
            >
              {copied ? (
                <Icon name="check" aria-hidden="true" size="sm" />
              ) : (
                <Icon name="copy-simple" aria-hidden="true" size="sm" />
              )}
              {copied ? "已复制" : "复制错误"}
            </button>
          </span>
          <pre className="canvas-output-node__error" aria-label="完整原始返回" tabIndex={0}>
            {failedDetail ?? "正在读取原始返回…"}
          </pre>
          <span className="canvas-asset-node__meta">{metaLine}</span>
        </>
      ) : (
        <>
          <span className="canvas-output-node__state">
            <span className={isRunning ? "spin-icon" : undefined}>
              {phase === "saving" ? (
                <Icon name="check-circle" aria-hidden="true" size="md" />
              ) : (
                <Icon name="circle-notch" aria-hidden="true" size="md" />
              )}
            </span>
            <span className="canvas-output-node__status">
              {phase === "saving" ? (saveProgressLabel ?? "已成功 · 等待结果保存") : statusText}
            </span>
            {(isRunning && progress != null) || (phase === "saving" && savePercent != null) ? (
              <span
                className="canvas-output-node__progress"
                role="progressbar"
                aria-label={
                  phase === "saving" ? "结果保存进度" : `${isVideo ? "视频生成" : "图片生成"}进度`
                }
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={phase === "saving" ? (savePercent ?? 0) : (progress ?? 0)}
              >
                <i style={{ width: `${phase === "saving" ? savePercent : progress}%` }} />
              </span>
            ) : null}
          </span>
          <span className="canvas-asset-node__identity">
            <AssetKindIcon kind={node.mediaType} />
            <span className="canvas-asset-node__name" title={node.name ?? modelLabel ?? undefined}>
              {node.name ?? task?.outputName ?? modelLabel ?? shortenTaskId(node.taskId)}
            </span>
          </span>
          <span className="canvas-asset-node__meta">{metaLine}</span>
        </>
      )}
      {(onRename && hasLocalArtifact && !mediaCard) ||
      (isImage && onUploadToLocal && hasLocalArtifact) ||
      (onOpenHistory && node.mediaType !== "image") ||
      (onPrepareVideo && isVideo && hasArtifact) ||
      (hasLocalArtifact && isDesktopRuntime()) ? (
        <CanvasNodeActionsMenu label="产物操作" icon={<LibTVMediaIcon name="more-s" size={16} />}>
          {onPrepareVideo && isVideo && hasArtifact ? (
            <button type="button" onClick={() => onPrepareVideo(node.key)}>
              视频准备
            </button>
          ) : null}
          {onRename && hasLocalArtifact && !mediaCard ? (
            <NodeNameEditor
              name={fileBaseName(node.name ?? "产物") ?? "产物"}
              label="修改产物名称"
              onSave={(name) => onRename(node.key, name)}
            />
          ) : null}
          {isImage && onUploadToLocal && hasLocalArtifact ? <button type="button"
            disabled={node.uploadedToLocal === true} onClick={() => onUploadToLocal(node.key)}>
            {node.uploadedToLocal ? "已保存到素材库" : "保存到素材库"}
          </button> : null}
          {hasLocalArtifact && isDesktopRuntime() ? (
            <button
              type="button"
              disabled={exporting}
              onClick={() => {
                setExporting(true);
                void exportArtifactToDesktop(
                  node.finalPath!,
                  artifactFileName(node.name ?? "产物", node.finalPath!),
                )
                  .then((path) => {
                    if (path) toast.success("产物已导出");
                  })
                  .catch((error: unknown) => {
                    // 完整原文只进日志；用户看到的是提过摘要的一句话。
                    frontendLog("error", `[canvas] 导出产物失败: ${formatRawBackendError(error)}`);
                    toast.error(`导出失败：${backendErrorMessage(error)}`);
                  })
                  .finally(() => setExporting(false));
              }}
            >
              {node.mediaType === "image" ? (exporting ? "下载中…" : "下载图片") : (exporting ? "导出中…" : "按名称导出")}
            </button>
          ) : null}
          {onOpenHistory && node.mediaType !== "image" ? (
            <button type="button" onClick={() => onOpenHistory(node.taskId)}>
              原任务
            </button>
          ) : null}
        </CanvasNodeActionsMenu>
      ) : null}
      {availableSaveDestinations.length > 0 &&
      (node.mediaType === "video" || node.mediaType === "audio") &&
      node.finalPath != null ? (
        <CanvasMediaSaveMenu
          triggerLabel={`保存产物：${node.name ?? `${mediaLabel}产物`}`}
          availableDestinations={availableSaveDestinations}
          onSave={(destination) => {
            if (destination === "local") onUploadToLocal?.(node.key);
            else if (destination === "cloud") onUploadToCloud?.(node.key);
            else onUploadToObjectStorage?.(node.key);
          }}
        />
      ) : null}
      {!isImage && (canUseAsGenerationReference || canConnectToComposer) ? (
        <button
          type="button"
          className="canvas-asset-node__port"
          aria-label={`从${mediaLabel}产物 ${node.name ?? "未命名"} 拖出连线`}
          title={
            canUseAsGenerationReference
              ? isAudio
                ? "拖到提示词节点作为音频参考，或拖到支持音频输入的视频生成节点"
                : isVideo
                  ? "拖到提示词节点作为参考理解素材，或拖到图片/视频生成节点作为参考视频、视频拼接与合成、爆款视频复刻节点"
                  : "拖到提示词节点作为参考理解素材，或拖到图片/视频生成节点作为参考图片"
              : "拖到视频拼接与合成或爆款视频复刻节点"
          }
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onConnectionStart(node.key);
          }}
        />
      ) : null}
    </div>
  );
}

/** 画布上的结果展示节点：预览最近一次生成结果，可打开所在文件夹。 */
export function CanvasResultNode({
  node,
  descriptor,
  selected,
  dragging,
  latestResult,
  onSelect,
  onNodeDragStart,
}: {
  readonly node: ResultNodeData;
  readonly descriptor: StaticNodeDescriptor;
  readonly selected: boolean;
  readonly dragging: boolean;
  readonly latestResult: GenerationResultRecord | null;
  readonly onSelect: (key: string) => void;
  readonly onNodeDragStart: (
    key: string,
    x: number,
    y: number,
    clientX: number,
    clientY: number,
  ) => void;
  /**
   * 删除节点。原站卡片上没有删除按钮（删除走「选中后按 Delete」），
   * 这里保留 prop 只是为了不改动调用方的插槽契约，组件本身不再渲染删除入口。
   */
  readonly onRemove: (key: string) => void;
}) {
  return (
    <div
      className={`canvas-result-node${selected ? " is-selected" : ""}${dragging ? " is-dragging" : ""}`}
      onMouseDown={(event) => {
        if ((event.target as HTMLElement).closest(".canvas-result-node__actions")) return;
        onSelect(node.key);
        onNodeDragStart(node.key, node.x, node.y, event.clientX, event.clientY);
      }}
    >
      <div className="canvas-result-node__header">
        <span className="canvas-result-node__type">
          <NodeTypeIcon kind="result" />
          {descriptor.kindLabel}
        </span>
        <span className="canvas-result-node__title" title={descriptor.description}>
          {descriptor.title}
        </span>
        <span className="canvas-result-node__actions">
          {latestResult?.finalPath && isDesktopRuntime() ? (
            <button
              type="button"
              className="canvas-result-node__reveal"
              aria-label="在文件夹中显示生成结果"
              title="在文件夹中显示"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                if (latestResult.finalPath) {
                  void revealDesktopItem(latestResult.finalPath).catch(() => undefined);
                }
              }}
            >
              <Icon name="folder-open" aria-hidden="true" size="sm" />
            </button>
          ) : null}
        </span>
      </div>
      <span className="keyframe-preview keyframe-preview--large" aria-hidden="true">
        {latestResult != null && latestResult.mediaType === "text" ? (
          <pre className="canvas-result-node__text">
            {textResultFromSource(latestResult.source) ?? "（扩写文本未内联）"}
          </pre>
        ) : latestResult?.finalPath && isDesktopRuntime() ? (
          latestResult.mediaType === "video" ? (
            <video src={toMediaSrc(latestResult.finalPath)} muted playsInline preload="metadata" />
          ) : (
            <img
              src={toMediaSrc(latestResult.finalPath)}
              alt=""
              draggable={false}
              decoding="async"
            />
          )
        ) : null}
      </span>
      <span className="result-facts">
        <span>
          {latestResult
            ? `${latestResult.mediaType === "text" ? "文本" : ASSET_KIND_LABELS[latestResult.mediaType]}结果 · ${fileBaseName(latestResult.finalPath) ?? "路径未记录"}${
                formatBytes(latestResult.byteSize) ? ` · ${formatBytes(latestResult.byteSize)}` : ""
              }`
            : "暂无结果 · 发起生成后显示"}
        </span>
        <span className="result-saved">
          {latestResult ? (SAVE_STATUS_LABELS[latestResult.saveStatus] ?? "已保存") : "等待生成"}
        </span>
      </span>
    </div>
  );
}

/**
 * 自动适应原始媒体宽高比的缩略图：高度固定，宽度按比例计算，完整显示不裁剪。
 * 参考视频素材取中间帧作静止封面（与素材卡片、画布素材节点一致），
 * 封面图/首帧尚未就绪时先显示类型图标。
 *
 * 传入素材身份（`assetId`/`assetKind`）时，图片同样取用会话内已下载的字节：参考素材
 * 清单与素材库卡片、画布素材节点显示的是同一份素材，只在这里把供应商签名地址交给
 * `<img>`，会让同一张图在卡片里可见、在参考清单里只留一个类型图标。
 */
export function AutoSizeThumb({
  previewUrl,
  kind,
  assetId,
  assetKind,
  renewAsset,
  height = "2rem",
  maxWidth = "6rem",
}: {
  readonly previewUrl: string | null;
  readonly kind: string;
  /** 素材身份与 `previewUrl` 一起决定字节缓存的账目；缺省时只按地址直连渲染。 */
  readonly assetId?: string | undefined;
  readonly assetKind?: AssetKind | undefined;
  /**
   * 续签身份：地址失效时按它续签一次（云端回读供应商记录、本地重签对象存储地址）。
   * 缺省时保持只渲染的原行为 —— 本地文件、产物路径这类不依赖签名的地址不需要续签。
   */
  readonly renewAsset?: {
    readonly id: string;
    readonly source: string | null | undefined;
    readonly providerConnectionId: string | null | undefined;
  } | null;
  readonly height?: string;
  readonly maxWidth?: string;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [renewedUrl, setRenewedUrl] = useState<string | null>(null);
  const renewAttemptedRef = useRef(false);
  const effectiveUrl = renewedUrl ?? previewUrl;
  const bytes = useMediaByteSource(assetId ?? "", assetKind ?? "image", effectiveUrl);
  const resolvedUrl = bytes.url ?? effectiveUrl;
  // 失败按 URL 记忆而非布尔值：来源节点续签出新地址后，新 URL 会自动重试加载。
  const failed = resolvedUrl != null && failedUrl === resolvedUrl;
  // 缩略图同样要能自愈：同一份素材在卡片与画布节点上能恢复，在参考清单里却只剩类型
  // 图标，是最容易被忽略的「预览不可用」。每个地址只续签一次，不形成重试循环。
  const handleMediaError = (failedSource: string | null) => {
    setFailedUrl(failedSource);
    bytes.retry();
    if (bytes.fromCache || renewAttemptedRef.current || renewAsset == null) return;
    if (failedSource == null || failedSource === "") return;
    renewAttemptedRef.current = true;
    void refreshMediaUrlWithStagingFallback(renewAsset, assetKind ?? "image", failedSource).then(
      (freshUrl) => {
        if (freshUrl == null || freshUrl === "") return;
        if (freshUrl !== failedSource) {
          setRenewedUrl(freshUrl);
        }
        setFailedUrl(null);
        bytes.reload();
      },
    );
  };
  // 宽高比与来源地址一起记忆：来源换地址后旧比例立即失效，避免沿用上一份媒体的比例。
  const [measured, setMeasured] = useState<{ url: string; ratio: number } | null>(null);
  const measuredRatio = measured != null && measured.url === resolvedUrl ? measured.ratio : null;
  const videoSource =
    kind === "video" &&
    (isVideoSourceUrl(resolvedUrl) ||
      (resolvedUrl != null &&
        /^https?:\/\/localbase64\.localhost\/|^localbase64:\/\//i.test(resolvedUrl)))
      ? resolvedUrl
      : null;
  const showVideo = videoSource != null && !failed;
  const imageSource =
    videoSource == null && resolvedUrl != null && !failed && kind !== "audio" && kind !== "document"
      ? resolvedUrl
      : null;
  const measure = (url: string, ratio: number) => {
    if (Number.isFinite(ratio) && ratio > 0) setMeasured({ url, ratio });
  };

  const thumbStyle: CSSProperties =
    measuredRatio != null
      ? {
          width: `min(${maxWidth}, calc(${height} * ${measuredRatio}))`,
          aspectRatio: `${measuredRatio}`,
        }
      : { width: height };

  return (
    <span className="auto-size-thumb" style={{ ...thumbStyle, height }} aria-hidden="true">
      {showVideo ? (
        <VideoMiddleFrame
          src={videoSource}
          placeholder={<AssetKindIcon kind="video" size="md" />}
          onAspectRatioChange={(ratio) => measure(videoSource, ratio)}
          onLoadError={() => handleMediaError(videoSource)}
        />
      ) : imageSource != null ? (
        <img
          src={toMediaProxyUrl(imageSource) ?? imageSource}
          alt=""
          draggable={false}
          decoding="async"
          loading="lazy"
          onError={() => handleMediaError(imageSource)}
          onLoad={(event) => {
            const image = event.currentTarget;
            measure(imageSource, image.naturalWidth / image.naturalHeight);
          }}
        />
      ) : (
        <AssetKindIcon
          kind={kind === "document" ? "text" : (kind as "image" | "video" | "audio" | "text")}
          size="md"
        />
      )}
    </span>
  );
}

/**
 * 参考素材的字节缓存身份：与 @ 引用候选（`referenceCandidateFromTarget`）同一套映射，
 * 保证同一份素材在候选面板、参考清单、素材库与画布节点之间共用同一笔缓存账。
 */
function referenceAssetIdentity(
  target: MediaReferenceTarget | undefined,
): { readonly assetId: string; readonly kind: AssetKind } | null {
  if (target == null) return null;
  // 文本产物（Context-IR）没有可预览的字节流，不进字节缓存账本。
  if (target.mediaType === "text") return null;
  if (target.kind === "asset") return { assetId: target.assetId, kind: target.mediaType };
  if (target.kind === "local_asset") {
    return { assetId: target.stagingJobId, kind: target.mediaType };
  }
  if (target.kind === "local_base64_asset") {
    return { assetId: target.assetId, kind: target.mediaType };
  }
  if (target.kind === "local_result") {
    // 产物节点没有素材 ID：按产物身份记账，同一份产物的缩略图只下载一次。
    return {
      assetId: `${target.generationTaskId}#${target.resultIndex}`,
      kind: target.mediaType,
    };
  }
  return null;
}

/**
 * 生成节点的有效参考素材列表：直连素材可解绑，随提示词继承的素材标明来源。
 *
 * 缩略图只显示现有素材。持久化槽位仍负责身份与排序，界面编号与供应商的分类编号一致。
 */
export function GenerationInputChips({
  inputs,
  imageOnly = false,
  onUnlink,
  onInsertReference,
  reorderableKeys,
  onReorder,
}: {
  readonly inputs: readonly (ConnectedAssetInput | InheritedAssetInput)[];
  readonly imageOnly?: boolean;
  readonly positions?: ReadonlyMap<string, number>;
  readonly onUnlink: (edgeId: string) => void;
  /**
   * 把某个参考素材插进提示词（原站 liblib 的 @ 按钮就在参考瓦片上）。
   * 缺省时不渲染该按钮——瓦片只剩序号角标与解除连线。
   */
  readonly onInsertReference?:
    ((input: ConnectedAssetInput | InheritedAssetInput) => void) | undefined;
  readonly reorderableKeys?: ReadonlySet<string>;
  readonly onReorder?: (sourceKey: string, targetKey: string) => void;
}) {
  const [dragSourceKey, setDragSourceKey] = useState<string | null>(null);
  const referencePreview = useReferenceMediaPreview();
  const pointerDragRef = useRef<{
    pointerId: number;
    sourceKey: string;
    x: number;
    y: number;
  } | null>(null);
  const [dropTargetKey, setDropTargetKey] = useState<string | null>(null);
  if (inputs.length === 0) return null;
  const reorderableOrder = inputs
    .filter((input) => !("promptNodeKey" in input) && (reorderableKeys?.has(input.key) ?? true))
    .map((input) => input.key);
  const clearPointerDrag = () => {
    pointerDragRef.current = null;
    setDragSourceKey(null);
    setDropTargetKey(null);
  };
  const dropKeyAt = (source: HTMLElement, x: number, y: number) => {
    const target = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-media-input-key]");
    const key = target?.dataset["mediaInputKey"];
    return target && source.parentElement?.contains(target) && key && reorderableOrder.includes(key)
      ? key
      : null;
  };
  const counters = new Map<AssetKind, number>();
  const orderByIndex = new Map(inputs.map(input => {
    const ordinal = (counters.get(input.kind) ?? 0) + 1;
    counters.set(input.kind, ordinal);
    return [input.key, ordinal];
  }));
  return (
    <><ol className="node-media-inputs" aria-label="生成参考素材，按传入顺序排列">
      {inputs.map(input => {
        const inherited = "promptNodeKey" in input;
        const isOutput = !inherited && input.sourceLabel === "产物";
        const orderNumber = orderByIndex.get(input.key)!;
        const reorderIndex = reorderableOrder.indexOf(input.key);
        const canReorder = onReorder != null && reorderIndex >= 0 && reorderableOrder.length > 1;
        const previousKey = reorderIndex > 0 ? reorderableOrder[reorderIndex - 1] : null;
        const nextKey = reorderIndex >= 0 ? (reorderableOrder[reorderIndex + 1] ?? null) : null;
        const identity = referenceAssetIdentity(input.target);
        // 云端素材回读供应商记录；旧本地素材续签，新 Base64 素材校验本机正文。
        const target = input.target;
        const renewAsset =
          target?.kind === "asset"
            ? {
                id: target.assetId,
                source: "cloud",
                providerConnectionId: target.providerConnectionId,
              }
            : target?.kind === "local_asset"
              ? { id: target.stagingJobId, source: "local", providerConnectionId: null }
              : target?.kind === "local_base64_asset"
                ? { id: target.assetId, source: "local", providerConnectionId: null }
                : null;
        return (
          <li
            key={inherited ? `inherited:${input.promptNodeKey}:${input.key}` : input.edgeId}
            className={`node-media-chip${!imageOnly && inherited ? " is-inherited" : ""}${!imageOnly && isOutput ? " is-output" : ""}${canReorder ? " is-reorderable nodrag nopan" : ""}${dragSourceKey === input.key ? " is-dragging" : ""}${dropTargetKey === input.key ? " is-drop-target" : ""}`}
            data-media-input-key={input.key}
            onPointerEnter={event => { if (event.pointerType !== "touch") referencePreview.show(event.currentTarget,
              { key: input.key, name: input.name, kind: input.kind, url: input.previewUrl, assetId: identity?.assetId }); }}
            onPointerLeave={referencePreview.hide}
            onFocus={event => referencePreview.show(event.currentTarget,
              { key: input.key, name: input.name, kind: input.kind, url: input.previewUrl, assetId: identity?.assetId })}
            onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) referencePreview.hide(); }}
            draggable={false}
            /*
             * 原站 liblib 的参考缩略图是 48×48 方块，靠拖拽排序，没有上移/下移按钮；
             * 编辑层里那两个按钮因此隐藏了，键盘排序改由方块自身承担
             * （方块可聚焦，↑ / ↓ 调整顺序）。排序使用指针捕获，避免 Windows
             * WebView2 的原生文件拖放接管 HTML5 拖放；本机文件拖入仍保持原路径。
             */
            tabIndex={0}
            onKeyDown={(event) => {
              if (!canReorder || event.target !== event.currentTarget || event.nativeEvent.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey) return;
              if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
              event.preventDefault();
              event.stopPropagation();
              const target = event.key === "ArrowUp" || event.key === "ArrowLeft" ? previousKey : nextKey;
              if (target == null) return;
              onReorder?.(input.key, target);
            }}
            onPointerDown={canReorder ? (event) => {
              referencePreview.hide();
              event.stopPropagation();
              if (event.button !== 0 || (event.target instanceof Element && event.target.closest("button"))) return;
              event.preventDefault();
              event.currentTarget.focus();
              event.currentTarget.setPointerCapture(event.pointerId);
              pointerDragRef.current = { pointerId: event.pointerId, sourceKey: input.key, x: event.clientX, y: event.clientY };
            } : undefined}
            onPointerMove={canReorder ? (event) => {
              const drag = pointerDragRef.current;
              if (!drag || drag.pointerId !== event.pointerId || Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 4) return;
              setDragSourceKey(drag.sourceKey);
              const targetKey = dropKeyAt(event.currentTarget, event.clientX, event.clientY);
              setDropTargetKey(targetKey === drag.sourceKey ? null : targetKey);
            } : undefined}
            onPointerUp={canReorder ? (event) => {
              const drag = pointerDragRef.current;
              if (!drag || drag.pointerId !== event.pointerId) return;
              const moved = Math.hypot(event.clientX - drag.x, event.clientY - drag.y) >= 4;
              const targetKey = dropKeyAt(event.currentTarget, event.clientX, event.clientY);
              clearPointerDrag();
              if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
              if (moved && targetKey && targetKey !== drag.sourceKey) onReorder?.(drag.sourceKey, targetKey);
            } : undefined}
            onPointerCancel={canReorder ? clearPointerDrag : undefined}
            onLostPointerCapture={canReorder ? clearPointerDrag : undefined}
            onMouseDown={canReorder ? (event) => event.stopPropagation() : undefined}
            onDragStart={(event) => event.preventDefault()}
          >
            <span
              className="node-media-chip__order"
              aria-label={`${ASSET_KIND_LABELS[input.kind]} ${orderNumber}`}
            >
              {orderNumber}
            </span>
            <AutoSizeThumb
              previewUrl={input.previewUrl}
              kind={input.kind}
              assetId={identity?.assetId}
              assetKind={identity?.kind}
              renewAsset={identity != null ? renewAsset : null}
              height="2.5rem"
              maxWidth="7rem"
            />
            {/* 原站瓦片右下角是 @ 按钮：把这份参考插进提示词。 */}
            {onInsertReference && (!inherited || imageOnly) ? (
              <button
                type="button"
                className="node-media-chip__mention nodrag nopan"
                aria-label={`在提示词中引用：${input.name}`}
                disabled={!input.target}
                data-tooltip={input.target ? "引用素材到提示词" : "图片保存完成后可引用"}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  onInsertReference(input);
                }}
              >
                @
              </button>
            ) : null}
            <span
              className="node-media-chip__name"
              title={
                inherited
                  ? `${input.name} · 随提示词继承`
                  : isOutput
                    ? `${input.name} · 上游生成节点的已保存产物`
                    : input.name
              }
            >
              {input.name}
            </span>
            {!inherited ? <button type="button" className="node-media-chip__unlink"
              aria-label={"解除连线：" + input.name} data-tooltip="移除参考"
              onClick={event => { event.stopPropagation(); onUnlink(input.edgeId); }}>
              <Icon name="x" aria-hidden="true" size="2xs" />
            </button> : null}
          </li>
        );
      })}
    </ol>{referencePreview.layer}</>
  );
}
