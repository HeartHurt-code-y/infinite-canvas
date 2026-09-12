import { videoDownloadInputs } from "./videoDownloadInputs";
import { ArrowClockwise } from "@phosphor-icons/react/ArrowClockwise";
import { ArrowCounterClockwise } from "@phosphor-icons/react/ArrowCounterClockwise";
import { CheckCircle } from "@phosphor-icons/react/CheckCircle";
import { Clock } from "@phosphor-icons/react/Clock";
import { CornersOut } from "@phosphor-icons/react/CornersOut";
import { CrosshairSimple } from "@phosphor-icons/react/CrosshairSimple";
import { GearSix } from "@phosphor-icons/react/GearSix";
import { Minus } from "@phosphor-icons/react/Minus";
import { Plus } from "@phosphor-icons/react/Plus";
import { Sparkle } from "@phosphor-icons/react/Sparkle";
import { StackSimple } from "@phosphor-icons/react/StackSimple";
import { TrashSimple } from "@phosphor-icons/react/TrashSimple";
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
  lazy,
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
  formatRawBackendError,
  frontendLog,
  generationClient,
  inferMediaKindFromName,
  isDesktopRuntime,
  loadProviderCatalog,
  pickLocalMediaFiles,
  pickPromptMultimodalFiles,
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
  type AssetImportOutputRecord,
  type CloudAssetKindTotals,
  type GenerationOperation,
  type GenerationResultRecord,
  type GenerationTaskSummary,
  type LocalAssetKindTotals,
  type LocalAssetRecord,
  type MediaType,
  type PromptOptimizationContextEntry,
  type PromptMultimodalInput,
  type PromptVisionImageInput,
  type ProviderCatalogEntry,
  type ProviderConnection,
  type RealPersonGroup,
  type StagingJobRecord,
  type StartGenerationCommand,
  type TosStagingConfig,
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
import {
  cleanGeneratedPrompt,
  createPromptContentModule,
  stripMarkdown,
} from "../../lib/promptContent";
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
  isSupportedConnection,
  type CanvasDocument,
  type CanvasDocumentV2,
  type CanvasNodeEntry,
  type CanvasStoreNodeChange,
} from "../canvas/canvasStore";
import {
  useCanvasDocumentPersistence,
  type CanvasSessionServices,
} from "../canvas/useCanvasDocumentPersistence";
import { buildInputOrderByEdge } from "../canvas/connectionIndex";
import { createCanvasInputResolver, canvasNodesByKeyFromDocument } from "./canvasInputs";

import { CanvasFlowEdgeView, CanvasFlowNodeView } from "./CanvasFlowViews";
import { ConnectionQuickAddMenu } from "./ConnectionQuickAddMenu";
import { RepositoryCard } from "./AssetLibraryViews";
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
import { revealDesktopItem, saveMarkdownDocumentToDesktop } from "./desktopActions";
import {
  CanvasDocumentSkillNode,
  CanvasPromptNode,
  CanvasViralRemixNode,
} from "./DocumentNodeViews";
import {
  CanvasAssetLightbox,
  CanvasAssetNode,
  CanvasGenNode,
  CanvasOutputLightbox,
  CanvasOutputNode,
  CanvasResultNode,
  CanvasVideoComposerNode,
  CanvasVideoDownloaderNode,
  CanvasVideoFrameExtractorNode,
} from "./MediaNodeViews";
import { resolveSeedanceTask, selectSeedanceTask } from "../../lib/seedanceTasks";
import { appendVideoLocalEditPrompt, resolveVideoEditFrameTarget } from "../../lib/videoLocalEdit";
import { sameMediaReferenceTarget } from "../../lib/promptReferenceTarget";
import type {
  VideoLocalEditFrameResolution,
  VideoLocalEditResult,
  VideoLocalEditSource,
} from "./VideoLocalEditDialog";
import { KnowledgeVideoWorkflowNode } from "./KnowledgeVideoWorkflowNode";
import {
  workflowCanvasInputsFromResolved,
  workflowCanvasInputsFromDocument,
  withCanvasWorkflowMaterials,
  withLiveWorkflowCanvasInputs,
} from "./workflowCanvasInputs";
import { formatWorkflowError } from "../../lib/workflowErrors";
import { WorkflowRepository } from "./WorkflowRepository";
import { createRecordedWorkflowRunner } from "./workflowHistoryExecution";
import { workflowHistoryClient, type WorkflowHistoryRecord } from "../../lib/workflowHistory";
import { restoreWorkflowHistoryNode } from "./workflowHistoryRestore";
import { workflowMaterialPathKey } from "./workflowMaterials";
import { aiFilmDeliveryMarkdown } from "./aiFilmWorkflowModel";
import { comicDramaDeliveryMarkdown } from "./comicDramaWorkflowModel";
import { commerceDeliveryMarkdown } from "./commerceWorkflowModel";
import { remotionDeliveryMarkdown } from "./remotionWorkflowModel";
import { xhsCoverDeliveryMarkdown } from "./xhsCoverWorkflowModel";
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
  KnowledgeVideoWorkflowCheckpoint,
  KnowledgeVideoWorkflowConfig,
  KnowledgeVideoWorkflowNodeData,
  KnowledgeVideoWorkflowRunState,
  KnowledgeVideoWorkflowShotRun,
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
  ASSET_PAGE_SIZE,
  CANVAS_CONNECTION_RADIUS,
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
  UPLOAD_ABANDONED_MS,
  UPLOAD_POLL_INTERVAL_MS,
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
  assetNodeDimensions,
  assetNodeKey,
  abandonedUploadError,
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
  isRunningTaskStatus,
  textResultFromSource,
  isTerminalAssetUpload,
  isTerminalStagingJob,
  isTerminalTaskStatus,
  isTextGenerationModel,
  localAssetToItem,
  localPathFileName,
  markdownDocumentExportName,
  materializeCompositionInputs,
  measuredFor,
  mergeStagingJobsIntoUploads,
  shouldAutoDismissUpload,
  stagingImportReachedLibrary,
  UPLOAD_AUTO_DISMISS_DELAY_MS,
  minimumCanvasZoom,
  modelDisplayNameForTask,
  nearestAvailableNodePosition,
  nextOutputSlot,
  nextVideoComposerOutputSlot,
  nextVideoDownloaderOutputSlot,
  normalizeLocalPathKey,
  outputNodeDimensions,
  outputNodeKey,
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
const VideoLocalEditDialog = lazy(() =>
  import("./VideoLocalEditDialog").then((module) => ({ default: module.VideoLocalEditDialog })),
);
const CANVAS_FLOW_EDGE_TYPES = { canvas: CanvasFlowEdgeView };

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
  const previous = cache.get(key);
  if (
    previous != null &&
    previous.inputs.length === inputs.length &&
    inputs.every((value, index) => value === previous.inputs[index])
  ) {
    return previous.node;
  }
  const node = build();
  cache.set(key, { inputs, node });
  return node;
}

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
    case "storyboard":
      return "剧本转工业级分镜脚本节点";
    case "knowledgeVideoWorkflow":
      return "工作流节点";
    case "viralRemix":
      return "爆款视频复刻节点";
    case "videoComposer":
      return "视频拼接与合成节点";
    case "videoDownloader":
      return "网络爆款视频下载节点";
    case "frameExtractor":
      return "视频抽帧节点";
    case "result":
      return "结果节点";
  }
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

