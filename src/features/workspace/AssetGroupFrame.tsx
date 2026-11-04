import { useStoreApi } from "@xyflow/react";
import { useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import type { CanvasGroupMember } from "./assetGroups";
import type { CanvasGroup } from "../canvas/canvasGroups";

/**
 * 框选结束的回调早于选区订阅。在 React Flow 内部同步读当前选中的真实节点。
 */
export function CanvasMarqueeSelectionReader({
  selectableKeysRef,
  readSelectionRef,
}: {
  readonly selectableKeysRef: { readonly current: ReadonlySet<string> };
  readonly readSelectionRef: { current: () => readonly string[] };
}) {
  const store = useStoreApi();
  useLayoutEffect(() => {
    readSelectionRef.current = () => {
      const keys = selectableKeysRef.current;
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
  }, [selectableKeysRef, readSelectionRef, store]);
  return null;
}

/** 卡片上方的组名可以拖动整组、双击改名，也可以打开组菜单。 */
export function AssetGroupFrame({
  group,
  members,
  selected,
  onSelect,
  onRename,
  onContextMenu,
}: {
  readonly group: CanvasGroup;
  readonly members: readonly CanvasGroupMember[];
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly onRename: (name: string) => void;
  /** 右键标签时打开组菜单（坐标是视口坐标）。 */
  readonly onContextMenu?:
    ((position: { readonly x: number; readonly y: number }) => void) | undefined;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(group.name);
  const titleRef = useRef<HTMLButtonElement>(null);
  const renameActiveRef = useRef(false);
  const finishRename = (save: boolean, restoreFocus = false) => {
    if (!renameActiveRef.current) return;
    renameActiveRef.current = false;
    if (save && draftName.trim()) onRename(draftName.trim());
    setRenaming(false);
    if (restoreFocus) window.requestAnimationFrame(() => titleRef.current?.focus());
  };
  const openGroupMenu = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onContextMenu?.({ x: event.clientX, y: event.clientY });
  };
  return (
    <div
      className="canvas-asset-group"
      onContextMenu={group.collapsed ? openGroupMenu : undefined}
      data-selected={selected ? "true" : undefined}
      data-collapsed={group.collapsed ? "true" : undefined}
      role="group"
      aria-label={`${group.name}，${members.length} 个节点${group.collapsed ? "，已折叠" : ""}`}
    >
      <button
        ref={titleRef}
        type="button"
        className="canvas-asset-group__chip"
        aria-label={`选择整组 ${group.name}`}
        onClick={onSelect}
        onDoubleClick={(event) => {
          event.stopPropagation();
          renameActiveRef.current = true;
          setDraftName(group.name);
          setRenaming(true);
        }}
        onContextMenu={openGroupMenu}
      >
        {group.name}
      </button>
      {renaming ? (
        <form
          className="canvas-asset-group__rename nodrag nopan"
          onSubmit={(event) => {
            event.preventDefault();
            finishRename(true, true);
          }}
        >
          <input
            aria-label="分组名称"
            autoFocus
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            onFocus={(event) => event.target.select()}
            onBlur={() => finishRename(true)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key === "Escape") {
                event.preventDefault();
                finishRename(false, true);
              }
            }}
          />
        </form>
      ) : null}
    </div>
  );
}
