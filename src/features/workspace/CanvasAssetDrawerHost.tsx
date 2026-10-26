import { useMemo, useSyncExternalStore } from "react";
import { useCanvasStore } from "../canvas/canvasStore";
import {
  CanvasAssetDrawer,
  type CanvasAssetDrawerAsset,
  type CanvasAssetKind,
} from "./CanvasAssetDrawer";

/**
 * 资产管理抽屉的宿主：把画布节点换算成抽屉里的资产条目。
 *
 * 订阅放在这里而不是壳组件里，是有意的：WorkspaceApp 按领域拆分过订阅，
 * 整体订阅 nodesById 会让每一次节点变动都重渲染整个工作台。
 * 这里只订阅 nodesById 的**对象身份**——它在两次节点变动之间是稳定的，
 * 因此只有抽屉这一小片会跟着更新。
 */
export interface CanvasAssetDrawerHostProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly canvases: readonly { readonly id: string; readonly name: string }[];
  readonly activeCanvasId: string;
  readonly onSelectCanvas: (id: string) => void;
}

function readString(source: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

function readKind(source: Record<string, unknown>): CanvasAssetKind {
  const kind = source["kind"];
  if (kind === "image" || kind === "video" || kind === "audio") return kind;
  if (typeof source["previewUrl"] === "string") return "image";
  if (typeof source["videoUrl"] === "string") return "video";
  if (typeof source["textContent"] === "string") return "text";
  return "text";
}

/**
 * 画布节点 → 抽屉资产条目。
 *
 * 各类节点的数据形状不同（素材节点带 kind/previewUrl，生成节点带提示词，
 * 剧本节点带章节），这里只取共有的「名字 + 媒体类型」，取不到名字时退回
 * 节点 key —— 抽屉要的是能点得动的条目，不是完整的节点模型。
 */
function toDrawerAsset(entry: {
  readonly type: string;
  readonly data: unknown;
}): CanvasAssetDrawerAsset {
  const data = (entry.data ?? {}) as Record<string, unknown>;
  const name = readString(data, ["name", "title", "label", "textContent", "prompt"]) ?? "";
  return {
    id: readString(data, ["key"]) ?? name,
    name: name === "" ? "未命名节点" : name,
    kind: readKind(data),
    thumbnailUrl: readString(data, ["previewUrl", "thumbnailUrl", "posterUrl"]) ?? undefined,
  };
}

export function CanvasAssetDrawerHost({
  open,
  onClose,
  canvases,
  activeCanvasId,
  onSelectCanvas,
}: CanvasAssetDrawerHostProps) {
  const store = useCanvasStore();
  const nodesById = useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.getState().nodesById,
    () => store.getState().nodesById,
  );
  const assets = useMemo<CanvasAssetDrawerAsset[]>(
    () => Object.values(nodesById).map(toDrawerAsset),
    [nodesById],
  );

  return (
    <CanvasAssetDrawer
      open={open}
      onClose={onClose}
      canvases={canvases}
      activeCanvasId={activeCanvasId}
      onSelectCanvas={onSelectCanvas}
      assets={assets}
    />
  );
}
