import { useMemo, type ComponentProps } from "react";
import { useStore } from "zustand";
import { useCanvas, useCanvasStore, type CanvasNodeEntry } from "../canvas/canvasStore";
import { toMediaSrc } from "../../lib/backend";
import { canvasGroupMemberName, compareLibraryPickOrder } from "./assetGroups";
import { CanvasAssetDrawer, type CanvasDrawerNode, type CanvasDrawerNodeKind } from "./CanvasAssetDrawer";
import { imageNodePreview } from "./imageNodeResults";
import type { OutputNodeData } from "./workspaceModel";

type DrawerProps = ComponentProps<typeof CanvasAssetDrawer>;

function drawerNodeKind(entry: CanvasNodeEntry): CanvasDrawerNodeKind {
  if (entry.type === "screenplay" || entry.type === "videoClip" || entry.type === "director") return entry.type;
  if (entry.type === "output") return entry.data.mediaType;
  if (entry.type === "asset") return entry.data.libraryResource?.kind ?? entry.data.kind;
  if (entry.type === "gen" && entry.data.kind !== "prompt") return entry.data.kind;
  return "text";
}

function imageThumbnail(output: OutputNodeData | null | undefined): string | null {
  if (output?.mediaType !== "image") return null;
  return output.finalPath ? toMediaSrc(output.finalPath) : output.previewSrc ?? null;
}

/** 节点订阅留在侧栏内，画布节点移动时无需刷新工作台外壳。 */
export function CanvasAssetDrawerHost({
  embeddedOutputOwners,
  ...props
}: Omit<DrawerProps, "nodes" | "groups" | "selectedNodeKey" | "onRateNode"> & {
  readonly embeddedOutputOwners: Readonly<Record<string, string>>;
}) {
  const store = useCanvasStore();
  const nodesById = useStore(store, (state) => state.nodesById);
  const groups = useCanvas((state) => state.groups);
  const selectedNodeKey = useCanvas((state) => state.selection.nodeKey);
  const nodes = useMemo((): readonly CanvasDrawerNode[] => {
    if (props.tab == null) return [];
    const entries = Object.values(nodesById);
    const embeddedImages = new Map<string, OutputNodeData>();
    for (const entry of entries) {
      if (entry.type === "output" && entry.data.mediaType === "image" && embeddedOutputOwners[entry.data.key]) {
        embeddedImages.set(entry.data.sourceNodeId, entry.data);
      }
    }
    return entries.filter((entry) => !embeddedOutputOwners[entry.data.key])
      .sort((left, right) => compareLibraryPickOrder(left.data, right.data))
      .map((entry) => {
        const { data } = entry;
        const kind = drawerNodeKind(entry);
        const thumbnail = entry.type === "asset" && (kind === "image" || entry.data.libraryResource) ? entry.data.previewUrl
          : entry.type === "output" ? imageThumbnail(entry.data)
            : entry.type === "gen" && entry.data.kind === "image"
              ? imageThumbnail(imageNodePreview(entry.data) ?? embeddedImages.get(data.key))
              : entry.type === "director" ? entry.data.previewUrl : null;
        const rating = data.rating ?? 0;
        return {
          id: data.key,
          name: canvasGroupMemberName(data),
          kind,
          thumbnail,
          groupId: data.assetGroupId,
          rating: Number.isInteger(rating) && rating >= 1 && rating <= 5 ? rating : 0,
        };
      });
  }, [nodesById, embeddedOutputOwners, props.tab]);
  return <CanvasAssetDrawer {...props} nodes={nodes} groups={groups} selectedNodeKey={selectedNodeKey}
    onRateNode={(key, rating) => {
      const state = store.getState();
      const entry = state.nodesById[key];
      if (entry) state.patchNode(entry.type, key, (node) => (node.rating ?? 0) === rating ? node : { ...node, rating });
    }}
  />;
}
