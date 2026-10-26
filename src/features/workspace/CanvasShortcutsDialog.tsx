import { useCallback, useEffect, useId, useRef, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

import { Icon } from "../../components/Icon";
import "./CanvasChromeOverlays.css";

export interface CanvasShortcutsDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

/** 一条快捷键。 */
interface ShortcutEntry {
  readonly id: string;
  /** 文案照抄原站 i18n，键名见各分组注释。 */
  readonly label: string;
  /**
   * 按键帽序列。
   *
   * `mod` / `alt` / `shift` 是平台占位符，渲染时按系统换成 ⌘/⌥/⇧ 或
   * Ctrl/Alt/Shift；其余按原样显示。
   */
  readonly keys: readonly string[];
  /** 按键帽之后的补充说明（如「+拖动节点」），不是按键帽。 */
  readonly suffix?: string;
  /**
   * 本项目是否真的绑定了这条快捷键。
   *
   * 面板文案照抄原站 i18n，但原站有、本项目没有对应能力的那些条目（画布连线、
   * 复制整组、搜索节点、整理画布、抓手/移动工具、导演台…）不能继续摆成
   * "可用"的样式：用户照着按却毫无反应，比不列出来更糟。置灰并标注「待接入」。
   */
  readonly available?: boolean;
}

/** 一个快捷键分组。 */
interface ShortcutGroup {
  readonly id: string;
  readonly title: string;
  readonly entries: readonly ShortcutEntry[];
}

/*
 * 分组与文案全部取自 liblib.tv 原站 i18n（.tmp/rea-liblib/i18n.json），
 * 键位取自原站画布快捷键注册表与快捷键面板源码
 * （.tmp/rea-liblib/static/3m6r0030cp57b.js、19e5aippy_pto.js）。
 *
 * 键位可信度分三档：
 *   · 原站注册表里能查到 combo 的 —— 直接照抄，标注「原站」；
 *   · 原站 i18n 里有文案、但捕获的分包里查不到 combo 的 —— 键位为占位，
 *     标注「键位待定」；
 *   · 导演台整组 —— 原站该面板在未捕获的懒加载分包里，键位全部为占位。
 */
const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  {
    id: "creation",
    // shortcutGroupCreation
    title: "创作",
    entries: [
      // shortcutLabelConnect —— 原站 canvas.connect = mod+l；本项目没有连线模式入口
      { id: "connect", label: "连线", keys: ["mod", "l"], available: false },
      // shortcutLabelCopyExpanded —— 键位待定（与复制节点的 mod+d 同族，取 shift 变体）
      {
        id: "copy-expanded",
        label: "复制整组",
        keys: ["mod", "shift", "d"],
        available: false,
      },
      // shortcutLabelGroup —— 原站 canvas.group = mod+g
      { id: "group", label: "成组", keys: ["mod", "g"] },
      // shortcutLabelUngroup —— 原站 canvas.ungroup = mod+shift+g
      { id: "ungroup", label: "解组", keys: ["mod", "shift", "g"] },
      // shortcutNodeCopy + shortcutPlusDragNode —— 原站面板里的 Alt + 拖动节点
      {
        id: "node-copy",
        label: "节点复制",
        keys: ["alt"],
        suffix: "+拖动节点",
        available: false,
      },
      // shortcutCreateCopy + shortcutPlusDrag —— 原站面板里的 Ctrl + Alt + 拖动
      {
        id: "create-copy",
        label: "创建副本",
        keys: ["mod", "alt"],
        suffix: "+拖动",
        available: false,
      },
    ],
  },
  {
    id: "generate",
    // shortcutGroupGenerate
    title: "生成",
    entries: [
      // shortcutGroupGenerate —— 原站 canvas.generate = mod+enter
      { id: "generate", label: "生成", keys: ["mod", "enter"], available: false },
      // shortcutFullscreen —— 键位待定（原站是节点播放器的全屏提示）
      { id: "fullscreen", label: "全屏", keys: ["f"], available: false },
    ],
  },
  {
    id: "move-canvas",
    // shortcutGroupMoveCanvas
    title: "移动画布",
    entries: [
      // keyboardShortcutsPanelCanvasMove —— 原站键盘平移 = Space + 拖动
      {
        id: "move-canvas",
        label: "移动画布",
        keys: ["space"],
        suffix: "+拖动",
        available: false,
      },
      // toolModeMove —— 原站 canvas.tool-move = v
      { id: "tool-move", label: "移动", keys: ["v"], available: false },
      // toolModeHand —— 原站 canvas.tool-hand = h
      { id: "tool-hand", label: "抓手工具", keys: ["h"], available: false },
      // shortcutLabelFormatLayout —— 原站 canvas.format-layout = alt+shift+f
      {
        id: "format-layout",
        label: "整理画布",
        keys: ["alt", "shift", "f"],
        available: false,
      },
    ],
  },
  {
    id: "zoom",
    // shortcutGroupZoom
    title: "缩放",
    entries: [
      // shortcutLabelZoomIn —— 原站 canvas.zoom-in = mod+= / mod+shift+plus
      // 键帽写 "="：实现绑的是 mod+=，而该库对未声明 shift 的热键会拒绝带 Shift
      // 修饰，写成 "+" 会让人以为 Ctrl+Shift++ 也能用。
      { id: "zoom-in", label: "放大", keys: ["mod", "="] },
      // shortcutLabelZoomOut —— 原站 canvas.zoom-out = mod+-
      { id: "zoom-out", label: "缩小", keys: ["mod", "-"] },
      // shortcutLabelFitView —— 原站 canvas.fit-view = mod+0
      { id: "fit-view", label: "适应画布", keys: ["mod", "0"] },
    ],
  },
  {
    id: "other",
    // shortcutGroupOther
    title: "其他",
    entries: [
      // shortcutLabelDelete —— 原站 canvas.delete-selection = delete / backspace
      { id: "delete", label: "删除", keys: ["Delete"] },
      /*
       * shortcutLabelExitCapture —— 原站 canvas.exit-capture = esc，
       * 但本项目没有截图模式：Esc 实际是取消框选 / 取消选中 / 关移动面板。
       * 文案照抄原站会指向一个不存在的功能，这里按真实语义写。
       */
      { id: "exit-capture", label: "取消选择", keys: ["Esc"] },
      // common:undo —— 原站撤销 = mod+z
      { id: "undo", label: "撤销", keys: ["mod", "z"] },
      // common:redo —— 原站重做 = mod+shift+z
      { id: "redo", label: "重做", keys: ["mod", "shift", "z"] },
      // shortcutLabelSearchNodes —— 原站 canvas.search-nodes = mod+f
      { id: "search-nodes", label: "画布节点搜索", keys: ["mod", "f"], available: false },
    ],
  },
  {
    id: "director",
    // nodeTypeDirectorConsole —— 导演台快捷键组；键位为占位（原站面板未捕获）
    // 导演台本项目后端未接入（见「工作流功能约定」），整组标注为待接入。
    title: "导演台",
    entries: [
      { id: "director-delete", label: "删除", keys: ["Delete"], available: false },
      { id: "director-group", label: "打组", keys: ["mod", "g"], available: false },
      { id: "director-ungroup", label: "解组", keys: ["mod", "shift", "g"], available: false },
      { id: "director-undo", label: "撤销", keys: ["mod", "z"], available: false },
      { id: "director-front-view", label: "正面视角", keys: ["1"], available: false },
      { id: "director-top-view", label: "俯视视角", keys: ["3"], available: false },
      { id: "director-snap-to-grid", label: "网格吸附", keys: ["g"], available: false },
      { id: "director-reset-view", label: "重置视角", keys: ["0"], available: false },
      { id: "director-move-view", label: "移动当前视角", keys: ["方向键"], available: false },
    ],
  },
];

