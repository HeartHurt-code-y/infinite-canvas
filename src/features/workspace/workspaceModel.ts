import type { Edge as ReactFlowEdge, Node as ReactFlowNode } from "@xyflow/react";
import { type ReactNode } from "react";
import {
  formatBytes,
  formatRawBackendError,
  isDesktopRuntime,
  type CloudAsset,
  type CloudAssetStatus,
  type ConfiguredModel,
  type GenerationOperation,
  type GenerationTaskSummary,
  type LocalAssetRecord,
  type MediaReferenceTarget,
  type PromptOptimizationContextEntry,
  type PromptOptimizationMode,
  type PromptMaterialKind,
  type ProviderCallRecord,
  type ProviderCatalogEntry,
  type StagingStatus,
  toMediaSrc,
} from "../../lib/backend";
import { defaultModelOperationSchema, type ModelParameterValue } from "../../lib/modelCapabilities";
import { type VideoCompositionInput } from "../../lib/videoComposer";

export type AssetKind = "image" | "video" | "audio";
export type AssetLibrarySource = "cloud" | "local";
/** 生成节点种类。视频、图片与提示词配置按画布节点实例保存。 */
export type GenerationNodeId = "image" | "video";
export type CanvasGenNodeKind = GenerationNodeId | "prompt";
export type DocumentSkillNodeKind = "screenplay" | "storyboard";
export type RepositoryNodeKind =
  CanvasGenNodeKind | DocumentSkillNodeKind | "viral_remix" | "video_composer" | "video_downloader";
export type MobilePanel = "assets" | "nodes" | null;

export interface NodeModelSelection {
  readonly providerId: string;
  readonly modelDefinitionId: string;
}

export type NodeModelSelections = Record<CanvasGenNodeKind, NodeModelSelection>;

export const DEFAULT_ZOOM = 74;
export const MIN_ZOOM = 54;
export const COARSE_POINTER_MIN_ZOOM = 74;
// 放大上限提升至 10 倍。不设真正的"无限"：极端缩放下平移/坐标计算会因
// 浮点精度出现抖动，栅格图也会放大到失去意义，保留硬顶更稳妥。
export const MAX_ZOOM = 1000;
export const ZOOM_STEP = 8;
/** 连线拖拽时端口周围的屏幕像素吸附半径；端口视觉尺寸仍保持 24px。 */
export const CANVAS_CONNECTION_RADIUS = 48;

export interface AssetItem {
  readonly id: string;
  readonly kind: AssetKind;
  readonly name: string;
  readonly meta: string;
  readonly visual: "portrait" | "station" | "rain" | "sketch" | "train" | "ambience";
  readonly previewUrl?: string | null;
  /** 视频关键帧封面（供应商封面图），缺失时抽取视频中间帧兜底。 */
  readonly coverUrl?: string | null;
  /** 视频源地址（素材卡片悬浮播放用）。 */
  readonly videoUrl?: string | null;
  readonly cloudStatus?: CloudAssetStatus;
  /** 未声明时按历史行为视为云端素材。 */
  readonly source?: AssetLibrarySource;
  readonly providerConnectionId?: string;
  readonly providerDisplayName?: string;
}

export interface AssetUploadEntry {
  readonly jobId: string;
  readonly name: string;
  readonly kind: AssetKind;
  readonly status: StagingStatus;
  readonly bytesUploaded: number;
  readonly bytesTotal: number | null;
  readonly error: unknown;
  /** 上传字节或阶段最后一次推进的时间戳（ms），用于停滞检测。 */
  readonly lastAdvancedAt: number;
  /** 上传中字节长时间未推进（疑似网络中断），由轮询在更新状态时计算。 */
  readonly stalled: boolean;
  readonly destination: AssetLibrarySource;
}

/** 从素材库拖到画布上生成的素材节点。旧文档未保存 source 时按 cloud 处理。 */
export interface AssetNodeData {
  /** 节点实例 id（同一素材可多次投放）。 */
  readonly key: string;
  readonly assetId: string;
  readonly providerConnectionId: string;
  readonly source?: AssetLibrarySource;
  readonly kind: AssetKind;
  readonly name: string;
  readonly previewUrl: string | null;
  /** 可播放的视频源地址（视频素材节点：中间帧封面 + 悬浮播放）。 */
  readonly videoUrl: string | null;
  /** 媒体原始宽高比；加载完成后写入，用于让卡片完整贴合素材而不裁切。 */
  readonly aspectRatio?: number;
  readonly x: number;
  readonly y: number;
  /** React Flow 实测尺寸（受控模式下需回存，避免节点对象重建后 handleBounds 被重置、节点闪烁隐藏）。 */
  readonly measured?: { readonly width: number; readonly height: number };
}

/**
 * 画布连线：既承载媒体/生成节点关系，也承载剧本 → 分镜的文档输入关系。
 * fromKey/toKey 共用画布节点 key 命名空间，具体语义由两端节点类型决定。
 */
export interface AssetEdgeData {
  readonly id: string;
  readonly fromKey: string;
  readonly toKey: string;
}

export interface CanvasFlowNodeData extends Record<string, unknown> {
  readonly content: ReactNode;
  readonly hasSourceHandle: boolean;
  readonly hasTargetHandle: boolean;
}

export type CanvasFlowNode = ReactFlowNode<CanvasFlowNodeData, "canvas">;

export interface CanvasFlowEdgeData extends Record<string, unknown> {
  readonly label: string;
  readonly edgeClassName: string;
  readonly order: number;
  readonly removable: boolean;
  readonly onSelect: () => void;
  readonly onRemove: () => void;
}

export type CanvasFlowEdge = ReactFlowEdge<CanvasFlowEdgeData, "canvas">;

/** 受控模式：实测尺寸存在时才携带（exactOptionalPropertyTypes 下不能显式传 undefined）。 */
export function measuredFor(node: {
  readonly measured?: { readonly width: number; readonly height: number };
}) {
  return node.measured ? { measured: node.measured } : {};
}

export interface ConnectedAssetInput {
  readonly key: string;
  readonly name: string;
  readonly kind: AssetKind;
  readonly edgeId: string;
  readonly sourceLabel: "素材" | "产物";
}

/** 分镜节点实时读取的上游剧本文档；连线只保存节点身份，不复制可能过期的正文。 */
export interface ConnectedScreenplayInput {
  readonly key: string;
  readonly name: string;
  readonly document: string;
  readonly edgeId: string;
}

export interface InheritedAssetInput {
  readonly key: string;
  readonly name: string;
  readonly kind: AssetKind;
  readonly promptNodeKey: string;
}

/** 图片/视频生成节点统一消费的媒体输入；可来自素材节点或已保存的生成产物。 */
export interface GenerationMediaInput {
  readonly key: string;
  readonly name: string;
  readonly kind: AssetKind;
  readonly target: MediaReferenceTarget;
  /** @ 下拉候选的缩略图源；素材节点直用预览图，产物节点经 finalPath/previewSrc 解析。 */
  readonly previewUrl?: string | null;
}

/**
 * 视频节点通过提示词连线自动继承上游提示词节点用于视觉理解的图片。
 * 直接连到视频节点的同一画布素材实例优先，避免同一素材被提交两次。
 */
export function inheritedVideoAssetInputs(
  nodeKey: string,
  edgesByTarget: ReadonlyMap<string, readonly AssetEdgeData[]>,
  assetNodeByKey: ReadonlyMap<string, AssetNodeData>,
  genTopologyByKey: ReadonlyMap<string, GenNodeData>,
): readonly { readonly node: AssetNodeData; readonly promptNodeKey: string }[] {
  const target = genTopologyByKey.get(nodeKey);
  if (target?.kind !== "video") return [];

  let promptNodeKey: string | null = null;
  const incoming = edgesByTarget.get(nodeKey) ?? [];
  for (const edge of incoming) {
    if (genTopologyByKey.get(edge.fromKey)?.kind === "prompt") {
      // 同一目标正常只会有一个提示词来源；旧文档若残留多条，沿用 UI 的最后一条语义。
      promptNodeKey = edge.fromKey;
    }
  }
  if (promptNodeKey == null) return [];

  const directAssetKeys = new Set<string>();
  for (const edge of incoming) {
    if (assetNodeByKey.has(edge.fromKey)) directAssetKeys.add(edge.fromKey);
  }
  const inherited: { node: AssetNodeData; promptNodeKey: string }[] = [];
  const seen = new Set(directAssetKeys);
  for (const edge of edgesByTarget.get(promptNodeKey) ?? []) {
    if (seen.has(edge.fromKey)) continue;
    const node = assetNodeByKey.get(edge.fromKey);
    if (node?.kind !== "image") continue;
    seen.add(node.key);
    inherited.push({ node, promptNodeKey });
  }
  return inherited;
}

