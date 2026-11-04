import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import { placeFloatingLayer } from "../../components/floatingLayer";
import { ErrorAlert } from "../../components/ErrorAlert";
import { useEscapeHandler } from "../../components/escapeArbiter";
import { FloatingLayerParentContext, hasOpenChildLayer, isInsideFloatingLayerFamily,
  registerFloatingLayer, unregisterFloatingLayer, useFloatingLayerParentId } from "../create/floatingLayerFamily";
import { CanvasChromeIcon } from "./CanvasChromeIcons";
import { PromptMentionInput } from "./PromptNodeViews";
import { CanvasReferenceTools } from "./CanvasReferenceTools";
import type { PromptContentEditorSession } from "../../lib/promptContent";
import type { MentionCandidate, VideoClipInput, VideoClipNodeData } from "./workspaceModel";
import {
  VIDEO_CLIP_ALL_MODES,
  VIDEO_CLIP_ASPECT_RATIOS,
  VIDEO_CLIP_DURATION_RANGE,
  VIDEO_CLIP_RESOLUTIONS,
  videoClipMode,
  videoClipParamsSummary,
  videoClipRatioBox,
  type VideoClipModeKey,
  type VideoClipParams,
} from "./videoClipModes";
import "./VideoClipEditor.css";

/**
 * 「智能剪辑」合成编辑层。
 *
 * 照抄原站 liblib.tv 的 `video-clip` 节点编辑层（实测 2026-10-23，1707×898 /
 * DPR 1.5，画布缩放 45%）：
 *
 *   面板根    flex min-h-0 flex-col gap-2 p-2（658.7px 宽，间隙 8 / 内边距 8）
 *   工具行    flex flex-wrap items-center gap-1 pl-1 pt-1
 *              「＋参考」chip 54×26（12px 图标 + 12px 文字）
 *              素材瓦片 48×48（圆角 8，左上角序号角标 14×14，左下角时长）
 *   提示词区  relative flex-1 overflow-hidden rounded-xl p-2 min-h-20
 *              占位文案 14px / 行高 1.8 / 绝对定位 left-2 right-2 top-2
 *   底栏      flex items-center justify-between gap-2（高 32）
 *              左组：剪辑模式按钮（32 高，14px 剪刀 + 13px 文字 + 12px 箭头）
 *                    参数汇总按钮（32 高，比例示意框 + 13px 文字 + 14px 箭头）
 *              右组：提交键 32×32 圆角 12
 *
 * 两个浮层都 portal 到 body 并按原站实测贴靠：
 *   · 剪辑模式：229.3×170.1，左边缘与触发器左边缘齐平，底边距触发器顶边 4px；
 *   · 参数面板：341.3×310，左边缘齐平，底边与触发器顶边相接。
 */

export interface VideoClipEditorProps {
  readonly node: VideoClipNodeData;
  /** 已连到本节点的素材，按连线顺序。 */
  readonly inputs: readonly VideoClipInput[];
  readonly params: VideoClipParams;
  /** @ 引用候选：已连到本节点的素材实例。 */
  readonly candidates: readonly MentionCandidate[];
  readonly aliveCanvasNodeKeys?: ReadonlySet<string> | undefined;
  readonly registerPromptInput: (
    nodeKey: string,
    session: PromptContentEditorSession | null,
  ) => void;
  /** 合成进行中：提交键禁用，模式与参数锁定。 */
  readonly busy: boolean;
  /** 提交失败的人话报错。 */
  readonly error: string | null;
  readonly onModeChange: (modeKey: VideoClipModeKey) => void;
  readonly onParamsChange: (params: VideoClipParams) => void;
  readonly onSubmit: () => void;
  readonly onUnlink: (edgeId: string) => void;
}

