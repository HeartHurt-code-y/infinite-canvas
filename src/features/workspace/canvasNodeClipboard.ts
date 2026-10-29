import type { PromptContentDocumentV1 } from "../../lib/promptContent";
import type { ExplicitMediaTarget } from "../../lib/backend";
import type { CanvasDocumentV2, CanvasNodeEntry } from "../canvas/canvasStore";
import type { AssetEdgeData } from "./workspaceModel";
import { assetGroupsFromNodes } from "./assetGroups";
import { decodeCanvasGroups, type CanvasGroups } from "../canvas/canvasGroups";
import { scriptSourceSignature, scriptTableFingerprint } from "./scriptGeneratorModel";

export interface CanvasNodeClipboard {
  readonly groups: CanvasGroups;
  readonly nodes: readonly CanvasNodeEntry[];
  readonly edges: readonly AssetEdgeData[];
  readonly promptContents: Readonly<Record<string, PromptContentDocumentV1>>;
  readonly skippedPendingOutputs: number;
}

const documentNodes = (document: CanvasDocumentV2): CanvasNodeEntry[] => [
  ...document.assetNodes.map((data) => ({ type: "asset" as const, data })),
  ...document.genNodes.map((data) => ({ type: "gen" as const, data })),
  ...(document.screenplayNodes ?? []).map((data) => ({ type: "screenplay" as const, data })),
  ...(document.videoClipNodes ?? []).map((data) => ({ type: "videoClip" as const, data })),
  ...document.resultNodes.map((data) => ({ type: "result" as const, data })),
  ...(document.outputNodes ?? []).map((data) => ({ type: "output" as const, data })),
];

/** Freeze the selected graph at copy time. A pending output has no durable media to copy. */
export function captureCanvasNodes(
  document: CanvasDocumentV2,
  selectedKeys: ReadonlySet<string>,
): CanvasNodeClipboard {
  const all = documentNodes(document);
  const skippedPendingOutputs = all.filter(
    (entry) =>
      entry.type === "output" &&
      selectedKeys.has(entry.data.key) &&
      entry.data.finalPath == null &&
      entry.data.textContent == null,
  ).length;
  const nodes = all.filter(
    (entry) =>
      selectedKeys.has(entry.data.key) &&
      (entry.type !== "output" || entry.data.finalPath != null || entry.data.textContent != null),
  );
  const copiedKeys = new Set(nodes.map((entry) => entry.data.key));
  const promptContents = Object.fromEntries(
    Object.entries(document.promptContents).filter(([key]) => copiedKeys.has(key)),
  );
  const metadata = decodeCanvasGroups(
    document.groups,
    Object.fromEntries(all.map((entry) => [entry.data.key, entry])),
  );
  const groups = Object.fromEntries(
    assetGroupsFromNodes(all.map((entry) => entry.data))
      .filter(
        (group) =>
          group.members.every((member) => selectedKeys.has(member.key)) &&
          group.members.filter((member) => copiedKeys.has(member.key)).length >= 2,
      )
      .map((group) => [group.groupId, metadata[group.groupId]!]),
  );
  return structuredClone({
    groups,
    nodes,
    edges: document.assetEdges.filter(
      (edge) => copiedKeys.has(edge.fromKey) && copiedKeys.has(edge.toKey),
    ),
    promptContents,
    skippedPendingOutputs,
  });
}

export interface PastedCanvasNodes {
  readonly groups: CanvasGroups;
  readonly nodes: readonly CanvasNodeEntry[];
  readonly edges: readonly AssetEdgeData[];
  readonly promptContents: Readonly<Record<string, PromptContentDocumentV1>>;
  readonly keys: readonly string[];
}

