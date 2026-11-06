import type { CanvasDocument, CanvasNodeEntry, CanvasNodesByKey } from "../canvas/canvasStore";
import {
  adoptMissingGenerationInputSlots,
  occupyingGenerationInputKeys,
} from "../canvas/generationInputSlots";
import { stripMarkdown } from "../../lib/promptContent";
import { canvasStoryboardPreset } from "../../lib/canvasImagePresets";
import { imageNodePreview } from "./imageNodeResults";
import type { ConnectedLibraryResource } from "./canvasLibraryResources";
import {
  assetGenerationInput,
  outputGenerationInput,
  type AssetEdgeData,
  type GenerationMediaInput,
  type OutputNodeData,
} from "./workspaceModel";

/** edgeId is the removable edge entering the consumer, even for a relayed source. */
export interface ConnectedCanvasMediaInput extends GenerationMediaInput {
  readonly sourceKey: string;
  readonly edgeId: string;
  readonly sourceLabel: "素材" | "产物";
  readonly src: string | null;
  readonly finalPath: string | null;
  /**
   * 该素材在目标生成节点槽位表里的位置（0 起）；非生成节点或未记槽位的来源不带此字段。
   * 引用据此记住「自己占的是第几位」，换图回填空槽后可判断出是哪一处引用需要跟随。
   */
  readonly slotIndex?: number | undefined;
}

export interface ConnectedCanvasTextInput {
  readonly key: string;
  readonly sourceKey: string;
  readonly name: string;
  readonly text: string;
  readonly edgeId: string;
}

export function connectedCanvasPromptText(sources: readonly ConnectedCanvasTextInput[]): string {
  const combined = sources.map((source) => source.text).join("\n\n");
  return stripMarkdown(combined) || combined.trim();
}

export interface ResolvedCanvasInputs {
  readonly libraryResources: readonly ConnectedLibraryResource[];
  readonly media: readonly ConnectedCanvasMediaInput[];
  readonly texts: readonly ConnectedCanvasTextInput[];
  readonly pending: readonly {
    readonly sourceKey: string;
    readonly edgeId: string;
    readonly name: string;
  }[];
  /**
   * 目标生成节点的槽位表长度（含空槽）。媒体按槽位位置占位，中途被解绑/删除的素材
   * 留下空位：其余素材不整体前移，下次连线回填空槽。清单按此渲染空位行。
   */
  readonly mediaSlotCount: number;
  /** 直连素材在其槽位表里的位置（0 起）；非生成节点或未记槽位的素材不在此表内。 */
  readonly mediaPosition: ReadonlyMap<string, number>;
}

type OwnMedia = Omit<ConnectedCanvasMediaInput, "edgeId">;
type OwnText = Omit<ConnectedCanvasTextInput, "edgeId">;
interface NodePayload {
  readonly media: readonly OwnMedia[];
  readonly texts: readonly OwnText[];
}

export function canvasNodeIndex(entries: readonly CanvasNodeEntry[]): CanvasNodesByKey {
  return {
    asset: new Map(entries.flatMap((e) => (e.type === "asset" ? [[e.data.key, e.data]] : []))),
    gen: new Map(entries.flatMap((e) => (e.type === "gen" ? [[e.data.key, e.data]] : []))),
    screenplay: new Map(
      entries.flatMap((e) => (e.type === "screenplay" ? [[e.data.key, e.data]] : [])),
    ),
    videoClip: new Map(
      entries.flatMap((e) => (e.type === "videoClip" ? [[e.data.key, e.data]] : [])),
    ),
    director: new Map(entries.flatMap(e => e.type === "director" ? [[e.data.key, e.data]] : [])),
    result: new Map(entries.flatMap((e) => (e.type === "result" ? [[e.data.key, e.data]] : []))),
    output: new Map(entries.flatMap((e) => (e.type === "output" ? [[e.data.key, e.data]] : []))),
  };
}

