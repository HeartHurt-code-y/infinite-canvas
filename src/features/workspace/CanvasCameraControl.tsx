import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ErrorAlert } from "../../components/ErrorAlert";
import { isInsideOpenPopup, useEscapeHandler } from "../../components/escapeArbiter";
import { useFloatingLayerAnchor } from "../create/useFloatingLayerAnchor";
import {
  CAMERA_CONTROL_CATEGORIES, CAMERA_CONTROL_PANEL_WIDTH, cameraControlImageUrl,
  cameraControlIssue, cameraControlItems, cameraControlLocked, canvasCameraSummary,
  editableCanvasCameraControl, readCanvasCameraPreferences, saveCanvasCameraPreferences,
  type CanvasCameraCategory, type CanvasCameraControl as CameraSettings,
} from "../../lib/canvasCameraControl";
import { LibTVMediaIcon } from "./LibTVMediaIcon";
import type { ImageNodeConfig } from "./workspaceModel";
import "./CanvasCameraControl.css";

function settingsForNode(value: CameraSettings | undefined): CameraSettings {
  return value ? editableCanvasCameraControl(value)
    : { ...readCanvasCameraPreferences(), enabled: false };
}

function sameSettings(a: CameraSettings, b: CameraSettings): boolean {
  return a.version === b.version && a.enabled === b.enabled && CAMERA_CONTROL_CATEGORIES.every(category => a[category.key] === b[category.key]);
}

/** 四列滚轮，与原站一致：不循环、15px 门槛、350ms 节流；键盘独立可达。 */
function CameraColumn({ category, selectedKey, onChange }: {
  readonly category: (typeof CAMERA_CONTROL_CATEGORIES)[number];
  readonly selectedKey: string;
  readonly onChange: (key: string) => void;
}) {
  const items = cameraControlItems(category.key);
  const index = Math.max(0, items.findIndex(item => item.key === selectedKey));
  const selected = items[index];
  const windowRef = useRef<HTMLDivElement>(null);
  const cooldown = useRef<number | null>(null);
  const latest = useRef({ index, onChange });
  useLayoutEffect(() => { latest.current = { index, onChange }; }, [index, onChange]);
  useEffect(() => {
    const element = windowRef.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault(); event.stopPropagation();
      if (cooldown.current !== null || Math.abs(event.deltaY) < 15) return;
      const current = latest.current;
      const nextIndex = Math.max(0, Math.min(items.length - 1, current.index + (event.deltaY > 0 ? 1 : -1)));
      const next = items[nextIndex];
      if (next && nextIndex !== current.index) current.onChange(next.key);
      cooldown.current = window.setTimeout(() => { cooldown.current = null; }, 350);
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => {
      element.removeEventListener("wheel", wheel);
      if (cooldown.current !== null) window.clearTimeout(cooldown.current);
      cooldown.current = null;
    };
  }, [items]);

  const select = (nextIndex: number) => {
    const next = items[Math.max(0, Math.min(items.length - 1, nextIndex))];
    if (next) onChange(next.key);
  };
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault(); event.stopPropagation(); return;
    }
    const next = event.key === "ArrowUp" ? index - 1 : event.key === "ArrowDown" ? index + 1
      : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
        : event.key === "PageUp" ? index - 3 : event.key === "PageDown" ? index + 3 : null;
    if (next === null) return;
    event.preventDefault(); event.stopPropagation(); select(next);
  };
  if (!selected) return null;
  return <div className="canvas-camera-column">
    <button type="button" className="canvas-camera-column__step is-up" tabIndex={-1} aria-label={`上一项${category.label}`} aria-disabled={index === 0}
      onPointerDown={event => { event.preventDefault(); event.stopPropagation(); }} onClick={event => { event.preventDefault(); event.stopPropagation(); if (index > 0) select(index - 1); }}>
      <LibTVMediaIcon name="icon-chevron-down-small" size={14} />
    </button>
    <div ref={windowRef} className="canvas-camera-column__window" role="spinbutton" tabIndex={0}
      aria-label={category.label} aria-valuemin={0} aria-valuemax={items.length - 1} aria-valuenow={index}
      aria-valuetext={`${selected.name}${category.unit ? ` ${category.unit}` : ""}`} onKeyDown={keys}>
      <div className="canvas-camera-column__selection" aria-hidden="true"><span>{category.label}</span></div>
      <div className="canvas-camera-column__clip" aria-hidden="true"><div className="canvas-camera-column__track" style={{ transform: `translateY(${30 - index * 96}px)` }}>
        {items.map((item, itemIndex) => <button key={item.key} type="button" tabIndex={-1} className={`canvas-camera-column__item${itemIndex === index ? " is-selected" : ""}${item.image ? " has-image" : ""}`}
          onPointerDown={event => { event.preventDefault(); event.stopPropagation(); }} onClick={event => { event.preventDefault(); event.stopPropagation(); select(itemIndex); }}>
          {item.image ? <img src={cameraControlImageUrl(item)} alt="" draggable={false} loading="lazy" /> : <span>{item.name}</span>}
        </button>)}
      </div></div>
    </div>
    <button type="button" className="canvas-camera-column__step" tabIndex={-1} aria-label={`下一项${category.label}`} aria-disabled={index === items.length - 1}
      onPointerDown={event => { event.preventDefault(); event.stopPropagation(); }} onClick={event => { event.preventDefault(); event.stopPropagation(); if (index < items.length - 1) select(index + 1); }}>
      <LibTVMediaIcon name="icon-chevron-down-small" size={14} />
    </button>
    <span className="canvas-camera-column__caption">{category.unit || selected.name}</span>
  </div>;
}