/** Remap only copied instances and their internal edges; external references stay unresolved. */
export function pasteCanvasNodes(
  clipboard: CanvasNodeClipboard,
  offset: { readonly x: number; readonly y: number },
  newKey: (entry: CanvasNodeEntry) => string,
): PastedCanvasNodes {
  const keysByOldKey = new Map(clipboard.nodes.map((entry) => [entry.data.key, newKey(entry)]));
  const groupIds = new Map(
    Object.keys(clipboard.groups).map((id) => [id, `group-${crypto.randomUUID()}`]),
  );
  const groups = Object.fromEntries(
    Object.entries(clipboard.groups).map(([id, group]) => {
      const copiedId = groupIds.get(id)!;
      return [copiedId, { ...group, id: copiedId }];
    }),
  );
  const incomingByTarget = new Map<string, Set<string>>();
  for (const edge of clipboard.edges) {
    const incoming = incomingByTarget.get(edge.toKey) ?? new Set<string>();
    incoming.add(edge.fromKey);
    incomingByTarget.set(edge.toKey, incoming);
  }
  const copiedInputKey = (targetKey: string, sourceKey: string): string | null =>
    incomingByTarget.get(targetKey)?.has(sourceKey) === true
      ? (keysByOldKey.get(sourceKey) ?? null)
      : null;
  const copiedConnectedSource = (targetKey: string, sourceKey: string): string | null => {
    const pending = [targetKey];
    const visited = new Set<string>();
    while (pending.length) {
      const key = pending.pop()!;
      if (visited.has(key)) continue;
      visited.add(key);
      for (const parent of incomingByTarget.get(key) ?? []) {
        if (parent === sourceKey) return keysByOldKey.get(sourceKey) ?? null;
        pending.push(parent);
      }
    }
    return null;
  };
  const remapBinding = <T extends { readonly key: string; readonly target: ExplicitMediaTarget }>(
    targetKey: string,
    binding: T | null,
  ): T | null => {
    if (binding == null) return null;
    const copiedKey = copiedInputKey(targetKey, binding.key);
    return copiedKey == null
      ? binding
      : { ...binding, key: copiedKey, target: { ...binding.target, canvasNodeKey: copiedKey } };
  };
  const nodes = clipboard.nodes.map((source): CanvasNodeEntry => {
    const entry = structuredClone(source);
    const previousGroup = entry.data.assetGroupId;
    delete (entry.data as { assetGroupId?: string }).assetGroupId;
    const copiedGroup = previousGroup == null ? undefined : groupIds.get(previousGroup);
    if (copiedGroup != null) Object.assign(entry.data, { assetGroupId: copiedGroup });
    const key = keysByOldKey.get(entry.data.key)!;
    const position = { key, x: entry.data.x + offset.x, y: entry.data.y + offset.y };
    switch (entry.type) {
      case "asset": {
        const data = entry.data;
        return { type: "asset", data: { ...data, ...position } };
      }
      case "output": {
        const data = entry.data;
        return {
          type: "output",
          data: {
            ...data,
            ...position,
            sourceNodeId: keysByOldKey.get(data.sourceNodeId) ?? data.sourceNodeId,
          },
        };
      }
      case "gen": {
        if (entry.data.kind === "prompt")
          return { type: "gen", data: { ...entry.data, ...position } };
        if (entry.data.kind === "image") {
          const config = entry.data.config;
          return {
            type: "gen",
            data: {
              ...entry.data,
              ...position,
              config: {
                ...config,
                // 翻译是原节点的一次付费任务，副本只复制创作配置。
                translationTask: null,
                ...(config.inputSlots == null
                  ? {}
                  : {
                      inputSlots: config.inputSlots.map((sourceKey) =>
                        sourceKey == null ? null : copiedInputKey(entry.data.key, sourceKey),
                      ),
                    }),
              },
            },
          };
        }
        if (entry.data.kind === "audio") {
          // 音频节点的配置没有视频节点那套「素材角色 / 绿幕 / 白模」绑定，
          // 只需要把输入槽位里的素材 key 换成副本 key。
          const config = entry.data.config;
          return {
            type: "gen",
            data: {
              ...entry.data,
              ...position,
              config: {
                ...config,
                ...(config.inputSlots == null
                  ? {}
                  : {
                      inputSlots: config.inputSlots.map((sourceKey) =>
                        sourceKey == null ? null : copiedInputKey(entry.data.key, sourceKey),
                      ),
                    }),
              },
            },
          };
        }
        const config = entry.data.config;
        const mediaRoles = config.mediaRoles
          ? Object.fromEntries(
              Object.entries(config.mediaRoles).flatMap(([sourceKey, role]) => {
                const copiedKey = copiedInputKey(entry.data.key, sourceKey);
                return copiedKey == null ? [] : [[copiedKey, role]];
              }),
            )
          : undefined;
        return {
          type: "gen",
          data: {
            ...entry.data,
            ...position,
            config: {
              ...config,
              ...(config.inputSlots == null
                ? {}
                : {
                    inputSlots: config.inputSlots.map((sourceKey) =>
                      sourceKey == null ? null : copiedInputKey(entry.data.key, sourceKey),
                    ),
                  }),
              ...(mediaRoles == null ? {} : { mediaRoles }),
              ...(config.whiteModelControl == null
                ? {}
                : {
                    whiteModelControl: {
                      ...config.whiteModelControl,
                      source: remapBinding(entry.data.key, config.whiteModelControl.source),
                      sceneReference: remapBinding(
                        entry.data.key,
                        config.whiteModelControl.sceneReference,
                      ),
                      mappings: config.whiteModelControl.mappings.map((mapping) => ({
                        ...mapping,
                        reference: remapBinding(entry.data.key, mapping.reference),
                      })),
                    },
                  }),
              ...(config.greenScreen == null
                ? {}
                : {
                    greenScreen: {
                      ...config.greenScreen,
                      phase: "prepare" as const,
                      preparationTasks: [],
                      source: remapBinding(entry.data.key, config.greenScreen.source),
                      subjectReference: remapBinding(
                        entry.data.key,
                        config.greenScreen.subjectReference,
                      ),
                      foregrounds: config.greenScreen.foregrounds.map((binding) =>
                        remapBinding(entry.data.key, binding)!,
                      ),
                      background: remapBinding(entry.data.key, config.greenScreen.background),
                    },
                  }),
            },
          },
        };
      }
      case "screenplay": {
        const script = entry.data.config.scriptGenerator;
        const remapAssets = (assets: NonNullable<typeof script>["assets"]) => assets.map((asset) => {
          if (asset.reference?.kind !== "canvas") return asset;
          const copied = copiedConnectedSource(entry.data.key, asset.reference.sourceKey);
          return copied == null ? asset : { ...asset, reference: { kind: "canvas" as const, sourceKey: copied } };
        });
        const remappedAssets = script ? remapAssets(script.assets) : [];
        const remapShots = (
          shots: NonNullable<typeof script>["shots"],
          oldAssets: NonNullable<typeof script>["assets"],
          newAssets: NonNullable<typeof script>["assets"],
        ) => shots.map((shot) => shot.composedFrom === scriptSourceSignature(shot, oldAssets)
          ? { ...shot, composedFrom: scriptSourceSignature(shot, newAssets) } : shot);
        const remappedShots = script ? remapShots(script.shots, script.assets, remappedAssets) : [];
        const previous = script?.previous;
        const previousAssets = previous ? remapAssets(previous.assets) : [];
        return {
          type: "screenplay",
          data: {
            ...entry.data,
            ...position,
            config: {
              ...entry.data.config,
              ...(script == null ? {} : { scriptGenerator: {
                ...script,
                // 复制创作内容，不复制原画布的付费任务或结果选用身份。
                batches: [], frameSelections: {},
                shots: remappedShots,
                assets: remappedAssets,
                ...(previous == null ? {} : { previous: {
                  ...previous, assets: previousAssets,
                  shots: remapShots(previous.shots, previous.assets, previousAssets),
                  afterFingerprint: previous.afterFingerprint === scriptTableFingerprint(script.shots, script.assets)
                    ? scriptTableFingerprint(remappedShots, remappedAssets) : previous.afterFingerprint,
                } }),
              } }),
            },
          },
        };
      }
      case "videoClip":
        return { ...entry, data: { ...entry.data, ...position, config: {
          ...entry.data.config, submission: null, renderDeliveries: [],
          timeline: (entry.data.config.timeline ?? []).map(clip => ({ ...clip, target: {
            ...clip.target, canvasNodeKey: clip.target.canvasNodeKey ? keysByOldKey.get(clip.target.canvasNodeKey) ?? null : null,
          } })),
        } } };
      case "result":
        return { ...entry, data: { ...entry.data, ...position } } as CanvasNodeEntry;
    }
  });
  const edges = clipboard.edges.map((edge) => {
    const fromKey = keysByOldKey.get(edge.fromKey)!;
    const toKey = keysByOldKey.get(edge.toKey)!;
    return { id: `${fromKey}->${toKey}`, fromKey, toKey };
  });
  const promptContents = Object.fromEntries(
    Object.entries(clipboard.promptContents).map(([oldKey, document]) => [
      keysByOldKey.get(oldKey)!,
      {
        ...document,
        items: document.items.map((item) => {
          if (item.kind !== "media_reference") return item;
          const copiedKey = keysByOldKey.get(item.canvasNodeKey);
          return copiedKey == null
            ? item
            : {
                ...item,
                canvasNodeKey: copiedKey,
                target: { ...item.target, canvasNodeKey: copiedKey },
              };
        }),
      },
    ]),
  );
  return { nodes, edges, promptContents, groups, keys: nodes.map((entry) => entry.data.key) };
}
