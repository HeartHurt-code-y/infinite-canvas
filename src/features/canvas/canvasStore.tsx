import {
  createContext,
  createElement,
  useContext,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { createStore, type StoreApi } from "zustand/vanilla";
import { temporal, type TemporalState } from "zundo";
import {
  EMPTY_CANVAS_GROUPS,
  decodeCanvasGroups,
  dissolveCanvasGroup,
  expandCanvasGroupPositionChanges,
  reconcileCanvasGroups,
  regroupCanvasNodes,
  type CanvasGroup,
  type CanvasGroups,
} from "./canvasGroups";
import {
  createCanvasInputResolverCache,
  type CanvasInputResolver,
} from "../workspace/canvasInputs";
import { decodePromptContentDocument, type PromptContentDocumentV1 } from "../../lib/promptContent";
import { decodeDirectorScene, type DirectorScene } from "../workspace/directorScene";

/** 画布里各提示词节点的 canonical 文档快照（按节点 key 索引）。 */
export type PromptContentDocumentMap = Readonly<Record<string, PromptContentDocumentV1>>;

/** 空快照：画布还没有任何提示词内容时的初值。 */
const EMPTY_PROMPT_DOCUMENTS: PromptContentDocumentMap = {};
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
  OutputNodeData,
  ResultNodeData,
  ScreenplayNodeData,
  VideoClipNodeData,
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
  | { readonly type: "aspectRatio"; readonly key: string; readonly aspectRatio: number }
  | { readonly type: "select"; readonly key: string; readonly selected: boolean };

/**
 * 画布六类节点的类型标签，即 nodesById 内每个条目的判别字段。
 * 标签沿用旧版平行数组的集合名；gen 一类内部仍以 data.kind 区分图片/视频/提示词。
 */
export type CanvasNodeType = "asset" | "gen" | "screenplay" | "videoClip" | "director" | "result" | "output";

export interface DirectorNodeData {
  readonly key: string;
  readonly kind: "director";
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly measured?: CanvasNodeSize;
  readonly assetGroupId?: string;
  readonly rating?: number;
  readonly scene: DirectorScene;
  readonly prompt: string;
  readonly panoramaKey: string | null;
  readonly previewUrl: string | null;
}

/** 类型标签 → 节点数据类型。 */
export interface CanvasNodesByType {
  asset: AssetNodeData;
  gen: GenNodeData;
  screenplay: ScreenplayNodeData;
  videoClip: VideoClipNodeData;
  director: DirectorNodeData;
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

/** 画布全部节点的唯一存储：key → 节点条目。六类节点不再各自持有平行数组。 */
export type CanvasNodesById = Readonly<Record<string, CanvasNodeEntry>>;

/** 节点数据的只读联合；按类型操作时经由 CanvasNodesByType 收窄。 */
export type CanvasNodeData = CanvasNodeEntry["data"];

/** 画布文档 V1：持久化 I/O 留给调用方，module 只负责纯快照与恢复。 */
export interface CanvasDocumentV1 {
  readonly version: 1;
  readonly assetNodes: readonly AssetNodeData[];
  readonly genNodes: readonly GenNodeData[];
  readonly screenplayNodes?: readonly ScreenplayNodeData[];
  readonly videoClipNodes?: readonly VideoClipNodeData[];
  readonly directorNodes?: readonly DirectorNodeData[];
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
  readonly groups?: CanvasGroups;
  readonly assetNodes: readonly AssetNodeData[];
  readonly genNodes: readonly GenNodeData[];
  readonly screenplayNodes?: readonly ScreenplayNodeData[];
  readonly videoClipNodes?: readonly VideoClipNodeData[];
  readonly directorNodes?: readonly DirectorNodeData[];
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
  readonly videoClip: readonly VideoClipNodeData[];
  readonly director: readonly DirectorNodeData[];
  readonly result: readonly ResultNodeData[];
  readonly output: readonly OutputNodeData[];
}

export interface CanvasNodesByKey {
  readonly asset: ReadonlyMap<string, AssetNodeData>;
  readonly gen: ReadonlyMap<string, GenNodeData>;
  readonly screenplay: ReadonlyMap<string, ScreenplayNodeData>;
  readonly videoClip: ReadonlyMap<string, VideoClipNodeData>;
  readonly director: ReadonlyMap<string, DirectorNodeData>;
  readonly result: ReadonlyMap<string, ResultNodeData>;
  readonly output: ReadonlyMap<string, OutputNodeData>;
}

export interface CanvasGraphReadModel {
  readonly edges: readonly AssetEdgeData[];
  readonly countByNode: ReadonlyMap<string, number>;
  readonly byTarget: ReadonlyMap<string, readonly AssetEdgeData[]>;
}

export interface CanvasReadModel {
  readonly groups: CanvasGroups;
  readonly resolveInputs: CanvasInputResolver;
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
  readonly groupNodes: (keys: readonly string[], groupId: string, layout?: {
    readonly group: CanvasGroup;
    readonly positions: readonly CanvasStoreNodeChange[];
  }) => CanvasWriteResult;
  readonly dissolveGroup: (groupId: string) => CanvasWriteResult;
  readonly updateGroup: (
    groupId: string,
    patch: Partial<Pick<CanvasGroup, "name" | "collapsed">>,
  ) => CanvasWriteResult;
  readonly insertSubgraph: (
    nodes: readonly CanvasNodeEntry[],
    edges: readonly AssetEdgeData[],
    options?: { readonly selectNodeKey?: string | null; readonly groups?: CanvasGroups },
  ) => CanvasWriteResult;
  readonly addNode: <K extends CanvasNodeType>(
    type: K,
    node:
      CanvasNodesByType[K] | ((siblings: readonly CanvasNodesByType[K][]) => CanvasNodesByType[K]),
    options?: { readonly select?: boolean },
  ) => CanvasNodesByType[K];
  readonly addOutput: (
    node:
      | OutputNodeData
      | ((outputs: readonly OutputNodeData[], nodesById: CanvasNodesById) => OutputNodeData),
  ) => OutputNodeData;
  readonly patchNode: <K extends CanvasNodeType>(
    type: K,
    key: string,
    update: (node: CanvasNodesByType[K]) => CanvasNodesByType[K],
    /*
     * 与这次节点写入**同批**落下的提示词 canonical 快照。
     *
     * 为什么必须同批：zundo 在每次 set 时把**变更前**的完整 state 推进历史栈。
     * 若节点写入与快照写入分成两次 set，第一次 set 之后历史里就已经是「新快照」，
     * 撤销恢复回来的就是当前内容而不是上一步 —— 撤销等于没撤销。
     * 同一次 set 里，变更前的 state 同时带着「旧 nodesById」与「旧快照」，
     * 撤销才拿得到真正的上一步。
     */
    promptDocuments?: PromptContentDocumentMap | undefined,
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
  readonly undo: () => CanvasWriteResult;
  readonly redo: () => CanvasWriteResult;
  /**
   * 机器驱动的连续写入（批量落卡等）在包裹期间走时间窗折叠：
   * 至多每窗口一条补记录，避免撤销栈被后台进度灌满。用户命令不受影响。
   */
  readonly runWithCoalescedHistory: <T>(fn: () => T) => T;
}

/** Zustand/zundo 细节不越过此 interface。 */
export interface CanvasStateModule {
  readonly commands: CanvasCommands;
  readonly getSnapshot: () => CanvasReadModel;
  readonly getHistory: () => CanvasHistorySummary;
  readonly subscribe: (listener: () => void) => () => void;
}

export interface CanvasStoreState {
  readonly groups: CanvasGroups;
  readonly groupNodes: CanvasCommands["groupNodes"];
  readonly dissolveGroup: CanvasCommands["dissolveGroup"];
  readonly updateGroup: CanvasCommands["updateGroup"];
  readonly nodesById: CanvasNodesById;
  readonly assetEdges: readonly AssetEdgeData[];
  /**
   * 画布里各提示词节点的 canonical 文档快照（按节点 key 索引）。
   *
   * ## 为什么它住在 store 里
   *
   * 撤销栈只存 `config.generatedPrompt` 这份**纯文本镜像**，而 canonical 文档
   * （含块结构、行内 marks、附件、@引用的素材身份）不在历史里 —— 于是撤销只能靠
   * 纯文本回灌 canonical，块结构与 marks 都不精确回滚。
   *
   * 提示词内容住在提示词模块里（不进 store），但**快照**可以进 store：zundo 的
   * `pastStates` 存的是**完整 state**（`partialize` 只用于 equality 比较），所以
   * 只要这个字段在 store state 里，撤销/重做时它会**自动**随整个 state 一起恢复。
   *
   * ## 为什么不会引发重渲染
   *
   * 没有组件订阅顶层 state —— `useCanvasStore()` 返回的是 **store 对象**（引用
   * 稳定，state 变而对象不变），窄订阅走 `useSyncExternalStore` 自己选字段。
   * 所以多一个字段的写入不增加任何重渲染。
   *
   * ## 写入顺序（重要）
   *
   * 必须是「先写 nodesById、再写本字段」：zundo 在每次 set 时把**变更前**的完整
   * state 推进历史栈。反过来写，历史里存的就是新快照，撤销会恢复到「当前」内容。
   */
  readonly promptDocuments: PromptContentDocumentMap;
  /**
   * 更新提示词快照。**必须在**对应的 `nodesById` 写入**之后**调用（见上）。
   */
  readonly setPromptDocuments: (documents: PromptContentDocumentMap) => void;
  readonly commitPromptReferenceChange: (
    graph: CanvasConnectionGraph,
    documents: PromptContentDocumentMap,
  ) => void;
  readonly zoom: number;
  readonly pan: CanvasPan;
  readonly selectedNodeKey: string | null;
  readonly selectedEdgeId: string | null;
  readonly insertSubgraph: (
    nodes: readonly CanvasNodeEntry[],
    edges: readonly AssetEdgeData[],
    options?: { readonly selectNodeKey?: string | null; readonly groups?: CanvasGroups },
  ) => CanvasWriteResult;
  readonly addNode: <K extends CanvasNodeType>(
    type: K,
    node:
      CanvasNodesByType[K] | ((siblings: readonly CanvasNodesByType[K][]) => CanvasNodesByType[K]),
    options?: { readonly select?: boolean },
  ) => CanvasNodesByType[K];
  readonly addOutput: (
    node:
      | OutputNodeData
      | ((outputs: readonly OutputNodeData[], nodesById: CanvasNodesById) => OutputNodeData),
  ) => OutputNodeData;
  readonly patchNode: <K extends CanvasNodeType>(
    type: K,
    key: string,
    update: (node: CanvasNodesByType[K]) => CanvasNodesByType[K],
    /*
     * 与这次节点写入**同批**落下的提示词 canonical 快照。
     *
     * 为什么必须同批：zundo 在每次 set 时把**变更前**的完整 state 推进历史栈。
     * 若节点写入与快照写入分成两次 set，第一次 set 之后历史里就已经是「新快照」，
     * 撤销恢复回来的就是当前内容而不是上一步 —— 撤销等于没撤销。
     * 同一次 set 里，变更前的 state 同时带着「旧 nodesById」与「旧快照」，
     * 撤销才拿得到真正的上一步。
     */
    promptDocuments?: PromptContentDocumentMap | undefined,
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
  /** 机器驱动的连续写入在包裹期间走时间窗折叠（详见 CanvasCommands 注释）。 */
  readonly runWithCoalescedHistory: <T>(fn: () => T) => T;
}

/**
 * 撤销/重做跟踪节点、连线、分组与提示词 canonical 快照。
 *
 * zoom/pan/选中态属于视图，不参与历史。
 *
 * `promptDocuments` 在这里的原因：zundo 的 `pastState` 取的是
 * `partialize(get())` 的结果 —— `partialize` 决定「历史里存哪些字段」。
 * 不带它，历史里就没有 canonical，撤销只能靠纯文本镜像回灌（有损）。
 */
type CanvasHistoryState = Pick<
  CanvasStoreState,
  "nodesById" | "assetEdges" | "groups" | "promptDocuments"
>;

/** 画布 store：主状态外挂 zundo temporal 历史 store。 */
export interface CanvasStore extends StoreApi<CanvasStoreState> {
  readonly temporal: StoreApi<TemporalState<CanvasHistoryState>>;
  /**
   * 最近一次写入是否来自用户命令。被动测量（尺寸回存、选中同步）与机器批写不算：
   * 它们继续按防抖窗口落盘；用户命令（成组、改名、折叠、粘贴、撤销、拖动提交）是
   * 明确的操作，要立刻落盘，不能排在防抖窗口之后。
   */
  readonly lastWriteWasUserCommand: () => boolean;
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
  "videoClip",
  "director",
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
      first.libraryResource === second.libraryResource &&
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
      first.customName === second.customName &&
      first.libraryPickOrder === second.libraryPickOrder &&
      first.assetGroupId === second.assetGroupId
    );
  }
  if (type === "gen") {
    const first = previous as GenNodeData;
    const second = next as GenNodeData;
    return (
      first.kind === second.kind && first.config === second.config && first.name === second.name &&
      (first.kind !== "image" || second.kind !== "image" || first.imageGeneration === second.imageGeneration)
    );
  }
  if (type === "screenplay") {
    const first = previous as ScreenplayNodeData;
    const second = next as ScreenplayNodeData;
    return first.config.currentDocument === second.config.currentDocument;
  }
  if (type === "videoClip") {
    const first = previous as VideoClipNodeData;
    const second = next as VideoClipNodeData;
    return first.config === second.config;
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
    videoClip: typeNodes(nodesById, "videoClip"),
    director: typeNodes(nodesById, "director"),
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
    videoClip: connectionTypeNodesByKey(nodesById, "videoClip"),
    director: connectionTypeNodesByKey(nodesById, "director"),
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
// Store action identities are stable across edits/undo and unique to each canvas owner.
const inputResolverOwners = new WeakMap<
  CanvasStoreState["addNode"],
  ReturnType<typeof createCanvasInputResolverCache>
>();

function canvasReadModel(state: CanvasStoreState): CanvasReadModel {
  const cached = readModelCache.get(state);
  if (cached != null) return cached;
  let inputCache = inputResolverOwners.get(state.addNode);
  if (!inputCache) {
    inputCache = createCanvasInputResolverCache();
    inputResolverOwners.set(state.addNode, inputCache);
  }
  const nodeByKey = canvasNodesByKey(state.nodesById);
  const model: CanvasReadModel = {
    groups: state.groups,
    resolveInputs: inputCache(nodeByKey, state.assetEdges),
    nodes: canvasNodeLists(state.nodesById),
    nodeByKey,
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

/** 六类节点数据均携带 x/y；union 展开会分布到各成员，TS 可直接推出覆写结果。 */
function withNodePosition(data: CanvasNodeData, position: CanvasPan): CanvasNodeData {
  return { ...data, x: position.x, y: position.y };
}

/** 六类节点数据均携带可选 measured；用于把 React Flow 实测尺寸回存到节点。 */
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
    } else if (change.type === "aspectRatio") {
      if ((entry.type !== "asset" && entry.type !== "output") || !Number.isFinite(change.aspectRatio) || change.aspectRatio <= 0) continue;
      if (Math.abs((entry.data.aspectRatio ?? 0) - change.aspectRatio) < 0.0001) continue;
      nextData = { ...entry.data, aspectRatio: change.aspectRatio };
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
    groups: state.groups,
    assetNodes: nodes.asset,
    genNodes: nodes.gen.map(node => node.kind === "image" && node.imageGeneration ? {
      ...node,
      imageGeneration: {
        ...node.imageGeneration,
        results: node.imageGeneration.results.map(result => {
          const persisted = { ...result };
          delete persisted.previewSrc;
          return persisted;
        }),
      },
    } : node),
    screenplayNodes: nodes.screenplay,
    videoClipNodes: nodes.videoClip,
    ...(nodes.director.length ? { directorNodes: nodes.director } : {}),
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

interface NormalizedCanvasDocument {
  readonly groups: CanvasGroups;
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

  // 已下线的节点类型（爆款复刻 / 视频下载 / 视频抽帧 / 视频拼接与合成）不在这张表里，
  // 因此旧文档里的这些数组连同指向它们的连线会被整体丢弃，不做兼容读取。
  const nodeGroups: readonly [CanvasNodeType, readonly unknown[]][] = [
    ["asset", value["assetNodes"] as readonly unknown[]],
    ["gen", value["genNodes"] as readonly unknown[]],
    ["screenplay", Array.isArray(value["screenplayNodes"]) ? value["screenplayNodes"] : []],
    ["videoClip", Array.isArray(value["videoClipNodes"]) ? value["videoClipNodes"] : []],
    ["director", Array.isArray(value["directorNodes"]) ? value["directorNodes"] : []],
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
      const directorScene = type === "director" ? decodeDirectorScene(rawNode["scene"]) : null;
      if (type === "director" && !directorScene) {
        issues.push("导演台场景格式无法读取：" + key);
        continue;
      }
      const data =
        type === "output"
          ? ({ ...rawNode, previewSrc: null } as unknown as CanvasNodeData)
          : type === "director" ? ({
            ...rawNode, kind: "director",
            name: typeof rawNode["name"] === "string" && rawNode["name"].trim() ? rawNode["name"] : "导演台",
            prompt: typeof rawNode["prompt"] === "string" ? rawNode["prompt"] : "",
            scene: directorScene!,
            panoramaKey: typeof rawNode["panoramaKey"] === "string" ? rawNode["panoramaKey"] : null,
            previewUrl: typeof rawNode["previewUrl"] === "string" ? rawNode["previewUrl"] : null,
          } as unknown as DirectorNodeData)
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
  return {
    ok: true,
    document: {
      nodesById,
      edges,
      view,
      promptContents,
      warnings,
      groups: decodeCanvasGroups(value["groups"], nodesById),
    },
  };
}

export function isSupportedConnection(source: CanvasNodeEntry, target: CanvasNodeEntry): boolean {
  if (target.type === "director") {
    return (source.type === "asset" && source.data.kind === "image" && !source.data.libraryResource) ||
      (source.type === "gen" && source.data.kind === "image") ||
      (source.type === "output" && source.data.mediaType === "image");
  }
  if (source.type === "director") {
    return target.type === "asset" && target.data.kind !== "audio" && !target.data.libraryResource;
  }
  if (target.type === "asset" && target.data.libraryResource) return false;
  if (source.type === "asset" && source.data.libraryResource) {
    return target.type === "gen" && (source.data.libraryResource.kind === "style"
      ? target.data.kind === "image" && target.data.config.imageMode !== "upscale"
      : target.data.kind === "video");
  }
  return source.data.key !== target.data.key;
}

type CanvasConnectionGraph = Pick<CanvasStoreState, "nodesById" | "assetEdges" | "selectedEdgeId">;

/** Validate a connection before changing the graph or its prompt documents. */
export function planCanvasConnection(
  state: CanvasStoreState,
  fromKey: string,
  toKey: string,
  replace?: AssetEdgeData,
): { readonly result: CanvasConnectResult; readonly graph: CanvasConnectionGraph } {
  const rejected = (reason: Extract<CanvasConnectResult, { status: "rejected" }>["reason"]) => ({
    result: { status: "rejected" as const, reason }, graph: state,
  });
  if (fromKey === toKey) return rejected("same-node");
  const source = state.nodesById[fromKey];
  const target = state.nodesById[toKey];
  if (!source) return rejected("missing-source");
  if (!target) return rejected("missing-target");
  if (!isSupportedConnection(source, target)) return rejected("unsupported-connection");
  if (replace && (replace.toKey !== toKey || !state.assetEdges.includes(replace))) return rejected("missing-source");

  const edge = { id: fromKey + "->" + toKey, fromKey, toKey };
  if (state.assetEdges.some(item => item.id === edge.id)) {
    return { result: { status: "unchanged", edgeId: edge.id }, graph: state };
  }
  let nodesById = state.nodesById;
  if (isGenerationMediaConsumer(target) && (replace || generationSourceOccupiesInputSlot(source))) {
    const currentSlots = target.data.config.inputSlots ?? [];
    const incoming = state.assetEdges.filter(item => item.toKey === toKey);
    const occupyingKeys = occupyingGenerationInputKeys(incoming, key => state.nodesById[key]);
    let slots = adoptMissingGenerationInputSlots(currentSlots, occupyingKeys);
    if (replace) {
      if (!slots.includes(replace.fromKey)) {
        // Generated inputs from older documents may have a visible rank but no ledger entry.
        const orderedKeys = canvasReadModelOfState(state).resolveInputs(toKey).media.map(input => input.sourceKey);
        slots = adoptMissingGenerationInputSlots(slots, orderedKeys);
      }
      slots = slots.map(key => key === replace.fromKey ? fromKey : key === fromKey ? null : key);
    } else {
      slots = assignGenerationInputSlot(slots, fromKey);
    }
    nodesById = { ...nodesById, [toKey]: withGenerationInputSlots(target, slots) };
  }
  return {
    result: { status: "connected", edge, replacedEdgeIds: replace ? [replace.id] : [] },
    graph: {
      nodesById,
      assetEdges: replace ? state.assetEdges.map(item => item === replace ? edge : item) : [...state.assetEdges, edge],
      selectedEdgeId: replace && state.selectedEdgeId === replace.id ? null : state.selectedEdgeId,
    },
  };
}

/** 历史栈上限：超出后丢弃最旧记录，防止长会话内存无界增长。 */
const CANVAS_HISTORY_LIMIT = 200;
/**
 * 撤销记录的时间窗：窗口内紧随上一条记录的连续写入折叠成一条补记录。
 * 跑批逐行落卡等高频写入至多每窗口两条记录，撤销步长按窗口粒度合并。
 */
const CANVAS_HISTORY_COALESCING_WINDOW_MS = 500;

function createCanvasStore(initialZoom = 100): {
  store: CanvasStore;
  flushPendingHistory: () => void;
  cancelPendingHistory: () => void;
} {
  // 同一同步批次内的多次写入（如清空画布会连写六类节点与连线）合并为一条历史，
  // 一次用户操作对应一步撤销；跨 await 的写入天然分批。
  let coalescingHistory = false;
  // RF 的尺寸回存与选中同步是被动测量/视图态，不是用户操作：置位时跳过历史记录。
  let suppressHistory = false;
  // 时间窗合帧：紧随上一条记录的连续写入（跑批逐行落卡、批量粘贴回存等）不再逐条
  // 入栈，而是按窗口折叠——首条写入立即入栈（保持离散操作一步撤销），窗口内的后续
  // 写入只在窗口收口时补一条「窗口起点」快照。跑批的高频写入因此至多每窗口产生
  // 两条记录，不再把撤销栈灌满中间态、也不再 pin 住大批旧节点对象。
  /*
   * 当前折叠窗口的起点时间。
   *
   * 窗口的计时基准必须是「**首次包裹写入**的时刻」。之前用的是
   * 「上一次非包裹写入」的时间：它只在用户命令时更新，而连续打字全在包裹期里，
   * 于是闲置后第一次打字算出的延时是 `max(0, 过期时间 + 窗口 - 现在) = 0`
   * → 定时器立刻收口 → **第一击单独成一条撤销记录**，第二次起才折叠。
   * 结果是「一次撤销退一段」没达成，还多占一条撤销栈。
   */
  let pendingHistoryStartedAt: number | null = null;
  let pendingHistoryPast: CanvasHistoryState | null = null;
  let pendingHistoryCurrent: CanvasHistoryState | null = null;
  let historyFlushTimer: ReturnType<typeof setTimeout> | null = null;
  let pushHistoryRecord: ((past: CanvasHistoryState) => void) | null = null;
  // >0 表示正处于机器写入包裹期（runWithCoalescedHistory）：写入走时间窗折叠；
  // 未包裹的写入一律立即入栈，用户命令保持一步一记录。
  let transientHistoryDepth = 0;

  /** 收口：把窗口内折叠的「窗口起点」快照补进撤销栈。查询/撤销前调用保证一致性。 */
  const flushPendingHistory = () => {
    if (historyFlushTimer !== null) {
      clearTimeout(historyFlushTimer);
      historyFlushTimer = null;
    }
    const pendingPast = pendingHistoryPast;
    const pendingCurrent = pendingHistoryCurrent;
    pendingHistoryPast = null;
    pendingHistoryCurrent = null;
    pendingHistoryStartedAt = null;
    if (pendingPast == null || pushHistoryRecord == null) return;
    // 窗口内的写入最终把状态改回窗口起点时，补记录只是空步骤，跳过。
    if (
      pendingCurrent != null &&
      pendingPast.groups === pendingCurrent.groups &&
      pendingPast.nodesById === pendingCurrent.nodesById &&
      pendingPast.assetEdges === pendingCurrent.assetEdges
    ) {
      return;
    }
    pushHistoryRecord(pendingPast);
  };
  /** 丢弃未收口的折叠记录：restore/clear 会整体重建历史，旧快照不能迟于清空入栈。 */
  const cancelPendingHistory = () => {
    if (historyFlushTimer !== null) {
      clearTimeout(historyFlushTimer);
      historyFlushTimer = null;
    }
    pendingHistoryPast = null;
    pendingHistoryCurrent = null;
    pendingHistoryStartedAt = null;
  };

  const canvasStore = createStore<CanvasStoreState>()(
    // UState 显式钉为历史切片：zundo 对 handleSet 里 currentState 的推断在
    // 本调用形态下会落到错误候选（boolean），显式泛型保证窄订阅类型正确。
    temporal<CanvasStoreState, [], [], CanvasHistoryState>(
      (set, _get, api) => {
        const temporalStore = api.temporal as CanvasStore["temporal"];
        return {
          groups: EMPTY_CANVAS_GROUPS,
          promptDocuments: EMPTY_PROMPT_DOCUMENTS,
          setPromptDocuments: (documents) => {
            set({ promptDocuments: documents });
          },
          commitPromptReferenceChange: (graph, documents) => {
            const { groups, nodesById, assetEdges, promptDocuments } = _get();
            const wasCoalescing = coalescingHistory;
            // Restoring the document can synchronously update a text node's mirrored prompt.
            // Record the state before both writes, including a swap that only changes the document.
            coalescingHistory = true;
            try {
              set({
                nodesById: graph.nodesById,
                assetEdges: graph.assetEdges,
                selectedEdgeId: graph.selectedEdgeId,
                promptDocuments: documents,
              });
            } finally {
              coalescingHistory = wasCoalescing;
            }
            cancelPendingHistory();
            pushHistoryRecord?.({ groups, nodesById, assetEdges, promptDocuments });
          },
          groupNodes: (keys, groupId, layout) => {
            let result: CanvasWriteResult = "unchanged";
            set((state) => {
              if (!groupId || state.groups[groupId]) return state;
              const nodesById = regroupCanvasNodes(state.nodesById, keys, groupId);
              if (nodesById == null) return state;
              result = "applied";
              const grouped = layout
                ? applyCanvasStoreNodeChanges({ ...state, nodesById }, layout.positions).nodesById ?? nodesById
                : nodesById;
              const groups = layout ? { ...state.groups, [groupId]: layout.group } : state.groups;
              return { nodesById: grouped, groups: reconcileCanvasGroups(groups, grouped) };
            });
            return result;
          },
          dissolveGroup: (groupId) => {
            let result: CanvasWriteResult = "unchanged";
            set((state) => {
              const nodesById = dissolveCanvasGroup(state.nodesById, groupId);
              if (nodesById == null) return state;
              result = "applied";
              return { nodesById, groups: reconcileCanvasGroups(state.groups, nodesById) };
            });
            return result;
          },
          updateGroup: (groupId, patch) => {
            let result: CanvasWriteResult = "missing";
            set((state) => {
              const current = state.groups[groupId];
              if (!current) return state;
              const requestedName = patch.name?.trim();
              const next = {
                ...current,
                ...patch,
                name: requestedName ? requestedName : current.name,
              };
              result = "unchanged";
              if (next.name === current.name && next.collapsed === current.collapsed) return state;
              result = "applied";
              return { groups: { ...state.groups, [groupId]: next } };
            });
            return result;
          },
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
                groups: reconcileCanvasGroups(
                  options?.groups ? { ...state.groups, ...options.groups } : state.groups,
                  nodesById,
                ),
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
                typeof nodeOrFactory === "function"
                  ? nodeOrFactory(outputs, state.nodesById)
                  : nodeOrFactory;
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
          patchNode: (type, key, update, promptDocuments) => {
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
              /*
               * 提示词快照与节点写入**同批**落下：zundo 记录的是 set 之前的完整
               * state，两者在同一次 set 里更新，历史里才同时带着「旧节点」与
               * 「旧快照」—— 撤销才拿得到真正的上一步（见类型上的说明）。
               */
              return {
                nodesById: replaceTypeNodes(state.nodesById, type, nextSiblings),
                ...(promptDocuments != null ? { promptDocuments } : {}),
              };
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
              /*
               * 组解散分支也要标记：末位成员清掉 assetGroupId 是就地改写在
               * replaceTypeNodes 返回的那个对象上，而那份投影缓存记的仍是组解散前
               * 的内容。不复制一层的话，节点投影仍带 assetGroupId——组框已经没了，
               * 成员却继续按组员渲染并被组框成员列表收录，而且没有任何后续写入会自愈。
               */
              let groupDissolved = false;
              if (entry.data.assetGroupId) {
                const remaining = Object.values(nodesById).filter(
                  (candidate) => candidate.data.assetGroupId === entry.data.assetGroupId,
                );
                if (remaining.length === 1) {
                  const last = remaining[0]!;
                  const { assetGroupId, ...data } = last.data;
                  void assetGroupId;
                  Object.assign(nodesById, { [data.key]: { ...last, data } as CanvasNodeEntry });
                  groupDissolved = true;
                }
              }
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
                 * 槽位是就地清在新对象上的，那份投影缓存已不代表它的内容；
                 * 组解散同样就地改了末位成员（清掉 assetGroupId），缓存也不代表内容。
                 * 两种情况都要清理过时再复制一层，让下游按新对象重算。
                 */
                nodesById: slotsPruned || groupDissolved ? { ...nodesById } : nodesById,
                groups: reconcileCanvasGroups(state.groups, nodesById),
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
            const plan = planCanvasConnection(_get(), fromKey, toKey);
            if (plan.result.status === "connected") set(plan.graph);
            return plan.result;
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
                Object.keys(state.groups).length === 0 &&
                state.assetEdges.length === 0 &&
                state.selectedNodeKey == null &&
                state.selectedEdgeId == null
              ) {
                return state;
              }
              return {
                groups: EMPTY_CANVAS_GROUPS,
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
                const next = applyCanvasStoreNodeChanges(
                  state,
                  expandCanvasGroupPositionChanges(state.nodesById, changes),
                );
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
                groups: restored.groups,
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
            // 恢复整体重建历史：丢弃未收口的折叠记录，避免旧快照迟于清空入栈。
            cancelPendingHistory();
            temporalStore.getState().clear();
            return {
              ok: true,
              promptContents: restored.promptContents,
              view: restored.view,
              warnings: restored.warnings,
            };
          },
          undo: () => {
            // 先收口折叠窗口：窗口内的写入也要成为可撤销的一步。
            flushPendingHistory();
            if (temporalStore.getState().pastStates.length === 0) return "unchanged";
            temporalStore.getState().undo();
            return "applied";
          },
          redo: () => {
            flushPendingHistory();
            if (temporalStore.getState().futureStates.length === 0) return "unchanged";
            temporalStore.getState().redo();
            return "applied";
          },
          runWithCoalescedHistory: <T,>(fn: () => T): T => {
            transientHistoryDepth += 1;
            try {
              return fn();
            } finally {
              transientHistoryDepth -= 1;
            }
          },
        };
      },
      {
        partialize: (state): CanvasHistoryState => ({
          groups: state.groups,
          nodesById: state.nodesById,
          assetEdges: state.assetEdges,
          /*
           * 提示词 canonical 快照必须进历史切片。
           *
           * zundo 的 `pastState` 取的是 **`partialize(get())` 的结果**（不是完整
           * state）—— 也就是说 `partialize` 决定了「历史里存哪些字段」。不加
           * 这一项，历史里就没有 canonical，撤销只能靠纯文本镜像回灌（有损：
           * 附件与 @引用会丢，块结构与行内 marks 会被压平）。
           *
           * 撤销时 zundo 用 `userSet(nextState)` 把这份切片合并回 store，
           * 所以 `promptDocuments` 会随撤销一起恢复 ✓。
           */
          promptDocuments: state.promptDocuments,
        }),
        // 各动作已保证"无变化返回原引用"，引用相等即可精确判断是否产生历史。
        // 普通快照只镜像 canonical。显式引用替换由命令记录完整的撤销快照。
        equality: (past, current) =>
          past.groups === current.groups &&
          past.nodesById === current.nodesById &&
          past.assetEdges === current.assetEdges,
        limit: CANVAS_HISTORY_LIMIT,
        handleSet: (handleSet) => {
          // zundo 的无 diff 配置只把 pastState（变更前部分化快照）入栈；
          // 这里收敛成单参入口，供 leading 记录与窗口收口共用。
          pushHistoryRecord = (past) => {
            (handleSet as unknown as (past: CanvasHistoryState) => void)(past);
          };
          // 注意形参位置：第二位是 zundo 的 replace 标记（boolean），必须占位，
          //currentState 才是第三个参数（部分化后的历史切片）。
          return (rawPastState, _replace, currentState) => {
            if (coalescingHistory || suppressHistory) return;
            // zundo 的参数类型照抄 setState 首参（含函数分支），运行时这里始终是状态对象。
            const pastState = rawPastState as CanvasStoreState;
            if (transientHistoryDepth === 0) {
              // 非包裹写入（用户命令等）：立即入栈。守卫保持到微任务边界——
              // 同一同步批次内的多次写入（如清空画布连写六类节点、批量删除逐个
              // removeNode）仍合并为一条记录，一次用户操作对应一步撤销。
              cancelPendingHistory();
              coalescingHistory = true;
              pushHistoryRecord?.(pastState);
              queueMicrotask(() => {
                coalescingHistory = false;
              });
              return;
            }
            // 包裹期写入走时间窗：保留最早的「变更前」快照与最新状态，收口时补一条记录。
            pendingHistoryPast ??= pastState;
            pendingHistoryCurrent = currentState;
            // 窗口起点 = 首次包裹写入的时刻（见 pendingHistoryStartedAt 的说明）。
            pendingHistoryStartedAt ??= Date.now();
            historyFlushTimer ??= setTimeout(
              () => {
                historyFlushTimer = null;
                flushPendingHistory();
              },
              Math.max(
                0,
                (pendingHistoryStartedAt ?? Date.now()) +
                  CANVAS_HISTORY_COALESCING_WINDOW_MS -
                  Date.now(),
              ),
            );
          };
        },
      },
    ),
  );
  // 用户命令与被动写入要能被落盘层区分：suppressHistory 标记被动测量（尺寸回存、
  // 选中同步），transientHistoryDepth 标记机器批写，两者都继续按防抖窗口落盘。
  const store: CanvasStore = Object.assign(canvasStore, {
    lastWriteWasUserCommand: () => !suppressHistory && transientHistoryDepth === 0,
  });
  return { store, flushPendingHistory, cancelPendingHistory };
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
  const { store, flushPendingHistory } = createCanvasStore(initialZoom);
  const commands: CanvasCommands = {
    groupNodes: (keys, groupId, layout) => store.getState().groupNodes(keys, groupId, layout),
    dissolveGroup: (groupId) => store.getState().dissolveGroup(groupId),
    updateGroup: (groupId, patch) => store.getState().updateGroup(groupId, patch),
    insertSubgraph: (nodes, edges, options) =>
      store.getState().insertSubgraph(nodes, edges, options),
    addNode: (type, node, options) => store.getState().addNode(type, node, options),
    addOutput: (node) => store.getState().addOutput(node),
    patchNode: (type, key, update, promptDocuments) =>
      store.getState().patchNode(type, key, update, promptDocuments),
    patchNodes: (type, update) => store.getState().patchNodes(type, update),
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
    restoreDocument: (document) => store.getState().restoreDocument(document),
    undo: () => store.getState().undo(),
    redo: () => store.getState().redo(),
    runWithCoalescedHistory: (fn) => store.getState().runWithCoalescedHistory(fn),
  };
  return {
    store,
    commands,
    getSnapshot: () => canvasReadModel(store.getState()),
    getHistory: () => {
      // 查询前收口折叠窗口，让撤销计数与即将发生的 undo 语义一致。
      flushPendingHistory();
      return historySummary(store);
    },
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

/** 渲染无关的 store 订阅入口。非活跃画布冻结渲染后，保存调度等后台职责从这里走。 */
export function useCanvasStore(): CanvasStore {
  const canvas = useContext(CanvasStoreContext);
  if (canvas == null) throw new Error("useCanvasStore must be used within CanvasStoreProvider");
  return canvas.store;
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

/**
 * 单节点条目订阅：节点卡片等 per-node 订阅者组件的切片入口。zustand 以 Object.is
 * 比较选中值，因此只有该节点自身的条目被整体替换时订阅者才重渲染；其余节点的
 * 写入、视图/选区/连线变化都不触发。key 不存在时返回 undefined。
 */
export function useCanvasNodeEntry(key: string): CanvasNodeEntry | undefined {
  const canvas = useContext(CanvasStoreContext);
  if (canvas == null) throw new Error("useCanvasNodeEntry must be used within CanvasStoreProvider");
  return useStore(canvas.store, (state) => state.nodesById[key]);
}

const subscribeNothing = () => () => {};
const snapshotNull = () => null;

/**
 * 可空的成员规模订阅：返回当前画布节点总数（无上下文时 null）。总数只在
 * 节点增删时变化，内容补丁与拖拽不触发，适合作为「节点集合已变化、需要
 * 重新识别文本中的节点代号」的低频信号。
 */
export function useOptionalCanvasNodeMembership(): number | null {
  const canvas = useContext(CanvasStoreContext);
  return useSyncExternalStore(
    canvas ? canvas.subscribe : subscribeNothing,
    canvas ? () => Object.keys(canvas.store.getState().nodesById).length : snapshotNull,
    snapshotNull,
  );
}

/** 可空的 store 句柄读取（不订阅）：事件期判断某个 key 是否为当前画布节点时用。 */
export function useOptionalCanvasStore(): CanvasStore | null {
  const canvas = useContext(CanvasStoreContext);
  return canvas?.store ?? null;
}

/**
 * 一类节点的 key 列表订阅（浅比较）。节点内容补丁不改变成员集合，因此跑批等高频
 * 写入不会触发订阅层重渲染；只有该类型新增/删除节点时才返回新数组。
 */
export function useCanvasNodeKeys(type: CanvasNodeType): readonly string[] {
  const canvas = useContext(CanvasStoreContext);
  if (canvas == null) throw new Error("useCanvasNodeKeys must be used within CanvasStoreProvider");
  return useStore(
    canvas.store,
    useShallow(
      (state: CanvasStoreState) =>
        canvasNodeLists(state.nodesById)[type].map((node) => node.key) as readonly string[],
    ),
  );
}

/**
 * 画布里**全部**节点的 key（浅比较订阅）。
 *
 * 提示词内容的落盘快照需要知道「哪些节点持有提示词」。此前这靠**手工登记节点类型**
 * （gen + videoClip），而那份登记表与真正的注册点（`PromptMentionInput` 挂载处）
 * 没有任何编译期关联 —— 已经因此丢过两次提示词（智能剪辑漏一次、提示词节点漏一次），
 * 症状都是「排期与落盘都正常，但重开画布就丢」。
 *
 * 改成「画布里存在的节点 key」之后，登记表整个不需要了：新增节点类型天然被覆盖，
 * 也不可能再漏登记。
 */
export function useAllCanvasNodeKeys(): readonly string[] {
  const canvas = useContext(CanvasStoreContext);
  if (canvas == null) throw new Error("useAllCanvasNodeKeys must be used within CanvasStoreProvider");
  return useStore(
    canvas.store,
    useShallow((state: CanvasStoreState) => Object.keys(state.nodesById)),
  );
}

/**
 * 非响应式读取一类节点的有序列表：布局指纹变化后，节点层用它从当前 store 快照重建
 * 外壳数组。订阅仍由 useCanvasNodeKeys / 布局指纹负责，这里只做事件期读取。
 */
export function canvasNodesOfState<K extends CanvasNodeType>(
  state: { readonly nodesById: CanvasNodesById },
  type: K,
): readonly CanvasNodesByType[K][] {
  return canvasNodeLists(state.nodesById)[type] as readonly CanvasNodesByType[K][];
}

/** 非响应式把原始 store state 折算成读模型（带缓存）；事件期/指纹变更期快照读取用。 */
export function canvasReadModelOfState(state: CanvasStoreState): CanvasReadModel {
  return canvasReadModel(state);
}
