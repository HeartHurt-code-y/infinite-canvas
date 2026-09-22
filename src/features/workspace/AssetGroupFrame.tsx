import { useStoreApi } from "@xyflow/react";
import { useLayoutEffect } from "react";
import type { AssetNodeData } from "./workspaceModel";

/**
 * 框选结束的回调早于选区订阅。这里在 React Flow 内部同步读当前选中的素材节点。
 */
export function AssetGroupSelectionReader({
  assetKeySetRef,
  readSelectionRef,
}: {
  readonly assetKeySetRef: { readonly current: ReadonlySet<string> };
  readonly readSelectionRef: { current: () => readonly string[] };
}) {
  const store = useStoreApi();
  useLayoutEffect(() => {
    readSelectionRef.current = () => {
      const keys = assetKeySetRef.current;
      const selected: string[] = [];
      // 框选在松手前就把选中写进节点查找表；受控 nodes 要等下一帧才会跟上。
      for (const node of store.getState().nodeLookup.values()) {
        if (node.selected === true && keys.has(node.id)) selected.push(node.id);
      }
      return selected;
    };
    return () => {
      readSelectionRef.current = () => [];
    };
  }, [assetKeySetRef, readSelectionRef, store]);
  return null;
}

/** 素材组外框。输出端口由画布节点层挂在右侧，这里只放顺序和解散。 */
export function AssetGroupFrame({
  members,
  onDissolve,
}: {
  readonly members: readonly AssetNodeData[];
  readonly onDissolve: () => void;
}) {
  const orderLabel = members.map((member, index) => `${index + 1}. ${member.name}`).join("  ");
  return (
    <div
      className="canvas-asset-group"
      role="group"
      aria-label={`素材组，${members.length} 个素材，输入顺序 ${orderLabel}`}
    >
      <div className="canvas-asset-group__bar">
        <span className="canvas-asset-group__title">素材组 · {members.length}</span>
        <span className="canvas-asset-group__order" title={orderLabel}>
          {orderLabel}
        </span>
        <button
          type="button"
          className="canvas-asset-group__dissolve nodrag nopan"
          aria-label="解散素材组"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onDissolve();
          }}
        >
          解散
        </button>
      </div>
    </div>
  );
}
