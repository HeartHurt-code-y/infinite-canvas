import { useId } from "react";
import { createPortal } from "react-dom";
import { useModalFocusTrap } from "../../components/useModalFocusTrap";
import { LibTVMediaIcon, type LibTVMediaIconName } from "./LibTVMediaIcon";
import { CANVAS_SHORTCUTS, type CanvasShortcut } from "./canvasShortcuts";
import "./CanvasChromeOverlays.css";

interface ShortcutRow {
  readonly label: string;
  readonly action?: CanvasShortcut;
  readonly keys?: readonly string[];
  readonly suffix?: string;
  readonly gesture?: LibTVMediaIconName;
}

const GROUPS: readonly { title: string; rows: readonly ShortcutRow[] }[] = [
  { title: "创作", rows: [
    { label: "成组", action: "group", keys: ["mod/alt", "g"] },
    { label: "合并分镜组", action: "storyboard" },
    { label: "解组", action: "ungroup", keys: ["mod/alt", "shift", "g"] },
    { label: "连线", action: "connect" },
    { label: "复制节点和连线", action: "duplicate" },
    { label: "生成", action: "generate" },
    { label: "新建节点", action: "add" },
    { label: "节点复制", keys: ["alt"], suffix: "+拖动节点" },
    { label: "创建副本", keys: ["mod", "alt"], suffix: "+拖动" },
  ] },
  { title: "缩放", rows: [
    { label: "放大", action: "zoomIn", keys: ["mod", "+"] },
    { label: "缩小", action: "zoomOut" },
    { label: "适应画布", action: "fit" },
    { label: "触控板", gesture: "shortcut-pinch", suffix: "双指捏合" },
    { label: "鼠标", keys: ["mod"], gesture: "shortcut-wheel", suffix: "滚轮" },
  ] },
  { title: "移动画布", rows: [
    { label: "键盘", keys: ["space"], gesture: "shortcut-space-drag", suffix: "左键拖动" },
    { label: "触控板", gesture: "shortcut-trackpad-pan", suffix: "双指滑动" },
    { label: "鼠标", gesture: "shortcut-mouse-pan", suffix: "中键拖动" },
    { label: "移动", action: "move" },
    { label: "抓手工具", action: "hand" },
    { label: "整理画布", action: "format" },
  ] },
  { title: "其他", rows: [
    { label: "撤销", action: "undo" },
    { label: "重做", action: "redo" },
    { label: "画布节点搜索", action: "search" },
    { label: "删除", action: "delete" },
  ] },
];

function keyCap(token: string, mac: boolean) {
  switch (token) {
    case "mod/alt": return mac ? "⌘/⌥" : "Ctrl/Alt";
    case "mod": return mac ? "⌘" : "Ctrl";
    case "alt": return mac ? "⌥" : "Alt";
    case "shift": return mac ? "⇧" : "Shift";
    case "delete": return "Del";
    case "-": return "−";
    default: return token.length === 1 ? token.toUpperCase() : token[0]?.toUpperCase() + token.slice(1);
  }
}

export function CanvasShortcutsDialog({ anchor, onClose }: {
  readonly anchor: HTMLElement | null;
  readonly onClose: () => void;
}) {
  const id = useId();
  const trap = useModalFocusTrap({ active: anchor != null, onEscape: onClose });
  if (!anchor) return null;
  const mac = /Mac OS X|Macintosh/i.test(navigator.userAgent);
  const trigger = anchor.getBoundingClientRect();
  const stage = anchor.closest(".canvas-stage")?.getBoundingClientRect();
  const center = stage ? stage.left + stage.width / 2 : window.innerWidth / 2;
  const width = Math.min(1152, Math.max(0, (stage?.width ?? window.innerWidth) - 32));
  const left = Math.min(window.innerWidth - width - 16, Math.max(16, center - width / 2));
  const bottom = window.innerHeight - trigger.top + 20;
  return createPortal(
    <div className="canvas-shortcuts-dialog">
      <div className="canvas-shortcuts-dialog__backdrop" onClick={onClose} aria-hidden="true" />
      <div className="canvas-shortcuts-dialog__panel" ref={trap.ref} {...trap.containerProps}
        role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1}
        style={{ width, left, bottom, maxHeight: `calc(100dvh - ${bottom + 16}px)`,
          "--shortcuts-arrow": Math.max(18, Math.min(width - 18, trigger.left + trigger.width / 2 - left)) + "px" } as React.CSSProperties}>
        <h2 id={id} className="sr-only">快捷键</h2>
        <button type="button" className="canvas-shortcuts-dialog__close" aria-label="关闭快捷键面板" onClick={onClose}>
          <LibTVMediaIcon name="close" size={18} />
        </button>
        <div className="canvas-shortcuts-dialog__groups">
          {GROUPS.map(group => <section key={group.title} className="canvas-shortcuts-dialog__group">
            <h3 className="canvas-shortcuts-dialog__group-title">{group.title}</h3>
            <ul className="canvas-shortcuts-dialog__entries">
              {group.rows.map(row => {
                const keys = row.keys ?? (row.action ? CANVAS_SHORTCUTS[row.action][0].split("+") : []);
                return <li key={row.label} className="canvas-shortcuts-dialog__entry">
                  <span className="canvas-shortcuts-dialog__entry-label">{row.label}</span>
                  <span className="canvas-shortcuts-dialog__keys">
                    {keys.map((token, index) => <span key={token} className="canvas-shortcuts-dialog__key-part">
                      {index > 0 && !row.suffix ? <span className="canvas-shortcuts-dialog__key-separator" aria-hidden="true">+</span> : null}
                      <kbd className="canvas-shortcuts-dialog__key">{keyCap(token, mac)}</kbd>
                    </span>)}
                    {row.gesture ? <><LibTVMediaIcon name={row.gesture} size={26} /><span className="sr-only">{row.suffix}</span></> :
                      row.suffix ? <span className="canvas-shortcuts-dialog__key-suffix">{row.suffix}</span> : null}
                  </span>
                </li>;
              })}
            </ul>
          </section>)}
        </div>
      </div>
    </div>, document.body,
  );
}
