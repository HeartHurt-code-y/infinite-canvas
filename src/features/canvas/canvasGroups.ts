import {
  assetGroupBounds,
  assetGroupIdFromFlowId,
  assetGroupsFromNodes,
  regroupAssetNodes,
  dissolveAssetGroupNodes,
} from "../workspace/assetGroups";
import type { CanvasNodeEntry, CanvasNodesById, CanvasStoreNodeChange } from "./canvasStore";

/** 普通组的展示元数据；成员身份保存在节点，组从不携带执行或审批状态。 */
export interface CanvasGroup {
  readonly id: string;
  readonly name: string;
  readonly collapsed: boolean;
  readonly purpose?: "character" | "storyboard";
}

export type CanvasGroups = Readonly<Record<string, CanvasGroup>>;
export const EMPTY_CANVAS_GROUPS: CanvasGroups = {};

export function reconcileCanvasGroups(
  groups: CanvasGroups,
  nodesById: CanvasNodesById,
): CanvasGroups {
  const memberships = assetGroupsFromNodes(Object.values(nodesById).map((entry) => entry.data));
  const next = Object.fromEntries(
    memberships.map(({ groupId }) => [
      groupId,
      groups[groupId] ?? { id: groupId, name: "未命名分组", collapsed: false },
    ]),
  );
  return Object.keys(groups).length === memberships.length &&
    memberships.every(({ groupId }) => groups[groupId] === next[groupId])
    ? groups
    : next;
}

export function decodeCanvasGroups(value: unknown, nodesById: CanvasNodesById): CanvasGroups {
  const groups: Record<string, CanvasGroup> = {};
  if (typeof value === "object" && value != null && !Array.isArray(value)) {
    for (const [id, raw] of Object.entries(value)) {
      if (typeof raw !== "object" || raw == null || Array.isArray(raw)) continue;
      const record = raw as Record<string, unknown>;
      groups[id] = {
        id,
        name:
          typeof record["name"] === "string" && record["name"].trim()
            ? record["name"].trim()
            : "未命名分组",
        collapsed: record["collapsed"] === true,
        ...(record["purpose"] === "character" || record["purpose"] === "storyboard" ? { purpose: record["purpose"] } : {}),
      };
    }
  }
  return reconcileCanvasGroups(groups, nodesById);
}

function replaceGroupMembers(
  nodesById: CanvasNodesById,
  members: readonly CanvasNodeEntry["data"][],
): CanvasNodesById {
  return Object.fromEntries(
    members.map((data) => [
      data.key,
      nodesById[data.key]!.data === data
        ? nodesById[data.key]!
        : ({ ...nodesById[data.key]!, data } as CanvasNodeEntry),
    ]),
  );
}

export function regroupCanvasNodes(
  nodesById: CanvasNodesById,
  keys: readonly string[],
  groupId: string,
): CanvasNodesById | null {
  const next = regroupAssetNodes(
    Object.values(nodesById).map((entry) => entry.data),
    keys,
    groupId,
  );
  return next == null ? null : replaceGroupMembers(nodesById, next);
}

export function dissolveCanvasGroup(
  nodesById: CanvasNodesById,
  groupId: string,
): CanvasNodesById | null {
  const next = dissolveAssetGroupNodes(
    Object.values(nodesById).map((entry) => entry.data),
    groupId,
  );
  return next == null ? null : replaceGroupMembers(nodesById, next);
}

/** 组框坐标只是展示；一次整组拖动作为同一事务写回真实成员。 */
export function expandCanvasGroupPositionChanges(
  nodesById: CanvasNodesById,
  changes: readonly CanvasStoreNodeChange[],
): readonly CanvasStoreNodeChange[] {
  const explicitKeys = new Set(
    changes.filter((change) => change.type === "position").map((change) => change.key),
  );
  return changes.flatMap((change): CanvasStoreNodeChange[] => {
    const groupId = assetGroupIdFromFlowId(change.key);
    if (groupId == null) return [change];
    if (change.type !== "position") return [];
    const members = Object.values(nodesById)
      .filter((entry) => entry.data.assetGroupId === groupId)
      .map((entry) => entry.data);
    if (members.length < 2) return [];
    const bounds = assetGroupBounds(members);
    return members
      .filter((member) => !explicitKeys.has(member.key))
      .map((member) => ({
        type: "position",
        key: member.key,
        position: {
          x: member.x + change.position.x - bounds.x,
          y: member.y + change.position.y - bounds.y,
        },
      }));
  });
}
