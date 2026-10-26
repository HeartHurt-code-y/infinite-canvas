import { useStoreApi } from "@xyflow/react";
import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { canvasGroupMemberName, isMediaGroupMember, type CanvasGroupMember } from "./assetGroups";
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

/**
 * 分组（对齐原站 liblib 画布）。
 *
 * 原站实测（2026-10-22，用户提供的复杂画布截图 + 像素取样）：
 *   - 组 = 一块**半透明彩色大框**：框内是该颜色的低透明度填充，叠一层 45° 斜纹，
 *     边框是同色；同一个组的所有成员共用一个颜色（黑 / 青 / 棕橙 / 紫 / 绛红 / 绿）。
 *   - 框的左上角压着一枚**同色实底的小标签**（组名，白字，约 11px，圆角 4）。
 *   - 框上**没有工具条**：原站的分组只有「框 + 标签」两件东西。
 *
 * 所以本项目原来的工具条（拖手柄 / 折叠 / 改名 / 顺序清单 / 复制 / 上传 / 解散）
 * 整体删除：标签就是拖动整组的手柄，改名改成**双击标签就地编辑**（与原站的
 * 节点标题一致），其余动作走**右键菜单**（原站的组操作同样在右键菜单里）。
 */
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
  const renameButtonRef = useRef<HTMLInputElement>(null);
  const renameActiveRef = useRef(false);
  const mediaOnly = members.every(isMediaGroupMember);
  const orderLabel = members
    .map((member, index) => `${index + 1}. ${canvasGroupMemberName(member)}`)
    .join("  ");
  const finishRename = (save: boolean) => {
    if (!renameActiveRef.current) return;
    renameActiveRef.current = false;
    if (save && draftName.trim()) onRename(draftName.trim());
    setRenaming(false);
    renameButtonRef.current?.focus();
  };
  const style = {
    "--canvas-group-color": `var(--canvas-group-ink-${groupColorIndex(group.id)})`,
  } as CSSProperties;
  return (
    <div
      className="canvas-asset-group"
      style={style}
      data-selected={selected ? "true" : undefined}
      data-collapsed={group.collapsed ? "true" : undefined}
      role="group"
      aria-label={`${group.name}，${members.length} 个节点${group.collapsed ? "，已折叠" : ""}`}
    >
      <button
        type="button"
        className="canvas-asset-group__chip nodrag nopan"
        aria-label={`选择整组 ${group.name}`}
        title={mediaOnly ? `${group.name} · ${orderLabel}` : `${group.name} · ${orderLabel}`}
        onClick={onSelect}
        onDoubleClick={(event) => {
          event.stopPropagation();
          renameActiveRef.current = true;
          setDraftName(group.name);
          setRenaming(true);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onContextMenu?.({ x: event.clientX, y: event.clientY });
        }}
      >
        {group.name}
      </button>
      {renaming ? (
        <form
          className="canvas-asset-group__rename nodrag nopan"
          onSubmit={(event) => {
            event.preventDefault();
            finishRename(true);
          }}
        >
          <input
            ref={renameButtonRef}
            aria-label="分组名称"
            autoFocus
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            onFocus={(event) => event.target.select()}
            onBlur={() => finishRename(true)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Escape") {
                event.preventDefault();
                finishRename(false);
              }
            }}
          />
        </form>
      ) : null}
    </div>
  );
}

/** 同一个组永远拿到同一个颜色：按组 id 的字符和取模。 */
function groupColorIndex(groupId: string): number {
  let sum = 0;
  for (let index = 0; index < groupId.length; index += 1) {
    sum = (sum + groupId.charCodeAt(index)) % 997;
  }
  return (sum % 6) + 1;
}
