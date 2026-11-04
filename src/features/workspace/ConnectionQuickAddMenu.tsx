import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useEscapeHandler } from "../../components/escapeArbiter";
import { CANVAS_ADD_NODE_CHOICES, CANVAS_ADD_SCRIPT_CHOICES, CANVAS_QUICK_ADD_CHOICES, type CanvasQuickAddKind } from "./canvasQuickAddCatalog";
import { LibTVMediaIcon, type LibTVMediaIconName } from "./LibTVMediaIcon";
import "./ConnectionQuickAddMenu.css";

export interface QuickAddSearchNode {
  readonly key: string;
  readonly label: string;
  readonly typeLabel: string;
  readonly icon: LibTVMediaIconName;
}

export interface ConnectionQuickAddMenuProps {
  readonly position: { readonly x: number; readonly y: number };
  readonly aboveTrigger?: boolean;
  readonly connectionMode?: boolean;
  readonly searchOnly?: boolean;
  readonly allowedKinds?: readonly CanvasQuickAddKind[] | undefined;
  readonly hint?: string | undefined;
  readonly triggerElement?: HTMLElement | null;
  readonly portSide?: "left" | "right" | undefined;
  readonly onSelect: (kind: CanvasQuickAddKind) => void;
  readonly onUpload: () => void;
  readonly onHistory: () => void;
  readonly readSearchNodes: () => readonly QuickAddSearchNode[];
  readonly onLocate: (key: string) => void;
  readonly onClose: () => void;
}

const MARGIN = 8;
function positionMenu(element: HTMLElement, x: number, y: number) {
  const { width, height } = element.getBoundingClientRect();
  element.style.left = Math.max(MARGIN, Math.min(x, document.documentElement.clientWidth - width - MARGIN)) + "px";
  element.style.top = Math.max(MARGIN, Math.min(y, window.innerHeight - height - MARGIN)) + "px";
}

