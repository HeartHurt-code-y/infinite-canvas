import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "../../components/Icon";
import { videoNodeEditorPlacement } from "./videoNodeEditorPlacement";
import type { CanvasNodeRect } from "./workspaceModel";
import "./VideoGenerationNode.css";
import "./CanvasNodePresentation.css";

/** 编辑区保留在视口独立层；只更新几何位置，平移和缩放不重建输入 DOM。 */
export function CanvasNodeEditorShell({
  nodeKey,
  kindLabel = "视频生成",
  name,
  anchor,
  open,
  onClose,
  children,
  expandOnOpen = false,
}: {
  readonly nodeKey: string;
  readonly kindLabel?: string;
  readonly name: string;
  readonly anchor: CanvasNodeRect;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly expandOnOpen?: boolean;
}) {
  const elementRef = useRef<HTMLElement>(null);
  const lastControl = useRef<HTMLElement | null>(null);
  const lastRange = useRef<Range | null>(null);
  const [expanded, setExpanded] = useState(false);
  const previouslyOpen = useRef(false);
  useLayoutEffect(() => {
    if (open && !previouslyOpen.current && expandOnOpen) setExpanded(true);
    previouslyOpen.current = open;
  }, [open, expandOnOpen]);
  const rememberFocus = useCallback((element: EventTarget | null = document.activeElement) => {
    if (!(element instanceof HTMLElement) || !elementRef.current?.contains(element)) return;
    if (
      !element.matches(
        "input:not([type='file']), select, textarea, [contenteditable='true'], button[data-video-settings-trigger]",
      )
    )
      return;
    lastControl.current = element;
    if (element.isContentEditable) {
      const selection = window.getSelection();
      if (
        selection?.rangeCount &&
        element.contains(selection.getRangeAt(0).commonAncestorContainer)
      ) {
        lastRange.current = selection.getRangeAt(0).cloneRange();
      }
    }
  }, []);
  const restoreFocus = useCallback(() => {
    const control = lastControl.current;
    if (!control?.isConnected || elementRef.current?.hidden) return;
    const panel = control.closest<HTMLElement>("[data-video-settings-panel]");
    if (panel?.hidden) {
      elementRef.current
        ?.querySelector<HTMLElement>(
          `[data-video-settings-trigger="${panel.dataset["videoSettingsPanel"]}"]`,
        )
        ?.click();
      requestAnimationFrame(() => control.focus({ preventScroll: true }));
      return;
    }
    if (control.closest("[hidden]")) return;
    control.focus({ preventScroll: true });
    if (control.isContentEditable && lastRange.current?.startContainer.isConnected) {
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(lastRange.current);
    }
  }, []);

  useLayoutEffect(() => {
    const editor = elementRef.current;
    const stage = editor?.closest<HTMLElement>(".canvas-viewport");
    if (!open || !editor || !stage) return;
    const viewport = stage.querySelector<HTMLElement>(".react-flow__viewport");
    const nodes = stage.querySelector(".react-flow__nodes");
    const docks = [
      ...(stage.closest(".canvas-stage") ?? stage).querySelectorAll<HTMLElement>(
        ".canvas-creation-dock, .canvas-viewport-dock",
      ),
    ];
    let observedNode: Element | null = null;
    const nodeObserver =
      typeof MutationObserver === "undefined" ? null : new MutationObserver(() => place());
    const place = () => {
      const preview = document.getElementById(`node-preview-${nodeKey}`);
      const wrapper = preview?.closest(".react-flow__node") ?? null;
      if (wrapper !== observedNode) {
        nodeObserver?.disconnect();
        observedNode = wrapper;
        if (wrapper)
          nodeObserver?.observe(wrapper, { attributes: true, attributeFilter: ["style", "class"] });
      }
      editor.style.visibility =
        !expanded && wrapper?.classList.contains("dragging") ? "hidden" : "";
      if (expanded) {
        editor.style.left = "";
        editor.style.top = "";
        editor.style.width = "";
        editor.style.maxHeight = "";
        return;
      }
      const bounds = stage.getBoundingClientRect();
      const transform = viewport?.style.transform ?? "";
      const scale = /scale\(([-\d.e]+)\)/u.exec(transform);
      const translate = /translate\(([-\d.e]+)px,\s*([-\d.e]+)px\)/u.exec(transform);
      const zoom = Number(scale?.[1] ?? 1) || 1;
      const rect = preview?.getBoundingClientRect();
      const node =
        rect && rect.width > 0
          ? {
              x: rect.left - bounds.left,
              y: rect.top - bounds.top,
              width: rect.width,
              height: rect.height,
            }
          : {
              x: anchor.x * zoom + Number(translate?.[1] ?? 0),
              y: anchor.y * zoom + Number(translate?.[2] ?? 0),
              width: anchor.width * zoom,
              height: anchor.height * zoom,
            };
      const rootFont = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const clearance = getComputedStyle(stage)
        .getPropertyValue("--size-studio-dock-clearance")
        .trim();
      let bottomClearance = clearance.endsWith("rem")
        ? Number.parseFloat(clearance) * rootFont
        : Number.parseFloat(clearance) || 88;
      // 短/窄窗口会把视口工具坞抬高或换行，固定底部距离不足以保留点击区域。
      // 按当前画布工具坞的真实上边界预留空间，编辑器与生成按钮一起向内避让。
      for (const dock of docks) {
        const dockBounds = dock.getBoundingClientRect();
        if (
          dockBounds.width > 0 &&
          dockBounds.height > 0 &&
          dockBounds.top < bounds.bottom &&
          dockBounds.bottom > bounds.top &&
          dockBounds.left < bounds.right &&
          dockBounds.right > bounds.left
        ) {
          bottomClearance = Math.max(bottomClearance, bounds.bottom - dockBounds.top);
        }
      }
      const box = videoNodeEditorPlacement(
        node,
        {
          width: stage.clientWidth || bounds.width || window.innerWidth,
          height: stage.clientHeight || bounds.height || window.innerHeight,
        },
        editor.offsetHeight,
        zoom,
        bottomClearance,
      );
      editor.style.left = `${box.left + stage.scrollLeft}px`;
      editor.style.top = `${box.top + stage.scrollTop}px`;
      editor.style.width = `${box.width}px`;
      editor.style.maxHeight = `${box.maxHeight}px`;
    };
    place();
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        place();
      });
    };
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    resize?.observe(stage);
    resize?.observe(editor);
    for (const dock of docks) resize?.observe(dock);
    const observer = typeof MutationObserver === "undefined" ? null : new MutationObserver(place);
    if (viewport) observer?.observe(viewport, { attributes: true, attributeFilter: ["style"] });
    if (nodes) observer?.observe(nodes, { childList: true });
    window.addEventListener("resize", place);
    stage.addEventListener("scroll", schedule);
    return () => {
      resize?.disconnect();
      observer?.disconnect();
      nodeObserver?.disconnect();
      window.removeEventListener("resize", place);
      stage.removeEventListener("scroll", schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [anchor.x, anchor.y, anchor.width, anchor.height, nodeKey, open, expanded]);

  useLayoutEffect(() => {
    if (!open) return;
    const explicitOpen =
      document.activeElement instanceof HTMLElement &&
      document.activeElement.dataset["openNodeEditor"] === nodeKey;
    if (lastControl.current) restoreFocus();
    else if (explicitOpen)
      elementRef.current
        ?.querySelector<HTMLElement>("[role='textbox'], textarea")
        ?.focus({ preventScroll: true });
    const capture = () => rememberFocus();
    document.addEventListener("pointerdown", capture, true);
    document.addEventListener("selectionchange", capture);
    return () => {
      document.removeEventListener("pointerdown", capture, true);
      document.removeEventListener("selectionchange", capture);
    };
  }, [nodeKey, open, rememberFocus, restoreFocus]);

  const toggleExpanded = () => {
    rememberFocus();
    setExpanded((value) => !value);
    requestAnimationFrame(restoreFocus);
  };
  return (
    <div className="video-node-editor-anchor" data-expanded={open && expanded ? "true" : undefined}>
      {open && expanded ? (
        <div
          className="video-node-editor__backdrop"
          aria-hidden="true"
          onMouseDown={(event) => {
            event.preventDefault();
            toggleExpanded();
          }}
        />
      ) : null}
      <aside
        ref={elementRef}
        id={`node-editor-${nodeKey}`}
        className={`video-node-editor canvas-node-editor${expanded ? " is-expanded" : ""}`}
        hidden={!open}
        role={expanded ? "dialog" : undefined}
        /*
         * 刻意**不**声明 `aria-modal`。
         *
         * 这个编辑区是**画布节点的一部分**，不是一个独立模态：展开时用户要的是
         * 「在这个节点里编辑」，而 `aria-modal="true"` 会让读屏屏蔽整个画布 ——
         * 正好屏蔽掉用户此刻仍然需要参照的其它节点。
         *
         * 它还带来一个连带后果：`aria-modal` 元素在画布子树内，焦点陷阱的
         * 「冻结背景」按 body 直接子节点做豁免（子树里含 aria-modal 就跳过），
         * 于是画布整体被免于冻结，背景始终可聚焦。
         */
        aria-label={`${kindLabel}编辑区：${name}`}
        data-video-node-key={kindLabel === "视频生成" ? nodeKey : undefined}
        data-node-key={nodeKey}
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onBlurCapture={(event) => rememberFocus(event.target)}
        onFocusCapture={(event) => rememberFocus(event.target)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape") {
            // Tiptap 会默认消费 Escape；引用候选和设置弹层通过 stopPropagation
            // 优先收起自身，冒泡到这里的 Escape 仍须关闭当前编辑层。
            event.preventDefault();
            event.stopPropagation();
            if (expanded) toggleExpanded();
            else onClose();
            return;
          }
          if (event.defaultPrevented || event.key !== "Tab" || !expanded) return;
          const controls = [
            ...(elementRef.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled), input:not(:disabled):not([type="file"]), select:not(:disabled), textarea:not(:disabled), [contenteditable="true"]',
            ) ?? []),
          ].filter(
            (element) => !element.closest("[hidden]") && element.getClientRects().length > 0,
          );
          const first = controls[0];
          const last = controls.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
        <div className="video-node-editor__heading">
          <h2 className="sr-only">{name}</h2>
          <button
            type="button"
            aria-label={
              expanded
                ? `收起放大${kindLabel === "视频生成" ? "视频" : kindLabel}编辑器`
                : "放大编辑提示词"
            }
            aria-expanded={expanded}
            title={expanded ? "收起" : "展开编辑"}
            onMouseDown={(event) => {
              rememberFocus();
              event.preventDefault();
            }}
            onClick={toggleExpanded}
          >
            <Icon name="corners-out" aria-hidden="true" size="sm" />
          </button>
          <button
            className="video-node-editor__close"
            type="button"
            aria-label={`收起${kindLabel === "视频生成" ? "视频" : kindLabel}编辑区`}
            onMouseDown={() => rememberFocus()}
            onClick={() => {
              setExpanded(false);
              onClose();
            }}
          >
            <Icon name="x" aria-hidden="true" size="sm" />
          </button>
        </div>
        <div className="video-node-editor__scroll">{children}</div>
      </aside>
    </div>
  );
}
