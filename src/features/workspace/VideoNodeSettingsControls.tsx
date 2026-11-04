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
import { LibTVMediaIcon, mediaAspectRatioIcon } from "./LibTVMediaIcon";

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
 * 视频高级设置由 CanvasVideoSettings 在编辑区底部展开；这里仅保留模型、模式和参数。
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
  parameterAccessory,
  active,
  model,
  parameters,
  modeControl,
}: {
  readonly kind?: "image" | "video";
  readonly modelLabel: string;
  readonly parameterLabel: string;
  readonly parameterAccessory?: ReactNode;
  readonly active: boolean;
  readonly model: ReactNode;
  readonly parameters: ReactNode;
  readonly modeControl?: ReactNode;
}) {
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const modelTriggerRef = useRef<HTMLButtonElement | null>(null);
  const parameterTriggerRef = useRef<HTMLButtonElement | null>(null);
  const modelLayerRef = useRef<HTMLDivElement | null>(null);
  const parameterLayerRef = useRef<HTMLDivElement | null>(null);
  const [section, setSection] = useState<SettingsSection | null>(null);
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
        Math.max(triggerBox.width, kind === "video" && layer.dataset["videoSettingsPanel"] === "parameters" ? 340 : POPUP_WIDTH),
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
      layer.style.maxHeight = `${Math.max(80, room - POPUP_GAP - 8)}px`;
    },
    [host, kind],
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
    const dismiss = (event: PointerEvent | FocusEvent) => {
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
    // 图片预设同样挂在 body；键盘把焦点移到另一块浮层时也应收起本面板。
    document.addEventListener("focusin", dismiss);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("focusin", dismiss);
    };
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
          aria-describedby={`${id}-${key}-summary${key === "parameters" && parameterAccessory ? " " + id + "-parameter-accessory" : ""}`}
          aria-haspopup="dialog"
          aria-expanded={active && section === key}
          aria-controls={`${id}-${key}`}
          data-video-settings-trigger={key}
          data-tooltip={label}
          onClick={() => openSection(key)}
        >
          {icon}
          <span id={`${id}-${key}-summary`}>{label}</span>
          {key === "parameters" && parameterAccessory ? <span id={id + "-parameter-accessory"}>{parameterAccessory}</span> : null}
          <LibTVMediaIcon name="icon-chevron-down-small" size={12} />
        </button>
        {host == null
          ? null
          : createPortal(
              <div
                id={`${id}-${key}`}
                role="dialog"
                /* 标签和留白点击先聚焦弹层，避免焦点落到画布后把弹层提前收掉。 */
                tabIndex={-1}
                aria-label={panel.title}
                className="video-settings-panel"
                data-video-settings-panel={key}
                data-media-kind={kind}
                ref={layerRef}
                hidden={!active || section !== key}
                onClick={(event) => {
                  if (key === "model" && event.target instanceof Element && event.target.closest("[data-video-model-option]")) close(key);
                }}
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
                {kind !== "video" ? <div className="video-settings-panel__heading">
                  <strong>{panel.title}</strong>
                  <button
                    type="button"
                    aria-label={`收起${panel.title}`}
                    onClick={() => close(key)}
                  >
                    <LibTVMediaIcon name="close" size={16} />
                  </button>
                </div> : null}
                <div className="canvas-gen-node__settings">{panel.content}</div>
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
        <LibTVMediaIcon name={kind === "video" ? "video-gen" : "image"} size={14} />,
        modelTriggerRef,
        modelLayerRef,
      )}
      {modeControl}
      <span className="video-settings-controls__divider" aria-hidden="true" />
      {trigger(
        "parameters",
        parameterLabel,
        <LibTVMediaIcon name={mediaAspectRatioIcon(parameterLabel, kind === "image" ? "generation-setting-ratio-1-1" : "generation-setting-ratio-16-9")} size={16} />,
        parameterTriggerRef,
        parameterLayerRef,
      )}
    </div>
  );
}