export function ConnectionQuickAddMenu({
  position, aboveTrigger = false, connectionMode = false, hint, triggerElement, portSide, onSelect, onUpload, onHistory,
  readSearchNodes, onLocate, onClose, allowedKinds, searchOnly = false,
}: ConnectionQuickAddMenuProps) {
  const descriptionId = useId();
  const submenuId = useId();
  const menu = useRef<HTMLDivElement>(null);
  const submenu = useRef<HTMLDivElement>(null);
  const scriptTrigger = useRef<HTMLButtonElement>(null);
  const searchTrigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const closeSubmenuTimer = useRef<number | undefined>(undefined);
  const [scriptsOpen, setScriptsOpen] = useState(false);
  const [searchNodes, setSearchNodes] = useState<readonly QuickAddSearchNode[] | null>(() => searchOnly ? readSearchNodes() : null);
  const [query, setQuery] = useState("");
  const searching = searchNodes != null;
  const searchResults = searchNodes?.filter(node =>
    (node.label + " " + node.typeLabel).toLowerCase().includes(query.trim().toLowerCase()),
  );
  const choices = allowedKinds
    ? CANVAS_QUICK_ADD_CHOICES.filter(({ kind }) => allowedKinds.includes(kind))
    : connectionMode ? CANVAS_QUICK_ADD_CHOICES : CANVAS_ADD_NODE_CHOICES;
  const closeScripts = () => {
    window.clearTimeout(closeSubmenuTimer.current);
    setScriptsOpen(false);
  };
  const keepScripts = () => window.clearTimeout(closeSubmenuTimer.current);
  const leaveScripts = () => {
    keepScripts();
    closeSubmenuTimer.current = window.setTimeout(() => setScriptsOpen(false), 120);
  };

  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    const port = portSide ? triggerElement?.querySelector(".canvas-flow-handle__circle") : null;
    if (port) {
      const rect = port.getBoundingClientRect();
      const width = element.getBoundingClientRect().width;
      const left = rect.left - 8 - width;
      const right = rect.right + 8;
      const rightFits = right + width + MARGIN <= document.documentElement.clientWidth;
      const x = portSide === "left"
        ? left >= MARGIN || !rightFits ? left : right
        : rightFits || left < MARGIN ? right : left;
      positionMenu(element, x, rect.top);
    } else {
      const top = aboveTrigger ? position.y - element.getBoundingClientRect().height - 6 : position.y;
      positionMenu(element, position.x, top);
    }
  }, [aboveTrigger, portSide, triggerElement, position.x, position.y, searching, searchResults?.length]);
  useLayoutEffect(() => {
    if (!portSide || !triggerElement) return;
    triggerElement.setAttribute("aria-expanded", "true");
    return () => triggerElement.removeAttribute("aria-expanded");
  }, [portSide, triggerElement]);
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && !menu.current?.contains(active)) previousFocus.current = active;
    menu.current?.querySelector<HTMLButtonElement>("[data-node-choice]")?.focus({ preventScroll: true });
  }, []);
  useLayoutEffect(() => {
    if (searching) input.current?.focus({ preventScroll: true });
  }, [searching]);
  useLayoutEffect(() => {
    if (!scriptsOpen || !scriptTrigger.current || !submenu.current) return;
    const trigger = scriptTrigger.current.getBoundingClientRect();
    const parent = menu.current?.getBoundingClientRect() ?? trigger;
    const width = submenu.current.getBoundingClientRect().width;
    const left = parent.right + 4 + width + MARGIN <= document.documentElement.clientWidth
      ? parent.right + 4 : parent.left - width - 4;
    positionMenu(submenu.current, left, trigger.top);
  }, [scriptsOpen, position.x, position.y]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menu.current?.contains(event.target) &&
          !submenu.current?.contains(event.target) && !triggerElement?.contains(event.target)) onClose();
    };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose, triggerElement]);
  useEffect(() => () => window.clearTimeout(closeSubmenuTimer.current), []);
  useEscapeHandler({ canHandle: () => true, handle: () => {
    if (scriptsOpen) {
      closeScripts();
      scriptTrigger.current?.focus({ preventScroll: true });
    } else if (searching && !searchOnly) {
      setSearchNodes(null);
      setQuery("");
      window.requestAnimationFrame(() => searchTrigger.current?.focus({ preventScroll: true }));
    } else {
      onClose();
      if (previousFocus.current?.isConnected) previousFocus.current.focus({ preventScroll: true });
    }
  } }, true);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") return;
    event.stopPropagation();
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    const inSubmenu = submenu.current?.contains(document.activeElement);
    if (event.key === "ArrowRight" && document.activeElement === scriptTrigger.current && !connectionMode) {
      event.preventDefault();
      keepScripts();
      setScriptsOpen(true);
      window.requestAnimationFrame(() => submenu.current?.querySelector("button")?.focus());
      return;
    }
    if (event.key === "ArrowLeft" && inSubmenu) {
      event.preventDefault();
      closeScripts();
      scriptTrigger.current?.focus();
      return;
    }
    const rows = Array.from((inSubmenu ? submenu.current : menu.current)?.querySelectorAll<HTMLButtonElement>("[data-menu-row]") ?? []);
    if (!rows.length) return;
    const index = rows.findIndex(button => button === document.activeElement);
    const next = event.key === "ArrowDown" ? (index + 1) % rows.length :
      event.key === "ArrowUp" ? (index <= 0 ? rows.length - 1 : index - 1) :
        document.activeElement !== input.current && event.key === "Home" ? 0 :
          document.activeElement !== input.current && event.key === "End" ? rows.length - 1 : null;
    if (next != null) {
      event.preventDefault();
      rows[next]?.focus();
    } else if (searching && event.key === "Enter" && document.activeElement === input.current) {
      event.preventDefault();
      rows[0]?.click();
    }
  };

  return createPortal(
    <div onKeyDown={handleKeyDown} onKeyUp={event => event.stopPropagation()}
      onBlur={event => {
        if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) onClose();
      }}
      onPointerDown={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()}
      onMouseDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
      onDoubleClick={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}
      onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}>
      <div ref={menu} role={searching ? "dialog" : "menu"} aria-label={searching ? "搜索画布节点" : "添加节点"}
        aria-describedby={connectionMode && hint ? descriptionId : undefined}
        className="connection-quick-add-menu nodrag nopan nowheel"
        style={{ left: position.x, top: position.y }} onScroll={closeScripts}>
        {searching ? <>
          <input className="connection-quick-add-menu__search-input" ref={input} type="search"
            placeholder="搜索画布节点" aria-label="搜索画布节点" value={query} onChange={event => setQuery(event.currentTarget.value)} />
          {searchResults?.map(node => <button key={node.key} type="button" data-menu-row=""
            className="connection-quick-add-menu__item" onClick={() => onLocate(node.key)}>
            <LibTVMediaIcon name={node.icon} size={16} /><span className="connection-quick-add-menu__node-label">{node.label}</span>
            <small>{node.typeLabel}</small>
          </button>)}
          {!searchResults?.length ? <p className="connection-quick-add-menu__empty">没有匹配的节点</p> : null}
        </> : <>
          <div className="connection-quick-add-menu__heading" role="presentation">
            <span>{connectionMode ? (hint?.includes("接入") ? "添加上下文" : "引用该节点生成") : "添加节点"}</span>
            {connectionMode && hint ? <span id={descriptionId} className="sr-only">{hint}</span> : null}
            {!connectionMode ? <button ref={searchTrigger} type="button" role="menuitem" data-menu-row=""
              className="connection-quick-add-menu__search" aria-label="搜索画布节点" data-tooltip="搜索画布节点"
              onClick={() => { closeScripts(); setSearchNodes(readSearchNodes()); }}>
              <LibTVMediaIcon name="menu-q4-search-small" size={16} />
            </button> : null}
          </div>
          {choices.map(({ kind, label, icon, badge, available }) => {
            const isScript = !connectionMode && kind === "screenplay";
            return <button key={kind} type="button" role="menuitem" data-menu-row="" data-node-choice=""
              ref={isScript ? scriptTrigger : undefined}
              aria-haspopup={isScript ? "menu" : undefined} aria-expanded={isScript ? scriptsOpen : undefined}
              aria-controls={isScript && scriptsOpen ? submenuId : undefined}
              data-tooltip={available === false ? label + "暂未接入" : undefined}
              className="connection-quick-add-menu__item"
              onPointerEnter={event => {
                if (event.pointerType !== "mouse") return;
                if (isScript) { keepScripts(); setScriptsOpen(true); } else closeScripts();
              }}
              onPointerLeave={isScript ? leaveScripts : undefined}
              onClick={() => {
                if (!isScript) { onSelect(kind); return; }
                keepScripts();
                setScriptsOpen(true);
                window.requestAnimationFrame(() => submenu.current?.querySelector("button")?.focus());
              }}>
              <LibTVMediaIcon name={icon} size={18} /><span>{label}</span>
              {badge ? <span className="connection-quick-add-menu__badge" data-new={badge === "NEW" || undefined}>{badge}</span> : null}
              {isScript ? <LibTVMediaIcon name="nt-chevron-right-small" size={18} className="connection-quick-add-menu__arrow" /> : null}
            </button>;
          })}
          {!connectionMode ? <>
            <div className="connection-quick-add-menu__separator" role="separator" />
            <div className="connection-quick-add-menu__heading" role="presentation">添加资源</div>
            <button type="button" role="menuitem" data-menu-row="" className="connection-quick-add-menu__item" onClick={onUpload}>
              <LibTVMediaIcon name="menu-q4-upload" size={18} /><span>上传</span>
            </button>
            <button type="button" role="menuitem" data-menu-row="" className="connection-quick-add-menu__item" onClick={onHistory}>
              <LibTVMediaIcon name="menu-q4-history" size={18} /><span>从生成历史选择</span>
            </button>
          </> : null}
        </>}
      </div>
      {scriptsOpen ? <div id={submenuId} ref={submenu} role="menu" aria-label="脚本"
        className="connection-quick-add-menu nodrag nopan nowheel"
        onPointerEnter={keepScripts} onPointerLeave={leaveScripts}>
        {CANVAS_ADD_SCRIPT_CHOICES.map(choice => <button key={choice.kind} type="button" role="menuitem" data-menu-row=""
          className="connection-quick-add-menu__item" onClick={() => onSelect(choice.kind)}>
          <span>{choice.label}</span><span className="connection-quick-add-menu__badge" data-new={choice.badge === "NEW" || undefined}>{choice.badge}</span>
        </button>)}
      </div> : null}
    </div>, document.body,
  );
}