/** 平台判断：macOS 用 ⌘/⌥/⇧，其余用 Ctrl/Alt/Shift（与原站一致）。 */
function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac OS X|Macintosh/i.test(navigator.userAgent);
}

/** 把按键占位符翻成本平台的写法。 */
function keyCapLabel(token: string, mac: boolean): string {
  switch (token) {
    case "mod":
      return mac ? "⌘" : "Ctrl";
    case "alt":
      return mac ? "⌥" : "Alt";
    case "shift":
      return mac ? "⇧" : "Shift";
    default:
      return token;
  }
}

/**
 * 画布快捷键面板：按分组列出原站的画布快捷键。
 *
 * 交互对齐原站的模态面板：点遮罩关闭、Esc 关闭、焦点锁在面板内、
 * 关闭后焦点回到触发它的那个按钮。
 */
export function CanvasShortcutsDialog({ open, onClose }: CanvasShortcutsDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const mac = isMacPlatform();

  /*
   * 打开时记住当前焦点元素，关闭后还回去——否则键盘用户会被丢回文档开头，
   * 找不到刚按下的那个快捷键入口。
   */
  useEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    restoreFocusRef.current = active instanceof HTMLElement ? active : null;
    closeRef.current?.focus();
    return () => {
      const target = restoreFocusRef.current;
      restoreFocusRef.current = null;
      if (target !== null && target.isConnected) target.focus();
    };
  }, [open]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      /*
       * 焦点锁在面板内：面板里只有关闭按钮是可聚焦控件，Tab 在它自己身上
       * 循环，Shift+Tab 同理，不会跑到背后的画布上去。
       */
      const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
        "button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])",
      );
      if (focusable === undefined || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first === undefined || last === undefined) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  if (!open) return null;

  return createPortal(
    <div className="canvas-shortcuts-dialog">
      {/* 遮罩与面板是兄弟节点：点面板不会冒泡到遮罩，不用再手动拦事件。 */}
      <div className="canvas-shortcuts-dialog__backdrop" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        className="canvas-shortcuts-dialog__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={handleKeyDown}
      >
        <h2 id={titleId} className="sr-only">
          快捷键
        </h2>
        <button
          ref={closeRef}
          type="button"
          className="canvas-shortcuts-dialog__close"
          aria-label="关闭快捷键面板"
          onClick={onClose}
        >
          <Icon name="x" size="xs" aria-hidden="true" />
        </button>
        <div className="canvas-shortcuts-dialog__groups">
          {SHORTCUT_GROUPS.map((group) => (
            <section key={group.id} className="canvas-shortcuts-dialog__group">
              <h3 className="canvas-shortcuts-dialog__group-title">{group.title}</h3>
              <ul className="canvas-shortcuts-dialog__entries">
                {group.entries.map((entry) => (
                  <li
                    key={entry.id}
                    className={`canvas-shortcuts-dialog__entry${
                      entry.available === false ? " is-unavailable" : ""
                    }`}
                  >
                    <span className="canvas-shortcuts-dialog__entry-label">{entry.label}</span>
                    <span className="canvas-shortcuts-dialog__keys">
                      {entry.keys.map((token, index) => (
                        <span key={`${entry.id}-${token}-${index}`}>
                          {index > 0 ? (
                            <span
                              className="canvas-shortcuts-dialog__key-separator"
                              aria-hidden="true"
                            >
                              +
                            </span>
                          ) : null}
                          <kbd className="canvas-shortcuts-dialog__key">
                            {keyCapLabel(token, mac)}
                          </kbd>
                        </span>
                      ))}
                      {entry.suffix !== undefined ? (
                        <span className="canvas-shortcuts-dialog__key-suffix">{entry.suffix}</span>
                      ) : null}
                      {entry.available === false ? (
                        <span className="canvas-shortcuts-dialog__entry-pending">待接入</span>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