// 素材节点最大尺寸（与 CSS 保持一致）；图片/视频在此范围内按原始比例缩放。
export const ASSET_NODE_WIDTH = 500;
export const ASSET_NODE_HEIGHT = 437.5;

export interface CanvasNodeDimensions {
  readonly width: number;
  readonly height: number;
}

/**
 * 在素材节点最大边界内按原始比例取最大尺寸：横图限制宽度，竖图限制高度。
 * 卡片比例与媒体一致，因此既不裁切，也不需要留黑/白边。
 */
export function fitMediaNodeDimensions(aspectRatio?: number): CanvasNodeDimensions {
  const fallbackRatio = ASSET_NODE_WIDTH / ASSET_NODE_HEIGHT;
  const ratio =
    aspectRatio != null && Number.isFinite(aspectRatio) && aspectRatio > 0
      ? aspectRatio
      : fallbackRatio;
  if (ratio >= fallbackRatio) {
    return { width: ASSET_NODE_WIDTH, height: ASSET_NODE_WIDTH / ratio };
  }
  return { width: ASSET_NODE_HEIGHT * ratio, height: ASSET_NODE_HEIGHT };
}

export function assetNodeDimensions(node: AssetNodeData): CanvasNodeDimensions {
  return node.kind === "audio"
    ? { width: ASSET_NODE_WIDTH, height: ASSET_NODE_HEIGHT }
    : fitMediaNodeDimensions(node.aspectRatio);
}

export function measuredAspectRatio(width: number, height: number): number | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return Math.round((width / height) * 10_000) / 10_000;
}

// 产物占位卡片沿用素材节点最大尺寸；媒体落卡后再按原始比例收缩。
export const OUTPUT_NODE_WIDTH = ASSET_NODE_WIDTH;
export const OUTPUT_NODE_HEIGHT = ASSET_NODE_HEIGHT;

// 生成节点紧凑尺寸（与 CSS 保持一致），用于连线端点与落点命中检测。
export const IMAGE_GEN_NODE_WIDTH = 580;
export const IMAGE_GEN_NODE_HEIGHT = 480;
export const IMAGE_GEN_NODE_COARSE_HEIGHT = 620;
export const VIDEO_GEN_NODE_WIDTH = 580;
export const VIDEO_GEN_NODE_HEIGHT = 900;
export const VIDEO_GEN_NODE_COARSE_HEIGHT = 1140;
export const PROMPT_NODE_WIDTH = 520;
export const PROMPT_NODE_HEIGHT = 650;
export const PROMPT_NODE_COARSE_HEIGHT = 760;
export const SCREENPLAY_NODE_WIDTH = 620;
export const SCREENPLAY_NODE_HEIGHT = 760;
export const SCREENPLAY_NODE_COARSE_HEIGHT = 900;
export const VIDEO_COMPOSER_NODE_WIDTH = 580;
export const VIDEO_COMPOSER_NODE_HEIGHT = 500;
export const VIDEO_DOWNLOADER_NODE_WIDTH = 580;
export const VIDEO_DOWNLOADER_NODE_HEIGHT = 420;
export const VIRAL_REMIX_NODE_WIDTH = 620;
export const VIRAL_REMIX_NODE_HEIGHT = 780;
export const VIRAL_REMIX_NODE_COARSE_HEIGHT = 920;

// 结果展示节点固定尺寸。
export const RESULT_NODE_WIDTH = 250;
export const RESULT_NODE_HEIGHT = 300;

// 新增节点之间保留一圈空隙，避免卡片边框、阴影和端口挤在一起。
export const NEW_NODE_GAP = 24;

export interface CanvasNodeRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** 判断候选矩形与已有节点是否保持了新增节点所需的最小间距。 */
export function isNodeRectAvailable(
  candidate: CanvasNodeRect,
  occupied: readonly CanvasNodeRect[],
): boolean {
  return occupied.every(
    (node) =>
      candidate.x + candidate.width + NEW_NODE_GAP <= node.x ||
      candidate.x >= node.x + node.width + NEW_NODE_GAP ||
      candidate.y + candidate.height + NEW_NODE_GAP <= node.y ||
      candidate.y >= node.y + node.height + NEW_NODE_GAP,
  );
}

/**
 * 从用户指定的理想左上角出发，就近寻找不与任何已有节点相交的位置。
 * 候选坐标取自每个已有节点的四条外边界；无限画布上最外侧候选必然可用。
 */
export function nearestAvailableNodePosition(
  desired: CanvasNodeRect,
  occupied: readonly CanvasNodeRect[],
): { x: number; y: number } {
  if (isNodeRectAvailable(desired, occupied)) return { x: desired.x, y: desired.y };

  const candidateXs = [desired.x];
  const candidateYs = [desired.y];
  for (const node of occupied) {
    // 同距离时优先放在右侧/下方，连续添加时布局方向更符合阅读顺序。
    candidateXs.push(node.x + node.width + NEW_NODE_GAP, node.x - desired.width - NEW_NODE_GAP);
    candidateYs.push(node.y + node.height + NEW_NODE_GAP, node.y - desired.height - NEW_NODE_GAP);
  }

  let best: { x: number; y: number } | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const x of candidateXs) {
    for (const y of candidateYs) {
      const candidate = { ...desired, x, y };
      if (!isNodeRectAvailable(candidate, occupied)) continue;
      const distance = (x - desired.x) ** 2 + (y - desired.y) ** 2;
      if (distance < bestDistance) {
        best = { x, y };
        bestDistance = distance;
      }
    }
  }

  // candidateXs 至少含最右侧节点之外的位置，理论上不会触发；保留理想位置作防御兜底。
  return best ?? { x: desired.x, y: desired.y };
}

// 产物卡片自动落点：来源生成节点右侧的水平间距，以及同节点多张卡片的垂直堆叠间距。
export const OUTPUT_NODE_GAP_X = 96;
export const OUTPUT_NODE_GAP_Y = 32;

// 素材卡片与节点仓库卡片统一使用指针拖拽（见 RepositoryCard / AssetCard）：
// Tauri WebView 的系统拖放处理器会拦截 HTML5 dataTransfer 拖拽，不能依赖 draggable。

export interface BaseGenNodeData {
  readonly key: string;
  readonly x: number;
  readonly y: number;
  /** React Flow 实测尺寸（受控模式下需回存，避免节点对象重建后 handleBounds 被重置、节点闪烁隐藏）。 */
  readonly measured?: { readonly width: number; readonly height: number };
}

/** 画布上的生成节点实例（从节点仓库拖入，可无限重复）。 */
export type GenNodeData =
  | (BaseGenNodeData & {
      readonly kind: "image";
      readonly config: ImageNodeConfig;
    })
  | (BaseGenNodeData & {
      readonly kind: "video";
      readonly config: VideoNodeConfig;
    })
  | (BaseGenNodeData & {
      readonly kind: "prompt";
      readonly config: PromptNodeConfig;
    });

export type ScreenplayConversationRole = "user" | "assistant" | "audit" | "decision";

export interface ScreenplayConversationEntry {
  readonly id: string;
  readonly role: ScreenplayConversationRole;
  readonly content: string;
}

/** 剧本节点引用的本地素材元数据；大文件正文不进入画布存档。 */
export interface ScreenplayMaterialInput {
  readonly id: string;
  readonly localPath: string;
  readonly displayName: string;
  readonly kind: PromptMaterialKind;
  readonly mimeType: string;
  readonly byteSize: number;
}

export interface ScreenplayNodeConfig {
  readonly modelSelection: NodeModelSelection;
  /** 尚未发送的本轮输入，随画布保存。 */
  readonly composer: string;
  /** 全部已完成轮次；每次请求都会完整注入。 */
  readonly conversation: readonly ScreenplayConversationEntry[];
  /** 当前可编辑、可导出的 Markdown 剧本文档。 */
  readonly currentDocument: string;
  /** 每轮创作与审计都会重新发送的本地多模态参考素材。 */
  readonly materials?: readonly ScreenplayMaterialInput[];
  readonly catalogResolved: boolean;
}

