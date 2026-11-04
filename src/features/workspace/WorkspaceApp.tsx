import { ImageLightbox } from "../../components/ImageLightbox";
import { copyTextToClipboard } from "../../lib/clipboard";
import { CanvasSelect } from "../../components/CanvasSelect";
import { Navigation, Workflow } from "lucide-react";
import { applyImageNodeResult, imageNodePreview, imageResultFromOutput, restoreImageNodeGeneration } from "./imageNodeResults";
import { CanvasContentNode, type NodeEditingProps } from "./CanvasContentNode";
import { usePromptAttachmentCount, usePromptSummary } from "./useNodePromptSummary";
import { Icon } from "../../components/Icon";
import {
  ESCAPE_PRIORITY_CANVAS,
  isInsideFormField,
  useEscapeHandler,
} from "../../components/escapeArbiter";
import { AppUpdateBanner } from "./AppUpdateBanner";
import { CanvasBottomDock, CanvasChromeControls } from "./CanvasChromeControls";
import { CanvasAllFeaturesDialog } from "./CanvasAllFeaturesDialog";
import type { ListFeatureAssets } from "./CanvasFeatureAssetPicker";
import { CanvasReferenceLibraryContext } from "./canvasReferenceLibrary";
import { loadCanvasGenerationTasks } from "./canvasGenerationTasks";
import { CanvasReferencePickingContext, useCanvasReferencePicking } from "./canvasReferencePicking";
import { CanvasImageMarkingBar, CanvasImageMarkingContext, useCanvasImageMarking } from "./CanvasImageMarking";
import "./CanvasReferencePicking.css";
import { CanvasTextImagePicker, CanvasTextReading, CanvasTextResource } from "./CanvasTextResource";
import { ErrorAlert } from "../../components/ErrorAlert";
import { canvasFeatureMediaType, type CanvasFeatureAction, type CanvasFeatureTarget, type CanvasInlineFeatureRequest } from "./canvasFeatureCatalog";
import { CanvasFeatureMediaEditor, type CanvasFeatureMediaSession } from "./CanvasFeatureMediaEditor";
import type { VideoOpeningDraft } from "./CanvasVideoOpeningEditor";
import { canPromoteSeedanceDraft } from "../../lib/seedanceDraft";
import { CanvasAtlasToolDialog, type CanvasAtlasToolOptions, type CanvasAtlasToolSession } from "./CanvasAtlasToolDialog";
import { invokeDesktop } from "../../lib/ipc";
import * as v from "valibot";
import { canvasImagePreset, selectCanvasImagePreset } from "../../lib/canvasImagePresets";
import { editableCanvasCameraControl } from "../../lib/canvasCameraControl";
import { CanvasChromeIcon } from "./CanvasChromeIcons";
import { CanvasAssetDrawerHost } from "./CanvasAssetDrawerHost";
import { CanvasCharacterStudio, type CharacterGenerationDraft } from "./CanvasCharacterStudio";
import { CanvasTvDirector } from "./CanvasTvDirector";
import { CanvasDirectorNode } from "./CanvasDirectorNode";
import type { DirectorMediaCapture, DirectorMotionRequest } from "./CanvasDirectorEditor";
import { DIRECTOR_NODE_SIZE, directorMotionRequest, directorSceneRequest, emptyDirectorScene, parseDirectorMotion, type DirectorScene } from "./directorScene";
import { directorImagePrompt, mergeDirectorLayout, parseDirectorLayout, type DirectorImageRequest } from "./directorSceneImport";
import { importDirectorMedia } from "./directorMedia";
import { CanvasStoryboardAssets, StoryboardResizeHandle } from "./CanvasStoryboardAssets";
import { StoryboardScriptDialog } from "./StoryboardScriptDialog";
import { LibTVMediaIcon } from "./LibTVMediaIcon";
import { readStoryboardLayout, storyboardFilmSource, storyboardProjectAssets,
  type StoryboardAsset, type StoryboardFilmSource, type StoryboardLayout } from "./storyboardProject";
import { directorDraftKey, directorHdParameter, isDirectorMediaKind, type DirectorCanvasContext, type DirectorJob, type DirectorTurn } from "./tvDirector";
import { characterPrompt, characterSourceFromAsset, characterVersionInfo, withCharacterSourcePaths, type CharacterMediaSource } from "./characterStudioModel";
import type { BrandModelSelection } from "../../lib/brandModels";
import { CanvasImageStyleMarket } from "./CanvasImageStyleMarket";
import { VideoEffectTemplatePanel } from "./VideoEffectTemplatePanel";
import { CanvasLibraryResourceCard } from "./CanvasLibraryResourceCard";
import {
  canvasLibraryResourcePreview,
  generationWithLibraryResources,
  libraryResourceConnectionIssue,
  type CanvasLibraryKind,
  type CanvasLibraryResource,
} from "./canvasLibraryResources";
import { MAX_VIDEO_EFFECTS } from "../../lib/videoEffectTemplates";
import type { CanvasAssetDrawerTab } from "./CanvasAssetDrawer";
import { CanvasOnboardingGuide } from "./CanvasOnboardingGuide";
import { readOnboardingSeen } from "./canvasOnboarding";
import { CanvasZoomMenu } from "./CanvasZoomMenu";
import { CanvasShortcutsDialog } from "./CanvasShortcutsDialog";
import { canvasShortcutFor } from "./canvasShortcuts";
import { CanvasContextMenu, type CanvasContextMenuItem } from "./CanvasContextMenu";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { longVideoClient, resolveLongVideoSettings, resolveLongVideoSegmentSeconds, LONG_VIDEO_RESULTS_REQUEST_EVENT, type LongVideoJob } from "../../lib/longVideo";
import { prepareVideoStoryboard } from "../../lib/videoStoryboard";
import { prepareVideoPromptForMode, videoCameraPresetsMuted, videoPromptForMode, hasVideoCameraPreset, VIDEO_CAMERA_EFFECT_CONFLICT } from "../../lib/videoCameraPresets";
import { useLongVideoJobs } from "./useLongVideoJobs";
import { VideoClipTimeline } from "./VideoClipTimeline";
import { clipRenderClient, clipJobActive, type ClipEdit, type ClipRenderJob, type StartClipRender, type ClipAgentModels, type ClipAgentModelOption, type ClipTimelineSettings } from "../../lib/videoClipEditing";
import { canvasImageClient, IMAGE_REGION_EDIT_BINDING, resolveImageUpscaler } from "../../lib/canvasImage";
import { planCanvasDerivedImage, stageCanvasRegionImages } from "./canvasDerivedImage";
import type { StartImageRegionEdit } from "./CanvasImageRegionEditor";
import {
  Background,
  BackgroundVariant,
  MiniMap,
  ReactFlow,
  SelectionMode,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type OnConnectEnd,
  type OnConnectStart,
  type OnNodeDrag,
  type ReactFlowInstance,
  type ReactFlowProps,
  type Viewport,
  useNodesState,
} from "@xyflow/react";
import {
  Suspense,
  cloneElement,
  lazy,
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
  type ReactElement,
} from "react";
import { toast } from "../../lib/toast";
import { useShallow } from "zustand/react/shallow";
import {
  assetLibraryClient,
  existingAssetClient,
  backendErrorMessage,
  formatRawBackendError,
  frontendLog,
  generationClient,
  promoteSeedanceDraft,
  renameGenerationResult,
  inferMediaKindFromName,
  isDesktopRuntime,
  loadProviderCatalog,
  pickLocalMediaFiles,
  pickPromptMultimodalFiles,
  promptNodeClient,
  translateCanvasTextClient,
  subscribeGenerationEvents,
  subscribeStagingEvents,
  toMediaSrc,
  tosStagingClient,
  localBase64AssetClient,
  LOCAL_ASSET_UNGROUPED_GROUP_ID,
  workspaceUiClient,
  type CloudAsset,
  type AssetGroupRecord,
  type AssetImportOutputRecord,
  type CloudAssetKindTotals,
  type GenerationOperation,
  type GenerationResultRecord,
  type VideoClipMode,
  type GenerationResultSaveProgress,
  type GenerationTaskPage,
  type GenerationTaskSummary,
  type GenerationTaskDetail,
  type LocalAssetKindTotals,
  type LocalAssetRecord,
  type LocalBase64AssetGroupRecord,
  type LocalBase64AssetRecord,
  type MediaReferenceTarget,
  type PromptOptimizationContextEntry,
  type PromptMultimodalInput,
  type PromptVisionImageInput,
  type ProviderCatalogEntry,
  type MediaLibraryKind,
  type RealPersonGroup,
  type StagingJobRecord,
  type StartGenerationCommand,
  type TosStagingConfig,
} from "../../lib/backend";
import { artifactFileName, resultDisplayName } from "./artifactNames";
import { exportArtifactToDesktop } from "./desktopActions";
import { canvasImageActionTarget, copyCanvasImage, downloadCanvasImage, duplicateCanvasImage } from "./canvasImageActions";
import {
  registerArtifactNameSync,
  publishArtifactNameChange,
  resolveCurrentArtifactName,
  artifactNameChangeMatches,
} from "./artifactNameSync";
import { exportArtifactDeliveryToDesktop } from "./artifactDelivery";
import type { VideoPreparationSource } from "./VideoPreparationDialog";
import { CanvasVideoFrameCropContext, type VideoFrameCropSession } from "./CanvasVideoFrameCrop";
import {
  videoPreparationClient,
  type VideoPreparationJob,
  type VideoPreparationOutput,
} from "../../lib/videoPreparation";
import {
  assetLibraryProviders,
  providerSupportsAssetLibrary,
  isDeletableCloudAssetGroupId,
  resolveActiveAssetLibraryProvider,
} from "../../lib/assetLibrarySupport";
import {
  generationParameters,
  isSeedance25VideoModel,
  modelParameterCapabilities,
  type ModelParameterCapability,
  type ModelParameterOption,
  type ModelParameterValue,
} from "../../lib/modelCapabilities";
import { compileCanvasVideoMode } from "../../lib/canvasVideoMode";
import { verifyGenerationMaterials } from "../../lib/generationMaterialVerification";
import { perTaskVideoUrlConnection, perTaskVideoUrlIssue } from "../../lib/perTaskVideo";
import type {
  PromptContentConnection,
  PromptContentDocumentV1,
  PromptContentEditorSession,
  PromptContentIssue,
} from "../../lib/promptContent";
import {
  cleanGeneratedPrompt,
  createPromptContentModule,
  promptContentDocumentMapsEqual,
} from "../../lib/promptContent";
import { parseCinematicDialogueResponse } from "./cinematicDialogueResponse";
import type { CinematicDialogueGuard } from "./cinematicDialogueValidator";
import {
  useCanvas,
  useCanvasCommands,
  useCanvasNodeEntry,
  useAllCanvasNodeKeys,
  useCanvasStore,
  canvasNodesOfState,
  canvasReadModelOfState,
  isSupportedConnection,
  type CanvasDocument,
  type CanvasDocumentV2,
  type CanvasNodeEntry,
  type CanvasNodeType,
  type CanvasNodesById,
  type CanvasNodesByType,
  type CanvasReadModel,
  type CanvasStoreNodeChange,
} from "../canvas/canvasStore";
import {
  useCanvasDocumentPersistence,
  type CanvasSessionServices,
} from "../canvas/useCanvasDocumentPersistence";
import { useDeferredSessionState } from "./useDeferredSessionState";
import { buildInputOrderByEdge } from "../canvas/connectionIndex";
import {
  createCanvasInputResolver,
  canvasInputEdgeOrder,
  connectedCanvasPromptText,
  canvasNodesByKeyFromDocument,
  type ConnectedCanvasTextInput,
  type ResolvedCanvasInputs,
} from "./canvasInputs";

import { CanvasFlowEdgeView, CanvasFlowNodeView } from "./CanvasFlowViews";
import { ConnectionQuickAddMenu, type QuickAddSearchNode } from "./ConnectionQuickAddMenu";
import {
  CANVAS_QUICK_ADD_CHOICES,
  EMPTY_CANVAS_SHORTCUTS,
  quickAddNodeDimensions,
  type CanvasQuickAddKind,
} from "./canvasQuickAddCatalog";
import { AssetPanel } from "./AssetPanelViews";
import {
  AssetGroupCreateDialog,
  AssetSourceDialog,
  DeferredDialogFallback,
  HistoryDialog,
  ProviderSettingsDialog,
  RealPersonAssetDialog,
} from "./deferredDialogs";
import { preloadHistoryDialog, preloadProviderSettingsDialog } from "./deferredDialogLoaders";
import { copyTextToDesktopClipboard, saveMarkdownDocumentToDesktop } from "./desktopActions";
import { CanvasDocumentSkillNode, CanvasPromptNode } from "./DocumentNodeViews";
import {
  IMAGE_TO_PROMPT_NODE_PROMPT,
  TEXT_TO_MUSIC_PROMPT,
  randomTextToVideoPrompt,
  type CanvasTextTryActionKey,
} from "./canvasTextTryActionCatalog";
import {
  CANVAS_TEXT_GENERATOR_PLACEHOLDER,
  CanvasTextGeneratorPanel,
  type CanvasTextGeneratorModelOption,
} from "./CanvasTextGeneratorPanel";
import { CanvasTextTryActions } from "./CanvasTextTryActions";
import {
  CanvasScriptTryActions,
  ScriptReferenceToolbar,
  scriptModelOptions,
} from "./CanvasScriptGenerator";
import {
  emptyScriptGenerator,
  emptyScriptShot,
  matchingScriptAssets,
  parseScriptComposition,
  parseScriptGeneration,
  replaceScriptTable,
  scriptDocument,
  scriptSourceSignature,
  type ScriptBatchFrame,
  type ScriptBatchItem,
  type ScriptBatchRun,
  type ScriptBatchStartRequest,
  type ScriptGeneratorState,
} from "./scriptGeneratorModel";
import {
  CanvasAssetLightbox,
  CanvasAssetNode,
  CanvasGenNode,
  CanvasOutputLightbox,
  CanvasOutputNode,
  CanvasResultNode,
} from "./MediaNodeViews";
import { CanvasAudioNode } from "./CanvasAudioNode";
import { VideoClipNode } from "./VideoClipNode";
import { AssetGroupFrame, CanvasMarqueeSelectionReader } from "./AssetGroupFrame";
import { classifyExternalMediaPaths, nativeDropClientPoint } from "./canvasExternalMediaDrop";
import {
  captureCanvasNodes,
  pasteCanvasNodes,
  type CanvasNodeClipboard,
} from "./canvasNodeClipboard";
import {
  assetGroupBounds,
  assetGroupFlowId,
  assetGroupIdFromFlowId,
  assetGroupKey,
  assetGroupsFromNodes,
  type CanvasGroupMember,
  canvasGroupMemberName,
  assetPickKey,
  isMediaGroupMember,
  isUploadableOutput,
  layoutAssetPlacements,
  nextLibraryPickOrder,
} from "./assetGroups";
import {
  resolveSeedanceTask,
  seedanceTaskInputs,
  selectSeedanceTask,
} from "../../lib/seedanceTasks";
import { prepareGreenScreenGeneration } from "../../lib/greenScreen";
import { greenScreenPreparationOutputs, greenScreenNodeSignature } from "./greenScreenPreparation";
import { prefetchLocalAssetMedia, resetLocalAssetMediaRegistry } from "./localAssetMedia";
import { prepareWhiteModelGeneration } from "../../lib/whiteModelControl";
import { preferredPanoramaParameters, preparePanoramaGeneration } from "../../lib/panorama";
import { appendVideoLocalEditPrompt, resolveVideoEditFrameTarget } from "../../lib/videoLocalEdit";
import { sameMediaReferenceTarget } from "../../lib/promptReferenceTarget";
import type {
  VideoLocalEditFrameResolution,
  VideoLocalEditResult,
  VideoLocalEditSource,
} from "./VideoLocalEditDialog";
import type {
  AssetEdgeData,
  AssetItem,
  AssetKind,
  AssetLibrarySource,
  AssetNodeData,
  AssetRefreshSource,
  AssetUploadEntry,
  CanvasFlowEdge,
  CanvasFlowNode,
  CanvasGenNodeKind,
  CanvasNodeDimensions,
  CanvasNodeRect,
  AudioNodeConfig,
  ConnectedAssetInput,
  ConnectedScreenplayInput,
  GenNodeData,
  GenerationMediaInput,
  ImageNodeConfig,
  MentionCandidate,
  NodeModelSelections,
  OutputLayerInfo,
  OutputNodeData,
  PromptNodeConfig,
  RetryInfo,
  ScreenplayNodeConfig,
  ScreenplayNodeData,
  VideoClipInput,
  VideoClipNodeConfig,
  VideoClipNodeData,
  VideoNodeConfig,
  VideoUrlMediaInput,
} from "./workspaceModel";
import { settleUnreadyCloudAsset } from "./cloudAssetSettlement";
import {
  repairUnavailableCloudAsset,
  replaceCloudAssetIdInPromptDocument,
} from "./unavailableAssetRepair";
import {
  ASSETS,
  ASSET_KIND_LABELS,
  ASSET_NODE_HEIGHT,
  ASSET_NODE_WIDTH,
  ASSET_PAGE_SIZE,
  CANVAS_CONNECTION_RADIUS,
  DEFAULT_NODE_MODEL_SELECTIONS,
  DEFAULT_ZOOM,
  DEMO_PROVIDER_CATALOG,
  EMPTY_GENERATION_TASKS,
  GENERATION_TASKS_POLL_INTERVAL_MS,
  GENERATION_TASKS_QUERY_KEY,
  GPT_IMAGE_MAX_GENERATION_COUNT,
  MAX_GENERATION_COUNT,
  MAX_ZOOM,
  MIN_ZOOM,
  RESULT_NODE_HEIGHT,
  RESULT_NODE_WIDTH,
  resolvePromptOptimizationMode,
  SCREENPLAY_NODE_COARSE_HEIGHT,
  SCREENPLAY_NODE_HEIGHT,
  SCREENPLAY_NODE_WIDTH,
  SCRIPT_GENERATOR_NODE_SIZE,
  UPLOAD_ABANDONED_MS,
  UPLOAD_POLL_INTERVAL_MS,
  ZOOM_STEP,
  assetNodeDimensions,
  assetNodeReferenceTarget,
  assetNodeKey,
  abandonedUploadError,
  fitMediaNodeDimensions,
  cloudAssetAwaitingId,
  cloudAssetToItem,
  createAudioNodeConfig,
  createImageNodeConfig,
  createPromptNodeConfig,
  createScreenplayNodeConfig,
  createVideoNodeConfig,
  documentSkillRoleLabel,
  fileNameFromPath,
  firstTextModelSelection,
  formatTaskRawResponse,
  genNodeDimensions,
  genNodeKey,
  generationInputMentionCandidate,
  getNodeDescriptor,
  isRunningTaskStatus,
  isPlaceholderAssetIdentity,
  textResultFromSource,
  isTerminalAssetUpload,
  isTerminalStagingJob,
  isTimedOutAssetImport,
  isUnresolvedLegacyAssetImport,
  isTerminalTaskStatus,
  isTextGenerationModel,
  isImageGenerationModel,
  localAssetToItem,
  localPathFileName,
  markdownDocumentExportName,
  measuredFor,
  mergeStagingJobsIntoUploads,
  shouldAutoDismissUpload,
  stagingImportReachedLibrary,
  UPLOAD_AUTO_DISMISS_DELAY_MS,
  clampCanvasZoom,
  canvasHomeViewport,
  modelDisplayNameForTask,
  nearestAvailableNodePosition,
  nextOutputSlot,
  nextPreparedMediaOutputSlot,
  NEW_NODE_GAP,
  normalizeLocalPathKey,
  outputNodeDimensions,
  outputNodeKey,
  outputNodeReferenceTarget,
  persistActiveAssetProviderId,
  persistAssetLibrarySource,
  parseAssetLibrarySource,
  promptConversationRoleLabel,
  promptMessageId,
  readActiveAssetProviderId,
  readAssetLibrarySource,
  reconcileNodeModelSelections,
  resolveGenerationSelection,
  resolvePendingDocumentNodeConfig,
  resolvePendingGenerationNodeConfig,
  screenplayMessageId,
  screenplayMaterialId,
  screenplayNodeKey,
  usesCoarsePointer,
  videoClipNodeKey,
  videoClipNodeName,
  VIDEO_CLIP_NODE_HEIGHT,
  VIDEO_CLIP_NODE_WIDTH,
} from "./workspaceModel";
import {
  VIDEO_CLIP_BACKEND_MODES,
  VIDEO_CLIP_DEFAULT_PARAMS,
  assignVideoClipSlots,
  videoClipMode,
  videoClipSlotIssue,
  videoClipUnusedMaterials,
  resolveVideoClipParams,
  type VideoClipModeKey,
  type VideoClipParams,
} from "./videoClipModes";

const CANVAS_FLOW_NODE_TYPES = { canvas: CanvasFlowNodeView };
const EMPTY_CANVAS_FLOW_NODES: CanvasFlowNode[] = [];
const VideoLocalEditDialog = lazy(() =>
  import("./VideoLocalEditDialog").then((module) => ({ default: module.VideoLocalEditDialog })),
);
const VideoPreparationDialog = lazy(() =>
  import("./VideoPreparationDialog").then((module) => ({ default: module.VideoPreparationDialog })),
);
const CANVAS_FLOW_EDGE_TYPES = { canvas: CanvasFlowEdgeView };

/**
 * 生成结果补发的最多尝试次数（含首次立即补发）。超过后不再轮询：卡片会停留在
 * 「正在保存本地副本」并保留结果记录里的错误，用户可用卡片上的按钮手动重试。
 */
const RESULT_RESCUE_MAX_ATTEMPTS = 8;

/**
 * 画布节点的 per-node 引用稳定缓存：inputs 浅比较全部相等时复用上次的
 * CanvasFlowNode 对象（含 data.content 的 JSX 元素引用），让 memo 化的
 * CanvasFlowNodeView 跳过未变化节点的整棵子树渲染。
 *
 * inputs 必须逐项使用 per-node 提取值（`map.get(key)` 直接用 undefined 表示缺失、
 * 布尔/字符串派生值、稳定回调引用），禁止用 `?? []` 之类每次新建的兜底对象。
 * cacheId 按节点类别分桶；节点删除后残留的 entry 是小对象，低频操作可接受。
 */
type CanvasFlowNodeCacheEntry = {
  readonly inputs: unknown[];
  readonly node: CanvasFlowNode;
};
type CanvasFlowNodeCache = Map<string, Map<string, CanvasFlowNodeCacheEntry>>;

/**
 * 画布保存时间戳：显示成「14:32:05」。
 *
 * 只显示时刻（不显示日期）是因为状态栏位置窄；而「是今天几点存的」正是用户
 * 判断「这份内容新不新」需要的粒度 —— 跨天的情况由状态栏的 title 属性补上
 * 完整日期，鼠标悬停即可看到。
 */
function formatSavedAt(timestamp: number): string {
  const date = new Date(timestamp);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

/** 保存时间的完整表述（供 title 属性用）：「2026-10-25 14:32:05」。 */
function formatSavedAtFull(timestamp: number): string {
  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day} ${formatSavedAt(timestamp)}`;
}

function stableCachedItem<T>(
  cache: Map<string, { inputs: unknown[]; node: T }>,
  key: string,
  inputs: unknown[],
  build: () => T,
): T {
  const previous = cache.get(key);
  if (
    previous != null &&
    previous.inputs.length === inputs.length &&
    inputs.every((value, index) => value === previous.inputs[index])
  ) {
    return previous.node;
  }
  const item = build();
  cache.set(key, { inputs, node: item });
  return item;
}

function stableCanvasFlowNode(
  caches: CanvasFlowNodeCache,
  cacheId: string,
  key: string,
  inputs: unknown[],
  build: () => CanvasFlowNode,
): CanvasFlowNode {
  let cache = caches.get(cacheId);
  if (cache == null) {
    cache = new Map();
    caches.set(cacheId, cache);
  }
  return stableCachedItem(cache, key, inputs, build);
}

// ── 画布节点 per-node 订阅基础设施 ──────────────────────────────────────────
// 巨型订阅拆分后，WorkspaceApp 壳只订阅选区/视图/成员与布局指纹；节点卡片经
// useCanvasNodeEntry 各自订阅自己的切片，单节点内容补丁只重渲染受影响的卡片。

/** Store-owned semantic snapshots retain cached inputs outside the changed successor closure. */
function sharedCanvasInputResolver(state: CanvasReadModel) {
  return state.resolveInputs;
}

interface CanvasNodeInputBadgeText {
  readonly summary: string;
  readonly details: string;
}
const EMPTY_CANVAS_NODE_INPUT_BADGE: CanvasNodeInputBadgeText = { summary: "", details: "" };
const canvasNodeInputBadgeCache = new WeakMap<ResolvedCanvasInputs, CanvasNodeInputBadgeText>();

/** 节点输入角标文本：直达来源数（剔除产物溯源边）+ 解析后的媒体/文本/等待清单。 */
function canvasNodeInputBadgeFor(
  state: CanvasReadModel,
  nodeKey: string,
): CanvasNodeInputBadgeText {
  const output = state.nodeByKey.output.get(nodeKey);
  const incoming = (state.graph.byTarget.get(nodeKey) ?? []).filter(
    (edge) => output?.sourceNodeId !== edge.fromKey,
  );
  if (incoming.length === 0) {
    return EMPTY_CANVAS_NODE_INPUT_BADGE;
  }
  const inputs = sharedCanvasInputResolver(state)(nodeKey);
  const cached = canvasNodeInputBadgeCache.get(inputs);
  if (cached != null) return cached;
  const summary =
    `已连接 ${incoming.length} 个来源 · ${inputs.media.length} 项媒体 · ${inputs.texts.length} 份文本` +
    (inputs.pending.length ? ` · 等待 ${inputs.pending.length} 项输出` : "");
  const details = [
    ...inputs.media.map((input) => input.name),
    ...inputs.texts.map((input) => input.name),
    ...inputs.pending.map((input) => `${input.name}：等待可用输出`),
  ].join("\n");
  const badge = { summary, details };
  canvasNodeInputBadgeCache.set(inputs, badge);
  return badge;
}

/** 输入角标自订阅：未受影响的解析结果共享角标引用，其他分支写入不触发重渲染。 */
const CanvasNodeInputBadge = memo(function CanvasNodeInputBadge({
  nodeKey,
}: {
  readonly nodeKey: string;
}) {
  const badge = useCanvas((state) => canvasNodeInputBadgeFor(state, nodeKey));
  if (!badge.summary) return null;
  return (
    <div className="canvas-flow-input-summary" role="status" title={badge.details}>
      {badge.summary}
    </div>
  );
});

interface CanvasNodeLayoutFields {
  readonly key: string;
  readonly x: number;
  readonly y: number;
  readonly measured?: { readonly width: number; readonly height: number };
  readonly assetGroupId?: string;
}

/**
 * 节点外壳布局指纹：成员、坐标、实测尺寸、选中态，以及会投射到外壳的少量内容
 * 字段（素材/产物的分组、工作流的端口开关）。内容补丁不改指纹 → 节点层订阅不动。
 */
function canvasNodeLayoutToken(
  node: CanvasNodeLayoutFields & { readonly groupId?: string | null },
  selected: boolean,
  extra = "",
): string {
  return [
    node.key,
    node.x,
    node.y,
    node.measured?.width ?? "",
    node.measured?.height ?? "",
    selected ? 1 : 0,
    node.groupId ?? "",
    node.assetGroupId ?? "",
    extra,
  ].join("\u0001");
}

/**
 * 一类节点的外壳指纹订阅（浅比较字符串数组）。指纹变化（增删/拖动落库/选中/
 * 分组变化）时节点层用 canvasNodesOfState 从当前快照重建外壳数组；内容补丁不触发。
 */
function useCanvasNodeLayoutTokens<K extends CanvasNodeType>(
  type: K,
  selectedKeys: ReadonlySet<string>,
  extra?: (node: CanvasNodesByType[K]) => string,
): readonly string[] {
  return useCanvas(
    useShallow((state) =>
      (state.nodes[type] as readonly CanvasNodesByType[K][]).map((node) =>
        canvasNodeLayoutToken(node, selectedKeys.has(node.key), extra ? extra(node) : ""),
      ),
    ),
  );
}

/**
 * 单节点派生值订阅（连线输入清单等）：对派生结果取内容 token，token 不变时复用上次
 * 的结果对象，让 zustand 引用比较判「无变化」——store 写入只有真正改变该节点派生
 * 内容时才重渲染这张卡片。compute 必须是纯函数（只用传入快照）。
 */
function useCanvasNodeDerived<T>(
  nodeKey: string,
  compute: (state: CanvasReadModel, key: string) => T,
  token: (value: T) => string,
): T {
  const cacheRef = useRef<{ token: string; value: T } | null>(null);
  return useCanvas((state) => {
    const next = compute(state, nodeKey);
    const nextToken = token(next);
    if (cacheRef.current != null && cacheRef.current.token === nextToken) {
      return cacheRef.current.value;
    }
    cacheRef.current = { token: nextToken, value: next };
    return next;
  });
}

// ── per-node 派生计算（纯函数，从读模型快照求值；与旧的全表 useMemo 等价） ──────

/** 生成节点当前连线的素材输入（携带连线 id 供解绑）。 */
function genConnectedInputsFor(
  state: CanvasReadModel,
  key: string,
): readonly ConnectedAssetInput[] {
  return sharedCanvasInputResolver(state)(key).media.map((input) => ({
    ...input,
    previewUrl: input.previewUrl ?? null,
  }));
}
function mediaInputsToken(inputs: readonly ConnectedAssetInput[]): string {
  return inputs
    .map(
      (input) =>
        `${input.key}\u0002${input.name}\u0002${input.previewUrl ?? ""}\u0002${input.edgeId}`,
    )
    .join("\u0003");
}

/** 文档类节点（剧本）的已连文本来源清单。 */
function documentInputsFor(
  state: CanvasReadModel,
  key: string,
): readonly ConnectedScreenplayInput[] {
  return sharedCanvasInputResolver(state)(key).texts.map((input) => ({
    key: input.key,
    name: input.name,
    document: input.text,
    edgeId: input.edgeId,
  }));
}
function documentInputsToken(inputs: readonly ConnectedScreenplayInput[]): string {
  return inputs
    .map((input) => `${input.key}\u0002${input.name}\u0002${input.document}\u0002${input.edgeId}`)
    .join("\u0003");
}

/**
 * 智能剪辑节点的上游素材。
 *
 * 媒体与文本都来自画布的通用输入解析：素材节点 / 产物节点给出媒体，
 * 提示词节点与剧本节点给出文本。原站按节点类型分槽位（视频 / 音频 /
 * 文字 / 产品图 / 参考视频 / 生成视频），槽位归属在 videoClipModes.ts 里按
 * 模式声明，这里只负责把上游条目按类型分好。
 */
function videoClipInputsFor(state: CanvasReadModel, key: string): readonly VideoClipInput[] {
  const resolved = sharedCanvasInputResolver(state)(key);
  const media: VideoClipInput[] = resolved.media.map((input) => ({
    key: input.key,
    name: input.name,
    nodeType:
      input.kind === "video" || input.kind === "image" || input.kind === "audio"
        ? input.kind
        : "video",
    edgeId: input.edgeId,
    previewUrl: input.previewUrl ?? null,
    ...(input.target ? { target: input.target } : {}),
  }));
  const texts: VideoClipInput[] = resolved.texts.map((input) => ({
    key: input.key,
    name: input.name,
    nodeType: "text" as const,
    edgeId: input.edgeId,
    previewUrl: null,
    text: input.text,
  }));
  return [...media, ...texts];
}
function videoClipInputsToken(inputs: readonly VideoClipInput[]): string {
  return inputs
    .map(
      (input) =>
        `${input.key}\u0002${input.nodeType}\u0002${input.edgeId}\u0002${input.previewUrl ?? ""}\u0002${input.text ?? ""}`,
    )
    .join("\u0003");
}

const generationPreviewIndex = new WeakMap<
  readonly OutputNodeData[],
  ReadonlyMap<string, OutputNodeData>
>();
function latestGenerationPreviewFor(state: CanvasReadModel, key: string): OutputNodeData | null {
  const source = state.nodeByKey.gen.get(key);
  if (source?.kind === "image" && source.imageGeneration) return imageNodePreview(source);
  let index = generationPreviewIndex.get(state.nodes.output);
  if (index == null) {
    const previews = new Map<string, OutputNodeData>();
    for (const output of state.nodes.output) {
      if (
        (output.mediaType === "image" ||
          output.mediaType === "video" ||
          output.mediaType === "audio") &&
        (output.finalPath != null || output.previewSrc != null)
      )
        previews.set(output.sourceNodeId, output);
    }
    index = previews;
    generationPreviewIndex.set(state.nodes.output, index);
  }
  return index.get(key) ?? null;
}

function generationPreviewToken(output: OutputNodeData | null): string {
  return output == null
    ? ""
    : `${output.key}\u0002${output.finalPath ?? ""}\u0002${output.previewSrc ?? ""}`;
}

/** 某生成节点的 @ 候选：直连素材 + 随提示词继承的参考图。 */
function mentionCandidatesFor(state: CanvasReadModel, key: string): readonly MentionCandidate[] {
  return sharedCanvasInputResolver(state)(key).media.map(generationInputMentionCandidate);
}
function mentionCandidatesToken(candidates: readonly MentionCandidate[]): string {
  return candidates
    .map(
      (candidate) =>
        `${candidate.canvasNodeKey}\u0002${candidate.assetId}\u0002${candidate.name}\u0002${candidate.generationTaskId ?? ""}\u0002${candidate.resultIndex ?? ""}`,
    )
    .join("\u0003");
}

/** 非提示词生成节点合并后的上游文本（提示词自动导入用）。 */
function promptSourceTextsFor(
  state: CanvasReadModel,
  key: string,
): readonly ConnectedCanvasTextInput[] {
  return sharedCanvasInputResolver(state)(key).texts;
}
function promptSourceTextsToken(texts: readonly { edgeId: string }[]): string {
  return texts.map((input) => input.edgeId).join("\u0003");
}

/** 提示词节点输出端显示的下游生成目标，供节点内解除单条连线。 */
function promptTargetsFor(
  state: CanvasReadModel,
  key: string,
): { key: string; name: string; kind: "image" | "video" | "audio"; edgeId: string }[] {
  const targets: { key: string; name: string; kind: "image" | "video" | "audio"; edgeId: string }[] = [];
  for (const edge of state.graph.edges) {
    if (edge.fromKey !== key) continue;
    const target = state.nodeByKey.gen.get(edge.toKey);
    if (target == null || target.kind === "prompt") continue;
    targets.push({
      key: target.key,
      name: `${target.kind === "image" ? "图片" : target.kind === "audio" ? "音频" : "视频"}生成 ${target.key.slice(-6)}`,
      kind: target.kind,
      edgeId: edge.id,
    });
  }
  return targets;
}
function promptTargetsToken(targets: readonly { key: string; edgeId: string }[]): string {
  return targets.map((target) => `${target.key}\u0002${target.edgeId}`).join("\u0003");
}

/** 绿幕节点的预处理产物视频清单。 */
function greenScreenResultsFor(
  state: CanvasReadModel,
  key: string,
  config: Extract<GenNodeData, { readonly kind: "video" }>["config"],
) {
  return greenScreenPreparationOutputs(key, config, state.nodes.output).map((output) => ({
    key: output.key,
    taskId: output.taskId,
    finalPath: output.finalPath!,
    name: output.name ?? "绿幕视频",
    src: toMediaSrc(output.finalPath!),
  }));
}
function greenScreenResultsToken(results: readonly { key: string; finalPath: string }[]): string {
  return results.map((result) => `${result.key}\u0002${result.finalPath}`).join("\u0003");
}

// ── 自订阅节点卡片 slot ─────────────────────────────────────────────────────
// slot 只从父层拿 nodeKey、按节点抽取的运行态与稳定回调；节点数据与 store 派生输入
// 一律自订阅。外壳缓存（stableCanvasFlowNode）命中时 slot 元素复用，memo 后跳过渲染。

type AssetNodeCardSlotProps = Omit<
  ComponentProps<typeof CanvasAssetNode>,
  "node" | "edgeCount" | "dragging"
> & {
  readonly nodeKey: string;
  readonly onReplaceLibraryResource: (key: string, kind: CanvasLibraryKind) => void;
};
const CanvasAssetNodeCardSlot = memo(function CanvasAssetNodeCardSlot(
  props: AssetNodeCardSlotProps,
) {
  const { nodeKey, onReplaceLibraryResource, ...card } = props;
  const entry = useCanvasNodeEntry(nodeKey);
  const edgeCount = useCanvas((state) => state.graph.countByNode.get(nodeKey) ?? 0);
  if (entry?.type !== "asset") return null;
  const resource = entry.data.libraryResource;
  if (resource) {
    return <CanvasLibraryResourceCard resource={resource} name={entry.data.name}
      onReplace={() => onReplaceLibraryResource(nodeKey, resource.kind)} />;
  }
  return (
    <>
      <CanvasAssetNode node={entry.data} edgeCount={edgeCount} dragging={false} {...card} />
      {entry.data.kind === "audio" ? <CanvasNodeInputBadge nodeKey={nodeKey} /> : null}
    </>
  );
});

type OutputNodeCardSlotProps = Omit<
  ComponentProps<typeof CanvasOutputNode>,
  | "node"
  | "dragging"
  | "task"
  | "retryInfo"
  | "results"
  | "saveProgress"
  | "rawResponse"
  | "modelLabel"
> & {
  readonly nodeKey: string;
  readonly task: GenerationTaskSummary | null;
  readonly retryInfo: RetryInfo | null;
  readonly results: readonly GenerationResultRecord[];
  readonly saveProgress: GenerationResultSaveProgress | null;
  readonly rawResponse: string | null;
  readonly modelLabel: string | null;
};
const CanvasOutputNodeCardSlot = memo(function CanvasOutputNodeCardSlot(
  props: OutputNodeCardSlotProps,
) {
  const { nodeKey, task, retryInfo, results, saveProgress, rawResponse, modelLabel, ...card } =
    props;
  const entry = useCanvasNodeEntry(nodeKey);
  if (entry?.type !== "output") return null;
  return (
    <>
      <CanvasOutputNode
        node={entry.data}
        dragging={false}
        task={task}
        retryInfo={retryInfo}
        results={results}
        saveProgress={saveProgress}
        rawResponse={rawResponse}
        modelLabel={modelLabel}
        {...card}
      />
      {entry.data.mediaType === "audio" || entry.data.mediaType === "text" ? <CanvasNodeInputBadge nodeKey={nodeKey} /> : null}
    </>
  );
});

type ResultNodeCardSlotProps = Omit<
  ComponentProps<typeof CanvasResultNode>,
  "node" | "selected" | "dragging" | "descriptor" | "latestResult"
> & {
  readonly nodeKey: string;
  readonly selected: boolean;
  readonly descriptor: ComponentProps<typeof CanvasResultNode>["descriptor"];
  readonly latestResult: ComponentProps<typeof CanvasResultNode>["latestResult"];
};
const CanvasResultNodeCardSlot = memo(function CanvasResultNodeCardSlot(
  props: ResultNodeCardSlotProps,
) {
  const { nodeKey, selected, descriptor, latestResult, ...card } = props;
  const entry = useCanvasNodeEntry(nodeKey);
  if (entry?.type !== "result") return null;
  return (
    <>
      <CanvasResultNode
        node={entry.data}
        descriptor={descriptor}
        selected={selected}
        dragging={false}
        latestResult={latestResult}
        {...card}
      />
      <CanvasNodeInputBadge nodeKey={nodeKey} />
    </>
  );
});

const ignoreEditorSizeChange = () => {};

type ScriptReferencePick = { readonly nodeKey: string; readonly assetId?: string; readonly character?: boolean };

type DocumentNodeCardSlotProps = Omit<
  ComponentProps<typeof CanvasDocumentSkillNode>,
  "node" | "selected" | "dragging" | "sourceInputs" | "connectedMedia"
> &
  NodeEditingProps & {
    readonly nodeKey: string;
    readonly canvasId: string;
    readonly selected: boolean;
    readonly onScriptUpdate: (key: string, update: (config: ScreenplayNodeConfig) => ScreenplayNodeConfig) => void;
    readonly onScriptStory: (key: string) => void;
    readonly onScriptPickReference: (request: ScriptReferencePick) => void;
    readonly onScriptTranslate: (key: string) => void;
    readonly scriptTranslating: boolean;
    readonly scriptEditorOpen: boolean;
    readonly onScriptCreateMedia: (key: string, shotId: string, kind: "image" | "video") => void;
    readonly onScriptCreateAsset: (key: string, assetId: string) => void;
    readonly onScriptSmartCompose: (key: string, shotIds: readonly string[]) => void;
    readonly onScriptBatchStart: (key: string, request: ScriptBatchStartRequest) => void;
    readonly onScriptBatchResume: (key: string, batchId: string) => void;
    readonly onScriptFilm: (sources: readonly StoryboardFilmSource[]) => Promise<void>;
    readonly scriptBatchRunning: boolean;
  };
function CanvasDocumentNodeCardSlot(props: DocumentNodeCardSlotProps) {
  const {
    nodeKey,
    canvasId,
    selected,
    presentation = "card",
    editorOpen,
    onEdit,
    onCloseEditor,
    onScriptUpdate,
    onScriptStory,
    onScriptPickReference,
    onScriptTranslate,
    scriptTranslating,
    scriptEditorOpen,
    onScriptCreateMedia,
    onScriptCreateAsset,
    onScriptSmartCompose,
    onScriptBatchStart,
    onScriptBatchResume,
    onScriptFilm,
    scriptBatchRunning,
    ...card
  } = props;
  const entry = useCanvasNodeEntry(nodeKey);
  const sourceInputs = useCanvasNodeDerived(nodeKey, documentInputsFor, documentInputsToken);
  const connectedMedia = useCanvas((state) => sharedCanvasInputResolver(state)(nodeKey).media);
  if (entry == null || entry.type !== "screenplay") return null;
  const script = entry.data.config.scriptGenerator;
  if (script) {
    const node = entry.data;
    const options = scriptModelOptions(card.providerCatalog);
    const modelValue = `${node.config.modelSelection.providerId}::${node.config.modelSelection.modelDefinitionId}`;
    const modelOptions = options.some((option) => option.value === modelValue) ? options : [
      { value: modelValue, label: node.config.modelSelection.modelDefinitionId || "请选择文本模型" },
      ...options,
    ];
    const onUpdate = (update: (config: ScreenplayNodeConfig) => ScreenplayNodeConfig) =>
      onScriptUpdate(nodeKey, update);
    const onPick = (key: string) => onScriptPickReference({ nodeKey: key });
    const onRemoveMaterial = card.onRemoveMaterial ?? (() => {});
    if (presentation === "editor") {
      return editorOpen && scriptEditorOpen ? <StoryboardScriptDialog canvasId={canvasId} node={node} active
        running={card.running} batchRunning={scriptBatchRunning}
        error={card.error} providerCatalog={card.providerCatalog}
        sourceInputs={sourceInputs} connectedMedia={connectedMedia} onUpdate={onUpdate} onRun={card.onSend}
        onPick={onPick} onPickAsset={(key, assetId) => onScriptPickReference({ nodeKey: key, assetId })}
        onRemoveMaterial={onRemoveMaterial} onUnlink={card.onUnlink}
        onExport={card.onExport} onCreateMedia={onScriptCreateMedia} onCreateAsset={onScriptCreateAsset} onSmartCompose={onScriptSmartCompose}
        onStartBatch={onScriptBatchStart} onResumeBatch={onScriptBatchResume} onFilm={onScriptFilm} onClose={onCloseEditor} /> : null;
    }
    const toolbar = <ScriptReferenceToolbar node={node} inputs={[...sourceInputs, ...connectedMedia]}
      running={card.running} onPick={onPick} onRemove={onRemoveMaterial} onUnlink={card.onUnlink} />;
    return (
      <CanvasContentNode node={node} kindLabel="脚本生成器" icon="book-open-text" selected={selected} scriptCard
        editorOpen={editorOpen && scriptEditorOpen}
        onEdit={onEdit} onCloseEditor={onCloseEditor}
        onSelect={card.onSelect} onRemove={card.onRemove} onSizeChange={card.onSizeChange}
        summary="" metadata="" status=""
        busy={card.running} error={card.error}
        cardBody={!script.shots.length && !card.running && !card.error ? <CanvasScriptTryActions
          onStory={() => onScriptStory(nodeKey)}
          onCharacter={() => {
            card.onSelect(nodeKey);
            onScriptPickReference({ nodeKey, character: true });
          }}
          onManual={() => {
            onUpdate((current) => {
              if (!current.scriptGenerator || current.scriptGenerator.shots.length) return current;
              const next = { ...current.scriptGenerator, step: "confirm-shots" as const, shots: [emptyScriptShot()] };
              return { ...current, scriptGenerator: next, currentDocument: scriptDocument(next) };
            });
            card.onSelect(nodeKey);
            onEdit(nodeKey);
          }} /> : <div className="canvas-text-card__body nowheel">
          {card.running ? <span role="status" className="canvas-text-card__status">正在生成分镜脚本…</span> : null}
          {card.error ? <ErrorAlert id={`node-preview-error-${nodeKey}`} error={card.error} /> : null}
          {script.shots.length ? <>
            <strong>{script.shots.length} 个镜头</strong>
            <ol className="canvas-script-card__shots">{script.shots.slice(0, 5).map(shot =>
              <li key={shot.id}>{shot.duration ? `${shot.duration} 秒 · ` : ""}{shot.plot.trim().slice(0, 120) || "待填写画面描述"}</li>)}</ol>
          </> : null}
        </div>}
        floatingPanel={selected ? <CanvasTextGeneratorPanel
          className="canvas-text-generator--text canvas-text-generator--script nodrag nowheel nopan" value={node.config.composer}
          onValueChange={(value) => onUpdate((current) => ({ ...current, composer: value }))}
          modelOptions={modelOptions} canChooseModel={options.length > 0} modelValue={modelValue}
          modelReady={options.some(option => option.value === modelValue)}
          onModelChange={(value) => {
            const separator = value.indexOf("::");
            if (separator <= 0) return;
            onUpdate((current) => ({ ...current, modelSelection: {
              providerId: value.slice(0, separator), modelDefinitionId: value.slice(separator + 2),
            } }));
          }}
          onTranslate={() => onScriptTranslate(nodeKey)} translating={scriptTranslating}
          onSubmit={() => card.onSend(nodeKey)} submitting={card.running} disabled={card.running}
          allowEmpty={sourceInputs.some((input) => input.document.trim()) || connectedMedia.length > 0 || (node.config.materials?.length ?? 0) > 0}
          submitLabel="生成分镜脚本" modelLabel="脚本生成模型" toolbar={toolbar}
          placeholder="描述剧情片段、故事，为你生成分镜脚本" /> : undefined} />
    );
  }
  const kindLabel = "剧本创作与优化";
  return (
    <>
      <CanvasContentNode
        node={entry.data}
        kindLabel={kindLabel}
        icon="book-open-text"
        selected={selected}
        presentation={presentation}
        editorOpen={editorOpen}
        onEdit={onEdit}
        onCloseEditor={onCloseEditor}
        onSelect={card.onSelect}
        onRemove={card.onRemove}
        onSizeChange={card.onSizeChange}
        summary={
          card.streamingText?.trim()
            ? card.streamingText
            : entry.data.config.currentDocument.trim()
              ? entry.data.config.currentDocument
              : entry.data.config.composer
        }
        metadata={`${sourceInputs.length} 份上游文本 · ${connectedMedia.length + (entry.data.config.materials?.length ?? 0)} 项参考 · ${entry.data.config.currentDocument.length} 字`}
        status={
          card.running
            ? "正在生成"
            : card.error
              ? "需要处理"
              : entry.data.config.currentDocument.trim()
                ? "稿件已就绪"
                : "等待创作"
        }
        busy={card.running}
        error={card.error}
      >
        <CanvasDocumentSkillNode
          node={entry.data}
          selected={selected}
          dragging={false}
          sourceInputs={sourceInputs}
          connectedMedia={connectedMedia}
          {...card}
          onSizeChange={ignoreEditorSizeChange}
        />
      </CanvasContentNode>
      {presentation === "card" ? <CanvasNodeInputBadge nodeKey={nodeKey} /> : null}
    </>
  );
}

/**
 * 智能剪辑节点 slot：卡片与编辑层共用一份节点数据与输入派生，
 * store 写入只有真正改变该节点派生内容时才重渲染。
 */
type VideoClipNodeCardProps = Omit<
  ComponentProps<typeof VideoClipNode>,
  "node" | "selected" | "dragging" | "inputs" | "candidates"
> & { readonly nodeKey: string; readonly selected: boolean };
const CanvasVideoClipNodeCardSlot = memo(function CanvasVideoClipNodeCardSlot(
  props: VideoClipNodeCardProps,
) {
  const { nodeKey, selected, ...card } = props;
  const entry = useCanvasNodeEntry(nodeKey);
  const inputs = useCanvasNodeDerived(nodeKey, videoClipInputsFor, videoClipInputsToken);
  const candidates = useCanvasNodeDerived(nodeKey, mentionCandidatesFor, mentionCandidatesToken);
  if (entry?.type !== "videoClip") return null;
  return (
    <>
      <VideoClipNode
        node={entry.data}
        inputs={inputs}
        candidates={candidates}
        selected={selected}
        dragging={false}
        {...card}
      />
      <CanvasNodeInputBadge nodeKey={nodeKey} />
    </>
  );
});

/** gen 节点 slot：提示词/图片/视频三态共用，store 派生输入全部自订阅。 */
type PromptNodeCardProps = ComponentProps<typeof CanvasPromptNode>;
type GenNodeCardProps = ComponentProps<typeof CanvasGenNode>;
type Param0<T> = Parameters<T extends (...args: never) => unknown ? T : never>[0];

/** 首次选中前不创建大表单；打开过的编辑会话随后常驻，避免视口裁剪打断输入。 */
function RetainedNodeEditor({
  open,
  children,
}: {
  readonly open: boolean;
  readonly children: ReactNode;
}) {
  const [visited, setVisited] = useState(open);
  if (open && !visited) setVisited(true);
  return open || visited ? children : null;
}
type GenNodeCardSlotProps = {
  readonly featureRequest?: CanvasInlineFeatureRequest | undefined;
  readonly canvasId: string;
  readonly presentation?: "card" | "editor";
  readonly editorOpen: boolean;
  readonly onRename: (key: string, name: string) => void;
  readonly onSelectImageResult: (key: string, resultKey: string) => void;
  readonly onPreviewImage: (key: string) => void;
  readonly onEnhanceImage: GenNodeCardProps["onEnhanceImage"];
  readonly onEditImageRegion: StartImageRegionEdit;
  readonly nodeKey: string;
  readonly selected: boolean;
  readonly running: boolean;
  readonly streamingText: string | null;
  readonly error: string | null;
  readonly activeTask: GenerationTaskSummary | null;
  readonly latestTask: GenerationTaskSummary | null;
  readonly nodeTasks: readonly GenerationTaskSummary[];
  readonly onOpenGenerationTask: (taskId: string) => void;
  readonly onPromoteSeedanceDraft: (taskId: string) => Promise<string>;
  readonly descriptorContext: Parameters<typeof getNodeDescriptor>[1];
  readonly providerCatalog: readonly ProviderCatalogEntry[];
  readonly promptContents: ReturnType<typeof createPromptContentModule>;
  readonly aliveCanvasNodeKeys: ReadonlySet<string>;
  readonly onSelect: NonNullable<GenNodeCardProps["onSelect"]>;
  readonly onEdit: NonNullable<GenNodeCardProps["onEdit"]>;
  readonly onCloseEditor: () => void;
  readonly onNodeDragStart: NonNullable<GenNodeCardProps["onNodeDragStart"]>;
  readonly onRemove: NonNullable<GenNodeCardProps["onRemove"]>;
  readonly onUnlink: NonNullable<GenNodeCardProps["onUnlink"]>;
  readonly onConnectionStart: NonNullable<PromptNodeCardProps["onConnectionStart"]>;
  readonly onSizeChange: NonNullable<GenNodeCardProps["onSizeChange"]>;
  readonly onReorderInput: NonNullable<GenNodeCardProps["onReorderInput"]>;
  readonly registerPromptInput: NonNullable<GenNodeCardProps["registerPromptInput"]>;
  readonly onPromptChange: (
    nodeKey: string,
    config: Param0<PromptNodeCardProps["onChange"]>,
  ) => void;
  /**
   * 面板写入：只改一个字段，其余字段按**当前**值保留。
   *
   * 为什么不能拿渲染时的配置快照回写：模型生成完成与用户打字可能撞在一起，
   * 面板与节点内的输入框是并存的第二个入口，拿旧快照回写会把刚生成的正文覆盖掉。
   */
  readonly onPromptFieldChange: (
    nodeKey: string,
    patch: Partial<PromptNodeConfig>,
  ) => void;
  readonly onRunPrompt: (nodeKey: string, generalText?: boolean) => void;
  /** 「尝试：」四个入口；节点 key 由卡片自己带上。 */
  readonly onTextTryAction: (nodeKey: string, action: CanvasTextTryActionKey) => void;
  /** 悬浮生成器面板的「翻译提示词」。 */
  readonly onTranslateCanvasText: (nodeKey: string) => void;
  /** 本节点是否正在做提示词翻译（面板的翻译键显示忙碌态）。 */
  readonly translating: boolean;
  /** 打开后把光标放进正文编辑器（画布上的「自己编写内容」用）。 */
  readonly autoFocusOutput: boolean;
  readonly onPromptFocusRequest: (nodeKey: string) => void;
  readonly onPromptFocusHandled: (nodeKey: string) => void;
  readonly onImageConfigChange: NonNullable<GenNodeCardProps["onImageConfigChange"]>;
  readonly onOpenCharacterStudio: (key: string) => void;
  readonly onVideoConfigChange: NonNullable<GenNodeCardProps["onVideoConfigChange"]>;
  /** 音频节点配置（模型 / 语种 / 采样率 / 输出格式 / 三档滑杆）。 */
  readonly onAudioConfigChange: (key: string, config: AudioNodeConfig) => void;
  /** 音频节点的「音频生视频」：在右侧建视频节点并连入这段音频。 */
  readonly onAudioToVideo: (nodeKey: string) => void;
  /** 音频节点的「翻译提示词」。 */
  readonly onTranslateAudioPrompt: (nodeKey: string) => void;
  readonly onAnnotateVideo: NonNullable<GenNodeCardProps["onAnnotateVideo"]>;
  readonly onGreenScreenUseResult: (
    ...args: Parameters<NonNullable<GenNodeCardProps["onGreenScreenUseResult"]>>
  ) => unknown;
  readonly onImportGreenScreenVideo: (
    ...args: Parameters<NonNullable<GenNodeCardProps["onImportGreenScreenVideo"]>>
  ) => unknown;
  readonly onStartGeneration: (
    ...args: Parameters<NonNullable<GenNodeCardProps["onStartGeneration"]>>
  ) => unknown;
};
function CanvasGenNodeCardSlot(props: GenNodeCardSlotProps) {
  const {
    presentation = "card",
    editorOpen,
    onCloseEditor,
    nodeKey,
    selected,
    running,
    streamingText,
    error,
    activeTask,
    latestTask,
    descriptorContext,
    providerCatalog,
    promptContents,
    aliveCanvasNodeKeys,
    onSelect,
    onEdit,
    onNodeDragStart,
    onRemove,
    onUnlink,
    onConnectionStart,
    onSizeChange,
    onReorderInput,
    registerPromptInput,
    onPromptChange,
    onPromptFieldChange,
    onRunPrompt,
    onTextTryAction,
    onTranslateCanvasText,
    translating,
    autoFocusOutput,
    onPromptFocusRequest,
    onPromptFocusHandled,
    onImageConfigChange,
    onOpenCharacterStudio,
    onVideoConfigChange,
    onAudioConfigChange,
    onAudioToVideo,
    onTranslateAudioPrompt,
    onAnnotateVideo,
    onGreenScreenUseResult,
    onImportGreenScreenVideo,
    onStartGeneration,
    onRename,
  } = props;
  const entry = useCanvasNodeEntry(nodeKey);
  const promptSummary = usePromptSummary(promptContents, nodeKey);
  const promptAttachmentCount = usePromptAttachmentCount(promptContents, nodeKey);
  const previewOutput = useCanvasNodeDerived(
    nodeKey,
    latestGenerationPreviewFor,
    generationPreviewToken,
  );
  const connectedInputs = useCanvasNodeDerived(nodeKey, genConnectedInputsFor, mediaInputsToken);
  const libraryResources = useCanvas((state) => sharedCanvasInputResolver(state)(nodeKey).libraryResources);
  const mentionCandidates = useCanvasNodeDerived(
    nodeKey,
    mentionCandidatesFor,
    mentionCandidatesToken,
  );
  const promptTargets = useCanvasNodeDerived(nodeKey, promptTargetsFor, promptTargetsToken);
  const promptSourceTexts = useCanvasNodeDerived(
    nodeKey,
    promptSourceTextsFor,
    promptSourceTextsToken,
  );
  const mediaSlots = useCanvasNodeDerived(
    nodeKey,
    (state, key) => {
      const resolved = sharedCanvasInputResolver(state)(key);
      return resolved.mediaSlotCount === 0 ? null : resolved.mediaPosition;
    },
    (value) =>
      value == null ? "" : [...value.entries()].map(([k, p]) => `${k}:${p}`).join("\u0003"),
  );
  const greenScreenConfig =
    entry?.type === "gen" && entry.data.kind === "video" ? entry.data.config : null;
  const greenScreenResults = useCanvasNodeDerived(
    nodeKey,
    (state, key) =>
      greenScreenConfig != null && greenScreenConfig.greenScreen
        ? greenScreenResultsFor(state, key, greenScreenConfig)
        : [],
    greenScreenResultsToken,
  );
  /**
   * 悬浮生成器面板的模型下拉：列出项目里**已配置**的文本模型。
   *
   * 原站这一位是它自家的 SaaS 模型清单（截图里是「GVLM 3.1」）；
   * 本项目按供应商目录里启用的文本模型列，模型名重复时补上供应商名，
   * 免得下拉里两行同名分不清。
   */
  const textModelOptions = useMemo<readonly CanvasTextGeneratorModelOption[]>(() => {
    const counts = new Map<string, number>();
    for (const catalogEntry of providerCatalog) {
      if (!catalogEntry.provider.enabled) continue;
      for (const model of catalogEntry.models) {
        if (!isTextGenerationModel(model)) continue;
        counts.set(model.displayName, (counts.get(model.displayName) ?? 0) + 1);
      }
    }
    const options: CanvasTextGeneratorModelOption[] = [];
    for (const catalogEntry of providerCatalog) {
      if (!catalogEntry.provider.enabled) continue;
      for (const model of catalogEntry.models) {
        if (!isTextGenerationModel(model)) continue;
        options.push({
          value: `${catalogEntry.provider.id}::${model.definitionId}`,
          label:
            (counts.get(model.displayName) ?? 0) > 1
              ? `${catalogEntry.provider.displayName} · ${model.displayName}`
              : model.displayName,
        });
      }
    }
    return options;
  }, [providerCatalog]);
  /**
   * 悬浮生成器面板与节点状态的绑定。
   *
   * 面板不是一份独立状态：提示词框读写节点的「创意 / 需求」，模型下拉读写节点
   * 选中的文本模型 —— 面板与节点内的输入框永远一致，不会各说各话。
   */
  const textGenerator = useMemo(() => {
    const data = entry?.type === "gen" ? entry.data : null;
    if (data?.kind !== "prompt") return null;
    const modelValue = `${data.config.modelSelection.providerId}::${data.config.modelSelection.modelDefinitionId}`;
    return {
      value: data.config.sourcePrompt,
      onValueChange: (value: string) => onPromptFieldChange(nodeKey, { sourcePrompt: value }),
      modelOptions: textModelOptions.some((option) => option.value === modelValue)
        ? textModelOptions
        : [
            {
              value: modelValue,
              label: data.config.modelSelection.modelDefinitionId
                ? `${data.config.modelSelection.modelDefinitionId}（不可用）`
                : textModelOptions.length > 0
                  ? "请选择文本模型"
                  : "没有可用文本模型",
            },
            ...textModelOptions,
          ],
      canChooseModel: textModelOptions.length > 0,
      modelReady: textModelOptions.some(option => option.value === modelValue),
      modelValue,
      onModelChange: (value: string) => {
        // 取值形如 `providerId::modelDefinitionId`；供应商 id 不含 `::`，
        // 模型定义 id 可能含（`remote::供应商::远端模型`），所以按**第一个** `::` 切。
        const separator = value.indexOf("::");
        if (separator <= 0) return;
        onPromptFieldChange(nodeKey, {
          modelSelection: {
            providerId: value.slice(0, separator),
            modelDefinitionId: value.slice(separator + 2),
          },
        });
      },
      onTranslate: () => onTranslateCanvasText(nodeKey),
      translating,
      onSubmit: () => onRunPrompt(nodeKey, true),
      submitting: running,
      placeholder: CANVAS_TEXT_GENERATOR_PLACEHOLDER,
    };
  }, [
    entry,
    nodeKey,
    onPromptFieldChange,
    onRunPrompt,
    onTranslateCanvasText,
    running,
    textModelOptions,
    translating,
  ]);
  if (entry?.type !== "gen") return null;
  const node = entry.data;
  const isPrompt = node.kind === "prompt";
  const descriptor = getNodeDescriptor(
    node.kind,
    descriptorContext,
    node.config.modelSelection,
    node.kind === "video"
      ? "video_generation"
      : node.kind === "audio"
        ? "speech_generation"
        : node.kind === "image"
          ? node.config.styleReference || libraryResources.length > 0 || connectedInputs.some((input) => input.kind === "image" || input.kind === "video")
            ? "image_to_image"
            : "text_to_image"
          : undefined,
  );
  if (isPrompt) {
    const promptEmpty =
      !running &&
      !error &&
      !node.config.textResource &&
      !node.config.generatedPrompt.trim() &&
      !promptSummary.trim() &&
      promptAttachmentCount === 0 &&
      !node.config.sourcePrompt.trim() &&
      (node.config.conversation ?? []).length === 0 &&
      connectedInputs.length === 0 && promptSourceTexts.length === 0;
    const bodyText = promptSummary || node.config.generatedPrompt;
    const hasBody = Boolean(bodyText.trim() || node.config.textResource || promptAttachmentCount);
    const cardBody = promptEmpty ? <CanvasTextTryActions compact onAction={action => {
      if (action === "writeText") onPromptFocusRequest(nodeKey);
      onTextTryAction(nodeKey, action);
    }} /> : <div className="canvas-text-card__body">
      {running ? <div className="canvas-text-card__status" role="status">
        <Icon name="circle-notch" className="spin-icon" size="sm" />正在生成正文…
      </div> : null}
      {running && streamingText ? <CanvasTextReading text={streamingText} /> :
        hasBody && selected && !editorOpen && !running ? <CanvasTextResource
          editor={{ nodeKey, candidates: mentionCandidates, aliveCanvasNodeKeys, registerInput: registerPromptInput,
            onTextChange: generatedPrompt => onPromptFieldChange(nodeKey, { generatedPrompt, textResource: true, cinematicDialogueValidated: false }) }}
          text={bodyText} contents={promptContents} focus={autoFocusOutput ?? false} onFocusHandled={onPromptFocusHandled}
        /> : bodyText ? <CanvasTextReading text={bodyText} /> :
          !running && !error ? <div className="canvas-text-card__placeholder">
            <LibTVMediaIcon name="list-detail" size={90} />
            {connectedInputs.length > 0 ? <span>已连接 {connectedInputs.length} 项参考素材</span> : null}
          </div> : null}
      {error ? <ErrorAlert id={`node-preview-error-${nodeKey}`} error={error} /> : null}
    </div>;
    return (
      <>
        <CanvasContentNode
          node={node}
          kindLabel="文本节点"
          icon="file-text"
          selected={selected}
          presentation={presentation}
          editorOpen={editorOpen}
          onEdit={onEdit}
          onCloseEditor={onCloseEditor}
          onSelect={onSelect}
          onRemove={onRemove}
          onSizeChange={onSizeChange}
          onRename={onRename}
          summary={
            streamingText?.trim()
              ? streamingText
              : promptSummary.trim()
                ? promptSummary
                : node.config.generatedPrompt.trim()
                  ? node.config.generatedPrompt
                  : node.config.sourcePrompt
          }
          metadata={`${connectedInputs.length} 项参考 · ${promptTargets.length} 个下游节点 · ${(promptSummary || node.config.generatedPrompt).length} 字`}
          status={
            running
              ? "正在生成"
              : error
                ? "需要处理"
                : node.config.generatedPrompt.trim()
                  ? "输出已就绪"
                  : "等待创作"
          }
          busy={running}
          error={error}
          cardBody={presentation === "card" ? cardBody : undefined}
          floatingPanel={
            presentation === "card" && selected && textGenerator ? (
              <CanvasTextGeneratorPanel
                className="canvas-text-generator--text nodrag nowheel nopan"
                value={textGenerator.value}
                onValueChange={textGenerator.onValueChange}
                modelOptions={textGenerator.modelOptions}
                canChooseModel={textGenerator.canChooseModel}
                modelReady={textGenerator.modelReady}
                modelValue={textGenerator.modelValue}
                onModelChange={textGenerator.onModelChange}
                onTranslate={textGenerator.onTranslate}
                translating={textGenerator.translating}
                onSubmit={textGenerator.onSubmit}
                submitting={textGenerator.submitting}
                disabled={running}
                allowEmpty={connectedInputs.length > 0 || promptSourceTexts.length > 0}
                placeholder={textGenerator.placeholder}
              />
            ) : undefined
          }
        >
          <CanvasPromptNode
            node={node}
            descriptor={descriptor}
            selected={selected}
            dragging={false}
            running={running}
            streamingText={streamingText}
            error={error}
            providerCatalog={providerCatalog}
            sourceConnections={connectedInputs}
            targetConnections={promptTargets}
            onSelect={onSelect}
            onNodeDragStart={onNodeDragStart}
            onRemove={onRemove}
            onUnlink={onUnlink}
            onConnectionStart={onConnectionStart}
            onSizeChange={ignoreEditorSizeChange}
            expandable={false}
            onChange={(config) => onPromptChange(nodeKey, config)}
            onRun={() => onRunPrompt(nodeKey)}
            autoFocusOutput={autoFocusOutput}
            onOutputFocusHandled={onPromptFocusHandled}
            promptContents={promptContents}
            registerPromptInput={registerPromptInput}
            mentionCandidates={mentionCandidates}
            aliveCanvasNodeKeys={aliveCanvasNodeKeys}
          />
        </CanvasContentNode>
      </>
    );
  }
  if (node.kind === "audio") {
    return (
      <>
        <CanvasAudioNode
          featureRequest={props.featureRequest}
          node={node}
          selected={selected}
          starting={running}
          startError={error}
          activeTask={activeTask}
          latestTask={latestTask}
          tasks={props.nodeTasks}
          onOpenTask={props.onOpenGenerationTask}
          connectedInputs={connectedInputs}
          mentionCandidates={mentionCandidates}
          aliveCanvasNodeKeys={aliveCanvasNodeKeys}
          registerPromptInput={registerPromptInput}
          providerCatalog={providerCatalog}
          onSelect={onSelect}
          onStartGeneration={(key) => {
            void onStartGeneration(key);
          }}
          onAudioConfigChange={onAudioConfigChange}
          onAudioToVideo={onAudioToVideo}
          onTranslatePrompt={onTranslateAudioPrompt}
          translating={translating}
          onRename={onRename}
          presentation={presentation}
          editorOpen={editorOpen}
          onCloseEditor={onCloseEditor}
          promptContents={promptContents}
          previewOutput={previewOutput}
        />
        {presentation === "card" ? <CanvasNodeInputBadge nodeKey={nodeKey} /> : null}
      </>
    );
  }
  return (
    <>
      <CanvasGenNode
        onPromoteSeedanceDraft={props.onPromoteSeedanceDraft}
        featureRequest={props.featureRequest}
        canvasId={props.canvasId}
        presentation={presentation}
        editorOpen={editorOpen}
        onCloseEditor={onCloseEditor}
        previewOutput={previewOutput}
        onSelectImageResult={props.onSelectImageResult}
        onPreviewImage={props.onPreviewImage}
        onEnhanceImage={props.onEnhanceImage}
        onEditImageRegion={props.onEditImageRegion}
        promptContents={promptContents}
        node={node}
        descriptor={descriptor}
        selected={selected}
        dragging={false}
        starting={running}
        startError={error}
        activeTask={activeTask}
        latestTask={latestTask}
        tasks={props.nodeTasks}
        onOpenTask={props.onOpenGenerationTask}
        connectedInputs={connectedInputs}
        libraryResources={libraryResources}
        inheritedInputs={[]}
        {...(mediaSlots != null ? { inputSlotPositions: mediaSlots } : {})}
        mentionCandidates={mentionCandidates}
        aliveCanvasNodeKeys={aliveCanvasNodeKeys}
        promptSourceName={
          promptSourceTexts.length ? `${promptSourceTexts.length} 份文本` : undefined
        }
        registerPromptInput={registerPromptInput}
        providerCatalog={providerCatalog}
        onSelect={onSelect}
        onEdit={onEdit}
        onNodeDragStart={onNodeDragStart}
        onRemove={onRemove}
        onUnlink={onUnlink}
        onReorderInput={onReorderInput}
        onSizeChange={onSizeChange}
        onImageConfigChange={onImageConfigChange}
        onOpenCharacterStudio={onOpenCharacterStudio}
        onRename={onRename}
        onVideoConfigChange={onVideoConfigChange}
        onAnnotateVideo={onAnnotateVideo}
        greenScreenResults={greenScreenResults.length ? greenScreenResults : undefined}
        onGreenScreenUseResult={(nodeKeyOf, key) => {
          void onGreenScreenUseResult(nodeKeyOf, key);
        }}
        onImportGreenScreenVideo={(nodeKeyOf) => {
          void onImportGreenScreenVideo(nodeKeyOf);
        }}
        onStartGeneration={(key) => {
          void onStartGeneration(key);
        }}
      />
    </>
  );
}

// ── 边描述符：标签/类名/序号的纯函数推导，token 与重建共用 ────────────────────

interface CanvasFlowEdgeDescriptor {
  readonly sourceName: string;
  readonly targetName: string;
  readonly edgeClassName: string;
  readonly order: number;
}
const edgeOrderIndexCache = new WeakMap<CanvasReadModel, ReadonlyMap<string, number>>();
/** 连线序号索引（与节点内清单同源），按读模型快照缓存。 */
function edgeOrderIndexFor(state: CanvasReadModel): ReadonlyMap<string, number> {
  const cached = edgeOrderIndexCache.get(state);
  if (cached != null) return cached;
  const groups = new Map<string, { edgeId: string }[]>();
  for (const [key, edges] of state.graph.byTarget) {
    const ordered = canvasInputEdgeOrder(
      sharedCanvasInputResolver(state)(key),
      edges.map((edge) => edge.id),
    );
    groups.set(
      key,
      ordered.map((edgeId) => ({ edgeId })),
    );
  }
  const index = buildInputOrderByEdge(groups);
  edgeOrderIndexCache.set(state, index);
  return index;
}

const CANVAS_NODE_TYPE_KEYS = [
  "asset",
  "gen",
  "screenplay",
  "videoClip",
  "director",
  "result",
  "output",
] as const satisfies readonly CanvasNodeType[];

const LazyDirectorEditor = lazy(() => import("./CanvasDirectorEditor").then(module => ({ default: module.CanvasDirectorEditor })));

function canvasNodeEntryInModel(state: CanvasReadModel, key: string): CanvasNodeEntry | null {
  for (const type of CANVAS_NODE_TYPE_KEYS) {
    const data = state.nodeByKey[type].get(key);
    if (data != null) return { type, data } as CanvasNodeEntry;
  }
  return null;
}

/** 边的标签/类名/序号：从端点节点内容推导（改名、换类型语义时随之变化）。 */
function canvasFlowEdgeDescriptor(
  state: CanvasReadModel,
  edge: CanvasReadModel["graph"]["edges"][number],
): CanvasFlowEdgeDescriptor {
  const genSource = state.nodeByKey.gen.get(edge.fromKey);
  const screenplaySource = state.nodeByKey.screenplay.get(edge.fromKey);
  const assetSource = state.nodeByKey.asset.get(edge.fromKey);
  const outputSource = state.nodeByKey.output.get(edge.fromKey);
  const generationTarget = state.nodeByKey.gen.get(edge.toKey);
  const assetTarget = state.nodeByKey.asset.get(edge.toKey);
  const isGenOutput = genSource != null && state.nodeByKey.output.has(edge.toKey);
  const promptSource = genSource?.kind === "prompt" ? genSource : null;
  const sourceName = promptSource
    ? "提示词节点"
    : screenplaySource
      ? connectedScreenplayName(screenplaySource)
      : (assetSource?.name ??
        outputSource?.name ??
        canvasNodeLabel(canvasNodeEntryInModel(state, edge.fromKey)));
  const targetName = generationTarget
    ? `${generationTarget.kind === "image" ? "图片" : generationTarget.kind === "video" ? "视频" : "提示词"}生成节点`
    : (assetTarget?.name ?? canvasNodeLabel(canvasNodeEntryInModel(state, edge.toKey)));
  const edgeClassName = isGenOutput
    ? `edge edge--gen-output edge--gen-output--${genSource?.kind ?? "video"}`
    : promptSource
      ? "edge edge--prompt-generation"
      : `edge edge--asset${generationTarget ? " edge--asset-generation" : ""}`;
  return {
    sourceName,
    targetName,
    edgeClassName,
    order: edgeOrderIndexFor(state).get(edge.id) ?? 0,
  };
}

function canvasFlowEdgeDescriptorToken(
  descriptor: CanvasFlowEdgeDescriptor,
  selected: boolean,
): string {
  return `${descriptor.sourceName}\u0002${descriptor.targetName}\u0002${descriptor.edgeClassName}\u0002${descriptor.order}\u0002${selected ? 1 : 0}`;
}

const CANVAS_PORT_DRAG_THRESHOLD = 4;
const DEFAULT_CANVAS_FLOW_VIEWPORT: Viewport = { x: 0, y: 0, zoom: DEFAULT_ZOOM / 100 };

/**
 * React Flow 的受控节点层：拖动帧只更新这个窄组件，避免让 WorkspaceApp 与画布文档
 * 每个 pointer move 都重渲染；上游节点内容变化时仍以业务状态为准同步进来。
 */
function LiveCanvasFlow({
  nodes: upstreamNodes = EMPTY_CANVAS_FLOW_NODES,
  onNodesChange,
  ...props
}: ReactFlowProps<CanvasFlowNode, CanvasFlowEdge>) {
  const [liveNodes, setLiveNodes, applyLiveNodeChanges] =
    useNodesState<CanvasFlowNode>(upstreamNodes);
  const liveNodesRef = useRef(liveNodes);
  // 渲染期不写 ref：事件处理器读的是上一次提交后的最新节点，
  // 效果在提交后刷新，下一次交互前一定已经落定。
  useEffect(() => {
    liveNodesRef.current = liveNodes;
  }, [liveNodes]);

  useEffect(() => {
    setLiveNodes((currentNodes) => {
      const draggingById = new Map(
        currentNodes
          .filter((node) => node.dragging === true)
          .map((node) => [node.id, node] as const),
      );
      if (draggingById.size === 0) return upstreamNodes;
      return upstreamNodes.map((node) => {
        const liveNode = draggingById.get(node.id);
        return liveNode == null ? node : { ...node, position: liveNode.position, dragging: true };
      });
    });
  }, [setLiveNodes, upstreamNodes]);

  const handleNodesChange = useCallback(
    (changes: NodeChange<CanvasFlowNode>[]) => {
      const explicitKeys = new Set(
        changes.filter((change) => change.type === "position").map((change) => change.id),
      );
      const memberChanges: NodeChange<CanvasFlowNode>[] = [];
      for (const change of changes) {
        if (change.type !== "position" || !change.position) continue;
        const groupNode = liveNodesRef.current.find((node) => node.id === change.id);
        if (!groupNode?.data.groupMemberKeys) continue;
        for (const memberKey of groupNode.data.groupMemberKeys) {
          if (explicitKeys.has(memberKey)) continue;
          const member = liveNodesRef.current.find((node) => node.id === memberKey);
          if (!member) continue;
          memberChanges.push({
            type: "position",
            id: memberKey,
            position: {
              x: member.position.x + change.position.x - groupNode.position.x,
              y: member.position.y + change.position.y - groupNode.position.y,
            },
            ...(change.dragging === undefined ? {} : { dragging: change.dragging }),
          });
        }
      }
      applyLiveNodeChanges([...changes, ...memberChanges]);
      onNodesChange?.(changes);
    },
    [applyLiveNodeChanges, onNodesChange],
  );

  return (
    <ReactFlow<CanvasFlowNode, CanvasFlowEdge>
      {...props}
      nodes={liveNodes}
      onNodesChange={handleNodesChange}
    />
  );
}

function canvasNodeKeyFromEventTarget(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  const node = target.closest(".react-flow__node");
  const id = node instanceof HTMLElement ? node.dataset["id"] : undefined;
  return id != null && id !== "" ? id : null;
}

/** Clipboard is shared by canvas sessions in this window, without changing the OS text clipboard. */
let canvasNodeClipboard: CanvasNodeClipboard | null = null;
let canvasNodePasteCount = 0;
const canvasNodeClipboardListeners = new Set<() => void>();

function subscribeCanvasNodeClipboard(listener: () => void): () => void {
  canvasNodeClipboardListeners.add(listener);
  return () => canvasNodeClipboardListeners.delete(listener);
}

function hasCanvasNodeClipboard(): boolean {
  return (canvasNodeClipboard?.nodes.length ?? 0) > 0;
}

function writeCanvasNodeClipboard(copied: CanvasNodeClipboard): void {
  canvasNodeClipboard = copied;
  canvasNodePasteCount = 0;
  for (const listener of canvasNodeClipboardListeners) listener();
}

function promptContentIssueMessage(issue: PromptContentIssue): string {
  if (issue.kind === "pending_reference") {
    return `提示词中的 @${issue.displayText} 匹配到 ${issue.candidateCount} 个同名对象。请点击黄色“待确认”引用并选择具体素材后再生成。`;
  }
  if (issue.kind === "disconnected_reference") {
    return `提示词中的 @${issue.displayName} 已与当前节点断开，请重新连线或删除该引用。`;
  }
  if (issue.kind === "reference_identity_changed") {
    return `提示词中的 @${issue.displayName} 已指向变化的画布实例，请删除该引用后重新选择。`;
  }
  return "提示词不能为空。请在该节点的提示词输入框中输入内容或 @ 引用素材。";
}

function connectedScreenplayName(node: ScreenplayNodeData): string {
  const firstContentLine = node.config.currentDocument
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
  const documentTitle = firstContentLine
    ?.replace(/^#{1,6}\s+/u, "")
    .replace(/\s+#+$/u, "")
    .trim();
  return documentTitle?.length ? documentTitle : `剧本节点 · ${node.key.slice(-6)}`;
}

function canvasNodeLabel(entry: CanvasNodeEntry | null): string {
  if (!entry) return "节点";
  switch (entry.type) {
    case "asset":
      return entry.data.name;
    case "output":
      return (
        entry.data.name ??
        `${entry.data.mediaType === "text" ? "文本" : entry.data.mediaType === "image" ? "图片" : "视频"}产物`
      );
    case "gen":
      return `${entry.data.kind === "prompt" ? "提示词" : entry.data.kind === "image" ? "图片生成" : "视频生成"}节点`;
    case "screenplay":
      return connectedScreenplayName(entry.data);
    case "videoClip":
      return entry.data.name ?? "智能剪辑节点";
    case "director":
      return entry.data.name;
    case "result":
      return "结果节点";
  }
}

function liveCanvasNodeRect(entry: CanvasNodeEntry): CanvasNodeRect {
  const { data } = entry;
  let fallback: CanvasNodeDimensions;
  switch (entry.type) {
    case "asset":
      fallback = assetNodeDimensions(entry.data);
      break;
    case "gen":
      fallback = genNodeDimensions(entry.data.kind);
      break;
    case "screenplay":
      fallback = entry.data.config.scriptGenerator ? {
        width: SCRIPT_GENERATOR_NODE_SIZE, height: SCRIPT_GENERATOR_NODE_SIZE,
      } : {
        width: SCREENPLAY_NODE_WIDTH,
        height: usesCoarsePointer() ? SCREENPLAY_NODE_COARSE_HEIGHT : SCREENPLAY_NODE_HEIGHT,
      };
      break;
    case "videoClip":
      fallback = { width: VIDEO_CLIP_NODE_WIDTH, height: VIDEO_CLIP_NODE_HEIGHT };
      break;
    case "director":
      fallback = { width: DIRECTOR_NODE_SIZE, height: DIRECTOR_NODE_SIZE };
      break;
    case "result":
      fallback = { width: RESULT_NODE_WIDTH, height: RESULT_NODE_HEIGHT };
      break;
    case "output":
      fallback = outputNodeDimensions(entry.data);
      break;
  }
  const measured = data.measured;
  const size = measured && measured.width > 0 && measured.height > 0 ? measured : fallback;
  return { x: data.x, y: data.y, width: size.width, height: size.height };
}

function currentOutputSource<K extends CanvasNodeType>(
  nodesById: CanvasNodesById,
  type: K,
  fallback: CanvasNodesByType[K],
): CanvasNodesByType[K] {
  const entry = nodesById[fallback.key];
  return entry?.type === type ? (entry.data as CanvasNodesByType[K]) : fallback;
}

function screenplayMultimodalInputs(
  config: ScreenplayNodeConfig,
): readonly PromptMultimodalInput[] {
  return (config.materials ?? []).map((material) => ({
    localPath: material.localPath,
    displayName: material.displayName,
    kind: material.kind,
    mimeType: material.mimeType,
  }));
}

function scriptBatchShotFingerprint(script: ScriptGeneratorState, shotId: string): string | null {
  const shot = script.shots.find((item) => item.id === shotId);
  return shot ? JSON.stringify({ shot, assets: matchingScriptAssets(shot, script.assets) }) : null;
}

function scriptBatchNodeFingerprint(document: CanvasDocumentV2, nodeKey: string): string | null {
  const node = document.genNodes.find((item) => item.key === nodeKey);
  if (!node || node.kind === "prompt") return null;
  const inputs = createCanvasInputResolver(canvasNodesByKeyFromDocument(document), document.assetEdges)(nodeKey);
  return JSON.stringify({ kind: node.kind, config: generationWithLibraryResources(node, inputs.libraryResources).config, prompt: document.promptContents[nodeKey] ?? null,
    media: inputs.media.map((input) => ({ key: input.key, target: input.target })) });
}

/**
 * 把镜头时长落到模型支持的时长档位。
 *
 * 模型往往只接受固定档位（5/10/15 秒），镜头写了 8 秒就只能取最近的档位；
 * 取值与镜头不一致时给出说明，随批次条目一起显示，不静默改时长。
 */
function scriptShotDurationValue(
  capability: ModelParameterCapability,
  duration: string,
): { readonly value: ModelParameterValue; readonly note: string | null } | null {
  const seconds = Number.parseFloat(duration.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const numeric = (value: ModelParameterValue): number | null =>
    typeof value === "number" ? value : Number.parseFloat(String(value));
  if (capability.options.length) {
    let best: ModelParameterOption | null = null;
    let bestGap = Number.POSITIVE_INFINITY;
    for (const option of capability.options) {
      const value = numeric(option.value);
      if (value == null || !Number.isFinite(value)) continue;
      const gap = Math.abs(value - seconds);
      if (gap < bestGap) { best = option; bestGap = gap; }
    }
    if (!best) return null;
    const applied = numeric(best.value);
    return { value: best.value,
      note: applied != null && Math.abs(applied - seconds) < 0.001 ? null : `镜头时长 ${seconds} 秒已按模型档位取为 ${best.label}` };
  }
  if (capability.type !== "integer" && capability.type !== "number") return null;
  const value = capability.type === "integer" ? Math.round(seconds) : seconds;
  if (capability.minimum != null && value < capability.minimum) return null;
  if (capability.maximum != null && value > capability.maximum) return null;
  return { value, note: null };
}

/**
 * 批量首帧的来源节点：画布上已有的图片，或上一批生成出来的产物卡片。
 *
 * 产物按 `taskId#resultIndex` 精确定位：同一批多出几张图时不会连错那一张。
 * 找不到（节点被删、产物尚未保存）时返回 null，调用方不提交这一镜。
 */
function scriptBatchFrameSourceKey(frame: ScriptBatchFrame, document: CanvasDocumentV2): string | null {
  const outputs = document.outputNodes ?? [];
  if (frame.kind === "canvas") {
    const exists = document.assetNodes.some((node) => node.key === frame.sourceKey) ||
      outputs.some((node) => node.key === frame.sourceKey);
    return exists ? frame.sourceKey : null;
  }
  const resultKey = `${frame.taskId}#${frame.resultIndex}`;
  const output = outputs.find((node) => node.taskId === frame.taskId && node.resultKey === resultKey);
  return output && output.mediaType === "image" && output.finalPath ? output.key : null;
}

function screenplayConversationUserMessage(
  userPrompt: string,
  materials: ScreenplayNodeConfig["materials"],
): string {
  if (!materials?.length) return userPrompt;
  return `${userPrompt}\n\n> 参考素材：${materials.map((material) => material.displayName).join("、")}`;
}

/**
 * 云端素材类型计数的作用域键（供应商连接 + 分组）。
 * 切换任一维度都要重新扫描并重新累计增量；增量集合按该键隔离，滚动换连接/分组互不串味。
 */
function cloudAssetKindTotalsScopeKey(
  providerConnectionId: string,
  groupId: string | null,
): string {
  return `${providerConnectionId}|${groupId ?? ""}`;
}

/**
 * WorkspaceApp 订阅的画布视图切片。抽成纯函数：非活跃画布把上次结果冻结后原样返回，
 * 让 zustand 的浅比较判定「无变化」，后台进度写入不再触发组件体重跑。
 *
 * 巨型订阅已按领域拆分：节点数组 / byKey 索引 / 连线与输入解析下沉到卡片 slot 的
 * per-node 窄订阅（useCanvasNodeEntry 等）与 token 门控的节点层；壳组件只保留
 * 选区、视图、成员签名与 hasNodes。
 */
function selectCanvasViewModel(state: CanvasReadModel) {
  return {
    selectedNodeKey: state.selection.nodeKey,
    selectedEdgeId: state.selection.edgeId,
    zoom: state.view.zoom,
    pan: state.view.pan,
    hasCanvasNodes: state.hasNodes,
  };
}
type CanvasViewModel = ReturnType<typeof selectCanvasViewModel>;

function nextTextNodeName(nodes: readonly GenNodeData[]) {
  const names = new Set(nodes.filter(node => node.kind === "prompt").map(node => node.name));
  let index = 1;
  while (names.has(`文本节点 ${index}`)) index += 1;
  return `文本节点 ${index}`;
}

export function WorkspaceApp({
  canvasId,
  active,
  services,
  canvasNavigation,
  canvasCatalog,
  onSelectCanvas,
  onCreateCanvas,
  assetDrawerTab,
  onAssetDrawerTabChange,
}: {
  readonly canvasId: string;
  readonly active: boolean;
  readonly services: CanvasSessionServices;
  readonly canvasNavigation?: ReactNode;
  /** 工作区里的画布清单，用于资产管理侧栏的画布切换。 */
  readonly canvasCatalog?: readonly { readonly id: string; readonly name: string }[];
  /** 从资产管理抽屉切换画布。 */
  readonly onSelectCanvas?: (id: string) => void;
  readonly onCreateCanvas?: () => void;
  readonly assetDrawerTab: CanvasAssetDrawerTab | null;
  readonly onAssetDrawerTabChange: (tab: CanvasAssetDrawerTab | null) => void;
}) {
  // 非活跃画布的降载开关：后台事件回调与 store 订阅读 ref，激活态变化驱动缓冲回放。
  const activeRef = useRef(active);
  activeRef.current = active;
  const [assetLibrarySource, setAssetLibrarySource] =
    useState<AssetLibrarySource>(readAssetLibrarySource);
  const [cloudCollection, setCloudCollection] = useState<"library" | "object_storage">("library");
  const [workspaceUiHydrated, setWorkspaceUiHydrated] = useState(() => !isDesktopRuntime());
  const [assetKind, setAssetKind] = useState<AssetKind>("image");
  const [assetSearch, setAssetSearch] = useState("");
  const [assetMultiSelect, setAssetMultiSelect] = useState(false);
  const [pickedAssets, setPickedAssets] = useState<readonly AssetItem[]>([]);
  const [nodeMarquee, setNodeMarquee] = useState(false);
  const [handTool, setHandTool] = useState(false);
  const lastCanvasPointer = useRef<{ x: number; y: number } | null>(null);
  const marqueeGesture = useRef<Set<string> | null>(null);
  /*
   * 画布视图开关：对齐 liblib.tv 左下控件组的「切换小地图 / 隐藏节点连线 /
   * 网格吸附」三项（逆向规格 docs/integrations/liblib-canvas-re.md 第 3 节）。
   * 这三项都是纯前端状态，不进画布文档 —— 它们描述的是「怎么看」而不是
   * 「画了什么」，持久化会让下次打开时画布外观与上次不符。
   */
  const [minimapVisible, setMinimapVisible] = useState(false);
  const [edgesVisible, setEdgesVisible] = useState(true);
  const [snapToGrid, setSnapToGrid] = useState(false);
  /** 快捷键面板（原站 liblib 的「快捷键」浮层）。 */
  const [shortcutsAnchor, setShortcutsAnchor] = useState<HTMLElement | null>(null);
  const [featuresOpen, setFeaturesOpen] = useState(false);
  const [characterStudio, setCharacterStudio] = useState<{ readonly targetKey: string | null; readonly open: boolean } | null>(null);
  const [directorOpen, setDirectorOpen] = useState(false);
  const [directorEditorKey, setDirectorEditorKey] = useState<string | null>(null);
  const [directorReferenceKey, setDirectorReferenceKey] = useState<string | null>(null);
  const directorEntry = useCanvasNodeEntry(directorEditorKey ?? "");
  const directorInputs = useCanvas(state => directorEditorKey ? sharedCanvasInputResolver(state)(directorEditorKey).media : null);
  const storyboardStorageKey = "canvas-storyboard-layout:v1:" + canvasId;
  const [storyboardLayout, setStoryboardLayout] = useState(() => readStoryboardLayout(storyboardStorageKey));
  const [storyboardReference, setStoryboardReference] = useState<{ id: string; asset: StoryboardAsset } | null>(null);
  const [textReferenceKey, setTextReferenceKey] = useState<string | null>(null);
  const [scriptReferencePick, setScriptReferencePick] = useState<ScriptReferencePick | null>(null);
  const [textEditorKey, setTextEditorKey] = useState<string | null>(null);
  const [storyboardScriptKey, setStoryboardScriptKey] = useState<string | null>(null);
  const storyboardScriptEntry = useCanvasNodeEntry(storyboardScriptKey ?? "");
  const storyboardScriptInputs = useCanvasNodeDerived(storyboardScriptKey ?? "", documentInputsFor, documentInputsToken);
  const storyboardScriptMedia = useCanvas(state => storyboardScriptKey ? sharedCanvasInputResolver(state)(storyboardScriptKey).media : null);
  const openingStoryboardFilm = useRef(false);
  const storyboardFrameRef = useRef<HTMLDivElement>(null);
  const storyboardEnabled = storyboardLayout.enabled;
  const openCharacterStudio = useCallback((targetKey: string | null = null) => {
    setCharacterStudio({ targetKey, open: true });
  }, []);
  const [libraryDialog, setLibraryDialog] = useState<{ readonly kind: CanvasLibraryKind; readonly replaceKey?: string } | null>(null);
  const [featureMedia, setFeatureMedia] = useState<CanvasFeatureMediaSession | null>(null);
  const [atlasTool, setAtlasTool] = useState<CanvasAtlasToolSession | null>(null);
  const featureModalOpen = featuresOpen || characterStudio?.open === true || libraryDialog != null || featureMedia != null || atlasTool != null;
  const [featureRequest, setFeatureRequest] = useState<CanvasInlineFeatureRequest | null>(null);
  /** 资产管理抽屉（原站 liblib 的左侧可调宽抽屉）。 */
  /** 缩放菜单（liblib 左下控件组里那个「72%」按钮弹出的菜单）。 */
  const [zoomMenuOpen, setZoomMenuOpen] = useState(false);
  /** 节点右键菜单（liblib 的画布上下文菜单）。 */
  const [nodeContextMenu, setNodeContextMenu] = useState<{
    readonly x: number;
    readonly y: number;
    readonly nodeKey: string;
  } | null>(null);
  /**
   * 分组右键菜单。
   *
   * 原站的分组只有「彩色框 + 小标签」两件东西，框上没有工具条；组动作（复制整组 /
   * 折叠 / 添加到素材库 / 解散）因此收在这里——原站的组操作同样走右键菜单。
   */
  const contextNodeEntry = useCanvasNodeEntry(nodeContextMenu?.nodeKey ?? "");
  const contextPreview = useCanvasNodeDerived(
    nodeContextMenu?.nodeKey ?? "",
    latestGenerationPreviewFor,
    generationPreviewToken,
  );
  const contextOutput = contextNodeEntry?.type === "output" ? contextNodeEntry.data : contextPreview;
  const contextImage = canvasImageActionTarget(contextNodeEntry);
  const contextMediaType = contextNodeEntry?.type === "gen" || contextNodeEntry?.type === "asset"
    ? contextNodeEntry.data.kind : contextOutput?.mediaType;
  const contextHasMedia = contextMediaType === "image" || contextMediaType === "video" || contextMediaType === "audio";
  const contextMediaPath = contextImage?.localPath ?? contextOutput?.finalPath;
  const contextMediaName = contextImage?.name ?? contextOutput?.name
    ?? (contextNodeEntry?.type === "gen" || contextNodeEntry?.type === "asset" ? contextNodeEntry.data.name : undefined) ?? "媒体";
  const [groupContextMenu, setGroupContextMenu] = useState<{
    readonly x: number;
    readonly y: number;
    readonly groupId: string;
  } | null>(null);
  /** 4 步新手引导（原站首次进入画布时弹一次；浮坞「教程」格可以再次打开）。 */
  const [guideOpen, setGuideOpen] = useState(false);
  const canPasteCanvasNodes = useSyncExternalStore(
    subscribeCanvasNodeClipboard,
    hasCanvasNodeClipboard,
    hasCanvasNodeClipboard,
  );
  const [marqueeNodeKeys, setMarqueeNodeKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [marqueeSelectionEpoch, setMarqueeSelectionEpoch] = useState(0);
  // 搜索防抖提交值：桌面端分页查询把它发给后端过滤，避免每次击键都发起请求。
  const [committedAssetSearch, setCommittedAssetSearch] = useState("");
  // 云端素材分页状态：当前页码与「可能有下一页」（当前页返回满页条数时为 true）。
  const [cloudAssetPageNumber, setCloudAssetPageNumber] = useState(1);
  const [cloudAssetHasMore, setCloudAssetHasMore] = useState(false);
  // 本地素材分页状态：当前页码、过滤后总数与全库类型计数（驱动类型 Tab 角标）。
  const [localAssetPageNumber, setLocalAssetPageNumber] = useState(1);
  const [localAssetTotal, setLocalAssetTotal] = useState(0);
  const [localAssetKindTotals, setLocalAssetKindTotals] = useState<LocalAssetKindTotals>({
    image: 0,
    video: 0,
    audio: 0,
  });
  const [objectStoragePageNumber, setObjectStoragePageNumber] = useState(1);
  const [objectStorageTotal, setObjectStorageTotal] = useState(0);
  const [objectStorageKindTotals, setObjectStorageKindTotals] = useState<LocalAssetKindTotals>({
    image: 0,
    video: 0,
    audio: 0,
  });
  // 云端素材类型计数（驱动类型 Tab 角标）。上游不返回任何类型总数，唯一的精确口径是
  // 翻完扫描范围内全部页；因此只在素材面板打开时扫一次，之后按上传/删除结果增量维护，
  // 翻页与切换类型都不重新扫描。null 表示当前连接/分组还没有可用计数（不显示角标）。
  const [cloudAssetKindTotals, setCloudAssetKindTotals] = useState<CloudAssetKindTotals | null>(
    null,
  );
  // 云端类型计数的增量变更与在途扫描（只维护 ref，避免每次上传/删除触发额外渲染）。
  // 扫描返回后先合并扫描期间累计的增量：扫描读到的是上游快照，晚到的结果不能吞掉
  // 上传/删除已经产生的变化。键为 `providerConnectionId|groupId`，滚动换连接/分组天然隔离。
  const cloudAssetKindTotalsRef = useRef<CloudAssetKindTotals | null>(null);
  const cloudAssetKindDeltaRef = useRef<Map<string, CloudAssetKindTotals>>(new Map());
  const countAssetsInFlightRef = useRef<Set<string>>(new Set());
  /** 当前角标计数所属的供应商连接；换连接时旧计数立即作废。 */
  const countedAssetProviderRef = useRef<string | null>(null);
  /** 最近一次请求的计数作用域；晚到的扫描结果只合并增量，不覆盖当前作用域的计数。 */
  const countedAssetScopeKeyRef = useRef<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyResourceAnchor, setHistoryResourceAnchor] = useState<{ x: number; y: number } | null>(null);
  const [historyInitialTaskId, setHistoryInitialTaskId] = useState<string | null>(null);
  const [realPersonDialogOpen, setRealPersonDialogOpen] = useState(false);
  const [videoLocalEdit, setVideoLocalEdit] = useState<{
    readonly nodeKey: string;
    readonly source: VideoLocalEditSource;
    readonly input: GenerationMediaInput;
  } | null>(null);
  const [videoPreparation, setVideoPreparation] = useState<VideoPreparationSource | null>(null);
  const [videoFrameCrop, setVideoFrameCrop] = useState<VideoFrameCropSession | null>(null);
  const canvasViewRef = useRef<CanvasViewModel | null>(null);
  const { selectedNodeKey, selectedEdgeId, zoom, pan, hasCanvasNodes } = useCanvas(
    useShallow((state) => {
      // 非活跃画布渲染 null，却会被后台进度写入反复触发全组件重跑。冻结为上次
      // 计算的视图：store 写入照常入库、持久化与撤销，UI 在重新激活时整体刷新。
      if (!activeRef.current) return canvasViewRef.current ?? selectCanvasViewModel(state);
      const view = selectCanvasViewModel(state);
      canvasViewRef.current = view;
      return view;
    }),
  );
  // 画布成员 key 订阅（浅比较）：内容补丁不改成员集合，跑批写入不再触发
  // 候选集/选中集/提示词 @ 引用集合的重建。
  const aliveCanvasNodeKeyList = useCanvas(
    useShallow((state) =>
      CANVAS_NODE_TYPE_KEYS.flatMap((type) => state.nodes[type].map((node) => node.key)),
    ),
  );
  const candidateCanvasNodeKeys = useMemo(
    () => new Set(aliveCanvasNodeKeyList),
    [aliveCanvasNodeKeyList],
  );
  const stableCanvasNodeKeysRef = useRef(candidateCanvasNodeKeys);
  if (
    stableCanvasNodeKeysRef.current.size !== candidateCanvasNodeKeys.size ||
    [...candidateCanvasNodeKeys].some((key) => !stableCanvasNodeKeysRef.current.has(key))
  ) {
    stableCanvasNodeKeysRef.current = candidateCanvasNodeKeys;
  }
  const canvasNodeKeys = stableCanvasNodeKeysRef.current;
  const selectedCanvasNodeKeys = useMemo(() => {
    const keys = new Set([...marqueeNodeKeys].filter((key) => canvasNodeKeys.has(key)));
    if (selectedNodeKey != null && canvasNodeKeys.has(selectedNodeKey)) keys.add(selectedNodeKey);
    return keys;
  }, [canvasNodeKeys, marqueeNodeKeys, selectedNodeKey]);
  const selectedGroupableNodeKeys = useMemo(
    () => [...selectedCanvasNodeKeys],
    [selectedCanvasNodeKeys],
  );
  const canGroupSelectedNodes =
    selectedGroupableNodeKeys.length >= 2 &&
    selectedGroupableNodeKeys.length === selectedCanvasNodeKeys.size;
  const {
    groupNodes,
    dissolveGroup,
    updateGroup,
    insertSubgraph,
    addNode,
    addOutput,
    patchNode,
    patchNodes,
    removeNode: removeCanvasNode,
    connect: connectCanvasStateNodes,
    disconnect: disconnectCanvasEdge,
    reorderGenerationInput,
    applyNodeChanges,
    setView,
    selectNode,
    selectEdge,
    clear: clearCanvasState,
    runWithCoalescedHistory,
    snapshotV2,
    restoreDocument,
    undo: undoCanvasOperation,
    redo: redoCanvasOperation,
  } = useCanvasCommands();

  // ── 节点外壳指纹订阅 ───────────────────────────────────────────────────────
  // 各类节点只订阅「成员/坐标/尺寸/选中/分组」指纹；内容补丁不触发 WorkspaceApp
  // 重渲染，由卡片 slot 的 per-node 订阅自行更新。指纹作为 per-node 缓存输入。
  const assetNodeLayoutTokens = useCanvasNodeLayoutTokens("asset", selectedCanvasNodeKeys);
  const outputNodeLayoutTokens = useCanvasNodeLayoutTokens(
    "output",
    selectedCanvasNodeKeys,
    (node) => `${node.name ?? ""}\u0002${node.finalPath ?? ""}\u0002${node.libraryPickOrder ?? ""}`,
  );
  const screenplayNodeLayoutTokens = useCanvasNodeLayoutTokens(
    "screenplay",
    selectedCanvasNodeKeys,
  );
  const genNodeLayoutTokens = useCanvasNodeLayoutTokens("gen", selectedCanvasNodeKeys);
  const videoClipNodeLayoutTokens = useCanvasNodeLayoutTokens("videoClip", selectedCanvasNodeKeys);
  const directorNodeLayoutTokens = useCanvasNodeLayoutTokens("director", selectedCanvasNodeKeys);
  const resultNodeLayoutTokens = useCanvasNodeLayoutTokens("result", selectedCanvasNodeKeys);
  // 保存调度与事件期读取共用的 store 句柄：非活跃画布冻结渲染后，后台进度写入不再
  // 触发组件重渲染与 effect 重跑，但断点与画布文档仍必须按时落盘；订阅与渲染解耦。
  const canvasStore = useCanvasStore();
  // 事件期输入解析：从当前快照解析（模块级 WeakMap 共享索引）。不再作为订阅派生，
  // 回调里拿到的永远是最新图；渲染路径的派生已下沉到卡片 slot 的窄订阅。
  const canvasInputsFor = useCallback(
    (nodeKey: string) =>
      sharedCanvasInputResolver(canvasReadModelOfState(canvasStore.getState()))(nodeKey),
    [canvasStore],
  );
  /** 事件期读取当前快照的一类节点；回调触发时求值，不随订阅重建。 */
  const canvasNodesNow = useCallback(
    <K extends CanvasNodeType>(type: K) => canvasNodesOfState(canvasStore.getState(), type),
    [canvasStore],
  );
  // 连线集合签名：连接关系变化时驱动依赖边的 effect/派生重建。
  const canvasEdgeSignature = useCanvas((state) =>
    state.graph.edges.map((edge) => edge.id).join(","),
  );
  // 产物卡片内容签名：finalPath/taskId/入库态变化时驱动对账类 effect。
  const outputCardSignature = useCanvas(
    useShallow((state) =>
      state.nodes.output.map(
        (node) =>
          `${node.key}:${node.taskId}:${node.finalPath ?? ""}:${node.uploadedToCloud === true ? 1 : 0}`,
      ),
    ),
  );
  // 空白处左键拖拽 / 任意位置中键拖拽平移画布时的指针状态。
  const [isPanning, setIsPanning] = useState(false);
  // 原生滚轮监听与缩放控制读取最新视图状态，避免监听器随状态变化反复重挂。
  const viewRef = useRef({ zoom, pan });
  useEffect(() => {
    viewRef.current = { zoom, pan };
  }, [zoom, pan]);
  const [providerCatalog, setProviderCatalog] = useState<readonly ProviderCatalogEntry[]>(() =>
    isDesktopRuntime() ? [] : DEMO_PROVIDER_CATALOG,
  );
  const [providerCatalogLoaded, setProviderCatalogLoaded] = useState(() => !isDesktopRuntime());
  const providerCatalogRequestRef = useRef(0);
  const cloudAssetsRequestRef = useRef(0);
  const localAssetsRequestRef = useRef(0);
  const objectStorageRequestRef = useRef(0);
  const purgedCloudAssetIdsRef = useRef(new Set<string>());
  const applyCloudAssetKindDeltaRef = useRef<
    (providerConnectionId: string, groupId: string | null, kind: AssetKind, delta: 1 | -1) => void
  >(() => undefined);
  const settingsAssetRequestRef = useRef<{
    readonly providerConnectionId: string;
    readonly requestId: number;
  } | null>(null);
  const [activeAssetProviderId, setActiveAssetProviderId] = useState(readActiveAssetProviderId);
  const activeAssetProviderIdRef = useRef(activeAssetProviderId);
  useEffect(() => {
    activeAssetProviderIdRef.current = activeAssetProviderId;
  }, [activeAssetProviderId]);
  const [nodeModelSelections, setNodeModelSelections] = useState<NodeModelSelections>(
    DEFAULT_NODE_MODEL_SELECTIONS,
  );
  // 正在提交生成任务的节点 key；不同节点可以同时提交。
  const [startingNodeKeys, setStartingNodeKeys] = useState<ReadonlySet<string>>(() => new Set());
  // 正在做提示词翻译的节点 key；悬浮生成器面板的翻译键用它显示忙碌态。
  const [translatingNodeKeys, setTranslatingNodeKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  /**
   * 待聚焦正文的节点 key。
   *
   * 画布卡片上的「自己编写内容」要先把独立编辑区打开、再把光标落进正文；
   * 编辑区是下一帧才挂上的，所以这里先记一笔，挂上后由节点回报。
   */
  const [pendingPromptFocusKey, setPendingPromptFocusKey] = useState<string | null>(null);
  const [scriptEditorKey, setScriptEditorKey] = useState<string | null>(null);
  const mediaSubmissionGuardRef = useRef(new Set<string>());
  const promptSubmissionGuardRef = useRef(new Set<string>());
  const textTranslationGuardRef = useRef(new Set<string>());
  const scriptMediaCreationGuardRef = useRef(new Set<string>());
  const scriptBatchSubmissionGuardRef = useRef(new Set<string>());
  const [scriptBatchRunningKeys, setScriptBatchRunningKeys] = useState<ReadonlySet<string>>(() => new Set());
  // 正在提交智能剪辑合成请求的节点 key；原站同款：合成进行中不允许重复发起。
  const [startingVideoClipKeys, setStartingVideoClipKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const clipSubmissionsRef = useRef(new Set<string>());
  const clipRemoteBusyRef = useRef(new Set<string>());
  const [clipTimeline, setClipTimeline] = useState<{ key: string; autoStart: boolean } | null>(null);
  const clipRenderJobs = useQuery({
    queryKey: ["clip-renders", canvasId], queryFn: () => clipRenderClient.list(canvasId), enabled: isDesktopRuntime(),
    refetchInterval: query => active && query.state.data?.some(clipJobActive) ? 1500 : false,
  });
  const clipJobsRef = useRef<readonly ClipRenderJob[]>([]);
  useEffect(() => {
    clipJobsRef.current = clipRenderJobs.data ?? [];
  }, [clipRenderJobs.data]);
  /**
   * 文本模型正在生成的正文（按节点 key 累加）。
   *
   * 只用于「运行中」的实时展示：任务完成后由 run 的回调写入完整结果并清空这里，
   * 因此它不是画布文档的一部分，不参与持久化。
   */
  const [streamingTextByNode, setStreamingTextByNodeInternal] = useState<Record<string, string>>(
    {},
  );
  // 非活跃画布的后台事件不再逐次 setState 重渲染整个组件：updater 进缓冲，激活时回放。
  const setStreamingTextByNode = useDeferredSessionState(
    setStreamingTextByNodeInternal,
    activeRef,
    active,
  );
  /** 记录每个节点当前流式任务 ID：任务换了说明是新一轮，需要从空重新累积。 */
  const streamingTextTaskByNodeRef = useRef<Map<string, string>>(new Map());
  /** 流式正文 50ms 合帧缓冲：同批 token 追加合并为一次 setState。 */
  const streamingTextBatchRef = useRef<{
    entries: Map<string, { text: string; replace: boolean }>;
    timer: number | null;
  }>({ entries: new Map(), timer: null });
  useEffect(
    () => () => {
      if (streamingTextBatchRef.current.timer !== null)
        window.clearTimeout(streamingTextBatchRef.current.timer);
    },
    [],
  );
  /** 本轮结束（成功或失败）后清掉流式草稿：完整结果由调用方写入节点。 */
  const clearStreamingText = useCallback(
    (nodeKey: string) => {
      streamingTextTaskByNodeRef.current.delete(nodeKey);
      const batch = streamingTextBatchRef.current;
      batch.entries.delete(nodeKey);
      if (batch.entries.size === 0 && batch.timer !== null) {
        window.clearTimeout(batch.timer);
        batch.timer = null;
      }
      setStreamingTextByNode((current) => {
        if (!(nodeKey in current)) return current;
        const next = { ...current };
        delete next[nodeKey];
        return next;
      });
    },
    [setStreamingTextByNode],
  );
  const [startErrorsByNode, setStartErrorsByNode] = useState<Record<string, string>>({});
  const setNodeStartError = useCallback((nodeKey: string, error: string | null) => {
    setStartErrorsByNode((current) => {
      if (error == null) {
        if (!(nodeKey in current)) return current;
        const next = { ...current };
        delete next[nodeKey];
        return next;
      }
      return { ...current, [nodeKey]: error };
    });
  }, []);
  const [taskResults, setTaskResultsInternal] = useState<
    Record<string, readonly GenerationResultRecord[]>
  >({});
  const setTaskResults = useDeferredSessionState(setTaskResultsInternal, activeRef, active);
  const [saveProgressByResult, setSaveProgressByResultInternal] = useState<
    Record<string, GenerationResultSaveProgress>
  >({});
  const setSaveProgressByResult = useDeferredSessionState(
    setSaveProgressByResultInternal,
    activeRef,
    active,
  );
  const [retryInfoByTask, setRetryInfoByTaskInternal] = useState<Record<string, RetryInfo>>({});
  const setRetryInfoByTask = useDeferredSessionState(setRetryInfoByTaskInternal, activeRef, active);
  /*
   * 自动查询已停止的任务（PixVerse 达 10 分钟上限 / 自动重试耗尽）。
   *
   * 后端会发 `generation:polling-stopped` 事件，但**任务状态仍是 running**
   * （`ChangeQueryHealth` 只改 query_health 不改 status）—— 前端若不接这个事件，
   * 卡片就永远转圈。这里记下这些任务 id，让它们不再被当作「在途」。
   *
   * 但**光靠事件不够**：事件是一次性的瞬时信号。用户重启应用、重新加载前端、
   * 或在事件投递前就打开了画布，这个 Set 就是空的 —— 于是任务又被当成在途，
   * 卡片永久转圈，该节点也**无法再次提交生成**（提示「该节点已有任务正在生成」）。
   *
   * 所以判定必须并上后端**持久化**的状态：`queryHealth === "degraded"` 表示
   * 后端已停止自动轮询（两条来源都是「停止轮询」：轮询达时限、自动重试耗尽）。
   * 后端持久化的东西不会因为进程重启而消失，这才是可靠判据。
   */
  const [pollingStoppedTaskIds, setPollingStoppedTaskIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [rawResponses, setRawResponses] = useState<Record<string, string>>({});
  const [cloudAssets, setCloudAssets] = useState<readonly CloudAsset[]>([]);
  // 云端素材库分组：按令牌作用域隔离，所有供应商/平台共用同一套接口。
  // 分组只展示 `name`（上游已去除 user-{uid}-token-{tid}- 前缀）。
  const [assetGroups, setAssetGroups] = useState<readonly AssetGroupRecord[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [groupsError, setGroupsError] = useState<string | null>(null);
  const [selectedAssetGroupId, setSelectedAssetGroupId] = useState<string | null>(null);
  // refreshCloudAssets 是稳定回调（依赖为空），通过 ref 读取当前分组避免重建。
  const selectedAssetGroupIdRef = useRef<string | null>(null);
  // 分页查询稳定回调读取的当前类型 / 防抖搜索词 / 页码。
  const assetKindRef = useRef<AssetKind>("image");
  const committedAssetSearchRef = useRef("");
  const cloudAssetPageRef = useRef(1);
  const localAssetPageRef = useRef(1);
  const objectStoragePageRef = useRef(1);
  const [newGroupDialogOpen, setNewGroupDialogOpen] = useState(false);
  const [creatingGroup, setCreatingGroup] = useState(false);
  // 正在删除的云端素材库分组 ID（删除期间禁用入口，并阻止重复提交）。
  const [deletingAssetGroupId, setDeletingAssetGroupId] = useState<string | null>(null);
  // 正在改名的云端素材 ID（详情弹窗显示保存中状态，并阻止重复提交）。
  const [renamingAssetId, setRenamingAssetId] = useState<string | null>(null);
  const [assetsLoading, setAssetsLoading] = useState(() => isDesktopRuntime());
  const [assetsError, setAssetsError] = useState<string | null>(null);
  // 上一次云端素材列表拉取是否失败。assetsError 同时承载列表错误与上传错误，
  // 但空状态的"素材库不可用"提示只应针对列表拉取失败显示。
  const [libraryError, setLibraryError] = useState(false);
  const [localAssets, setLocalAssets] = useState<readonly LocalBase64AssetRecord[]>([]);
  const [localAssetsLoading, setLocalAssetsLoading] = useState(false);
  const [localAssetsError, setLocalAssetsError] = useState<string | null>(null);
  const [localLibraryError, setLocalLibraryError] = useState(false);
  // 本地素材分组（文件夹语义，本机 SQLite）：交互对齐云端分组选择器。
  const [localAssetGroups, setLocalAssetGroups] = useState<readonly LocalBase64AssetGroupRecord[]>(
    [],
  );
  const [localGroupsLoading, setLocalGroupsLoading] = useState(false);
  const [localGroupsError, setLocalGroupsError] = useState<string | null>(null);
  const [selectedLocalAssetGroupId, setSelectedLocalAssetGroupId] = useState<string | null>(null);
  // refreshLocalAssets 是稳定回调（依赖为空），通过 ref 读取当前分组避免重建。
  const selectedLocalAssetGroupIdRef = useRef<string | null>(null);
  const [newLocalGroupDialogOpen, setNewLocalGroupDialogOpen] = useState(false);
  const [creatingLocalGroup, setCreatingLocalGroup] = useState(false);
  // 正在删除的本地分组 ID（删除期间禁用入口，并阻止重复提交）。
  const [deletingLocalAssetGroupId, setDeletingLocalAssetGroupId] = useState<string | null>(null);
  // 多选批量删除本地素材进行中（禁用批量操作，防止重复提交）。
  const [deletingPickedLocalAssets, setDeletingPickedLocalAssets] = useState(false);
  const [objectStorageAssets, setObjectStorageAssets] = useState<readonly LocalAssetRecord[]>([]);
  const [objectStorageLoading, setObjectStorageLoading] = useState(false);
  const [objectStorageError, setObjectStorageError] = useState<string | null>(null);
  const [objectStorageLibraryError, setObjectStorageLibraryError] = useState(false);
  const [pullingBucket, setPullingBucket] = useState(false);
  const pullingBucketRef = useRef(false);
  const [assetUploads, setAssetUploads] = useState<readonly AssetUploadEntry[]>([]);
  // 云端 staging jobId -> 产物节点。本机 Base64 保存不经过 staging。
  const uploadJobToOutputRef = useRef<Map<string, string>>(new Map());
  // 独立对象存储 staging jobId -> 产物节点；成功判据是 staged，不是云端素材 ID。
  const objectStorageUploadJobToOutputRef = useRef<Map<string, string>>(new Map());
  const [timedOutCloudAssetKeys, setTimedOutCloudAssetKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const hiddenCloudAssetKeys = useMemo(() => {
    const keys = new Set(timedOutCloudAssetKeys);
    for (const entry of assetUploads) {
      if (
        entry.destination !== "cloud" ||
        entry.providerConnectionId == null ||
        entry.overseasDbId == null ||
        isTerminalAssetUpload(entry)
      ) {
        continue;
      }
      keys.add(JSON.stringify([entry.providerConnectionId, entry.overseasDbId]));
    }
    return keys;
  }, [assetUploads, timedOutCloudAssetKeys]);
  const hideTimedOutCloudAsset = useCallback((providerConnectionId: string, dbId: number) => {
    const key = JSON.stringify([providerConnectionId, dbId]);
    setTimedOutCloudAssetKeys((current) => {
      if (current.has(key)) return current;
      return new Set([...current, key]);
    });
  }, []);
  const timeoutNotifiedJobIdsRef = useRef(new Set<string>());
  const noteTimedOutAssetImport = useCallback(
    (job: StagingJobRecord) => {
      if (!isTimedOutAssetImport(job)) return;
      if (job.overseasDbId != null && job.importTarget?.providerConnectionId != null) {
        hideTimedOutCloudAsset(job.importTarget.providerConnectionId, job.overseasDbId);
      }
      if (timeoutNotifiedJobIdsRef.current.has(job.id)) return;
      timeoutNotifiedJobIdsRef.current.add(job.id);
      toast.error("上传超时，已清理本地待处理素材");
    },
    [hideTimedOutCloudAsset],
  );
  /** 预览替换：上传任务 → 被替换的旧云端素材，入库成功后改写画布引用。 */
  const previewRepairJobsRef = useRef<
    Map<string, { readonly oldAssetId: string; readonly providerConnectionId: string }>
  >(new Map());
  // 供轮询订阅回调读取最新上传条目（destination 映射），避免闭包过期。
  const uploadEntriesRef = useRef<readonly AssetUploadEntry[]>([]);
  useEffect(() => {
    uploadEntriesRef.current = assetUploads;
  }, [assetUploads]);
  /** 成功上传行的自动收起计时器（jobId → timer），卸载时一并清除。 */
  const uploadAutoDismissTimersRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    const timers = uploadAutoDismissTimersRef.current;
    return () => {
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
    };
  }, []);
  // 终态事件偶尔丢失时，轮询仍会把超时结果写到上传行；旧版误存 task 号的
  // active/cleaning/cleaned 行也需要收尾，不能在当前会话永久显示处理中。
  useEffect(() => {
    for (const entry of assetUploads) {
      if (
        (!isTimedOutAssetImport(entry) && !isUnresolvedLegacyAssetImport(entry)) ||
        uploadAutoDismissTimersRef.current.has(entry.jobId)
      ) {
        continue;
      }
      const timer = window.setTimeout(() => {
        uploadAutoDismissTimersRef.current.delete(entry.jobId);
        setAssetUploads((current) => current.filter((item) => item.jobId !== entry.jobId));
      }, UPLOAD_AUTO_DISMISS_DELAY_MS);
      uploadAutoDismissTimersRef.current.set(entry.jobId, timer);
    }
  }, [assetUploads]);
  // startUpload 返回 jobId 前，占位行的临时自增 id（前缀避免与后端真实 id 冲突）。
  const pendingUploadSeqRef = useRef(0);
  // 生成节点改为内容自适应高度后，记录 DOM 实际尺寸供避让、命中与 SVG 边界使用。
  const [genNodeSizes, setGenNodeSizes] = useState<Record<string, CanvasNodeDimensions>>({});
  const [previewOutputNodeKey, setPreviewOutputNodeKey] = useState<string | null>(null);
  const [previewAssetNodeKey, setPreviewAssetNodeKey] = useState<string | null>(null);
  const [previewAsset, setPreviewAsset] = useState<AssetItem | null>(null);
  const handleGenNodeSizeChange = useCallback((key: string, dimensions: CanvasNodeDimensions) => {
    setGenNodeSizes((current) => {
      const previous = current[key];
      if (previous?.width === dimensions.width && previous.height === dimensions.height) {
        return current;
      }
      return { ...current, [key]: dimensions };
    });
  }, []);
  const genNodeDimensionsFor = useCallback(
    (node: GenNodeData): CanvasNodeDimensions =>
      genNodeSizes[node.key] ?? genNodeDimensions(node.kind),
    [genNodeSizes],
  );
  // 所有可见节点共用同一份占位集合；新增素材、图片节点和视频节点都据此避让。
  // 外壳指纹聚合签名：占用避让表按成员/坐标/尺寸/选中重建（内容补丁不触发）。
  const canvasLayoutSignature = [
    assetNodeLayoutTokens,
    genNodeLayoutTokens,
    screenplayNodeLayoutTokens,
    directorNodeLayoutTokens,
    resultNodeLayoutTokens,
    outputNodeLayoutTokens,
  ].join("");
  const occupiedNodeRects = useMemo<readonly CanvasNodeRect[]>(() => {
    void canvasLayoutSignature;
    return [
      ...canvasNodesNow("asset").map((node) => ({
        x: node.x,
        y: node.y,
        ...assetNodeDimensions(node),
      })),
      ...canvasNodesNow("gen").map((node) => ({ ...node, ...genNodeDimensionsFor(node) })),
      ...canvasNodesNow("director").map(node => liveCanvasNodeRect({ type: "director", data: node })),
      ...canvasNodesNow("screenplay").map((node) => ({
        x: node.x,
        y: node.y,
        ...(genNodeSizes[node.key] ?? (node.config.scriptGenerator ? {
          width: SCRIPT_GENERATOR_NODE_SIZE, height: SCRIPT_GENERATOR_NODE_SIZE,
        } : {
          width: SCREENPLAY_NODE_WIDTH,
          height: usesCoarsePointer() ? SCREENPLAY_NODE_COARSE_HEIGHT : SCREENPLAY_NODE_HEIGHT,
        })),
      })),
      ...canvasNodesNow("result").map((node) => ({
        x: node.x,
        y: node.y,
        width: RESULT_NODE_WIDTH,
        height: RESULT_NODE_HEIGHT,
      })),
      ...canvasNodesNow("output").map((node) => ({
        x: node.x,
        y: node.y,
        ...outputNodeDimensions(node),
      })),
    ];
  }, [canvasLayoutSignature, genNodeDimensionsFor, genNodeSizes, canvasNodesNow]);
  const mediaInputTargetKeysRef = useRef<ReadonlySet<string>>(new Set());
  // 提示内容 module 持有 canonical documents 与节点级 handle；视口裁剪不会丢内容。
  const [promptContents] = useState(createPromptContentModule);
  const programmaticPromptWriteRef = useRef(new Set<string>());
  const replaceGeneratedPrompt = useCallback(
    (nodeKey: string, text: string, candidates: readonly MentionCandidate[]) => {
      programmaticPromptWriteRef.current.add(nodeKey);
      try {
        promptContents.replaceText(nodeKey, text, candidates);
      } finally {
        programmaticPromptWriteRef.current.delete(nodeKey);
      }
    },
    [promptContents],
  );
  const deletedPromptContentsRef = useRef(new Map<string, PromptContentDocumentV1>());
  /*
   * 持有提示内容的节点成员 key 订阅：删除的提示词文档在同类节点复用时恢复。
   *
   * 这里**不再按节点类型登记**（此前是 gen + videoClip 两类手工列表）：
   * 那份登记表与真正的注册点（`PromptMentionInput` 挂载处）没有任何编译期关联，
   * 已经因此丢过两次提示词（智能剪辑漏一次、提示词节点漏一次）—— 症状都是
   * 「排期与落盘都正常，但重开画布就丢」，丢的恰是 @引用的素材身份绑定与
   * 粘贴附件（纯文本有 config 镜像所以不丢），最难被察觉。
   *
   * 改成「画布里现存的节点 key」之后登记表整个不需要了：新增节点类型天然被覆盖，
   * 也不可能再漏登记。
   */
  const promptContentNodeKeys = useAllCanvasNodeKeys();
  useEffect(() => {
    let restored = 0;
    for (const key of promptContentNodeKeys) {
      const deleted = deletedPromptContentsRef.current.get(key);
      if (deleted == null) continue;
      promptContents.restoreDocument(key, deleted);
      deletedPromptContentsRef.current.delete(key);
      restored += 1;
    }
    /*
     * 撤销/重做会触发一次「立即落盘」，而它取快照的时刻**早于**上面这个 effect
     * （提示词恢复在 effect 里，晚一步）——那次落盘会把该节点的提示词写成空文档，
     * 界面看着正常、磁盘上却是空的，直到下次任意落盘才被纠正。恢复成功后补一次
     * 排期，把正确内容写回去。
     */
    if (restored > 0) scheduleCanvasSaveRef.current?.();
  }, [promptContentNodeKeys, promptContents]);
  // 追踪上游原始输出版本；结构化引用的显示文字和用户手改内容都不用于判定重新导入。
  const importedPromptSourcesRef = useRef(
    new Map<string, { edgeId: string; sourceKey: string; text: string; importedText: string }>(),
  );
  const canvasViewportRef = useRef<HTMLDivElement | null>(null);
  // 视口裁剪开关：仅在容器有真实布局尺寸时启用 React Flow 的
  // onlyRenderVisibleElements（画布上大量节点离屏时跳过整棵 DOM 子树）。
  // 测试环境（jsdom）永不启用：测试会伪造视口 rect 驱动拖拽几何，
  // 与裁剪所依赖的真实布局互相冲突。
  const [canvasViewportMeasured, setCanvasViewportMeasured] = useState(false);
  useEffect(() => {
    if (!active || import.meta.env.MODE === "test") return;
    const container = canvasViewportRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const rect = container.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) setCanvasViewportMeasured(true);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [active]);
  const [externalMediaDropHover, setExternalMediaDropHover] = useState(false);
  // React Flow 实例引用：命令式视口操作（恢复视图/锚点缩放/坐标换算）的唯一入口。
  const flowInstanceRef = useRef<ReactFlowInstance<CanvasFlowNode, CanvasFlowEdge> | null>(null);
  const outputPlacementOptionsFor = useCallback(
    (nodesById: CanvasNodesById, sourceKey: string) => {
      const viewport = flowInstanceRef.current?.getViewport();
      const scale = viewport?.zoom ?? zoom / 100;
      const canvasHeight = canvasViewportRef.current?.getBoundingClientRect().height ?? 0;
      const sourceY = nodesById[sourceKey]?.data.y ?? 0;
      const visibleHeight =
        viewport && scale > 0
          ? Math.max(0, (canvasHeight - viewport.y) / scale - sourceY)
          : scale > 0
            ? canvasHeight / scale
            : 0;
      return {
        visibleHeight,
        occupied: Object.values(nodesById)
          .filter((entry) => entry.type !== "output")
          .map((entry) => liveCanvasNodeRect(entry)),
      };
    },
    [zoom],
  );
  const assetDrawerTriggerRef = useRef<HTMLElement | null>(null);
  const settingsTriggerRef = useRef<HTMLButtonElement | null>(null);
  // 会话控制器的宿主依赖里，保存调度与视口取点声明在持久化/视口层（本钩子之后），
  // 经 latest-ref 在动作触发时读取；动作只在回调期消费它们，语义与直连一致。
  const scheduleCanvasSaveRef = useRef<() => void>(() => {});
  /** 提示内容变化 → 落盘排期的订阅（按节点 key 记录退订函数）。 */
  const promptSaveSubscriptionsRef = useRef(new Map<string, () => void>());
  const viewportCenterBoardCoordinatesRef = useRef<() => { x: number; y: number }>(() => ({
    x: 0,
    y: 0,
  }));
  // 「清空画布」确认弹窗的原生 <dialog> 引用——HTMLDialogElement 自带
  // modal 语义（ESC 关闭、focus trap、::backdrop 遮罩），无需自建 dialog 框架。
  const clearCanvasDialogRef = useRef<HTMLDialogElement | null>(null);

  const clearCanvas = useCallback(() => {
    // 清空画布上的节点与连线，同时重置与画布交互相关的临时状态；
    // 不清空任务历史（生成节点删除/本地结果文件缺失都不能清理历史，详见 MVP 契约）。
    // 先撤销拼接产物仅会话内有效的 blob 预览，再原子清空画布持久状态。
    for (const node of canvasNodesOfState(canvasStore.getState(), "output")) {
      if (node.origin === "composition" && node.previewSrc?.startsWith("blob:")) {
        URL.revokeObjectURL(node.previewSrc);
      }
    }
    /*
     * 清空是整体替换节点状态，不走逐节点的删除路径，所以长视频编排的界面入口会一起消失，
     * 而后端并不知道。不叫停的话，它们会继续每 1.2 秒提交一个片段、继续花钱。
     */
    void longVideoClient.cancelForCanvas(canvasId).then(cancelled => {
      if (cancelled > 0) toast.info(`已结束这张画布上的 ${cancelled} 个长视频编排。`);
    }).catch((error: unknown) => {
      frontendLog("warn", `[long-video] 叫停画布 ${canvasId} 上的长视频编排失败：${backendErrorMessage(error)}`);
      toast.error("没能叫停这张画布上的长视频编排", { description: "它们可能仍在按额度提交片段，直到额度用尽才会停下。" });
    });
    for (const job of clipJobsRef.current.filter(clipJobActive)) {
      void clipRenderClient.cancel(job.id).catch((error: unknown) => toast.error(`取消剪辑失败：${backendErrorMessage(error)}`));
    }
    setClipTimeline(null);
    clearCanvasState();
    setGenNodeSizes({});
    setPreviewOutputNodeKey(null);
  }, [clearCanvasState, canvasStore, setGenNodeSizes, setPreviewOutputNodeKey, canvasId]);

  const collectCanvasDocument = useCallback((): CanvasDocumentV2 => {
    /*
     * 提示词内容住在提示词模块里（不进画布 store），落盘快照必须带上它们。
     *
     * 这里**不再手工登记持有提示词的节点类型**（此前是 gen + videoClip）：
     * 那份登记表与真正的注册点没有任何编译期关联，已经因此丢过两次提示词
     * （智能剪辑漏一次、提示词节点漏一次）。症状很隐蔽：排期与落盘都"正常"，
     * 但存出来的画布文档里没有这段提示词，重新打开就丢了 —— 丢的恰是 @引用的
     * 素材身份绑定与粘贴的附件（纯文本有 config 镜像所以不丢），最难被察觉。
     *
     * 改成「画布里现存的节点 key」求交集后，登记表整个不需要了：新增节点类型
     * 天然被覆盖，也不可能再漏登记。
     */
    // 即时提交前可能刚插入节点、React 还没完成一次重渲染；落盘必须读 store 当前 key。
    const promptContentKeys = new Set(Object.keys(canvasStore.getState().nodesById));
    return snapshotV2(promptContents.snapshotAll(promptContentKeys));
  }, [canvasStore, promptContents, snapshotV2]);

  const restoreCanvasDocument = useCallback(
    (raw: unknown) => {
      const restored = restoreDocument(raw);
      if (!restored.ok) throw new Error(`画布存档无法恢复：${restored.issues.join("；")}`);
      deletedPromptContentsRef.current.clear();
      const document = raw as CanvasDocument;
      // restoreDocument 已原子替换节点、连线、视图与选择并清空画布操作历史。
      void flowInstanceRef.current?.setViewport({
        x: restored.view.pan.x,
        y: restored.view.pan.y,
        zoom: restored.view.zoom / 100,
      });
      const promptRestore = promptContents.restoreAll(restored.promptContents);
      if (!promptRestore.ok) {
        throw new Error(`提示内容恢复失败: ${promptRestore.invalidNodeKeys.join(", ")}`);
      } else {
        // 恢复后的提示内容已经包含精确引用或用户修改。
        // 用同时保存的上游版本初始化同步记录，避免首次 effect 按当前编号重新解析。
        // 例外：若恢复内容为空文档，说明上次保存时同步可能未完成（或节点刚创建），
        // 不初始化同步记录，让下方 effect 检测到差异后重新导入上游输出。
        importedPromptSourcesRef.current.clear();
        // 首次挂载时编辑器尚未创建，read() 读不到 pendingRestore 中的存档。
        const restoredPromptDocuments = promptContents.snapshotAll();
        const restoredInputsFor = createCanvasInputResolver(
          canvasNodesByKeyFromDocument(document),
          document.assetEdges,
        );
        for (const node of document.genNodes) {
          if (node.kind === "prompt") continue;
          const sources = restoredInputsFor(node.key).texts;
          const hasSavedContent = restoredPromptDocuments[node.key]?.items.some(
            (item) => item.kind !== "text" || item.text.trim().length > 0,
          );
          if (!sources.length || !hasSavedContent) continue;
          importedPromptSourcesRef.current.set(node.key, {
            edgeId: sources.map((source) => source.edgeId).join("\n"),
            sourceKey: sources.map((source) => source.sourceKey).join("\n"),
            text: sources.map((source) => source.text).join("\n\n"),
            importedText: connectedCanvasPromptText(sources),
          });
        }
      }
      /*
       * 画布水合完成后，把当前 canonical 写进 store 的快照字段。
       *
       * 这一步**必需**：撤销栈记录的是「变更前」的切片，而切片里的快照来自
       * store 此刻的值。画布刚打开时 store 的快照是空的 —— 若不初始化，用户
       * 第一次打字时记下的历史就带着**空**快照 → 撤销会把提示词清空
       * （节点回来了，内容没了）。
       *
       * 水合后立刻初始化，第一条历史就带着「打开画布时的内容」→ 撤销回到那个
       * 状态，精确无损。
       */
      canvasStore.getState().setPromptDocuments(promptContents.snapshotAll());
    },
    [canvasStore, promptContents, restoreDocument],
  );

  const validateCanvasDelete = useCallback(async () => {
    if (startingNodeKeys.size > 0 || scriptBatchSubmissionGuardRef.current.size > 0) {
      throw new Error("此画布仍有任务正在执行，请先暂停工作流或等待任务完成后再删除。");
    }
    if (!isDesktopRuntime()) return;
    // Query when deletion is confirmed: the regular task list may be stale or limited.
    const tasks = await generationClient.list({
      canvasId,
      statuses: ["created", "submitting", "retry_wait", "queued", "running"],
      limit: 1,
    });
    if (tasks.items.length > 0) {
      throw new Error("此画布仍有生成任务正在执行，请等待任务完成后再删除。");
    }
  }, [canvasId, startingNodeKeys]);

  const canvasPersistence = useCanvasDocumentPersistence({
    canvasId,
    collect: collectCanvasDocument,
    restore: restoreCanvasDocument,
    services,
    validateDelete: validateCanvasDelete,
    active,
  });
  const {
    hydrated: canvasHydrated,
    flush: flushCanvasDocument,
    schedule: scheduleCanvasSave,
    documentChanged,
  } = canvasPersistence;
  // 会话控制器动作与视口 input 监听都经 latest-ref 读最新保存调度：提示词编辑器的
  // input 会冒泡触发防抖保存，退订窗口里的那次击键不能丢一次落盘。订阅只跟
  // schedule 引用走，回调读 ref。
  useLayoutEffect(() => {
    scheduleCanvasSaveRef.current = scheduleCanvasSave;
  }, [scheduleCanvasSave]);

  /*
   * 撤销/重做后把 canonical 从 store 的历史快照恢复回来。
   *
   * zundo 的 undo/redo 会把历史切片（含 `promptDocuments`）合并回 store，所以这里
   * 只要盯着这个字段的变化，把新值灌回提示词模块即可。
   *
   * 比**内容**而不是引用：恢复动作会让提示词模块 notify，而那个 notify 若又被
   * 用来写 store，就会绕回这里形成**无限递归**（主线程卡死）。
   */
  useEffect(() => {
    if (!canvasHydrated) return;
    let lastDocuments = canvasStore.getState().promptDocuments;
    const unsubscribe = canvasStore.subscribe((state) => {
      const documents = state.promptDocuments;
      if (promptContentDocumentMapsEqual(documents, lastDocuments)) {
        lastDocuments = documents;
        return;
      }
      lastDocuments = documents;
      /*
       * 用**按 key 的增量恢复**，不是 `restoreAll`。
       *
       * `restoreAll` 的语义是「整个画布回到这份快照」—— 快照里没有的节点会被
       * **清空**。那是存档恢复该有的语义，但**撤销**只回滚一步，不该把这一步
       * 之外的内容清掉：用户删掉一个提示词节点再撤销，节点回来了，它的提示词
       * 却被清空了。
       */
      const result = promptContents.restoreSubset(documents);
      if (!result.ok) {
        frontendLog(
          "warn",
          `[canvas] 撤销恢复提示词失败，节点：${result.invalidNodeKeys.join(", ")}`,
        );
      }
    });
    return unsubscribe;
  }, [canvasHydrated, canvasStore, promptContents]);

  useEffect(() => {
    if (!canvasHydrated) return;
    documentChanged();
    let lastNodes = canvasStore.getState().nodesById;
    let lastEdges = canvasStore.getState().assetEdges;
    let lastGroups = canvasStore.getState().groups;
    let lastZoom = canvasStore.getState().zoom;
    let lastPan = canvasStore.getState().pan;
    return canvasStore.subscribe((state) => {
      // 分组元数据（名称、折叠态）也是画布文档的一部分：只改分组时同样要排期保存，
      // 否则存档里的 collapsed 会停在旧值，重开画布就丢掉了这次折叠/展开。
      const contentChanged =
        state.nodesById !== lastNodes ||
        state.assetEdges !== lastEdges ||
        state.groups !== lastGroups;
      const viewChanged = state.zoom !== lastZoom || state.pan !== lastPan;
      if (!contentChanged && !viewChanged) return;
      lastNodes = state.nodesById;
      lastEdges = state.assetEdges;
      lastGroups = state.groups;
      lastZoom = state.zoom;
      lastPan = state.pan;
      // 用户命令（成组、改名、折叠、粘贴、撤销、拖动提交）立刻落盘：明确的一次操作
      // 不该排在防抖窗口之后，否则紧接着切画布或关窗就会丢掉这次改动。被动测量
      // （尺寸回存、选中同步）、机器批写与视图变化仍走防抖，避免连续写入打爆落盘。
      if (contentChanged && canvasStore.lastWriteWasUserCommand()) {
        void flushCanvasDocument().catch(() => undefined);
        return;
      }
      documentChanged();
    });
  }, [canvasHydrated, documentChanged, canvasStore, flushCanvasDocument]);

  // 首次进入画布时自动弹 4 步引导；看过之后不再自动弹（浮坞「教程」格仍可打开）。
  useEffect(() => {
    if (!canvasHydrated) return;
    if (readOnboardingSeen()) return;
    setGuideOpen(true);
  }, [canvasHydrated]);

  useEffect(() => {
    if (!canvasHydrated || !active) return;
    const viewport = canvasViewportRef.current;
    if (viewport == null) return;
    const onInput = () => {
      scheduleCanvasSaveRef.current();
    };
    viewport.addEventListener("input", onInput);
    return () => viewport.removeEventListener("input", onInput);
  }, [active, canvasHydrated]);

  useEffect(() => {
    if (!active) flowInstanceRef.current = null;
  }, [active]);

  const closeClearCanvasDialog = useCallback(() => {
    const dialog = clearCanvasDialogRef.current;
    if (!dialog) return;
    if (typeof dialog.close === "function") {
      dialog.close();
    }
    // jsdom fallback：手动移除 open 属性（jsdom 30 不支持 showModal/close，
    // 只能用 setAttribute("open", "") 模拟）。
    if (!dialog.hasAttribute("open")) return;
    try {
      dialog.removeAttribute("open");
    } catch {
      /* noop */
    }
  }, []);

  const openClearCanvasDialog = useCallback(() => {
    const dialog = clearCanvasDialogRef.current;
    if (!dialog) return;
    // 优先用原生 showModal() 拿 modal 语义（top-layer、focus trap、::backdrop）。
    if (typeof dialog.showModal === "function") {
      try {
        dialog.showModal();
        return;
      } catch {
        // dialog 已在 open 状态或被父层拦截——fallback。
      }
    }
    // jsdom fallback：手动设 open 属性，使 dialog 在文档流中可见。
    // 牺牲 modal 与 backdrop，但测试可见。
    dialog.setAttribute("open", "");
  }, []);

  const confirmClearCanvas = useCallback(() => {
    clearCanvas();
    closeClearCanvasDialog();
  }, [clearCanvas, closeClearCanvasDialog]);

  useEffect(() => {
    mediaInputTargetKeysRef.current = new Set(
      canvasNodesNow("gen")
        .filter((node) =>
          canvasInputsFor(node.key).media.some(
            (input) => input.kind === "image" || input.kind === "video",
          ),
        )
        .map((node) => node.key),
    );
  }, [canvasEdgeSignature, canvasInputsFor, canvasNodesNow]);

  // 只有实现了云端素材库的连接才会出现在素材库来源里：RD API 这类只有生成接口的
  // 网关没有素材库接口，列出来只会让面板把上游 404 当成素材库故障展示。
  const availableAssetProviders = useMemo(
    () =>
      assetLibraryProviders(
        providerCatalog.map((entry) => entry.provider).filter((provider) => provider.enabled),
      ),
    [providerCatalog],
  );

  const persistWorkspaceUi = useCallback(
    (providerId: string | null, source: AssetLibrarySource) => {
      if (providerId) persistActiveAssetProviderId(providerId);
      persistAssetLibrarySource(source);
      if (!isDesktopRuntime()) return;
      void workspaceUiClient
        .save({
          activeAssetProviderId: providerId,
          assetLibrarySource: source,
        })
        .catch(() => undefined);
    },
    [],
  );

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let cancelled = false;
    void (async () => {
      try {
        const prefs = await workspaceUiClient.get();
        if (cancelled) return;
        const trimmedProvider = prefs.activeAssetProviderId?.trim();
        const storedProvider = trimmedProvider ? trimmedProvider : null;
        const storedSource = parseAssetLibrarySource(prefs.assetLibrarySource);
        if (storedProvider) {
          persistActiveAssetProviderId(storedProvider);
          setActiveAssetProviderId(storedProvider);
        }
        if (storedSource) {
          persistAssetLibrarySource(storedSource);
          setAssetLibrarySource(storedSource);
        }
        if (!storedProvider && !storedSource) {
          const localProvider = readActiveAssetProviderId();
          const localSource = readAssetLibrarySource();
          if (localProvider || localSource === "local") {
            await workspaceUiClient.save({
              activeAssetProviderId: localProvider,
              assetLibrarySource: localSource,
            });
          }
        }
      } catch {
        // sqlite 读失败时仍用 localStorage，避免卡住素材库。
      } finally {
        if (!cancelled) setWorkspaceUiHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const assetProvider = useMemo(() => {
    if (isDesktopRuntime() && !workspaceUiHydrated && !activeAssetProviderId) {
      return null;
    }
    return resolveActiveAssetLibraryProvider(availableAssetProviders, activeAssetProviderId);
  }, [activeAssetProviderId, availableAssetProviders, workspaceUiHydrated]);

  const rememberAssetProvider = useCallback(
    (providerConnectionId: string) => {
      setActiveAssetProviderId(providerConnectionId);
      persistWorkspaceUi(providerConnectionId, assetLibrarySource);
    },
    [assetLibrarySource, persistWorkspaceUi],
  );

  useEffect(() => {
    if (!workspaceUiHydrated) return;
    if (assetProvider == null) return;
    if (assetProvider.id === activeAssetProviderId) return;
    rememberAssetProvider(assetProvider.id);
  }, [activeAssetProviderId, assetProvider, rememberAssetProvider, workspaceUiHydrated]);

  const handleAssetProviderChanged = useCallback(
    (providerConnectionId: string) => {
      if (providerConnectionId === activeAssetProviderIdRef.current) {
        rememberAssetProvider(providerConnectionId);
        return;
      }
      // 供应商切换立即使旧 provider 的所有素材请求失效；新 provider 的 effect 会启动下一次请求。
      cloudAssetsRequestRef.current += 1;
      settingsAssetRequestRef.current = null;
      rememberAssetProvider(providerConnectionId);
      setCloudAssets([]);
      setAssetGroups([]);
      selectedAssetGroupIdRef.current = null;
      setSelectedAssetGroupId(null);
      setGroupsError(null);
      setAssetsError(null);
      setLibraryError(false);
      setAssetsLoading(isDesktopRuntime() && assetLibrarySource === "cloud");
    },
    [assetLibrarySource, rememberAssetProvider],
  );

  // 全局网络状态：断网时素材库顶部显示提示条，恢复后自动刷新云端素材列表。
  const [isOffline, setIsOffline] = useState(
    () => isDesktopRuntime() && typeof navigator !== "undefined" && !navigator.onLine,
  );
  const wasOfflineRef = useRef(false);

  useEffect(() => {
    const goOffline = () => {
      frontendLog("warn", "[assets] 网络连接已断开（offline 事件），云端素材拉取与上传将不可用");
      setIsOffline(true);
    };
    const goOnline = () => {
      frontendLog("info", "[assets] 网络连接已恢复（online 事件），等待自动刷新素材列表");
      setIsOffline(false);
    };
    window.addEventListener("offline", goOffline);
    window.addEventListener("online", goOnline);
    return () => {
      window.removeEventListener("offline", goOffline);
      window.removeEventListener("online", goOnline);
    };
  }, []);

  const settleListedCloudAssets = useCallback(
    (assets: readonly CloudAsset[], requestId: number, providerConnectionId: string): void => {
      const unready = assets.filter((asset) => asset.status !== "ready");
      if (unready.length === 0) return;
      void (async () => {
        for (const asset of unready) {
          if (requestId !== cloudAssetsRequestRef.current) return;
          const outcome = await settleUnreadyCloudAsset(asset, assetLibraryClient);
          if (requestId !== cloudAssetsRequestRef.current) return;
          if (outcome.kind === "removed") {
            setCloudAssets((current) => current.filter((item) => item.id !== asset.id));
            if (
              selectedAssetGroupIdRef.current == null &&
              (asset.kind === "image" || asset.kind === "video" || asset.kind === "audio")
            ) {
              applyCloudAssetKindDeltaRef.current(providerConnectionId, null, asset.kind, -1);
            }
            if (!purgedCloudAssetIdsRef.current.has(asset.id)) {
              purgedCloudAssetIdsRef.current.add(asset.id);
              toast.error(`「${asset.name}」已从素材库移除`, { description: outcome.reason });
            }
            frontendLog(
              "info",
              `[assets] 云端素材处理失败已剔除: providerConnectionId=${providerConnectionId}, assetId=${asset.id}, 原因=${outcome.reason}`,
            );
            continue;
          }
          if (outcome.kind === "ready") {
            setCloudAssets((current) =>
              current.map((item) =>
                item.id === asset.id
                  ? {
                      ...item,
                      status: "ready",
                      rawStatus: outcome.rawStatus,
                      previewUrl: outcome.previewUrl ?? item.previewUrl,
                      coverUrl: outcome.coverUrl ?? item.coverUrl,
                    }
                  : item,
              ),
            );
          }
        }
      })();
    },
    [],
  );

  const refreshCloudAssets = useCallback(
    (providerConnectionId: string, source: AssetRefreshSource): void => {
      const requestId = ++cloudAssetsRequestRef.current;
      settingsAssetRequestRef.current = null;
      // 分页参数在调用时从 ref 快照：类型 / 防抖搜索词 / 页码 / 分组。
      const pageNumber = cloudAssetPageRef.current;
      const kind = assetKindRef.current;
      const name = committedAssetSearchRef.current.trim();
      const startedAt = Date.now();
      frontendLog(
        "info",
        `[assets] 云端素材列表开始拉取: providerConnectionId=${providerConnectionId}, 触发来源=${source}, 类型=${kind}, 页码=${pageNumber}`,
      );
      // 状态重置延迟到微任务提交：effect 同步触发时避免在 effect 体内 setState
      // 引发级联渲染（react-hooks/set-state-in-effect）。微任务先于任何网络响应
      // 执行，与同步重置语义一致。
      void Promise.resolve().then(() => {
        if (requestId !== cloudAssetsRequestRef.current) return;
        setCloudAssets([]);
        setAssetsLoading(true);
        setAssetsError(null);
        setLibraryError(false);
      });
      void assetLibraryClient
        .list({
          providerConnectionId,
          groupId: selectedAssetGroupIdRef.current,
          pageNumber,
          pageSize: ASSET_PAGE_SIZE,
          kind,
          name: name || null,
        })
        .then(
          (assets) => {
            if (requestId !== cloudAssetsRequestRef.current) {
              frontendLog(
                "info",
                `[assets] 已忽略过期素材列表响应: providerConnectionId=${providerConnectionId}, 触发来源=${source}, requestId=${requestId}`,
              );
              return;
            }
            setCloudAssets(assets);
            void settleListedCloudAssets(assets, requestId, providerConnectionId);
            // 满页说明可能还有下一页；不足一页即最后一页（上游无过滤总数）。
            setCloudAssetHasMore(assets.length >= ASSET_PAGE_SIZE);
            setAssetsError(null);
            setLibraryError(false);
            frontendLog(
              "info",
              `[assets] 云端素材列表拉取成功: providerConnectionId=${providerConnectionId}, 触发来源=${source}, 页码=${pageNumber}, 共 ${assets.length} 个素材, ${assets.filter((asset) => asset.previewUrl != null && asset.previewUrl !== "").length} 个有预览地址, 耗时 ${Date.now() - startedAt}ms`,
            );
          },
          (error: unknown) => {
            const formatted = formatRawBackendError(error);
            if (requestId !== cloudAssetsRequestRef.current) {
              frontendLog(
                "info",
                `[assets] 已忽略过期素材列表错误: providerConnectionId=${providerConnectionId}, 触发来源=${source}, requestId=${requestId}`,
              );
              return;
            }
            // 素材库 module 返回的领域错误直接展示 message；IPC 错误保留完整 JSON。
            // 两种情况的完整详情都进入日志。
            setAssetsError(backendErrorMessage(error));
            setCloudAssets([]);
            setLibraryError(true);
            frontendLog(
              "error",
              `[assets] 云端素材列表拉取失败: providerConnectionId=${providerConnectionId}, 触发来源=${source}, 页码=${pageNumber}, 耗时 ${Date.now() - startedAt}ms, 错误: ${formatted}`,
            );
          },
        )
        .finally(() => {
          if (requestId === cloudAssetsRequestRef.current) setAssetsLoading(false);
        });
    },
    [settleListedCloudAssets],
  );

  /**
   * 按上传/删除结果把一次增减记进类型计数。扫描在途时先记入增量集合，扫描返回后统一合并，
   * 避免上游快照覆盖已经发生的变更。
   */
  const applyCloudAssetKindDelta = useCallback(
    (
      providerConnectionId: string,
      groupId: string | null,
      kind: AssetKind,
      delta: 1 | -1,
    ): void => {
      const key = cloudAssetKindTotalsScopeKey(providerConnectionId, groupId);
      const pending = cloudAssetKindDeltaRef.current.get(key) ?? { image: 0, video: 0, audio: 0 };
      cloudAssetKindDeltaRef.current.set(key, {
        ...pending,
        [kind]: Math.max(0, pending[kind] + delta),
      });
      const current = cloudAssetKindTotalsRef.current;
      if (current == null) return;
      const next = { ...current, [kind]: Math.max(0, current[kind] + delta) };
      cloudAssetKindTotalsRef.current = next;
      setCloudAssetKindTotals(next);
    },
    [],
  );
  useEffect(() => {
    applyCloudAssetKindDeltaRef.current = applyCloudAssetKindDelta;
  }, [applyCloudAssetKindDelta]);

  /**
   * 扫描云端素材库并按类型计数（驱动类型 Tab 角标）。
   *
   * 上游不返回任何类型总数，精确计数只能翻完扫描范围内的全部页，因此只在素材面板打开、
   * 连接或分组变化时调用一次；翻页、切换类型、搜索都不重新扫描，上传/删除用增量维护。
   * 扫描失败时保留已有计数并记录日志，不阻塞素材浏览。
   */
  const refreshCloudAssetKindTotals = useCallback(
    (providerConnectionId: string, groupId: string | null, source: AssetRefreshSource): void => {
      if (!isDesktopRuntime()) return;
      const countAssetsByKind = assetLibraryClient.countAssetsByKind;
      if (countAssetsByKind == null) return;
      const key = cloudAssetKindTotalsScopeKey(providerConnectionId, groupId);
      if (countAssetsInFlightRef.current.has(key)) return;
      // 换供应商时旧连接的计数没有意义：先清空角标，扫完再显示新连接的计数。
      if (
        cloudAssetKindTotalsRef.current != null &&
        countedAssetProviderRef.current !== providerConnectionId
      ) {
        cloudAssetKindTotalsRef.current = null;
        setCloudAssetKindTotals(null);
      }
      countedAssetProviderRef.current = providerConnectionId;
      countedAssetScopeKeyRef.current = key;
      countAssetsInFlightRef.current.add(key);
      const startedAt = Date.now();
      frontendLog(
        "info",
        `[assets] 云端素材类型计数开始扫描: providerConnectionId=${providerConnectionId}, groupId=${groupId ?? "全部"}, 触发来源=${source}`,
      );
      void countAssetsByKind({ providerConnectionId, groupId })
        .then(
          (totals) => {
            const pending = cloudAssetKindDeltaRef.current.get(key) ?? {
              image: 0,
              video: 0,
              audio: 0,
            };
            cloudAssetKindDeltaRef.current.delete(key);
            // 期间已切到别的连接/分组：本次结果只清掉自己的增量，不覆盖当前作用域的计数。
            if (countedAssetScopeKeyRef.current !== key) return;
            const merged: CloudAssetKindTotals = {
              image: Math.max(0, totals.image + pending.image),
              video: Math.max(0, totals.video + pending.video),
              audio: Math.max(0, totals.audio + pending.audio),
            };
            cloudAssetKindTotalsRef.current = merged;
            setCloudAssetKindTotals(merged);
            frontendLog(
              "info",
              `[assets] 云端素材类型计数扫描完成: providerConnectionId=${providerConnectionId}, groupId=${groupId ?? "全部"}, 图片=${merged.image}, 视频=${merged.video}, 音频=${merged.audio}, 耗时 ${Date.now() - startedAt}ms`,
            );
          },
          (error: unknown) => {
            frontendLog(
              "error",
              `[assets] 云端素材类型计数扫描失败: providerConnectionId=${providerConnectionId}, groupId=${groupId ?? "全部"}, 耗时 ${Date.now() - startedAt}ms, 错误: ${formatRawBackendError(error)}`,
            );
          },
        )
        .finally(() => {
          countAssetsInFlightRef.current.delete(key);
        });
    },
    [],
  );

  const refreshLocalAssets = useCallback((source: AssetRefreshSource): void => {
    const requestId = ++localAssetsRequestRef.current;
    const pageNumber = localAssetPageRef.current;
    const mediaType = assetKindRef.current;
    const name = committedAssetSearchRef.current.trim();
    const groupId = selectedLocalAssetGroupIdRef.current;
    const startedAt = Date.now();
    setLocalAssetsLoading(true);
    frontendLog(
      "info",
      `[assets] 本地素材索引开始读取: 触发来源=${source}, 类型=${mediaType}, 页码=${pageNumber}, 分组=${groupId ?? "全部"}`,
    );
    void localBase64AssetClient
      .listAssets({
        mediaType,
        name: name || null,
        groupId,
        page: pageNumber,
        pageSize: ASSET_PAGE_SIZE,
      })
      .then(
        (page) => {
          if (requestId !== localAssetsRequestRef.current) return;
          setLocalAssets(page.items);
          setLocalAssetTotal(page.total);
          setLocalAssetKindTotals(page.kindTotals);
          setLocalAssetsError(null);
          setLocalLibraryError(false);
          frontendLog(
            "info",
            `[assets] 本地素材索引读取成功: 触发来源=${source}, 类型=${mediaType}, 页码=${pageNumber}, 本页 ${page.items.length} 个 / 共 ${page.total} 个素材, 耗时 ${Date.now() - startedAt}ms`,
          );
        },
        (error: unknown) => {
          if (requestId !== localAssetsRequestRef.current) return;
          const formatted = formatRawBackendError(error);
          setLocalAssetsError(backendErrorMessage(error));
          setLocalLibraryError(true);
          frontendLog(
            "error",
            `[assets] 本地素材索引读取失败: 触发来源=${source}, 页码=${pageNumber}, 耗时 ${Date.now() - startedAt}ms, 错误: ${formatted}`,
          );
        },
      )
      .finally(() => {
        if (requestId === localAssetsRequestRef.current) setLocalAssetsLoading(false);
      });
  }, []);

  // 本地素材分组：列表拉取保持选中（分组消失时回退「全部素材」），失败不阻塞浏览。
  const refreshLocalAssetGroups = useCallback((): void => {
    if (!isDesktopRuntime()) return;
    setLocalGroupsLoading(true);
    void localBase64AssetClient
      .listGroups()
      .then(
        (groups) => {
          setLocalAssetGroups(groups);
          const wanted = selectedLocalAssetGroupIdRef.current;
          const next =
            wanted != null && groups.some((group) => group.id === wanted) ? wanted : null;
          selectedLocalAssetGroupIdRef.current = next;
          setSelectedLocalAssetGroupId(next);
          setLocalGroupsError(null);
        },
        (error: unknown) => {
          const formatted = formatRawBackendError(error);
          frontendLog("error", `[assets] 本地素材分组读取失败: 错误: ${formatted}`);
          setLocalGroupsError(backendErrorMessage(error));
        },
      )
      .finally(() => setLocalGroupsLoading(false));
  }, []);

  /** 面板当前选中的本地分组即上传目标：全部/未分组视图落「未分组」（只读 ref，稳定回调）。 */
  const uploadTargetLocalGroupId = useCallback((): string | null => {
    const groupId = selectedLocalAssetGroupIdRef.current;
    return groupId != null && groupId !== LOCAL_ASSET_UNGROUPED_GROUP_ID ? groupId : null;
  }, []);

  const handleLocalAssetGroupChanged = useCallback((groupId: string | null) => {
    selectedLocalAssetGroupIdRef.current = groupId;
    setSelectedLocalAssetGroupId(groupId);
    // 重查由分页查询 filter effect 统一处理（分组选择是 filterKey 的一部分）。
  }, []);

  const handleCreateLocalAssetGroup = useCallback(
    (name: string) => {
      setCreatingLocalGroup(true);
      void localBase64AssetClient
        .createGroup({ name })
        .then(
          (group) => {
            setNewLocalGroupDialogOpen(false);
            frontendLog(
              "info",
              `[assets] 本地素材分组已创建: groupId=${group.id}, name=${group.name}`,
            );
            selectedLocalAssetGroupIdRef.current = group.id;
            setSelectedLocalAssetGroupId(group.id);
            // 本地先插入保证选择器立即可见；后台刷新同步计数。
            setLocalAssetGroups((current) =>
              current.some((entry) => entry.id === group.id) ? current : [...current, group],
            );
            refreshLocalAssetGroups();
          },
          (error: unknown) => {
            const formatted = formatRawBackendError(error);
            frontendLog("error", `[assets] 本地素材分组创建失败: 错误: ${formatted}`);
            // 同名冲突最常见；弹窗挡着面板错误区，直接 toast 给出结论。
            toast.error("新建本地分组失败", { description: backendErrorMessage(error) });
          },
        )
        .finally(() => setCreatingLocalGroup(false));
    },
    [refreshLocalAssetGroups],
  );

  const handleDeleteLocalAssetGroup = useCallback(
    (groupId: string) => {
      if (deletingLocalAssetGroupId != null) return;
      if (groupId === LOCAL_ASSET_UNGROUPED_GROUP_ID) return;
      setDeletingLocalAssetGroupId(groupId);
      void localBase64AssetClient
        .deleteGroup({ id: groupId })
        .then(
          () => {
            frontendLog("info", `[assets] 本地素材分组已删除: groupId=${groupId}`);
            if (selectedLocalAssetGroupIdRef.current === groupId) {
              selectedLocalAssetGroupIdRef.current = null;
              setSelectedLocalAssetGroupId(null);
            }
            setLocalAssetGroups((current) => current.filter((group) => group.id !== groupId));
            refreshLocalAssetGroups();
            // 组内素材回到未分组：当前列表与 Tab 计数都要重查。
            refreshLocalAssets("group-deleted");
          },
          (error: unknown) => {
            const formatted = formatRawBackendError(error);
            frontendLog(
              "error",
              `[assets] 本地素材分组删除失败: groupId=${groupId}, 错误: ${formatted}`,
            );
            setLocalAssetsError(backendErrorMessage(error));
          },
        )
        .finally(() => setDeletingLocalAssetGroupId(null));
    },
    [deletingLocalAssetGroupId, refreshLocalAssetGroups, refreshLocalAssets],
  );

  /** 移动本地素材到分组（null = 移出分组）；供详情弹窗单素材与多选批量共用。 */
  const handleMoveLocalAssets = useCallback(
    (assets: readonly AssetItem[], groupId: string | null) => {
      const ids = assets
        .filter((asset) => asset.source === "local" && asset.id.startsWith("local-b64-"))
        .map((asset) => asset.id);
      if (ids.length === 0) return;
      void localBase64AssetClient.moveAssets({ assetIds: ids, groupId }).then(
        (moved) => {
          frontendLog(
            "info",
            `[assets] 本地素材已移动分组: 目标=${groupId ?? "未分组"}, 命中 ${moved}/${ids.length} 个`,
          );
          if (moved === 0) {
            toast.info("没有可移动的素材，列表可能已更新。");
            return;
          }
          if (moved < ids.length) toast.info(`部分素材已不在本地素材库，移动了 ${moved} 项。`);
          refreshLocalAssetGroups();
          refreshLocalAssets("group-changed");
          setPickedAssets([]);
        },
        (error: unknown) => {
          const formatted = formatRawBackendError(error);
          frontendLog("error", `[assets] 本地素材移动分组失败: 错误: ${formatted}`);
          toast.error("移动分组失败", { description: backendErrorMessage(error) });
        },
      );
    },
    [refreshLocalAssetGroups, refreshLocalAssets],
  );

  /** 删除本地 Base64 素材（正文 + 索引行）；供详情弹窗单素材与多选批量共用。 */
  const handleDeleteLocalAssets = useCallback(
    async (assets: readonly AssetItem[]): Promise<void> => {
      const targets = assets.filter(
        (asset) => asset.source === "local" && asset.id.startsWith("local-b64-"),
      );
      if (targets.length === 0) return;
      let deleted = 0;
      for (const asset of targets) {
        try {
          await localBase64AssetClient.deleteAsset({ id: asset.id });
          deleted += 1;
        } catch (error) {
          frontendLog(
            "error",
            `[assets] 本地素材删除失败: assetId=${asset.id}, 错误: ${formatRawBackendError(error)}`,
          );
        }
      }
      if (deleted > 0) {
        frontendLog("info", `[assets] 本地素材已删除: ${deleted}/${targets.length} 个`);
        refreshLocalAssetGroups();
        refreshLocalAssets("delete");
        setPickedAssets([]);
        toast.success(
          targets.length === 1
            ? `已从本地素材库删除「${targets[0]?.name ?? ""}」`
            : `已从本地素材库删除 ${deleted} 项素材`,
        );
      }
      if (deleted < targets.length) {
        toast.error(`有 ${targets.length - deleted} 项素材删除失败，列表可能已更新。`);
      }
    },
    [refreshLocalAssetGroups, refreshLocalAssets],
  );

  // 对象存储保留独立目录：旧 TOS-only 素材与新上传的对象都在这里按页浏览，
  // 不混入云端供应商素材库，也不混入本机 Base64 素材库。
  const refreshObjectStorageAssets = useCallback((source: AssetRefreshSource): void => {
    const requestId = ++objectStorageRequestRef.current;
    const pageNumber = objectStoragePageRef.current;
    const mediaType = assetKindRef.current;
    const name = committedAssetSearchRef.current.trim();
    setObjectStorageLoading(true);
    void tosStagingClient
      .listLocalAssets({
        mediaType,
        name: name || null,
        page: pageNumber,
        pageSize: ASSET_PAGE_SIZE,
      })
      .then(
        (page) => {
          if (requestId !== objectStorageRequestRef.current) return;
          setObjectStorageAssets(page.items);
          setObjectStorageTotal(page.total);
          setObjectStorageKindTotals(page.kindTotals);
          setObjectStorageError(null);
          setObjectStorageLibraryError(false);
          frontendLog(
            "info",
            `[assets] 对象存储索引读取成功: 来源=${source}, 类型=${mediaType}, 页码=${pageNumber}, 本页=${page.items.length}, 总数=${page.total}`,
          );
        },
        (error: unknown) => {
          if (requestId !== objectStorageRequestRef.current) return;
          const formatted = formatRawBackendError(error);
          setObjectStorageError(backendErrorMessage(error));
          setObjectStorageLibraryError(true);
          frontendLog("error", `[assets] 对象存储索引读取失败: 来源=${source}, 错误=${formatted}`);
        },
      )
      .finally(() => {
        if (requestId === objectStorageRequestRef.current) setObjectStorageLoading(false);
      });
  }, []);

  const handlePullObjectStorageBucket = useCallback(async (): Promise<void> => {
    if (pullingBucketRef.current) return;
    pullingBucketRef.current = true;
    setPullingBucket(true);
    try {
      const summary = await tosStagingClient.pullBucketAssets();
      refreshObjectStorageAssets("manual");
      setObjectStorageError(null);
      toast.success(
        `对象存储同步完成：新增 ${summary.imported} 项，已有 ${summary.skippedExisting} 项`,
      );
    } catch (error) {
      const message = backendErrorMessage(error);
      setObjectStorageError(message);
      toast.error(`对象存储同步失败：${message}`);
    } finally {
      pullingBucketRef.current = false;
      setPullingBucket(false);
    }
  }, [refreshObjectStorageAssets]);

  // 拉取当前令牌作用域下的云端素材库分组。分组失败不阻塞素材浏览：
  // 选中保持「全部素材」，仅记录错误并允许在界面上重试。
  const refreshAssetGroups = useCallback(
    (providerConnectionId: string, preferredGroupId: string | null = null): void => {
      if (!isDesktopRuntime()) return;
      // 状态重置延迟到微任务提交：effect 同步触发时避免在 effect 体内 setState
      // 引发级联渲染（react-hooks/set-state-in-effect），与素材列表拉取一致。
      void Promise.resolve().then(() => {
        setGroupsLoading(true);
      });
      void assetLibraryClient
        .listAssetGroups(providerConnectionId)
        .then(
          (groups) => {
            setAssetGroups(groups);
            const wanted = preferredGroupId ?? selectedAssetGroupIdRef.current;
            const next =
              wanted != null && groups.some((group) => group.id === wanted) ? wanted : null;
            selectedAssetGroupIdRef.current = next;
            setSelectedAssetGroupId(next);
            setGroupsError(null);
            frontendLog(
              "info",
              `[assets] 素材库分组拉取成功: providerConnectionId=${providerConnectionId}, 共 ${groups.length} 个分组`,
            );
          },
          (error: unknown) => {
            const formatted = formatRawBackendError(error);
            frontendLog(
              "error",
              `[assets] 素材库分组拉取失败: providerConnectionId=${providerConnectionId}, 错误: ${formatted}`,
            );
            setGroupsError(error instanceof Error ? error.message : formatted);
          },
        )
        .finally(() => {
          setGroupsLoading(false);
        });
    },
    [],
  );

  const handleAssetGroupChanged = useCallback(
    (groupId: string | null, providerConnectionId: string) => {
      selectedAssetGroupIdRef.current = groupId;
      setSelectedAssetGroupId(groupId);
      refreshCloudAssets(providerConnectionId, "group-changed");
      // 计数口径跟随分组：切换分组后重新扫描该范围内的类型计数。
      refreshCloudAssetKindTotals(providerConnectionId, groupId, "group-changed");
    },
    [refreshCloudAssetKindTotals, refreshCloudAssets],
  );

  const handleCreateAssetGroup = useCallback(
    (providerConnectionId: string, name: string): void => {
      setCreatingGroup(true);
      void assetLibraryClient
        .createAssetGroup({ providerConnectionId, name })
        .then(
          (group) => {
            setNewGroupDialogOpen(false);
            frontendLog(
              "info",
              `[assets] 素材库分组已创建: providerConnectionId=${providerConnectionId}, groupId=${group.id}, name=${group.name}`,
            );
            selectedAssetGroupIdRef.current = group.id;
            setSelectedAssetGroupId(group.id);
            // 服务器分组列表可能尚未包含刚创建的记录，本地先插入保证选择器立即可见，
            // 后台刷新用于同步计数。
            setAssetGroups((current) =>
              current.some((entry) => entry.id === group.id) ? current : [...current, group],
            );
            refreshAssetGroups(providerConnectionId, group.id);
            // 分组选择变化触发的重查由分页查询 filter effect 统一处理。
          },
          (error: unknown) => {
            const formatted = formatRawBackendError(error);
            frontendLog(
              "error",
              `[assets] 素材库分组创建失败: providerConnectionId=${providerConnectionId}, 错误: ${formatted}`,
            );
            setAssetsError(backendErrorMessage(error));
          },
        )
        .finally(() => setCreatingGroup(false));
    },
    [refreshAssetGroups],
  );

  const handleDeleteAssetGroup = useCallback(
    (providerConnectionId: string, groupId: string): void => {
      if (deletingAssetGroupId != null) return;
      if (!isDeletableCloudAssetGroupId(groupId)) {
        frontendLog(
          "warn",
          `[assets] 拒绝删除未落库的临时分组，未向云端发删除请求: providerConnectionId=${providerConnectionId}, groupId=${groupId}`,
        );
        setAssetsError("该分组还在同步到云端，请稍候再删，以免误伤整库。");
        return;
      }
      setDeletingAssetGroupId(groupId);
      void assetLibraryClient
        .deleteAssetGroup({ providerConnectionId, id: groupId })
        .then(
          (deletedId) => {
            frontendLog(
              "info",
              `[assets] 素材库分组已删除: providerConnectionId=${providerConnectionId}, groupId=${deletedId}`,
            );
            // 被删分组不再存在：清空本地选中并移除本地记录，后台刷新同步计数。
            if (selectedAssetGroupIdRef.current === groupId) {
              selectedAssetGroupIdRef.current = null;
              setSelectedAssetGroupId(null);
            }
            setAssetGroups((current) => current.filter((group) => group.id !== groupId));
            refreshAssetGroups(providerConnectionId);
            // 组内素材已连同分组删除；若删除的是当前计数范围，整库计数同样需要重扫。
            if (selectedAssetGroupIdRef.current == null) {
              refreshCloudAssetKindTotals(providerConnectionId, null, "group-deleted");
            }
          },
          (error: unknown) => {
            const formatted = formatRawBackendError(error);
            frontendLog(
              "error",
              `[assets] 素材库分组删除失败: providerConnectionId=${providerConnectionId}, groupId=${groupId}, 错误: ${formatted}`,
            );
            setAssetsError(backendErrorMessage(error));
          },
        )
        .finally(() => setDeletingAssetGroupId(null));
    },
    [deletingAssetGroupId, refreshAssetGroups, refreshCloudAssetKindTotals],
  );

  const handleRenameAsset = useCallback(
    (asset: AssetItem, name: string) => {
      if (asset.source !== "cloud" || !asset.providerConnectionId) return;
      setRenamingAssetId(asset.id);
      void assetLibraryClient
        .renameAsset({
          providerConnectionId: asset.providerConnectionId,
          id: asset.id,
          name,
        })
        .then(
          (renamedId) => {
            frontendLog(
              "info",
              `[assets] 云端素材已改名: assetId=${asset.id}, renamedId=${renamedId}, name=${name}`,
            );
            setPreviewAsset(null);
            if (assetProvider) {
              refreshCloudAssets(assetProvider.id, "rename");
              // 改名不改类型；但上游记录被重写后类型字段可能随之变化，重扫一次保持计数准确。
              refreshCloudAssetKindTotals(
                assetProvider.id,
                selectedAssetGroupIdRef.current,
                "rename",
              );
            }
          },
          (error: unknown) => {
            const formatted = formatRawBackendError(error);
            frontendLog(
              "error",
              `[assets] 云端素材改名失败: assetId=${asset.id}, 错误: ${formatted}`,
            );
            setAssetsError(backendErrorMessage(error));
          },
        )
        .finally(() => setRenamingAssetId(null));
    },
    [assetProvider, refreshCloudAssetKindTotals, refreshCloudAssets],
  );

  const handleAssetLibraryLoaded = useCallback(
    (providerConnectionId: string, assets: readonly CloudAsset[]) => {
      const request = settingsAssetRequestRef.current;
      if (
        request?.providerConnectionId !== providerConnectionId ||
        request.requestId !== cloudAssetsRequestRef.current
      ) {
        frontendLog(
          "info",
          `[assets] 已忽略过期设置页素材响应: providerConnectionId=${providerConnectionId}`,
        );
        return;
      }
      settingsAssetRequestRef.current = null;
      rememberAssetProvider(providerConnectionId);
      setCloudAssets([...assets]);
      setAssetsError(null);
      setLibraryError(false);
      setAssetsLoading(false);
      refreshAssetGroups(providerConnectionId);
      frontendLog(
        "info",
        `[assets] 全局设置中的素材库令牌校验成功: providerConnectionId=${providerConnectionId}, 共 ${assets.length} 个素材`,
      );
    },
    [rememberAssetProvider, refreshAssetGroups],
  );

  const handleAssetLibraryLoading = useCallback(
    (providerConnectionId: string) => {
      const requestId = ++cloudAssetsRequestRef.current;
      settingsAssetRequestRef.current = { providerConnectionId, requestId };
      rememberAssetProvider(providerConnectionId);
      setCloudAssets([]);
      setAssetsError(null);
      setLibraryError(false);
      setAssetsLoading(true);
    },
    [rememberAssetProvider],
  );

  const handleAssetLibraryLoadFailed = useCallback(
    (providerConnectionId: string, error: string) => {
      const request = settingsAssetRequestRef.current;
      if (
        request?.providerConnectionId !== providerConnectionId ||
        request.requestId !== cloudAssetsRequestRef.current
      ) {
        frontendLog(
          "info",
          `[assets] 已忽略过期设置页素材错误: providerConnectionId=${providerConnectionId}`,
        );
        return;
      }
      settingsAssetRequestRef.current = null;
      rememberAssetProvider(providerConnectionId);
      setCloudAssets([]);
      setAssetsError(error);
      setLibraryError(true);
      setAssetsLoading(false);
    },
    [rememberAssetProvider],
  );

  // 同步稳定回调读取的 ref：声明顺序必须早于 scope / filter 查询 effect，
  // 保证同一次提交内先同步再发起分页查询（否则查询会拿到上一次的类型/搜索词）。
  useEffect(() => {
    assetKindRef.current = assetKind;
  }, [assetKind]);
  useEffect(() => {
    committedAssetSearchRef.current = committedAssetSearch;
  }, [committedAssetSearch]);

  // 素材面板打开时扫描一次云端类型计数（供应商切换、分组切换各再扫一次）。
  // 面板关闭时不再扫描，但已拿到的计数保留：再次打开同一作用域不会重复扫全库。
  const assetPanelOpen = isDesktopRuntime() && !settingsOpen;
  const cloudKindTotalsScanKey = assetPanelOpen ? (assetProvider?.id ?? null) : null;
  useEffect(() => {
    if (cloudKindTotalsScanKey == null) return;
    refreshCloudAssetKindTotals(
      cloudKindTotalsScanKey,
      selectedAssetGroupIdRef.current,
      "panel-opened",
    );
  }, [cloudKindTotalsScanKey, refreshCloudAssetKindTotals]);

  // 素材库分页查询统一入口：来源 / 供应商 / 设置面板开关变化时回到第 1 页重查。
  // 查询键去重避免同一状态组合重复请求；分组列表仍在云端来源下单独刷新。
  const assetQueryScopeKeyRef = useRef("");
  useEffect(() => {
    const resetToFirstPage = () => {
      cloudAssetPageRef.current = 1;
      localAssetPageRef.current = 1;
      objectStoragePageRef.current = 1;
      setCloudAssetPageNumber(1);
      setLocalAssetPageNumber(1);
      setObjectStoragePageNumber(1);
    };
    if (!isDesktopRuntime()) {
      assetQueryScopeKeyRef.current = "";
      return;
    }
    const scopeKey =
      assetLibrarySource === "local"
        ? "local"
        : cloudCollection === "object_storage"
          ? "object_storage"
          : `cloud|${assetProvider?.id ?? ""}|${settingsOpen ? "settings" : ""}`;
    if (assetQueryScopeKeyRef.current === scopeKey) return;
    assetQueryScopeKeyRef.current = scopeKey;
    resetToFirstPage();
    if (assetLibrarySource === "cloud") {
      if (cloudCollection === "object_storage") {
        refreshObjectStorageAssets("initial");
        return;
      }
      if (!assetProvider || settingsOpen) return;
      refreshCloudAssets(assetProvider.id, "initial");
      refreshAssetGroups(assetProvider.id);
      // 不用 cleanup 失效在途请求：provider/settings 等路径已显式递增请求号，
      // 而 refresh 本身也会递增；这里 cleanup 会在依赖变化但 key 未变时
      // 误杀在途响应且不重发，导致面板卡在空列表。
    } else {
      refreshLocalAssets("initial");
      // 本地分组与素材列表并行拉取；分组失败不阻塞浏览（选择器显示重试）。
      refreshLocalAssetGroups();
    }
    // refreshCloudAssets / refreshLocalAssets / refreshAssetGroups 均为稳定回调（依赖为空）。
  }, [
    assetLibrarySource,
    cloudCollection,
    assetProvider,
    refreshAssetGroups,
    refreshCloudAssets,
    refreshLocalAssetGroups,
    refreshLocalAssets,
    refreshObjectStorageAssets,
    settingsOpen,
  ]);

  // 类型 Tab / 防抖搜索词 / 分组选择变化：回到第 1 页并重查当前来源（查询键去重）。
  // 来源 / 供应商切换由上方 scope effect 负责，故 key 不含来源；首次运行只登记 key，
  // 首查由 scope effect 发起，避免挂载时重复请求。
  const assetQueryFilterKeyRef = useRef("");
  const assetQueryFilterArmedRef = useRef(false);
  useEffect(() => {
    if (!isDesktopRuntime()) {
      assetQueryFilterArmedRef.current = false;
      assetQueryFilterKeyRef.current = "";
      return;
    }
    // 分组段按来源取值：本地=本地分组，云端素材库=云端分组，对象存储无分组。
    // 空串与「未选分组」等价，来源切换（两边都没选分组）不会触发多余重查。
    const groupSegment =
      assetLibrarySource === "local"
        ? (selectedLocalAssetGroupId ?? "")
        : cloudCollection === "library"
          ? (selectedAssetGroupId ?? "")
          : "";
    const filterKey = `${assetKind}|${committedAssetSearch}|${groupSegment}`;
    if (assetQueryFilterKeyRef.current === filterKey) return;
    assetQueryFilterKeyRef.current = filterKey;
    if (!assetQueryFilterArmedRef.current) {
      assetQueryFilterArmedRef.current = true;
      return;
    }
    cloudAssetPageRef.current = 1;
    localAssetPageRef.current = 1;
    objectStoragePageRef.current = 1;
    setCloudAssetPageNumber(1);
    setLocalAssetPageNumber(1);
    setObjectStoragePageNumber(1);
    if (assetLibrarySource === "cloud") {
      if (cloudCollection === "object_storage") {
        refreshObjectStorageAssets("filter");
        return;
      }
      if (!assetProvider || settingsOpen) return;
      refreshCloudAssets(assetProvider.id, "filter");
    } else {
      refreshLocalAssets("filter");
    }
  }, [
    assetKind,
    assetLibrarySource,
    cloudCollection,
    assetProvider,
    committedAssetSearch,
    refreshCloudAssets,
    refreshLocalAssets,
    refreshObjectStorageAssets,
    selectedAssetGroupId,
    selectedLocalAssetGroupId,
    settingsOpen,
  ]);

  // 搜索输入防抖提交：停止输入 350ms 后才发起分页查询。
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const committed = assetSearch.trim();
      committedAssetSearchRef.current = committed;
      setCommittedAssetSearch(committed);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [assetSearch]);

  // 断网恢复时自动重拉当前云端目录（首次挂载不算）。
  useEffect(() => {
    if (wasOfflineRef.current && !isOffline && assetLibrarySource === "cloud") {
      if (cloudCollection === "object_storage") {
        refreshObjectStorageAssets("reconnect");
      } else if (!assetProvider) {
        frontendLog("warn", "[assets] 检测到断网恢复，但没有已启用的供应商连接，跳过自动刷新");
      } else {
        const providerId = assetProvider.id;
        frontendLog(
          "info",
          `[assets] 检测到断网恢复，自动刷新云端素材列表: providerConnectionId=${providerId}`,
        );
        refreshCloudAssets(providerId, "reconnect");
        refreshAssetGroups(providerId);
      }
    }
    wasOfflineRef.current = isOffline;
  }, [
    isOffline,
    assetLibrarySource,
    assetProvider,
    cloudCollection,
    refreshAssetGroups,
    refreshCloudAssets,
    refreshObjectStorageAssets,
  ]);

  const handleImportLocalAssets = useCallback(
    async (
      realPersonGroup?: RealPersonGroup,
      options?: {
        readonly destination?: AssetLibrarySource | "object_storage";
      },
    ): Promise<number> => {
      const destination = realPersonGroup ? "cloud" : (options?.destination ?? assetLibrarySource);
      const uploadOutsideCurrentLibrary = destination !== assetLibrarySource;
      const reportError = (message: string) => {
        if (destination === "cloud") setAssetsError(message);
        else if (destination === "object_storage") setObjectStorageError(message);
        else setLocalAssetsError(message);
        if (uploadOutsideCurrentLibrary) toast.error(message);
      };
      // 非桌面（浏览器预览）环境：文件选择器直接返回空，明确提示而非静默无反应。
      if (!isDesktopRuntime()) {
        reportError("上传素材功能仅在桌面应用中使用，浏览器预览模式暂不支持。");
        return 0;
      }
      if (destination === "cloud" && !assetProvider) {
        reportError("请先在全局设置中配置并启用供应商连接，再上传本地素材。");
        return 0;
      }
      if (destination === "cloud") setAssetsError(null);
      else if (destination === "object_storage") setObjectStorageError(null);
      else setLocalAssetsError(null);
      if (destination !== "local") {
        // 云端导入仍需 TOS 中转；本机 Base64 入库不读取对象存储配置。
        let stagingConfig: TosStagingConfig | null;
        try {
          stagingConfig = await tosStagingClient.getConfig();
        } catch (error) {
          reportError(`对象存储配置读取失败：${backendErrorMessage(error)}`);
          return 0;
        }
        if (stagingConfig == null || !stagingConfig.enabled) {
          reportError(
            "对象存储未启用，无法上传素材：请在“设置 → 对象存储”中填写桶名、AccessKey 与 Secret 并保存（桶名为空会停用上传）。",
          );
          return 0;
        }
      }
      const files = await pickLocalMediaFiles();
      if (files.length === 0) {
        toast.info("未选择文件，已取消上传。");
        return 0;
      }
      // 先为每个可识别的文件插入「准备中」占位行，再逐个提交任务；
      // 避免 startUpload 的 IPC 等待期界面无任何反馈。
      const candidates: Array<{
        readonly pendingId: string;
        readonly filePath: string;
        readonly name: string;
        readonly kind: MediaLibraryKind;
      }> = [];
      const unsupportedFiles: string[] = [];
      for (const filePath of files) {
        const name = filePath.split(/[\\/]/).pop() ?? filePath;
        const kind = inferMediaKindFromName(filePath);
        if (!kind) {
          unsupportedFiles.push(name);
          continue;
        }
        candidates.push({
          pendingId: `pending-upload-${pendingUploadSeqRef.current++}`,
          filePath,
          name,
          kind,
        });
      }
      if (candidates.length > 0) {
        setAssetUploads((current) => [
          ...current,
          ...candidates.map((candidate) => ({
            jobId: candidate.pendingId,
            name: candidate.name,
            kind: candidate.kind,
            // 素材身份由后端在入库成功后写回，提交这一刻还没有。
            assetId: null,
            status: "preparing" as const,
            bytesUploaded: 0,
            bytesTotal: null,
            error: null,
            lastAdvancedAt: Date.now(),
            stalled: false,
            destination,
            // 尺寸归一化等自动调整由后端在真正上传时决定，这里先留空。
            adjustment: null,
          })),
        ]);
      }
      let startedCount = 0;
      let firstError: unknown = null;
      for (const candidate of candidates) {
        try {
          if (destination === "local") {
            const record = await localBase64AssetClient.importAsset({
              localPath: candidate.filePath,
              name: candidate.name,
              // 上传目标跟随面板当前选中的本地分组（全部/未分组 = 未分组）。
              groupId: uploadTargetLocalGroupId(),
            });
            startedCount += 1;
            setAssetUploads((current) =>
              current.map((entry) =>
                entry.jobId === candidate.pendingId
                  ? {
                      ...entry,
                      jobId: record.id,
                      assetId: record.id,
                      status: "staged",
                      bytesUploaded: record.byteSize,
                      bytesTotal: record.byteSize,
                      lastAdvancedAt: Date.now(),
                    }
                  : entry,
              ),
            );
            window.setTimeout(() => {
              setAssetUploads((current) => current.filter((entry) => entry.jobId !== record.id));
            }, UPLOAD_AUTO_DISMISS_DELAY_MS);
            continue;
          }
          const jobId = await tosStagingClient.startUpload({
            localPath: candidate.filePath,
            purpose: destination === "object_storage" ? "local_asset" : "asset_import",
            mediaType: candidate.kind,
            import:
              destination === "cloud" && assetProvider
                ? {
                    providerConnectionId: assetProvider.id,
                    name: candidate.name,
                    // 真人素材上传用平台数值分组 ID；普通上传沿用面板当前选中的分组。
                    groupId:
                      realPersonGroup != null
                        ? String(realPersonGroup.id)
                        : selectedAssetGroupIdRef.current,
                  }
                : null,
          });
          startedCount += 1;
          setAssetUploads((current) =>
            current.map((entry) =>
              entry.jobId === candidate.pendingId
                ? {
                    ...entry,
                    jobId,
                    status: "validating",
                    lastAdvancedAt: Date.now(),
                  }
                : entry,
            ),
          );
        } catch (error) {
          firstError ??= error;
          setAssetUploads((current) =>
            current.map((entry) =>
              entry.jobId === candidate.pendingId
                ? {
                    ...entry,
                    status: "failed",
                    error,
                    lastAdvancedAt: Date.now(),
                  }
                : entry,
            ),
          );
          if (destination === "cloud") setAssetsError(backendErrorMessage(error));
          else if (destination === "object_storage")
            setObjectStorageError(backendErrorMessage(error));
          else setLocalAssetsError(backendErrorMessage(error));
          if (uploadOutsideCurrentLibrary) toast.error("上传失败", { description: backendErrorMessage(error) });
        }
      }
      if (unsupportedFiles.length > 0) {
        const message = `不支持的文件类型，已跳过：${unsupportedFiles.join("、")}。支持 mp4 / mov / webm / avi / mkv 等常见格式。`;
        if (destination === "cloud") setAssetsError(message);
        else if (destination === "object_storage") setObjectStorageError(message);
        else setLocalAssetsError(message);
        if (uploadOutsideCurrentLibrary) toast.error(message);
      }
      if (startedCount > 0 && destination === "local") refreshLocalAssets("upload-finished");
      if (startedCount > 0 && uploadOutsideCurrentLibrary) {
        if (destination === "local") toast.success(`已保存 ${startedCount} 项素材到本地素材库`);
        else {
          const target = destination === "object_storage" ? "对象存储" : "云端素材库";
          toast.info(`正在上传 ${startedCount} 项素材到${target}`, {
            description: "进度也可以在左侧素材库查看。",
          });
        }
      }
      if (startedCount === 0 && firstError != null && realPersonGroup) {
        throw firstError instanceof Error
          ? firstError
          : new Error(backendErrorMessage(firstError));
      }
      return startedCount;
    },
    [assetLibrarySource, assetProvider, refreshLocalAssets, uploadTargetLocalGroupId],
  );

  /** 把已保存的图片/视频产物写入明确选择的目标。 */
  const uploadOutputsToLibrary = useCallback(
    async (
      outputKeys: readonly string[],
      destination: "cloud" | "local" | "object_storage",
    ): Promise<void> => {
      const wanted = new Set(outputKeys);
      const saved = canvasNodesNow("output").flatMap((node) => {
        if (!wanted.has(node.key)) return [];
        if (node.mediaType !== "image" && node.mediaType !== "video" && node.mediaType !== "audio")
          return [];
        if (node.finalPath == null) return [];
        return [{ node, mediaType: node.mediaType, localPath: node.finalPath }];
      });
      if (saved.length === 0) {
        toast.error(
          outputKeys.length === 1
            ? "仅已保存到本地的媒体产物支持上传到素材库。"
            : "组内没有已保存到本地的媒体产物，无法上传到当前素材库。",
        );
        return;
      }
      if (!isDesktopRuntime()) {
        toast.error("上传素材功能仅在桌面应用中使用，浏览器预览模式暂不支持。");
        return;
      }
      if (destination === "cloud" && !assetProvider) {
        toast.error("请先在全局设置中配置并启用供应商连接，再上传到云端素材库。");
        return;
      }
      if (destination !== "local") {
        let stagingConfig: TosStagingConfig | null;
        try {
          stagingConfig = await tosStagingClient.getConfig();
        } catch (error) {
          toast.error("对象存储配置读取失败", { description: backendErrorMessage(error) });
          return;
        }
        if (stagingConfig == null || !stagingConfig.enabled) {
          toast.error(
            "对象存储未启用，无法上传素材：请在“设置 → 对象存储”中填写桶名、AccessKey 与 Secret 并保存。",
          );
          return;
        }
      }
      const libraryName =
        destination === "local"
          ? "本地素材库"
          : destination === "object_storage"
            ? "对象存储"
            : "云端素材库";
      let started = 0;
      for (const output of saved) {
        const pendingId = `pending-upload-${pendingUploadSeqRef.current++}`;
        const name =
          output.node.name ??
          output.localPath.split(/[\\/]/).pop() ??
          `${output.mediaType === "video" ? "视频" : output.mediaType === "audio" ? "音频" : "图片"}产物`;
        if (destination === "cloud") uploadJobToOutputRef.current.set(pendingId, output.node.key);
        if (destination === "object_storage")
          objectStorageUploadJobToOutputRef.current.set(pendingId, output.node.key);
        setAssetUploads((current) => [
          ...current,
          {
            jobId: pendingId,
            name,
            kind: output.mediaType,
            assetId: null,
            status: "preparing",
            bytesUploaded: 0,
            bytesTotal: null,
            error: null,
            lastAdvancedAt: Date.now(),
            stalled: false,
            destination,
            adjustment: null,
          },
        ]);
        try {
          if (destination === "local") {
            const record = await localBase64AssetClient.importAsset({
              localPath: output.localPath,
              name,
              groupId: uploadTargetLocalGroupId(),
            });
            setAssetUploads((current) =>
              current.map((entry) =>
                entry.jobId === pendingId
                  ? {
                      ...entry,
                      jobId: record.id,
                      assetId: record.id,
                      status: "staged",
                      bytesUploaded: record.byteSize,
                      bytesTotal: record.byteSize,
                      lastAdvancedAt: Date.now(),
                    }
                  : entry,
              ),
            );
            window.setTimeout(() => {
              setAssetUploads((current) => current.filter((entry) => entry.jobId !== record.id));
            }, UPLOAD_AUTO_DISMISS_DELAY_MS);
            patchNode("output", output.node.key, (node) => ({ ...node, uploadedToLocal: true }));
            refreshLocalAssets("upload-finished");
            started += 1;
            if (outputKeys.length === 1) toast.success(`已保存「${name}」到本地素材库`);
            continue;
          }
          const jobId = await tosStagingClient.startUpload({
            localPath: output.localPath,
            purpose: destination === "object_storage" ? "local_asset" : "asset_import",
            mediaType: output.mediaType,
            import:
              destination === "cloud" && assetProvider
                ? {
                    providerConnectionId: assetProvider.id,
                    name,
                    groupId: selectedAssetGroupIdRef.current,
                  }
                : null,
          });
          if (destination === "cloud") {
            uploadJobToOutputRef.current.delete(pendingId);
            uploadJobToOutputRef.current.set(jobId, output.node.key);
          } else {
            objectStorageUploadJobToOutputRef.current.delete(pendingId);
            objectStorageUploadJobToOutputRef.current.set(jobId, output.node.key);
          }
          setAssetUploads((current) =>
            current.map((entry) =>
              entry.jobId === pendingId
                ? { ...entry, jobId, status: "validating", lastAdvancedAt: Date.now() }
                : entry,
            ),
          );
          started += 1;
          if (outputKeys.length === 1)
            toast.success(`已开始上传「${name}」到${libraryName}，可在素材面板查看进度。`);
        } catch (error) {
          setAssetUploads((current) =>
            current.map((entry) =>
              entry.jobId === pendingId
                ? { ...entry, status: "failed", error, lastAdvancedAt: Date.now() }
                : entry,
            ),
          );
          uploadJobToOutputRef.current.delete(pendingId);
          objectStorageUploadJobToOutputRef.current.delete(pendingId);
          toast.error("上传失败", { description: backendErrorMessage(error) });
        }
      }
      const skipped = outputKeys.length - saved.length;
      if (started > 0 && outputKeys.length !== 1) {
        toast.success(
          `${destination === "local" ? "已保存" : "已开始上传"} ${started} 个产物到${libraryName}`,
          {
            description:
              skipped > 0
                ? `已跳过 ${skipped} 个尚未保存的媒体或文本产物。`
                : destination === "local"
                  ? "可以在本地素材库查看。"
                  : "进度可以在素材面板查看。",
          },
        );
      }
    },
    [assetProvider, canvasNodesNow, patchNode, refreshLocalAssets, uploadTargetLocalGroupId],
  );
  const handleUploadOutputToCloud = useCallback(
    (outputKey: string) => {
      void uploadOutputsToLibrary([outputKey], "cloud");
    },
    [uploadOutputsToLibrary],
  );
  const handleUploadOutputToLocal = useCallback(
    (outputKey: string) => {
      void uploadOutputsToLibrary([outputKey], "local");
    },
    [uploadOutputsToLibrary],
  );
  const handleUploadOutputToObjectStorage = useCallback(
    (outputKey: string) => {
      void uploadOutputsToLibrary([outputKey], "object_storage");
    },
    [uploadOutputsToLibrary],
  );

  const savingExistingAssetsRef = useRef(new Set<string>());
  const saveExistingAssetToLibrary = useCallback(
    async (
      asset: {
        readonly id: string;
        readonly kind: MediaLibraryKind;
        readonly name: string;
        readonly source?: AssetLibrarySource | undefined;
        readonly providerConnectionId?: string | undefined;
      },
      destination: "local" | "cloud" | "object_storage",
    ) => {
      if (!isDesktopRuntime()) {
        toast.error("保存素材功能仅在桌面应用中使用。");
        return;
      }
      if (destination === "cloud" && !assetProvider) {
        toast.error("请先在全局设置中配置并启用云端素材库连接。");
        return;
      }
      if (asset.source !== "local" && !asset.providerConnectionId) {
        toast.error("素材缺少来源供应商，无法读取原始内容。");
        return;
      }
      const sourceKind =
        asset.source !== "local"
          ? "cloud"
          : asset.id.startsWith("local-b64-")
            ? "local_base64"
            : "object_storage";
      const targetName =
        destination === "local"
          ? "本地素材库"
          : destination === "cloud"
            ? "云端素材库"
            : "对象存储";
      const saveKey = `${sourceKind}:${asset.providerConnectionId ?? ""}:${asset.id}:${destination}:${assetProvider?.id ?? ""}:${selectedAssetGroupIdRef.current ?? ""}`;
      if (savingExistingAssetsRef.current.has(saveKey)) return;
      savingExistingAssetsRef.current.add(saveKey);
      const toastId = toast.loading(`正在保存「${asset.name}」到${targetName}…`);
      try {
        const result = await existingAssetClient.saveToLibrary({
          source: {
            kind: sourceKind,
            assetId: asset.id,
            providerConnectionId:
              sourceKind === "cloud" ? (asset.providerConnectionId ?? null) : null,
            mediaType: asset.kind,
          },
          destination,
          targetProviderConnectionId: destination === "cloud" ? (assetProvider?.id ?? null) : null,
          groupId: destination === "cloud" ? selectedAssetGroupIdRef.current : null,
          name: asset.name,
        });
        if (result.destination === "local") refreshLocalAssets("upload-finished");
        else if (result.destination === "object_storage")
          refreshObjectStorageAssets("upload-finished");
        else if (assetProvider) {
          void refreshCloudAssets(assetProvider.id, "upload-finished");
          refreshAssetGroups(assetProvider.id);
        }
        toast.success(
          result.reused
            ? `「${asset.name}」已在${targetName}，未重复保存`
            : `已保存「${asset.name}」到${targetName}`,
        );
      } catch (error) {
        toast.error("保存素材失败", { description: backendErrorMessage(error) });
      } finally {
        toast.dismiss(toastId);
        savingExistingAssetsRef.current.delete(saveKey);
      }
    },
    [
      assetProvider,
      refreshAssetGroups,
      refreshCloudAssets,
      refreshLocalAssets,
      refreshObjectStorageAssets,
    ],
  );
  const handleSaveAssetNodeToLibrary = useCallback(
    (key: string, destination: "local" | "cloud" | "object_storage") => {
      const entry = canvasStore.getState().nodesById[key];
      const node = entry?.type === "asset" ? entry.data : undefined;
      if (!node) return;
      void saveExistingAssetToLibrary(
        {
          id: node.assetId,
          kind: node.kind,
          name: node.name,
          source: node.source,
          providerConnectionId: node.providerConnectionId,
        },
        destination,
      );
    },
    [saveExistingAssetToLibrary, canvasStore],
  );
  useEffect(() => {
    return subscribeStagingEvents((payload) => {
      setAssetUploads((current) => {
        const index = current.findIndex((entry) => entry.jobId === payload.jobId);
        if (index === -1) return current;
        const job = payload.job;
        const next = [...current];
        const existing = next[index];
        if (existing != null) {
          next[index] = {
            ...existing,
            status: job?.status ?? "failed",
            // 素材身份只在入库成功后由后端写回；它是"这次上传成没成"的判据，
            // 事件里带上就必须落到行上（见 stagingImportReachedLibrary）。
            assetId: job?.assetId ?? existing.assetId,
            overseasDbId: job?.overseasDbId ?? existing.overseasDbId,
            providerConnectionId:
              job?.importTarget?.providerConnectionId ?? existing.providerConnectionId,
            bytesUploaded: job?.bytesUploaded ?? existing.bytesUploaded,
            bytesTotal: job?.bytesTotal ?? existing.bytesTotal,
            // 失败原因有两个来源：事件顶层的 error（进程内失败时后端只发 error），
            // 以及任务记录里的 job.error（跑完一轮后落库的完整记录，前端走 startUpload
            // 的那条路径就吃这个）。只看顶层会把后者的失败原因丢掉，用户看到一行
            // "失败"却没有任何原因。
            error: payload.error ?? (job != null ? job.error : existing.error),
            // 后端的尺寸归一化说明在上传阶段就已写回任务记录，随事件一起送达。
            adjustment: job?.adjustment ?? existing.adjustment,
          };
        }
        return next;
      });
      const status = payload.job?.status;
      const uploadDestination =
        uploadEntriesRef.current.find((entry) => entry.jobId === payload.jobId)?.destination ??
        (payload.job?.purpose === "local_asset" ? "object_storage" : "cloud");
      if (payload.job != null && isTimedOutAssetImport(payload.job)) {
        noteTimedOutAssetImport(payload.job);
        const providerId = payload.job.importTarget?.providerConnectionId;
        if (providerId != null && assetProvider?.id === providerId) {
          refreshCloudAssets(providerId, "upload-finished");
        }
      }
      // 入库是否成功看 `assetId` 而不是状态：后端给出素材身份后还会清理暂存对象
      // （active → cleaning → cleaned），事件里读到的未必是 active。
      const reachedLibrary = payload.job != null && stagingImportReachedLibrary(payload.job);
      if (payload.job?.purpose === "local_asset" && status === "staged") {
        refreshObjectStorageAssets("upload-finished");
        const outputKey = objectStorageUploadJobToOutputRef.current.get(payload.jobId);
        if (outputKey) {
          patchNodes("output", (node) =>
            node.key === outputKey && !node.uploadedToObjectStorage
              ? { ...node, uploadedToObjectStorage: true }
              : node,
          );
          objectStorageUploadJobToOutputRef.current.delete(payload.jobId);
        }
        toast.success("已保存到对象存储，可在云端素材的对象存储列表查看");
      } else if (assetLibrarySource === "cloud" && reachedLibrary) {
        if (assetProvider) {
          void refreshCloudAssets(assetProvider.id, "upload-finished");
          refreshAssetGroups(assetProvider.id);
          // 云端上传完成后按素材类型增量更新角标：不做全库重扫（那是「面板打开时扫一次」的成本）。
          // 只看整库口径（选中具体分组时上传去向由后端决定，无法归因到当前分组范围）。
          const uploadedKind = payload.job?.mediaType;
          if (
            selectedAssetGroupIdRef.current == null &&
            (uploadedKind === "image" || uploadedKind === "video" || uploadedKind === "audio")
          ) {
            applyCloudAssetKindDelta(assetProvider.id, null, uploadedKind, 1);
          }
        }
      }
      const outputUpload = uploadJobToOutputRef.current.get(payload.jobId);
      if (outputUpload && reachedLibrary) {
        patchNodes("output", (node) =>
          node.key !== outputUpload
            ? node
            : node.uploadedToCloud
              ? node
              : { ...node, uploadedToCloud: true },
        );
        uploadJobToOutputRef.current.delete(payload.jobId);
      }
      if (reachedLibrary) {
        const repair = previewRepairJobsRef.current.get(payload.jobId);
        const newAssetId = payload.job?.assetId;
        if (repair && newAssetId && newAssetId !== repair.oldAssetId) {
          patchNodes("asset", (node) =>
            node.source !== "local" &&
            node.assetId === repair.oldAssetId &&
            node.providerConnectionId === repair.providerConnectionId
              ? {
                  ...node,
                  assetId: newAssetId,
                  previewUrl: null,
                  videoUrl: node.kind === "video" ? null : node.videoUrl,
                }
              : node,
          );
          for (const [nodeKey, document] of Object.entries(promptContents.snapshotAll())) {
            const next = replaceCloudAssetIdInPromptDocument(
              document,
              repair.oldAssetId,
              newAssetId,
            );
            if (next) promptContents.restoreDocument(nodeKey, next);
          }
          /*
           * 显式排期落盘。
           *
           * 提示词内容住在提示词模块里，**不进画布 store**，所以内容变化不会
           * 触发 store 订阅里的落盘；节点卡里的编辑器靠 input 事件冒泡到画布视口
           * 触发排期，而独立编辑区（视口之外）的冒泡到不了视口。
           *
           * 这里是**程序改写**（素材自愈后把 @引用换到新素材身份），既没有
           * input 事件，也没有「编辑器已挂载」的订阅者（未挂载的节点连
           * promptContents.subscribe 都没建）——不显式排期，这次改写就只留在
           * 内存里：界面上看着是对的，重开画布后 @引用又指回已删除的旧素材。
           * 这正是 AGENTS.md 点名的「排期与落盘都正常，但重开画布就丢」那一类。
           */
          scheduleCanvasSaveRef.current?.();
          previewRepairJobsRef.current.delete(payload.jobId);
        }
      } else if (status === "failed" || status === "interrupted") {
        // 上传失败：清理映射，不标记已上传。
        uploadJobToOutputRef.current.delete(payload.jobId);
        objectStorageUploadJobToOutputRef.current.delete(payload.jobId);
        previewRepairJobsRef.current.delete(payload.jobId);
      }
      // 成功的上传不用用户再点一次 ×：素材已经入库、绿色小点已经点亮，这一行
      // 留一小会儿让"已完成"被看见，然后自行收起。失败/中断行永不自动收起
      // （用户要看原因并重试），僵尸在途行也留着由行内判定落地为可移除的已中断行。
      if (
        payload.job != null &&
        shouldAutoDismissUpload(payload.job, uploadDestination) &&
        !uploadAutoDismissTimersRef.current.has(payload.jobId)
      ) {
        uploadAutoDismissTimersRef.current.set(
          payload.jobId,
          window.setTimeout(() => {
            uploadAutoDismissTimersRef.current.delete(payload.jobId);
            // 延迟期间这一行可能已经被手动移除：重复过滤是幂等的。
            setAssetUploads((current) => current.filter((entry) => entry.jobId !== payload.jobId));
          }, UPLOAD_AUTO_DISMISS_DELAY_MS),
        );
      }
    });
  }, [
    assetLibrarySource,
    assetProvider,
    applyCloudAssetKindDelta,
    noteTimedOutAssetImport,
    patchNodes,
    promptContents,
    refreshAssetGroups,
    refreshCloudAssets,
    refreshLocalAssets,
    refreshObjectStorageAssets,
  ]);

  const dismissAssetUpload = useCallback((jobId: string) => {
    setAssetUploads((current) => current.filter((entry) => entry.jobId !== jobId));
  }, []);

  /** 重启恢复只尝试一次：后台任务本身不会因为本命令失败而消失，重试交给下一次启动。 */
  const restoredAssetImportsRef = useRef(false);
  /** 后端交回的上传记录；画布文档可能比它晚读回来，节点匹配因此要能重复尝试。 */
  const recoveredAssetImportsRef = useRef<readonly AssetImportOutputRecord[] | null>(null);
  /**
   * 应用重启后接回未完成/刚完成的产物入库上传。
   *
   * 上传在后端进程里推进，但 `jobId → 产物节点` 映射只活在前端内存：重启后成功事件到达时
   * 回查不到产物卡片，绿色小点永远不亮，在途上传也从素材面板消失，用户只能重传一次。
   * 这里取回后端仍在推进或刚完成的上传记录，交给下面的节点匹配点亮绿色小点，
   * 并把在途上传恢复成面板行继续跟踪。
   *
   * 只对产物节点生效：本机文件路径是产物节点与暂存任务唯一共有的稳定身份。
   */
  useEffect(() => {
    if (!isDesktopRuntime() || restoredAssetImportsRef.current) return;
    restoredAssetImportsRef.current = true;
    const restoredAt = Date.now();
    void tosStagingClient.listAssetImportOutputs().then(
      (records) => {
        recoveredAssetImportsRef.current = records;
        for (const record of records) {
          if (
            isTimedOutAssetImport(record) &&
            record.providerConnectionId != null &&
            record.overseasDbId != null
          ) {
            hideTimedOutCloudAsset(record.providerConnectionId, record.overseasDbId);
          }
        }
        // 在途上传恢复成面板行：状态与字节进度都来自后端记录，之后由既有轮询继续推进。
        // 长时间没有推进的记录不再当作"还在传"：进程在上传途中被杀时后端会留下一个
        // staged/importing 的僵死记录，显示成在途会让进度条永远转下去，用户既
        // 不知道失败也无法重试；按僵尸口径直接落地为已中断，给出明确的终态与原因。
        // 已经拿到素材身份的记录不算在内：那是入库成功（随后清理暂存对象没走完而已），
        // 恢复成在途行会让它两分钟后被判成"已中断"，而素材其实已经在库里了。
        const restoredEntries: AssetUploadEntry[] = records
          .filter((record) => !shouldAutoDismissUpload(record))
          .map((record) => {
            const lastAdvancedAt = record.updatedAt || restoredAt;
            const abandoned =
              record.overseasDbId == null &&
              (record.assetId == null || !isPlaceholderAssetIdentity(record.assetId)) &&
              restoredAt - lastAdvancedAt >= UPLOAD_ABANDONED_MS;
            return {
              jobId: record.jobId,
              name: localPathFileName(record.localPath),
              kind: record.mediaType,
              assetId: record.assetId,
              overseasDbId: record.overseasDbId,
              providerConnectionId: record.providerConnectionId,
              status: abandoned ? ("interrupted" as const) : record.status,
              bytesUploaded: record.bytesUploaded,
              bytesTotal: record.bytesTotal,
              error: abandoned ? abandonedUploadError(record.status) : record.error,
              lastAdvancedAt,
              stalled: false,
              destination: "cloud" as const,
              adjustment: null,
            };
          });
        if (restoredEntries.length > 0) {
          setAssetUploads((current) => {
            const known = new Set(current.map((entry) => entry.jobId));
            const merged = [...current, ...restoredEntries.filter((it) => !known.has(it.jobId))];
            return merged.sort((first, second) => first.lastAdvancedAt - second.lastAdvancedAt);
          });
          toast.info(`已恢复 ${restoredEntries.length} 条重启前的上传记录`, {
            description: "可在素材面板查看处理状态。",
          });
        }
        // 重启后只恢复同一 db_id 的状态查询。后端按海外提交时间执行固定截止，
        // 截止后的记录直接落为失败并清理；这里不重新上传素材，也不显示续查入口。
        for (const record of records) {
          if (record.status !== "importing" || record.overseasDbId == null) continue;
          void tosStagingClient.resumeStagingImport(record.jobId).catch((error: unknown) => {
            frontendLog(
              "info",
              `[assets] 重启后状态查询未启动: jobId=${record.jobId}, 原因=${formatRawBackendError(error)}`,
            );
          });
        }
        frontendLog(
          "info",
          `[assets] 重启恢复产物入库上传: 记录=${records.length}, 在途=${restoredEntries.length}`,
        );
      },
      (error: unknown) => {
        frontendLog("error", `[assets] 重启恢复产物入库上传失败: ${formatRawBackendError(error)}`);
      },
    );
  }, [hideTimedOutCloudAsset]);

  /**
   * 把已入库的上传记录配回产物节点并点亮绿色小点。
   *
   * 独立于取回动作重复执行：画布文档读取通常晚于本命令返回，节点列表在挂载后才出现；
   * 切换画布标签后节点集合也会整体替换。`uploadedToCloud` 的写入是幂等的，重复匹配无副作用。
   */
  useEffect(() => {
    const completed = (recoveredAssetImportsRef.current ?? []).filter((record) =>
      stagingImportReachedLibrary(record),
    );
    const outputs = canvasNodesNow("output");
    if (completed.length === 0 || outputs.length === 0) return;
    const outputKeyByLocalPath = new Map<string, string>();
    for (const node of outputs) {
      if (node.finalPath == null || node.finalPath === "") continue;
      outputKeyByLocalPath.set(normalizeLocalPathKey(node.finalPath), node.key);
    }
    const matchedKeys: string[] = [];
    for (const record of completed) {
      const outputKey = outputKeyByLocalPath.get(normalizeLocalPathKey(record.localPath));
      if (outputKey == null) continue;
      // 先重建映射再点亮：即使产物节点这一刻还没补齐 uploadedToCloud，事件路径也能命中。
      uploadJobToOutputRef.current.set(record.jobId, outputKey);
      if (outputs.some((node) => node.key === outputKey && node.uploadedToCloud !== true)) {
        matchedKeys.push(outputKey);
      }
    }
    if (matchedKeys.length === 0) return;
    const keys = new Set(matchedKeys);
    patchNodes("output", (node) =>
      keys.has(node.key) && !node.uploadedToCloud ? { ...node, uploadedToCloud: true } : node,
    );
    frontendLog("info", `[assets] 重启恢复绿色小点: 命中产物节点 ${matchedKeys.length} 个`);
  }, [outputCardSignature, canvasNodesNow, patchNodes]);

  /**
   * RF 实例就绪前的坐标兜底换算（store 中的 pan/zoom 与视口几何一致）。
   * 真实运行时 onInit 在任何交互前触发，兜底只服务于测试环境的时序。
   */
  const fallbackFlowPosition = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } => {
      const scale = zoom / 100;
      const rect = canvasViewportRef.current?.getBoundingClientRect();
      return {
        x: (clientX - (rect?.left ?? 0) - pan.x) / scale,
        y: (clientY - (rect?.top ?? 0) - pan.y) / scale,
      };
    },
    [pan, zoom],
  );

  /** 当前视口中心在画布坐标系中的位置（键盘/点击新增节点的默认落点）。 */
  const viewportCenterBoardCoordinates = useCallback((): { x: number; y: number } => {
    const viewport = canvasViewportRef.current;
    if (viewport == null) return { x: 0, y: 0 };
    const rect = viewport.getBoundingClientRect();
    const instance = flowInstanceRef.current;
    if (instance == null) {
      return fallbackFlowPosition(rect.left + rect.width / 2, rect.top + rect.height / 2);
    }
    const point = instance.screenToFlowPosition({
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    });
    return { x: point.x, y: point.y };
  }, [fallbackFlowPosition]);
  useLayoutEffect(() => {
    viewportCenterBoardCoordinatesRef.current = viewportCenterBoardCoordinates;
  }, [viewportCenterBoardCoordinates]);

  /** 指针拖拽松开点 → 画布坐标；松开点不在画布视口内时返回 null。 */
  const dropClientPointToBoard = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } | null => {
      const viewport = canvasViewportRef.current;
      if (viewport == null) return null;
      const rect = viewport.getBoundingClientRect();
      if (
        clientX < rect.left ||
        clientX > rect.right ||
        clientY < rect.top ||
        clientY > rect.bottom
      ) {
        return null;
      }
      const instance = flowInstanceRef.current;
      if (instance == null) return fallbackFlowPosition(clientX, clientY);
      const point = instance.screenToFlowPosition({ x: clientX, y: clientY });
      return { x: point.x, y: point.y };
    },
    [fallbackFlowPosition],
  );

  /** 节点落点：以节点中心对齐投放点，并就近避开所有已有节点。 */
  const dropPosition = useCallback(
    (rawX: number, rawY: number, width: number, height: number) =>
      nearestAvailableNodePosition(
        {
          x: rawX - width / 2,
          y: rawY - height / 2,
          width,
          height,
        },
        occupiedNodeRects,
      ),
    [occupiedNodeRects],
  );

  /** 各创建入口共用模型默认值与落点避让；由调用方提交节点或完整子图。 */
  const createGenNode = useCallback(
    (kind: CanvasGenNodeKind, x: number, y: number) => {
      const { width, height } = genNodeDimensions(kind);
      const position = dropPosition(x, y, width, height);
      const node: GenNodeData =
        kind === "video"
          ? {
              key: genNodeKey(),
              kind,
              config: createVideoNodeConfig(nodeModelSelections.video, providerCatalogLoaded),
              ...position,
            }
          : kind === "audio"
            ? {
                key: genNodeKey(),
                kind,
                config: createAudioNodeConfig(nodeModelSelections.audio, providerCatalogLoaded),
                ...position,
              }
            : kind === "prompt"
              ? {
                  key: genNodeKey(),
                  kind,
                  name: nextTextNodeName(canvasNodesOfState(canvasStore.getState(), "gen")),
                  config: createPromptNodeConfig(nodeModelSelections.prompt, providerCatalogLoaded),
                  ...position,
                }
              : {
                  key: genNodeKey(),
                  kind,
                  config: createImageNodeConfig(nodeModelSelections.image, providerCatalogLoaded),
                  ...position,
                };
      return node;
    },
    [
      canvasStore,
      dropPosition,
      nodeModelSelections.audio,
      nodeModelSelections.image,
      nodeModelSelections.prompt,
      nodeModelSelections.video,
      providerCatalogLoaded,
    ],
  );

  /** 创建独立剧本节点；复用全局文本模型连接。 */
  const createScreenplayNode = useCallback(
    (x: number, y: number, legacy = false) => {
      const position = dropPosition(x, y, legacy ? SCREENPLAY_NODE_WIDTH : SCRIPT_GENERATOR_NODE_SIZE,
        legacy ? SCREENPLAY_NODE_HEIGHT : SCRIPT_GENERATOR_NODE_SIZE);
      const node: ScreenplayNodeData = {
        key: screenplayNodeKey(),
        kind: "screenplay",
        ...position,
        config: {
          ...createScreenplayNodeConfig(nodeModelSelections.prompt, providerCatalogLoaded),
          ...(!legacy ? { scriptGenerator: emptyScriptGenerator() } : {}),
        },
      };
      return node;
    },
    [dropPosition, nodeModelSelections.prompt, providerCatalogLoaded],
  );

  /** 在画布上创建智能剪辑节点（照抄原站 liblib 的 `video-clip` 节点）。 */
  const createVideoClipNode = useCallback(
    (x: number, y: number) => {
      const position = dropPosition(x, y, VIDEO_CLIP_NODE_WIDTH, VIDEO_CLIP_NODE_HEIGHT);
      const index = canvasNodesOfState(canvasStore.getState(), "videoClip").length + 1;
      const node: VideoClipNodeData = {
        key: videoClipNodeKey(),
        kind: "video_clip",
        name: videoClipNodeName(index),
        ...position,
        config: {
          modeKey: "default",
          aspectRatio: VIDEO_CLIP_DEFAULT_PARAMS.aspectRatio,
          durationSeconds: VIDEO_CLIP_DEFAULT_PARAMS.durationSeconds,
          resolution: VIDEO_CLIP_DEFAULT_PARAMS.resolution,
          outputName: `智能剪辑成片 ${index}`,
        },
      };
      return node;
    },
    [canvasStore, dropPosition],
  );

  /** 先准备完整节点，再由菜单将节点和可选连线一次写入。 */
  const createQuickAddEntry = (kind: CanvasQuickAddKind, x: number, y: number): CanvasNodeEntry => {
    switch (kind) {
      case "text":
        return { type: "gen", data: createGenNode("prompt", x, y) };
      case "image":
        return { type: "gen", data: createGenNode("image", x, y) };
      case "video":
        return { type: "gen", data: createGenNode("video", x, y) };
      case "audio":
        return { type: "gen", data: createGenNode("audio", x, y) };
      case "screenplay":
        return { type: "screenplay", data: createScreenplayNode(x, y) };
      case "screenplay_legacy":
        return { type: "screenplay", data: createScreenplayNode(x, y, true) };
      case "video_clip":
        return { type: "videoClip", data: createVideoClipNode(x, y) };
      case "director":
        return { type: "director", data: {
          key: `director-${crypto.randomUUID()}`,
          kind: "director",
          name: `导演台 ${canvasNodesNow("director").length + 1}`,
          ...dropPosition(x, y, DIRECTOR_NODE_SIZE, DIRECTOR_NODE_SIZE),
          scene: emptyDirectorScene(),
          prompt: "",
          panoramaKey: null,
          previewUrl: null,
        } };
      case "shot_breakdown":
      case "reference":
        // 原站有、本项目后端尚未提供的节点类型：入口在菜单里已给出说明。
        throw new Error("该节点类型后端暂未接入");
    }
  };

  const updateImageNodeConfig = useCallback(
    (key: string, config: ImageNodeConfig) => {
      patchNode("gen", key, (node) => (node.kind === "image" ? { ...node, config } : node));
    },
    [patchNode],
  );

  /** 音频节点配置（模型 / 语种 / 采样率 / 输出格式 / 三档滑杆）。 */
  const updateAudioNodeConfig = useCallback(
    (key: string, config: AudioNodeConfig) => {
      patchNode("gen", key, (node) => (node.kind === "audio" ? { ...node, config } : node));
    },
    [patchNode],
  );

  /** 智能剪辑节点配置（模式 / 参数 / 输出名）。 */
  const updateVideoClipConfig = useCallback(
    (key: string, config: Partial<VideoClipNodeConfig>) => {
      patchNode("videoClip", key, (node) => ({ ...node, config: { ...node.config, ...config } }));
    },
    [patchNode],
  );

  const clipModelsFor = useCallback((config: VideoClipNodeConfig): ClipAgentModels => ({
    text: config.agentModels?.text ?? nodeModelSelections.prompt,
    video: config.agentModels?.video ?? nodeModelSelections.video,
    speech: config.agentModels?.speech ?? nodeModelSelections.audio,
  }), [nodeModelSelections]);

  /** 切换剪辑模式；模式变了，参数保持原站默认组合（比例 / 时长 / 清晰度不随模式变）。 */
  const changeVideoClipMode = useCallback(
    (key: string, modeKey: VideoClipModeKey) => {
      if (clipSubmissionsRef.current.has(key) || clipRemoteBusyRef.current.has(key) || clipJobsRef.current.some(job => job.sourceNodeId === key && clipJobActive(job))) return;
      updateVideoClipConfig(key, { modeKey });
    },
    [updateVideoClipConfig],
  );

  /** 改参数：比例 / 时长 / 清晰度。 */
  const changeVideoClipParams = useCallback(
    (key: string, params: VideoClipParams) => {
      if (clipSubmissionsRef.current.has(key) || clipRemoteBusyRef.current.has(key) || clipJobsRef.current.some(job => job.sourceNodeId === key && clipJobActive(job))) return;
      updateVideoClipConfig(key, {
        aspectRatio: params.aspectRatio,
        durationSeconds: params.durationSeconds,
        resolution: params.resolution,
      });
    },
    [updateVideoClipConfig],
  );

  /**
   * 点「尝试：」里的某个预设：切到该模式并把原站的预置提示词写进提示词模块。
   *
   * 原站预置素材是它自家的资源地址，这里不引入外链素材——模式与提示词先落位，
   * 素材由用户自己连进来（这也是原站空态提示的用意）。
   *
   * 同时把节点**单选**出来，让编辑层展开：编辑层是「选中即展开」，而「尝试」按钮
   * 为了不触发拖拽会吃掉冒泡，不显式选中就会写完配置却什么都看不到（面板不出现）。
   * 这里必须连框选/多选一起清掉——编辑层的展开条件是「未框选且恰好选中一个」，
   * 只 selectNode 的话，多选残留会让面板照样不出现。
   */
  const applyVideoClipPreset = useCallback(
    (key: string, modeKey: string) => {
      if (clipSubmissionsRef.current.has(key) || clipRemoteBusyRef.current.has(key) || clipJobsRef.current.some(job => job.sourceNodeId === key && clipJobActive(job))) return;
      const mode = videoClipMode(modeKey);
      updateVideoClipConfig(key, { modeKey: mode.modeKey });
      if (mode.preset?.prompt) {
        promptContents.replaceText(key, mode.preset.prompt, []);
        scheduleCanvasSaveRef.current();
      }
      setNodeMarquee(false);
      setMarqueeNodeKeys(new Set());
      selectNode(key);
    },
    [promptContents, updateVideoClipConfig, selectNode],
  );

  const closeNodeEditor = useCallback(() => {
    const nodeKey =
      document.activeElement?.closest<HTMLElement>(".video-node-editor")?.dataset["nodeKey"];
    const button = [
      ...(canvasViewportRef.current?.querySelectorAll<HTMLElement>("[data-open-node-editor]") ??
        []),
    ].find((element) => element.dataset["openNodeEditor"] === nodeKey);
    button?.focus({ preventScroll: true });
    setTextEditorKey(null);
    selectNode(null);
  }, [selectNode]);

  /** 打开本地剪辑时间轴，剪辑决策按节点持久化。 */
  const handleOpenVideoClipEditor = useCallback((key: string) => {
    closeNodeEditor();
    setClipTimeline({ key, autoStart: false });
  }, [closeNodeEditor]);

  const submitClipRender = useCallback(async (key: string, body: Omit<StartClipRender, "requestId">) => {
    const node = canvasStore.getState().nodesById[key];
    if (node?.type !== "videoClip") throw new Error("剪辑节点已不存在。");
    const fingerprint = JSON.stringify({ ...body, planner: body.planner ? { ...body.planner, clientTaskId: "" } : null });
    const previous = node.data.config.agentSubmission;
    if (previous && previous.fingerprint !== fingerprint) throw new Error("上次请求的回执尚待核对。请重新读取原任务，或先还原原请求内容再提交。");
    const requestId = previous?.id ?? crypto.randomUUID();
    updateVideoClipConfig(key, { agentSubmission: { id: requestId, fingerprint } });
    scheduleCanvasSaveRef.current();
    const command: StartClipRender = { ...body, requestId, planner: body.planner ? { ...body.planner, clientTaskId: requestId } : null };
    let accepted: ClipRenderJob;
    try { accepted = await clipRenderClient.start(command); }
    catch (error) {
      if (error != null && typeof error === "object" && "kind" in error && error.kind === "validation") updateVideoClipConfig(key, { agentSubmission: null });
      await clipRenderJobs.refetch();
      throw error;
    }
    if (canvasStore.getState().nodesById[key]?.type !== "videoClip") { await clipRenderClient.cancel(accepted.id); return; }
    const result = await clipRenderJobs.refetch();
    if (result.error) throw new Error(`Agent已受理，但读取进度失败：${backendErrorMessage(result.error)}。请重新读取原任务记录。`);
  }, [canvasStore, updateVideoClipConfig, clipRenderJobs.refetch]);

  /**
   * 发起智能剪辑合成。
   *
   * 照抄原站的提交链路：提示词 + 素材 + 模式参数 → 后端合成请求 → 生成任务，
   * 成片作为一条视频产物落在节点右侧。合成进行中不允许重复发起（原站同款：
   * 「智能剪辑进行中，完成后可再次发起」）。
   */
  const startVideoClip = useCallback(
    async (nodeKey: string) => {
      const node = canvasNodesNow("videoClip").find((item) => item.key === nodeKey);
      if (!node) return;
      if (clipSubmissionsRef.current.has(nodeKey) || clipRemoteBusyRef.current.has(nodeKey) || clipJobsRef.current.some(job => job.sourceNodeId === nodeKey && clipJobActive(job))) {
        setNodeStartError(nodeKey, "智能剪辑进行中，完成后可再次发起。");
        return;
      }
      const mode = videoClipMode(node.config.modeKey);
      const prepared = promptContents.preparePlainText(nodeKey);
      const prompt = prepared?.ok === true ? prepared.text.trim() : "";
      if (mode.promptRequired && !prompt) {
        setNodeStartError(nodeKey, "请填写提示词");
        return;
      }
      const inputs = videoClipInputsFor(canvasReadModelOfState(canvasStore.getState()), nodeKey);
      const slots = assignVideoClipSlots(mode, inputs);
      const issue = videoClipSlotIssue(mode, slots);
      if (issue) {
        setNodeStartError(nodeKey, issue);
        return;
      }
      // 有素材没被当前模式采用（多为切换模式后残留，或超过槽位上限）：
      // 它们不会进合成载荷，必须明确告知用户，不能静默丢弃。
      const unused = videoClipUnusedMaterials(mode, inputs, slots);
      if (unused.overflow.length > 0) {
        const detail = unused.overflow
          .map((entry) => `${entry.label}最多 ${entry.max} 个（还有 ${entry.count} 个素材未使用）`)
          .join("；");
        setNodeStartError(nodeKey, `${detail}，请解绑多余的素材或换用其它素材。`);
        return;
      }
      if (unused.unmatched.length > 0) {
        setNodeStartError(
          nodeKey,
          `当前模式下有 ${unused.unmatched.length} 个素材不参与合成（节点类型与槽位不匹配），请解绑它们或切换到匹配的模式。`,
        );
        return;
      }
      if (mode.modeKey === "default" || mode.modeKey === "smartMixCut") {
        setNodeStartError(nodeKey, null);
        closeNodeEditor();
        setClipTimeline({ key: nodeKey, autoStart: true });
        return;
      }
      const models = clipModelsFor(node.config);
      closeNodeEditor();
      setClipTimeline({ key: nodeKey, autoStart: false });
      const selection = resolveGenerationSelection(
        "video",
        models.video,
        providerCatalog,
      );
      if (!selection) {
        setNodeStartError(
          nodeKey,
          "请在剪辑编辑器的 Agent 模型中选择可用的画面模型。",
        );
        return;
      }
      const textSelection = models.text;
      if (!providerCatalog.some(entry => entry.provider.enabled && entry.provider.id === textSelection.providerId && entry.models.some(model => model.definitionId === textSelection.modelDefinitionId && model.operations.includes("text_generation")))) {
        setNodeStartError(nodeKey, "请在 Agent 模型中选择可用的规划模型。"); return;
      }
      const needsVoice = mode.modeKey === "explainerVideo" || mode.modeKey === "talkingHeadVideo";
      if (needsVoice && !resolveGenerationSelection("audio", models.speech, providerCatalog)) {
        setNodeStartError(nodeKey, "请在 Agent 模型中选择可用的语音模型，再生成讲解或口播视频。"); return;
      }
      const materials = mode.materialSlots.flatMap((slot) => {
        const filled = slots.find((entry) => entry.slotKey === slot.slotKey)?.items ?? [];
        return filled.map((item) => ({
          slotKey: slot.slotKey,
          nodeType: item.nodeType,
          displayName: item.name,
          role: slot.role ?? "",
          text: item.nodeType === "text" ? (item.text ?? "") : null,
          target: item.target ?? null,
        }));
      });
      setNodeStartError(nodeKey, null);
      clipSubmissionsRef.current.add(nodeKey);
      setStartingVideoClipKeys((current) => new Set(current).add(nodeKey));
      try {
        await submitClipRender(nodeKey, {
          canvasId, sourceNodeId: nodeKey, name: node.config.outputName, params: resolveVideoClipParams(node.config), clips: [],
          planner: { clientTaskId: "", canvasId, sourceNodeId: nodeKey, operation: "text_generation", providerConnectionId: textSelection.providerId,
            modelDefinitionId: textSelection.modelDefinitionId, prompt: [{ kind: "text", text: prompt }], explicitMedia: [], parameters: {}, generationCount: 1 },
          agent: { mode: VIDEO_CLIP_BACKEND_MODES[mode.modeKey] as VideoClipMode, materials,
            video: { providerId: models.video.providerId, modelId: models.video.modelDefinitionId },
            speech: needsVoice ? { providerId: models.speech.providerId, modelId: models.speech.modelDefinitionId } : null },
        });
        setClipTimeline({ key: nodeKey, autoStart: false });
        toast.success("创作Agent已开始，可在剪辑编辑器查看每一步与成片。");
      } catch (error) {
        setNodeStartError(nodeKey, backendErrorMessage(error));
      } finally {
        clipSubmissionsRef.current.delete(nodeKey);
        setStartingVideoClipKeys((current) => {
          const next = new Set(current);
          next.delete(nodeKey);
          return next;
        });
      }
    },
    [
      canvasId,
      canvasNodesNow,
      canvasStore,
      clipModelsFor,
      closeNodeEditor,
      promptContents,
      providerCatalog,
      setNodeStartError,
      submitClipRender,
    ],
  );

  const saveClipTimeline = useCallback((key: string, clips: readonly ClipEdit[], settings?: ClipTimelineSettings) => {
    updateVideoClipConfig(key, { timeline: clips, ...(settings ? { timelineSettings: settings } : {}) });
    scheduleCanvasSaveRef.current();
  }, [updateVideoClipConfig]);

  const renderClipTimeline = useCallback(async (clips: readonly ClipEdit[], intelligent: boolean, settings: ClipTimelineSettings, instructions: string) => {
    const key = clipTimeline?.key;
    if (!key || clipSubmissionsRef.current.has(key)) return;
    const entry = canvasStore.getState().nodesById[key];
    if (entry?.type !== "videoClip") throw new Error("剪辑节点已不存在，请重新打开。 ");
    if (clipJobsRef.current.some(job => job.sourceNodeId === key && clipJobActive(job))) throw new Error("智能剪辑进行中，请等待完成。");
    const prepared = promptContents.preparePlainText(key);
    if (intelligent && !instructions.trim() && (!prepared?.ok || !prepared.text.trim())) throw new Error("请填写本次改剪要求，或先在节点里填写剪辑提示词。");
    const models = clipModelsFor(entry.data.config);
    const selection = intelligent && providerCatalog.some(entry => entry.provider.enabled && entry.provider.id === models.text.providerId && entry.models.some(model => model.definitionId === models.text.modelDefinitionId && model.operations.includes("text_generation")));
    if (intelligent && !selection) throw new Error("请在 Agent 模型中选择可用的规划模型；手动导出可直接使用。");
    clipSubmissionsRef.current.add(key);
    setStartingVideoClipKeys(current => new Set(current).add(key));
    try {
      const planner = intelligent ? {
        clientTaskId: "", canvasId, sourceNodeId: key, operation: "text_generation" as const,
        providerConnectionId: models.text.providerId, modelDefinitionId: models.text.modelDefinitionId,
        prompt: [{ kind: "text" as const, text: [prepared?.ok ? prepared.text : "", instructions.trim() ? `本次改剪要求：${instructions.trim()}` : ""].filter(Boolean).join("\n") }], explicitMedia: [], parameters: {}, generationCount: 1,
      } : null;
      const targets = clips.filter((clip, index) => !clips.slice(0, index).some(previous => previous.target.kind === "url"
        ? clip.target.kind === "url" && previous.target.url === clip.target.url && previous.target.mediaType === clip.target.mediaType && previous.target.canvasNodeKey === clip.target.canvasNodeKey
        : sameMediaReferenceTarget(previous.target, clip.target)));
      const mix = entry.data.config.modeKey === "smartMixCut" && targets.length >= 5;
      await submitClipRender(key, { canvasId, sourceNodeId: key, name: entry.data.config.outputName, params: resolveVideoClipParams(entry.data.config), clips, planner, settings,
        agent: intelligent ? { mode: mix ? "smart_mix_cut" : "default", video: null, speech: null,
          materials: targets.map(clip => ({ slotKey: mix ? "generatedVideo" : "video", nodeType: "video", displayName: clip.name, role: "reference_video", text: null, target: clip.target })) } : null });
    } finally {
      clipSubmissionsRef.current.delete(key);
      setStartingVideoClipKeys(current => { const next = new Set(current); next.delete(key); return next; });
    }
  }, [clipTimeline?.key, canvasStore, promptContents, clipModelsFor, providerCatalog, canvasId, submitClipRender]);

  const updatePromptNodeConfig = useCallback(
    (key: string, config: PromptNodeConfig) => {
      // 程序化替换会同步派发 input；由发起者把 canonical 与节点镜像同批写入。
      if (programmaticPromptWriteRef.current.has(key)) return;
      /*
       * 提示词**打字**要合并历史；**离散设置**（换模型 / 换模式 / 换任务）不要。
       *
       * 每击一键就往撤销栈里塞一条记录：200 字就把栈填满，真正的操作（成组、粘贴）
       * 会被打字挤出撤销栈，Ctrl+Z 一次也只退一个字符。store 里已有
       * runWithCoalescedHistory（500ms 窗口，包裹期写入保留最早的变更前快照、收口时
       * 补一条记录），打字走它——用户预期是「一次撤销退一段」，不是「退一个字」。
       *
       * 但包裹期写入**不再算用户命令**（`lastWriteWasUserCommand()` 为 false），
       * 于是落盘从「每击键立即写库」变成 1 秒防抖。这对打字是对的（本来就该防抖），
       * 对**离散设置**却是回退：换完模型立刻关窗/崩溃，这次设置就丢了
       * （而图片/视频节点改同样的设置仍然是立即落盘，行为不一致）。
       *
       * 所以这里按「离散设置是否变化」分流：变了就走普通 patchNode（立即落盘、
       * 一步撤销），只有纯内容变化才进合并窗口。
       */
      const previousNode = canvasNodesNow("gen").find((node) => node.key === key);
      const previous = previousNode?.kind === "prompt" ? previousNode.config : undefined;
      const discreteChanged =
        previous == null ||
        previous.modelSelection.providerId !== config.modelSelection.providerId ||
        previous.modelSelection.modelDefinitionId !== config.modelSelection.modelDefinitionId ||
        previous.task !== config.task ||
        previous.mode !== config.mode;
      /*
       * 提示词 canonical 快照与节点写入**同批**落下。
       *
       * 撤销栈只存 `config.generatedPrompt` 这份纯文本镜像（canonical 不在历史里），
       * 所以撤销只能靠纯文本回灌 canonical —— **有损**：附件与 @引用会丢，块结构与
       * 行内 marks 也会被压平。把 canonical 快照放进 store 的 `promptDocuments`
       * 字段后，zundo 的历史里就带着「上一步的完整 canonical」，撤销可以精确还原。
       *
       * 必须**同一次 set**：zundo 记录的是 set 之前的完整 state，分两次写的话，
       * 第一次写完历史里就已经是新快照，撤销恢复回来的是当前内容 —— 等于没撤销。
       */
      const promptDocuments = promptContents.snapshotAll();
      if (discreteChanged) {
        patchNode(
          "gen",
          key,
          (node) => (node.kind === "prompt" ? { ...node, config } : node),
          promptDocuments,
        );
        return;
      }
      runWithCoalescedHistory(() => {
        patchNode(
          "gen",
          key,
          (node) => (node.kind === "prompt" ? { ...node, config } : node),
          promptDocuments,
        );
      });
    },
    [canvasNodesNow, patchNode, promptContents, runWithCoalescedHistory],
  );

  /**
   * 提示词节点的**按字段**写入：只改传入的字段，其余字段按当前值保留。
   *
   * 画布上的悬浮生成器面板与节点内的输入框是同一个「创意 / 需求」的两个入口。
   * 若面板拿渲染时的配置快照回写，模型生成完成与用户打字撞在一起时，
   * 刚生成的正文会被旧快照覆盖掉 —— 所以这里按当前值合并。
   */
  const patchPromptNodeConfigField = useCallback(
    (key: string, patch: Partial<PromptNodeConfig>) => {
      const previousNode = canvasNodesNow("gen").find((node) => node.key === key);
      const previous = previousNode?.kind === "prompt" ? previousNode.config : undefined;
      if (previous == null) return;
      updatePromptNodeConfig(key, { ...previous, ...patch });
    },
    [canvasNodesNow, updatePromptNodeConfig],
  );

  const updateScreenplayNodeConfig = useCallback(
    (key: string, config: ScreenplayNodeConfig) => {
      patchNode("screenplay", key, (node) => ({ ...node, config }));
    },
    [patchNode],
  );

  /** 按当前配置更新，避免面板和编辑器的旧快照覆盖彼此的修改。 */
  const updateScreenplayNode = useCallback(
    (key: string, update: (config: ScreenplayNodeConfig) => ScreenplayNodeConfig) => {
      patchNode("screenplay", key, (node) => ({ ...node, config: update(node.config) }));
    },
    [patchNode],
  );

  const handlePickScreenplayMaterials = useCallback(
    async (nodeKey: string) => {
      try {
        const picked = await pickPromptMultimodalFiles();
        if (!picked.length) return;
        let addedCount = 0;
        let rejectedCount = 0;
        patchNode("screenplay", nodeKey, (node) => {
          const existing = node.config.materials ?? [];
          const existingPaths = new Set(
            existing.map((material) => material.localPath.toLocaleLowerCase()),
          );
          const additions = [] as NonNullable<ScreenplayNodeConfig["materials"]>[number][];
          for (const material of picked) {
            const normalizedPath = material.localPath.toLocaleLowerCase();
            if (
              existingPaths.has(normalizedPath) ||
              !Number.isFinite(material.byteSize) ||
              material.byteSize <= 0
            ) {
              rejectedCount += 1;
              continue;
            }
            existingPaths.add(normalizedPath);
            additions.push({ ...material, id: screenplayMaterialId() });
          }
          addedCount = additions.length;
          if (!additions.length) return node;
          return {
            ...node,
            config: { ...node.config, materials: [...existing, ...additions] },
          };
        });
        if (addedCount) {
          setNodeStartError(nodeKey, null);
          toast.success(`已添加 ${addedCount} 项参考素材`);
        }
        if (rejectedCount) {
          toast.info(`${rejectedCount} 项素材未添加`, {
            description: "文件已存在、为空或大小信息无效。",
          });
        }
      } catch (error) {
        const message = backendErrorMessage(error);
        setNodeStartError(nodeKey, message);
        toast.error("读取参考素材失败", { description: message });
      }
    },
    [patchNode, setNodeStartError],
  );

  const handleRemoveScreenplayMaterial = useCallback(
    (nodeKey: string, materialId: string) => {
      patchNode("screenplay", nodeKey, (node) => ({
        ...node,
        config: {
          ...node.config,
          materials: (node.config.materials ?? []).filter((material) => material.id !== materialId),
        },
      }));
    },
    [patchNode],
  );

  const updateVideoNodeConfig = useCallback(
    (key: string, config: VideoNodeConfig) => {
      patchNode("gen", key, (node) => (node.kind === "video" ? { ...node, config } : node));
    },
    [patchNode],
  );

  /** 图片沿用视觉输入协议；视频和音频保留引用身份交由后端读取。 */
  const promptVisionImages = useCallback(
    (nodeKey: string): readonly PromptVisionImageInput[] =>
      canvasInputsFor(nodeKey)
        .media.filter((input) => input.kind === "image")
        .map((input) => ({ target: input.target, displayName: input.name })),
    [canvasInputsFor],
  );
  const promptVideoMaterials = useCallback(
    (nodeKey: string) =>
      canvasInputsFor(nodeKey)
        .media.filter((input) => input.kind !== "image")
        .map((input) => ({ target: input.target, displayName: input.name })),
    [canvasInputsFor],
  );

  /** 提示词节点调用已配置的文本模型，返回结果写入节点输出并由连线自动下发。 */
  const handleRunPromptNode = useCallback(
    (nodeKey: string, generalText = false) => {
      if (startingNodeKeys.has(nodeKey) || promptSubmissionGuardRef.current.has(nodeKey)) return;
      const node = canvasNodesNow("gen").find(
        (item): item is Extract<GenNodeData, { kind: "prompt" }> =>
          item.key === nodeKey && item.kind === "prompt",
      );
      if (!node) return;
      const failWith = (message: string) => setNodeStartError(nodeKey, message);
      if (!isDesktopRuntime()) {
        failWith("提示词模型只能在桌面应用中调用。请通过 Tauri 桌面端运行。");
        return;
      }
      const visionImages = promptVisionImages(nodeKey);
      const videoMaterials = promptVideoMaterials(nodeKey);
      const isFpvPath = !generalText && node.config.mode === "fpv_path";
      const isFightPromptMaster = !generalText && node.config.mode === "fight_prompt_master";
      const isCinematicDialogue = !generalText && node.config.mode === "cinematic_dialogue";
      const dialogueGuard: CinematicDialogueGuard = node.config.cinematicDialogueGuard ?? {
        lockedLines: "",
        targetDurationSeconds: null,
        targetFormat: "generic",
      };
      const defaultFpvPrompt =
        isFpvPath && node.config.task === "generate" && visionImages.length > 0
          ? "请根据已连接参考图中的路径标记，生成完整的 FPV 飞行提示词方案。"
          : isFpvPath && node.config.task === "optimize" && node.config.generatedPrompt.trim()
            ? "请优化当前输出中的 FPV 飞行提示词方案，保留路径顺序与关键途经点。"
            : "";
      const defaultFightPrompt =
        isFightPromptMaster &&
        node.config.task === "generate" &&
        (visionImages.length > 0 || videoMaterials.length > 0)
          ? "请根据已连接的参考素材设计打斗提示词；先检查目标视频模型、时长和速度档，缺失时按技能规则补问。"
          : isFightPromptMaster &&
              node.config.task === "optimize" &&
              node.config.generatedPrompt.trim()
            ? "请继续优化当前输出中的打斗提示词，保留已确认的角色、动作逻辑与用户要求。"
            : "";
      const defaultCinematicDialoguePrompt =
        isCinematicDialogue &&
        node.config.task === "generate" &&
        (visionImages.length > 0 ||
          videoMaterials.length > 0 ||
          canvasInputsFor(nodeKey).texts.length > 0 ||
          dialogueGuard.lockedLines.trim().length > 0)
          ? "请依据节点锁定原台词、已连接的剧本文字与实际可见参考素材设计对白表演提示词；若未锁定台词的改编权限、目标视频模型或时长尚未明确，请合并询问。"
          : isCinematicDialogue &&
              node.config.task === "optimize" &&
              node.config.generatedPrompt.trim()
            ? "请基于当前可编辑输出优化对白表演提示词，保留已确认的台词、角色关系、目标模型和时长。"
            : "";
      const sourcePrompt =
        node.config.sourcePrompt.trim() ||
        defaultFpvPrompt ||
        defaultFightPrompt ||
        defaultCinematicDialoguePrompt ||
        (canvasInputsFor(nodeKey).texts.length || canvasInputsFor(nodeKey).media.length
          ? "请依据已连接的文本和参考素材生成或优化提示词。"
          : "");
      if (!sourcePrompt) {
        failWith(
          node.config.task === "generate"
            ? isFpvPath
              ? "请连接带路径标记的参考图，或填写飞行路径描述。"
              : isFightPromptMaster
                ? "请连接参考图片或已保存的视频产物，或填写打斗创意与需求。"
                : isCinematicDialogue
                  ? "请填写对白创意、锁定原台词，或连接剧本文字、参考素材。"
                  : "请输入创意或需求，再生成提示词。"
            : "请输入需要优化的提示词。",
        );
        return;
      }
      const provider = providerCatalog.find(
        (entry) =>
          entry.provider.enabled && entry.provider.id === node.config.modelSelection.providerId,
      );
      const model = provider?.models.find(
        (item) =>
          item.definitionId === node.config.modelSelection.modelDefinitionId &&
          isTextGenerationModel(item),
      );
      if (!provider || !model) {
        failWith("请先在当前提示词节点中选择可用的文本模型。");
        return;
      }
      const outputBeforeRequest = JSON.stringify(
        promptContents.read(nodeKey)?.document ?? { schema: "prompt-content", version: 1, items: [] },
      );
      // 多轮对话：把全部已完成轮次逐条注入系统上下文，本轮输入作为新的用户消息。
      const conversation = node.config.conversation ?? [];
      const contextHistory: PromptOptimizationContextEntry[] = conversation.map((entry, index) => ({
        role:
          (generalText || isCinematicDialogue) && (entry.role === "user" || entry.role === "assistant")
            ? entry.role
            : `第 ${index + 1} 条 · ${promptConversationRoleLabel(entry.role)}`,
        content: entry.content,
      }));
      contextHistory.push(
        ...canvasInputsFor(nodeKey).texts.map((input) => ({
          role: `已连接的上游文本 · ${input.name}`,
          content: input.text,
        })),
      );
      if (
        (isFpvPath || isFightPromptMaster || isCinematicDialogue) &&
        node.config.generatedPrompt.trim()
      ) {
        contextHistory.push({ role: "当前输出提示词", content: node.config.generatedPrompt });
      }
      if (isCinematicDialogue) {
        contextHistory.push({
          role: "用户在节点确认的对白校验基准（优先于模型自述）",
          content: JSON.stringify(dialogueGuard),
        });
        const availableVideoModelIds = [
          ...new Set(
            providerCatalog
              .filter((entry) => entry.provider.enabled)
              .flatMap((entry) =>
                entry.models
                  .filter((item) => item.operations.includes("video_generation"))
                  .map((item) => item.remoteModelId),
              ),
          ),
        ];
        contextHistory.push({
          role: "项目当前启用的视频模型候选",
          content: availableVideoModelIds.length
            ? availableVideoModelIds.join("、")
            : "当前没有已启用的视频模型；只能讨论草案，不得声称可直接提交生成。",
        });
        const targetModelIds = new Set(
          canvasReadModelOfState(canvasStore.getState())
            .graph.edges.filter((edge) => edge.fromKey === nodeKey)
            .map((edge) => canvasNodesNow("gen").find((item) => item.key === edge.toKey))
            .filter((item) => item?.kind === "video")
            .map((item) =>
              item?.kind === "video"
                ? resolveGenerationSelection("video", item.config.modelSelection, providerCatalog)
                    ?.model.remoteModelId
                : undefined,
            )
            .filter((id): id is string => Boolean(id)),
        );
        if (targetModelIds.size === 1) {
          contextHistory.push({
            role: "当前已连接的下游视频模型",
            content: [...targetModelIds][0]!,
          });
        }
      }
      setNodeStartError(nodeKey, null);
      promptSubmissionGuardRef.current.add(nodeKey);
      setStartingNodeKeys((current) => new Set(current).add(nodeKey));
      frontendLog(
        "info",
        `[generation] 发起提示词节点请求: node=${nodeKey}, task=${node.config.task}, mode=${node.config.mode}, model=${model.remoteModelId}, 历史 ${contextHistory.length} 条, 本轮 ${sourcePrompt.length} 字符, 视觉素材 ${visionImages.length} 张, 视频素材 ${videoMaterials.length} 个`,
      );
      void promptNodeClient
        .run({
          canvasId: canvasId,
          sourceNodeId: nodeKey,
          providerConnectionId: provider.provider.id,
          modelDefinitionId: model.definitionId,
          mode: resolvePromptOptimizationMode(node.config.mode),
          generalText,
          task: node.config.task,
          userPrompt: sourcePrompt,
          contextHistory,
          visionImages,
          referenceInputs: videoMaterials,
        })
        .then((result) => {
          if (!result) return;
          const dialogueResponse = isCinematicDialogue
            ? parseCinematicDialogueResponse(result.optimizedPrompt, dialogueGuard)
            : null;
          const outputPrompt = dialogueResponse
            ? dialogueResponse.downstreamPrompt
            : generalText ? result.optimizedPrompt.trim() : cleanGeneratedPrompt(result.optimizedPrompt);
          const assistantText = dialogueResponse?.displayText ?? outputPrompt ?? "";
          const currentNode = canvasNodesNow("gen").find((item) => item.key === nodeKey);
          if (currentNode?.kind !== "prompt") {
            toast.info("文本生成已完成", { description: "原节点已移除，结果可在任务历史中查看。" });
            return;
          }
          const currentOutput = JSON.stringify(
            promptContents.read(nodeKey)?.document ?? { schema: "prompt-content", version: 1, items: [] },
          );
          if (currentOutput !== outputBeforeRequest) {
            patchNode("gen", nodeKey, (item) => item.kind === "prompt"
              ? {
                  ...item,
                  config: {
                    ...item.config,
                    conversation: [
                      ...(item.config.conversation ?? []),
                      { id: promptMessageId(), role: "user", content: sourcePrompt },
                      { id: promptMessageId(), role: "assistant", content: assistantText },
                    ],
                  },
                }
              : item);
            toast.info("文本生成已完成，已保留你修改的正文", {
              description: "生成结果已加入对话，也可在任务历史中查看。",
              duration: 10000,
              action: {
                label: "复制结果",
                onClick: () => {
                  void copyTextToDesktopClipboard(assistantText).then(
                    () => toast.success("结果已复制"),
                    (error: unknown) => toast.error("复制结果失败", { description: backendErrorMessage(error) }),
                  );
                },
              },
            });
            return;
          }
          // 整篇结果先写入 canonical 文档，再与镜像同批存入画布；编辑区未挂载时
          // 也不能只保存空文档，否则重开会丢失 @ 素材身份。没有新输出时保留原文。
          if (outputPrompt != null) {
            replaceGeneratedPrompt(
              nodeKey,
              outputPrompt,
              canvasInputsFor(nodeKey).media.map(generationInputMentionCandidate),
            );
          }
          const promptDocuments = promptContents.snapshotAll();
          patchNode(
            "gen",
            nodeKey,
            (item) =>
              item.kind === "prompt"
                ? {
                    ...item,
                    config: {
                      ...item.config,
                      generatedPrompt: outputPrompt ?? item.config.generatedPrompt,
                      cinematicDialogueValidated:
                        dialogueResponse?.status === "ready"
                          ? true
                          : isCinematicDialogue
                            ? (item.config.cinematicDialogueValidated ?? false)
                            : false,
                      conversation: [
                        ...(item.config.conversation ?? []),
                        { id: promptMessageId(), role: "user", content: sourcePrompt },
                        { id: promptMessageId(), role: "assistant", content: assistantText },
                      ],
                    },
                  }
                : item,
            promptDocuments,
          );
          frontendLog(
            "info",
            `[generation] 提示词节点请求完成: node=${nodeKey}, 返回 ${result.optimizedPrompt.length} 字符，写入 ${outputPrompt?.length ?? 0} 字符`,
          );
          toast.success(
            dialogueResponse?.status === "needs_input" ? "请补充对白要求" : "提示词已生成",
          );
        })
        .catch((error: unknown) => {
          const message =
            isCinematicDialogue && error instanceof Error
              ? error.message
              : backendErrorMessage(error);
          setNodeStartError(nodeKey, message);
          toast.error("提示词生成失败", { description: message });
          frontendLog("error", `[generation] 提示词节点请求失败: node=${nodeKey}, ${message}`);
        })
        .finally(() => {
          // 完整结果已写入节点（或已失败），流式草稿不再需要。
          clearStreamingText(nodeKey);
          promptSubmissionGuardRef.current.delete(nodeKey);
          setStartingNodeKeys((current) => {
            const next = new Set(current);
            next.delete(nodeKey);
            return next;
          });
        });
    },
    [
      canvasId,
      canvasNodesNow,
      promptVideoMaterials,
      promptVisionImages,
      promptContents,
      replaceGeneratedPrompt,
      providerCatalog,
      canvasInputsFor,
      setNodeStartError,
      startingNodeKeys,
      patchNode,
      clearStreamingText,
      canvasStore,
    ],
  );

  /** 剧本对话：双技能全文由后端每轮重新载入，节点内全部历史逐条注入系统上下文。 */
  const handleRunScreenplayNode = useCallback(
    (nodeKey: string) => {
      if (startingNodeKeys.has(nodeKey) || promptSubmissionGuardRef.current.has(nodeKey)) return;
      const node = canvasNodesNow("screenplay").find((item) => item.key === nodeKey);
      if (!node) return;
      const script = node.config.scriptGenerator;
      const failWith = (message: string) => setNodeStartError(nodeKey, message);
      if (!isDesktopRuntime()) {
        failWith("剧本模型只能在桌面应用中调用。请通过 Tauri 桌面端运行。");
        return;
      }
      const materials = node.config.materials ?? [];
      const userPrompt = node.config.composer.trim() ||
        (script ? "请依据已连接的文本和参考素材制作分镜脚本。" : "请分析附带的参考素材，并据此创作或优化剧本。");
      const connected = canvasInputsFor(nodeKey);
      if (
        !node.config.composer.trim() &&
        !materials.length &&
        !connected.media.length &&
        !connected.texts.length
      ) {
        failWith("请输入本轮剧本创作或修改要求。");
        return;
      }
      const provider = providerCatalog.find(
        (entry) =>
          entry.provider.enabled && entry.provider.id === node.config.modelSelection.providerId,
      );
      const model = provider?.models.find(
        (item) =>
          item.definitionId === node.config.modelSelection.modelDefinitionId &&
          isTextGenerationModel(item),
      );
      if (!provider || !model) {
        failWith("请先在当前剧本节点中选择可用的文本模型。");
        return;
      }
      const contextHistory: PromptOptimizationContextEntry[] = script ? [] : node.config.conversation.map(
        (entry, index) => ({
          role: `第 ${index + 1} 条 · ${documentSkillRoleLabel(entry.role, "screenplay")}`,
          content: entry.content,
        }),
      );
      if (!script && node.config.currentDocument.trim()) {
        contextHistory.push({
          role: "当前剧本文档",
          content: node.config.currentDocument,
        });
      }
      contextHistory.push(
        ...connected.texts.map((input) => ({
          role: `已连接的上游文本 · ${input.name}`,
          content: input.text,
        })),
      );
      const boundAssets = script?.assets.filter(asset => asset.reference) ?? [];
      if (boundAssets.length) {
        contextHistory.push({
          role: "用户已绑定的参考资产",
          content: "沿用下列资产时，将其 ref 原样填入对应资产及镜头的 assetRefs。\n" + JSON.stringify(boundAssets.map(asset => ({
            ref: asset.id, kind: asset.kind, name: asset.name, description: asset.description,
          }))),
        });
      }
      const multimodalInputs = screenplayMultimodalInputs(node.config);
      const frozenScriptConfig = script ? JSON.stringify({
        shots: script.shots, assets: script.assets,
        composer: node.config.composer, modelSelection: node.config.modelSelection,
        materials: node.config.materials ?? [],
      }) : null;
      const fingerprintInputs = (inputs: typeof connected) => JSON.stringify({
        texts: inputs.texts.map((input) => ({ key: input.key, text: input.text })),
        media: inputs.media.map((input) => ({ key: input.key, target: input.target })),
      });
      const frozenInputs = script ? fingerprintInputs(connected) : null;
      setNodeStartError(nodeKey, null);
      promptSubmissionGuardRef.current.add(nodeKey);
      setStartingNodeKeys((current) => new Set(current).add(nodeKey));
      frontendLog(
        "info",
        `[generation] 发起剧本多轮对话: node=${nodeKey}, model=${model.remoteModelId}, 历史 ${contextHistory.length} 条, 本轮 ${userPrompt.length} 字符, 多模态素材 ${multimodalInputs.length} 项`,
      );
      void promptNodeClient
        .run({
          canvasId: canvasId,
          sourceNodeId: nodeKey,
          providerConnectionId: provider.provider.id,
          modelDefinitionId: model.definitionId,
          mode: "screenplay",
          scriptGenerator: Boolean(script),
          task: "generate",
          userPrompt,
          contextHistory,
          multimodalInputs,
          referenceInputs: connected.media.map((input) => ({
            target: input.target,
            displayName: input.name,
          })),
        })
        .then((result) => {
          if (script) {
            const parsed = parseScriptGeneration(result.optimizedPrompt, boundAssets);
            let applied = false;
            patchNode("screenplay", nodeKey, (item) => {
              const current = item.config.scriptGenerator;
              if (!current || JSON.stringify({
                shots: current.shots, assets: current.assets,
                composer: item.config.composer, modelSelection: item.config.modelSelection,
                materials: item.config.materials ?? [],
              }) !== frozenScriptConfig || fingerprintInputs(canvasInputsFor(nodeKey)) !== frozenInputs) return item;
              const next = { ...replaceScriptTable(current, parsed.shots, parsed.assets), step: "confirm-shots" as const };
              applied = true;
              return { ...item, config: { ...item.config, scriptGenerator: next, currentDocument: scriptDocument(next) } };
            });
            if (!applied) toast.info("分镜已生成，但节点内容已变化", {
              description: "已保留当前编辑内容；模型原始结果可在任务历史中查看。",
            });
            else toast.success("分镜已生成", { description: "打开脚本节点即可核对镜头、资产和提示词。" });
            return;
          }
          patchNode("screenplay", nodeKey, (item) => ({
            ...item,
            config: {
              ...item.config,
              composer: "",
              currentDocument: result.optimizedPrompt,
              conversation: [
                ...item.config.conversation,
                {
                  id: screenplayMessageId(),
                  role: "user",
                  content: screenplayConversationUserMessage(userPrompt, materials),
                },
                {
                  id: screenplayMessageId(),
                  role: "assistant",
                  content: result.optimizedPrompt,
                },
              ],
            },
          }));
          frontendLog(
            "info",
            `[generation] 剧本多轮对话完成: node=${nodeKey}, 返回 ${result.optimizedPrompt.length} 字符`,
          );
        })
        .catch((error: unknown) => {
          const message = backendErrorMessage(error);
          setNodeStartError(nodeKey, message);
          frontendLog("error", `[generation] 剧本多轮对话失败: node=${nodeKey}, ${message}`);
        })
        .finally(() => {
          // 完整结果已写入节点（或已失败），流式草稿不再需要。
          clearStreamingText(nodeKey);
          promptSubmissionGuardRef.current.delete(nodeKey);
          setStartingNodeKeys((current) => {
            const next = new Set(current);
            next.delete(nodeKey);
            return next;
          });
        });
    },
    [
      canvasId,
      patchNode,
      providerCatalog,
      canvasNodesNow,
      setNodeStartError,
      startingNodeKeys,
      canvasInputsFor,
      clearStreamingText,
    ],
  );

  /** 智能合成只更新明确选择的镜头；请求期间编辑或素材变化时保留当前内容。 */
  const handleScriptSmartCompose = useCallback((nodeKey: string, shotIds: readonly string[]) => {
    if (startingNodeKeys.has(nodeKey) || promptSubmissionGuardRef.current.has(nodeKey)) return;
    const node = canvasNodesNow("screenplay").find((item) => item.key === nodeKey);
    const script = node?.config.scriptGenerator;
    if (!node || !script) return;
    const ids = [...new Set(shotIds)];
    const selected = script.shots.filter((shot) => ids.includes(shot.id));
    if (!ids.length || selected.length !== ids.length) return;
    if (selected.some((shot) => shot.unresolvedAssetRefs?.length)) {
      setNodeStartError(nodeKey, "部分镜头的模型资产关联尚未确认，请先核对并清除提示。"); return;
    }
    if (selected.some((shot) => (shot.assetIds ?? []).some((id) => !script.assets.some((asset) => asset.id === id)))) {
      setNodeStartError(nodeKey, "部分镜头关联的资产已删除，请先清除失效关联。"); return;
    }
    if (!isDesktopRuntime()) { setNodeStartError(nodeKey, "智能合成只能在桌面应用中调用。"); return; }
    const provider = providerCatalog.find((entry) => entry.provider.enabled && entry.provider.id === node.config.modelSelection.providerId);
    const model = provider?.models.find((item) => item.definitionId === node.config.modelSelection.modelDefinitionId && isTextGenerationModel(item));
    if (!provider || !model) { setNodeStartError(nodeKey, "请先选择可用的文本模型。"); return; }
    const connected = canvasInputsFor(nodeKey);
    const fingerprint = (config: ScreenplayNodeConfig, inputs: typeof connected) => JSON.stringify({
      shots: config.scriptGenerator?.shots.filter((shot) => ids.includes(shot.id)),
      assets: config.scriptGenerator?.assets, model: config.modelSelection, materials: config.materials ?? [],
      media: inputs.media.map((input) => ({ key: input.key, target: input.target })),
    });
    const frozen = fingerprint(node.config, connected);
    promptSubmissionGuardRef.current.add(nodeKey);
    setNodeStartError(nodeKey, null);
    setStartingNodeKeys((current) => new Set(current).add(nodeKey));
    let completedChunks = 0;
    void (async () => {
      const prompts = new Map<string, { imagePrompt: string; videoPrompt: string; imageToVideoPrompt: string }>();
      for (let offset = 0; offset < selected.length; offset += 20) {
        const current = canvasNodesNow("screenplay").find((item) => item.key === nodeKey);
        if (!current?.config.scriptGenerator || fingerprint(current.config, canvasInputsFor(nodeKey)) !== frozen) {
          throw new Error("镜头或参考已变化，已停止后续合成。");
        }
        const chunk = selected.slice(offset, offset + 20);
        const assets = script.assets.filter((asset) => chunk.some((shot) => (shot.assetIds ?? []).includes(asset.id)));
        const result = await promptNodeClient.run({
          canvasId, sourceNodeId: nodeKey, providerConnectionId: provider.provider.id,
          modelDefinitionId: model.definitionId, mode: "screenplay", task: "generate", scriptPromptCompose: true,
          userPrompt: JSON.stringify({ shots: chunk, assets }), multimodalInputs: screenplayMultimodalInputs(node.config),
          referenceInputs: connected.media.map((input) => ({ target: input.target, displayName: input.name })),
        });
        completedChunks += 1;
        for (const [id, prompt] of parseScriptComposition(result.optimizedPrompt, chunk.map((shot) => shot.id))) {
          prompts.set(id, prompt);
        }
      }
      let applied = false;
      patchNode("screenplay", nodeKey, (current) => {
        const currentScript = current.config.scriptGenerator;
        if (!currentScript || fingerprint(current.config, canvasInputsFor(nodeKey)) !== frozen) return current;
        const shots = currentScript.shots.map((shot) => {
          const composed = prompts.get(shot.id);
          return composed ? { ...shot, ...composed, composedFrom: scriptSourceSignature(shot, currentScript.assets) } : shot;
        });
        const next = replaceScriptTable(currentScript, shots);
        applied = true;
        return { ...current, config: { ...current.config, scriptGenerator: next, currentDocument: scriptDocument(next) } };
      });
      if (applied) toast.success("提示词已合成", { description: "可逐镜核对，或撤回上一次替换。" });
      else toast.info("提示词已合成，但镜头或参考已变化", { description: "已保留当前内容；模型结果可在任务历史中查看。" });
    })().catch((error: unknown) => {
      const message = backendErrorMessage(error);
      setNodeStartError(nodeKey, message);
      toast.error("提示词合成未完成", { description: completedChunks
        ? `${message}；已完成的 ${completedChunks} 次结果可从本节点任务历史恢复，不会自动重发。`
        : message });
    }).finally(() => {
      clearStreamingText(nodeKey);
      promptSubmissionGuardRef.current.delete(nodeKey);
      setStartingNodeKeys((current) => { const next = new Set(current); next.delete(nodeKey); return next; });
    });
  }, [canvasId, canvasInputsFor, canvasNodesNow, clearStreamingText, patchNode, providerCatalog, setNodeStartError, startingNodeKeys]);

  const handleExportScreenplay = useCallback(
    async (nodeKey: string) => {
      const node = canvasNodesNow("screenplay").find((item) => item.key === nodeKey);
      if (!node?.config.currentDocument.trim()) return;
      const content = `${node.config.currentDocument.trimEnd()}\n`;
      const fileName = markdownDocumentExportName(content, nodeKey, "剧本");
      try {
        if (isDesktopRuntime()) {
          const filePath = await saveMarkdownDocumentToDesktop(
            content,
            fileName,
            "Markdown 剧本文档",
          );
          if (!filePath) return;
          frontendLog("info", `[canvas] 剧本 Markdown 已导出: node=${nodeKey}, path=${filePath}`);
        } else {
          const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
          const url = URL.createObjectURL(blob);
          const anchor = document.createElement("a");
          anchor.href = url;
          anchor.download = fileName;
          anchor.click();
          URL.revokeObjectURL(url);
        }
        setNodeStartError(nodeKey, null);
      } catch (error) {
        const message = `导出 Markdown 失败：${backendErrorMessage(error)}`;
        setNodeStartError(nodeKey, message);
        frontendLog("error", `[canvas] 剧本 Markdown 导出失败: node=${nodeKey}, ${message}`);
      }
    },
    [canvasNodesNow, setNodeStartError],
  );

  /** Add a new canvas projection for an asset; repeated additions always create a new instance. */
  const addAssetNode = useCallback(
    (
      asset: Pick<
        AssetItem,
        | "id"
        | "dbId"
        | "kind"
        | "name"
        | "previewUrl"
        | "assetUrl"
        | "videoUrl"
        | "source"
        | "providerConnectionId"
      >,
      rawX: number,
      rawY: number,
    ) => {
      const source = asset.source ?? "cloud";
      if (cloudAssetAwaitingId({ ...asset, source })) return null;
      const providerConnectionId = asset.providerConnectionId ?? assetProvider?.id ?? "";
      if (
        source === "cloud" &&
        asset.dbId != null &&
        hiddenCloudAssetKeys.has(JSON.stringify([providerConnectionId, asset.dbId]))
      ) {
        return null;
      }
      if (source === "cloud" && !providerConnectionId) {
        setAssetsError("拖放素材需要已启用的供应商连接。请先在全局设置中配置。");
        return null;
      }
      const { x, y } = dropPosition(rawX, rawY, ASSET_NODE_WIDTH, ASSET_NODE_HEIGHT);
      const node: AssetNodeData = {
        key: assetNodeKey(),
        assetId: asset.id,
        providerConnectionId,
        source,
        kind: asset.kind,
        name: asset.name,
        previewUrl: asset.previewUrl ?? null,
        videoUrl: asset.kind === "video" ? (asset.videoUrl ?? asset.previewUrl ?? null) : null,
        libraryPickOrder: nextLibraryPickOrder(canvasNodesNow("asset")),
        x,
        y,
      };
      addNode("asset", node);
      frontendLog(
        "info",
        `[canvas] 素材节点已创建: assetId=${node.assetId}, kind=${node.kind}, 位置=(${Math.round(x)}, ${Math.round(y)})`,
      );
      return node;
    },
    [addNode, canvasNodesNow, assetProvider?.id, dropPosition, hiddenCloudAssetKeys],
  );

  /** 连线保存节点身份；全部参数通过共享解析器在执行时读取。 */
  const connectCanvasNodes = useCallback(
    (fromKey: string, toKey: string) => {
      const state = canvasStore.getState();
      const source = state.nodesById[fromKey];
      const target = state.nodesById[toKey];
      if (source?.type === "asset" && source.data.libraryResource) {
        if (state.assetEdges.some((edge) => edge.fromKey === fromKey && edge.toKey === toKey)) return false;
        const issue = target?.type === "gen" ? libraryResourceConnectionIssue(
          source.data.libraryResource, target.data, canvasInputsFor(toKey).libraryResources,
        ) : "请将素材库资源连接到对应的图片或视频生成节点。";
        if (issue) {
          toast.error(issue);
          return false;
        }
      }
      const promptSource = canvasNodesNow("gen").find(
        (node) => node.key === fromKey && node.kind === "prompt",
      );
      const screenplaySource = canvasNodesNow("screenplay").find((node) => node.key === fromKey);
      const outputSource = canvasNodesNow("output").find((node) => node.key === fromKey);
      const generationTarget = canvasNodesNow("gen").find((node) => node.key === toKey);
      const result = connectCanvasStateNodes(fromKey, toKey);
      if (result.status !== "connected") return false;
      const targetLabel = generationTarget
        ? `${generationTarget.kind === "image" ? "图片" : generationTarget.kind === "video" ? "视频" : "提示词"}节点`
        : `素材节点 ${toKey}`;
      frontendLog(
        "info",
        `[canvas] ${promptSource ? "提示词" : screenplaySource ? "剧本" : outputSource ? `${outputSource.mediaType === "image" ? "图片" : "视频"}产物` : "素材"}连线建立: ${fromKey} → ${targetLabel}`,
      );
      return true;
    },
    [connectCanvasStateNodes, canvasNodesNow, canvasStore, canvasInputsFor],
  );

  /** 组端口一次连线：按素材库点选顺序，把组内每个素材写进目标节点。 */
  const connectAssetGroup = useCallback(
    (groupId: string, toKey: string) => {
      if (assetGroupIdFromFlowId(toKey) != null) return;
      const snapshot = canvasStore.getState();
      const group = assetGroupsFromNodes(
        Object.values(snapshot.nodesById).map((entry) => entry.data),
      ).find((item) => item.groupId === groupId);
      if (!group) return;
      if (snapshot.groups[groupId]?.purpose === "character") {
        const target = snapshot.nodesById[toKey];
        if (target?.type !== "gen" || (target.data.kind !== "video" && target.data.kind !== "image") ||
          (target.data.kind === "image" && target.data.config.imageMode === "upscale")) {
          toast.error("角色分组可连接到普通图片或视频生成节点。");
          return;
        }
        const edges = group.members.flatMap(({ key }) => {
          const from = snapshot.nodesById[key];
          if (!from || !isSupportedConnection(from, target) ||
            snapshot.assetEdges.some(edge => edge.fromKey === key && edge.toKey === toKey)) return [];
          return [{ id: key + "->" + toKey, fromKey: key, toKey }];
        });
        if (edges.length > 0) insertSubgraph([], edges);
        return;
      }
      if (!group.members.every(isMediaGroupMember)) return;
      for (const member of group.members) connectCanvasNodes(member.key, toKey);
      frontendLog(
        "info",
        `[canvas] 素材组连线: group=${groupId}, count=${group.members.length}, target=${toKey}`,
      );
    },
    [connectCanvasNodes, canvasStore, insertSubgraph],
  );

  /** 媒体加载完成后记录原始比例，卡片与连线端点随尺寸同步更新。 */
  const handleAssetAspectRatioChange = useCallback(
    (key: string, aspectRatio: number) => {
      patchNode("asset", key, (node) => {
        return Math.abs((node.aspectRatio ?? 0) - aspectRatio) < 0.0001
          ? node
          : { ...node, aspectRatio };
      });
    },
    [patchNode],
  );

  // 素材节点预览地址按稳定身份刷新：旧 TOS 本地素材续签，新 Base64 素材验证本机文件。
  // 把新签名地址回写节点数据并随画布文档持久化。
  const handleAssetMediaRefresh = useCallback(
    (key: string, freshPreviewUrl: string) => {
      patchNode("asset", key, (node) => {
        return node.previewUrl === freshPreviewUrl
          ? node
          : {
              ...node,
              previewUrl: freshPreviewUrl,
              videoUrl: node.kind === "video" ? freshPreviewUrl : node.videoUrl,
            };
      });
    },
    [patchNode],
  );

  // 画布文档水合后给旧 TOS 素材续签；本机 Base64 素材仅在地址字段缺失时按 ID 恢复。
  // 依赖只看本轮画布里的素材身份集合：续签写回节点后签名变化不会重新触发本效果。
  const localAssetNodeSignature = useMemo(
    () =>
      canvasNodesNow("asset")
        .filter((node) => node.source === "local" && node.assetId !== "")
        .map((node) => `${node.assetId}:${node.kind}`)
        .sort()
        .join("|"),
    [canvasNodesNow],
  );
  useEffect(() => {
    if (!canvasHydrated) return;
    const localAssetNodes = canvasNodesNow("asset").filter(
      (node) => node.source === "local" && node.assetId !== "",
    );
    if (localAssetNodes.length === 0) return;
    return prefetchLocalAssetMedia(localAssetNodes, (fresh) => {
      for (const node of localAssetNodes) {
        const freshUrl = fresh.get(`${node.assetId}:${node.kind}`);
        if (freshUrl != null) handleAssetMediaRefresh(node.key, freshUrl);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 按素材身份集合触发，避免签名回写引发重复续签
  }, [canvasHydrated, handleAssetMediaRefresh, localAssetNodeSignature]);

  // 切换画布时丢弃上一条画布的重签登记表，避免把上一份素材的新地址用到当前画布。
  useEffect(() => {
    return () => resetLocalAssetMediaRegistry();
  }, [canvasId]);

  const handleOutputAspectRatioChange = useCallback(
    (key: string, aspectRatio: number) => {
      patchNode("output", key, (node) => {
        return Math.abs((node.aspectRatio ?? 0) - aspectRatio) < 0.0001
          ? node
          : { ...node, aspectRatio };
      });
    },
    [patchNode],
  );

  /** 删除素材节点（连同其所有连线）。 */
  const removeAssetNode = useCallback(
    (key: string) => {
      removeCanvasNode(key);
    },
    [removeCanvasNode],
  );

  /** 删除生成节点（连同其所有连线与提示词引用）。 */
  const removeGenNode = useCallback(
    (key: string) => {
      const removed = removeCanvasNode(key);
      /*
       * 删掉节点只是前端状态变化，后端并不知道。长视频的编排会继续每 1.2 秒提交一个片段
       * （有额度上限，但每一段都是真金白银），而它的界面入口是按节点过滤的——节点没了，
       * 用户连暂停/结束都点不到，编排就成了一个还在烧钱的隐形任务。所以删节点时叫停它。
       */
      void longVideoClient.cancelForNode(canvasId, key).then(cancelled => {
        if (cancelled > 0) toast.info(`已结束该节点上的 ${cancelled} 个长视频编排；撤销恢复节点后需要重新发起。`);
      }).catch((error: unknown) => {
        frontendLog("warn", `[long-video] 叫停节点 ${key} 上的长视频编排失败：${backendErrorMessage(error)}`);
        toast.error("没能叫停该节点上的长视频编排", { description: "它可能仍在按额度提交片段，请到长视频的创作过程里结束它。" });
      });
      setGenNodeSizes((current) => {
        if (!(key in current)) return current;
        const next = { ...current };
        delete next[key];
        return next;
      });
      if (removed != null) {
        const document = promptContents.remove(key);
        if (document != null) {
          deletedPromptContentsRef.current.set(key, document);
          // The canvas history keeps at most 200 structural operations.
          if (deletedPromptContentsRef.current.size > 200) {
            const oldest = deletedPromptContentsRef.current.keys().next().value;
            if (oldest != null) deletedPromptContentsRef.current.delete(oldest);
          }
        }
      }
      setStartErrorsByNode((current) => {
        if (!(key in current)) return current;
        const next = { ...current };
        delete next[key];
        return next;
      });
    },
    [promptContents, removeCanvasNode, canvasId],
  );

  const removeScreenplayNode = useCallback(
    (key: string) => {
      removeCanvasNode(key);
      setGenNodeSizes((current) => {
        if (!(key in current)) return current;
        const next = { ...current };
        delete next[key];
        return next;
      });
      setStartErrorsByNode((current) => {
        if (!(key in current)) return current;
        const next = { ...current };
        delete next[key];
        return next;
      });
      setStartingNodeKeys((current) => {
        if (!current.has(key)) return current;
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    },
    [removeCanvasNode],
  );

  /** 删除结果节点。 */
  const removeResultNode = useCallback(
    (key: string) => {
      removeCanvasNode(key);
    },
    [removeCanvasNode],
  );

  /** 删除智能剪辑节点（连同它的提示词内容与在途状态）。 */
  const removeVideoClipNode = useCallback(
    (key: string) => {
      for (const job of clipJobsRef.current.filter(job => job.sourceNodeId === key && clipJobActive(job))) {
        void clipRenderClient.cancel(job.id).catch((error: unknown) => toast.error(`取消剪辑失败：${backendErrorMessage(error)}`));
      }
      removeCanvasNode(key);
      // 智能剪辑的提示词住在提示词模块里，不随节点删除清理就会残留；
      // 存进 deletedPromptContentsRef 才能被撤销恢复。
      const document = promptContents.remove(key);
      if (document != null) {
        deletedPromptContentsRef.current.set(key, document);
        if (deletedPromptContentsRef.current.size > 200) {
          const oldest = deletedPromptContentsRef.current.keys().next().value;
          if (oldest != null) deletedPromptContentsRef.current.delete(oldest);
        }
      }
      setStartErrorsByNode((current) => {
        if (!(key in current)) return current;
        const next = { ...current };
        delete next[key];
        return next;
      });
      setStartingVideoClipKeys((current) => {
        if (!current.has(key)) return current;
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    },
    [promptContents, removeCanvasNode],
  );

  /** 删除产物卡片（连同其与来源生成节点的虚线连线）。 */
  const removeOutputNode = useCallback(
    (key: string) => {
      const removed = removeCanvasNode(key);
      if (
        removed?.type === "output" &&
        removed.data.origin === "composition" &&
        removed.data.previewSrc?.startsWith("blob:")
      ) {
        URL.revokeObjectURL(removed.data.previewSrc);
      }
      setPreviewOutputNodeKey((current) => (current === key ? null : current));
    },
    [removeCanvasNode],
  );

  /** 解除某条连线。 */
  const removeAssetEdge = useCallback(
    (edgeId: string) => {
      const edge = canvasStore.getState().assetEdges.find(item => item.id === edgeId);
      if (edge && canvasStore.getState().nodesById[edge.toKey]?.type === "videoClip" && (clipSubmissionsRef.current.has(edge.toKey) || clipRemoteBusyRef.current.has(edge.toKey) || clipJobsRef.current.some(job => job.sourceNodeId === edge.toKey && clipJobActive(job)))) {
        toast.error("智能剪辑进行中，暂时无法断开素材连线");
        return;
      }
      disconnectCanvasEdge(edgeId);
    },
    [disconnectCanvasEdge, canvasStore],
  );

  /** 所有上游路径共用身份、顺序和循环去重规则。 */
  const generationInputs = useCallback(
    (nodeKey: string): readonly GenerationMediaInput[] => canvasInputsFor(nodeKey).media,
    [canvasInputsFor],
  );

  const openVideoLocalEdit = useCallback(
    (nodeKey: string, input: { readonly key: string }) => {
      const source = canvasInputsFor(nodeKey).media.find(
        (item) => item.key === input.key && item.kind === "video",
      );
      if (!source) {
        setNodeStartError(nodeKey, "待编辑视频当前无法读取，请检查源视频及连线。");
        return;
      }
      setVideoLocalEdit({
        nodeKey,
        source: {
          key: source.key,
          label: source.name,
          src: source.src ?? "",
          target: source.target,
        },
        input: source,
      });
    },
    [canvasInputsFor, setNodeStartError],
  );

  const importGreenScreenVideo = useCallback(
    async (nodeKey: string) => {
      try {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const path = await open({
          multiple: false,
          directory: false,
          title: "导入绿幕或原视频",
          filters: [{ name: "视频", extensions: ["mp4", "mov", "webm", "mkv", "avi", "m4v"] }],
        });
        if (typeof path !== "string" || !path) return;
        const current = snapshotV2({});
        const target = current.genNodes.find((node) => node.key === nodeKey);
        if (target?.kind !== "video") return;
        const key = outputNodeKey();
        insertSubgraph(
          [
            {
              type: "output",
              data: {
                key,
                resultKey: null,
                sourceNodeId: `green-screen-import-${key}`,
                taskId: `green-screen-import-${key}`,
                mediaType: "video",
                origin: "green_screen",
                finalPath: path,
                name: fileNameFromPath(path),
                x: target.x - 360,
                y: target.y,
              },
            },
          ],
          [{ id: `green-screen-${key}-${nodeKey}`, fromKey: key, toKey: nodeKey }],
          { selectNodeKey: nodeKey },
        );
        toast.success("视频已连接", {
          description: "请在绿幕流程中将它明确选为原视频或绿幕前景。",
        });
      } catch (error) {
        toast.error("导入视频失败", { description: backendErrorMessage(error) });
      }
    },
    [snapshotV2, insertSubgraph],
  );

  const handleUseGreenScreenResult = useCallback(
    async (nodeKey: string, outputKey: string) => {
      try {
        const requested = snapshotV2({}).outputNodes?.find((output) => output.key === outputKey);
        if (!requested?.finalPath) throw new Error("绿幕视频尚未保存，请等待保存完成后再选用。");
        const detail = await generationClient.get(requested.taskId);
        const current = snapshotV2({});
        const node = current.genNodes.find((entry) => entry.key === nodeKey);
        const output = current.outputNodes?.find((entry) => entry.key === outputKey);
        if (node?.kind !== "video" || !output?.finalPath || !node.config.greenScreen)
          throw new Error("节点或绿幕结果已变化，请重新选择。");
        const greenScreen = node.config.greenScreen;
        const task = greenScreen.preparationTasks.find((entry) => entry.taskId === output.taskId);
        const prompt = promptContents.snapshotAll(new Set([nodeKey]))[nodeKey];
        if (!task || task.signature !== greenScreenNodeSignature(node.config, prompt))
          throw new Error(
            "绿幕制作设置或提示词已变化，请重新制作；旧视频仍保留在画布中，也可作为已有绿幕手动选用。",
          );
        const selection = resolveGenerationSelection(
          "video",
          node.config.modelSelection,
          providerCatalog,
        );
        const inputs = createCanvasInputResolver(
          canvasNodesByKeyFromDocument(current),
          current.assetEdges,
        )(nodeKey).media;
        const preparation = prepareGreenScreenGeneration(
          { ...greenScreen, phase: "prepare" },
          inputs,
          selection?.model.remoteModelId ?? "",
          prompt,
        );
        if (preparation.issue) throw new Error(preparation.issue);
        if (!preparation.preparation?.ok)
          throw new Error("制作阶段的提示词引用已失效，请检查来源后重新制作。");
        const result = detail.results.find(
          (entry) =>
            `${entry.taskId}#${entry.resultIndex}` === output.resultKey &&
            entry.saveStatus === "succeeded" &&
            entry.finalPath === output.finalPath,
        );
        if (detail.summary.id !== output.taskId || detail.summary.status !== "succeeded" || !result)
          throw new Error("这版绿幕结果尚未成功保存，或来源已变化，请在任务历史中检查后重试。");
        const mediaTarget = outputNodeReferenceTarget(output);
        if (!mediaTarget) throw new Error("绿幕结果的素材身份无效。");
        if (
          !current.assetEdges.some((edge) => edge.fromKey === outputKey && edge.toKey === nodeKey)
        ) {
          insertSubgraph(
            [],
            [{ id: `green-screen-${outputKey}-${nodeKey}`, fromKey: outputKey, toKey: nodeKey }],
          );
        }
        updateVideoNodeConfig(nodeKey, {
          ...node.config,
          greenScreen: {
            ...greenScreen,
            enabled: true,
            phase: "composite",
            foregrounds: [
              { key: output.key, name: output.name ?? "绿幕视频", target: mediaTarget },
            ],
          },
        });
        setNodeStartError(nodeKey, null);
        toast.success("绿幕已选用", {
          description: "设置新场景并点击生成融合成片；制作阶段的原视频会保留在画布中。",
        });
      } catch (error) {
        setNodeStartError(nodeKey, backendErrorMessage(error));
      }
    },
    [
      snapshotV2,
      promptContents,
      providerCatalog,
      insertSubgraph,
      updateVideoNodeConfig,
      setNodeStartError,
    ],
  );

  const applyVideoLocalEdit = useCallback(
    (edit: VideoLocalEditResult) => {
      if (!videoLocalEdit || edit.sourceKey !== videoLocalEdit.input.key)
        throw new Error("待编辑视频已变化，请重新打开标注。");
      // Read the live graph after disk I/O: never bind a late annotation to a removed/replaced source.
      const current = snapshotV2({});
      const target = current.genNodes.find((node) => node.key === videoLocalEdit.nodeKey);
      const inputs = createCanvasInputResolver(
        canvasNodesByKeyFromDocument(current),
        current.assetEdges,
      )(videoLocalEdit.nodeKey).media;
      const source = inputs.find((input) => input.key === edit.sourceKey);
      if (
        target?.kind !== "video" ||
        !source ||
        !sameMediaReferenceTarget(videoLocalEdit.input.target, source.target)
      ) {
        throw new Error("源视频或生成节点已变化，标注图已保存，请重新打开视频编辑。");
      }
      // 编辑要求里的 @ 引用按连线身份解析；连线被移除后再提交会得到无法定位的引用。
      const connectedKeys = new Set(inputs.map((input) => input.key));
      const staleReference = edit.instructionDocument.items.find(
        (item) => item.kind === "media_reference" && !connectedKeys.has(item.canvasNodeKey),
      );
      if (staleReference) {
        throw new Error("编辑要求引用的素材已断开连接，标注图已保存，请重新打开视频编辑。");
      }
      const selection = resolveGenerationSelection(
        "video",
        target.config.modelSelection,
        providerCatalog,
      );
      if (!selection) throw new Error("请先选择可用的 Seedance 2.5 模型。");
      const capabilities = modelParameterCapabilities(
        selection.model.operationSchema,
        "video_generation",
        selection.model.remoteModelId,
      );
      const key = outputNodeKey();
      const name = edit.frame.name;
      // 帧的保存与入库都在弹窗里完成：这里只按它给的身份接入节点，不再做磁盘 I/O。
      // canvasNodeKey 必须改成这个产物节点自己的 key：解析阶段还不知道最终 key，
      // 提示内容里的引用身份必须与节点身份一致，否则存档会因为目标身份不匹配被拒。
      const frame = {
        key,
        name,
        kind: "image" as const,
        target: { ...edit.frame.target, canvasNodeKey: key },
      };
      const nextConfig = selectSeedanceTask(
        selection.model.remoteModelId,
        capabilities,
        target.config,
        [...inputs, frame],
        "edit",
        selection.model.operationSchema,
      );
      const taskState = resolveSeedanceTask(
        selection.model.remoteModelId,
        capabilities,
        nextConfig,
        [...inputs, frame],
        selection.model.operationSchema,
      );
      if (!taskState.enabled || taskState.issue)
        throw new Error(taskState.issue ?? "当前模型不支持 Seedance 2.5 视频局部编辑。");
      const document = appendVideoLocalEditPrompt(
        promptContents.snapshotAll(new Set([target.key]))[target.key],
        source,
        frame,
        edit,
      );
      insertSubgraph(
        [
          {
            type: "output",
            data: {
              key,
              resultKey: null,
              sourceNodeId: source.key,
              taskId: `video-edit-${key}`,
              mediaType: "image",
              origin: "video_edit",
              finalPath: edit.frame.path,
              name,
              aspectRatio: edit.frame.aspectRatio,
              // 标注帧的入库发生在弹窗里，不走产物卡片的上传按钮，因此 jobId → 产物节点
              // 映射在这一刻并不存在；不在这里补上已上传状态，绿色小点就永远不会亮，
              // 用户还会再点一次上传、把同一张帧重复上传成第二个素材。
              ...(edit.frame.uploadedToLibrary ? { uploadedToCloud: true } : {}),
              x: target.x - 360,
              y: target.y + inputs.length * 24,
            },
          },
        ],
        [{ id: `video-edit-${key}-${target.key}`, fromKey: key, toKey: target.key }],
        { selectNodeKey: target.key },
      );
      updateVideoNodeConfig(target.key, nextConfig);
      promptContents.restoreDocument(target.key, document);
      setNodeStartError(target.key, null);
      setVideoLocalEdit(null);
      if (edit.offFrameReferenceTimes != null && edit.offFrameReferenceTimes.length > 0) {
        toast.info("编辑要求引用了其它画面的标注", {
          description: `提示词已写明它是视频 ${edit.offFrameReferenceTimes.join("、")} 处的区域，但标注帧只画出了当前画面。如需画面里的定位线，请回到该时间点再添加一次标注帧。`,
        });
      }
      toast.success("局部编辑已添加到输入框", {
        description: edit.frame.uploadedToLibrary
          ? "标注帧已上传云端素材库，将以资产身份提交，可检查提示词后开始生成。"
          : "标注帧以本地文件身份提交（未入库）。含真人的素材可能被平台拒绝，可在弹窗里勾选入库后重试。",
      });
    },
    [
      videoLocalEdit,
      snapshotV2,
      providerCatalog,
      promptContents,
      insertSubgraph,
      updateVideoNodeConfig,
      setNodeStartError,
    ],
  );

  /**
   * 把弹窗落盘的标注帧解析成提交身份：勾选入库时优先走云端素材库。
   *
   * 它是弹窗的回调而不是弹窗的前置步骤：入库失败时要让弹窗留在原地重试，
   * 用户不必重新标注一遍。未勾选入库时只落本地文件，不产生云端素材。
   */
  const resolveVideoLocalEditFrame = useCallback(
    async ({
      path,
      name,
      uploadToLibrary,
      onProgress,
    }: {
      readonly path: string;
      readonly name: string;
      readonly dataUrl: string;
      readonly uploadToLibrary: boolean;
      readonly onProgress: (label: string) => void;
    }): Promise<VideoLocalEditFrameResolution> => {
      // 未配置素材库连接或用户取消勾选：直接以本地文件身份提交。
      // 这里的 canvasNodeKey 只是占位：真正的产物节点 key 在接入时才知道，
      // 提交前会由 applyVideoLocalEdit 覆写为节点自己的 key。
      if (!uploadToLibrary || assetProvider == null) {
        return {
          uploadedToLibrary: false,
          target: {
            kind: "local_file",
            path,
            canvasNodeKey: "",
            mediaType: "image",
          },
        };
      }
      return resolveVideoEditFrameTarget({
        path,
        name,
        canvasNodeKey: "",
        providerConnectionId: assetProvider.id,
        // 标注帧入库沿用面板当前选中的分组；未选中时由后端决定默认上传分组。
        groupId: selectedAssetGroupIdRef.current,
        onProgress,
      });
    },
    [assetProvider],
  );

  /** 以视口中心为锚点缩放到目标百分比（键盘与缩放按钮共用），落点由 onMoveEnd 同步回 store。 */
  const zoomAroundViewportCenter = useCallback(
    (targetZoom: number) => {
      const instance = flowInstanceRef.current;
      const nextZoom = clampCanvasZoom(targetZoom);
      if (instance == null) {
        // 实例尚未就绪（理论仅在挂载前）：先同步展示层，挂载后由 onInit 应用视图。
        setView({ zoom: nextZoom });
        return;
      }
      const currentZoom = Math.round(instance.getViewport().zoom * 100);
      if (nextZoom === currentZoom) return;
      void instance.zoomTo(nextZoom / 100, { duration: 160 });
    },
    [setView],
  );

  /**
   * 回到画布起始位置。空画布与新建画布一样：原点在视口左上角、缩放为 DEFAULT_ZOOM。
   * 已有节点时不回到世界原点——节点是按当时视口落点的，看着远处的视频生成再归位，
   * 原点是空白，无限画布上无法再靠平移找回整段流。改为把现有节点框进视口并居中。
   * 落点同样由 onMoveEnd 同步回 store。只移动镜头，不改节点坐标。
   */
  const resetCanvasViewport = useCallback(() => {
    const instance = flowInstanceRef.current;
    if (instance == null) {
      // 实例尚未就绪（理论仅在挂载前）：先同步展示层，挂载后由 onInit 应用视图。
      setView({ zoom: DEFAULT_ZOOM, pan: { x: 0, y: 0 } });
      return;
    }
    const rect = canvasViewportRef.current?.getBoundingClientRect();
    const home =
      rect != null && rect.width > 0 && rect.height > 0
        ? canvasHomeViewport({
            viewportWidth: rect.width,
            viewportHeight: rect.height,
            nodes: instance.getNodes().map((node) => ({
              x: node.position.x,
              y: node.position.y,
              width: node.measured?.width ?? node.width ?? 0,
              height: node.measured?.height ?? node.height ?? 0,
            })),
          })
        : { x: 0, y: 0, zoom: DEFAULT_ZOOM / 100 };
    void instance.setViewport(home, { duration: 200 });
  }, [setView]);

  const queryClient = useQueryClient();
  // 对未到达终态的上传任务轮询 get_staging_job，驱动进度条实时刷新。
  // 查询 key 随活动任务集合变化：全部到达终态后集合为空，轮询自动停止；
  // 单个任务查询失败只跳过该任务，不影响同批其他任务的进度。
  const activeUploadJobIds = useMemo(
    () =>
      assetUploads
        .filter((entry) => entry.destination !== "local" && !isTerminalAssetUpload(entry))
        .map((entry) => entry.jobId),
    [assetUploads],
  );
  // 查询仅负责拉取与定时；结果合并通过下方对 Query 缓存的订阅完成。
  useQuery({
    queryKey: ["staging-jobs", activeUploadJobIds],
    queryFn: async (): Promise<readonly (StagingJobRecord | null)[]> =>
      Promise.all(
        activeUploadJobIds.map(async (jobId) => {
          try {
            return await tosStagingClient.getJob(jobId);
          } catch {
            // 瞬时轮询失败静默忽略，下一轮重试。
            return null;
          }
        }),
      ),
    enabled: isDesktopRuntime(),
    // 结果只经缓存订阅消费，无需触发任何重渲染。
    notifyOnChangeProps: [],
    refetchInterval: activeUploadJobIds.length > 0 ? UPLOAD_POLL_INTERVAL_MS : false,
  });
  // 轮询结果 → 会话状态合并。订阅 Query 缓存而不是在 effect 体里同步 setState：
  // 每次轮询成功都会派发 success 动作（即便数据被结构共享折叠成同一引用），
  // 因此 uploading 条目每秒重算一次停滞提示的原节奏在回调里得以保留。
  useEffect(() => {
    const cache = queryClient.getQueryCache();
    return cache.subscribe((event) => {
      if (event.type !== "updated") return;
      const [cacheKey] = event.query.queryKey as readonly unknown[];
      if (typeof cacheKey !== "string" || cacheKey !== "staging-jobs") return;
      const jobs = event.query.state.data as readonly (StagingJobRecord | null)[] | undefined;
      if (jobs == null || jobs.length === 0) return;
      const now = Date.now();
      // 兜底刷新：轮询发现任务到达终态时也刷新素材列表，覆盖终态事件丢失的场景。
      // 事件通道仍是主路径，此处与事件刷新重复调用是幂等的列表拉取。
      for (const job of jobs) {
        if (job == null) continue;
        noteTimedOutAssetImport(job);
        const entry = uploadEntriesRef.current.find((item) => item.jobId === job.id);
        if (entry == null || isTerminalAssetUpload(entry)) continue;
        const reachedTerminal = isTerminalStagingJob(job, entry.destination);
        if (!reachedTerminal) continue;
        const outputUpload = uploadJobToOutputRef.current.get(job.id);
        if (outputUpload && stagingImportReachedLibrary(job)) {
          patchNodes("output", (node) =>
            node.key !== outputUpload
              ? node
              : node.uploadedToCloud
                ? node
                : { ...node, uploadedToCloud: true },
          );
          uploadJobToOutputRef.current.delete(job.id);
        }
        if (entry.destination === "object_storage" && job.status === "staged") {
          refreshObjectStorageAssets("upload-finished");
          const objectOutput = objectStorageUploadJobToOutputRef.current.get(job.id);
          if (objectOutput) {
            patchNodes("output", (node) =>
              node.key === objectOutput && !node.uploadedToObjectStorage
                ? { ...node, uploadedToObjectStorage: true }
                : node,
            );
            objectStorageUploadJobToOutputRef.current.delete(job.id);
          }
        } else if (
          entry.destination === "cloud" &&
          assetLibrarySource === "cloud" &&
          assetProvider
        ) {
          void refreshCloudAssets(assetProvider.id, "upload-finished");
          refreshAssetGroups(assetProvider.id);
        }
      }
      setAssetUploads((current) => {
        // 状态合并（终态写入、僵尸在途落地为已中断、停滞提示）在 workspaceModel 里：
        // 僵尸判定要等两分钟，抽成纯函数后可以直接验证边界，不必在测试里真实等待。
        return mergeStagingJobsIntoUploads(current, jobs, now) ?? current;
      });
    });
  }, [
    assetLibrarySource,
    assetProvider,
    patchNodes,
    noteTimedOutAssetImport,
    queryClient,
    refreshAssetGroups,
    refreshCloudAssets,
    refreshLocalAssets,
    refreshObjectStorageAssets,
  ]);

  const libraryAssets = useMemo<readonly AssetItem[]>(() => {
    if (!isDesktopRuntime()) {
      if (assetLibrarySource !== "cloud") return [];
      return assetProvider
        ? ASSETS.map((item) => ({
            ...item,
            providerConnectionId: assetProvider.id,
            providerDisplayName: assetProvider.displayName,
          }))
        : ASSETS;
    }
    if (assetLibrarySource === "local") return localAssets.map(localAssetToItem);
    if (cloudCollection === "object_storage") return objectStorageAssets.map(localAssetToItem);
    return cloudAssets
      .filter(
        (asset) =>
          asset.dbId == null ||
          !hiddenCloudAssetKeys.has(JSON.stringify([asset.providerConnectionId, asset.dbId])),
      )
      .map((asset) => {
        const item = cloudAssetToItem(asset);
        return assetProvider?.id === asset.providerConnectionId
          ? {
              ...item,
              providerDisplayName: assetProvider.displayName,
            }
          : item;
      });
  }, [
    assetLibrarySource,
    assetProvider,
    cloudCollection,
    cloudAssets,
    hiddenCloudAssetKeys,
    localAssets,
    objectStorageAssets,
  ]);

  const refreshProviderCatalog = useCallback(async () => {
    if (!isDesktopRuntime()) return;
    const requestId = ++providerCatalogRequestRef.current;
    const catalog = await loadProviderCatalog();
    if (requestId !== providerCatalogRequestRef.current) return;
    setProviderCatalog(catalog);
    setNodeModelSelections((current) => reconcileNodeModelSelections(current, catalog));
    patchNodes("gen", (node) =>
      resolvePendingGenerationNodeConfig(node, catalog, mediaInputTargetKeysRef.current),
    );
    patchNodes("screenplay", (node) => resolvePendingDocumentNodeConfig(node, catalog));
    setProviderCatalogLoaded(true);
  }, [patchNodes]);

  // 生成任务列表：generation:* 事件是主驱动（handleGenerationEvent 里失效触发
  // 重新拉取），refetchInterval 仅在有未到终态任务时兜底轮询，防止漏接事件。
  // 拉取失败时 React Query 保留上一次成功数据，与原“失败保留现有状态”一致。
  const generationTasksQuery = useQuery({
    queryKey: [...GENERATION_TASKS_QUERY_KEY, canvasId],
    queryFn: ({ signal }) => {
      const state = canvasStore.getState();
      const ownedTaskIds = new Set<string>();
      for (const entry of Object.values(state.nodesById)) {
        if (entry.type === "output" && (entry.data.origin == null || entry.data.origin === "generation")) ownedTaskIds.add(entry.data.taskId);
        if (entry.type === "gen" && entry.data.kind === "image") {
          for (const taskId of entry.data.imageGeneration?.taskIds ?? []) ownedTaskIds.add(taskId);
        }
      }
      return loadCanvasGenerationTasks(canvasId,
        queryClient.getQueryData<GenerationTaskPage>([...GENERATION_TASKS_QUERY_KEY, canvasId]), ownedTaskIds, signal);
    },
    enabled: isDesktopRuntime(),
    // 非活跃画布不需要任务列表触发的重渲染（渲染本就被冻结为 null）：
    // 数据继续进缓存，激活后下一条渲染直接读到最新值。
    notifyOnChangeProps: active ? undefined : [],
    refetchInterval: (query) => {
      const tasks = query.state.data?.items ?? [];
      return tasks.some((task) => !isTerminalTaskStatus(task.status))
        ? GENERATION_TASKS_POLL_INTERVAL_MS
        : false;
    },
  });
  const generationTasks = useMemo(
    () =>
      generationTasksQuery.data?.items.filter((task) => task.canvasId === canvasId) ??
      EMPTY_GENERATION_TASKS,
    [generationTasksQuery.data, canvasId],
  );
  useEffect(() => {
    clipRemoteBusyRef.current = new Set(generationTasks.filter(task => !isTerminalTaskStatus(task.status)).map(task => task.sourceNodeId));
    for (const task of generationTasks) {
      if (!["succeeded", "failed", "cancelled"].includes(task.status)) continue;
      const node = canvasStore.getState().nodesById[task.sourceNodeId];
      if (node?.type === "videoClip" && node.data.config.submission?.id === task.id) {
        updateVideoClipConfig(node.data.key, { submission: null });
      }
    }
  }, [generationTasks, canvasStore, updateVideoClipConfig]);
  // A node's accepted task can fall outside the paginated history. Reconcile its
  // durable ID directly; a history read never creates another generation.
  useEffect(() => {
    const visibleIds = new Set(generationTasks.map(task => task.id));
    const pending = canvasNodesOfState(canvasStore.getState(), "videoClip").filter(node => node.config.submission && !visibleIds.has(node.config.submission.id) && !startingVideoClipKeys.has(node.key));
    if (!pending.length || !isDesktopRuntime()) return;
    let disposed = false;
    void Promise.allSettled(pending.map(node => generationClient.getProgress(node.config.submission!.id))).then(results => {
      if (disposed) return;
      results.forEach((result, index) => {
        const node = pending[index]!;
        if (result.status === "fulfilled" && ["succeeded", "failed", "cancelled"].includes(result.value.summary.status)) {
          const live = canvasStore.getState().nodesById[node.key];
          if (live?.type === "videoClip" && live.data.config.submission?.id === node.config.submission?.id) updateVideoClipConfig(node.key, { submission: null });
        } else if (result.status === "rejected") {
          setNodeStartError(node.key, `原剪辑任务回执待核对：${backendErrorMessage(result.reason)}。任务身份已保留，请先在历史中核对。`);
        }
      });
    });
    return () => { disposed = true; };
  }, [videoClipNodeLayoutTokens, generationTasks, startingVideoClipKeys, canvasStore, updateVideoClipConfig, setNodeStartError]);

  const refreshTasks = useCallback(() => {
    if (!isDesktopRuntime()) return;
    // 只失效本画布的任务列表：generation:* 事件是全局广播，每个画布实例都会收到，
    // 若按基础 key 失效，一次事件会让所有打开的画布各拉一遍任务列表。
    void queryClient.invalidateQueries({ queryKey: [...GENERATION_TASKS_QUERY_KEY, canvasId] });
  }, [queryClient, canvasId]);

  // 高频事件（图片保存进度、逐张结果）不需要逐次拉任务列表：500ms 合并一次兜底刷新，
  // 语义不变（事件后 0.5s 内必然对账），但把 N 次 IPC 收敛为 1 次。
  const tasksRefreshTimerRef = useRef<number | null>(null);
  const scheduleTasksRefresh = useCallback(() => {
    if (tasksRefreshTimerRef.current !== null) return;
    tasksRefreshTimerRef.current = window.setTimeout(() => {
      tasksRefreshTimerRef.current = null;
      refreshTasks();
    }, 500);
  }, [refreshTasks]);
  useEffect(
    () => () => {
      if (tasksRefreshTimerRef.current !== null) window.clearTimeout(tasksRefreshTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!isDesktopRuntime() || !active) return;
    let current = true;
    const providerCatalogRequestId = ++providerCatalogRequestRef.current;
    void loadProviderCatalog()
      .then((catalog) => {
        if (!current || providerCatalogRequestId !== providerCatalogRequestRef.current) return;
        setProviderCatalog(catalog);
        setNodeModelSelections((current) => reconcileNodeModelSelections(current, catalog));
        patchNodes("gen", (node) =>
          resolvePendingGenerationNodeConfig(node, catalog, mediaInputTargetKeysRef.current),
        );
        patchNodes("screenplay", (node) => resolvePendingDocumentNodeConfig(node, catalog));
        setProviderCatalogLoaded(true);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [active, patchNodes]);

  // 应用启动后一次性回填：最近成功（非文本）任务的产物结果写入 taskResults，
  // 供产物卡片与“最新产物”展示使用；会话内落卡由事件驱动，不经过这里。
  const initialTaskResultsLoadedRef = useRef(false);
  useEffect(() => {
    const page = generationTasksQuery.data;
    if (!isDesktopRuntime() || page == null || initialTaskResultsLoadedRef.current) return;
    initialTaskResultsLoadedRef.current = true;
    const succeededIds = page.items
      // 文本任务没有本地媒体结果；避免频繁的提示词调用占满回填名额，
      // 让应用重启后仍能优先恢复最近的图片/视频产物卡片。
      .filter((task) => task.status === "succeeded" && task.operation !== "text_generation")
      .slice(0, 5)
      .map((task) => task.id);
    void (async () => {
      const entries = await Promise.all(
        succeededIds.map(async (taskId) => {
          try {
            const detail = await generationClient.get(taskId);
            return [taskId, detail.results] as const;
          } catch {
            return [taskId, [] as readonly GenerationResultRecord[]] as const;
          }
        }),
      );
      setTaskResults(current => ({ ...Object.fromEntries(entries), ...current }));
    })();
  }, [generationTasksQuery.data, setTaskResults]);

  // 生成结果落卡去重（taskId#resultIndex）：占位卡片在任务启动时即已创建。
  // result-ready 只写入会话内 previewSrc，result-saved 再写入稳定的 finalPath；
  // 用户手动删除的占位卡片也不会因结果事件被重新创建。
  //
  // 去重按「卡片自己的 resultKey」判定，不使用「已处理过的 resultKey」全局集合：
  // 图片结果的 result-ready 与 result-saved 由后端几乎同一时刻连着发出，事件一旦在
  // 监听重建窗口里丢失，事后补发就会被那个集合挡住，卡片永远停在「正在保存本地副本」。
  // 幂等改由卡片自身状态保证——resultKey 已对上且 finalPath 已写好的卡片只补缺失字段。
  //
  // 补发重试台账：`inFlight` 记录已排定待执行的任务（同一任务只排一个计时器），
  // `attempts` 记录已用掉的重试次数。两者分开是因为 effect 会随画布任何变化重跑：
  // 已排定的退避不能被无关的节点变化取消，否则补发会退化成打满次数就放弃。
  const imageResultPreviewsRef = useRef(new Map<string, string>());
  const imageGenerationSignature = useCanvas(state => state.nodes.gen.flatMap(node =>
    node.kind === "image" ? [node.key, ...(node.imageGeneration?.taskIds ?? []),
      ...(node.imageGeneration?.results.map(result => result.resultKey + (result.finalPath ?? "")) ?? [])] : [],
  ).join("\u0001"));
  const registerImageGeneration = useCallback((nodeKey: string, taskIds: readonly string[], submittedAt = Date.now(), expectedCount = 1) => {
    const tasks = queryClient.getQueryData<GenerationTaskPage>([...GENERATION_TASKS_QUERY_KEY, canvasId])?.items ?? [];
    const legacy = latestGenerationPreviewFor(canvasReadModelOfState(canvasStore.getState()), nodeKey);
    patchNode("gen", nodeKey, node => {
      if (node.kind !== "image") return node;
      const generation = node.imageGeneration;
      const previousTaskIds = generation?.taskIds ?? [];
      // 并行提交归入同一批。用点击时刻而非 IPC 回执时刻判定重叠，避免先提交的任务
      // 在后一次回执抵达前完成，就丢掉它的结果。列表可能比回执晚，未见到状态先保留。
      const keepBatch = previousTaskIds.some(id => {
        if (taskIds.includes(id)) return true;
        const task = tasks.find(entry => entry.id === id);
        return task == null || !isTerminalTaskStatus(task.status) ||
          (task.completedAt != null && task.completedAt >= submittedAt);
      });
      const nextTaskIds = keepBatch ? [...new Set([...previousTaskIds, ...taskIds])] : [...taskIds];
      if (generation && nextTaskIds.length === previousTaskIds.length &&
          nextTaskIds.every((id, index) => id === previousTaskIds[index]) &&
          taskIds.every(id => (generation.expectedResults?.[id] ?? 1) >= expectedCount)) return node;
      const previous = legacy ? imageResultFromOutput(legacy) : null;
      const expectedResults = { ...generation?.expectedResults };
      for (const taskId of taskIds) expectedResults[taskId] = Math.max(expectedResults[taskId] ?? 1, expectedCount);
      return { ...node, imageGeneration: {
        ...generation, taskIds: nextTaskIds,
        expectedResults: Object.fromEntries(nextTaskIds.map(id => [id, expectedResults[id] ?? 1])),
        results: generation?.results ?? (previous ? [previous] : []),
      } };
    });
  }, [canvasId, canvasStore, patchNode, queryClient]);
  const selectImageResult = useCallback((nodeKey: string, resultKey: string) => {
    patchNode("gen", nodeKey, node => node.kind === "image" &&
      node.imageGeneration?.results.some(result => result.resultKey === resultKey)
      ? { ...node, imageGeneration: { ...node.imageGeneration, selectedResultKey: resultKey } } : node);
  }, [patchNode]);
  const resultRescueInFlightRef = useRef<Map<string, number>>(new Map());
  const resultRescueAttemptsRef = useRef<Map<string, number>>(new Map());

  /**
   * 生成结果填充：供应商返回的结果先原地填充 previewSrc，保存完成后再替换成
   * finalPath。previewSrc 只存在于当前会话，不会写进画布文档。
   * 图片保存在来源节点的当前批次中（多张结果在菜单切换），不追加画布节点。
   * 旧产物卡片仍可按原有身份补齐路径，其他媒体沿用各自的产物机制。
   *
   * 返回值表示「这次调用是否让某个卡片拿到了该结果」：
   * - 事件路径不关心返回值（事件只发一次，重复投递由幂等吸收）；
   * - 补发路径用它决定是否继续重试——没落卡就说明后端结果还没就绪或事件没到，需要再等。
   */
  const applyGenerationResult = useCallback(
    (record: GenerationResultRecord, previewSrc: string | null = null): boolean => {
      if (!isDesktopRuntime()) return false;
      const mediaType = record.mediaType;
      if (mediaType !== "image" && mediaType !== "video" && mediaType !== "text" && mediaType !== "audio") return false;
      const resultKey = `${record.taskId}#${record.resultIndex}`;
      let inlineImage = false;
      if (mediaType === "image") {
        patchNodes("gen", node => {
          if (node.kind !== "image" || !node.imageGeneration?.taskIds.includes(record.taskId)) return node;
          inlineImage = true;
          return applyImageNodeResult(node, record, previewSrc ?? imageResultPreviewsRef.current.get(resultKey) ?? null);
        });
      }
      const saved = record.saveStatus === "succeeded" && record.finalPath != null;
      if (!saved && previewSrc == null && mediaType !== "text") return false;
      const finalPath = saved ? record.finalPath : null;
      const name = resultDisplayName(record) ?? (finalPath ? fileNameFromPath(finalPath) : null);
      // Context-IR 文本产物：扩写正文内联在 source.text，随事件写入卡片展示。
      const textContent =
        mediaType === "text" ? (textResultFromSource(record.source) ?? null) : null;
      // Seedream 图层拆分：从结果记录 source.layer 提取图层元数据，用于把每个图层
      // 单独落为可编辑对象并展示图层名称/层级。
      const layer = (() => {
        const layerRaw = (record.source as { layer?: unknown } | null)?.layer;
        if (!layerRaw || typeof layerRaw !== "object") return undefined;
        const l = layerRaw as {
          zIndex?: unknown;
          name?: unknown;
          description?: unknown;
          boundingBox?: unknown;
        };
        const zIndex = typeof l.zIndex === "number" ? l.zIndex : 0;
        const info: OutputLayerInfo = {
          zIndex,
          name: typeof l.name === "string" ? l.name : null,
          description: typeof l.description === "string" ? l.description : null,
          boundingBox:
            l.boundingBox != null && typeof l.boundingBox === "object"
              ? (l.boundingBox as Record<string, unknown>)
              : null,
          isBaseLayer: zIndex === 0,
        };
        return info;
      })();
      // 把结果写进指定卡片。幂等：以卡片自身 resultKey + finalPath 判定，绝不重复落卡，
      // 因此可以在事件丢失后由补发路径反复调用。
      const fillNode = (node: OutputNodeData): OutputNodeData => ({
        ...node,
        resultKey,
        mediaType,
        ...(saved
          ? { finalPath, previewSrc: null, name: node.customName ?? name }
          : { previewSrc, finalPath: null }),
        ...(textContent != null ? { textContent } : {}),
        ...(layer != null ? { layer } : {}),
      });
      const ownsResult = (node: OutputNodeData) =>
        node.taskId === record.taskId && node.resultKey === resultKey;
      let matched = false;
      patchNodes("output", (node) => {
        if (matched || !ownsResult(node)) return node;
        // 已经是这次结果且本地文件路径已写入：真正无事可做，直接出账。
        if (!(saved && node.finalPath === finalPath)) {
          matched = true;
          return fillNode(node);
        }
        matched = true;
        return node;
      });
      // 兜底收编本次任务的空占位卡片：即使 resultKey 与本次结果对不上（历史文档里的
      // 旧编号、或结果索引与占位编号错位），也把结果填进已有卡片——否则占位卡片会永远
      // 停在「已成功 · 等待结果保存」，同一次生成还会多出一张重复卡片。
      // 已有内容（finalPath / previewSrc）的卡片不参与收编，多结果场景仍由后续结果各自新建卡片。
      if (!matched) {
        patchNodes("output", (node) => {
          if (
            matched ||
            node.taskId !== record.taskId ||
            node.finalPath != null ||
            node.previewSrc != null
          ) {
            return node;
          }
          matched = true;
          return fillNode(node);
        });
      }
      // 单任务多结果（如图层拆分）：占位卡片只有一个，后续结果匹配不到时动态新建卡片。
      // 先确认没有任何卡片代表这次结果——补发路径可能在上一次尝试里已经落过卡，
      // 这时只补字段，不能再新建一张重复卡片。
      const outputs = canvasNodesNow("output");
      if (!matched) {
        const alreadyOwned = outputs.find(ownsResult);
        if (alreadyOwned != null) {
          matched = true;
          if (saved && alreadyOwned.finalPath !== finalPath) {
            patchNodes("output", (node) => (ownsResult(node) ? fillNode(node) : node));
          }
        }
      }
      if (!matched) {
        const existing = outputs.find((node) => node.taskId === record.taskId);
        const sourceNodeId = existing?.sourceNodeId;
        if (sourceNodeId) {
          const genNode = canvasNodesNow("gen").find((node) => node.key === sourceNodeId);
          if (genNode && genNode.kind !== "image") {
            addOutput((current, nodesById) => ({
              key: outputNodeKey(),
              resultKey,
              sourceNodeId,
              taskId: record.taskId,
              mediaType,
              origin: "generation",
              finalPath,
              previewSrc: saved ? null : previewSrc,
              name,
              ...(textContent != null ? { textContent } : {}),
              ...(layer != null ? { layer } : {}),
              ...nextOutputSlot(
                currentOutputSource(nodesById, "gen", genNode),
                current,
                outputPlacementOptionsFor(nodesById, genNode.key),
              ),
            }));
            matched = true;
          }
        }
      }
      if (matched) {
        if (saved) {
          frontendLog("info", `[canvas] 生成产物已落卡: ${name}`);
        } else {
          frontendLog("info", `[canvas] 生成结果已返回，先展示临时预览: task=${record.taskId}`);
        }
      }
      return matched || inlineImage;
    },
    [patchNodes, addOutput, canvasNodesNow, outputPlacementOptionsFor],
  );

  const handleGenerationEvent = useCallback(
    (eventName: string, payload: unknown) => {
      if (eventName === "generation:text-delta") {
        // 文本模型正在生成的正文：按节点暂存，节点卡片实时展示。
        // 任务结束后由 run 的 then 用完整结果覆盖，这里不需要清理。
        const info = payload as {
          sourceNodeId?: string;
          taskId?: string;
          delta?: string;
        } | null;
        const nodeKey = info?.sourceNodeId;
        const chunk = info?.delta;
        if (!nodeKey || !chunk) return;
        const taskChanged =
          Boolean(info?.taskId) && info?.taskId !== streamingTextTaskByNodeRef.current.get(nodeKey);
        if (taskChanged) {
          // 同一节点可能被连续发起多轮；任务 ID 变了说明是新一轮，从空开始累积。
          streamingTextTaskByNodeRef.current.set(nodeKey, info?.taskId as string);
        }
        // 流式正文按 50ms 合帧：每个 token 一次 setState 会让整棵组件树空转。
        const batch = streamingTextBatchRef.current;
        const entry = batch.entries.get(nodeKey);
        if (taskChanged || !entry)
          batch.entries.set(nodeKey, { text: chunk, replace: taskChanged });
        else entry.text += chunk;
        batch.timer ??= window.setTimeout(() => {
          batch.timer = null;
          const pending = batch.entries;
          batch.entries = new Map();
          if (pending.size === 0) return;
          setStreamingTextByNode((current) => {
            let next = current;
            for (const [key, item] of pending) {
              next = {
                ...next,
                [key]: item.replace ? item.text : `${next[key] ?? ""}${item.text}`,
              };
            }
            return next;
          });
        }, 50);
        return;
      }
      if (eventName === "generation:result-save-progress") {
        const info = payload as GenerationResultSaveProgress | null;
        if (info?.taskId && Number.isFinite(info.resultIndex) && Number.isFinite(info.received)) {
          setSaveProgressByResult((current) => ({
            ...current,
            [`${info.taskId}#${info.resultIndex}`]: info,
            [info.taskId]: info,
          }));
        }
        return;
      }
      if (eventName === "generation:result-ready" || eventName === "generation:result-saved") {
        const record = (payload as { result?: GenerationResultRecord } | null)?.result;
        if (record) {
          if (eventName === "generation:result-saved") {
            setSaveProgressByResult((current) => {
              if (
                !(record.taskId in current) &&
                !(`${record.taskId}#${record.resultIndex}` in current)
              ) {
                return current;
              }
              const next = { ...current };
              delete next[record.taskId];
              delete next[`${record.taskId}#${record.resultIndex}`];
              return next;
            });
          }
          setTaskResults((current) => ({
            ...current,
            [record.taskId]: [
              ...(current[record.taskId] ?? []).filter(
                (existing) => existing.resultIndex !== record.resultIndex,
              ),
              record,
            ],
          }));
          const rawPreviewSrc = (payload as { previewSrc?: unknown } | null)?.previewSrc;
          const previewSrc = typeof rawPreviewSrc === "string" ? rawPreviewSrc : null;
          const resultKey = `${record.taskId}#${record.resultIndex}`;
          if (previewSrc && eventName === "generation:result-ready") imageResultPreviewsRef.current.set(resultKey, previewSrc);
          if (eventName === "generation:result-saved") imageResultPreviewsRef.current.delete(resultKey);
          // 图片回填原节点；其他媒体沿用各自的结果展示。
          applyGenerationResult(
            record,
            eventName === "generation:result-ready" ? previewSrc : null,
          );
        }
      }
      if (eventName === "generation:polling-stopped") {
        /*
         * 自动查询已停止：任务状态仍是 running，所以必须显式记一笔，
         * 否则卡片永远转圈、用户既等不到结果也看不出该去手动查询。
         */
        const info = payload as { taskId?: string; reason?: unknown } | null;
        const taskId = info?.taskId;
        if (taskId) {
          setPollingStoppedTaskIds((current) => {
            if (current.has(taskId)) return current;
            const next = new Set(current);
            next.add(taskId);
            return next;
          });
          toast.info("自动查询已停止", {
            description:
              "这次生成已查询 10 分钟仍未拿到结果，自动查询已停止。可在任务历史里点「重新查询」继续获取结果。",
          });
        }
        return;
      }
      if (eventName === "generation:retry") {
        const info = payload as {
          taskId?: string;
          retry?: number;
          maxRetries?: number;
          delayMs?: number;
        } | null;
        if (info?.taskId && info.retry != null && info.maxRetries != null && info.delayMs != null) {
          setRetryInfoByTask((current) => ({
            ...current,
            [info.taskId as string]: {
              retry: info.retry as number,
              maxRetries: info.maxRetries as number,
              delayMs: info.delayMs as number,
            },
          }));
        }
      }
      void scheduleTasksRefresh();
    },
    [
      applyGenerationResult,
      scheduleTasksRefresh,
      setRetryInfoByTask,
      setSaveProgressByResult,
      setStreamingTextByNode,
      setTaskResults,
    ],
  );

  // 事件处理器每次渲染都会重建（依赖 applyGenerationResult → outputNodes），因此订阅
  // 必须经过 ref 转发：早期实现把处理器直接作为 effect 依赖，于是每次画布节点变化都会
  // 把 8 个事件监听全部退订再重新注册。而图片结果的 result-ready 与 result-saved 由后端
  // 在下载完成后几乎同一时刻连着发出，恰好落在重建窗口里的那次 save 事件会被静默吞掉——
  // 卡片就永远停在「正在保存本地副本」，后端其实早已把文件写进下载目录。
  // 订阅只注册一次，处理器始终读取最新闭包。
  const generationEventHandlerRef = useRef(handleGenerationEvent);
  useEffect(() => {
    generationEventHandlerRef.current = handleGenerationEvent;
  }, [handleGenerationEvent]);
  useEffect(() => {
    return subscribeGenerationEvents((eventName, payload) => {
      generationEventHandlerRef.current(eventName, payload);
    });
  }, []);

  // 拉取任务的完整原始返回（失败产物卡片展示完整原始错误）：
  // ref 去重避免重复请求；状态只在异步回调中更新。
  const rawResponseLoadsRef = useRef<Set<string>>(new Set());
  const loadRawResponse = useCallback((taskId: string) => {
    if (rawResponseLoadsRef.current.has(taskId)) return;
    rawResponseLoadsRef.current.add(taskId);
    void generationClient
      .get(taskId)
      .then((detail) => {
        const formatted = formatTaskRawResponse(detail);
        setRawResponses((cached) => ({
          ...cached,
          [taskId]: formatted ?? "该任务没有可展示的原始返回。",
        }));
      })
      .catch((error: unknown) => {
        setRawResponses((cached) => ({
          ...cached,
          [taskId]: formatRawBackendError(error),
        }));
      });
  }, []);

  // 各任务摘要按 id 索引（产物卡片按 taskId 关联实时状态）。
  const taskById = useMemo(() => {
    const map = new Map<string, GenerationTaskSummary>();
    for (const task of generationTasks) map.set(task.id, task);
    return map;
  }, [generationTasks]);

  /**
   * 后端已停止轮询的任务（`queryHealth === "degraded"`）。
   *
   * 与 `pollingStoppedTaskIds`（事件瞬时信号）合并使用：事件能立刻生效，
   * 持久化状态能跨重启兜底。两者取并集才是完整判据。
   */
  const degradedQueryTaskIds = useMemo(() => {
    const ids = new Set<string>();
    for (const task of generationTasks) {
      if (task.queryHealth === "degraded") ids.add(task.id);
    }
    return ids;
  }, [generationTasks]);
  /** 「自动查询已停止」的完整判据：事件 ∪ 后端持久化状态。 */
  const isPollingStopped = useCallback(
    (taskId: string) => pollingStoppedTaskIds.has(taskId) || degradedQueryTaskIds.has(taskId),
    [degradedQueryTaskIds, pollingStoppedTaskIds],
  );

  // 生成结果补发（兜底）：任务已经成功，但卡片始终没拿到本地文件路径。成因只有两类——
  // 事件通道漏掉了那一次 result-saved（监听重建窗口、应用切后台、页面重载都会造成），
  // 或结果落卡时这张卡片还不存在（图片结果下载很快，result-ready/result-saved 可能早于
  // 占位卡片落入画布）。两者都追不回事件，但事实还在后端：任务详情里的结果记录带着
  // finalPath。所以这里按任务拉一次详情，把后端真实状态对账进卡片；没就绪就退避重试。
  useEffect(() => {
    if (!isDesktopRuntime()) return;
    const inFlight = resultRescueInFlightRef.current;
    const attempts = resultRescueAttemptsRef.current;
    const waitingTaskIds = new Set<string>();
    const outputs = canvasNodesNow("output");
    for (const node of outputs) {
      if (node.finalPath != null) continue;
      // 组合/下载/白模等本地产物不是生成任务的结果投影，只对账生成产物卡片。
      if (node.origin != null && node.origin !== "generation") continue;
      const task = taskById.get(node.taskId);
      if (task?.status !== "succeeded") continue;
      // 有失败结果记录的卡片走「重试保存」按钮，不在这里反复拉取。
      if (
        taskResults[node.taskId]?.some((result) =>
          ["failed", "interrupted", "local_missing", "conflict"].includes(result.saveStatus),
        )
      ) {
        continue;
      }
      waitingTaskIds.add(node.taskId);
    }
    for (const node of canvasNodesNow("gen")) {
      if (node.kind !== "image") continue;
      for (const taskId of node.imageGeneration?.taskIds ?? []) {
        if (taskById.get(taskId)?.status !== "succeeded") continue;
        const records = taskResults[taskId] ?? [];
        const known = node.imageGeneration?.results.filter(result => result.taskId === taskId) ?? [];
        if (records.length === 0 ? known.length === 0 || known.some(result => !result.finalPath)
          : records.some(result => result.saveStatus === "pending" || result.saveStatus === "writing")) {
          waitingTaskIds.add(taskId);
        }
      }
    }
    // 已有本地结果的节点无需补发。
    for (const [taskId, timer] of [...inFlight]) {
      if (waitingTaskIds.has(taskId)) continue;
      window.clearTimeout(timer);
      inFlight.delete(taskId);
      attempts.delete(taskId);
    }
    for (const taskId of waitingTaskIds) {
      // 已排定待执行的重试不重复排期：effect 会随画布任何变化重跑，
      // 每次都重排就等于把退避取消掉。
      if (inFlight.has(taskId)) continue;
      const attempt = attempts.get(taskId) ?? 0;
      if (attempt >= RESULT_RESCUE_MAX_ATTEMPTS) continue;
      attempts.set(taskId, attempt + 1);
      // 首次立即补发（重启回填要保持即时响应），之后按 2s/4s/8s… 退避，最长 128s。
      const delay = attempt === 0 ? 0 : Math.min(2_000 * 2 ** (attempt - 1), 128_000);
      const timer = window.setTimeout(() => {
        inFlight.delete(taskId);
        void generationClient
          .get(taskId)
          .then((detail) => {
            setTaskResults(current => ({ ...current, [taskId]: detail.results }));
            const savedResults = detail.results.filter(
              (result) => result.saveStatus === "succeeded" && result.finalPath != null,
            );
            // 已经落好的结果也算「对账完成」：applyGenerationResult 对同一结果重复调用
            // 是空操作（幂等），这里必须把它算成成功，否则单任务多结果场景会被误判为
            // 一直没补齐，白白重试到上限。
            const landed = (record: GenerationResultRecord) => {
              const key = `${record.taskId}#${record.resultIndex}`;
              return canvasNodesNow("output").some(
                (node) => node.resultKey === key && node.finalPath === record.finalPath,
              );
            };
            let applied = false;
            for (const record of savedResults) {
              applied = applyGenerationResult(record) || applied;
            }
            const saving = detail.results.some(result => result.saveStatus === "pending" || result.saveStatus === "writing");
            if (!saving && (applied || savedResults.some(landed))) {
              attempts.delete(taskId);
              frontendLog(
                "info",
                `[canvas] 生成结果补发成功：任务已保存但卡片未收到事件，已按后端事实补齐本地路径: task=${taskId}`,
              );
            }
          })
          .catch((error: unknown) => {
            frontendLog(
              "warn",
              `[canvas] 生成结果补发查询失败，将重试: task=${taskId}, ${formatRawBackendError(error)}`,
            );
          });
      }, delay);
      inFlight.set(taskId, timer);
    }
  }, [outputCardSignature, imageGenerationSignature, canvasNodesNow, taskById, taskResults, applyGenerationResult, setTaskResults]);

  // 卸载时清理补发计时器。
  useEffect(() => {
    const inFlight = resultRescueInFlightRef.current;
    return () => {
      for (const timer of inFlight.values()) window.clearTimeout(timer);
      inFlight.clear();
    };
  }, []);

  // 旧画布首次升级时从后端任务身份恢复；复制节点的空 taskIds 不接收原节点的迟到结果。
  useEffect(() => {
    if (!canvasHydrated) return;
    const latest = new Map<string, GenerationTaskSummary>();
    for (const task of generationTasks) {
      if ((task.operation === "text_to_image" || task.operation === "image_to_image") && !latest.has(task.sourceNodeId)) latest.set(task.sourceNodeId, task);
    }
    for (const node of canvasNodesNow("gen")) {
      if (node.kind === "image" && !node.imageGeneration) {
        const task = latest.get(node.key);
        if (task) registerImageGeneration(node.key, [task.id]);
      }
    }
    // 覆盖结果事件早于 start 回执、重启后回读和保存事件补发三条路径。
    for (const node of canvasNodesNow("gen")) {
      if (node.kind !== "image") continue;
      for (const taskId of node.imageGeneration?.taskIds ?? []) {
        for (const result of taskResults[taskId] ?? []) applyGenerationResult(result);
      }
    }
  }, [canvasHydrated, generationTasks, taskResults, imageGenerationSignature, canvasNodesNow, registerImageGeneration, applyGenerationResult]);

  // 失败/中断的产物卡片自动加载完整原始返回（卡片内展示完整原始错误）。
  useEffect(() => {
    if (!isDesktopRuntime()) return;
    for (const node of canvasNodesNow("output")) {
      if (node.finalPath != null) continue;
      const task = taskById.get(node.taskId);
      if (!task) continue;
      if (isRunningTaskStatus(task.status) || task.status === "retry_wait") continue;
      if (
        task.status === "succeeded" &&
        !taskResults[node.taskId]?.some((result) =>
          ["failed", "interrupted", "local_missing", "conflict"].includes(result.saveStatus),
        )
      ) {
        continue;
      }
      if (rawResponses[node.taskId] == null) loadRawResponse(node.taskId);
    }
  }, [outputCardSignature, canvasNodesNow, taskById, taskResults, rawResponses, loadRawResponse]);

  const handleStartGeneration = useCallback(
    (nodeKey: string, options?: { readonly clientTaskId?: string }) => {
      if (startingNodeKeys.has(nodeKey) || mediaSubmissionGuardRef.current.has(nodeKey)) return;
      const liveCanvas = snapshotV2({});
      const draftNode = liveCanvas.genNodes.find((node) => node.key === nodeKey);
      if (!draftNode) return;
      const inputs = createCanvasInputResolver(canvasNodesByKeyFromDocument(liveCanvas), liveCanvas.assetEdges)(nodeKey);
      const genNode = generationWithLibraryResources(draftNode, inputs.libraryResources);
      // 提示词节点通过自身的文本模型按钮执行，不创建媒体生成任务。
      if (genNode.kind === "prompt") return;
      const isLongVideo = genNode.kind === "video" && genNode.config.videoMode === "longVideo2video";
      if (options?.clientTaskId && (isLongVideo || genNode.config.generationCount !== 1)) {
        setNodeStartError(nodeKey, "批量镜头任务必须使用单次生成，请检查节点设置。");
        return;
      }
      // 普通图片生成在本地建单后可继续提交。固定身份的批量任务、其他媒体和
      // 自动查询已停止的任务仍需先核对在途记录。
      const blockingTask = generationTasks.find(
        (task) => task.sourceNodeId === nodeKey && !isTerminalTaskStatus(task.status) &&
          (genNode.kind !== "image" || options?.clientTaskId != null || isPollingStopped(task.id)),
      );
      if (blockingTask != null) {
        setNodeStartError(
          nodeKey,
          isPollingStopped(blockingTask.id)
            ? "这次生成的自动查询已停止，上游可能仍在执行并计费。请先到任务历史里「重新查询」看结果，或「取消这个任务」后再重新生成。"
            : genNode.kind === "video" && genNode.config.greenScreen?.enabled
              ? "绿幕流程已有任务正在生成，请完成后检查选用，或在任务历史中取消后重做。"
              : "该节点已有任务正在生成，请等待完成，或在任务历史中取消后重做。",
        );
        return;
      }
      if (!isDesktopRuntime()) {
        setNodeStartError(nodeKey, "生成任务只能在桌面应用中发起。请通过 Tauri 桌面端运行。");
        return;
      }
      const isImageUpscale = genNode.kind === "image" && genNode.config.imageMode === "upscale";
      const upscaleSelection = isImageUpscale ? resolveImageUpscaler(providerCatalog, genNode.config.upscaleProviderId) : null;
      if (isImageUpscale && !upscaleSelection) {
        setNodeStartError(nodeKey, "请先在全局设置中配置 Atlas Cloud 连接，再选择高清服务供应商。");
        return;
      }
      const selection = upscaleSelection ? {providerId:upscaleSelection.provider.provider.id,modelDefinitionId:upscaleSelection.model.definitionId} : genNode.config.modelSelection;
      if (!selection?.providerId || !selection?.modelDefinitionId) {
        setNodeStartError(
          nodeKey,
          genNode.kind === "video"
            ? "请先在当前视频节点卡片中选择供应商和模型。"
            : genNode.kind === "audio"
              ? "请先在当前音频节点卡片中选择供应商和语音模型。"
              : "请先在当前图片节点卡片中选择供应商和模型。",
        );
        return;
      }

      const connectedAssets = inputs.media;
      // 万相 3.0 URL 素材（文档 file / 网页 link）：随节点配置保存，不在画布连线上。
      const urlMedia: readonly VideoUrlMediaInput[] =
        genNode.kind === "video" ? (genNode.config.urlMedia ?? []) : [];
      const urlConnections: PromptContentConnection[] = urlMedia.map((input) => ({
        key: `url:${input.id}`,
        name: input.label,
        // file/link 素材在请求体中只表达 type 与 url，类型仅占位，不参与图N引用编号。
        kind: "image",
        target: { kind: "url", url: input.url, mediaType: "image" },
        role: input.role,
      }));
      let connections: PromptContentConnection[] = [
        ...connectedAssets.map((input) => ({
          ...input,
          role: genNode.kind === "video" ? (genNode.config.mediaRoles?.[input.key] ?? "") : "",
        })),
        ...urlConnections,
      ];
      const storedPromptDocument = promptContents.snapshotAll(new Set([nodeKey]))[nodeKey];
      // A mark pins the actual image that was recognized, including the node's
      // own previous result. Replacing the preview must not retarget that mark.
      if (genNode.kind === "image" && !isImageUpscale) {
        const referencedMarks = new Set(storedPromptDocument?.items.flatMap(item => item.kind === "mark_reference" ? [item.markId] : []));
        for (const mark of genNode.config.imageMarks ?? []) {
          if (!referencedMarks.has(mark.id) || connections.some(input => input.target.kind !== "url" && sameMediaReferenceTarget(input.target, mark.sourceTarget))) continue;
          connections.push({ key: `image-mark-source:${mark.id}`, name: mark.sourceName, kind: "image", target: mark.sourceTarget, role: "" });
        }
      }
      const hasMediaInput = connections.some(input => input.kind === "image" || input.kind === "video");
      const videoMode = genNode.kind === "video" ? genNode.config.videoMode ?? genNode.config.seedanceTaskMode : undefined;
      const promptDocument = storedPromptDocument && genNode.kind === "video"
        ? videoPromptForMode(storedPromptDocument, videoMode)
        : storedPromptDocument;
      const hasPromptMedia = promptDocument?.items.some(item =>
        item.kind === "media_reference"
          ? item.target.mediaType === "image" || item.target.mediaType === "video"
          : item.kind === "attachment" && (item.mediaType === "image" || item.mediaType === "video"),
      ) ?? false;
      const operation: GenerationOperation =
        genNode.kind === "video"
          ? "video_generation"
          : genNode.kind === "audio"
            ? "speech_generation"
            : hasMediaInput || hasPromptMedia || isImageUpscale || (genNode.kind === "image" && genNode.config.styleReference != null)
              ? "image_to_image"
              : "text_to_image";
      const resolvedSelection = upscaleSelection ?? resolveGenerationSelection(
        genNode.kind,
        selection,
        providerCatalog,
      );
      if (!resolvedSelection) {
        setNodeStartError(
          nodeKey,
          genNode.kind === "video"
            ? "当前视频节点所选供应商或模型不可用，请在节点卡片中重新选择。"
            : genNode.kind === "audio"
              ? "当前音频节点所选供应商或模型不支持语音生成，请在节点卡片中重新选择。"
              : `当前图片节点所选供应商或模型不支持${operation === "image_to_image" ? "图片参考生成" : "文生图"}，请在节点卡片中重新选择。`,
        );
        return;
      }

      if (genNode.kind === "video") {
        // Keep every configured input. Cached model profiles cannot veto the request,
        // and an adapter must report media it cannot represent rather than discard it.
        const publicUrlInputs = genNode.config.perTaskUrlMedia ?? [];
        const urlIssue = perTaskVideoUrlIssue(publicUrlInputs);
        if (urlIssue) {
          setNodeStartError(nodeKey, urlIssue);
          return;
        }
        connections = [...connections, ...publicUrlInputs.map(perTaskVideoUrlConnection)];
      }
      if (genNode.kind === "audio") {
        /*
         * 音频节点只吃**一段**音频作为音色参考。
         *
         * 后端也会拒（media.rs 的 speech 分支），但前端先拦一道：用户看到的是
         * 「解绑哪个素材」而不是一句后端返回的校验失败。
         */
        const foreignReferences = connections.filter(
          (connection) => connection.target.mediaType !== "audio",
        );
        if (foreignReferences.length > 0) {
          setNodeStartError(
            nodeKey,
            "音频节点只接受音频素材作为音色参考，请先解绑图片或视频素材。",
          );
          return;
        }
        if (connections.length > 1) {
          setNodeStartError(
            nodeKey,
            "音频节点最多只能引用 1 段参考音频，请先解绑多余的素材。",
          );
          return;
        }
      }
      const parameterCapabilities = modelParameterCapabilities(
        resolvedSelection.model.operationSchema,
        operation,
        resolvedSelection.model.remoteModelId,
      );
      const videoIntent = genNode.kind === "video" && genNode.config.videoMode
        ? compileCanvasVideoMode(genNode.config.videoMode, connections, genNode.config.mediaRoles)
        : null;
      if (videoIntent) connections = connections.map(connection => ({ ...connection, role: videoIntent.mediaRoles[connection.key] ?? connection.role ?? "" }));
      const greenScreen =
        !isLongVideo && genNode.kind === "video" && genNode.config.greenScreen?.enabled
          ? genNode.config.greenScreen
          : null;
      if (greenScreen && genNode.kind === "video" && genNode.config.whiteModelControl?.enabled) {
        setNodeStartError(nodeKey, "绿幕流程与白模控制不能同时启用，请关闭其中一项后生成。");
        return;
      }
      const greenScreenPreparation = greenScreen
        ? prepareGreenScreenGeneration(
            greenScreen,
            connections,
            resolvedSelection.model.remoteModelId,
            promptDocument,
          )
        : null;
      if (greenScreenPreparation?.issue) {
        setNodeStartError(nodeKey, greenScreenPreparation.issue);
        return;
      }
      if (greenScreenPreparation) connections = [...greenScreenPreparation.connections];
      const greenScreenSignature =
        greenScreen && genNode.kind === "video" && greenScreen.phase === "prepare"
          ? greenScreenNodeSignature(genNode.config, promptDocument)
          : null;
      const seedanceTask =
        genNode.kind === "video"
          ? resolveSeedanceTask(
              resolvedSelection.model.remoteModelId,
              parameterCapabilities,
              greenScreenPreparation
                ? { ...genNode.config, seedanceTaskMode: greenScreenPreparation.taskMode }
                : videoIntent ? { ...genNode.config, seedanceTaskMode: videoIntent.taskMode, mediaRoles: videoIntent.mediaRoles } : genNode.config,
              seedanceTaskInputs(connections),
              resolvedSelection.model.operationSchema,
            )
          : null;
      if (seedanceTask?.issue) {
        setNodeStartError(nodeKey, seedanceTask.issue);
        return;
      }
      if (seedanceTask?.enabled) {
        connections = connections.map((connection) => ({
          ...connection,
          role: seedanceTask.mediaRoles[connection.key] ?? connection.role ?? "",
        }));
      }
      const whiteModel =
        !isLongVideo && genNode.kind === "video" && genNode.config.whiteModelControl?.enabled
          ? prepareWhiteModelGeneration(
              genNode.config.whiteModelControl,
              connections,
              resolvedSelection.model.remoteModelId,
              seedanceTask?.mode ?? "auto",
              promptDocument,
            )
          : null;
      if (whiteModel?.issue) {
        setNodeStartError(nodeKey, whiteModel.issue);
        return;
      }
      // Media-only acceptance is a remote capability, not a cached catalog policy.
      /*
       * 音频节点例外：语音合成的**内容就是正文**，只有一段音色参考而没有正文
       * 是一次「合成空字符串」——既没有产物，又已经付了费。所以这里要求有正文。
       */
      const allowMediaOnly = genNode.kind !== "audio";
      const panorama =
        genNode.kind === "image" && !isImageUpscale && genNode.config.panoramaEnabled
          ? preparePanoramaGeneration(promptDocument, connections, allowMediaOnly)
          : null;
      if (panorama?.issue) {
        setNodeStartError(nodeKey, panorama.issue);
        return;
      }
      const storyboardConfig = genNode.kind === "video" ? genNode.config.storyboard : null;
      if (genNode.kind === "video" && (genNode.config.effectVersionIds?.length ?? 0) > MAX_VIDEO_EFFECTS) {
        setNodeStartError(nodeKey, `最多使用 ${MAX_VIDEO_EFFECTS} 个视频特效，请移除多余特效。`);
        return;
      }
      if (genNode.kind === "video" && genNode.config.effectVersionIds?.length && hasVideoCameraPreset(storedPromptDocument)) {
        setNodeStartError(nodeKey, VIDEO_CAMERA_EFFECT_CONFLICT);
        return;
      }
      if (genNode.kind === "video" && genNode.config.effectVersionIds?.length && videoCameraPresetsMuted(videoMode)) {
        setNodeStartError(nodeKey, "当前生成模式不支持已选特效，请移除特效或切换生成模式。");
        return;
      }
      if (genNode.kind === "video" && genNode.config.effectVersionIds?.length && (storyboardConfig?.enabled || isLongVideo)) {
        setNodeStartError(nodeKey, "特效模板不能与智能分镜或长视频规划同时使用，请移除特效或切回普通视频模式。");
        return;
      }
      if (storyboardConfig?.enabled && (isLongVideo || greenScreen || whiteModel || connections.some(input => input.kind === "video"))) {
        setNodeStartError(nodeKey, "智能分镜不能与长视频、绿幕、白模控制或视频参考同时使用，请关闭智能分镜或移除冲突设置。");
        return;
      }
      const storyboardDurationKey = parameterCapabilities.find(item => /^(duration|duration_seconds|seconds)$/.test(item.key))?.key ?? "duration";
      const storyboardParameters = generationParameters(parameterCapabilities, genNode.config.parameterValues, connections.length > 0);
      const storyboard = storyboardConfig?.enabled ? prepareVideoStoryboard(storyboardConfig, resolvedSelection.model.remoteModelId, Number(storyboardParameters[storyboardDurationKey] ?? 5), connections, genNode.config.autoLink !== false, videoMode) : null;
      if (storyboard?.issue) { setNodeStartError(nodeKey, storyboard.issue); return; }
      let preparedPrompt = storyboard?.preparation ?? (greenScreenPreparation
        ? greenScreenPreparation.preparation
        : whiteModel
          ? whiteModel.preparation
          : panorama
            ? panorama.preparation
            : (genNode.kind === "video" ? prepareVideoPromptForMode(storedPromptDocument, videoMode, {
                connections,
                allowMediaOnly,
                autoLink: genNode.config.autoLink !== false,
              }) : null) ?? promptContents.prepareGeneration(nodeKey, {
                connections,
                allowMediaOnly,
                autoLink: genNode.config.autoLink !== false,
              }));
      if (genNode.kind === "video" && genNode.config.effectVersionIds?.length && preparedPrompt && !preparedPrompt.ok && preparedPrompt.issues.every(issue => issue.kind === "empty_prompt")) {
        const text = "根据所选特效模板生成视频。";
        preparedPrompt = { ok: true, frozen: { segments: [{ kind: "text", text }], explicitMedia: [], mentionedCanvasNodeKeys: new Set<string>(), plainText: text } };
      }
      if (preparedPrompt == null || !preparedPrompt.ok) {
        const issue = preparedPrompt?.issues[0] ?? ({ kind: "empty_prompt" } as const);
        setNodeStartError(nodeKey, promptContentIssueMessage(issue));
        promptContents.focusIssue(nodeKey, issue);
        return;
      }
      const promptSegments = preparedPrompt.frozen.segments;
      const explicitMedia = preparedPrompt.frozen.explicitMedia;
      if (genNode.kind === "audio") {
        /*
         * 语音合成必须**有要念的文字**。
         *
         * `prepareGeneration` 把「正文里 @ 引用了素材」也算作有内容，但音频节点的
         * @引用是**音色参考**，不是要念的内容 —— 只写一个 @引用就提交，等于合成
         * 一段空音频（付了费、拿不到东西）。这里按「文本片段里有没有字」再判一道。
         */
        const hasSpeakableText = promptSegments.some(
          (segment) => segment.kind === "text" && segment.text.trim().length > 0,
        );
        if (!hasSpeakableText) {
          const issue = { kind: "empty_prompt" } as const;
          setNodeStartError(nodeKey, promptContentIssueMessage(issue));
          promptContents.focusIssue(nodeKey, issue);
          return;
        }
      }

      setNodeStartError(nodeKey, null);
      const submittedAt = Date.now();
      mediaSubmissionGuardRef.current.add(nodeKey);
      setStartingNodeKeys((current) => new Set(current).add(nodeKey));
      /*
       * 音频节点的参数走自己的键（与原站 liblib 的请求体同名）：
       * language / sample_rate / format / voice_setting_speed / voice_setting_pitch /
       * voice_setting_vol。后端按名字显式取（网关 TTS 契约里没有 language 项，
       * 那一项会被忽略），所以这里**不能**过 `generationParameters` 的能力白名单 ——
       * 白名单只保留模型 Schema 声明过的键，会把这六个全部筛掉。
       */
      const parameters: Record<string, unknown> =
        genNode.kind === "audio"
          ? {
              ...generationParameters(
                parameterCapabilities,
                genNode.config.parameterValues,
                connections.length > 0,
              ),
              language: genNode.config.language,
              sample_rate: genNode.config.sampleRate,
              format: genNode.config.format,
              voice_setting_speed: genNode.config.voiceSettingSpeed,
              voice_setting_pitch: genNode.config.voiceSettingPitch,
              voice_setting_vol: genNode.config.voiceSettingVolume,
            }
          : seedanceTask?.enabled
            ? seedanceTask.parameters
            : generationParameters(
                parameterCapabilities,
                genNode.kind === "image" && genNode.config.panoramaEnabled
                  ? {
                      ...genNode.config.parameterValues,
                      ...preferredPanoramaParameters(parameterCapabilities),
                    }
                  : genNode.config.parameterValues,
                connections.length > 0,
              );
      // GPT-Image 契约的模型支持 `n` 参数：一次请求生成 n 张图片，不再拆分任务。
      if (storyboard) {
        parameters["__canvas_storyboard"] = storyboard.ranges;
        parameters[storyboardDurationKey] ??= 5;
      }
      if (genNode.kind === "video" && genNode.config.effectVersionIds?.length) parameters["__canvas_effects"] = genNode.config.effectVersionIds;
      // 其余供应商 API 无数量参数：数量 > 1 时拆分为 N 个独立任务（每个任务数量 1），
      // 每个任务对应一张占位产物卡片，单独展示状态与执行细节。
      const batchCountCapability = parameterCapabilities.find(
        (capability) => capability.key === "n" && capability.type === "integer",
      );
      const supportsBatchCount = batchCountCapability != null;
      // 远端 n 是一次请求：上限取**契约声明的 maximum**（契约没声明才不设限）。
      const countMaximum =
        batchCountCapability?.maximum ??
        (supportsBatchCount ? Number.MAX_SAFE_INTEGER : MAX_GENERATION_COUNT);
      // 语音合成一次只产出一段音频：数量恒为 1，拆成多个任务只是重复扣费。
      const generationCount =
        genNode.kind === "audio" || isImageUpscale
          ? 1
          : Math.min(countMaximum, Math.max(1, Math.floor(genNode.config.generationCount) || 1));
      if (supportsBatchCount) {
        parameters["n"] = generationCount;
      }
      const taskCount = isLongVideo || supportsBatchCount ? 1 : generationCount;
      frontendLog(
        "info",
        `[generation] 发起画布生成: node=${nodeKey}（${genNode.kind}）, operation=${operation}, 提示词片段 ${promptSegments.length} 个（含 ${promptSegments.filter((s) => s.kind === "media_reference").length} 个 @引用）, 显式媒体输入 ${explicitMedia.length} 个, 生成数量 ${generationCount}${supportsBatchCount ? `（作为 n 参数一次请求提交）` : `（拆分为 ${taskCount} 个任务）`}`,
      );
      const startErrors: string[] = [];
      const startedTaskIds: string[] = [];
      const submissions: Promise<unknown>[] = [];
      // Share one import/review run across every output. A failed review never reaches start_generation.
      const verificationLibraries = providerCatalog.filter(entry => entry.provider.enabled && providerSupportsAssetLibrary(entry.provider));
      const verificationProviderId = genNode.kind === "video"
        ? genNode.config.verificationProviderId ?? verificationLibraries.find(entry => entry.provider.id === selection.providerId)?.provider.id ?? verificationLibraries[0]?.provider.id ?? null
        : null;
      const preparedMaterials = genNode.kind === "video" && genNode.config.autoVerifyMaterials !== false
        ? verifyGenerationMaterials(promptSegments, explicitMedia, verificationProviderId)
        : Promise.resolve({ prompt: promptSegments, explicitMedia });
      let remaining = taskCount;
      const settleOne = () => {
        remaining -= 1;
        if (remaining > 0) return;
        mediaSubmissionGuardRef.current.delete(nodeKey);
        setStartingNodeKeys((current) => {
          const next = new Set(current);
          next.delete(nodeKey);
          return next;
        });
        if (startErrors.length > 0) {
          setNodeStartError(
            nodeKey,
            startErrors.length === taskCount
              ? `${taskCount} 个生成任务全部创建失败：${startErrors[0]}`
              : `${startErrors.length}/${taskCount} 个生成任务创建失败：${startErrors[0]}`,
          );
        }
      };
      if (isLongVideo && genNode.kind === "video") {
        const settings = resolveLongVideoSettings(genNode.config.longVideo, providerCatalog);
        // 单片段时长夹到模型真正允许的档位：后端会再夹一次（冻结档案才是权威），
        // 前端先夹是为了让「镜头数」和实际请求一致。
        const durationCapability = parameterCapabilities.find(capability => /^(duration|duration_seconds|seconds)$/.test(capability.key));
        const durationParameter = durationCapability?.key ?? "duration";
        const longSettings = { ...settings, segmentSeconds: resolveLongVideoSegmentSeconds(durationCapability, settings.segmentSeconds) };
        return preparedMaterials.then(async materials => {
          const currentNode = snapshotV2({}).genNodes.find(node => node.key === nodeKey);
          if (currentNode?.kind !== "video") throw new Error("素材准备期间原长视频节点已移除，本次没有提交生成。");
          const generation: StartGenerationCommand = {
            canvasId, sourceNodeId: nodeKey, ...(genNode.name ? { outputName: genNode.name } : {}),
            operation: "video_generation", providerConnectionId: selection.providerId, modelDefinitionId: selection.modelDefinitionId,
            prompt: materials.prompt, explicitMedia: materials.explicitMedia,
            parameters: { ...parameters, [durationParameter]: longSettings.segmentSeconds }, generationCount: 1,
          };
          const fingerprint = JSON.stringify({ settings: longSettings, durationParameter, generation });
          const requestId = currentNode.config.longVideoRequest?.fingerprint === fingerprint ? currentNode.config.longVideoRequest.id : crypto.randomUUID();
          patchNode("gen", nodeKey, node => node.kind === "video" ? { ...node, config: { ...node.config, longVideoRequest: { id: requestId, fingerprint } } } : node);
          const job = await longVideoClient.start({ ...longSettings, durationParameter, generation, requestId });
          patchNode("gen", nodeKey, node => node.kind === "video" && node.config.longVideoRequest?.id === requestId ? { ...node, config: { ...node.config, longVideoRequest: null } } : node);
          window.dispatchEvent(new CustomEvent("canvas:long-video-created", { detail: { canvasId, jobId: job.id } }));
          return { taskIds: [job.id], errors: [] as string[] };
        }).catch((error: unknown) => {
          startErrors.push(backendErrorMessage(error));
          return { taskIds: [] as string[], errors: startErrors };
        }).finally(settleOne);
      }
      for (let index = 0; index < taskCount; index += 1) {
        const outputName = genNode.name
          ? taskCount > 1
            ? `${genNode.name}_${String(index + 1).padStart(2, "0")}`
            : genNode.name
          : null;
        const submission = preparedMaterials
          .then(materials => {
            const currentNode = snapshotV2({}).genNodes.find(node => node.key === nodeKey);
            if (currentNode?.kind !== genNode.kind) {
              throw new Error("素材准备期间原生成节点已移除，本次没有提交生成。");
            }
            const command: StartGenerationCommand = {
            ...(options?.clientTaskId ? { clientTaskId: options.clientTaskId } : {}),
            canvasId: canvasId,
            sourceNodeId: nodeKey,
            ...(outputName ? { outputName } : {}),
            operation,
            providerConnectionId: selection.providerId,
            modelDefinitionId: selection.modelDefinitionId,
            prompt: materials.prompt,
            explicitMedia: materials.explicitMedia,
            parameters,
            ...(seedanceTask?.enabled ? { videoTaskType: seedanceTask.mode } : videoIntent ? { videoTaskType: videoIntent.taskMode } : {}),
            generationCount: 1,
            };
            return genNode.kind === "image"
              ? canvasImageClient.start({
                  generation: command,
                  mode: isImageUpscale ? "upscale" : "auto",
                  ...(isImageUpscale ? { upscaleScale: genNode.config.upscaleScale ?? 2 } : {}),
                  ...(!isImageUpscale && genNode.config.styleReference ? { styleReference: genNode.config.styleReference } : {}),
                  ...(genNode.config.imagePreset ? { preset: genNode.config.imagePreset } : {}),
                  ...(genNode.config.cameraControl?.enabled === true ? { cameraControl: genNode.config.cameraControl } : {}),
                  ...(genNode.config.panoramaEnabled ? { panorama: true } : {}),
                })
              : generationClient.start(command);
          })
          .then((taskId) => {
            startedTaskIds.push(taskId);
            const placeholderCount = supportsBatchCount
              ? Math.min(generationCount, GPT_IMAGE_MAX_GENERATION_COUNT)
              : 1;
            const publish = () => {
              if (genNode.kind === "image") {
                registerImageGeneration(nodeKey, startedTaskIds, submittedAt, placeholderCount);
                return;
              }
              if (options?.clientTaskId && canvasNodesOfState(canvasStore.getState(), "output").some((output) => output.taskId === taskId)) return;
              if (greenScreenSignature) {
                patchNode("gen", nodeKey, (node) =>
                  node.kind === "video" && node.config.greenScreen
                    ? {
                        ...node,
                        config: {
                          ...node.config,
                          greenScreen: {
                            ...node.config.greenScreen,
                            preparationTasks: [
                              ...node.config.greenScreen.preparationTasks,
                              { taskId, signature: greenScreenSignature },
                            ],
                          },
                        },
                      }
                    : node,
                );
              }
              // 任务创建成功 → 立即在来源生成节点右侧落下占位产物卡片并连虚线，
              // 卡片承担任务状态栏职责：进行中展示进度，成功填充产物，失败展示完整错误。
              // 支持 n 参数的模型一次请求返回多张图：生成开始时就落下与数量相等的占位卡片，
              // 每个卡片预设 resultKey=taskId#index，结果返回后按 index 原地填充。
              // 编号必须与后端结果索引保持一致（1 起）：错位会让占位卡片永远匹配不到结果，
              // 同一次生成既留下永远等待保存的卡片，又多出一张重复产物卡片。
              for (let resultIndex = 1; resultIndex <= placeholderCount; resultIndex += 1) {
                const key = outputNodeKey();
                addOutput((current, nodesById) => ({
                  key,
                  resultKey: supportsBatchCount ? `${taskId}#${resultIndex}` : null,
                  sourceNodeId: genNode.key,
                  taskId,
                  mediaType:
                    genNode.kind === "video"
                      ? "video"
                      : genNode.kind === "audio"
                        ? "audio"
                        : "image",
                  finalPath: null,
                  previewSrc: null,
                  name: outputName
                    ? placeholderCount > 1
                      ? `${outputName}_${String(resultIndex).padStart(2, "0")}`
                      : outputName
                    : null,
                  ...nextOutputSlot(
                    currentOutputSource(nodesById, "gen", genNode),
                    current,
                    outputPlacementOptionsFor(nodesById, genNode.key),
                  ),
                }));
              }
            };
            publish();
            frontendLog(
              "info",
              genNode.kind === "image"
                ? `[canvas] 图片任务已绑定原节点: task=${taskId}, node=${nodeKey}`
                : `[canvas] 已创建生成占位产物卡片: task=${taskId}, 数量=${placeholderCount}`,
            );
            return refreshTasks();
          })
          .catch((error: unknown) => {
            startErrors.push(backendErrorMessage(error));
          })
          .finally(settleOne);
        submissions.push(submission);
      }
      return Promise.all(submissions).then(() => ({
        taskIds: startedTaskIds,
        errors: startErrors,
      }));
    },
    [
      canvasId,
      canvasStore,
      snapshotV2,
      patchNode,
      generationTasks,
      registerImageGeneration,
      isPollingStopped,
      providerCatalog,
      promptContents,
      refreshTasks,
      setNodeStartError,
      startingNodeKeys,
      addOutput,
      outputPlacementOptionsFor,
    ],
  );

  /** 历史重新生成仍创建新任务；图片回填来源节点，其他媒体沿用各自的占位机制。 */
  const regenerateGenerationFromHistory = useCallback(
    async (command: StartGenerationCommand): Promise<string> => {
      const genNode =
        command.canvasId === canvasId
          ? canvasNodesNow("gen").find((node) => node.key === command.sourceNodeId)
          : undefined;
      // 支持 n 参数的模型一次请求返回多张图；其余模型数量 > 1 时拆分为多个独立任务。
      const supportsBatchCount =
        typeof command.parameters?.["n"] === "number" && command.parameters["n"] > 1;
      const taskCount = supportsBatchCount ? 1 : Math.max(1, command.generationCount ?? 1);
      let firstTaskId = "";
      const imageTaskIds: string[] = [];
      const submittedAt = Date.now();

      for (let taskIndex = 0; taskIndex < taskCount; taskIndex += 1) {
        const taskCommand = supportsBatchCount ? command : { ...command, generationCount: 1 };
        const taskId = await generationClient.start(taskCommand);
        if (taskIndex === 0) firstTaskId = taskId;

        if (genNode?.kind === "image") {
          imageTaskIds.push(taskId);
          registerImageGeneration(genNode.key, imageTaskIds, submittedAt);
        } else if (genNode != null) {
          if (supportsBatchCount) {
            // 单任务多结果：创建 n 个占位卡片，每个预设 resultKey=taskId#index（索引 1 起，
            // 与后端结果索引同一套编号）。
            const batchCount = Math.min(
              GPT_IMAGE_MAX_GENERATION_COUNT,
              Math.floor(command.parameters["n"] as number),
            );
            for (let resultIndex = 1; resultIndex <= batchCount; resultIndex += 1) {
              const key = outputNodeKey();
              addOutput((current, nodesById) => ({
                key,
                resultKey: `${taskId}#${resultIndex}`,
                sourceNodeId: genNode.key,
                taskId,
                mediaType: command.operation === "video_generation" ? "video" : "image",
                finalPath: null,
                previewSrc: null,
                name: command.outputName
                  ? `${command.outputName}_${String(resultIndex).padStart(2, "0")}`
                  : null,
                ...nextOutputSlot(
                  currentOutputSource(nodesById, "gen", genNode),
                  current,
                  outputPlacementOptionsFor(nodesById, genNode.key),
                ),
              }));
            }
            frontendLog(
              "info",
              `[canvas] 历史重新生成已创建占位产物卡片: task=${taskId} node=${genNode.key} 数量=${batchCount}（单任务多结果）`,
            );
          } else {
            // 多任务：每个任务一个占位卡片
            const key = outputNodeKey();
            addOutput((current, nodesById) => ({
              key,
              resultKey: null,
              sourceNodeId: genNode.key,
              taskId,
              mediaType: command.operation === "video_generation" ? "video" : "image",
              finalPath: null,
              previewSrc: null,
              name: command.outputName ?? null,
              ...nextOutputSlot(
                currentOutputSource(nodesById, "gen", genNode),
                current,
                outputPlacementOptionsFor(nodesById, genNode.key),
              ),
            }));
            frontendLog(
              "info",
              `[canvas] 历史重新生成已创建占位产物卡片: task=${taskId} node=${genNode.key}（任务 ${taskIndex + 1}/${taskCount}）`,
            );
          }
        } else {
          frontendLog(
            "info",
            `[canvas] 历史重新生成未找到来源节点，仅保留任务记录: task=${taskId} node=${command.sourceNodeId}`,
          );
        }
      }
      refreshTasks();
      return firstTaskId;
    },
    [canvasId, addOutput, canvasNodesNow, refreshTasks, outputPlacementOptionsFor, registerImageGeneration],
  );

  const promoteSeedanceDraftFromHistory = useCallback(
    async (draft: GenerationTaskDetail): Promise<string> => {
      const taskId = await promoteSeedanceDraft(draft.summary.id);
      const sourceNode =
        draft.summary.canvasId === canvasId
          ? canvasNodesNow("gen").find((node) => node.key === draft.summary.sourceNodeId)
          : undefined;
      if (sourceNode) {
        // The paid task already exists; a delayed summary must not make submission look failed.
        const task = await generationClient.getProgress(taskId).catch(() => null);
        const savedResult = task?.results.find(
          (result) =>
            result.mediaType === "video" && result.saveStatus === "succeeded" && result.finalPath,
        );
        if (!canvasNodesNow("output").some((node) => node.taskId === taskId)) {
          addOutput((current, nodesById) => ({
            key: outputNodeKey(),
            resultKey: savedResult ? `${taskId}#${savedResult.resultIndex}` : null,
            sourceNodeId: sourceNode.key,
            taskId,
            mediaType: "video",
            finalPath: savedResult?.finalPath ?? null,
            previewSrc: null,
            name: task?.summary.outputName ?? `${draft.summary.outputName ?? "草稿样片"}_正片`,
            ...nextOutputSlot(
              currentOutputSource(nodesById, "gen", sourceNode),
              current,
              outputPlacementOptionsFor(nodesById, sourceNode.key),
            ),
          }));
        }
      }
      refreshTasks();
      return taskId;
    },
    [canvasId, canvasNodesNow, addOutput, outputPlacementOptionsFor, refreshTasks],
  );

  const promoteSeedanceDraftFromCanvas = useCallback(async (taskId: string) => {
    const draft = await generationClient.get(taskId);
    if (!canPromoteSeedanceDraft(draft)) throw new Error("这个任务不是可转正片的已完成样片。");
    return promoteSeedanceDraftFromHistory(draft);
  }, [promoteSeedanceDraftFromHistory]);

  // 各生成节点的活动任务与最近成功结果（按 sourceNodeId = 节点 key 关联）。
  const activeTaskByNode = useMemo(() => {
    const map = new Map<string, GenerationTaskSummary>();
    for (const task of generationTasks) {
      if (isTerminalTaskStatus(task.status)) continue;
      /*
       * 自动查询已停止的任务不算「在途」。
       *
       * 后端停止轮询（PixVerse 达 10 分钟上限 / 自动重试耗尽）但**任务状态仍是
       * running**（`ChangeQueryHealth` 只改 query_health 不改 status），于是卡片会
       * 永远转圈、用户等不到结果也看不出该去手动查询。这里把它排除出「在途」，
       * 卡片改按「查询已停止」渲染。
       *
       * 判据是「事件 ∪ 后端持久化的 degraded」—— 只靠事件的话，重启应用后
       * 事件集合是空的，任务会被重新当成在途，卡片又开始永久转圈。
       */
      if (isPollingStopped(task.id)) continue;
      if (!map.has(task.sourceNodeId)) map.set(task.sourceNodeId, task);
    }
    return map;
  }, [generationTasks, isPollingStopped]);
  const tasksBySourceNode = useMemo(() => {
    const groups = new Map<string, GenerationTaskSummary[]>();
    for (const task of generationTasks) {
      const items = groups.get(task.sourceNodeId) ?? [];
      items.push(task);
      groups.set(task.sourceNodeId, items);
    }
    return groups;
  }, [generationTasks]);

  const restoreImageFromHistory = useCallback(async (detail: GenerationTaskDetail, result: GenerationResultRecord): Promise<void> => {
    if (result.taskId !== detail.summary.id || result.mediaType !== "image") throw new Error("请选择该任务的图片结果。");
    const imageGeneration = restoreImageNodeGeneration(detail.summary.id, detail.results, result.resultIndex);
    const images = canvasNodesNow("gen").filter(node => node.kind === "image");
    const target = (detail.summary.canvasId === canvasId ? images.find(node => node.key === detail.summary.sourceNodeId) : undefined)
      ?? images.find(node => node.imageGeneration?.results.some(saved => saved.resultKey === imageGeneration.selectedResultKey));
    if (target) {
      if (startingNodeKeys.has(target.key) || mediaSubmissionGuardRef.current.has(target.key) || activeTaskByNode.has(target.key))
        throw new Error("该图片节点正在生成，请等待完成后再恢复历史结果。");
      patchNode("gen", target.key, node => node.kind === "image" ? { ...node, imageGeneration } : node);
      setNodeStartError(target.key, null);
      selectNode(target.key);
    } else {
      const position = viewportCenterBoardCoordinates();
      const node = createGenNode("image", position.x, position.y);
      if (node.kind !== "image" || insertSubgraph([{ type: "gen", data: { ...node, imageGeneration,
        name: detail.summary.outputName ?? result.displayName ?? "图片节点" } }], [], { selectNodeKey: node.key }) !== "applied")
        throw new Error("图片未能添加到画布，请重试。");
    }
    setNodeMarquee(false);
    setMarqueeNodeKeys(new Set());
    selectEdge(null);
    setHistoryOpen(false);
    setHistoryInitialTaskId(null);
    toast.success(target ? "历史图片已恢复到原节点" : "历史图片已添加到画布");
  }, [canvasId, canvasNodesNow, startingNodeKeys, activeTaskByNode, patchNode, setNodeStartError,
    selectNode, selectEdge, viewportCenterBoardCoordinates, createGenNode, insertSubgraph]);

  const latestTaskByNode = useMemo(() => {
    const map = new Map<string, GenerationTaskSummary>();
    for (const task of generationTasks) {
      if (!map.has(task.sourceNodeId)) map.set(task.sourceNodeId, task);
    }
    return map;
  }, [generationTasks]);

  const imageSaveErrorsByNode = useMemo(() => {
    const errors = new Map<string, string>();
    for (const node of canvasNodesNow("gen")) {
      if (node.kind !== "image") continue;
      const failed = node.imageGeneration?.taskIds.flatMap(taskId => taskResults[taskId] ?? []).find(result =>
        ["failed", "interrupted", "local_missing", "conflict"].includes(result.saveStatus));
      if (failed) errors.set(node.key, `图片已生成，但本地保存未完成：${backendErrorMessage(failed.error ?? failed.saveStatus)}。请在生成历史中重试保存。`);
    }
    return errors;
  }, [taskResults, imageGenerationSignature, canvasNodesNow]);

  const latestResult = useMemo(() => {
    const canvasTaskIds = new Set(generationTasks.map((task) => task.id));
    for (const node of canvasNodesOfState(canvasStore.getState(), "output")) {
      if (node.taskId) canvasTaskIds.add(node.taskId);
    }
    const results = Object.values(taskResults)
      .flat()
      .filter(
        (result) =>
          canvasTaskIds.has(result.taskId) && result.saveStatus === "succeeded" && result.finalPath,
      )
      .sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0));
    return results[0] ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- outputNodeLayoutTokens covers output membership
  }, [generationTasks, outputNodeLayoutTokens, taskResults]);

  /** 注册节点级提示内容 handle；DOM implementation 不越过此 seam。 */
  const registerPromptInput = useCallback(
    (nodeKey: string, session: PromptContentEditorSession | null) => {
      promptContents.adoptEditor(nodeKey, session);
      // 提示内容住在提示词模块里，不进画布 store，因此内容变化不会触发 store 订阅里的落盘。
      // 节点卡里的编辑器靠 input 事件冒泡到画布视口触发排期，而独立编辑区（视口之外）
      // 的冒泡到不了视口——只靠那一条会丢掉独立编辑区里改的字。这里显式订阅内容变化，
      // 无论在哪个编辑区改字都排一次落盘。
      promptSaveSubscriptionsRef.current.get(nodeKey)?.();
      promptSaveSubscriptionsRef.current.delete(nodeKey);
      if (session != null) {
        promptSaveSubscriptionsRef.current.set(
          nodeKey,
          promptContents.subscribe(nodeKey, () => {
            scheduleCanvasSaveRef.current();
          }),
        );
      }
    },
    [promptContents],
  );

  /** 文本输出可经任意中间节点传入；多个来源按连接顺序合并。签名驱动重建。 */
  const promptSourceSignature = useCanvas((state) =>
    state.nodes.gen
      .filter((node) => node.kind !== "prompt")
      .map((node) =>
        sharedCanvasInputResolver(state)(node.key)
          .texts.map((text) => `${text.edgeId}:${text.sourceKey}:${text.text}`)
          .join(";"),
      )
      .join("|"),
  );
  const promptSourceByTarget = useMemo(() => {
    const state = canvasReadModelOfState(canvasStore.getState());
    const map = new Map<string, ReturnType<typeof canvasInputsFor>["texts"]>();
    for (const node of state.nodes.gen) {
      if (node.kind === "prompt") continue;
      const texts = sharedCanvasInputResolver(state)(node.key).texts;
      if (texts.length) map.set(node.key, texts);
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- promptSourceSignature 驱动重建
  }, [promptSourceSignature]);

  /** 某生成节点的 @ 候选：直连素材 + 视频节点随提示词继承的参考图，保持请求传入顺序。 */
  const mentionCandidatesFor = useCallback(
    (nodeKey: string): readonly MentionCandidate[] => {
      return generationInputs(nodeKey).map(generationInputMentionCandidate);
    },
    [generationInputs],
  );

  /** UI and agent commands share this reconciliation, including the imported version marker. */
  const synchronizePromptSources = useCallback(
    (
      sourcesByTarget: ReadonlyMap<string, ReturnType<typeof canvasInputsFor>["texts"]>,
      candidatesFor: (nodeKey: string) => readonly MentionCandidate[],
    ) => {
      const imported = importedPromptSourcesRef.current;
      for (const [targetKey, previous] of imported) {
        if (sourcesByTarget.has(targetKey)) continue;
        // 断开最后一条来源时清除自动导入内容，保留用户另行修改的内容。
        if (promptContents.read(targetKey)?.plainText === previous.importedText) {
          promptContents.replaceText(targetKey, "", candidatesFor(targetKey));
        }
        imported.delete(targetKey);
      }
      for (const [targetKey, sources] of sourcesByTarget) {
        const version = {
          edgeId: sources.map((source) => source.edgeId).join("\n"),
          sourceKey: sources.map((source) => source.sourceKey).join("\n"),
          text: sources.map((source) => source.text).join("\n\n"),
          importedText: connectedCanvasPromptText(sources),
        };
        const previous = imported.get(targetKey);
        if (
          previous?.edgeId === version.edgeId &&
          previous.sourceKey === version.sourceKey &&
          previous.text === version.text &&
          previous.importedText === version.importedText
        )
          continue;
        if (
          promptContents.replaceText(targetKey, version.importedText, candidatesFor(targetKey)) !=
          null
        ) {
          imported.set(targetKey, version);
        }
      }
    },
    [promptContents],
  );
  /** 同步合并后的文本；同一上游版本保留用户手工编辑。 */
  useEffect(() => {
    if (canvasHydrated) synchronizePromptSources(promptSourceByTarget, mentionCandidatesFor);
  }, [canvasHydrated, mentionCandidatesFor, promptSourceByTarget, synchronizePromptSources]);

  /*
   * 「尝试：」动作与面板翻译用到的易变值。
   *
   * 这两个动作回调必须**永远拿到最新状态**：画布节点的卡片内容由外壳缓存
   * （`stableCanvasFlowNode` 按签名逐项比对）复用，元素一旦创建，props 就被冻住。
   * 若把 `genNodeSizes`（每拖一次节点就变）这类值放进 `useCallback` 依赖，
   * 回调身份跟着抖，而卡片内容又不会重建 —— 节点拿到的就是**上一次**的回调，
   * 动作会作用在旧状态上（比如把视频节点建到已经挪走的老位置旁边）。
   *
   * 所以这里把易变值收进 ref，回调本身保持身份恒定。
   */
  const textTryStateRef = useRef({
    genNodeSizes,
    occupiedNodeRects,
    nodeModelSelections,
    providerCatalogLoaded,
    providerCatalog,
  });
  useLayoutEffect(() => {
    textTryStateRef.current = {
      genNodeSizes,
      occupiedNodeRects,
      nodeModelSelections,
      providerCatalogLoaded,
      providerCatalog,
    };
  }, [
    genNodeSizes,
    occupiedNodeRects,
    nodeModelSelections,
    providerCatalogLoaded,
    providerCatalog,
  ]);

  /**
   * 「尝试：」四个入口（liblib.tv 文本节点空态的快捷方式）。
   *
   * 逆向来源：docs/integrations/liblib-text-node-re.md 第 3 节。
   * 原站四个动作各自改写文本节点并在旁边建节点；本项目把它们落到提示词节点上：
   *  - writeText     → 切到正文态，由卡片聚焦编辑器
   *  - textToVideo   → 写入一段爆款脚本 → 右侧建视频节点 → 连线（文本 → 视频）
   *  - imageToPrompt → 从素材选择器选图后连线（图片 → 文本）
   *  - textToMusic   → 写入音乐描述模板
   */
  const handleTextTryAction = useCallback(
    (nodeKey: string, action: CanvasTextTryActionKey) => {
      const node = canvasNodesNow("gen").find(
        (item): item is Extract<GenNodeData, { kind: "prompt" }> =>
          item.key === nodeKey && item.kind === "prompt",
      );
      if (!node) return;
      if (action === "writeText") {
        patchPromptNodeConfigField(nodeKey, { textResource: true });
        selectNode(nodeKey);
        return;
      }
      const existingContent = promptContents.read(nodeKey);
      if (
        node.config.sourcePrompt.trim() ||
        node.config.generatedPrompt.trim() ||
        (node.config.conversation ?? []).length > 0 ||
        (existingContent && (existingContent.plainText.trim() || existingContent.referenceCount ||
          existingContent.pendingCount || existingContent.attachmentCount))
      ) {
        toast.info("节点内容已变化，请继续编辑现有内容。");
        return;
      }
      const state = textTryStateRef.current;
      const candidates = mentionCandidatesFor(nodeKey);
      /** 整篇改写节点正文：先落模块里的文档，再把 config 与快照同批写下。 */
      const writeNodeContent = (text: string) => {
        replaceGeneratedPrompt(nodeKey, text, candidates);
        patchNode(
          "gen",
          nodeKey,
          (item) =>
            item.kind === "prompt"
              ? { ...item, config: { ...item.config, generatedPrompt: text } }
              : item,
          promptContents.snapshotAll(),
        );
      };
      const sourceWidth =
        state.genNodeSizes[nodeKey]?.width ?? genNodeDimensions("prompt").width;
      if (action === "textToMusic") {
        writeNodeContent(TEXT_TO_MUSIC_PROMPT);
        selectNode(nodeKey);
        toast.info("已写入音乐描述", { description: "当前供应商目录仅支持语音合成，音乐生成暂不可用。" });
        return;
      }
      if (action === "textToVideo") {
        const story = randomTextToVideoPrompt();
        const { width, height } = genNodeDimensions("video");
        const position = nearestAvailableNodePosition(
          { x: node.x + sourceWidth + NEW_NODE_GAP, y: node.y, width, height },
          state.occupiedNodeRects,
        );
        const video: GenNodeData = {
          key: genNodeKey(),
          kind: "video",
          config: createVideoNodeConfig(state.nodeModelSelections.video, state.providerCatalogLoaded),
          ...position,
        };
        // 边是「文本 → 视频」：视频节点消费文本节点的输出（正文由连线自动同步过去）。
        try {
          runWithCoalescedHistory(() => {
            const result = insertSubgraph(
              [{ type: "gen", data: video }],
              [{ id: `${nodeKey}->${video.key}`, fromKey: nodeKey, toKey: video.key }],
              { selectNodeKey: video.key },
            );
            if (result !== "applied") throw new Error("请重试，或手动添加视频节点。");
            writeNodeContent(story);
          });
        } catch (error: unknown) {
          toast.error("未能创建视频节点", { description: backendErrorMessage(error) });
          return;
        }
        scheduleCanvasSaveRef.current();
        toast.success("已写入故事脚本，并在右侧建好视频节点", {
          description: "在视频节点里选好模型即可生成。",
        });
        return;
      }
      if (action === "imageToPrompt") setTextReferenceKey(nodeKey);
    },
    [canvasNodesNow, canvasStore, insertSubgraph, mentionCandidatesFor, patchNode, patchPromptNodeConfigField,
      promptContents, replaceGeneratedPrompt, runWithCoalescedHistory, selectNode],
  );

  /** 记一笔「编辑区挂上后把光标放进正文」。 */
  const onPromptFocusRequest = useCallback((nodeKey: string) => {
    setPendingPromptFocusKey(nodeKey);
  }, []);

  /** 正文已聚焦（或编辑器没挂上、落不进去）：清掉待办，免得标记一直挂着。 */
  const onPromptFocusHandled = useCallback((nodeKey: string) => {
    setPendingPromptFocusKey((current) => (current === nodeKey ? null : current));
  }, []);

  /**
   * 悬浮生成器面板的「翻译提示词」。
   *
   * 逆向来源：docs/integrations/liblib-text-node-re.md 第 4.6 节。
   * 原站是 `POST /api/canva/translate`；本项目走自己的文本模型链路
   * （后端 `translate_canvas_text`），译文直接回填节点的「创意 / 需求」。
   */
  const handleTranslateCanvasText = useCallback(
    (nodeKey: string) => {
      const node = canvasNodesNow("gen").find(
        (item): item is Extract<GenNodeData, { kind: "prompt" }> =>
          item.key === nodeKey && item.kind === "prompt",
      );
      if (!node) return;
      const sourceText = node.config.sourcePrompt;
      const text = sourceText.trim();
      if (!text) {
        toast("提示词为空，请输入内容后点击");
        return;
      }
      if (!isDesktopRuntime()) {
        toast("提示词翻译只能在桌面应用中调用。请通过 Tauri 桌面端运行。");
        return;
      }
      const state = textTryStateRef.current;
      if (textTranslationGuardRef.current.has(nodeKey)) return;
      const provider = state.providerCatalog.find(
        (entry) =>
          entry.provider.enabled && entry.provider.id === node.config.modelSelection.providerId,
      );
      const model = provider?.models.find(
        (item) =>
          item.definitionId === node.config.modelSelection.modelDefinitionId &&
          isTextGenerationModel(item),
      );
      if (!provider || !model) {
        toast("请先在当前提示词节点中选择可用的文本模型。");
        return;
      }
      textTranslationGuardRef.current.add(nodeKey);
      setTranslatingNodeKeys((current) => new Set(current).add(nodeKey));
      void translateCanvasTextClient
        .run({
          canvasId,
          sourceNodeId: nodeKey,
          providerConnectionId: provider.provider.id,
          modelDefinitionId: model.definitionId,
          text,
          targetLanguage: "English",
        })
        .then((result) => {
          const translated = result.translatedText.trim();
          if (!translated) {
            toast("翻译结果为空，请重试。");
            return;
          }
          const current = canvasNodesNow("gen").find((item) => item.key === nodeKey);
          if (current?.kind !== "prompt" || current.config.sourcePrompt !== sourceText) {
            toast.info("译文已生成，当前输入已变化", {
              description: "保留了你正在编辑的内容；译文也可在任务历史中查看。",
              duration: 10000,
              action: {
                label: "复制译文",
                onClick: () => {
                  void copyTextToDesktopClipboard(translated).then(
                    () => toast.success("译文已复制"),
                    (error: unknown) => toast.error("复制译文失败", { description: backendErrorMessage(error) }),
                  );
                },
              },
            });
            return;
          }
          patchNode("gen", nodeKey, (item) =>
            item.kind === "prompt" && item.config.sourcePrompt === sourceText
              ? { ...item, config: { ...item.config, sourcePrompt: translated } }
              : item,
          );
          toast.success("提示词已翻译成英文");
        })
        .catch((error: unknown) => {
          toast.error("翻译失败", { description: backendErrorMessage(error) });
        })
        .finally(() => {
          textTranslationGuardRef.current.delete(nodeKey);
          setTranslatingNodeKeys((current) => {
            const next = new Set(current);
            next.delete(nodeKey);
            return next;
          });
        });
    },
    [canvasId, canvasNodesNow, patchNode],
  );

  /**
   * 音频节点的「翻译提示词」。
   *
   * 与文本节点走同一条后端链路（`translate_canvas_text`），差别只有两处：
   * 正文在 `promptContents` 里（不在节点的 `sourcePrompt` 字段），而音频节点
   * 本身没有文本模型，所以取供应商目录里第一个可用的文本模型。
   */
  const handleTranslateAudioPrompt = useCallback(
    (nodeKey: string) => {
      const node = canvasNodesNow("gen").find(
        (item): item is Extract<GenNodeData, { kind: "audio" }> =>
          item.key === nodeKey && item.kind === "audio",
      );
      if (!node) return;
      const text = (promptContents.read(nodeKey)?.plainText ?? "").trim();
      if (!text) {
        toast("提示词为空，请输入内容后点击");
        return;
      }
      if (!isDesktopRuntime()) {
        toast("提示词翻译只能在桌面应用中调用。请通过 Tauri 桌面端运行。");
        return;
      }
      if (textTranslationGuardRef.current.has(nodeKey)) return;
      const state = textTryStateRef.current;
      const selection = firstTextModelSelection(state.providerCatalog);
      if (!selection.providerId || !selection.modelDefinitionId) {
        toast("还没有可用的文本模型，请先在全局设置里绑定一个支持文本生成的模型。");
        return;
      }
      textTranslationGuardRef.current.add(nodeKey);
      setTranslatingNodeKeys((current) => new Set(current).add(nodeKey));
      void translateCanvasTextClient
        .run({
          canvasId,
          sourceNodeId: nodeKey,
          providerConnectionId: selection.providerId,
          modelDefinitionId: selection.modelDefinitionId,
          text,
          targetLanguage: "English",
        })
        .then((result) => {
          const translated = result.translatedText.trim();
          if (!translated) {
            toast.info("译文为空", {
              description: "当前提示词可能已经是英文，或模型没有返回内容。",
            });
            return;
          }
          // 保留附件与 @引用：翻译只换文字，不该把引用身份一起抹掉。
          promptContents.replaceTextKeepingAttachments(
            nodeKey,
            translated,
            mentionCandidatesFor(nodeKey),
          );
          toast.success("提示词已翻译成英文");
        })
        .catch((error: unknown) => {
          toast.error("翻译失败", { description: backendErrorMessage(error) });
        })
        .finally(() => {
          textTranslationGuardRef.current.delete(nodeKey);
          setTranslatingNodeKeys((current) => {
            const next = new Set(current);
            next.delete(nodeKey);
            return next;
          });
        });
    },
    [canvasId, canvasNodesNow, mentionCandidatesFor, promptContents],
  );

  /**
   * 音频节点的「音频生视频」。
   *
   * 只建节点、连上线，**不自动发起付费生成**：用户还没写提示词、也没确认模型，
   * 自动提交等于替用户按下付费按钮。原站的这个入口同样是「建好节点让你接着填」。
   *
   * 方向：音频是上游，视频是下游 —— 视频节点摆在音频节点**右边**，
   * 边是「音频 → 视频」（音频节点的输出端口喂给视频节点的输入端口）。
   */
  const audioToVideoPending = useRef(new Set<string>());
  const handleAudioToVideo = useCallback(async (nodeKey: string) => {
    if (audioToVideoPending.current.has(nodeKey)) return;
    audioToVideoPending.current.add(nodeKey);
    try {
      const before = canvasStore.getState();
      const entry = before.nodesById[nodeKey];
      if (entry?.type !== "gen" || entry.data.kind !== "audio") return;

      const saved = latestGenerationPreviewFor(canvasReadModelOfState(before), nodeKey);
      let sourceKey = saved?.mediaType === "audio" && saved.finalPath ? saved.key : null;
      let imported: Awaited<ReturnType<typeof localBase64AssetClient.importAsset>> | null = null;
      if (!sourceKey) {
        const [path] = await pickLocalMediaFiles(["audio"], { multiple: false, title: "选择用于生成视频的音频" });
        if (!path || !canvasStore.getState().nodesById[nodeKey]) return;
        imported = await localBase64AssetClient.importAsset({ localPath: path });
        if (imported.mediaType !== "audio") throw new Error("请选择音频文件。");
        refreshLocalAssets("upload-finished");
      }

      const state = canvasStore.getState();
      const current = state.nodesById[nodeKey];
      if (current?.type !== "gen" || current.data.kind !== "audio") return;
      const defaults = textTryStateRef.current;
      const occupied = Object.values(state.nodesById).map(liveCanvasNodeRect);
      const bounds = liveCanvasNodeRect(current);
      const size = genNodeDimensions("video");
      const position = nearestAvailableNodePosition({
        x: bounds.x + bounds.width + NEW_NODE_GAP,
        y: bounds.y,
        ...size,
      }, occupied);

      const entries: CanvasNodeEntry[] = [];
      if (imported) {
        const assetSize = fitMediaNodeDimensions();
        const assetPosition = nearestAvailableNodePosition({
          x: position.x - assetSize.width - NEW_NODE_GAP,
          y: position.y,
          ...assetSize,
        }, [...occupied, { ...position, ...size }]);
        const asset: AssetNodeData = {
          key: assetNodeKey(), assetId: imported.id, providerConnectionId: "", source: "local",
          kind: "audio", name: imported.name, previewUrl: imported.previewUrl, videoUrl: null, ...assetPosition,
        };
        entries.push({ type: "asset", data: asset });
        sourceKey = asset.key;
      } else if (!sourceKey || !state.nodesById[sourceKey]) {
        throw new Error("音频结果已变化，请重新选择。");
      }
      const video: GenNodeData = {
        key: genNodeKey(),
        kind: "video",
        config: {
          ...createVideoNodeConfig(defaults.nodeModelSelections.video, defaults.providerCatalogLoaded),
          videoMode: "reference",
        },
        ...position,
      };
      entries.push({ type: "gen", data: video });
      if (insertSubgraph(entries, [{ id: sourceKey + "->" + video.key, fromKey: sourceKey, toKey: video.key }], {
        selectNodeKey: video.key,
      }) !== "applied") throw new Error("未能创建视频节点，请重试。");
    } catch (failure) {
      toast.error("准备音频参考失败：" + backendErrorMessage(failure));
    } finally {
      audioToVideoPending.current.delete(nodeKey);
    }
  }, [canvasStore, insertSubgraph, refreshLocalAssets]);

  const handleEnhanceImage = useCallback((nodeKey: string, displayed: OutputNodeData) => {
    const state = canvasStore.getState();
    const source = state.nodesById[nodeKey];
    if (source?.type !== "gen" || source.data.kind !== "image") return;

    const current = latestGenerationPreviewFor(canvasReadModelOfState(state), nodeKey);
    if (!current?.finalPath || current.mediaType !== "image" ||
        generationPreviewToken(current) !== generationPreviewToken(displayed)) {
      toast.error("当前图片已变化或尚未保存，请重新选择。");
      return;
    }

    // 历史画布可能还用独立产物节点，复用该产物的实际引用。
    const fromKey = current.key === nodeKey ? nodeKey : current.key;
    const bounds = liveCanvasNodeRect(source);
    const { width, height } = genNodeDimensions("image");
    const position = nearestAvailableNodePosition({
      x: bounds.x + bounds.width + NEW_NODE_GAP,
      y: bounds.y,
      width,
      height,
    }, Object.values(state.nodesById).map(liveCanvasNodeRect));
    const defaults = textTryStateRef.current;
    const node: GenNodeData = {
      key: genNodeKey(),
      kind: "image",
      name: "高清",
      ...position,
      config: {
        ...createImageNodeConfig(defaults.nodeModelSelections.image, defaults.providerCatalogLoaded),
        imageMode: "upscale",
      },
    };
    const result = insertSubgraph(
      [{ type: "gen", data: node }],
      [{ id: fromKey + "->" + node.key, fromKey, toKey: node.key }],
      { selectNodeKey: node.key },
    );
    if (result !== "applied") toast.error("未能创建高清节点，请重试。");
  }, [canvasStore, insertSubgraph]);

  const handleEditImageRegion = useCallback<StartImageRegionEdit>(async (sourceKey, source, request) => {
    const ratio = request.image.width / request.image.height;
    planCanvasDerivedImage(canvasStore, sourceKey, source, ratio);
    const clientTaskId = crypto.randomUUID();
    const files = await stageCanvasRegionImages(clientTaskId, request.image, request.mask);
    const key = genNodeKey();
    const name = { outpaint: "扩图", repaint: "重绘", erase: "擦除", elements: "元素编辑" }[request.mode];
    let inserted = false;
    let invoked = false;
    try {
      request.signal.throwIfAborted();
      const { x, y } = planCanvasDerivedImage(canvasStore, sourceKey, source, ratio);
      const defaults = textTryStateRef.current;
      const node: GenNodeData = {
        key, kind: "image", name, x, y,
        config: createImageNodeConfig(defaults.nodeModelSelections.image, defaults.providerCatalogLoaded),
      };
      inserted = insertSubgraph([{ type: "gen", data: node }], [{
        id: source.key + "->" + key, fromKey: source.key, toKey: key,
      }]) === "applied";
      if (!inserted) throw new Error("未能创建编辑结果节点，请重试。");
      setStartingNodeKeys(current => new Set(current).add(key));
      invoked = true;
      const taskId = await canvasImageClient.start({
        mode: "masked_edit",
        generation: {
          clientTaskId, canvasId, sourceNodeId: key, outputName: name, operation: "image_to_image",
          providerConnectionId: request.providerId,
          modelDefinitionId: `remote::${request.providerId}::${IMAGE_REGION_EDIT_BINDING}`,
          prompt: [{ kind: "text", text: request.prompt }],
          explicitMedia: [
            { target: { kind: "local_file", path: files.imagePath, mediaType: "image" }, role: "image", displayNameSnapshot: "编辑底图" },
            { target: { kind: "local_file", path: files.maskPath, mediaType: "image" }, role: "mask", displayNameSnapshot: "编辑蒙版" },
          ],
          parameters: { num_images: request.count },
        },
      }).catch(async (failure: unknown) => {
        const existing = await generationClient.get(clientTaskId).catch((lookupFailure: unknown) => {
          if (lookupFailure && typeof lookupFailure === "object" && "kind" in lookupFailure &&
              lookupFailure.kind === "not_found") return null;
          throw failure;
        });
        if (existing) return existing.summary.id;
        invoked = false;
        removeCanvasNode(key);
        throw failure;
      });
      registerImageGeneration(key, [taskId]);
      if (!request.signal.aborted) selectNode(key);
    } catch (failure) {
      if (!invoked) {
        await files.discard();
        throw failure;
      }
      // IPC 回执异常时保留任务输入和节点，由任务列表对账，避免再次提交。
      setNodeStartError(key, backendErrorMessage(failure));
      toast.error(name + "任务回执异常", { description: backendErrorMessage(failure) });
    } finally {
      if (inserted) {
        setStartingNodeKeys(current => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
        refreshTasks();
      }
    }
  }, [canvasId, canvasStore, insertSubgraph, refreshTasks, registerImageGeneration, removeCanvasNode, selectNode, setNodeStartError]);

  /** 新建一份上游文本，由用户填写故事，再通过连线供脚本生成器读取。 */
  const handleScriptStory = useCallback((nodeKey: string) => {
    const node = canvasNodesNow("screenplay").find((item) => item.key === nodeKey);
    if (!node?.config.scriptGenerator) return;
    const state = textTryStateRef.current;
    const { width, height } = genNodeDimensions("prompt");
    const position = nearestAvailableNodePosition(
      { x: node.x - width - NEW_NODE_GAP, y: node.y, width, height }, state.occupiedNodeRects,
    );
    const source: GenNodeData = {
      key: genNodeKey(), kind: "prompt", name: "故事文本", ...position,
      config: { ...createPromptNodeConfig(state.nodeModelSelections.prompt, state.providerCatalogLoaded), textResource: true },
    };
    const result = insertSubgraph(
      [{ type: "gen", data: source }],
      [{ id: `${source.key}->${nodeKey}`, fromKey: source.key, toKey: nodeKey }],
      { selectNodeKey: source.key },
    );
    if (result !== "applied") {
      toast.error("未能创建故事文本节点，请重试。");
      return;
    }
    setPendingPromptFocusKey(source.key);
    setNodeMarquee(false);
    setMarqueeNodeKeys(new Set());
    selectEdge(null);
    selectNode(source.key);
  }, [canvasNodesNow, insertSubgraph, selectEdge, selectNode]);

  /** 只替换仍未被编辑过的输入；翻译任务本身会记入历史。 */
  const handleScriptTranslate = useCallback((nodeKey: string) => {
    const node = canvasNodesNow("screenplay").find((item) => item.key === nodeKey);
    if (!node?.config.scriptGenerator || textTranslationGuardRef.current.has(nodeKey)) return;
    const sourceText = node.config.composer;
    if (!sourceText.trim()) { toast("提示词为空，请输入内容后点击"); return; }
    if (!isDesktopRuntime()) { toast("提示词翻译只能在桌面应用中调用。"); return; }
    const provider = textTryStateRef.current.providerCatalog.find((entry) =>
      entry.provider.enabled && entry.provider.id === node.config.modelSelection.providerId);
    const model = provider?.models.find((item) => item.definitionId === node.config.modelSelection.modelDefinitionId && isTextGenerationModel(item));
    if (!provider || !model) { toast("请先选择可用的文本模型。"); return; }
    textTranslationGuardRef.current.add(nodeKey);
    setTranslatingNodeKeys((current) => new Set(current).add(nodeKey));
    void translateCanvasTextClient.run({
      canvasId, sourceNodeId: nodeKey, providerConnectionId: provider.provider.id,
      modelDefinitionId: model.definitionId, text: sourceText.trim(), targetLanguage: "English",
    }).then((result) => {
      const translated = result.translatedText.trim();
      if (!translated) { toast("翻译结果为空，请重试。"); return; }
      let applied = false;
      patchNode("screenplay", nodeKey, (current) => {
        if (!current.config.scriptGenerator || current.config.composer !== sourceText) return current;
        applied = true;
        return { ...current, config: { ...current.config, composer: translated } };
      });
      if (applied) toast.success("提示词已翻译成英文");
      else toast.info("译文已生成，当前输入已变化", {
        description: "保留了当前输入；译文可在任务历史中查看。",
        action: { label: "复制译文", onClick: () => {
          void copyTextToDesktopClipboard(translated).then(
            () => toast.success("译文已复制"),
            (error: unknown) => toast.error("复制译文失败", { description: backendErrorMessage(error) }),
          );
        } },
      });
    }).catch((error: unknown) => toast.error("翻译失败", { description: backendErrorMessage(error) }))
      .finally(() => {
        textTranslationGuardRef.current.delete(nodeKey);
        setTranslatingNodeKeys((current) => {
          const next = new Set(current); next.delete(nodeKey); return next;
        });
      });
  }, [canvasId, canvasNodesNow, patchNode]);

  /**
   * 为某个镜头创建图片/视频生成节点。
   *
   * 单镜「创建图片节点」与批量生图/生视频共用这一条链路：参考图解析、本地素材导入、
   * 指纹核对、节点落位都集中在这里；批量只是额外指定模型、参数与首帧。
   *
   * 返回新节点 key；无法创建时返回原因，由调用方决定是提示用户还是把这一镜标记为阻塞。
   */
  const createScriptMediaNode = useCallback(async (options: {
    readonly nodeKey: string;
    readonly shotId: string;
    readonly kind: "image" | "video";
    /** 批量指定的模型；缺省时沿用画布上当前选中的模型。 */
    readonly modelSelection?: { readonly providerId: string; readonly modelDefinitionId: string };
    readonly parameterValues?: Readonly<Record<string, ModelParameterValue>>;
    /** 首帧：画布上的图片或上一批生成出来的产物。 */
    readonly frame?: ScriptBatchFrame | null;
    /** 首帧在请求里的角色（如 first_frame）；缺省时由后端按素材类型推导。 */
    readonly frameRole?: string | undefined;
    /** 是否带上镜头关联资产的参考图；批量生视频带首帧时不再重复带参考图。 */
    readonly useAssetReferences?: boolean;
    readonly batchGroup?: { readonly id: string; readonly name: string; readonly purpose?: "storyboard" };
  }): Promise<{ readonly key: string } | { readonly reason: string }> => {
    const { nodeKey, shotId, kind } = options;
    const scriptNode = canvasNodesNow("screenplay").find((item) => item.key === nodeKey);
    const script = scriptNode?.config.scriptGenerator;
    const shot = script?.shots.find((item) => item.id === shotId);
    if (!scriptNode || !script || !shot) return { reason: "脚本节点已不存在。" };
    if (shot.unresolvedAssetRefs?.length) {
      return { reason: "镜头的资产关联尚未确认，请在镜头行核对资产并清除提示。" };
    }
    if ((shot.assetIds ?? []).some((id) => !script.assets.some((asset) => asset.id === id))) {
      return { reason: "镜头关联的资产已删除，请清除失效关联或重新选择资产。" };
    }
    const prompt = kind === "image" ? shot.imagePrompt : (shot.videoPrompt || shot.imageToVideoPrompt);
    if (!prompt.trim()) return { reason: "镜头缺少可用的提示词。" };
    const assets = matchingScriptAssets(shot, script.assets);
    const snapshot = JSON.stringify({ shot, assets });
    const useAssetReferences = options.useAssetReferences !== false;
    const nodeKeys = new Set(useAssetReferences
      ? assets.flatMap((asset) => asset.reference?.kind === "canvas" ? [asset.reference.sourceKey] : [])
      : []);
    const materialIds = new Set(useAssetReferences
      ? assets.flatMap((asset) => asset.reference?.kind === "material" ? [asset.reference.materialId] : [])
      : []);
    const connected = canvasInputsFor(nodeKey).media;
    if ([...nodeKeys].some((key) => !connected.some((input) => input.sourceKey === key && input.kind === "image"))) {
      return { reason: "参考图已断开，请在准备资产步骤重新关联参考图。" };
    }
    const referenceTargets = (inputs: typeof connected) => JSON.stringify([...nodeKeys].map((key) => ({
      key, target: inputs.find((input) => input.sourceKey === key && input.kind === "image")?.target ?? null,
    })));
    const frozenTargets = referenceTargets(connected);
    const materials = [...materialIds].map((id) => (scriptNode.config.materials ?? []).find((item) => item.id === id));
    if (materials.some((item) => !item || item.kind !== "image")) {
      return { reason: "本地参考图不可用，请重新添加并关联参考图。" };
    }
    const frozenMaterials = JSON.stringify(materials);
    if (materials.length && !isDesktopRuntime()) return { reason: "请在桌面应用中使用本地参考图。" };
    const imported: Awaited<ReturnType<typeof localBase64AssetClient.importAsset>>[] = [];
    for (const material of materials) {
      const record = await localBase64AssetClient.importAsset({ localPath: material!.localPath });
      refreshLocalAssets("upload-finished");
      if (record.mediaType !== "image") throw new Error("所选参考素材不是图片。");
      imported.push(record);
    }
    // 首帧在导入之后解析：期间画布可能已变化，过期的首帧不再接进新节点。
    const frameSourceKey = options.frame
      ? scriptBatchFrameSourceKey(options.frame, snapshotV2(promptContents.snapshotAll()))
      : null;
    const current = canvasNodesNow("screenplay").find((item) => item.key === nodeKey);
    const currentScript = current?.config.scriptGenerator;
    const currentShot = currentScript?.shots.find((item) => item.id === shotId);
    if (!current || !currentScript || !currentShot ||
      JSON.stringify({ shot: currentShot, assets: matchingScriptAssets(currentShot, currentScript.assets) }) !== snapshot ||
      referenceTargets(canvasInputsFor(nodeKey).media) !== frozenTargets ||
      JSON.stringify([...materialIds].map((id) => (current.config.materials ?? []).find((item) => item.id === id))) !== frozenMaterials) {
      return { reason: "镜头或参考图已变化，请重新发起。" };
    }
    const state = textTryStateRef.current;
    const { width, height } = genNodeDimensions(kind);
    const occupied = Object.values(canvasStore.getState().nodesById).map(liveCanvasNodeRect);
    const position = nearestAvailableNodePosition({
      x: current.x + (current.measured?.width ?? 350) + NEW_NODE_GAP,
      y: current.y, width, height,
    }, occupied);
    const index = currentScript.shots.findIndex((item) => item.id === shotId) + 1;
    const key = genNodeKey();
    const selection = options.modelSelection;
    const parameterValues = options.parameterValues ? { ...options.parameterValues } : undefined;
    const placement = { ...position, ...(options.batchGroup ? { assetGroupId: options.batchGroup.id } : {}) };
    const media: GenNodeData = kind === "image"
      ? { key, kind, name: `镜头 ${index} 图片`, ...placement,
          config: {
            ...createImageNodeConfig(selection ?? state.nodeModelSelections.image, state.providerCatalogLoaded),
            ...(parameterValues ? { parameterValues } : {}),
          } }
      : { key, kind, name: `镜头 ${index} 视频`, ...placement,
          config: {
            ...createVideoNodeConfig(selection ?? state.nodeModelSelections.video, state.providerCatalogLoaded),
            ...(parameterValues ? { parameterValues } : {}),
            ...(frameSourceKey && options.frameRole ? { mediaRoles: { [frameSourceKey]: options.frameRole } } : {}),
          } };
    const entries: CanvasNodeEntry[] = [{ type: "gen", data: media }];
    const placed = [...occupied, { ...position, width, height }];
    const sources = [...nodeKeys];
    if (frameSourceKey) sources.push(frameSourceKey);
    for (const record of imported) {
      const assetPosition = nearestAvailableNodePosition({
        x: position.x - ASSET_NODE_WIDTH - NEW_NODE_GAP, y: position.y,
        width: ASSET_NODE_WIDTH, height: ASSET_NODE_HEIGHT,
      }, placed);
      const asset: AssetNodeData = {
        key: assetNodeKey(), assetId: record.id, providerConnectionId: "", source: "local",
        kind: "image", name: record.name, previewUrl: record.previewUrl, videoUrl: null, ...assetPosition,
      };
      entries.push({ type: "asset", data: asset });
      sources.push(asset.key);
      placed.push({ ...assetPosition, width: ASSET_NODE_WIDTH, height: ASSET_NODE_HEIGHT });
    }
    const edges = sources.map((source) => ({ id: `${source}->${key}`, fromKey: source, toKey: key }));
    const group = options.batchGroup;
    if (insertSubgraph(entries, edges, { selectNodeKey: key,
      ...(group && !canvasStore.getState().groups[group.id] ? { groups: { [group.id]: { ...group, collapsed: false } } } : {}),
    }) !== "applied") {
      return { reason: "未能创建媒体节点，请重试。" };
    }
    promptContents.replaceText(key, prompt, []);
    patchNode("gen", key, (item) => ({ ...item }), promptContents.snapshotAll());
    scheduleCanvasSaveRef.current();
    return { key };
  }, [canvasNodesNow, canvasInputsFor, canvasStore, insertSubgraph, patchNode, promptContents, refreshLocalAssets, snapshotV2]);

  /** 用单镜提示词创建待配置的媒体节点，不自动提交生成任务。 */
  const handleScriptCreateMedia = useCallback((nodeKey: string, shotId: string, kind: "image" | "video") => {
    const operationKey = `${nodeKey}:${shotId}:${kind}`;
    if (scriptMediaCreationGuardRef.current.has(operationKey)) return;
    scriptMediaCreationGuardRef.current.add(operationKey);
    void (async () => {
      const created = await createScriptMediaNode({ nodeKey, shotId, kind });
      if ("reason" in created) {
        toast.error("未能创建媒体节点", { description: created.reason });
        return;
      }
      const index = Math.max(0, canvasNodesNow("screenplay").find((item) => item.key === nodeKey)?.config.scriptGenerator?.shots
        .findIndex((item) => item.id === shotId) ?? 0) + 1;
      toast.success(`已创建镜头 ${index} 的${kind === "image" ? "图片" : "视频"}节点`, {
        description: "提示词与已关联的参考图已填入；选择模型后可自行生成。",
      });
    })().catch((error: unknown) => toast.error("创建媒体节点失败", {
      description: `${backendErrorMessage(error)}；已导入的图片可在本地素材库中查看。`,
    })).finally(() => scriptMediaCreationGuardRef.current.delete(operationKey));
  }, [canvasNodesNow, createScriptMediaNode]);

  /** 为角色、场景或道具准备一张可继续编辑的图片生成节点。 */
  const handleScriptCreateAsset = useCallback((nodeKey: string, assetId: string) => {
    const operationKey = `${nodeKey}:asset:${assetId}`;
    if (scriptMediaCreationGuardRef.current.has(operationKey)) return;
    scriptMediaCreationGuardRef.current.add(operationKey);
    void (async () => {
      const node = canvasNodesNow("screenplay").find((item) => item.key === nodeKey);
      const asset = node?.config.scriptGenerator?.assets.find((item) => item.id === assetId);
      if (!node || !asset?.description.trim()) return;
      const reference = asset.reference;
      const sourceKey = reference?.kind === "canvas" ? reference.sourceKey : null;
      const sourceInput = sourceKey ? canvasInputsFor(nodeKey).media.find((input) => input.sourceKey === sourceKey && input.kind === "image") : null;
      if (sourceKey && !sourceInput) {
        toast.error("参考图已断开", { description: "请重新选择资产参考图。" }); return;
      }
      const frozenTarget = JSON.stringify(sourceInput?.target ?? null);
      const material = reference?.kind === "material"
        ? (node.config.materials ?? []).find((item) => item.id === reference.materialId) : undefined;
      if (reference?.kind === "material" && (!material || material.kind !== "image")) {
        toast.error("本地参考图不可用", { description: "请重新添加并关联参考图。" }); return;
      }
      const snapshot = JSON.stringify({ asset, material });
      let imported: Awaited<ReturnType<typeof localBase64AssetClient.importAsset>> | null = null;
      if (material) {
        if (!isDesktopRuntime()) { toast("请在桌面应用中使用本地参考图。"); return; }
        imported = await localBase64AssetClient.importAsset({ localPath: material.localPath });
        refreshLocalAssets("upload-finished");
        if (imported.mediaType !== "image") throw new Error("所选参考素材不是图片。");
      }
      const current = canvasNodesNow("screenplay").find((item) => item.key === nodeKey);
      const latestAsset = current?.config.scriptGenerator?.assets.find((item) => item.id === assetId);
      const latestMaterial = reference?.kind === "material"
        ? (current?.config.materials ?? []).find((item) => item.id === reference.materialId) : undefined;
      if (!current || JSON.stringify({ asset: latestAsset, material: latestMaterial }) !== snapshot ||
        (sourceKey && JSON.stringify(canvasInputsFor(nodeKey).media.find((input) => input.sourceKey === sourceKey && input.kind === "image")?.target ?? null) !== frozenTarget)) {
        toast.info("资产或参考图已变化", { description: "已保留当前内容；导入的图片可在本地素材库中查看。" }); return;
      }
      const state = textTryStateRef.current;
      const { width, height } = genNodeDimensions("image");
      const occupied = Object.values(canvasStore.getState().nodesById).map(liveCanvasNodeRect);
      const position = nearestAvailableNodePosition({
        x: current.x + (current.measured?.width ?? 350) + NEW_NODE_GAP, y: current.y, width, height,
      }, occupied);
      const label = asset.kind === "character" ? "角色" : asset.kind === "scene" ? "场景" : "道具";
      const key = genNodeKey();
      const image: GenNodeData = {
        key, kind: "image", name: `${label}：${asset.name || "未命名"}`, ...position,
        config: createImageNodeConfig(state.nodeModelSelections.image, state.providerCatalogLoaded),
      };
      const entries: CanvasNodeEntry[] = [{ type: "gen", data: image }];
      const sources = sourceKey ? [sourceKey] : [];
      if (imported) {
        const assetPosition = nearestAvailableNodePosition({
          x: position.x - ASSET_NODE_WIDTH - NEW_NODE_GAP, y: position.y,
          width: ASSET_NODE_WIDTH, height: ASSET_NODE_HEIGHT,
        }, [...occupied, { ...position, width, height }]);
        const source: AssetNodeData = {
          key: assetNodeKey(), assetId: imported.id, providerConnectionId: "", source: "local",
          kind: "image", name: imported.name, previewUrl: imported.previewUrl, videoUrl: null, ...assetPosition,
        };
        entries.push({ type: "asset", data: source });
        sources.push(source.key);
      }
      const edges = sources.map((source) => ({ id: `${source}->${key}`, fromKey: source, toKey: key }));
      // 生成节点先接回脚本：产物完成后会出现在资产参考选项中，由用户明确选择。
      edges.push({ id: `${key}->${nodeKey}`, fromKey: key, toKey: nodeKey });
      if (insertSubgraph(entries, edges, { selectNodeKey: key }) !== "applied") {
        toast.error("未能创建资产图片节点，请重试。"); return;
      }
      promptContents.replaceText(key, `${label}设定：${asset.name || ""}\n${asset.description}`, []);
      patchNode("gen", key, (item) => ({ ...item }), promptContents.snapshotAll());
      scheduleCanvasSaveRef.current();
      toast.success("已创建资产图片节点", { description: "选择模型生成后，可在脚本节点为该资产选择生成的图片。" });
    })().catch((error: unknown) => toast.error("创建资产图片节点失败", {
      description: `${backendErrorMessage(error)}；已导入的图片可在本地素材库中查看。`,
    })).finally(() => scriptMediaCreationGuardRef.current.delete(operationKey));
  }, [canvasNodesNow, canvasInputsFor, canvasStore, insertSubgraph, patchNode, promptContents, refreshLocalAssets]);

  /**
   * 批量生图/生视频：每个镜头一个独立生成节点、一个独立任务。
   *
   * 任务身份（clientTaskId）在提交前就写进画布：重复点击或恢复时后端按同一身份定位原任务，
   * 不会再发第二笔付费请求；镜头或节点在期间被改动时身份失效，这一镜标记为阻塞而不是重发。
   */
  const handleScriptBatchStart = useCallback((nodeKey: string, request: ScriptBatchStartRequest) => {
    if (scriptBatchSubmissionGuardRef.current.has(nodeKey)) return;
    scriptBatchSubmissionGuardRef.current.add(nodeKey);
    setScriptBatchRunningKeys((current) => new Set(current).add(nodeKey));
    void (async () => {
      let items: readonly ScriptBatchItem[] = [];
      let submitted = 0;
      let blocked = 0;
      try {
        if (!isDesktopRuntime()) { toast("批量生成只能在桌面应用中发起。"); return; }
        const node = canvasNodesNow("screenplay").find((item) => item.key === nodeKey);
        const script = node?.config.scriptGenerator;
        if (!node || !script) return;
        const provider = providerCatalog.find((entry) => entry.provider.enabled && entry.provider.id === request.providerId);
        const model = provider?.models.find((item) => item.definitionId === request.modelDefinitionId);
        if (!provider || !model) {
          toast.error("所选模型不可用", { description: "请重新选择供应商与模型后再发起批量生成。" });
          return;
        }
        const batchId = crypto.randomUUID();
        const group = request.kind === "image" ?
          { id: batchId, name: "分镜图", purpose: "storyboard" as const } : { id: batchId, name: "视频组 · 分镜" };
        const run: ScriptBatchRun = {
          id: batchId, kind: request.kind, createdAt: Date.now(),
          providerId: request.providerId, modelDefinitionId: request.modelDefinitionId,
          modelLabel: `${provider.provider.displayName} · ${model.displayName}`,
          providerFingerprint: JSON.stringify({ providerId: request.providerId,
            modelDefinitionId: request.modelDefinitionId, parameters: request.parameters }),
          items: [],
        };
        const writeItems = (next: readonly ScriptBatchItem[]) => {
          items = next;
          updateScreenplayNode(nodeKey, (config) => {
            if (!config.scriptGenerator) return config;
            const batches = (config.scriptGenerator.batches ?? []).map((batch) =>
              batch.id === batchId ? { ...batch, items: next } : batch);
            return { ...config, scriptGenerator: { ...config.scriptGenerator, batches } };
          });
        };
        // 批次先落画布：中途退出后任务身份仍在，可以继续或核对，不会重复计费。
        updateScreenplayNode(nodeKey, (config) => {
          if (!config.scriptGenerator) return config;
          return { ...config, scriptGenerator: {
            ...config.scriptGenerator, batches: [...(config.scriptGenerator.batches ?? []), run],
          } };
        });
        const capabilities = modelParameterCapabilities(model.operationSchema,
          request.kind === "video" ? "video_generation"
            : model.operations.includes("text_to_image") ? "text_to_image" : "image_to_image",
          model.remoteModelId);
        const durationCapability = request.kind === "video"
          ? capabilities.find((capability) => /^(duration|duration_seconds|seconds)$/.test(capability.key))
          : undefined;
        for (const shotId of request.shotIds) {
          const shot = script.shots.find((item) => item.id === shotId);
          if (!shot) continue;
          if (!activeRef.current) throw new Error("已切换画布，批量提交已暂停。");
          const approvedShot = scriptBatchShotFingerprint(script, shotId);
          const beforeCreation = canvasNodesNow("screenplay").find(item => item.key === nodeKey)?.config.scriptGenerator;
          if (!beforeCreation || scriptBatchShotFingerprint(beforeCreation, shotId) !== approvedShot) {
            throw new Error("分镜或关联资产已修改，请重新核对未提交的镜头。");
          }
          const shotNumber = script.shots.findIndex((item) => item.id === shotId) + 1;
          const taskId = crypto.randomUUID();
          const frame = request.kind === "video" ? (request.frames[shotId] ?? null) : null;
          const parameterValues: Record<string, ModelParameterValue> = { ...request.parameters };
          let note: string | null = null;
          if (request.kind === "video" && request.useShotDuration && durationCapability) {
            const applied = scriptShotDurationValue(durationCapability, shot.duration);
            if (applied) {
              parameterValues[durationCapability.key] = applied.value;
              note = applied.note;
            }
          }
          const created = await createScriptMediaNode({
            nodeKey, shotId, kind: request.kind,
            modelSelection: { providerId: request.providerId, modelDefinitionId: request.modelDefinitionId },
            parameterValues, frame, frameRole: frame ? "first_frame" : undefined,
            // 视频带首帧时不再重复带资产参考图：多数图生视频模型只接受一张图片。
            useAssetReferences: !(frame && request.kind === "video"),
            batchGroup: group,
          });
          const liveScript = canvasNodesNow("screenplay").find((item) => item.key === nodeKey)?.config.scriptGenerator;
          // 指纹按「真正建节点那一刻」的镜头内容记录：中途改过镜头，恢复时身份就对不上了。
          const shotFingerprint = liveScript ? (scriptBatchShotFingerprint(liveScript, shotId) ?? "") : "";
          if ("reason" in created) {
            writeItems([...items, { id: crypto.randomUUID(), shotId, shotNumber, nodeKey: "", taskId,
              shotFingerprint, nodeFingerprint: "", phase: "blocked" as const, error: created.reason, note }]);
            blocked += 1;
            continue;
          }
          const nodeFingerprint = scriptBatchNodeFingerprint(snapshotV2(promptContents.snapshotAll()), created.key) ?? "";
          const item: ScriptBatchItem = { id: crypto.randomUUID(), shotId, shotNumber, nodeKey: created.key,
            taskId, shotFingerprint, nodeFingerprint, phase: "submitting", error: null, note };
          writeItems([...items, item]);
          await flushCanvasDocument();
          const live = canvasNodesNow("screenplay").find(candidate => candidate.key === nodeKey)?.config.scriptGenerator;
          if (!activeRef.current || !live || scriptBatchShotFingerprint(live, shotId) !== approvedShot ||
              scriptBatchNodeFingerprint(snapshotV2(promptContents.snapshotAll()), item.nodeKey) !== item.nodeFingerprint) {
            writeItems(items.map(entry => entry.id === item.id ? { ...entry, phase: "prepared" } : entry));
            throw new Error("分镜或生成节点已变化，批次已暂停。");
          }
          const outcome = await handleStartGeneration(created.key, { clientTaskId: taskId });
          const ok = Boolean(outcome?.taskIds.includes(taskId));
          writeItems(items.map((entry) => entry.id === item.id ? {
            ...entry,
            phase: (ok ? "submitted" : outcome ? "uncertain" : "blocked") as ScriptBatchItem["phase"],
            error: ok ? null : outcome?.errors[0]
              ?? "生成节点未通过校验，请在该镜头的生成节点上查看原因后重新发起。",
          } : entry));
          if (ok) submitted += 1; else blocked += 1;
        }
        if (submitted) {
          toast.success(`已提交 ${submitted} 个${request.kind === "image" ? "图片" : "视频"}任务`, {
            description: blocked ? `另有 ${blocked} 个镜头未提交，结果按镜头归集在下方。` : "结果按镜头归集在下方。",
          });
        } else if (blocked) {
          toast.error("批量生成没有提交成功", { description: "请查看下方各镜头的失败原因。" });
        }
      } catch (error: unknown) {
        toast.error("批量生成中断", { description: backendErrorMessage(error) });
      } finally {
        scriptBatchSubmissionGuardRef.current.delete(nodeKey);
        setScriptBatchRunningKeys((current) => {
          const next = new Set(current);
          next.delete(nodeKey);
          return next;
        });
      }
    })();
  }, [canvasNodesNow, createScriptMediaNode, flushCanvasDocument, handleStartGeneration, providerCatalog, promptContents, snapshotV2, updateScreenplayNode]);

  /**
   * 继续或核对未完成的批次提交。
   *
   * 先查任务是否已经存在：存在就只认领原任务，不重发；确实不存在才用同一身份重提。
   * 镜头或生成节点被改动后原身份不可复用（请求内容变了），这一镜标记为阻塞而不是重发。
   */
  const handleScriptBatchResume = useCallback((nodeKey: string, batchId: string) => {
    if (scriptBatchSubmissionGuardRef.current.has(nodeKey)) return;
    scriptBatchSubmissionGuardRef.current.add(nodeKey);
    setScriptBatchRunningKeys((current) => new Set(current).add(nodeKey));
    void (async () => {
      try {
        const node = canvasNodesNow("screenplay").find((item) => item.key === nodeKey);
        const script = node?.config.scriptGenerator;
        const batch = script?.batches?.find((entry) => entry.id === batchId);
        if (!node || !script || !batch) return;
        let items = batch.items;
        const writeItems = (next: readonly ScriptBatchItem[]) => {
          items = next;
          updateScreenplayNode(nodeKey, (config) => {
            if (!config.scriptGenerator) return config;
            const batches = (config.scriptGenerator.batches ?? []).map((entry) =>
              entry.id === batchId ? { ...entry, items: next } : entry);
            return { ...config, scriptGenerator: { ...config.scriptGenerator, batches } };
          });
        };
        let claimed = 0;
        let resubmitted = 0;
        let blocked = 0;
        for (const item of batch.items) {
          if (item.phase === "submitted") continue;
          // 任务已经存在就只认领，不再发请求。
          const existing = await generationClient.getProgress(item.taskId).catch((error: unknown) => {
            if (error && typeof error === "object" && "kind" in error && error.kind === "not_found") return null;
            throw error;
          });
          if (existing) {
            const matches = existing.summary.canvasId === canvasId &&
              existing.summary.sourceNodeId === item.nodeKey &&
              existing.summary.providerConnectionId === batch.providerId &&
              existing.summary.modelDefinitionId === batch.modelDefinitionId;
            // 已经结束的任务不能复用身份：重提只会拿回同一个失败任务，要重来只能重新发起。
            const ended = existing.summary.status === "failed" ||
              existing.summary.status === "cancelled" || existing.summary.status === "interrupted";
            writeItems(items.map((entry) => entry.id === item.id ? { ...entry,
              phase: (!matches || ended ? "blocked" : "submitted") as ScriptBatchItem["phase"],
              error: !matches ? "任务身份与批次记录不一致，请在任务历史中核对。"
                : ended ? `该任务已结束（${existing.summary.status}），原任务身份不能复用；请重新发起批量生成。`
                  : null } : entry));
            if (matches && !ended) claimed += 1; else blocked += 1;
            continue;
          }
          if (item.phase !== "prepared") {
            writeItems(items.map(entry => entry.id === item.id ? { ...entry, phase: "uncertain",
              error: "这笔请求曾尝试提交，暂未查到原任务。请稍后核对，不会自动重发。" } : entry));
            blocked += 1;
            continue;
          }
          if (!activeRef.current) throw new Error("已切换画布，批量提交已暂停。");
          writeItems(items.map(entry => entry.id === item.id ? { ...entry, phase: "submitting" } : entry));
          await flushCanvasDocument();
          const live = canvasNodesNow("screenplay").find(candidate => candidate.key === nodeKey)?.config.scriptGenerator;
          if (!activeRef.current || !live || scriptBatchShotFingerprint(live, item.shotId) !== item.shotFingerprint ||
              scriptBatchNodeFingerprint(snapshotV2(promptContents.snapshotAll()), item.nodeKey) !== item.nodeFingerprint) {
            writeItems(items.map(entry => entry.id === item.id ? { ...entry, phase: "prepared" } : entry));
            throw new Error("分镜或生成节点已变化，批次已暂停。");
          }
          const outcome = await handleStartGeneration(item.nodeKey, { clientTaskId: item.taskId });
          const ok = Boolean(outcome?.taskIds.includes(item.taskId));
          writeItems(items.map((entry) => entry.id === item.id ? {
            ...entry,
            phase: (ok ? "submitted" : outcome ? "uncertain" : "blocked") as ScriptBatchItem["phase"],
            error: ok ? null : outcome?.errors[0] ?? "生成节点未通过校验，请在该镜头的生成节点上查看原因。",
          } : entry));
          if (ok) resubmitted += 1; else blocked += 1;
        }
        if (claimed || resubmitted) {
          toast.success(`已核对 ${claimed + resubmitted} 个任务`, {
            description: blocked ? `另有 ${blocked} 个镜头需要处理。` : "已存在的任务直接认领，没有重复提交。",
          });
        } else if (blocked) {
          toast.error("没有可继续的提交", { description: "请查看各镜头的失败原因。" });
        }
      } catch (error: unknown) {
        toast.error("核对批次失败", { description: backendErrorMessage(error) });
      } finally {
        scriptBatchSubmissionGuardRef.current.delete(nodeKey);
        setScriptBatchRunningKeys((current) => {
          const next = new Set(current);
          next.delete(nodeKey);
          return next;
        });
      }
    })();
  }, [canvasId, canvasNodesNow, flushCanvasDocument, handleStartGeneration, promptContents, snapshotV2, updateScreenplayNode]);

  const nodeDescriptorContext = useMemo(
    () => ({ providerCatalog, nodeModelSelections }),
    [providerCatalog, nodeModelSelections],
  );

  // 桌面端：服务端分页查询已按类型与名称过滤，前端不再二次筛选。
  // 浏览器预览模式：静态演示数据，保留客户端类型 + 名称过滤（useDeferredValue 即时反馈）。
  const deferredAssetSearch = useDeferredValue(assetSearch);
  const browserAssetSearch = deferredAssetSearch.trim().toLowerCase();
  const visibleAssets = useMemo(() => {
    if (isDesktopRuntime()) return libraryAssets;
    return libraryAssets.filter(
      (asset) => asset.kind === assetKind && asset.name.toLowerCase().includes(browserAssetSearch),
    );
  }, [assetKind, browserAssetSearch, libraryAssets]);
  // 输入中的瞬时过滤反馈：桌面端以 350ms 防抖提交值为准，浏览器端沿用 deferred 值。
  const assetSearchPending = isDesktopRuntime()
    ? assetSearch.trim() !== committedAssetSearch
    : assetSearch !== deferredAssetSearch;
  const localAssetTotalPages = Math.max(1, Math.ceil(localAssetTotal / ASSET_PAGE_SIZE));
  const objectStorageTotalPages = Math.max(1, Math.ceil(objectStorageTotal / ASSET_PAGE_SIZE));
  // 云端类型角标已是当前分组的全库计数；无搜索时即可换算总页数。
  // 名称搜索仍无过滤总数，分页文案退回「第 N 页」。
  const cloudAssetTotal =
    committedAssetSearch.trim() === "" && cloudAssetKindTotals != null
      ? cloudAssetKindTotals[assetKind]
      : null;
  const cloudAssetTotalPages =
    cloudAssetTotal == null ? null : Math.max(1, Math.ceil(cloudAssetTotal / ASSET_PAGE_SIZE));
  const goToCloudAssetPage = useCallback(
    (page: number) => {
      if (!assetProvider || page === cloudAssetPageRef.current) return;
      cloudAssetPageRef.current = page;
      setCloudAssetPageNumber(page);
      refreshCloudAssets(assetProvider.id, "page");
    },
    [assetProvider, refreshCloudAssets],
  );
  const goToLocalAssetPage = useCallback(
    (page: number) => {
      if (page === localAssetPageRef.current) return;
      localAssetPageRef.current = page;
      setLocalAssetPageNumber(page);
      refreshLocalAssets("page");
    },
    [refreshLocalAssets],
  );
  const goToObjectStoragePage = useCallback(
    (page: number) => {
      if (page === objectStoragePageRef.current) return;
      objectStoragePageRef.current = page;
      setObjectStoragePageNumber(page);
      refreshObjectStorageAssets("page");
    },
    [refreshObjectStorageAssets],
  );
  const handlePreviewAsset = useCallback((asset: AssetItem) => setPreviewAsset(asset), []);
  const handleDropAssetToCanvas = useCallback(
    (asset: AssetItem, clientX: number, clientY: number) => {
      if (cloudAssetAwaitingId(asset)) return;
      const point = dropClientPointToBoard(clientX, clientY);
      if (point == null) return;
      addAssetNode(asset, point.x, point.y);
    },
    [addAssetNode, dropClientPointToBoard],
  );
  const externalDropPlacementRef = useRef({
    occupied: occupiedNodeRects,
    nextOrder: nextLibraryPickOrder(canvasNodesNow("asset")),
  });
  useLayoutEffect(() => {
    externalDropPlacementRef.current = {
      occupied: occupiedNodeRects,
      nextOrder: nextLibraryPickOrder(canvasNodesNow("asset")),
    };
  }, [canvasNodesNow, occupiedNodeRects]);
  const importCanvasMedia = useCallback(
    async (paths: readonly string[], anchor: { x: number; y: number }) => {
      const { mediaPaths, skippedCount } = classifyExternalMediaPaths(paths);
      if (mediaPaths.length === 0) {
        toast.error("请选择图片、视频或音频文件。");
        return false;
      }
      const toastId = `canvas-media-drop-${pendingUploadSeqRef.current++}`;
      toast.loading(`正在将 ${mediaPaths.length} 项素材保存到本地素材库…`, { id: toastId });
      const imported: LocalBase64AssetRecord[] = [];
      const failures: string[] = [];
      for (const path of mediaPaths) {
        const name = path.split(/[\\/]/).pop() ?? path;
        try {
          imported.push(
            await localBase64AssetClient.importAsset({
              localPath: path,
              name,
              groupId: uploadTargetLocalGroupId(),
            }),
          );
        } catch (error) {
          failures.push(`${name}：${backendErrorMessage(error)}`);
        }
      }
      if (imported.length > 0) {
        const placement = externalDropPlacementRef.current;
        const positions = layoutAssetPlacements(
          imported.length,
          anchor,
          { width: ASSET_NODE_WIDTH, height: ASSET_NODE_HEIGHT },
          placement.occupied,
        );
        let libraryPickOrder = placement.nextOrder;
        const entries: CanvasNodeEntry[] = imported.flatMap((record, index) => {
          const position = positions[index];
          if (position == null) return [];
          const asset = localAssetToItem(record);
          return [
            {
              type: "asset" as const,
              data: {
                key: assetNodeKey(),
                assetId: asset.id,
                providerConnectionId: "",
                source: "local" as const,
                kind: asset.kind,
                name: asset.name,
                previewUrl: asset.previewUrl ?? null,
                videoUrl:
                  asset.kind === "video" ? (asset.videoUrl ?? asset.previewUrl ?? null) : null,
                libraryPickOrder: libraryPickOrder++,
                x: position.x,
                y: position.y,
              },
            },
          ];
        });
        if (insertSubgraph(entries, []) !== "applied") {
          toast.error("素材已保存到本地素材库，但未能放入画布", { id: toastId });
          refreshLocalAssets("upload-finished");
          return false;
        }
        externalDropPlacementRef.current = {
          occupied: [
            ...placement.occupied,
            ...positions.map((position) => ({
              ...position,
              width: ASSET_NODE_WIDTH,
              height: ASSET_NODE_HEIGHT,
            })),
          ],
          nextOrder: libraryPickOrder,
        };
        refreshLocalAssets("upload-finished");
      }
      if (imported.length === 0) {
        toast.error("素材未能导入画布", {
          id: toastId,
          description: failures[0] ?? "请确认文件是可读取的图片、视频或音频。",
        });
      } else if (failures.length > 0 || skippedCount > 0) {
        const details = [
          failures.length > 0 ? failures[0] : null,
          skippedCount > 0 ? `跳过 ${skippedCount} 个不支持的项目` : null,
        ]
          .filter(Boolean)
          .join("；");
        toast.warning(
          `已放入 ${imported.length} 项素材，${failures.length + skippedCount} 项未导入`,
          {
            id: toastId,
            description: details,
          },
        );
      } else {
        toast.success(`已将 ${imported.length} 项素材放入画布并保存到本地素材库`, { id: toastId });
      }
      return imported.length > 0;
    },
    [insertSubgraph, refreshLocalAssets, uploadTargetLocalGroupId],
  );
  const handleDropExternalMedia = useCallback(async (paths: readonly string[], clientX: number, clientY: number) => {
    const anchor = dropClientPointToBoard(clientX, clientY);
    if (anchor) await importCanvasMedia(paths, anchor);
  }, [dropClientPointToBoard, importCanvasMedia]);
  const dropClientPointToBoardRef = useRef(dropClientPointToBoard);
  const handleDropExternalMediaRef = useRef(handleDropExternalMedia);
  useLayoutEffect(() => {
    dropClientPointToBoardRef.current = dropClientPointToBoard;
    handleDropExternalMediaRef.current = handleDropExternalMedia;
  }, [dropClientPointToBoard, handleDropExternalMedia]);
  useEffect(() => {
    if (!isDesktopRuntime() || !active || !canvasHydrated) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let draggingMedia = false;
    void import("@tauri-apps/api/webview")
      .then(async ({ getCurrentWebview }) => {
        const stop = await getCurrentWebview().onDragDropEvent(({ payload }) => {
          if (payload.type === "leave") {
            draggingMedia = false;
            setExternalMediaDropHover(false);
            return;
          }
          const point = nativeDropClientPoint(payload.position, window.devicePixelRatio);
          const viewport = canvasViewportRef.current;
          const topElement = document.elementFromPoint?.(point.x, point.y);
          const storyFrame = storyboardFrameRef.current;
          const insideStoryboard = storyFrame != null && storyFrame.closest("[inert]") == null &&
            topElement != null && storyFrame.contains(topElement);
          const insideCanvas =
            viewport != null &&
            viewport.closest("[inert]") == null &&
            document.querySelector("dialog[open]") == null &&
            (topElement == null || viewport.contains(topElement)) &&
            dropClientPointToBoardRef.current(point.x, point.y) != null;
          if (payload.type === "enter") {
            draggingMedia = classifyExternalMediaPaths(payload.paths).mediaPaths.length > 0;
            setExternalMediaDropHover(draggingMedia && insideCanvas);
          } else if (payload.type === "over") {
            setExternalMediaDropHover(draggingMedia && insideCanvas);
          } else {
            draggingMedia = false;
            setExternalMediaDropHover(false);
            if (insideStoryboard) void importCanvasMedia(payload.paths, viewportCenterBoardCoordinatesRef.current());
            else if (insideCanvas)
              void handleDropExternalMediaRef.current(payload.paths, point.x, point.y);
          }
        });
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch((error: unknown) => {
        frontendLog("error", `[canvas] 注册外部素材拖放失败: ${formatRawBackendError(error)}`);
      });
    return () => {
      disposed = true;
      unlisten?.();
      setExternalMediaDropHover(false);
    };
  }, [active, canvasHydrated, importCanvasMedia]);
  const toggleAssetMultiSelect = useCallback(() => {
    setAssetMultiSelect((enabled) => {
      if (enabled) setPickedAssets([]);
      return !enabled;
    });
  }, []);
  const togglePickedAsset = useCallback((asset: AssetItem) => {
    if (cloudAssetAwaitingId(asset)) return;
    const key = assetPickKey(asset);
    setPickedAssets((current) => {
      const index = current.findIndex((item) => assetPickKey(item) === key);
      if (index >= 0) return current.filter((_, itemIndex) => itemIndex !== index);
      return [...current, asset];
    });
  }, []);
  const pickOrderByKey = useMemo(() => {
    const orders = new Map<string, number>();
    pickedAssets.forEach((asset, index) => orders.set(assetPickKey(asset), index + 1));
    return orders;
  }, [pickedAssets]);
  const handlePlacePickedAssets = useCallback(() => {
    const placeable = pickedAssets.filter((asset) => !cloudAssetAwaitingId(asset));
    if (placeable.length === 0) {
      if (pickedAssets.length > 0) setPickedAssets([]);
      return;
    }
    for (const asset of placeable) {
      const source = asset.source ?? "cloud";
      const providerConnectionId = asset.providerConnectionId ?? assetProvider?.id ?? "";
      if (source === "cloud" && providerConnectionId === "") {
        setAssetsError("拖放素材需要已启用的供应商连接。请先在全局设置中配置。");
        return;
      }
    }
    const positions = layoutAssetPlacements(
      placeable.length,
      viewportCenterBoardCoordinates(),
      { width: ASSET_NODE_WIDTH, height: ASSET_NODE_HEIGHT },
      occupiedNodeRects,
    );
    let libraryPickOrder = nextLibraryPickOrder(canvasNodesNow("asset"));
    const entries: CanvasNodeEntry[] = [];
    for (let index = 0; index < placeable.length; index += 1) {
      const asset = placeable[index];
      const position = positions[index];
      if (asset == null || position == null) continue;
      const source = asset.source ?? "cloud";
      const providerConnectionId = asset.providerConnectionId ?? assetProvider?.id ?? "";
      entries.push({
        type: "asset",
        data: {
          key: assetNodeKey(),
          assetId: asset.id,
          providerConnectionId,
          source,
          kind: asset.kind,
          name: asset.name,
          previewUrl: asset.previewUrl ?? null,
          videoUrl: asset.kind === "video" ? (asset.videoUrl ?? asset.previewUrl ?? null) : null,
          libraryPickOrder,
          x: position.x,
          y: position.y,
        },
      });
      libraryPickOrder += 1;
    }
    if (entries.length === 0) return;
    insertSubgraph(entries, []);
    setPickedAssets([]);
    toast.success(`已将 ${entries.length} 个素材放到画布`);
    frontendLog(
      "info",
      `[canvas] 多选素材已放到画布: count=${entries.length}, order=${entries.map((entry) => (entry.type === "asset" ? entry.data.libraryPickOrder : "")).join(",")}`,
    );
  }, [
    canvasNodesNow,
    assetProvider?.id,
    insertSubgraph,
    occupiedNodeRects,
    pickedAssets,
    viewportCenterBoardCoordinates,
  ]);

  // 预览确认失败：先把本机原件重新上传进同一分组，再删除旧的云端记录。
  const handleUnavailableCloudAsset = useCallback(
    (asset: AssetItem) => {
      if (!isDesktopRuntime() || asset.source !== "cloud" || !asset.providerConnectionId) return;
      void repairUnavailableCloudAsset(
        asset,
        {
          resolveImportedAsset: (assetId) => tosStagingClient.resolveImportedAssetSource(assetId),
          deleteAsset: (command) => assetLibraryClient.deleteAsset(command),
          startUpload: (command) => tosStagingClient.startUpload(command),
        },
        (jobId) => {
          previewRepairJobsRef.current.set(jobId, {
            oldAssetId: asset.id,
            providerConnectionId: asset.providerConnectionId ?? "",
          });
          setAssetUploads((current) => [
            ...current,
            {
              jobId,
              name: asset.name,
              kind: asset.kind,
              assetId: null,
              status: "validating",
              bytesUploaded: 0,
              bytesTotal: null,
              error: null,
              lastAdvancedAt: Date.now(),
              stalled: false,
              destination: "cloud",
              adjustment: null,
            },
          ]);
        },
      ).then((result) => {
        if (result.status === "skipped") {
          if (result.reason === "no-local-file") {
            frontendLog(
              "info",
              `[assets] 预览不可用但没有本机原件，保留云端记录: assetId=${asset.id}`,
            );
          }
          return;
        }
        if (result.status === "failed") {
          const formatted = formatRawBackendError(result.error);
          frontendLog(
            "error",
            `[assets] 预览不可用素材未能重新上传: assetId=${asset.id}, 阶段=${result.reason}, 错误: ${formatted}`,
          );
          toast.error(`「${asset.name}」预览不可用，重新上传失败`, { description: backendErrorMessage(result.error) });
          return;
        }
        if (result.deleted) {
          setCloudAssets((current) => current.filter((item) => item.id !== asset.id));
          if (
            assetProvider &&
            selectedAssetGroupIdRef.current == null &&
            asset.providerConnectionId === assetProvider.id &&
            (asset.kind === "image" || asset.kind === "video" || asset.kind === "audio")
          ) {
            applyCloudAssetKindDelta(assetProvider.id, null, asset.kind, -1);
          }
          frontendLog(
            "info",
            `[assets] 预览不可用素材已删除并重新上传: assetId=${asset.id}, jobId=${result.jobId}`,
          );
          toast.success(`「${asset.name}」预览不可用，已删除并重新上传到素材库`);
          return;
        }
        const formatted = formatRawBackendError(result.deleteError);
        frontendLog(
          "error",
          `[assets] 预览不可用素材已重新上传，但删除旧记录失败: assetId=${asset.id}, jobId=${result.jobId}, 错误: ${formatted}`,
        );
        toast.error(`「${asset.name}」已重新上传，旧素材删除失败`, { description: backendErrorMessage(result.deleteError) });
      });
    },
    [applyCloudAssetKindDelta, assetProvider],
  );

  // 云端素材删除：调用上游 `POST /v1/assets/delete`，成功后重新拉取云端列表。
  // 本地素材不走此路径（没有云端 ID，删除按钮也不渲染）。
  const handleDeleteAsset = useCallback(
    (asset: AssetItem) => {
      if (asset.source !== "cloud" || !asset.providerConnectionId) return;
      setAssetsError(null);
      void assetLibraryClient
        .deleteAsset({
          providerConnectionId: asset.providerConnectionId,
          id: asset.id,
        })
        .then(
          (deletedId) => {
            frontendLog(
              "info",
              `[assets] 云端素材已删除: providerConnectionId=${asset.providerConnectionId}, assetId=${asset.id}, deletedId=${deletedId}`,
            );
            if (assetProvider) {
              refreshCloudAssets(assetProvider.id, "delete");
              refreshAssetGroups(assetProvider.id);
              // 删除按素材类型减一，不做全库重扫；只看整库口径（选中分组时无法确认素材归属范围）。
              if (
                selectedAssetGroupIdRef.current == null &&
                asset.providerConnectionId === assetProvider.id
              ) {
                applyCloudAssetKindDelta(assetProvider.id, null, asset.kind, -1);
              }
            }
          },
          (error: unknown) => {
            const formatted = formatRawBackendError(error);
            frontendLog(
              "error",
              `[assets] 云端素材删除失败: providerConnectionId=${asset.providerConnectionId}, assetId=${asset.id}, 错误: ${formatted}`,
            );
            setAssetsError(backendErrorMessage(error));
          },
        );
    },
    [applyCloudAssetKindDelta, assetProvider, refreshAssetGroups, refreshCloudAssets],
  );

  // 预览大图按节点窄订阅：产物落盘/预览地址补齐时只重渲染灯箱，不重跑工作台。
  const previewOutputEntry = useCanvasNodeEntry(previewOutputNodeKey ?? "");
  const previewImageSource = previewOutputEntry?.type === "gen" && previewOutputEntry.data.kind === "image" ? previewOutputEntry.data : null;
  const previewImageNode = previewImageSource?.imageGeneration ? previewImageSource : null;
  const previewOutputNode =
    previewOutputEntry?.type === "output" &&
    (previewOutputEntry.data.finalPath != null || previewOutputEntry.data.previewSrc != null)
      ? previewOutputEntry.data
      : previewImageSource && !previewImageNode ? latestGenerationPreviewFor(canvasReadModelOfState(canvasStore.getState()), previewImageSource.key) : null;

  const previewAssetEntry = useCanvasNodeEntry(previewAssetNodeKey ?? "");
  const previewAssetNode =
    previewAssetEntry?.type === "asset" &&
    (previewAssetEntry.data.previewUrl != null || previewAssetEntry.data.videoUrl != null)
      ? previewAssetEntry.data
      : null;

  const closeAssetDrawer = () => {
    onAssetDrawerTabChange(null);
    window.requestAnimationFrame(() => {
      const trigger = assetDrawerTriggerRef.current;
      if (trigger?.isConnected) trigger.focus();
      else canvasViewportRef.current?.parentElement
        ?.querySelector<HTMLButtonElement>('button[aria-controls="canvas-asset-drawer"]')?.focus();
    });
  };

  const closeSettings = () => {
    setSettingsOpen(false);
    window.requestAnimationFrame(() => settingsTriggerRef.current?.focus());
  };

  const closeHistory = () => {
    setHistoryOpen(false);
    setHistoryInitialTaskId(null);
    setHistoryResourceAnchor(null);
  };
  const renameGenNode = useCallback(
    (key: string, name: string) => {
      patchNode("gen", key, (node) => ({ ...node, name }));
    },
    [patchNode],
  );
  useEffect(() => {
    if (!canvasHydrated) return;
    return registerArtifactNameSync((update) => patchNodes("output", update));
  }, [canvasHydrated, patchNodes]);

  // 已保存画布可长时间未打开；读本机结果记录恢复规范名称，再应用本会话较新的改名。
  const reconciledArtifactNameTasksRef = useRef(new Set<string>());
  useEffect(() => {
    if (!canvasHydrated || !isDesktopRuntime()) return;
    const taskIds = [
      ...new Set(
        canvasNodesNow("output")
          .filter(
            (node) =>
              node.finalPath != null && (node.origin == null || node.origin === "generation"),
          )
          .map((node) => node.taskId),
      ),
    ];
    for (const taskId of taskIds) {
      if (reconciledArtifactNameTasksRef.current.has(taskId)) continue;
      reconciledArtifactNameTasksRef.current.add(taskId);
      void generationClient
        .get(taskId)
        .then((detail) => {
          patchNodes("output", (node) => {
            const record = detail.results.find(
              (result) =>
                result.saveStatus === "succeeded" &&
                result.finalPath != null &&
                artifactNameChangeMatches(node, {
                  taskId,
                  finalPath: result.finalPath,
                  name: "match",
                }),
            );
            const name = record ? resultDisplayName(record) : null;
            if (!name || (node.name === name && node.customName === name))
              return resolveCurrentArtifactName(node);
            return resolveCurrentArtifactName({ ...node, name, customName: name });
          });
        })
        .catch(() => {
          reconciledArtifactNameTasksRef.current.delete(taskId);
        });
    }
  }, [canvasHydrated, outputCardSignature, canvasNodesNow, patchNodes]);

  const renameOutputNode = useCallback(
    async (key: string, name: string) => {
      const entry = canvasStore.getState().nodesById[key];
      const node = entry?.type === "output" ? entry.data : null;
      if (!node?.finalPath) throw new Error("请等待产物保存完成。");
      let fileName = artifactFileName(name, node.finalPath);
      let resultIndex: number | undefined;
      if ((node.origin == null || node.origin === "generation") && isDesktopRuntime()) {
        // Read the saved identity: legacy canvas archives can contain zero-based result keys.
        const detail = await generationClient.get(node.taskId);
        const matches = detail.results.filter(
          (result) => result.finalPath === node.finalPath && result.saveStatus === "succeeded",
        );
        if (matches.length !== 1)
          throw new Error("无法唯一定位此产物的原任务结果，请先查看任务历史。");
        await renameGenerationResult(node.taskId, matches[0]!.resultIndex, fileName);
        resultIndex = matches[0]!.resultIndex;
      }
      if (node.origin === "video_preparation") {
        const renamed = await videoPreparationClient.rename(node.taskId, fileName);
        fileName = renamed.output?.name ?? fileName;
      }
      publishArtifactNameChange({
        taskId: node.taskId,
        finalPath: node.finalPath,
        name: fileName,
        ...(resultIndex == null ? {} : { resultIndex }),
      });
      toast.success("产物名称已保存，再次导出将使用新名称");
    },
    [canvasStore],
  );
  const openGenerationHistory = useCallback((taskId: string) => {
    setHistoryResourceAnchor(null);
    setHistoryInitialTaskId(taskId);
    setHistoryOpen(true);
  }, []);

  const toggleAssetDrawer = (tab: CanvasAssetDrawerTab, trigger: HTMLElement) => {
    if (assetDrawerTab === tab) {
      closeAssetDrawer();
      return;
    }

    assetDrawerTriggerRef.current = trigger;
    onAssetDrawerTabChange(tab);
  };

  /*
   * Esc = 画布的「退出」：清掉框选、选中与移动端面板。
   *
   * 原来这条走 `useHotkeys("esc", …)`：它在 **document 冒泡阶段**处理 Escape
   * 并 `preventDefault()`，等于**先认领**这个键——画布上的抽屉、缩放菜单、
   * 摄像机面板全都无法用 Esc 关闭（它们原本挂在捕获阶段才抢得过它）。
   * 统一到仲裁器后，这条也必须是一个处理者，否则它会在冒泡阶段把仲裁器整个短路掉。
   *
   * 优先级压在所有浮层 / 弹窗之下（画布背景动作）：浮层开着时 Esc 归浮层，
   * 什么都没开时才清选中——一次按键只做一件事。
   *
   * 输入框 / 文本域里不触发（沿用 `react-hotkeys-hook` 默认的
   * `enableOnFormTags: false` 口径）：打字打到一半按 Esc 不该把画布选中清掉。
   */
  useEscapeHandler(
    {
      canHandle: (event) => !isInsideFormField(event.target),
      handle: () => {
        if (assetDrawerTab != null) {
          closeAssetDrawer();
          return;
        }
        setNodeMarquee(false);
        setMarqueeNodeKeys(new Set());
        selectEdge(null);
        selectNode(null);
      },
      priority: ESCAPE_PRIORITY_CANVAS,
    },
    active && canvasHydrated && !settingsOpen,
  );

  const removeSelectedCanvasNode = useCallback(
    (key: string) => {
      const entry = canvasStore.getState().nodesById[key];
      if (entry?.type === "asset") {
        removeAssetNode(key);
        return;
      }
      if (entry?.type === "gen") {
        removeGenNode(key);
        return;
      }
      if (entry?.type === "screenplay") {
        removeScreenplayNode(key);
        return;
      }
      if (entry?.type === "output") {
        removeOutputNode(key);
        return;
      }
      if (entry?.type === "videoClip") {
        removeVideoClipNode(key);
        return;
      }
      if (entry?.type === "result") {
        removeResultNode(key);
      }
    },
    [
      removeAssetNode,
      removeGenNode,
      removeOutputNode,
      removeResultNode,
      removeScreenplayNode,
      canvasStore,
    ],
  );

  const copyCanvasNodes = useCallback(
    (keys: ReadonlySet<string>): CanvasNodeClipboard | null => {
      const captured = captureCanvasNodes(collectCanvasDocument(), keys);
      if (captured.nodes.length === 0) {
        toast.error(
          captured.skippedPendingOutputs > 0
            ? "进行中的产物尚未保存，暂时无法复制"
            : "请先选择要复制的节点",
        );
        return null;
      }
      writeCanvasNodeClipboard(captured);
      toast.success(`已复制 ${captured.nodes.length} 个节点`, {
        ...(captured.skippedPendingOutputs > 0
          ? { description: `跳过 ${captured.skippedPendingOutputs} 个尚未保存的产物` }
          : {}),
      });
      return captured;
    },
    [collectCanvasDocument],
  );
  const copySelectedCanvasNodes = useCallback(
    () => copyCanvasNodes(selectedCanvasNodeKeys),
    [copyCanvasNodes, selectedCanvasNodeKeys],
  );

  const insertCopiedCanvasNodes = useCallback((source: CanvasNodeClipboard, offset: { x: number; y: number }) => {
    const pasted = pasteCanvasNodes(source, offset, (entry) => `${entry.type}-${crypto.randomUUID()}`);
    if (insertSubgraph(pasted.nodes, pasted.edges, { selectNodeKey: null, groups: pasted.groups }) !== "applied") return;
    for (const [key, document] of Object.entries(pasted.promptContents)) promptContents.restoreDocument(key, document);
    scheduleCanvasSaveRef.current();
    setNodeMarquee(true);
    setMarqueeNodeKeys(new Set(pasted.keys));
    selectEdge(null);
  }, [insertSubgraph, promptContents, selectEdge]);

  const pasteCopiedCanvasNodes = useCallback(
    (source: CanvasNodeClipboard | null = canvasNodeClipboard) => {
      if (source == null || source.nodes.length === 0) {
        toast.error("请先复制画布节点");
        return;
      }
      const offset = 40 * ++canvasNodePasteCount;
      const anchor = viewportCenterBoardCoordinates();
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const { data } of source.nodes) {
        minX = Math.min(minX, data.x);
        minY = Math.min(minY, data.y);
        maxX = Math.max(maxX, data.x);
        maxY = Math.max(maxY, data.y);
      }
      insertCopiedCanvasNodes(source, {
        x: anchor.x - (minX + maxX) / 2 + offset,
        y: anchor.y - (minY + maxY) / 2 + offset,
      });
      toast.success(`已粘贴 ${source.nodes.length} 个节点`);
    },
    [insertCopiedCanvasNodes, viewportCenterBoardCoordinates],
  );

  const duplicateSelectedCanvasNodes = useCallback(() => {
    const copied = captureCanvasNodes(collectCanvasDocument(), selectedCanvasNodeKeys);
    if (!copied.nodes.length) {
      toast.info(copied.skippedPendingOutputs ? "产物保存后才能复制" : "请先选择节点");
      return;
    }
    insertCopiedCanvasNodes(copied, { x: 40, y: 40 });
    toast.success(`已复制 ${copied.nodes.length} 个节点`);
  }, [collectCanvasDocument, insertCopiedCanvasNodes, selectedCanvasNodeKeys]);

  const deleteSelectedCanvasNodes = useCallback(() => {
    const keys = [...selectedCanvasNodeKeys];
    if (keys.length === 0) return;
    for (const key of keys) removeSelectedCanvasNode(key);
    setMarqueeNodeKeys(new Set());
    toast.success(`已删除 ${keys.length} 个节点`);
  }, [removeSelectedCanvasNode, selectedCanvasNodeKeys]);

  const ignoreLegacyNodeDrag = useCallback(() => undefined, []);
  const ignoreLegacyConnectionStart = useCallback(() => undefined, []);

  // 画布节点 per-node 引用稳定缓存（配合 memo 化的 CanvasFlowNodeView）。
  const canvasFlowNodeCachesRef = useRef<CanvasFlowNodeCache>(undefined!);
  canvasFlowNodeCachesRef.current ??= new Map();

  const [artifactDeliveryBusy, setArtifactDeliveryBusy] = useState(false);
  const exportSelectedArtifacts = useCallback(async (contextNodeKey?: string) => {
    const exportKeys = contextNodeKey && !selectedCanvasNodeKeys.has(contextNodeKey)
      ? new Set([contextNodeKey])
      : selectedCanvasNodeKeys;
    const outputs = [
      ...canvasNodesNow("output").filter(node => exportKeys.has(node.key) && node.finalPath != null),
      ...canvasNodesNow("gen").flatMap(node => {
        if (node.kind !== "image" || !exportKeys.has(node.key)) return [];
        const output = imageNodePreview(node);
        return output?.finalPath ? [output] : [];
      }),
    ];
    if (!outputs.length) {
      toast.error("请先选中已保存到本机的产物。");
      return;
    }
    setArtifactDeliveryBusy(true);
    try {
      const directory = await exportArtifactDeliveryToDesktop(
        outputs.map((node) => ({
          ...node,
          finalPath: node.finalPath!,
          name: node.name ?? fileNameFromPath(node.finalPath!),
        })),
      );
      if (directory) toast.success(`已交付 ${outputs.length} 个产物`, { description: directory });
    } catch (error) {
      toast.error("批量交付失败", { description: backendErrorMessage(error) });
    } finally {
      setArtifactDeliveryBusy(false);
    }
  }, [canvasNodesNow, selectedCanvasNodeKeys]);

  const listFeatureAssets = useCallback<ListFeatureAssets>(async (source, kind, query, page) => {
    const pageSize = 32;
    if (source === "cloud") {
      if (!assetProvider?.id) return { items: [], hasNext: false };
      const records = await assetLibraryClient.list({ providerConnectionId: assetProvider.id,
        kind, name: query || null, pageNumber: page, pageSize });
      const items = records.map(cloudAssetToItem).filter(asset => asset.kind === kind &&
        asset.cloudStatus !== "failed" && asset.cloudStatus !== "deleted" && !cloudAssetAwaitingId(asset) &&
        !hiddenCloudAssetKeys.has(JSON.stringify([assetProvider.id, asset.dbId])));
      return { items, hasNext: records.length === pageSize };
    }
    const filters = { mediaType: kind, name: query || null, page, pageSize };
    const result = source === "local"
      ? await localBase64AssetClient.listAssets(filters)
      : await tosStagingClient.listLocalAssets(filters);
    return { items: result.items.map(localAssetToItem), hasNext: page * pageSize < result.total };
  }, [assetProvider?.id, hiddenCloudAssetKeys]);

  const referenceLibrary = useMemo(() => ({
    listAssets: listFeatureAssets,
    hasCloud: assetProvider != null,
  }), [listFeatureAssets, assetProvider != null]);

  async function chooseFeatureFile(kind: AssetItem["kind"], historyPath: string | null, signal: AbortSignal) {
    const path = historyPath ?? (await pickLocalMediaFiles([kind], { multiple: false }))[0];
    if (!path) return null;
    signal.throwIfAborted();
    const record = await localBase64AssetClient.importAsset({
      localPath: path,
      groupId: uploadTargetLocalGroupId(),
    });
    refreshLocalAssets("upload-finished");
    signal.throwIfAborted();
    if (record.mediaType !== kind || !activeRef.current) return null;
    return localAssetToItem(record);
  }

  function getFeatureSources(action: CanvasFeatureAction) {
    const state = canvasStore.getState();
    const model = canvasReadModelOfState(state);
    const mediaType = canvasFeatureMediaType(action);
    const singleSelection = selectedCanvasNodeKeys.size === 1;
    const sources: (CanvasFeatureTarget & {
      target: MediaReferenceTarget;
      output?: OutputNodeData;
    })[] = [];
    const representedOutputs = new Set<string>();
    for (const node of model.nodes.gen) {
      if (node.kind !== mediaType) continue;
      const output = latestGenerationPreviewFor(model, node.key);
      if (!output?.finalPath || output.mediaType !== mediaType) continue;
      const target = outputNodeReferenceTarget(output);
      if (!target) continue;
      const label = node.name ?? output.name ?? ({ video: "视频节点", image: "图片节点", audio: "音频节点" })[mediaType];
      const selected = singleSelection && selectedCanvasNodeKeys.has(node.key);
      sources.push({ key: node.key, label, selected, target, output, previewSrc: toMediaSrc(output.finalPath) });
      representedOutputs.add(output.key);
    }
    for (const node of model.nodes.asset) {
      if (node.libraryResource || node.kind !== mediaType || !node.assetId || (node.source !== "local" && !node.providerConnectionId)) continue;
      sources.push({ key: node.key, label: node.name, selected: singleSelection && selectedCanvasNodeKeys.has(node.key),
        target: assetNodeReferenceTarget(node), previewSrc: node.videoUrl ?? node.previewUrl ?? null });
    }
    for (const node of model.nodes.output) {
      if (node.mediaType !== mediaType || !node.finalPath) continue;
      const isSelected = selectedCanvasNodeKeys.has(node.key);
      if (!isSelected && representedOutputs.has(node.key)) continue;
      const target = outputNodeReferenceTarget(node);
      if (!target) continue;
      const label = node.name ?? ({ video: "视频产物", image: "图片产物", audio: "音频产物" })[mediaType];
      sources.push({ key: node.key, label, selected: singleSelection && isSelected, target, output: node, previewSrc: toMediaSrc(node.finalPath) });
    }
    return sources;
  }

  function attachTextReference(nodeKey: string, source: string | AssetItem) {
    const state = canvasStore.getState();
    const node = state.nodesById[nodeKey];
    if (!activeRef.current || node?.type !== "gen" || node.data.kind !== "prompt" || node.data.config.sourcePrompt.trim()) {
      throw new Error("文本节点已变化，请重新选择参考图。");
    }
    runWithCoalescedHistory(() => {
      let sourceKey: string;
      if (typeof source === "string") {
        if (!getFeatureSources({ kind: "image-hd" }).some(item => item.key === source)) {
          throw new Error("参考图已变化，请重新选择。");
        }
        sourceKey = source;
      } else {
        if (source.kind !== "image") throw new Error("请选择图片素材。");
        const image = addAssetNode(source, node.data.x - NEW_NODE_GAP - ASSET_NODE_WIDTH / 2,
          node.data.y + ASSET_NODE_HEIGHT / 2);
        if (!image) throw new Error("无法将该图片放到当前画布。");
        sourceKey = image.key;
      }
      const alreadyConnected = canvasStore.getState().assetEdges.some(edge => edge.fromKey === sourceKey && edge.toKey === nodeKey);
      if (!alreadyConnected && !connectCanvasNodes(sourceKey, nodeKey)) throw new Error("无法连接参考图。");
      patchPromptNodeConfigField(nodeKey, { sourcePrompt: IMAGE_TO_PROMPT_NODE_PROMPT });
      selectNode(nodeKey);
    });
    setTextReferenceKey(null);
    scheduleCanvasSaveRef.current();
  }

  function attachScriptReference(request: ScriptReferencePick, source: string | AssetItem) {
    const { nodeKey, assetId, character } = request;
    const state = canvasStore.getState();
    const node = state.nodesById[nodeKey];
    const script = node?.type === "screenplay" ? node.data.config.scriptGenerator : null;
    if (!activeRef.current || !node || !script || promptSubmissionGuardRef.current.has(nodeKey) ||
      (assetId && !script.assets.some(asset => asset.id === assetId))) {
      throw new Error("脚本或资产已变化，请重新选择参考图。");
    }
    runWithCoalescedHistory(() => {
      let sourceKey: string;
      let name: string;
      if (typeof source === "string") {
        const image = getFeatureSources({ kind: "image-hd" }).find(item => item.key === source);
        if (!image) throw new Error("参考图已变化，请重新选择。");
        sourceKey = image.key;
        name = image.label;
      } else {
        if (source.kind !== "image") throw new Error("请选择图片素材。");
        const image = addAssetNode(source, node.data.x - NEW_NODE_GAP - ASSET_NODE_WIDTH / 2,
          node.data.y + ASSET_NODE_HEIGHT / 2);
        if (!image) throw new Error("无法将该图片放到当前画布。");
        sourceKey = image.key;
        name = image.name;
      }
      const alreadyConnected = state.assetEdges.some(edge => edge.fromKey === sourceKey && edge.toKey === nodeKey);
      if (!alreadyConnected && !connectCanvasNodes(sourceKey, nodeKey)) {
        if (typeof source !== "string") removeCanvasNode(sourceKey);
        throw new Error("无法连接参考图，请检查是否会形成循环连线。");
      }
      if (assetId || character) {
        updateScreenplayNode(nodeKey, (config) => {
          const current = config.scriptGenerator;
          if (!current) return config;
          const reference = { kind: "canvas" as const, sourceKey };
          const assets = assetId ? current.assets.map(asset =>
            asset.id === assetId ? { ...asset, name: asset.name.trim() ? asset.name : name, reference } : asset)
            : current.assets.some(asset => asset.kind === "character" && asset.reference?.kind === "canvas" &&
              asset.reference.sourceKey === sourceKey) ? current.assets : [
              ...current.assets, { id: crypto.randomUUID(), kind: "character" as const, name, description: "", reference },
            ];
          const next = { ...current, assets };
          return {
            ...config, scriptGenerator: next, currentDocument: scriptDocument(next),
            composer: character && !config.composer.trim()
              ? "以参考图中的角色为主角生成分镜脚本，保持角色造型和动作连贯。" : config.composer,
          };
        });
      }
    });
    setScriptReferencePick(null);
    scheduleCanvasSaveRef.current();
  }

  const openDirectorEditor = useCallback((key: string) => {
    setDirectorEditorKey(key);
  }, []);

  const setDirectorPrompt = useCallback((key: string, prompt: string) => {
    runWithCoalescedHistory(() => patchNode("director", key, node => node.prompt === prompt ? node : { ...node, prompt }));
  }, [patchNode, runWithCoalescedHistory]);

  const renameDirector = useCallback((key: string, name: string) => {
    const title = name.trim().slice(0, 80);
    if (title) patchNode("director", key, node => node.name === title ? node : { ...node, name: title });
  }, [patchNode]);

  const generateDirectorScene = useCallback((key: string, motion?: DirectorMotionRequest, image?: DirectorImageRequest) => {
    if (promptSubmissionGuardRef.current.has(key)) return;
    const entry = canvasStore.getState().nodesById[key];
    if (entry?.type !== "director") return;
    const images = () => canvasInputsFor(key).media.filter(input => input.kind === "image" && (!image || input.sourceKey === image.referenceKey)).slice(0, 6)
      .map(input => ({ target: input.target, displayName: input.name }));
    const references = images();
    const prompt = entry.data.prompt;
    const camera = motion ? entry.data.scene.objects.find(item => item.id === motion.cameraId && item.kind === "camera") : null;
    if (image && !references.length) { setNodeStartError(key, "参考图已移除，请重新选择。"); return; }
    if (image?.mode === "insert" && entry.data.scene.objects.length >= 80) {
      setNodeStartError(key, "场景已有 80 项，请精简后再插入。");
      return;
    }
    if (motion ? !camera : !prompt.trim() && !references.length) return;
    if (!isDesktopRuntime()) { setNodeStartError(key, "请在桌面应用中生成场景。"); return; }
    const settings = textTryStateRef.current;
    const selected = image?.model ?? settings.nodeModelSelections.prompt;
    const enabled = settings.providerCatalog.find(item => item.provider.enabled && item.provider.id === selected.providerId);
    const model = enabled?.models.find(item => isTextGenerationModel(item) && item.definitionId === selected.modelDefinitionId);
    if (image && !model) {
      setNodeStartError(key, "所选识图模型已不可用，请重新选择。");
      return;
    }
    const resolved = model ? selected : firstTextModelSelection(settings.providerCatalog);
    if (!resolved.providerId || !resolved.modelDefinitionId) {
      setNodeStartError(key, "请先在全局设置中配置文本模型。参考图搭景需要支持图片输入的模型。");
      return;
    }
    const frozenReferences = JSON.stringify(references);
    setNodeStartError(key, null);
    promptSubmissionGuardRef.current.add(key);
    setStartingNodeKeys(current => new Set(current).add(key));
    return promptNodeClient.run({
      canvasId, sourceNodeId: key, providerConnectionId: resolved.providerId, modelDefinitionId: resolved.modelDefinitionId,
      mode: "video_prompt", generalText: true, task: "generate",
      userPrompt: motion && camera ? directorMotionRequest(entry.data.scene, camera, motion.prompt)
        : references.length ? directorImagePrompt(prompt.trim(), image?.charactersOnly ?? false) : directorSceneRequest(prompt.trim()),
      visionImages: motion ? [{ displayName: "导演台当前视角", dataUrl: motion.preview }] : references,
    }).then(result => {
      const base = entry.data.scene;
      const track = camera ? parseDirectorMotion(result.optimizedPrompt, camera, base.duration) : null;
      const next = track ? { ...base, tracks: [...base.tracks.filter(item => item.objectId !== track.objectId), track] }
        : mergeDirectorLayout(base, { ...parseDirectorLayout(result.optimizedPrompt, "model", image?.charactersOnly),
          aspect: base.aspect, duration: base.duration }, image?.mode ?? "replace");
      let applied = false;
      patchNode("director", key, node => {
        if (node.scene !== base || (!motion && (node.prompt !== prompt || JSON.stringify(images()) !== frozenReferences))) return node;
        applied = true;
        return { ...node, scene: next, previewUrl: null, panoramaKey: image?.mode === "replace" ? null : node.panoramaKey };
      });
      if (applied) {
        toast.success(motion ? "运镜已写入机位轨道。" : "3D 场景已生成，可以打开导演台继续编辑。");
      } else toast.info("当前布局已变化。模型回复可从任务历史查看。");
      return applied;
    }).catch(error => {
      setNodeStartError(key, backendErrorMessage(error));
      return false;
    }).finally(() => {
      promptSubmissionGuardRef.current.delete(key);
      setStartingNodeKeys(current => { const next = new Set(current); next.delete(key); return next; });
      refreshTasks();
    });
  }, [canvasId, canvasStore, canvasInputsFor, patchNode, refreshTasks, setNodeStartError]);

  function attachDirectorReference(key: string, source: string | AssetItem) {
    const state = canvasStore.getState();
    const target = state.nodesById[key];
    if (!activeRef.current || target?.type !== "director") throw new Error("导演台已变化，请重新选择参考图。");
    runWithCoalescedHistory(() => {
      let sourceKey: string;
      if (typeof source === "string") {
        if (!getFeatureSources({ kind: "image-hd" }).some(item => item.key === source)) throw new Error("参考图已变化。");
        sourceKey = source;
      } else {
        if (source.kind !== "image") throw new Error("请选择图片。");
        const image = addAssetNode(source, target.data.x - NEW_NODE_GAP - ASSET_NODE_WIDTH / 2,
          target.data.y + ASSET_NODE_HEIGHT / 2);
        if (!image) throw new Error("素材无法添加到当前画布。");
        sourceKey = image.key;
      }
      if (!state.assetEdges.some(edge => edge.fromKey === sourceKey && edge.toKey === key) &&
        !connectCanvasNodes(sourceKey, key)) {
        if (typeof source !== "string") removeCanvasNode(sourceKey);
        throw new Error("参考图无法连入导演台，请检查是否形成循环。");
      }
    });
    setDirectorReferenceKey(null);
  }

  async function saveDirectorCaptures(key: string, media: readonly DirectorMediaCapture[], signal: AbortSignal) {
    if (!isDesktopRuntime() || canvasStore.getState().nodesById[key]?.type !== "director") throw new Error("请在桌面画布中导出场景。");
    const records = await importDirectorMedia(media, signal);
    const first = records[0];
    if (!first) throw new Error("没有可导出的截图或视频。");
    signal.throwIfAborted();
    const state = canvasStore.getState();
    const entry = state.nodesById[key];
    if (!activeRef.current || entry?.type !== "director") throw new Error("画布已切换，导出的文件已保存在素材库。");
    const bounds = liveCanvasNodeRect(entry);
    const occupied = Object.values(state.nodesById).map(liveCanvasNodeRect);
    const columns = records.length === 4 ? 2 : records.length === 12 ? 4 : 1;
    const rows = Math.ceil(records.length / columns);
    const size = fitMediaNodeDimensions(first.capture.aspectRatio);
    const gap = 48;
    const groupId = records.length > 1 ? `director-captures-${crypto.randomUUID()}` : null;
    const right = state.assetEdges.reduce((edgeRight, edge) => {
      const output = edge.fromKey === key ? state.nodesById[edge.toKey] : null;
      if (!output) return edgeRight;
      const rect = liveCanvasNodeRect(output);
      return Math.max(edgeRight, rect.x + rect.width);
    }, bounds.x + bounds.width);
    const origin = nearestAvailableNodePosition({
      x: right + gap, y: bounds.y, width: columns * size.width + (columns - 1) * gap,
      height: rows * size.height + (rows - 1) * gap,
    }, occupied);
    const nodes = records.map(({ capture, record }, index): AssetNodeData => {
      return {
        key: assetNodeKey(), source: "local", providerConnectionId: "", assetId: record.id,
        kind: capture.kind, name: capture.name, previewUrl: record.previewUrl,
        videoUrl: capture.kind === "video" ? record.previewUrl : null, aspectRatio: capture.aspectRatio,
        x: origin.x + index % columns * (size.width + gap),
        y: origin.y + Math.floor(index / columns) * (size.height + gap),
        ...(groupId ? { assetGroupId: groupId } : {}),
      };
    });
    const preview = records.find(item => item.capture.kind === "image")?.record.previewUrl;
    runWithCoalescedHistory(() => {
      if (insertSubgraph(nodes.map(data => ({ type: "asset", data })), nodes.map(data => ({
        id: `${key}->${data.key}`, fromKey: key, toKey: data.key,
      })), groupId ? { groups: { [groupId]: { id: groupId, name: `${entry.data.name} · 多视角`, collapsed: false } } } : undefined)
        !== "applied") throw new Error("导出的文件已保存到素材库，请从素材库添加到画布。");
      if (preview) patchNode("director", key, node => ({ ...node, previewUrl: preview }));
    });
    toast.success(`已导出 ${nodes.length} 项素材到画布`);
  }

  function featureNodePlacement(entry: CanvasNodeEntry, kind: "image" | "video") {
    const bounds = liveCanvasNodeRect(entry);
    return nearestAvailableNodePosition({
      x: bounds.x + bounds.width + NEW_NODE_GAP,
      y: bounds.y,
      ...genNodeDimensions(kind),
    }, Object.values(canvasStore.getState().nodesById).map(liveCanvasNodeRect));
  }

  function openCanvasFeature(action: CanvasFeatureAction, key: string, label: string, assetPreview?: string | null) {
    if (!isDesktopRuntime()) {
      toast.error("请在桌面应用中使用画布编辑工具。");
      return false;
    }
    const source = getFeatureSources(action).find(candidate => candidate.key === key);
    const entry = canvasStore.getState().nodesById[key];
    if (!source || !entry) {
      toast.error("素材已变化，请重新选择。");
      return false;
    }
    if (action.kind === "video-crop") {
      const { x, y, width, height } = liveCanvasNodeRect(entry);
      const flow = flowInstanceRef.current;
      if (flow) void flow.setCenter(x + width / 2, y + height / 2, { zoom: flow.getZoom(), duration: 200 });
      closeNodeEditor();
      const target = { ...source.target, canvasNodeKey: key };
      const session: VideoFrameCropSession = {
        key, target, name: source.label,
        onClose: () => setVideoFrameCrop(current => current === session ? null : current),
        onResult: (output, job) => {
          const current = getFeatureSources(action).find(candidate => candidate.key === key);
          if (current && sameMediaReferenceTarget(current.target, source.target)) usePreparedVideoOutput(output, job);
          session.onClose();
        },
      };
      setVideoFrameCrop(session);
      return true;
    }
    if (action.kind === "video-preparation") {
      setVideoPreparation({ target: { ...source.target, canvasNodeKey: key }, name: source.label,
        initialOperation: action.mode, ...(action.tool ? { tool: action.tool } : {}) });
      return true;
    }
    if (action.kind === "atlas-tool") {
      const previewSrc = source.previewSrc ?? assetPreview;
      setAtlasTool({ action, label, nodeKey: key, sourceLabel: source.label, target: source.target,
        ...(previewSrc ? { previewSrc } : {}) });
      return true;
    }
    const fromKey = source.output?.key ?? key;
    if (action.kind === "image-hd" || action.kind === "image-preset" || action.kind === "image-camera") {
      const chosen = resolveGenerationSelection("image", nodeModelSelections.image, providerCatalog);
      const eligible = chosen?.model.operations.includes("image_to_image") ? chosen : providerCatalog.flatMap(provider =>
        provider.provider.enabled ? provider.models.filter(model => isImageGenerationModel(model) &&
          model.operations.includes("image_to_image")).map(model => ({ provider, model })) : [])[0];
      if (action.kind !== "image-hd" && !eligible) {
        toast.error("请先启用支持参考图编辑的模型。");
        return false;
      }
      const selection = eligible ? { providerId: eligible.provider.provider.id, modelDefinitionId: eligible.model.definitionId } : nodeModelSelections.image;
      const config = createImageNodeConfig(selection, providerCatalogLoaded);
      const preset = action.kind === "image-preset" ? canvasImagePreset(action.scene) : null;
      if (action.kind === "image-preset" && !preset) return false;
      const configured = preset && eligible ? selectCanvasImagePreset(preset,
        modelParameterCapabilities(eligible.model.operationSchema, "image_to_image", eligible.model.remoteModelId),
        config.parameterValues, selection.providerId + "::" + selection.modelDefinitionId) : null;
      const node: GenNodeData = {
        key: genNodeKey(), kind: "image", name: label, ...featureNodePlacement(entry, "image"),
        config: { ...config, imageMode: action.kind === "image-hd" ? "upscale" : "image_to_image",
          ...(configured ? { imagePreset: configured.selection, parameterValues: configured.parameterValues } : {}),
          ...(action.kind === "image-camera" ? { cameraControl: { ...editableCanvasCameraControl(config.cameraControl), enabled: true } } : {}),
        },
      };
      return insertSubgraph([{ type: "gen", data: node }], [{ id: fromKey + "->" + node.key, fromKey, toKey: node.key }],
        { selectNodeKey: node.key }) === "applied";
    }
    if (action.kind === "video-draft") {
      const eligible = providerCatalog.flatMap(provider => provider.provider.enabled
        ? provider.models.filter(model => model.operations.includes("video_generation") && isSeedance25VideoModel(model.remoteModelId))
          .map(model => ({ provider, model }))
        : []);
      const inputs = [{ key: fromKey, kind: "video" as const }];
      const compatible = eligible.find(({ model }) => {
        const capabilities = modelParameterCapabilities(model.operationSchema, "video_generation", model.remoteModelId);
        return resolveSeedanceTask(model.remoteModelId, capabilities, { seedanceTaskMode: action.mode, parameterValues: {} },
          inputs, model.operationSchema).enabled;
      });
      if (!compatible) {
        toast.error("请先启用支持视频编辑或延长的 Seedance 2.5 模型。");
        return false;
      }
      const { model, provider } = compatible;
      const caps = modelParameterCapabilities(model.operationSchema, "video_generation", model.remoteModelId);
      const config = createVideoNodeConfig({ providerId: provider.provider.id, modelDefinitionId: model.definitionId }, providerCatalogLoaded);
      const node: GenNodeData = {
        key: genNodeKey(), kind: "video", name: label, ...featureNodePlacement(entry, "video"),
        config: { ...selectSeedanceTask(model.remoteModelId, caps, config, inputs, action.mode, model.operationSchema), videoMode: action.mode },
      };
      if (insertSubgraph([{ type: "gen", data: node }], [{ id: fromKey + "->" + node.key, fromKey, toKey: node.key }],
        { selectNodeKey: node.key }) !== "applied") return false;
      promptContents.restoreDocument(node.key, { schema: "prompt-content", version: 1, items: [{ kind: "text", text: action.prompt }] });
      scheduleCanvasSaveRef.current();
      if (action.mark) openVideoLocalEdit(node.key, { key: fromKey });
      return true;
    }
    if (entry.type !== "gen" || action.kind === "image-local" || action.kind === "video-opening") {
      setFeatureMedia({ action, nodeKey: key, label, source: source.output ??
        { key, name: source.label, target: source.target } });
      return true;
    }
    if (!source.output?.finalPath) return false;
    const request: CanvasInlineFeatureRequest = {
      nodeKey: key,
      sourcePath: source.output.finalPath,
      action,
      onHandled: () => setFeatureRequest(current => current === request ? null : current),
    };
    const { x, y, width, height } = liveCanvasNodeRect(entry);
    const flow = flowInstanceRef.current;
    if (flow) void flow.setCenter(x + width / 2, y + height / 2, { zoom: flow.getZoom(), duration: 200 });
    closeNodeEditor();
    setFeatureRequest(request);
    return true;
  }

  function openCanvasFeatureAsset(action: CanvasFeatureAction, asset: AssetItem, label: string) {
    if (!isDesktopRuntime() || asset.kind !== canvasFeatureMediaType(action)) return false;
    const existing = canvasNodesNow("asset").find(node => node.assetId === asset.id &&
      node.source === (asset.source ?? "cloud") && (node.source === "local" || node.providerConnectionId === asset.providerConnectionId) && node.kind === asset.kind);
    if (existing) return openCanvasFeature(action, existing.key, label, asset.videoUrl ?? asset.previewUrl);
    const point = viewportCenterBoardCoordinates();
    const node = addAssetNode(asset, point.x, point.y);
    if (!node) {
      toast.error("素材已变化，请重新选择。");
      return false;
    }
    return openCanvasFeature(action, node.key, label, asset.videoUrl ?? asset.previewUrl);
  }

  async function startAtlasCanvasTool(session: CanvasAtlasToolSession, options: CanvasAtlasToolOptions) {
    const live = getFeatureSources(session.action).find(source => source.key === session.nodeKey);
    const entry = canvasStore.getState().nodesById[session.nodeKey];
    if (!live || !entry || !sameMediaReferenceTarget(live.target, session.target)) throw new Error("来源素材已变化，请重新选择。");
    const kind = session.action.mode === "video_upscale" ? "video" : "image";
    const key = genNodeKey();
    const clientTaskId = crypto.randomUUID();
    const name = session.label;
    const selection = { providerId: options.providerId, modelDefinitionId: "" };
    const base = { key, name, ...featureNodePlacement(entry, kind) };
    const node: GenNodeData = kind === "video" ? { ...base, kind, config: createVideoNodeConfig(selection, providerCatalogLoaded) }
      : { ...base, kind, config: createImageNodeConfig(selection, providerCatalogLoaded) };
    const fromKey = live.output?.key ?? entry.data.key;
    if (insertSubgraph([{ type: "gen", data: node }], [{ id: fromKey + "->" + key, fromKey, toKey: key }]) !== "applied") {
      throw new Error("未能创建结果节点，请重试。");
    }
    const generation: StartGenerationCommand = {
      clientTaskId, canvasId, sourceNodeId: key, outputName: name,
      operation: kind === "video" ? "video_generation" : "image_to_image",
      providerConnectionId: options.providerId, modelDefinitionId: "", generationCount: 1,
      explicitMedia: [{ target: live.target, role: kind, displayNameSnapshot: live.label }],
      prompt: options.prompt ? [{ kind: "text", text: options.prompt }] : [],
      parameters: options.parameters,
    };
    setStartingNodeKeys(current => new Set(current).add(key));
    try {
      const taskId = await invokeDesktop("start_canvas_feature_generation", v.string(), {
        tool: session.action.mode, generation,
      }).catch(async (failure: unknown) => {
        const known = await generationClient.get(clientTaskId).catch((lookup: unknown) => {
          if (typeof lookup === "object" && lookup != null && "kind" in lookup && lookup.kind === "not_found") return null;
          setNodeStartError(key, backendErrorMessage(failure));
          return undefined;
        });
        if (known) return known.summary.id;
        if (known === null) {
          removeCanvasNode(key);
          throw failure;
        }
        toast.error("任务回执异常，请在生成历史中核对。");
        return null;
      });
      if (kind === "image" && taskId) registerImageGeneration(key, [taskId]);
      if (taskId) selectNode(key);
      return taskId;
    } finally {
      setStartingNodeKeys(current => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
      refreshTasks();
    }
  }

  async function startOpeningLayerSplit(assetKey: string, providerId: string) {
    const action = { kind: "atlas-tool", mode: "image_layers" } as const;
    const source = getFeatureSources(action).find(candidate => candidate.key === assetKey);
    if (!source) throw new Error("分层源图已变化，请重新选择。");
    const taskId = await startAtlasCanvasTool({ action, label: "片头图层分离", nodeKey: assetKey, sourceLabel: source.label, target: source.target },
      { providerId, prompt: "", parameters: {} });
    if (!taskId) throw new Error("未收到图层任务回执，请在生成历史核对。");
    return taskId;
  }

  function openVideoOpeningDraft({ firstFrameKey, title, motion }: VideoOpeningDraft) {
    const frame = canvasStore.getState().nodesById[firstFrameKey];
    if (frame?.type !== "asset" || frame.data.kind !== "image") return;
    const config = createVideoNodeConfig(nodeModelSelections.video, providerCatalogLoaded);
    const node: GenNodeData = {
      key: genNodeKey(), kind: "video", name: title + " · 创意片头", ...featureNodePlacement(frame, "video"),
      config: { ...config, videoMode: "first_frame", seedanceTaskMode: "first_frame", mediaRoles: { [firstFrameKey]: "first_frame" } },
    };
    if (insertSubgraph([{ type: "gen", data: node }],
      [{ id: firstFrameKey + "->" + node.key, fromKey: firstFrameKey, toKey: node.key }], { selectNodeKey: node.key }) !== "applied") {
      toast.error("片名已保存为图片，未能创建动效节点。");
      return;
    }
    promptContents.restoreDocument(node.key, { schema: "prompt-content", version: 1, items: [
      { kind: "text", text: `设计简洁的创意片头。片名为「${title}」，保持参考图中的文字、位置和字形。${motion}` },
    ] });
    scheduleCanvasSaveRef.current();
  }

  const openVideoPreparation = useCallback(
    (key: string) => {
      if (!isDesktopRuntime()) {
        toast.error("视频准备需要在桌面应用中运行。");
        return;
      }
      const entry = canvasStore.getState().nodesById[key];
      const target =
        entry?.type === "asset" && entry.data.kind === "video"
          ? assetNodeReferenceTarget(entry.data)
          : entry?.type === "output" && entry.data.mediaType === "video"
            ? outputNodeReferenceTarget(entry.data)
            : null;
      if (!target) {
        toast.error("请先保存视频，再进行视频准备。");
        return;
      }
      setVideoPreparation({
        target,
        name:
          entry?.type === "asset" || entry?.type === "output"
            ? (entry.data.name ?? "视频")
            : "视频",
      });
    },
    [canvasStore],
  );

  const usePreparedVideoOutput = useCallback(
    (output: VideoPreparationOutput, job: VideoPreparationJob) => {
      const snapshot = canvasStore.getState();
      const existing = canvasNodesOfState(snapshot, "output").find(
        (node) =>
          node.origin === "video_preparation" &&
          node.taskId === job.jobId &&
          node.finalPath === output.path,
      );
      if (existing) {
        selectNode(existing.key);
        toast.success("该产物已在当前画布");
        return existing.key;
      }
      const sourceKey = job.source.canvasNodeKey ?? "";
      const key = outputNodeKey();
      addOutput((current, nodesById) => {
        const entry = nodesById[sourceKey];
        const source = entry ? liveCanvasNodeRect(entry) : { x: 80, y: 80, width: 320, height: 240 };
        return resolveCurrentArtifactName({
          key,
          resultKey: null,
          sourceNodeId: sourceKey,
          taskId: job.jobId,
          origin: "video_preparation",
          mediaType: output.kind,
          finalPath: output.path,
          name: output.name,
          previewSrc: null,
          ...(output.width && output.height ? { aspectRatio: output.width / output.height } : {}),
          ...nextPreparedMediaOutputSlot(
            source,
            current,
            outputPlacementOptionsFor(nodesById, sourceKey),
          ),
        });
      });
      toast.success(`已将「${output.name}」加入画布`);
      return key;
    },
    [canvasStore, selectNode, addOutput, outputPlacementOptionsFor],
  );

  const longVideoJobs = useLongVideoJobs(canvasId);
  useEffect(() => {
    if (!canvasHydrated) return;
    for (const job of clipRenderJobs.data ?? []) {
      const source = canvasStore.getState().nodesById[job.sourceNodeId];
      if (source?.type !== "videoClip") continue;
      if (source.data.config.agentSubmission?.id === job.id) updateVideoClipConfig(job.sourceNodeId, { agentSubmission: null });
      const outputs = job.agent ? job.agent.outputs : job.status === "completed" && job.outputPath ? [{ id: job.id, path: job.outputPath, name: job.name }] : [];
      for (const output of outputs) {
        const entry = canvasStore.getState().nodesById[job.sourceNodeId];
        if (entry?.type !== "videoClip" || entry.data.config.renderDeliveries?.includes(output.id)) continue;
        if (!canvasNodesOfState(canvasStore.getState(), "output").some(node => node.taskId === output.id && node.finalPath === output.path)) {
          addOutput((current, nodesById) => ({
            key: outputNodeKey(), resultKey: null, taskId: output.id, sourceNodeId: job.sourceNodeId,
            origin: "composition", mediaType: "video", finalPath: output.path, previewSrc: null, name: output.name,
            ...nextOutputSlot({ x: entry.data.x, y: entry.data.y, measured: { width: entry.data.measured?.width ?? 566, height: 350 } }, current, outputPlacementOptionsFor(nodesById, job.sourceNodeId)),
          }));
        }
        updateVideoClipConfig(job.sourceNodeId, { renderDeliveries: [...(entry.data.config.renderDeliveries ?? []), output.id] });
      }
    }
  }, [canvasHydrated, clipRenderJobs.data, canvasStore, addOutput, outputPlacementOptionsFor, updateVideoClipConfig]);
  /*
   * 别的画布上可能还有长视频在跑。
   *
   * 长视频的界面入口是按画布的：切到这张画布后，另一张画布上的编排还在每 1.2 秒提交一个片段
   * （每一段都是真金白银），而「结束编排」按钮在另一张画布上——不提示的话，
   * 用户根本不知道还有钱在花。同一组任务只提示一次，避免每次切画布都弹。
   */
  const longVideoNoticeRef = useRef("");
  // 画布清单是数组 prop，每次渲染都可能是新引用：放进 ref，避免它把下面的 effect 变成「每渲染一次查一次」。
  const canvasCatalogRef = useRef(canvasCatalog);
  canvasCatalogRef.current = canvasCatalog;
  useEffect(() => {
    if (!active) return;
    void longVideoClient.listActive().then(jobs => {
      const others = jobs.filter(job => job.canvasId !== canvasId);
      if (others.length === 0) return;
      // 提示的去重键要带上状态：同一个任务从「尚未结束」变成「正在生成」时，
      // 光看 id 会认为「没变」而不再提示，用户看到的还是那句「尚未结束」。
      const key = others.map(job => `${job.id}:${job.status}`).sort().join(",");
      if (key === longVideoNoticeRef.current) return;
      longVideoNoticeRef.current = key;
      // 分开说「正在生成」与「尚未结束」：应用重启后的任务都是暂停状态，
      // 一律说成「生成中」会让用户以为钱在白花。
      const active = others.filter(job => ["planning", "generating", "composing"].includes(job.status)).length;
      const idle = others.length - active;
      const parts: string[] = [];
      if (active > 0) parts.push(`${active} 个正在生成`);
      if (idle > 0) parts.push(`${idle} 个尚未结束`);
      const names = [...new Set(others.map(job => canvasCatalogRef.current?.find(item => item.id === job.canvasId)?.name ?? "另一张画布"))];
      toast.info(`别的画布上还有长视频：${parts.join("、")}（${names.join("、")}），切回那张画布可以查看与暂停。`);
    }).catch(() => undefined);
  }, [active, canvasId]);
  const putLongVideoResults = useCallback((job: LongVideoJob, kind: "segments" | "output", standalone = false) => {
    // 返回新增数与总数：成片在任务完成时会自动放回画布，用户再点一次时新增数是 0，
    // 但那不代表「没有成片」——只是已经在画布上了，提示要说清楚。
    if (job.canvasId !== canvasId) return { added: 0, total: 0 };
    const artifacts = kind === "output" && job.output ? [{
      taskId: job.id, resultKey: null, finalPath: job.output.path, name: job.output.name,
      origin: "long_video" as const, aspectRatio: job.output.width / job.output.height,
    }] : kind === "segments" ? job.shots.flatMap((shot, index) => {
      const taskId = shot.attempts.at(-1);
      return shot.finalPath && taskId && shot.resultIndex != null ? [{
        taskId, resultKey: `${taskId}#${shot.resultIndex}`, finalPath: shot.finalPath,
        name: `${job.title} · 镜头 ${index + 1} · ${shot.title}`, origin: "generation" as const, aspectRatio: 16 / 9,
      }] : [];
    }) : [];
    const keys: string[] = [];
    let added = 0;
    for (const artifact of artifacts) {
      const existing = canvasNodesOfState(canvasStore.getState(), "output").find(node => node.taskId === artifact.taskId && node.finalPath === artifact.finalPath);
      if (existing) {
        if ((standalone || kind === "segments") && !existing.standalone) {
          patchNode("output", existing.key, node => ({ ...node, standalone: true }));
          added += 1;
        }
        keys.push(existing.key);
        continue;
      }
      const key = outputNodeKey();
      addOutput((current, nodesById) => {
        const source = nodesById[job.sourceNodeId]?.data;
        return {
          key, ...artifact, sourceNodeId: job.sourceNodeId, mediaType: "video", previewSrc: null,
          standalone: standalone || kind === "segments",
          ...nextOutputSlot({ x: source?.x ?? 80, y: source?.y ?? 80, measured: { width: 622, height: 350 } }, current, outputPlacementOptionsFor(nodesById, job.sourceNodeId)),
        };
      });
      keys.push(key);
      added += 1;
    }
    if (kind === "segments" && keys.length > 1) {
      const groupId = `long-video-segments:${job.id}`;
      groupNodes(keys, groupId);
      canvasStore.getState().updateGroup(groupId, { name: `${job.title} · 成功片段` });
    }
    return { added, total: artifacts.length };
  }, [canvasId, canvasStore, addOutput, outputPlacementOptionsFor, groupNodes, patchNode]);
  useEffect(() => {
    if (!canvasHydrated) return;
    for (const job of longVideoJobs.data ?? []) {
      if (!job.output) continue;
      const source = canvasStore.getState().nodesById[job.sourceNodeId];
      if (source?.type !== "gen" || source.data.kind !== "video" || source.data.config.longVideoDeliveries?.includes(job.id)) continue;
      putLongVideoResults(job, "output");
      patchNode("gen", job.sourceNodeId, node => node.kind === "video" ? { ...node, config: { ...node.config, longVideoDeliveries: [...(node.config.longVideoDeliveries ?? []), job.id] } } : node);
    }
  }, [canvasHydrated, longVideoJobs.data, putLongVideoResults, canvasStore, patchNode]);
  useEffect(() => {
    const created = (event: Event) => {
      const detail = (event as CustomEvent<{ canvasId?: string }>).detail;
      if (detail?.canvasId === canvasId) void longVideoJobs.refetch();
    };
    const recover = (event: Event) => {
      const detail = (event as CustomEvent<{ jobId?: string; kind?: string }>).detail;
      if (!detail?.jobId || (detail.kind !== "segments" && detail.kind !== "output")) return;
      const kind = detail.kind;
      void longVideoClient.get(detail.jobId).then(job => {
        if (job.canvasId !== canvasId) return;
        const placed = putLongVideoResults(job, kind, true);
        // 没有产物可放回时不要报成功：那会让用户以为片段已经放上画布。
        if (placed.added > 0) toast.success(kind === "segments" ? `已放回 ${placed.added} 个成功片段` : "成片已放回画布");
        else if (placed.total > 0) toast.info("这些产物已经在画布上了");
        else toast.info(kind === "segments" ? "还没有已保存的片段可以放回画布" : "还没有成片可以放回画布");
      }).catch((error: unknown) => toast.error("读取长视频产物失败", { description: backendErrorMessage(error) }));
    };
    window.addEventListener("canvas:long-video-created", created);
    window.addEventListener(LONG_VIDEO_RESULTS_REQUEST_EVENT, recover);
    return () => {
      window.removeEventListener("canvas:long-video-created", created);
      window.removeEventListener(LONG_VIDEO_RESULTS_REQUEST_EVENT, recover);
    };
  }, [canvasId, longVideoJobs.refetch, putLongVideoResults]);

  const openNodeEditor = useCallback(
    (key: string) => {
      const entry = canvasStore.getState().nodesById[key];
      if (entry?.type === "gen" && entry.data.kind === "prompt") setTextEditorKey(key);
      setNodeMarquee(false);
      setMarqueeNodeKeys(new Set());
      selectEdge(null);
      selectNode(key);
    },
    [canvasStore, selectEdge, selectNode],
  );
  const singleSelectedNode = !nodeMarquee && selectedCanvasNodeKeys.size === 1 && selectedNodeKey
    ? canvasStore.getState().nodesById[selectedNodeKey] : null;
  const editingNodeKey = singleSelectedNode?.type === "gen" && singleSelectedNode.data.kind === "prompt"
    ? textEditorKey === selectedNodeKey ? selectedNodeKey : null
    : singleSelectedNode?.data.key ?? null;
  const reference = useCanvasReferencePicking(canvasStore, canvasViewportRef,
    active && !storyboardEnabled ? editingNodeKey : null);
  const pickingReference = reference.session != null;
  const marking = useCanvasImageMarking({ store: canvasStore, viewport: canvasViewportRef,
    editorKey: active && !storyboardEnabled ? editingNodeKey : null, canvasId, providerCatalog, defaultModel: nodeModelSelections.prompt, promptContents });
  const pickingCanvas = pickingReference || marking.targetKey != null;
  const referenceAssetOrder = useMemo(() => {
    const order = new Map<string, number>();
    if (pickingReference && assetDrawerTab === "assets") {
      for (const asset of visibleAssets) {
        const index = reference.assetOrder(asset);
        if (index != null) order.set(assetPickKey(asset), index);
      }
    }
    return order;
  }, [pickingReference, assetDrawerTab, visibleAssets, reference.assetOrder]);
  useEffect(() => {
    if (textEditorKey && textEditorKey !== selectedNodeKey) setTextEditorKey(null);
  }, [selectedNodeKey, textEditorKey]);

  const openDocumentEditor = useCallback((key: string) => {
    const entry = canvasStore.getState().nodesById[key];
    if (entry?.type === "screenplay" && entry.data.config.scriptGenerator) setScriptEditorKey(key);
    openNodeEditor(key);
  }, [canvasStore, openNodeEditor]);
  const closeDocumentEditor = useCallback(() => {
    const entry = scriptEditorKey ? canvasStore.getState().nodesById[scriptEditorKey] : null;
    if (scriptEditorKey && entry?.type === "screenplay" && entry.data.config.scriptGenerator) {
      const button = [...(canvasViewportRef.current?.querySelectorAll<HTMLElement>("[data-open-node-editor]") ?? [])]
        .find((element) => element.dataset["openNodeEditor"] === scriptEditorKey);
      setScriptEditorKey(null);
      button?.focus({ preventScroll: true });
      return;
    }
    setScriptEditorKey(null);
    closeNodeEditor();
  }, [scriptEditorKey, closeNodeEditor, canvasStore]);
  useEffect(() => {
    if (scriptEditorKey && editingNodeKey !== scriptEditorKey) setScriptEditorKey(null);
  }, [editingNodeKey, scriptEditorKey]);

  const openReplaceLibraryResource = useCallback((key: string, kind: CanvasLibraryKind) => {
    setLibraryDialog({ kind, replaceKey: key });
  }, []);

  const assetFlowNodes = useMemo<CanvasFlowNode[]>(
    () =>
      canvasNodesOfState(canvasStore.getState(), "asset").map((node, index) =>
        stableCanvasFlowNode(
          canvasFlowNodeCachesRef.current,
          "asset",
          node.key,
          [
            assetNodeLayoutTokens[index] ?? node.key,
            node.libraryResource != null,
            ignoreLegacyNodeDrag,
            ignoreLegacyConnectionStart,
            removeAssetNode,
            handleAssetAspectRatioChange,
            handleAssetMediaRefresh,
            handleSaveAssetNodeToLibrary,
            openVideoPreparation,
            assetProvider?.id,
            isDesktopRuntime(),
          ],
          () => ({
            id: node.key,
            type: "canvas",
            position: { x: node.x, y: node.y },
            ...measuredFor(node),
            selected: selectedCanvasNodeKeys.has(node.key),
            data: {
              hasSourceHandle: true,
              hasTargetHandle: !node.libraryResource,
              content: (
                <CanvasAssetNodeCardSlot
                  nodeKey={node.key}
                  onReplaceLibraryResource={openReplaceLibraryResource}
                  onNodeDragStart={ignoreLegacyNodeDrag}
                  onConnectionStart={ignoreLegacyConnectionStart}
                  onRemove={removeAssetNode}
                  onAspectRatioChange={handleAssetAspectRatioChange}
                  onRefreshMediaUrls={handleAssetMediaRefresh}
                  onPreview={setPreviewAssetNodeKey}
                  onPrepareVideo={openVideoPreparation}
                  {...(isDesktopRuntime() ? { onSaveToLibrary: handleSaveAssetNodeToLibrary } : {})}
                  targetCloudProviderConnectionId={assetProvider?.id ?? null}
                />
              ),
            },
          }),
        ),
      ),
    [
      assetNodeLayoutTokens,
      openReplaceLibraryResource,
      selectedCanvasNodeKeys,
      ignoreLegacyNodeDrag,
      ignoreLegacyConnectionStart,
      removeAssetNode,
      handleAssetAspectRatioChange,
      handleAssetMediaRefresh,
      handleSaveAssetNodeToLibrary,
      openVideoPreparation,
      assetProvider?.id,
      canvasStore,
    ],
  );

  const outputFlowNodes = useMemo<CanvasFlowNode[]>(
    () =>
      canvasNodesOfState(canvasStore.getState(), "output").map((node, index) => {
        const task = taskById.get(node.taskId) ?? null;
        return stableCanvasFlowNode(
          canvasFlowNodeCachesRef.current,
          "output",
          node.key,
          [
            outputNodeLayoutTokens[index] ?? node.key,
            task,
            retryInfoByTask[node.taskId] ?? null,
            taskResults[node.taskId],
            saveProgressByResult[node.resultKey ?? ""] ?? saveProgressByResult[node.taskId] ?? null,
            rawResponses[node.taskId] ?? null,
            task ? modelDisplayNameForTask(task, providerCatalog) : null,
            ignoreLegacyNodeDrag,
            removeOutputNode,
            handleOutputAspectRatioChange,
            setPreviewOutputNodeKey,
            ignoreLegacyConnectionStart,
            handleUploadOutputToCloud,
            handleUploadOutputToLocal,
            handleUploadOutputToObjectStorage,
            renameOutputNode,
            openGenerationHistory,
            openVideoPreparation,
          ],
          () => ({
            id: node.key,
            type: "canvas",
            position: { x: node.x, y: node.y },
            ...measuredFor(node),
            selected: selectedCanvasNodeKeys.has(node.key),
            data: {
              hasSourceHandle: true,
              hasTargetHandle: true,
              content: (
                <CanvasOutputNodeCardSlot
                  nodeKey={node.key}
                  task={task}
                  retryInfo={retryInfoByTask[node.taskId] ?? null}
                  results={taskResults[node.taskId] ?? []}
                  saveProgress={
                    saveProgressByResult[node.resultKey ?? ""] ??
                    saveProgressByResult[node.taskId] ??
                    null
                  }
                  rawResponse={rawResponses[node.taskId] ?? null}
                  modelLabel={task ? modelDisplayNameForTask(task, providerCatalog) : null}
                  onNodeDragStart={ignoreLegacyNodeDrag}
                  onRemove={removeOutputNode}
                  onAspectRatioChange={handleOutputAspectRatioChange}
                  onPreview={setPreviewOutputNodeKey}
                  onConnectionStart={ignoreLegacyConnectionStart}
                  onUploadToCloud={(key) => void handleUploadOutputToCloud(key)}
                  onUploadToLocal={(key) => void handleUploadOutputToLocal(key)}
                  onUploadToObjectStorage={(key) => void handleUploadOutputToObjectStorage(key)}
                  onRename={renameOutputNode}
                  onPrepareVideo={openVideoPreparation}
                  onOpenHistory={
                    node.origin == null || node.origin === "generation"
                      ? openGenerationHistory
                      : undefined
                  }
                />
              ),
            },
          }),
        );
      }),
    [
      outputNodeLayoutTokens,
      selectedCanvasNodeKeys,
      taskById,
      ignoreLegacyNodeDrag,
      removeOutputNode,
      handleOutputAspectRatioChange,
      setPreviewOutputNodeKey,
      ignoreLegacyConnectionStart,
      handleUploadOutputToCloud,
      handleUploadOutputToLocal,
      handleUploadOutputToObjectStorage,
      renameOutputNode,
      openGenerationHistory,
      openVideoPreparation,
      retryInfoByTask,
      taskResults,
      saveProgressByResult,
      rawResponses,
      providerCatalog,
      canvasStore,
    ],
  );

  const openStoryboardFilm = useCallback(async (sources: readonly StoryboardFilmSource[], name: string, editKey?: string) => {
    if (openingStoryboardFilm.current) throw new Error("正在读取成片素材。");
    if (!activeRef.current || !canvasHydrated || !isDesktopRuntime()) throw new Error("请在桌面画布中制作成片。");
    const initial = canvasStore.getState();
    const existing = editKey ? initial.nodesById[editKey] : undefined;
    if (editKey && existing?.type !== "videoClip") throw new Error("剪辑节点已移除。");
    if (existing?.type === "videoClip" && (existing.data.config.timeline || existing.data.config.agentSubmission ||
        clipJobsRef.current.some(job => job.sourceNodeId === editKey && clipJobActive(job)))) {
      setStoryboardScriptKey(null);
      handleOpenVideoClipEditor(existing.data.key);
      return;
    }
    if (!sources.length || sources.length > 60) throw new Error("请选择 1 到 60 段已保存的视频。");
    openingStoryboardFilm.current = true;
    try {
      const timeline: ClipEdit[] = [];
      for (const source of sources) {
        if (!activeRef.current) throw new Error("已切换画布，请重新打开剪辑。");
        const probe = await videoPreparationClient.probe(source.target);
        if (!Number.isFinite(probe.durationSeconds) || probe.durationSeconds <= 0) {
          throw new Error(source.name + "没有可用的视频时长。");
        }
        timeline.push({ target: source.target, name: source.name, sourceIdentity: probe.sourceIdentity,
          start: 0, end: probe.durationSeconds, volume: 1, fade: false, caption: "" });
      }
      if (!activeRef.current) throw new Error("已切换画布，请重新打开剪辑。");
      const state = canvasStore.getState();
      if (sources.some(source => !state.nodesById[source.key])) throw new Error("所选片段已从画布移除。");
      if (existing?.type === "videoClip") {
        if (state.nodesById[existing.data.key] !== existing) throw new Error("剪辑节点已变化，请重新打开。");
        updateVideoClipConfig(existing.data.key, { timeline });
        scheduleCanvasSaveRef.current();
        setStoryboardScriptKey(null);
        handleOpenVideoClipEditor(existing.data.key);
        return;
      }
      const center = viewportCenterBoardCoordinates();
      const draft = createVideoClipNode(center.x, center.y);
      const position = nearestAvailableNodePosition(liveCanvasNodeRect({ type: "videoClip", data: draft }),
        Object.values(state.nodesById).map(liveCanvasNodeRect));
      const links = [...new Set(sources.map(source => source.key))].map(fromKey => ({
        id: fromKey + "->" + draft.key, fromKey, toKey: draft.key,
      }));
      if (insertSubgraph([{ type: "videoClip", data: {
        ...draft, ...position, name, config: { ...draft.config, outputName: name, timeline },
      } }], links, { selectNodeKey: null }) !== "applied") throw new Error("未能创建成片剪辑节点。");
      scheduleCanvasSaveRef.current();
      setStoryboardScriptKey(null);
      handleOpenVideoClipEditor(draft.key);
    } finally {
      openingStoryboardFilm.current = false;
    }
  }, [canvasHydrated, canvasStore, createVideoClipNode, handleOpenVideoClipEditor, insertSubgraph, updateVideoClipConfig, viewportCenterBoardCoordinates]);

  const openScriptFilm = useCallback((sources: readonly StoryboardFilmSource[]) =>
    openStoryboardFilm(sources, "分镜成片"), [openStoryboardFilm]);

  const screenplayFlowNodes = useMemo<CanvasFlowNode[]>(
    () =>
      canvasNodesOfState(canvasStore.getState(), "screenplay").map((node, index) =>
        stableCanvasFlowNode(
          canvasFlowNodeCachesRef.current,
          "screenplay",
          node.key,
          [
            screenplayNodeLayoutTokens[index] ?? node.key,
            canvasId,
            selectedCanvasNodeKeys.has(node.key),
            startingNodeKeys.has(node.key),
            // 流式正文变化必须让节点重建，否则画布上看不到逐字推进。
            streamingTextByNode[node.key] ?? null,
            startErrorsByNode[node.key] ?? null,
            providerCatalog,
            editingNodeKey === node.key,
            scriptEditorKey === node.key,
            openDocumentEditor,
            closeDocumentEditor,
            selectNode,
            ignoreLegacyNodeDrag,
            removeScreenplayNode,
            removeAssetEdge,
            handleGenNodeSizeChange,
            updateScreenplayNodeConfig,
            handlePickScreenplayMaterials,
            handleRemoveScreenplayMaterial,
            handleRunScreenplayNode,
            handleExportScreenplay,
            updateScreenplayNode,
            handleScriptStory,
            setScriptReferencePick,
            handleScriptTranslate,
            translatingNodeKeys.has(node.key),
            handleScriptCreateMedia,
            handleScriptCreateAsset,
            handleScriptSmartCompose,
            handleScriptBatchStart,
            handleScriptBatchResume,
            openScriptFilm,
            scriptBatchRunningKeys.has(node.key),
          ],
          () => ({
            id: node.key,
            type: "canvas",
            position: { x: node.x, y: node.y },
            ...measuredFor(node),
            selected: selectedCanvasNodeKeys.has(node.key),
            data: {
              hasSourceHandle: true,
              hasTargetHandle: true,
              content: (
                <CanvasDocumentNodeCardSlot
                  nodeKey={node.key}
                  canvasId={canvasId}
                  editorOpen={editingNodeKey === node.key}
                  onEdit={openDocumentEditor}
                  onCloseEditor={closeDocumentEditor}
                  selected={selectedCanvasNodeKeys.has(node.key)}
                  running={startingNodeKeys.has(node.key)}
                  streamingText={streamingTextByNode[node.key] ?? null}
                  error={startErrorsByNode[node.key] ?? null}
                  providerCatalog={providerCatalog}
                  onSelect={selectNode}
                  onNodeDragStart={ignoreLegacyNodeDrag}
                  onRemove={removeScreenplayNode}
                  onUnlink={removeAssetEdge}
                  onSizeChange={handleGenNodeSizeChange}
                  onChange={(config) => updateScreenplayNodeConfig(node.key, config)}
                  onPickMaterials={handlePickScreenplayMaterials}
                  onRemoveMaterial={handleRemoveScreenplayMaterial}
                  onSend={handleRunScreenplayNode}
                  onExport={handleExportScreenplay}
                  onScriptUpdate={updateScreenplayNode}
                  onScriptStory={handleScriptStory}
                  onScriptPickReference={setScriptReferencePick}
                  onScriptTranslate={handleScriptTranslate}
                  scriptTranslating={translatingNodeKeys.has(node.key)}
                  scriptEditorOpen={scriptEditorKey === node.key}
                  onScriptCreateMedia={handleScriptCreateMedia}
                  onScriptCreateAsset={handleScriptCreateAsset}
                  onScriptSmartCompose={handleScriptSmartCompose}
                  onScriptBatchStart={handleScriptBatchStart}
                  onScriptBatchResume={handleScriptBatchResume}
                  onScriptFilm={openScriptFilm}
                  scriptBatchRunning={scriptBatchRunningKeys.has(node.key)}
                />
              ),
            },
          }),
        ),
      ),
    [
      screenplayNodeLayoutTokens,
      canvasId,
      selectedCanvasNodeKeys,
      startingNodeKeys,
      startErrorsByNode,
      providerCatalog,
      editingNodeKey,
      scriptEditorKey,
      openDocumentEditor,
      closeDocumentEditor,
      selectNode,
      ignoreLegacyNodeDrag,
      removeScreenplayNode,
      removeAssetEdge,
      handleGenNodeSizeChange,
      updateScreenplayNodeConfig,
      handlePickScreenplayMaterials,
      handleRemoveScreenplayMaterial,
      handleRunScreenplayNode,
      handleExportScreenplay,
      updateScreenplayNode,
      handleScriptStory,
      handleScriptTranslate,
      translatingNodeKeys,
      handleScriptCreateMedia,
      handleScriptCreateAsset,
      handleScriptSmartCompose,
      handleScriptBatchStart,
      handleScriptBatchResume,
      openScriptFilm,
      scriptBatchRunningKeys,
      streamingTextByNode,
      canvasStore,
    ],
  );

  // aliveCanvasNodeKeys 复用组件上方的成员集合订阅（candidateCanvasNodeKeys 同源）。
  const aliveCanvasNodeKeys = candidateCanvasNodeKeys;
  useEffect(() => {
    if (videoFrameCrop && (!active || !aliveCanvasNodeKeys.has(videoFrameCrop.key))) videoFrameCrop.onClose();
  }, [active, aliveCanvasNodeKeys, videoFrameCrop]);

  const genFlowNodes = useMemo<CanvasFlowNode[]>(
    () =>
      canvasNodesOfState(canvasStore.getState(), "gen").map((node, index) => {
        const nodeFeatureRequest = featureRequest?.nodeKey === node.key ? featureRequest : undefined;
        return stableCanvasFlowNode(
          canvasFlowNodeCachesRef.current,
          "gen",
          node.key,
          [
            genNodeLayoutTokens[index] ?? node.key,
            nodeFeatureRequest,
            canvasId,
            nodeDescriptorContext,
            selectedCanvasNodeKeys.has(node.key),
            editingNodeKey === node.key,
            openNodeEditor,
            closeNodeEditor,
            startingNodeKeys.has(node.key),
            startErrorsByNode[node.key] ?? imageSaveErrorsByNode.get(node.key) ?? null,
            // 流式正文变化必须让节点重建，否则画布上看不到逐字推进。
            streamingTextByNode[node.key] ?? null,
            activeTaskByNode.get(node.key) ?? null,
            latestTaskByNode.get(node.key) ?? null,
            (tasksBySourceNode.get(node.key) ?? []).map(task => `${task.id}:${task.updatedAt}:${task.status}:${task.progress}:${task.queryHealth}`).join("|"),
            aliveCanvasNodeKeys,
            providerCatalog,
            selectNode,
            ignoreLegacyNodeDrag,
            removeGenNode,
            removeAssetEdge,
            reorderGenerationInput,
            ignoreLegacyConnectionStart,
            handleGenNodeSizeChange,
            updatePromptNodeConfig,
            patchPromptNodeConfigField,
            handleRunPromptNode,
            handleTextTryAction,
            handleTranslateCanvasText,
            onPromptFocusRequest,
            onPromptFocusHandled,
            registerPromptInput,
            updateImageNodeConfig,
            selectImageResult,
            handleEnhanceImage,
            handleEditImageRegion,
            openGenerationHistory,
            promoteSeedanceDraftFromCanvas,
            updateVideoNodeConfig,
            openVideoLocalEdit,
            handleUseGreenScreenResult,
            importGreenScreenVideo,
            handleStartGeneration,
            promptContents,
            // 面板的忙碌态与「自己编写内容」的聚焦待办都只跟**本节点**有关，
            // 按节点粒度进签名：别的节点不会因为这两个值变化而重建卡片内容。
            translatingNodeKeys.has(node.key),
            pendingPromptFocusKey === node.key,
          ],
          () => {
            const content = (
              <CanvasGenNodeCardSlot
                featureRequest={nodeFeatureRequest}
                canvasId={canvasId}
                nodeKey={node.key}
                selected={selectedCanvasNodeKeys.has(node.key)}
                editorOpen={editingNodeKey === node.key}
                onCloseEditor={closeNodeEditor}
                running={startingNodeKeys.has(node.key)}
                streamingText={streamingTextByNode[node.key] ?? null}
                error={startErrorsByNode[node.key] ?? imageSaveErrorsByNode.get(node.key) ?? null}
                activeTask={activeTaskByNode.get(node.key) ?? null}
                latestTask={latestTaskByNode.get(node.key) ?? null}
                nodeTasks={tasksBySourceNode.get(node.key) ?? EMPTY_GENERATION_TASKS}
                onOpenGenerationTask={openGenerationHistory}
                onPromoteSeedanceDraft={promoteSeedanceDraftFromCanvas}
                descriptorContext={nodeDescriptorContext}
                providerCatalog={providerCatalog}
                promptContents={promptContents}
                aliveCanvasNodeKeys={aliveCanvasNodeKeys}
                onSelect={selectNode}
                onEdit={openNodeEditor}
                onNodeDragStart={ignoreLegacyNodeDrag}
                onRemove={removeGenNode}
                onUnlink={removeAssetEdge}
                onConnectionStart={ignoreLegacyConnectionStart}
                onSizeChange={handleGenNodeSizeChange}
                onReorderInput={reorderGenerationInput}
                registerPromptInput={registerPromptInput}
                onPromptChange={updatePromptNodeConfig}
                onPromptFieldChange={patchPromptNodeConfigField}
                onRunPrompt={handleRunPromptNode}
                onTextTryAction={handleTextTryAction}
                onTranslateCanvasText={handleTranslateCanvasText}
                translating={translatingNodeKeys.has(node.key)}
                autoFocusOutput={pendingPromptFocusKey === node.key}
                onPromptFocusRequest={onPromptFocusRequest}
                onPromptFocusHandled={onPromptFocusHandled}
                onImageConfigChange={updateImageNodeConfig}
                onOpenCharacterStudio={openCharacterStudio}
                onRename={renameGenNode}
                onSelectImageResult={selectImageResult}
                onPreviewImage={setPreviewOutputNodeKey}
                onEnhanceImage={handleEnhanceImage}
                onEditImageRegion={handleEditImageRegion}
                onVideoConfigChange={updateVideoNodeConfig}
                onAudioConfigChange={updateAudioNodeConfig}
                onAudioToVideo={handleAudioToVideo}
                onTranslateAudioPrompt={handleTranslateAudioPrompt}
                onAnnotateVideo={openVideoLocalEdit}
                onGreenScreenUseResult={handleUseGreenScreenResult}
                onImportGreenScreenVideo={importGreenScreenVideo}
                onStartGeneration={handleStartGeneration}
              />
            );
            return {
              id: node.key,
              type: "canvas",
              position: { x: node.x, y: node.y },
              ...measuredFor(node),
              selected: selectedCanvasNodeKeys.has(node.key),
              data: {
                hasSourceHandle: true,
                hasTargetHandle: true,
                content,
              },
            };
          },
        );
      }),
    [
      genNodeLayoutTokens,
      featureRequest,
      canvasId,
      editingNodeKey,
      openNodeEditor,
      handleEnhanceImage,
      handleEditImageRegion,
      closeNodeEditor,
      promoteSeedanceDraftFromCanvas,
      nodeDescriptorContext,
      selectedCanvasNodeKeys,
      startingNodeKeys,
      startErrorsByNode,
      imageSaveErrorsByNode,
      providerCatalog,
      promptContents,
      selectNode,
      ignoreLegacyNodeDrag,
      removeGenNode,
      removeAssetEdge,
      reorderGenerationInput,
      ignoreLegacyConnectionStart,
      handleGenNodeSizeChange,
      updatePromptNodeConfig,
      patchPromptNodeConfigField,
      handleRunPromptNode,
      handleTextTryAction,
      handleTranslateCanvasText,
      onPromptFocusRequest,
      onPromptFocusHandled,
      activeTaskByNode,
      tasksBySourceNode,
      latestTaskByNode,
      aliveCanvasNodeKeys,
      registerPromptInput,
      updateImageNodeConfig,
            openCharacterStudio,
      selectImageResult,
      renameGenNode,
      updateVideoNodeConfig,
      updateAudioNodeConfig,
      handleAudioToVideo,
      handleTranslateAudioPrompt,
      openVideoLocalEdit,
      handleUseGreenScreenResult,
      importGreenScreenVideo,
      handleStartGeneration,
      streamingTextByNode,
      translatingNodeKeys,
      pendingPromptFocusKey,
      canvasStore,
    ],
  );

  const videoClipBusyKeys = useMemo(() => new Set([
    ...startingVideoClipKeys,
    ...generationTasks.filter(task => !isTerminalTaskStatus(task.status)).map(task => task.sourceNodeId),
    ...(clipRenderJobs.data ?? []).filter(clipJobActive).map(job => job.sourceNodeId),
    ...canvasNodesOfState(canvasStore.getState(), "videoClip").filter(node => node.config.submission).map(node => node.key),
  ]), [startingVideoClipKeys, generationTasks, clipRenderJobs.data, videoClipNodeLayoutTokens, canvasStore]);
  const videoClipFlowNodes = useMemo<CanvasFlowNode[]>(
    () =>
      canvasNodesOfState(canvasStore.getState(), "videoClip").map((node, index) =>
        stableCanvasFlowNode(
          canvasFlowNodeCachesRef.current,
          "videoClip",
          node.key,
          [
            videoClipNodeLayoutTokens[index] ?? node.key,
            selectedCanvasNodeKeys.has(node.key),
            videoClipBusyKeys.has(node.key),
            startErrorsByNode[node.key] ?? null,
            selectNode,
            ignoreLegacyNodeDrag,
            removeAssetEdge,
            applyVideoClipPreset,
            changeVideoClipMode,
            changeVideoClipParams,
            startVideoClip,
            registerPromptInput,
          ],
          () => ({
            id: node.key,
            type: "canvas",
            position: { x: node.x, y: node.y },
            ...measuredFor(node),
            selected: selectedCanvasNodeKeys.has(node.key),
            data: {
              hasSourceHandle: true,
              hasTargetHandle: true,
              content: (
                <CanvasVideoClipNodeCardSlot
                  nodeKey={node.key}
                  selected={selectedCanvasNodeKeys.has(node.key)}
                  editorOpen={editingNodeKey === node.key}
                  busy={videoClipBusyKeys.has(node.key)}
                  error={startErrorsByNode[node.key] ?? null}
                  onSelect={selectNode}
                  onNodeDragStart={ignoreLegacyNodeDrag}
                  onCloseEditor={closeNodeEditor}
                  onModeChange={changeVideoClipMode}
                  onParamsChange={changeVideoClipParams}
                  onSubmit={(nodeKey) => {
                    // startVideoClip 是 async：包一层把 Promise 显式丢弃，
                    // 避免把 Promise 交给只期待 void 的回调（no-misused-promises）。
                    void startVideoClip(nodeKey);
                  }}
                  onTryMode={applyVideoClipPreset}
                  onOpenEditor={handleOpenVideoClipEditor}
                  onUnlink={removeAssetEdge}
                  registerPromptInput={registerPromptInput}
                />
              ),
            },
          }),
        ),
      ),
    [
      applyVideoClipPreset,
      changeVideoClipMode,
      changeVideoClipParams,
      closeNodeEditor,
      editingNodeKey,
      handleOpenVideoClipEditor,
      ignoreLegacyNodeDrag,
      registerPromptInput,
      removeAssetEdge,
      selectNode,
      selectedCanvasNodeKeys,
      startErrorsByNode,
      startVideoClip,
      videoClipBusyKeys,
      videoClipNodeLayoutTokens,
      canvasStore,
    ],
  );

  const resultFlowNodes = useMemo<CanvasFlowNode[]>(
    () =>
      canvasNodesOfState(canvasStore.getState(), "result").map((node, index) =>
        stableCanvasFlowNode(
          canvasFlowNodeCachesRef.current,
          "result",
          node.key,
          [
            resultNodeLayoutTokens[index] ?? node.key,
            nodeDescriptorContext,
            selectedCanvasNodeKeys.has(node.key),
            latestResult,
            selectNode,
            ignoreLegacyNodeDrag,
            removeResultNode,
          ],
          () => ({
            id: node.key,
            type: "canvas",
            position: { x: node.x, y: node.y },
            ...measuredFor(node),
            selected: selectedCanvasNodeKeys.has(node.key),
            data: {
              hasSourceHandle: true,
              hasTargetHandle: true,
              content: (
                <CanvasResultNodeCardSlot
                  nodeKey={node.key}
                  selected={selectedCanvasNodeKeys.has(node.key)}
                  descriptor={getNodeDescriptor("result", nodeDescriptorContext)}
                  latestResult={latestResult}
                  onSelect={selectNode}
                  onNodeDragStart={ignoreLegacyNodeDrag}
                  onRemove={removeResultNode}
                />
              ),
            },
          }),
        ),
      ),
    [
      resultNodeLayoutTokens,
      nodeDescriptorContext,
      selectedCanvasNodeKeys,
      latestResult,
      selectNode,
      ignoreLegacyNodeDrag,
      removeResultNode,
      canvasStore,
    ],
  );

  const directorFlowNodes = useMemo((): CanvasFlowNode[] => canvasNodesOfState(canvasStore.getState(), "director")
    .map((node, index) => {
      const selected = selectedCanvasNodeKeys.has(node.key);
      const running = startingNodeKeys.has(node.key);
      const error = startErrorsByNode[node.key] ?? null;
      return stableCanvasFlowNode(canvasFlowNodeCachesRef.current, "director", node.key,
        [directorNodeLayoutTokens[index], selected, running, error, openDirectorEditor, generateDirectorScene, setDirectorPrompt, renameDirector],
        () => ({
          id: node.key, type: "canvas", position: { x: node.x, y: node.y }, ...measuredFor(node), selected,
          data: { hasTargetHandle: true, hasSourceHandle: true, content: <CanvasDirectorNode nodeKey={node.key} selected={selected}
            running={running} error={error} onOpen={openDirectorEditor} onReference={setDirectorReferenceKey}
            onPrompt={setDirectorPrompt} onGenerate={generateDirectorScene} onRename={renameDirector} /> },
        }));
    }), [canvasStore, directorNodeLayoutTokens, selectedCanvasNodeKeys, startingNodeKeys, startErrorsByNode,
      openDirectorEditor, generateDirectorScene, setDirectorPrompt, renameDirector]);

  // 拖线过程中记录源节点 key，用于高亮所有可连接目标的输入端口。
  const [connectionSourceKey, setConnectionSourceKey] = useState<string | null>(null);
  const [nodeMenuTriggerElement, setNodeMenuTriggerElement] = useState<HTMLButtonElement | null>(
    null,
  );
  const connectionStartRef = useRef<{
    nodeKey: string;
    handleType: "source" | "target";
    x: number;
    y: number;
  } | null>(null);
  const [connectionQuickAdd, setConnectionQuickAdd] = useState<{
    connection: { nodeKey: string; handleType: "source" | "target" } | null;
    position: { x: number; y: number };
    boardPosition: { x: number; y: number };
    aboveTrigger?: boolean;
    searchOnly?: boolean;
    /**
     * 从**手柄点按**进入（而不是拖到空白处）：新节点落在端口的另一侧，
     * 也就是原站「引用该节点生成」里新节点出现在被引用节点左边的位置。
     */
    besidePort?: boolean;
    portTrigger?: HTMLElement;
  } | null>(null);

  const closeConnectionQuickAdd = useCallback(() => setConnectionQuickAdd(null), []);

  useEffect(() => {
    if (!active) {
      connectionStartRef.current = null;
      // Switching canvases cancels the transient gesture and its menu.
      setConnectionQuickAdd(null);
      setConnectionSourceKey(null);
      setHandTool(false);
      setShortcutsAnchor(null);
      lastCanvasPointer.current = null;
      marqueeGesture.current = null;
      setNodeMarquee(false);
      setMarqueeNodeKeys(new Set());
    }
  }, [active]);

  /*
   * Esc 取消「从手柄出发、还没落下」的连线手势：交给全应用唯一的仲裁器
   * （`escapeArbiter`）。仲裁器保证一次按键只关一层，且内层浮层优先。
   */
  useEscapeHandler(
    {
      canHandle: () => active && connectionSourceKey != null,
      handle: () => {
        connectionStartRef.current = null;
        setConnectionSourceKey(null);
      },
      priority: ESCAPE_PRIORITY_CANVAS,
    },
    active && connectionSourceKey != null,
  );

  // 从当前快照按 key 组装 CanvasNodeEntry，供连接合法性判断等事件期读取复用。
  const canvasEntryByKey = useCallback(
    (key: string): CanvasNodeEntry | null => canvasStore.getState().nodesById[key] ?? null,
    [canvasStore],
  );

  const quickAddEndpointExists =
    connectionQuickAdd != null &&
    (connectionQuickAdd.connection == null ||
      canvasEntryByKey(connectionQuickAdd.connection.nodeKey) != null ||
      assetGroupIdFromFlowId(connectionQuickAdd.connection.nodeKey) != null);
  const quickAddSource = connectionQuickAdd?.connection?.handleType === "source"
    ? canvasEntryByKey(connectionQuickAdd.connection.nodeKey)
    : null;
  const quickAddResource = quickAddSource?.type === "asset" ? quickAddSource.data.libraryResource : undefined;
  const quickAddGroupId = connectionQuickAdd?.connection?.handleType === "source"
    ? assetGroupIdFromFlowId(connectionQuickAdd.connection.nodeKey)
    : null;
  const quickAddIsCharacter = quickAddGroupId != null && canvasStore.getState().groups[quickAddGroupId]?.purpose === "character";
  useEffect(() => {
    if (connectionQuickAdd && !quickAddEndpointExists) closeConnectionQuickAdd();
  }, [connectionQuickAdd, quickAddEndpointExists, closeConnectionQuickAdd]);

  // The same port opens the menu on a tap or a keyboard press. React Flow
  // handles movements beyond CANVAS_PORT_DRAG_THRESHOLD as a drag to connect.
  useEffect(() => {
    if (!active || handTool) return;
    let pressed: { handle: HTMLElement; x: number; y: number; pointerId: number } | null = null;
    const findHandle = (target: EventTarget | null) => {
      const handle = target instanceof Element ? target.closest<HTMLElement>(".canvas-flow-handle.connectable") : null;
      return handle && canvasViewportRef.current?.contains(handle) &&
        !canvasViewportRef.current.matches(".canvas-reference-picking, .canvas-image-marking") ? handle : null;
    };
    const toggleMenu = (handle: HTMLElement) => {
      const nodeKey = handle.dataset["nodeid"];
      const knob = handle.querySelector(".canvas-flow-handle__knob");
      if (!nodeKey || !knob) return;
      const rect = knob.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const boardPosition = dropClientPointToBoardRef.current(x, y);
      if (!boardPosition) return;
      const handleType = handle.dataset["handleid"] === "source" ? "source" : "target";
      setConnectionQuickAdd(previous => previous?.portTrigger === handle ? null : {
        connection: { nodeKey, handleType },
        position: { x, y },
        boardPosition,
        besidePort: true,
        portTrigger: handle,
      });
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!event.isPrimary || event.button !== 0) return;
      const handle = findHandle(event.target);
      pressed = handle?.classList.contains("connectionindicator")
        ? { handle, x: event.clientX, y: event.clientY, pointerId: event.pointerId } : null;
    };
    const onPointerUp = (event: PointerEvent) => {
      if (pressed?.pointerId !== event.pointerId) return;
      const start = pressed;
      pressed = null;
      if (connectionStartRef.current ||
          Math.hypot(event.clientX - start.x, event.clientY - start.y) > CANVAS_PORT_DRAG_THRESHOLD) return;
      const target = event.pointerType === "touch" ? document.elementFromPoint(event.clientX, event.clientY) : event.target;
      if (findHandle(target) === start.handle) toggleMenu(start.handle);
    };
    const onPointerCancel = (event: PointerEvent) => {
      if (pressed?.pointerId === event.pointerId) pressed = null;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.key !== "Enter" && event.key !== " ") || event.defaultPrevented ||
          event.isComposing || event.keyCode === 229 || event.repeat) return;
      const handle = findHandle(document.activeElement);
      if (!handle) return;
      event.preventDefault();
      event.stopPropagation();
      toggleMenu(handle);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointerup", onPointerUp, true);
    document.addEventListener("pointercancel", onPointerCancel, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("pointerup", onPointerUp, true);
      document.removeEventListener("pointercancel", onPointerCancel, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [active, handTool]);

  // 只订阅组织、几何与展示字段，后台进度和正文补丁不重建分组。
  const canvasGroupMetadata = useCanvas((state) => state.groups);
  const canvasAssetGroupSignature = useCanvas(
    useShallow((state) =>
      CANVAS_NODE_TYPE_KEYS.flatMap(
        (type) => state.nodes[type] as readonly CanvasGroupMember[],
      ).map((node) => {
        return `${node.key}:${node.assetGroupId ?? ""}:${canvasGroupMemberName(node)}:${node.x}:${node.y}:${node.measured?.width ?? ""}:${node.measured?.height ?? ""}:${
          "libraryPickOrder" in node ? (node.libraryPickOrder ?? "") : ""
        }:${"finalPath" in node ? (node.finalPath ?? "") : ""}`;
      }),
    ),
  );
  const canvasAssetGroups = useMemo(() => {
    void canvasAssetGroupSignature;
    return assetGroupsFromNodes(
      Object.values(canvasStore.getState().nodesById).map((entry) => entry.data),
    );
  }, [canvasAssetGroupSignature, canvasStore]);
  const collapsedGroupByNode = useMemo(
    () =>
      new Map(
        canvasAssetGroups.flatMap((group) =>
          canvasGroupMetadata[group.groupId]?.collapsed
            ? group.members.map((member) => [member.key, assetGroupFlowId(group.groupId)] as const)
            : [],
        ),
      ),
    [canvasAssetGroups, canvasGroupMetadata],
  );
  const selectCanvasGroup = useCallback(
    (groupId: string) => {
      const keys = Object.values(canvasStore.getState().nodesById)
        .filter((entry) => entry.data.assetGroupId === groupId)
        .map((entry) => entry.data.key);
      setMarqueeNodeKeys(new Set(keys));
      selectNode(null);
      selectEdge(null);
    },
    [canvasStore, selectNode, selectEdge],
  );
  const dissolveCanvasAssetGroup = useCallback(
    (groupId: string) => {
      dissolveGroup(groupId);
    },
    [dissolveGroup],
  );
  const uploadCanvasGroupToLibrary = useCallback(
    (groupId: string) => {
      const group = canvasAssetGroups.find((item) => item.groupId === groupId);
      if (group == null) return;
      void uploadOutputsToLibrary(
        group.members.filter(isUploadableOutput).map((member) => member.key),
        assetLibrarySource === "local"
          ? "local"
          : cloudCollection === "object_storage"
            ? "object_storage"
            : "cloud",
      );
    },
    [assetLibrarySource, canvasAssetGroups, cloudCollection, uploadOutputsToLibrary],
  );
  const assetGroupFlowNodes = useMemo<CanvasFlowNode[]>(
    () =>
      canvasAssetGroups.map((group) => {
        const metadata = canvasGroupMetadata[group.groupId] ?? {
          id: group.groupId,
          name: "未命名分组",
          collapsed: false,
        };
        const fullBounds = assetGroupBounds(group.members);
        const bounds = {
          ...fullBounds,
          width: metadata.collapsed ? 460 : fullBounds.width,
          height: metadata.collapsed ? 112 : fullBounds.height,
        };
        const mediaOnly = group.members.every(isMediaGroupMember);
        const roleGroup = metadata.purpose === "character";
        const selected = group.members.every((member) => selectedCanvasNodeKeys.has(member.key));
        const memberSignature = group.members
          .map(
            (member) =>
              `${member.key}:${canvasGroupMemberName(member)}:${"libraryPickOrder" in member ? (member.libraryPickOrder ?? "") : ""}:${"finalPath" in member ? (member.finalPath ?? "") : ""}`,
          )
          .join("|");
        const uploadLabel =
          assetLibrarySource === "local"
            ? "上传到本地素材库"
            : cloudCollection === "object_storage"
              ? "上传到对象存储"
              : "上传到云端素材库";
        const canUpload = group.members.some(isUploadableOutput);
        return stableCanvasFlowNode(
          canvasFlowNodeCachesRef.current,
          "asset-group",
          group.groupId,
          [
            bounds.x,
            bounds.y,
            bounds.width,
            bounds.height,
            memberSignature,
            metadata,
            selected,
            mediaOnly,
            selectCanvasGroup,
            updateGroup,
            copyCanvasNodes,
            dissolveCanvasAssetGroup,
            canUpload,
            uploadLabel,
            uploadCanvasGroupToLibrary,
            canvasStore,
          ],
          () => ({
            id: assetGroupFlowId(group.groupId),
            type: "canvas",
            className: "canvas-asset-group-node",
            position: { x: bounds.x, y: bounds.y },
            width: bounds.width,
            height: bounds.height,
            style: { width: bounds.width, height: bounds.height },
            zIndex: 0,
            selectable: metadata.collapsed,
            draggable: true,
            dragHandle: ".canvas-asset-group__chip",
            focusable: false,
            connectable: mediaOnly || roleGroup,
            data: {
              groupMemberKeys: group.members.map((member) => member.key),
              hasSourceHandle: mediaOnly || roleGroup || metadata.collapsed,
              hasTargetHandle: metadata.collapsed,
              sourceHandleLabel: roleGroup ? "连接角色设定与参考图" : mediaOnly ? "连接素材组内的全部素材" : "组内节点的输出连线",
              content: (
                <AssetGroupFrame
                  group={metadata}
                  members={group.members}
                  selected={selected}
                  onSelect={() => selectCanvasGroup(group.groupId)}
                  onRename={(name) => updateGroup(group.groupId, { name })}
                  onContextMenu={(position) => {
                    selectCanvasGroup(group.groupId);
                    setGroupContextMenu({ ...position, groupId: group.groupId });
                  }}
                />
              ),
            },
          }),
        );
      }),
    [
      assetLibrarySource,
      canvasAssetGroups,
      canvasGroupMetadata,
      selectedCanvasNodeKeys,
      selectCanvasGroup,
      updateGroup,
      copyCanvasNodes,
      cloudCollection,
      dissolveCanvasAssetGroup,
      uploadCanvasGroupToLibrary,
      canvasStore,
    ],
  );

  // 旧图片自动卡片仅在已有引用或主动独立展示时保留；新图片结果不再创建 output 节点。
  // 视频产物按原节点投影。音频只收起已在源节点播放器显示的那张结果卡。
  // 仅改变画布投影，不删除文件、结果记录或下游引用；源节点删除后产物自然独立显示。
  const embeddedOutputOwners = useCanvas(useShallow((state) => Object.fromEntries(
    state.nodes.output.flatMap(output => {
      const source = state.nodeByKey.gen.get(output.sourceNodeId);
      if (output.standalone || !source) return [];
      const embeddedVideo = output.mediaType === "video" && source.kind === "video" &&
        (output.origin == null || output.origin === "generation" || output.origin === "long_video");
      const embeddedAudio = output.mediaType === "audio" && source.kind === "audio" &&
        (output.origin == null || output.origin === "generation") &&
        latestGenerationPreviewFor(state, source.key)?.key === output.key;
      const legacyImage = output.mediaType === "image" && source.kind === "image" &&
        (output.origin == null || output.origin === "generation") &&
        !state.graph.edges.some(edge => edge.fromKey === output.key || (edge.toKey === output.key && edge.fromKey !== source.key));
      return embeddedVideo || embeddedAudio || legacyImage ? [[output.key, source.key]] : [];
    }),
  )));
  const projectStoryboard = useCallback((state: CanvasReadModel) =>
    storyboardProjectAssets(state, latestGenerationPreviewFor, embeddedOutputOwners), [embeddedOutputOwners]);

  const flowNodes = useMemo<CanvasFlowNode[]>(() => {
    const connectionGroupId =
      connectionSourceKey != null ? assetGroupIdFromFlowId(connectionSourceKey) : null;
    const groupedMember =
      connectionGroupId == null
        ? null
        : (canvasAssetGroups.find((group) => group.groupId === connectionGroupId)?.members[0] ??
          null);
    const snapshotNodes = canvasStore.getState().nodesById;
    const sourceEntry: CanvasNodeEntry | null =
      connectionSourceKey == null
        ? null
        : (snapshotNodes[connectionSourceKey] ??
          (groupedMember != null ? (snapshotNodes[groupedMember.key] ?? null) : null));
    const baseNodes: CanvasFlowNode[] = [
      ...assetFlowNodes,
      ...outputFlowNodes,
      ...screenplayFlowNodes,
      ...genFlowNodes,
      ...videoClipFlowNodes,
      ...directorFlowNodes,
      ...resultFlowNodes,
    ];
    const projected = baseNodes.map((baseNode) => {
      // 最终层同样做 per-node 引用稳定：baseNode 引用与派生值不变时复用整个节点
      // 对象（含 data 引用），memo 化的节点视图因此能跳过未变化节点。输入角标已随
      // 卡片 slot 自订阅，这里只补连线手势的目标高亮。
      const targetEntry = snapshotNodes[baseNode.id] ?? null;
      const highlightTarget =
        sourceEntry != null &&
        targetEntry != null &&
        isSupportedConnection(sourceEntry, targetEntry);
      return stableCanvasFlowNode(
        canvasFlowNodeCachesRef.current,
        "final",
        baseNode.id,
        [baseNode, highlightTarget, collapsedGroupByNode.has(baseNode.id), embeddedOutputOwners[baseNode.id]],
        () => ({
          ...baseNode,
          hidden: collapsedGroupByNode.has(baseNode.id) || embeddedOutputOwners[baseNode.id] != null,
          data: {
            ...baseNode.data,
            highlightTarget,
          },
        }),
      );
    });
    // 框选只改了 React Flow 内部选中态。计数变化时交出新数组，受控同步后高亮会清掉。
    if (marqueeSelectionEpoch < 0) return [];
    return [...assetGroupFlowNodes, ...projected];
  }, [
    marqueeSelectionEpoch,
    assetGroupFlowNodes,
    canvasAssetGroups,
    canvasStore,
    assetFlowNodes,
    outputFlowNodes,
    screenplayFlowNodes,
    genFlowNodes,
    videoClipFlowNodes,
    directorFlowNodes,
    resultFlowNodes,
    connectionSourceKey,
    collapsedGroupByNode,
    embeddedOutputOwners,
  ]);

  // 每条边的稳定缓存：内容输入（端点、名称、类名、序号、选中态、回调）不变时
  // 返回同一 edge 对象引用，React Flow 便不会因一次全表重建而重渲染所有连线。
  const flowEdgeCacheRef = useRef(new Map<string, { inputs: unknown[]; node: CanvasFlowEdge }>());
  // 边指纹订阅：端点内容推导的标签/类名/序号 + 选中态。节点内容补丁只在真正影响
  // 某条边的描述时才改变指纹，连线层不随无关写入重建。
  const flowEdgeTokens = useCanvas(
    useShallow((state) =>
      state.graph.edges.map((edge) =>
        canvasFlowEdgeDescriptorToken(
          canvasFlowEdgeDescriptor(state, edge),
          state.selection.edgeId === edge.id,
        ),
      ),
    ),
  );
  const flowEdges = useMemo<CanvasFlowEdge[]>(() => {
    const cache = flowEdgeCacheRef.current;
    const state = canvasReadModelOfState(canvasStore.getState());
    const nextEdges = state.graph.edges.map((edge, index) => {
      const descriptor = canvasFlowEdgeDescriptor(state, edge);
      const isSelected = state.selection.edgeId === edge.id;
      const visibleFrom = embeddedOutputOwners[edge.fromKey] ?? edge.fromKey;
      const visibleTo = embeddedOutputOwners[edge.toKey] ?? edge.toKey;
      const source = collapsedGroupByNode.get(visibleFrom) ?? visibleFrom;
      const target = collapsedGroupByNode.get(visibleTo) ?? visibleTo;
      return stableCachedItem(
        cache,
        edge.id,
        [
          edge.fromKey,
          edge.toKey,
          source,
          target,
          flowEdgeTokens[index] ?? edge.id,
          selectEdge,
          selectNode,
          removeAssetEdge,
          canvasStore,
        ],
        () =>
          ({
            id: edge.id,
            type: "canvas",
            source,
            target,
            hidden: source === target,
            sourceHandle: "source",
            targetHandle: "target",
            selected: isSelected,
            selectable: true,
            focusable: true,
            data: {
              label: `${descriptor.sourceName} → ${descriptor.targetName}`,
              edgeClassName: descriptor.edgeClassName,
              order: descriptor.order,
              removable: true,
              onSelect: () => {
                selectEdge(edge.id);
                selectNode(null);
              },
              onRemove: () => removeAssetEdge(edge.id),
            },
          }) satisfies CanvasFlowEdge,
      );
    });
    // 已删除的边退出缓存，防止长会话下 Map 无界增长。
    if (cache.size > nextEdges.length) {
      const alive = new Set(nextEdges.map((item) => item.id));
      for (const key of [...cache.keys()]) {
        if (!alive.has(key)) cache.delete(key);
      }
    }
    return nextEdges;
  }, [flowEdgeTokens, selectEdge, selectNode, removeAssetEdge, canvasStore, collapsedGroupByNode, embeddedOutputOwners]);

  /*
   * 「隐藏节点连线」只改可见性，不动图数据：连线仍在图里、仍可被选中与
   * 删除，重新打开开关就回来。hidden 是 React Flow 的原生开关，交给它
   * 处理裁剪，比自己过滤数组更省一次渲染。
   */
  const visibleFlowEdges = useMemo<CanvasFlowEdge[]>(
    () => (edgesVisible ? flowEdges : flowEdges.map((edge) => ({ ...edge, hidden: true }))),
    [edgesVisible, flowEdges],
  );

  /*
   * 整理画布：把散落的顶层节点按网格重排（对应原站 Alt+Shift+F）。
   *
   * 只重排顶层节点：组内成员的位置由组框决定，移动组根时由
   * expandCanvasGroupPositionChanges 展开成整组位移，单独挪成员会把组
   * 拆散。排序沿用当前的上→下、左→右阅读顺序，用户看到的相对次序不变。
   */
  const formatCanvasLayout = useCallback(() => {
    const state = canvasStore.getState();
    const movable = flowNodes.filter(
      (node) => !node.hidden && (assetGroupIdFromFlowId(node.id) != null ||
        !state.groups[state.nodesById[node.id]?.data.assetGroupId ?? ""]),
    );
    if (movable.length === 0) {
      toast.error("画布没有可整理的节点");
      return;
    }
    const ordered = [...movable].sort(
      (left, right) => left.position.y - right.position.y || left.position.x - right.position.x,
    );
    const cellWidth =
      Math.max(...ordered.map((node) => node.measured?.width ?? node.width ?? 320)) + 64;
    const cellHeight =
      Math.max(...ordered.map((node) => node.measured?.height ?? node.height ?? 240)) + 64;
    const columns = Math.max(1, Math.ceil(Math.sqrt(ordered.length)));
    const originX = Math.min(...ordered.map((node) => node.position.x));
    const originY = Math.min(...ordered.map((node) => node.position.y));
    applyNodeChanges(
      ordered.map((node, index) => ({
        type: "position" as const,
        key: node.id,
        position: {
          x: originX + (index % columns) * cellWidth,
          y: originY + Math.floor(index / columns) * cellHeight,
        },
      })),
    );
  }, [applyNodeChanges, canvasStore, flowNodes]);

  /*
   * 节点右键菜单（原站 liblib 的画布上下文菜单）。
   *
   * 画布**空白处**的右键仍是本项目既有的「快速添加节点」菜单（既有契约与测试
   * 都在它上面）；原站的上下文菜单是**节点级**的——复制节点 / 复制图片 / 成组 /
   * 整理画布那一组，所以挂在节点上。
   *
   * 左下控件组按原站收敛成六项后，节点动作（复制 / 粘贴 / 成组 / 删除 / 交付）
   * 的按钮入口一并消失，按原站的分工它们留在**右键菜单**与键盘快捷键里。
   */
  /*
   * 分组右键菜单（原站 liblib 的组操作入口）。
   *
   * 原站的分组只有「彩色框 + 小标签」两件东西，框上没有工具条；组动作
   * （复制整组 / 折叠 / 添加到素材库 / 解散）因此收在这里。
   */
  const handleGroupContextMenuAction = useCallback(
    (action: string) => {
      const target = groupContextMenu;
      setGroupContextMenu(null);
      if (target == null) return;
      const group = canvasAssetGroups.find((item) => item.groupId === target.groupId);
      if (group == null) return;
      const metadata = canvasGroupMetadata[group.groupId];
      switch (action) {
        case "copyGroup":
          copyCanvasNodes(new Set(group.members.map((member) => member.key)));
          return;
        case "toggleCollapsed":
          updateGroup(target.groupId, { collapsed: !(metadata?.collapsed ?? false) });
          return;
        case "uploadGroup":
          uploadCanvasGroupToLibrary(target.groupId);
          return;
        case "dissolveGroup":
          dissolveCanvasAssetGroup(target.groupId);
          return;
        default:
          return;
      }
    },
    [
      canvasAssetGroups,
      canvasGroupMetadata,
      copyCanvasNodes,
      dissolveCanvasAssetGroup,
      groupContextMenu,
      updateGroup,
      uploadCanvasGroupToLibrary,
    ],
  );

  const groupContextMenuItems: readonly CanvasContextMenuItem[] = useMemo(() => {
    const target = groupContextMenu;
    if (target == null) return [];
    const group = canvasAssetGroups.find((item) => item.groupId === target.groupId);
    if (group == null) return [];
    const metadata = canvasGroupMetadata[group.groupId];
    return [
      { id: "copyGroup", label: "复制整组", hint: "复制组内全部节点" },
      {
        id: "toggleCollapsed",
        label: metadata?.collapsed === true ? "展开分组" : "折叠分组",
      },
      ...(group.members.some(isUploadableOutput)
        ? [{ id: "uploadGroup", label: "添加到素材库" as const }]
        : []),
      { id: "dissolveGroup", label: "解散分组", danger: true },
    ];
  }, [canvasAssetGroups, canvasGroupMetadata, groupContextMenu]);

  const nodeContextMenuItems: readonly CanvasContextMenuItem[] = [
    ...(contextHasMedia ? [
      { id: "createAsset", label: "保存到我的资产", disabled: !isDesktopRuntime() || (!contextMediaPath && contextNodeEntry?.type !== "asset") },
      { id: "createSubject", label: "创建主体", disabled: true },
      { id: "download", label: "下载", disabled: !contextMediaPath || !isDesktopRuntime(), separatorBefore: true },
    ] : []),
    { id: "copyNode", label: "复制节点", hint: "仅复制当前节点", shortcut: "mod+c" },
    ...(contextImage?.src ? [{ id: "copyImage", label: "复制图片" }] : []),
    { id: "duplicate", label: "创建副本", hint: "复制当前节点及其参数", shortcut: "mod+d" },
    { id: "paste", label: "粘贴", shortcut: "mod+v", disabled: !canPasteCanvasNodes },
    { id: "remove", label: "删除", shortcut: "Del" },
    { id: "copyToClipboard", label: "复制到剪贴板", separatorBefore: true },
  ];

  const groupSelectedCanvasNodes = useCallback(() => {
    if (!canGroupSelectedNodes) return;
    if (groupNodes(selectedGroupableNodeKeys, assetGroupKey()) !== "applied") {
      toast.info("所选节点已在同一组");
      return;
    }
    setNodeMarquee(false);
    setMarqueeNodeKeys(new Set());
    selectNode(null);
    selectEdge(null);
    setMarqueeSelectionEpoch((epoch) => epoch + 1);
    toast.success(`已成组，共 ${selectedGroupableNodeKeys.length} 个节点`);
  }, [groupNodes, canGroupSelectedNodes, selectEdge, selectedGroupableNodeKeys, selectNode]);

  const handleNodeContextMenuAction = useCallback(
    (action: string) => {
      const target = nodeContextMenu;
      setNodeContextMenu(null);
      if (target == null) return;
      switch (action) {
        case "createAsset":
          if (contextNodeEntry?.type === "asset") {
            handleSaveAssetNodeToLibrary(target.nodeKey, "local");
          } else if (contextMediaPath) {
            void localBase64AssetClient.importAsset({
              localPath: contextMediaPath,
              name: contextMediaName,
              groupId: uploadTargetLocalGroupId(),
            }).then(() => {
              refreshLocalAssets("upload-finished");
              toast.success("已保存到我的资产");
            }).catch((error: unknown) => toast.error(`保存素材失败：${backendErrorMessage(error)}`));
          }
          return;
        case "download":
          if (contextMediaPath) void exportArtifactToDesktop(contextMediaPath,
            artifactFileName(contextMediaName, contextMediaPath))
            .then(saved => { if (saved) toast.success("已下载"); })
            .catch((error: unknown) => toast.error(`下载失败：${backendErrorMessage(error)}`));
          return;
        case "copyToClipboard":
          if (contextNodeEntry) void copyTextToClipboard(JSON.stringify(contextNodeEntry, null, 2))
            .then(() => toast.success("已复制到剪贴板"))
            .catch((error: unknown) => toast.error(`复制失败：${backendErrorMessage(error)}`));
          return;
        case "copyImage":
          if (contextImage?.src) void copyCanvasImage(contextImage)
            .then(() => toast.success("图片已复制"))
            .catch((error: unknown) => toast.error(`复制图片失败：${backendErrorMessage(error)}`));
          return;
        case "downloadImage":
          if (contextImage?.localPath) void downloadCanvasImage(contextImage)
            .then(saved => { if (saved) toast.success("图片已保存"); })
            .catch((error: unknown) => toast.error(`下载失败：${backendErrorMessage(error)}`));
          return;
        case "copyNode":
        case "copyExpanded":
          void copyCanvasNodes(new Set([target.nodeKey]));
          return;
        case "duplicate": {
          if (contextImage) {
            const duplicate = duplicateCanvasImage(collectCanvasDocument(), target.nodeKey);
            if (!duplicate) { toast.error("图片尚未保存，暂时无法创建副本。"); return; }
            insertSubgraph(duplicate.nodes, duplicate.edges, { selectNodeKey: duplicate.keys[0] ?? null, groups: duplicate.groups });
            for (const [key, document] of Object.entries(duplicate.promptContents)) promptContents.restoreDocument(key, document);
            setMarqueeNodeKeys(new Set());
            selectEdge(null);
            return;
          }
          const captured = copyCanvasNodes(new Set([target.nodeKey]));
          if (captured != null) pasteCopiedCanvasNodes(captured);
          return;
        }
        case "paste":
          if (!canPasteCanvasNodes) {
            toast.error("请先复制画布节点");
            return;
          }
          pasteCopiedCanvasNodes();
          return;
        case "group":
          if (canGroupSelectedNodes && selectedCanvasNodeKeys.has(target.nodeKey)) {
            groupSelectedCanvasNodes();
            return;
          }
          selectNode(target.nodeKey);
          toast.error("成组需要选中至少两个节点", {
            description: "先在画布上框选多个节点，再按 ⌘G（Ctrl+G）。",
          });
          return;
        case "remove":
          removeSelectedCanvasNode(target.nodeKey);
          return;
        case "exportArtifacts":
          if (artifactDeliveryBusy) {
            toast.error("正在交付中，请稍候");
            return;
          }
          void exportSelectedArtifacts(target.nodeKey);
          return;
        case "formatLayout":
          formatCanvasLayout();
          return;
        default:
          toast.error("该能力后端暂未接入", {
            description: "原站这条上下文操作依赖本项目后端尚未提供的服务；入口与文案已按原站保留。",
          });
      }
    },
    [
      artifactDeliveryBusy,
      canGroupSelectedNodes,
      canPasteCanvasNodes,
      copyCanvasNodes,
      contextImage,
      contextNodeEntry,
      contextMediaPath,
      contextMediaName,
      handleSaveAssetNodeToLibrary,
      uploadTargetLocalGroupId,
      refreshLocalAssets,
      collectCanvasDocument,
      insertSubgraph,
      promptContents,
      selectEdge,
      removeSelectedCanvasNode,
      exportSelectedArtifacts,
      formatCanvasLayout,
      groupSelectedCanvasNodes,
      nodeContextMenu,
      pasteCopiedCanvasNodes,
      selectedCanvasNodeKeys,
      selectNode,
    ],
  );

  const handleFlowNodesChange = useCallback(
    (changes: NodeChange<CanvasFlowNode>[]) => {
      const persistedChanges: CanvasStoreNodeChange[] = [];
      for (const change of changes) {
        if (change.type === "position" && change.position) {
          // LiveCanvasFlow 已逐帧应用拖动位置；这里只在结束时回存业务状态与历史。
          if (change.dragging !== true && !canvasCopyDrag.current) {
            persistedChanges.push({ type: "position", key: change.id, position: change.position });
          }
        } else if (change.type === "dimensions" && change.dimensions) {
          // 受控模式：把 RF 实测尺寸回存到节点数据，节点对象重建时 RF 才能保留 handleBounds。
          persistedChanges.push({
            type: "dimensions",
            key: change.id,
            measured: change.dimensions,
          });
        } else if (change.type === "select") {
          if (marqueeGesture.current) {
            if (change.selected) marqueeGesture.current.add(change.id);
            else marqueeGesture.current.delete(change.id);
            continue;
          }
          // The marquee owns its selection until the gesture ends.
          if (nodeMarquee) continue;
          persistedChanges.push({
            type: "select",
            key: change.id,
            selected: change.selected,
          });
        }
      }
      applyNodeChanges(persistedChanges);
    },
    [applyNodeChanges, nodeMarquee],
  );

  const canvasCopyDrag = useRef<{
    readonly key: string;
    readonly origin: { x: number; y: number };
    readonly source: CanvasNodeClipboard;
  } | null>(null);
  const handleFlowNodeDragStart: OnNodeDrag<CanvasFlowNode> = (event, node, draggedNodes) => {
    canvasCopyDrag.current = null;
    if (!("button" in event) || !event.altKey || event.getModifierState("AltGraph")) return;
    const keys = new Set((draggedNodes.length ? draggedNodes : [node]).map(item => item.id));
    const entries = Object.values(canvasStore.getState().nodesById);
    for (const key of [...keys]) {
      const groupId = assetGroupIdFromFlowId(key);
      if (groupId != null) for (const entry of entries) {
        if (entry.data.assetGroupId === groupId) keys.add(entry.data.key);
      }
    }
    const source = captureCanvasNodes(collectCanvasDocument(), keys,
      event.ctrlKey || event.metaKey ? (keys.size === 1 ? "incoming" : "internal") : "none");
    if (!source.nodes.length) return;
    const groupId = assetGroupIdFromFlowId(node.id);
    const state = canvasStore.getState();
    const origin = groupId != null ? assetGroupBounds(entries.filter(entry => entry.data.assetGroupId === groupId).map(entry => entry.data))
      : state.nodesById[node.id]?.data;
    if (origin) canvasCopyDrag.current = { key: node.id, origin: { x: origin.x, y: origin.y }, source };
  };

  const handleFlowNodeDragStop: OnNodeDrag<CanvasFlowNode> = useCallback(
    (_event, node, draggedNodes) => {
      const nodes = draggedNodes.length > 0 ? draggedNodes : [node];
      const copied = canvasCopyDrag.current;
      if (copied) {
        canvasCopyDrag.current = null;
        const end = nodes.find(item => item.id === copied.key)?.position ?? node.position;
        const offset = { x: end.x - copied.origin.x, y: end.y - copied.origin.y };
        if (offset.x !== 0 || offset.y !== 0) {
          insertCopiedCanvasNodes(copied.source, offset);
          toast.success(`已复制 ${copied.source.nodes.length} 个节点`);
        }
        return;
      }
      applyNodeChanges(
        nodes.map((draggedNode) => ({
          type: "position" as const,
          key: draggedNode.id,
          position: draggedNode.position,
        })),
      );
    },
    [applyNodeChanges, insertCopiedCanvasNodes],
  );

  const handleFlowEdgesChange = (changes: EdgeChange<CanvasFlowEdge>[]) => {
    if (nodeMarquee) return;
    for (const change of changes) {
      if (change.type === "select") {
        selectEdge(change.selected ? change.id : null);
      }
    }
  };

  const handleConnectStart: OnConnectStart = (event, params) => {
    closeConnectionQuickAdd();
    const point = "touches" in event ? event.touches[0] : event;
    connectionStartRef.current =
      params.nodeId && params.handleType && point
        ? {
            nodeKey: params.nodeId,
            handleType: params.handleType,
            x: point.clientX,
            y: point.clientY,
          }
        : null;
    setConnectionSourceKey(params.nodeId);
  };

  const handleConnectEnd: OnConnectEnd = (event, connection) => {
    const start = connectionStartRef.current;
    connectionStartRef.current = null;
    setConnectionSourceKey(null);
    if (!active || !start || connection.isValid || event.type === "touchcancel") return;
    const point = "changedTouches" in event ? event.changedTouches[0] : event;
    if (!point || Math.hypot(point.clientX - start.x, point.clientY - start.y) <= CANVAS_PORT_DRAG_THRESHOLD) return;
    // Touch events retain the starting handle as their target, so hit-test the release point.
    const target =
      "changedTouches" in event
        ? document.elementFromPoint(point.clientX, point.clientY)
        : event.target;
    const droppedKey = canvasNodeKeyFromEventTarget(target);
    const startGroupId =
      start.handleType === "source" ? assetGroupIdFromFlowId(start.nodeKey) : null;
    if (startGroupId != null) {
      if (droppedKey != null) {
        if (assetGroupIdFromFlowId(droppedKey) != null) return;
        connectAssetGroup(startGroupId, droppedKey);
        return;
      }
      if (!(target instanceof Element) || !target.classList.contains("react-flow__pane")) return;
      const boardPosition = dropClientPointToBoard(point.clientX, point.clientY);
      if (!boardPosition) return;
      setConnectionQuickAdd({
        connection: { nodeKey: start.nodeKey, handleType: "source" },
        position: { x: point.clientX, y: point.clientY },
        boardPosition,
      });
      return;
    }
    if (droppedKey != null) {
      if (
        droppedKey === start.nodeKey ||
        canvasEntryByKey(start.nodeKey) == null ||
        assetGroupIdFromFlowId(droppedKey) != null
      )
        return;
      const [fromKey, toKey] =
        start.handleType === "source" ? [start.nodeKey, droppedKey] : [droppedKey, start.nodeKey];
      connectCanvasNodes(fromKey, toKey);
      return;
    }
    if (!(target instanceof Element) || !target.classList.contains("react-flow__pane")) return;
    const boardPosition = dropClientPointToBoard(point.clientX, point.clientY);
    if (!boardPosition || !canvasEntryByKey(start.nodeKey)) return;
    setConnectionQuickAdd({
      connection: { nodeKey: start.nodeKey, handleType: start.handleType },
      position: { x: point.clientX, y: point.clientY },
      boardPosition,
    });
  };

  const handleConnectionQuickAdd = (kind: CanvasQuickAddKind) => {
    if (!connectionQuickAdd) return;
    /*
     * 原站有、本项目后端尚未提供的节点类型（导演台 / 逐帧拉片 / 音频 / 参考节点）：
     * 条目与文案按原站保留，点击给出明确说明，不静默失败。
     */
    const choice = CANVAS_QUICK_ADD_CHOICES.find((item) => item.kind === kind);
    if (choice?.available === false) {
      closeConnectionQuickAdd();
      toast.error(`${choice.label}后端暂未接入`, {
        description: "原站 liblib 画布有这一类节点，本项目的后端服务尚未提供；入口按原站保留。",
      });
      return;
    }
    const { connection, boardPosition, besidePort } = connectionQuickAdd;
    const endpoint = connection ? canvasEntryByKey(connection.nodeKey) : null;
    /*
     * 落点：拖拽落在松手处；**手柄点按**落在端口的另一侧。
     *
     * 原站的「引用该节点生成」把新节点摆在被引用节点的**左边**（画布从左往右流，
     * 新节点消费旧节点的产物）。本项目的输出端口在右、输入端口在左，所以：
     *   · 点输出端口 → 新节点在左边，边是「原节点 → 新节点」（引用它生成）
     *   · 点输入端口 → 新节点在右边，边是「新节点 → 原节点」（接入它）
     * 边的方向沿用端口语义，两种落点方向与边的方向始终一致。
     *
     * 锚点优先取原节点的边缘（点手柄命中区有 80px 直径，直接用点击点会让新节点
     * 偏上偏下几十像素）；原节点不在 store 里（素材组框是渲染出来的伪节点）时
     * 退回点击点。素材组那条分支也走同一份落点，否则新节点会压在手柄上。
     */
    let landing = (kind === "screenplay" || kind === "director") && !connection && connectionQuickAdd.aboveTrigger
      ? { ...boardPosition, y: boardPosition.y - Math.min(100, 80 / (flowInstanceRef.current?.getZoom() ?? 1)) }
      : boardPosition;
    if (besidePort) {
      const size = quickAddNodeDimensions(kind);
      if (size.width > 0) {
        const rect = endpoint ? liveCanvasNodeRect(endpoint) : null;
        const anchorX =
          rect == null
            ? boardPosition.x
            : connection?.handleType === "source"
              ? rect.x + rect.width
              : rect.x;
        const anchorY = rect == null ? boardPosition.y : rect.y + rect.height / 2;
        landing =
          connection?.handleType === "source"
            ? { x: anchorX - NEW_NODE_GAP - size.width / 2, y: anchorY }
            : { x: anchorX + NEW_NODE_GAP + size.width / 2, y: anchorY };
      }
    }
    const sourceGroupId =
      connection?.handleType === "source" ? assetGroupIdFromFlowId(connection.nodeKey) : null;
    if (sourceGroupId != null) {
      closeConnectionQuickAdd();
      const entry = createQuickAddEntry(kind, landing.x, landing.y);
      const state = canvasStore.getState();
      if (state.groups[sourceGroupId]?.purpose === "character") {
        if (kind !== "image" && kind !== "video") return;
        const edges = Object.values(state.nodesById).flatMap((source) => {
          if (source.data.assetGroupId !== sourceGroupId || !isSupportedConnection(source, entry)) return [];
          return [{ id: source.data.key + "->" + entry.data.key, fromKey: source.data.key, toKey: entry.data.key }];
        });
        insertSubgraph([entry], edges, { selectNodeKey: entry.data.key });
        return;
      }
      insertSubgraph([entry], [], { selectNodeKey: entry.data.key });
      connectAssetGroup(sourceGroupId, entry.data.key);
      frontendLog(
        "info",
        `[canvas] 菜单创建节点并接入素材组: key=${entry.data.key}, kind=${kind}, group=${sourceGroupId}`,
      );
      return;
    }
    closeConnectionQuickAdd();
    if (connection && !endpoint) return;
    const entry = createQuickAddEntry(kind, landing.x, landing.y);
    const edges: AssetEdgeData[] = [];
    if (connection && endpoint) {
      const [source, target] =
        connection.handleType === "source" ? [endpoint, entry] : [entry, endpoint];
      if (!isSupportedConnection(source, target)) {
        if (source.type === "asset" && source.data.libraryResource) {
          toast.error(source.data.libraryResource.kind === "style" ? "请选择图片节点来引用风格。" : "请选择视频节点来引用特效。");
        }
        return;
      }
      const fromKey = source.data.key;
      const toKey = target.data.key;
      edges.push({ id: `${fromKey}->${toKey}`, fromKey, toKey });
    }
    insertSubgraph([entry], edges, {
      selectNodeKey: entry.data.key,
    });
    selectEdge(null);
    frontendLog(
      "info",
      `[canvas] 菜单创建节点: key=${entry.data.key}, kind=${kind}, edges=${edges.length}`,
    );
  };

  const uploadQuickAddMedia = async () => {
    if (!connectionQuickAdd) return;
    const anchor = connectionQuickAdd.boardPosition;
    closeConnectionQuickAdd();
    try {
      const paths = await pickLocalMediaFiles();
      if (paths.length) await importCanvasMedia(paths, anchor);
    } catch (error) {
      toast.error("上传素材失败", { description: backendErrorMessage(error) });
    }
  };
  const selectQuickAddHistory = () => {
    if (!connectionQuickAdd) return;
    setHistoryResourceAnchor(connectionQuickAdd.boardPosition);
    setHistoryInitialTaskId(null);
    setHistoryOpen(true);
    closeConnectionQuickAdd();
  };
  const addQuickAddHistoryResult = async (result: GenerationResultRecord) => {
    if (!historyResourceAnchor || !result.finalPath || result.saveStatus !== "succeeded") {
      throw new Error("请先将生成结果保存到本机。");
    }
    if (!(await importCanvasMedia([result.finalPath], historyResourceAnchor))) {
      throw new Error("无法导入该结果，请确认本机文件仍可读取。");
    }
    closeHistory();
  };
  const readQuickAddSearchNodes = (): readonly QuickAddSearchNode[] =>
    Object.values(canvasStore.getState().nodesById).flatMap(entry => {
      const { key } = entry.data;
      if (embeddedOutputOwners[key]) return [];
      const kind = entry.type === "gen" ? entry.data.kind === "prompt" ? "text" : entry.data.kind
        : entry.type === "asset" ? entry.data.kind
          : entry.type === "output" ? entry.data.mediaType
            : entry.type === "videoClip" ? "video_clip" : entry.type;
      const choice = CANVAS_QUICK_ADD_CHOICES.find(item => item.kind === kind);
      const typeLabel = choice?.label ?? (entry.type === "result" ? "结果" : "素材");
      const label = "name" in entry.data && typeof entry.data.name === "string" ? entry.data.name.trim() : "";
      return [{ key, label: label || typeLabel + "节点", typeLabel, icon: choice?.icon ?? "file-text" }];
    });
  const locateQuickAddNode = (key: string) => {
    const entry = canvasEntryByKey(key);
    if (!entry) return;
    const { x, y, width, height } = liveCanvasNodeRect(entry);
    closeConnectionQuickAdd();
    const groupId = entry.data.assetGroupId;
    if (groupId && canvasGroupMetadata[groupId]?.collapsed) updateGroup(groupId, { collapsed: false });
    setNodeMarquee(false);
    setMarqueeNodeKeys(new Set());
    selectEdge(null);
    selectNode(key);
    const flow = flowInstanceRef.current;
    if (flow) void flow.setCenter(x + width / 2, y + height / 2, { zoom: flow.getZoom(), duration: 200 });
  };

  /**
   * 空画布快捷入口：在画布中心建一个对应类型的节点。
   *
   * 原站空画布上的五个入口（图片生成 / 视频生成 / 音频生成 / 剧本生成 / 智能剪辑）
   * 就是这么用的；未接入的类型按约定给出明确说明，不静默失败。
   */
  const createNodeFromEmptyCanvas = useCallback(
    (kind: CanvasQuickAddKind) => {
      const choice = CANVAS_QUICK_ADD_CHOICES.find((item) => item.kind === kind);
      if (choice?.available === false) {
        toast.error(`${choice.label}后端暂未接入`, {
          description: "原站 liblib 画布有这一类节点，本项目的后端服务尚未提供；入口按原站保留。",
        });
        return;
      }
      const center = viewportCenterBoardCoordinates();
      const entry = createQuickAddEntry(kind, center.x, center.y);
      insertSubgraph([entry], [], { selectNodeKey: entry.data.key });
      selectEdge(null);
      frontendLog("info", `[canvas] 空画布入口创建节点: key=${entry.data.key}, kind=${kind}`);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- createQuickAddEntry 是普通函数，放进依赖会让回调每次渲染都变
    [insertSubgraph, selectEdge],
  );

  const canvasNodeKeySetRef = useRef<ReadonlySet<string>>(new Set());
  canvasNodeKeySetRef.current = new Set([
    ...canvasNodeKeys,
    ...new Set(collapsedGroupByNode.values()),
  ]);
  const readNodeSelectionRef = useRef<() => readonly string[]>(() => []);
  const handleNodeSelectionEnd = useCallback(() => {
    const selected = marqueeGesture.current ? [...marqueeGesture.current] : readNodeSelectionRef.current();
    marqueeGesture.current = null;
    const entries = Object.values(canvasStore.getState().nodesById);
    setNodeMarquee(selected.length > 0);
    setMarqueeNodeKeys(
      new Set(
        selected.flatMap((key) => {
          const groupId = assetGroupIdFromFlowId(key);
          return groupId == null
            ? [key]
            : entries
                .filter((entry) => entry.data.assetGroupId === groupId)
                .map((entry) => entry.data.key);
        }),
      ),
    );
    selectNode(null);
    selectEdge(null);
  }, [canvasStore, selectEdge, selectNode]);

  /*
   * 解组（mod+shift+g）：原站注册表是 canvas.ungroup = mod+shift+g / alt+shift+g。
   * 成组有 mod+g，解组此前只在右键菜单里有——快捷键面板声明了解组，照着按没反应。
   * 语义：所选节点同属一个组时才解散；跨组、未选或不是组员时不动作。
   */
  const dissolveSelectedCanvasGroup = useCallback(() => {
    const state = canvasStore.getState();
    const groupIds = new Set<string>();
    for (const key of selectedCanvasNodeKeys) {
      const groupId = state.nodesById[key]?.data.assetGroupId;
      if (groupId == null || groupId === "") continue;
      groupIds.add(groupId);
    }
    for (const groupId of groupIds) dissolveGroup(groupId);
    if (groupIds.size > 0) toast.success("已解散分组");
  }, [canvasStore, dissolveGroup, selectedCanvasNodeKeys]);

  const groupStoryboard = () => {
    const { nodesById } = canvasStore.getState();
    const images = [...selectedCanvasNodeKeys].flatMap<CanvasNodeEntry>(key => {
      const entry = nodesById[key];
      if (!entry || entry.data.assetGroupId) return [];
      if (entry.type === "gen" || entry.type === "asset") return entry.data.kind === "image" ? [entry] : [];
      return entry.type === "output" && entry.data.mediaType === "image" ? [entry] : [];
    });
    if (images.length !== selectedCanvasNodeKeys.size || images.length < 2 || images.length > 25) {
      toast.info("请选择 2 到 25 个未成组的图片节点。");
      return;
    }
    const sorted = images.map(entry => ({ key: entry.data.key, ...liveCanvasNodeRect(entry) }))
      .sort((a, b) => a.y - b.y || a.x - b.x);
    const x = Math.min(...sorted.map(node => node.x));
    const y = Math.min(...sorted.map(node => node.y));
    const width = Math.max(...sorted.map(node => node.width));
    const height = Math.max(...sorted.map(node => node.height));
    const columns = Math.ceil(Math.sqrt(sorted.length));
    const id = assetGroupKey();
    if (groupNodes(sorted.map(node => node.key), id, {
      group: { id, name: "分镜组", collapsed: false, purpose: "storyboard" },
      positions: sorted.map((node, index) => ({
        type: "position", key: node.key,
        position: {
          x: x + (index % columns) * (width + 24) + (width - node.width) / 2,
          y: y + Math.floor(index / columns) * (height + 36) + (height - node.height) / 2,
        },
      })),
    }) === "applied") {
      selectCanvasGroup(id);
      toast.success(`已合并 ${sorted.length} 个分镜`);
    }
  };

  const connectSelectedNodes = () => {
    const [a, b] = selectedCanvasNodeKeys;
    const state = canvasStore.getState();
    if (selectedCanvasNodeKeys.size !== 2 || a == null || b == null) {
      toast.info("请选择两个节点再连线。");
      return;
    }
    const source = state.nodesById[a];
    const target = state.nodesById[b];
    if (!source || !target) return;
    if (state.assetEdges.some(edge => (edge.fromKey === a && edge.toKey === b) || (edge.fromKey === b && edge.toKey === a))) {
      toast.info("两个节点已连接。");
    } else if (isSupportedConnection(source, target) ? connectCanvasNodes(a, b)
      : isSupportedConnection(target, source) && connectCanvasNodes(b, a)) {
      toast.success("已连接两个节点");
    } else if (!isSupportedConnection(source, target) && !isSupportedConnection(target, source)) {
      toast.info("这两种节点无法连接。");
    }
  };

  const chooseCanvasTool = (hand: boolean) => {
    setHandTool(hand);
    closeConnectionQuickAdd();
    setNodeMarquee(false);
    setMarqueeNodeKeys(new Set());
    selectNode(null);
    selectEdge(null);
  };

  const onCanvasKey = useEffectEvent((event: KeyboardEvent) => {
    if (settingsOpen || historyOpen || realPersonDialogOpen || featureModalOpen || shortcutsAnchor ||
      guideOpen || videoLocalEdit || videoPreparation || previewAsset || previewAssetNodeKey || previewOutputNodeKey) return;
    const action = canvasShortcutFor(event);
    if (!action) return;
    if (storyboardEnabled && action !== "undo" && action !== "redo") return;
    const element = event.target instanceof Element ? event.target : null;
    const viewport = canvasViewportRef.current;
    if (!viewport || element?.closest('[aria-modal="true"], [role="menu"], [role="listbox"]')) return;
    const editor = element?.closest<HTMLElement>("[data-node-key]");
    const typing = isInsideFormField(event.target);
    if (typing && action !== "search" && (!editor || (action !== "generate" && action !== "duplicate"))) return;
    if (pickingCanvas && !["zoomIn", "zoomOut", "fit", "undo", "redo"].includes(action)) {
      event.preventDefault();
      return;
    }
    if (action === "add" && (!element || (element !== viewport && !element.matches(".canvas-stage, .react-flow__pane")))) return;
    if (action === "paste" && !canPasteCanvasNodes) return;
    if (action === "copy" && selectedCanvasNodeKeys.size === 0) return;
    if (action === "delete" && selectedEdgeId == null && selectedCanvasNodeKeys.size === 0) return;
    event.preventDefault();
    if (event.repeat && action !== "zoomIn" && action !== "zoomOut") return;
    switch (action) {
      case "add": case "search": {
        const bounds = viewport.getBoundingClientRect();
        const center = { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
        const pointer = lastCanvasPointer.current ?? center;
        const position = action === "search" ? { x: center.x - 135, y: bounds.top + 16 } : pointer;
        const boardPosition = dropClientPointToBoard(pointer.x, pointer.y) ?? viewportCenterBoardCoordinates();
        setConnectionQuickAdd({ connection: null, position, boardPosition, searchOnly: action === "search" });
        break;
      }
      case "generate": {
        const key = editor?.dataset["nodeKey"] ?? (selectedCanvasNodeKeys.size === 1 ? [...selectedCanvasNodeKeys][0] : null);
        if (!key) return;
        const submit = () => {
          const buttons = viewport.querySelectorAll<HTMLButtonElement>("button[data-canvas-generate]");
          const matching = [...buttons].filter(button =>
            (button.closest<HTMLElement>("[data-node-key]")?.dataset["nodeKey"] ?? canvasNodeKeyFromEventTarget(button)) === key &&
            !button.closest("[hidden], [inert]") && button.getClientRects().length > 0,
          );
          const button = matching.find(item => editor?.contains(item)) ?? matching[0];
          if (button && !button.disabled) button.click();
          return button != null;
        };
        const node = canvasStore.getState().nodesById[key];
        if (!submit() && (node?.type === "gen" || node?.type === "screenplay" || node?.type === "videoClip")) {
          openNodeEditor(key);
          requestAnimationFrame(() => {
            if (activeRef.current && canvasStore.getState().selectedNodeKey === key && !viewport.closest("[inert]")) submit();
          });
        }
        break;
      }
      case "group": groupSelectedCanvasNodes(); break;
      case "storyboard": groupStoryboard(); break;
      case "ungroup": dissolveSelectedCanvasGroup(); break;
      case "connect": connectSelectedNodes(); break;
      case "duplicate": duplicateSelectedCanvasNodes(); break;
      case "copy": copySelectedCanvasNodes(); break;
      case "paste": pasteCopiedCanvasNodes(); break;
      case "zoomIn": zoomAroundViewportCenter(viewRef.current.zoom + ZOOM_STEP); break;
      case "zoomOut": zoomAroundViewportCenter(viewRef.current.zoom - ZOOM_STEP); break;
      case "fit": void flowInstanceRef.current?.fitView({ duration: 200 }); break;
      case "move": chooseCanvasTool(false); break;
      case "hand": chooseCanvasTool(true); break;
      case "format": formatCanvasLayout(); break;
      case "undo": undoCanvasOperation(); break;
      case "redo": redoCanvasOperation(); break;
      case "delete":
        if (selectedCanvasNodeKeys.size > 1 || marqueeNodeKeys.size > 0) deleteSelectedCanvasNodes();
        else if (selectedEdgeId != null) removeAssetEdge(selectedEdgeId);
        else if (selectedNodeKey != null) removeSelectedCanvasNode(selectedNodeKey);
        break;
    }
  });

  useEffect(() => {
    if (!active || !canvasHydrated) return;
    const onKeyDown = (event: KeyboardEvent) => onCanvasKey(event);
    const onEditorKeyDown = (event: KeyboardEvent) => {
      const shortcut = canvasShortcutFor(event);
      if (shortcut !== "generate" && shortcut !== "search" && shortcut !== "duplicate") return;
      if (!(event.target instanceof Element) || !event.target.closest("[data-node-key]")) return;
      // Prompt editors handle Enter during bubbling. Claim the explicit chord first.
      onCanvasKey(event);
      if (event.defaultPrevented) event.stopPropagation();
    };
    document.addEventListener("keydown", onEditorKeyDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onEditorKeyDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [active, canvasHydrated]);

  const handleFlowConnect = (connection: Connection) => {
    if (!connection.source || !connection.target) return;
    const groupId = assetGroupIdFromFlowId(connection.source);
    if (groupId != null) {
      connectAssetGroup(groupId, connection.target);
      return;
    }
    if (assetGroupIdFromFlowId(connection.target) != null) return;
    connectCanvasNodes(connection.source, connection.target);
  };

  const applyLibraryResource = (resource: CanvasLibraryResource) => {
    const preview = canvasLibraryResourcePreview(resource);
    const name = `素材-${resource.kind === "style" ? "风格" : "特效"}-${preview.name}`;
    const replaceKey = libraryDialog?.replaceKey;
    if (replaceKey) {
      const existing = canvasStore.getState().nodesById[replaceKey];
      if (existing?.type !== "asset" || existing.data.libraryResource?.kind !== resource.kind) {
        throw new Error("素材节点已发生变化，请重新打开素材库。");
      }
      patchNode("asset", replaceKey, (node) => ({ ...node, name, previewUrl: preview.src, libraryResource: resource }));
    } else {
      const center = viewportCenterBoardCoordinates();
      const node: AssetNodeData = {
        key: assetNodeKey(), kind: "image", assetId: "", providerConnectionId: "",
        name, libraryResource: resource, previewUrl: preview.src, videoUrl: null,
        x: center.x, y: center.y,
      };
      const { width, height } = assetNodeDimensions(node);
      const titleClearance = 32;
      const position = dropPosition(center.x, center.y, width, height + titleClearance);
      if (insertSubgraph(
        [{ type: "asset", data: { ...node, x: position.x, y: position.y + titleClearance } }],
        [], { selectNodeKey: node.key },
      ) !== "applied") {
        throw new Error("素材暂时无法放到画布，请重试。");
      }
      setNodeMarquee(false);
      setMarqueeNodeKeys(new Set());
      selectEdge(null);
    }
  };

  const libraryReplacement = libraryDialog?.replaceKey ? canvasEntryByKey(libraryDialog.replaceKey) : null;
  const currentLibraryResource = libraryReplacement?.type === "asset" ? libraryReplacement.data.libraryResource : undefined;
  const characterTarget = characterStudio?.targetKey ? canvasEntryByKey(characterStudio.targetKey) : null;

  async function importCharacterMedia(sources: readonly CharacterMediaSource[], kind: "image" | "audio") {
    return withCharacterSourcePaths(sources, async (paths) => {
      const records = [];
      for (const [index, path] of paths.entries()) {
        if (!activeRef.current) throw new Error("画布已切换，请重新打开角色造型室。");
        const record = await localBase64AssetClient.importAsset({ localPath: path, name: sources[index]?.label ?? null });
        if (record.mediaType !== kind) throw new Error(kind === "image" ? "角色参考必须是图片。" : "音色参考必须是音频。");
        records.push(record);
      }
      if (records.length) refreshLocalAssets("upload-finished");
      return records;
    });
  }

  function placeCharacterMedia(
    records: Awaited<ReturnType<typeof importCharacterMedia>>,
    anchor: { x: number; y: number },
    occupied: CanvasNodeRect[],
    groupId?: string,
  ): CanvasNodeEntry[] {
    return records.map((record) => {
      const node: AssetNodeData = {
        key: assetNodeKey(), assetId: record.id, providerConnectionId: "", source: "local",
        kind: record.mediaType, name: record.name, previewUrl: record.previewUrl, videoUrl: null,
        x: anchor.x, y: anchor.y, ...(groupId ? { assetGroupId: groupId } : {}),
      };
      const size = assetNodeDimensions(node);
      const position = nearestAvailableNodePosition({ ...anchor, ...size }, occupied);
      occupied.push({ ...position, ...size });
      return { type: "asset", data: { ...node, ...position } };
    });
  }

  const useCharacterInCanvas = async (role: BrandModelSelection) => {
    const targetKey = characterStudio?.targetKey;
    const info = characterVersionInfo(role.description);
    const records = await importCharacterMedia(role.references.map(reference => ({
      label: role.name + " · " + reference.label, path: reference.path,
    })), "image");
    if (!activeRef.current) throw new Error("画布已切换，请重新选择角色。");
    const state = canvasStore.getState();
    const target = targetKey ? state.nodesById[targetKey] : undefined;
    if (targetKey && (target?.type !== "gen" || (target.data.kind !== "image" && target.data.kind !== "video") ||
      (target.data.kind === "image" && target.data.config.imageMode === "upscale"))) {
      throw new Error("当前节点已变化，请重新打开角色造型室。");
    }
    const occupied = Object.values(state.nodesById).map(liveCanvasNodeRect);
    const center = viewportCenterBoardCoordinates();
    const anchor = target ? { x: target.data.x - genNodeDimensions("prompt").width - NEW_NODE_GAP, y: target.data.y } : center;
    const roleGroupId = assetGroupKey();
    const promptNode = createGenNode("prompt", anchor.x, anchor.y);
    if (promptNode.kind !== "prompt") return;
    const textSize = genNodeDimensions("prompt");
    const textPosition = nearestAvailableNodePosition({ ...anchor, ...textSize }, occupied);
    occupied.push({ ...textPosition, ...textSize });
    const textEntry: CanvasNodeEntry = {
      type: "gen", data: {
        ...promptNode, ...textPosition, name: role.name + " · 角色设定", assetGroupId: roleGroupId,
        config: { ...promptNode.config, generatedPrompt: characterPrompt(role.name, info, role.invariants) },
      },
    };
    const entries = [textEntry, ...placeCharacterMedia(records, {
      x: textPosition.x, y: textPosition.y + textSize.height + NEW_NODE_GAP,
    }, occupied, roleGroupId)];
    const edges = targetKey ? entries.map(({ data }) => ({
      id: data.key + "->" + targetKey, fromKey: data.key, toKey: targetKey,
    })) : [];
    if (insertSubgraph(entries, edges, {
      selectNodeKey: targetKey ?? null,
      groups: { [roleGroupId]: { id: roleGroupId, name: "角色 · " + role.name, collapsed: false, purpose: "character" } },
    }) !== "applied") throw new Error("角色没有放到画布，请重试。");
    setNodeMarquee(false);
    setMarqueeNodeKeys(new Set());
    selectEdge(null);
    if (!targetKey) {
      selectCanvasGroup(roleGroupId);
      const bounds = assetGroupBounds(entries.map(entry => entry.data));
      const flow = flowInstanceRef.current;
      if (flow) void flow.setCenter(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, { zoom: flow.getZoom(), duration: 200 });
    }
  };

  const stageCharacterDraft = async (draft: CharacterGenerationDraft) => {
    const records = await importCharacterMedia(draft.sources, draft.kind);
    if (!activeRef.current) throw new Error("画布已切换，请重新打开角色造型室。");
    const occupied = Object.values(canvasStore.getState().nodesById).map(liveCanvasNodeRect);
    const center = viewportCenterBoardCoordinates();
    const node = { ...createGenNode(draft.kind, center.x, center.y), name: draft.name };
    occupied.push(liveCanvasNodeRect({ type: "gen", data: node }));
    const assets = placeCharacterMedia(records, {
      x: node.x - ASSET_NODE_WIDTH - NEW_NODE_GAP, y: node.y,
    }, occupied);
    if (insertSubgraph([{ type: "gen", data: node }, ...assets], assets.map(({ data }) => ({
      id: data.key + "->" + node.key, fromKey: data.key, toKey: node.key,
    })), { selectNodeKey: node.key }) !== "applied") throw new Error("未能准备角色生成节点，请重试。");
    promptContents.restoreDocument(node.key, { schema: "prompt-content", version: 1, items: [{ kind: "text", text: draft.prompt }] });
    scheduleCanvasSaveRef.current();
    const { x, y, width, height } = liveCanvasNodeRect({ type: "gen", data: node });
    const flow = flowInstanceRef.current;
    if (flow) void flow.setCenter(x + width / 2, y + height / 2, { zoom: flow.getZoom(), duration: 200 });
    openNodeEditor(node.key);
  };

  function setStoryboard(next: Partial<StoryboardLayout>) {
    const value = { ...storyboardLayout, ...next };
    setStoryboardLayout(value);
    try { localStorage.setItem(storyboardStorageKey, JSON.stringify(value)); } catch { /* Keep the current layout. */ }
  }

  function switchToStoryboard(enabled: boolean) {
    if (storyboardEnabled === enabled) return;
    if (enabled) {
      closeNodeEditor();
      closeConnectionQuickAdd();
      onAssetDrawerTabChange(null);
      setShortcutsAnchor(null);
    }
    if (!enabled) setStoryboardScriptKey(null);
    setStoryboard({ enabled });
  }

  function openStoryboardScript(sourceKey?: string) {
    if (!activeRef.current || !canvasHydrated) throw new Error("请等待画布加载。");
    const state = canvasStore.getState();
    const source = sourceKey ? state.nodesById[sourceKey] : undefined;
    if (sourceKey && (source?.type !== "screenplay" || (!source.data.config.scriptGenerator && !source.data.config.currentDocument.trim()))) {
      throw new Error("剧本正文为空或已移除。");
    }
    if (source?.type === "screenplay" && source.data.config.scriptGenerator) {
      setStoryboardScriptKey(source.data.key);
      return;
    }
    const key = source ? "tv-storyboard-" + source.data.key : screenplayNodeKey();
    const existing = state.nodesById[key];
    if (existing?.type === "screenplay" && existing.data.config.scriptGenerator) {
      setStoryboardScriptKey(key);
      return;
    }
    const center = viewportCenterBoardCoordinates();
    const draft = createScreenplayNode(center.x, center.y);
    const position = nearestAvailableNodePosition({
      ...liveCanvasNodeRect({ type: "screenplay", data: draft }),
      ...(source ? { x: source.data.x + liveCanvasNodeRect(source).width + NEW_NODE_GAP, y: source.data.y } : {}),
    }, Object.values(state.nodesById).map(liveCanvasNodeRect));
    const upstream = source ? new Set([source.data.key, ...canvasInputsFor(source.data.key).media.map(input => input.sourceKey)]) : new Set<string>();
    const links = [...upstream].filter(fromKey => state.nodesById[fromKey]).map(fromKey => ({
      id: fromKey + "->" + key, fromKey, toKey: key,
    }));
    if (insertSubgraph([{ type: "screenplay", data: { ...draft, ...position, key } }], links, { selectNodeKey: null }) !== "applied") {
      throw new Error("未能创建分镜脚本。");
    }
    scheduleCanvasSaveRef.current();
    setStoryboardScriptKey(key);
  }

  function openDirectorFilm(turn: DirectorTurn, id: string) {
    const key = directorDraftKey(turn.id, id);
    const state = canvasReadModelOfState(canvasStore.getState());
    if (state.nodeByKey.videoClip.get(key)?.config.timeline) return openStoryboardFilm([], "TV Director · 成片", key);
    const assets = projectStoryboard(state);
    const sources = (turn.plan?.links ?? []).filter(link => link.to === id).flatMap(link => {
      const sourceKey = turn.sources[link.from] ?? directorDraftKey(turn.id, link.from);
      const draft = turn.plan?.nodes.find(node => node.id === link.from);
      if (draft?.kind === "video") {
        const job = turn.jobs?.find(item => item.draftId === link.from && item.status === "complete");
        const result = job && state.nodes.output.find(item =>
          item.taskId === job.taskId && item.sourceNodeId === sourceKey && item.mediaType === "video" && item.finalPath);
        const target = result ? outputNodeReferenceTarget(result) : null;
        if (target) return [{ key: sourceKey, name: draft.name, target }];
        throw new Error(draft.name + "还没有已保存的批次片段，请先完成生成。");
      }
      const asset = assets.find(item => item.key === sourceKey);
      const source = asset ? storyboardFilmSource(asset) : null;
      if (source) return [source];
      const output = state.nodeByKey.output.get(sourceKey);
      const target = output?.mediaType === "video" && output.finalPath ? outputNodeReferenceTarget(output) : null;
      return target ? [{ key: sourceKey, name: output?.name ?? "视频片段", target }] : [];
    });
    return openStoryboardFilm(sources, "TV Director · 成片", key);
  }

  function getDirectorCanvasContext(keys: readonly string[], includeCanvas: boolean) {
    const state = canvasStore.getState();
    const all = Object.values(state.nodesById);
    const selected = all.filter(entry => selectedCanvasNodeKeys.has(entry.data.key));
    const included = new Set([...keys, ...(includeCanvas ? (selected.length ? selected : all).map(entry => entry.data.key) : [])]);
    const entries = [...included].slice(0, 24).flatMap(key => state.nodesById[key] ?? []);
    const aliases = new Map(entries.map((entry, index) => [entry.data.key, "canvas-" + (index + 1)]));
    const context: DirectorCanvasContext = {
      nodes: entries.map(entry => {
        const kind = "kind" in entry.data ? entry.data.kind : entry.type;
        const name = "name" in entry.data && typeof entry.data.name === "string" ? entry.data.name : kind;
        const text = entry.type === "screenplay" ? entry.data.config.currentDocument ||
          (entry.data.config.scriptGenerator ? scriptDocument(entry.data.config.scriptGenerator) : "") :
          promptContents.read(entry.data.key)?.plainText ||
          (entry.type === "gen" && entry.data.kind === "prompt" ?
            entry.data.config.generatedPrompt || entry.data.config.sourcePrompt : entry.type === "output" ? entry.data.textContent ?? "" : "");
        return { id: aliases.get(entry.data.key)!, kind, name, text: text.slice(0, 1200) };
      }),
      links: state.assetEdges.flatMap(edge => {
        const from = aliases.get(edge.fromKey);
        const to = aliases.get(edge.toKey);
        return from && to ? [{ from, to }] : [];
      }).slice(0, 64),
    };
    return { context, sources: Object.fromEntries([...aliases].map(([key, alias]) => [alias, key])) };
  }

  function locateDirectorPlan(keys: readonly string[], panelLeft: number) {
    const state = canvasStore.getState();
    const nodes = keys.flatMap(key => state.nodesById[key]?.data ?? []);
    if (!nodes.length) return;
    closeNodeEditor();
    selectNode(null);
    selectEdge(null);
    setNodeMarquee(false);
    setMarqueeNodeKeys(new Set());
    const groupId = nodes[0]?.assetGroupId;
    if (groupId && state.groups[groupId]) {
      if (state.groups[groupId].collapsed) updateGroup(groupId, { collapsed: false });
      selectCanvasGroup(groupId);
    }
    const bounds = assetGroupBounds(nodes);
    const flow = flowInstanceRef.current;
    const viewport = canvasViewportRef.current?.getBoundingClientRect();
    if (!flow || !viewport) return;
    const visibleWidth = Math.max(1, Math.min(viewport.width, panelLeft - viewport.left));
    const targetZoom = Math.max(MIN_ZOOM / 100, Math.min(flow.getZoom(),
      (visibleWidth - 48) / bounds.width, (viewport.height - 112) / bounds.height));
    void flow.setViewport({
      zoom: targetZoom,
      x: visibleWidth / 2 - (bounds.x + bounds.width / 2) * targetZoom,
      y: viewport.height / 2 - (bounds.y + bounds.height / 2) * targetZoom,
    }, { duration: 200 });
  }

  function applyDirectorPlan(turn: DirectorTurn, panelLeft: number) {
    const plan = turn.plan;
    if (!activeRef.current || !canvasHydrated || !plan?.nodes.length) throw new Error("当前画布还无法应用方案。");
    const state = canvasStore.getState();
    const occupied = Object.values(state.nodesById).map(liveCanvasNodeRect);
    const center = viewportCenterBoardCoordinates();
    const groupId = plan.nodes.length > 1 ? "tv-director-group-" + turn.id : null;
    let nextX = center.x;
    const entries = new Map<string, CanvasNodeEntry>();
    const documents: Record<string, PromptContentDocumentV1> = {};
    for (const draft of plan.nodes) {
      const key = directorDraftKey(turn.id, draft.id);
      if (state.nodesById[key]) throw new Error("这份方案已经放到画布。");
      const entry = createQuickAddEntry(draft.kind === "screenplay" ? "screenplay_legacy" : draft.kind, nextX, center.y);
      const bounds = liveCanvasNodeRect(entry);
      const position = nearestAvailableNodePosition({
        x: nextX, y: center.y - bounds.height / 2, width: bounds.width, height: bounds.height,
      }, occupied);
      const placement = { ...position, key, ...(groupId ? { assetGroupId: groupId } : {}) };
      if (entry.type === "gen") {
        const data = entry.data;
        entries.set(draft.id, { type: "gen", data: data.kind === "prompt" ? {
          ...data, ...placement, name: draft.name, config: { ...data.config, generatedPrompt: draft.prompt },
        } : { ...data, ...placement, name: draft.name } });
      } else if (entry.type === "screenplay") {
        entries.set(draft.id, { type: "screenplay", data: {
          ...entry.data, ...placement, config: { ...entry.data.config, currentDocument: draft.prompt },
        } });
      } else if (entry.type === "videoClip") {
        entries.set(draft.id, { type: "videoClip", data: {
          ...entry.data, ...placement, name: draft.name, config: { ...entry.data.config, outputName: draft.name },
        } });
      }
      if (entry.type === "gen" || entry.type === "videoClip") documents[key] = {
        schema: "prompt-content", version: 1, items: [{ kind: "text", text: draft.prompt }],
      };
      occupied.push({ ...position, width: bounds.width, height: bounds.height });
      nextX = position.x + bounds.width + NEW_NODE_GAP;
    }
    const edges = plan.links.map(link => {
      const source = entries.get(link.from) ?? state.nodesById[turn.sources[link.from] ?? ""];
      const target = entries.get(link.to);
      if (!source || !target || !isSupportedConnection(source, target)) {
        throw new Error("方案引用的节点已移除，或该连线不可用。请根据当前画布重新准备方案。");
      }
      return { id: source.data.key + "->" + target.data.key, fromKey: source.data.key, toKey: target.data.key };
    });
    const appliedQuality: Record<string, string> = {};
    for (const [id, entry] of entries) {
      if (entry.type !== "gen" || (entry.data.kind !== "image" && entry.data.kind !== "video")) continue;
      const sources = plan.links.filter(link => link.to === id)
        .map(link => entries.get(link.from) ?? state.nodesById[turn.sources[link.from] ?? ""]);
      const media = sources.map(source => source?.type === "output" ? source.data.mediaType :
        source && "kind" in source.data ? source.data.kind : null)
        .filter(kind => kind === "image" || kind === "video" || kind === "audio");
      const data = entry.data;
      const operation = data.kind === "video" ? "video_generation" :
        media.some(kind => kind === "image" || kind === "video") ? "image_to_image" : "text_to_image";
      const model = turn.quality === "hd" ? resolveGenerationSelection(data.kind, data.config.modelSelection, providerCatalog)?.model : undefined;
      const hd = model ? directorHdParameter(model, operation, data.config.parameterValues, media.length > 0) : null;
      const parameterValues = hd ? { ...data.config.parameterValues, [hd.key]: hd.value } : data.config.parameterValues;
      if (turn.quality === "hd") appliedQuality[id] = hd ? "写入节点画质 · " + hd.label : "此模型没有可用的高清档位，沿用节点设置。";
      if (data.kind === "video") {
        const firstFrame = media.length === 1 && media[0] === "image";
        if (hd || firstFrame) entries.set(id, { type: "gen", data: {
          ...data, config: { ...data.config, parameterValues, ...(firstFrame ? { videoMode: "first_frame" } : {}) },
        } });
      } else if (hd) {
        entries.set(id, { type: "gen", data: { ...data, config: { ...data.config, parameterValues } } });
      }
    }
    const first = entries.values().next().value;
    if (!first || insertSubgraph([...entries.values()], edges, {
      selectNodeKey: null,
      ...(groupId ? { groups: { [groupId]: {
        id: groupId, name: "TV Director · " + turn.input.slice(0, 36), collapsed: false,
      } } } : {}),
    }) !== "applied") throw new Error("未能将导演方案放到画布。");

    promptContents.restoreSubset(documents);
    canvasStore.getState().setPromptDocuments(promptContents.snapshotAll());
    scheduleCanvasSaveRef.current();
    if (!storyboardEnabled) locateDirectorPlan([...entries.values()].map(entry => entry.data.key), panelLeft);
    return turn.quality === "hd" ? appliedQuality : undefined;
  }

  async function runDirectorMedia(turn: DirectorTurn, jobs: readonly DirectorJob[], saveJob: (job: DirectorJob) => void,
    setProgress: (progress: string) => void, signal: AbortSignal) {
    const plan = turn.plan;
    if (!plan || !isDesktopRuntime() || !canvasHydrated) throw new Error("请在桌面画布中运行生成方案。");
    const canvasKey = (id: string) => Object.hasOwn(turn.sources, id) ? turn.sources[id]! : directorDraftKey(turn.id, id);
    const ensureActive = () => {
      signal.throwIfAborted();
      if (!activeRef.current) throw new Error("已切换画布，生成方案已暂停。");
    };
    const configuration = (key: string) => {
      const state = canvasStore.getState();
      const entry = state.nodesById[key];
      if (entry?.type !== "gen" || entry.data.kind === "prompt") throw new Error("方案中的媒体节点已移除。");
      return JSON.stringify([
        entry.data.config, promptContents.read(key)?.document,
        state.assetEdges.filter(edge => edge.toKey === key),
      ]);
    };
    const initialConfigurations = new Map(jobs.map(job => [job.draftId, configuration(canvasKey(job.draftId))]));
    for (const job of jobs) {
      ensureActive();
      const draft = plan.nodes.find(node => node.id === job.draftId);
      if (!draft || !isDirectorMediaKind(draft.kind)) throw new Error("方案任务记录不匹配。");
      const key = canvasKey(draft.id);
      setProgress("正在核对 · " + draft.name);
      if (job.status === "ready") {
        const previous = await generationClient.list({ canvasId, sourceNodeId: key, limit: 1 });
        ensureActive();
        if (previous.items.length) throw new Error(draft.name + "已有生成记录，请在画布节点上核对结果。");
        const state = canvasStore.getState();
        const missingLink = plan.links.some(link => link.to === draft.id &&
          !state.assetEdges.some(edge => edge.fromKey === canvasKey(link.from) && edge.toKey === key));
        if (missingLink || configuration(key) !== initialConfigurations.get(draft.id)) {
          throw new Error(draft.name + "的参数或连线已变化，请重新确认方案。");
        }
        saveJob({ ...job, status: "recorded" });
        const result = await handleStartGeneration(key, { clientTaskId: job.taskId });
        if (!result) {
          saveJob(job);
          throw new Error(draft.name + "未通过生成校验，请打开节点查看原因。");
        }
        if (!result.taskIds.includes(job.taskId)) {
          throw new Error(result.errors[0] ?? draft.name + "的提交回执不明确，请查询任务记录。");
        }
      }
      setProgress("等待生成与保存 · " + draft.name);
      const deadline = Date.now() + 8 * 60 * 1000;
      for (;;) {
        ensureActive();
        const detail = await generationClient.getProgress(job.taskId);
        ensureActive();
        if (detail.summary.canvasId !== canvasId || detail.summary.sourceNodeId !== key) {
          throw new Error("任务记录与方案节点不匹配，已暂停生成。");
        }
        const saved = detail.results.filter(result =>
          result.mediaType === draft.kind && result.saveStatus === "succeeded" && result.finalPath);
        if (detail.summary.status === "succeeded" && saved.length) {
          const complete = await generationClient.get(job.taskId);
          ensureActive();
          const landed = complete.results.filter(record => saved.some(item => item.resultIndex === record.resultIndex &&
            item.finalPath === record.finalPath && record.saveStatus === "succeeded")).map(record => applyGenerationResult(record));
          if (!landed.some(Boolean)) throw new Error(draft.name + "的文件已保存，请在画布生成历史中恢复产物。");
          if (job.status !== "complete") saveJob({ ...job, status: "complete" });
          break;
        }
        if (detail.summary.status !== "succeeded" && isTerminalTaskStatus(detail.summary.status)) {
          const reason = detail.finalError ? backendErrorMessage(detail.finalError) : detail.summary.status;
          throw new Error(draft.name + "未完成，已暂停后续节点。" + reason);
        }
        if (detail.summary.status === "succeeded" &&
            !detail.results.some(result => result.saveStatus === "pending" || result.saveStatus === "writing")) {
          throw new Error(draft.name + "未取得可用的本地媒体，已暂停后续节点。");
        }
        if (Date.now() >= deadline) throw new Error(draft.name + "仍在处理。可稍后查询同一任务并继续。");
        await new Promise<void>(resolve => window.setTimeout(resolve, 2000));
      }
    }
  }

  const handleFlowInit = (instance: ReactFlowInstance<CanvasFlowNode, CanvasFlowEdge>) => {
    flowInstanceRef.current = instance;
    const { zoom: currentZoom, pan: currentPan } = viewRef.current;
    if (currentZoom !== DEFAULT_ZOOM || currentPan.x !== 0 || currentPan.y !== 0) {
      void instance.setViewport({ x: currentPan.x, y: currentPan.y, zoom: currentZoom / 100 });
    }
  };

  // 用户手势与命令式视口变化（zoomTo/setViewport 动画）结束时同步一次 store：
  // 平移/缩放过程中不再逐帧重渲染整个 App。
  const handleFlowMoveEnd = (_event: MouseEvent | TouchEvent | null, viewport: Viewport) => {
    setIsPanning(false);
    setView({ pan: { x: viewport.x, y: viewport.y }, zoom: Math.round(viewport.zoom * 100) });
  };

  const selectedAssetsLoading =
    assetLibrarySource === "local"
      ? localAssetsLoading
      : cloudCollection === "object_storage"
        ? objectStorageLoading
        : assetsLoading;
  const selectedAssetsError =
    assetLibrarySource === "local"
      ? localAssetsError
      : cloudCollection === "object_storage"
        ? objectStorageError
        : assetsError;
  const selectedLibraryError =
    assetLibrarySource === "local"
      ? localLibraryError
      : cloudCollection === "object_storage"
        ? objectStorageLibraryError
        : libraryError;
  const uploadActionLabel =
    assetLibrarySource === "local"
      ? "上传到本地素材库"
      : cloudCollection === "object_storage"
        ? "上传到对象存储"
        : "上传本地素材到云端素材库";
  // 面板当前选中的分组即上传目标（云端与本地同规则）：选中分组后，上传必须直接
  // 归入该分组，而不是落到默认位置、只在「全部素材」里可见。
  const uploadGroupName =
    assetLibrarySource === "local"
      ? (localAssetGroups.find((group) => group.id === selectedLocalAssetGroupId)?.name ?? null)
      : cloudCollection === "library"
        ? (assetGroups.find((group) => group.id === selectedAssetGroupId)?.name ?? null)
        : null;

  if (!active) return null;

  const clipTimelineNode = clipTimeline ? canvasNodesOfState(canvasStore.getState(), "videoClip").find(node => node.key === clipTimeline.key) : null;
  const clipModelOptions = (operation: "text_generation" | "video_generation" | "speech_generation"):
    readonly (ClipAgentModelOption & { readonly remoteModelId: string })[] =>
    providerCatalog.flatMap(entry => entry.provider.enabled ? entry.models.filter(model => model.operations.includes(operation)).map(model => ({
      providerId: entry.provider.id, modelDefinitionId: model.definitionId, remoteModelId: model.remoteModelId,
      label: `${entry.provider.displayName} · ${model.displayName}`,
    })) : []);
  let clipTimelineInputs = clipTimelineNode ? videoClipInputsFor(canvasReadModelOfState(canvasStore.getState()), clipTimelineNode.key) : [];
  if (clipTimelineNode && !clipTimelineInputs.some(input => input.nodeType === "video")) {
    const result = canvasNodesOfState(canvasStore.getState(), "output").filter(output => output.sourceNodeId === clipTimelineNode.key && output.mediaType === "video" && output.finalPath).at(-1);
    const target = result ? outputNodeReferenceTarget(result) : null;
    if (result && target) clipTimelineInputs = [...clipTimelineInputs, { key: result.key, name: result.name ?? "剪辑成片", nodeType: "video", edgeId: "", previewUrl: result.finalPath ? toMediaSrc(result.finalPath) : null, target }];
  }

  return (
    <main className={`workspace-shell workspace-shell--immersive${storyboardEnabled
      ? " workspace-shell--storyboard" : assetDrawerTab ? " workspace-shell--asset-drawer" : ""}${pickingCanvas ? " workspace-shell--reference-picking" : ""}`}>
      {directorEntry?.type === "director" ? <Suspense fallback={<div role="status" className="sr-only">正在加载3D导演台…</div>}>
        <LazyDirectorEditor key={directorEntry.data.key} node={directorEntry.data}
          models={clipModelOptions("text_generation")} defaultModel={nodeModelSelections.prompt}
          references={(directorInputs ?? []).flatMap(input => input.kind === "image" ?
            [{ key: input.sourceKey, name: input.name, previewUrl: input.previewUrl ?? null }] : [])}
          generating={startingNodeKeys.has(directorEntry.data.key)} generationError={startErrorsByNode[directorEntry.data.key] ?? null}
          onClose={() => setDirectorEditorKey(null)}
          onChange={(update, options) => {
            const change = () => patchNode("director", directorEntry.data.key, node => {
              const scene: DirectorScene = update(node.scene);
              const panoramaKey = options?.clearPanorama ? null : node.panoramaKey;
              return scene === node.scene && panoramaKey === node.panoramaKey ? node : { ...node, scene, panoramaKey, previewUrl: null };
            });
            if (options?.coalesce) runWithCoalescedHistory(change);
            else change();
          }}
          onPrompt={setDirectorPrompt} onGenerate={generateDirectorScene} onMotion={generateDirectorScene} onPick={setDirectorReferenceKey}
          onRecognize={(key, request) => generateDirectorScene(key, undefined, request)}
          onPanorama={panoramaKey => patchNode("director", directorEntry.data.key, node => ({ ...node, panoramaKey, previewUrl: null }))}
          onCapture={(media, signal) => saveDirectorCaptures(directorEntry.data.key, media, signal)}
          onUndo={undoCanvasOperation} onRedo={redoCanvasOperation} />
      </Suspense> : null}
      {directorReferenceKey ? <CanvasTextImagePicker key={directorReferenceKey}
        targets={getFeatureSources({ kind: "image-hd" })} listAssets={listFeatureAssets} hasCloud={assetProvider != null}
        onBack={() => setDirectorReferenceKey(null)}
        onChoose={source => {
          try { attachDirectorReference(directorReferenceKey, source); } catch (error) { toast.error(backendErrorMessage(error)); }
        }}
        onChooseAsset={asset => {
          try { attachDirectorReference(directorReferenceKey, asset); } catch (error) { toast.error(backendErrorMessage(error)); }
        }}
        onChooseFile={async (path, signal) => {
          const asset = await chooseFeatureFile("image", path, signal);
          if (asset) attachDirectorReference(directorReferenceKey, asset);
        }}
      /> : null}
      {textReferenceKey ? <CanvasTextImagePicker key={textReferenceKey}
        targets={getFeatureSources({ kind: "image-hd" })} listAssets={listFeatureAssets} hasCloud={assetProvider != null}
        onBack={() => setTextReferenceKey(null)}
        onChoose={key => {
          try { attachTextReference(textReferenceKey, key); } catch (error) { toast.error(backendErrorMessage(error)); }
        }}
        onChooseAsset={asset => {
          try { attachTextReference(textReferenceKey, asset); } catch (error) { toast.error(backendErrorMessage(error)); }
        }}
        onChooseFile={async (path, signal) => {
          const asset = await chooseFeatureFile("image", path, signal);
          if (asset) attachTextReference(textReferenceKey, asset);
        }}
      /> : null}
      {storyboardEnabled && storyboardScriptEntry?.type === "screenplay" ? <StoryboardScriptDialog
        key={storyboardScriptEntry.data.key} canvasId={canvasId} node={storyboardScriptEntry.data} active
        running={startingNodeKeys.has(storyboardScriptEntry.data.key)}
        batchRunning={scriptBatchRunningKeys.has(storyboardScriptEntry.data.key)}
        error={startErrorsByNode[storyboardScriptEntry.data.key] ?? null}
        providerCatalog={providerCatalog} sourceInputs={storyboardScriptInputs} connectedMedia={storyboardScriptMedia ?? []}
        onUpdate={update => updateScreenplayNode(storyboardScriptEntry.data.key, update)}
        onRun={handleRunScreenplayNode} onPick={nodeKey => setScriptReferencePick({ nodeKey })}
        onPickAsset={(nodeKey, assetId) => setScriptReferencePick({ nodeKey, assetId })}
        onRemoveMaterial={handleRemoveScreenplayMaterial}
        onUnlink={removeAssetEdge} onExport={handleExportScreenplay} onCreateMedia={handleScriptCreateMedia}
        onCreateAsset={handleScriptCreateAsset} onSmartCompose={handleScriptSmartCompose}
        onStartBatch={handleScriptBatchStart} onResumeBatch={handleScriptBatchResume}
        onFilm={openScriptFilm} onClose={() => setStoryboardScriptKey(null)}
      /> : null}
      {scriptReferencePick ? <CanvasTextImagePicker key={scriptReferencePick.nodeKey}
        targets={getFeatureSources({ kind: "image-hd" })} listAssets={listFeatureAssets} hasCloud={assetProvider != null}
        onBack={() => setScriptReferencePick(null)}
        onChoose={key => {
          try { attachScriptReference(scriptReferencePick, key); } catch (error) { toast.error(backendErrorMessage(error)); }
        }}
        onChooseAsset={asset => {
          try { attachScriptReference(scriptReferencePick, asset); } catch (error) { toast.error(backendErrorMessage(error)); }
        }}
        onChooseFile={async (path, signal) => {
          const asset = await chooseFeatureFile("image", path, signal);
          if (asset) attachScriptReference(scriptReferencePick, asset);
        }}
      /> : null}
      {clipTimelineNode && clipTimeline ? <VideoClipTimeline
        key={clipTimelineNode.key}
        name={clipTimelineNode.config.outputName}
        inputs={clipTimelineInputs}
        saved={clipTimelineNode.config.timeline}
        savedSettings={clipTimelineNode.config.timelineSettings}
        params={resolveVideoClipParams(clipTimelineNode.config)}
        jobs={(clipRenderJobs.data ?? []).filter(job => job.sourceNodeId === clipTimelineNode.key)}
        autoStart={clipTimeline.autoStart}
        models={clipModelsFor(clipTimelineNode.config)}
        modelOptions={{ text: clipModelOptions("text_generation"), video: clipModelOptions("video_generation"), speech: clipModelOptions("speech_generation") }}
        onModelChange={(kind, model) => { const live = canvasStore.getState().nodesById[clipTimelineNode.key]; if (live?.type === "videoClip") { updateVideoClipConfig(clipTimelineNode.key, { agentModels: { ...live.data.config.agentModels, [kind]: model } }); scheduleCanvasSaveRef.current(); } }}
        onRunAgent={!["default", "smartMixCut"].includes(clipTimelineNode.config.modeKey) ? () => startVideoClip(clipTimelineNode.key) : undefined}
        nodeError={startErrorsByNode[clipTimelineNode.key]}
        readError={clipRenderJobs.error}
        onRefresh={() => { void clipRenderJobs.refetch(); }}
        onImportParams={params => changeVideoClipParams(clipTimelineNode.key, params)}
        onSave={(clips, settings) => saveClipTimeline(clipTimelineNode.key, clips, settings)}
        onRender={renderClipTimeline}
        onCancelJob={async id => { await clipRenderClient.cancel(id); await clipRenderJobs.refetch(); }}
        onResumeJob={async id => { await clipRenderClient.resume(id); await clipRenderJobs.refetch(); }}
        onClose={() => setClipTimeline(null)}
      /> : null}
      {!canvasHydrated ? (
        <div className="canvas-load-notice" role="status">
          <strong>{canvasPersistence.error ? "画布读取失败" : "正在读取画布…"}</strong>
          {canvasPersistence.error ? (
            <>
              <p>{canvasPersistence.error}</p>
              <button type="button" onClick={canvasPersistence.retry}>
                重试读取画布
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      <div className="workspace-content" inert={settingsOpen || !canvasHydrated ? true : undefined}>
        <a className="skip-link" href={storyboardEnabled ? "#canvas-storyboard-workspace" : "#canvas-workspace"}>
          {storyboardEnabled ? "跳到故事板" : "跳到画布"}
        </a>
        <header className="workspace-header">
          <div className="brand-lockup" aria-label="无限画布">
            <span className="brand-mark" aria-hidden="true">
              <Icon name="bounding-box" size="2xl" />
            </span>
            <span className="brand-name">无限画布</span>
          </div>
          <div
            className={`save-state${canvasPersistence.error ? " save-state--error" : ""}`}
            title={canvasPersistence.error ?? undefined}
            role="status"
          >
            {canvasPersistence.error ? (
              <Icon name="warning-circle" aria-hidden="true" size="sm" />
            ) : (
              <Icon name="check-circle" aria-hidden="true" size="sm" />
            )}
            {canvasPersistence.status === "saved"
              ? "已保存"
              : canvasPersistence.status === "saving"
                ? "正在保存…"
                : canvasPersistence.status === "pending"
                  ? "待保存"
                  : canvasPersistence.status === "loading"
                    ? "正在读取…"
                    : "保存失败"}
            {/*
             * 保存时间戳：光说「已保存」只说明「上次保存成功了」，不说明
             * 「内容有多新」。崩溃会丢掉防抖窗口里的编辑，磁盘上是旧版本，
             * 界面却照样写「已保存」—— 用户无从判断眼前这份画布有多旧。
             * 把时间摆出来，用户一眼就知道该信不信这份内容。
             */}
            {canvasPersistence.status === "saved" && canvasPersistence.savedAt != null ? (
              <span
                className="save-state__time"
                title={`最近保存于 ${formatSavedAtFull(canvasPersistence.savedAt)}`}
              >
                {formatSavedAt(canvasPersistence.savedAt)}
              </span>
            ) : null}
            {canvasPersistence.error && canvasHydrated ? (
              <button type="button" onClick={canvasPersistence.retry}>
                重试保存
              </button>
            ) : null}
          </div>
          {/*
           * 崩溃恢复提示。
           *
           * 上次退出是**崩溃**而不是正常关闭（草稿比存档新），那些差点丢掉的
           * 改动已经被恢复。这件事必须明确告诉用户 —— 静默恢复会让人以为那些
           * 内容一直好好地存在（其实它们差点就消失了），也让人不知道上次到底
           * 发生过什么。
           */}
          {canvasPersistence.recoveredAt != null ? (
            <div className="workspace-recovered-notice" role="status">
              <Icon name="warning-circle" aria-hidden="true" size="sm" />
              <span>
                上次退出时应用意外中断，未保存的改动已恢复（恢复于 {formatSavedAt(canvasPersistence.recoveredAt)}）。
              </span>
            </div>
          ) : null}
          <div className="workspace-header__navigation">
            {storyboardEnabled && canvasCatalog?.length ? <CanvasSelect ariaLabel="切换画布" id={`canvas-tab-${canvasId}`}
              className="storyboard-canvas-select" value={canvasId}
              options={[
                ...canvasCatalog.map(canvas => ({ value: canvas.id, label: canvas.name })),
                ...(onCreateCanvas ? [{ value: "new-canvas", label: "新建画布" }] : []),
              ]}
              onChange={value => {
                if (value === "new-canvas") onCreateCanvas?.();
                else onSelectCanvas?.(value);
              }} /> : canvasNavigation}
            <div className="canvas-storyboard-switch" role="group" aria-label="工作区视图">
            <button type="button" aria-label="工作流" data-tooltip="工作流" aria-pressed={!storyboardEnabled}
              onClick={() => switchToStoryboard(false)}>
              <Workflow size={16} aria-hidden="true" />
            </button>
            <button type="button" aria-label="故事板" data-tooltip="故事板" aria-pressed={storyboardEnabled}
              onClick={() => switchToStoryboard(true)}>
              <LibTVMediaIcon name="storyboard" size={16} />
            </button>
            </div>
          </div>
          <div className="header-actions">
            <button
              type="button"
              className="header-icon"
              aria-label={storyboardEnabled ? "显示项目素材" : "打开素材库侧板"}
              aria-controls={storyboardEnabled ? undefined : "canvas-asset-drawer"}
              aria-expanded={storyboardEnabled ? storyboardLayout.showAssets : assetDrawerTab === "assets"}
              data-tooltip={storyboardEnabled ? "显示项目素材" : "素材库"}
              onClick={(event) => {
                if (storyboardEnabled) setStoryboard({ showAssets: !storyboardLayout.showAssets });
                else toggleAssetDrawer("assets", event.currentTarget);
              }}
            >
              <Icon name="stack-simple" aria-hidden="true" size="lg" />
            </button>
            {!storyboardEnabled ? <button
              type="button"
              className="header-icon"
              aria-label="清空画布"
              data-tooltip="清空画布上的节点与连线"
              onClick={openClearCanvasDialog}
            >
              <Icon name="arrow-counter-clockwise" aria-hidden="true" size="lg" />
            </button> : null}
            <button
              ref={settingsTriggerRef}
              type="button"
              className="header-icon"
              aria-label="打开全局设置"
              aria-controls="global-settings-dialog"
              aria-expanded={settingsOpen}
              data-tooltip="全局设置"
              onMouseEnter={preloadProviderSettingsDialog}
              onFocus={preloadProviderSettingsDialog}
              onClick={() => {
                setSettingsOpen(true);
              }}
            >
              <Icon name="gear-six" aria-hidden="true" size="lg" />
            </button>
          </div>
        </header>

        <CanvasAssetDrawerHost
          tab={storyboardEnabled ? null : assetDrawerTab}
          onTabChange={onAssetDrawerTabChange}
          onClose={closeAssetDrawer}
          referenceSelection={reference.selectedByNode}
          onPickReferences={reference.toggleNodes}
          canvases={canvasCatalog ?? []}
          activeCanvasId={canvasId}
          onSelectCanvas={(id) => onSelectCanvas?.(id)}
          embeddedOutputOwners={embeddedOutputOwners}
          onLocateNode={(key) => {
            const groupId = canvasEntryByKey(key)?.data.assetGroupId;
            if (groupId && canvasGroupMetadata[groupId]?.collapsed) updateGroup(groupId, { collapsed: false });
            locateQuickAddNode(key);
          }}
          onLocateGroup={(id) => {
            selectCanvasGroup(id);
            const group = canvasAssetGroups.find((item) => item.groupId === id);
            if (!group) return;
            const { x, y, width, height } = assetGroupBounds(group.members);
            const collapsed = canvasGroupMetadata[id]?.collapsed;
            const flow = flowInstanceRef.current;
            if (flow) void flow.setCenter(
              x + (collapsed ? 460 : width) / 2,
              y + (collapsed ? 112 : height) / 2,
              { zoom: flow.getZoom(), duration: 200 },
            );
          }}
        >
        <AssetPanel
          uploadActionLabel={uploadActionLabel}
          onImportLocalAssets={() => {
            void handleImportLocalAssets(undefined, {
              destination:
                assetLibrarySource === "local"
                  ? "local"
                  : cloudCollection === "object_storage"
                    ? "object_storage"
                    : "cloud",
            });
          }}
          isOffline={isOffline}
          source={assetLibrarySource}
          cloudCollection={cloudCollection}
          onCloudCollectionChange={(next) => {
            if (next === cloudCollection) return;
            setAssetSearch("");
            committedAssetSearchRef.current = "";
            setCommittedAssetSearch("");
            setPickedAssets([]);
            setCloudCollection(next);
          }}
          onSourceChange={(next) => {
            setAssetLibrarySource(next);
            persistWorkspaceUi(activeAssetProviderId, next);
            setAssetSearch("");
            if (!isDesktopRuntime()) return;
            if (next === "local") refreshLocalAssets("initial");
            else setAssetsLoading(Boolean(assetProvider));
          }}
          providerId={assetProvider?.id ?? null}
          availableProviders={availableAssetProviders}
          onProviderChange={(nextId) => {
            const nextProvider = availableAssetProviders.find((provider) => provider.id === nextId);
            if (nextProvider) handleAssetProviderChanged(nextProvider.id);
          }}
          onOpenRealPersonDialog={() => setRealPersonDialogOpen(true)}
          assetsLoading={selectedAssetsLoading}
          libraryError={selectedLibraryError}
          assetsError={selectedAssetsError}
          onRetryLocal={() => refreshLocalAssets("manual")}
          onRetryCloud={() => {
            if (assetProvider) refreshCloudAssets(assetProvider.id, "manual");
          }}
          onRetryObjectStorage={() => refreshObjectStorageAssets("manual")}
          pullingBucket={pullingBucket}
          onPullBucket={() => {
            void handlePullObjectStorageBucket();
          }}
          uploads={assetUploads}
          onDismissUpload={dismissAssetUpload}
          groups={assetGroups}
          groupsLoading={groupsLoading}
          groupsError={groupsError}
          selectedGroupId={selectedAssetGroupId}
          onGroupChange={handleAssetGroupChanged}
          onRefreshGroups={refreshAssetGroups}
          onCreateGroup={() => setNewGroupDialogOpen(true)}
          onDeleteGroup={(groupId) => {
            if (assetProvider) handleDeleteAssetGroup(assetProvider.id, groupId);
          }}
          localGroups={localAssetGroups}
          localGroupsLoading={localGroupsLoading}
          localGroupsError={localGroupsError}
          selectedLocalGroupId={selectedLocalAssetGroupId}
          onLocalGroupChange={handleLocalAssetGroupChanged}
          onRefreshLocalGroups={refreshLocalAssetGroups}
          onCreateLocalGroup={() => setNewLocalGroupDialogOpen(true)}
          onDeleteLocalGroup={handleDeleteLocalAssetGroup}
          onMovePickedLocalAssets={(groupId) => {
            handleMoveLocalAssets(pickedAssets, groupId);
          }}
          onDeletePickedLocalAssets={() => {
            setDeletingPickedLocalAssets(true);
            void handleDeleteLocalAssets(pickedAssets).finally(() =>
              setDeletingPickedLocalAssets(false),
            );
          }}
          deletingPickedLocalAssets={deletingPickedLocalAssets}
          kind={assetKind}
          getKindCount={(tabKind) =>
            // 浏览器模式：演示数据即时计数；本地素材：分页响应携带的全库类型计数；
            // 云端：面板打开时扫一次全库得到的类型计数（上传/删除按增量维护）。
            !isDesktopRuntime()
              ? libraryAssets.filter((asset) => asset.kind === tabKind).length
              : assetLibrarySource === "local"
                ? localAssetKindTotals[tabKind]
                : cloudCollection === "object_storage"
                  ? objectStorageKindTotals[tabKind]
                  : (cloudAssetKindTotals?.[tabKind] ?? null)
          }
          onKindChange={(tabKind) => {
            setAssetKind(tabKind);
            setAssetSearch("");
          }}
          search={assetSearch}
          onSearchChange={setAssetSearch}
          searchPending={assetSearchPending}
          uploadGroupName={uploadGroupName}
          resultSummary={
            !isDesktopRuntime()
              ? `找到 ${visibleAssets.length} 个${ASSET_KIND_LABELS[assetKind]}素材`
              : assetLibrarySource === "local"
                ? `找到 ${localAssetTotal} 个${ASSET_KIND_LABELS[assetKind]}素材`
                : cloudCollection === "object_storage"
                  ? `找到 ${objectStorageTotal} 个${ASSET_KIND_LABELS[assetKind]}对象`
                  : `本页 ${visibleAssets.length} 个${ASSET_KIND_LABELS[assetKind]}素材`
          }
          visibleAssets={visibleAssets}
          onPreviewAsset={handlePreviewAsset}
          onDropAssetToCanvas={handleDropAssetToCanvas}
          {...(cloudCollection === "library"
            ? { onPreviewUnavailable: handleUnavailableCloudAsset }
            : {})}
          multiSelect={assetMultiSelect}
          pickedCount={pickedAssets.length}
          pickOrderByKey={pickingReference ? referenceAssetOrder : pickOrderByKey}
          onToggleMultiSelect={toggleAssetMultiSelect}
          onTogglePickedAsset={pickingReference ? reference.toggleAsset : togglePickedAsset}
          canReferenceAsset={pickingReference ? reference.acceptsAsset : undefined}
          onPlacePickedAssets={handlePlacePickedAssets}
          onClearPickedAssets={() => setPickedAssets([])}
          localPage={localAssetPageNumber}
          localTotalPages={localAssetTotalPages}
          localTotal={localAssetTotal}
          cloudPage={
            cloudCollection === "object_storage" ? objectStoragePageNumber : cloudAssetPageNumber
          }
          cloudTotalPages={
            cloudCollection === "object_storage" ? objectStorageTotalPages : cloudAssetTotalPages
          }
          cloudTotal={cloudCollection === "object_storage" ? objectStorageTotal : cloudAssetTotal}
          cloudHasMore={
            cloudCollection === "object_storage"
              ? objectStoragePageNumber < objectStorageTotalPages
              : cloudAssetHasMore
          }
          onLocalPageChange={goToLocalAssetPage}
          onCloudPageChange={
            cloudCollection === "object_storage" ? goToObjectStoragePage : goToCloudAssetPage
          }
        />

        </CanvasAssetDrawerHost>

        <section
          id="canvas-workspace"
          className="canvas-stage"
          aria-label="无限画布工作区"
          aria-hidden={storyboardEnabled || undefined}
          inert={storyboardEnabled || undefined}
          tabIndex={-1}
        >
          <AppUpdateBanner />
          {marking.targetKey ? <CanvasImageMarkingBar onReturn={() => {
            locateQuickAddNode(marking.targetKey!);
            marking.stop();
          }} onExit={marking.stop} /> : null}
          {marking.overlays}
          {reference.session ? (
            <div className="canvas-reference-pick-bar" aria-label="画布参考">
              <div className="canvas-reference-pick-bar__message" role="status">
                <span className="canvas-reference-pick-bar__icon" aria-hidden="true"><Navigation size={18} /></span>
                <span>从画布或资产管理选择参考</span>
              </div>
              <div className="canvas-reference-pick-bar__actions">
                <button type="button" onClick={() => {
                  const key = reference.session?.targetKey;
                  if (key) locateQuickAddNode(key);
                  reference.stop();
                }}>返回节点</button>
                <button type="button" aria-label="退出参考选择" data-tooltip="退出参考选择 · Esc" onClick={reference.stop}>
                  <CanvasChromeIcon name="close" size={16} />
                </button>
              </div>
            </div>
          ) : null}
          <div
            className={`canvas-viewport${isPanning ? " is-panning" : ""}${nodeMarquee ? " is-selecting" : ""}${handTool ? " is-hand-tool" : ""}${externalMediaDropHover ? " is-external-media-drop" : ""}${pickingReference ? " canvas-reference-picking" : ""}${marking.targetKey ? " canvas-image-marking" : ""}`}
            style={{ "--canvas-media-title-scale": 100 / Math.max(50, zoom) } as CSSProperties}
            ref={canvasViewportRef}
            tabIndex={0}
            aria-label="画布快捷键区域"
            onPointerMove={(event) => { lastCanvasPointer.current = { x: event.clientX, y: event.clientY }; }}
            onPointerCancel={() => { marqueeGesture.current = null; }}
            onDoubleClick={(event) => {
              if (pickingCanvas) return;
              if (
                !(event.target instanceof Element) ||
                !event.target.classList.contains("react-flow__pane")
              )
                return;
              const boardPosition = dropClientPointToBoard(event.clientX, event.clientY);
              if (!boardPosition) return;
              setConnectionQuickAdd({
                connection: null,
                position: { x: event.clientX, y: event.clientY },
                boardPosition,
              });
            }}
          >
            {externalMediaDropHover ? (
              <div className="canvas-external-media-drop-hint" role="status">
                松开以将素材放入画布并保存到本地素材库
              </div>
            ) : null}
            <CanvasVideoFrameCropContext.Provider value={videoFrameCrop}>
            {/* Capture the node grab offset on press so the first mouse move also moves the node. */}
            <LiveCanvasFlow
              className="canvas-react-flow"
              nodes={flowNodes}
              edges={visibleFlowEdges}
              onlyRenderVisibleElements={canvasViewportMeasured}
              nodeTypes={CANVAS_FLOW_NODE_TYPES}
              edgeTypes={CANVAS_FLOW_EDGE_TYPES}
              defaultViewport={DEFAULT_CANVAS_FLOW_VIEWPORT}
              minZoom={MIN_ZOOM / 100}
              maxZoom={MAX_ZOOM / 100}
              snapToGrid={snapToGrid}
              snapGrid={[24, 24]}
              panOnDrag={handTool || pickingCanvas ? [0, 1] : [1]}
              nodesDraggable={!handTool && !pickingCanvas}
              nodeDragThreshold={0}
              nodesConnectable={!handTool && !pickingCanvas}
              elementsSelectable={!handTool && !pickingCanvas}
              selectionOnDrag={!handTool && !pickingCanvas}
              selectionMode={SelectionMode.Partial}
              onSelectionStart={() => { marqueeGesture.current = new Set(); }}
              onSelectionEnd={handleNodeSelectionEnd}
              panOnScroll
              zoomOnScroll={false}
              zoomOnPinch
              zoomOnDoubleClick={false}
              preventScrolling
              connectionRadius={CANVAS_CONNECTION_RADIUS}
              connectionDragThreshold={CANVAS_PORT_DRAG_THRESHOLD}
              connectOnClick={false}
              connectionLineStyle={{ stroke: "var(--canvas-edge)", strokeWidth: 2 }}
              deleteKeyCode={null}
              onInit={handleFlowInit}
              onNodesChange={handleFlowNodesChange}
              onNodeDragStart={handleFlowNodeDragStart}
              onNodeDragStop={handleFlowNodeDragStop}
              onEdgesChange={handleFlowEdgesChange}
              onConnect={handleFlowConnect}
              onConnectStart={handleConnectStart}
              onConnectEnd={handleConnectEnd}
              onMoveStart={() => {
                closeConnectionQuickAdd();
                setIsPanning(true);
              }}
              onMoveEnd={handleFlowMoveEnd}
              onPaneClick={() => {
                canvasViewportRef.current?.focus({ preventScroll: true });
                if (pickingCanvas) return;
                selectNode(null);
                selectEdge(null);
                setMarqueeNodeKeys(new Set());
                setNodeMarquee(false);
              }}
              onPaneContextMenu={(event) => {
                event.preventDefault();
                if (pickingCanvas) return;
                const boardPosition = dropClientPointToBoard(event.clientX, event.clientY);
                if (!boardPosition) return;
                setConnectionQuickAdd({
                  connection: null,
                  position: { x: event.clientX, y: event.clientY },
                  boardPosition,
                });
              }}
              onNodeContextMenu={(event, node) => {
                event.preventDefault();
                if (pickingCanvas) return;
                setNodeContextMenu({ x: event.clientX, y: event.clientY, nodeKey: node.id });
              }}
              onSelectionContextMenu={(event) => {
                event.preventDefault();
                if (pickingCanvas) return;
                const nodeKey = selectedGroupableNodeKeys[0];
                if (canGroupSelectedNodes && nodeKey) {
                  setNodeContextMenu({ x: event.clientX, y: event.clientY, nodeKey });
                }
              }}
              onNodeClick={(event, node) => {
                if (handTool || pickingCanvas) return;
                const groupId = assetGroupIdFromFlowId(node.id);
                if (groupId != null) {
                  selectCanvasGroup(groupId);
                  return;
                }
                if (nodeMarquee || event.shiftKey || event.ctrlKey || event.metaKey) {
                  if (!canvasNodeKeySetRef.current.has(node.id)) return;
                  setNodeMarquee(true);
                  setMarqueeNodeKeys((current) => {
                    if (!event.shiftKey && !event.ctrlKey && !event.metaKey)
                      return new Set([node.id]);
                    const next = new Set(current);
                    if (selectedNodeKey) next.add(selectedNodeKey);
                    if (next.has(node.id)) next.delete(node.id);
                    else next.add(node.id);
                    return next;
                  });
                  selectNode(null);
                  selectEdge(null);
                  return;
                }
                setMarqueeNodeKeys(new Set());
                selectNode(node.id);
                selectEdge(null);
              }}
              onEdgeClick={(_, edge) => {
                if (nodeMarquee || pickingCanvas) return;
                if (edge.selectable !== false) {
                  selectEdge(edge.id);
                  selectNode(null);
                }
              }}
              aria-label="无限画布节点编辑器"
              attributionPosition="bottom-left"
            >
                <CanvasMarqueeSelectionReader
                  selectableKeysRef={canvasNodeKeySetRef}
                  readSelectionRef={readNodeSelectionRef}
                />
              {/* 点阵随原生视口移动，给媒体留出安静的背景。 */}
              <Background
                id="canvas-grid-minor"
                variant={BackgroundVariant.Dots}
                gap={24}
                size={2}
                lineWidth={1}
                className="canvas-flow-bg canvas-flow-bg--minor"
              />
              {minimapVisible ? (
                <MiniMap
                  className="canvas-minimap"
                  ariaLabel="画布小地图"
                  bgColor="var(--minimap-bg)"
                  maskColor="var(--minimap-mask)"
                  nodeColor="var(--minimap-node)"
                  nodeStrokeColor="var(--minimap-node)"
                  nodeBorderRadius={2}
                  pannable
                  zoomable
                />
              ) : null}
            </LiveCanvasFlow>
            </CanvasVideoFrameCropContext.Provider>

            <CanvasReferenceLibraryContext.Provider value={referenceLibrary}>
              <CanvasReferencePickingContext.Provider value={reference.context}>
              <CanvasImageMarkingContext.Provider value={marking.context}>
              <div className="video-node-editor-layer">
                {[...genFlowNodes, ...screenplayFlowNodes, ...videoClipFlowNodes].map((node) => (
                  <RetainedNodeEditor key={node.id} open={editingNodeKey === node.id}>
                    {cloneElement(
                      node.data.content as ReactElement<{ presentation: "card" | "editor" }>,
                      { presentation: "editor" },
                    )}
                  </RetainedNodeEditor>
                ))}
              </div>
              </CanvasImageMarkingContext.Provider>
              </CanvasReferencePickingContext.Provider>
            </CanvasReferenceLibraryContext.Provider>

            {connectionQuickAdd && quickAddEndpointExists ? (
              <ConnectionQuickAddMenu
                key={connectionQuickAdd.searchOnly ? "node-search" : "add-node"}
                position={connectionQuickAdd.position}
                aboveTrigger={connectionQuickAdd.aboveTrigger === true}
                connectionMode={connectionQuickAdd.connection !== null}
                searchOnly={connectionQuickAdd.searchOnly === true}
                allowedKinds={quickAddIsCharacter ? ["image", "video"]
                  : quickAddResource?.kind === "style" ? ["image"]
                  : quickAddResource?.kind === "effect" ? ["video"] : undefined}
                hint={
                  connectionQuickAdd.besidePort
                    ? connectionQuickAdd.connection?.handleType === "source"
                      ? "选择后创建并引用该节点"
                      : "选择后创建并接入该节点"
                    : undefined
                }
                triggerElement={connectionQuickAdd.portTrigger ?? (connectionQuickAdd.connection ? null : nodeMenuTriggerElement)}
                portSide={connectionQuickAdd.besidePort ? connectionQuickAdd.connection?.handleType === "target" ? "left" : "right" : undefined}
                onSelect={handleConnectionQuickAdd}
                onUpload={() => { void uploadQuickAddMedia(); }}
                onHistory={selectQuickAddHistory}
                readSearchNodes={readQuickAddSearchNodes}
                onLocate={locateQuickAddNode}
                onClose={closeConnectionQuickAdd}
              />
            ) : null}

            {/* 空态提示与连线/拖动捕获层挂在视口上，不随画布平移缩放。 */}
            {!hasCanvasNodes ? (
              <div className="canvas-empty-hint">
                {/*
                  原站 liblib 的空画布就是一行提示 + 一排创建入口（实测截图与
                  i18n：guideDoubleClickCanvas「双击画布」+ guideFreelyCreateNodes
                  「自由生成节点」，下面五个入口是图片生成 / 视频生成 / 音频生成 /
                  剧本生成 / 智能剪辑）。
                */}
                <p className="canvas-empty-hint__guide">
                  <CanvasChromeIcon name="move" size={18} />
                  <span>双击画布</span>
                  <span>自由生成节点</span>
                </p>
                <div className="canvas-empty-hint__actions">
                  {EMPTY_CANVAS_SHORTCUTS.map(({ kind, label, icon }) => (
                    <button
                      key={kind}
                      type="button"
                      className={`canvas-empty-hint__action canvas-empty-hint__action--${kind}`}
                      onClick={() => createNodeFromEmptyCanvas(kind)}
                    >
                      <span className="canvas-empty-hint__action-icon" aria-hidden="true">
                        <Icon name={icon} size="md" />
                      </span>
                      <span className="canvas-empty-hint__action-label">{label}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          {!pickingCanvas ? <CanvasBottomDock
            characterStudioOpen={characterStudio?.open === true}
            onOpenCharacterStudio={() => {
              closeConnectionQuickAdd();
              if (characterStudio && !characterStudio.open) setCharacterStudio({ ...characterStudio, open: true });
              else openCharacterStudio();
            }}
            onOpenLibrary={(kind) => {
              closeConnectionQuickAdd();
              setLibraryDialog({ kind });
            }}
            featuresOpen={featuresOpen}
            onOpenFeatures={() => {
              closeConnectionQuickAdd();
              setFeaturesOpen(true);
            }}
            addNodeOpen={connectionQuickAdd !== null}
            addNodeTriggerRef={setNodeMenuTriggerElement}
            onAddNode={(trigger) => {
              if (connectionQuickAdd) {
                closeConnectionQuickAdd();
                return;
              }
              const bounds = trigger.getBoundingClientRect();
              setConnectionQuickAdd({
                connection: null,
                position: { x: bounds.left, y: bounds.top },
                boardPosition: viewportCenterBoardCoordinates(),
                aboveTrigger: true,
              });
            }}
            handTool={handTool}
            onToggleHandTool={() => chooseCanvasTool(!handTool)}
            onOpenHistory={() => {
              setHistoryResourceAnchor(null);
              setHistoryOpen(true);
            }}
            onPreloadHistory={preloadHistoryDialog}
            shortcutsOpen={shortcutsAnchor != null}
            onOpenShortcuts={setShortcutsAnchor}
            onOpenGuide={() => {
              setGuideOpen(true);
            }}
            directorOpen={directorOpen}
            onToggleDirector={() => setDirectorOpen(previous => !previous)}
          /> : null}

          <div className="canvas-viewport-dock">
            <CanvasChromeControls
              onOpenAssets={(trigger) => {
                if (assetDrawerTab) closeAssetDrawer();
                else toggleAssetDrawer("canvas", trigger);
              }}
              assetsOpen={assetDrawerTab != null}
              onFormatLayout={formatCanvasLayout}
              minimapVisible={minimapVisible}
              onToggleMinimap={() => {
                setMinimapVisible((visible) => !visible);
              }}
              edgesVisible={edgesVisible}
              onToggleEdges={() => {
                setEdgesVisible((visible) => !visible);
              }}
              snapToGrid={snapToGrid}
              onToggleSnap={() => {
                setSnapToGrid((enabled) => !enabled);
              }}
              zoomControl={
                <CanvasZoomMenu
                  zoom={zoom}
                  step={ZOOM_STEP}
                  minZoom={MIN_ZOOM}
                  maxZoom={MAX_ZOOM}
                  onZoomChange={(next) => {
                    zoomAroundViewportCenter(next);
                  }}
                  onFitView={() => {
                    resetCanvasViewport();
                  }}
                  open={zoomMenuOpen}
                  onOpenChange={setZoomMenuOpen}
                />
              }
            />
          </div>
        </section>

        <div id="canvas-storyboard-workspace" tabIndex={storyboardEnabled ? -1 : undefined} className={"canvas-storyboard-layout" +
          (storyboardEnabled ? " is-active" : "") + (storyboardLayout.chatSide === "right" ? " is-chat-right" : "")}>
          <CanvasTvDirector key={canvasId} canvasId={canvasId} open={active && (storyboardEnabled || directorOpen)}
            onClose={() => setDirectorOpen(false)} models={clipModelOptions("text_generation")}
            defaultModel={nodeModelSelections.prompt} nodeKeys={canvasNodeKeys} getCanvasContext={getDirectorCanvasContext}
            getSources={kind => getFeatureSources(kind === "image" ? { kind: "image-hd" } :
              kind === "video" ? { kind: "video-crop" } : { kind: "audio", mode: "trim" })
              .map(source => ({ ...source, displayName: source.label }))}
            listAssets={listFeatureAssets} hasCloud={assetProvider != null}
            assetReference={asset => {
              const { target } = characterSourceFromAsset(asset);
              return target ? { target, displayName: asset.name } : null;
            }}
            importFile={chooseFeatureFile} onApply={applyDirectorPlan} onLocate={(keys, panelLeft) => {
              if (storyboardEnabled) switchToStoryboard(false);
              locateDirectorPlan(keys, storyboardEnabled ? window.innerWidth : panelLeft);
            }} onRun={runDirectorMedia}
            referenceRequest={storyboardReference}
            onReferenceHandled={id => setStoryboardReference(current => current?.id === id ? null : current)}
            storyboard={storyboardEnabled ? {
              layout: storyboardLayout, onChange: setStoryboard,
              getAssets: () => projectStoryboard(canvasReadModelOfState(canvasStore.getState())),
              openScript: openStoryboardScript, openFilm: openDirectorFilm,
            } : undefined} />
          {active && storyboardEnabled && storyboardLayout.showAssets ? <>
            <StoryboardResizeHandle axis="horizontal" label="调整项目素材列宽" value={storyboardLayout.width} min={260} max={740}
              reverse={storyboardLayout.chatSide === "left"} onResize={width => setStoryboard({ width })}
              onPreview={width => {
                if (storyboardFrameRef.current) storyboardFrameRef.current.style.width = `min(${width}px, 50%)`;
              }}
              onReset={() => setStoryboard({ width: 360 })} />
            <div className="storyboard-assets-frame" ref={storyboardFrameRef}
              style={{ width: `min(${storyboardLayout.width}px, 50%)` }}>
              <CanvasStoryboardAssets canvasId={canvasId} project={projectStoryboard} listAssets={listFeatureAssets}
                hasCloud={assetProvider != null} onChooseFile={chooseFeatureFile}
                getTargets={kind => getFeatureSources(kind === "image" ? { kind: "image-hd" } :
                  kind === "video" ? { kind: "video-crop" } : { kind: "audio", mode: "trim" })}
                onImport={async () => {
                  const paths = await pickLocalMediaFiles(["image", "video", "audio"], { multiple: true });
                  if (paths.length) await importCanvasMedia(paths, viewportCenterBoardCoordinates());
                }}
                onPlace={asset => {
                  const { x, y } = viewportCenterBoardCoordinates();
                  if (!addAssetNode(asset, x, y)) throw new Error("该素材无法放到当前画布。");
                }}
                onCreate={kind => {
                  const { x, y } = viewportCenterBoardCoordinates();
                  insertSubgraph([createQuickAddEntry(kind, x, y)], []);
                }}
                onReference={asset => setStoryboardReference({ id: crypto.randomUUID(), asset })}
                onScript={openStoryboardScript} onFilm={sources => openStoryboardFilm(sources, "项目成片")}
                onEditFilm={handleOpenVideoClipEditor}
                onLocate={key => {
                  switchToStoryboard(false);
                  locateQuickAddNode(key);
                }} />
            </div>
          </> : null}
        </div>
      </div>
      {/* 原站 liblib 首次进入画布时的 4 步引导（浮坞「教程」格可以再次打开）。 */}
      <CanvasOnboardingGuide
        ready={active && canvasHydrated && !storyboardEnabled}
        open={guideOpen && !storyboardEnabled}
        onClose={() => {
          setGuideOpen(false);
        }}
      />{" "}
      <CanvasShortcutsDialog
        anchor={shortcutsAnchor}
        onClose={() => {
          setShortcutsAnchor(null);
        }}
      />
      {active && featuresOpen ? (
        <CanvasAllFeaturesDialog
          onClose={() => setFeaturesOpen(false)}
          getTargets={getFeatureSources}
          onChoose={openCanvasFeature}
          onChooseAsset={openCanvasFeatureAsset}
          onChooseFile={chooseFeatureFile}
          listAssets={listFeatureAssets}
          hasCloud={assetProvider != null}
        />
      ) : null}
      {libraryDialog?.kind === "style" ? <CanvasImageStyleMarket
        canvasAction={libraryDialog.replaceKey ? "replace" : "add"}
        selected={currentLibraryResource?.kind === "style" ? currentLibraryResource.style : undefined}
        onSelect={(style) => applyLibraryResource({ kind: "style", style })}
        onClose={() => setLibraryDialog(null)} /> : null}
      {libraryDialog?.kind === "effect" ? <VideoEffectTemplatePanel
        canvasAction={libraryDialog.replaceKey ? "replace" : "add"}
        selectedId={currentLibraryResource?.kind === "effect" ? currentLibraryResource.versionId : undefined}
        onSelect={(template) => applyLibraryResource({ kind: "effect", versionId: template.versionId })}
        onClose={() => setLibraryDialog(null)} /> : null}
      {characterStudio ? <CanvasCharacterStudio key={characterStudio.targetKey ?? "dock"} open={characterStudio.open}
        targetName={characterTarget?.type === "gen" ? (characterTarget.data.kind === "image" ? "图片节点" : "视频节点") : null}
        onClose={() => setCharacterStudio(null)}
        onSuspend={() => setCharacterStudio(previous => previous ? { ...previous, open: false } : previous)}
        getSources={(kind) => getFeatureSources(kind === "image" ? { kind: "image-hd" } : { kind: "audio", mode: "trim" })
          .map((source) => source.output?.finalPath ? { ...source, path: source.output.finalPath } : source)}
        listAssets={listFeatureAssets} hasCloud={assetProvider != null}
        onUse={useCharacterInCanvas} onDraft={stageCharacterDraft} /> : null}
      {active && featureMedia ? <CanvasFeatureMediaEditor session={featureMedia}
        providers={providerCatalog} onImageRegion={handleEditImageRegion}
        onOpeningLayerSplit={startOpeningLayerSplit}
        onVideoOpening={openVideoOpeningDraft} onClose={() => setFeatureMedia(null)} /> : null}
      {active && atlasTool ? <CanvasAtlasToolDialog session={atlasTool} providers={providerCatalog}
        onSubmit={async options => { await startAtlasCanvasTool(atlasTool, options); }} onClose={() => setAtlasTool(null)} /> : null}
      <CanvasContextMenu
        open={nodeContextMenu !== null}
        position={nodeContextMenu}
        items={canGroupSelectedNodes && nodeContextMenu && selectedCanvasNodeKeys.has(nodeContextMenu.nodeKey)
          ? [{ id: "group", label: "成组", shortcut: "Ctrl+G" }]
          : nodeContextMenuItems}
        onClose={() => {
          setNodeContextMenu(null);
        }}
        onSelect={handleNodeContextMenuAction}
      />
      <CanvasContextMenu
        open={groupContextMenu !== null}
        position={groupContextMenu}
        items={groupContextMenuItems}
        onClose={() => {
          setGroupContextMenu(null);
        }}
        onSelect={handleGroupContextMenuAction}
      />
      {settingsOpen ? (
        <Suspense
          fallback={
            <DeferredDialogFallback
              id="global-settings-dialog"
              label="全局设置"
              onClose={closeSettings}
            />
          }
        >
          <ProviderSettingsDialog
            open
            onClose={closeSettings}
            onCatalogChanged={refreshProviderCatalog}
            activeAssetProviderId={assetProvider?.id ?? null}
            onAssetProviderChanged={handleAssetProviderChanged}
            onAssetLibraryLoaded={handleAssetLibraryLoaded}
            onAssetLibraryLoading={handleAssetLibraryLoading}
            onAssetLibraryLoadFailed={handleAssetLibraryLoadFailed}
          />
        </Suspense>
      ) : null}
      {historyOpen ? (
        <Suspense
          fallback={
            <DeferredDialogFallback
              id="generation-history-dialog"
              label="历史记录"
              onClose={closeHistory}
            />
          }
        >
          <HistoryDialog
            open
            onClose={closeHistory}
            canvasId={canvasId}
            initialTaskId={historyInitialTaskId}
            onRegenerateGeneration={regenerateGenerationFromHistory}
            onRestoreImage={restoreImageFromHistory}
            onAddResource={historyResourceAnchor ? addQuickAddHistoryResult : undefined}
            onPromoteSeedanceDraft={promoteSeedanceDraftFromHistory}
          />
        </Suspense>
      ) : null}
      {previewAsset ? (
        <Suspense
          fallback={
            <DeferredDialogFallback
              id="asset-source-dialog"
              label="媒体预览"
              onClose={() => setPreviewAsset(null)}
            />
          }
        >
          <AssetSourceDialog
            asset={previewAsset}
            onClose={() => setPreviewAsset(null)}
            onDelete={
              previewAsset.source === "cloud" && previewAsset.providerConnectionId
                ? () => handleDeleteAsset(previewAsset)
                : previewAsset.source === "local" && previewAsset.id.startsWith("local-b64-")
                  ? () => void handleDeleteLocalAssets([previewAsset])
                  : null
            }
            localGroups={
              previewAsset.source === "local" && previewAsset.id.startsWith("local-b64-")
                ? localAssetGroups
                : undefined
            }
            onMoveToGroup={
              previewAsset.source === "local" && previewAsset.id.startsWith("local-b64-")
                ? (groupId) => {
                    handleMoveLocalAssets([previewAsset], groupId);
                    // 弹窗保持打开：立即反映新分组，列表由处理器后台重查。
                    setPreviewAsset({ ...previewAsset, groupId });
                  }
                : null
            }
            onRename={
              previewAsset.source === "cloud" &&
              previewAsset.providerConnectionId &&
              renamingAssetId == null
                ? (name) => handleRenameAsset(previewAsset, name)
                : null
            }
          />
        </Suspense>
      ) : null}
      {realPersonDialogOpen && assetProvider ? (
        <Suspense
          fallback={
            <DeferredDialogFallback
              id="real-person-asset-dialog"
              label="明星真人素材"
              onClose={() => setRealPersonDialogOpen(false)}
            />
          }
        >
          <RealPersonAssetDialog
            providerConnectionId={assetProvider.id}
            providerDisplayName={assetProvider.displayName}
            onClose={() => setRealPersonDialogOpen(false)}
            onUploadToGroup={handleImportLocalAssets}
          />
        </Suspense>
      ) : null}
      {newGroupDialogOpen && assetProvider ? (
        <Suspense
          fallback={
            <DeferredDialogFallback
              id="asset-group-create-dialog"
              label="新建素材分组"
              onClose={() => setNewGroupDialogOpen(false)}
            />
          }
        >
          <AssetGroupCreateDialog
            providerDisplayName={assetProvider.displayName}
            busy={creatingGroup}
            onClose={() => setNewGroupDialogOpen(false)}
            onCreate={(name) => handleCreateAssetGroup(assetProvider.id, name)}
          />
        </Suspense>
      ) : null}
      {newLocalGroupDialogOpen ? (
        <Suspense
          fallback={
            <DeferredDialogFallback
              id="local-asset-group-create-dialog"
              label="新建本地素材分组"
              onClose={() => setNewLocalGroupDialogOpen(false)}
            />
          }
        >
          <AssetGroupCreateDialog
            scope="local"
            busy={creatingLocalGroup}
            onClose={() => setNewLocalGroupDialogOpen(false)}
            onCreate={handleCreateLocalAssetGroup}
          />
        </Suspense>
      ) : null}
      {previewImageNode ? <ImageLightbox key={previewImageNode.key}
        items={(previewImageNode.imageGeneration?.results ?? []).flatMap(result => {
          const src = result.finalPath ? toMediaSrc(result.finalPath) : result.previewSrc;
          return src ? [{ id: result.resultKey, src, name: previewImageNode.name ?? "生成图片" }] : [];
        })}
        initialItemId={previewImageNode.imageGeneration?.selectedResultKey}
        onClose={() => setPreviewOutputNodeKey(null)} /> : null}
      {previewOutputNode ? (
        <CanvasOutputLightbox
          node={previewOutputNode}
          onClose={() => setPreviewOutputNodeKey(null)}
        />
      ) : null}
      {previewAssetNode ? (
        <CanvasAssetLightbox node={previewAssetNode} onClose={() => setPreviewAssetNodeKey(null)} />
      ) : null}
      {active && videoPreparation ? (
        <Suspense
          fallback={
            <DeferredDialogFallback
              id="video-preparation"
              label="视频准备"
              onClose={() => setVideoPreparation(null)}
            />
          }
        >
          <VideoPreparationDialog
            source={videoPreparation}
            onClose={() => setVideoPreparation(null)}
            onUseOutput={(output, job) => {
              const outputKey = usePreparedVideoOutput(output, job);
              if (videoPreparation.tool === "remake" && job.operation === "clip_video" &&
                  output.kind === "video" && job.source.canvasNodeKey === videoPreparation.target.canvasNodeKey &&
                  job.endSeconds - job.startSeconds >= 4 && job.endSeconds - job.startSeconds <= 30) {
                if (openCanvasFeature({ kind: "video-draft", mode: "edit",
                  prompt: "重拍该片段，保留镜头的构图、动作和节奏。可补充想改变的内容。" }, outputKey, "片段重拍")) {
                  setVideoPreparation(null);
                }
              }
            }}
          />
        </Suspense>
      ) : null}
      {active && videoLocalEdit ? (
        <Suspense
          fallback={
            <DeferredDialogFallback
              id="video-local-edit"
              label="视频局部编辑"
              onClose={() => setVideoLocalEdit(null)}
            />
          }
        >
          <VideoLocalEditDialog
            source={videoLocalEdit.source}
            candidates={mentionCandidatesFor(videoLocalEdit.nodeKey)}
            canUploadToLibrary={assetProvider != null}
            resolveFrame={resolveVideoLocalEditFrame}
            onClose={() => setVideoLocalEdit(null)}
            onApply={applyVideoLocalEdit}
          />
        </Suspense>
      ) : null}
      <dialog
        ref={clearCanvasDialogRef}
        className="confirm-dialog"
        aria-labelledby="clear-canvas-dialog-title"
        aria-describedby="clear-canvas-dialog-desc"
      >
        <form
          method="dialog"
          className="confirm-dialog__form"
          onSubmit={(event) => {
            // 表单提交（按 Enter 或点「确认清空」）时阻止默认关闭，由 confirmClearCanvas
            // 显式 close()，确保先清空再关闭（避免 close 触发后 setState 在已卸载 dialog 上）。
            event.preventDefault();
          }}
        >
          <header className="confirm-dialog__header">
            <span className="confirm-dialog__badge" aria-hidden="true">
              <Icon name="warning" size="xl" />
            </span>
            <div>
              <p className="confirm-dialog__eyebrow">危险操作 · 不可撤销</p>
              <h2 id="clear-canvas-dialog-title" className="confirm-dialog__title">
                确认清空画布？
              </h2>
            </div>
          </header>
          <div className="confirm-dialog__body">
            <p id="clear-canvas-dialog-desc" className="confirm-dialog__desc">
              将移除画布上所有节点与连线，任务历史会保留。此操作不可撤销。
            </p>
            <ul className="confirm-dialog__facts">
              <li className="confirm-dialog__fact confirm-dialog__fact--removed">
                <span className="confirm-dialog__fact-icon" aria-hidden="true">
                  <Icon name="trash-simple" size="sm" />
                </span>
                <span className="confirm-dialog__fact-label">画布节点与连线</span>
                <span className="confirm-dialog__fact-state">将被移除</span>
              </li>
              <li className="confirm-dialog__fact confirm-dialog__fact--kept">
                <span className="confirm-dialog__fact-icon" aria-hidden="true">
                  <Icon name="check-circle" size="sm" />
                </span>
                <span className="confirm-dialog__fact-label">任务历史</span>
                <span className="confirm-dialog__fact-state">保留 · 可复现审计</span>
              </li>
            </ul>
          </div>
          <div className="confirm-dialog__actions">
            <button type="button" className="confirm-dialog__btn" onClick={closeClearCanvasDialog}>
              取消
            </button>
            <button
              type="button"
              className="confirm-dialog__btn confirm-dialog__btn--danger"
              onClick={confirmClearCanvas}
            >
              <Icon name="trash-simple" aria-hidden="true" size="sm" />
              确认清空
            </button>
          </div>
        </form>
      </dialog>
    </main>
  );
}