export function canvasNodesByKeyFromDocument(document: CanvasDocument): CanvasNodesByKey {
  return {
    asset: new Map(document.assetNodes.map((n) => [n.key, n])),
    gen: new Map(document.genNodes.map((n) => [n.key, n])),
    screenplay: new Map((document.screenplayNodes ?? []).map((n) => [n.key, n])),
    videoClip: new Map((document.videoClipNodes ?? []).map((n) => [n.key, n])),
    director: new Map((document.directorNodes ?? []).map(n => [n.key, n])),
    result: new Map(document.resultNodes.map((n) => [n.key, n])),
    output: new Map((document.outputNodes ?? []).map((n) => [n.key, n])),
  };
}

function outputPayload(output: OutputNodeData): NodePayload {
  if (output.mediaType === "text") {
    const text = output.textContent?.trim() ?? "";
    return {
      media: [],
      texts: text
        ? [{ key: output.key, sourceKey: output.key, name: output.name ?? "文本产物", text }]
        : [],
    };
  }
  const input = outputGenerationInput(output);
  return {
    media: input
      ? [
          {
            ...input,
            sourceKey: output.key,
            sourceLabel: "产物",
            src: input.previewUrl ?? null,
            finalPath: output.finalPath,
          },
        ]
      : [],
    texts: [],
  };
}

export type CanvasInputResolver = (targetKey: string) => ResolvedCanvasInputs;
type ProducerPayloads = Map<string, Map<string, NodePayload[]>>;
interface InputSnapshot {
  readonly nodeByKey: CanvasNodesByKey;
  readonly edges: readonly AssetEdgeData[];
  readonly nodes: ReadonlyMap<string, CanvasNodeEntry>;
  readonly incoming: ReadonlyMap<string, readonly AssetEdgeData[]>;
  readonly outgoing: ReadonlyMap<string, ReadonlySet<string>>;
  readonly producerOutputs: ReadonlyMap<string, readonly OutputNodeData[]>;
  readonly outputsByProducer: ProducerPayloads;
  readonly ownPayloads: Map<string, NodePayload>;
  readonly resolved: Map<string, ResolvedCanvasInputs>;
  readonly resolve: CanvasInputResolver;
}

/** One owner per canvas. Returned resolvers remain immutable snapshots, including after undo. */
export function createCanvasInputResolverCache(): (
  nodes: CanvasNodesByKey,
  edges: readonly AssetEdgeData[],
) => CanvasInputResolver {
  const snapshots = new WeakMap<
    CanvasNodesByKey,
    WeakMap<readonly AssetEdgeData[], InputSnapshot>
  >();
  let previous: InputSnapshot | undefined;
  return (nodes, edges) => {
    let byEdges = snapshots.get(nodes);
    if (!byEdges) {
      byEdges = new WeakMap();
      snapshots.set(nodes, byEdges);
    }
    const snapshot = byEdges.get(edges) ?? buildInputSnapshot(nodes, edges, previous);
    byEdges.set(edges, snapshot);
    previous = snapshot;
    return snapshot.resolve;
  };
}

/**
 * One index per semantic graph snapshot; each target is resolved once. All node families relay
 * ordered inputs. Iterative traversal avoids stack overflow and visits each node at most once,
 * so diamonds and cycles cannot multiply payloads or feed the target's own data back into it.
 */
export function createCanvasInputResolver(
  nodeByKey: CanvasNodesByKey,
  edges: readonly AssetEdgeData[],
): CanvasInputResolver {
  return buildInputSnapshot(nodeByKey, edges).resolve;
}

