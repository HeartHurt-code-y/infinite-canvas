import {
  assetNodeDimensions,
  nearestAvailableNodePosition,
  type AssetItem,
  type AssetNodeData,
  type CanvasNodeRect,
} from "./workspaceModel";

/** 画布上素材组节点的 id 前缀。组本身不是持久化节点，只是成员外框和统一输出端口。 */
export const ASSET_GROUP_FLOW_PREFIX = "asset-group:";

const GROUP_PAD = 16;
const GROUP_HEADER = 32;
/** 右侧留白，让组的输出端口落在素材卡片外面。 */
const GROUP_GUTTER = 28;

export const ASSET_PLACE_GAP = 36;

export interface AssetGroupMembership {
  readonly groupId: string;
  readonly members: readonly AssetNodeData[];
}

export function assetGroupKey(): string {
  return `group-${Math.random().toString(36).slice(2, 10)}`;
}

export function assetGroupFlowId(groupId: string): string {
  return `${ASSET_GROUP_FLOW_PREFIX}${groupId}`;
}

export function assetGroupIdFromFlowId(flowId: string): string | null {
  if (!flowId.startsWith(ASSET_GROUP_FLOW_PREFIX)) return null;
  const groupId = flowId.slice(ASSET_GROUP_FLOW_PREFIX.length);
  return groupId === "" ? null : groupId;
}

/** 素材库多选的身份：同一素材在不同来源或供应商下不是同一次点选。 */
export function assetPickKey(
  asset: Pick<AssetItem, "id" | "source" | "providerConnectionId">,
): string {
  return `${asset.source ?? "cloud"}\u0000${asset.providerConnectionId ?? ""}\u0000${asset.id}`;
}

function withoutAssetGroup(node: AssetNodeData): AssetNodeData {
  const { assetGroupId, ...rest } = node;
  void assetGroupId;
  return rest;
}

