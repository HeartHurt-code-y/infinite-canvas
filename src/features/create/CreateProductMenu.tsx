/*
 * 记录卡与产物详情页共用的**产物菜单浮层**。
 *
 * 浮层外观与即梦一致：底色 #262626、圆角 12px、0.5px 描边、条目 36px 高、
 * 内边距 9px 12px、文字 13px/24。条目表在 `createProductMenuModel.ts`。
 *
 * 与操作行末位那个「⋯」不同：那个开的是**记录**菜单（删除 / 反馈生成问题）。
 */
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { JimengIcon } from "./JimengIcon";
import type { RecordMenuEntry } from "./createProductMenuModel";
import { useCreateFloatingLayerAnchor, useDismissOnOutside } from "./useFloatingLayerAnchor";
import "./CreateRecordList.css";

/** 产物菜单浮层。 */
export function RecordProductMenu({
  open,
  anchorRef,
  items,
  onClose,
}: {
  readonly open: boolean;
  readonly anchorRef: React.RefObject<HTMLElement | null>;
  readonly items: readonly RecordMenuEntry[];
  readonly onClose: () => void;
}) {
  const { ref: menuRef } = useCreateFloatingLayerAnchor<HTMLDivElement>({
    open,
    anchorRef,
    minWidth: 196,
    maxHeight: 400,
    preferAbove: true,
  });

  useDismissOnOutside(open, menuRef, anchorRef, onClose);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  useEffect(() => {
    if (open) menuRef.current?.focus();
  }, [menuRef, open]);

  return createPortal(
    <div
      ref={menuRef}
      role="dialog"
      aria-label="更多操作"
      tabIndex={-1}
      className="create-record-menu"
    >
      {items.map((item) => (
        <div key={item.id}>
          {item.dividerBefore ? <div className="create-record-menu__divider" /> : null}
          <button
            type="button"
            className="create-record-menu__item"
            disabled={item.disabled}
            title={item.hint}
            onClick={item.onSelect}
          >
            <JimengIcon name={item.icon} />
            <span className="create-record-menu__item-label">{item.label}</span>
            {item.isNew ? <span className="create-record-menu__item-new">New</span> : null}
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