export function VideoClipEditor({
  node,
  inputs,
  params,
  candidates,
  aliveCanvasNodeKeys,
  registerPromptInput,
  busy,
  error,
  onModeChange,
  onParamsChange,
  onSubmit,
  onUnlink,
}: VideoClipEditorProps) {
  const promptLabelId = `video-clip-prompt-label-${node.key}`;
  const promptHintId = `video-clip-prompt-hint-${node.key}`;

  return (
    <div className="video-clip-editor" aria-busy={busy || undefined}>
      <div className="video-node-editor__form">
        <div className="canvas-gen-node__tool-chips" role="group" aria-label="智能剪辑素材">
          <VideoClipReferenceButton node={node} disabled={busy} />
          {inputs.map((input, index) => (
            <VideoClipMaterialTile
              key={input.key}
              input={input}
              index={index + 1}
              disabled={busy}
              onUnlink={() => onUnlink(input.edgeId)}
            />
          ))}
        </div>

        <div className="canvas-gen-node__prompt-area video-clip-editor__prompt-area">
          <span id={promptLabelId} className="sr-only">
            智能剪辑提示词，描述想剪成什么效果
          </span>
          <span id={promptHintId} className="sr-only">
            {inputs.length > 0
              ? `已连接 ${inputs.length} 个素材`
              : "请连接视频节点，或从素材库添加参考"}
          </span>
          <PromptMentionInput
            nodeKey={node.key}
            candidates={candidates}
            {...(aliveCanvasNodeKeys ? { aliveCanvasNodeKeys } : {})}
            registerInput={registerPromptInput}
            labelledBy={promptLabelId}
            describedBy={promptHintId}
            expandable={false}
            placeholder="描述想剪成什么效果"
          />
        </div>

        {error ? (
          <div aria-label="智能剪辑提交失败">
            <ErrorAlert
              id={`video-clip-error-${node.key}`}
              error={error}
              hint="补齐素材或改写提示词后重试；提交回执不明确时请在历史里核对原任务，不要重复发起。"
            />
          </div>
        ) : null}

        <div className="video-clip-editor__footer">
          <div className="video-clip-editor__footer-left">
            <VideoClipModeButton
              modeKey={node.config.modeKey}
              disabled={busy}
              onModeChange={onModeChange}
            />
            <VideoClipParamsButton
              params={params}
              disabled={busy}
              onParamsChange={onParamsChange}
            />
          </div>
          <div className="video-clip-editor__footer-right">
            <button
              type="button"
              className="video-clip-editor__submit"
              data-canvas-generate=""
              aria-label="发送智能剪辑请求"
              // 报错与触发控件关联（WCAG 3.3.1）：键盘用户走到提交键就知道错在哪。
              aria-describedby={error ? `video-clip-error-${node.key}` : undefined}
              disabled={busy}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onSubmit();
              }}
            >
              <CanvasChromeIcon name="arrow-up" size={12} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * 素材瓦片：48×48 方形，圆角 8，左上角序号角标、左下角时长。
 * 悬停右上角出现解除连线按钮（原站同款）。
 */
function VideoClipMaterialTile({
  input,
  index,
  onUnlink,
  disabled,
}: {
  readonly input: VideoClipInput;
  readonly index: number;
  readonly onUnlink: () => void;
  readonly disabled: boolean;
}) {
  return (
    <span className="video-clip-editor__tile" title={input.name}>
      {input.previewUrl ? (
        <img className="video-clip-editor__tile-image" src={input.previewUrl} alt={input.name} />
      ) : (
        <span className="video-clip-editor__tile-placeholder" />
      )}
      <span className="video-clip-editor__tile-index" aria-hidden="true">
        {index}
      </span>
      {typeof input.durationSeconds === "number" && input.durationSeconds > 0 ? (
        <span className="video-clip-editor__tile-duration">
          {input.durationSeconds.toFixed(1)}s
        </span>
      ) : null}
      <button
        type="button"
        className="video-clip-editor__tile-remove"
        aria-label={`解除连线：${input.name}`}
        disabled={disabled}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onUnlink();
        }}
      >
        ×
      </button>
    </span>
  );
}

/* ── 浮层公共件：贴靠 + 实测高度 ─────────────────────────────────────── */

/**
 * 把浮层贴到触发器上方：左边缘与触发器齐平，底边留 `gap` 的缝。
 *
 * 高度必须用浮层自己的实测值（ResizeObserver 量），不能拿 CSS 上限当高度——
 * 否则面板会多上浮「上限 − 实际高度」px，与触发器之间裂开一条黑缝。
 *
 * 键盘与焦点（WCAG 2.1.1 / 2.4.3）：
 * - 打开时把焦点移进浮层首个可操作元素，键盘用户不用去「猜」浮层在哪；
 * - Esc 关闭并把焦点还给触发器；
 * - 点击浮层外部关闭时**不**抢焦点——那次点击的目标才是用户想去的地方。
 */