export function WorkspaceApp({
  canvasId,
  active,
  services,
}: {
  readonly canvasId: string;
  readonly active: boolean;
  readonly services: CanvasSessionServices;
}) {
  const [assetLibrarySource, setAssetLibrarySource] = useState<AssetLibrarySource>("cloud");
  const [assetKind, setAssetKind] = useState<AssetKind>("image");
  const [assetSearch, setAssetSearch] = useState("");
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
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>(null);
  const [workflowRepositoryExpanded, setWorkflowRepositoryExpanded] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyInitialTab, setHistoryInitialTab] = useState<"generation" | "workflow">(
    "generation",
  );
  const [historyInitialWorkflowId, setHistoryInitialWorkflowId] = useState<string | null>(null);
  const [realPersonDialogOpen, setRealPersonDialogOpen] = useState(false);
  const [videoLocalEdit, setVideoLocalEdit] = useState<{
    readonly nodeKey: string;
    readonly source: VideoLocalEditSource;
    readonly input: GenerationMediaInput;
  } | null>(null);
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
    canvasNodeByKey,
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
      canvasNodeByKey: state.nodeByKey,
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
  const canvasInputsFor = useMemo(
    () => createCanvasInputResolver(canvasNodeByKey, assetEdges),
    [canvasNodeByKey, assetEdges],
  );
  const workflowInputsByNode = useMemo(
    () =>
      new Map(
        knowledgeVideoWorkflowNodes.map((node) => [
          node.key,
          workflowCanvasInputsFromResolved(canvasInputsFor(node.key)),
        ]),
      ),
    [knowledgeVideoWorkflowNodes, canvasInputsFor],
  );
  const documentInputsByNode = useMemo(() => {
    const inputs = new Map<string, readonly ConnectedScreenplayInput[]>();
    for (const node of [...screenplayNodes, ...storyboardNodes]) {
      inputs.set(
        node.key,
        canvasInputsFor(node.key).texts.map((input) => ({
          key: input.key,
          name: input.name,
          document: input.text,
          edgeId: input.edgeId,
        })),
      );
    }
    return inputs;
  }, [canvasInputsFor, screenplayNodes, storyboardNodes]);
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
  /**
   * 文本模型正在生成的正文（按节点 key 累加）。
   *
   * 只用于「运行中」的实时展示：任务完成后由 run 的回调写入完整结果并清空这里，
   * 因此它不是画布文档的一部分，不参与持久化。
   */
  const [streamingTextByNode, setStreamingTextByNode] = useState<Record<string, string>>({});
  /** 记录每个节点当前流式任务 ID：任务换了说明是新一轮，需要从空重新累积。 */
  const streamingTextTaskByNodeRef = useRef<Map<string, string>>(new Map());
  /** 本轮结束（成功或失败）后清掉流式草稿：完整结果由调用方写入节点。 */
  const clearStreamingText = useCallback((nodeKey: string) => {
    streamingTextTaskByNodeRef.current.delete(nodeKey);
    setStreamingTextByNode((current) => {
      if (!(nodeKey in current)) return current;
      const next = { ...current };
      delete next[nodeKey];
      return next;
    });
  }, []);
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
  const [selectedAssetGroupId, setSelectedAssetGroupId] = useState<string | null>(null);
  // refreshCloudAssets 是稳定回调（依赖为空），通过 ref 读取当前分组避免重建。
  const selectedAssetGroupIdRef = useRef<string | null>(null);
  // 分页查询稳定回调读取的当前类型 / 防抖搜索词 / 页码。
  const assetKindRef = useRef<AssetKind>("image");
  const committedAssetSearchRef = useRef("");
  const cloudAssetPageRef = useRef(1);
  const localAssetPageRef = useRef(1);
  const [newGroupDialogOpen, setNewGroupDialogOpen] = useState(false);
  const [creatingGroup, setCreatingGroup] = useState(false);
  // 正在删除的云端素材库分组 ID（删除期间禁用入口，并阻止重复提交）。
  const [deletingAssetGroupId, setDeletingAssetGroupId] = useState<string | null>(null);
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
  // 拉取整个存储桶素材（ListObjectsV2 分页列举 + 写入本地索引）进行中标记。
  const [pullingBucket, setPullingBucket] = useState(false);
  const [assetUploads, setAssetUploads] = useState<readonly AssetUploadEntry[]>([]);
  // staging jobId -> 产物节点 key 映射，上传成功事件只有 jobId，需通过此映射回查产物节点并标记已上传。
  const uploadJobToOutputKeyRef = useRef<Map<string, string>>(new Map());
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
  // startUpload 返回 jobId 前，占位行的临时自增 id（前缀避免与后端真实 id 冲突）。
  const pendingUploadSeqRef = useRef(0);
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
  const videoDownloadQueuesRef = useRef(
    new Map<
      string,
      {
        sources: string[];
        batchId: string;
        activeJobId: string;
      }
    >(),
  );
  const [downloaderEngineStatus, setDownloaderEngineStatus] =
    useState<VideoDownloaderEngineStatus | null>(null);
  const downloaderEngineLoadedRef = useRef(false);
  const [downloaderEngineBusy, setDownloaderEngineBusy] = useState(false);
  // 视频抽帧节点：抽帧任务与会话内运行状态；产物自动落 origin=frame_extract 图片卡片。
  const [frameExtractorRuns, setFrameExtractorRuns] = useState<
    Readonly<Record<string, VideoFrameExtractorRunState>>
  >({});
  const frameExtractorStartNodesRef = useRef<Map<string, VideoFrameExtractorNodeData>>(new Map());
  const frameExtractionQueuesRef = useRef(
    new Map<
      string,
      {
        sources: string[];
        timestamps: readonly number[];
        batchId: string;
        activeJobId: string;
      }
    >(),
  );
  const cancelVideoToolBatches = useCallback(() => {
    for (const queue of videoDownloadQueuesRef.current.values()) {
      if (queue.activeJobId)
        void videoDownloaderClient.cancelJob(queue.activeJobId).catch(() => undefined);
    }
    videoDownloadQueuesRef.current.clear();
    videoDownloaderStartNodesRef.current.clear();
    for (const queue of frameExtractionQueuesRef.current.values()) {
      if (queue.activeJobId)
        void videoFrameExtractionClient.cancelJob(queue.activeJobId).catch(() => undefined);
    }
    frameExtractionQueuesRef.current.clear();
    frameExtractorStartNodesRef.current.clear();
  }, []);
  useEffect(() => {
    const downloaderKeys = new Set(videoDownloaderNodes.map((node) => node.key));
    for (const [key, queue] of videoDownloadQueuesRef.current) {
      if (downloaderKeys.has(key)) continue;
      videoDownloadQueuesRef.current.delete(key);
      videoDownloaderStartNodesRef.current.delete(key);
      setVideoDownloaderRuns((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      if (queue.activeJobId)
        void videoDownloaderClient.cancelJob(queue.activeJobId).catch(() => undefined);
    }
    const extractorKeys = new Set(frameExtractorNodes.map((node) => node.key));
    for (const [key, queue] of frameExtractionQueuesRef.current) {
      if (extractorKeys.has(key)) continue;
      frameExtractionQueuesRef.current.delete(key);
      frameExtractorStartNodesRef.current.delete(key);
      setFrameExtractorRuns((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      if (queue.activeJobId)
        void videoFrameExtractionClient.cancelJob(queue.activeJobId).catch(() => undefined);
    }
  }, [videoDownloaderNodes, frameExtractorNodes]);
  const [knowledgeVideoWorkflowRuns, setKnowledgeVideoWorkflowRuns] = useState<
    Readonly<Record<string, KnowledgeVideoWorkflowRunState>>
  >({});
  const knowledgeVideoWorkflowAbortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const recordedWorkflowRunner = useMemo(
    () => createRecordedWorkflowRunner({ canvasId }),
    [canvasId],
  );
  const activeWorkflowHistoryIdsRef = useRef(new Set<string>());
  const workflowHistoryActionsRef = useRef(new Set<string>());
  const [activeWorkflowHistoryIds, setActiveWorkflowHistoryIds] = useState<readonly string[]>([]);
  const recoverWorkflowHistory = services.recoverWorkflowHistory;
  useEffect(() => {
    if (!isDesktopRuntime()) return;
    void recoverWorkflowHistory().catch((error: unknown) => {
      toast.error("工作流历史恢复失败", { description: formatWorkflowError(error) });
    });
  }, [recoverWorkflowHistory]);
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
    cancelVideoToolBatches();
    clearCanvasState();
    setVideoComposerRuns({});
    setVideoDownloaderRuns({});
    setFrameExtractorRuns({});
    setKnowledgeVideoWorkflowRuns({});
    setGenNodeSizes({});
    setPreviewOutputNodeKey(null);
  }, [
    cancelVideoToolBatches,
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
      cancelVideoToolBatches();
      for (const controller of videoComposerAbortControllersRef.current.values()) {
        controller.abort();
      }
      videoComposerAbortControllersRef.current.clear();
      for (const controller of knowledgeVideoWorkflowAbortControllersRef.current.values()) {
        controller.abort();
      }
      knowledgeVideoWorkflowAbortControllersRef.current.clear();
    },
    [cancelVideoToolBatches],
  );

  const collectCanvasDocument = useCallback((): CanvasDocumentV2 => {
    const generationNodeKeys = new Set(
      genNodes.filter((node) => node.kind !== "prompt").map((node) => node.key),
    );
    return snapshotV2(promptContents.snapshotAll(generationNodeKeys));
  }, [genNodes, promptContents, snapshotV2]);

  const restoreCanvasDocument = useCallback(
    (raw: unknown) => {
      const restored = restoreDocument(raw);
      if (!restored.ok) throw new Error(`画布存档无法恢复：${restored.issues.join("；")}`);
      const document = raw as CanvasDocument;
      // restoreDocument 已原子替换节点、连线、视图与选择并清空历史；这里只同步 RF 与提示内容 adapter。
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
          });
        }
      }
    },
    [promptContents, restoreDocument],
  );

  const validateCanvasDelete = useCallback(async () => {
    if (
      startingNodeKeys.size > 0 ||
      knowledgeVideoWorkflowAbortControllersRef.current.size > 0 ||
      activeWorkflowHistoryIdsRef.current.size > 0 ||
      workflowHistoryActionsRef.current.size > 0 ||
      videoComposerAbortControllersRef.current.size > 0 ||
      videoDownloadQueuesRef.current.size > 0 ||
      frameExtractionQueuesRef.current.size > 0 ||
      Object.values(videoComposerRuns).some((run) => run.status === "running") ||
      Object.values(videoDownloaderRuns).some((run) => run.status === "running") ||
      Object.values(frameExtractorRuns).some((run) => run.status === "running")
    ) {
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
  }, [canvasId, startingNodeKeys, videoComposerRuns, videoDownloaderRuns, frameExtractorRuns]);

  const canvasPersistence = useCanvasDocumentPersistence({
    canvasId,
    collect: collectCanvasDocument,
    restore: restoreCanvasDocument,
    services,
    validateDelete: validateCanvasDelete,
  });
  const {
    hydrated: canvasHydrated,
    schedule: scheduleCanvasSave,
    documentChanged,
  } = canvasPersistence;

  useEffect(() => {
    if (canvasHydrated) documentChanged();
  }, [
    canvasHydrated,
    documentChanged,
    assetEdges,
    assetNodes,
    genNodes,
    screenplayNodes,
    storyboardNodes,
    viralRemixNodes,
    videoComposerNodes,
    videoDownloaderNodes,
    frameExtractorNodes,
    outputNodes,
    knowledgeVideoWorkflowNodes,
    pan,
    resultNodes,
    zoom,
  ]);

  useEffect(() => {
    if (!canvasHydrated || !active) return;
    const viewport = canvasViewportRef.current;
    if (viewport == null) return;
    viewport.addEventListener("input", scheduleCanvasSave);
    return () => viewport.removeEventListener("input", scheduleCanvasSave);
  }, [active, canvasHydrated, scheduleCanvasSave]);

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
      genNodes
        .filter((node) =>
          canvasInputsFor(node.key).media.some(
            (input) => input.kind === "image" || input.kind === "video",
          ),
        )
        .map((node) => node.key),
    );
  }, [canvasInputsFor, genNodes]);

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
            // 满页说明可能还有下一页；不足一页即最后一页（上游无过滤总数）。
            setCloudAssetHasMore(assets.length >= ASSET_PAGE_SIZE);
            setAssetsError(null);
            setLibraryError(false);
            frontendLog(
              "info",
              `[assets] 云端素材列表拉取成功: providerConnectionId=${providerConnectionId}, 触发来源=${source}, 页码=${pageNumber}, 共 ${assets.length} 个素材, 耗时 ${Date.now() - startedAt}ms`,
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
              `[assets] 云端素材列表拉取失败: providerConnectionId=${providerConnectionId}, 触发来源=${source}, 页码=${pageNumber}, 耗时 ${Date.now() - startedAt}ms, 错误: ${formatted}`,
            );
          },
        )
        .finally(() => {
          if (requestId === cloudAssetsRequestRef.current) setAssetsLoading(false);
        });
    },
    [],
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
    const pageNumber = localAssetPageRef.current;
    const mediaType = assetKindRef.current;
    const name = committedAssetSearchRef.current.trim();
    const startedAt = Date.now();
    setLocalAssetsLoading(true);
    frontendLog(
      "info",
      `[assets] 本地素材索引开始读取: 触发来源=${source}, 类型=${mediaType}, 页码=${pageNumber}`,
    );
    void tosStagingClient
      .listLocalAssets({
        mediaType,
        name: name || null,
        page: pageNumber,
        pageSize: ASSET_PAGE_SIZE,
      })
      .then(
        (page) => {
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
          const formatted = formatRawBackendError(error);
          setLocalAssetsError(error instanceof Error ? error.message : formatted);
          setLocalLibraryError(true);
          frontendLog(
            "error",
            `[assets] 本地素材索引读取失败: 触发来源=${source}, 页码=${pageNumber}, 耗时 ${Date.now() - startedAt}ms, 错误: ${formatted}`,
          );
        },
      )
      .finally(() => setLocalAssetsLoading(false));
  }, []);

  /** 拉取整个对象存储桶下的素材文件到本地素材索引（TOS ListObjectsV2 分页列举）。 */
  const handlePullBucketAssets = useCallback(async (): Promise<void> => {
    if (!isDesktopRuntime()) {
      toast.error("拉取存储桶素材仅在桌面应用中可用，浏览器预览模式暂不支持。");
      return;
    }
    if (pullingBucket) return;
    setPullingBucket(true);
    const startedAt = Date.now();
    try {
      const summary = await tosStagingClient.pullBucketAssets();
      frontendLog(
        "info",
        `[assets] 存储桶素材拉取完成: 总对象 ${summary.totalObjects}, 新导入 ${summary.imported}, 已存在跳过 ${summary.skippedExisting}, 非媒体忽略 ${summary.ignoredUnsupported}, 耗时 ${Date.now() - startedAt}ms`,
      );
      const details: string[] = [];
      if (summary.skippedExisting > 0) {
        details.push(`跳过 ${summary.skippedExisting} 个已存在`);
      }
      if (summary.ignoredUnsupported > 0) {
        details.push(`忽略 ${summary.ignoredUnsupported} 个非媒体文件`);
      }
      toast.success(
        `已拉取 ${summary.imported} 个新素材${details.length > 0 ? `（${details.join("，")}）` : ""}`,
      );
      refreshLocalAssets("manual");
    } catch (error) {
      const formatted = formatRawBackendError(error);
      frontendLog(
        "error",
        `[assets] 存储桶素材拉取失败: 耗时 ${Date.now() - startedAt}ms, 错误: ${formatted}`,
      );
      toast.error(`拉取存储桶素材失败：${formatted}`);
    } finally {
      setPullingBucket(false);
    }
  }, [pullingBucket, refreshLocalAssets]);

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
            setAssetsError(error instanceof Error ? error.message : formatted);
          },
        )
        .finally(() => setCreatingGroup(false));
    },
    [refreshAssetGroups],
  );

  const handleDeleteAssetGroup = useCallback(
    (providerConnectionId: string, groupId: string): void => {
      if (deletingAssetGroupId != null) return;
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
            setAssetsError(error instanceof Error ? error.message : formatted);
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
            setAssetsError(error instanceof Error ? error.message : formatted);
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
      setCloudAssetPageNumber(1);
      setLocalAssetPageNumber(1);
    };
    if (!isDesktopRuntime()) {
      assetQueryScopeKeyRef.current = "";
      return;
    }
    const scopeKey =
      assetLibrarySource === "cloud"
        ? `cloud|${assetProvider?.id ?? ""}|${settingsOpen ? "settings" : ""}`
        : `local|`;
    if (assetQueryScopeKeyRef.current === scopeKey) return;
    assetQueryScopeKeyRef.current = scopeKey;
    resetToFirstPage();
    if (assetLibrarySource === "cloud") {
      if (!assetProvider || settingsOpen) return;
      refreshCloudAssets(assetProvider.id, "initial");
      refreshAssetGroups(assetProvider.id);
      // 不用 cleanup 失效在途请求：provider/settings 等路径已显式递增请求号，
      // 而 refresh 本身也会递增；这里 cleanup 会在依赖变化但 key 未变时
      // 误杀在途响应且不重发，导致面板卡在空列表。
    } else {
      refreshLocalAssets("initial");
    }
    // refreshCloudAssets / refreshLocalAssets / refreshAssetGroups 均为稳定回调（依赖为空）。
  }, [
    assetLibrarySource,
    assetProvider,
    refreshAssetGroups,
    refreshCloudAssets,
    refreshLocalAssets,
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
    const filterKey = `${assetKind}|${committedAssetSearch}|${selectedAssetGroupId ?? ""}`;
    if (assetQueryFilterKeyRef.current === filterKey) return;
    assetQueryFilterKeyRef.current = filterKey;
    if (!assetQueryFilterArmedRef.current) {
      assetQueryFilterArmedRef.current = true;
      return;
    }
    cloudAssetPageRef.current = 1;
    localAssetPageRef.current = 1;
    setCloudAssetPageNumber(1);
    setLocalAssetPageNumber(1);
    if (assetLibrarySource === "cloud") {
      if (!assetProvider || settingsOpen) return;
      refreshCloudAssets(assetProvider.id, "filter");
    } else {
      refreshLocalAssets("filter");
    }
  }, [
    assetKind,
    assetLibrarySource,
    assetProvider,
    committedAssetSearch,
    refreshCloudAssets,
    refreshLocalAssets,
    selectedAssetGroupId,
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
      // 非桌面（浏览器预览）环境：文件选择器直接返回空，明确提示而非静默无反应。
      if (!isDesktopRuntime()) {
        const message = "上传素材功能仅在桌面应用中使用，浏览器预览模式暂不支持。";
        if (destination === "cloud") setAssetsError(message);
        else setLocalAssetsError(message);
        return 0;
      }
      if (destination === "cloud" && !assetProvider) {
        setAssetsError("请先在全局设置中配置并启用供应商连接，再上传本地素材。");
        return 0;
      }
      if (destination === "cloud") setAssetsError(null);
      else setLocalAssetsError(null);
      // 预检对象存储（TOS）配置：未配置或未启用时直接明确提示，避免后台异步静默失败。
      let stagingConfig: TosStagingConfig | null;
      try {
        stagingConfig = await tosStagingClient.getConfig();
      } catch (error) {
        const message = `对象存储配置读取失败：${formatRawBackendError(error)}`;
        if (destination === "cloud") setAssetsError(message);
        else setLocalAssetsError(message);
        return 0;
      }
      if (stagingConfig == null || !stagingConfig.enabled) {
        const message =
          "对象存储未启用，无法上传素材：请在“设置 → 对象存储”中填写桶名、AccessKey 与 Secret 并保存（桶名为空会停用上传）。";
        if (destination === "cloud") setAssetsError(message);
        else setLocalAssetsError(message);
        return 0;
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
        readonly kind: MediaType;
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
          const jobId = await tosStagingClient.startUpload({
            localPath: candidate.filePath,
            purpose: destination === "local" ? "local_asset" : "asset_import",
            mediaType: candidate.kind,
            import:
              destination === "cloud" && assetProvider
                ? {
                    providerConnectionId: assetProvider.id,
                    name: candidate.name,
                    // 真人素材上传用平台数值分组 ID；普通上传沿用面板当前选中的分组，
                    // 未选中任何分组时传 null，由后端发现/创建默认上传分组。
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
          if (destination === "cloud") setAssetsError(formatRawBackendError(error));
          else setLocalAssetsError(formatRawBackendError(error));
        }
      }
      if (unsupportedFiles.length > 0) {
        const message = `不支持的文件类型，已跳过：${unsupportedFiles.join("、")}。支持 mp4 / mov / webm / avi / mkv 等常见格式。`;
        if (destination === "cloud") setAssetsError(message);
        else setLocalAssetsError(message);
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

  /** 产物图片/视频一键上传到云端素材库：直接使用产物的本地 finalPath，跳过文件选择器。 */
  const handleUploadOutputToCloud = useCallback(
    async (outputKey: string): Promise<void> => {
      const output = outputNodes.find((node) => node.key === outputKey);
      if (
        output == null ||
        (output.mediaType !== "image" && output.mediaType !== "video") ||
        output.finalPath == null
      ) {
        toast.error("仅已保存到本地的图片/视频产物支持上传到云端素材库。");
        return;
      }
      if (!isDesktopRuntime()) {
        toast.error("上传素材功能仅在桌面应用中使用，浏览器预览模式暂不支持。");
        return;
      }
      if (!assetProvider) {
        toast.error("请先在全局设置中配置并启用供应商连接，再上传到云端素材库。");
        return;
      }
      let stagingConfig: TosStagingConfig | null;
      try {
        stagingConfig = await tosStagingClient.getConfig();
      } catch (error) {
        toast.error(`对象存储配置读取失败：${formatRawBackendError(error)}`);
        return;
      }
      if (stagingConfig == null || !stagingConfig.enabled) {
        toast.error(
          "对象存储未启用，无法上传素材：请在“设置 → 对象存储”中填写桶名、AccessKey 与 Secret 并保存。",
        );
        return;
      }
      const pendingId = `pending-upload-${pendingUploadSeqRef.current++}`;
      const name =
        output.name ??
        output.finalPath.split(/[\\/]/).pop() ??
        `${output.mediaType === "video" ? "视频" : "图片"}产物`;
      // 记录 pendingId -> 产物节点 key 映射，上传成功后回查标记绿色小点。
      uploadJobToOutputKeyRef.current.set(pendingId, outputKey);
      setAssetUploads((current) => [
        ...current,
        {
          jobId: pendingId,
          name,
          kind: output.mediaType as "image" | "video",
          assetId: null,
          status: "preparing",
          bytesUploaded: 0,
          bytesTotal: null,
          error: null,
          lastAdvancedAt: Date.now(),
          stalled: false,
          destination: "cloud",
          adjustment: null,
        },
      ]);
      try {
        const jobId = await tosStagingClient.startUpload({
          localPath: output.finalPath,
          purpose: "asset_import",
          mediaType: output.mediaType,
          import: {
            providerConnectionId: assetProvider.id,
            name,
            // 产物上传同样归入面板当前选中的分组；未选中时由后端决定默认上传分组。
            groupId: selectedAssetGroupIdRef.current,
          },
        });
        // pendingId 替换为真实 jobId，保持映射连续。
        uploadJobToOutputKeyRef.current.delete(pendingId);
        uploadJobToOutputKeyRef.current.set(jobId, outputKey);
        setAssetUploads((current) =>
          current.map((entry) =>
            entry.jobId === pendingId
              ? { ...entry, jobId, status: "validating", lastAdvancedAt: Date.now() }
              : entry,
          ),
        );
        toast.success(`已开始上传「${name}」到云端素材库，可在素材面板查看进度。`);
      } catch (error) {
        setAssetUploads((current) =>
          current.map((entry) =>
            entry.jobId === pendingId
              ? { ...entry, status: "failed", error, lastAdvancedAt: Date.now() }
              : entry,
          ),
        );
        toast.error(`上传失败：${formatRawBackendError(error)}`);
      }
    },
    [assetProvider, outputNodes],
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
            bytesUploaded: job?.bytesUploaded ?? existing.bytesUploaded,
            bytesTotal: job?.bytesTotal ?? existing.bytesTotal,
            // 失败原因有两个来源：事件顶层的 error（进程内失败时后端只发 error），
            // 以及任务记录里的 job.error（跑完一轮后落库的完整记录，前端走 startUpload
            // 的那条路径就吃这个）。只看顶层会把后者的失败原因丢掉，用户看到一行
            // "失败"却没有任何原因。
            error: payload.error ?? job?.error ?? existing.error,
            // 后端的尺寸归一化说明在上传阶段就已写回任务记录，随事件一起送达。
            adjustment: job?.adjustment ?? existing.adjustment,
          };
        }
        return next;
      });
      const status = payload.job?.status;
      // 入库是否成功看 `assetId` 而不是状态：后端给出素材身份后还会清理暂存对象
      // （active → cleaning → cleaned），事件里读到的未必是 active。
      const reachedLibrary = payload.job != null && stagingImportReachedLibrary(payload.job);
      if (payload.job?.purpose === "local_asset" && status === "staged") {
        refreshLocalAssets("upload-finished");
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
      // 上传到云端素材库成功：标记对应产物节点已上传（写入节点数据，随画布文档持久化）。
      if (reachedLibrary) {
        const outputKey = uploadJobToOutputKeyRef.current.get(payload.jobId);
        if (outputKey) {
          patchNodes("output", (node) =>
            node.key === outputKey && !node.uploadedToCloud
              ? { ...node, uploadedToCloud: true }
              : node,
          );
          uploadJobToOutputKeyRef.current.delete(payload.jobId);
        }
      } else if (status === "failed" || status === "interrupted") {
        // 上传失败：清理映射，不标记已上传。
        uploadJobToOutputKeyRef.current.delete(payload.jobId);
      }
      // 成功的上传不用用户再点一次 ×：素材已经入库、绿色小点已经点亮，这一行
      // 留一小会儿让"已完成"被看见，然后自行收起。失败/中断行永不自动收起
      // （用户要看原因并重试），僵尸在途行也留着由行内判定落地为可移除的已中断行。
      if (payload.job != null && shouldAutoDismissUpload(payload.job)) {
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
    patchNodes,
    refreshAssetGroups,
    refreshCloudAssets,
    refreshLocalAssets,
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
        // 在途上传恢复成面板行：状态与字节进度都来自后端记录，之后由既有轮询继续推进。
        // 长时间没有推进的记录不再当作"还在传"：进程在上传途中被杀时后端会留下一个
        // staged/importing 的僵死记录，显示成在途会让进度条永远转下去，用户既
        // 不知道失败也无法重试；按僵尸口径直接落地为已中断，给出明确的终态与原因。
        // 已经拿到素材身份的记录不算在内：那是入库成功（随后清理暂存对象没走完而已），
        // 恢复成在途行会让它两分钟后被判成"已中断"，而素材其实已经在库里了。
        const restoredEntries: AssetUploadEntry[] = records
          .filter((record) => !stagingImportReachedLibrary(record))
          .map((record) => {
            const lastAdvancedAt = record.updatedAt || restoredAt;
            const abandoned = restoredAt - lastAdvancedAt >= UPLOAD_ABANDONED_MS;
            return {
              jobId: record.jobId,
              name: localPathFileName(record.localPath),
              kind: record.mediaType,
              assetId: record.assetId,
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
          toast.info(`已接管 ${restoredEntries.length} 个重启前未完成的上传`, {
            description: "后台仍在继续，可在素材面板查看进度。",
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
  }, []);

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
    if (completed.length === 0 || outputNodes.length === 0) return;
    const outputKeyByLocalPath = new Map<string, string>();
    for (const node of outputNodes) {
      if (node.finalPath == null || node.finalPath === "") continue;
      outputKeyByLocalPath.set(normalizeLocalPathKey(node.finalPath), node.key);
    }
    const matchedKeys: string[] = [];
    for (const record of completed) {
      const outputKey = outputKeyByLocalPath.get(normalizeLocalPathKey(record.localPath));
      if (outputKey == null) continue;
      // 先重建映射再点亮：即使产物节点这一刻还没补齐 uploadedToCloud，事件路径也能命中。
      uploadJobToOutputKeyRef.current.set(record.jobId, outputKey);
      if (outputNodes.some((node) => node.key === outputKey && node.uploadedToCloud !== true)) {
        matchedKeys.push(outputKey);
      }
    }
    if (matchedKeys.length === 0) return;
    const keys = new Set(matchedKeys);
    patchNodes("output", (node) =>
      keys.has(node.key) && !node.uploadedToCloud ? { ...node, uploadedToCloud: true } : node,
    );
    frontendLog("info", `[assets] 重启恢复绿色小点: 命中产物节点 ${matchedKeys.length} 个`);
  }, [outputNodes, patchNodes]);

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
      return node;
    },
    [
      dropPosition,
      nodeModelSelections.image,
      nodeModelSelections.prompt,
      nodeModelSelections.video,
      providerCatalogLoaded,
    ],
  );

  /** 在画布上创建一个生成节点（来自节点仓库拖拽或键盘新增）。 */
  const addGenNode = useCallback(
    (kind: CanvasGenNodeKind, x: number, y: number) => {
      const node = createGenNode(kind, x, y);
      addNode("gen", node, { select: true });
      frontendLog(
        "info",
        `[canvas] 生成节点已创建: key=${node.key}, kind=${kind}, 位置=(${Math.round(node.x)}, ${Math.round(node.y)})`,
      );
      return node;
    },
    [addNode, createGenNode],
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
    async (
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
        const templateModule = await import("./workflowTemplates");
        const createWorkflow = {
          knowledge: templateModule.createKnowledgeVideoDirectorWorkflow,
          film: templateModule.createAiFilmWorkflow,
          comicDrama: templateModule.createComicDramaWorkflow,
          commerce: templateModule.createCommerceWorkflow,
          remotion: templateModule.createRemotionWorkflow,
          xhsCover: templateModule.createXhsCoverWorkflow,
          reverseVideo: templateModule.createReverseVideoWorkflow,
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
  const insertKnowledgeVideoDirectorWorkflow = useCallback(() => {
    void insertWorkflow("knowledge");
  }, [insertWorkflow]);
  const insertAiFilmWorkflow = useCallback(() => {
    void insertWorkflow("film");
  }, [insertWorkflow]);
  const insertComicDramaWorkflow = useCallback(() => {
    void insertWorkflow("comicDrama");
  }, [insertWorkflow]);
  const insertCommerceWorkflow = useCallback(() => {
    void insertWorkflow("commerce");
  }, [insertWorkflow]);
  const insertRemotionWorkflow = useCallback(() => {
    void insertWorkflow("remotion");
  }, [insertWorkflow]);
  const insertXhsCoverWorkflow = useCallback(() => {
    void insertWorkflow("xhsCover");
  }, [insertWorkflow]);
  const insertReverseVideoWorkflow = useCallback(() => {
    void insertWorkflow("reverseVideo");
  }, [insertWorkflow]);
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
        if (latest.canvasId !== canvasId) throw new Error("请先打开这条工作流所属的画布。");
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
            node: withLiveWorkflowCanvasInputs(restored.node, original),
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
      canvasId,
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
        const generalPaths = new Set(materials.map(workflowMaterialPathKey));
        for (const item of picked) {
          const path = workflowMaterialPathKey(item);
          if (generalPaths.has(path) || !Number.isFinite(item.byteSize) || item.byteSize <= 0) {
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
          description: "重复文件会跳过，不支持空文件。",
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
        for (const item of picked) {
          if (
            item.kind !== "image" ||
            paths.has(workflowMaterialPathKey(item)) ||
            items.length >= (role === "portrait" ? 3 : 5) ||
            !Number.isFinite(item.byteSize) ||
            item.byteSize <= 0
          ) {
            rejected++;
            continue;
          }
          paths.add(workflowMaterialPathKey(item));
          items.push(item);
        }
        return { ...node, config: { ...node.config, xhsCover: { ...options, [field]: items } } };
      });
      if (rejected)
        toast.info(`${rejected} 张图片未添加`, {
          description: "人物参考图最多 3 张、补充图片最多 5 张，仅支持非空图片，重复图片会跳过。",
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
        for (const item of picked) {
          if (
            (item.kind !== "image" && item.kind !== "document") ||
            paths.has(workflowMaterialPathKey(item)) ||
            !Number.isFinite(item.byteSize) ||
            item.byteSize <= 0
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
          description: "支持非空图片与文档，重复文件会跳过。",
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
  const redoKnowledgeVideoWorkflowShot = useCallback(
    (key: string, shotId: string) => {
      if (knowledgeVideoWorkflowAbortControllersRef.current.has(key)) return;
      const node = knowledgeVideoWorkflowNodes.find((candidate) => candidate.key === key);
      const checkpoint: KnowledgeVideoWorkflowCheckpoint | undefined = node?.config.checkpoint;
      const run: KnowledgeVideoWorkflowShotRun | undefined = checkpoint?.shotRuns[shotId];
      const shot = checkpoint?.shots.find((item) => item.id === shotId);
      if (!node || !checkpoint || !run || !shot) return;
      const supersededTaskId = run.videoTaskId ?? null;
      const nextRun: KnowledgeVideoWorkflowShotRun = {
        ...run,
        redoRequested: true,
        videoTaskId: null,
        clipPath: null,
        qcStatus: "pending",
        retryCount: 0,
        repairPrompt: null,
        qcReport: "用户要求重做此镜头，已重新提交生成。",
        ...(supersededTaskId
          ? { supersededTaskIds: [...(run.supersededTaskIds ?? []), supersededTaskId] }
          : {}),
      };
      const nextCheckpoint: KnowledgeVideoWorkflowCheckpoint = {
        ...checkpoint,
        phase: "paused",
        lastActivePhase: checkpoint.lastActivePhase ?? "generating",
        activeCompositionJobId: null,
        error: null,
        decision: null,
        shotRuns: { ...checkpoint.shotRuns, [shotId]: nextRun },
        updatedAt: Date.now(),
      };
      patchNode("knowledgeVideoWorkflow", key, (currentNode) => ({
        ...currentNode,
        config: { ...currentNode.config, checkpoint: nextCheckpoint },
      }));
      toast.info("正在重做该镜头", {
        description: `镜头 ${shot.sequence} 只重跑这一个分镜，其他镜头保持不变。`,
      });
      runKnowledgeVideoWorkflow(key, true);
    },
    [knowledgeVideoWorkflowNodes, patchNode, runKnowledgeVideoWorkflow],
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
        defaultStoryboardPrompt ||
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
      contextHistory.push(
        ...canvasInputsFor(nodeKey).texts.map((input) => ({
          role: `已连接的上游文本 · ${input.name}`,
          content: input.text,
        })),
      );
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
          canvasId: canvasId,
          sourceNodeId: nodeKey,
          providerConnectionId: provider.provider.id,
          modelDefinitionId: model.definitionId,
          mode: node.config.mode,
          task: node.config.task,
          userPrompt: sourcePrompt,
          contextHistory,
          visionImages,
          referenceInputs: videoMaterials,
        })
        .then((result) => {
          const cleanedPrompt = cleanGeneratedPrompt(result.optimizedPrompt);
          patchNode("gen", nodeKey, (item) =>
            item.kind === "prompt"
              ? {
                  ...item,
                  config: {
                    ...item.config,
                    generatedPrompt: cleanedPrompt,
                    conversation: [
                      ...(item.config.conversation ?? []),
                      { id: promptMessageId(), role: "user", content: sourcePrompt },
                      { id: promptMessageId(), role: "assistant", content: cleanedPrompt },
                    ],
                  },
                }
              : item,
          );
          frontendLog(
            "info",
            `[generation] 提示词节点请求完成: node=${nodeKey}, 返回 ${result.optimizedPrompt.length} 字符，清洗后 ${cleanedPrompt.length} 字符`,
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
          // 完整结果已写入节点（或已失败），流式草稿不再需要。
          clearStreamingText(nodeKey);
          setStartingNodeKeys((current) => {
            const next = new Set(current);
            next.delete(nodeKey);
            return next;
          });
        });
    },
    [
      canvasId,
      genNodes,
      promptVideoMaterials,
      promptVisionImages,
      providerCatalog,
      canvasInputsFor,
      setNodeStartError,
      startingNodeKeys,
      patchNode,
      clearStreamingText,
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
      contextHistory.push(
        ...connected.texts.map((input) => ({
          role: `已连接的上游文本 · ${input.name}`,
          content: input.text,
        })),
      );
      const multimodalInputs = screenplayMultimodalInputs(node.config);
      setNodeStartError(nodeKey, null);
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
          // 完整结果已写入节点（或已失败），流式草稿不再需要。
          clearStreamingText(nodeKey);
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
      screenplayNodes,
      setNodeStartError,
      startingNodeKeys,
      canvasInputsFor,
      clearStreamingText,
    ],
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
      const connected = canvasInputsFor(nodeKey);
      const userPrompt =
        node.config.composer.trim() ||
        (connected.texts.length || connected.media.length
          ? "请将已连接的剧本转换为工业级分镜脚本。"
          : "");
      if (!userPrompt) {
        failWith("请连接参考文本或素材、粘贴剧本，或输入本轮分镜要求。");
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
      const contextHistory: PromptOptimizationContextEntry[] = connected.texts.map((input) => ({
        role: `已连接的上游 Markdown 剧本 · ${input.name}`,
        content: input.text,
      }));
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
          canvasId: canvasId,
          sourceNodeId: nodeKey,
          providerConnectionId: provider.provider.id,
          modelDefinitionId: model.definitionId,
          mode: "storyboard",
          task: "generate",
          userPrompt,
          contextHistory,
          referenceInputs: connected.media.map((input) => ({
            target: input.target,
            displayName: input.name,
          })),
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
          // 完整结果已写入节点（或已失败），流式草稿不再需要。
          clearStreamingText(nodeKey);
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
      canvasInputsFor,
      setNodeStartError,
      startingNodeKeys,
      storyboardNodes,
      clearStreamingText,
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
      const resolved = canvasInputsFor(nodeKey);
      const inputs = resolved.media.filter((input) => input.kind === "video");
      if (!node) return;
      const failWith = (message: string) => setNodeStartError(nodeKey, message);
      if (!isDesktopRuntime()) {
        failWith("爆款视频复刻只能在桌面应用中运行。请通过 Tauri 桌面端使用。");
        return;
      }
      if (inputs.length === 0 || inputs.some((input) => !input.src)) {
        failWith("当前上游没有可读取的视频。请提供视频来源，或先完成上游视频生成、下载。");
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
        failWith("请先在当前复刻节点中选择可用的多模态文本模型。");
        return;
      }
      setNodeStartError(nodeKey, null);
      setStartingNodeKeys((current) => new Set(current).add(nodeKey));
      frontendLog(
        "info",
        `[viral-remix] 开始本地密集抽帧: node=${nodeKey}, inputs=${inputs.length}`,
      );
      void import("../../lib/videoFrameSampler")
        .then(async ({ buildVideoContactSheets }) => {
          const documents: string[] = [];
          for (const [index, input] of inputs.entries()) {
            const contactSheets = await buildVideoContactSheets(input.src!);
            const instructions = node.config.instructions.trim();
            const userPrompt = [
              `输入视频 ${index + 1}/${inputs.length}：${input.name}`,
              `已验证时长：${contactSheets.duration.toFixed(3)} 秒`,
              `全片抽帧：${contactSheets.overviewFrameCount} 帧；结尾 5 秒加密：${contactSheets.tailFrameCount} 帧；联系表：${contactSheets.sheets.length} 张。`,
              instructions
                ? `用户补充方向：${instructions}`
                : "用户未指定额外方向，请执行技能默认复刻合同。",
              ...resolved.texts.map((text) => `上游文档（${text.name}）：\n${text.text}`),
              "静态联系表不包含可听声音；任何对白、音乐或音效判断都必须标记为待听觉确认。",
            ].join("\n");
            const result = await promptNodeClient.run({
              canvasId: canvasId,
              sourceNodeId: nodeKey,
              providerConnectionId: provider.provider.id,
              modelDefinitionId: model.definitionId,
              mode: "viral_remix",
              task: "generate",
              userPrompt,
              visionImages: contactSheets.sheets.map((sheet) => ({
                dataUrl: sheet.dataUrl,
                displayName: `${input.name} · ${sheet.displayName}`,
              })),
            });
            documents.push(
              inputs.length === 1
                ? result.optimizedPrompt
                : `# 视频 ${index + 1}：${input.name}\n\n${result.optimizedPrompt}`,
            );
            patchNode("viralRemix", nodeKey, (item) => ({
              ...item,
              config: { ...item.config, currentDocument: documents.join("\n\n---\n\n") },
            }));
          }
          frontendLog(
            "info",
            `[viral-remix] 全部复刻方案完成: node=${nodeKey}, inputs=${inputs.length}`,
          );
        })
        .catch((error: unknown) => {
          const message = formatRawBackendError(error);
          setNodeStartError(nodeKey, message);
          frontendLog("error", `[viral-remix] 复刻失败: node=${nodeKey}, ${message}`);
        })
        .finally(() => {
          // 完整结果已写入节点（或已失败），流式草稿不再需要。
          clearStreamingText(nodeKey);
          setStartingNodeKeys((current) => {
            const next = new Set(current);
            next.delete(nodeKey);
            return next;
          });
        });
    },
    [
      canvasId,
      providerCatalog,
      canvasInputsFor,
      setNodeStartError,
      startingNodeKeys,
      viralRemixNodes,
      patchNode,
      clearStreamingText,
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

  /** 连线保存节点身份；全部参数通过共享解析器在执行时读取。 */
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

  // 云端素材节点预览续签成功：把新签名地址回写节点数据并随画布文档持久化。
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
    { enabled: active && selectedEdgeId != null },
    [active, removeAssetEdge, selectEdge, selectedEdgeId],
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
      );
      const taskState = resolveSeedanceTask(
        selection.model.remoteModelId,
        capabilities,
        nextConfig,
        [...inputs, frame],
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

  /**
   * 回到画布起始位置：平移回原点并恢复默认缩放，与新建画布的初始视口一致
   * （原点在视口左上角、缩放为 DEFAULT_ZOOM）。落点同样由 onMoveEnd 同步回 store。
   */
  const resetCanvasViewport = useCallback(() => {
    const instance = flowInstanceRef.current;
    if (instance == null) {
      // 实例尚未就绪（理论仅在挂载前）：先同步展示层，挂载后由 onInit 应用视图。
      setView({ zoom: DEFAULT_ZOOM, pan: { x: 0, y: 0 } });
      return;
    }
    void instance.setViewport({ x: 0, y: 0, zoom: DEFAULT_ZOOM / 100 }, { duration: 200 });
  }, [setView]);

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
      // 兜底刷新：轮询发现任务到达终态时也刷新素材列表，覆盖终态事件丢失的场景。
      // 事件通道仍是主路径，此处与事件刷新重复调用是幂等的列表拉取。
      for (const job of jobs) {
        if (job == null) continue;
        const entry = uploadEntriesRef.current.find((item) => item.jobId === job.id);
        if (entry == null || isTerminalAssetUpload(entry)) continue;
        const reachedTerminal =
          isTerminalStagingJob(job) || (entry.destination === "local" && job.status === "staged");
        if (!reachedTerminal) continue;
        if (entry.destination === "local") {
          refreshLocalAssets("upload-finished");
        } else if (assetLibrarySource === "cloud" && assetProvider) {
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
    queryClient,
    refreshAssetGroups,
    refreshCloudAssets,
    refreshLocalAssets,
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
    queryKey: [...GENERATION_TASKS_QUERY_KEY, canvasId],
    queryFn: () => generationClient.list({ canvasId, limit: 50 }),
    enabled: isDesktopRuntime(),
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

  const refreshTasks = useCallback(() => {
    if (!isDesktopRuntime()) return;
    void queryClient.invalidateQueries({ queryKey: GENERATION_TASKS_QUERY_KEY });
  }, [queryClient]);

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
        if (info?.taskId && info.taskId !== streamingTextTaskByNodeRef.current.get(nodeKey)) {
          // 同一节点可能被连续发起多轮；任务 ID 变了说明是新一轮，从空开始累积。
          streamingTextTaskByNodeRef.current.set(nodeKey, info.taskId);
          setStreamingTextByNode((current) => ({ ...current, [nodeKey]: chunk }));
          return;
        }
        setStreamingTextByNode((current) => ({
          ...current,
          [nodeKey]: `${current[nodeKey] ?? ""}${chunk}`,
        }));
        return;
      }
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
      let connections: PromptContentConnection[] = [
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

      const parameterCapabilities = modelParameterCapabilities(
        resolvedSelection.model.operationSchema,
        operation,
        resolvedSelection.model.remoteModelId,
      );
      const seedanceTask =
        genNode.kind === "video"
          ? resolveSeedanceTask(
              resolvedSelection.model.remoteModelId,
              parameterCapabilities,
              genNode.config,
              connectedAssets,
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
      const parameters: Record<string, unknown> = seedanceTask?.enabled
        ? seedanceTask.parameters
        : generationParameters(
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
            canvasId: canvasId,
            sourceNodeId: nodeKey,
            operation,
            providerConnectionId: selection.providerId,
            modelDefinitionId: selection.modelDefinitionId,
            prompt: promptSegments,
            explicitMedia,
            parameters,
            ...(seedanceTask?.enabled ? { videoTaskType: seedanceTask.mode } : {}),
            generationCount: 1,
          })
          .then((taskId) => {
            // 任务创建成功 → 立即在来源生成节点右侧落下占位产物卡片并连虚线，
            // 卡片承担任务状态栏职责：进行中展示进度，成功填充产物，失败展示完整错误。
            // 支持 n 参数的模型一次请求返回多张图：生成开始时就落下与数量相等的占位卡片，
            // 每个卡片预设 resultKey=taskId#index，结果返回后按 index 原地填充。
            const placeholderCount = supportsBatchCount ? generationCount : 1;
            for (let resultIndex = 0; resultIndex < placeholderCount; resultIndex += 1) {
              const key = outputNodeKey();
              addOutput((current) => ({
                key,
                resultKey: supportsBatchCount ? `${taskId}#${resultIndex}` : null,
                sourceNodeId: genNode.key,
                taskId,
                mediaType: genNode.kind === "video" ? "video" : "image",
                finalPath: null,
                previewSrc: null,
                name: null,
                ...nextOutputSlot(genNode, current),
              }));
            }
            frontendLog(
              "info",
              `[canvas] 已创建生成占位产物卡片: task=${taskId}, 数量=${placeholderCount}`,
            );
            return refreshTasks();
          })
          .catch((error: unknown) => {
            startErrors.push(formatRawBackendError(error));
          })
          .finally(settleOne);
      }
    },
    [
      canvasId,
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

  /** 从生成任务历史重新生成：创建全新任务；若来源节点仍在画布上，落下占位产物卡片。 */
  const regenerateGenerationFromHistory = useCallback(
    async (command: StartGenerationCommand): Promise<string> => {
      const genNode =
        command.canvasId === canvasId
          ? genNodes.find((node) => node.key === command.sourceNodeId)
          : undefined;
      // 支持 n 参数的模型一次请求返回多张图；其余模型数量 > 1 时拆分为多个独立任务。
      const supportsBatchCount =
        typeof command.parameters?.["n"] === "number" && command.parameters["n"] > 1;
      const taskCount = supportsBatchCount ? 1 : Math.max(1, command.generationCount ?? 1);
      let firstTaskId = "";

      for (let taskIndex = 0; taskIndex < taskCount; taskIndex += 1) {
        const taskCommand = supportsBatchCount ? command : { ...command, generationCount: 1 };
        const taskId = await generationClient.start(taskCommand);
        if (taskIndex === 0) firstTaskId = taskId;

        if (genNode != null) {
          if (supportsBatchCount) {
            // 单任务多结果：创建 n 个占位卡片，每个预设 resultKey=taskId#index
            const batchCount = Math.min(
              GPT_IMAGE_MAX_GENERATION_COUNT,
              Math.floor(command.parameters["n"] as number),
            );
            for (let resultIndex = 0; resultIndex < batchCount; resultIndex += 1) {
              const key = outputNodeKey();
              addOutput((current) => ({
                key,
                resultKey: `${taskId}#${resultIndex}`,
                sourceNodeId: genNode.key,
                taskId,
                mediaType: command.operation === "video_generation" ? "video" : "image",
                finalPath: null,
                previewSrc: null,
                name: null,
                ...nextOutputSlot(genNode, current),
              }));
            }
            frontendLog(
              "info",
              `[canvas] 历史重新生成已创建占位产物卡片: task=${taskId} node=${genNode.key} 数量=${batchCount}（单任务多结果）`,
            );
          } else {
            // 多任务：每个任务一个占位卡片
            const key = outputNodeKey();
            addOutput((current) => ({
              key,
              resultKey: null,
              sourceNodeId: genNode.key,
              taskId,
              mediaType: command.operation === "video_generation" ? "video" : "image",
              finalPath: null,
              previewSrc: null,
              name: null,
              ...nextOutputSlot(genNode, current),
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
    [canvasId, addOutput, genNodes, refreshTasks],
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
    const canvasTaskIds = new Set(generationTasks.map((task) => task.id));
    for (const node of outputNodes) if (node.taskId) canvasTaskIds.add(node.taskId);
    const results = Object.values(taskResults)
      .flat()
      .filter(
        (result) =>
          canvasTaskIds.has(result.taskId) && result.saveStatus === "succeeded" && result.finalPath,
      )
      .sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0));
    return results[0] ?? null;
  }, [generationTasks, outputNodes, taskResults]);

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
    for (const node of genNodes) {
      map.set(
        node.key,
        canvasInputsFor(node.key).media.map((input) => ({
          ...input,
          previewUrl: input.previewUrl ?? null,
        })),
      );
    }
    return map;
  }, [canvasInputsFor, genNodes]);

  /** 所有上游节点中的可读取视频，按节点保存的顺序排列。 */
  const videoComposerInputsByNode = useMemo(() => {
    const map = new Map<string, VideoComposerInput[]>();
    for (const composer of videoComposerNodeByKey.values()) {
      const connected: VideoComposerInput[] = canvasInputsFor(composer.key)
        .media.filter((input) => input.kind === "video" && input.src != null)
        .map((input) => ({
          key: input.key,
          name: input.name,
          src: input.src!,
          sourceLabel: input.sourceLabel,
          edgeId: input.edgeId,
          ffmpegSource: input.finalPath ?? (/^https?:\/\//i.test(input.src!) ? input.src : null),
        }));
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
  }, [canvasInputsFor, videoComposerNodeByKey]);

  const inputOrderByEdge = useMemo(() => {
    const direct = new Map(
      [...canvasEdgeIndex.byTarget].map(([key, edges]) => [
        key,
        edges.map((edge) => ({ edgeId: edge.id })),
      ]),
    );
    return buildInputOrderByEdge(direct);
  }, [canvasEdgeIndex]);

  const viralRemixInputsByNode = useMemo(() => {
    const map = new Map<string, ViralRemixVideoInput[]>();
    for (const node of viralRemixNodeByKey.values()) {
      const resolved = canvasInputsFor(node.key);
      const videos: ViralRemixVideoInput[] = resolved.media
        .filter((input) => input.kind === "video")
        .map((input) => ({
          key: input.key,
          name: input.name,
          src: input.src,
          sourceLabel: videoDownloaderNodeByKey.has(
            outputNodeByKey.get(input.sourceKey)?.sourceNodeId ?? "",
          )
            ? "下载节点"
            : input.sourceLabel,
          edgeId: input.edgeId,
        }));
      for (const input of resolved.pending) {
        if (!videoDownloaderNodeByKey.has(input.sourceKey)) continue;
        videos.push({
          key: input.sourceKey,
          name: input.name,
          src: null,
          sourceLabel: "下载节点",
          edgeId: input.edgeId,
        });
      }
      map.set(node.key, videos);
    }
    return map;
  }, [canvasInputsFor, videoDownloaderNodeByKey, outputNodeByKey, viralRemixNodeByKey]);

  const frameExtractorInputsByNode = useMemo(() => {
    const map = new Map<string, FrameExtractorVideoInput[]>();
    for (const node of frameExtractorNodeByKey.values()) {
      map.set(
        node.key,
        canvasInputsFor(node.key)
          .media.filter((input) => input.kind === "video")
          .map((input) => ({
            key: input.key,
            name: input.name,
            src: input.src,
            sourceLabel: input.sourceLabel,
            edgeId: input.edgeId,
            finalPath:
              input.finalPath ?? (input.src && /^https?:\/\//i.test(input.src) ? input.src : null),
          })),
      );
    }
    return map;
  }, [canvasInputsFor, frameExtractorNodeByKey]);

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
      if (canvasInputsFor(nodeKey).media.some((input) => input.kind === "video" && !input.src)) {
        setVideoComposerRuns((current) => ({
          ...current,
          [nodeKey]: {
            status: "error",
            progress: 0,
            error: "部分上游视频尚无可读取的地址，请先完成生成或保存视频。",
          },
        }));
        return;
      }
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
      canvasInputsFor,
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

  const videoDownloadSourcesByNode = useMemo(
    () =>
      new Map(
        videoDownloaderNodes.map((node) => {
          const resolved = canvasInputsFor(node.key);
          return [
            node.key,
            videoDownloadInputs(node.config.url, [
              ...resolved.texts.map((input) => input.text),
              ...resolved.media
                .filter(
                  (input) => input.kind === "video" && input.src && /^https?:\/\//i.test(input.src),
                )
                .map((input) => input.src!),
            ]),
          ] as const;
        }),
      ),
    [canvasInputsFor, videoDownloaderNodes],
  );
  const submitNextVideoDownload = useCallback((nodeKey: string) => {
    const queue = videoDownloadQueuesRef.current.get(nodeKey);
    const source = queue?.sources.shift();
    if (!queue || !source) return;
    queue.activeJobId = "";
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
    void videoDownloaderClient
      .startDownload(source)
      .then((record) => {
        if (videoDownloadQueuesRef.current.get(nodeKey) !== queue) {
          void videoDownloaderClient.cancelJob(record.jobId).catch(() => undefined);
          return;
        }
        queue.activeJobId = record.jobId;
        setVideoDownloaderRuns((current) => ({
          ...current,
          [nodeKey]: {
            jobId: record.jobId,
            status: "running",
            preparingEngine: false,
            progress: null,
            qualityHint: null,
            watermarkRemoved: false,
            error: null,
          },
        }));
      })
      .catch((error: unknown) => {
        if (videoDownloadQueuesRef.current.get(nodeKey) !== queue) return;
        videoDownloadQueuesRef.current.delete(nodeKey);
        setVideoDownloaderRuns((current) => ({
          ...current,
          [nodeKey]: {
            jobId: "",
            status: "error",
            preparingEngine: false,
            progress: null,
            qualityHint: null,
            watermarkRemoved: false,
            error: formatRawBackendError(error),
          },
        }));
      });
  }, []);

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
        const queue = videoDownloadQueuesRef.current.get(nodeKey);
        if (queue?.activeJobId !== jobId) continue;
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
              taskId: queue.batchId,
              mediaType: "video",
              origin: "download",
              finalPath: job.finalPath,
              previewSrc: null,
              name: fileName,
              ...nextVideoDownloaderOutputSlot(startNode, current),
            }));
          }
          if (queue.sources.length > 0) {
            submitNextVideoDownload(nodeKey);
            continue;
          }
          videoDownloadQueuesRef.current.delete(nodeKey);
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
        videoDownloadQueuesRef.current.delete(nodeKey);
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
  }, [addOutput, queryClient, videoDownloaderNodes, submitNextVideoDownload]);

  const handleStartVideoDownload = useCallback(
    (nodeKey: string) => {
      const node = videoDownloaderNodes.find((candidate) => candidate.key === nodeKey);
      if (!node || videoDownloadQueuesRef.current.has(nodeKey)) return;
      const sources = videoDownloadSourcesByNode.get(nodeKey) ?? [];
      if (sources.length === 0) {
        setVideoDownloaderRuns((current) => ({
          ...current,
          [nodeKey]: {
            jobId: "",
            status: "error",
            preparingEngine: false,
            progress: null,
            qualityHint: null,
            watermarkRemoved: false,
            error: "请填写视频链接，或从上游文本、视频传入 HTTP(S) 地址。",
          },
        }));
        return;
      }
      videoDownloaderStartNodesRef.current.set(nodeKey, node);
      videoDownloadQueuesRef.current.set(nodeKey, {
        sources: [...sources],
        batchId: `download-batch:${Date.now()}:${nodeKey}`,
        activeJobId: "",
      });
      submitNextVideoDownload(nodeKey);
    },
    [videoDownloaderNodes, videoDownloadSourcesByNode, submitNextVideoDownload],
  );

  const handleCancelVideoDownload = useCallback((nodeKey: string) => {
    const queue = videoDownloadQueuesRef.current.get(nodeKey);
    if (!queue) return;
    videoDownloadQueuesRef.current.delete(nodeKey);
    setVideoDownloaderRuns((current) => ({
      ...current,
      [nodeKey]: {
        jobId: queue.activeJobId,
        status: "cancelled",
        preparingEngine: false,
        progress: null,
        qualityHint: null,
        watermarkRemoved: false,
        error: null,
      },
    }));
    if (queue.activeJobId)
      void videoDownloaderClient.cancelJob(queue.activeJobId).catch((error: unknown) => {
        frontendLog("error", `[downloader] 取消请求失败: ${formatRawBackendError(error)}`);
      });
  }, []);

  /** 删除视频下载节点（保留已经生成的产物卡片）。 */
  const removeVideoDownloaderNode = useCallback(
    (key: string) => {
      videoDownloaderStartNodesRef.current.delete(key);
      videoDownloadQueuesRef.current.delete(key);
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

  const submitNextFrameExtraction = useCallback((nodeKey: string) => {
    const queue = frameExtractionQueuesRef.current.get(nodeKey);
    const source = queue?.sources.shift();
    if (!queue || !source) return;
    queue.activeJobId = "";
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
    void videoFrameExtractionClient
      .startExtraction(source, queue.timestamps)
      .then((record) => {
        if (frameExtractionQueuesRef.current.get(nodeKey) !== queue) {
          void videoFrameExtractionClient.cancelJob(record.jobId).catch(() => undefined);
          return;
        }
        queue.activeJobId = record.jobId;
        setFrameExtractorRuns((current) => ({
          ...current,
          [nodeKey]: {
            jobId: record.jobId,
            status: "running",
            preparingEngine: false,
            progress: null,
            error: null,
          },
        }));
      })
      .catch((error: unknown) => {
        if (frameExtractionQueuesRef.current.get(nodeKey) !== queue) return;
        frameExtractionQueuesRef.current.delete(nodeKey);
        setFrameExtractorRuns((current) => ({
          ...current,
          [nodeKey]: {
            jobId: "",
            status: "error",
            preparingEngine: false,
            progress: null,
            error: formatRawBackendError(error),
          },
        }));
      });
  }, []);

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
        const queue = frameExtractionQueuesRef.current.get(nodeKey);
        if (queue?.activeJobId !== jobId) continue;
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
                taskId: queue.batchId,
                mediaType: "image",
                origin: "frame_extract",
                finalPath: frame.path,
                previewSrc: null,
                name: fileNameFromPath(frame.path),
                ...nextFrameExtractorOutputSlot(startNode, current),
              }));
            }
          }
          if (queue.sources.length > 0) {
            submitNextFrameExtraction(nodeKey);
            continue;
          }
          frameExtractionQueuesRef.current.delete(nodeKey);
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
        frameExtractionQueuesRef.current.delete(nodeKey);
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
  }, [addOutput, queryClient, frameExtractorNodes, submitNextFrameExtraction]);

  /** 每个上游视频依次抽帧；同一批次保留所有来源的完整帧产物。 */
  const handleStartFrameExtraction = useCallback(
    (nodeKey: string) => {
      const node = frameExtractorNodes.find((candidate) => candidate.key === nodeKey);
      if (!node || frameExtractionQueuesRef.current.has(nodeKey)) return;
      const inputs = frameExtractorInputsByNode.get(nodeKey) ?? [];
      const sources =
        inputs.length > 0
          ? inputs.map((input) => input.finalPath)
          : node.config.videoPath.trim()
            ? [node.config.videoPath.trim()]
            : [];
      const error =
        sources.length === 0
          ? "请提供上游视频或填写视频文件路径。"
          : sources.some((source) => !source)
            ? "部分上游视频没有可读取的本地路径或 HTTP(S) 地址，请先保存视频。"
            : node.config.timestamps.length === 0
              ? "请先添加至少一个抽帧秒数。"
              : null;
      if (error) {
        setFrameExtractorRuns((current) => ({
          ...current,
          [nodeKey]: {
            jobId: "",
            status: "error",
            preparingEngine: false,
            progress: null,
            error,
          },
        }));
        return;
      }
      frameExtractorStartNodesRef.current.set(nodeKey, node);
      frameExtractionQueuesRef.current.set(nodeKey, {
        sources: sources as string[],
        timestamps: node.config.timestamps,
        batchId: `frame-batch:${Date.now()}:${nodeKey}`,
        activeJobId: "",
      });
      submitNextFrameExtraction(nodeKey);
    },
    [frameExtractorNodes, frameExtractorInputsByNode, submitNextFrameExtraction],
  );

  const handleCancelFrameExtraction = useCallback((nodeKey: string) => {
    const queue = frameExtractionQueuesRef.current.get(nodeKey);
    if (!queue) return;
    frameExtractionQueuesRef.current.delete(nodeKey);
    setFrameExtractorRuns((current) => ({
      ...current,
      [nodeKey]: {
        jobId: queue.activeJobId,
        status: "cancelled",
        preparingEngine: false,
        progress: null,
        error: null,
      },
    }));
    if (queue.activeJobId)
      void videoFrameExtractionClient.cancelJob(queue.activeJobId).catch((error: unknown) => {
        frontendLog("error", `[frame-extractor] 取消请求失败: ${formatRawBackendError(error)}`);
      });
  }, []);

  /** 删除视频抽帧节点（保留已经生成的图片产物卡片）。 */
  const removeFrameExtractorNode = useCallback(
    (key: string) => {
      frameExtractorStartNodesRef.current.delete(key);
      frameExtractionQueuesRef.current.delete(key);
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

  /** 文本输出可经任意中间节点传入；多个来源按连接顺序合并。 */
  const promptSourceByTarget = useMemo(() => {
    const map = new Map<string, ReturnType<typeof canvasInputsFor>["texts"]>();
    for (const node of genNodes) {
      if (node.kind === "prompt") continue;
      const texts = canvasInputsFor(node.key).texts;
      if (texts.length) map.set(node.key, texts);
    }
    return map;
  }, [canvasInputsFor, genNodes]);

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

  /** 同步合并后的文本；同一上游版本保留用户手工编辑。 */
  useEffect(() => {
    if (!canvasHydrated) return;
    const imported = importedPromptSourcesRef.current;
    for (const [targetKey, previous] of imported) {
      if (promptSourceByTarget.has(targetKey)) continue;
      // 断开最后一条来源时清除自动导入内容，保留用户另行修改的内容。
      const generated = stripMarkdown(previous.text) || previous.text.trim();
      if (promptContents.read(targetKey)?.plainText === generated) {
        promptContents.replaceText(targetKey, "", mentionCandidatesFor(targetKey));
      }
      imported.delete(targetKey);
    }
    for (const [targetKey, sources] of promptSourceByTarget) {
      const version = {
        edgeId: sources.map((source) => source.edgeId).join("\n"),
        sourceKey: sources.map((source) => source.sourceKey).join("\n"),
        text: sources.map((source) => source.text).join("\n\n"),
      };
      const previous = imported.get(targetKey);
      if (
        previous?.edgeId === version.edgeId &&
        previous.sourceKey === version.sourceKey &&
        previous.text === version.text
      )
        continue;
      const text = stripMarkdown(version.text) || version.text.trim();
      if (promptContents.replaceText(targetKey, text, mentionCandidatesFor(targetKey)) != null) {
        imported.set(targetKey, version);
      }
    }
  }, [canvasHydrated, mentionCandidatesFor, promptContents, promptSourceByTarget]);

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
            setAssetsError(error instanceof Error ? error.message : formatted);
          },
        );
    },
    [applyCloudAssetKindDelta, assetProvider, refreshAssetGroups, refreshCloudAssets],
  );

  const previewOutputNode =
    outputNodes.find(
      (node) =>
        node.key === previewOutputNodeKey && (node.finalPath != null || node.previewSrc != null),
    ) ?? null;

  const previewAssetNode =
    assetNodes.find(
      (node) =>
        node.key === previewAssetNodeKey && (node.previewUrl != null || node.videoUrl != null),
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
    if (!active || !mobilePanel || !window.matchMedia?.("(max-width: 59.999rem)").matches) return;

    const closeButton = document.querySelector<HTMLButtonElement>(
      mobilePanel === "nodes" ? ".mobile-panel-close--nodes" : ".mobile-panel-close--assets",
    );
    const animationFrame = window.requestAnimationFrame(() => closeButton?.focus());

    return () => window.cancelAnimationFrame(animationFrame);
  }, [active, mobilePanel]);

  useHotkeys(
    "esc",
    () => {
      setMobilePanel(null);
      window.requestAnimationFrame(() => mobilePanelTriggerRef.current?.focus());
    },
    { enabled: active && canvasHydrated && !settingsOpen },
    [active, canvasHydrated, settingsOpen],
  );

  // 文本输入框内默认不触发这些快捷键，继续使用浏览器原生的文本撤销行为。
  useHotkeys(
    ["mod+z", "mod+shift+z", "mod+y"],
    (_event, hotkey) => {
      if (hotkey.hotkey === "mod+z") undo();
      else redo();
    },
    { enabled: active && canvasHydrated && !settingsOpen, preventDefault: true },
    [active, canvasHydrated, settingsOpen, undo, redo],
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
      enabled: active && canvasHydrated && !settingsOpen,
      preventDefault: true,
      splitKey: "_",
      useKey: true,
    },
    [active, canvasHydrated, settingsOpen, zoomAroundViewportCenter],
  );

  const ignoreLegacyNodeDrag = useCallback(() => undefined, []);
  const ignoreLegacyConnectionStart = useCallback(() => undefined, []);

  // 画布节点 per-node 引用稳定缓存（配合 memo 化的 CanvasFlowNodeView）。
  const canvasFlowNodeCachesRef = useRef<CanvasFlowNodeCache>(new Map());

  const assetFlowNodes = useMemo<CanvasFlowNode[]>(
    () =>
      assetNodes.map((node) =>
        stableCanvasFlowNode(
          canvasFlowNodeCachesRef.current,
          "asset",
          node.key,
          [
            node,
            selectedNodeKey === node.key,
            canvasEdgeIndex.countByNode.get(node.key) ?? 0,
            ignoreLegacyNodeDrag,
            ignoreLegacyConnectionStart,
            removeAssetNode,
            handleAssetAspectRatioChange,
            handleAssetMediaRefresh,
          ],
          () => ({
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
                  onRefreshMediaUrls={handleAssetMediaRefresh}
                  onPreview={setPreviewAssetNodeKey}
                />
              ),
            },
          }),
        ),
      ),
    [
      assetNodes,
      canvasEdgeIndex,
      selectedNodeKey,
      ignoreLegacyNodeDrag,
      ignoreLegacyConnectionStart,
      removeAssetNode,
      handleAssetAspectRatioChange,
      handleAssetMediaRefresh,
    ],
  );

  const outputFlowNodes = useMemo<CanvasFlowNode[]>(
    () =>
      outputNodes.map((node) => {
        const task = taskById.get(node.taskId) ?? null;
        return stableCanvasFlowNode(
          canvasFlowNodeCachesRef.current,
          "output",
          node.key,
          [
            node,
            task,
            selectedNodeKey === node.key,
            retryInfoByTask[node.taskId] ?? null,
            taskResults[node.taskId],
            rawResponses[node.taskId] ?? null,
            providerCatalog,
            ignoreLegacyNodeDrag,
            removeOutputNode,
            handleOutputAspectRatioChange,
            setPreviewOutputNodeKey,
            ignoreLegacyConnectionStart,
            handleUploadOutputToCloud,
          ],
          () => ({
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
                  onUploadToCloud={(key) => void handleUploadOutputToCloud(key)}
                  task={task}
                  retryInfo={retryInfoByTask[node.taskId] ?? null}
                  results={taskResults[node.taskId] ?? []}
                  rawResponse={rawResponses[node.taskId] ?? null}
                  modelLabel={task ? modelDisplayNameForTask(task, providerCatalog) : null}
                />
              ),
            },
          }),
        );
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
      handleUploadOutputToCloud,
      retryInfoByTask,
      taskResults,
      rawResponses,
      providerCatalog,
    ],
  );

  const screenplayFlowNodes = useMemo<CanvasFlowNode[]>(
    () =>
      screenplayNodes.map((node) =>
        stableCanvasFlowNode(
          canvasFlowNodeCachesRef.current,
          "screenplay",
          node.key,
          [
            node,
            selectedNodeKey === node.key,
            startingNodeKeys.has(node.key),
            startErrorsByNode[node.key] ?? null,
            // 流式正文变化必须让节点重建，否则画布上看不到逐字推进。
            streamingTextByNode[node.key] ?? null,
            providerCatalog,
            documentInputsByNode.get(node.key),
            canvasInputsFor,
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
          () => ({
            id: node.key,
            type: "canvas",
            position: { x: node.x, y: node.y },
            ...measuredFor(node),
            selected: selectedNodeKey === node.key,
            data: {
              hasSourceHandle: true,
              hasTargetHandle: true,
              content: (
                <CanvasDocumentSkillNode
                  key={node.key}
                  node={node}
                  selected={selectedNodeKey === node.key}
                  dragging={false}
                  running={startingNodeKeys.has(node.key)}
                  streamingText={streamingTextByNode[node.key] ?? null}
                  error={startErrorsByNode[node.key] ?? null}
                  providerCatalog={providerCatalog}
                  sourceInputs={documentInputsByNode.get(node.key) ?? []}
                  connectedMedia={canvasInputsFor(node.key).media}
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
          }),
        ),
      ),
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
      documentInputsByNode,
      canvasInputsFor,
      streamingTextByNode,
    ],
  );

  const storyboardFlowNodes = useMemo<CanvasFlowNode[]>(
    () =>
      storyboardNodes.map((node) =>
        stableCanvasFlowNode(
          canvasFlowNodeCachesRef.current,
          "storyboard",
          node.key,
          [
            node,
            selectedNodeKey === node.key,
            startingNodeKeys.has(node.key),
            startErrorsByNode[node.key] ?? null,
            // 流式正文变化必须让节点重建，否则画布上看不到逐字推进。
            streamingTextByNode[node.key] ?? null,
            providerCatalog,
            documentInputsByNode.get(node.key),
            canvasInputsFor,
            selectNode,
            ignoreLegacyNodeDrag,
            removeStoryboardNode,
            removeAssetEdge,
            handleGenNodeSizeChange,
            updateStoryboardNodeConfig,
            handleRunStoryboardNode,
            handleExportStoryboard,
          ],
          () => ({
            id: node.key,
            type: "canvas",
            position: { x: node.x, y: node.y },
            ...measuredFor(node),
            selected: selectedNodeKey === node.key,
            data: {
              hasSourceHandle: true,
              hasTargetHandle: true,
              content: (
                <CanvasDocumentSkillNode
                  key={node.key}
                  node={node}
                  selected={selectedNodeKey === node.key}
                  dragging={false}
                  running={startingNodeKeys.has(node.key)}
                  streamingText={streamingTextByNode[node.key] ?? null}
                  error={startErrorsByNode[node.key] ?? null}
                  providerCatalog={providerCatalog}
                  sourceInputs={documentInputsByNode.get(node.key) ?? []}
                  connectedMedia={canvasInputsFor(node.key).media}
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
          }),
        ),
      ),
    [
      storyboardNodes,
      selectedNodeKey,
      startingNodeKeys,
      startErrorsByNode,
      providerCatalog,
      documentInputsByNode,
      canvasInputsFor,
      selectNode,
      ignoreLegacyNodeDrag,
      removeStoryboardNode,
      removeAssetEdge,
      handleGenNodeSizeChange,
      updateStoryboardNodeConfig,
      handleRunStoryboardNode,
      handleExportStoryboard,
      streamingTextByNode,
    ],
  );

  const knowledgeVideoWorkflowFlowNodes = useMemo<CanvasFlowNode[]>(
    () =>
      knowledgeVideoWorkflowNodes.map((node) =>
        stableCanvasFlowNode(
          canvasFlowNodeCachesRef.current,
          "knowledgeVideoWorkflow",
          node.key,
          [
            node,
            workflowInputsByNode.get(node.key),
            selectedNodeKey === node.key,
            knowledgeVideoWorkflowRuns[node.key] ?? null,
            providerCatalog,
            removeAssetEdge,
            patchNode,
            selectNode,
            ignoreLegacyNodeDrag,
            handleGenNodeSizeChange,
            updateKnowledgeVideoWorkflowConfig,
            executeKnowledgeVideoWorkflow,
            continueKnowledgeVideoWorkflow,
            cancelKnowledgeVideoWorkflow,
            redoKnowledgeVideoWorkflowShot,
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
          () => ({
            id: node.key,
            type: "canvas",
            position: { x: node.x, y: node.y },
            ...measuredFor(node),
            selected: selectedNodeKey === node.key,
            data: {
              hasSourceHandle: true,
              hasTargetHandle: true,
              content: (
                <KnowledgeVideoWorkflowNode
                  key={node.key}
                  node={node}
                  connectedInputs={workflowInputsByNode.get(node.key)?.media ?? []}
                  connectedTexts={workflowInputsByNode.get(node.key)?.texts ?? []}
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
                  onRedoShot={redoKnowledgeVideoWorkflowShot}
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
          }),
        ),
      ),
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
      redoKnowledgeVideoWorkflowShot,
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
      viralRemixNodes.map((node) =>
        stableCanvasFlowNode(
          canvasFlowNodeCachesRef.current,
          "viralRemix",
          node.key,
          [
            node,
            viralRemixInputsByNode.get(node.key),
            selectedNodeKey === node.key,
            startingNodeKeys.has(node.key),
            startErrorsByNode[node.key] ?? null,
            // 流式正文变化必须让节点重建，否则画布上看不到逐字推进。
            streamingTextByNode[node.key] ?? null,
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
          () => ({
            id: node.key,
            type: "canvas",
            position: { x: node.x, y: node.y },
            ...measuredFor(node),
            selected: selectedNodeKey === node.key,
            data: {
              hasSourceHandle: true,
              hasTargetHandle: true,
              content: (
                <CanvasViralRemixNode
                  key={node.key}
                  node={node}
                  inputs={viralRemixInputsByNode.get(node.key) ?? []}
                  selected={selectedNodeKey === node.key}
                  dragging={false}
                  running={startingNodeKeys.has(node.key)}
                  streamingText={streamingTextByNode[node.key] ?? null}
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
          }),
        ),
      ),
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
      streamingTextByNode,
    ],
  );

  // gen 节点的 @ 候选按 key 缓存成稳定引用（mentionCandidatesFor 每次调用新建数组，
  // 会让 per-node 浅比较永远失效）。派生来源（canvasInputsFor/genNodes）变化时整表重算。
  const mentionCandidatesByNode = useMemo(() => {
    const map = new Map<string, readonly MentionCandidate[]>();
    for (const node of genNodes) map.set(node.key, mentionCandidatesFor(node.key));
    return map;
  }, [genNodes, mentionCandidatesFor]);

  const genFlowNodes = useMemo<CanvasFlowNode[]>(
    () =>
      genNodes.map((node) => {
        const connectedInputs = connectedInputsByNode.get(node.key);
        const mentionCandidates = mentionCandidatesByNode.get(node.key);
        const isPrompt = node.kind === "prompt";
        return stableCanvasFlowNode(
          canvasFlowNodeCachesRef.current,
          "gen",
          node.key,
          [
            node,
            isPrompt,
            nodeDescriptorContext,
            selectedNodeKey === node.key,
            startingNodeKeys.has(node.key),
            startErrorsByNode[node.key] ?? null,
            // 流式正文变化必须让节点重建，否则画布上看不到逐字推进。
            streamingTextByNode[node.key] ?? null,
            connectedInputs,
            promptTargetsBySource.get(node.key),
            promptSourceByTarget.has(node.key),
            promptSourceByTarget.get(node.key)?.length ?? 0,
            activeTaskByNode.get(node.key) ?? null,
            mentionCandidates,
            providerCatalog,
            selectNode,
            ignoreLegacyNodeDrag,
            removeGenNode,
            removeAssetEdge,
            ignoreLegacyConnectionStart,
            handleGenNodeSizeChange,
            updatePromptNodeConfig,
            handleRunPromptNode,
            registerPromptInput,
            updateImageNodeConfig,
            updateVideoNodeConfig,
            openVideoLocalEdit,
            handleStartGeneration,
          ],
          () => {
            const descriptor = getNodeDescriptor(
              node.kind,
              nodeDescriptorContext,
              node.config.modelSelection,
              node.kind === "video"
                ? "video_generation"
                : node.kind === "image"
                  ? (connectedInputs ?? []).some(
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
                  streamingText={streamingTextByNode[node.key] ?? null}
                  error={startErrorsByNode[node.key] ?? null}
                  providerCatalog={providerCatalog}
                  sourceConnections={connectedInputs ?? []}
                  targetConnections={promptTargetsBySource.get(node.key) ?? []}
                  onSelect={selectNode}
                  onNodeDragStart={ignoreLegacyNodeDrag}
                  onRemove={removeGenNode}
                  onUnlink={removeAssetEdge}
                  onConnectionStart={ignoreLegacyConnectionStart}
                  onSizeChange={handleGenNodeSizeChange}
                  onChange={(config) => updatePromptNodeConfig(node.key, config)}
                  onRun={handleRunPromptNode}
                  promptContents={promptContents}
                  registerPromptInput={registerPromptInput}
                  mentionCandidates={mentionCandidates ?? []}
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
                  connectedInputs={connectedInputs ?? []}
                  inheritedInputs={[]}
                  mentionCandidates={mentionCandidates ?? []}
                  promptSourceName={
                    promptSourceByTarget.has(node.key)
                      ? `${promptSourceByTarget.get(node.key)?.length ?? 0} 份文本`
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
                  onAnnotateVideo={openVideoLocalEdit}
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
          },
        );
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
      promptContents,
      selectNode,
      ignoreLegacyNodeDrag,
      removeGenNode,
      removeAssetEdge,
      ignoreLegacyConnectionStart,
      handleGenNodeSizeChange,
      updatePromptNodeConfig,
      handleRunPromptNode,
      activeTaskByNode,
      mentionCandidatesByNode,
      promptSourceByTarget,
      registerPromptInput,
      updateImageNodeConfig,
      updateVideoNodeConfig,
      openVideoLocalEdit,
      handleStartGeneration,
      streamingTextByNode,
    ],
  );

  const videoComposerFlowNodes = useMemo<CanvasFlowNode[]>(
    () =>
      videoComposerNodes.map((node) =>
        stableCanvasFlowNode(
          canvasFlowNodeCachesRef.current,
          "videoComposer",
          node.key,
          [
            node,
            videoComposerInputsByNode.get(node.key),
            selectedNodeKey === node.key,
            videoComposerRuns[node.key],
            videoCompositionFormat,
            selectNode,
            ignoreLegacyNodeDrag,
            removeVideoComposerNode,
            removeAssetEdge,
            updateVideoComposerConfig,
            moveVideoComposerInput,
            handleComposeVideos,
          ],
          () => ({
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
          }),
        ),
      ),
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
      videoDownloaderNodes.map((node) =>
        stableCanvasFlowNode(
          canvasFlowNodeCachesRef.current,
          "videoDownloader",
          node.key,
          [
            node,
            videoDownloadSourcesByNode.get(node.key),
            selectedNodeKey === node.key,
            videoDownloaderRuns[node.key],
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
          () => ({
            id: node.key,
            type: "canvas",
            position: { x: node.x, y: node.y },
            ...measuredFor(node),
            selected: selectedNodeKey === node.key,
            data: {
              hasSourceHandle: true,
              hasTargetHandle: true,
              content: (
                <CanvasVideoDownloaderNode
                  key={node.key}
                  node={node}
                  downloadSources={videoDownloadSourcesByNode.get(node.key) ?? []}
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
          }),
        ),
      ),
    [
      videoDownloaderNodes,
      videoDownloadSourcesByNode,
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
      frameExtractorNodes.map((node) =>
        stableCanvasFlowNode(
          canvasFlowNodeCachesRef.current,
          "frameExtractor",
          node.key,
          [
            node,
            selectedNodeKey === node.key,
            frameExtractorInputsByNode.get(node.key),
            frameExtractorOutputsByNode.get(node.key),
            frameExtractorRuns[node.key],
            selectNode,
            ignoreLegacyNodeDrag,
            removeFrameExtractorNode,
            updateFrameExtractorConfig,
            handleStartFrameExtraction,
            handleCancelFrameExtraction,
          ],
          () => ({
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
          }),
        ),
      ),
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
      resultNodes.map((node) =>
        stableCanvasFlowNode(
          canvasFlowNodeCachesRef.current,
          "result",
          node.key,
          [
            node,
            nodeDescriptorContext,
            selectedNodeKey === node.key,
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
            selected: selectedNodeKey === node.key,
            data: {
              hasSourceHandle: true,
              hasTargetHandle: true,
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
          }),
        ),
      ),
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

  // 拖线过程中记录源节点 key，用于高亮所有可连接目标的输入端口。
  const [connectionSourceKey, setConnectionSourceKey] = useState<string | null>(null);
  const connectionStartRef = useRef<{
    nodeKey: string;
    handleType: "source" | "target";
    x: number;
    y: number;
  } | null>(null);
  const [connectionQuickAdd, setConnectionQuickAdd] = useState<{
    nodeKey: string;
    handleType: "source" | "target";
    position: { x: number; y: number };
    boardPosition: { x: number; y: number };
  } | null>(null);

  const closeConnectionQuickAdd = useCallback(() => setConnectionQuickAdd(null), []);

  useEffect(() => {
    if (!active) {
      connectionStartRef.current = null;
      // Switching canvases cancels the transient gesture and its menu.
      setConnectionQuickAdd(null);
      setConnectionSourceKey(null);
    }
  }, [active]);

  useEffect(() => {
    if (!active || !connectionSourceKey) return;
    const cancelConnection = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      connectionStartRef.current = null;
      setConnectionSourceKey(null);
    };
    window.addEventListener("keydown", cancelConnection);
    return () => window.removeEventListener("keydown", cancelConnection);
  }, [active, connectionSourceKey]);

  // 从各类节点索引中按 key 查找并组装 CanvasNodeEntry，供连接合法性判断复用。
  const canvasEntryByKey = useCallback(
    (key: string): CanvasNodeEntry | null => {
      const asset = assetNodeByKey.get(key);
      if (asset) return { type: "asset", data: asset };
      const gen = genTopologyByKey.get(key);
      if (gen) return { type: "gen", data: gen };
      const screenplay = screenplayNodeByKey.get(key);
      if (screenplay) return { type: "screenplay", data: screenplay };
      const storyboard = storyboardNodeByKey.get(key);
      if (storyboard) return { type: "storyboard", data: storyboard };
      const viralRemix = viralRemixNodeByKey.get(key);
      if (viralRemix) return { type: "viralRemix", data: viralRemix };
      const composer = videoComposerNodeByKey.get(key);
      if (composer) return { type: "videoComposer", data: composer };
      const downloader = videoDownloaderNodeByKey.get(key);
      if (downloader) return { type: "videoDownloader", data: downloader };
      const extractor = frameExtractorNodeByKey.get(key);
      if (extractor) return { type: "frameExtractor", data: extractor };
      const output = outputNodeByKey.get(key);
      if (output) return { type: "output", data: output };
      const workflow = knowledgeVideoWorkflowNodes.find((n) => n.key === key);
      if (workflow) return { type: "knowledgeVideoWorkflow", data: workflow };
      const result = resultNodes.find((n) => n.key === key);
      if (result) return { type: "result", data: result };
      return null;
    },
    [
      assetNodeByKey,
      genTopologyByKey,
      screenplayNodeByKey,
      storyboardNodeByKey,
      viralRemixNodeByKey,
      videoComposerNodeByKey,
      videoDownloaderNodeByKey,
      frameExtractorNodeByKey,
      outputNodeByKey,
      knowledgeVideoWorkflowNodes,
      resultNodes,
    ],
  );

  const quickAddEndpointExists =
    connectionQuickAdd != null && canvasEntryByKey(connectionQuickAdd.nodeKey) != null;
  useEffect(() => {
    if (connectionQuickAdd && !quickAddEndpointExists) closeConnectionQuickAdd();
  }, [connectionQuickAdd, quickAddEndpointExists, closeConnectionQuickAdd]);

  const flowNodes = useMemo<CanvasFlowNode[]>(() => {
    const sourceEntry: CanvasNodeEntry | null =
      connectionSourceKey != null ? canvasEntryByKey(connectionSourceKey) : null;
    const baseNodes: CanvasFlowNode[] = [
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
    ];
    return baseNodes.map((baseNode) => {
      // 最终层同样做 per-node 引用稳定：baseNode 引用与三个派生值不变时复用整个
      // 节点对象（含 data 引用），memo 化的节点视图因此能跳过未变化节点。
      const incoming = (canvasEdgeIndex.byTarget.get(baseNode.id) ?? []).filter(
        (edge) => outputNodeByKey.get(baseNode.id)?.sourceNodeId !== edge.fromKey,
      );
      const inputs = canvasInputsFor(baseNode.id);
      const targetEntry = canvasEntryByKey(baseNode.id);
      const highlightTarget =
        sourceEntry != null &&
        targetEntry != null &&
        isSupportedConnection(sourceEntry, targetEntry);
      const inputSummary = incoming.length
        ? `已连接 ${incoming.length} 个来源 · ${inputs.media.length} 项媒体 · ${inputs.texts.length} 份文本${inputs.pending.length ? ` · 等待 ${inputs.pending.length} 项输出` : ""}`
        : "";
      const inputDetails = [
        ...inputs.media.map((input) => input.name),
        ...inputs.texts.map((input) => input.name),
        ...inputs.pending.map((input) => `${input.name}：等待可用输出`),
      ].join("\n");
      return stableCanvasFlowNode(
        canvasFlowNodeCachesRef.current,
        "final",
        baseNode.id,
        [baseNode, highlightTarget, inputSummary, inputDetails],
        () => ({
          ...baseNode,
          data: {
            ...baseNode.data,
            highlightTarget,
            inputSummary,
            inputDetails,
          },
        }),
      );
    });
  }, [
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
    connectionSourceKey,
    canvasEntryByKey,
    canvasEdgeIndex,
    canvasInputsFor,
    outputNodeByKey,
  ]);

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
                  : (source?.name ??
                    outputSource?.name ??
                    canvasNodeLabel(canvasEntryByKey(edge.fromKey)));
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
                    : (assetTarget?.name ?? canvasNodeLabel(canvasEntryByKey(edge.toKey)));
        const connectionOrder = inputOrderByEdge.get(edge.id) ?? 0;
        return {
          id: edge.id,
          type: "canvas",
          source: edge.fromKey,
          target: edge.toKey,
          sourceHandle: "source",
          targetHandle: "target",
          selected: selectedEdgeId === edge.id,
          selectable: true,
          focusable: true,
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
            removable: true,
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
      canvasEntryByKey,
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
    if (!point || Math.hypot(point.clientX - start.x, point.clientY - start.y) < 4) return;
    // Touch events retain the starting handle as their target, so hit-test the release point.
    const target =
      "changedTouches" in event
        ? document.elementFromPoint(point.clientX, point.clientY)
        : event.target;
    if (!(target instanceof Element) || !target.classList.contains("react-flow__pane")) return;
    const boardPosition = dropClientPointToBoard(point.clientX, point.clientY);
    if (!boardPosition || !canvasEntryByKey(start.nodeKey)) return;
    setConnectionQuickAdd({
      nodeKey: start.nodeKey,
      handleType: start.handleType,
      position: { x: point.clientX, y: point.clientY },
      boardPosition,
    });
  };

  const handleConnectionQuickAdd = (kind: CanvasGenNodeKind) => {
    if (!connectionQuickAdd) return;
    const endpoint = canvasEntryByKey(connectionQuickAdd.nodeKey);
    closeConnectionQuickAdd();
    if (!endpoint) return;
    const node = createGenNode(
      kind,
      connectionQuickAdd.boardPosition.x,
      connectionQuickAdd.boardPosition.y,
    );
    const entry: CanvasNodeEntry = { type: "gen", data: node };
    const [source, target] =
      connectionQuickAdd.handleType === "source" ? [endpoint, entry] : [entry, endpoint];
    if (!isSupportedConnection(source, target)) return;
    const fromKey = source.data.key;
    const toKey = target.data.key;
    insertSubgraph([entry], [{ id: `${fromKey}->${toKey}`, fromKey, toKey }], {
      selectNodeKey: node.key,
    });
    selectEdge(null);
    frontendLog("info", `[canvas] 拖线创建生成节点并连接: ${fromKey} → ${toKey}, kind=${kind}`);
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
  // 云端面板当前选中的分组即上传目标：选中分组后，上传必须直接归入该分组，
  // 而不是始终落到默认上传分组、只在「全部素材」里可见。
  const uploadGroupName =
    assetLibrarySource === "cloud"
      ? (assetGroups.find((group) => group.id === selectedAssetGroupId)?.name ?? null)
      : null;

  if (!active) return null;

  return (
    <main className="workspace-shell">
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
          <div
            className={`save-state${canvasPersistence.error ? " save-state--error" : ""}`}
            title={canvasPersistence.error ?? undefined}
            role="status"
          >
            {canvasPersistence.error ? (
              <WarningCircle size={14} aria-hidden="true" />
            ) : (
              <CheckCircle size={14} weight="fill" aria-hidden="true" />
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
            {canvasPersistence.error && canvasHydrated ? (
              <button type="button" onClick={canvasPersistence.retry}>
                重试保存
              </button>
            ) : null}
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

        <AssetPanel
          mobileOpen={mobilePanel === "assets"}
          onCloseMobilePanel={closeMobilePanel}
          uploadActionLabel={uploadActionLabel}
          onImportLocalAssets={() => {
            void handleImportLocalAssets();
          }}
          isOffline={isOffline}
          source={assetLibrarySource}
          onSourceChange={(next) => {
            setAssetLibrarySource(next);
            setAssetSearch("");
            if (!isDesktopRuntime()) return;
            if (next === "local") refreshLocalAssets("initial");
            else setAssetsLoading(Boolean(assetProvider));
          }}
          pullingBucket={pullingBucket}
          onPullBucket={() => {
            void handlePullBucketAssets();
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
          kind={assetKind}
          getKindCount={(tabKind) =>
            // 浏览器模式：演示数据即时计数；本地素材：分页响应携带的全库类型计数；
            // 云端：面板打开时扫一次全库得到的类型计数（上传/删除按增量维护）。
            !isDesktopRuntime()
              ? libraryAssets.filter((asset) => asset.kind === tabKind).length
              : assetLibrarySource === "local"
                ? localAssetKindTotals[tabKind]
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
                : `本页 ${visibleAssets.length} 个${ASSET_KIND_LABELS[assetKind]}素材`
          }
          visibleAssets={visibleAssets}
          onPreviewAsset={handlePreviewAsset}
          onDropAssetToCanvas={handleDropAssetToCanvas}
          localPage={localAssetPageNumber}
          localTotalPages={localAssetTotalPages}
          localTotal={localAssetTotal}
          cloudPage={cloudAssetPageNumber}
          cloudHasMore={cloudAssetHasMore}
          onLocalPageChange={goToLocalAssetPage}
          onCloudPageChange={goToCloudAssetPage}
        />

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
              onConnectStart={handleConnectStart}
              onConnectEnd={handleConnectEnd}
              onMoveStart={() => {
                closeConnectionQuickAdd();
                setIsPanning(true);
              }}
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

            {connectionQuickAdd && quickAddEndpointExists ? (
              <ConnectionQuickAddMenu
                position={connectionQuickAdd.position}
                onSelect={handleConnectionQuickAdd}
                onClose={closeConnectionQuickAdd}
              />
            ) : null}

            {/* 空态提示与连线/拖动捕获层挂在视口上，不随画布平移缩放。 */}
            {!hasCanvasNodes ? (
              <div className="canvas-empty-hint">
                <strong>画布为空</strong>
                <span>从左侧节点仓库拖入生成节点，或从素材库拖入素材开始创作。</span>
              </div>
            ) : null}
          </div>

          <div className="canvas-home-control" role="group" aria-label="画布视图归位">
            <button
              type="button"
              aria-label="回到画布起始位置"
              data-tooltip="回到起始位置"
              onClick={resetCanvasViewport}
            >
              <CrosshairSimple size={16} weight="bold" aria-hidden="true" />
            </button>
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
            canvasId={canvasId}
            initialTab={historyInitialTab}
            initialWorkflowId={historyInitialWorkflowId}
            onResumeWorkflow={resumeHistoryWorkflow}
            onRestartWorkflow={restartHistoryWorkflow}
            onLocateWorkflow={locateHistoryWorkflow}
            onRegenerateGeneration={regenerateGenerationFromHistory}
            activeWorkflowIds={activeWorkflowHistoryIds}
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
      {previewOutputNode ? (
        <CanvasOutputLightbox
          node={previewOutputNode}
          onClose={() => setPreviewOutputNodeKey(null)}
        />
      ) : null}
      {previewAssetNode ? (
        <CanvasAssetLightbox node={previewAssetNode} onClose={() => setPreviewAssetNodeKey(null)} />
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