function buildInputSnapshot(
  nodeByKey: CanvasNodesByKey,
  edges: readonly AssetEdgeData[],
  previous?: InputSnapshot,
): InputSnapshot {
  const changed = new Set<string>();
  const nodes = new Map(previous?.nodes);
  for (const type of Object.keys(nodeByKey) as (keyof CanvasNodesByKey)[]) {
    if (previous?.nodeByKey[type] === nodeByKey[type]) continue;
    for (const key of previous?.nodeByKey[type].keys() ?? []) {
      if (!nodeByKey[type].has(key)) {
        if (nodes.get(key)?.type === type) nodes.delete(key);
        changed.add(key);
      }
    }
    for (const [key, data] of nodeByKey[type]) {
      if (previous?.nodeByKey[type].get(key) === data) continue;
      nodes.set(key, { type, data } as CanvasNodeEntry);
      changed.add(key);
    }
  }
  let incoming = previous?.incoming;
  let outgoing = previous?.outgoing;
  if (!previous || previous.edges !== edges || previous.nodeByKey.output !== nodeByKey.output) {
    const nextIncoming = new Map<string, AssetEdgeData[]>();
    const nextOutgoing = new Map<string, Set<string>>();
    for (const edge of edges) {
      // Provenance is not a data dependency: selected outputs stay pinned to their own task.
      if (nodeByKey.output.get(edge.toKey)?.sourceNodeId === edge.fromKey) continue;
      const list = nextIncoming.get(edge.toKey) ?? [];
      list.push(edge);
      nextIncoming.set(edge.toKey, list);
      const targets = nextOutgoing.get(edge.fromKey) ?? new Set<string>();
      targets.add(edge.toKey);
      nextOutgoing.set(edge.fromKey, targets);
    }
    for (const key of new Set([...nextIncoming.keys(), ...(previous?.incoming.keys() ?? [])])) {
      const before = previous?.incoming.get(key) ?? [];
      const next = nextIncoming.get(key) ?? [];
      if (
        before.length !== next.length ||
        before.some(
          (edge, index) =>
            edge.id !== next[index]!.id ||
            edge.fromKey !== next[index]!.fromKey ||
            edge.toKey !== next[index]!.toKey,
        )
      )
        changed.add(key);
    }
    incoming = nextIncoming;
    outgoing = nextOutgoing;
  }
  let producerOutputs = previous?.producerOutputs;
  let outputsByProducer = previous?.outputsByProducer;
  if (!previous || previous.nodeByKey.output !== nodeByKey.output) {
    const groups = new Map<string, OutputNodeData[]>();
    for (const output of nodeByKey.output.values()) {
      const group = groups.get(output.sourceNodeId) ?? [];
      group.push(output);
      groups.set(output.sourceNodeId, group);
    }
    outputsByProducer = new Map(previous?.outputsByProducer);
    for (const producer of new Set([
      ...groups.keys(),
      ...(previous?.producerOutputs.keys() ?? []),
    ])) {
      const before = previous?.producerOutputs.get(producer) ?? [];
      const next = groups.get(producer) ?? [];
      if (before.length === next.length && before.every((output, index) => output === next[index]))
        continue;
      changed.add(producer);
      if (!next.length) {
        outputsByProducer.delete(producer);
        continue;
      }
      const tasks = new Map<string, NodePayload[]>();
      for (const output of next) {
        // First placeholder fixes task order, including empty or late-arriving output layers.
        const payloads = tasks.get(output.taskId) ?? [];
        const payload = outputPayload(output);
        if (payload.media.length || payload.texts.length) payloads.push(payload);
        tasks.set(output.taskId, payloads);
      }
      outputsByProducer.set(producer, tasks);
    }
    producerOutputs = groups;
  }
  const ownPayloads = new Map(previous?.ownPayloads);
  for (const key of changed) ownPayloads.delete(key);
  const affected = new Set(changed);
  const queue = [...changed];
  for (let index = 0; index < queue.length; index += 1) {
    const key = queue[index]!;
    for (const targets of [outgoing!.get(key), previous?.outgoing.get(key)]) {
      for (const target of targets ?? []) {
        if (affected.has(target)) continue;
        affected.add(target);
        queue.push(target);
      }
    }
  }
  const resolved = new Map(previous?.resolved);
  for (const key of affected) resolved.delete(key);
  const ownPayload = (entry: CanvasNodeEntry): NodePayload => {
    const key = entry.data.key;
    const cached = ownPayloads.get(key);
    if (cached) return cached;
    let payload: NodePayload = { media: [], texts: [] };
    if (entry.type === "asset") {
      payload = {
        media: [
          {
            ...assetGenerationInput(entry.data),
            sourceKey: key,
            sourceLabel: "素材",
            src: entry.data.videoUrl ?? entry.data.previewUrl,
            finalPath: null,
          },
        ],
        texts: [],
      };
    } else if (entry.type === "output") {
      payload = outputPayload(entry.data);
    } else if (entry.type === "gen" && entry.data.kind === "image" && entry.data.imageGeneration) {
      const output = imageNodePreview(entry.data);
      payload = output ? outputPayload(output) : payload;
    } else if (entry.type === "gen" && entry.data.kind === "prompt") {
      const text = entry.data.config.generatedPrompt.trim();
      payload = {
        media: [],
        texts: text
          ? [
              {
                key,
                sourceKey: key,
                name: "提示词节点",
                text,
              },
            ]
          : [],
      };
    } else if (entry.type === "screenplay") {
      const text = entry.data.config.currentDocument.trim();
      payload = {
        media: [],
        texts: text
          ? [
              {
                key,
                sourceKey: key,
                name: text.match(/^#+\s+(.+)$/m)?.[1] ?? "剧本节点",
                text,
              },
            ]
          : [],
      };
    }
    if (entry.type !== "asset" && entry.type !== "output" &&
        !(entry.type === "gen" && entry.data.kind === "image" && entry.data.imageGeneration)) {
      const latest =
        Array.from(outputsByProducer!.get(key)?.values() ?? [])
          .reverse()
          .find((outputs) => outputs.length > 0) ?? [];
      payload = {
        media: [...payload.media, ...latest.flatMap((p) => p.media)],
        texts: [...payload.texts, ...latest.flatMap((p) => p.texts)],
      };
    }
    ownPayloads.set(key, payload);
    return payload;
  };
  const resolve: CanvasInputResolver = (targetKey) => {
    const cached = resolved.get(targetKey);
    if (cached) return cached;
    const media: ConnectedCanvasMediaInput[] = [];
    const texts: ConnectedCanvasTextInput[] = [];
    const pending: { sourceKey: string; edgeId: string; name: string }[] = [];
    const libraryResources: ConnectedLibraryResource[] = [];
    const directEdges = incoming!.get(targetKey) ?? [];
    const target = nodeByKey.gen.get(targetKey);
    const useStoryboardFrames = target?.kind === "image" && target.config.imageMode !== "upscale"
      && canvasStoryboardPreset(target.config.imagePreset?.scene) != null;
    for (const edge of directEdges) {
      const source = nodes.get(edge.fromKey);
      if (source?.type === "asset" && source.data.libraryResource) {
        libraryResources.push({ edgeId: edge.id, name: source.data.name, resource: source.data.libraryResource });
      }
    }
    // 直连素材在槽位表里的位置（0 起）与槽位表长度：清单据此渲染稳定的位置编号与空位行。
    let mediaPosition = new Map<string, number>();
    let mediaSlotCount = 0;
    const seenNodes = new Set([targetKey]);
    const seenMedia = new Set([targetKey]);
    const seenTexts = new Set([targetKey]);
    const stack = directEdges
      .map((edge) => ({ key: edge.fromKey, edgeId: edge.id }))
      .reverse();
    while (stack.length) {
      const next = stack.pop()!;
      if (seenNodes.has(next.key)) continue;
      seenNodes.add(next.key);
      const entry = nodes.get(next.key);
      if (entry?.type === "asset" && entry.data.libraryResource) continue;
      const parents = incoming!.get(next.key) ?? [];
      const payload = entry ? ownPayload(entry) : { media: [], texts: [] };
      for (const item of payload.media) {
        if (seenMedia.has(item.sourceKey)) continue;
        seenMedia.add(item.sourceKey);
        media.push({ ...item, edgeId: next.edgeId });
      }
      for (const item of payload.texts) {
        if (seenTexts.has(item.sourceKey)) continue;
        seenTexts.add(item.sourceKey);
        texts.push({ ...item, edgeId: next.edgeId });
      }
      if (
        !payload.media.length &&
        !payload.texts.length &&
        (entry?.type !== "result" || !parents.length)
      ) {
        pending.push({
          sourceKey: next.key,
          edgeId: next.edgeId,
          name: entry?.type === "output" ? (entry.data.name ?? "待完成产物") : next.key,
        });
      }
      // 分镜引用已有图片节点时，节点产物就是参考画面。原任务的输入仍可另行直连。
      if (useStoryboardFrames && entry?.type === "gen" && entry.data.kind === "image"
        && payload.media.some(item => item.kind === "image")) continue;
      for (let i = parents.length - 1; i >= 0; i--) {
        stack.push({ key: parents[i]!.fromKey, edgeId: next.edgeId });
      }
    }
    // 链式连接时按源头优先排序：从目标节点出发，深度越大（越上游的源头）越靠前。
    // 例如 A → B → 生成节点，当前 DFS 会先收集 B 再收集 A，此处重排为 [A, B]。
    // 直连素材深度相同，相对顺序保持不变；直连素材的位置另有槽位账本，见下。
    const depthByKey = new Map<string, number>();
    const computeDepth = (key: string): number => {
      if (depthByKey.has(key)) return depthByKey.get(key)!;
      const active = new Set([key]);
      const stack = [{ key, cursor: 0, maximum: 0 }];
      while (stack.length) {
        const current = stack.at(-1)!;
        const parents = incoming!.get(current.key) ?? [];
        if (current.cursor < parents.length) {
          const parent = parents[current.cursor++]!.fromKey;
          const known = depthByKey.get(parent);
          if (known !== undefined) current.maximum = Math.max(current.maximum, known);
          else if (!active.has(parent)) {
            active.add(parent);
            stack.push({ key: parent, cursor: 0, maximum: 0 });
          }
        } else {
          const depth = current.maximum + 1;
          depthByKey.set(current.key, depth);
          active.delete(current.key);
          stack.pop();
          if (stack.length) stack.at(-1)!.maximum = Math.max(stack.at(-1)!.maximum, depth);
        }
      }
      return depthByKey.get(key)!;
    };
    media.sort((a, b) => computeDepth(b.sourceKey) - computeDepth(a.sourceKey));
    // 生成节点（图片/视频）若配置了 inputSlots，则直连素材按槽位位置落座：
    // 槽位是这份清单的位置账本，被解绑/删除的素材留下空槽（null），其余素材不整体前移，
    // 新连线回填空槽后拿回原来的位置。素材数组保持同一顺序，空槽不占位，
    // 渲染层再按 mediaPosition 逐行展开，把空槽显示为空位行。
    // 槽位表可能残留指向已删除节点/已解绑素材的 key：它们不出现在本次素材里，直接跳过。
    // 已经连上却没入账的直连来源（拖线建节点的旧文档）按连线先后插回槽位，避免后连的图抢走顺序 1。
    const targetEntry = nodes.get(targetKey);
    const targetSlots =
      targetEntry?.type === "gen" &&
      (targetEntry.data.kind === "image" || targetEntry.data.kind === "video")
        ? targetEntry.data.config.inputSlots
        : undefined;
    if (targetSlots && targetSlots.length > 0) {
      const occupyingKeys = occupyingGenerationInputKeys(incoming!.get(targetKey) ?? [], (key) =>
        nodes.get(key),
      );
      const effectiveSlots = adoptMissingGenerationInputSlots(targetSlots, occupyingKeys);
      const present = new Set(media.map((item) => item.sourceKey));
      const positionByKey = new Map<string, number>();
      // 同一素材 key 重复占位时以第一个槽位为准，避免后一个槽位覆盖真实位置。
      effectiveSlots.forEach((slot, index) => {
        if (slot === null || !present.has(slot) || positionByKey.has(slot)) return;
        positionByKey.set(slot, index);
      });
      mediaPosition = positionByKey;
      mediaSlotCount = effectiveSlots.length;
      if (positionByKey.size > 0) {
        // 素材顺序也按槽位位置排：位置编号与提交顺序（请求体里的「图片N」）一一对应，
        // 不会出现清单上第 2 行的素材实际是第 1 个提交。空槽不参与排序，其余保持既有前后关系。
        const rankByKey = new Map<string, number>();
        effectiveSlots.forEach((slot) => {
          if (slot === null || !positionByKey.has(slot) || rankByKey.has(slot)) return;
          rankByKey.set(slot, rankByKey.size);
        });
        const orderByIndex = new Map(media.map((item, index) => [item.sourceKey, index]));
        media.sort((left, right) => {
          const leftRank = rankByKey.get(left.sourceKey);
          const rightRank = rankByKey.get(right.sourceKey);
          if (leftRank == null && rightRank == null) {
            return (
              (orderByIndex.get(left.sourceKey) ?? 0) - (orderByIndex.get(right.sourceKey) ?? 0)
            );
          }
          if (leftRank == null) return 1;
          if (rightRank == null) return -1;
          return leftRank - rightRank;
        });
        // 位置随素材一路带下去：提示词引用据此记住自己占的是第几位。
        for (let index = 0; index < media.length; index += 1) {
          const position = positionByKey.get(media[index]!.sourceKey);
          if (position == null) continue;
          media[index] = { ...media[index]!, slotIndex: position };
        }
      }
    }
    const result = { media, texts, pending, mediaSlotCount, mediaPosition, libraryResources };
    resolved.set(targetKey, result);
    return result;
  };
  return {
    nodeByKey,
    edges,
    nodes,
    incoming: incoming!,
    outgoing: outgoing!,
    producerOutputs: producerOutputs!,
    outputsByProducer: outputsByProducer!,
    ownPayloads,
    resolved,
    resolve,
  };
}

/**
 * 目标节点输入清单里每条输入的归属连线，按清单顺序去重。
 *
 * 同一连线可以承载多条输入：中转素材与随提示词继承的素材都记在进入目标的这条连线上，
 * 这里取它首次出现的位置。解析结果里没有出现的连线（例如上游还没有可用结果）按调用方
 * 给出的原始连线顺序接在末尾，保证每条进入目标的连线都拿到唯一且连续的序号。
 *
 * 直连素材按槽位位置排序：空槽不出现在清单里，序号也随之连续；但同一条连线在
 * 「解绑再重连」「槽位留空后回填」之后仍然拿到与节点清单一致的位置，不会与清单错位。
 */
export function canvasInputEdgeOrder(
  resolved: ResolvedCanvasInputs,
  fallbackEdgeIds: readonly string[],
): readonly string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  const collect = (edgeId: string) => {
    if (seen.has(edgeId)) return;
    seen.add(edgeId);
    ordered.push(edgeId);
  };
  const mediaByPosition = resolved.media
    .map((input, index) => ({ input, index }))
    .sort((left, right) => {
      const leftPosition = resolved.mediaPosition.get(left.input.sourceKey) ?? left.index;
      const rightPosition = resolved.mediaPosition.get(right.input.sourceKey) ?? right.index;
      return leftPosition - rightPosition;
    })
    .map((entry) => entry.input);
  for (const input of mediaByPosition) collect(input.edgeId);
  for (const input of resolved.texts) collect(input.edgeId);
  for (const input of resolved.pending) collect(input.edgeId);
  for (const edgeId of fallbackEdgeIds) collect(edgeId);
  return ordered;
}