export interface ScreenplayNodeData {
  readonly key: string;
  readonly kind: "screenplay";
  readonly x: number;
  readonly y: number;
  /** React Flow 实测尺寸（受控模式下需回存，避免节点对象重建后 handleBounds 被重置、节点闪烁隐藏）。 */
  readonly measured?: { readonly width: number; readonly height: number };
  readonly config: ScreenplayNodeConfig;
}

export interface StoryboardNodeData {
  readonly key: string;
  readonly kind: "storyboard";
  readonly x: number;
  readonly y: number;
  /** React Flow 实测尺寸（受控模式下需回存，避免节点对象重建后 handleBounds 被重置、节点闪烁隐藏）。 */
  readonly measured?: { readonly width: number; readonly height: number };
  readonly config: ScreenplayNodeConfig;
}

export type DocumentSkillNodeData = ScreenplayNodeData | StoryboardNodeData;

export interface VideoComposerNodeConfig {
  readonly outputName: string;
  /** 保存用户明确调整过的顺序；恢复时会与当前连线集合归一化。 */
  readonly inputOrder: readonly string[];
}

/** 本地工具节点：按显式顺序把素材视频或生成产物视频录制为一个完整视频。 */
export interface VideoComposerNodeData {
  readonly key: string;
  readonly kind: "video_composer";
  readonly x: number;
  readonly y: number;
  /** React Flow 实测尺寸（受控模式下需回存，避免节点对象重建后 handleBounds 被重置、节点闪烁隐藏）。 */
  readonly measured?: { readonly width: number; readonly height: number };
  readonly config: VideoComposerNodeConfig;
}

export interface VideoComposerInput {
  readonly key: string;
  readonly name: string;
  readonly src: string;
  readonly sourceLabel: "素材" | "产物";
  readonly edgeId: string;
  /**
   * 可交给 Rust FFmpeg 合成的来源：本地文件绝对路径或 http(s) 地址。
   * 省略（如仅有会话内 blob 预览）时整次合成回退 WebView MediaRecorder 路径。
   */
  readonly ffmpegSource?: string | null;
}

export interface VideoComposerRunState {
  readonly status: "running" | "done" | "error";
  readonly progress: number;
  readonly error: string | null;
}

/** 本地工具节点：粘贴网络视频链接（抖音等），用内置 yt-dlp 引擎下载为本地视频。 */
export interface VideoDownloaderNodeData {
  readonly key: string;
  readonly kind: "video_downloader";
  readonly x: number;
  readonly y: number;
  /** React Flow 实测尺寸（受控模式下需回存，避免节点对象重建后 handleBounds 被重置、节点闪烁隐藏）。 */
  readonly measured?: { readonly width: number; readonly height: number };
  readonly config: VideoDownloaderNodeConfig;
}

export interface VideoDownloaderNodeConfig {
  /** 节点内保存的链接输入（可能是整段分享口令文本，启动时提取首个 URL）。 */
  readonly url: string;
}

/**
 * 下载任务的会话内运行状态。jobId 关联后端内存任务记录；
 * 下载完成时节点右侧自动落一张 origin=download 的产物卡片。
 */
export interface VideoDownloaderRunState {
  readonly jobId: string;
  readonly status: "running" | "done" | "error" | "cancelled";
  readonly preparingEngine: boolean;
  readonly progress: number | null;
  readonly error: string | null;
}

export interface ViralRemixNodeConfig {
  readonly modelSelection: NodeModelSelection;
  /** 可选的题材、品牌或改编方向；为空时按内置技能自动完成忠实复刻与三条二创。 */
  readonly instructions: string;
  /** 当前可编辑、可导出的 Markdown 复刻方案。 */
  readonly currentDocument: string;
  readonly catalogResolved: boolean;
}

export interface ViralRemixNodeData {
  readonly key: string;
  readonly kind: "viral_remix";
  readonly x: number;
  readonly y: number;
  /** React Flow 实测尺寸（受控模式下需回存，避免节点对象重建后 handleBounds 被重置、节点闪烁隐藏）。 */
  readonly measured?: { readonly width: number; readonly height: number };
  readonly config: ViralRemixNodeConfig;
}

export interface ViralRemixVideoInput {
  readonly key: string;
  readonly name: string;
  readonly src: string | null;
  readonly sourceLabel: "素材" | "产物" | "下载节点";
  readonly edgeId: string;
}

export function usesCoarsePointer(): boolean {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches
    ? true
    : false;
}

export function minimumCanvasZoom(): number {
  return usesCoarsePointer() ? COARSE_POINTER_MIN_ZOOM : MIN_ZOOM;
}

export function genNodeDimensions(kind: CanvasGenNodeKind): { width: number; height: number } {
  if (kind === "video") {
    return {
      width: VIDEO_GEN_NODE_WIDTH,
      height: usesCoarsePointer() ? VIDEO_GEN_NODE_COARSE_HEIGHT : VIDEO_GEN_NODE_HEIGHT,
    };
  }
  if (kind === "prompt") {
    return {
      width: PROMPT_NODE_WIDTH,
      height: usesCoarsePointer() ? PROMPT_NODE_COARSE_HEIGHT : PROMPT_NODE_HEIGHT,
    };
  }
  return {
    width: IMAGE_GEN_NODE_WIDTH,
    height: usesCoarsePointer() ? IMAGE_GEN_NODE_COARSE_HEIGHT : IMAGE_GEN_NODE_HEIGHT,
  };
}

/** 画布上的结果展示节点实例。 */
export interface ResultNodeData {
  readonly key: string;
  readonly x: number;
  readonly y: number;
  /** React Flow 实测尺寸（受控模式下需回存，避免节点对象重建后 handleBounds 被重置、节点闪烁隐藏）。 */
  readonly measured?: { readonly width: number; readonly height: number };
}

/**
 * 生成任务启动后自动落画布的产物卡片（本地生成结果的画布投影）：
 * 不在生成节点内部展示产物，而是生成独立卡片并以虚线连回来源节点。
 * 任务进行中先落下占位卡片展示进度，结果返回后先展示会话内预览，保存完成后切换到本地文件，失败展示完整原始错误。
 */
export interface OutputNodeData {
  /** 节点实例 id。 */
  readonly key: string;
  /** 结果唯一标识（taskId#resultIndex）；任务尚未产出结果时为 null。 */
  readonly resultKey: string | null;
  /** 来源生成节点 key（定位与虚线连线用）。 */
  readonly sourceNodeId: string;
  readonly taskId: string;
  readonly mediaType: "image" | "video";
  /** 旧文档未保存时默认为 generation。 */
  readonly origin?: "generation" | "composition" | "download";
  /** 本地产物文件绝对路径（桌面端经 convertFileSrc 展示）；任务未完成时为 null。 */
  readonly finalPath: string | null;
  /** 供应商返回后、保存完成前的会话内预览地址；不写入画布文档。 */
  readonly previewSrc?: string | null;
  /** 展示名（产物文件名）；任务未完成时为 null。 */
  readonly name: string | null;
  /** 生成结果原始宽高比；成功加载后写入并随画布持久化。 */
  readonly aspectRatio?: number;
  readonly x: number;
  readonly y: number;
  /** React Flow 实测尺寸（受控模式下需回存，避免节点对象重建后 handleBounds 被重置、节点闪烁隐藏）。 */
  readonly measured?: { readonly width: number; readonly height: number };
}

export function outputNodeDimensions(node: OutputNodeData): CanvasNodeDimensions {
  return node.finalPath == null && node.previewSrc == null
    ? { width: OUTPUT_NODE_WIDTH, height: OUTPUT_NODE_HEIGHT }
    : fitMediaNodeDimensions(node.aspectRatio);
}

export function assetNodeKey(): string {
  return `asset-${Math.random().toString(36).slice(2, 10)}`;
}

export function genNodeKey(): string {
  return `gen-${Math.random().toString(36).slice(2, 10)}`;
}

export function outputNodeKey(): string {
  return `output-${Math.random().toString(36).slice(2, 10)}`;
}

export function videoComposerNodeKey(): string {
  return `composer-${Math.random().toString(36).slice(2, 10)}`;
}

export function videoDownloaderNodeKey(): string {
  return `downloader-${Math.random().toString(36).slice(2, 10)}`;
}

export function screenplayNodeKey(): string {
  return `screenplay-${Math.random().toString(36).slice(2, 10)}`;
}