function useFloatingPanel(
  open: boolean,
  gap: number,
  minWidth: number,
  onClose: () => void,
  /** 打开时聚焦哪个元素；不传就聚焦面板内第一个可操作元素。 */
  initialFocus?: () => HTMLElement | null,
  layerId?: string,
): {
  readonly anchorRef: React.RefObject<HTMLElement | null>;
  readonly panelRef: React.Dispatch<React.SetStateAction<HTMLDivElement | null>>;
  readonly panelElement: HTMLDivElement | null;
  readonly placement: ReturnType<typeof placeFloatingLayer> | null;
  /** Esc / 选中菜单项后的关闭动作：关闭并把焦点还给触发器。 */
  readonly closeAndRestoreFocus: () => void;
} {
  const anchorRef = useRef<HTMLElement | null>(null);
  /*
   * 面板用 state 回调 ref 挂载：浮层是在 placement 算出来之后才渲染的，
   * 普通 ref 在 effect 首次执行时还是 null，ResizeObserver 挂不上，
   * 高度就永远量不到（拿上限当高度，浮层会整体上浮）。
   */
  const [panelRef, setPanelRef] = useState<HTMLDivElement | null>(null);
  const [placement, setPlacement] = useState<ReturnType<typeof placeFloatingLayer> | null>(null);
  const [measuredHeight, setMeasuredHeight] = useState<number | null>(null);
  /*
   * onClose 用 ref 兜住：调用方传的是内联箭头函数（每次渲染新引用），
   * 直接进依赖会让 focusout 监听随每次渲染重挂。按项目惯例在 effect 里同步。
   */
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const closeAndRestoreFocus = useCallback(() => {
    onCloseRef.current();
    anchorRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const anchorElement = anchorRef.current;
      if (!anchorElement) return;
      const next = placeFloatingLayer(anchorElement, {
        minWidth,
        gap,
        leftOffset: 0,
        preferAbove: true,
        measuredHeight,
        maxHeight: 520,
      });
      /*
       * 只在真的动了才 setState，避免跟随轮询在位置没变时反复重渲染。
       */
      setPlacement((current) =>
        current &&
        current.top === next.top &&
        current.left === next.left &&
        current.width === next.width &&
        current.maxHeight === next.maxHeight
          ? current
          : next,
      );
    };
    update();
    const observer = new ResizeObserver(() => {
      if (panelRef) setMeasuredHeight(panelRef.getBoundingClientRect().height);
      update();
    });
    if (panelRef) observer.observe(panelRef);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    /*
     * 浮层挂在 body 上，而触发器在编辑层里——编辑层被重新定位（节点移动、
     * 视口缩放、编辑层首次测量）时，触发器的屏幕坐标会变而浮层不会自己跟。
     * 这里在浮层打开期间低频比对触发器位置，变了就重贴一次。
     */
    let lastRect = "";
    const track = () => {
      const anchorElement = anchorRef.current;
      if (anchorElement) {
        const rect = anchorElement.getBoundingClientRect();
        const signature = `${Math.round(rect.x)}\u0002${Math.round(rect.y)}\u0002${Math.round(rect.width)}\u0002${Math.round(rect.height)}`;
        if (signature !== lastRect) {
          lastRect = signature;
          update();
        }
      }
    };
    const followTimer = window.setInterval(track, 120);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      window.clearInterval(followTimer);
    };
  }, [open, gap, minWidth, measuredHeight, panelRef]);

  /*
   * Esc 关闭并回焦：交给全应用唯一的仲裁器（`escapeArbiter`）。
   *
   * 之前这段自己挂在 document 的**捕获阶段**：抢在 React 冒泡处理之前把
   * Escape 吃掉，浮层里的下拉（`CanvasSelect`）想先关自己都来不及。
   *
   * 刻意**不**拦截 Tab：浮层是非模态的（菜单 / 参数面板），Tab 应当自然移出。
   * 若在卸载浮层前就拦掉 Tab，浏览器还没转移焦点就找不到落脚点，焦点会丢到
   * body（WCAG 2.4.3）。焦点真正离开浮层时由下面的 focusout 负责收起。
   */
  useEscapeHandler(
    {
      canHandle: () => open && (!layerId || !hasOpenChildLayer(layerId)),
      handle: () => closeAndRestoreFocus(),
    },
    open,
  );

  // 焦点完全离开浮层与触发器时收起（Tab 出去 / Shift+Tab 出去 / 点了别处）。
  useEffect(() => {
    if (!open) return;
    const panel = panelRef;
    if (!panel) return;
    const onFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget as Node | null;
      if (next && (panel.contains(next) || anchorRef.current?.contains(next))) return;
      if (layerId && (next ? isInsideFloatingLayerFamily(next, layerId) : hasOpenChildLayer(layerId))) return;
      onCloseRef.current();
    };
    panel.addEventListener("focusout", onFocusOut);
    return () => panel.removeEventListener("focusout", onFocusOut);
  }, [open, panelRef, layerId]);

  // 打开时把焦点移进浮层：键盘用户不需要 Tab 一路找过去。
  useEffect(() => {
    if (!open || !panelRef) return;
    const target =
      initialFocus?.() ??
      panelRef.querySelector<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
    // preventScroll：浮层挂在 body 上，聚焦时不要把画布带着滚。
    target?.focus({ preventScroll: true });
  }, [open, panelRef, initialFocus]);

  return {
    anchorRef,
    panelRef: setPanelRef,
    panelElement: panelRef,
    placement,
    closeAndRestoreFocus,
  };
}

