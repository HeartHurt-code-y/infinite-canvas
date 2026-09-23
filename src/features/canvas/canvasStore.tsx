import { createContext, createElement, useContext, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { temporal, type TemporalState } from "zundo";
import {
  initializeWorkflowVersions,
  mergeWorkflowVersionHistory,
  recordWorkflowVersion,
} from "../workspace/workflowVersionHistory";
import { decodePromptContentDocument, type PromptContentDocumentV1 } from "../../lib/promptContent";
import {
  applyNewEdgesToGenerationInputSlots,
  adoptMissingGenerationInputSlots,
  assignGenerationInputSlot,
  generationSourceOccupiesInputSlot,
  isGenerationMediaConsumer,
  occupyingGenerationInputKeys,
  reorderGenerationInputSlots,
  withGenerationInputSlots,
} from "./generationInputSlots";
import type {
  AssetEdgeData,
  AssetNodeData,
  GenNodeData,
  KnowledgeVideoWorkflowConfig,
  KnowledgeVideoWorkflowNodeData,
  OutputNodeData,
  ResultNodeData,
  ScreenplayNodeData,
  StoryboardNodeData,
  VideoComposerNodeData,
  VideoDownloaderNodeData,
  VideoFrameExtractorNodeData,
  ViralRemixNodeData,
} from "../workspace/workspaceModel";

export interface CanvasPan {
  readonly x: number;
  readonly y: number;
}

export interface CanvasNodeSize {
  readonly width: number;
  readonly height: number;
}

/** React Flow 高频变化进入画布状态前使用的最小、可批处理表示。 */
export type CanvasStoreNodeChange =
  | { readonly type: "position"; readonly key: string; readonly position: CanvasPan }
  | { readonly type: "dimensions"; readonly key: string; readonly measured: CanvasNodeSize }
  | { readonly type: "select"; readonly key: string; readonly selected: boolean };

/**
 * 画布九类节点的类型标签，即 nodesById 内每个条目的判别字段。
 * 标签沿用旧版九组平行数组的集合名；gen 一类内部仍以 data.kind 区分图片/视频/提示词。
 */
export type CanvasNodeType =
  | "asset"
  | "gen"
  | "screenplay"
  | "storyboard"
  | "knowledgeVideoWorkflow"
  | "viralRemix"
  | "videoComposer"
  | "videoDownloader"
  | "frameExtractor"
  | "result"
  | "output";

/** 类型标签 → 节点数据类型。 */
export interface CanvasNodesByType {
  asset: AssetNodeData;
  gen: GenNodeData;
  screenplay: ScreenplayNodeData;
  storyboard: StoryboardNodeData;
  knowledgeVideoWorkflow: KnowledgeVideoWorkflowNodeData;
  viralRemix: ViralRemixNodeData;
  videoComposer: VideoComposerNodeData;
  videoDownloader: VideoDownloaderNodeData;
  frameExtractor: VideoFrameExtractorNodeData;
  result: ResultNodeData;
  output: OutputNodeData;
}

/** nodesById 中的单条节点：type 与 data 一一对应，读取时可按 type 收窄。 */
export type CanvasNodeEntry = {
  readonly [K in CanvasNodeType]: {
    readonly type: K;
    readonly data: CanvasNodesByType[K];
  };
}[CanvasNodeType];

/** 画布全部节点的唯一存储：key → 节点条目。九类节点不再各自持有平行数组。 */
export type CanvasNodesById = Readonly<Record<string, CanvasNodeEntry>>;

/** 节点数据的只读联合；按类型操作时经由 CanvasNodesByType 收窄。 */
export type CanvasNodeData = CanvasNodeEntry["data"];

/** 画布文档 V1：持久化 I/O 留给调用方，module 只负责纯快照与恢复。 */
export interface CanvasDocumentV1 {
  readonly version: 1;
  readonly assetNodes: readonly AssetNodeData[];
  readonly genNodes: readonly GenNodeData[];
  readonly screenplayNodes?: readonly ScreenplayNodeData[];
  readonly storyboardNodes?: readonly StoryboardNodeData[];
  readonly knowledgeVideoWorkflowNodes?: readonly KnowledgeVideoWorkflowNodeData[];
  readonly viralRemixNodes?: readonly ViralRemixNodeData[];
  readonly videoComposerNodes?: readonly VideoComposerNodeData[];
  readonly videoDownloaderNodes?: readonly VideoDownloaderNodeData[];
  readonly frameExtractorNodes?: readonly VideoFrameExtractorNodeData[];
  readonly resultNodes: readonly ResultNodeData[];
  readonly outputNodes?: readonly Omit<OutputNodeData, "previewSrc">[];
  readonly assetEdges: readonly AssetEdgeData[];
  readonly view: {
    readonly zoom: number;
    readonly pan: CanvasPan;
  };
  readonly prompts: Readonly<Record<string, string>>;
}

/** V2 不再持久化浏览器 HTML；提示内容使用可验证的 canonical document。 */
export interface CanvasDocumentV2 {
  readonly version: 2;
  readonly assetNodes: readonly AssetNodeData[];
  readonly genNodes: readonly GenNodeData[];
  readonly screenplayNodes?: readonly ScreenplayNodeData[];
  readonly storyboardNodes?: readonly StoryboardNodeData[];
  readonly knowledgeVideoWorkflowNodes?: readonly KnowledgeVideoWorkflowNodeData[];
  readonly viralRemixNodes?: readonly ViralRemixNodeData[];
  readonly videoComposerNodes?: readonly VideoComposerNodeData[];
  readonly videoDownloaderNodes?: readonly VideoDownloaderNodeData[];
  readonly frameExtractorNodes?: readonly VideoFrameExtractorNodeData[];
  readonly resultNodes: readonly ResultNodeData[];
  readonly outputNodes?: readonly Omit<OutputNodeData, "previewSrc">[];
  readonly assetEdges: readonly AssetEdgeData[];
  readonly view: {
    readonly zoom: number;
    readonly pan: CanvasPan;
  };
  readonly promptContents: Readonly<Record<string, PromptContentDocumentV1>>;
}

export type CanvasDocument = CanvasDocumentV1 | CanvasDocumentV2;
export type PersistedPromptContent = PromptContentDocumentV1 | string;

export interface CanvasNodeLists {
  readonly asset: readonly AssetNodeData[];
  readonly gen: readonly GenNodeData[];
  readonly screenplay: readonly ScreenplayNodeData[];
  readonly storyboard: readonly StoryboardNodeData[];
  readonly knowledgeVideoWorkflow: readonly KnowledgeVideoWorkflowNodeData[];
  readonly viralRemix: readonly ViralRemixNodeData[];
  readonly videoComposer: readonly VideoComposerNodeData[];
  readonly videoDownloader: readonly VideoDownloaderNodeData[];
  readonly frameExtractor: readonly VideoFrameExtractorNodeData[];
  readonly result: readonly ResultNodeData[];
  readonly output: readonly OutputNodeData[];
}

export interface CanvasNodesByKey {
  readonly asset: ReadonlyMap<string, AssetNodeData>;
  readonly gen: ReadonlyMap<string, GenNodeData>;
  readonly screenplay: ReadonlyMap<string, ScreenplayNodeData>;
  readonly storyboard: ReadonlyMap<string, StoryboardNodeData>;
  readonly knowledgeVideoWorkflow: ReadonlyMap<string, KnowledgeVideoWorkflowNodeData>;
  readonly viralRemix: ReadonlyMap<string, ViralRemixNodeData>;
  readonly videoComposer: ReadonlyMap<string, VideoComposerNodeData>;
  readonly videoDownloader: ReadonlyMap<string, VideoDownloaderNodeData>;
  readonly frameExtractor: ReadonlyMap<string, VideoFrameExtractorNodeData>;
  readonly result: ReadonlyMap<string, ResultNodeData>;
  readonly output: ReadonlyMap<string, OutputNodeData>;
}

export interface CanvasGraphReadModel {
  readonly edges: readonly AssetEdgeData[];
  readonly countByNode: ReadonlyMap<string, number>;
  readonly byTarget: ReadonlyMap<string, readonly AssetEdgeData[]>;
}

export interface CanvasReadModel {
  readonly nodes: CanvasNodeLists;
  /** 连线语义索引；布局变化时引用保持稳定，不应用它读取最新 x/y/measured。 */
  readonly nodeByKey: CanvasNodesByKey;
  readonly graph: CanvasGraphReadModel;
  readonly view: { readonly zoom: number; readonly pan: CanvasPan };
  readonly selection: { readonly nodeKey: string | null; readonly edgeId: string | null };
  readonly hasNodes: boolean;
}

export type CanvasWriteResult = "applied" | "unchanged" | "missing";

export type CanvasConnectResult =
  | {
      readonly status: "connected";
      readonly edge: AssetEdgeData;
      readonly replacedEdgeIds: readonly string[];
    }
  | { readonly status: "unchanged"; readonly edgeId: string }
  | {
      readonly status: "rejected";
      readonly reason: "same-node" | "missing-source" | "missing-target" | "unsupported-connection";
    };

export type CanvasRestoreResult =
  | {
      readonly ok: true;
      readonly promptContents: Readonly<Record<string, PersistedPromptContent>>;
      readonly view: CanvasReadModel["view"];
      readonly warnings: readonly string[];
    }
  | {
      readonly ok: false;
      readonly reason: "unsupported-version" | "invalid-document";
      readonly issues: readonly string[];
    };

export interface CanvasHistorySummary {
  readonly pastCount: number;
  readonly futureCount: number;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

export interface CanvasCommands {
  readonly insertSubgraph: (
    nodes: readonly CanvasNodeEntry[],
    edges: readonly AssetEdgeData[],
    options?: { readonly selectNodeKey?: string | null },
  ) => CanvasWriteResult;
  readonly addNode: <K extends CanvasNodeType>(
    type: K,
    node:
      CanvasNodesByType[K] | ((siblings: readonly CanvasNodesByType[K][]) => CanvasNodesByType[K]),
    options?: { readonly select?: boolean },
  ) => CanvasNodesByType[K];
  readonly addOutput: (
    node: OutputNodeData | ((outputs: readonly OutputNodeData[]) => OutputNodeData),
  ) => OutputNodeData;
  readonly patchNode: <K extends CanvasNodeType>(
    type: K,
    key: string,
    update: (node: CanvasNodesByType[K]) => CanvasNodesByType[K],
  ) => CanvasWriteResult;
  readonly patchNodes: <K extends CanvasNodeType>(
    type: K,
    update: (node: CanvasNodesByType[K]) => CanvasNodesByType[K],
  ) => number;
  readonly removeNode: (key: string) => CanvasNodeEntry | null;
  readonly connect: (fromKey: string, toKey: string) => CanvasConnectResult;
  readonly disconnect: (edgeId: string) => CanvasWriteResult;
  readonly reorderGenerationInput: (
    nodeKey: string,
    sourceKey: string,
    targetKey: string,
  ) => CanvasWriteResult;
  readonly applyNodeChanges: (changes: readonly CanvasStoreNodeChange[]) => CanvasWriteResult;
  readonly setView: (view: {
    readonly zoom?: number;
    readonly pan?: CanvasPan;
  }) => CanvasWriteResult;
  readonly selectNode: (key: string | null) => CanvasWriteResult;
  readonly selectEdge: (edgeId: string | null) => CanvasWriteResult;
  readonly clear: () => readonly CanvasNodeEntry[];
  readonly snapshotV2: (
    promptContents: Readonly<Record<string, PromptContentDocumentV1>>,
  ) => CanvasDocumentV2;
  readonly restoreDocument: (document: unknown) => CanvasRestoreResult;
  readonly undo: (protectedWorkflowKeys?: ReadonlySet<string>) => CanvasWriteResult;
  readonly redo: (protectedWorkflowKeys?: ReadonlySet<string>) => CanvasWriteResult;
}

/** Zustand/zundo 细节不越过此 interface。 */
export interface CanvasStateModule {
  readonly commands: CanvasCommands;
  readonly getSnapshot: () => CanvasReadModel;
  readonly getHistory: () => CanvasHistorySummary;
  readonly subscribe: (listener: () => void) => () => void;
}

interface CanvasStoreState {
  readonly nodesById: CanvasNodesById;
  readonly assetEdges: readonly AssetEdgeData[];
  readonly zoom: number;
  readonly pan: CanvasPan;
  readonly selectedNodeKey: string | null;
  readonly selectedEdgeId: string | null;
  readonly insertSubgraph: (
    nodes: readonly CanvasNodeEntry[],
    edges: readonly AssetEdgeData[],
    options?: { readonly selectNodeKey?: string | null },
  ) => CanvasWriteResult;
  readonly addNode: <K extends CanvasNodeType>(
    type: K,
    node:
      CanvasNodesByType[K] | ((siblings: readonly CanvasNodesByType[K][]) => CanvasNodesByType[K]),
    options?: { readonly select?: boolean },
  ) => CanvasNodesByType[K];
  readonly addOutput: (
    node: OutputNodeData | ((outputs: readonly OutputNodeData[]) => OutputNodeData),
  ) => OutputNodeData;
  readonly patchNode: <K extends CanvasNodeType>(
    type: K,
    key: string,
    update: (node: CanvasNodesByType[K]) => CanvasNodesByType[K],
  ) => CanvasWriteResult;
  readonly patchNodes: <K extends CanvasNodeType>(
    type: K,
    update: (node: CanvasNodesByType[K]) => CanvasNodesByType[K],
  ) => number;
  readonly removeNode: (key: string) => CanvasNodeEntry | null;
  readonly connect: (fromKey: string, toKey: string) => CanvasConnectResult;
  readonly disconnect: (edgeId: string) => CanvasWriteResult;
  readonly reorderGenerationInput: (
    nodeKey: string,
    sourceKey: string,
    targetKey: string,
  ) => CanvasWriteResult;
  readonly clear: () => readonly CanvasNodeEntry[];
  /** 一次 Zustand transaction 应用一批 React Flow 位置、尺寸与选择变化。 */
  readonly applyNodeChanges: (changes: readonly CanvasStoreNodeChange[]) => CanvasWriteResult;
  readonly setView: (view: {
    readonly zoom?: number;
    readonly pan?: CanvasPan;
  }) => CanvasWriteResult;
  readonly selectNode: (key: string | null) => CanvasWriteResult;
  readonly selectEdge: (edgeId: string | null) => CanvasWriteResult;
  readonly restoreDocument: (document: unknown) => CanvasRestoreResult;
  /** 撤销上一次画布操作（节点/连线写入）；历史为空时是安全的空操作。 */
  readonly undo: () => CanvasWriteResult;
  /** 重做上一次被撤销的操作；无可重做时是安全的空操作。 */
  readonly redo: () => CanvasWriteResult;
}

/** 撤销/重做跟踪的状态切片：仅节点与连线；zoom/pan/选中态属于视图，不参与历史。 */
type CanvasHistoryState = Pick<CanvasStoreState, "nodesById" | "assetEdges">;

/** 画布 store：主状态外挂 zundo temporal 历史 store。 */
interface CanvasStore extends StoreApi<CanvasStoreState> {
  readonly temporal: StoreApi<TemporalState<CanvasHistoryState>>;
}

/**
 * 按类型收集节点数组。结果按 nodesById 引用缓存：map 不变时返回同一数组引用，
 * 让按类型订阅的组件在无关节点变化时保持跳过渲染。
 */
interface CanvasNodeProjectionCache {
  readonly byType: ReadonlyMap<CanvasNodeType, readonly CanvasNodeData[]>;
  readonly indexByKey: ReadonlyMap<
    string,
    { readonly type: CanvasNodeType; readonly index: number }
  >;
}

const CANVAS_NODE_TYPES: readonly CanvasNodeType[] = [
  "asset",
  "gen",
  "screenplay",
  "storyboard",
  "knowledgeVideoWorkflow",
  "viralRemix",
  "videoComposer",
  "videoDownloader",
  "frameExtractor",
  "result",
  "output",
];

const nodeProjectionCache = new WeakMap<CanvasNodesById, CanvasNodeProjectionCache>();

interface CanvasConnectionProjectionCache {
  readonly byType: ReadonlyMap<CanvasNodeType, ReadonlyMap<string, CanvasNodeData>>;
}

const connectionProjectionCache = new WeakMap<CanvasNodesById, CanvasConnectionProjectionCache>();

/** 只比较连线派生会读取的字段；x/y/measured 不属于连线语义。 */
function sameConnectionData(
  type: CanvasNodeType,
  previous: CanvasNodeData,
  next: CanvasNodeData,
): boolean {
  if (type === "asset") {
    const first = previous as AssetNodeData;
    const second = next as AssetNodeData;
    return (
      first.assetId === second.assetId &&
      first.providerConnectionId === second.providerConnectionId &&
      first.source === second.source &&
      first.kind === second.kind &&
      first.name === second.name &&
      first.previewUrl === second.previewUrl &&
      first.videoUrl === second.videoUrl &&
      first.libraryPickOrder === second.libraryPickOrder &&
      first.assetGroupId === second.assetGroupId
    );
  }
  if (type === "output") {
    const first = previous as OutputNodeData;
    const second = next as OutputNodeData;
    return (
      first.resultKey === second.resultKey &&
      first.sourceNodeId === second.sourceNodeId &&
      first.taskId === second.taskId &&
      first.mediaType === second.mediaType &&
      first.origin === second.origin &&
      first.finalPath === second.finalPath &&
      first.previewSrc === second.previewSrc &&
      first.name === second.name &&
      first.textContent === second.textContent &&
      first.libraryPickOrder === second.libraryPickOrder &&
      first.assetGroupId === second.assetGroupId
    );
  }
  if (type === "gen") {
    const first = previous as GenNodeData;
    const second = next as GenNodeData;
    return first.kind === second.kind && first.config === second.config;
  }
  if (type === "screenplay" || type === "storyboard" || type === "viralRemix") {
    const first = previous as ScreenplayNodeData;
    const second = next as ScreenplayNodeData;
    return first.config.currentDocument === second.config.currentDocument;
  }
  if (type === "videoComposer") {
    const first = previous as VideoComposerNodeData;
    const second = next as VideoComposerNodeData;
    return first.config.inputOrder === second.config.inputOrder;
  }
  if (type === "knowledgeVideoWorkflow") {
    return (
      (previous as KnowledgeVideoWorkflowNodeData).config ===
      (next as KnowledgeVideoWorkflowNodeData).config
    );
  }
  // 其余节点的自有连线载荷仅取自独立保存的产物。
  return true;
}

function connectionProjection(nodesById: CanvasNodesById): CanvasConnectionProjectionCache {
  const cached = connectionProjectionCache.get(nodesById);
  if (cached != null) return cached;

  const byType = new Map<CanvasNodeType, Map<string, CanvasNodeData>>(
    CANVAS_NODE_TYPES.map((type) => [type, new Map()]),
  );
  for (const [key, entry] of Object.entries(nodesById)) {
    byType.get(entry.type)!.set(key, entry.data);
  }
  const projection = { byType };
  connectionProjectionCache.set(nodesById, projection);
  return projection;
}

/**
 * 连线派生专用 key 索引。布局字段变化时复用 Map，避免节点拖拽触发全量边重算。
 * Map 中的节点对象只保证连线语义字段为最新值，不应用于读取坐标或实测尺寸。
 */
function connectionTypeNodesByKey<K extends CanvasNodeType>(
  nodesById: CanvasNodesById,
  type: K,
): ReadonlyMap<string, CanvasNodesByType[K]> {
  return connectionProjection(nodesById).byType.get(type)! as unknown as ReadonlyMap<
    string,
    CanvasNodesByType[K]
  >;
}

/** 单次遍历建立全部节点族视图；之后的节点动作会增量继承未变化视图。 */
function nodeProjection(nodesById: CanvasNodesById): CanvasNodeProjectionCache {
  const cached = nodeProjectionCache.get(nodesById);
  if (cached != null) return cached;

  const byType = new Map<CanvasNodeType, CanvasNodeData[]>(
    CANVAS_NODE_TYPES.map((type) => [type, []]),
  );
  const indexByKey = new Map<string, { type: CanvasNodeType; index: number }>();
  for (const [key, entry] of Object.entries(nodesById)) {
    const nodes = byType.get(entry.type)!;
    indexByKey.set(key, { type: entry.type, index: nodes.length });
    nodes.push(entry.data);
  }
  const projection = { byType, indexByKey };
  nodeProjectionCache.set(nodesById, projection);
  return projection;
}

function typeNodes<K extends CanvasNodeType>(
  nodesById: CanvasNodesById,
  type: K,
): readonly CanvasNodesByType[K][] {
  // 条目的 type 与 data 由 store 动作成对写入，按 K 收窄是安全的；
  // TS 无法验证泛型 K 与联合元素的相关性，需经 unknown 桥接。
  return nodeProjection(nodesById).byType.get(type)! as unknown as readonly CanvasNodesByType[K][];
}

const nodeListsCache = new WeakMap<CanvasNodesById, CanvasNodeLists>();

function canvasNodeLists(nodesById: CanvasNodesById): CanvasNodeLists {
  const cached = nodeListsCache.get(nodesById);
  if (cached != null) return cached;
  const lists: CanvasNodeLists = {
    asset: typeNodes(nodesById, "asset"),
    gen: typeNodes(nodesById, "gen"),
    screenplay: typeNodes(nodesById, "screenplay"),
    storyboard: typeNodes(nodesById, "storyboard"),
    knowledgeVideoWorkflow: typeNodes(nodesById, "knowledgeVideoWorkflow"),
    viralRemix: typeNodes(nodesById, "viralRemix"),
    videoComposer: typeNodes(nodesById, "videoComposer"),
    videoDownloader: typeNodes(nodesById, "videoDownloader"),
    frameExtractor: typeNodes(nodesById, "frameExtractor"),
    result: typeNodes(nodesById, "result"),
    output: typeNodes(nodesById, "output"),
  };
  nodeListsCache.set(nodesById, lists);
  return lists;
}

const nodesByKeyReadCache = new WeakMap<CanvasConnectionProjectionCache, CanvasNodesByKey>();

function canvasNodesByKey(nodesById: CanvasNodesById): CanvasNodesByKey {
  // The wrapper is also semantic state: pointer movement must not invalidate graph resolvers
  // that consume all families together while each family map remains unchanged.
  const projection = connectionProjection(nodesById);
  const cached = nodesByKeyReadCache.get(projection);
  if (cached != null) return cached;
  const byKey: CanvasNodesByKey = {
    asset: connectionTypeNodesByKey(nodesById, "asset"),
    gen: connectionTypeNodesByKey(nodesById, "gen"),
    screenplay: connectionTypeNodesByKey(nodesById, "screenplay"),
    storyboard: connectionTypeNodesByKey(nodesById, "storyboard"),
    knowledgeVideoWorkflow: connectionTypeNodesByKey(nodesById, "knowledgeVideoWorkflow"),
    viralRemix: connectionTypeNodesByKey(nodesById, "viralRemix"),
    videoComposer: connectionTypeNodesByKey(nodesById, "videoComposer"),
    videoDownloader: connectionTypeNodesByKey(nodesById, "videoDownloader"),
    frameExtractor: connectionTypeNodesByKey(nodesById, "frameExtractor"),
    result: connectionTypeNodesByKey(nodesById, "result"),
    output: connectionTypeNodesByKey(nodesById, "output"),
  };
  nodesByKeyReadCache.set(projection, byKey);
  return byKey;
}

const graphReadCache = new WeakMap<readonly AssetEdgeData[], CanvasGraphReadModel>();

function canvasGraph(edges: readonly AssetEdgeData[]): CanvasGraphReadModel {
  const cached = graphReadCache.get(edges);
  if (cached != null) return cached;
  const countByNode = new Map<string, number>();
  const byTarget = new Map<string, AssetEdgeData[]>();
  for (const edge of edges) {
    countByNode.set(edge.fromKey, (countByNode.get(edge.fromKey) ?? 0) + 1);
    if (edge.toKey !== edge.fromKey) {
      countByNode.set(edge.toKey, (countByNode.get(edge.toKey) ?? 0) + 1);
    }
    const incoming = byTarget.get(edge.toKey);
    if (incoming == null) byTarget.set(edge.toKey, [edge]);
    else incoming.push(edge);
  }
  const graph = { edges, countByNode, byTarget };
  graphReadCache.set(edges, graph);
  return graph;
}

const readModelCache = new WeakMap<CanvasStoreState, CanvasReadModel>();

function canvasReadModel(state: CanvasStoreState): CanvasReadModel {
  const cached = readModelCache.get(state);
  if (cached != null) return cached;
  const model: CanvasReadModel = {
    nodes: canvasNodeLists(state.nodesById),
    nodeByKey: canvasNodesByKey(state.nodesById),
    graph: canvasGraph(state.assetEdges),
    view: { zoom: state.zoom, pan: state.pan },
    selection: { nodeKey: state.selectedNodeKey, edgeId: state.selectedEdgeId },
    hasNodes: Object.keys(state.nodesById).length > 0,
  };
  readModelCache.set(state, model);
  return model;
}

function cacheConnectionTypeReplacement(
  previousNodesById: CanvasNodesById,
  nextNodesById: CanvasNodesById,
  type: CanvasNodeType,
  nextNodes: readonly CanvasNodeData[],
): void {
  const previous = connectionProjection(previousNodesById);
  const previousByKey = previous.byType.get(type)!;
  const previousKeys = previousByKey.keys();
  const nextByKey = new Map<string, CanvasNodeData>();
  let changed = previousByKey.size !== nextNodes.length;

  for (const node of nextNodes) {
    if (previousKeys.next().value !== node.key) changed = true;
    const previousNode = previousByKey.get(node.key);
    const stableNode =
      previousNode != null && sameConnectionData(type, previousNode, node) ? previousNode : node;
    if (stableNode !== previousNode) changed = true;
    nextByKey.set(node.key, stableNode);
  }

  if (!changed) {
    connectionProjectionCache.set(nextNodesById, previous);
    return;
  }
  const byType = new Map(previous.byType);
  byType.set(type, nextByKey);
  connectionProjectionCache.set(nextNodesById, { byType });
}

/** 类型整体替换时只重建该类型的视图，其余八类继续复用原数组。 */
function cacheTypeReplacement(
  previousNodesById: CanvasNodesById,
  nextNodesById: CanvasNodesById,
  type: CanvasNodeType,
  nextNodes: readonly CanvasNodeData[],
): void {
  const previous = nodeProjection(previousNodesById);
  const byType = new Map(previous.byType);
  byType.set(type, nextNodes);

  const indexByKey = new Map(previous.indexByKey);
  for (const [key, location] of previous.indexByKey) {
    if (location.type === type) indexByKey.delete(key);
  }
  nextNodes.forEach((node, index) => indexByKey.set(node.key, { type, index }));
  nodeProjectionCache.set(nextNodesById, { byType, indexByKey });
  cacheConnectionTypeReplacement(previousNodesById, nextNodesById, type, nextNodes);
}

/** 位置/尺寸变化不会改变节点族顺序；每个受影响的族只复制一次数组。 */
function cacheNodeDataChanges(
  previousNodesById: CanvasNodesById,
  nextNodesById: CanvasNodesById,
  changedEntries: ReadonlyMap<string, CanvasNodeEntry>,
): void {
  const previous = nodeProjection(previousNodesById);
  const byType = new Map(previous.byType);
  const mutableByType = new Map<CanvasNodeType, CanvasNodeData[]>();

  for (const [key, entry] of changedEntries) {
    const location = previous.indexByKey.get(key);
    if (location == null) continue;
    let nodes = mutableByType.get(location.type);
    if (nodes == null) {
      nodes = [...(previous.byType.get(location.type) ?? [])];
      mutableByType.set(location.type, nodes);
    }
    nodes[location.index] = entry.data;
  }
  for (const [type, nodes] of mutableByType) byType.set(type, nodes);
  nodeProjectionCache.set(nextNodesById, { byType, indexByKey: previous.indexByKey });
  // 此路径只应用位置/尺寸变化，连线语义索引可以完整继承。
  connectionProjectionCache.set(nextNodesById, connectionProjection(previousNodesById));
}

/** 用同类型的新数组替换 nodesById 中该类型的全部节点，其他类型条目原样保留。 */
function replaceTypeNodes(
  nodesById: CanvasNodesById,
  type: CanvasNodeType,
  nextNodes: readonly CanvasNodeData[],
): CanvasNodesById {
  const next: Record<string, CanvasNodeEntry> = {};
  for (const [key, entry] of Object.entries(nodesById)) {
    if (entry.type !== type) next[key] = entry;
  }
  for (const data of nextNodes) {
    // type 与 nextNodes 的元素类型由调用方的 K 绑定，成对写入保持判别一致。
    next[data.key] = { type, data } as CanvasNodeEntry;
  }
  cacheTypeReplacement(nodesById, next, type, nextNodes);
  return next;
}

/** 九类节点数据均携带 x/y；union 展开会分布到各成员，TS 可直接推出覆写结果。 */
function withNodePosition(data: CanvasNodeData, position: CanvasPan): CanvasNodeData {
  return { ...data, x: position.x, y: position.y };
}

/** 九类节点数据均携带可选 measured；用于把 React Flow 实测尺寸回存到节点。 */
function withNodeMeasured(data: CanvasNodeData, measured: CanvasNodeSize): CanvasNodeData {
  return { ...data, measured: { width: measured.width, height: measured.height } };
}

/** 合并同一批 RF change，只克隆一次 nodesById，并只复制实际变化的节点族数组。 */
function applyCanvasStoreNodeChanges(
  state: CanvasStoreState,
  changes: readonly CanvasStoreNodeChange[],
): CanvasStoreState | Partial<CanvasStoreState> {
  if (changes.length === 0) return state;

  let selectedNodeKey = state.selectedNodeKey;
  const changedEntries = new Map<string, CanvasNodeEntry>();
  for (const change of changes) {
    if (change.type === "select") {
      selectedNodeKey = change.selected ? change.key : null;
      continue;
    }

    const entry = changedEntries.get(change.key) ?? state.nodesById[change.key];
    if (entry == null) continue;
    const { data } = entry;
    let nextData: CanvasNodeData;
    if (change.type === "position") {
      if (data.x === change.position.x && data.y === change.position.y) continue;
      nextData = withNodePosition(data, change.position);
    } else {
      const current = data.measured;
      if (
        current != null &&
        current.width === change.measured.width &&
        current.height === change.measured.height
      ) {
        continue;
      }
      nextData = withNodeMeasured(data, change.measured);
    }
    changedEntries.set(change.key, { type: entry.type, data: nextData } as CanvasNodeEntry);
  }

  if (changedEntries.size === 0) {
    return selectedNodeKey === state.selectedNodeKey ? state : { selectedNodeKey };
  }

  const nodesById: Record<string, CanvasNodeEntry> = { ...state.nodesById };
  for (const [key, entry] of changedEntries) nodesById[key] = entry;
  cacheNodeDataChanges(state.nodesById, nodesById, changedEntries);
  return { nodesById, selectedNodeKey };
}

function persistedOutputNode(node: OutputNodeData): Omit<OutputNodeData, "previewSrc"> {
  const persisted = { ...node };
  delete persisted.previewSrc;
  return persisted;
}

function snapshotCanvasV2(
  state: CanvasStoreState,
  promptContents: Readonly<Record<string, PromptContentDocumentV1>>,
): CanvasDocumentV2 {
  const nodes = canvasNodeLists(state.nodesById);
  return {
    version: 2,
    assetNodes: nodes.asset,
    genNodes: nodes.gen,
    screenplayNodes: nodes.screenplay,
    storyboardNodes: nodes.storyboard,
    knowledgeVideoWorkflowNodes: nodes.knowledgeVideoWorkflow,
    viralRemixNodes: nodes.viralRemix,
    videoComposerNodes: nodes.videoComposer,
    videoDownloaderNodes: nodes.videoDownloader,
    frameExtractorNodes: nodes.frameExtractor,
    resultNodes: nodes.result,
    outputNodes: nodes.output.map(persistedOutputNode),
    assetEdges: state.assetEdges,
    view: { zoom: state.zoom, pan: state.pan },
    promptContents,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

const INTERRUPTED_KNOWLEDGE_VIDEO_PHASES = new Set(["planning", "generating", "qc", "composing"]);

/**
 * 运行控制器只存在于当前进程。文档恢复时，持久化为活动态的复合工作流实际已经
 * 中断，因此转为可继续的 paused，同时完整保留检查点中的任务身份和阶段产物。
 */
function normalizeRestoredKnowledgeVideoWorkflowNode(
  rawNode: Record<string, unknown>,
): CanvasNodeData {
  const config = rawNode["config"];
  if (!isRecord(config)) return rawNode as unknown as CanvasNodeData;
  const checkpoint = config["checkpoint"];
  if (!isRecord(checkpoint)) return rawNode as unknown as CanvasNodeData;
  const phase = checkpoint["phase"];
  if (typeof phase !== "string" || !INTERRUPTED_KNOWLEDGE_VIDEO_PHASES.has(phase)) {
    return rawNode as unknown as CanvasNodeData;
  }
  return {
    ...rawNode,
    config: {
      ...config,
      checkpoint: {
        ...checkpoint,
        phase: "paused",
        lastActivePhase: phase,
      },
    },
  } as unknown as CanvasNodeData;
}

interface NormalizedCanvasDocument {
  readonly nodesById: CanvasNodesById;
  readonly edges: readonly AssetEdgeData[];
  readonly view: CanvasReadModel["view"];
  readonly promptContents: Readonly<Record<string, PersistedPromptContent>>;
  readonly warnings: readonly string[];
}

function normalizeCanvasDocument(
  value: unknown,
  fallbackView: CanvasReadModel["view"],
):
  | { readonly ok: true; readonly document: NormalizedCanvasDocument }
  | {
      readonly ok: false;
      readonly reason: "unsupported-version" | "invalid-document";
      readonly issues: readonly string[];
    } {
  if (!isRecord(value)) {
    return { ok: false, reason: "invalid-document", issues: ["画布文档必须是对象"] };
  }
  if (value["version"] !== 1 && value["version"] !== 2) {
    return { ok: false, reason: "unsupported-version", issues: ["仅支持画布文档 V1/V2"] };
  }

  const requiredArrays = ["assetNodes", "genNodes", "resultNodes", "assetEdges"] as const;
  const issues: string[] = [];
  for (const field of requiredArrays) {
    if (!Array.isArray(value[field])) issues.push(field + " 必须是数组");
  }
  if (issues.length > 0) return { ok: false, reason: "invalid-document", issues };

  const nodeGroups: readonly [CanvasNodeType, readonly unknown[]][] = [
    ["asset", value["assetNodes"] as readonly unknown[]],
    ["gen", value["genNodes"] as readonly unknown[]],
    ["screenplay", Array.isArray(value["screenplayNodes"]) ? value["screenplayNodes"] : []],
    ["storyboard", Array.isArray(value["storyboardNodes"]) ? value["storyboardNodes"] : []],
    [
      "knowledgeVideoWorkflow",
      Array.isArray(value["knowledgeVideoWorkflowNodes"])
        ? value["knowledgeVideoWorkflowNodes"]
        : [],
    ],
    ["viralRemix", Array.isArray(value["viralRemixNodes"]) ? value["viralRemixNodes"] : []],
    [
      "videoComposer",
      Array.isArray(value["videoComposerNodes"]) ? value["videoComposerNodes"] : [],
    ],
    [
      "videoDownloader",
      Array.isArray(value["videoDownloaderNodes"]) ? value["videoDownloaderNodes"] : [],
    ],
    [
      "frameExtractor",
      Array.isArray(value["frameExtractorNodes"]) ? value["frameExtractorNodes"] : [],
    ],
    ["result", value["resultNodes"] as readonly unknown[]],
    ["output", Array.isArray(value["outputNodes"]) ? value["outputNodes"] : []],
  ];

  const nodesById: Record<string, CanvasNodeEntry> = {};
  for (const [type, nodes] of nodeGroups) {
    for (const rawNode of nodes) {
      if (!isRecord(rawNode) || typeof rawNode["key"] !== "string") {
        issues.push(type + " 节点缺少有效 key");
        continue;
      }
      const key = rawNode["key"];
      if (nodesById[key] != null) {
        issues.push("节点 key 重复: " + key);
        continue;
      }
      const data =
        type === "output"
          ? ({ ...rawNode, previewSrc: null } as unknown as CanvasNodeData)
          : type === "knowledgeVideoWorkflow"
            ? normalizeRestoredKnowledgeVideoWorkflowNode(rawNode)
            : (rawNode as unknown as CanvasNodeData);
      nodesById[key] = { type, data } as CanvasNodeEntry;
    }
  }
  if (issues.length > 0) return { ok: false, reason: "invalid-document", issues };

  const warnings: string[] = [];
  const edgeIds = new Set<string>();
  const edges: AssetEdgeData[] = [];
  for (const rawEdge of value["assetEdges"] as readonly unknown[]) {
    if (
      !isRecord(rawEdge) ||
      typeof rawEdge["id"] !== "string" ||
      typeof rawEdge["fromKey"] !== "string" ||
      typeof rawEdge["toKey"] !== "string"
    ) {
      warnings.push("已忽略格式无效的连线");
      continue;
    }
    const edge = rawEdge as unknown as AssetEdgeData;
    if (edgeIds.has(edge.id)) {
      warnings.push("已忽略重复连线: " + edge.id);
      continue;
    }
    if (nodesById[edge.fromKey] == null || nodesById[edge.toKey] == null) {
      warnings.push("已忽略端点缺失的连线: " + edge.id);
      continue;
    }
    edgeIds.add(edge.id);
    edges.push(edge);
  }

  let view = fallbackView;
  const rawView = value["view"];
  if (
    isRecord(rawView) &&
    typeof rawView["zoom"] === "number" &&
    isRecord(rawView["pan"]) &&
    typeof rawView["pan"]["x"] === "number" &&
    typeof rawView["pan"]["y"] === "number"
  ) {
    view = {
      zoom: rawView["zoom"],
      pan: { x: rawView["pan"]["x"], y: rawView["pan"]["y"] },
    };
  } else {
    warnings.push("文档视图无效，已保留当前视图");
  }

  const promptContents: Record<string, PersistedPromptContent> = {};
  if (value["version"] === 1 && isRecord(value["prompts"])) {
    for (const [key, prompt] of Object.entries(value["prompts"])) {
      if (typeof prompt === "string") promptContents[key] = prompt;
    }
  } else if (value["version"] === 2 && isRecord(value["promptContents"])) {
    for (const [key, prompt] of Object.entries(value["promptContents"])) {
      const decoded = decodePromptContentDocument(prompt);
      if (decoded == null) {
        warnings.push("已忽略格式无效的提示内容: " + key);
      } else {
        promptContents[key] = decoded;
      }
    }
  }
  return { ok: true, document: { nodesById, edges, view, promptContents, warnings } };
}

/** Generic nodes accept deferred inputs; product scenes require explicitly prepared originals. */
export function isSupportedConnection(source: CanvasNodeEntry, target: CanvasNodeEntry): boolean {
  if (target.type === "knowledgeVideoWorkflow" && target.data.config.productScene) return false;
  return source.data.key !== target.data.key;
}

/** 历史栈上限：超出后丢弃最旧记录，防止长会话内存无界增长。 */
const CANVAS_HISTORY_LIMIT = 200;

function createCanvasStore(initialZoom = 100): CanvasStore {
  // 同一同步批次内的多次写入（如清空画布会连写九类节点与连线）合并为一条历史，
  // 一次用户操作对应一步撤销；跨 await 的写入天然分批。
  let coalescingHistory = false;
  // RF 的尺寸回存与选中同步是被动测量/视图态，不是用户操作：置位时跳过历史记录。
  let suppressHistory = false;

  return createStore<CanvasStoreState>()(
    temporal(
      (set, _get, api) => {
        const temporalStore = api.temporal as CanvasStore["temporal"];
        return {
          nodesById: {},
          assetEdges: [],
          zoom: initialZoom,
          pan: { x: 0, y: 0 },
          selectedNodeKey: null,
          selectedEdgeId: null,
          insertSubgraph: (nodes, edges, options) => {
            let result: CanvasWriteResult = "unchanged";
            set((state) => {
              const batchNodeKeys = new Set<string>();
              for (const entry of nodes) {
                const key = entry.data.key;
                if (batchNodeKeys.has(key)) {
                  throw new Error("Canvas subgraph contains duplicate node key: " + key);
                }
                if (state.nodesById[key] != null) {
                  throw new Error("Canvas node key already exists: " + key);
                }
                batchNodeKeys.add(key);
              }

              const nodesById: Record<string, CanvasNodeEntry> =
                nodes.length === 0 ? state.nodesById : { ...state.nodesById };
              for (const entry of nodes) nodesById[entry.data.key] = entry;

              const existingEdgeIds = new Set(state.assetEdges.map((edge) => edge.id));
              const batchEdgeIds = new Set<string>();
              for (const edge of edges) {
                if (batchEdgeIds.has(edge.id)) {
                  throw new Error("Canvas subgraph contains duplicate edge id: " + edge.id);
                }
                if (existingEdgeIds.has(edge.id)) {
                  throw new Error("Canvas edge id already exists: " + edge.id);
                }
                batchEdgeIds.add(edge.id);

                const source = nodesById[edge.fromKey];
                const target = nodesById[edge.toKey];
                if (source == null || target == null) {
                  throw new Error("Canvas subgraph edge endpoint is missing: " + edge.id);
                }
                if (!isSupportedConnection(source, target)) {
                  throw new Error("Canvas subgraph connection is unsupported: " + edge.id);
                }
              }

              const selectNodeKey = options?.selectNodeKey;
              if (selectNodeKey != null && nodesById[selectNodeKey] == null) {
                throw new Error("Canvas selected node key is missing: " + selectNodeKey);
              }
              const selectedNodeKey =
                selectNodeKey === undefined ? state.selectedNodeKey : selectNodeKey;
              if (
                nodes.length === 0 &&
                edges.length === 0 &&
                selectedNodeKey === state.selectedNodeKey
              ) {
                return state;
              }

              result = "applied";
              return {
                nodesById: applyNewEdgesToGenerationInputSlots(nodesById, edges),
                assetEdges: edges.length === 0 ? state.assetEdges : [...state.assetEdges, ...edges],
                selectedNodeKey,
              };
            });
            return result;
          },
          addNode: (type, nodeOrFactory, options) => {
            let added: CanvasNodeData | null = null;
            set((state) => {
              const siblings = typeNodes(state.nodesById, type);
              const node =
                typeof nodeOrFactory === "function" ? nodeOrFactory(siblings) : nodeOrFactory;
              if (state.nodesById[node.key] != null) {
                throw new Error("Canvas node key already exists: " + node.key);
              }
              added = node;
              return {
                nodesById: replaceTypeNodes(state.nodesById, type, [...siblings, node]),
                selectedNodeKey: options?.select === true ? node.key : state.selectedNodeKey,
              };
            });
            return added as unknown as CanvasNodesByType[typeof type];
          },
          addOutput: (nodeOrFactory) => {
            let added: OutputNodeData | null = null;
            set((state) => {
              const outputs = typeNodes(state.nodesById, "output");
              const node =
                typeof nodeOrFactory === "function" ? nodeOrFactory(outputs) : nodeOrFactory;
              if (state.nodesById[node.key] != null) {
                throw new Error("Canvas node key already exists: " + node.key);
              }
              added = node;
              const edgeId = node.sourceNodeId + "->" + node.key;
              const edge = { id: edgeId, fromKey: node.sourceNodeId, toKey: node.key };
              const assetEdges =
                state.nodesById[node.sourceNodeId] != null &&
                !state.assetEdges.some((current) => current.id === edgeId)
                  ? [...state.assetEdges, edge]
                  : state.assetEdges;
              return {
                nodesById: replaceTypeNodes(state.nodesById, "output", [...outputs, node]),
                assetEdges,
              };
            });
            return added!;
          },
          patchNode: (type, key, update) => {
            let result: CanvasWriteResult = "missing";
            set((state) => {
              const entry = state.nodesById[key];
              if (entry == null) return state;
              if (entry.type !== type) {
                throw new Error("Canvas node type mismatch for key: " + key);
              }
              const current = entry.data as CanvasNodesByType[typeof type];
              const next = update(current);
              if (next.key !== key) throw new Error("Canvas node patch cannot change key: " + key);
              if (next === current) {
                result = "unchanged";
                return state;
              }
              const siblings = typeNodes(state.nodesById, type);
              const nextSiblings = siblings.map((node) => (node.key === key ? next : node));
              result = "applied";
              return { nodesById: replaceTypeNodes(state.nodesById, type, nextSiblings) };
            });
            return result;
          },
          patchNodes: (type, update) => {
            let changed = 0;
            set((state) => {
              const siblings = typeNodes(state.nodesById, type);
              const next = siblings.map((node) => {
                const updated = update(node);
                if (updated.key !== node.key) {
                  throw new Error("Canvas node patch cannot change key: " + node.key);
                }
                if (updated !== node) changed += 1;
                return updated;
              });
              return changed === 0
                ? state
                : { nodesById: replaceTypeNodes(state.nodesById, type, next) };
            });
            return changed;
          },
          removeNode: (key) => {
            let removed: CanvasNodeEntry | null = null;
            set((state) => {
              const entry = state.nodesById[key];
              if (entry == null) return state;
              removed = entry;
              const siblings = typeNodes(state.nodesById, entry.type);
              const nodesById = replaceTypeNodes(
                state.nodesById,
                entry.type,
                siblings.filter((node) => node.key !== key),
              );
              const removedEdgeIds = new Set(
                state.assetEdges
                  .filter((edge) => edge.fromKey === key || edge.toKey === key)
                  .map((edge) => edge.id),
              );
              // 删除的边会从 assetEdges 移除，但它占用的 inputSlots 槽位若继续留着，
              // 就会变成一个指向已不存在节点的悬挂 key：既占住槽位表位置（导致跳号），
              // 又可能被后续素材按"最小空槽"复用时对不上真实连线。
              // 这里把它清成 null 空槽，与 disconnect 的语义一致：保留位置、不压缩顺序。
              let slotsPruned = false;
              for (const candidate of Object.values(nodesById)) {
                if (candidate.type !== "gen") continue;
                const candidateData = candidate.data;
                if (candidateData.kind !== "image" && candidateData.kind !== "video") continue;
                const slots = candidateData.config.inputSlots;
                if (slots == null || !slots.includes(key)) continue;
                slotsPruned = true;
                const prunedData = {
                  ...candidateData,
                  config: {
                    ...candidateData.config,
                    inputSlots: slots.map((slot) => (slot === key ? null : slot)),
                  },
                };
                Object.assign(nodesById, {
                  [candidateData.key]: { type: "gen", data: prunedData },
                });
              }
              return {
                /*
                 * nodesById 必须无条件回写：replaceTypeNodes 每次都返回删掉该节点的
                 * 新对象，漏掉这一步等于把节点留在图里——表现为「点叉号没反应」，
                 * 只有恰好清到槽位（删的素材被生成节点的 inputSlots 引用）才会生效。
                 *
                 * 槽位是就地清在新对象上的，那份投影缓存已不代表它的内容，
                 * 因此清理过时再复制一层，让下游按新对象重算。
                 */
                nodesById: slotsPruned ? { ...nodesById } : nodesById,
                assetEdges:
                  removedEdgeIds.size === 0
                    ? state.assetEdges
                    : state.assetEdges.filter((edge) => !removedEdgeIds.has(edge.id)),
                selectedNodeKey: state.selectedNodeKey === key ? null : state.selectedNodeKey,
                selectedEdgeId:
                  state.selectedEdgeId != null && removedEdgeIds.has(state.selectedEdgeId)
                    ? null
                    : state.selectedEdgeId,
              };
            });
            return removed;
          },
          connect: (fromKey, toKey) => {
            let result: CanvasConnectResult = { status: "rejected", reason: "missing-source" };
            set((state) => {
              if (fromKey === toKey) {
                result = { status: "rejected", reason: "same-node" };
                return state;
              }
              const source = state.nodesById[fromKey];
              if (source == null) return state;
              const target = state.nodesById[toKey];
              if (target == null) {
                result = { status: "rejected", reason: "missing-target" };
                return state;
              }
              if (!isSupportedConnection(source, target)) {
                result = { status: "rejected", reason: "unsupported-connection" };
                return state;
              }
              const edgeId = fromKey + "->" + toKey;
              if (state.assetEdges.some((edge) => edge.id === edgeId)) {
                result = { status: "unchanged", edgeId };
                return state;
              }
              const edge = { id: edgeId, fromKey, toKey };
              result = { status: "connected", edge, replacedEdgeIds: [] };
              // 生成节点（图片/视频）维护 inputSlots：能贡献媒体的来源填充最小空槽，无空槽则追加。
              // 只走文本/中转的来源（提示词、剧本、分镜）不占媒体位置——
              // 让纯文本连线占一个槽位，会在参考清单里凭空多出一行空位，也会打乱图片编号。
              // 先把已连上却没入账的来源按连线先后补进槽位（拖线建节点的旧文档），再给新线分配。
              if (isGenerationMediaConsumer(target) && generationSourceOccupiesInputSlot(source)) {
                const healed = adoptMissingGenerationInputSlots(
                  target.data.config.inputSlots ?? [],
                  occupyingGenerationInputKeys(
                    state.assetEdges.filter((candidate) => candidate.toKey === toKey),
                    (key) => state.nodesById[key],
                  ),
                );
                const slots = assignGenerationInputSlot(healed, fromKey);
                return {
                  assetEdges: [...state.assetEdges, edge],
                  nodesById: {
                    ...state.nodesById,
                    [toKey]: withGenerationInputSlots(target, slots),
                  },
                };
              }
              return { assetEdges: [...state.assetEdges, edge] };
            });
            return result;
          },
          disconnect: (edgeId) => {
            let result: CanvasWriteResult = "missing";
            set((state) => {
              const edge = state.assetEdges.find((candidate) => candidate.id === edgeId);
              if (!edge) return state;
              result = "applied";
              const nextEdges = state.assetEdges.filter((candidate) => candidate.id !== edgeId);
              // 生成节点（图片/视频）维护 inputSlots：被删除素材的槽位保留为 null（不压缩），
              // 保证其余素材顺序不变，下次新增时填充该空槽。
              const target = state.nodesById[edge.toKey];
              if (
                target &&
                target.type === "gen" &&
                (target.data.kind === "image" || target.data.kind === "video")
              ) {
                const slots = [...(target.data.config.inputSlots ?? [])];
                const slotIndex = slots.indexOf(edge.fromKey);
                if (slotIndex >= 0) {
                  slots[slotIndex] = null;
                  const nextData = {
                    ...target.data,
                    config: { ...target.data.config, inputSlots: slots },
                  };
                  return {
                    assetEdges: nextEdges,
                    nodesById: {
                      ...state.nodesById,
                      [edge.toKey]: { type: "gen", data: nextData },
                    },
                    selectedEdgeId: state.selectedEdgeId === edgeId ? null : state.selectedEdgeId,
                  };
                }
              }
              return {
                assetEdges: nextEdges,
                selectedEdgeId: state.selectedEdgeId === edgeId ? null : state.selectedEdgeId,
              };
            });
            return result;
          },
          reorderGenerationInput: (nodeKey, sourceKey, targetKey) => {
            let result: CanvasWriteResult = "missing";
            set((state) => {
              const target = state.nodesById[nodeKey];
              if (!target || !isGenerationMediaConsumer(target)) return state;
              const connectedKeys = occupyingGenerationInputKeys(
                state.assetEdges.filter((edge) => edge.toKey === nodeKey),
                (key) => state.nodesById[key],
              );
              if (!connectedKeys.includes(sourceKey) || !connectedKeys.includes(targetKey)) {
                return state;
              }
              const currentSlots = target.data.config.inputSlots ?? [];
              const nextSlots = reorderGenerationInputSlots(
                currentSlots,
                connectedKeys,
                sourceKey,
                targetKey,
              );
              if (nextSlots === currentSlots) {
                result = "unchanged";
                return state;
              }
              result = "applied";
              return {
                nodesById: {
                  ...state.nodesById,
                  [nodeKey]: withGenerationInputSlots(target, nextSlots),
                },
              };
            });
            return result;
          },
          clear: () => {
            let removed: readonly CanvasNodeEntry[] = [];
            set((state) => {
              removed = Object.values(state.nodesById);
              if (
                removed.length === 0 &&
                state.assetEdges.length === 0 &&
                state.selectedNodeKey == null &&
                state.selectedEdgeId == null
              ) {
                return state;
              }
              return {
                nodesById: {},
                assetEdges: [],
                selectedNodeKey: null,
                selectedEdgeId: null,
              };
            });
            return removed;
          },
          applyNodeChanges: (changes) => {
            // 位置变更是拖拽提交的用户操作，参与历史；尺寸/选中批次不入历史。
            const historyEligible = changes.some((change) => change.type === "position");
            suppressHistory = !historyEligible;
            let result: CanvasWriteResult = "unchanged";
            try {
              set((state) => {
                const next = applyCanvasStoreNodeChanges(state, changes);
                result = next === state ? "unchanged" : "applied";
                return next;
              });
            } finally {
              suppressHistory = false;
            }
            return result;
          },
          setView: (view) => {
            let result: CanvasWriteResult = "unchanged";
            set((state) => {
              const zoom = view.zoom ?? state.zoom;
              const pan = view.pan ?? state.pan;
              if (zoom === state.zoom && pan.x === state.pan.x && pan.y === state.pan.y)
                return state;
              result = "applied";
              return { zoom, pan };
            });
            return result;
          },
          selectNode: (key) => {
            let result: CanvasWriteResult = "unchanged";
            set((state) => {
              if (key != null && state.nodesById[key] == null) {
                result = "missing";
                return state;
              }
              if (state.selectedNodeKey === key) return state;
              result = "applied";
              return { selectedNodeKey: key };
            });
            return result;
          },
          selectEdge: (edgeId) => {
            let result: CanvasWriteResult = "unchanged";
            set((state) => {
              if (edgeId != null && !state.assetEdges.some((edge) => edge.id === edgeId)) {
                result = "missing";
                return state;
              }
              if (state.selectedEdgeId === edgeId) return state;
              result = "applied";
              return { selectedEdgeId: edgeId };
            });
            return result;
          },
          restoreDocument: (document) => {
            const current = _get();
            const normalized = normalizeCanvasDocument(document, {
              zoom: current.zoom,
              pan: current.pan,
            });
            if (!normalized.ok) return normalized;
            const restored = normalized.document;
            suppressHistory = true;
            try {
              set({
                nodesById: restored.nodesById,
                assetEdges: restored.edges,
                zoom: restored.view.zoom,
                pan: restored.view.pan,
                selectedNodeKey: null,
                selectedEdgeId: null,
              });
            } finally {
              suppressHistory = false;
            }
            temporalStore.getState().clear();
            return {
              ok: true,
              promptContents: restored.promptContents,
              view: restored.view,
              warnings: restored.warnings,
            };
          },
          undo: () => {
            if (temporalStore.getState().pastStates.length === 0) return "unchanged";
            temporalStore.getState().undo();
            return "applied";
          },
          redo: () => {
            if (temporalStore.getState().futureStates.length === 0) return "unchanged";
            temporalStore.getState().redo();
            return "applied";
          },
        };
      },
      {
        partialize: (state): CanvasHistoryState => ({
          nodesById: state.nodesById,
          assetEdges: state.assetEdges,
        }),
        // 各动作已保证"无变化返回原引用"，引用相等即可精确判断是否产生历史。
        equality: (past, current) =>
          past.nodesById === current.nodesById && past.assetEdges === current.assetEdges,
        limit: CANVAS_HISTORY_LIMIT,
        handleSet: (handleSet) => (pastState, replace, currentState, deltaState) => {
          if (coalescingHistory || suppressHistory) return;
          coalescingHistory = true;
          // zundo 选项类型把内层声明成 setState（1-2 参），运行时实际接收 4 参。
          const recordHistory = handleSet as (
            past: typeof pastState,
            replaceArg: typeof replace,
            current: typeof currentState,
            delta: typeof deltaState,
          ) => void;
          recordHistory(pastState, replace, currentState, deltaState);
          queueMicrotask(() => {
            coalescingHistory = false;
          });
        },
      },
    ),
  );
}

interface CanvasStateImplementation extends CanvasStateModule {
  readonly store: CanvasStore;
}

function historySummary(store: CanvasStore): CanvasHistorySummary {
  const temporalState = store.temporal.getState();
  const pastCount = temporalState.pastStates.length;
  const futureCount = temporalState.futureStates.length;
  return { pastCount, futureCount, canUndo: pastCount > 0, canRedo: futureCount > 0 };
}

function createCanvasStateImplementation(initialZoom = 100): CanvasStateImplementation {
  const store = createCanvasStore(initialZoom);
  // Canvas structural undo stays in zundo. Each workflow's durable version branches outlive
  // the older node snapshots stored there, including a delete followed by canvas undo.
  const workflowVersions = new Map<string, KnowledgeVideoWorkflowConfig>();
  const versionedNode = <T extends CanvasNodeData>(type: CanvasNodeType, node: T): T => {
    if (type !== "knowledgeVideoWorkflow") return node;
    const workflow = node as KnowledgeVideoWorkflowNodeData;
    const previous = workflowVersions.get(workflow.key);
    const config = previous
      ? recordWorkflowVersion(previous, workflow.config)
      : initializeWorkflowVersions(workflow.config);
    return config === workflow.config ? node : ({ ...workflow, config } as T);
  };
  const rememberWorkflows = () => {
    for (const node of canvasNodeLists(store.getState().nodesById).knowledgeVideoWorkflow)
      workflowVersions.set(node.key, node.config);
  };
  const protectedWorkflows = (
    keys?: ReadonlySet<string>,
  ): ReadonlyMap<string, KnowledgeVideoWorkflowNodeData> =>
    new Map(
      canvasNodeLists(store.getState().nodesById)
        .knowledgeVideoWorkflow.filter(
          (node) =>
            keys?.has(node.key) === true ||
            INTERRUPTED_KNOWLEDGE_VIDEO_PHASES.has(node.config.checkpoint.phase),
        )
        .map((node) => [node.key, node] as const),
    );
  const reconcileWorkflows = (
    freshDocument = false,
    protectedNodes: ReadonlyMap<string, KnowledgeVideoWorkflowNodeData> = new Map(),
  ) => {
    if (freshDocument) workflowVersions.clear();
    const current = store.getState().nodesById;
    let nodesById = current;
    for (const entry of Object.values(current)) {
      if (entry.type !== "knowledgeVideoWorkflow") continue;
      const previous = workflowVersions.get(entry.data.key);
      const config =
        protectedNodes.get(entry.data.key)?.config ??
        (previous
          ? mergeWorkflowVersionHistory(previous, entry.data.config)
          : initializeWorkflowVersions(entry.data.config));
      workflowVersions.set(entry.data.key, config);
      if (config === entry.data.config) continue;
      if (nodesById === current) nodesById = { ...current };
      (nodesById as Record<string, CanvasNodeEntry>)[entry.data.key] = {
        type: "knowledgeVideoWorkflow",
        data: { ...entry.data, config },
      };
    }
    // Undoing the insertion of an active workflow cannot orphan its paid in-flight execution.
    for (const [key, data] of protectedNodes) {
      if (nodesById[key]) continue;
      if (nodesById === current) nodesById = { ...current };
      (nodesById as Record<string, CanvasNodeEntry>)[key] = {
        type: "knowledgeVideoWorkflow",
        data,
      };
      workflowVersions.set(key, data.config);
    }
    if (nodesById !== current) {
      // Reattaching version metadata must not push another canvas undo or clear its redo stack.
      store.temporal.getState().pause();
      try {
        store.setState({ nodesById });
      } finally {
        store.temporal.getState().resume();
      }
    }
  };
  const commands: CanvasCommands = {
    insertSubgraph: (nodes, edges, options) => {
      const prepared = nodes.map((entry): CanvasNodeEntry =>
        entry.type === "knowledgeVideoWorkflow"
          ? { ...entry, data: versionedNode(entry.type, entry.data) }
          : entry,
      );
      const result = store.getState().insertSubgraph(prepared, edges, options);
      rememberWorkflows();
      return result;
    },
    addNode: (type, node, options) => {
      const added = store
        .getState()
        .addNode(
          type,
          (siblings) => versionedNode(type, typeof node === "function" ? node(siblings) : node),
          options,
        );
      if (type === "knowledgeVideoWorkflow") rememberWorkflows();
      return added;
    },
    addOutput: (node) => store.getState().addOutput(node),
    patchNode: (type, key, update) => {
      const result = store.getState().patchNode(type, key, (node) => {
        const next = update(node);
        return next === node ? node : versionedNode(type, next);
      });
      if (type === "knowledgeVideoWorkflow") rememberWorkflows();
      return result;
    },
    patchNodes: (type, update) => {
      const result = store.getState().patchNodes(type, (node) => {
        const next = update(node);
        return next === node ? node : versionedNode(type, next);
      });
      if (type === "knowledgeVideoWorkflow") rememberWorkflows();
      return result;
    },
    removeNode: (key) => store.getState().removeNode(key),
    connect: (fromKey, toKey) => store.getState().connect(fromKey, toKey),
    disconnect: (edgeId) => store.getState().disconnect(edgeId),
    reorderGenerationInput: (nodeKey, sourceKey, targetKey) =>
      store.getState().reorderGenerationInput(nodeKey, sourceKey, targetKey),
    applyNodeChanges: (changes) => store.getState().applyNodeChanges(changes),
    setView: (view) => store.getState().setView(view),
    selectNode: (key) => store.getState().selectNode(key),
    selectEdge: (edgeId) => store.getState().selectEdge(edgeId),
    clear: () => store.getState().clear(),
    snapshotV2: (promptContents) => snapshotCanvasV2(store.getState(), promptContents),
    restoreDocument: (document) => {
      const result = store.getState().restoreDocument(document);
      if (result.ok) reconcileWorkflows(true);
      return result;
    },
    undo: (protectedWorkflowKeys) => {
      const protectedNodes = protectedWorkflows(protectedWorkflowKeys);
      const result = store.getState().undo();
      if (result === "applied") reconcileWorkflows(false, protectedNodes);
      return result;
    },
    redo: (protectedWorkflowKeys) => {
      const protectedNodes = protectedWorkflows(protectedWorkflowKeys);
      const result = store.getState().redo();
      if (result === "applied") reconcileWorkflows(false, protectedNodes);
      return result;
    },
  };
  return {
    store,
    commands,
    getSnapshot: () => canvasReadModel(store.getState()),
    getHistory: () => historySummary(store),
    subscribe: (listener) => store.subscribe(() => listener()),
  };
}

export function createCanvasState(initialZoom = 100): CanvasStateModule {
  return createCanvasStateImplementation(initialZoom);
}

const CanvasStoreContext = createContext<CanvasStateImplementation | null>(null);

export function CanvasStoreProvider({
  children,
  initialZoom = 100,
}: {
  readonly children: ReactNode;
  readonly initialZoom?: number;
}) {
  const [canvas] = useState(() => createCanvasStateImplementation(initialZoom));
  return createElement(CanvasStoreContext.Provider, { value: canvas }, children);
}

export function useCanvas<T>(selector: (state: CanvasReadModel) => T): T {
  const canvas = useContext(CanvasStoreContext);
  if (canvas == null) throw new Error("useCanvas must be used within CanvasStoreProvider");
  return useStore(canvas.store, (state) => selector(canvasReadModel(state)));
}

export function useCanvasCommands(): CanvasCommands {
  const canvas = useContext(CanvasStoreContext);
  if (canvas == null) throw new Error("useCanvasCommands must be used within CanvasStoreProvider");
  return canvas.commands;
}

/** 订阅撤销/重做历史长度，供工具栏按钮的可用态渲染。 */
export function useCanvasHistoryCounts(): {
  readonly pastCount: number;
  readonly futureCount: number;
} {
  const canvas = useContext(CanvasStoreContext);
  if (canvas == null) {
    throw new Error("useCanvasHistoryCounts must be used within CanvasStoreProvider");
  }
  const pastCount = useStore(canvas.store.temporal, (state) => state.pastStates.length);
  const futureCount = useStore(canvas.store.temporal, (state) => state.futureStates.length);
  return { pastCount, futureCount };
}
