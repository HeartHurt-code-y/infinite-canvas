import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Icon } from "../../components/Icon";
import { toast } from "../../lib/toast";
import { CanvasChromeIcon } from "./CanvasChromeIcons";

type SettingsSection = "model" | "parameters";

/** 原站模型下拉浮层的实测宽度（365px）与浮层与触发器的缝隙（8px）。 */
const POPUP_WIDTH = 365;
const POPUP_GAP = 8;

/**
 * 生成节点底栏的设置控件。
 *
 * 结构对齐原站 liblib 画布（实测 2026-10-22，1707×898 / DPR 1.5）：
 *   模型按钮（图标 + 名称 + chevron）· 全能参考按钮 · 1px 分隔线 · 参数汇总按钮
 * 参数汇总按钮的文案就是原站的 `9:16 · 720p · 15s · 1个 ·` 那种汇总串。
 *
 * 「更多设置」不再是底栏上的第三个按钮（原站底栏没有这个按钮），而是收进
 * 参数浮层底部的「高级设置」折叠区——原站的高级设置也是这么放的：一根
 * hairline 上边框 + 12px 粗体标题，默认收起。
 *
 * 浮层贴到触发器上：面板底边贴触发器顶边上方 8px（与项目浮层锚定约定一致，
 * 也与原站模型下拉的实际落点一致）。浮层挂在**编辑层 DOM 内**而不是 body：
 * 编辑层自身是 `position: absolute` 的定位祖先，面板按相对坐标贴靠，画布
 * 平移缩放时不用重新测量；同时面板仍在编辑层的 DOM 语义之内。
 */