function finitePickOrder(node: AssetNodeData): number | null {
  const value = node.libraryPickOrder;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * 生成输入顺序：先按素材库点选序号，没有序号的旧节点再按从上到下、从左到右。
 */
export function compareLibraryPickOrder(left: AssetNodeData, right: AssetNodeData): number {
  const leftOrder = finitePickOrder(left);
  const rightOrder = finitePickOrder(right);
  if (leftOrder != null && rightOrder != null && leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }
  if (leftOrder != null && rightOrder == null) return -1;
  if (leftOrder == null && rightOrder != null) return 1;
  if (left.y !== right.y) return left.y - right.y;
  if (left.x !== right.x) return left.x - right.x;
  if (left.key < right.key) return -1;
  if (left.key > right.key) return 1;
  return 0;
}

/** 下一次投放使用的点选序号，接在画布上已有序号之后。 */
export function nextLibraryPickOrder(nodes: readonly AssetNodeData[]): number {
  let max = 0;
  for (const node of nodes) {
    const order = finitePickOrder(node);
    if (order != null && order > max) max = order;
  }
  return max + 1;
}

/** 至少两个成员才构成可连线的组，成员按点选顺序排列。 */
export function assetGroupsFromNodes(
  nodes: readonly AssetNodeData[],
): readonly AssetGroupMembership[] {
  const buckets = new Map<string, AssetNodeData[]>();
  for (const node of nodes) {
    const groupId = node.assetGroupId;
    if (typeof groupId !== "string" || groupId === "") continue;
    const bucket = buckets.get(groupId);
    if (bucket == null) buckets.set(groupId, [node]);
    else bucket.push(node);
  }
  const groups: AssetGroupMembership[] = [];
  for (const [groupId, members] of buckets) {
    if (members.length < 2) continue;
    groups.push({ groupId, members: [...members].sort(compareLibraryPickOrder) });
  }
  return groups;
}

/**
 * 把框选到的素材收成一个新组。
 * 已经是同一整组时不改数据。被拆散后只剩一个成员的旧组会解散。
 */
export function regroupAssetNodes(
  nodes: readonly AssetNodeData[],
  memberKeys: readonly string[],
  newGroupId: string,
): readonly AssetNodeData[] | null {
  const selected = new Set(memberKeys);
  const selectedNodes = nodes.filter((node) => selected.has(node.key));
  if (selectedNodes.length < 2) return null;

  const shared = selectedNodes[0]?.assetGroupId;
  const alreadyGrouped =
    typeof shared === "string" &&
    shared !== "" &&
    selectedNodes.every((node) => node.assetGroupId === shared) &&
    nodes.every((node) => node.assetGroupId !== shared || selected.has(node.key));
  if (alreadyGrouped) return null;

  const vacated = new Set<string>();
  for (const node of selectedNodes) {
    if (
      typeof node.assetGroupId === "string" &&
      node.assetGroupId !== "" &&
      node.assetGroupId !== newGroupId
    ) {
      vacated.add(node.assetGroupId);
    }
  }
  const remaining = new Map<string, number>();
  for (const groupId of vacated) {
    let count = 0;
    for (const node of nodes) {
      if (node.assetGroupId === groupId && !selected.has(node.key)) count += 1;
    }
    remaining.set(groupId, count);
  }

  let changed = false;
  const next = nodes.map((node) => {
    if (selected.has(node.key)) {
      if (node.assetGroupId === newGroupId) return node;
      changed = true;
      return { ...node, assetGroupId: newGroupId };
    }
    const groupId = node.assetGroupId;
    if (typeof groupId === "string" && (remaining.get(groupId) ?? 2) < 2) {
      changed = true;
      return withoutAssetGroup(node);
    }
    return node;
  });
  return changed ? next : null;
}

export function dissolveAssetGroupNodes(
  nodes: readonly AssetNodeData[],
  groupId: string,
): readonly AssetNodeData[] | null {
  let changed = false;
  const next = nodes.map((node) => {
    if (node.assetGroupId !== groupId) return node;
    changed = true;
    return withoutAssetGroup(node);
  });
  return changed ? next : null;
}

function memberSize(node: AssetNodeData): { readonly width: number; readonly height: number } {
  const measured = node.measured;
  if (measured != null && measured.width > 0 && measured.height > 0) return measured;
  return assetNodeDimensions(node);
}

/** 包住全部成员，并在上方留标题栏、右侧留输出端口。 */
export function assetGroupBounds(members: readonly AssetNodeData[]): CanvasNodeRect {
  if (members.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const node of members) {
    const size = memberSize(node);
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x + size.width);
    maxY = Math.max(maxY, node.y + size.height);
  }
  return {
    x: minX - GROUP_PAD,
    y: minY - GROUP_PAD - GROUP_HEADER,
    width: maxX - minX + GROUP_PAD * 2 + GROUP_GUTTER,
    height: maxY - minY + GROUP_PAD * 2 + GROUP_HEADER,
  };
}

/**
 * 按点选顺序把素材排成网格，锚点是整组中心。
 * 每个格子都会避开已经占用的区域，返回值下标与传入顺序一致。
 */
export function layoutAssetPlacements(
  count: number,
  anchor: { readonly x: number; readonly y: number },
  cell: { readonly width: number; readonly height: number },
  occupied: readonly CanvasNodeRect[],
): readonly { readonly x: number; readonly y: number }[] {
  if (count <= 0) return [];
  const columns = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / columns);
  const stepX = cell.width + ASSET_PLACE_GAP;
  const stepY = cell.height + ASSET_PLACE_GAP;
  const gridWidth = columns * cell.width + (columns - 1) * ASSET_PLACE_GAP;
  const gridHeight = rows * cell.height + (rows - 1) * ASSET_PLACE_GAP;
  const originX = anchor.x - gridWidth / 2;
  const originY = anchor.y - gridHeight / 2;
  const placed: { x: number; y: number }[] = [];
  const busy = [...occupied];
  for (let index = 0; index < count; index += 1) {
    const desired: CanvasNodeRect = {
      x: originX + (index % columns) * stepX,
      y: originY + Math.floor(index / columns) * stepY,
      width: cell.width,
      height: cell.height,
    };
    const position = nearestAvailableNodePosition(desired, busy);
    placed.push(position);
    busy.push({ ...desired, x: position.x, y: position.y });
  }
  return placed;
}
