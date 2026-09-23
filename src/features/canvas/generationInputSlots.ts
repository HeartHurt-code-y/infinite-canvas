import type { AssetEdgeData, GenNodeData } from "../workspace/workspaceModel";
import type { CanvasNodeEntry } from "./canvasStore";

type GenerationMediaConsumerEntry = {
  readonly type: "gen";
  readonly data: Extract<GenNodeData, { kind: "image" | "video" }>;
};

/**
 * 图片/视频生成节点才维护媒体槽位账本。提示词节点只转发文本与继承素材，不占位置。
 */
export function isGenerationMediaConsumer(
  entry: CanvasNodeEntry,
): entry is GenerationMediaConsumerEntry {
  return entry.type === "gen" && (entry.data.kind === "image" || entry.data.kind === "video");
}

/**
 * 能给生成节点贡献直连媒体的来源才占槽位。提示词/剧本/分镜只送文本或中转，
 * 让它们占槽会在参考清单里凭空多出空位，也会打乱图片编号。
 */
export function generationSourceOccupiesInputSlot(source: CanvasNodeEntry): boolean {
  return source.type !== "gen" && source.type !== "screenplay" && source.type !== "storyboard";
}

/** 进入目标的直连媒体来源，按连线数组先后去重。 */
export function occupyingGenerationInputKeys(
  incoming: readonly Pick<AssetEdgeData, "fromKey">[],
  getNode: (key: string) => CanvasNodeEntry | undefined,
): readonly string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const edge of incoming) {
    if (seen.has(edge.fromKey)) continue;
    const source = getNode(edge.fromKey);
    if (!source || !generationSourceOccupiesInputSlot(source)) continue;
    seen.add(edge.fromKey);
    keys.push(edge.fromKey);
  }
  return keys;
}

/**
 * 新连线填最小空槽，没有空槽则追加。已在账本里的来源保持原位，避免重复占槽。
 */
export function assignGenerationInputSlot(
  slots: readonly (string | null)[],
  fromKey: string,
): readonly (string | null)[] {
  if (slots.includes(fromKey)) return slots;
  const emptyIndex = slots.findIndex((slot) => slot === null);
  if (emptyIndex < 0) return [...slots, fromKey];
  const next = [...slots];
  next[emptyIndex] = fromKey;
  return next;
}

/**
 * 把已经连上、却没写进槽位表的来源按连线先后插回去。
 *
 * 拖线到空白建节点的那条线曾经不写槽位；随后 connect 的图会占槽位 0，
 * 先连上的图变成「无槽位」被挤到最后。这里不填 reserved 的 null 空槽——
 * 那些空位是解绑留下的位置，缺账的旧连线只按它在连线数组里相对已入账来源的前后插入。
 */
export function adoptMissingGenerationInputSlots(
  slots: readonly (string | null)[],
  connectedKeysInOrder: readonly string[],
): readonly (string | null)[] {
  if (connectedKeysInOrder.every((key) => slots.includes(key))) return slots;
  const next = [...slots];
  for (const key of connectedKeysInOrder) {
    if (next.includes(key)) continue;
    let insertAt = 0;
    for (const previous of connectedKeysInOrder) {
      if (previous === key) break;
      const index = next.indexOf(previous);
      if (index >= 0) insertAt = index + 1;
    }
    next.splice(insertAt, 0, key);
  }
  return next;
}

/**
 * 把一个已连的直连素材移到另一个素材原来的序号，中间素材依次让位。
 * null 空位仍留在原槽位，后续新连线继续按原规则填回空位。
 */
export function reorderGenerationInputSlots(
  slots: readonly (string | null)[],
  connectedKeysInOrder: readonly string[],
  sourceKey: string,
  targetKey: string,
): readonly (string | null)[] {
  if (sourceKey === targetKey) return slots;
  const connected = new Set(connectedKeysInOrder);
  if (!connected.has(sourceKey) || !connected.has(targetKey)) return slots;
  const healed = adoptMissingGenerationInputSlots(slots, connectedKeysInOrder);
  const seen = new Set<string>();
  const normalized = healed.map((slot) => {
    if (slot === null || !connected.has(slot) || seen.has(slot)) return null;
    seen.add(slot);
    return slot;
  });
  const occupied = normalized.flatMap((slot, index) => (slot === null ? [] : [index]));
  const order = occupied.map((index) => normalized[index]!);
  const from = order.indexOf(sourceKey);
  const to = order.indexOf(targetKey);
  if (from < 0 || to < 0) return slots;
  order.splice(from, 1);
  order.splice(to, 0, sourceKey);
  const next = [...normalized];
  occupied.forEach((index, position) => {
    next[index] = order[position]!;
  });
  return next.every((key, index) => key === slots[index]) && next.length === slots.length
    ? slots
    : next;
}

export function withGenerationInputSlots(
  entry: CanvasNodeEntry,
  slots: readonly (string | null)[],
): CanvasNodeEntry {
  if (!isGenerationMediaConsumer(entry)) return entry;
  if (entry.data.config.inputSlots === slots) return entry;
  return {
    type: "gen",
    data: {
      ...entry.data,
      config: { ...entry.data.config, inputSlots: slots },
    },
  };
}

/**
 * 新写入的连线按 connect 同一套规则入账：占媒体槽的来源填空槽或追加。
 * 一次插入多条线时按 edges 数组顺序分配，保证拖线建节点的第一条线就是槽位 0。
 */
export function applyNewEdgesToGenerationInputSlots(
  nodesById: Readonly<Record<string, CanvasNodeEntry>>,
  newEdges: readonly AssetEdgeData[],
): Readonly<Record<string, CanvasNodeEntry>> {
  if (newEdges.length === 0) return nodesById;
  let next: Record<string, CanvasNodeEntry> | null = null;
  const write = (key: string, entry: CanvasNodeEntry) => {
    next ??= { ...nodesById };
    next[key] = entry;
  };
  for (const edge of newEdges) {
    const current = next ?? nodesById;
    const source = current[edge.fromKey];
    const target = current[edge.toKey];
    if (source == null || target == null) continue;
    if (!isGenerationMediaConsumer(target) || !generationSourceOccupiesInputSlot(source)) continue;
    const slots = assignGenerationInputSlot(target.data.config.inputSlots ?? [], edge.fromKey);
    if (slots === target.data.config.inputSlots) continue;
    write(edge.toKey, withGenerationInputSlots(target, slots));
  }
  return next ?? nodesById;
}
