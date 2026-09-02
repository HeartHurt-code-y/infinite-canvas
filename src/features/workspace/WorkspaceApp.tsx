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
  promptNodeClient,
  promptOptimizeClient,
  subscribeGenerationEvents,
  subscribeStagingEvents,
  toMediaSrc,
  tosStagingClient,
  videoComposerClient,
  videoDownloaderClient,
  type CloudAsset,
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
} from "../../lib/backend";
import {
  generationParameters,
  modelAllowsMediaOnlyPrompt,
  modelParameterCapabilities,
} from "../../lib/modelCapabilities";
import type { PromptContentEditorSession, PromptContentIssue } from "../../lib/promptContent";
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
} from "./MediaNodeViews";
import { AssetKindIcon } from "./PromptNodeViews";
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
  MentionCandidate,
  MobilePanel,
  NodeModelSelections,
  OutputNodeData,
  PromptNodeConfig,
  PromptOptimizationPanelState,
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
  VideoNodeConfig,
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
  VIRAL_REMIX_NODE_COARSE_HEIGHT,
  VIRAL_REMIX_NODE_HEIGHT,
  VIRAL_REMIX_NODE_WIDTH,
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
  firstTextModelSelection,
  formatTaskRawResponse,
  genNodeDimensions,
  genNodeKey,
  generationInputMentionCandidate,
  getNodeDescriptor,
  inheritedVideoAssetInputs,
  isRunningTaskStatus,
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
  readActiveAssetProviderId,
  reconcileNodeModelSelections,
  reconcileTextModelSelection,
  resolveGenerationSelection,
  resolvePendingDocumentNodeConfig,
  resolvePendingGenerationNodeConfig,
  saveComposedVideoBlob,
  screenplayMessageId,
  screenplayMaterialId,
  screenplayNodeKey,
  storyboardNodeKey,
  usesCoarsePointer,
  videoComposerNodeKey,
  videoDownloaderNodeKey,
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
const MAX_SCREENPLAY_MATERIAL_BYTES = 20 * 1024 * 1024;
const MAX_SCREENPLAY_MATERIAL_TOTAL_BYTES = 40 * 1024 * 1024;

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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
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
    viralRemixNodes,
    videoComposerNodes,
    videoDownloaderNodes,
    resultNodes,
    outputNodes,
    assetNodeByKey,
    outputNodeByKey,
    genNodeByKey,
    screenplayNodeByKey,
    storyboardNodeByKey,
    videoComposerNodeByKey,
    videoDownloaderNodeByKey,
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
      viralRemixNodes: state.nodes.viralRemix,
      videoComposerNodes: state.nodes.videoComposer,
      videoDownloaderNodes: state.nodes.videoDownloader,
      resultNodes: state.nodes.result,
      outputNodes: state.nodes.output,
      assetNodeByKey: state.nodeByKey.asset,
      outputNodeByKey: state.nodeByKey.output,
      genNodeByKey: state.nodeByKey.gen,
      screenplayNodeByKey: state.nodeByKey.screenplay,
      storyboardNodeByKey: state.nodeByKey.storyboard,
      videoComposerNodeByKey: state.nodeByKey.videoComposer,
      videoDownloaderNodeByKey: state.nodeByKey.videoDownloader,
      viralRemixNodeByKey: state.nodeByKey.viralRemix,
      assetEdges: state.graph.edges,
      canvasEdgeIndex: state.graph,
      hasCanvasNodes: state.hasNodes,
    })),
  );
  const {
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
  // 生成节点改为内容自适应高度后，记录 DOM 实际尺寸供避让、命中与 SVG 边界使用。
  const [genNodeSizes, setGenNodeSizes] = useState<Record<string, CanvasNodeDimensions>>({});
  // 各视频节点的提示词优化面板状态（key = 生成节点 key，会话内有效）。
  const [promptOptimizations, setPromptOptimizations] = useState<
    Record<string, PromptOptimizationPanelState>
  >({});
  const [promptAudits, setPromptAudits] = useState<Record<string, PromptOptimizationPanelState>>(
    {},
  );
  const [screenplayAudits, setScreenplayAudits] = useState<
    Record<string, PromptOptimizationPanelState>
  >({});
  const [storyboardAudits, setStoryboardAudits] = useState<
    Record<string, PromptOptimizationPanelState>
  >({});
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
      viralRemixNodes,
      videoComposerNodes,
      videoDownloaderNodes,
    ],
  );
  const mediaInputTargetKeysRef = useRef<ReadonlySet<string>>(new Set());
  // 提示内容 module 持有 canonical documents 与节点级 handle；视口裁剪不会丢内容。
  const [promptContents] = useState(createPromptContentModule);
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
    // 先撤销拼接产物仅会话内有效的 blob 预览，再原子清空画布持久状态。
    for (const node of outputNodes) {
      if (node.origin === "composition" && node.previewSrc?.startsWith("blob:")) {
        URL.revokeObjectURL(node.previewSrc);
      }
    }
    clearCanvasState();
    setVideoComposerRuns({});
    setVideoDownloaderRuns({});
    setGenNodeSizes({});
    setPreviewOutputNodeKey(null);
    setPromptOptimizations({});
    setPromptAudits({});
    setScreenplayAudits({});
    setStoryboardAudits({});
  }, [
    clearCanvasState,
    outputNodes,
    setVideoComposerRuns,
    setVideoDownloaderRuns,
    setGenNodeSizes,
    setPreviewOutputNodeKey,
    setPromptOptimizations,
    setPromptAudits,
    setScreenplayAudits,
    setStoryboardAudits,
  ]);

  useEffect(
    () => () => {
      for (const controller of videoComposerAbortControllersRef.current.values()) {
        controller.abort();
      }
      videoComposerAbortControllersRef.current.clear();
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
          `[canvas] 画布状态已保存: 节点=${document.assetNodes.length + document.genNodes.length + (document.screenplayNodes?.length ?? 0) + (document.storyboardNodes?.length ?? 0) + (document.viralRemixNodes?.length ?? 0) + (document.videoComposerNodes?.length ?? 0) + (document.videoDownloaderNodes?.length ?? 0) + document.resultNodes.length + (document.outputNodes?.length ?? 0)}, 连线=${document.assetEdges.length}, revision=${record.revision}`,
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
        }
        frontendLog(
          "info",
          `[canvas] 画布状态已恢复: 节点=${document.assetNodes.length + document.genNodes.length + (document.screenplayNodes?.length ?? 0) + (document.storyboardNodes?.length ?? 0) + (document.viralRemixNodes?.length ?? 0) + (document.videoComposerNodes?.length ?? 0) + (document.videoDownloaderNodes?.length ?? 0) + document.resultNodes.length + (document.outputNodes?.length ?? 0)}, 连线=${document.assetEdges.length}, revision=${record.revision}`,
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
        .list({ providerConnectionId })
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
      frontendLog(
        "info",
        `[assets] 全局设置中的素材库令牌校验成功: providerConnectionId=${providerConnectionId}, 共 ${assets.length} 个素材`,
      );
    },
    [rememberAssetProvider],
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
    return () => {
      // provider / 来源 / 设置面板改变或组件卸载时，当前请求不可再提交状态。
      cloudAssetsRequestRef.current += 1;
      settingsAssetRequestRef.current = null;
    };
  }, [assetLibrarySource, assetProvider, refreshCloudAssets, settingsOpen]);

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
      }
    }
    wasOfflineRef.current = isOffline;
  }, [isOffline, assetLibrarySource, assetProvider, refreshCloudAssets]);

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
        if (assetProvider) void refreshCloudAssets(assetProvider.id, "upload-finished");
      }
    });
  }, [assetLibrarySource, assetProvider, refreshCloudAssets, refreshLocalAssets]);

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

  const updateImageNodeConfig = useCallback(
    (key: string, config: ImageNodeConfig) => {
      patchNode("gen", key, (node) => (node.kind === "image" ? { ...node, config } : node));
      // 关闭优化开关时清掉该节点的优化面板状态（进行中的请求回来后会被 running 守卫拦下）。
      if (!config.promptOptimization?.enabled) {
        setPromptOptimizations((current) => {
          if (!(key in current)) return current;
          const next = { ...current };
          delete next[key];
          return next;
        });
      }
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

  const updatePromptNodeConfig = useCallback(
    (key: string, config: PromptNodeConfig) => {
      patchNode("gen", key, (node) => (node.kind === "prompt" ? { ...node, config } : node));
      // 手动改动源输入、模型或输出后，旧 Diff 不再对应当前版本；历史上下文仍保留在节点配置中。
      setPromptAudits((current) => {
        if (!(key in current)) return current;
        const next = { ...current };
        delete next[key];
        return next;
      });
    },
    [patchNode],
  );

  const updateScreenplayNodeConfig = useCallback(
    (key: string, config: ScreenplayNodeConfig) => {
      patchNode("screenplay", key, (node) => ({ ...node, config }));
      setScreenplayAudits((current) => {
        if (!(key in current)) return current;
        const next = { ...current };
        delete next[key];
        return next;
      });
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
            description: "已存在、超过 8 项，或超出单项 20 MB / 合计 40 MB 限制。",
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
      setStoryboardAudits((current) => {
        if (!(key in current)) return current;
        const next = { ...current };
        delete next[key];
        return next;
      });
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
      // 关闭优化开关时清掉该节点的优化面板状态（进行中的请求回来后会被 running 守卫拦下）。
      if (!config.promptOptimization?.enabled) {
        setPromptOptimizations((current) => {
          if (!(key in current)) return current;
          const next = { ...current };
          delete next[key];
          return next;
        });
      }
    },
    [patchNode],
  );

  /** 提示词节点连入的图片素材（按连线建立顺序），执行时作为视觉理解输入传给文本模型。 */
  const promptVisionImages = useCallback(
    (nodeKey: string): readonly PromptVisionImageInput[] => {
      return (canvasEdgeIndex.byTarget.get(nodeKey) ?? []).flatMap((edge) => {
        const node = assetNodeByKey.get(edge.fromKey);
        return node && node.kind === "image"
          ? [{ target: assetNodeReferenceTarget(node), displayName: node.name }]
          : [];
      });
    },
    [assetNodeByKey, canvasEdgeIndex],
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
      const sourcePrompt = node.config.sourcePrompt.trim();
      if (!sourcePrompt) {
        failWith(
          node.config.task === "generate"
            ? "请输入创意或需求，再生成提示词。"
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
      const visionImages = promptVisionImages(nodeKey);
      setNodeStartError(nodeKey, null);
      setPromptAudits((current) => {
        if (!(nodeKey in current)) return current;
        const next = { ...current };
        delete next[nodeKey];
        return next;
      });
      setStartingNodeKeys((current) => new Set(current).add(nodeKey));
      frontendLog(
        "info",
        `[generation] 发起提示词节点请求: node=${nodeKey}, task=${node.config.task}, mode=${node.config.mode}, model=${model.remoteModelId}, 视觉素材 ${visionImages.length} 张`,
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
          contextHistory: [],
          detailReview: false,
          visionImages,
        })
        .then((result) => {
          patchNode("gen", nodeKey, (item) =>
            item.kind === "prompt"
              ? { ...item, config: { ...item.config, generatedPrompt: result.optimizedPrompt } }
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
    [genNodes, promptVisionImages, providerCatalog, setNodeStartError, startingNodeKeys, patchNode],
  );

  /** 审计提示词节点的可编辑输出：技能全文与历史上下文进入系统提示词，用户提示词固定。 */
  const handlePromptAudit = useCallback(
    (nodeKey: string) => {
      const node = genNodes.find(
        (item): item is Extract<GenNodeData, { kind: "prompt" }> =>
          item.key === nodeKey && item.kind === "prompt",
      );
      if (!node) return;
      const previous = promptAudits[nodeKey];
      if (previous?.status === "running") return;
      const savedHistory = node.config.auditContextHistory ?? [];
      const previousHistory = previous?.contextHistory ?? savedHistory;
      // Diff 尚未确认应用时，“再次审计”也要沿用上一轮审计建议，
      // 这样每一轮审计都建立在最新审计版本上，而不是回到第一版输出。
      const currentPrompt = (
        previous?.status === "done" && previous.optimizedPrompt
          ? previous.optimizedPrompt
          : node.config.generatedPrompt
      ).trim();
      const auditCount = previousHistory.filter((entry) => entry.role.includes("审计输入")).length;
      const round = Math.max(previous?.round ?? 0, auditCount) + 1;
      const failWith = (message: string) => {
        setPromptAudits((current) => ({
          ...current,
          [nodeKey]: {
            status: "error",
            detail: true,
            round: Math.max(previous?.round ?? 0, auditCount),
            originalPrompt: currentPrompt,
            optimizedPrompt: null,
            error: message,
            contextHistory: previousHistory,
          },
        }));
      };
      if (!isDesktopRuntime()) {
        failWith("提示词审计只能在桌面应用中使用。请通过 Tauri 桌面端运行。");
        return;
      }
      if (!currentPrompt) {
        failWith("输出提示词为空：请先生成提示词或直接编辑输出内容，再进行审计。");
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
      const contextHistory = [
        ...previousHistory,
        { role: `第 ${round} 轮审计输入`, content: currentPrompt },
      ];
      const visionImages = promptVisionImages(nodeKey);
      setPromptAudits((current) => ({
        ...current,
        [nodeKey]: {
          status: "running",
          detail: true,
          round,
          originalPrompt: currentPrompt,
          optimizedPrompt: null,
          error: null,
          contextHistory,
        },
      }));
      frontendLog(
        "info",
        `[generation] 发起提示词审计: node=${nodeKey}, mode=${node.config.mode}, round=${round}, 提示词 ${currentPrompt.length} 字符, 视觉素材 ${visionImages.length} 张, 注入上下文 ${contextHistory.length} 条`,
      );
      void promptNodeClient
        .run({
          canvasId: CANVAS_ID,
          sourceNodeId: nodeKey,
          providerConnectionId: provider.provider.id,
          modelDefinitionId: model.definitionId,
          mode: node.config.mode,
          task: "audit",
          userPrompt: currentPrompt,
          contextHistory,
          detailReview: true,
          visionImages,
        })
        .then((result) => {
          const completedContext = [
            ...contextHistory,
            { role: `第 ${round} 轮审计结果`, content: result.optimizedPrompt },
          ];
          patchNode("gen", nodeKey, (item) =>
            item.kind === "prompt"
              ? { ...item, config: { ...item.config, auditContextHistory: completedContext } }
              : item,
          );
          setPromptAudits((current) => {
            const state = current[nodeKey];
            if (state?.status !== "running" || state.round !== round) return current;
            return {
              ...current,
              [nodeKey]: {
                ...state,
                status: "done",
                optimizedPrompt: result.optimizedPrompt,
                error: null,
                contextHistory: completedContext,
              },
            };
          });
          frontendLog(
            "info",
            `[generation] 提示词审计完成: node=${nodeKey}, round=${round}, 返回 ${result.optimizedPrompt.length} 字符`,
          );
          toast.success(`第 ${round} 轮提示词审计已完成`);
        })
        .catch((error: unknown) => {
          const message = formatRawBackendError(error);
          setPromptAudits((current) => {
            const state = current[nodeKey];
            if (state?.status !== "running" || state.round !== round) return current;
            return { ...current, [nodeKey]: { ...state, status: "error", error: message } };
          });
          frontendLog(
            "error",
            `[generation] 提示词审计失败: node=${nodeKey}, round=${round}, ${message}`,
          );
          toast.error("提示词审计失败", { description: message });
        });
    },
    [genNodes, patchNode, promptAudits, promptVisionImages, providerCatalog],
  );

  /** 应用审计建议到输出框，并把用户决定写进下一轮审计上下文。 */
  const handleApplyPromptAudit = useCallback(
    (nodeKey: string) => {
      const state = promptAudits[nodeKey];
      if (state?.status !== "done" || !state.optimizedPrompt) return;
      const contextHistory = [
        ...state.contextHistory,
        { role: "用户决定", content: `已应用第 ${state.round} 轮审计结果。` },
      ];
      patchNode("gen", nodeKey, (item) =>
        item.kind === "prompt"
          ? {
              ...item,
              config: {
                ...item.config,
                generatedPrompt: state.optimizedPrompt!,
                auditContextHistory: contextHistory,
              },
            }
          : item,
      );
      setPromptAudits((current) => ({
        ...current,
        [nodeKey]: { ...state, status: "idle", optimizedPrompt: null, error: null, contextHistory },
      }));
      frontendLog("info", `[generation] 应用提示词审计结果: node=${nodeKey}, round=${state.round}`);
      toast.success("已应用提示词审计结果", {
        description: `第 ${state.round} 轮建议已写入当前输出。`,
      });
    },
    [patchNode, promptAudits],
  );

  /** 放弃审计建议但保留审计上下文，下一轮仍可基于完整历史继续审查。 */
  const handleDiscardPromptAudit = useCallback(
    (nodeKey: string) => {
      const state = promptAudits[nodeKey];
      if (state?.status !== "done") return;
      const contextHistory = [
        ...state.contextHistory,
        { role: "用户决定", content: `已保留当前输出，未应用第 ${state.round} 轮审计结果。` },
      ];
      patchNode("gen", nodeKey, (item) =>
        item.kind === "prompt"
          ? { ...item, config: { ...item.config, auditContextHistory: contextHistory } }
          : item,
      );
      setPromptAudits((current) => ({
        ...current,
        [nodeKey]: { ...state, status: "idle", optimizedPrompt: null, error: null, contextHistory },
      }));
      frontendLog(
        "info",
        `[generation] 保留提示词审计前输出: node=${nodeKey}, round=${state.round}`,
      );
      toast.info("已保留当前提示词", {
        description: `未应用第 ${state.round} 轮审计建议。`,
      });
    },
    [patchNode, promptAudits],
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
          role: "当前 Markdown 剧本文档",
          content: node.config.currentDocument,
        });
      }
      const multimodalInputs = screenplayMultimodalInputs(node.config);
      setNodeStartError(nodeKey, null);
      setScreenplayAudits((current) => {
        if (!(nodeKey in current)) return current;
        const next = { ...current };
        delete next[nodeKey];
        return next;
      });
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
          detailReview: false,
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

  const handleScreenplayAudit = useCallback(
    (nodeKey: string) => {
      const node = screenplayNodes.find((item) => item.key === nodeKey);
      if (!node) return;
      const previous = screenplayAudits[nodeKey];
      if (previous?.status === "running") return;
      const currentDocument = (
        previous?.status === "done" && previous.optimizedPrompt
          ? previous.optimizedPrompt
          : node.config.currentDocument
      ).trim();
      const round = node.config.conversation.filter((entry) => entry.role === "audit").length + 1;
      const failWith = (message: string) => {
        setScreenplayAudits((current) => ({
          ...current,
          [nodeKey]: {
            status: "error",
            detail: true,
            round: round - 1,
            originalPrompt: currentDocument,
            optimizedPrompt: null,
            error: message,
            contextHistory: previous?.contextHistory ?? [],
          },
        }));
      };
      if (!isDesktopRuntime()) {
        failWith("剧本审计只能在桌面应用中使用。请通过 Tauri 桌面端运行。");
        return;
      }
      if (!currentDocument) {
        failWith("当前剧本为空：请先完成一轮创作或粘贴 Markdown 剧本。");
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
      contextHistory.push({ role: `第 ${round} 轮审计输入 · 当前剧本`, content: currentDocument });
      const multimodalInputs = screenplayMultimodalInputs(node.config);
      setNodeStartError(nodeKey, null);
      setScreenplayAudits((current) => ({
        ...current,
        [nodeKey]: {
          status: "running",
          detail: true,
          round,
          originalPrompt: currentDocument,
          optimizedPrompt: null,
          error: null,
          contextHistory,
        },
      }));
      frontendLog(
        "info",
        `[generation] 发起剧本审计: node=${nodeKey}, round=${round}, 剧本 ${currentDocument.length} 字符, 注入 ${contextHistory.length} 条历史, 多模态素材 ${multimodalInputs.length} 项`,
      );
      void promptNodeClient
        .run({
          canvasId: CANVAS_ID,
          sourceNodeId: nodeKey,
          providerConnectionId: provider.provider.id,
          modelDefinitionId: model.definitionId,
          mode: "screenplay",
          task: "audit",
          userPrompt: currentDocument,
          contextHistory,
          detailReview: true,
          multimodalInputs,
        })
        .then((result) => {
          const completedContext = [
            ...contextHistory,
            { role: `第 ${round} 轮审计结果`, content: result.optimizedPrompt },
          ];
          patchNode("screenplay", nodeKey, (item) => ({
            ...item,
            config: {
              ...item.config,
              conversation: [
                ...item.config.conversation,
                {
                  id: screenplayMessageId(),
                  role: "audit",
                  content: result.optimizedPrompt,
                },
              ],
            },
          }));
          setScreenplayAudits((current) => {
            const state = current[nodeKey];
            if (state?.status !== "running" || state.round !== round) return current;
            return {
              ...current,
              [nodeKey]: {
                ...state,
                status: "done",
                optimizedPrompt: result.optimizedPrompt,
                contextHistory: completedContext,
              },
            };
          });
          frontendLog(
            "info",
            `[generation] 剧本审计完成: node=${nodeKey}, round=${round}, 返回 ${result.optimizedPrompt.length} 字符`,
          );
        })
        .catch((error: unknown) => {
          const message = formatRawBackendError(error);
          setScreenplayAudits((current) => {
            const state = current[nodeKey];
            if (state?.status !== "running" || state.round !== round) return current;
            return { ...current, [nodeKey]: { ...state, status: "error", error: message } };
          });
          frontendLog("error", `[generation] 剧本审计失败: node=${nodeKey}, ${message}`);
        });
    },
    [patchNode, providerCatalog, screenplayAudits, screenplayNodes, setNodeStartError],
  );

  const handleApplyScreenplayAudit = useCallback(
    (nodeKey: string) => {
      const state = screenplayAudits[nodeKey];
      if (state?.status !== "done" || !state.optimizedPrompt) return;
      patchNode("screenplay", nodeKey, (node) => ({
        ...node,
        config: {
          ...node.config,
          currentDocument: state.optimizedPrompt!,
          conversation: [
            ...node.config.conversation,
            {
              id: screenplayMessageId(),
              role: "decision",
              content: `已应用第 ${state.round} 轮审计修订稿。`,
            },
          ],
        },
      }));
      setScreenplayAudits((current) => ({
        ...current,
        [nodeKey]: { ...state, status: "idle", optimizedPrompt: null, error: null },
      }));
      toast.success("已应用剧本审计修订稿", {
        description: `第 ${state.round} 轮修订已写入当前剧本。`,
      });
    },
    [patchNode, screenplayAudits],
  );

  const handleDiscardScreenplayAudit = useCallback(
    (nodeKey: string) => {
      const state = screenplayAudits[nodeKey];
      if (state?.status !== "done") return;
      patchNode("screenplay", nodeKey, (node) => ({
        ...node,
        config: {
          ...node.config,
          conversation: [
            ...node.config.conversation,
            {
              id: screenplayMessageId(),
              role: "decision",
              content: `已保留当前剧本，未应用第 ${state.round} 轮审计修订稿。`,
            },
          ],
        },
      }));
      setScreenplayAudits((current) => ({
        ...current,
        [nodeKey]: { ...state, status: "idle", optimizedPrompt: null, error: null },
      }));
      toast.info("已保留当前剧本", {
        description: `未应用第 ${state.round} 轮审计修订。`,
      });
    },
    [patchNode, screenplayAudits],
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
      setStoryboardAudits((current) => {
        if (!(nodeKey in current)) return current;
        const next = { ...current };
        delete next[nodeKey];
        return next;
      });
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
          detailReview: false,
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

  const handleStoryboardAudit = useCallback(
    (nodeKey: string) => {
      const node = storyboardNodes.find((item) => item.key === nodeKey);
      if (!node) return;
      const previous = storyboardAudits[nodeKey];
      if (previous?.status === "running") return;
      const currentDocument = (
        previous?.status === "done" && previous.optimizedPrompt
          ? previous.optimizedPrompt
          : node.config.currentDocument
      ).trim();
      const round = node.config.conversation.filter((entry) => entry.role === "audit").length + 1;
      const failWith = (message: string) => {
        setStoryboardAudits((current) => ({
          ...current,
          [nodeKey]: {
            status: "error",
            detail: true,
            round: round - 1,
            originalPrompt: currentDocument,
            optimizedPrompt: null,
            error: message,
            contextHistory: previous?.contextHistory ?? [],
          },
        }));
      };
      if (!isDesktopRuntime()) {
        failWith("分镜审计只能在桌面应用中使用。请通过 Tauri 桌面端运行。");
        return;
      }
      if (!currentDocument) {
        failWith("当前分镜脚本为空：请先完成一轮剧本转分镜或粘贴 Markdown 分镜稿。");
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
      const sourceInput = screenplayInputByStoryboard.get(nodeKey);
      const contextHistory: PromptOptimizationContextEntry[] = [];
      if (sourceInput?.document.trim()) {
        contextHistory.push({
          role: `已连接的上游 Markdown 剧本 · ${sourceInput.name}`,
          content: sourceInput.document.trim(),
        });
      }
      contextHistory.push(
        ...node.config.conversation.map((entry, index) => ({
          role: `第 ${index + 1} 条 · ${documentSkillRoleLabel(entry.role, "storyboard")}`,
          content: entry.content,
        })),
      );
      contextHistory.push({
        role: `第 ${round} 轮审计输入 · 当前工业级分镜脚本`,
        content: currentDocument,
      });
      setNodeStartError(nodeKey, null);
      setStoryboardAudits((current) => ({
        ...current,
        [nodeKey]: {
          status: "running",
          detail: true,
          round,
          originalPrompt: currentDocument,
          optimizedPrompt: null,
          error: null,
          contextHistory,
        },
      }));
      frontendLog(
        "info",
        `[generation] 发起工业级分镜审计: node=${nodeKey}, round=${round}, 分镜 ${currentDocument.length} 字符, 注入 ${contextHistory.length} 条历史`,
      );
      void promptNodeClient
        .run({
          canvasId: CANVAS_ID,
          sourceNodeId: nodeKey,
          providerConnectionId: provider.provider.id,
          modelDefinitionId: model.definitionId,
          mode: "storyboard",
          task: "audit",
          userPrompt: currentDocument,
          contextHistory,
          detailReview: true,
        })
        .then((result) => {
          const completedContext = [
            ...contextHistory,
            { role: `第 ${round} 轮审计结果`, content: result.optimizedPrompt },
          ];
          patchNode("storyboard", nodeKey, (item) => ({
            ...item,
            config: {
              ...item.config,
              conversation: [
                ...item.config.conversation,
                {
                  id: screenplayMessageId(),
                  role: "audit",
                  content: result.optimizedPrompt,
                },
              ],
            },
          }));
          setStoryboardAudits((current) => {
            const state = current[nodeKey];
            if (state?.status !== "running" || state.round !== round) return current;
            return {
              ...current,
              [nodeKey]: {
                ...state,
                status: "done",
                optimizedPrompt: result.optimizedPrompt,
                contextHistory: completedContext,
              },
            };
          });
          frontendLog(
            "info",
            `[generation] 工业级分镜审计完成: node=${nodeKey}, round=${round}, 返回 ${result.optimizedPrompt.length} 字符`,
          );
        })
        .catch((error: unknown) => {
          const message = formatRawBackendError(error);
          setStoryboardAudits((current) => {
            const state = current[nodeKey];
            if (state?.status !== "running" || state.round !== round) return current;
            return { ...current, [nodeKey]: { ...state, status: "error", error: message } };
          });
          frontendLog("error", `[generation] 工业级分镜审计失败: node=${nodeKey}, ${message}`);
        });
    },
    [
      patchNode,
      providerCatalog,
      screenplayInputByStoryboard,
      setNodeStartError,
      storyboardAudits,
      storyboardNodes,
    ],
  );

  const handleApplyStoryboardAudit = useCallback(
    (nodeKey: string) => {
      const state = storyboardAudits[nodeKey];
      if (state?.status !== "done" || !state.optimizedPrompt) return;
      patchNode("storyboard", nodeKey, (node) => ({
        ...node,
        config: {
          ...node.config,
          currentDocument: state.optimizedPrompt!,
          conversation: [
            ...node.config.conversation,
            {
              id: screenplayMessageId(),
              role: "decision",
              content: `已应用第 ${state.round} 轮分镜审计修订稿。`,
            },
          ],
        },
      }));
      setStoryboardAudits((current) => ({
        ...current,
        [nodeKey]: { ...state, status: "idle", optimizedPrompt: null, error: null },
      }));
      toast.success("已应用分镜审计修订稿", {
        description: `第 ${state.round} 轮修订已写入当前分镜。`,
      });
    },
    [patchNode, storyboardAudits],
  );

  const handleDiscardStoryboardAudit = useCallback(
    (nodeKey: string) => {
      const state = storyboardAudits[nodeKey];
      if (state?.status !== "done") return;
      patchNode("storyboard", nodeKey, (node) => ({
        ...node,
        config: {
          ...node.config,
          conversation: [
            ...node.config.conversation,
            {
              id: screenplayMessageId(),
              role: "decision",
              content: `已保留当前分镜脚本，未应用第 ${state.round} 轮审计修订稿。`,
            },
          ],
        },
      }));
      setStoryboardAudits((current) => ({
        ...current,
        [nodeKey]: { ...state, status: "idle", optimizedPrompt: null, error: null },
      }));
      toast.info("已保留当前分镜", {
        description: `未应用第 ${state.round} 轮审计修订。`,
      });
    },
    [patchNode, storyboardAudits],
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
            detailReview: false,
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

  /** 写入某节点的优化面板状态（running 守卫：仅当仍是本轮发起的状态时才落地结果）。 */
  const patchPromptOptimization = useCallback(
    (
      nodeKey: string,
      patch: (state: PromptOptimizationPanelState) => PromptOptimizationPanelState,
    ) => {
      setPromptOptimizations((current) => {
        const state = current[nodeKey];
        if (state == null) return current;
        return { ...current, [nodeKey]: patch(state) };
      });
    },
    [],
  );

  /**
   * 发起提示词优化：读取节点当前提示词 → 注入技能系统提示词调用文本大模型 →
   * done 态展示 diff 对比。detailReview = true 时把历史上下文全部注入并严格审查。
   */
  const handlePromptOptimize = useCallback(
    (nodeKey: string, detailReview: boolean) => {
      const genNode = genNodes.find(
        (node): node is Extract<GenNodeData, { kind: "image" | "video" }> =>
          node.key === nodeKey && (node.kind === "video" || node.kind === "image"),
      );
      const optimization = genNode?.config.promptOptimization;
      if (!genNode || !optimization?.enabled) return;
      const failWith = (message: string) => {
        setPromptOptimizations((current) => {
          const previous = current[nodeKey];
          return {
            ...current,
            [nodeKey]: {
              status: "error",
              detail: detailReview,
              round: previous?.round ?? 0,
              originalPrompt: previous?.originalPrompt ?? "",
              optimizedPrompt: null,
              error: message,
              contextHistory: previous?.contextHistory ?? [],
            },
          };
        });
      };
      if (!isDesktopRuntime()) {
        failWith("提示词优化只能在桌面应用中使用。请通过 Tauri 桌面端运行。");
        return;
      }
      // 自动应用已配置的文本模型：历史选择为空或已失效（被移除/改分类）时，
      // 回退到全局设置里第一个可用的文本模型，而不是直接报错阻塞。
      const resolveOptimizationTarget = (): {
        providerId: string;
        modelDefinitionId: string;
      } | null => {
        const provider = providerCatalog.find(
          (entry) => entry.provider.enabled && entry.provider.id === optimization.providerId,
        );
        const model = provider?.models.find(
          (item) =>
            item.definitionId === optimization.modelDefinitionId && isTextGenerationModel(item),
        );
        if (provider && model) {
          return { providerId: provider.provider.id, modelDefinitionId: model.definitionId };
        }
        const fallback = firstTextModelSelection(providerCatalog);
        return fallback.modelDefinitionId ? fallback : null;
      };
      const target = resolveOptimizationTarget();
      if (!target) {
        failWith(
          "尚未配置文本模型：请先在全局设置的「供应商连接与模型」中把至少一个模型分类为文本模型。",
        );
        return;
      }
      const preparedPrompt = promptContents.preparePlainText(nodeKey);
      if (preparedPrompt == null || !preparedPrompt.ok) {
        const issue = preparedPrompt?.issues[0];
        failWith(
          issue?.kind === "pending_reference"
            ? `请先确认提示词中的同名引用 @${issue.displayText}，再进行提示词优化。`
            : "提示词为空：请先在该节点的提示词输入框中输入内容再优化。",
        );
        if (issue) promptContents.focusIssue(nodeKey, issue);
        return;
      }
      const userPrompt = preparedPrompt.text;
      const previous = promptOptimizations[nodeKey];
      const round = (previous?.round ?? 0) + 1;
      const contextHistory = detailReview
        ? (previous?.contextHistory ?? [])
        : [{ role: "用户当前提示词", content: userPrompt }];
      setPromptOptimizations((current) => ({
        ...current,
        [nodeKey]: {
          status: "running",
          detail: detailReview,
          round,
          originalPrompt: userPrompt,
          optimizedPrompt: null,
          error: null,
          contextHistory,
        },
      }));
      frontendLog(
        "info",
        `[generation] 发起提示词优化: node=${nodeKey}, mode=${optimization.mode}, detailReview=${detailReview}, round=${round}, 提示词 ${userPrompt.length} 字符, 注入上下文 ${contextHistory.length} 条`,
      );
      promptOptimizeClient
        .optimize({
          canvasId: CANVAS_ID,
          sourceNodeId: nodeKey,
          providerConnectionId: target.providerId,
          modelDefinitionId: target.modelDefinitionId,
          mode: optimization.mode,
          userPrompt,
          contextHistory: detailReview ? contextHistory : [],
          detailReview,
        })
        .then((result) => {
          toast.success(`第 ${round} 轮提示词优化已完成`);
          patchPromptOptimization(nodeKey, (state) => {
            if (state.status !== "running") return state;
            frontendLog(
              "info",
              `[generation] 提示词优化完成: node=${nodeKey}, round=${round}, 返回 ${result.optimizedPrompt.length} 字符`,
            );
            return {
              ...state,
              status: "done",
              optimizedPrompt: result.optimizedPrompt,
              error: null,
              contextHistory: [
                ...state.contextHistory,
                {
                  role: detailReview ? `第 ${round} 轮细节审查结果` : `第 ${round} 轮优化结果`,
                  content: result.optimizedPrompt,
                },
              ],
            };
          });
        })
        .catch((error: unknown) => {
          const message = formatRawBackendError(error);
          frontendLog(
            "error",
            `[generation] 提示词优化失败: node=${nodeKey}, round=${round}, ${message}`,
          );
          toast.error("提示词优化失败", { description: message });
          patchPromptOptimization(nodeKey, (state) =>
            state.status === "running" ? { ...state, status: "error", error: message } : state,
          );
        });
    },
    [genNodes, promptContents, promptOptimizations, providerCatalog, patchPromptOptimization],
  );

  /** 不采用优化结果：保留输入框原提示词，仅记录用户决定供后续细节审查注入。 */
  const handleDiscardOptimizedPrompt = useCallback(
    (nodeKey: string) => {
      const state = promptOptimizations[nodeKey];
      if (state?.status !== "done") return;
      frontendLog("info", `[generation] 放弃优化提示词: node=${nodeKey}, round=${state.round}`);
      toast.info("已保留原提示词", {
        description: `未应用第 ${state.round} 轮优化结果。`,
      });
      patchPromptOptimization(nodeKey, (current) => ({
        ...current,
        status: "idle",
        detail: false,
        optimizedPrompt: null,
        error: null,
        contextHistory: [
          ...current.contextHistory,
          {
            role: "用户决定",
            content: `已放弃第 ${current.round} 轮${current.detail ? "细节审查" : "优化"}结果，保留原提示词。`,
          },
        ],
      }));
    },
    [promptOptimizations, patchPromptOptimization],
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
   * 图片素材还可连入提示词节点做视觉理解，提示词只可连入图片/视频节点；
   * 剧本节点可作为工业级分镜节点的实时文档输入。
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
      const storyboardTarget = storyboardNodes.find((node) => node.key === toKey);
      const result = connectCanvasStateNodes(fromKey, toKey);
      if (result.status !== "connected") return;
      const targetLabel = generationTarget
        ? `${generationTarget.kind === "image" ? "图片" : generationTarget.kind === "video" ? "视频" : "提示词"}节点`
        : composerTarget
          ? "视频拼接与合成节点"
          : viralRemixTarget
            ? "爆款视频复刻节点"
            : storyboardTarget
              ? "剧本转工业级分镜脚本节点"
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
      videoComposerNodes,
      videoDownloaderNodes,
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
      setPromptOptimizations((current) => {
        if (!(key in current)) return current;
        const next = { ...current };
        delete next[key];
        return next;
      });
      setPromptAudits((current) => {
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
      setScreenplayAudits((current) => {
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
      setStoryboardAudits((current) => {
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
   */
  const applyResultToOutputCard = useCallback(
    (record: GenerationResultRecord, previewSrc: string | null = null) => {
      if (!isDesktopRuntime()) return;
      const mediaType = record.mediaType;
      if (mediaType !== "image" && mediaType !== "video") return;
      const resultKey = `${record.taskId}#${record.resultIndex}`;
      const saved = record.saveStatus === "succeeded" && record.finalPath != null;
      if (!saved && previewSrc == null) return;
      if (saved && seenOutputResultKeysRef.current.has(resultKey)) return;
      const finalPath = saved ? record.finalPath : null;
      const name = finalPath ? fileNameFromPath(finalPath) : null;
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
        };
      });
      if (saved) {
        seenOutputResultKeysRef.current.add(resultKey);
        frontendLog("info", `[canvas] 生成产物已落卡: ${name}`);
      } else {
        frontendLog("info", `[canvas] 生成结果已返回，先展示临时预览: task=${record.taskId}`);
      }
    },
    [patchNodes],
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
        connections: connectedAssets,
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
        connectedAssets.length > 0,
      );

      // 供应商 API 无数量参数：数量 > 1 时拆分为 N 个独立任务（每个任务数量 1），
      // 每个任务对应一张占位产物卡片，单独展示状态与执行细节。
      const generationCount = Math.min(
        MAX_GENERATION_COUNT,
        Math.max(1, Math.floor(genNode.config.generationCount) || 1),
      );
      frontendLog(
        "info",
        `[generation] 发起画布生成: node=${nodeKey}（${genNode.kind}）, operation=${operation}, 提示词片段 ${promptSegments.length} 个（含 ${promptSegments.filter((s) => s.kind === "media_reference").length} 个 @引用）, 显式媒体输入 ${explicitMedia.length} 个, 生成数量 ${generationCount}（拆分为 ${generationCount} 个任务）`,
      );
      const startErrors: string[] = [];
      let remaining = generationCount;
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
            startErrors.length === generationCount
              ? `${generationCount} 个生成任务全部创建失败：${startErrors[0]}`
              : `${startErrors.length}/${generationCount} 个生成任务创建失败：${startErrors[0]}`,
          );
        }
      };
      for (let index = 0; index < generationCount; index += 1) {
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

  const videoCompositionFormat = useMemo(
    () => preferredVideoCompositionFormat()?.extension.toUpperCase() ?? null,
    [],
  );

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
        frontendLog("info", "[downloader] Cookies 已导入，抖音下载将自动携带");
      } catch (error: unknown) {
        frontendLog("error", `[downloader] Cookies 导入失败: ${formatRawBackendError(error)}`);
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
    for (const [targetKey, source] of promptSourceByTarget) {
      const generatedPrompt = source.config.generatedPrompt.trim();
      if (!generatedPrompt) continue;
      if (promptContents.read(targetKey)?.plainText.trim() === generatedPrompt) continue;
      const replaced = promptContents.replaceText(
        targetKey,
        generatedPrompt,
        mentionCandidatesFor(targetKey),
      );
      if (replaced == null) continue;
      frontendLog(
        "info",
        `[canvas] 提示词节点输出已导入生成节点: source=${source.key}, target=${targetKey}, 字符 ${generatedPrompt.length}`,
      );
    }
  }, [mentionCandidatesFor, promptContents, promptSourceByTarget]);

  /** 采用优化结果：把优化后的提示词写回节点输入框，并记录用户决定供细节审查注入。 */
  const handleAdoptOptimizedPrompt = useCallback(
    (nodeKey: string) => {
      const state = promptOptimizations[nodeKey];
      if (state?.status !== "done" || !state.optimizedPrompt) return;
      const restored = promptContents.replaceText(
        nodeKey,
        state.optimizedPrompt,
        mentionCandidatesFor(nodeKey),
      );
      if (restored) {
        // 优化结果是纯文本，按当前连线在同一提示内容 edit interface 内重建引用。
        if (restored.converted > 0 || restored.ambiguous > 0) {
          frontendLog(
            "info",
            `[generation] 优化结果重建素材引用: node=${nodeKey}, 精确恢复 ${restored.converted} 处, 待确认 ${restored.pending} 处`,
          );
        }
      }
      frontendLog("info", `[generation] 采用优化提示词: node=${nodeKey}, round=${state.round}`);
      toast.success("已采用优化提示词", {
        description: `第 ${state.round} 轮结果已写回生成节点。`,
      });
      patchPromptOptimization(nodeKey, (current) => ({
        ...current,
        status: "idle",
        detail: false,
        optimizedPrompt: null,
        error: null,
        contextHistory: [
          ...current.contextHistory,
          {
            role: "用户决定",
            content: `已采用第 ${current.round} 轮${current.detail ? "细节审查" : "优化"}结果，当前提示词已更新为该版本。`,
          },
        ],
      }));
    },
    [promptOptimizations, patchPromptOptimization, mentionCandidatesFor, promptContents],
  );

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
              audit={screenplayAudits[node.key]}
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
              onAudit={handleScreenplayAudit}
              onApplyAudit={handleApplyScreenplayAudit}
              onDiscardAudit={handleDiscardScreenplayAudit}
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
      screenplayAudits,
      selectNode,
      ignoreLegacyNodeDrag,
      removeScreenplayNode,
      removeAssetEdge,
      handleGenNodeSizeChange,
      updateScreenplayNodeConfig,
      handlePickScreenplayMaterials,
      handleRemoveScreenplayMaterial,
      handleRunScreenplayNode,
      handleScreenplayAudit,
      handleApplyScreenplayAudit,
      handleDiscardScreenplayAudit,
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
              audit={storyboardAudits[node.key]}
              sourceInput={screenplayInputByStoryboard.get(node.key) ?? null}
              onSelect={selectNode}
              onNodeDragStart={ignoreLegacyNodeDrag}
              onRemove={removeStoryboardNode}
              onUnlink={removeAssetEdge}
              onSizeChange={handleGenNodeSizeChange}
              onChange={(config) => updateStoryboardNodeConfig(node.key, config)}
              onSend={handleRunStoryboardNode}
              onAudit={handleStoryboardAudit}
              onApplyAudit={handleApplyStoryboardAudit}
              onDiscardAudit={handleDiscardStoryboardAudit}
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
      storyboardAudits,
      screenplayInputByStoryboard,
      selectNode,
      ignoreLegacyNodeDrag,
      removeStoryboardNode,
      removeAssetEdge,
      handleGenNodeSizeChange,
      updateStoryboardNodeConfig,
      handleRunStoryboardNode,
      handleStoryboardAudit,
      handleApplyStoryboardAudit,
      handleDiscardStoryboardAudit,
      handleExportStoryboard,
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
              audit={promptAudits[node.key]}
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
              onAudit={handlePromptAudit}
              onApplyAudit={handleApplyPromptAudit}
              onDiscardAudit={handleDiscardPromptAudit}
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
              promptOptimization={promptOptimizations[node.key]}
              onPromptOptimize={handlePromptOptimize}
              onAdoptOptimizedPrompt={handleAdoptOptimizedPrompt}
              onDiscardOptimizedPrompt={handleDiscardOptimizedPrompt}
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
      promptAudits,
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
      handlePromptAudit,
      handleApplyPromptAudit,
      handleDiscardPromptAudit,
      activeTaskByNode,
      inheritedInputsByNode,
      mentionCandidatesFor,
      promptSourceByTarget,
      registerPromptInput,
      promptOptimizations,
      handlePromptOptimize,
      handleAdoptOptimizedPrompt,
      handleDiscardOptimizedPrompt,
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
      ...viralRemixFlowNodes,
      ...genFlowNodes,
      ...videoComposerFlowNodes,
      ...videoDownloaderFlowNodes,
      ...resultFlowNodes,
    ],
    [
      assetFlowNodes,
      outputFlowNodes,
      screenplayFlowNodes,
      storyboardFlowNodes,
      viralRemixFlowNodes,
      genFlowNodes,
      videoComposerFlowNodes,
      videoDownloaderFlowNodes,
      resultFlowNodes,
    ],
  );

  const flowEdges = useMemo<CanvasFlowEdge[]>(
    () =>
      assetEdges.map((edge) => {
        const genSource = genTopologyByKey.get(edge.fromKey);
        const composerSource = videoComposerNodeByKey.get(edge.fromKey);
        const downloaderSource = videoDownloaderNodeByKey.get(edge.fromKey);
        const screenplaySource = screenplayNodeByKey.get(edge.fromKey);
        const source = assetNodeByKey.get(edge.fromKey);
        const outputSource = outputNodeByKey.get(edge.fromKey);
        const generationTarget = genTopologyByKey.get(edge.toKey);
        const composerTarget = videoComposerNodeByKey.get(edge.toKey);
        const viralRemixTarget = viralRemixNodeByKey.get(edge.toKey);
        const storyboardTarget = storyboardNodeByKey.get(edge.toKey);
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
              : (source?.name ?? outputSource?.name ?? "视频产物");
        const targetName = generationTarget
          ? `${generationTarget.kind === "image" ? "图片" : generationTarget.kind === "video" ? "视频" : "提示词"}生成节点`
          : composerTarget
            ? "视频拼接与合成节点"
            : viralRemixTarget
              ? "爆款视频复刻节点"
              : storyboardTarget
                ? "剧本转工业级分镜脚本节点"
                : (assetTarget?.name ?? "目标节点");
        const connectionOrder =
          composerTarget != null || (generationTarget && !promptSource)
            ? (inputOrderByEdge.get(edge.id) ?? 0)
            : viralRemixTarget
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
                  : `edge edge--asset${generationTarget || composerTarget || viralRemixTarget ? " edge--asset-generation" : ""}`,
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
      genTopologyByKey,
      videoComposerNodeByKey,
      videoDownloaderNodeByKey,
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
              onClick={() => setHistoryOpen(true)}
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
          <HistoryDialog open onClose={closeHistory} />
        </Suspense>
      ) : null}
      {previewAsset ? (
        <AssetSourceDialog asset={previewAsset} onClose={() => setPreviewAsset(null)} />
      ) : null}
      {realPersonDialogOpen && assetProvider ? (
        <RealPersonAssetDialog
          providerConnectionId={assetProvider.id}
          providerDisplayName={assetProvider.displayName}
          onClose={() => setRealPersonDialogOpen(false)}
          onUploadToGroup={handleImportLocalAssets}
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