export function storyboardNodeKey(): string {
  return `storyboard-${Math.random().toString(36).slice(2, 10)}`;
}

export function viralRemixNodeKey(): string {
  return `viral-remix-${Math.random().toString(36).slice(2, 10)}`;
}

export function screenplayMessageId(): string {
  return `turn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function screenplayMaterialId(): string {
  return `material-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function markdownDocumentExportName(
  content: string,
  nodeKey: string,
  fallbackLabel: string,
): string {
  const heading = content
    .split(/\r?\n/)
    .map((line) => line.match(/^#\s+(.+)$/)?.[1]?.trim())
    .find((value): value is string => Boolean(value));
  const base = Array.from(heading ?? `${fallbackLabel}-${nodeKey.slice(-6)}`)
    .map((character) =>
      '<>:"/\\|?*'.includes(character) || character.charCodeAt(0) < 32 ? "-" : character,
    )
    .join("")
    .replace(/[. ]+$/g, "")
    .slice(0, 80);
  return `${base || `${fallbackLabel}-${nodeKey.slice(-6)}`}.md`;
}

/**
 * 计算产物卡片在来源生成节点右侧的落点：
 * 同一节点的多张卡片（多次生成）按现有数量垂直堆叠。
 */
export function nextOutputSlot(
  genNode: GenNodeData,
  current: readonly OutputNodeData[],
): { x: number; y: number } {
  const { width } = genNodeDimensions(genNode.kind);
  const stackIndex = current.filter((node) => node.sourceNodeId === genNode.key).length;
  return {
    x: genNode.x + width + OUTPUT_NODE_GAP_X,
    y: genNode.y + stackIndex * (OUTPUT_NODE_HEIGHT + OUTPUT_NODE_GAP_Y),
  };
}

export function nextVideoComposerOutputSlot(
  node: VideoComposerNodeData,
  current: readonly OutputNodeData[],
): { x: number; y: number } {
  const stackIndex = current.filter((output) => output.sourceNodeId === node.key).length;
  return {
    x: node.x + VIDEO_COMPOSER_NODE_WIDTH + OUTPUT_NODE_GAP_X,
    y: node.y + stackIndex * (OUTPUT_NODE_HEIGHT + OUTPUT_NODE_GAP_Y),
  };
}

export function nextVideoDownloaderOutputSlot(
  node: VideoDownloaderNodeData,
  current: readonly OutputNodeData[],
): { x: number; y: number } {
  const stackIndex = current.filter((output) => output.sourceNodeId === node.key).length;
  return {
    x: node.x + VIDEO_DOWNLOADER_NODE_WIDTH + OUTPUT_NODE_GAP_X,
    y: node.y + stackIndex * (OUTPUT_NODE_HEIGHT + OUTPUT_NODE_GAP_Y),
  };
}

/** 从产物绝对路径提取文件名（兼容 Windows 反斜杠分隔符）。 */
export function fileNameFromPath(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

/** 桌面端通过原生 HTTP 拉取远程素材，转为同源 Blob，避免画布录制被 CORS 污染。 */
export async function materializeCompositionInputs(inputs: readonly VideoComposerInput[]): Promise<{
  readonly inputs: readonly VideoCompositionInput[];
  readonly objectUrls: readonly string[];
}> {
  const objectUrls: string[] = [];
  try {
    const materialized = await Promise.all(
      inputs.map(async (input) => {
        if (!isDesktopRuntime() || !/^https?:\/\//i.test(input.src)) {
          return { key: input.key, name: input.name, src: input.src };
        }
        const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
        const response = await tauriFetch(input.src);
        if (!response.ok) {
          throw new Error(`读取「${input.name}」失败（HTTP ${response.status}）。`);
        }
        const objectUrl = URL.createObjectURL(await response.blob());
        objectUrls.push(objectUrl);
        return { key: input.key, name: input.name, src: objectUrl };
      }),
    );
    return { inputs: materialized, objectUrls };
  } catch (error) {
    for (const url of objectUrls) URL.revokeObjectURL(url);
    throw error;
  }
}

export async function saveComposedVideoBlob(
  blob: Blob,
  fileName: string,
): Promise<{ readonly finalPath: string | null; readonly previewSrc: string | null }> {
  if (!isDesktopRuntime()) {
    const previewSrc = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = previewSrc;
    anchor.download = fileName;
    anchor.click();
    return { finalPath: null, previewSrc };
  }
  const [{ downloadDir, join }, { exists, mkdir, writeFile }] = await Promise.all([
    import("@tauri-apps/api/path"),
    import("@tauri-apps/plugin-fs"),
  ]);
  const directory = await join(await downloadDir(), "无限画布");
  await mkdir(directory, { recursive: true });
  let finalPath = await join(directory, fileName);
  const extensionIndex = fileName.lastIndexOf(".");
  const baseName = extensionIndex > 0 ? fileName.slice(0, extensionIndex) : fileName;
  const extension = extensionIndex > 0 ? fileName.slice(extensionIndex) : "";
  let suffix = 2;
  while (await exists(finalPath)) {
    finalPath = await join(directory, `${baseName}-${suffix}${extension}`);
    suffix += 1;
  }
  await writeFile(finalPath, new Uint8Array(await blob.arrayBuffer()));
  return { finalPath, previewSrc: null };
}

export const ASSET_CLOUD_STATUS_LABELS: Record<CloudAssetStatus, string> = {
  processing: "云端处理中",
  ready: "已就绪",
  failed: "导入失败",
  deleted: "已删除",
  unknown: "状态未知",
};

export const STAGING_STATUS_LABELS: Record<StagingStatus, string> = {
  validating: "校验文件",
  authorizing: "申请上传地址",
  uploading: "上传中",
  staged: "上传完成",
  importing: "云端导入中",
  active: "导入成功",
  in_use: "使用中",
  failed: "失败",
  interrupted: "已中断",
  cleaning: "清理暂存",
  cleaned: "已完成",
};

// 到达这些状态后停止轮询，显示可移除的终态记录。
export const TERMINAL_UPLOAD_STATUSES: ReadonlySet<StagingStatus> = new Set([
  "active",
  "cleaned",
  "failed",
  "interrupted",
]);

export function isTerminalAssetUpload(entry: AssetUploadEntry): boolean {
  return (
    TERMINAL_UPLOAD_STATUSES.has(entry.status) ||
    (entry.destination === "local" && entry.status === "staged")
  );
}

// 上传进度只写入 SQLite，staging:state-changed 事件仅在任务结束时发射，
// 因此前端按该间隔轮询 get_staging_job 刷新进度条。
export const UPLOAD_POLL_INTERVAL_MS = 1000;

// yt-dlp 下载任务的进度轮询间隔（与迁移前 setTimeout 链的节奏一致）。
export const DOWNLOAD_POLL_INTERVAL_MS = 700;

// 生成任务状态的主驱动是 generation:* 事件（失效触发重新拉取）；该间隔仅在
// 存在未到终态的任务时作为兜底轮询，防止漏接事件让占位卡片永远停在“进行中”。
export const GENERATION_TASKS_POLL_INTERVAL_MS = 2000;

export const GENERATION_TASKS_QUERY_KEY = ["generation-tasks"] as const;
// 空任务列表的稳定引用：避免任务数据缺失时 useMemo 依赖反复变化。
export const EMPTY_GENERATION_TASKS: readonly GenerationTaskSummary[] = [];

// 上传中超过该时长字节无推进时，提示疑似网络中断（后端 reqwest 总超时最长 300s，
// 停滞期间进度条会一直停留在最后字节数，没有该提示用户无法区分“慢”和“断”）。
export const UPLOAD_STALL_HINT_MS = 15_000;

// 云端素材列表刷新的触发来源，写入 [assets] 日志便于区分刷新路径。
export type AssetRefreshSource = "initial" | "manual" | "reconnect" | "upload-finished" | "delete";

// 云端单页最多 100 条，本地索引没有上限；分批挂载媒体卡片，避免一次创建无界 DOM。
export const ASSET_RENDER_BATCH_SIZE = 40;

export const ACTIVE_ASSET_PROVIDER_STORAGE_KEY = "infinite-canvas:active-asset-provider-connection";

export function readActiveAssetProviderId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(ACTIVE_ASSET_PROVIDER_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function persistActiveAssetProviderId(providerConnectionId: string): void {
  try {
    window.localStorage.setItem(ACTIVE_ASSET_PROVIDER_STORAGE_KEY, providerConnectionId);
  } catch {
    // WebView 存储不可用时仍保留当前会话内的选择。
  }
}

// 从后端 runtime record（JSON）中提取人类可读的失败原因。
export function stagingErrorSummary(error: unknown): string | null {
  if (error == null) return null;
  if (typeof error === "string") return error;
  if (typeof error === "object") {
    const record = error as Record<string, unknown>;
    const message = typeof record["message"] === "string" ? record["message"] : null;
    const kind = typeof record["kind"] === "string" ? record["kind"] : null;
    if (message != null) return kind != null ? `${kind}：${message}` : message;
  }
  return formatRawBackendError(error);
}

export const ASSET_RAW_RESPONSE_MARKER = "原始响应：";

export function findAssetErrorMessage(value: unknown, depth = 0): string | null {
  if (depth > 5 || value == null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const key of ["message", "msg", "error_description", "reason", "source"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  for (const key of ["error", "details", "detail", "response", "body"]) {
    const candidate = findAssetErrorMessage(record[key], depth + 1);
    if (candidate) return candidate;
  }
  return null;
}

export function formatAssetErrorDetails(error: string): string {
  const trimmed = error.trim();
  const markerIndex = trimmed.indexOf(ASSET_RAW_RESPONSE_MARKER);
  if (markerIndex >= 0) {
    const prefix = trimmed.slice(0, markerIndex).trim();
    const rawResponse = trimmed.slice(markerIndex + ASSET_RAW_RESPONSE_MARKER.length).trim();
    try {
      const parsed = JSON.parse(rawResponse) as unknown;
      return `${prefix}${prefix ? "\n\n" : ""}${ASSET_RAW_RESPONSE_MARKER}\n${JSON.stringify(parsed, null, 2)}`;
    } catch {
      return trimmed;
    }
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return typeof parsed === "string" ? parsed : (JSON.stringify(parsed, null, 2) ?? trimmed);
  } catch {
    return trimmed;
  }
}

export function assetErrorPresentation(error: string): { summary: string; details: string } {
  const trimmed = error.trim();
  const mainMessage = (trimmed.split(ASSET_RAW_RESPONSE_MARKER, 1)[0] ?? trimmed).trim();
  const status = mainMessage.match(/HTTP\s+\d{3}/i)?.[0] ?? null;
  const reason = mainMessage.match(/）：\s*(.+)$/)?.[1]?.trim() ?? null;
  if (status && reason) {
    return {
      summary: `${status} · ${reason}`,
      details: formatAssetErrorDetails(trimmed),
    };
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    // 非 JSON 错误直接按文本展示。
  }
  return {
    summary: findAssetErrorMessage(parsed) ?? (mainMessage || trimmed),
    details: formatAssetErrorDetails(trimmed),
  };
}

export const ASSET_KIND_LABELS: Record<AssetKind, string> = {
  image: "图片",
  video: "视频",
  audio: "音频",
};

export const ASSETS: readonly AssetItem[] = [
  {
    id: "asset-image-01",
    kind: "image",
    name: "林遥·角色正面",
    meta: "2048 × 3072",
    visual: "portrait",
  },
  {
    id: "asset-image-02",
    kind: "image",
    name: "旧站台·清晨",
    meta: "3840 × 2160",
    visual: "station",
  },
  {
    id: "asset-image-03",
    kind: "image",
    name: "雨夜街道",
    meta: "2560 × 1440",
    visual: "rain",
  },
  {
    id: "asset-image-04",
    kind: "image",
    name: "分镜草图 12",
    meta: "1920 × 1080",
    visual: "sketch",
  },
  {
    id: "asset-video-01",
    kind: "video",
    name: "列车进站参考",
    meta: "00:08 · 4K",
    visual: "train",
  },
  {
    id: "asset-video-02",
    kind: "video",
    name: "衣摆运动参考",
    meta: "00:05 · 1080p",
    visual: "portrait",
  },
  {
    id: "asset-audio-01",
    kind: "audio",
    name: "站台环境声",
    meta: "00:14 · WAV",
    visual: "ambience",
  },
  {
    id: "asset-audio-02",
    kind: "audio",
    name: "远处列车鸣笛",
    meta: "00:07 · WAV",
    visual: "ambience",
  },
] as const;

export const DEMO_PROVIDER_CATALOG: readonly ProviderCatalogEntry[] = [
  {
    provider: {
      id: "moyu-production",
      displayName: "Moyu · 生产环境",
      adapterId: "moyu_v1",
      baseUrl: "https://api.example.com/v1",
      apiKeyRef: "provider:moyu-production:api-key",
      enabled: true,
      createdAt: 0,
      updatedAt: 0,
    },
    models: [
      {
        definitionId: "gpt-image-2",
        remoteModelId: "gpt-image-2",
        displayName: "GPT Image 2",
        operations: ["text_to_image", "image_to_image"],
        operationSchema: defaultModelOperationSchema("gpt-image-2", [
          "text_to_image",
          "image_to_image",
        ]),
      },
      {
        definitionId: "doubao-seedance-2-5-260628",
        remoteModelId: "doubao-seedance-2-5-260628",
        displayName: "Seedance 2.5",
        operations: ["video_generation"],
        operationSchema: defaultModelOperationSchema("doubao-seedance-2-5-260628", [
          "video_generation",
        ]),
      },
      {
        definitionId: "doubao-seed-1-8-251228",
        remoteModelId: "doubao-seed-1-8-251228",
        displayName: "Seed 1.8 文本模型",
        operations: ["text_generation"],
        operationSchema: defaultModelOperationSchema("doubao-seed-1-8-251228", ["text_generation"]),
      },
    ],
  },
  {
    provider: {
      id: "maigateway",
      displayName: "MAIGateway",
      adapterId: "moyu_v1",
      baseUrl: "https://mai.anquan.info/v1",
      apiKeyRef: "provider:maigateway:api-key",
      enabled: true,
      createdAt: 0,
      updatedAt: 0,
    },
    models: [],
  },
  {
    provider: {
      id: "moyu-staging",
      displayName: "Moyu · 测试环境",
      adapterId: "moyu_v1",
      baseUrl: "https://staging.example.com/v1",
      apiKeyRef: "provider:moyu-staging:api-key",
      enabled: true,
      createdAt: 0,
      updatedAt: 0,
    },
    models: [
      {
        definitionId: "doubao-seedance-2-0-fast-260128",
        remoteModelId: "doubao-seedance-2-0-fast-260128",
        displayName: "Seedance 2.0 Fast",
        operations: ["video_generation"],
        operationSchema: defaultModelOperationSchema("doubao-seedance-2-0-fast-260128", [
          "video_generation",
        ]),
      },
    ],
  },
] as const;

export const DEFAULT_NODE_MODEL_SELECTIONS: NodeModelSelections = {
  image: { providerId: "moyu-production", modelDefinitionId: "gpt-image-2" },
  video: {
    providerId: "moyu-production",
    modelDefinitionId: "doubao-seedance-2-5-260628",
  },
  prompt: {
    providerId: "moyu-production",
    modelDefinitionId: "doubao-seed-1-8-251228",
  },
};

export interface StaticNodeDescriptor {
  readonly kindLabel: string;
  readonly title?: string;
  readonly description: string;
}

export const NODE_KIND_DESCRIPTORS: Record<CanvasGenNodeKind | "result", StaticNodeDescriptor> = {
  prompt: {
    kindLabel: "提示词生成与优化",
    description: "文本模型 · 生成后可连接图片或视频节点",
  },
  image: {
    kindLabel: "图片生成",
    description: "文生图 · 生成后保存到本机",
  },
  video: {
    kindLabel: "视频生成",
    description: "视频生成 · 自动轮询直到完成",
  },
  result: {
    kindLabel: "本地结果",
    title: "关键帧结果",
    description: "生成成功后自动保存到本机",
  },
};

export const SCREENPLAY_NODE_DESCRIPTOR: StaticNodeDescriptor = {
  kindLabel: "剧本创作与优化",
  description: "内置双技能 · 多轮创作、审计与 Markdown 导出",
};

export const STORYBOARD_NODE_DESCRIPTOR: StaticNodeDescriptor = {
  kindLabel: "剧本转工业级分镜脚本",
  description: "内置 V4.6 技能 · 多轮分镜、审计与 Markdown 导出",
};

export interface DocumentSkillNodeCopy {
  readonly descriptor: StaticNodeDescriptor;
  readonly assistantRole: string;
  readonly documentName: string;
  readonly currentDocumentLabel: string;
  readonly skillTitle: string;
  readonly skillDetail: string;
  readonly providerAriaLabel: string;
  readonly modelAriaLabel: string;
  readonly conversationAriaLabel: string;
  readonly emptyTitle: string;
  readonly emptyDescription: string;
  readonly composerAriaLabel: string;
  readonly composerPlaceholder: string;
  readonly documentPlaceholder: string;
  readonly loadingLabel: string;
  readonly removeAriaLabel: string;
  readonly exportAriaLabel: string;
  readonly exportReadyTitle: string;
  readonly exportEmptyTitle: string;
}

export const DOCUMENT_SKILL_NODE_COPY: Record<DocumentSkillNodeKind, DocumentSkillNodeCopy> = {
  screenplay: {
    descriptor: SCREENPLAY_NODE_DESCRIPTOR,
    assistantRole: "编剧助手",
    documentName: "剧本",
    currentDocumentLabel: "当前剧本",
    skillTitle: "双技能已内置",
    skillDetail: "screenplay-master + screenwriter-zh · 每轮完整注入",
    providerAriaLabel: "剧本文本模型供应商",
    modelAriaLabel: "剧本文本模型",
    conversationAriaLabel: "剧本多轮对话",
    emptyTitle: "从灵感、梗概或已有剧本开始",
    emptyDescription: "助手会按项目类型逐步提问；后续每轮都会带上全部对话。",
    composerAriaLabel: "剧本对话消息",
    composerPlaceholder: "例如：写一部 80 集女频复仇短剧，先从项目参数开始",
    documentPlaceholder: "对话产出的最新稿件会同步到这里，也可以粘贴或直接编辑后审计、导出。",
    loadingLabel: "正在载入双技能与全部对话…",
    removeAriaLabel: "移除剧本创作与优化节点",
    exportAriaLabel: "导出 Markdown 剧本文档",
    exportReadyTitle: "导出当前剧本",
    exportEmptyTitle: "暂无可导出的剧本",
  },
  storyboard: {
    descriptor: STORYBOARD_NODE_DESCRIPTOR,
    assistantRole: "分镜导演",
    documentName: "分镜脚本",
    currentDocumentLabel: "当前工业级分镜脚本",
    skillTitle: "V4.6 分镜技能已内置",
    skillDetail: "SKILL.md + 16 references · 每轮完整注入",
    providerAriaLabel: "分镜文本模型供应商",
    modelAriaLabel: "分镜文本模型",
    conversationAriaLabel: "工业级分镜多轮对话",
    emptyTitle: "粘贴剧本，开始工业化拆镜",
    emptyDescription: "逐轮锁定画幅、时长与资产；每轮都会带上完整对话和当前分镜稿。",
    composerAriaLabel: "分镜对话消息",
    composerPlaceholder:
      "粘贴剧本，或输入：将上面的剧本转成 9:16、每段 15 秒的 Seedance 2.5 分镜脚本",
    documentPlaceholder:
      "最新工业级分镜稿会同步到这里；可直接编辑、继续对话、审计并导出 Markdown。",
    loadingLabel: "正在载入 V4.6 技能与全部上下文…",
    removeAriaLabel: "移除剧本转工业级分镜脚本节点",
    exportAriaLabel: "导出 Markdown 分镜脚本文档",
    exportReadyTitle: "导出当前工业级分镜脚本",
    exportEmptyTitle: "暂无可导出的分镜脚本",
  },
};

export function documentSkillRoleLabel(
  role: ScreenplayConversationRole,
  kind: DocumentSkillNodeKind,
): string {
  if (role === "user") return "你";
  if (role === "audit") return "审计";
  if (role === "decision") return "决定";
  return DOCUMENT_SKILL_NODE_COPY[kind].assistantRole;
}

export interface NodeDescriptorContext {
  readonly providerCatalog: readonly ProviderCatalogEntry[];
  readonly nodeModelSelections: NodeModelSelections;
}

export function getNodeDescriptor(
  kind: CanvasGenNodeKind | "result",
  context: NodeDescriptorContext,
  selectionOverride?: NodeModelSelection,
  operationOverride?: GenerationOperation,
): StaticNodeDescriptor {
  const base = NODE_KIND_DESCRIPTORS[kind];
  if (kind === "result" || kind === "prompt") return base;
  const selection = selectionOverride ?? context.nodeModelSelections[kind];
  const resolved = resolveGenerationSelection(kind, selection, context.providerCatalog);
  if (!resolved || (operationOverride && !resolved.model.operations.includes(operationOverride))) {
    return { ...base, description: "所选供应商或模型当前不可用" };
  }
  return {
    ...base,
    description: `${resolved.provider.provider.displayName} · ${resolved.model.displayName}`,
  };
}

export const CANVAS_ID = "canvas-scene-03";

/** 画布文档标题（仅用于 canvas_documents 表展示）。 */
export const CANVAS_DOCUMENT_TITLE = "未命名画布";

/** 画布状态变更后的自动保存防抖间隔。 */
export const CANVAS_SAVE_DEBOUNCE_MS = 1000;

/** 生成数量上限：供应商 API 无数量参数，数量 > 1 时前端拆分为多个独立任务（每个任务数量 1）。 */
export const MAX_GENERATION_COUNT = 4;

/** 解析生成数量输入：空值/非法值回落为 1，并钳制到 [1, MAX_GENERATION_COUNT]。 */
export function parseGenerationCountInput(raw: string): number {
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) return 1;
  return Math.min(MAX_GENERATION_COUNT, Math.max(1, parsed));
}

/** 提示词优化功能已从图片/视频生成节点移除，交由独立「提示词生成与优化」节点承担。 */
export interface ImageNodeConfig {
  readonly modelSelection: NodeModelSelection;
  readonly generationCount: number;
  readonly parameterValues: Readonly<Record<string, ModelParameterValue>>;
  readonly catalogResolved: boolean;
}

export interface VideoNodeConfig {
  readonly modelSelection: NodeModelSelection;
  readonly generationCount: number;
  readonly parameterValues: Readonly<Record<string, ModelParameterValue>>;
  readonly catalogResolved: boolean;
}

export type PromptNodeTask = "generate" | "optimize";

export type PromptConversationRole = "user" | "assistant" | "audit" | "decision";

export interface PromptConversationEntry {
  readonly id: string;
  readonly role: PromptConversationRole;
  readonly content: string;
}

/** 提示词节点的稳定配置：输入创意、文本模型、技能模式、多轮对话与最近一次输出均随画布保存。 */
export interface PromptNodeConfig {
  readonly modelSelection: NodeModelSelection;
  readonly task: PromptNodeTask;
  readonly mode: PromptOptimizationMode;
  /** 尚未发送的本轮输入草稿（随画布保存；多轮对话的输入框）。 */
  readonly sourcePrompt: string;
  /** 全部已完成轮次（你 / 提示词助手 / 审计 / 决定）；每次请求都会完整注入上一轮上下文。 */
  readonly conversation?: readonly PromptConversationEntry[];
  /** 当前可编辑输出（下发给下游节点）；应用审计结果后更新。 */
  readonly generatedPrompt: string;
  readonly catalogResolved: boolean;
  /** 兼容旧文档：旧版审计上下文在恢复时迁移进 conversation，此后不再写入。 */
  readonly auditContextHistory?: readonly PromptOptimizationContextEntry[];
}

export function promptConversationRoleLabel(role: PromptConversationRole): string {
  if (role === "user") return "你";
  if (role === "audit") return "审计";
  if (role === "decision") return "决定";
  return "提示词助手";
}

export function promptMessageId(): string {
  return `prompt-turn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 旧版审计上下文（角色为「第 N 轮审计输入/结果」「用户决定」）折叠为多轮对话条目。 */
function legacyAuditContextToConversation(
  history: readonly PromptOptimizationContextEntry[] | undefined,
): readonly PromptConversationEntry[] {
  if (!history?.length) return [];
  return history.map((entry) => {
    const role: PromptConversationRole = entry.role.includes("审计结果")
      ? "audit"
      : entry.role.includes("用户决定")
        ? "decision"
        : "user";
    return { id: promptMessageId(), role, content: entry.content };
  });
}

/** 补齐旧提示词节点配置缺失的多轮对话字段，并把旧版审计上下文迁移进 conversation。 */
export function migratePromptNodeConfig(config: PromptNodeConfig): PromptNodeConfig {
  if (config.conversation != null) return config;
  return { ...config, conversation: legacyAuditContextToConversation(config.auditContextHistory) };
}

export function createImageNodeConfig(
  modelSelection: NodeModelSelection,
  catalogResolved: boolean,
): ImageNodeConfig {
  return {
    modelSelection: { ...modelSelection },
    generationCount: 1,
    parameterValues: {},
    catalogResolved,
  };
}

export function createVideoNodeConfig(
  modelSelection: NodeModelSelection,
  catalogResolved: boolean,
): VideoNodeConfig {
  return {
    modelSelection: { ...modelSelection },
    generationCount: 1,
    parameterValues: {},
    catalogResolved,
  };
}

export function createPromptNodeConfig(
  modelSelection: NodeModelSelection,
  catalogResolved: boolean,
): PromptNodeConfig {
  return {
    modelSelection: { ...modelSelection },
    task: "generate",
    mode: "seedance_2_5",
    sourcePrompt: "",
    conversation: [],
    generatedPrompt: "",
    catalogResolved,
  };
}

export function createScreenplayNodeConfig(
  modelSelection: NodeModelSelection,
  catalogResolved: boolean,
): ScreenplayNodeConfig {
  return {
    modelSelection: { ...modelSelection },
    composer: "",
    conversation: [],
    currentDocument: "",
    materials: [],
    catalogResolved,
  };
}

export function createViralRemixNodeConfig(
  modelSelection: NodeModelSelection,
  catalogResolved: boolean,
): ViralRemixNodeConfig {
  return {
    modelSelection: { ...modelSelection },
    instructions: "",
    currentDocument: "",
    catalogResolved,
  };
}

/** 提示词优化/审计面板的运行时状态（会话内有效，完整审计上下文另存于提示词节点）。 */
export interface PromptOptimizationPanelState {
  /**
   * running = 优化进行中（此时生成按钮被禁用）；done = 展示对比结果；
   * error = 展示错误；idle = 已采用/放弃后的待命态（仅保留轮次与上下文）。
   */
  readonly status: "idle" | "running" | "done" | "error";
  /** 最近一次执行是否为细节优化/审计。 */
  readonly detail: boolean;
  /** 已完成的优化轮次（含失败前的进行中轮次）。 */
  readonly round: number;
  /** 最近一轮请求前的原提示词（diff 对比基线）。 */
  readonly originalPrompt: string;
  readonly optimizedPrompt: string | null;
  readonly error: string | null;
  /** 细节优化/审计时注入系统提示词的全部历史上下文。 */
  readonly contextHistory: readonly PromptOptimizationContextEntry[];
}

export const PROMPT_OPTIMIZATION_MODE_LABELS: Record<PromptOptimizationMode, string> = {
  seedance_2_0: "Seedance 2.0 专用",
  seedance_2_5: "Seedance 2.5 专用",
  wan_3_0: "万相 3.0 专用",
  minimax_h3: "MiniMax H3 专用",
  realistic_character: "人物真实感图片 专用",
};

/** 把提示词段序列（文本 + @引用）压成纯文本：引用内联为「@显示名」。 */
export const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "unknown",
  "interrupted",
]);

export const TASK_STATUS_LABELS: Record<string, string> = {
  created: "已创建",
  submitting: "提交中",
  retry_wait: "重试等待",
  queued: "排队中",
  running: "生成中",
  succeeded: "已成功",
  failed: "失败",
  unknown: "结果未知",
  interrupted: "已中断",
};

export const SAVE_STATUS_LABELS: Record<string, string> = {
  pending: "等待保存",
  writing: "正在写入",
  succeeded: "已保存到本机",
  failed: "保存失败",
  interrupted: "保存已中断",
  local_missing: "本地文件缺失",
  conflict: "文件冲突",
};

export interface RetryInfo {
  readonly retry: number;
  readonly maxRetries: number;
  readonly delayMs: number;
}

export function isTerminalTaskStatus(status: string): boolean {
  return TERMINAL_TASK_STATUSES.has(status);
}

export function isRunningTaskStatus(status: string): boolean {
  return (
    status === "created" || status === "submitting" || status === "queued" || status === "running"
  );
}

export function formatTaskClock(timestamp: number | null): string {
  if (timestamp == null) return "--:--";
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function shortenTaskId(taskId: string): string {
  return `${taskId.slice(0, 10)}…`;
}

export function fileBaseName(path: string | null): string | null {
  if (!path) return null;
  const normalized = path.replace(/[\\/]+/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  return segments.at(-1) ?? null;
}

export function modelDisplayNameForTask(
  task: GenerationTaskSummary,
  providerCatalog: readonly ProviderCatalogEntry[],
): string {
  const entry = providerCatalog.find((item) => item.provider.id === task.providerConnectionId);
  const model = entry?.models.find((item) => item.definitionId === task.modelDefinitionId);
  return model?.displayName ?? task.remoteModelIdSnapshot ?? task.modelDefinitionId;
}

export function formatTaskRawResponse(detail: {
  readonly calls: readonly ProviderCallRecord[];
  readonly finalError: unknown;
}): string | null {
  // 空字符串的 rawResponse 视为无响应体，需显式真值判断（?? 会把 "" 当作有效记录）。
  const call = [...detail.calls]
    .reverse()
    .find((item) => Boolean(item.rawResponse) || Boolean(item.runtimeError));
  if (call) {
    const lines: string[] = [];
    if (call.httpStatus != null) lines.push(`HTTP ${call.httpStatus}`);
    if (call.rawResponse) lines.push(call.rawResponse);
    if (call.runtimeError) lines.push(JSON.stringify(call.runtimeError, null, 2));
    const body = lines.join("\n\n");
    if (body.trim()) return body;
  }
  if (detail.finalError != null) {
    const body = JSON.stringify(detail.finalError, null, 2);
    if (body && body !== "null") return body;
  }
  return null;
}

export function cloudAssetToItem(asset: CloudAsset): AssetItem {
  const statusLabel = ASSET_CLOUD_STATUS_LABELS[asset.status];
  const meta =
    asset.status === "ready" ? (asset.assetUrl ?? asset.id) : `${statusLabel} · ${asset.rawStatus}`;
  return {
    id: asset.id,
    kind: asset.kind,
    name: asset.name,
    meta,
    visual: asset.kind === "audio" ? "ambience" : "portrait",
    previewUrl: asset.previewUrl,
    coverUrl: asset.coverUrl,
    // assetUrl may be an opaque asset:// reference; only the signed preview URL is playable.
    videoUrl: asset.kind === "video" ? asset.previewUrl : null,
    cloudStatus: asset.status,
    source: "cloud",
    providerConnectionId: asset.providerConnectionId,
  };
}

export function localAssetToItem(asset: LocalAssetRecord): AssetItem {
  return {
    id: asset.id,
    kind: asset.mediaType,
    name: asset.name,
    meta: `${formatBytes(asset.byteSize) ?? "对象存储"} · 本地索引`,
    visual: asset.mediaType === "audio" ? "ambience" : "portrait",
    previewUrl: asset.previewUrl,
    videoUrl: asset.mediaType === "video" ? asset.previewUrl : null,
    source: "local",
  };
}

export function assetNodeReferenceTarget(node: AssetNodeData): MediaReferenceTarget {
  if (node.source === "local") {
    return {
      kind: "local_asset",
      stagingJobId: node.assetId,
      canvasNodeKey: node.key,
      mediaType: node.kind,
    };
  }
  return {
    kind: "asset",
    providerConnectionId: node.providerConnectionId,
    assetId: node.assetId,
    canvasNodeKey: node.key,
    mediaType: node.kind,
  };
}

/**
 * 已保存的生成产物可直接作为下一节点的 local_result 媒体引用。
 * 合成节点产物不是 generation task 的结果，仍只用于视频拼接输入。
 */
export function outputNodeReferenceTarget(node: OutputNodeData): MediaReferenceTarget | null {
  // 合成与下载产物不是 generation task 的结果，无法通过 local_result 校验，
  // 只能作为视频拼接输入（下载产物同样是普通本地文件）。
  if (
    node.origin === "composition" ||
    node.origin === "download" ||
    node.finalPath == null ||
    node.resultKey == null
  ) {
    return null;
  }
  const resultKeyPrefix = `${node.taskId}#`;
  if (!node.resultKey.startsWith(resultKeyPrefix)) return null;
  const resultIndex = Number.parseInt(node.resultKey.slice(resultKeyPrefix.length), 10);
  if (!Number.isInteger(resultIndex) || resultIndex < 0) return null;
  return {
    kind: "local_result",
    generationTaskId: node.taskId,
    resultIndex,
    canvasNodeKey: node.key,
    mediaType: node.mediaType,
  };
}

export function assetGenerationInput(node: AssetNodeData): GenerationMediaInput {
  return {
    key: node.key,
    name: node.name,
    kind: node.kind,
    target: assetNodeReferenceTarget(node),
    previewUrl: node.previewUrl ?? null,
  };
}

export function outputGenerationInput(node: OutputNodeData): GenerationMediaInput | null {
  const target = outputNodeReferenceTarget(node);
  if (target == null) return null;
  return {
    key: node.key,
    name: node.name ?? `${node.mediaType === "image" ? "图片" : "视频"}产物`,
    kind: node.mediaType,
    target,
    previewUrl: node.finalPath != null ? toMediaSrc(node.finalPath) : (node.previewSrc ?? null),
  };
}

/** @ 引用候选：来自画布素材节点（优先，已连线）或素材库。 */
export interface MentionCandidate {
  /** 当前生成节点已连线的画布素材实例 key。 */
  readonly canvasNodeKey: string;
  readonly assetId: string;
  readonly providerConnectionId: string;
  readonly source?: AssetLibrarySource;
  readonly referenceKind?: MediaReferenceTarget["kind"];
  readonly generationTaskId?: string;
  readonly resultIndex?: number;
  readonly kind: AssetKind;
  readonly name: string;
  /** @ 下拉候选缩略图源（可能为 null，渲染端需兜底到类型图标）。 */
  readonly previewUrl?: string | null;
}

export function generationInputMentionCandidate(input: GenerationMediaInput): MentionCandidate {
  const target = input.target;
  if (target.kind === "local_result") {
    return {
      canvasNodeKey: input.key,
      assetId: `${target.generationTaskId}#${target.resultIndex}`,
      providerConnectionId: "",
      referenceKind: target.kind,
      generationTaskId: target.generationTaskId,
      resultIndex: target.resultIndex,
      kind: input.kind,
      name: input.name,
      previewUrl: input.previewUrl ?? null,
    };
  }
  if (target.kind === "local_asset") {
    return {
      canvasNodeKey: input.key,
      assetId: target.stagingJobId,
      providerConnectionId: "",
      source: "local",
      referenceKind: target.kind,
      kind: input.kind,
      name: input.name,
      previewUrl: input.previewUrl ?? null,
    };
  }
  return {
    canvasNodeKey: input.key,
    assetId: target.assetId,
    providerConnectionId: target.providerConnectionId,
    source: "cloud",
    referenceKind: target.kind,
    kind: input.kind,
    name: input.name,
    previewUrl: input.previewUrl ?? null,
  };
}

export function supportsGenerationNode(model: ConfiguredModel, nodeId: GenerationNodeId): boolean {
  return nodeId === "video" ? isVideoGenerationModel(model) : isImageGenerationModel(model);
}

export function isImageGenerationModel(model: ConfiguredModel): boolean {
  return model.operations.includes("text_to_image") || model.operations.includes("image_to_image");
}

export function isVideoGenerationModel(model: ConfiguredModel): boolean {
  return model.operations.includes("video_generation");
}

/** 文本（对话）模型：在全局设置里被分类为「文本模型」的模型，供提示词优化等功能使用。 */
export function isTextGenerationModel(model: ConfiguredModel): boolean {
  return model.operations.includes("text_generation");
}

/** 解析当前可用的第一个文本模型（供应商优先、模型次之），供文本功能自动回退。 */
export function firstTextModelSelection(providerCatalog: readonly ProviderCatalogEntry[]): {
  providerId: string;
  modelDefinitionId: string;
} {
  for (const entry of providerCatalog) {
    if (!entry.provider.enabled) continue;
    const model = entry.models.find(isTextGenerationModel);
    if (model) {
      return { providerId: entry.provider.id, modelDefinitionId: model.definitionId };
    }
  }
  return { providerId: "", modelDefinitionId: "" };
}

export function resolveGenerationSelection(
  nodeId: GenerationNodeId,
  selection: NodeModelSelection,
  providerCatalog: readonly ProviderCatalogEntry[],
) {
  const provider = providerCatalog.find(
    (entry) => entry.provider.enabled && entry.provider.id === selection.providerId,
  );
  const model = provider?.models.find(
    (item) =>
      item.definitionId === selection.modelDefinitionId && supportsGenerationNode(item, nodeId),
  );
  return provider && model ? { provider, model } : null;
}

export function reconcileNodeModelSelection(
  nodeId: GenerationNodeId,
  current: NodeModelSelection,
  providerCatalog: readonly ProviderCatalogEntry[],
  operation?: GenerationOperation,
): NodeModelSelection {
  const supportsCurrentOperation = (model: ConfiguredModel) =>
    operation == null
      ? supportsGenerationNode(model, nodeId)
      : model.operations.includes(operation);
  const currentProvider = providerCatalog.find(
    (entry) => entry.provider.enabled && entry.provider.id === current.providerId,
  );
  if (
    currentProvider?.models.some(
      (model) =>
        model.definitionId === current.modelDefinitionId && supportsCurrentOperation(model),
    )
  ) {
    return current;
  }

  const fallbackProvider = providerCatalog.find(
    (entry) => entry.provider.enabled && entry.models.some(supportsCurrentOperation),
  );
  const fallbackModel = fallbackProvider?.models.find(supportsCurrentOperation);
  return {
    providerId: fallbackProvider?.provider.id ?? "",
    modelDefinitionId: fallbackModel?.definitionId ?? "",
  };
}

export function reconcileNodeModelSelections(
  current: NodeModelSelections,
  providerCatalog: readonly ProviderCatalogEntry[],
): NodeModelSelections {
  return {
    image: reconcileNodeModelSelection("image", current.image, providerCatalog, "text_to_image"),
    video: reconcileNodeModelSelection("video", current.video, providerCatalog, "video_generation"),
    prompt: reconcileTextModelSelection(current.prompt, providerCatalog),
  };
}

export function reconcileTextModelSelection(
  current: NodeModelSelection,
  providerCatalog: readonly ProviderCatalogEntry[],
): NodeModelSelection {
  const currentProvider = providerCatalog.find(
    (entry) => entry.provider.enabled && entry.provider.id === current.providerId,
  );
  if (
    currentProvider?.models.some(
      (model) => model.definitionId === current.modelDefinitionId && isTextGenerationModel(model),
    )
  ) {
    return current;
  }
  const fallback = firstTextModelSelection(providerCatalog);
  return fallback;
}

export function resolvePendingGenerationNodeConfig(
  node: GenNodeData,
  providerCatalog: readonly ProviderCatalogEntry[],
  mediaInputTargetKeys: ReadonlySet<string>,
): GenNodeData {
  if (node.config.catalogResolved) return node;
  if (node.kind === "prompt") {
    // 先补齐旧文档缺失的多轮对话字段（旧版审计上下文迁移进 conversation），再校准模型选择。
    const migrated = migratePromptNodeConfig(node.config);
    return {
      ...node,
      config: {
        ...migrated,
        modelSelection: reconcileTextModelSelection(migrated.modelSelection, providerCatalog),
        catalogResolved: true,
      },
    };
  }
  if (node.kind === "image") {
    return {
      ...node,
      config: {
        ...node.config,
        modelSelection: reconcileNodeModelSelection(
          "image",
          node.config.modelSelection,
          providerCatalog,
          mediaInputTargetKeys.has(node.key) ? "image_to_image" : "text_to_image",
        ),
        catalogResolved: true,
      },
    };
  }
  return {
    ...node,
    config: {
      ...node.config,
      modelSelection: reconcileNodeModelSelection(
        "video",
        node.config.modelSelection,
        providerCatalog,
        "video_generation",
      ),
      catalogResolved: true,
    },
  };
}

export function resolvePendingDocumentNodeConfig<T extends DocumentSkillNodeData>(
  node: T,
  providerCatalog: readonly ProviderCatalogEntry[],
): T {
  return node.config.catalogResolved
    ? node
    : {
        ...node,
        config: {
          ...node.config,
          modelSelection: reconcileTextModelSelection(node.config.modelSelection, providerCatalog),
          catalogResolved: true,
        },
      };
}