/** 非模态面板：关闭面板不等于关闭摄影参数；关闭开关才停止向新任务编译。 */
export function CanvasCameraControl({ config, active, triggerRef, openRequestId, onChange }: {
  readonly config: ImageNodeConfig;
  readonly active: boolean;
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  readonly openRequestId: number;
  readonly onChange: (config: ImageNodeConfig) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => settingsForNode(config.cameraControl));
  const lastOpenRequest = useRef(0);
  const latest = useRef({ config, onChange });
  useLayoutEffect(() => { latest.current = { config, onChange }; }, [config, onChange]);
  const locked = cameraControlLocked(config);
  const visible = open && active && !locked;
  const enabled = config.cameraControl?.enabled === true;
  const issue = enabled ? cameraControlIssue(config.cameraControl) : null;
  const layer = useFloatingLayerAnchor<HTMLDivElement>({ open: visible, anchorRef: triggerRef, minWidth: CAMERA_CONTROL_PANEL_WIDTH, maxHeight: 580, preferAbove: true, gap: 0, align: "center", followAnchor: true });
  const close = useCallback((restoreFocus = true) => {
    setOpen(false);
    const trigger = triggerRef.current;
    if (restoreFocus && trigger?.isConnected && trigger.getBoundingClientRect().width > 0) trigger.focus({ preventScroll: true });
  }, [triggerRef]);
  useEffect(() => { if (!active || locked) setOpen(false); }, [active, locked]);
  useEffect(() => {
    if (!openRequestId || lastOpenRequest.current === openRequestId) return;
    lastOpenRequest.current = openRequestId;
    if (!active || locked) return;
    setDraft(settingsForNode(config.cameraControl));
    setOpen(true);
  }, [openRequestId, active, locked, config.cameraControl]);
  useLayoutEffect(() => {
    if (!open) return;
    const value = settingsForNode(config.cameraControl);
    setDraft(previous => sameSettings(previous, value) ? previous : value);
  }, [open, config.cameraControl]);
  useLayoutEffect(() => {
    if (visible) layer.ref.current?.querySelector<HTMLElement>('[role="spinbutton"]')?.focus({ preventScroll: true });
  }, [visible, layer.ref]);
  useEffect(() => {
    if (!visible) return;
    const otherPopup = (event: FocusEvent) => {
      if (!(event.target instanceof Element) || layer.ref.current?.contains(event.target) || triggerRef.current?.contains(event.target)) return;
      const popup = event.target.closest('[role="dialog"], [role="listbox"], [role="menu"]');
      const hostDialog = triggerRef.current?.closest('[role="dialog"]');
      if (popup && popup !== hostDialog) close(false);
    };
    document.addEventListener("focusin", otherPopup);
    return () => { document.removeEventListener("focusin", otherPopup); };
  }, [visible, close, layer.ref, triggerRef]);

  /*
   * Esc 关闭摄像机面板：交给全应用唯一的仲裁器（`escapeArbiter`）。
   *
   * 之前这段自己挂在 document 的**捕获阶段**：抢在 React 冒泡处理之前，
   * 面板里的下拉（`CanvasSelect`）想先关自己都来不及——用户在下拉里按 Esc，
   * 关掉的是整个摄像机面板。仲裁器在冒泡阶段，内层浮层先认领。
   */
  useEscapeHandler(
    {
      canHandle: (event) => visible && !isInsideOpenPopup(event.target),
      handle: () => close(),
    },
    visible,
  );

  const commit = useCallback((value: CameraSettings) => {
    latest.current.onChange({ ...latest.current.config, cameraControl: value });
    saveCanvasCameraPreferences(value);
  }, []);
  const select = (category: CanvasCameraCategory, key: string) => {
    const value = { ...draft, [category]: key };
    setDraft(value);
    if (enabled) commit({ ...value, enabled: true });
  };
  const tooltip = locked ? "全景模式下无法使用摄像机" : issue ?? (enabled ? `摄像机已开启：${canvasCameraSummary(config.cameraControl)}` : "摄像机");
  return <>
    <button ref={triggerRef} type="button" className="canvas-camera-trigger" aria-label="摄像机" aria-haspopup="dialog" aria-expanded={visible} aria-controls={visible ? id : undefined}
      disabled={locked} data-selected={enabled && !locked || undefined} data-tooltip={tooltip} onClick={() => {
        if (!open) setDraft(settingsForNode(config.cameraControl));
        setOpen(value => !value);
      }}><LibTVMediaIcon name="lens-aperture" size={16} /></button>
    {visible ? createPortal(<div ref={layer.ref} id={id} className="canvas-camera-panel nodrag nopan" role="dialog" aria-labelledby={`${id}-title`}
      onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
      onKeyDown={event => event.stopPropagation()}
      onDoubleClickCapture={event => { event.preventDefault(); event.stopPropagation(); }}>
      <header><span id={`${id}-title`}>摄像机</span><button type="button" aria-label="关闭摄像机面板" data-tooltip="关闭摄像机面板" onClick={() => close()}><LibTVMediaIcon name="close" size={18} /></button></header>
      {issue ? <div className="canvas-camera-panel__error"><ErrorAlert error={issue} tone="warning" hint="重新选择任一摄影参数以确认设置，或关闭摄像机开关。" /></div> : null}
      <div className="canvas-camera-panel__columns"><div className="canvas-camera-panel__separator" />
        {CAMERA_CONTROL_CATEGORIES.map(category => <Fragment key={category.key}>
          <CameraColumn category={category} selectedKey={draft[category.key]} onChange={key => select(category.key, key)} />
          <div className="canvas-camera-panel__separator" />
        </Fragment>)}
      </div>
      <footer><span>{enabled ? "开启" : "关闭"}</span><label className="canvas-video-switch canvas-camera-panel__switch">
        <input type="checkbox" role="switch" aria-label="启用摄像机控制" checked={enabled} onChange={event => {
          const value = { ...draft, enabled: event.target.checked }; setDraft(value); commit(value);
        }} /><i aria-hidden="true" />
      </label></footer>
    </div>, document.body) : null}
  </>;
}

export function CanvasCameraControlBadge({ config, onOpen, onDisable }: {
  readonly config: ImageNodeConfig;
  readonly onOpen: () => void;
  readonly onDisable: () => void;
}) {
  if (!config.cameraControl?.enabled || config.imagePreset || cameraControlLocked(config)) return null;
  return <div className="canvas-camera-badge">
    <button type="button" aria-label="打开摄像机控制" data-tooltip={canvasCameraSummary(config.cameraControl)} onClick={onOpen}><LibTVMediaIcon name="lens-aperture" size={14} /><span>摄像机</span></button>
    <button type="button" aria-label="关闭摄像机控制" data-tooltip="关闭摄像机控制" onClick={onDisable}><LibTVMediaIcon name="close" size={12} /></button>
  </div>;
}