export function VideoNodeSettingsControls({
  kind = "video",
  modelLabel,
  parameterLabel,
  modeLabel,
  active,
  model,
  parameters,
  advanced,
}: {
  readonly kind?: "image" | "video";
  readonly modelLabel: string;
  readonly parameterLabel: string;
  readonly modeLabel: string;
  readonly active: boolean;
  readonly model: ReactNode;
  readonly parameters: ReactNode;
  readonly advanced: ReactNode;
}) {
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const modelTriggerRef = useRef<HTMLButtonElement | null>(null);
  const parameterTriggerRef = useRef<HTMLButtonElement | null>(null);
  const modelLayerRef = useRef<HTMLDivElement | null>(null);
  const parameterLayerRef = useRef<HTMLDivElement | null>(null);
  const [section, setSection] = useState<SettingsSection | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const labelPrefix = kind === "image" ? "图片" : "视频";

  // 浮层挂在编辑层本体上：它不在滚动容器里，因此不会被编辑层的 overflow 裁掉。
  useLayoutEffect(() => {
    const element = rootRef.current?.closest<HTMLElement>(".video-node-editor") ?? null;
    setHost(element);
  }, []);

  /** 把浮层贴到触发器上：底边 = 触发器顶边 − 8px，左边缘与触发器对齐。 */
  const place = useCallback(
    (layer: HTMLDivElement | null, trigger: HTMLButtonElement | null) => {
      const panel = host;
      if (!layer || !trigger || !panel) return;
      const triggerBox = trigger.getBoundingClientRect();
      const hostBox = panel.getBoundingClientRect();
      const stage = panel.closest<HTMLElement>(".canvas-viewport");
      const stageBox = stage?.getBoundingClientRect();
      // 窄视口里浮层不能超出画布视口（视口 overflow: hidden 会把超出部分裁掉）。
      const stageWidth = stageBox ? stageBox.width : Number.POSITIVE_INFINITY;
      const width = Math.min(
        Math.max(triggerBox.width, POPUP_WIDTH),
        Math.max(220, stageWidth - 16),
      );
      // 上方可用高度：浮层不能高到超出画布视口上沿。
      const room = stageBox ? triggerBox.top - stageBox.top : triggerBox.top;
      const minLeft = stageBox ? stageBox.left - hostBox.left + 8 : Number.NEGATIVE_INFINITY;
      const maxLeft = stageBox
        ? stageBox.right - hostBox.left - width - 8
        : Number.POSITIVE_INFINITY;
      const left = Math.min(Math.max(triggerBox.left - hostBox.left, minLeft), maxLeft);
      layer.style.left = `${left}px`;
      layer.style.bottom = `${hostBox.bottom - triggerBox.top + POPUP_GAP}px`;
      layer.style.width = `${width}px`;
      layer.style.maxHeight = `${Math.max(160, room)}px`;
    },
    [host],
  );

  useLayoutEffect(() => {
    if (!host || section == null) return;
    const layer = section === "model" ? modelLayerRef.current : parameterLayerRef.current;
    const trigger = section === "model" ? modelTriggerRef.current : parameterTriggerRef.current;
    const reposition = () => place(layer, trigger);
    reposition();
    const observer = new ResizeObserver(reposition);
    if (layer) observer.observe(layer);
    observer.observe(host);
    window.addEventListener("resize", reposition);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", reposition);
    };
  }, [host, section, place]);

  const close = useCallback((key: SettingsSection) => {
    setSection(null);
    const trigger = key === "model" ? modelTriggerRef.current : parameterTriggerRef.current;
    trigger?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (!active || section == null) return;
    const dismiss = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (rootRef.current?.contains(event.target)) return;
      const layer = section === "model" ? modelLayerRef.current : parameterLayerRef.current;
      if (layer?.contains(event.target)) return;
      // 画布节点里的下拉菜单挂在 body 上（portal），点菜单不等于点面板外部：
      // 否则 capture 阶段先关掉面板，菜单随面板卸载，用户根本点不中选项。
      if (event.target instanceof Element && event.target.closest(".canvas-select__menu") != null) {
        return;
      }
      setSection(null);
    };
    document.addEventListener("pointerdown", dismiss, true);
    return () => document.removeEventListener("pointerdown", dismiss, true);
  }, [active, section]);

  const panelFor = (key: SettingsSection) =>
    key === "model"
      ? { title: `${labelPrefix}模型与供应商`, content: model }
      : { title: `${labelPrefix}参数`, content: parameters };

  const openSection = (key: SettingsSection) => {
    setSection((current) => (current === key ? null : key));
  };

  const trigger = (
    key: SettingsSection,
    label: string,
    icon: ReactNode,
    triggerRef: React.RefObject<HTMLButtonElement | null>,
    layerRef: React.RefObject<HTMLDivElement | null>,
  ) => {
    const panel = panelFor(key);
    return (
      <div key={key} className={`video-settings-control video-settings-control--${key}`}>
        <button
          type="button"
          ref={triggerRef}
          className="video-settings-control__trigger"
          aria-label={key === "model" ? `选择${labelPrefix}模型` : `${labelPrefix}参数`}
          aria-describedby={`${id}-${key}-summary`}
          aria-haspopup="dialog"
          aria-expanded={active && section === key}
          aria-controls={`${id}-${key}`}
          data-video-settings-trigger={key}
          title={label}
          onClick={() => openSection(key)}
        >
          {icon}
          <span id={`${id}-${key}-summary`}>{label}</span>
          <Icon name="caret-down" size="xs" aria-hidden="true" />
        </button>
        {host == null
          ? null
          : createPortal(
              <div
                id={`${id}-${key}`}
                role="dialog"
                aria-label={panel.title}
                className="video-settings-panel"
                data-video-settings-panel={key}
                ref={layerRef}
                hidden={!active || section !== key}
                onKeyDown={(event) => {
                  if (
                    event.key !== "Escape" ||
                    event.defaultPrevented ||
                    event.nativeEvent.isComposing
                  )
                    return;
                  event.preventDefault();
                  event.stopPropagation();
                  close(key);
                }}
              >
                <div className="video-settings-panel__heading">
                  <strong>{panel.title}</strong>
                  <button
                    type="button"
                    aria-label={`收起${panel.title}`}
                    onClick={() => close(key)}
                  >
                    <Icon name="x" size="sm" aria-hidden="true" />
                  </button>
                </div>
                <div className="canvas-gen-node__settings">{panel.content}</div>
                {key === "parameters" ? (
                  <section className="video-settings-advanced">
                    <button
                      type="button"
                      className="video-settings-advanced__toggle"
                      aria-expanded={advancedOpen}
                      title={`${modeLabel} · 更多${labelPrefix}设置`}
                      onClick={() => setAdvancedOpen((open) => !open)}
                    >
                      高级设置
                    </button>
                    <div className="video-settings-advanced__body" hidden={!advancedOpen}>
                      {advanced}
                    </div>
                  </section>
                ) : null}
              </div>,
              host,
            )}
      </div>
    );
  };

  return (
    <div ref={rootRef} className="video-settings-controls">
      {trigger(
        "model",
        modelLabel,
        <CanvasChromeIcon name={kind === "image" ? "image" : "video"} size={14} />,
        modelTriggerRef,
        modelLayerRef,
      )}
      {/*
        全能参考：原站底栏的第二项（本项目后端没有这个能力，按项目约定
        结构定死、交互做全、点击给出明确说明）。
      */}
      <button
        type="button"
        className="video-settings-control__trigger video-settings-control__trigger--universal"
        aria-label="全能参考"
        title="全能参考（后端暂未接入）"
        onClick={() => toast.error("全能参考后端暂未接入")}
      >
        <CanvasChromeIcon name="universal" size={14} />
        <span>全能参考</span>
        <Icon name="caret-down" size="xs" aria-hidden="true" />
      </button>
      <span className="video-settings-controls__divider" aria-hidden="true" />
      {trigger(
        "parameters",
        parameterLabel,
        <Icon name="bounding-box" size="sm" aria-hidden="true" />,
        parameterTriggerRef,
        parameterLayerRef,
      )}
    </div>
  );
}
