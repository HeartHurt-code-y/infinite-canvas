import { useStoreApi } from "@xyflow/react";
import { useLayoutEffect } from "react";
import type { CanvasGroupMember } from "./assetGroups";

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

/** 素材或产物组的外框。输出端口由画布节点层挂在右侧。 */
export function AssetGroupFrame({
  members,
  onDissolve,
  onUpload,
  uploadLabel,
}: {
  readonly members: readonly CanvasGroupMember[];
  readonly onDissolve: () => void;
  readonly onUpload?: () => void;
  readonly uploadLabel?: string;
}) {
  const outputCount = members.filter((member) => !("assetId" in member)).length;
  const title =
    outputCount === 0 ? "素材组" : outputCount === members.length ? "产物组" : "成组";
  const orderLabel = members
    .map((member, index) => `${index + 1}. ${member.name ?? "未命名"}`)
    .join("  ");
  return (
    <div
      className="canvas-asset-group"
      role="group"
      aria-label={`${title}，${members.length} 个，输入顺序 ${orderLabel}`}
    >
      <div className="canvas-asset-group__bar">
        <span className="canvas-asset-group__title">
          {title} · {members.length}
        </span>
        <span className="canvas-asset-group__order" title={orderLabel}>
          {orderLabel}
        </span>
        {onUpload != null && uploadLabel != null ? (
          <button
            type="button"
            className="canvas-asset-group__upload nodrag nopan"
            aria-label={uploadLabel}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onUpload();
            }}
          >
            {uploadLabel}
          </button>
        ) : null}
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
