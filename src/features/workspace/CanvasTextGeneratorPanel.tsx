import { memo, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { CanvasSelect } from "../../components/CanvasSelect";
import { LibTVMediaIcon } from "./LibTVMediaIcon";
import "./CanvasTextGenerator.css";

/**
 * 文本节点下方的**悬浮生成器面板**。
 *
 * 逆向规格见 `docs/integrations/liblib-text-node-re.md` 第 4 节（2026-10-27 登录态实测）：
 * - 面板锚在节点**下沿外扩 16px**、水平居中、固定宽 660px；
 * - 面板本体底色 `#262626`、圆角 16px、0.5px `#363636` 描边、投影 `0 4px 10px rgba(0,0,0,.12)`；
 * - 结构：提示词区（占位文案 + 可编辑正文）+ 底栏（模型选择 / 翻译 / 消耗位 / 提交）；
 * - 右上角一枚 28×28 的展开键。
 *
 * 模型来自本项目的供应商目录；消耗位显示 `—`，因为项目没有原站的积分计价。
 * 展开键采用本项目的长文本编辑行为，原站的对应行为尚未确认。
 */
export interface CanvasTextGeneratorModelOption {
  /** `providerId::modelDefinitionId`，与本项目模型绑定的作用域格式一致。 */
  readonly value: string;
  readonly label: string;
}

/**
 * 面板提示词区的占位文案。
 *
 * 逆向来源：原站 i18n `common:promptPlaceholderText`（见
 * `docs/integrations/liblib-text-node-re.md` 第 4.5 节）。
 */
export const CANVAS_TEXT_GENERATOR_PLACEHOLDER =
  "写下你想讲的故事、场景或角色设定。例如：一个来自未来的机器人，在城市屋顶看星星。";

export interface CanvasTextGeneratorPanelProps {
  readonly className?: string | undefined;
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly modelOptions: readonly CanvasTextGeneratorModelOption[];
  readonly canChooseModel: boolean;
  readonly modelReady?: boolean;
  readonly modelValue: string;
  readonly onModelChange: (value: string) => void;
  readonly onTranslate: () => void;
  readonly translating: boolean;
  readonly onSubmit: () => void;
  readonly submitting: boolean;
  /**
   * 展开键的通知回调。
   *
   * 展开态本身由面板内部持有（提示词区拉高到可写长稿）；
   * 原站这一键的具体行为没有逆向出来，这里只保证「点得动、有反馈」。
   */
  readonly onExpand?: (() => void) | undefined;
  readonly placeholder: string;
  /** 提示词为空时的提醒文案（对应原站 `promptEmptyForTranslate`）。 */
  readonly emptyHint?: string;
  readonly disabled?: boolean;
  /** 脚本节点可仅依靠已连接的正文或参考素材生成。 */
  readonly allowEmpty?: boolean;
  readonly submitLabel?: string;
  readonly modelLabel?: string;
  readonly toolbar?: ReactNode;
}

export const CanvasTextGeneratorPanel = memo(function CanvasTextGeneratorPanel({
  className,
  value,
  onValueChange,
  modelOptions,
  canChooseModel,
  modelReady = canChooseModel,
  modelValue,
  onModelChange,
  onTranslate,
  translating,
  onSubmit,
  submitting,
  onExpand,
  placeholder,
  emptyHint = "提示词为空，请输入内容后点击",
  disabled = false,
  allowEmpty = false,
  submitLabel = "生成这段正文",
  modelLabel = "文本节点生成模型",
  toolbar,
}: CanvasTextGeneratorPanelProps) {
  const promptId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const trimmed = value.trim();
  const canSubmit = (trimmed.length > 0 || allowEmpty) && !submitting && !disabled && modelReady;
  const canTranslate = trimmed.length > 0 && !translating && !disabled;

  // 跟随画布缩放，同时把面板约束在画布可见范围；靠边时允许翻到节点上方。
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const surface = panel?.parentElement;
    const viewport = panel?.closest<HTMLElement>(".canvas-viewport");
    const flowViewport = panel?.closest<HTMLElement>(".react-flow__viewport");
    const flowNode = panel?.closest<HTMLElement>(".react-flow__node");
    if (!panel || !surface || !viewport) return;
    const scriptPanel = panel.classList.contains("canvas-text-generator--script");
    const dock = scriptPanel
      ? viewport.closest(".canvas-stage")?.querySelector(".canvas-bottom-dock-row") : null;
    const header = scriptPanel ? surface.querySelector(".canvas-gen-node__header") : null;
    let frame = 0;
    const place = () => {
      frame = 0;
      const bounds = viewport.getBoundingClientRect();
      const anchor = surface.getBoundingClientRect();
      const scale = surface.offsetWidth > 0 ? anchor.width / surface.offsetWidth : 0;
      if (!scale || bounds.width <= 0 || bounds.height <= 0) return;
      const margin = 8;
      const dockRect = dock?.getBoundingClientRect();
      const bottom = dockRect && dockRect.height > 0 && dockRect.top > bounds.top
        ? Math.min(bounds.bottom, dockRect.top) : bounds.bottom;
      const width = `${Math.min(660, Math.max(0, bounds.width - margin * 2) / scale)}px`;
      if (panel.style.width !== width) panel.style.width = width;
      const gap = 16 * scale;
      const topAnchor = header ? Math.min(anchor.top, header.getBoundingClientRect().top) : anchor.top;
      const spaceBelow = bottom - margin - anchor.bottom;
      const spaceAbove = topAnchor - bounds.top - margin;
      const naturalHeight = (panel.scrollHeight + panel.offsetHeight - panel.clientHeight) * scale;
      const above = spaceBelow < naturalHeight + gap && spaceAbove > spaceBelow;
      const viewportHeight = Math.max(0, bottom - bounds.top - margin * 2);
      const available = Math.min(viewportHeight, Math.max(112 * scale, (above ? spaceAbove : spaceBelow) - gap));
      const maxHeight = `${(scriptPanel ? available : viewportHeight) / scale}px`;
      if (panel.style.maxHeight !== maxHeight) panel.style.maxHeight = maxHeight;
      panel.style.transform = "translateX(-50%)";
      const box = panel.getBoundingClientRect();
      const maxLeft = Math.max(bounds.left + margin, bounds.right - margin - box.width);
      const left = Math.min(Math.max(bounds.left + margin, box.left), maxLeft);
      const desiredTop = above ? topAnchor - gap - box.height : anchor.bottom + gap;
      const top = Math.min(
        Math.max(bounds.top + margin, desiredTop),
        Math.max(bounds.top + margin, bottom - margin - box.height),
      );
      panel.style.transform = `translate(calc(-50% + ${(left - box.left) / scale}px), ${(top - box.top) / scale}px)`;
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(place);
    };
    place();
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    resize?.observe(panel);
    resize?.observe(viewport);
    if (dock) resize?.observe(dock);
    const movement = typeof MutationObserver === "undefined" ? null : new MutationObserver(schedule);
    if (flowViewport) movement?.observe(flowViewport, { attributes: true, attributeFilter: ["style"] });
    if (flowNode) movement?.observe(flowNode, { attributes: true, attributeFilter: ["style"] });
    window.addEventListener("resize", schedule);
    return () => {
      resize?.disconnect();
      movement?.disconnect();
      window.removeEventListener("resize", schedule);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div ref={panelRef} className={`canvas-text-generator${expanded ? " is-expanded" : ""}${className ? ` ${className}` : ""}`}>
      <div className="canvas-text-generator__body">
        {toolbar ? <div className="canvas-text-generator__toolbar">{toolbar}</div> : null}
        <div className="canvas-text-generator__prompt">
          <label className="sr-only" htmlFor={promptId}>
            生成提示词
          </label>
          <textarea
            id={promptId}
            className="canvas-text-generator__input"
            value={value}
            rows={3}
            placeholder={placeholder}
            disabled={disabled}
            onChange={(event) => onValueChange(event.target.value)}
            onMouseDown={(event) => event.stopPropagation()}
          />
        </div>
        <div className="canvas-text-generator__bar">
          <CanvasSelect
            ariaLabel={modelLabel}
            className="canvas-text-generator__model"
            value={modelValue}
            options={modelOptions}
              triggerValue={className?.includes("canvas-text-generator--text") ? {
                label: modelOptions.find(option => option.value === modelValue)?.label ?? "选择文本模型",
                icon: <LibTVMediaIcon name="text-file" size={16} />,
              } : undefined}
            onChange={onModelChange}
            disabled={disabled || !canChooseModel}
            chevronIcon={<LibTVMediaIcon name="icon-chevron-down-small" size={12} />}
            selectedIcon={<LibTVMediaIcon name="check" size={12} />}
            title="选择用于生成这段正文的文本模型"
          />
          <div className="canvas-text-generator__spacer" />
          <div className="canvas-text-generator__actions">
            <button
              type="button"
              className="canvas-text-generator__icon-button"
              data-tooltip="翻译提示词"
              aria-label="翻译提示词"
              disabled={!canTranslate}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onTranslate();
              }}
            >
              <LibTVMediaIcon name="translate" size={16} />
            </button>
            <span
              className="canvas-text-generator__cost"
              data-tooltip="按当前供应商的实际用量计费"
            >
              <LibTVMediaIcon name="icon-lightning-filled" size={14} className="canvas-text-generator__cost-icon" />
              <span className="canvas-text-generator__cost-value">—</span>
            </span>
            <button
              type="button"
              className="canvas-text-generator__submit"
              data-canvas-generate=""
              data-tooltip={trimmed.length === 0 && !allowEmpty ? emptyHint : submitLabel}
              aria-label={submitLabel}
              disabled={!canSubmit}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onSubmit();
              }}
            >
              <LibTVMediaIcon name="up-arrow" size={12} />
            </button>
          </div>
        </div>
      </div>
      <button
        type="button"
        className="canvas-text-generator__expand"
        aria-label={expanded ? "收起编辑提示词" : "展开编辑提示词"}
        aria-pressed={expanded}
        data-tooltip={expanded ? "收起编辑提示词" : "展开编辑提示词"}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          setExpanded((current) => !current);
          onExpand?.();
        }}
      >
        <LibTVMediaIcon name="icon-arrow-expand" size={14} />
      </button>
    </div>
  );
});