function VideoClipReferenceButton({ node, disabled }: { readonly node: VideoClipNodeData; readonly disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [referenceError, setReferenceError] = useState<string | null>(null);
  const layerId = useId();
  const parentLayerId = useFloatingLayerParentId();
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  const { anchorRef, panelRef, panelElement, placement } = useFloatingPanel(open, 8, 260, () => setOpen(false), undefined, layerId);
  useLayoutEffect(() => {
    if (!open || !panelElement) return;
    registerFloatingLayer(layerId, parentLayerId, panelElement);
    return () => unregisterFloatingLayer(layerId);
  }, [open, panelElement, layerId, parentLayerId]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !anchorRef.current?.contains(event.target) && !isInsideFloatingLayerFamily(event.target, layerId)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [open, anchorRef, layerId]);
  // Keep the tools mounted while picking: closing the popover must not cancel canvas picking.
  return <>
    <button ref={anchorRef as React.RefObject<HTMLButtonElement | null>} type="button" className="canvas-gen-node__tool-chip" data-reference-panel-trigger aria-label="添加参考素材" aria-expanded={open} aria-haspopup="dialog" disabled={disabled} onClick={() => setOpen(value => !value)}><CanvasChromeIcon name="plus" size={12} /><span>参考</span></button>
    <FloatingPanel keepMounted open={open} panelRef={panelRef} placement={placement} className="video-clip-editor__reference-panel" role="dialog" ariaLabel="添加剪辑参考">
      <FloatingLayerParentContext.Provider value={layerId}>
        <CanvasReferenceTools node={node} active disabled={disabled} onError={setReferenceError} />
      </FloatingLayerParentContext.Provider>
    </FloatingPanel>
    {referenceError ? <ErrorAlert error={referenceError} variant="inline" hint="检查素材后重新添加；添加参考不会发起生成。" /> : null}
  </>;
}

/** 浮层外壳：portal 到 body，跟随触发器定位。 */
function FloatingPanel({
  open,
  panelRef,
  placement,
  className,
  role,
  ariaLabel,
  children,
  keepMounted = false,
}: {
  readonly open: boolean;
  readonly panelRef: React.Dispatch<React.SetStateAction<HTMLDivElement | null>>;
  readonly placement: ReturnType<typeof placeFloatingLayer> | null;
  readonly className: string;
  /** 浮层语义；参数面板是 dialog，模式菜单是 menu。 */
  readonly role?: "menu" | "dialog";
  readonly ariaLabel?: string;
  readonly children: ReactNode;
  readonly keepMounted?: boolean;
}) {
  if ((!open && !keepMounted) || !placement) return null;
  return createPortal(
    <div
      ref={panelRef}
      className={className}
      role={role}
      aria-label={ariaLabel}
      style={{
        display: open ? undefined : "none",
        position: "fixed",
        top: placement.top,
        left: placement.left,
        width: placement.width,
        maxHeight: placement.maxHeight,
        zIndex: "calc(var(--z-modal) + 20)",
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

/* ── 剪辑模式 ──────────────────────────────────────────────────────────── */

function VideoClipModeButton({
  modeKey,
  disabled,
  onModeChange,
}: {
  readonly modeKey: string;
  readonly disabled: boolean;
  readonly onModeChange: (modeKey: VideoClipModeKey) => void;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  const mode = videoClipMode(modeKey);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const activeIndex = Math.max(
    0,
    VIDEO_CLIP_ALL_MODES.findIndex((item) => item.modeKey === modeKey),
  );
  const initialFocus = useCallback(() => itemRefs.current[activeIndex] ?? null, [activeIndex]);
  const { anchorRef, panelRef, panelElement, placement, closeAndRestoreFocus } = useFloatingPanel(
    open,
    4,
    229.3,
    () => setOpen(false),
    // 菜单打开时聚焦**当前选中项**（ARIA 惯例），方向键再从它往下走。
    // 回调必须稳定：否则每次重渲染都会把焦点拉回选中项，方向键导航会「卡住」。
    initialFocus,
  );
  const ModeIcon = mode.icon;
  /*
   * 菜单键盘模式（ARIA APG menu button）：
   * 声明了 `role="menu"` 就必须实现方向键导航与 roving tabindex，
   * 否则读屏用户进入菜单后会被困在 Tab 序列里。
   */
  const focusItem = (index: number) => {
    const total = VIDEO_CLIP_ALL_MODES.length;
    const bounded = ((index % total) + total) % total;
    itemRefs.current[bounded]?.focus({ preventScroll: true });
  };
  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // 基准是**当前焦点项**而不是模式索引：焦点可能已经被方向键移动过。
    const focused = itemRefs.current.findIndex((item) => item === document.activeElement);
    const base = focused >= 0 ? focused : activeIndex;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusItem(base + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        focusItem(base - 1);
        break;
      case "Home":
        event.preventDefault();
        focusItem(0);
        break;
      case "End":
        event.preventDefault();
        focusItem(VIDEO_CLIP_ALL_MODES.length - 1);
        break;
      default:
        break;
    }
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (anchorRef.current?.contains(target)) return;
      if (panelElement?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open, anchorRef, panelElement]);

  return (
    <>
      <button
        ref={anchorRef as React.RefObject<HTMLButtonElement | null>}
        type="button"
        className="video-clip-editor__mode-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`剪辑模式：${mode.name}`}
        disabled={disabled}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((current) => !current);
        }}
      >
        <ModeIcon aria-hidden="true" width={14} height={14} strokeWidth={1.75} />
        <span className="video-clip-editor__mode-label">{mode.name}</span>
        <ChevronDown aria-hidden="true" width={12} height={12} strokeWidth={1.75} />
      </button>
      <FloatingPanel
        open={open}
        panelRef={panelRef}
        placement={placement}
        className="video-clip-editor__mode-menu"
        role="menu"
        ariaLabel="剪辑模式"
      >
        <div className="video-clip-editor__mode-list" onKeyDown={onMenuKeyDown}>
          {VIDEO_CLIP_ALL_MODES.map((item, index) => {
            const ItemIcon = item.icon;
            const active = item.modeKey === modeKey;
            return (
              <button
                key={item.modeKey}
                ref={(element) => {
                  itemRefs.current[index] = element;
                }}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                // roving tabindex：菜单整体只占一个 Tab 位，方向键在项间移动。
                tabIndex={active ? 0 : -1}
                className={`video-clip-editor__mode-item${active ? " is-active" : ""}`}
                title={item.description}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  closeAndRestoreFocus();
                  onModeChange(item.modeKey);
                }}
              >
                <ItemIcon aria-hidden="true" width={14} height={14} strokeWidth={1.75} />
                <span className="video-clip-editor__mode-name">{item.name}</span>
                {active ? (
                  <Check
                    aria-hidden="true"
                    width={14}
                    height={14}
                    strokeWidth={1.75}
                    className="video-clip-editor__mode-check"
                  />
                ) : null}
              </button>
            );
          })}
        </div>
      </FloatingPanel>
    </>
  );
}

/* ── 参数面板（比例 / 时长 / 清晰度）────────────────────────────────────── */

function VideoClipParamsButton({
  params,
  disabled,
  onParamsChange,
}: {
  readonly params: VideoClipParams;
  readonly disabled: boolean;
  readonly onParamsChange: (params: VideoClipParams) => void;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  const { anchorRef, panelRef, panelElement, placement } = useFloatingPanel(open, 0, 341.3, () =>
    setOpen(false),
  );
  const box = videoClipRatioBox(params.aspectRatio);
  const summary = videoClipParamsSummary(params);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (anchorRef.current?.contains(target)) return;
      if (panelElement?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open, anchorRef, panelElement]);

  return (
    <>
      <button
        ref={anchorRef as React.RefObject<HTMLButtonElement | null>}
        type="button"
        className="video-clip-editor__params-button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`剪辑参数：${summary}`}
        disabled={disabled}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((current) => !current);
        }}
      >
        <span className="video-clip-editor__params-left">
          <span className="video-clip-editor__ratio-icon">
            <span
              className="video-clip-editor__ratio-box"
              style={{ width: box.width, height: box.height }}
            />
          </span>
          <span className="video-clip-editor__params-label">{summary}</span>
        </span>
        <ChevronDown aria-hidden="true" width={14} height={14} strokeWidth={1.75} />
      </button>
      <FloatingPanel
        open={open}
        panelRef={panelRef}
        placement={placement}
        className="video-clip-editor__params-panel"
        role="dialog"
        ariaLabel="剪辑参数"
      >
        <div className="video-clip-editor__params-inner">
          <section className="video-clip-editor__params-section">
            <h4 className="video-clip-editor__params-title">比例</h4>
            <div className="video-clip-editor__ratio-grid">
              {VIDEO_CLIP_ASPECT_RATIOS.map((ratio) => {
                const box = videoClipRatioBox(ratio);
                const active = ratio === params.aspectRatio;
                return (
                  <button
                    key={ratio}
                    type="button"
                    className={`video-clip-editor__ratio${active ? " is-active" : ""}`}
                    aria-pressed={active}
                    onClick={() => onParamsChange({ ...params, aspectRatio: ratio })}
                  >
                    <span className="video-clip-editor__ratio-icon">
                      <span
                        className="video-clip-editor__ratio-box"
                        style={{ width: box.width, height: box.height }}
                      />
                    </span>
                    <span className="video-clip-editor__ratio-label">{ratio}</span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="video-clip-editor__params-section">
            <h4 className="video-clip-editor__params-title">时长</h4>
            <div className="video-clip-editor__duration-row">
              <input
                className="video-clip-editor__duration-slider"
                type="range"
                min={VIDEO_CLIP_DURATION_RANGE.min}
                max={VIDEO_CLIP_DURATION_RANGE.max}
                step={1}
                value={params.durationSeconds}
                aria-label="时长（秒）"
                onChange={(event) =>
                  onParamsChange({ ...params, durationSeconds: Number(event.target.value) })
                }
              />
              <span className="video-clip-editor__duration-number">
                <input
                  className="video-clip-editor__duration-input"
                  type="number"
                  min={VIDEO_CLIP_DURATION_RANGE.min}
                  max={VIDEO_CLIP_DURATION_RANGE.max}
                  value={params.durationSeconds}
                  aria-label="时长数值（秒）"
                  onChange={(event) =>
                    onParamsChange({
                      ...params,
                      // 时长是整数秒（Rust 侧 u32）：这里就取整，
                      // 避免画布里存下小数、界面上又显示成另一个数。
                      durationSeconds: Math.min(
                        VIDEO_CLIP_DURATION_RANGE.max,
                        Math.max(
                          VIDEO_CLIP_DURATION_RANGE.min,
                          Math.round(Number(event.target.value) || 0),
                        ),
                      ),
                    })
                  }
                />
                <span className="video-clip-editor__duration-unit">s</span>
              </span>
            </div>
          </section>

          <section className="video-clip-editor__params-section">
            <h4 className="video-clip-editor__params-title">清晰度</h4>
            <div className="video-clip-editor__resolution-grid">
              {VIDEO_CLIP_RESOLUTIONS.map((resolution) => {
                const active = resolution === params.resolution;
                return (
                  <button
                    key={resolution}
                    type="button"
                    className={`video-clip-editor__resolution${active ? " is-active" : ""}`}
                    aria-pressed={active}
                    onClick={() => onParamsChange({ ...params, resolution })}
                  >
                    {resolution}
                  </button>
                );
              })}
            </div>
          </section>
        </div>
      </FloatingPanel>
    </>
  );
}
