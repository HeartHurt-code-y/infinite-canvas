import { ArrowClockwise } from "@phosphor-icons/react/ArrowClockwise";
import { ArrowCounterClockwise } from "@phosphor-icons/react/ArrowCounterClockwise";
import { CaretRight } from "@phosphor-icons/react/CaretRight";
import { CheckCircle } from "@phosphor-icons/react/CheckCircle";
import { CircleNotch } from "@phosphor-icons/react/CircleNotch";
import { Clock } from "@phosphor-icons/react/Clock";
import { CornersOut } from "@phosphor-icons/react/CornersOut";
import { GearSix } from "@phosphor-icons/react/GearSix";
import { MagnifyingGlass } from "@phosphor-icons/react/MagnifyingGlass";
import { Minus } from "@phosphor-icons/react/Minus";
import { Plus } from "@phosphor-icons/react/Plus";
import { Sparkle } from "@phosphor-icons/react/Sparkle";
import { StackSimple } from "@phosphor-icons/react/StackSimple";
import { TrashSimple } from "@phosphor-icons/react/TrashSimple";
import { UploadSimple } from "@phosphor-icons/react/UploadSimple";
import { UserFocus } from "@phosphor-icons/react/UserFocus";
import { Warning } from "@phosphor-icons/react/Warning";
import { WarningCircle } from "@phosphor-icons/react/WarningCircle";
import { X } from "@phosphor-icons/react/X";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type OnNodeDrag,
  type ReactFlowInstance,
  type ReactFlowProps,
  type Viewport,
  useNodesState,
} from "@xyflow/react";
import {
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { toast } from "sonner";
import { useShallow } from "zustand/react/shallow";
import {
  assetLibraryClient,
  canvasDocumentClient,
  formatRawBackendError,
  frontendLog,
  generationClient,
  inferMediaKindFromName,
  isDesktopRuntime,
  loadProviderCatalog,
  pickLocalMediaFiles,
  pickPromptMultimodalFiles,
  promptMultimodalDefinitionForPath,
  promptNodeClient,
  subscribeGenerationEvents,
  subscribeStagingEvents,
  toMediaSrc,
  tosStagingClient,
  videoComposerClient,
  videoDownloaderClient,
  videoFrameExtractionClient,
  type CloudAsset,
  type AssetGroupRecord,
  type GenerationOperation,
  type GenerationResultRecord,
  type GenerationTaskSummary,
  type LocalAssetRecord,
  type PromptOptimizationContextEntry,
  type PromptMultimodalInput,
  type PromptVisionImageInput,
  type ProviderCatalogEntry,
  type ProviderConnection,
  type RealPersonGroup,
  type StagingJobRecord,
  type VideoDownloadJobRecord,
  type VideoDownloaderEngineStatus,
  type VideoFrameExtractionJobRecord,
} from "../../lib/backend";
import {
  generationParameters,
  modelAllowsMediaOnlyPrompt,
  modelParameterCapabilities,
} from "../../lib/modelCapabilities";
import type {
  PromptContentConnection,
  PromptContentEditorSession,
  PromptContentIssue,
} from "../../lib/promptContent";
import { createPromptContentModule } from "../../lib/promptContent";
import {
  composeVideosInOrder,
  composedVideoFileName,
  normalizeVideoInputOrder,
  preferredVideoCompositionFormat,
} from "../../lib/videoComposer";
import {
  useCanvas,
  useCanvasCommands,
  useCanvasHistoryCounts,
  type CanvasDocument,
  type CanvasDocumentV2,
  type CanvasStoreNodeChange,
} from "../canvas/canvasStore";
import { buildInputOrderByEdge } from "../canvas/connectionIndex";

import { CanvasFlowEdgeView, CanvasFlowNodeView } from "./CanvasFlowViews";
import {
  AssetFlow,
  AssetGroupCreateDialog,
  AssetPanelError,
  RealPersonAssetDialog,
  AssetSourceDialog,
  AssetUploadRow,
  RepositoryCard,
} from "./AssetLibraryViews";
import { DeferredDialogFallback, HistoryDialog, ProviderSettingsDialog } from "./deferredDialogs";
import { preloadHistoryDialog, preloadProviderSettingsDialog } from "./deferredDialogLoaders";
import { revealDesktopItem, saveMarkdownDocumentToDesktop } from "./desktopActions";
import {
  CanvasDocumentSkillNode,
  CanvasPromptNode,
  CanvasViralRemixNode,
} from "./DocumentNodeViews";
import {
  CanvasAssetNode,
  CanvasGenNode,
  CanvasOutputLightbox,
  CanvasOutputNode,
  CanvasResultNode,
  CanvasVideoComposerNode,
  CanvasVideoDownloaderNode,
  CanvasVideoFrameExtractorNode,
} from "./MediaNodeViews";
import { AssetKindIcon } from "./PromptNodeViews";
import { KnowledgeVideoWorkflowNode } from "./KnowledgeVideoWorkflowNode";
import {
  workflowCanvasInputs,
  workflowCanvasInputsFromDocument,
  withCanvasWorkflowMaterials,
} from "./workflowCanvasInputs";
import { formatWorkflowError } from "../../lib/workflowErrors";
import { WorkflowRepository } from "./WorkflowRepository";
import { createRecordedWorkflowRunner } from "./workflowHistoryExecution";
import { workflowHistoryClient, type WorkflowHistoryRecord } from "../../lib/workflowHistory";
import { restoreWorkflowHistoryNode } from "./workflowHistoryRestore";
import {
  MAX_WORKFLOW_MATERIALS,
  MAX_WORKFLOW_MATERIAL_BYTES,
  workflowMaterialPathKey,
  workflowMaterialQuota,
} from "./workflowMaterials";
import {
  createKnowledgeVideoDirectorWorkflow,
  createAiFilmWorkflow,
  createComicDramaWorkflow,
  createCommerceWorkflow,
  createRemotionWorkflow,
  createXhsCoverWorkflow,
  createReverseVideoWorkflow,
} from "./workflowTemplates";
import { aiFilmDeliveryMarkdown } from "./aiFilmWorkflowModel";
import { comicDramaDeliveryMarkdown } from "./comicDramaWorkflowModel";
import { commerceDeliveryMarkdown } from "./commerceWorkflowModel";
import { remotionDeliveryMarkdown } from "./remotionWorkflowModel";
import { XHS_COVER_MAX_REFERENCE_BYTES, xhsCoverDeliveryMarkdown } from "./xhsCoverWorkflowModel";
import type {
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
  ConnectedAssetInput,
  ConnectedScreenplayInput,
  GenNodeData,
  GenerationMediaInput,
  ImageNodeConfig,
  InheritedAssetInput,
  KnowledgeVideoWorkflowConfig,
  KnowledgeVideoWorkflowNodeData,
  KnowledgeVideoWorkflowRunState,
  MentionCandidate,
  MobilePanel,
  NodeModelSelections,
  OutputLayerInfo,
  OutputNodeData,
  PromptNodeConfig,
  RetryInfo,
  ScreenplayNodeConfig,
  ScreenplayNodeData,
  StoryboardNodeData,
  VideoComposerInput,
  VideoComposerNodeConfig,
  VideoComposerNodeData,
  VideoComposerRunState,
  VideoDownloaderNodeConfig,
  VideoDownloaderNodeData,
  VideoDownloaderRunState,
  VideoFrameExtractorNodeConfig,
  VideoFrameExtractorNodeData,
  VideoFrameExtractorRunState,
  FrameExtractorVideoInput,
  VideoNodeConfig,
  VideoUrlMediaInput,
  ViralRemixNodeConfig,
  ViralRemixNodeData,
  ViralRemixVideoInput,
} from "./workspaceModel";
import {
  ASSETS,
  ASSET_KIND_LABELS,
  ASSET_NODE_HEIGHT,
  ASSET_NODE_WIDTH,
  ASSET_RENDER_BATCH_SIZE,
  CANVAS_CONNECTION_RADIUS,
  CANVAS_DOCUMENT_TITLE,
  CANVAS_ID,
  CANVAS_SAVE_DEBOUNCE_MS,
  DEFAULT_NODE_MODEL_SELECTIONS,
  DEFAULT_ZOOM,
  DEMO_PROVIDER_CATALOG,
  DOCUMENT_SKILL_NODE_COPY,
  DOWNLOAD_POLL_INTERVAL_MS,
  EMPTY_GENERATION_TASKS,
  GENERATION_TASKS_POLL_INTERVAL_MS,
  GENERATION_TASKS_QUERY_KEY,
  GPT_IMAGE_MAX_GENERATION_COUNT,
  MAX_GENERATION_COUNT,
  MAX_ZOOM,
  RESULT_NODE_HEIGHT,
  RESULT_NODE_WIDTH,
  SCREENPLAY_NODE_COARSE_HEIGHT,
  SCREENPLAY_NODE_HEIGHT,
  SCREENPLAY_NODE_WIDTH,
  UPLOAD_POLL_INTERVAL_MS,
  UPLOAD_STALL_HINT_MS,
  VIDEO_COMPOSER_NODE_HEIGHT,
  VIDEO_COMPOSER_NODE_WIDTH,
  VIDEO_DOWNLOADER_NODE_HEIGHT,
  VIDEO_DOWNLOADER_NODE_WIDTH,
  VIDEO_FRAME_EXTRACTOR_NODE_HEIGHT,
  VIDEO_FRAME_EXTRACTOR_NODE_WIDTH,
  VIRAL_REMIX_NODE_COARSE_HEIGHT,
  VIRAL_REMIX_NODE_HEIGHT,
  VIRAL_REMIX_NODE_WIDTH,
  KNOWLEDGE_VIDEO_WORKFLOW_NODE_COARSE_HEIGHT,
  KNOWLEDGE_VIDEO_WORKFLOW_NODE_HEIGHT,
  KNOWLEDGE_VIDEO_WORKFLOW_NODE_WIDTH,
  ZOOM_STEP,
  assetGenerationInput,
  assetNodeDimensions,
  assetNodeKey,
  assetNodeReferenceTarget,
  cloudAssetToItem,
  createImageNodeConfig,
  createPromptNodeConfig,
  createScreenplayNodeConfig,
  createVideoNodeConfig,
  createViralRemixNodeConfig,
  documentSkillRoleLabel,
  fileNameFromPath,
  formatTaskRawResponse,
  genNodeDimensions,
  genNodeKey,
  generationInputMentionCandidate,
  getNodeDescriptor,
  inheritedVideoAssetInputs,
  isRunningTaskStatus,
  textResultFromSource,
  isTerminalAssetUpload,
  isTerminalTaskStatus,
  isTextGenerationModel,
  localAssetToItem,
  markdownDocumentExportName,
  materializeCompositionInputs,
  measuredFor,
  minimumCanvasZoom,
  modelDisplayNameForTask,
  nearestAvailableNodePosition,
  nextOutputSlot,
  nextVideoComposerOutputSlot,
  nextVideoDownloaderOutputSlot,
  outputGenerationInput,
  outputNodeDimensions,
  outputNodeKey,
  outputNodeReferenceTarget,
  persistActiveAssetProviderId,
  promptConversationRoleLabel,
  promptMessageId,
  readActiveAssetProviderId,
  reconcileNodeModelSelections,
  reconcileTextModelSelection,
  resolveGenerationSelection,
  resolvePendingDocumentNodeConfig,
  resolvePendingGenerationNodeConfig,
  resolvePendingKnowledgeVideoWorkflowConfig,
  saveComposedVideoBlob,
  screenplayMessageId,
  screenplayMaterialId,
  screenplayNodeKey,
  storyboardNodeKey,
  usesCoarsePointer,
  videoComposerNodeKey,
  videoDownloaderNodeKey,
  frameExtractorNodeKey,
  nextFrameExtractorOutputSlot,
  viralRemixNodeKey,
} from "./workspaceModel";

const CANVAS_FLOW_NODE_TYPES = { canvas: CanvasFlowNodeView };
const CANVAS_FLOW_EDGE_TYPES = { canvas: CanvasFlowEdgeView };

/**
 * React Flow 的受控节点层：拖动帧只更新这个窄组件，避免让 WorkspaceApp 与画布文档
 * 每个 pointer move 都重渲染；上游节点内容变化时仍以业务状态为准同步进来。
 */
function LiveCanvasFlow({
  nodes: upstreamNodes = [],
  onNodesChange,
  ...props
}: ReactFlowProps<CanvasFlowNode, CanvasFlowEdge>) {
  const [liveNodes, setLiveNodes, applyLiveNodeChanges] =
    useNodesState<CanvasFlowNode>(upstreamNodes);

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
      applyLiveNodeChanges(changes);
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

const MAX_SCREENPLAY_MATERIALS = 8;
// Gemini 的内联媒体请求上限为 20 MB；Base64 约膨胀 1/3，因此原始文件合计
// 控制在 14 MiB，给完整技能提示词与 JSON 包装预留空间。
const MAX_SCREENPLAY_MATERIAL_BYTES = 14 * 1024 * 1024;
const MAX_SCREENPLAY_MATERIAL_TOTAL_BYTES = 14 * 1024 * 1024;

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

function screenplayConversationUserMessage(
  userPrompt: string,
  materials: ScreenplayNodeConfig["materials"],
): string {
  if (!materials?.length) return userPrompt;
  return `${userPrompt}\n\n> 参考素材：${materials.map((material) => material.displayName).join("、")}`;
}

export function WorkspaceApp() {
  const [assetLibrarySource, setAssetLibrarySource] = useState<AssetLibrarySource>("cloud");
  const [assetKind, setAssetKind] = useState<AssetKind>("image");
  const [assetSearch, setAssetSearch] = useState("");
  const [assetRenderPage, setAssetRenderPage] = useState<{
    readonly key: string;
    readonly limit: number;
  }>({ key: "", limit: ASSET_RENDER_BATCH_SIZE });
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>(null);
  const [workflowRepositoryExpanded, setWorkflowRepositoryExpanded] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyInitialTab, setHistoryInitialTab] = useState<"generation" | "workflow">(
    "generation",
  );
  const [historyInitialWorkflowId, setHistoryInitialWorkflowId] = useState<string | null>(null);
  const [realPersonDialogOpen, setRealPersonDialogOpen] = useState(false);
  const {
    selectedNodeKey,
    selectedEdgeId,
    zoom,
    pan,
    assetNodes,
    genNodes,
    screenplayNodes,
    storyboardNodes,
    knowledgeVideoWorkflowNodes,
    viralRemixNodes,
    videoComposerNodes,
    videoDownloaderNodes,
    frameExtractorNodes,
    resultNodes,
    outputNodes,
    assetNodeByKey,
    outputNodeByKey,
    genNodeByKey,
    screenplayNodeByKey,
    storyboardNodeByKey,
    videoComposerNodeByKey,
    videoDownloaderNodeByKey,
    frameExtractorNodeByKey,
    viralRemixNodeByKey,
    assetEdges,
    canvasEdgeIndex,
    hasCanvasNodes,
  } = useCanvas(
    useShallow((state) => ({
      selectedNodeKey: state.selection.nodeKey,
      selectedEdgeId: state.selection.edgeId,
      zoom: state.view.zoom,
      pan: state.view.pan,
      assetNodes: state.nodes.asset,
      genNodes: state.nodes.gen,
      screenplayNodes: state.nodes.screenplay,
      storyboardNodes: state.nodes.storyboard,
      knowledgeVideoWorkflowNodes: state.nodes.knowledgeVideoWorkflow,
      viralRemixNodes: state.nodes.viralRemix,
      videoComposerNodes: state.nodes.videoComposer,
      videoDownloaderNodes: state.nodes.videoDownloader,
      frameExtractorNodes: state.nodes.frameExtractor,
      resultNodes: state.nodes.result,
      outputNodes: state.nodes.output,
      assetNodeByKey: state.nodeByKey.asset,
      outputNodeByKey: state.nodeByKey.output,
      genNodeByKey: state.nodeByKey.gen,
      screenplayNodeByKey: state.nodeByKey.screenplay,
      storyboardNodeByKey: state.nodeByKey.storyboard,
      videoComposerNodeByKey: state.nodeByKey.videoComposer,
      videoDownloaderNodeByKey: state.nodeByKey.videoDownloader,
      frameExtractorNodeByKey: state.nodeByKey.frameExtractor,
      viralRemixNodeByKey: state.nodeByKey.viralRemix,
      assetEdges: state.graph.edges,
      canvasEdgeIndex: state.graph,
      hasCanvasNodes: state.hasNodes,
    })),
  );
  const {
    insertSubgraph,
    addNode,
    addOutput,
    patchNode,
    patchNodes,
    removeNode: removeCanvasNode,
    connect: connectCanvasStateNodes,
    disconnect: disconnectCanvasEdge,
    applyNodeChanges,
    setView,
    selectNode,
    selectEdge,
    clear: clearCanvasState,
    snapshotV2,
    restoreDocument,
    undo,
    redo,
  } = useCanvasCommands();
  // 撤销/重做按钮的可用态；历史栈变化频率低，独立订阅避免额外渲染放大。
  const { pastCount, futureCount } = useCanvasHistoryCounts();
  const genTopologyByKey = genNodeByKey;
  const workflowInputsByNode = useMemo(
    () =>
      new Map(
        knowledgeVideoWorkflowNodes.map((node) => [
          node.key,
          workflowCanvasInputs(
            canvasEdgeIndex.byTarget.get(node.key) ?? [],
            assetNodeByKey,
            outputNodeByKey,
          ),
        ]),
      ),
    [knowledgeVideoWorkflowNodes, canvasEdgeIndex, assetNodeByKey, outputNodeByKey],
  );
  const workflowInputsRef = useRef(workflowInputsByNode);
  useEffect(() => {
    workflowInputsRef.current = workflowInputsByNode;
  }, [workflowInputsByNode]);
  const screenplayInputByStoryboard = useMemo(() => {
    const inputs = new Map<string, ConnectedScreenplayInput>();
    for (const edge of assetEdges) {
      const source = screenplayNodeByKey.get(edge.fromKey);
      if (source == null || !storyboardNodeByKey.has(edge.toKey)) continue;
      inputs.set(edge.toKey, {
        key: source.key,
        name: connectedScreenplayName(source),
        document: source.config.currentDocument,
        edgeId: edge.id,
      });
    }
    return inputs;
  }, [assetEdges, screenplayNodeByKey, storyboardNodeByKey]);
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
  const settingsAssetRequestRef = useRef<{
    readonly providerConnectionId: string;
    readonly requestId: number;
  } | null>(null);
  const [activeAssetProviderId, setActiveAssetProviderId] = useState(readActiveAssetProviderId);
  const [nodeModelSelections, setNodeModelSelections] = useState<NodeModelSelections>(
    DEFAULT_NODE_MODEL_SELECTIONS,
  );
  // 正在提交生成任务的节点 key；不同节点可以同时提交。
  const [startingNodeKeys, setStartingNodeKeys] = useState<ReadonlySet<string>>(() => new Set());
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
  const [taskResults, setTaskResults] = useState<Record<string, readonly GenerationResultRecord[]>>(
    {},
  );
  const [retryInfoByTask, setRetryInfoByTask] = useState<Record<string, RetryInfo>>({});
  const [rawResponses, setRawResponses] = useState<Record<string, string>>({});
  const [cloudAssets, setCloudAssets] = useState<readonly CloudAsset[]>([]);
  // 云端素材库分组：按令牌作用域隔离，所有供应商/平台共用同一套接口。
  // 分组只展示 `name`（上游已去除 user-{uid}-token-{tid}- 前缀）。
  const [assetGroups, setAssetGroups] = useState<readonly AssetGroupRecord[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [groupsError, setGroupsError] = useState<string | null>(null);
  const [selectedAssetGroupId, setSelectedAssetGroupId] = useState<number | null>(null);
  // refreshCloudAssets 是稳定回调（依赖为空），通过 ref 读取当前分组避免重建。
  const selectedAssetGroupIdRef = useRef<number | null>(null);
  const [newGroupDialogOpen, setNewGroupDialogOpen] = useState(false);
  const [creatingGroup, setCreatingGroup] = useState(false);
  // 正在改名的云端素材 ID（详情弹窗显示保存中状态，并阻止重复提交）。
  const [renamingAssetId, setRenamingAssetId] = useState<string | null>(null);
  const [assetsLoading, setAssetsLoading] = useState(isDesktopRuntime());
  const [assetsError, setAssetsError] = useState<string | null>(null);
  // 上一次云端素材列表拉取是否失败。assetsError 同时承载列表错误与上传错误，
  // 但空状态的"素材库不可用"提示只应针对列表拉取失败显示。
  const [libraryError, setLibraryError] = useState(false);
  const [localAssets, setLocalAssets] = useState<readonly LocalAssetRecord[]>([]);
  const [localAssetsLoading, setLocalAssetsLoading] = useState(false);
  const [localAssetsError, setLocalAssetsError] = useState<string | null>(null);
  const [localLibraryError, setLocalLibraryError] = useState(false);
  const [assetUploads, setAssetUploads] = useState<readonly AssetUploadEntry[]>([]);
  const [videoComposerRuns, setVideoComposerRuns] = useState<
    Readonly<Record<string, VideoComposerRunState>>
  >({});
  const videoComposerAbortControllersRef = useRef<Map<string, AbortController>>(new Map());
  // 网络爆款视频下载节点：节点随画布持久化，下载任务与引擎状态只在会话内。
  const [videoDownloaderRuns, setVideoDownloaderRuns] = useState<
    Readonly<Record<string, VideoDownloaderRunState>>
  >({});
  // 下载启动时的节点快照：产物卡片落点按启动时节点位置计算（轮询期间用户
  // 拖动节点不改变落点，与迁移前 setTimeout 轮询的语义一致）。
  const videoDownloaderStartNodesRef = useRef<Map<string, VideoDownloaderNodeData>>(new Map());
  const [downloaderEngineStatus, setDownloaderEngineStatus] =
    useState<VideoDownloaderEngineStatus | null>(null);
  const downloaderEngineLoadedRef = useRef(false);
  const [downloaderEngineBusy, setDownloaderEngineBusy] = useState(false);
  // 视频抽帧节点：抽帧任务与会话内运行状态；产物自动落 origin=frame_extract 图片卡片。
  const [frameExtractorRuns, setFrameExtractorRuns] = useState<
    Readonly<Record<string, VideoFrameExtractorRunState>>
  >({});
  const frameExtractorStartNodesRef = useRef<Map<string, VideoFrameExtractorNodeData>>(new Map());
  const [knowledgeVideoWorkflowRuns, setKnowledgeVideoWorkflowRuns] = useState<
    Readonly<Record<string, KnowledgeVideoWorkflowRunState>>
  >({});
  const knowledgeVideoWorkflowAbortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const recordedWorkflowRunner = useMemo(() => createRecordedWorkflowRunner(), []);
  const activeWorkflowHistoryIdsRef = useRef(new Set<string>());
  const [activeWorkflowHistoryIds, setActiveWorkflowHistoryIds] = useState<readonly string[]>([]);
  const workflowHistoryRecoveryRef = useRef<Promise<number> | null>(null);
  const recoverWorkflowHistory = useCallback(() => {
    if (!workflowHistoryRecoveryRef.current) {
      const pending = workflowHistoryClient.recover();
      workflowHistoryRecoveryRef.current = pending;
      void pending.catch(() => {
        if (workflowHistoryRecoveryRef.current === pending)
          workflowHistoryRecoveryRef.current = null;
      });
    }
    return workflowHistoryRecoveryRef.current;
  }, []);
  useEffect(() => {
    if (!isDesktopRuntime()) return;
    void recoverWorkflowHistory().catch((error: unknown) => {
      toast.error("工作流历史恢复失败", { description: formatWorkflowError(error) });
    });
  }, [recoverWorkflowHistory]);
  // 生成节点改为内容自适应高度后，记录 DOM 实际尺寸供避让、命中与 SVG 边界使用。
  const [genNodeSizes, setGenNodeSizes] = useState<Record<string, CanvasNodeDimensions>>({});
  const [previewOutputNodeKey, setPreviewOutputNodeKey] = useState<string | null>(null);
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
  const occupiedNodeRects = useMemo<readonly CanvasNodeRect[]>(
    () => [
      ...assetNodes.map((node) => ({
        x: node.x,
        y: node.y,
        ...assetNodeDimensions(node),
      })),
      ...genNodes.map((node) => ({ ...node, ...genNodeDimensionsFor(node) })),
      ...screenplayNodes.map((node) => ({
        x: node.x,
        y: node.y,
        ...(genNodeSizes[node.key] ?? {
          width: SCREENPLAY_NODE_WIDTH,
          height: usesCoarsePointer() ? SCREENPLAY_NODE_COARSE_HEIGHT : SCREENPLAY_NODE_HEIGHT,
        }),
      })),
      ...storyboardNodes.map((node) => ({
        x: node.x,
        y: node.y,
        ...(genNodeSizes[node.key] ?? {
          width: SCREENPLAY_NODE_WIDTH,
          height: usesCoarsePointer() ? SCREENPLAY_NODE_COARSE_HEIGHT : SCREENPLAY_NODE_HEIGHT,
        }),
      })),
      ...knowledgeVideoWorkflowNodes.map((node) => ({
        x: node.x,
        y: node.y,
        ...(genNodeSizes[node.key] ?? {
          width: KNOWLEDGE_VIDEO_WORKFLOW_NODE_WIDTH,
          height: usesCoarsePointer()
            ? KNOWLEDGE_VIDEO_WORKFLOW_NODE_COARSE_HEIGHT
            : KNOWLEDGE_VIDEO_WORKFLOW_NODE_HEIGHT,
        }),
      })),
      ...viralRemixNodes.map((node) => ({
        x: node.x,
        y: node.y,
        ...(genNodeSizes[node.key] ?? {
          width: VIRAL_REMIX_NODE_WIDTH,
          height: usesCoarsePointer() ? VIRAL_REMIX_NODE_COARSE_HEIGHT : VIRAL_REMIX_NODE_HEIGHT,
        }),
      })),
      ...videoComposerNodes.map((node) => ({
        x: node.x,
        y: node.y,
        width: VIDEO_COMPOSER_NODE_WIDTH,
        height: VIDEO_COMPOSER_NODE_HEIGHT,
      })),
      ...videoDownloaderNodes.map((node) => ({
        x: node.x,
        y: node.y,
        width: VIDEO_DOWNLOADER_NODE_WIDTH,
        height: VIDEO_DOWNLOADER_NODE_HEIGHT,
      })),
      ...frameExtractorNodes.map((node) => ({
        x: node.x,
        y: node.y,
        width: VIDEO_FRAME_EXTRACTOR_NODE_WIDTH,
        height: VIDEO_FRAME_EXTRACTOR_NODE_HEIGHT,
      })),
      ...resultNodes.map((node) => ({
        x: node.x,
        y: node.y,
        width: RESULT_NODE_WIDTH,
        height: RESULT_NODE_HEIGHT,
      })),
      ...outputNodes.map((node) => ({
        x: node.x,
        y: node.y,
        ...outputNodeDimensions(node),
      })),
    ],
    [
      assetNodes,
      genNodeDimensionsFor,
      genNodeSizes,
      genNodes,
      outputNodes,
      resultNodes,
      screenplayNodes,
      storyboardNodes,
      knowledgeVideoWorkflowNodes,
      viralRemixNodes,
      videoComposerNodes,
      videoDownloaderNodes,
      frameExtractorNodes,
    ],
  );
  const mediaInputTargetKeysRef = useRef<ReadonlySet<string>>(new Set());
  // 提示内容 module 持有 canonical documents 与节点级 handle；视口裁剪不会丢内容。
  const [promptContents] = useState(createPromptContentModule);
  // 追踪上游原始输出版本；结构化引用的显示文字和用户手改内容都不用于判定重新导入。
  const importedPromptSourcesRef = useRef(
    new Map<string, { edgeId: string; sourceKey: string; text: string }>(),
  );
  const canvasViewportRef = useRef<HTMLDivElement | null>(null);
  // React Flow 实例引用：命令式视口操作（恢复视图/锚点缩放/坐标换算）的唯一入口。
  const flowInstanceRef = useRef<ReactFlowInstance<CanvasFlowNode, CanvasFlowEdge> | null>(null);
  const mobilePanelTriggerRef = useRef<HTMLButtonElement | null>(null);
  const settingsTriggerRef = useRef<HTMLButtonElement | null>(null);
  // 「清空画布」确认弹窗的原生 <dialog> 引用——HTMLDialogElement 自带
  // modal 语义（ESC 关闭、focus trap、::backdrop 遮罩），无需自建 dialog 框架。
  const clearCanvasDialogRef = useRef<HTMLDialogElement | null>(null);

  const clearCanvas = useCallback(() => {
    // 清空画布上的节点与连线，同时重置与画布交互相关的临时状态；
    // 不清空任务历史（生成节点删除/本地结果文件缺失都不能清理历史，详见 MVP 契约）。
    for (const controller of videoComposerAbortControllersRef.current.values()) controller.abort();
    videoComposerAbortControllersRef.current.clear();
    for (const controller of knowledgeVideoWorkflowAbortControllersRef.current.values()) {
      controller.abort();
    }
    knowledgeVideoWorkflowAbortControllersRef.current.clear();
    // 先撤销拼接产物仅会话内有效的 blob 预览，再原子清空画布持久状态。
    for (const node of outputNodes) {
      if (node.origin === "composition" && node.previewSrc?.startsWith("blob:")) {
        URL.revokeObjectURL(node.previewSrc);
      }
    }
    clearCanvasState();
    setVideoComposerRuns({});
    setVideoDownloaderRuns({});
    setFrameExtractorRuns({});
    setKnowledgeVideoWorkflowRuns({});
    setGenNodeSizes({});
    setPreviewOutputNodeKey(null);
  }, [
    clearCanvasState,
    outputNodes,
    setVideoComposerRuns,
    setVideoDownloaderRuns,
    setFrameExtractorRuns,
    setKnowledgeVideoWorkflowRuns,
    setGenNodeSizes,
    setPreviewOutputNodeKey,
  ]);

  useEffect(
    () => () => {
      for (const controller of videoComposerAbortControllersRef.current.values()) {
        controller.abort();
      }
      videoComposerAbortControllersRef.current.clear();
      for (const controller of knowledgeVideoWorkflowAbortControllersRef.current.values()) {
        controller.abort();
      }
      knowledgeVideoWorkflowAbortControllersRef.current.clear();
    },
    [],
  );

  // ---- 画布状态持久化（canvas_documents 表）----
  // 启动恢复 + 防抖自动保存。V2 保存提示内容 canonical document；旧 V1 HTML
  // 仅通过提示内容 module 的白名单 adapter 迁移读取。
  const [canvasHydrated, setCanvasHydrated] = useState(!isDesktopRuntime());
  const canvasRestoredRef = useRef(false);
  const canvasSaveTimerRef = useRef<number | null>(null);
  const canvasSaveRequestRef = useRef(0);
  // 跳过恢复完成后由状态回填触发的第一次保存（内容与磁盘一致，无需写一次）。
  const suppressNextCanvasSaveRef = useRef(false);
  // 最新画布状态收集器：保存定时器触发时读取，避免闭包捕获旧状态。
  const collectCanvasDocumentRef = useRef<() => CanvasDocumentV2>(() => {
    throw new Error("canvas document collector not ready");
  });

  const collectCanvasDocument = useCallback((): CanvasDocumentV2 => {
    const generationNodeKeys = new Set(
      genNodes.filter((node) => node.kind !== "prompt").map((node) => node.key),
    );
    return snapshotV2(promptContents.snapshotAll(generationNodeKeys));
  }, [genNodes, promptContents, snapshotV2]);

  useEffect(() => {
    collectCanvasDocumentRef.current = collectCanvasDocument;
  }, [collectCanvasDocument]);

  const flushCanvasSave = useCallback((): Promise<void> => {
    if (canvasSaveTimerRef.current != null) {
      window.clearTimeout(canvasSaveTimerRef.current);
      canvasSaveTimerRef.current = null;
    }
    const requestId = ++canvasSaveRequestRef.current;
    const document = collectCanvasDocumentRef.current();
    return canvasDocumentClient
      .save({ id: CANVAS_ID, title: CANVAS_DOCUMENT_TITLE, document })
      .then((record) => {
        if (requestId !== canvasSaveRequestRef.current) return;
        frontendLog(
          "info",
          `[canvas] 画布状态已保存: 节点=${document.assetNodes.length + document.genNodes.length + (document.screenplayNodes?.length ?? 0) + (document.storyboardNodes?.length ?? 0) + (document.knowledgeVideoWorkflowNodes?.length ?? 0) + (document.viralRemixNodes?.length ?? 0) + (document.videoComposerNodes?.length ?? 0) + (document.videoDownloaderNodes?.length ?? 0) + (document.frameExtractorNodes?.length ?? 0) + document.resultNodes.length + (document.outputNodes?.length ?? 0)}, 连线=${document.assetEdges.length}, revision=${record.revision}`,
        );
      })
      .catch((error: unknown) => {
        if (requestId !== canvasSaveRequestRef.current) return;
        frontendLog("error", `[canvas] 画布状态保存失败: ${formatRawBackendError(error)}`);
      });
  }, []);

  const scheduleCanvasSave = useCallback(() => {
    if (canvasSaveTimerRef.current != null) {
      window.clearTimeout(canvasSaveTimerRef.current);
    }
    canvasSaveTimerRef.current = window.setTimeout(() => {
      canvasSaveTimerRef.current = null;
      void flushCanvasSave();
    }, CANVAS_SAVE_DEBOUNCE_MS);
  }, [flushCanvasSave]);

  // 启动时恢复画布（仅桌面端；首次运行无文档时后端返回 NotFound，保持空白画布）。
  useEffect(() => {
    if (!isDesktopRuntime() || canvasRestoredRef.current) return;
    canvasRestoredRef.current = true;
    let cancelled = false;
    canvasDocumentClient
      .get(CANVAS_ID)
      .then((record) => {
        if (cancelled) return;
        const restored = restoreDocument(record.document);
        if (!restored.ok) return;
        const document = record.document as CanvasDocument;
        // restoreDocument 已原子替换节点、连线、视图与选择并清空历史；这里只同步 RF 与提示内容 adapter。
        void flowInstanceRef.current?.setViewport({
          x: restored.view.pan.x,
          y: restored.view.pan.y,
          zoom: restored.view.zoom / 100,
        });
        const promptRestore = promptContents.restoreAll(restored.promptContents);
        if (!promptRestore.ok) {
          frontendLog(
            "error",
            `[canvas] 提示内容恢复失败: ${promptRestore.invalidNodeKeys.join(", ")}`,
          );
        } else {
          // 恢复后的提示内容已经包含精确引用或用户修改，包括主动清空的文档。
          // 用同时保存的上游版本初始化同步记录，避免首次 effect 按当前编号重新解析。
          importedPromptSourcesRef.current.clear();
          const restoredGenNodes = new Map(document.genNodes.map((node) => [node.key, node]));
          for (const edge of document.assetEdges) {
            const source = restoredGenNodes.get(edge.fromKey);
            if (source?.kind !== "prompt" || !(edge.toKey in restored.promptContents)) continue;
            importedPromptSourcesRef.current.set(edge.toKey, {
              edgeId: edge.id,
              sourceKey: source.key,
              text: source.config.generatedPrompt,
            });
          }
        }
        frontendLog(
          "info",
          `[canvas] 画布状态已恢复: 节点=${document.assetNodes.length + document.genNodes.length + (document.screenplayNodes?.length ?? 0) + (document.storyboardNodes?.length ?? 0) + (document.knowledgeVideoWorkflowNodes?.length ?? 0) + (document.viralRemixNodes?.length ?? 0) + (document.videoComposerNodes?.length ?? 0) + (document.videoDownloaderNodes?.length ?? 0) + (document.frameExtractorNodes?.length ?? 0) + document.resultNodes.length + (document.outputNodes?.length ?? 0)}, 连线=${document.assetEdges.length}, revision=${record.revision}`,
        );
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) {
          suppressNextCanvasSaveRef.current = true;
          setCanvasHydrated(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [promptContents, restoreDocument]);

  // 画布结构/视图变化 → 防抖保存（仅桌面端；浏览器预览模式无本地 SQLite）。
  // 提示词由 Tiptap 在 React 状态外管理，由下方画布容器上的 input 事件监听兜底触发。
  useEffect(() => {
    if (!canvasHydrated || !isDesktopRuntime()) return;
    if (suppressNextCanvasSaveRef.current) {
      suppressNextCanvasSaveRef.current = false;
      return;
    }
    scheduleCanvasSave();
  }, [
    canvasHydrated,
    assetEdges,
    assetNodes,
    genNodes,
    screenplayNodes,
    storyboardNodes,
    viralRemixNodes,
    videoComposerNodes,
    outputNodes,
    knowledgeVideoWorkflowNodes,
    pan,
    resultNodes,
    scheduleCanvasSave,
    zoom,
  ]);

  // Tiptap 提示词输入不进 React 状态，监听画布容器 input 事件触发防抖保存。
  useEffect(() => {
    if (!canvasHydrated || !isDesktopRuntime()) return;
    const viewport = canvasViewportRef.current;
    if (viewport == null) return;
    viewport.addEventListener("input", scheduleCanvasSave);
    return () => viewport.removeEventListener("input", scheduleCanvasSave);
  }, [canvasHydrated, scheduleCanvasSave]);

  // Tauri 关闭请求必须先阻止默认关闭，等待 SQLite 保存完成后再销毁窗口；否则
  // beforeunload 中发出的异步 invoke 可能随着 WebView 一同销毁，最近的画布变更会丢失。
  useEffect(() => {
    if (!canvasHydrated || !isDesktopRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let closing = false;

    void (async () => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      if (disposed) return;
      const appWindow = getCurrentWindow();
      const stopListening = await appWindow.onCloseRequested(async (event) => {
        event.preventDefault();
        if (closing) return;
        closing = true;
        await flushCanvasSave();
        await appWindow.destroy();
      });
      if (disposed) {
        stopListening();
        return;
      }
      unlisten = stopListening;
    })().catch((error: unknown) => {
      frontendLog("error", `[canvas] 注册窗口关闭保存失败: ${formatRawBackendError(error)}`);
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [canvasHydrated, flushCanvasSave]);

  // beforeunload 作为非标准关闭路径的兜底；React 卸载时也立即刷新尚未到期的防抖保存。
  useEffect(() => {
    if (!canvasHydrated || !isDesktopRuntime()) return;
    const handleBeforeUnload = () => {
      if (canvasSaveTimerRef.current != null) void flushCanvasSave();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      if (canvasSaveTimerRef.current != null) void flushCanvasSave();
    };
  }, [canvasHydrated, flushCanvasSave]);

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
    const mediaSourceKeys = new Set<string>();
    for (const node of assetNodeByKey.values()) {
      if (node.kind === "image" || node.kind === "video") mediaSourceKeys.add(node.key);
    }
    for (const node of outputNodeByKey.values()) {
      if (outputNodeReferenceTarget(node) != null) mediaSourceKeys.add(node.key);
    }
    const mediaInputTargetKeys = new Set<string>();
    for (const edge of assetEdges) {
      if (mediaSourceKeys.has(edge.fromKey)) mediaInputTargetKeys.add(edge.toKey);
    }
    mediaInputTargetKeysRef.current = mediaInputTargetKeys;
  }, [assetEdges, assetNodeByKey, outputNodeByKey]);

  const availableAssetProviders = useMemo(
    () => providerCatalog.map((entry) => entry.provider).filter((provider) => provider.enabled),
    [providerCatalog],
  );

  const assetProvider = useMemo(() => {
    const persisted = availableAssetProviders.find(
      (provider) => provider.id === activeAssetProviderId,
    );
    if (persisted) return persisted;
    // 旧版本没有保存素材库当前供应商：用最近修改的连接作为迁移默认，
    // 避免回退到按名称排序的旧 SD2.0 连接。
    return (
      availableAssetProviders.reduce<ProviderConnection | null>(
        (latest, provider) =>
          latest == null || provider.updatedAt > latest.updatedAt ? provider : latest,
        null,
      ) ?? null
    );
  }, [activeAssetProviderId, availableAssetProviders]);

  const rememberAssetProvider = useCallback((providerConnectionId: string) => {
    setActiveAssetProviderId(providerConnectionId);
    persistActiveAssetProviderId(providerConnectionId);
  }, []);

  const handleAssetProviderChanged = useCallback(
    (providerConnectionId: string) => {
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

  const refreshCloudAssets = useCallback(
    (providerConnectionId: string, source: AssetRefreshSource): void => {
      const requestId = ++cloudAssetsRequestRef.current;
      settingsAssetRequestRef.current = null;
      const startedAt = Date.now();
      frontendLog(
        "info",
        `[assets] 云端素材列表开始拉取: providerConnectionId=${providerConnectionId}, 触发来源=${source}`,
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
            setAssetsError(null);
            setLibraryError(false);
            frontendLog(
              "info",
              `[assets] 云端素材列表拉取成功: providerConnectionId=${providerConnectionId}, 触发来源=${source}, 共 ${assets.length} 个素材, 耗时 ${Date.now() - startedAt}ms`,
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
            setAssetsError(error instanceof Error ? error.message : formatted);
            setCloudAssets([]);
            setLibraryError(true);
            frontendLog(
              "error",
              `[assets] 云端素材列表拉取失败: providerConnectionId=${providerConnectionId}, 触发来源=${source}, 耗时 ${Date.now() - startedAt}ms, 错误: ${formatted}`,
            );
          },
        )
        .finally(() => {
          if (requestId === cloudAssetsRequestRef.current) setAssetsLoading(false);
        });
    },
    [],
  );

  const refreshLocalAssets = useCallback((source: AssetRefreshSource): void => {
    const startedAt = Date.now();
    setLocalAssetsLoading(true);
    frontendLog("info", `[assets] 本地素材索引开始读取: 触发来源=${source}`);
    void tosStagingClient
      .listLocalAssets()
      .then(
        (assets) => {
          setLocalAssets(assets);
          setLocalAssetsError(null);
          setLocalLibraryError(false);
          frontendLog(
            "info",
            `[assets] 本地素材索引读取成功: 触发来源=${source}, 共 ${assets.length} 个素材, 耗时 ${Date.now() - startedAt}ms`,
          );
        },
        (error: unknown) => {
          const formatted = formatRawBackendError(error);
          setLocalAssetsError(error instanceof Error ? error.message : formatted);
          setLocalLibraryError(true);
          frontendLog(
            "error",
            `[assets] 本地素材索引读取失败: 触发来源=${source}, 耗时 ${Date.now() - startedAt}ms, 错误: ${formatted}`,
          );
        },
      )
      .finally(() => setLocalAssetsLoading(false));
  }, []);

  // 拉取当前令牌作用域下的云端素材库分组。分组失败不阻塞素材浏览：
  // 选中保持「全部素材」，仅记录错误并允许在界面上重试。
  const refreshAssetGroups = useCallback(
    (providerConnectionId: string, preferredGroupId: number | null = null): void => {
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
    (groupId: number | null, providerConnectionId: string) => {
      selectedAssetGroupIdRef.current = groupId;
      setSelectedAssetGroupId(groupId);
      refreshCloudAssets(providerConnectionId, "group-changed");
    },
    [refreshCloudAssets],
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
            refreshCloudAssets(providerConnectionId, "group-created");
          },
          (error: unknown) => {
            const formatted = formatRawBackendError(error);
            frontendLog(
              "error",
              `[assets] 素材库分组创建失败: providerConnectionId=${providerConnectionId}, 错误: ${formatted}`,
            );
            setAssetsError(error instanceof Error ? error.message : formatted);
          },
        )
        .finally(() => setCreatingGroup(false));
    },
    [refreshAssetGroups, refreshCloudAssets],
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
            if (assetProvider) refreshCloudAssets(assetProvider.id, "rename");
          },
          (error: unknown) => {
            const formatted = formatRawBackendError(error);
            frontendLog(
              "error",
              `[assets] 云端素材改名失败: assetId=${asset.id}, 错误: ${formatted}`,
            );
            setAssetsError(error instanceof Error ? error.message : formatted);
          },
        )
        .finally(() => setRenamingAssetId(null));
    },
    [assetProvider, refreshCloudAssets],
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

  useEffect(() => {
    if (!isDesktopRuntime() || assetLibrarySource !== "cloud" || !assetProvider || settingsOpen)
      return;
    refreshCloudAssets(assetProvider.id, "initial");
    refreshAssetGroups(assetProvider.id);
    return () => {
      // provider / 来源 / 设置面板改变或组件卸载时，当前请求不可再提交状态。
      cloudAssetsRequestRef.current += 1;
      settingsAssetRequestRef.current = null;
    };
  }, [assetLibrarySource, assetProvider, refreshAssetGroups, refreshCloudAssets, settingsOpen]);

  // 断网恢复时自动重拉云端素材列表（首次挂载不算）。
  useEffect(() => {
    if (wasOfflineRef.current && !isOffline && assetLibrarySource === "cloud") {
      if (!assetProvider) {
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
  }, [isOffline, assetLibrarySource, assetProvider, refreshAssetGroups, refreshCloudAssets]);

  const handleImportLocalAssets = useCallback(
    async (realPersonGroup?: RealPersonGroup): Promise<number> => {
      const destination = realPersonGroup ? "cloud" : assetLibrarySource;
      if (destination === "cloud" && !assetProvider) {
        setAssetsError("请先在全局设置中配置并启用供应商连接，再上传本地素材。");
        return 0;
      }
      if (destination === "cloud") setAssetsError(null);
      else setLocalAssetsError(null);
      const files = await pickLocalMediaFiles();
      if (files.length === 0) return 0;
      let startedCount = 0;
      let firstError: unknown = null;
      for (const filePath of files) {
        const kind = inferMediaKindFromName(filePath);
        if (!kind) continue;
        const name = filePath.split(/[\\/]/).pop() ?? filePath;
        try {
          const jobId = await tosStagingClient.startUpload({
            localPath: filePath,
            purpose: destination === "local" ? "local_asset" : "asset_import",
            mediaType: kind,
            import:
              destination === "cloud" && assetProvider
                ? {
                    providerConnectionId: assetProvider.id,
                    name,
                    groupId: realPersonGroup?.id ?? null,
                  }
                : null,
          });
          startedCount += 1;
          setAssetUploads((current) => [
            ...current,
            {
              jobId,
              name,
              kind,
              status: "validating",
              bytesUploaded: 0,
              bytesTotal: null,
              error: null,
              lastAdvancedAt: Date.now(),
              stalled: false,
              destination,
            },
          ]);
        } catch (error) {
          firstError ??= error;
          if (destination === "cloud") setAssetsError(formatRawBackendError(error));
          else setLocalAssetsError(formatRawBackendError(error));
        }
      }
      if (startedCount === 0 && firstError != null && realPersonGroup) {
        throw firstError instanceof Error
          ? firstError
          : new Error(formatRawBackendError(firstError));
      }
      return startedCount;
    },
    [assetLibrarySource, assetProvider],
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
            bytesUploaded: job?.bytesUploaded ?? existing.bytesUploaded,
            bytesTotal: job?.bytesTotal ?? existing.bytesTotal,
            error: payload.error ?? existing.error,
          };
        }
        return next;
      });
      const status = payload.job?.status;
      if (payload.job?.purpose === "local_asset" && status === "staged") {
        refreshLocalAssets("upload-finished");
      } else if (assetLibrarySource === "cloud" && (status === "active" || status === "cleaned")) {
        if (assetProvider) {
          void refreshCloudAssets(assetProvider.id, "upload-finished");
          refreshAssetGroups(assetProvider.id);
        }
      }
    });
  }, [assetLibrarySource, assetProvider, refreshAssetGroups, refreshCloudAssets, refreshLocalAssets]);

  const dismissAssetUpload = useCallback((jobId: string) => {
    setAssetUploads((current) => current.filter((entry) => entry.jobId !== jobId));
  }, []);

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

  /** 在画布上创建一个生成节点（来自节点仓库拖拽或键盘新增）。 */
  const addGenNode = useCallback(
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
          : kind === "prompt"
            ? {
                key: genNodeKey(),
                kind,
                config: createPromptNodeConfig(nodeModelSelections.prompt, providerCatalogLoaded),
                ...position,
              }
            : {
                key: genNodeKey(),
                kind,
                config: createImageNodeConfig(nodeModelSelections.image, providerCatalogLoaded),
                ...position,
              };
      addNode("gen", node, { select: true });
      frontendLog(
        "info",
        `[canvas] 生成节点已创建: key=${node.key}, kind=${kind}, 位置=(${Math.round(position.x)}, ${Math.round(position.y)})`,
      );
      return node;
    },
    [
      dropPosition,
      nodeModelSelections.image,
      nodeModelSelections.prompt,
      nodeModelSelections.video,
      providerCatalogLoaded,
      addNode,
    ],
  );

  /** 创建独立剧本节点；它不接媒体连线，只复用全局文本模型连接。 */
  const addScreenplayNode = useCallback(
    (x: number, y: number) => {
      const position = dropPosition(x, y, SCREENPLAY_NODE_WIDTH, SCREENPLAY_NODE_HEIGHT);
      const node: ScreenplayNodeData = {
        key: screenplayNodeKey(),
        kind: "screenplay",
        ...position,
        config: createScreenplayNodeConfig(nodeModelSelections.prompt, providerCatalogLoaded),
      };
      addNode("screenplay", node, { select: true });
      frontendLog(
        "info",
        `[canvas] 剧本节点已创建: key=${node.key}, 位置=(${Math.round(position.x)}, ${Math.round(position.y)})`,
      );
      return node;
    },
    [dropPosition, nodeModelSelections.prompt, providerCatalogLoaded, addNode],
  );

  /** 创建剧本转工业级分镜脚本节点；V4.6 技能与历史均由文本模型通道注入。 */
  const addStoryboardNode = useCallback(
    (x: number, y: number) => {
      const position = dropPosition(x, y, SCREENPLAY_NODE_WIDTH, SCREENPLAY_NODE_HEIGHT);
      const node: StoryboardNodeData = {
        key: storyboardNodeKey(),
        kind: "storyboard",
        ...position,
        config: createScreenplayNodeConfig(nodeModelSelections.prompt, providerCatalogLoaded),
      };
      addNode("storyboard", node, { select: true });
      frontendLog(
        "info",
        `[canvas] 工业级分镜节点已创建: key=${node.key}, 位置=(${Math.round(position.x)}, ${Math.round(position.y)})`,
      );
      return node;
    },
    [dropPosition, nodeModelSelections.prompt, providerCatalogLoaded, addNode],
  );

  /** 创建爆款视频复刻节点；视频输入由连线提供，技能本身不执行下载。 */
  const addViralRemixNode = useCallback(
    (x: number, y: number) => {
      const position = dropPosition(x, y, VIRAL_REMIX_NODE_WIDTH, VIRAL_REMIX_NODE_HEIGHT);
      const node: ViralRemixNodeData = {
        key: viralRemixNodeKey(),
        kind: "viral_remix",
        ...position,
        config: createViralRemixNodeConfig(nodeModelSelections.prompt, providerCatalogLoaded),
      };
      addNode("viralRemix", node, { select: true });
      frontendLog(
        "info",
        `[canvas] 爆款视频复刻节点已创建: key=${node.key}, 位置=(${Math.round(position.x)}, ${Math.round(position.y)})`,
      );
      return node;
    },
    [dropPosition, nodeModelSelections.prompt, providerCatalogLoaded, addNode],
  );

  /** 在画布上创建本地视频拼接与合成节点。 */
  const addVideoComposerNode = useCallback(
    (x: number, y: number) => {
      const position = dropPosition(x, y, VIDEO_COMPOSER_NODE_WIDTH, VIDEO_COMPOSER_NODE_HEIGHT);
      const node: VideoComposerNodeData = {
        key: videoComposerNodeKey(),
        kind: "video_composer",
        ...position,
        config: { outputName: "合成视频", inputOrder: [] },
      };
      addNode("videoComposer", node, { select: true });
      frontendLog(
        "info",
        `[canvas] 视频合成节点已创建: key=${node.key}, 位置=(${Math.round(position.x)}, ${Math.round(position.y)})`,
      );
      return node;
    },
    [addNode, dropPosition],
  );

  /** 在画布上创建网络爆款视频下载节点（内置 yt-dlp 引擎的本地工具）。 */
  const addVideoDownloaderNode = useCallback(
    (x: number, y: number) => {
      const position = dropPosition(
        x,
        y,
        VIDEO_DOWNLOADER_NODE_WIDTH,
        VIDEO_DOWNLOADER_NODE_HEIGHT,
      );
      const node: VideoDownloaderNodeData = {
        key: videoDownloaderNodeKey(),
        kind: "video_downloader",
        ...position,
        config: { url: "" },
      };
      addNode("videoDownloader", node, { select: true });
      frontendLog(
        "info",
        `[canvas] 视频下载节点已创建: key=${node.key}, 位置=(${Math.round(position.x)}, ${Math.round(position.y)})`,
      );
      return node;
    },
    [addNode, dropPosition],
  );

  /** 在画布上创建视频抽帧节点（复用内置 FFmpeg 引擎的本地工具）。 */
  const addFrameExtractorNode = useCallback(
    (x: number, y: number) => {
      const position = dropPosition(
        x,
        y,
        VIDEO_FRAME_EXTRACTOR_NODE_WIDTH,
        VIDEO_FRAME_EXTRACTOR_NODE_HEIGHT,
      );
      const node: VideoFrameExtractorNodeData = {
        key: frameExtractorNodeKey(),
        kind: "frame_extractor",
        ...position,
        config: { timestamps: [], videoPath: "" },
      };
      addNode("frameExtractor", node, { select: true });
      frontendLog(
        "info",
        `[canvas] 视频抽帧节点已创建: key=${node.key}, 位置=(${Math.round(position.x)}, ${Math.round(position.y)})`,
      );
      return node;
    },
    [addNode, dropPosition],
  );

  /**
   * 从底部工作流仓库一次性放入知识教学视频导演流程。
   * 模板只保存当前项目供应商目录校准后的模型绑定；插入本身不会发起任何模型任务。
   */
  const insertWorkflow = useCallback(
    (
      kind:
        "knowledge" | "film" | "comicDrama" | "commerce" | "remotion" | "xhsCover" | "reverseVideo",
    ) => {
      try {
        const anchor = viewportCenterBoardCoordinates();
        const scale = flowInstanceRef.current?.getZoom() ?? zoom / 100;
        const visibleHeight =
          (canvasViewportRef.current?.getBoundingClientRect().height ?? 0) / scale;
        // 仓库展开时可视区域较矮，先保证折叠节点的标题与需求输入留在视口内。
        const topInset =
          visibleHeight > 0
            ? Math.max(0, (KNOWLEDGE_VIDEO_WORKFLOW_NODE_HEIGHT + 48 - visibleHeight) / 2)
            : 0;
        const createWorkflow = {
          knowledge: createKnowledgeVideoDirectorWorkflow,
          film: createAiFilmWorkflow,
          comicDrama: createComicDramaWorkflow,
          commerce: createCommerceWorkflow,
          remotion: createRemotionWorkflow,
          xhsCover: createXhsCoverWorkflow,
          reverseVideo: createReverseVideoWorkflow,
        }[kind];
        const title = {
          knowledge: "知识教学视频",
          film: "AI影视",
          comicDrama: "漫剧自动",
          commerce: "剧情带货",
          remotion: "动画逻辑图",
          xhsCover: "小红书封面",
          reverseVideo: "短视频反推",
        }[kind];
        const workflow = createWorkflow({
          anchor: { x: anchor.x, y: anchor.y + topInset },
          occupied: occupiedNodeRects,
          nodeModelSelections,
          providerCatalog,
          providerCatalogLoaded,
        });
        insertSubgraph(workflow.nodes, workflow.edges, {
          selectNodeKey: workflow.selectedNodeKey,
        });
        setWorkflowRepositoryExpanded(false);
        frontendLog(
          "info",
          `[canvas] ${title}工作流已放入画布: 节点=${workflow.nodes.length}, 连线=${workflow.edges.length}, 位置=(${Math.round(workflow.bounds.x)}, ${Math.round(workflow.bounds.y)})`,
        );
        toast.success(`${title}工作流已放入画布`, {
          description:
            kind === "reverseVideo"
              ? "粘贴视频链接或选择本地视频，自动下载、拆解并交付提示词与二创方案。"
              : kind === "xhsCover"
                ? "添加人物参考图和选题，使用项目模型自动制作 3:4 封面。"
                : kind === "remotion"
                  ? "描述动画或粘贴 ASCII 草图，选择项目文本模型后自动渲染。"
                  : kind === "commerce"
                    ? "添加产品原图与资料，配置项目模型后自动制作剧情带货视频。"
                    : kind === "comicDrama"
                      ? "在节点中添加各集剧本，点击开始后自动完成导演、服化道与分镜。"
                      : "填写制作要求并点击开始，其余步骤由节点自动完成。",
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        frontendLog("error", `[canvas] 工作流放入失败: ${message}`);
        toast.error("工作流放入失败", { description: message });
      }
    },
    [
      insertSubgraph,
      nodeModelSelections,
      occupiedNodeRects,
      providerCatalog,
      providerCatalogLoaded,
      viewportCenterBoardCoordinates,
      zoom,
    ],
  );
  const insertKnowledgeVideoDirectorWorkflow = useCallback(
    () => insertWorkflow("knowledge"),
    [insertWorkflow],
  );
  const insertAiFilmWorkflow = useCallback(() => insertWorkflow("film"), [insertWorkflow]);
  const insertComicDramaWorkflow = useCallback(
    () => insertWorkflow("comicDrama"),
    [insertWorkflow],
  );
  const insertCommerceWorkflow = useCallback(() => insertWorkflow("commerce"), [insertWorkflow]);
  const insertRemotionWorkflow = useCallback(() => insertWorkflow("remotion"), [insertWorkflow]);
  const insertXhsCoverWorkflow = useCallback(() => insertWorkflow("xhsCover"), [insertWorkflow]);
  const insertReverseVideoWorkflow = useCallback(
    () => insertWorkflow("reverseVideo"),
    [insertWorkflow],
  );
  const toggleWorkflowRepository = useCallback(
    () => setWorkflowRepositoryExpanded((current) => !current),
    [],
  );

  const updateKnowledgeVideoWorkflowConfig = useCallback(
    (key: string, config: KnowledgeVideoWorkflowConfig) => {
      patchNode("knowledgeVideoWorkflow", key, (node) => ({ ...node, config }));
    },
    [patchNode],
  );

  const runKnowledgeVideoWorkflow = useCallback(
    (
      key: string,
      resume: boolean,
      decisionResolution?: string,
      restoredNode?: KnowledgeVideoWorkflowNodeData,
    ) => {
      if (knowledgeVideoWorkflowAbortControllersRef.current.has(key)) return;
      const document = snapshotV2({});
      const sourceNode =
        restoredNode ??
        document.knowledgeVideoWorkflowNodes?.find((candidate) => candidate.key === key);
      if (!sourceNode) return;
      if (!isDesktopRuntime()) {
        setKnowledgeVideoWorkflowRuns((current) => ({
          ...current,
          [key]: {
            phase: "failed",
            progress: 0,
            message: "请在桌面应用中执行工作流。",
            error: "自动工作流需要桌面端的项目供应商和本地合成能力。",
          },
        }));
        return;
      }
      const historyRunId =
        resume && sourceNode.config.historyRunId
          ? sourceNode.config.historyRunId
          : crypto.randomUUID();
      if (activeWorkflowHistoryIdsRef.current.has(historyRunId)) return;
      const savedNode = { ...sourceNode, config: { ...sourceNode.config, historyRunId } };
      const node = withCanvasWorkflowMaterials(
        savedNode,
        workflowCanvasInputsFromDocument(document, key),
      );
      patchNode("knowledgeVideoWorkflow", key, () => savedNode);
      activeWorkflowHistoryIdsRef.current.add(historyRunId);
      setActiveWorkflowHistoryIds([...activeWorkflowHistoryIdsRef.current]);
      const controller = new AbortController();
      knowledgeVideoWorkflowAbortControllersRef.current.set(key, controller);
      setKnowledgeVideoWorkflowRuns((current) => ({
        ...current,
        [key]: {
          phase: resume ? node.config.checkpoint.phase : "planning",
          progress: resume ? 20 : 2,
          message: resume ? "正在从已保存进度继续…" : "正在启动自动工作流…",
          error: null,
        },
      }));
      void recoverWorkflowHistory()
        .then(() =>
          recordedWorkflowRunner.run({
            node,
            providerCatalog,
            resume,
            newHistory: !sourceNode.config.historyRunId,
            ...(decisionResolution === undefined ? {} : { decisionResolution }),
            signal: controller.signal,
            onCheckpoint: (checkpoint) => {
              patchNode("knowledgeVideoWorkflow", key, (currentNode) => ({
                ...currentNode,
                config: { ...currentNode.config, checkpoint },
              }));
            },
            onProgress: (runState) => {
              setKnowledgeVideoWorkflowRuns((current) => ({ ...current, [key]: runState }));
            },
          }),
        )
        .then((checkpoint) => {
          if (checkpoint.phase === "done") {
            toast.success(
              node.config.xhsCover
                ? "小红书封面制作完成"
                : node.config.remotion
                  ? "动画逻辑图制作完成"
                  : node.config.commerce
                    ? "剧情带货制作完成"
                    : node.config.comicDrama
                      ? "漫剧制作完成"
                      : node.config.film
                        ? "影视制作完成"
                        : "知识视频制作完成",
              {
                description: node.config.xhsCover
                  ? "封面方案、提示词与交付物已保存在工作流节点中。"
                  : node.config.remotion
                    ? "动画、预览图和可编辑工程已保存在工作流节点中。"
                    : checkpoint.documentsOnly
                      ? "制作文档与提示词已保存在工作流节点中。"
                      : "完整成片与过程文档已保存在工作流节点中。",
              },
            );
          } else if (checkpoint.phase === "awaiting_approval") {
            toast.info("工作流需要一项确认", {
              description: checkpoint.decision?.question ?? "请在节点内确认后继续。",
            });
          }
        })
        .catch((error: unknown) => {
          const message = formatWorkflowError(error);
          setKnowledgeVideoWorkflowRuns((current) => ({
            ...current,
            [key]: { phase: "failed", progress: 0, message: "工作流执行失败。", error: message },
          }));
        })
        .finally(() => {
          activeWorkflowHistoryIdsRef.current.delete(historyRunId);
          setActiveWorkflowHistoryIds([...activeWorkflowHistoryIdsRef.current]);
          if (knowledgeVideoWorkflowAbortControllersRef.current.get(key) === controller) {
            knowledgeVideoWorkflowAbortControllersRef.current.delete(key);
          }
        });
    },
    [recordedWorkflowRunner, snapshotV2, recoverWorkflowHistory, patchNode, providerCatalog],
  );

  const workflowHistoryActionsRef = useRef(new Set<string>());
  const restoreStoredWorkflow = useCallback(
    async (
      record: WorkflowHistoryRecord,
      action: "resume" | "restart" | "locate",
      resolution?: string,
    ) => {
      if (workflowHistoryActionsRef.current.has(record.id)) return;
      workflowHistoryActionsRef.current.add(record.id);
      try {
        await recoverWorkflowHistory();
        const latest = (await workflowHistoryClient.get(record.id)).record;
        if (latest.canvasId !== CANVAS_ID) throw new Error("请先打开这条工作流所属的画布。");
        if (activeWorkflowHistoryIdsRef.current.has(latest.id) && action !== "locate")
          throw new Error("这条工作流正在运行，请先在画布中暂停后再处理。");
        const document = snapshotV2({});
        const nodes = document.knowledgeVideoWorkflowNodes ?? [];
        const activeNode = nodes.find(
          (item) =>
            item.config.historyRunId === latest.id &&
            knowledgeVideoWorkflowAbortControllersRef.current.has(item.key),
        );
        if (activeNode && action === "locate") {
          selectNode(activeNode.key);
          void flowInstanceRef.current?.setCenter(
            activeNode.x + KNOWLEDGE_VIDEO_WORKFLOW_NODE_WIDTH / 2,
            activeNode.y + 100,
            { zoom: zoom / 100, duration: 200 },
          );
          setHistoryOpen(false);
          return;
        }
        const anchor = viewportCenterBoardCoordinates();
        const occupiedKeys = new Set(
          [
            ...document.assetNodes,
            ...document.genNodes,
            ...document.resultNodes,
            ...(document.outputNodes ?? []),
            ...(document.screenplayNodes ?? []),
            ...(document.storyboardNodes ?? []),
            ...(document.viralRemixNodes ?? []),
            ...(document.videoComposerNodes ?? []),
            ...(document.videoDownloaderNodes ?? []),
            ...(document.frameExtractorNodes ?? []),
            ...nodes,
          ].map((item) => item.key),
        );
        let restored = restoreWorkflowHistoryNode(
          latest,
          nodes.map((node) =>
            withCanvasWorkflowMaterials(node, workflowCanvasInputsFromDocument(document, node.key)),
          ),
          {
            restart: action === "restart",
            occupiedKeys,
            newKey: `workflow-restored-${crypto.randomUUID()}`,
            position: nearestAvailableNodePosition(
              {
                x: anchor.x - KNOWLEDGE_VIDEO_WORKFLOW_NODE_WIDTH / 2,
                y: anchor.y - 180,
                width: KNOWLEDGE_VIDEO_WORKFLOW_NODE_WIDTH,
                height: KNOWLEDGE_VIDEO_WORKFLOW_NODE_HEIGHT,
              },
              occupiedNodeRects,
            ),
          },
        );
        if (restored.replace) {
          // The history owns a full input snapshot; the live canvas continues to own its edges.
          const original = nodes.find((node) => node.key === restored.node.key);
          restored = {
            ...restored,
            node: {
              ...restored.node,
              config: {
                ...restored.node.config,
                connectedMaterials: original?.config.connectedMaterials ?? [],
              },
            },
          };
          patchNode("knowledgeVideoWorkflow", restored.node.key, () => restored.node);
        } else addNode("knowledgeVideoWorkflow", restored.node, { select: true });
        selectNode(restored.node.key);
        void flowInstanceRef.current?.setCenter(
          restored.node.x + KNOWLEDGE_VIDEO_WORKFLOW_NODE_WIDTH / 2,
          restored.node.y + 180,
          { zoom: zoom / 100, duration: 200 },
        );
        if (action !== "locate") {
          runKnowledgeVideoWorkflow(
            restored.node.key,
            action === "resume",
            resolution,
            restored.node,
          );
        }
        setHistoryOpen(false);
        if (!restored.replace)
          toast.success(
            action === "restart" ? "已按历史输入重新制作" : "工作流已从历史记录恢复到画布",
          );
      } finally {
        workflowHistoryActionsRef.current.delete(record.id);
      }
    },
    [
      recoverWorkflowHistory,
      snapshotV2,
      selectNode,
      zoom,
      viewportCenterBoardCoordinates,
      occupiedNodeRects,
      patchNode,
      addNode,
      runKnowledgeVideoWorkflow,
    ],
  );
  const resumeHistoryWorkflow = useCallback(
    (record: WorkflowHistoryRecord, resolution?: string) =>
      restoreStoredWorkflow(record, "resume", resolution),
    [restoreStoredWorkflow],
  );
  const restartHistoryWorkflow = useCallback(
    (record: WorkflowHistoryRecord) => restoreStoredWorkflow(record, "restart"),
    [restoreStoredWorkflow],
  );
  const locateHistoryWorkflow = useCallback(
    (record: WorkflowHistoryRecord) => {
      void restoreStoredWorkflow(record, "locate").catch((error: unknown) =>
        toast.error("恢复工作流失败", { description: formatWorkflowError(error) }),
      );
    },
    [restoreStoredWorkflow],
  );
  const openWorkflowHistory = useCallback(
    (key: string) => {
      const node = knowledgeVideoWorkflowNodes.find((item) => item.key === key);
      setHistoryInitialTab("workflow");
      setHistoryInitialWorkflowId(node?.config.historyRunId ?? null);
      setHistoryOpen(true);
    },
    [knowledgeVideoWorkflowNodes],
  );

  const handlePickReverseVideo = useCallback(
    async (key: string) => {
      try {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const selection = await open({
          multiple: false,
          directory: false,
          title: "选择要反推的本地视频",
          filters: [{ name: "视频", extensions: ["mp4", "mov", "webm", "mkv", "avi", "m4v"] }],
        });
        if (typeof selection !== "string" || !selection) return;
        patchNode("knowledgeVideoWorkflow", key, (node) => {
          if (
            !node.config.reverseVideo ||
            knowledgeVideoWorkflowAbortControllersRef.current.has(key) ||
            node.config.checkpoint.phase === "awaiting_approval"
          )
            return node;
          return {
            ...node,
            config: {
              ...node.config,
              reverseVideo: {
                ...node.config.reverseVideo,
                sourceUrl: "",
                localVideoPath: selection,
                localVideoName: selection.split(/[\\/]/).at(-1) ?? "本地视频",
              },
            },
          };
        });
      } catch (error) {
        toast.error("选择视频失败", { description: formatWorkflowError(error) });
      }
    },
    [patchNode],
  );

  const handleRemoveReverseVideo = useCallback(
    (key: string) => {
      patchNode("knowledgeVideoWorkflow", key, (node) => {
        if (
          !node.config.reverseVideo ||
          knowledgeVideoWorkflowAbortControllersRef.current.has(key) ||
          node.config.checkpoint.phase === "awaiting_approval"
        )
          return node;
        return {
          ...node,
          config: {
            ...node.config,
            reverseVideo: {
              ...node.config.reverseVideo,
              localVideoPath: "",
              localVideoName: "",
            },
          },
        };
      });
    },
    [patchNode],
  );

  const handlePickWorkflowMaterials = useCallback(
    async (key: string) => {
      const picked = await pickPromptMultimodalFiles({ title: "为工作流添加参考素材" });
      if (!picked.length) return;
      let rejected = 0;
      patchNode("knowledgeVideoWorkflow", key, (node) => {
        if (
          knowledgeVideoWorkflowAbortControllersRef.current.has(key) ||
          node.config.checkpoint.phase === "awaiting_approval"
        )
          return node;
        const materials = [...(node.config.materials ?? [])];
        const effectiveConfig = withCanvasWorkflowMaterials(
          node,
          workflowInputsRef.current.get(key) ?? [],
        ).config;
        const generalPaths = new Set(materials.map(workflowMaterialPathKey));
        for (const item of picked) {
          const path = workflowMaterialPathKey(item);
          const nextQuota = workflowMaterialQuota({
            ...effectiveConfig,
            materials: [...materials, item],
          });
          if (
            generalPaths.has(path) ||
            !Number.isFinite(item.byteSize) ||
            item.byteSize <= 0 ||
            item.byteSize > MAX_WORKFLOW_MATERIAL_BYTES ||
            nextQuota.count > MAX_WORKFLOW_MATERIALS ||
            nextQuota.localBytes > MAX_WORKFLOW_MATERIAL_BYTES
          ) {
            rejected++;
            continue;
          }
          generalPaths.add(path);
          materials.push(item);
        }
        return { ...node, config: { ...node.config, materials } };
      });
      if (rejected)
        toast.info(`${rejected} 项参考素材未添加`, {
          description: "重复文件会跳过；参考素材与专用资料合计最多 8 项、14 MB，不支持空文件。",
        });
    },
    [patchNode],
  );

  const handleRemoveWorkflowMaterial = useCallback(
    (key: string, localPath: string) => {
      patchNode("knowledgeVideoWorkflow", key, (node) => {
        if (
          knowledgeVideoWorkflowAbortControllersRef.current.has(key) ||
          node.config.checkpoint.phase === "awaiting_approval"
        )
          return node;
        return {
          ...node,
          config: {
            ...node.config,
            materials: (node.config.materials ?? []).filter((item) => item.localPath !== localPath),
          },
        };
      });
    },
    [patchNode],
  );

  const handlePickCoverImages = useCallback(
    async (key: string, role: "portrait" | "material") => {
      const picked = await pickPromptMultimodalFiles({
        title: role === "portrait" ? "添加同一人物的封面参考图" : "添加封面截图、产品图或标志",
        kinds: ["image"],
      });
      if (!picked.length) return;
      let rejected = 0;
      patchNode("knowledgeVideoWorkflow", key, (node) => {
        const options = node.config.xhsCover;
        if (
          !options ||
          knowledgeVideoWorkflowAbortControllersRef.current.has(key) ||
          node.config.checkpoint.phase === "awaiting_approval"
        )
          return node;
        const field = role === "portrait" ? "portraits" : "materials";
        const items = [...options[field]];
        const existing = [...options.portraits, ...options.materials];
        const paths = new Set(existing.map(workflowMaterialPathKey));
        let totalBytes = existing.reduce((sum, item) => sum + item.byteSize, 0);
        const effectiveConfig = withCanvasWorkflowMaterials(
          node,
          workflowInputsRef.current.get(key) ?? [],
        ).config;
        for (const item of picked) {
          const nextQuota = workflowMaterialQuota({
            ...effectiveConfig,
            xhsCover: { ...options, [field]: [...items, item] },
          });
          if (
            item.kind !== "image" ||
            paths.has(workflowMaterialPathKey(item)) ||
            items.length >= (role === "portrait" ? 3 : 5) ||
            !Number.isFinite(item.byteSize) ||
            item.byteSize <= 0 ||
            totalBytes + item.byteSize > XHS_COVER_MAX_REFERENCE_BYTES ||
            nextQuota.count > MAX_WORKFLOW_MATERIALS ||
            nextQuota.localBytes > MAX_WORKFLOW_MATERIAL_BYTES
          ) {
            rejected++;
            continue;
          }
          paths.add(workflowMaterialPathKey(item));
          totalBytes += item.byteSize;
          items.push(item);
        }
        return { ...node, config: { ...node.config, xhsCover: { ...options, [field]: items } } };
      });
      if (rejected)
        toast.info(`${rejected} 张图片未添加`, {
          description:
            "人物参考图最多 3 张，封面图片合计不超过 8 MB；与通用参考素材合计最多 8 项、14 MB，重复图片会跳过。",
        });
    },
    [patchNode],
  );

  const handleRemoveCoverImage = useCallback(
    (key: string, role: "portrait" | "material", path: string) => {
      patchNode("knowledgeVideoWorkflow", key, (node) => {
        const options = node.config.xhsCover;
        if (
          !options ||
          knowledgeVideoWorkflowAbortControllersRef.current.has(key) ||
          node.config.checkpoint.phase === "awaiting_approval"
        )
          return node;
        const field = role === "portrait" ? "portraits" : "materials";
        return {
          ...node,
          config: {
            ...node.config,
            xhsCover: {
              ...options,
              [field]: options[field].filter((item) => item.localPath !== path),
            },
          },
        };
      });
    },
    [patchNode],
  );

  const handlePickCommerceMaterials = useCallback(
    async (key: string) => {
      const picked = await pickPromptMultimodalFiles({
        title: "为带货工作流添加商品原图和资料",
        kinds: ["image", "document"],
      });
      if (!picked.length) return;
      let rejected = 0;
      patchNode("knowledgeVideoWorkflow", key, (node) => {
        const options = node.config.commerce;
        if (
          !options ||
          knowledgeVideoWorkflowAbortControllersRef.current.has(key) ||
          node.config.checkpoint.phase === "awaiting_approval"
        )
          return node;
        const materials = [...options.materials];
        const paths = new Set(materials.map(workflowMaterialPathKey));
        const effectiveConfig = withCanvasWorkflowMaterials(
          node,
          workflowInputsRef.current.get(key) ?? [],
        ).config;
        for (const item of picked) {
          const nextQuota = workflowMaterialQuota({
            ...effectiveConfig,
            commerce: { ...options, materials: [...materials, item] },
          });
          if (
            (item.kind !== "image" && item.kind !== "document") ||
            paths.has(workflowMaterialPathKey(item)) ||
            !Number.isFinite(item.byteSize) ||
            item.byteSize <= 0 ||
            item.byteSize > MAX_WORKFLOW_MATERIAL_BYTES ||
            nextQuota.count > MAX_WORKFLOW_MATERIALS ||
            nextQuota.localBytes > MAX_WORKFLOW_MATERIAL_BYTES
          ) {
            rejected++;
            continue;
          }
          paths.add(workflowMaterialPathKey(item));
          materials.push(item);
        }
        return { ...node, config: { ...node.config, commerce: { ...options, materials } } };
      });
      if (rejected)
        toast.info(`${rejected} 项产品资料未添加`, {
          description: "支持图片与文档，与通用参考素材合计最多 8 项、14 MB；重复文件会跳过。",
        });
    },
    [patchNode],
  );

  const handleRemoveCommerceMaterial = useCallback(
    (key: string, localPath: string) => {
      patchNode("knowledgeVideoWorkflow", key, (node) => {
        const options = node.config.commerce;
        if (
          !options ||
          knowledgeVideoWorkflowAbortControllersRef.current.has(key) ||
          node.config.checkpoint.phase === "awaiting_approval"
        )
          return node;
        return {
          ...node,
          config: {
            ...node.config,
            commerce: {
              ...options,
              materials: options.materials.filter((item) => item.localPath !== localPath),
            },
          },
        };
      });
    },
    [patchNode],
  );

  const executeKnowledgeVideoWorkflow = useCallback(
    (key: string) => runKnowledgeVideoWorkflow(key, false),
    [runKnowledgeVideoWorkflow],
  );
  const continueKnowledgeVideoWorkflow = useCallback(
    (key: string, resolution?: string) => runKnowledgeVideoWorkflow(key, true, resolution),
    [runKnowledgeVideoWorkflow],
  );
  const cancelKnowledgeVideoWorkflow = useCallback(
    (key: string) => {
      knowledgeVideoWorkflowAbortControllersRef.current.get(key)?.abort();
      const node = knowledgeVideoWorkflowNodes.find((candidate) => candidate.key === key);
      const jobId = node?.config.checkpoint.activeCompositionJobId;
      if (jobId) void videoComposerClient.cancelJob(jobId).catch(() => undefined);
    },
    [knowledgeVideoWorkflowNodes],
  );
  const removeKnowledgeVideoWorkflow = useCallback(
    (key: string) => {
      knowledgeVideoWorkflowAbortControllersRef.current.get(key)?.abort();
      knowledgeVideoWorkflowAbortControllersRef.current.delete(key);
      removeCanvasNode(key);
      setKnowledgeVideoWorkflowRuns((current) => {
        if (!(key in current)) return current;
        const next = { ...current };
        delete next[key];
        return next;
      });
    },
    [removeCanvasNode],
  );
  const revealKnowledgeVideoWorkflowResult = useCallback(
    (key: string) => {
      const checkpoint = knowledgeVideoWorkflowNodes.find((node) => node.key === key)?.config
        .checkpoint;
      const path =
        checkpoint?.xhsCover?.finalPath ??
        checkpoint?.xhsCover?.imagePath ??
        checkpoint?.finalPath ??
        checkpoint?.remotion?.renderJob?.gifPath ??
        checkpoint?.remotion?.renderJob?.videoPath ??
        checkpoint?.remotion?.renderJob?.previewPath;
      if (path) void revealDesktopItem(path).catch(() => undefined);
    },
    [knowledgeVideoWorkflowNodes],
  );

  const revealRemotionProject = useCallback(
    (key: string) => {
      const path = knowledgeVideoWorkflowNodes.find((node) => node.key === key)?.config.checkpoint
        .remotion?.renderJob?.projectPath;
      if (path)
        void revealDesktopItem(path).catch((error: unknown) =>
          toast.error("打开动画工程失败", { description: formatRawBackendError(error) }),
        );
    },
    [knowledgeVideoWorkflowNodes],
  );

  const exportFilmDocuments = useCallback(
    (key: string) => {
      const node = knowledgeVideoWorkflowNodes.find((item) => item.key === key);
      if (!node) return;
      const isDrama = Boolean(node.config.comicDrama);
      const isCommerce = Boolean(node.config.commerce);
      const isRemotion = Boolean(node.config.remotion);
      const isCover = Boolean(node.config.xhsCover);
      if (
        !isCover &&
        !isRemotion &&
        !isDrama &&
        !isCommerce &&
        !node.config.checkpoint.film?.artifacts.length
      )
        return;
      const content = isCover
        ? xhsCoverDeliveryMarkdown(node.config.checkpoint)
        : isRemotion
          ? remotionDeliveryMarkdown(node.config.checkpoint)
          : isCommerce
            ? commerceDeliveryMarkdown(node.config.checkpoint)
            : isDrama
              ? comicDramaDeliveryMarkdown(node.config.checkpoint)
              : aiFilmDeliveryMarkdown(node.config.checkpoint);
      if (!content) return;
      const title = isCover
        ? "小红书封面制作文档"
        : isRemotion
          ? "动画逻辑图制作文档"
          : isCommerce
            ? "剧情带货制作文档"
            : isDrama
              ? "漫剧制作文档"
              : "影视制作文档";
      const fileName = markdownDocumentExportName(content, key, title);
      void (async () => {
        try {
          if (isDesktopRuntime()) {
            if (!(await saveMarkdownDocumentToDesktop(content, fileName, title))) return;
          } else {
            const url = URL.createObjectURL(
              new Blob([content], { type: "text/markdown;charset=utf-8" }),
            );
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = fileName;
            anchor.click();
            URL.revokeObjectURL(url);
          }
          toast.success(`${title}已导出`);
        } catch (error) {
          toast.error(`${title}导出失败`, { description: formatRawBackendError(error) });
        }
      })();
    },
    [knowledgeVideoWorkflowNodes],
  );

  const updateImageNodeConfig = useCallback(
    (key: string, config: ImageNodeConfig) => {
      patchNode("gen", key, (node) => (node.kind === "image" ? { ...node, config } : node));
    },
    [patchNode],
  );

  const updateVideoComposerConfig = useCallback(
    (key: string, config: VideoComposerNodeConfig) => {
      patchNode("videoComposer", key, (node) => ({ ...node, config }));
    },
    [patchNode],
  );

  const updateVideoDownloaderConfig = useCallback(
    (key: string, config: VideoDownloaderNodeConfig) => {
      patchNode("videoDownloader", key, (node) => ({ ...node, config }));
    },
    [patchNode],
  );

  const updateFrameExtractorConfig = useCallback(
    (key: string, config: VideoFrameExtractorNodeConfig) => {
      patchNode("frameExtractor", key, (node) => ({ ...node, config }));
    },
    [patchNode],
  );

  const updatePromptNodeConfig = useCallback(
    (key: string, config: PromptNodeConfig) => {
      patchNode("gen", key, (node) => (node.kind === "prompt" ? { ...node, config } : node));
    },
    [patchNode],
  );

  const updateScreenplayNodeConfig = useCallback(
    (key: string, config: ScreenplayNodeConfig) => {
      patchNode("screenplay", key, (node) => ({ ...node, config }));
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
          let totalBytes = existing.reduce((total, material) => total + material.byteSize, 0);
          const additions = [] as NonNullable<ScreenplayNodeConfig["materials"]>[number][];
          for (const material of picked) {
            const normalizedPath = material.localPath.toLocaleLowerCase();
            const exceedsCount = existing.length + additions.length >= MAX_SCREENPLAY_MATERIALS;
            const exceedsFileLimit =
              material.byteSize <= 0 || material.byteSize > MAX_SCREENPLAY_MATERIAL_BYTES;
            const exceedsTotalLimit =
              totalBytes + material.byteSize > MAX_SCREENPLAY_MATERIAL_TOTAL_BYTES;
            if (
              existingPaths.has(normalizedPath) ||
              exceedsCount ||
              exceedsFileLimit ||
              exceedsTotalLimit
            ) {
              rejectedCount += 1;
              continue;
            }
            existingPaths.add(normalizedPath);
            totalBytes += material.byteSize;
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
            description: "已存在、超过 8 项，或超出单项 / 合计 14 MB 限制。",
          });
        }
      } catch (error) {
        const message = formatRawBackendError(error);
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

  const updateStoryboardNodeConfig = useCallback(
    (key: string, config: ScreenplayNodeConfig) => {
      patchNode("storyboard", key, (node) => ({ ...node, config }));
    },
    [patchNode],
  );

  const updateViralRemixNodeConfig = useCallback(
    (key: string, config: ViralRemixNodeConfig) => {
      patchNode("viralRemix", key, (node) => ({ ...node, config }));
    },
    [patchNode],
  );

  const updateVideoNodeConfig = useCallback(
    (key: string, config: VideoNodeConfig) => {
      patchNode("gen", key, (node) => (node.kind === "video" ? { ...node, config } : node));
    },
    [patchNode],
  );

  /** 提示词节点连入的图片素材与图片产物（按连线建立顺序），执行时作为视觉理解输入传给文本模型。 */
  const promptVisionImages = useCallback(
    (nodeKey: string): readonly PromptVisionImageInput[] => {
      return (canvasEdgeIndex.byTarget.get(nodeKey) ?? []).flatMap((edge) => {
        const asset = assetNodeByKey.get(edge.fromKey);
        if (asset && asset.kind === "image") {
          return [{ target: assetNodeReferenceTarget(asset), displayName: asset.name }];
        }
        const output = outputNodeByKey.get(edge.fromKey);
        if (output?.mediaType === "image") {
          const target = outputNodeReferenceTarget(output);
          return target ? [{ target, displayName: output.name ?? "图片产物" }] : [];
        }
        return [];
      });
    },
    [assetNodeByKey, canvasEdgeIndex, outputNodeByKey],
  );

  /** 提示词节点连入的视频产物（已保存到本地的 generation 结果），作为多模态视频素材传给文本模型。 */
  const promptVideoMaterials = useCallback(
    (nodeKey: string): readonly PromptMultimodalInput[] => {
      return (canvasEdgeIndex.byTarget.get(nodeKey) ?? []).flatMap((edge) => {
        const output = outputNodeByKey.get(edge.fromKey);
        if (output?.mediaType !== "video" || output.finalPath == null) return [];
        const definition = promptMultimodalDefinitionForPath(output.finalPath);
        return definition && definition.kind === "video"
          ? [
              {
                localPath: output.finalPath,
                displayName: output.name ?? "视频产物",
                kind: "video",
                mimeType: definition.mimeType,
              },
            ]
          : [];
      });
    },
    [canvasEdgeIndex, outputNodeByKey],
  );

  /** 提示词节点调用已配置的文本模型，返回结果写入节点输出并由连线自动下发。 */
  const handleRunPromptNode = useCallback(
    (nodeKey: string) => {
      if (startingNodeKeys.has(nodeKey)) return;
      const node = genNodes.find(
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
      const isFpvPath = node.config.mode === "fpv_path";
      const isFightPromptMaster = node.config.mode === "fight_prompt_master";
      const isMultiGridStoryboard = node.config.mode === "multi_grid_storyboard";
      const isStoryboardPrompt = node.config.mode === "storyboard_prompt";
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
      const defaultMultiGridPrompt =
        isMultiGridStoryboard &&
        node.config.task === "generate" &&
        (visionImages.length > 0 || videoMaterials.length > 0)
          ? "请根据已连接参考素材中可见的人物、场景与动作提出多宫格分镜建议，参考画面不等于已有剧本；沿用对话中已确认的剧情和参数，仅在宫格数量、目标时长或风格缺失时补问，确认后生成图片与视频两套提示词。"
          : isMultiGridStoryboard &&
              node.config.task === "optimize" &&
              node.config.generatedPrompt.trim()
            ? "请继续优化当前输出中的多宫格分镜方案，沿用已确认的宫格数量、目标时长、风格、剧情与交付范围，完整保留本次所需的提示词和说明。"
            : "";
      const defaultStoryboardPrompt =
        isStoryboardPrompt &&
        node.config.task === "generate" &&
        (visionImages.length > 0 || videoMaterials.length > 0)
          ? "请根据已连接参考素材中实际可见的人物、场景与风格，结合对话中已确认的用途和剧情，生成可直接交给图片节点的完整整张故事板提示词。仅将可见内容作为参考，不把参考画面当作已确认的剧情；合理补全可推断细节，必要的核心信息缺失时再补问。"
          : isStoryboardPrompt &&
              node.config.task === "optimize" &&
              node.config.generatedPrompt.trim()
            ? "请继续优化当前输出中的故事板提示词，保留已确认的用途、角色、剧情、格数、画幅和风格，返回可直接交给图片节点的完整整张故事板提示词。"
            : "";
      const sourcePrompt =
        node.config.sourcePrompt.trim() ||
        defaultFpvPrompt ||
        defaultFightPrompt ||
        defaultMultiGridPrompt ||
        defaultStoryboardPrompt;
      if (!sourcePrompt) {
        failWith(
          node.config.task === "generate"
            ? isFpvPath
              ? "请连接带路径标记的参考图，或填写飞行路径描述。"
              : isFightPromptMaster
                ? "请连接参考图片或已保存的视频产物，或填写打斗创意与需求。"
                : isMultiGridStoryboard
                  ? "请填写剧情或分镜需求，或连接参考图片、已保存的视频产物。"
                  : isStoryboardPrompt
                    ? "请填写故事板用途与创意，或连接参考图片、已保存的视频产物。"
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
      // 多轮对话：把全部已完成轮次逐条注入系统上下文，本轮输入作为新的用户消息。
      const conversation = node.config.conversation ?? [];
      const contextHistory: PromptOptimizationContextEntry[] = conversation.map((entry, index) => ({
        role: `第 ${index + 1} 条 · ${promptConversationRoleLabel(entry.role)}`,
        content: entry.content,
      }));
      if (
        (isFpvPath || isFightPromptMaster || isMultiGridStoryboard || isStoryboardPrompt) &&
        node.config.generatedPrompt.trim()
      ) {
        contextHistory.push({ role: "当前输出提示词", content: node.config.generatedPrompt });
      }
      setNodeStartError(nodeKey, null);
      setStartingNodeKeys((current) => new Set(current).add(nodeKey));
      frontendLog(
        "info",
        `[generation] 发起提示词节点请求: node=${nodeKey}, task=${node.config.task}, mode=${node.config.mode}, model=${model.remoteModelId}, 历史 ${contextHistory.length} 条, 本轮 ${sourcePrompt.length} 字符, 视觉素材 ${visionImages.length} 张, 视频素材 ${videoMaterials.length} 个`,
      );
      void promptNodeClient
        .run({
          canvasId: CANVAS_ID,
          sourceNodeId: nodeKey,
          providerConnectionId: provider.provider.id,
          modelDefinitionId: model.definitionId,
          mode: node.config.mode,
          task: node.config.task,
          userPrompt: sourcePrompt,
          contextHistory,
          visionImages,
          multimodalInputs: videoMaterials,
        })
        .then((result) => {
          patchNode("gen", nodeKey, (item) =>
            item.kind === "prompt"
              ? {
                  ...item,
                  config: {
                    ...item.config,
                    generatedPrompt: result.optimizedPrompt,
                    conversation: [
                      ...(item.config.conversation ?? []),
                      { id: promptMessageId(), role: "user", content: sourcePrompt },
                      { id: promptMessageId(), role: "assistant", content: result.optimizedPrompt },
                    ],
                  },
                }
              : item,
          );
          frontendLog(
            "info",
            `[generation] 提示词节点请求完成: node=${nodeKey}, 返回 ${result.optimizedPrompt.length} 字符`,
          );
          toast.success("提示词已生成");
        })
        .catch((error: unknown) => {
          const message = formatRawBackendError(error);
          setNodeStartError(nodeKey, message);
          toast.error("提示词生成失败", { description: message });
          frontendLog("error", `[generation] 提示词节点请求失败: node=${nodeKey}, ${message}`);
        })
        .finally(() => {
          setStartingNodeKeys((current) => {
            const next = new Set(current);
            next.delete(nodeKey);
            return next;
          });
        });
    },
    [
      genNodes,
      promptVideoMaterials,
      promptVisionImages,
      providerCatalog,
      setNodeStartError,
      startingNodeKeys,
      patchNode,
    ],
  );

  /** 剧本对话：双技能全文由后端每轮重新载入，节点内全部历史逐条注入系统上下文。 */
  const handleRunScreenplayNode = useCallback(
    (nodeKey: string) => {
      if (startingNodeKeys.has(nodeKey)) return;
      const node = screenplayNodes.find((item) => item.key === nodeKey);
      if (!node) return;
      const failWith = (message: string) => setNodeStartError(nodeKey, message);
      if (!isDesktopRuntime()) {
        failWith("剧本模型只能在桌面应用中调用。请通过 Tauri 桌面端运行。");
        return;
      }
      const materials = node.config.materials ?? [];
      const userPrompt =
        node.config.composer.trim() || "请分析附带的参考素材，并据此创作或优化剧本。";
      if (!node.config.composer.trim() && !materials.length) {
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
      const contextHistory: PromptOptimizationContextEntry[] = node.config.conversation.map(
        (entry, index) => ({
          role: `第 ${index + 1} 条 · ${documentSkillRoleLabel(entry.role, "screenplay")}`,
          content: entry.content,
        }),
      );
      if (node.config.currentDocument.trim()) {
        contextHistory.push({
          role: "当前剧本文档",
          content: node.config.currentDocument,
        });
      }
      const multimodalInputs = screenplayMultimodalInputs(node.config);
      setNodeStartError(nodeKey, null);
      setStartingNodeKeys((current) => new Set(current).add(nodeKey));
      frontendLog(
        "info",
        `[generation] 发起剧本多轮对话: node=${nodeKey}, model=${model.remoteModelId}, 历史 ${contextHistory.length} 条, 本轮 ${userPrompt.length} 字符, 多模态素材 ${multimodalInputs.length} 项`,
      );
      void promptNodeClient
        .run({
          canvasId: CANVAS_ID,
          sourceNodeId: nodeKey,
          providerConnectionId: provider.provider.id,
          modelDefinitionId: model.definitionId,
          mode: "screenplay",
          task: "generate",
          userPrompt,
          contextHistory,
          multimodalInputs,
        })
        .then((result) => {
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
          const message = formatRawBackendError(error);
          setNodeStartError(nodeKey, message);
          frontendLog("error", `[generation] 剧本多轮对话失败: node=${nodeKey}, ${message}`);
        })
        .finally(() => {
          setStartingNodeKeys((current) => {
            const next = new Set(current);
            next.delete(nodeKey);
            return next;
          });
        });
    },
    [patchNode, providerCatalog, screenplayNodes, setNodeStartError, startingNodeKeys],
  );

  const handleExportScreenplay = useCallback(
    async (nodeKey: string) => {
      const node = screenplayNodes.find((item) => item.key === nodeKey);
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
        const message = `导出 Markdown 失败：${formatRawBackendError(error)}`;
        setNodeStartError(nodeKey, message);
        frontendLog("error", `[canvas] 剧本 Markdown 导出失败: node=${nodeKey}, ${message}`);
      }
    },
    [screenplayNodes, setNodeStartError],
  );

  /** 工业级分镜对话：V4.6 完整技能由后端每轮重新载入，节点全部历史逐条注入。 */
  const handleRunStoryboardNode = useCallback(
    (nodeKey: string) => {
      if (startingNodeKeys.has(nodeKey)) return;
      const node = storyboardNodes.find((item) => item.key === nodeKey);
      if (!node) return;
      const failWith = (message: string) => setNodeStartError(nodeKey, message);
      if (!isDesktopRuntime()) {
        failWith("工业级分镜模型只能在桌面应用中调用。请通过 Tauri 桌面端运行。");
        return;
      }
      const sourceInput = screenplayInputByStoryboard.get(nodeKey);
      const sourceDocument = sourceInput?.document.trim() ?? "";
      const userPrompt =
        node.config.composer.trim() ||
        (sourceDocument ? "请将已连接的剧本转换为工业级分镜脚本。" : "");
      if (!userPrompt) {
        failWith("请连接含有正文的剧本节点、粘贴剧本，或输入本轮分镜要求。");
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
        failWith("请先在当前分镜节点中选择可用的文本模型。");
        return;
      }
      const contextHistory: PromptOptimizationContextEntry[] = [];
      if (sourceInput && sourceDocument) {
        contextHistory.push({
          role: `已连接的上游 Markdown 剧本 · ${sourceInput.name}`,
          content: sourceDocument,
        });
      }
      contextHistory.push(
        ...node.config.conversation.map((entry, index) => ({
          role: `第 ${index + 1} 条 · ${documentSkillRoleLabel(entry.role, "storyboard")}`,
          content: entry.content,
        })),
      );
      if (node.config.currentDocument.trim()) {
        contextHistory.push({
          role: DOCUMENT_SKILL_NODE_COPY.storyboard.currentDocumentLabel,
          content: node.config.currentDocument,
        });
      }
      setNodeStartError(nodeKey, null);
      setStartingNodeKeys((current) => new Set(current).add(nodeKey));
      frontendLog(
        "info",
        `[generation] 发起工业级分镜多轮对话: node=${nodeKey}, model=${model.remoteModelId}, 历史 ${contextHistory.length} 条, 本轮 ${userPrompt.length} 字符`,
      );
      void promptNodeClient
        .run({
          canvasId: CANVAS_ID,
          sourceNodeId: nodeKey,
          providerConnectionId: provider.provider.id,
          modelDefinitionId: model.definitionId,
          mode: "storyboard",
          task: "generate",
          userPrompt,
          contextHistory,
        })
        .then((result) => {
          patchNode("storyboard", nodeKey, (item) => ({
            ...item,
            config: {
              ...item.config,
              composer: "",
              currentDocument: result.optimizedPrompt,
              conversation: [
                ...item.config.conversation,
                { id: screenplayMessageId(), role: "user", content: userPrompt },
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
            `[generation] 工业级分镜多轮对话完成: node=${nodeKey}, 返回 ${result.optimizedPrompt.length} 字符`,
          );
        })
        .catch((error: unknown) => {
          const message = formatRawBackendError(error);
          setNodeStartError(nodeKey, message);
          frontendLog("error", `[generation] 工业级分镜多轮对话失败: node=${nodeKey}, ${message}`);
        })
        .finally(() => {
          setStartingNodeKeys((current) => {
            const next = new Set(current);
            next.delete(nodeKey);
            return next;
          });
        });
    },
    [
      patchNode,
      providerCatalog,
      screenplayInputByStoryboard,
      setNodeStartError,
      startingNodeKeys,
      storyboardNodes,
    ],
  );

  const handleExportStoryboard = useCallback(
    async (nodeKey: string) => {
      const node = storyboardNodes.find((item) => item.key === nodeKey);
      if (!node?.config.currentDocument.trim()) return;
      const content = `${node.config.currentDocument.trimEnd()}\n`;
      const fileName = markdownDocumentExportName(content, nodeKey, "工业级分镜脚本");
      try {
        if (isDesktopRuntime()) {
          const filePath = await saveMarkdownDocumentToDesktop(
            content,
            fileName,
            "Markdown 分镜脚本文档",
          );
          if (!filePath) return;
          frontendLog(
            "info",
            `[canvas] 分镜脚本 Markdown 已导出: node=${nodeKey}, path=${filePath}`,
          );
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
        const message = `导出 Markdown 失败：${formatRawBackendError(error)}`;
        setNodeStartError(nodeKey, message);
        frontendLog("error", `[canvas] 分镜脚本 Markdown 导出失败: node=${nodeKey}, ${message}`);
      }
    },
    [setNodeStartError, storyboardNodes],
  );

  /** 爆款视频复刻：本地密集抽帧生成联系表，再把联系表与纯复刻技能交给多模态模型。 */
  const handleRunViralRemixNode = useCallback(
    (nodeKey: string) => {
      if (startingNodeKeys.has(nodeKey)) return;
      const node = viralRemixNodes.find((item) => item.key === nodeKey);
      const inputEdge = assetEdges.find((edge) => edge.toKey === nodeKey);
      const input: ViralRemixVideoInput | null = (() => {
        if (!inputEdge) return null;
        const asset = assetNodes.find(
          (item) =>
            item.key === inputEdge.fromKey && item.kind === "video" && item.videoUrl != null,
        );
        if (asset?.kind === "video" && asset.videoUrl) {
          return {
            key: asset.key,
            name: asset.name,
            src: asset.videoUrl,
            sourceLabel: "素材",
            edgeId: inputEdge.id,
          };
        }
        const output = outputNodes.find(
          (item) =>
            item.key === inputEdge.fromKey &&
            item.mediaType === "video" &&
            (item.finalPath != null || item.previewSrc != null),
        );
        if (output) {
          return {
            key: output.key,
            name: output.name ?? "未命名视频产物",
            src: output.finalPath ? toMediaSrc(output.finalPath) : (output.previewSrc ?? null),
            sourceLabel: "产物",
            edgeId: inputEdge.id,
          };
        }
        const downloader = videoDownloaderNodes.find((item) => item.key === inputEdge.fromKey);
        if (!downloader) return null;
        const latestOutput = [...outputNodes]
          .reverse()
          .find(
            (item) =>
              item.sourceNodeId === downloader.key &&
              item.origin === "download" &&
              item.mediaType === "video",
          );
        return {
          key: downloader.key,
          name: latestOutput?.name ?? "网络爆款视频下载",
          src: latestOutput?.finalPath
            ? toMediaSrc(latestOutput.finalPath)
            : (latestOutput?.previewSrc ?? null),
          sourceLabel: "下载节点",
          edgeId: inputEdge.id,
        };
      })();
      if (!node) return;
      const failWith = (message: string) => setNodeStartError(nodeKey, message);
      if (!isDesktopRuntime()) {
        failWith("爆款视频复刻只能在桌面应用中运行。请通过 Tauri 桌面端使用。");
        return;
      }
      if (!input) {
        failWith("请先连接一个视频素材、视频产物或网络爆款视频下载节点。");
        return;
      }
      if (!input.src) {
        failWith("已连接下载节点，但还没有可用视频。请先完成下载。");
        return;
      }
      const inputSrc = input.src;
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
        failWith("请先在当前复刻节点中选择可用的多模态文本模型。");
        return;
      }
      setNodeStartError(nodeKey, null);
      setStartingNodeKeys((current) => new Set(current).add(nodeKey));
      frontendLog(
        "info",
        `[viral-remix] 开始本地密集抽帧: node=${nodeKey}, source=${input.sourceLabel}, name=${input.name}`,
      );
      void import("../../lib/videoFrameSampler")
        .then(({ buildVideoContactSheets }) => buildVideoContactSheets(inputSrc))
        .then((contactSheets) => {
          const instructions = node.config.instructions.trim();
          const userPrompt = [
            `输入视频：${input.name}`,
            `已验证时长：${contactSheets.duration.toFixed(3)} 秒`,
            `全片抽帧：${contactSheets.overviewFrameCount} 帧；结尾 5 秒加密：${contactSheets.tailFrameCount} 帧；联系表：${contactSheets.sheets.length} 张。`,
            instructions
              ? `用户补充方向：${instructions}`
              : "用户未指定额外方向，请执行技能默认复刻合同。",
            "静态联系表不包含可听声音；任何对白、音乐或音效判断都必须标记为待听觉确认。",
          ].join("\n");
          frontendLog(
            "info",
            `[viral-remix] 联系表完成: node=${nodeKey}, duration=${contactSheets.duration.toFixed(3)}s, overview=${contactSheets.overviewFrameCount}, tail=${contactSheets.tailFrameCount}, sheets=${contactSheets.sheets.length}`,
          );
          return promptNodeClient.run({
            canvasId: CANVAS_ID,
            sourceNodeId: nodeKey,
            providerConnectionId: provider.provider.id,
            modelDefinitionId: model.definitionId,
            mode: "viral_remix",
            task: "generate",
            userPrompt,
            visionImages: contactSheets.sheets.map((sheet) => ({
              dataUrl: sheet.dataUrl,
              displayName: sheet.displayName,
            })),
          });
        })
        .then((result) => {
          patchNode("viralRemix", nodeKey, (item) => ({
            ...item,
            config: { ...item.config, currentDocument: result.optimizedPrompt },
          }));
          frontendLog(
            "info",
            `[viral-remix] 复刻方案完成: node=${nodeKey}, 返回 ${result.optimizedPrompt.length} 字符`,
          );
        })
        .catch((error: unknown) => {
          const message = formatRawBackendError(error);
          setNodeStartError(nodeKey, message);
          frontendLog("error", `[viral-remix] 复刻失败: node=${nodeKey}, ${message}`);
        })
        .finally(() => {
          setStartingNodeKeys((current) => {
            const next = new Set(current);
            next.delete(nodeKey);
            return next;
          });
        });
    },
    [
      providerCatalog,
      assetEdges,
      assetNodes,
      outputNodes,
      setNodeStartError,
      startingNodeKeys,
      videoDownloaderNodes,
      viralRemixNodes,
      patchNode,
    ],
  );

  const handleExportViralRemix = useCallback(
    async (nodeKey: string) => {
      const node = viralRemixNodes.find((item) => item.key === nodeKey);
      if (!node?.config.currentDocument.trim()) return;
      const content = `${node.config.currentDocument.trimEnd()}\n`;
      const fileName = markdownDocumentExportName(content, nodeKey, "爆款视频复刻方案");
      try {
        if (isDesktopRuntime()) {
          const filePath = await saveMarkdownDocumentToDesktop(
            content,
            fileName,
            "Markdown 复刻方案",
          );
          if (!filePath) return;
          frontendLog("info", `[canvas] 爆款视频复刻方案已导出: node=${nodeKey}, path=${filePath}`);
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
        const message = `导出 Markdown 失败：${formatRawBackendError(error)}`;
        setNodeStartError(nodeKey, message);
        frontendLog("error", `[canvas] 爆款视频复刻方案导出失败: node=${nodeKey}, ${message}`);
      }
    },
    [setNodeStartError, viralRemixNodes],
  );

  /** Add a new canvas projection for an asset; repeated additions always create a new instance. */
  const addAssetNode = useCallback(
    (
      asset: Pick<
        AssetItem,
        "id" | "kind" | "name" | "previewUrl" | "videoUrl" | "source" | "providerConnectionId"
      >,
      rawX: number,
      rawY: number,
    ) => {
      const source = asset.source ?? "cloud";
      const providerConnectionId = asset.providerConnectionId ?? assetProvider?.id ?? "";
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
    [addNode, assetProvider?.id, dropPosition],
  );

  /**
   * 连线拖拽结束：素材与已保存产物可连入图片/视频生成节点作为参考媒体；
   * 图片素材与已保存的图片/视频产物还可连入提示词节点做多模态参考理解，
   * 提示词只可连入图片/视频节点；剧本节点可作为工业级分镜节点的实时文档输入。
   */
  const connectCanvasNodes = useCallback(
    (fromKey: string, toKey: string) => {
      const promptSource = genNodes.find((node) => node.key === fromKey && node.kind === "prompt");
      const screenplaySource = screenplayNodes.find((node) => node.key === fromKey);
      const outputSource = outputNodes.find((node) => node.key === fromKey);
      const downloaderSource = videoDownloaderNodes.find((node) => node.key === fromKey);
      const generationTarget = genNodes.find((node) => node.key === toKey);
      const composerTarget = videoComposerNodes.find((node) => node.key === toKey);
      const viralRemixTarget = viralRemixNodes.find((node) => node.key === toKey);
      const frameExtractorTarget = frameExtractorNodes.find((node) => node.key === toKey);
      const workflowTarget = knowledgeVideoWorkflowNodes.some((node) => node.key === toKey);
      const storyboardTarget = storyboardNodes.find((node) => node.key === toKey);
      const result = connectCanvasStateNodes(fromKey, toKey);
      if (result.status !== "connected") return;
      const targetLabel = generationTarget
        ? `${generationTarget.kind === "image" ? "图片" : generationTarget.kind === "video" ? "视频" : "提示词"}节点`
        : composerTarget
          ? "视频拼接与合成节点"
          : viralRemixTarget
            ? "爆款视频复刻节点"
            : frameExtractorTarget
              ? "视频抽帧节点"
              : storyboardTarget
                ? "剧本转工业级分镜脚本节点"
                : workflowTarget
                  ? "工作流节点"
                  : `素材节点 ${toKey}`;
      frontendLog(
        "info",
        `[canvas] ${promptSource ? "提示词" : screenplaySource ? "剧本" : downloaderSource ? "网络爆款视频下载" : outputSource ? `${outputSource.mediaType === "image" ? "图片" : "视频"}产物` : "素材"}连线建立: ${fromKey} → ${targetLabel}`,
      );
    },
    [
      connectCanvasStateNodes,
      genNodes,
      outputNodes,
      screenplayNodes,
      storyboardNodes,
      knowledgeVideoWorkflowNodes,
      videoComposerNodes,
      videoDownloaderNodes,
      frameExtractorNodes,
      viralRemixNodes,
    ],
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
      removeCanvasNode(key);
      setGenNodeSizes((current) => {
        if (!(key in current)) return current;
        const next = { ...current };
        delete next[key];
        return next;
      });
      promptContents.remove(key);
      setStartErrorsByNode((current) => {
        if (!(key in current)) return current;
        const next = { ...current };
        delete next[key];
        return next;
      });
    },
    [promptContents, removeCanvasNode],
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

  const removeStoryboardNode = useCallback(
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

  const removeViralRemixNode = useCallback(
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

  /** 删除视频合成节点（保留已经生成的独立产物卡片）。 */
  const removeVideoComposerNode = useCallback(
    (key: string) => {
      videoComposerAbortControllersRef.current.get(key)?.abort();
      videoComposerAbortControllersRef.current.delete(key);
      removeCanvasNode(key);
      setVideoComposerRuns((current) => {
        if (!(key in current)) return current;
        const next = { ...current };
        delete next[key];
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
      disconnectCanvasEdge(edgeId);
    },
    [disconnectCanvasEdge],
  );

  useHotkeys(
    ["esc", "delete", "backspace"],
    (event) => {
      if (event.key === "Escape") {
        selectEdge(null);
        return;
      }
      event.preventDefault();
      if (selectedEdgeId != null) removeAssetEdge(selectedEdgeId);
    },
    { enabled: selectedEdgeId != null },
    [removeAssetEdge, selectEdge, selectedEdgeId],
  );

  /** 指定生成节点当前连接的素材/产物媒体（按建立顺序）。 */
  const generationInputs = useCallback(
    (nodeKey: string): readonly GenerationMediaInput[] => {
      const direct = (canvasEdgeIndex.byTarget.get(nodeKey) ?? []).flatMap((edge) => {
        const asset = assetNodeByKey.get(edge.fromKey);
        if (asset) return [assetGenerationInput(asset)];
        const output = outputNodeByKey.get(edge.fromKey);
        const input = output ? outputGenerationInput(output) : null;
        return input ? [input] : [];
      });
      const inherited = inheritedVideoAssetInputs(
        nodeKey,
        canvasEdgeIndex.byTarget,
        assetNodeByKey,
        genTopologyByKey,
      ).map((input) => assetGenerationInput(input.node));
      return [...direct, ...inherited];
    },
    [assetNodeByKey, canvasEdgeIndex, genTopologyByKey, outputNodeByKey],
  );

  /** 以视口中心为锚点缩放到目标百分比（键盘与缩放按钮共用），落点由 onMoveEnd 同步回 store。 */
  const zoomAroundViewportCenter = useCallback(
    (targetZoom: number) => {
      const instance = flowInstanceRef.current;
      const nextZoom = Math.round(Math.min(MAX_ZOOM, Math.max(minimumCanvasZoom(), targetZoom)));
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

  const queryClient = useQueryClient();
  // 对未到达终态的上传任务轮询 get_staging_job，驱动进度条实时刷新。
  // 查询 key 随活动任务集合变化：全部到达终态后集合为空，轮询自动停止；
  // 单个任务查询失败只跳过该任务，不影响同批其他任务的进度。
  const activeUploadJobIds = useMemo(
    () => assetUploads.filter((entry) => !isTerminalAssetUpload(entry)).map((entry) => entry.jobId),
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
      setAssetUploads((current) => {
        let changed = false;
        const next = current.map((entry) => {
          const job = jobs.find(
            (item): item is StagingJobRecord => item != null && item.id === entry.jobId,
          );
          if (job == null) return entry;
          const bytesAdvanced = job.bytesUploaded > entry.bytesUploaded;
          const statusChanged = job.status !== entry.status;
          // 非 uploading 阶段数据未变时跳过更新，避免无谓重渲染；
          // uploading 阶段每秒刷新一次，让停滞提示能按时间出现。
          if (!bytesAdvanced && !statusChanged && entry.status !== "uploading") {
            return entry;
          }
          changed = true;
          const lastAdvancedAt = bytesAdvanced || statusChanged ? now : entry.lastAdvancedAt;
          return {
            ...entry,
            status: job.status,
            bytesUploaded: job.bytesUploaded,
            bytesTotal: job.bytesTotal ?? entry.bytesTotal,
            error: job.error ?? entry.error,
            lastAdvancedAt,
            stalled: job.status === "uploading" && now - lastAdvancedAt >= UPLOAD_STALL_HINT_MS,
          };
        });
        return changed ? next : current;
      });
    });
  }, [queryClient]);

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
    return cloudAssets.map((asset) => {
      const item = cloudAssetToItem(asset);
      return assetProvider?.id === asset.providerConnectionId
        ? {
            ...item,
            providerDisplayName: assetProvider.displayName,
          }
        : item;
    });
  }, [assetLibrarySource, assetProvider, cloudAssets, localAssets]);

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
    patchNodes("storyboard", (node) => resolvePendingDocumentNodeConfig(node, catalog));
    patchNodes("knowledgeVideoWorkflow", (node) =>
      resolvePendingKnowledgeVideoWorkflowConfig(node, catalog),
    );
    patchNodes("viralRemix", (node) =>
      node.config.catalogResolved
        ? node
        : {
            ...node,
            config: {
              ...node.config,
              modelSelection: reconcileTextModelSelection(node.config.modelSelection, catalog),
              catalogResolved: true,
            },
          },
    );
    setProviderCatalogLoaded(true);
  }, [patchNodes]);

  // 生成任务列表：generation:* 事件是主驱动（handleGenerationEvent 里失效触发
  // 重新拉取），refetchInterval 仅在有未到终态任务时兜底轮询，防止漏接事件。
  // 拉取失败时 React Query 保留上一次成功数据，与原“失败保留现有状态”一致。
  const generationTasksQuery = useQuery({
    queryKey: GENERATION_TASKS_QUERY_KEY,
    queryFn: () => generationClient.list({ limit: 50 }),
    enabled: isDesktopRuntime(),
    refetchInterval: (query) => {
      const tasks = query.state.data?.items ?? [];
      return tasks.some((task) => !isTerminalTaskStatus(task.status))
        ? GENERATION_TASKS_POLL_INTERVAL_MS
        : false;
    },
  });
  const generationTasks = generationTasksQuery.data?.items ?? EMPTY_GENERATION_TASKS;

  const refreshTasks = useCallback(() => {
    if (!isDesktopRuntime()) return;
    void queryClient.invalidateQueries({ queryKey: GENERATION_TASKS_QUERY_KEY });
  }, [queryClient]);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let active = true;
    const providerCatalogRequestId = ++providerCatalogRequestRef.current;
    void loadProviderCatalog()
      .then((catalog) => {
        if (!active || providerCatalogRequestId !== providerCatalogRequestRef.current) return;
        setProviderCatalog(catalog);
        setNodeModelSelections((current) => reconcileNodeModelSelections(current, catalog));
        patchNodes("gen", (node) =>
          resolvePendingGenerationNodeConfig(node, catalog, mediaInputTargetKeysRef.current),
        );
        patchNodes("screenplay", (node) => resolvePendingDocumentNodeConfig(node, catalog));
        patchNodes("storyboard", (node) => resolvePendingDocumentNodeConfig(node, catalog));
        patchNodes("knowledgeVideoWorkflow", (node) =>
          resolvePendingKnowledgeVideoWorkflowConfig(node, catalog),
        );
        patchNodes("viralRemix", (node) =>
          node.config.catalogResolved
            ? node
            : {
                ...node,
                config: {
                  ...node.config,
                  modelSelection: reconcileTextModelSelection(node.config.modelSelection, catalog),
                  catalogResolved: true,
                },
              },
        );
        setProviderCatalogLoaded(true);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [patchNodes]);

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
      setTaskResults(Object.fromEntries(entries));
    })();
  }, [generationTasksQuery.data]);

  // 生成结果落卡去重（taskId#resultIndex）：占位卡片在任务启动时即已创建。
  // result-ready 只写入会话内 previewSrc，result-saved 再写入稳定的 finalPath；
  // 用户手动删除的占位卡片也不会因结果事件被重新创建。
  const seenOutputResultKeysRef = useRef<Set<string>>(new Set());
  // 已尝试补齐结果的占位卡片任务（应用重启后回填用，避免重复拉取任务详情）。
  const resolvedPendingTaskIdsRef = useRef<Set<string>>(new Set());

  /**
   * 生成结果填充：供应商返回的结果先原地填充 previewSrc，保存完成后再替换成
   * finalPath。previewSrc 只存在于当前会话，不会写进画布文档。
   * Seedream 图层拆分场景下单任务返回多张图（底图+多个图层），占位卡片只有一个，
   * 后续结果会动态新建独立卡片，每个图层单独落为可编辑对象。
   */
  const applyResultToOutputCard = useCallback(
    (record: GenerationResultRecord, previewSrc: string | null = null) => {
      if (!isDesktopRuntime()) return;
      const mediaType = record.mediaType;
      if (mediaType !== "image" && mediaType !== "video" && mediaType !== "text") return;
      const resultKey = `${record.taskId}#${record.resultIndex}`;
      const saved = record.saveStatus === "succeeded" && record.finalPath != null;
      if (!saved && previewSrc == null && mediaType !== "text") return;
      if (saved && seenOutputResultKeysRef.current.has(resultKey)) return;
      const finalPath = saved ? record.finalPath : null;
      const name = finalPath ? fileNameFromPath(finalPath) : null;
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
      let matched = false;
      patchNodes("output", (node) => {
        if (
          matched ||
          node.taskId !== record.taskId ||
          (node.resultKey != null && node.resultKey !== resultKey)
        ) {
          return node;
        }
        matched = true;
        return {
          ...node,
          resultKey,
          mediaType,
          ...(saved ? { finalPath, previewSrc: null, name } : { previewSrc, finalPath: null }),
          ...(textContent != null ? { textContent } : {}),
          ...(layer != null ? { layer } : {}),
        };
      });
      // 单任务多结果（如图层拆分）：占位卡片只有一个，后续结果匹配不到时动态新建卡片。
      if (!matched) {
        const existing = outputNodes.find((node) => node.taskId === record.taskId);
        const sourceNodeId = existing?.sourceNodeId;
        if (sourceNodeId) {
          const genNode = genNodes.find((node) => node.key === sourceNodeId);
          if (genNode) {
            addOutput((current) => ({
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
              ...nextOutputSlot(genNode, current),
            }));
            matched = true;
          }
        }
      }
      if (saved) {
        seenOutputResultKeysRef.current.add(resultKey);
        frontendLog("info", `[canvas] 生成产物已落卡: ${name}`);
      } else {
        frontendLog("info", `[canvas] 生成结果已返回，先展示临时预览: task=${record.taskId}`);
      }
    },
    [patchNodes, addOutput, genNodes, outputNodes],
  );

  const handleGenerationEvent = useCallback(
    (eventName: string, payload: unknown) => {
      if (eventName === "generation:result-ready" || eventName === "generation:result-saved") {
        const record = (payload as { result?: GenerationResultRecord } | null)?.result;
        if (record) {
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
          // 结果返回先展示临时预览；保存完成事件会把同一张卡片切换到本地文件。
          applyResultToOutputCard(
            record,
            eventName === "generation:result-ready" ? previewSrc : null,
          );
        }
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
      void refreshTasks();
    },
    [applyResultToOutputCard, refreshTasks],
  );

  useEffect(() => {
    return subscribeGenerationEvents(handleGenerationEvent);
  }, [handleGenerationEvent]);

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

  // 应用重启后回填：画布恢复出的占位产物卡片，若对应任务在应用关闭期间已成功
  // 且结果已保存，则拉取任务详情把产物补进卡片（会话内落卡由事件驱动，不经过这里）。
  useEffect(() => {
    if (!isDesktopRuntime()) return;
    for (const node of outputNodes) {
      if (node.finalPath != null) continue;
      if (resolvedPendingTaskIdsRef.current.has(node.taskId)) continue;
      const task = taskById.get(node.taskId);
      if (task?.status !== "succeeded") continue;
      resolvedPendingTaskIdsRef.current.add(node.taskId);
      void generationClient
        .get(node.taskId)
        .then((detail) => {
          const record = detail.results.find(
            (result) => result.saveStatus === "succeeded" && result.finalPath != null,
          );
          if (record) applyResultToOutputCard(record);
        })
        .catch(() => undefined);
    }
  }, [outputNodes, taskById, applyResultToOutputCard]);

  // 失败/中断的产物卡片自动加载完整原始返回（卡片内展示完整原始错误）。
  useEffect(() => {
    if (!isDesktopRuntime()) return;
    for (const node of outputNodes) {
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
  }, [outputNodes, taskById, taskResults, rawResponses, loadRawResponse]);

  const handleStartGeneration = useCallback(
    (nodeKey: string) => {
      if (startingNodeKeys.has(nodeKey)) return;
      const genNode = genNodes.find((node) => node.key === nodeKey);
      if (!genNode) return;
      // 提示词节点通过自身的文本模型按钮执行，不创建媒体生成任务。
      if (genNode.kind === "prompt") return;
      if (!isDesktopRuntime()) {
        setNodeStartError(nodeKey, "生成任务只能在桌面应用中发起。请通过 Tauri 桌面端运行。");
        return;
      }
      const selection = genNode.config.modelSelection;
      if (!selection?.providerId || !selection?.modelDefinitionId) {
        setNodeStartError(
          nodeKey,
          genNode.kind === "video"
            ? "请先在当前视频节点卡片中选择供应商和模型。"
            : "请先在当前图片节点卡片中选择供应商和模型。",
        );
        return;
      }

      const connectedAssets = generationInputs(nodeKey);
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
      const connections: PromptContentConnection[] = [
        ...connectedAssets.map((input) => ({
          ...input,
          role: genNode.kind === "video" ? (genNode.config.mediaRoles?.[input.key] ?? "") : "",
        })),
        ...urlConnections,
      ];
      const hasMediaInput = connectedAssets.some(
        (input) => input.kind === "image" || input.kind === "video",
      );
      const operation: GenerationOperation =
        genNode.kind === "video"
          ? "video_generation"
          : hasMediaInput
            ? "image_to_image"
            : "text_to_image";
      const resolvedSelection = resolveGenerationSelection(
        genNode.kind,
        selection,
        providerCatalog,
      );
      if (!resolvedSelection?.model.operations.includes(operation)) {
        setNodeStartError(
          nodeKey,
          genNode.kind === "video"
            ? "当前视频节点所选供应商或模型不可用，请在节点卡片中重新选择。"
            : `当前图片节点所选供应商或模型不支持${operation === "image_to_image" ? "图片参考生成" : "文生图"}，请在节点卡片中重新选择。`,
        );
        return;
      }

      const preparedPrompt = promptContents.prepareGeneration(nodeKey, {
        connections,
        allowMediaOnly: modelAllowsMediaOnlyPrompt(
          resolvedSelection.model.operationSchema,
          operation,
        ),
      });
      if (preparedPrompt == null || !preparedPrompt.ok) {
        const issue = preparedPrompt?.issues[0] ?? ({ kind: "empty_prompt" } as const);
        setNodeStartError(nodeKey, promptContentIssueMessage(issue));
        promptContents.focusIssue(nodeKey, issue);
        return;
      }
      const promptSegments = preparedPrompt.frozen.segments;
      const explicitMedia = preparedPrompt.frozen.explicitMedia;

      setNodeStartError(nodeKey, null);
      setStartingNodeKeys((current) => new Set(current).add(nodeKey));
      const parameterCapabilities = modelParameterCapabilities(
        resolvedSelection.model.operationSchema,
        operation,
        resolvedSelection.model.remoteModelId,
      );
      const parameters: Record<string, unknown> = generationParameters(
        parameterCapabilities,
        genNode.config.parameterValues,
        connections.length > 0,
      );

      // GPT-Image 契约的模型支持 `n` 参数：一次请求生成 n 张图片，不再拆分任务。
      // 其余供应商 API 无数量参数：数量 > 1 时拆分为 N 个独立任务（每个任务数量 1），
      // 每个任务对应一张占位产物卡片，单独展示状态与执行细节。
      const supportsBatchCount = parameterCapabilities.some(
        (capability) => capability.key === "n" && capability.type === "integer",
      );
      const countMaximum = supportsBatchCount
        ? GPT_IMAGE_MAX_GENERATION_COUNT
        : MAX_GENERATION_COUNT;
      const generationCount = Math.min(
        countMaximum,
        Math.max(1, Math.floor(genNode.config.generationCount) || 1),
      );
      if (supportsBatchCount) {
        parameters["n"] = generationCount;
      }
      const taskCount = supportsBatchCount ? 1 : generationCount;
      frontendLog(
        "info",
        `[generation] 发起画布生成: node=${nodeKey}（${genNode.kind}）, operation=${operation}, 提示词片段 ${promptSegments.length} 个（含 ${promptSegments.filter((s) => s.kind === "media_reference").length} 个 @引用）, 显式媒体输入 ${explicitMedia.length} 个, 生成数量 ${generationCount}${supportsBatchCount ? `（作为 n 参数一次请求提交）` : `（拆分为 ${taskCount} 个任务）`}`,
      );
      const startErrors: string[] = [];
      let remaining = taskCount;
      const settleOne = () => {
        remaining -= 1;
        if (remaining > 0) return;
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
      for (let index = 0; index < taskCount; index += 1) {
        void generationClient
          .start({
            canvasId: CANVAS_ID,
            sourceNodeId: nodeKey,
            operation,
            providerConnectionId: selection.providerId,
            modelDefinitionId: selection.modelDefinitionId,
            prompt: promptSegments,
            explicitMedia,
            parameters,
            generationCount: 1,
          })
          .then((taskId) => {
            // 任务创建成功 → 立即在来源生成节点右侧落下占位产物卡片并连虚线，
            // 卡片承担任务状态栏职责：进行中展示进度，成功填充产物，失败展示完整错误。
            const key = outputNodeKey();
            addOutput((current) => ({
              key,
              resultKey: null,
              sourceNodeId: genNode.key,
              taskId,
              mediaType: genNode.kind === "video" ? "video" : "image",
              finalPath: null,
              previewSrc: null,
              name: null,
              ...nextOutputSlot(genNode, current),
            }));
            frontendLog("info", `[canvas] 已创建生成占位产物卡片: task=${taskId}`);
            return refreshTasks();
          })
          .catch((error: unknown) => {
            startErrors.push(formatRawBackendError(error));
          })
          .finally(settleOne);
      }
    },
    [
      generationInputs,
      genNodes,
      providerCatalog,
      promptContents,
      refreshTasks,
      setNodeStartError,
      startingNodeKeys,
      addOutput,
    ],
  );

  // 各生成节点的活动任务与最近成功结果（按 sourceNodeId = 节点 key 关联）。
  const activeTaskByNode = useMemo(() => {
    const map = new Map<string, GenerationTaskSummary>();
    for (const task of generationTasks) {
      if (isTerminalTaskStatus(task.status)) continue;
      if (!map.has(task.sourceNodeId)) map.set(task.sourceNodeId, task);
    }
    return map;
  }, [generationTasks]);

  const latestResult = useMemo(() => {
    const results = Object.values(taskResults)
      .flat()
      .filter((result) => result.saveStatus === "succeeded" && result.finalPath)
      .sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0));
    return results[0] ?? null;
  }, [taskResults]);

  /** 注册节点级提示内容 handle；DOM implementation 不越过此 seam。 */
  const registerPromptInput = useCallback(
    (nodeKey: string, session: PromptContentEditorSession | null) => {
      promptContents.adoptEditor(nodeKey, session);
    },
    [promptContents],
  );

  /** 每个生成节点当前连线的素材输入（按建立顺序，携带连线 id 供解绑）。 */
  const connectedInputsByNode = useMemo(() => {
    const map = new Map<string, ConnectedAssetInput[]>();
    for (const edge of assetEdges) {
      const asset = assetNodeByKey.get(edge.fromKey);
      const output = outputNodeByKey.get(edge.fromKey);
      const outputInput = output ? outputGenerationInput(output) : null;
      if (asset == null && outputInput == null) continue;
      const list = map.get(edge.toKey) ?? [];
      list.push(
        asset
          ? {
              key: asset.key,
              name: asset.name,
              kind: asset.kind,
              edgeId: edge.id,
              sourceLabel: "素材",
            }
          : {
              key: outputInput!.key,
              name: outputInput!.name,
              kind: outputInput!.kind,
              edgeId: edge.id,
              sourceLabel: "产物",
            },
      );
      map.set(edge.toKey, list);
    }
    return map;
  }, [assetEdges, assetNodeByKey, outputNodeByKey]);

  /** 视频合成节点的有效输入：仅接收可播放的视频素材/产物，并按节点内保存顺序排列。 */
  const videoComposerInputsByNode = useMemo(() => {
    const map = new Map<string, VideoComposerInput[]>();
    for (const composer of videoComposerNodeByKey.values()) {
      const connected: VideoComposerInput[] = [];
      for (const edge of canvasEdgeIndex.byTarget.get(composer.key) ?? []) {
        const asset = assetNodeByKey.get(edge.fromKey);
        if (asset?.videoUrl) {
          connected.push({
            key: asset.key,
            name: asset.name,
            src: asset.videoUrl,
            sourceLabel: "素材",
            edgeId: edge.id,
            // ffmpeg 可直读 http(s)；其余形式（如会话内 blob）留给 MediaRecorder 路径。
            ffmpegSource: /^https?:\/\//i.test(asset.videoUrl) ? asset.videoUrl : null,
          });
          continue;
        }
        const candidate = outputNodeByKey.get(edge.fromKey);
        const output =
          candidate?.mediaType === "video" &&
          (candidate.finalPath != null || candidate.previewSrc != null)
            ? candidate
            : null;
        const src = output?.finalPath ? toMediaSrc(output.finalPath) : (output?.previewSrc ?? null);
        if (output && src) {
          connected.push({
            key: output.key,
            name: output.name ?? "未命名视频产物",
            src,
            sourceLabel: "产物",
            edgeId: edge.id,
            ffmpegSource: output.finalPath,
          });
        }
      }
      const order = normalizeVideoInputOrder(
        composer.config.inputOrder,
        connected.map((input) => input.key),
      );
      const orderIndex = new Map(order.map((key, index) => [key, index]));
      connected.sort(
        (first, second) =>
          (orderIndex.get(first.key) ?? Number.MAX_SAFE_INTEGER) -
          (orderIndex.get(second.key) ?? Number.MAX_SAFE_INTEGER),
      );
      map.set(composer.key, connected);
    }
    return map;
  }, [assetNodeByKey, canvasEdgeIndex, outputNodeByKey, videoComposerNodeByKey]);

  const inputOrderByEdge = useMemo(
    () => buildInputOrderByEdge(connectedInputsByNode, videoComposerInputsByNode),
    [connectedInputsByNode, videoComposerInputsByNode],
  );

  const latestDownloadOutputBySource = useMemo(() => {
    const map = new Map<string, OutputNodeData>();
    for (const output of outputNodeByKey.values()) {
      if (output.sourceNodeId && output.origin === "download" && output.mediaType === "video") {
        map.set(output.sourceNodeId, output);
      }
    }
    return map;
  }, [outputNodeByKey]);

  /** 视频合成节点的最近一次完成产物（供合成节点直接连线到下游工具时跟随）。 */
  const latestCompositionOutputBySource = useMemo(() => {
    const map = new Map<string, OutputNodeData>();
    for (const output of outputNodeByKey.values()) {
      if (output.sourceNodeId && output.origin === "composition" && output.mediaType === "video") {
        map.set(output.sourceNodeId, output);
      }
    }
    return map;
  }, [outputNodeByKey]);

  /** 爆款视频复刻节点的唯一视频输入；下载节点连接会自动跟随其最新完成产物。 */
  const viralRemixInputsByNode = useMemo(() => {
    const map = new Map<string, ViralRemixVideoInput>();
    for (const remixNode of viralRemixNodeByKey.values()) {
      const edge = canvasEdgeIndex.byTarget.get(remixNode.key)?.[0];
      if (!edge) continue;
      const asset = assetNodeByKey.get(edge.fromKey);
      if (asset?.kind === "video" && asset.videoUrl) {
        map.set(remixNode.key, {
          key: asset.key,
          name: asset.name,
          src: asset.videoUrl,
          sourceLabel: "素材",
          edgeId: edge.id,
        });
        continue;
      }
      const candidate = outputNodeByKey.get(edge.fromKey);
      const output =
        candidate?.mediaType === "video" &&
        (candidate.finalPath != null || candidate.previewSrc != null)
          ? candidate
          : null;
      if (output) {
        map.set(remixNode.key, {
          key: output.key,
          name: output.name ?? "未命名视频产物",
          src: output.finalPath ? toMediaSrc(output.finalPath) : (output.previewSrc ?? null),
          sourceLabel: "产物",
          edgeId: edge.id,
        });
        continue;
      }
      if (videoDownloaderNodeByKey.has(edge.fromKey)) {
        const latestOutput = latestDownloadOutputBySource.get(edge.fromKey);
        map.set(remixNode.key, {
          key: edge.fromKey,
          name: latestOutput?.name ?? "网络爆款视频下载",
          src: latestOutput?.finalPath
            ? toMediaSrc(latestOutput.finalPath)
            : (latestOutput?.previewSrc ?? null),
          sourceLabel: "下载节点",
          edgeId: edge.id,
        });
      }
    }
    return map;
  }, [
    assetNodeByKey,
    canvasEdgeIndex,
    latestDownloadOutputBySource,
    outputNodeByKey,
    videoDownloaderNodeByKey,
    viralRemixNodeByKey,
  ]);

  /** 视频抽帧节点的有效输入：仅接收可播放的视频（素材/产物/下载与合成节点），
   *  解析出可交给 Rust FFmpeg 的本地路径或 http(s) 地址。 */
  const frameExtractorInputsByNode = useMemo(() => {
    const map = new Map<string, FrameExtractorVideoInput[]>();
    for (const node of frameExtractorNodeByKey.values()) {
      const connected: FrameExtractorVideoInput[] = [];
      for (const edge of canvasEdgeIndex.byTarget.get(node.key) ?? []) {
        const asset = assetNodeByKey.get(edge.fromKey);
        if (asset?.kind === "video" && asset.videoUrl) {
          connected.push({
            key: asset.key,
            name: asset.name,
            src: asset.videoUrl,
            sourceLabel: "素材",
            edgeId: edge.id,
            finalPath: /^https?:\/\//i.test(asset.videoUrl) ? asset.videoUrl : null,
          });
          continue;
        }
        const candidate = outputNodeByKey.get(edge.fromKey);
        const output =
          candidate?.mediaType === "video" &&
          (candidate.finalPath != null || candidate.previewSrc != null)
            ? candidate
            : null;
        if (output) {
          connected.push({
            key: output.key,
            name: output.name ?? "未命名视频产物",
            src: output.finalPath ? toMediaSrc(output.finalPath) : (output.previewSrc ?? null),
            sourceLabel: "产物",
            edgeId: edge.id,
            finalPath: output.finalPath,
          });
          continue;
        }
        // 下载/合成节点直接连线：跟随该节点最近一次完成的视频产物。
        if (
          videoDownloaderNodeByKey.has(edge.fromKey) ||
          videoComposerNodeByKey.has(edge.fromKey)
        ) {
          const latestOutput =
            latestDownloadOutputBySource.get(edge.fromKey) ??
            latestCompositionOutputBySource.get(edge.fromKey);
          if (latestOutput?.finalPath) {
            connected.push({
              key: edge.fromKey,
              name: latestOutput.name ?? "视频工具产物",
              src: toMediaSrc(latestOutput.finalPath),
              sourceLabel: "产物",
              edgeId: edge.id,
              finalPath: latestOutput.finalPath,
            });
          }
        }
      }
      map.set(node.key, connected);
    }
    return map;
  }, [
    assetNodeByKey,
    canvasEdgeIndex,
    latestCompositionOutputBySource,
    latestDownloadOutputBySource,
    outputNodeByKey,
    videoComposerNodeByKey,
    videoDownloaderNodeByKey,
    frameExtractorNodeByKey,
  ]);

  const videoCompositionFormat = useMemo(
    () => preferredVideoCompositionFormat()?.extension.toUpperCase() ?? null,
    [],
  );

  /** 抽帧节点已产出的图片产物卡片（origin=frame_extract），供节点内预览。 */
  const frameExtractorOutputsByNode = useMemo(() => {
    const map = new Map<string, readonly OutputNodeData[]>();
    for (const node of frameExtractorNodeByKey.values()) {
      map.set(
        node.key,
        outputNodes.filter(
          (output) =>
            output.sourceNodeId === node.key &&
            output.origin === "frame_extract" &&
            output.finalPath != null,
        ),
      );
    }
    return map;
  }, [frameExtractorNodeByKey, outputNodes]);
  const moveVideoComposerInput = useCallback(
    (nodeKey: string, inputKey: string, direction: -1 | 1) => {
      const node = videoComposerNodes.find((candidate) => candidate.key === nodeKey);
      const inputs = videoComposerInputsByNode.get(nodeKey) ?? [];
      if (!node) return;
      const order = inputs.map((input) => input.key);
      const index = order.indexOf(inputKey);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= order.length) return;
      [order[index], order[nextIndex]] = [order[nextIndex]!, order[index]!];
      updateVideoComposerConfig(nodeKey, { ...node.config, inputOrder: order });
    },
    [updateVideoComposerConfig, videoComposerInputsByNode, videoComposerNodes],
  );

  /**
   * 桌面端 FFmpeg 合成路径：交给 Rust 后端确定性完成（不再实时重放录制），
   * 启动后轮询任务进度；引擎缺失时后端会先自动下载官方构建。
   */
  const runFfmpegComposition = useCallback(
    async (
      nodeKey: string,
      node: VideoComposerNodeData,
      inputs: readonly VideoComposerInput[],
      abortController: AbortController,
    ): Promise<void> => {
      const job = await videoComposerClient.startComposition(
        inputs.map((input) => ({
          key: input.key,
          name: input.name,
          source: input.ffmpegSource ?? "",
        })),
        node.config.outputName,
      );
      const handleAbort = () => {
        void videoComposerClient.cancelJob(job.jobId).catch(() => undefined);
      };
      abortController.signal.addEventListener("abort", handleAbort, { once: true });
      try {
        let record = job;
        while (record.status === "preparing_engine" || record.status === "processing") {
          await new Promise<void>((resolve) => window.setTimeout(resolve, 500));
          record = await videoComposerClient.getJob(record.jobId);
          const progress = record.progress;
          if (progress != null) {
            setVideoComposerRuns((current) => {
              const previous = current[nodeKey];
              if (previous?.status !== "running" || previous.progress === progress) return current;
              return { ...current, [nodeKey]: { ...previous, progress } };
            });
          }
        }
        if (record.status === "cancelled" || abortController.signal.aborted) {
          throw new DOMException("视频合成已取消。", "AbortError");
        }
        if (record.status !== "completed" || record.finalPath == null) {
          throw new Error(record.error ?? "视频合成失败。");
        }
        const finalPath = record.finalPath;
        const fileName = record.fileName ?? fileNameFromPath(finalPath);
        const taskId = `composition:${Date.now()}:${nodeKey}`;
        const outputKey = outputNodeKey();
        const aspectRatio =
          record.width != null && record.height != null && record.height > 0
            ? record.width / record.height
            : 16 / 9;
        const outputBase: Omit<OutputNodeData, "x" | "y"> = {
          key: outputKey,
          resultKey: `${taskId}#0`,
          sourceNodeId: nodeKey,
          taskId,
          mediaType: "video",
          origin: "composition",
          finalPath,
          previewSrc: toMediaSrc(finalPath),
          name: fileName,
          aspectRatio,
        };
        addOutput((current) => ({
          ...outputBase,
          ...nextVideoComposerOutputSlot(node, current),
        }));
        setVideoComposerRuns((current) => ({
          ...current,
          [nodeKey]: { status: "done", progress: 100, error: null },
        }));
        frontendLog(
          "info",
          `[composition] FFmpeg 合成完成: node=${nodeKey}, duration=${(record.durationSeconds ?? 0).toFixed(2)}s, output=${finalPath}`,
        );
      } finally {
        abortController.signal.removeEventListener("abort", handleAbort);
      }
    },
    [addOutput, setVideoComposerRuns],
  );

  const handleComposeVideos = useCallback(
    (nodeKey: string) => {
      const node = videoComposerNodes.find((candidate) => candidate.key === nodeKey);
      const inputs = videoComposerInputsByNode.get(nodeKey) ?? [];
      if (!node || videoComposerRuns[nodeKey]?.status === "running") return;
      if (inputs.length < 2) {
        setVideoComposerRuns((current) => ({
          ...current,
          [nodeKey]: { status: "error", progress: 0, error: "至少连接 2 段视频后才能合成。" },
        }));
        return;
      }
      setVideoComposerRuns((current) => ({
        ...current,
        [nodeKey]: { status: "running", progress: 0, error: null },
      }));
      const abortController = new AbortController();
      videoComposerAbortControllersRef.current.set(nodeKey, abortController);
      frontendLog("info", `[composition] 开始视频合成: node=${nodeKey}, inputs=${inputs.length}`);
      // 桌面端且全部输入可交给 ffmpeg（本地文件/远程地址）时走 Rust 合成；
      // 含会话内 blob 预览的输入回退 WebView MediaRecorder 实时录制。
      if (isDesktopRuntime() && inputs.every((input) => input.ffmpegSource != null)) {
        void runFfmpegComposition(nodeKey, node, inputs, abortController)
          .catch((error: unknown) => {
            if (error instanceof DOMException && error.name === "AbortError") {
              frontendLog("info", `[composition] 视频合成已取消: node=${nodeKey}`);
              return;
            }
            const message = formatRawBackendError(error);
            setVideoComposerRuns((current) => ({
              ...current,
              [nodeKey]: { status: "error", progress: 0, error: message },
            }));
            frontendLog("error", `[composition] FFmpeg 合成失败: node=${nodeKey}, ${message}`);
          })
          .finally(() => {
            if (videoComposerAbortControllersRef.current.get(nodeKey) === abortController) {
              videoComposerAbortControllersRef.current.delete(nodeKey);
            }
          });
        return;
      }
      let objectUrls: readonly string[] = [];
      void materializeCompositionInputs(inputs)
        .then((materialized) => {
          objectUrls = materialized.objectUrls;
          return composeVideosInOrder(materialized.inputs, {
            signal: abortController.signal,
            onProgress: (progress) => {
              setVideoComposerRuns((current) => {
                const previous = current[nodeKey];
                if (previous?.status !== "running" || previous.progress === progress)
                  return current;
                return { ...current, [nodeKey]: { ...previous, progress } };
              });
            },
          });
        })
        .then(async (result) => {
          if (abortController.signal.aborted)
            throw new DOMException("视频合成已取消。", "AbortError");
          const fileName = composedVideoFileName(node.config.outputName, result.format.extension);
          const saved = await saveComposedVideoBlob(result.blob, fileName);
          if (abortController.signal.aborted) {
            if (saved.previewSrc?.startsWith("blob:")) URL.revokeObjectURL(saved.previewSrc);
            throw new DOMException("视频合成已取消。", "AbortError");
          }
          const taskId = `composition:${Date.now()}:${nodeKey}`;
          const savedFileName = saved.finalPath ? fileNameFromPath(saved.finalPath) : fileName;
          const outputKey = outputNodeKey();
          const outputBase: Omit<OutputNodeData, "x" | "y"> = {
            key: outputKey,
            resultKey: `${taskId}#0`,
            sourceNodeId: nodeKey,
            taskId,
            mediaType: "video",
            origin: "composition",
            finalPath: saved.finalPath,
            previewSrc: saved.previewSrc,
            name: savedFileName,
            aspectRatio: result.width / result.height,
          };
          addOutput((current) => ({
            ...outputBase,
            ...nextVideoComposerOutputSlot(node, current),
          }));
          setVideoComposerRuns((current) => ({
            ...current,
            [nodeKey]: { status: "done", progress: 100, error: null },
          }));
          frontendLog(
            "info",
            `[composition] 视频合成完成: node=${nodeKey}, duration=${result.duration.toFixed(2)}s, output=${saved.finalPath ?? fileName}`,
          );
        })
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === "AbortError") {
            frontendLog("info", `[composition] 视频合成已取消: node=${nodeKey}`);
            return;
          }
          const message = formatRawBackendError(error);
          setVideoComposerRuns((current) => ({
            ...current,
            [nodeKey]: { status: "error", progress: 0, error: message },
          }));
          frontendLog("error", `[composition] 视频合成失败: node=${nodeKey}, ${message}`);
        })
        .finally(() => {
          for (const url of objectUrls) URL.revokeObjectURL(url);
          if (videoComposerAbortControllersRef.current.get(nodeKey) === abortController) {
            videoComposerAbortControllersRef.current.delete(nodeKey);
          }
        });
    },
    [
      videoComposerInputsByNode,
      videoComposerNodes,
      videoComposerRuns,
      runFfmpegComposition,
      addOutput,
    ],
  );

  // ---------- 网络爆款视频下载（内置 yt-dlp 引擎） ----------

  const refreshDownloaderEngineStatus = useCallback(() => {
    if (!isDesktopRuntime()) return;
    videoDownloaderClient
      .getEngine()
      .then((status) => setDownloaderEngineStatus(status))
      .catch((error: unknown) => {
        frontendLog("error", `[downloader] 引擎状态获取失败: ${formatRawBackendError(error)}`);
      });
  }, []);

  // 画布上第一次出现下载节点时加载引擎状态；之后由操作结果直接更新。
  useEffect(() => {
    if (videoDownloaderNodes.length === 0 || downloaderEngineLoadedRef.current) return;
    downloaderEngineLoadedRef.current = true;
    refreshDownloaderEngineStatus();
  }, [refreshDownloaderEngineStatus, videoDownloaderNodes.length]);

  const runDownloaderEngineOperation = useCallback(
    (operation: "install" | "update") => {
      if (downloaderEngineBusy) return;
      setDownloaderEngineBusy(true);
      frontendLog(
        "info",
        `[downloader] 开始${operation === "install" ? "安装" : "更新"} yt-dlp 引擎…`,
      );
      const request =
        operation === "install"
          ? videoDownloaderClient.installEngine()
          : videoDownloaderClient.updateEngine();
      request
        .then((status) => {
          setDownloaderEngineStatus(status);
          frontendLog(
            "info",
            `[downloader] 引擎${operation === "install" ? "安装" : "更新"}${status.state === "ready" ? "完成" : "未完成"}: state=${status.state}, version=${status.version ?? "未知"}`,
          );
        })
        .catch((error: unknown) => {
          frontendLog("error", `[downloader] 引擎操作失败: ${formatRawBackendError(error)}`);
          refreshDownloaderEngineStatus();
        })
        .finally(() => setDownloaderEngineBusy(false));
    },
    [downloaderEngineBusy, refreshDownloaderEngineStatus],
  );

  const prepareDownloaderEngine = useCallback(
    () => runDownloaderEngineOperation("install"),
    [runDownloaderEngineOperation],
  );

  const updateDownloaderEngine = useCallback(
    () => runDownloaderEngineOperation("update"),
    [runDownloaderEngineOperation],
  );

  const importDownloaderCookies = useCallback(() => {
    void (async () => {
      try {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const selection = await open({
          multiple: false,
          directory: false,
          title: "选择浏览器导出的 cookies.txt",
          filters: [{ name: "Cookies 文件", extensions: ["txt"] }],
        });
        if (typeof selection !== "string" || selection.length === 0) return;
        const status = await videoDownloaderClient.importCookies(selection);
        setDownloaderEngineStatus(status);
        toast.success("下载登录凭据已导入，可以重试下载步骤");
        frontendLog("info", "[downloader] Cookies 已导入，抖音下载将自动携带");
      } catch (error: unknown) {
        frontendLog("error", `[downloader] Cookies 导入失败: ${formatRawBackendError(error)}`);
        toast.error("下载登录凭据导入失败", { description: formatWorkflowError(error) });
      }
    })();
  }, []);

  const clearDownloaderCookies = useCallback(() => {
    videoDownloaderClient
      .clearCookies()
      .then((status) => {
        setDownloaderEngineStatus(status);
        frontendLog("info", "[downloader] Cookies 已清除");
      })
      .catch((error: unknown) => {
        frontendLog("error", `[downloader] Cookies 清除失败: ${formatRawBackendError(error)}`);
      });
  }, []);

  /** 打开该节点最近一次下载产物所在文件夹。 */
  const revealDownloaderResult = useCallback(
    (nodeKey: string) => {
      const latest = outputNodes
        .filter((node) => node.sourceNodeId === nodeKey && node.finalPath != null)
        .at(-1);
      if (latest?.finalPath && isDesktopRuntime()) {
        void revealDesktopItem(latest.finalPath).catch(() => undefined);
      }
    },
    [outputNodes],
  );

  // 活动下载任务（运行中且已拿到 jobId）：查询 key 随该集合变化，任务到达
  // 终态后离开集合，轮询随之停止；定时与清理由 React Query 管理。
  const activeDownloadJobs = useMemo(
    () =>
      Object.entries(videoDownloaderRuns)
        .filter(([, run]) => run.status === "running" && run.jobId.length > 0)
        .map(([nodeKey, run]) => ({ nodeKey, jobId: run.jobId })),
    [videoDownloaderRuns],
  );
  // 查询仅负责拉取与定时；终态处理通过下方对 Query 缓存的订阅完成。
  useQuery({
    queryKey: ["video-download-jobs", activeDownloadJobs],
    queryFn: async (): Promise<
      readonly {
        nodeKey: string;
        jobId: string;
        job: VideoDownloadJobRecord | null;
        error: string | null;
      }[]
    > =>
      Promise.all(
        activeDownloadJobs.map(async ({ nodeKey, jobId }) => {
          try {
            return { nodeKey, jobId, job: await videoDownloaderClient.getJob(jobId), error: null };
          } catch (error: unknown) {
            return { nodeKey, jobId, job: null, error: formatRawBackendError(error) };
          }
        }),
      ),
    enabled: isDesktopRuntime(),
    refetchInterval: activeDownloadJobs.length > 0 ? DOWNLOAD_POLL_INTERVAL_MS : false,
  });

  // 下载任务的终态只能处理一次：产物卡片落卡、运行状态收尾都在这里完成。
  // 订阅 Query 缓存而非在 effect 体里同步 setState；若某次终态事件恰好落在
  // 依赖变化导致的重订阅间隙，下一轮轮询会携带同一份终态数据再次触发兜底。
  const handledDownloadJobIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const cache = queryClient.getQueryCache();
    return cache.subscribe((event) => {
      if (event.type !== "updated") return;
      const [cacheKey] = event.query.queryKey as readonly unknown[];
      if (typeof cacheKey !== "string" || cacheKey !== "video-download-jobs") return;
      const results = event.query.state.data as
        | readonly {
            nodeKey: string;
            jobId: string;
            job: VideoDownloadJobRecord | null;
            error: string | null;
          }[]
        | undefined;
      if (results == null) return;
      for (const { nodeKey, jobId, job, error } of results) {
        // 运行中：推进进度（updater 内用 jobId 守卫，节点换任务后旧结果不写入）。
        if (job != null && (job.status === "preparing_engine" || job.status === "downloading")) {
          const preparingEngine = job.status === "preparing_engine";
          setVideoDownloaderRuns((current) => {
            const previous = current[nodeKey];
            if (previous?.jobId !== jobId) return current;
            if (
              previous.status === "running" &&
              previous.preparingEngine === preparingEngine &&
              previous.progress === job.progress
            ) {
              return current;
            }
            return {
              ...current,
              [nodeKey]: {
                jobId,
                status: "running",
                preparingEngine,
                progress: job.progress,
                qualityHint: job.qualityHint,
                watermarkRemoved: job.watermarkRemoved,
                error: null,
              },
            };
          });
          continue;
        }
        // 终态（完成/取消/失败/查询失败）：每个 job 只处理一次。
        if (handledDownloadJobIdsRef.current.has(jobId)) continue;
        handledDownloadJobIdsRef.current.add(jobId);
        if (job != null && job.status === "completed" && job.finalPath != null) {
          const fileName = job.fileName ?? fileNameFromPath(job.finalPath);
          const outputKey = outputNodeKey();
          const startNode =
            videoDownloaderStartNodesRef.current.get(nodeKey) ??
            videoDownloaderNodes.find((node) => node.key === nodeKey);
          if (startNode == null) {
            // 会话内快照与运行状态总是成对创建；此分支仅防御性兜底。
            frontendLog("error", `[downloader] 下载完成但节点快照缺失，跳过落卡: node=${nodeKey}`);
          } else {
            addOutput((current) => ({
              key: outputKey,
              resultKey: null,
              sourceNodeId: nodeKey,
              taskId: job.jobId,
              mediaType: "video",
              origin: "download",
              finalPath: job.finalPath,
              previewSrc: null,
              name: fileName,
              ...nextVideoDownloaderOutputSlot(startNode, current),
            }));
          }
          setVideoDownloaderRuns((current) => {
            const previous = current[nodeKey];
            if (previous?.jobId !== jobId) return current;
            return {
              ...current,
              [nodeKey]: {
                jobId,
                status: "done",
                preparingEngine: false,
                progress: 100,
                qualityHint: job.qualityHint,
                watermarkRemoved: job.watermarkRemoved,
                error: null,
              },
            };
          });
          frontendLog("info", `[downloader] 视频下载完成: node=${nodeKey}, 文件=${fileName}`);
          continue;
        }
        if (job != null && job.status === "cancelled") {
          setVideoDownloaderRuns((current) => {
            const previous = current[nodeKey];
            if (previous?.jobId !== jobId) return current;
            return {
              ...current,
              [nodeKey]: {
                jobId,
                status: "cancelled",
                preparingEngine: false,
                progress: null,
                qualityHint: null,
                watermarkRemoved: false,
                error: null,
              },
            };
          });
          frontendLog("info", `[downloader] 视频下载已取消: node=${nodeKey}`);
          continue;
        }
        const message =
          job == null
            ? (error ?? "下载失败，请稍后重试。")
            : (job.error ?? "下载失败，请稍后重试。");
        setVideoDownloaderRuns((current) => {
          const previous = current[nodeKey];
          if (previous?.jobId !== jobId) return current;
          return {
            ...current,
            [nodeKey]: {
              jobId,
              status: "error",
              preparingEngine: false,
              progress: null,
              qualityHint: job?.qualityHint ?? null,
              watermarkRemoved: job?.watermarkRemoved ?? false,
              error: message,
            },
          };
        });
        frontendLog("error", `[downloader] 视频下载失败: node=${nodeKey}, ${message}`);
      }
    });
  }, [addOutput, queryClient, videoDownloaderNodes]);

  const handleStartVideoDownload = useCallback(
    (nodeKey: string) => {
      const node = videoDownloaderNodes.find((candidate) => candidate.key === nodeKey);
      if (!node || videoDownloaderRuns[nodeKey]?.status === "running") return;
      const url = node.config.url.trim();
      if (url.length === 0) {
        setVideoDownloaderRuns((current) => ({
          ...current,
          [nodeKey]: {
            jobId: "",
            status: "error",
            preparingEngine: false,
            progress: null,
            qualityHint: null,
            watermarkRemoved: false,
            error: "请先粘贴要下载的视频链接。",
          },
        }));
        return;
      }
      setVideoDownloaderRuns((current) => ({
        ...current,
        [nodeKey]: {
          jobId: "",
          status: "running",
          preparingEngine: false,
          progress: null,
          qualityHint: null,
          watermarkRemoved: false,
          error: null,
        },
      }));
      videoDownloaderClient
        .startDownload(url)
        .then((record) => {
          setVideoDownloaderRuns((current) => {
            const previous = current[nodeKey];
            if (previous?.status !== "running") return current;
            return { ...current, [nodeKey]: { ...previous, jobId: record.jobId } };
          });
          // 查询按活动任务集合自动开始轮询；这里只记下启动时节点快照供落卡定位。
          videoDownloaderStartNodesRef.current.set(nodeKey, node);
          frontendLog("info", `[downloader] 下载任务已提交: node=${nodeKey}, job=${record.jobId}`);
        })
        .catch((error: unknown) => {
          setVideoDownloaderRuns((current) => {
            const previous = current[nodeKey];
            if (previous?.status !== "running") return current;
            return {
              ...current,
              [nodeKey]: {
                ...previous,
                status: "error",
                error: formatRawBackendError(error),
              },
            };
          });
          frontendLog("error", `[downloader] 下载任务提交失败: ${formatRawBackendError(error)}`);
        });
    },
    [videoDownloaderNodes, videoDownloaderRuns],
  );

  const handleCancelVideoDownload = useCallback(
    (nodeKey: string) => {
      const run = videoDownloaderRuns[nodeKey];
      if (run?.status !== "running" || run.jobId.length === 0) return;
      videoDownloaderClient.cancelJob(run.jobId).catch((error: unknown) => {
        frontendLog("error", `[downloader] 取消请求失败: ${formatRawBackendError(error)}`);
      });
    },
    [videoDownloaderRuns],
  );

  /** 删除视频下载节点（保留已经生成的产物卡片）。 */
  const removeVideoDownloaderNode = useCallback(
    (key: string) => {
      videoDownloaderStartNodesRef.current.delete(key);
      const run = videoDownloaderRuns[key];
      if (run?.status === "running" && run.jobId.length > 0) {
        void videoDownloaderClient.cancelJob(run.jobId).catch(() => undefined);
      }
      removeCanvasNode(key);
      setVideoDownloaderRuns((current) => {
        if (!(key in current)) return current;
        const next = { ...current };
        delete next[key];
        return next;
      });
    },
    [removeCanvasNode, videoDownloaderRuns],
  );

  // ---- 视频抽帧：任务轮询与终态落卡 ----

  // 活动抽帧任务：查询 key 随运行任务集合变化，任务到终态后离开集合停止轮询。
  const activeFrameExtractionJobs = useMemo(
    () =>
      Object.entries(frameExtractorRuns)
        .filter(([, run]) => run.status === "running" && run.jobId.length > 0)
        .map(([nodeKey, run]) => ({ nodeKey, jobId: run.jobId })),
    [frameExtractorRuns],
  );
  useQuery({
    queryKey: ["video-frame-extraction-jobs", activeFrameExtractionJobs],
    queryFn: async (): Promise<
      readonly {
        nodeKey: string;
        jobId: string;
        job: VideoFrameExtractionJobRecord | null;
        error: string | null;
      }[]
    > =>
      Promise.all(
        activeFrameExtractionJobs.map(async ({ nodeKey, jobId }) => {
          try {
            return {
              nodeKey,
              jobId,
              job: await videoFrameExtractionClient.getJob(jobId),
              error: null,
            };
          } catch (error: unknown) {
            return { nodeKey, jobId, job: null, error: formatRawBackendError(error) };
          }
        }),
      ),
    enabled: isDesktopRuntime(),
    refetchInterval: activeFrameExtractionJobs.length > 0 ? DOWNLOAD_POLL_INTERVAL_MS : false,
  });

  // 抽帧终态只处理一次：每帧落一张 origin=frame_extract 的图片产物卡片。
  const handledFrameExtractionJobIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const cache = queryClient.getQueryCache();
    return cache.subscribe((event) => {
      if (event.type !== "updated") return;
      const [cacheKey] = event.query.queryKey as readonly unknown[];
      if (typeof cacheKey !== "string" || cacheKey !== "video-frame-extraction-jobs") return;
      const results = event.query.state.data as
        | readonly {
            nodeKey: string;
            jobId: string;
            job: VideoFrameExtractionJobRecord | null;
            error: string | null;
          }[]
        | undefined;
      if (results == null) return;
      for (const { nodeKey, jobId, job, error } of results) {
        if (job != null && (job.status === "preparing_engine" || job.status === "processing")) {
          const preparingEngine = job.status === "preparing_engine";
          setFrameExtractorRuns((current) => {
            const previous = current[nodeKey];
            if (previous?.jobId !== jobId) return current;
            if (
              previous.status === "running" &&
              previous.preparingEngine === preparingEngine &&
              previous.progress === job.progress
            ) {
              return current;
            }
            return {
              ...current,
              [nodeKey]: {
                jobId,
                status: "running",
                preparingEngine,
                progress: job.progress,
                error: null,
              },
            };
          });
          continue;
        }
        if (handledFrameExtractionJobIdsRef.current.has(jobId)) continue;
        handledFrameExtractionJobIdsRef.current.add(jobId);
        if (job != null && job.status === "completed") {
          const startNode =
            frameExtractorStartNodesRef.current.get(nodeKey) ??
            frameExtractorNodes.find((candidate) => candidate.key === nodeKey);
          if (startNode == null) {
            frontendLog(
              "error",
              `[frame-extractor] 抽帧完成但节点快照缺失，跳过落卡: node=${nodeKey}`,
            );
          } else {
            for (const frame of job.frames) {
              addOutput((current) => ({
                key: outputNodeKey(),
                resultKey: null,
                sourceNodeId: nodeKey,
                taskId: jobId,
                mediaType: "image",
                origin: "frame_extract",
                finalPath: frame.path,
                previewSrc: null,
                name: fileNameFromPath(frame.path),
                ...nextFrameExtractorOutputSlot(startNode, current),
              }));
            }
          }
          setFrameExtractorRuns((current) => {
            const previous = current[nodeKey];
            if (previous?.jobId !== jobId) return current;
            return {
              ...current,
              [nodeKey]: {
                jobId,
                status: "done",
                preparingEngine: false,
                progress: 100,
                error: null,
              },
            };
          });
          frontendLog(
            "info",
            `[frame-extractor] 视频抽帧完成: node=${nodeKey}, 帧数=${job.frames.length}`,
          );
          continue;
        }
        if (job != null && job.status === "cancelled") {
          setFrameExtractorRuns((current) => {
            const previous = current[nodeKey];
            if (previous?.jobId !== jobId) return current;
            return {
              ...current,
              [nodeKey]: {
                jobId,
                status: "cancelled",
                preparingEngine: false,
                progress: null,
                error: null,
              },
            };
          });
          frontendLog("info", `[frame-extractor] 视频抽帧已取消: node=${nodeKey}`);
          continue;
        }
        const message =
          job == null
            ? (error ?? "抽帧失败，请稍后重试。")
            : (job.error ?? "抽帧失败，请稍后重试。");
        setFrameExtractorRuns((current) => {
          const previous = current[nodeKey];
          if (previous?.jobId !== jobId) return current;
          return {
            ...current,
            [nodeKey]: {
              jobId,
              status: "error",
              preparingEngine: false,
              progress: null,
              error: message,
            },
          };
        });
        frontendLog("error", `[frame-extractor] 视频抽帧失败: node=${nodeKey}, ${message}`);
      }
    });
  }, [addOutput, queryClient, frameExtractorNodes]);

  /** 开始抽帧：解析视频来源（连线优先，其次节点内手动路径），提交后端任务。 */
  const handleStartFrameExtraction = useCallback(
    (nodeKey: string) => {
      // 注意：config 变化必须读节点列表（typeNodes，永远新鲜）；frameExtractorNodeByKey 是
      // 连线派生投影，对 config 变化会复用旧节点对象，会导致抽帧秒数读取为空。
      const node = frameExtractorNodes.find((candidate) => candidate.key === nodeKey);
      if (!node || frameExtractorRuns[nodeKey]?.status === "running") return;
      const inputs = frameExtractorInputsByNode.get(nodeKey) ?? [];
      const connected = inputs[0];
      const source =
        connected ??
        (node.config.videoPath.trim().length > 0
          ? {
              key: "manual",
              name: fileNameFromPath(node.config.videoPath.trim()),
              src: node.config.videoPath.trim(),
              sourceLabel: "素材" as const,
              edgeId: "",
              finalPath: node.config.videoPath.trim(),
            }
          : null);
      if (source == null) {
        setFrameExtractorRuns((current) => ({
          ...current,
          [nodeKey]: {
            jobId: "",
            status: "error",
            preparingEngine: false,
            progress: null,
            error: "请先连入视频（素材/下载/合成产物）或填写视频文件路径。",
          },
        }));
        return;
      }
      if (source.finalPath == null) {
        setFrameExtractorRuns((current) => ({
          ...current,
          [nodeKey]: {
            jobId: "",
            status: "error",
            preparingEngine: false,
            progress: null,
            error: "当前视频来源不是本地文件，暂无法抽帧。",
          },
        }));
        return;
      }
      const timestamps = node.config.timestamps;
      if (timestamps.length === 0) {
        setFrameExtractorRuns((current) => ({
          ...current,
          [nodeKey]: {
            jobId: "",
            status: "error",
            preparingEngine: false,
            progress: null,
            error: "请先添加至少一个抽帧秒数。",
          },
        }));
        return;
      }
      setFrameExtractorRuns((current) => ({
        ...current,
        [nodeKey]: {
          jobId: "",
          status: "running",
          preparingEngine: false,
          progress: null,
          error: null,
        },
      }));
      videoFrameExtractionClient
        .startExtraction(source.finalPath, timestamps)
        .then((record) => {
          setFrameExtractorRuns((current) => {
            const previous = current[nodeKey];
            if (previous?.status !== "running") return current;
            return { ...current, [nodeKey]: { ...previous, jobId: record.jobId } };
          });
          frameExtractorStartNodesRef.current.set(nodeKey, node);
          frontendLog(
            "info",
            `[frame-extractor] 抽帧任务已提交: node=${nodeKey}, job=${record.jobId}`,
          );
        })
        .catch((error: unknown) => {
          setFrameExtractorRuns((current) => {
            const previous = current[nodeKey];
            if (previous?.status !== "running") return current;
            return {
              ...current,
              [nodeKey]: {
                ...previous,
                status: "error",
                error: formatRawBackendError(error),
              },
            };
          });
          frontendLog(
            "error",
            `[frame-extractor] 抽帧任务提交失败: ${formatRawBackendError(error)}`,
          );
        });
    },
    [frameExtractorNodes, frameExtractorInputsByNode, frameExtractorRuns],
  );

  const handleCancelFrameExtraction = useCallback(
    (nodeKey: string) => {
      const run = frameExtractorRuns[nodeKey];
      if (run?.status !== "running" || run.jobId.length === 0) return;
      videoFrameExtractionClient.cancelJob(run.jobId).catch((error: unknown) => {
        frontendLog("error", `[frame-extractor] 取消请求失败: ${formatRawBackendError(error)}`);
      });
    },
    [frameExtractorRuns],
  );

  /** 删除视频抽帧节点（保留已经生成的图片产物卡片）。 */
  const removeFrameExtractorNode = useCallback(
    (key: string) => {
      frameExtractorStartNodesRef.current.delete(key);
      const run = frameExtractorRuns[key];
      if (run?.status === "running" && run.jobId.length > 0) {
        void videoFrameExtractionClient.cancelJob(run.jobId).catch(() => undefined);
      }
      removeCanvasNode(key);
      setFrameExtractorRuns((current) => {
        if (!(key in current)) return current;
        const next = { ...current };
        delete next[key];
        return next;
      });
    },
    [removeCanvasNode, frameExtractorRuns],
  );

  /** 视频节点从上游提示词节点继承的视觉参考图；这是连线派生数据，不额外写入画布文档。 */
  const inheritedInputsByNode = useMemo(() => {
    const map = new Map<string, InheritedAssetInput[]>();
    for (const node of genTopologyByKey.values()) {
      if (node.kind !== "video") continue;
      const inherited = inheritedVideoAssetInputs(
        node.key,
        canvasEdgeIndex.byTarget,
        assetNodeByKey,
        genTopologyByKey,
      ).map(({ node: asset, promptNodeKey }) => ({
        key: asset.key,
        name: asset.name,
        kind: asset.kind,
        promptNodeKey,
      }));
      if (inherited.length > 0) map.set(node.key, inherited);
    }
    return map;
  }, [assetNodeByKey, canvasEdgeIndex, genTopologyByKey]);

  /** 每个图片/视频节点当前接入的提示词节点（同一目标只保留最后一条）。 */
  const promptSourceByTarget = useMemo(() => {
    const map = new Map<string, Extract<GenNodeData, { kind: "prompt" }>>();
    for (const edge of assetEdges) {
      const source = genNodeByKey.get(edge.fromKey);
      const target = genTopologyByKey.get(edge.toKey);
      if (source?.kind === "prompt" && target && target.kind !== "prompt") {
        map.set(target.key, source);
      }
    }
    return map;
  }, [assetEdges, genNodeByKey, genTopologyByKey]);

  /** 提示词节点输出端显示的下游目标，供节点内解除单条连线。 */
  const promptTargetsBySource = useMemo(() => {
    const map = new Map<
      string,
      { key: string; name: string; kind: "image" | "video"; edgeId: string }[]
    >();
    for (const edge of assetEdges) {
      const source = genTopologyByKey.get(edge.fromKey);
      const target = genTopologyByKey.get(edge.toKey);
      if (source?.kind !== "prompt" || !target || target.kind === "prompt") continue;
      const list = map.get(source.key) ?? [];
      list.push({
        key: target.key,
        name: `${target.kind === "image" ? "图片" : "视频"}生成 ${target.key.slice(-6)}`,
        kind: target.kind,
        edgeId: edge.id,
      });
      map.set(source.key, list);
    }
    return map;
  }, [assetEdges, genTopologyByKey]);

  /** 某生成节点的 @ 候选：直连素材 + 视频节点随提示词继承的参考图，保持请求传入顺序。 */
  const mentionCandidatesFor = useCallback(
    (nodeKey: string): readonly MentionCandidate[] => {
      return generationInputs(nodeKey).map(generationInputMentionCandidate);
    },
    [generationInputs],
  );

  /** 提示词节点输出变化或新建连线后，自动导入目标生成节点的提示内容。 */
  useEffect(() => {
    if (!canvasHydrated) return;
    const importedSources = importedPromptSourcesRef.current;
    for (const targetKey of importedSources.keys()) {
      if (!promptSourceByTarget.has(targetKey)) importedSources.delete(targetKey);
    }
    for (const [targetKey, source] of promptSourceByTarget) {
      const edgeId = assetEdges.find(
        (edge) => edge.fromKey === source.key && edge.toKey === targetKey,
      )?.id;
      if (edgeId == null) continue;
      const previous = importedSources.get(targetKey);
      const sourceText = source.config.generatedPrompt;
      if (
        previous?.edgeId === edgeId &&
        previous.sourceKey === source.key &&
        previous.text === sourceText
      )
        continue;
      const generatedPrompt = source.config.generatedPrompt.trim();
      if (!generatedPrompt) {
        importedSources.set(targetKey, { edgeId, sourceKey: source.key, text: sourceText });
        continue;
      }
      const replaced = promptContents.replaceText(
        targetKey,
        generatedPrompt,
        mentionCandidatesFor(targetKey),
      );
      if (replaced == null) continue;
      importedSources.set(targetKey, { edgeId, sourceKey: source.key, text: sourceText });
      frontendLog(
        "info",
        `[canvas] 提示词节点输出已导入生成节点: source=${source.key}, target=${targetKey}, 字符 ${generatedPrompt.length}`,
      );
    }
  }, [assetEdges, canvasHydrated, mentionCandidatesFor, promptContents, promptSourceByTarget]);

  const nodeDescriptorContext = useMemo(
    () => ({ providerCatalog, nodeModelSelections }),
    [providerCatalog, nodeModelSelections],
  );

  const deferredAssetSearch = useDeferredValue(assetSearch);
  const normalizedAssetSearch = deferredAssetSearch.trim().toLowerCase();
  const assetSearchPending = assetSearch !== deferredAssetSearch;
  const visibleAssets = useMemo(
    () =>
      libraryAssets.filter(
        (asset) =>
          asset.kind === assetKind && asset.name.toLowerCase().includes(normalizedAssetSearch),
      ),
    [assetKind, libraryAssets, normalizedAssetSearch],
  );
  const assetResultKey = `${assetLibrarySource}\u0000${assetProvider?.id ?? "local"}\u0000${assetKind}\u0000${normalizedAssetSearch}`;
  const assetRenderLimit =
    assetRenderPage.key === assetResultKey ? assetRenderPage.limit : ASSET_RENDER_BATCH_SIZE;
  const renderedAssets = useMemo(
    () => visibleAssets.slice(0, assetRenderLimit),
    [assetRenderLimit, visibleAssets],
  );
  const remainingAssetCount = visibleAssets.length - renderedAssets.length;
  const loadMoreAssets = useCallback(() => {
    setAssetRenderPage((current) => ({
      key: assetResultKey,
      limit: Math.min(
        visibleAssets.length,
        (current.key === assetResultKey ? current.limit : ASSET_RENDER_BATCH_SIZE) +
          ASSET_RENDER_BATCH_SIZE,
      ),
    }));
  }, [assetResultKey, visibleAssets.length]);
  const handlePreviewAsset = useCallback((asset: AssetItem) => setPreviewAsset(asset), []);
  const handleDropAssetToCanvas = useCallback(
    (asset: AssetItem, clientX: number, clientY: number) => {
      const point = dropClientPointToBoard(clientX, clientY);
      if (point == null) return;
      addAssetNode(asset, point.x, point.y);
    },
    [addAssetNode, dropClientPointToBoard],
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
            }
          },
          (error: unknown) => {
            const formatted = formatRawBackendError(error);
            frontendLog(
              "error",
              `[assets] 云端素材删除失败: providerConnectionId=${asset.providerConnectionId}, assetId=${asset.id}, 错误: ${formatted}`,
            );
            setAssetsError(error instanceof Error ? error.message : formatted);
          },
        );
    },
    [assetProvider, refreshAssetGroups, refreshCloudAssets],
  );

  const previewOutputNode =
    outputNodes.find(
      (node) =>
        node.key === previewOutputNodeKey && (node.finalPath != null || node.previewSrc != null),
    ) ?? null;

  const closeMobilePanel = () => {
    setMobilePanel(null);
    window.requestAnimationFrame(() => mobilePanelTriggerRef.current?.focus());
  };

  const closeSettings = () => {
    setSettingsOpen(false);
    window.requestAnimationFrame(() => settingsTriggerRef.current?.focus());
  };

  const closeHistory = () => setHistoryOpen(false);

  const toggleMobilePanel = (panel: Exclude<MobilePanel, null>, trigger: HTMLButtonElement) => {
    if (mobilePanel === panel) {
      closeMobilePanel();
      return;
    }

    mobilePanelTriggerRef.current = trigger;
    setMobilePanel(panel);
  };

  useEffect(() => {
    if (!mobilePanel || !window.matchMedia?.("(max-width: 59.999rem)").matches) return;

    const closeButton = document.querySelector<HTMLButtonElement>(
      mobilePanel === "nodes" ? ".mobile-panel-close--nodes" : ".mobile-panel-close--assets",
    );
    const animationFrame = window.requestAnimationFrame(() => closeButton?.focus());

    return () => window.cancelAnimationFrame(animationFrame);
  }, [mobilePanel]);

  useHotkeys(
    "esc",
    () => {
      setMobilePanel(null);
      window.requestAnimationFrame(() => mobilePanelTriggerRef.current?.focus());
    },
    { enabled: !settingsOpen },
    [settingsOpen],
  );

  // 文本输入框内默认不触发这些快捷键，继续使用浏览器原生的文本撤销行为。
  useHotkeys(
    ["mod+z", "mod+shift+z", "mod+y"],
    (_event, hotkey) => {
      if (hotkey.hotkey === "mod+z") undo();
      else redo();
    },
    { enabled: !settingsOpen, preventDefault: true },
    [settingsOpen, undo, redo],
  );

  useHotkeys(
    ["+", "=", "-", "0"],
    (event) => {
      if (event.key === "+" || event.key === "=") {
        zoomAroundViewportCenter(viewRef.current.zoom + ZOOM_STEP);
      } else if (event.key === "-") {
        zoomAroundViewportCenter(viewRef.current.zoom - ZOOM_STEP);
      } else {
        zoomAroundViewportCenter(DEFAULT_ZOOM);
      }
    },
    {
      enabled: !settingsOpen,
      preventDefault: true,
      splitKey: "_",
      useKey: true,
    },
    [settingsOpen, zoomAroundViewportCenter],
  );

  const ignoreLegacyNodeDrag = useCallback(() => undefined, []);
  const ignoreLegacyConnectionStart = useCallback(() => undefined, []);

  const assetFlowNodes = useMemo<CanvasFlowNode[]>(
    () =>
      assetNodes.map((node): CanvasFlowNode => ({
        id: node.key,
        type: "canvas",
        position: { x: node.x, y: node.y },
        ...measuredFor(node),
        selected: selectedNodeKey === node.key,
        data: {
          hasSourceHandle: true,
          hasTargetHandle: true,
          content: (
            <CanvasAssetNode
              key={node.key}
              node={node}
              edgeCount={canvasEdgeIndex.countByNode.get(node.key) ?? 0}
              dragging={false}
              onNodeDragStart={ignoreLegacyNodeDrag}
              onConnectionStart={ignoreLegacyConnectionStart}
              onRemove={removeAssetNode}
              onAspectRatioChange={handleAssetAspectRatioChange}
            />
          ),
        },
      })),
    [
      assetNodes,
      canvasEdgeIndex,
      selectedNodeKey,
      ignoreLegacyNodeDrag,
      ignoreLegacyConnectionStart,
      removeAssetNode,
      handleAssetAspectRatioChange,
    ],
  );

  const outputFlowNodes = useMemo<CanvasFlowNode[]>(
    () =>
      outputNodes.map((node): CanvasFlowNode => {
        const task = taskById.get(node.taskId) ?? null;
        return {
          id: node.key,
          type: "canvas",
          position: { x: node.x, y: node.y },
          ...measuredFor(node),
          selected: selectedNodeKey === node.key,
          data: {
            hasSourceHandle: true,
            hasTargetHandle: true,
            content: (
              <CanvasOutputNode
                key={node.key}
                node={node}
                dragging={false}
                onNodeDragStart={ignoreLegacyNodeDrag}
                onRemove={removeOutputNode}
                onAspectRatioChange={handleOutputAspectRatioChange}
                onPreview={setPreviewOutputNodeKey}
                onConnectionStart={ignoreLegacyConnectionStart}
                task={task}
                retryInfo={retryInfoByTask[node.taskId] ?? null}
                results={taskResults[node.taskId] ?? []}
                rawResponse={rawResponses[node.taskId] ?? null}
                modelLabel={task ? modelDisplayNameForTask(task, providerCatalog) : null}
              />
            ),
          },
        };
      }),
    [
      outputNodes,
      selectedNodeKey,
      taskById,
      ignoreLegacyNodeDrag,
      removeOutputNode,
      handleOutputAspectRatioChange,
      setPreviewOutputNodeKey,
      ignoreLegacyConnectionStart,
      retryInfoByTask,
      taskResults,
      rawResponses,
      providerCatalog,
    ],
  );

  const screenplayFlowNodes = useMemo<CanvasFlowNode[]>(
    () =>
      screenplayNodes.map((node): CanvasFlowNode => ({
        id: node.key,
        type: "canvas",
        position: { x: node.x, y: node.y },
        ...measuredFor(node),
        selected: selectedNodeKey === node.key,
        data: {
          hasSourceHandle: true,
          hasTargetHandle: false,
          content: (
            <CanvasDocumentSkillNode
              key={node.key}
              node={node}
              selected={selectedNodeKey === node.key}
              dragging={false}
              running={startingNodeKeys.has(node.key)}
              error={startErrorsByNode[node.key] ?? null}
              providerCatalog={providerCatalog}
              sourceInput={null}
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
            />
          ),
        },
      })),
    [
      screenplayNodes,
      selectedNodeKey,
      startingNodeKeys,
      startErrorsByNode,
      providerCatalog,
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
    ],
  );

  const storyboardFlowNodes = useMemo<CanvasFlowNode[]>(
    () =>
      storyboardNodes.map((node): CanvasFlowNode => ({
        id: node.key,
        type: "canvas",
        position: { x: node.x, y: node.y },
        ...measuredFor(node),
        selected: selectedNodeKey === node.key,
        data: {
          hasSourceHandle: false,
          hasTargetHandle: true,
          content: (
            <CanvasDocumentSkillNode
              key={node.key}
              node={node}
              selected={selectedNodeKey === node.key}
              dragging={false}
              running={startingNodeKeys.has(node.key)}
              error={startErrorsByNode[node.key] ?? null}
              providerCatalog={providerCatalog}
              sourceInput={screenplayInputByStoryboard.get(node.key) ?? null}
              onSelect={selectNode}
              onNodeDragStart={ignoreLegacyNodeDrag}
              onRemove={removeStoryboardNode}
              onUnlink={removeAssetEdge}
              onSizeChange={handleGenNodeSizeChange}
              onChange={(config) => updateStoryboardNodeConfig(node.key, config)}
              onSend={handleRunStoryboardNode}
              onExport={handleExportStoryboard}
            />
          ),
        },
      })),
    [
      storyboardNodes,
      selectedNodeKey,
      startingNodeKeys,
      startErrorsByNode,
      providerCatalog,
      screenplayInputByStoryboard,
      selectNode,
      ignoreLegacyNodeDrag,
      removeStoryboardNode,
      removeAssetEdge,
      handleGenNodeSizeChange,
      updateStoryboardNodeConfig,
      handleRunStoryboardNode,
      handleExportStoryboard,
    ],
  );

  const knowledgeVideoWorkflowFlowNodes = useMemo<CanvasFlowNode[]>(
    () =>
      knowledgeVideoWorkflowNodes.map((node): CanvasFlowNode => ({
        id: node.key,
        type: "canvas",
        position: { x: node.x, y: node.y },
        ...measuredFor(node),
        selected: selectedNodeKey === node.key,
        data: {
          hasSourceHandle: false,
          hasTargetHandle: true,
          content: (
            <KnowledgeVideoWorkflowNode
              key={node.key}
              node={node}
              connectedInputs={workflowInputsByNode.get(node.key) ?? []}
              onUnlink={removeAssetEdge}
              onRemoveHistoricalReference={(index) =>
                patchNode("knowledgeVideoWorkflow", node.key, (current) => ({
                  ...current,
                  config: {
                    ...current.config,
                    connectedMaterials: (current.config.connectedMaterials ?? []).filter(
                      (_, itemIndex) => itemIndex !== index,
                    ),
                  },
                }))
              }
              providerCatalog={providerCatalog}
              runState={knowledgeVideoWorkflowRuns[node.key] ?? null}
              selected={selectedNodeKey === node.key}
              dragging={false}
              onSelect={selectNode}
              onNodeDragStart={ignoreLegacyNodeDrag}
              onSizeChange={handleGenNodeSizeChange}
              onChange={(config) => updateKnowledgeVideoWorkflowConfig(node.key, config)}
              onExecute={executeKnowledgeVideoWorkflow}
              onContinue={continueKnowledgeVideoWorkflow}
              onCancel={cancelKnowledgeVideoWorkflow}
              onRemove={removeKnowledgeVideoWorkflow}
              onRevealResult={revealKnowledgeVideoWorkflowResult}
              onOpenHistory={openWorkflowHistory}
              onPickMaterials={handlePickWorkflowMaterials}
              onRemoveMaterial={handleRemoveWorkflowMaterial}
              onPickReverseVideo={handlePickReverseVideo}
              onRemoveReverseVideo={handleRemoveReverseVideo}
              onOpenDownloadSettings={importDownloaderCookies}
              onExportFilmDocuments={exportFilmDocuments}
              onExportComicDramaDocuments={exportFilmDocuments}
              onExportCommerceDocuments={exportFilmDocuments}
              onExportRemotionDocuments={exportFilmDocuments}
              onRevealRemotionProject={revealRemotionProject}
              onPickCommerceMaterials={handlePickCommerceMaterials}
              onRemoveCommerceMaterial={handleRemoveCommerceMaterial}
              onPickCoverImages={handlePickCoverImages}
              onRemoveCoverImage={handleRemoveCoverImage}
              onExportCoverDocuments={exportFilmDocuments}
            />
          ),
        },
      })),
    [
      knowledgeVideoWorkflowNodes,
      workflowInputsByNode,
      removeAssetEdge,
      patchNode,
      providerCatalog,
      knowledgeVideoWorkflowRuns,
      selectedNodeKey,
      selectNode,
      ignoreLegacyNodeDrag,
      handleGenNodeSizeChange,
      updateKnowledgeVideoWorkflowConfig,
      executeKnowledgeVideoWorkflow,
      continueKnowledgeVideoWorkflow,
      cancelKnowledgeVideoWorkflow,
      removeKnowledgeVideoWorkflow,
      revealKnowledgeVideoWorkflowResult,
      openWorkflowHistory,
      handlePickWorkflowMaterials,
      handleRemoveWorkflowMaterial,
      handlePickReverseVideo,
      handleRemoveReverseVideo,
      importDownloaderCookies,
      exportFilmDocuments,
      revealRemotionProject,
      handlePickCommerceMaterials,
      handleRemoveCommerceMaterial,
      handlePickCoverImages,
      handleRemoveCoverImage,
    ],
  );

  const viralRemixFlowNodes = useMemo<CanvasFlowNode[]>(
    () =>
      viralRemixNodes.map((node): CanvasFlowNode => ({
        id: node.key,
        type: "canvas",
        position: { x: node.x, y: node.y },
        ...measuredFor(node),
        selected: selectedNodeKey === node.key,
        data: {
          hasSourceHandle: false,
          hasTargetHandle: true,
          content: (
            <CanvasViralRemixNode
              key={node.key}
              node={node}
              input={viralRemixInputsByNode.get(node.key) ?? null}
              selected={selectedNodeKey === node.key}
              dragging={false}
              running={startingNodeKeys.has(node.key)}
              error={startErrorsByNode[node.key] ?? null}
              providerCatalog={providerCatalog}
              onSelect={selectNode}
              onNodeDragStart={ignoreLegacyNodeDrag}
              onRemove={removeViralRemixNode}
              onUnlink={removeAssetEdge}
              onSizeChange={handleGenNodeSizeChange}
              onChange={(config) => updateViralRemixNodeConfig(node.key, config)}
              onRun={handleRunViralRemixNode}
              onExport={handleExportViralRemix}
            />
          ),
        },
      })),
    [
      viralRemixNodes,
      viralRemixInputsByNode,
      selectedNodeKey,
      startingNodeKeys,
      startErrorsByNode,
      providerCatalog,
      selectNode,
      ignoreLegacyNodeDrag,
      removeViralRemixNode,
      removeAssetEdge,
      handleGenNodeSizeChange,
      updateViralRemixNodeConfig,
      handleRunViralRemixNode,
      handleExportViralRemix,
    ],
  );

  const genFlowNodes = useMemo<CanvasFlowNode[]>(
    () =>
      genNodes.map((node): CanvasFlowNode => {
        const descriptor = getNodeDescriptor(
          node.kind,
          nodeDescriptorContext,
          node.config.modelSelection,
          node.kind === "video"
            ? "video_generation"
            : node.kind === "image"
              ? (connectedInputsByNode.get(node.key) ?? []).some(
                  (input) => input.kind === "image" || input.kind === "video",
                )
                ? "image_to_image"
                : "text_to_image"
              : undefined,
        );
        const content =
          node.kind === "prompt" ? (
            <CanvasPromptNode
              key={node.key}
              node={node}
              descriptor={descriptor}
              selected={selectedNodeKey === node.key}
              dragging={false}
              running={startingNodeKeys.has(node.key)}
              error={startErrorsByNode[node.key] ?? null}
              providerCatalog={providerCatalog}
              sourceConnections={connectedInputsByNode.get(node.key) ?? []}
              targetConnections={promptTargetsBySource.get(node.key) ?? []}
              onSelect={selectNode}
              onNodeDragStart={ignoreLegacyNodeDrag}
              onRemove={removeGenNode}
              onUnlink={removeAssetEdge}
              onConnectionStart={ignoreLegacyConnectionStart}
              onSizeChange={handleGenNodeSizeChange}
              onChange={(config) => updatePromptNodeConfig(node.key, config)}
              onRun={handleRunPromptNode}
            />
          ) : (
            <CanvasGenNode
              key={node.key}
              node={node}
              descriptor={descriptor}
              selected={selectedNodeKey === node.key}
              dragging={false}
              starting={startingNodeKeys.has(node.key)}
              startError={startErrorsByNode[node.key] ?? null}
              activeTask={activeTaskByNode.get(node.key) ?? null}
              connectedInputs={connectedInputsByNode.get(node.key) ?? []}
              inheritedInputs={inheritedInputsByNode.get(node.key) ?? []}
              mentionCandidates={mentionCandidatesFor(node.key)}
              promptSourceName={
                promptSourceByTarget.has(node.key)
                  ? `提示词节点 ${promptSourceByTarget.get(node.key)?.key.slice(-6) ?? ""}`
                  : undefined
              }
              registerPromptInput={registerPromptInput}
              providerCatalog={providerCatalog}
              onSelect={selectNode}
              onNodeDragStart={ignoreLegacyNodeDrag}
              onRemove={removeGenNode}
              onUnlink={removeAssetEdge}
              onSizeChange={handleGenNodeSizeChange}
              onImageConfigChange={updateImageNodeConfig}
              onVideoConfigChange={updateVideoNodeConfig}
              onStartGeneration={handleStartGeneration}
            />
          );
        return {
          id: node.key,
          type: "canvas",
          position: { x: node.x, y: node.y },
          ...measuredFor(node),
          selected: selectedNodeKey === node.key,
          data: {
            hasSourceHandle: true,
            hasTargetHandle: true,
            content,
          },
        };
      }),
    [
      genNodes,
      nodeDescriptorContext,
      connectedInputsByNode,
      selectedNodeKey,
      startingNodeKeys,
      startErrorsByNode,
      providerCatalog,
      promptTargetsBySource,
      selectNode,
      ignoreLegacyNodeDrag,
      removeGenNode,
      removeAssetEdge,
      ignoreLegacyConnectionStart,
      handleGenNodeSizeChange,
      updatePromptNodeConfig,
      handleRunPromptNode,
      activeTaskByNode,
      inheritedInputsByNode,
      mentionCandidatesFor,
      promptSourceByTarget,
      registerPromptInput,
      updateImageNodeConfig,
      updateVideoNodeConfig,
      handleStartGeneration,
    ],
  );

  const videoComposerFlowNodes = useMemo<CanvasFlowNode[]>(
    () =>
      videoComposerNodes.map((node): CanvasFlowNode => ({
        id: node.key,
        type: "canvas",
        position: { x: node.x, y: node.y },
        ...measuredFor(node),
        selected: selectedNodeKey === node.key,
        data: {
          hasSourceHandle: true,
          hasTargetHandle: true,
          content: (
            <CanvasVideoComposerNode
              key={node.key}
              node={node}
              inputs={videoComposerInputsByNode.get(node.key) ?? []}
              selected={selectedNodeKey === node.key}
              dragging={false}
              runState={videoComposerRuns[node.key]}
              recordingFormat={videoCompositionFormat}
              onSelect={selectNode}
              onNodeDragStart={ignoreLegacyNodeDrag}
              onRemove={removeVideoComposerNode}
              onUnlink={removeAssetEdge}
              onConfigChange={updateVideoComposerConfig}
              onMoveInput={moveVideoComposerInput}
              onCompose={handleComposeVideos}
            />
          ),
        },
      })),
    [
      videoComposerNodes,
      videoComposerInputsByNode,
      selectedNodeKey,
      videoComposerRuns,
      videoCompositionFormat,
      selectNode,
      ignoreLegacyNodeDrag,
      removeVideoComposerNode,
      removeAssetEdge,
      updateVideoComposerConfig,
      moveVideoComposerInput,
      handleComposeVideos,
    ],
  );

  const videoDownloaderFlowNodes = useMemo<CanvasFlowNode[]>(
    () =>
      videoDownloaderNodes.map((node): CanvasFlowNode => ({
        id: node.key,
        type: "canvas",
        position: { x: node.x, y: node.y },
        ...measuredFor(node),
        selected: selectedNodeKey === node.key,
        data: {
          hasSourceHandle: true,
          hasTargetHandle: false,
          content: (
            <CanvasVideoDownloaderNode
              key={node.key}
              node={node}
              selected={selectedNodeKey === node.key}
              dragging={false}
              runState={videoDownloaderRuns[node.key]}
              engineStatus={downloaderEngineStatus}
              enginePreparing={downloaderEngineBusy}
              onSelect={selectNode}
              onNodeDragStart={ignoreLegacyNodeDrag}
              onRemove={removeVideoDownloaderNode}
              onConfigChange={updateVideoDownloaderConfig}
              onStartDownload={handleStartVideoDownload}
              onCancelDownload={handleCancelVideoDownload}
              onPrepareEngine={prepareDownloaderEngine}
              onUpdateEngine={updateDownloaderEngine}
              onImportCookies={importDownloaderCookies}
              onClearCookies={clearDownloaderCookies}
              onRevealResult={revealDownloaderResult}
              onConnectionStart={ignoreLegacyConnectionStart}
            />
          ),
        },
      })),
    [
      videoDownloaderNodes,
      selectedNodeKey,
      videoDownloaderRuns,
      downloaderEngineStatus,
      downloaderEngineBusy,
      selectNode,
      ignoreLegacyNodeDrag,
      removeVideoDownloaderNode,
      updateVideoDownloaderConfig,
      handleStartVideoDownload,
      handleCancelVideoDownload,
      prepareDownloaderEngine,
      updateDownloaderEngine,
      importDownloaderCookies,
      clearDownloaderCookies,
      revealDownloaderResult,
      ignoreLegacyConnectionStart,
    ],
  );

  const frameExtractorFlowNodes = useMemo<CanvasFlowNode[]>(
    () =>
      frameExtractorNodes.map((node): CanvasFlowNode => ({
        id: node.key,
        type: "canvas",
        position: { x: node.x, y: node.y },
        ...measuredFor(node),
        selected: selectedNodeKey === node.key,
        data: {
          hasSourceHandle: true,
          hasTargetHandle: true,
          content: (
            <CanvasVideoFrameExtractorNode
              key={node.key}
              node={node}
              selected={selectedNodeKey === node.key}
              dragging={false}
              inputs={frameExtractorInputsByNode.get(node.key) ?? []}
              producedFrames={frameExtractorOutputsByNode.get(node.key) ?? []}
              runState={frameExtractorRuns[node.key]}
              onSelect={selectNode}
              onNodeDragStart={ignoreLegacyNodeDrag}
              onRemove={removeFrameExtractorNode}
              onConfigChange={updateFrameExtractorConfig}
              onStartExtraction={handleStartFrameExtraction}
              onCancelExtraction={handleCancelFrameExtraction}
            />
          ),
        },
      })),
    [
      frameExtractorNodes,
      selectedNodeKey,
      frameExtractorInputsByNode,
      frameExtractorOutputsByNode,
      frameExtractorRuns,
      selectNode,
      ignoreLegacyNodeDrag,
      removeFrameExtractorNode,
      updateFrameExtractorConfig,
      handleStartFrameExtraction,
      handleCancelFrameExtraction,
    ],
  );

  const resultFlowNodes = useMemo<CanvasFlowNode[]>(
    () =>
      resultNodes.map((node): CanvasFlowNode => ({
        id: node.key,
        type: "canvas",
        position: { x: node.x, y: node.y },
        ...measuredFor(node),
        selected: selectedNodeKey === node.key,
        data: {
          hasSourceHandle: false,
          hasTargetHandle: false,
          content: (
            <CanvasResultNode
              key={node.key}
              node={node}
              descriptor={getNodeDescriptor("result", nodeDescriptorContext)}
              selected={selectedNodeKey === node.key}
              dragging={false}
              latestResult={latestResult}
              onSelect={selectNode}
              onNodeDragStart={ignoreLegacyNodeDrag}
              onRemove={removeResultNode}
            />
          ),
        },
      })),
    [
      resultNodes,
      nodeDescriptorContext,
      selectedNodeKey,
      latestResult,
      selectNode,
      ignoreLegacyNodeDrag,
      removeResultNode,
    ],
  );

  const flowNodes = useMemo<CanvasFlowNode[]>(
    () => [
      ...assetFlowNodes,
      ...outputFlowNodes,
      ...screenplayFlowNodes,
      ...storyboardFlowNodes,
      ...knowledgeVideoWorkflowFlowNodes,
      ...viralRemixFlowNodes,
      ...genFlowNodes,
      ...videoComposerFlowNodes,
      ...videoDownloaderFlowNodes,
      ...frameExtractorFlowNodes,
      ...resultFlowNodes,
    ],
    [
      assetFlowNodes,
      outputFlowNodes,
      screenplayFlowNodes,
      storyboardFlowNodes,
      knowledgeVideoWorkflowFlowNodes,
      viralRemixFlowNodes,
      genFlowNodes,
      videoComposerFlowNodes,
      videoDownloaderFlowNodes,
      frameExtractorFlowNodes,
      resultFlowNodes,
    ],
  );

  const flowEdges = useMemo<CanvasFlowEdge[]>(
    () =>
      assetEdges.map((edge) => {
        const genSource = genTopologyByKey.get(edge.fromKey);
        const composerSource = videoComposerNodeByKey.get(edge.fromKey);
        const downloaderSource = videoDownloaderNodeByKey.get(edge.fromKey);
        const frameExtractorSource = frameExtractorNodeByKey.get(edge.fromKey);
        const screenplaySource = screenplayNodeByKey.get(edge.fromKey);
        const source = assetNodeByKey.get(edge.fromKey);
        const outputSource = outputNodeByKey.get(edge.fromKey);
        const generationTarget = genTopologyByKey.get(edge.toKey);
        const composerTarget = videoComposerNodeByKey.get(edge.toKey);
        const viralRemixTarget = viralRemixNodeByKey.get(edge.toKey);
        const frameExtractorTarget = frameExtractorNodeByKey.get(edge.toKey);
        const storyboardTarget = storyboardNodeByKey.get(edge.toKey);
        const workflowTarget = workflowInputsByNode.has(edge.toKey);
        const assetTarget = assetNodeByKey.get(edge.toKey);
        const isGenOutput =
          (genSource != null || composerSource != null) && outputNodeByKey.has(edge.toKey);
        const promptSource = genSource?.kind === "prompt" ? genSource : null;
        const isScreenplayToStoryboard = screenplaySource != null && storyboardTarget != null;
        const sourceName = promptSource
          ? "提示词节点"
          : screenplaySource
            ? connectedScreenplayName(screenplaySource)
            : downloaderSource
              ? "网络爆款视频下载节点"
              : composerSource
                ? "视频拼接与合成节点"
                : frameExtractorSource
                  ? "视频抽帧节点"
                  : (source?.name ?? outputSource?.name ?? "视频产物");
        const targetName = generationTarget
          ? `${generationTarget.kind === "image" ? "图片" : generationTarget.kind === "video" ? "视频" : "提示词"}生成节点`
          : composerTarget
            ? "视频拼接与合成节点"
            : viralRemixTarget
              ? "爆款视频复刻节点"
              : frameExtractorTarget
                ? "视频抽帧节点"
                : storyboardTarget
                  ? "剧本转工业级分镜脚本节点"
                  : workflowTarget
                    ? "工作流节点"
                    : (assetTarget?.name ?? "目标节点");
        const connectionOrder =
          workflowTarget || composerTarget != null || (generationTarget && !promptSource)
            ? (inputOrderByEdge.get(edge.id) ?? 0)
            : viralRemixTarget || frameExtractorTarget
              ? 1
              : 0;
        return {
          id: edge.id,
          type: "canvas",
          source: edge.fromKey,
          target: edge.toKey,
          sourceHandle: "source",
          targetHandle: "target",
          selected: !isGenOutput && selectedEdgeId === edge.id,
          selectable: !isGenOutput,
          focusable: !isGenOutput,
          data: {
            label: `${sourceName} → ${targetName}`,
            edgeClassName: isGenOutput
              ? `edge edge--gen-output edge--gen-output--${genSource?.kind ?? "video"}`
              : promptSource
                ? "edge edge--prompt-generation"
                : isScreenplayToStoryboard
                  ? "edge edge--screenplay-storyboard"
                  : `edge edge--asset${workflowTarget || generationTarget || composerTarget || viralRemixTarget || frameExtractorTarget ? " edge--asset-generation" : ""}`,
            order: connectionOrder,
            removable: !isGenOutput,
            onSelect: () => {
              selectEdge(edge.id);
              selectNode(null);
            },
            onRemove: () => removeAssetEdge(edge.id),
          },
        };
      }),
    [
      assetEdges,
      workflowInputsByNode,
      genTopologyByKey,
      videoComposerNodeByKey,
      videoDownloaderNodeByKey,
      frameExtractorNodeByKey,
      screenplayNodeByKey,
      storyboardNodeByKey,
      assetNodeByKey,
      outputNodeByKey,
      viralRemixNodeByKey,
      selectedEdgeId,
      inputOrderByEdge,
      removeAssetEdge,
      selectEdge,
      selectNode,
    ],
  );

  const handleFlowNodesChange = useCallback(
    (changes: NodeChange<CanvasFlowNode>[]) => {
      const persistedChanges: CanvasStoreNodeChange[] = [];
      for (const change of changes) {
        if (change.type === "position" && change.position) {
          // LiveCanvasFlow 已逐帧应用拖动位置；这里只在结束时回存业务状态与历史。
          if (change.dragging !== true) {
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
          persistedChanges.push({
            type: "select",
            key: change.id,
            selected: change.selected,
          });
        }
      }
      applyNodeChanges(persistedChanges);
    },
    [applyNodeChanges],
  );

  const handleFlowNodeDragStop: OnNodeDrag<CanvasFlowNode> = useCallback(
    (_event, node, draggedNodes) => {
      const nodes = draggedNodes.length > 0 ? draggedNodes : [node];
      applyNodeChanges(
        nodes.map((draggedNode) => ({
          type: "position" as const,
          key: draggedNode.id,
          position: draggedNode.position,
        })),
      );
    },
    [applyNodeChanges],
  );

  const handleFlowEdgesChange = (changes: EdgeChange<CanvasFlowEdge>[]) => {
    for (const change of changes) {
      if (change.type === "select") {
        selectEdge(change.selected ? change.id : null);
      }
    }
  };

  const handleFlowConnect = (connection: Connection) => {
    if (connection.source && connection.target) {
      connectCanvasNodes(connection.source, connection.target);
    }
  };

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

  const selectedAssetsLoading = assetLibrarySource === "local" ? localAssetsLoading : assetsLoading;
  const selectedAssetsError = assetLibrarySource === "local" ? localAssetsError : assetsError;
  const selectedLibraryError = assetLibrarySource === "local" ? localLibraryError : libraryError;
  const uploadActionLabel =
    assetLibrarySource === "local" ? "上传到本地素材库（仅对象存储）" : "上传本地素材到云端素材库";

  return (
    <main className="workspace-shell">
      <div className="workspace-content" inert={settingsOpen ? true : undefined}>
        <a className="skip-link" href="#canvas-workspace">
          跳到画布
        </a>
        <header className="workspace-header">
          <div className="brand-lockup" aria-label="无限画布">
            <span className="brand-mark" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span className="brand-name">无限画布</span>
          </div>
          <div className="save-state">
            <CheckCircle size={14} weight="fill" aria-hidden="true" />
            已保存
          </div>
          <div className="header-actions">
            <button
              type="button"
              className="mobile-panel-trigger"
              aria-label="打开节点仓库侧板"
              aria-controls="node-panel"
              aria-expanded={mobilePanel === "nodes"}
              onClick={(event) => toggleMobilePanel("nodes", event.currentTarget)}
            >
              <Sparkle size={18} weight="bold" aria-hidden="true" />
              <span>节点</span>
            </button>
            <button
              type="button"
              className="mobile-panel-trigger"
              aria-label="打开素材库侧板"
              aria-controls="asset-panel"
              aria-expanded={mobilePanel === "assets"}
              onClick={(event) => toggleMobilePanel("assets", event.currentTarget)}
            >
              <StackSimple size={18} weight="bold" aria-hidden="true" />
              <span>素材</span>
            </button>
            <button
              type="button"
              className="header-icon"
              aria-label="打开历史记录"
              aria-controls="generation-history-dialog"
              aria-expanded={historyOpen}
              data-tooltip="历史记录"
              onMouseEnter={preloadHistoryDialog}
              onFocus={preloadHistoryDialog}
              onClick={() => {
                setHistoryInitialTab("generation");
                setHistoryInitialWorkflowId(null);
                setHistoryOpen(true);
              }}
            >
              <Clock size={18} weight="bold" aria-hidden="true" />
            </button>
            <button
              type="button"
              className="header-icon"
              aria-label="清空画布"
              data-tooltip="清空画布上的节点与连线"
              onClick={openClearCanvasDialog}
            >
              <ArrowCounterClockwise size={18} weight="bold" aria-hidden="true" />
            </button>
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
                setMobilePanel(null);
                setSettingsOpen(true);
              }}
            >
              <GearSix size={18} weight="bold" aria-hidden="true" />
            </button>
          </div>
        </header>

        <aside
          id="node-panel"
          className={`node-panel${mobilePanel === "nodes" ? " is-mobile-open" : ""}`}
          aria-label="节点仓库"
        >
          <button
            type="button"
            className="mobile-panel-close mobile-panel-close--nodes"
            aria-label="关闭节点仓库"
            onClick={closeMobilePanel}
          >
            <X size={18} weight="bold" aria-hidden="true" />
          </button>
          <div className="panel-title-row">
            <div className="panel-title-row__identity">
              <Sparkle size={18} weight="bold" aria-hidden="true" />
              <h2>节点仓库</h2>
            </div>
          </div>
          <p className="node-panel__hint">拖到画布创建节点，可重复放置；单击在画布中心创建。</p>
          <div className="node-panel__grid">
            <RepositoryCard
              nodeType="image"
              label="图片生成"
              onAddToCanvas={() => {
                const center = viewportCenterBoardCoordinates();
                addGenNode("image", center.x, center.y);
              }}
              onDropToCanvas={(clientX, clientY) => {
                const point = dropClientPointToBoard(clientX, clientY);
                if (point == null) return;
                addGenNode("image", point.x, point.y);
              }}
            />
            <RepositoryCard
              nodeType="video"
              label="视频生成"
              onAddToCanvas={() => {
                const center = viewportCenterBoardCoordinates();
                addGenNode("video", center.x, center.y);
              }}
              onDropToCanvas={(clientX, clientY) => {
                const point = dropClientPointToBoard(clientX, clientY);
                if (point == null) return;
                addGenNode("video", point.x, point.y);
              }}
            />
            <RepositoryCard
              nodeType="video_composer"
              label="视频拼接与合成"
              onAddToCanvas={() => {
                const center = viewportCenterBoardCoordinates();
                addVideoComposerNode(center.x, center.y);
              }}
              onDropToCanvas={(clientX, clientY) => {
                const point = dropClientPointToBoard(clientX, clientY);
                if (point == null) return;
                addVideoComposerNode(point.x, point.y);
              }}
            />
            <RepositoryCard
              nodeType="video_downloader"
              label="网络爆款视频下载"
              onAddToCanvas={() => {
                const center = viewportCenterBoardCoordinates();
                addVideoDownloaderNode(center.x, center.y);
              }}
              onDropToCanvas={(clientX, clientY) => {
                const point = dropClientPointToBoard(clientX, clientY);
                if (point == null) return;
                addVideoDownloaderNode(point.x, point.y);
              }}
            />
            <RepositoryCard
              nodeType="frame_extractor"
              label="视频抽帧"
              onAddToCanvas={() => {
                const center = viewportCenterBoardCoordinates();
                addFrameExtractorNode(center.x, center.y);
              }}
              onDropToCanvas={(clientX, clientY) => {
                const point = dropClientPointToBoard(clientX, clientY);
                if (point == null) return;
                addFrameExtractorNode(point.x, point.y);
              }}
            />
            <RepositoryCard
              nodeType="viral_remix"
              label="爆款视频复刻"
              onAddToCanvas={() => {
                const center = viewportCenterBoardCoordinates();
                addViralRemixNode(center.x, center.y);
              }}
              onDropToCanvas={(clientX, clientY) => {
                const point = dropClientPointToBoard(clientX, clientY);
                if (point == null) return;
                addViralRemixNode(point.x, point.y);
              }}
            />
            <RepositoryCard
              nodeType="prompt"
              label="提示词生成与优化"
              onAddToCanvas={() => {
                const center = viewportCenterBoardCoordinates();
                addGenNode("prompt", center.x, center.y);
              }}
              onDropToCanvas={(clientX, clientY) => {
                const point = dropClientPointToBoard(clientX, clientY);
                if (point == null) return;
                addGenNode("prompt", point.x, point.y);
              }}
            />
            <RepositoryCard
              nodeType="screenplay"
              label="剧本创作与优化"
              onAddToCanvas={() => {
                const center = viewportCenterBoardCoordinates();
                addScreenplayNode(center.x, center.y);
              }}
              onDropToCanvas={(clientX, clientY) => {
                const point = dropClientPointToBoard(clientX, clientY);
                if (point == null) return;
                addScreenplayNode(point.x, point.y);
              }}
            />
            <RepositoryCard
              nodeType="storyboard"
              label="剧本转工业级分镜脚本"
              onAddToCanvas={() => {
                const center = viewportCenterBoardCoordinates();
                addStoryboardNode(center.x, center.y);
              }}
              onDropToCanvas={(clientX, clientY) => {
                const point = dropClientPointToBoard(clientX, clientY);
                if (point == null) return;
                addStoryboardNode(point.x, point.y);
              }}
            />
          </div>
        </aside>

        <aside
          id="asset-panel"
          className={`asset-panel${mobilePanel === "assets" ? " is-mobile-open" : ""}`}
          aria-label="素材库"
        >
          <button
            type="button"
            className="mobile-panel-close mobile-panel-close--assets"
            aria-label="关闭素材库"
            onClick={closeMobilePanel}
          >
            <X size={18} weight="bold" aria-hidden="true" />
          </button>
          <div className="panel-title-row">
            <div className="panel-title-row__identity">
              <StackSimple size={18} weight="bold" aria-hidden="true" />
              <h2>素材库</h2>
            </div>
            <button
              type="button"
              className="square-action"
              aria-label={uploadActionLabel}
              data-tooltip={uploadActionLabel}
              onClick={() => {
                void handleImportLocalAssets();
              }}
            >
              <UploadSimple size={18} weight="bold" aria-hidden="true" />
            </button>
          </div>
          {isDesktopRuntime() && isOffline ? (
            <div className="asset-panel__offline" role="status">
              <WarningCircle size={14} weight="fill" aria-hidden="true" />
              <span>
                {assetLibrarySource === "local"
                  ? "网络连接已断开，对象存储预览与上传暂时不可用。"
                  : "网络连接已断开，云端拉取与上传暂时不可用；恢复后会自动刷新素材列表。"}
              </span>
            </div>
          ) : null}
          <div className="asset-origin">
            <label className="sr-only" htmlFor="asset-library-source">
              素材库来源
            </label>
            <select
              id="asset-library-source"
              aria-label="素材库来源"
              value={assetLibrarySource}
              onChange={(event) => {
                const nextSource = event.target.value as AssetLibrarySource;
                setAssetLibrarySource(nextSource);
                setAssetSearch("");
                if (!isDesktopRuntime()) return;
                if (nextSource === "local") refreshLocalAssets("initial");
                else setAssetsLoading(Boolean(assetProvider));
              }}
            >
              <option value="cloud">云端素材</option>
              <option value="local">本地素材</option>
            </select>
            <span className="asset-origin__status">
              {assetLibrarySource === "local"
                ? "本地索引 · 对象存储"
                : isDesktopRuntime()
                  ? assetProvider
                    ? "已连接"
                    : "未连接"
                  : "Moyu · 制作库"}
            </span>
            {selectedAssetsLoading ? (
              <CircleNotch size={14} weight="bold" aria-hidden="true" data-spin="true" />
            ) : selectedLibraryError ? (
              <WarningCircle size={14} weight="fill" aria-hidden="true" />
            ) : assetLibrarySource === "local" || assetProvider || !isDesktopRuntime() ? (
              <CheckCircle size={14} weight="fill" aria-hidden="true" />
            ) : (
              <WarningCircle size={14} weight="fill" aria-hidden="true" />
            )}
          </div>
          {assetLibrarySource === "cloud" ? (
            <>
              <div className="asset-provider-switcher">
                <label htmlFor="asset-library-provider">供应商</label>
                <select
                  id="asset-library-provider"
                  aria-label="素材库供应商"
                  value={assetProvider?.id ?? ""}
                  disabled={availableAssetProviders.length === 0}
                  onChange={(event) => {
                    const nextProvider = availableAssetProviders.find(
                      (provider) => provider.id === event.target.value,
                    );
                    if (nextProvider) handleAssetProviderChanged(nextProvider.id);
                  }}
                >
                  {availableAssetProviders.length > 0 ? (
                    availableAssetProviders.map((provider) => (
                      <option key={provider.id} value={provider.id}>
                        {provider.displayName}
                      </option>
                    ))
                  ) : (
                    <option value="">未配置启用的供应商</option>
                  )}
                </select>
              </div>
              <button
                type="button"
                className="real-person-entry"
                disabled={!isDesktopRuntime() || !assetProvider || isOffline}
                aria-label="打开明星真人素材 H5 认证与上传"
                onClick={() => setRealPersonDialogOpen(true)}
              >
                <span className="real-person-entry__icon" aria-hidden="true">
                  <UserFocus size={20} weight="duotone" />
                </span>
                <span className="real-person-entry__copy">
                  <strong>明星真人素材</strong>
                  <small>
                    {!assetProvider
                      ? "先配置供应商与素材库令牌"
                      : isOffline
                        ? "网络恢复后可进行 H5 认证"
                        : "H5 人脸认证 · 同人素材上传"}
                  </small>
                </span>
                <CaretRight size={16} weight="bold" aria-hidden="true" />
              </button>
            </>
          ) : null}
          {isDesktopRuntime() && selectedAssetsError ? (
            <AssetPanelError
              title={
                selectedLibraryError
                  ? assetLibrarySource === "local"
                    ? "本地素材库不可用"
                    : "云端素材库不可用"
                  : "素材上传失败"
              }
              error={selectedAssetsError}
              actionLabel={
                selectedLibraryError
                  ? assetLibrarySource === "local"
                    ? "重新读取"
                    : "重新拉取"
                  : undefined
              }
              onAction={
                selectedLibraryError && (assetLibrarySource === "local" || assetProvider)
                  ? () => {
                      if (assetLibrarySource === "local") {
                        refreshLocalAssets("manual");
                      } else if (assetProvider) {
                        refreshCloudAssets(assetProvider.id, "manual");
                      }
                    }
                  : undefined
              }
            />
          ) : null}
          {assetUploads.length > 0 ? (
            <ul className="asset-uploads" aria-label="本地上传进度">
              {assetUploads.map((entry) => (
                <AssetUploadRow
                  key={entry.jobId}
                  entry={entry}
                  onDismiss={() => dismissAssetUpload(entry.jobId)}
                />
              ))}
            </ul>
          ) : null}
          {assetLibrarySource === "cloud" && isDesktopRuntime() && assetProvider ? (
            <div className="asset-groups">
              <div className="asset-groups__heading">
                <span className="asset-groups__title">分组</span>
                <button
                  type="button"
                  className="asset-groups__create"
                  aria-label="新建素材分组"
                  onClick={() => setNewGroupDialogOpen(true)}
                >
                  <Plus size={14} weight="bold" aria-hidden="true" />
                  新建分组
                </button>
              </div>
              <div className="asset-groups__select-row">
                <label className="sr-only" htmlFor="asset-group-select">
                  素材库分组
                </label>
                <select
                  id="asset-group-select"
                  aria-label="素材库分组"
                  value={selectedAssetGroupId ?? ""}
                  disabled={groupsLoading && assetGroups.length === 0}
                  onChange={(event) => {
                    const value = event.target.value;
                    handleAssetGroupChanged(value ? Number(value) : null, assetProvider.id);
                  }}
                >
                  <option value="">全部素材</option>
                  {assetGroups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name}
                      {group.isDefault ? " · 默认" : ""}
                    </option>
                  ))}
                </select>
                {groupsLoading ? (
                  <CircleNotch size={14} weight="bold" data-spin="true" aria-hidden="true" />
                ) : null}
              </div>
              {groupsError ? (
                <span className="asset-groups__error" role="status">
                  <WarningCircle size={13} weight="fill" aria-hidden="true" />
                  分组加载失败，仍显示全部素材
                  <button type="button" onClick={() => refreshAssetGroups(assetProvider.id)}>
                    重试
                  </button>
                </span>
              ) : null}
            </div>
          ) : null}
          <div className="asset-tabs" role="tablist" aria-label="素材类型">
            {(["image", "video", "audio"] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                role="tab"
                aria-label={`${ASSET_KIND_LABELS[kind]} ${libraryAssets.filter((asset) => asset.kind === kind).length}`}
                aria-selected={assetKind === kind}
                onClick={() => {
                  setAssetKind(kind);
                  setAssetSearch("");
                }}
              >
                <AssetKindIcon kind={kind} />
                <span className="asset-tab__label">{ASSET_KIND_LABELS[kind]}</span>
                <span>{libraryAssets.filter((asset) => asset.kind === kind).length}</span>
              </button>
            ))}
          </div>
          <div className="asset-search-group">
            <label className="asset-search-label" htmlFor="asset-search-input">
              筛选当前素材
            </label>
            <div className="asset-search">
              <MagnifyingGlass size={16} weight="bold" aria-hidden="true" />
              <input
                id="asset-search-input"
                type="search"
                aria-label={`搜索${ASSET_KIND_LABELS[assetKind]}素材`}
                aria-describedby="asset-search-status"
                aria-controls="asset-grid"
                placeholder={`搜索${ASSET_KIND_LABELS[assetKind]}素材`}
                value={assetSearch}
                onChange={(event) => setAssetSearch(event.target.value)}
              />
              {assetSearch ? (
                <button
                  type="button"
                  className="asset-search__clear"
                  aria-label="清除素材搜索"
                  onClick={() => setAssetSearch("")}
                >
                  <X size={14} weight="bold" aria-hidden="true" />
                </button>
              ) : null}
            </div>
            <span
              id="asset-search-status"
              className="sr-only"
              role="status"
              aria-atomic="true"
              aria-busy={assetSearchPending}
            >
              找到 {visibleAssets.length} 个{ASSET_KIND_LABELS[assetKind]}素材
            </span>
          </div>
          <div
            id="asset-grid"
            className="asset-grid"
            aria-busy={selectedAssetsLoading || assetSearchPending}
          >
            {visibleAssets.length > 0 ? (
              <AssetFlow
                assets={renderedAssets}
                onPreview={handlePreviewAsset}
                onDropToCanvas={handleDropAssetToCanvas}
              />
            ) : (
              <div className="asset-empty">
                {selectedAssetsLoading ? (
                  <CircleNotch size={24} weight="bold" aria-hidden="true" data-spin="true" />
                ) : selectedLibraryError ? (
                  <WarningCircle size={24} weight="fill" aria-hidden="true" />
                ) : (
                  <MagnifyingGlass size={24} weight="regular" aria-hidden="true" />
                )}
                <strong>
                  {selectedAssetsLoading
                    ? assetLibrarySource === "local"
                      ? "正在读取本地素材…"
                      : "正在拉取云端素材…"
                    : selectedLibraryError
                      ? assetLibrarySource === "local"
                        ? "本地素材库不可用"
                        : "云端素材库不可用"
                      : "没有找到素材"}
                </strong>
                <span>
                  {selectedAssetsLoading
                    ? assetLibrarySource === "local"
                      ? "正在从本机索引签发对象存储预览地址。"
                      : "云端素材库正在同步，稍候即可看到最新素材。"
                    : selectedLibraryError
                      ? assetLibrarySource === "local"
                        ? "无法读取本地索引或对象存储配置，详情见上方错误信息。"
                        : "云端请求失败（可能是供应商故障或鉴权问题），详情见上方错误信息，稍后可点击「重新拉取」重试。"
                      : assetLibrarySource === "cloud" && isDesktopRuntime() && !assetProvider
                        ? "请先在全局设置中配置并启用供应商连接。"
                        : isDesktopRuntime()
                          ? assetLibrarySource === "local"
                            ? "上传的素材只会写入对象存储，不会导入云端素材库。"
                            : "试试上传本地素材，或切换素材类型。"
                          : "试试更短的名称，或切换素材类型。"}
                </span>
                {!selectedAssetsLoading && assetSearch ? (
                  <button type="button" onClick={() => setAssetSearch("")}>
                    <X size={14} weight="bold" aria-hidden="true" />
                    清除搜索
                  </button>
                ) : null}
                {!selectedAssetsLoading &&
                isDesktopRuntime() &&
                (assetLibrarySource === "local" || assetProvider) ? (
                  <button
                    type="button"
                    onClick={() => {
                      void handleImportLocalAssets();
                    }}
                  >
                    <UploadSimple size={14} weight="bold" aria-hidden="true" />
                    {assetLibrarySource === "local" ? "上传到本地素材库" : "上传本地素材"}
                  </button>
                ) : null}
              </div>
            )}
            {remainingAssetCount > 0 ? (
              <div className="asset-pagination">
                <span>
                  已显示 {renderedAssets.length} / {visibleAssets.length}
                </span>
                <button type="button" disabled={assetSearchPending} onClick={loadMoreAssets}>
                  加载更多素材（还有 {remainingAssetCount} 个）
                </button>
              </div>
            ) : null}
          </div>
          <p className="asset-panel__hint">
            单击素材查看源媒体与完整信息；拖到画布创建节点，连线后可在提示词中 @ 引用。
          </p>
        </aside>

        <section
          id="canvas-workspace"
          className="canvas-stage"
          aria-label="无限画布工作区"
          tabIndex={-1}
        >
          <div
            className={`canvas-viewport${isPanning ? " is-panning" : ""}`}
            ref={canvasViewportRef}
          >
            <LiveCanvasFlow
              className="canvas-react-flow"
              nodes={flowNodes}
              edges={flowEdges}
              nodeTypes={CANVAS_FLOW_NODE_TYPES}
              edgeTypes={CANVAS_FLOW_EDGE_TYPES}
              minZoom={minimumCanvasZoom() / 100}
              maxZoom={MAX_ZOOM / 100}
              panOnDrag={[0, 1]}
              zoomOnScroll
              zoomOnPinch
              zoomOnDoubleClick={false}
              preventScrolling
              connectionRadius={CANVAS_CONNECTION_RADIUS}
              deleteKeyCode={null}
              onInit={handleFlowInit}
              onNodesChange={handleFlowNodesChange}
              onNodeDragStop={handleFlowNodeDragStop}
              onEdgesChange={handleFlowEdgesChange}
              onConnect={handleFlowConnect}
              onMoveStart={() => setIsPanning(true)}
              onMoveEnd={handleFlowMoveEnd}
              onPaneClick={() => {
                selectNode(null);
                selectEdge(null);
              }}
              onNodeClick={(_, node) => {
                selectNode(node.id);
                selectEdge(null);
              }}
              onEdgeClick={(_, edge) => {
                if (edge.selectable !== false) {
                  selectEdge(edge.id);
                  selectNode(null);
                }
              }}
              aria-label="无限画布节点编辑器"
              attributionPosition="bottom-left"
            >
              {/* 网格由 React Flow Background 渲染，随视口原生平移缩放（主网格 5rem、次网格 1rem）。 */}
              <Background
                id="canvas-grid-minor"
                variant={BackgroundVariant.Lines}
                gap={16}
                lineWidth={1}
                className="canvas-flow-bg canvas-flow-bg--minor"
              />
              <Background
                id="canvas-grid-major"
                variant={BackgroundVariant.Lines}
                gap={80}
                lineWidth={1}
                className="canvas-flow-bg canvas-flow-bg--major"
              />
            </LiveCanvasFlow>

            {/* 空态提示与连线/拖动捕获层挂在视口上，不随画布平移缩放。 */}
            {!hasCanvasNodes ? (
              <div className="canvas-empty-hint">
                <strong>画布为空</strong>
                <span>从左侧节点仓库拖入生成节点，或从素材库拖入素材开始创作。</span>
              </div>
            ) : null}
          </div>

          <div className="canvas-history-control" role="group" aria-label="画布撤销与重做">
            <button
              type="button"
              aria-label="撤销画布操作"
              aria-keyshortcuts="Control+Z"
              data-tooltip="撤销 · Ctrl+Z"
              disabled={pastCount === 0}
              onClick={undo}
            >
              <ArrowCounterClockwise size={16} weight="bold" aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label="重做画布操作"
              aria-keyshortcuts="Control+Shift+Z"
              data-tooltip="重做 · Ctrl+Shift+Z"
              disabled={futureCount === 0}
              onClick={redo}
            >
              <ArrowClockwise size={16} weight="bold" aria-hidden="true" />
            </button>
          </div>

          <div className="zoom-control" role="group" aria-label="画布缩放控制">
            <button
              type="button"
              aria-label="缩小画布"
              aria-keyshortcuts="-"
              data-tooltip="缩小画布 · -"
              onClick={() => zoomAroundViewportCenter(viewRef.current.zoom - ZOOM_STEP)}
            >
              <Minus size={16} weight="bold" aria-hidden="true" />
            </button>
            <button
              type="button"
              className="zoom-control__reset"
              aria-label={`重置画布缩放为 ${DEFAULT_ZOOM}%`}
              aria-keyshortcuts="0"
              data-tooltip="重置缩放 · 0"
              onClick={() => zoomAroundViewportCenter(DEFAULT_ZOOM)}
            >
              <CornersOut size={14} weight="bold" aria-hidden="true" />
              <output aria-live="polite">{zoom}%</output>
            </button>
            <button
              type="button"
              aria-label="放大画布"
              aria-keyshortcuts="+"
              data-tooltip="放大画布 · +"
              onClick={() => zoomAroundViewportCenter(viewRef.current.zoom + ZOOM_STEP)}
            >
              <Plus size={16} weight="bold" aria-hidden="true" />
            </button>
          </div>
        </section>

        <WorkflowRepository
          expanded={workflowRepositoryExpanded}
          onToggle={toggleWorkflowRepository}
          onInsertKnowledgeVideoWorkflow={insertKnowledgeVideoDirectorWorkflow}
          onInsertAiFilmWorkflow={insertAiFilmWorkflow}
          onInsertComicDramaWorkflow={insertComicDramaWorkflow}
          onInsertCommerceWorkflow={insertCommerceWorkflow}
          onInsertRemotionWorkflow={insertRemotionWorkflow}
          onInsertXhsCoverWorkflow={insertXhsCoverWorkflow}
          onInsertReverseVideoWorkflow={insertReverseVideoWorkflow}
        />

        {mobilePanel ? (
          <button
            type="button"
            className="mobile-panel-backdrop"
            aria-label="关闭侧板"
            onClick={closeMobilePanel}
          />
        ) : null}
      </div>
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
            canvasId={CANVAS_ID}
            initialTab={historyInitialTab}
            initialWorkflowId={historyInitialWorkflowId}
            onResumeWorkflow={resumeHistoryWorkflow}
            onRestartWorkflow={restartHistoryWorkflow}
            onLocateWorkflow={locateHistoryWorkflow}
            activeWorkflowIds={activeWorkflowHistoryIds}
          />
        </Suspense>
      ) : null}
      {previewAsset ? (
        <AssetSourceDialog
          asset={previewAsset}
          onClose={() => setPreviewAsset(null)}
          onDelete={
            previewAsset.source === "cloud" && previewAsset.providerConnectionId
              ? () => handleDeleteAsset(previewAsset)
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
      ) : null}
      {realPersonDialogOpen && assetProvider ? (
        <RealPersonAssetDialog
          providerConnectionId={assetProvider.id}
          providerDisplayName={assetProvider.displayName}
          onClose={() => setRealPersonDialogOpen(false)}
          onUploadToGroup={handleImportLocalAssets}
        />
      ) : null}
      {newGroupDialogOpen && assetProvider ? (
        <AssetGroupCreateDialog
          providerDisplayName={assetProvider.displayName}
          busy={creatingGroup}
          onClose={() => setNewGroupDialogOpen(false)}
          onCreate={(name) => handleCreateAssetGroup(assetProvider.id, name)}
        />
      ) : null}
      {previewOutputNode ? (
        <CanvasOutputLightbox
          node={previewOutputNode}
          onClose={() => setPreviewOutputNodeKey(null)}
        />
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
              <Warning size={20} weight="bold" />
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
                  <TrashSimple size={14} weight="bold" />
                </span>
                <span className="confirm-dialog__fact-label">画布节点与连线</span>
                <span className="confirm-dialog__fact-state">将被移除</span>
              </li>
              <li className="confirm-dialog__fact confirm-dialog__fact--kept">
                <span className="confirm-dialog__fact-icon" aria-hidden="true">
                  <CheckCircle size={14} weight="bold" />
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
              <TrashSimple size={14} weight="bold" aria-hidden="true" />
              确认清空
            </button>
          </div>
        </form>
      </dialog>
    </main>
  );
}
