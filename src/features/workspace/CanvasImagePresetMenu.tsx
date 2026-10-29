import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { CanvasSelect } from "../../components/CanvasSelect";
import { useFloatingLayerAnchor } from "../create/useFloatingLayerAnchor";
import {
  CANVAS_IMAGE_PRESET_GROUPS,
  canvasImagePreset,
  imagePresetOptionValues,
  selectCanvasImagePreset,
} from "../../lib/canvasImagePresets";
import type { ModelParameterCapability } from "../../lib/modelCapabilities";
import { CanvasChromeIcon } from "./CanvasChromeIcons";
import type { ImageNodeConfig } from "./workspaceModel";

/** 让 body portal 与编辑层各自的关闭手势互不抢占。 */
function usePresetDismiss(open: boolean, anchor: RefObject<HTMLElement | null>, layer: RefObject<HTMLElement | null>, close: () => void, allowSelect = false) {
  useEffect(() => {
    if (!open) return;
    const outside = (target: EventTarget | null) => target instanceof Node
      && !anchor.current?.contains(target) && !layer.current?.contains(target)
      && !(allowSelect && target instanceof Element && target.closest(".canvas-select__menu"));
    const pointer = (event: PointerEvent) => { if (outside(event.target)) close(); };
    const focus = (event: FocusEvent) => { if (outside(event.target)) close(); };
    document.addEventListener("pointerdown", pointer, true);
    document.addEventListener("focusin", focus);
    return () => {
      document.removeEventListener("pointerdown", pointer, true);
      document.removeEventListener("focusin", focus);
    };
  }, [open, anchor, layer, close, allowSelect]);
}

export function CanvasImagePresetMenu({ config, active, getCapabilities, triggerRef, onChange }: {
  readonly config: ImageNodeConfig;
  readonly active: boolean;
  readonly getCapabilities: () => readonly ModelParameterCapability[];
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  readonly onChange: (config: ImageNodeConfig) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const visible = open && active;
  const close = useCallback(() => setOpen(false), []);
  const layer = useFloatingLayerAnchor<HTMLDivElement>({ open: visible, anchorRef: triggerRef, minWidth: 524, maxHeight: 600, preferAbove: true, gap: 8 });
  const current = canvasImagePreset(config.imagePreset?.scene);
  usePresetDismiss(visible, triggerRef, layer.ref, close);
  useEffect(() => { if (!active) setOpen(false); }, [active]);
  useLayoutEffect(() => {
    if (!visible) return;
    const selected = layer.ref.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"]');
    (selected ?? layer.ref.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"]'))?.focus({ preventScroll: true });
  }, [visible, layer.ref]);

  const keydown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation(); close(); triggerRef.current?.focus({ preventScroll: true }); return;
    }
    if (event.key === "Tab") {
      close(); triggerRef.current?.focus({ preventScroll: true }); event.stopPropagation(); return;
    }
    const buttons = [...(layer.ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])];
    const index = buttons.findIndex(button => button === document.activeElement);
    let next: HTMLButtonElement | undefined;
    if (event.key === "ArrowDown") next = buttons[(index + 1) % buttons.length];
    if (event.key === "ArrowUp") next = buttons[(index - 1 + buttons.length) % buttons.length];
    if (event.key === "Home") next = buttons[0];
    if (event.key === "End") next = buttons.at(-1);
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const currentButton = buttons[index];
      if (currentButton) {
        const box = currentButton.getBoundingClientRect();
        const direction = event.key === "ArrowRight" ? 1 : -1;
        next = buttons.filter(button => (button.getBoundingClientRect().left - box.left) * direction > box.width / 2)
          .sort((a, b) => Math.abs(a.getBoundingClientRect().top - box.top) - Math.abs(b.getBoundingClientRect().top - box.top))[0];
      }
    }
    if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      next?.focus({ preventScroll: true }); next?.scrollIntoView({ block: "nearest" });
    }
    // Enter / Space 的 click 由按钮原生触发，阻止节点包装层将它解释为「选中」。
    if (event.key === "Enter" || event.key === " ") event.stopPropagation();
  };

  return <>
    <button ref={triggerRef} type="button" aria-label="图片预设" aria-haspopup="menu" aria-expanded={visible} aria-controls={visible ? id : undefined}
      data-tooltip={current ? `图片预设：${current.label}` : "图片预设"} data-selected={Boolean(config.imagePreset) || undefined}
      onClick={() => setOpen(value => !value)}>
      <CanvasChromeIcon name="grid2plus" size={16} /><i className="canvas-image-preset-new-dot" aria-hidden="true" />
    </button>
    {visible ? createPortal(<div ref={layer.ref} id={id} className="canvas-image-preset-menu nodrag nopan" role="menu" aria-label="图片预设"
      onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onKeyDown={keydown}>
      {([0, 1] as const).map(column => <div className="canvas-image-preset-menu__column" key={column}>
        {CANVAS_IMAGE_PRESET_GROUPS.filter(group => group.column === column).map(group => <section key={group.id} role="group" aria-labelledby={`${id}-${group.id}`}>
          <h3 id={`${id}-${group.id}`}>{group.label}</h3>
          {group.presets.map(preset => <button type="button" key={preset.scene} role="menuitemradio" aria-checked={config.imagePreset?.scene === preset.scene}
            data-tooltip={preset.description} onClick={() => {
              const selected = selectCanvasImagePreset(preset, getCapabilities(), config.parameterValues,
                `${config.modelSelection.providerId}:${config.modelSelection.modelDefinitionId}`, config.imagePreset);
              onChange({ ...config, imagePreset: selected.selection, parameterValues: selected.parameterValues, imageMode: "auto", panoramaEnabled: false });
              close(); triggerRef.current?.focus({ preventScroll: true });
            }}>
            <span className="canvas-image-preset-menu__icon"><CanvasChromeIcon name={preset.icon} size={20} />{preset.newFeature ? <i className="canvas-image-preset-new-dot" aria-hidden="true" /> : null}</span>
            <span>{preset.label}</span>
            {preset.newFeature ? <span className="sr-only">新功能</span> : null}
          </button>)}
        </section>)}
      </div>)}
    </div>, document.body) : null}
  </>;
}

/** 预设状态独立于 canonical 提示词；切换或清除不会改写文字、附件、@ 引用。 */
export function CanvasImagePresetBadge({ config, active, onChange, onReopen, onClear }: {
  readonly config: ImageNodeConfig;
  readonly active: boolean;
  readonly onChange: (config: ImageNodeConfig) => void;
  readonly onReopen: () => void;
  readonly onClear: () => void;
}) {
  const id = useId();
  const preset = canvasImagePreset(config.imagePreset?.scene);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const visible = open && active && Boolean(preset?.options.length);
  const close = useCallback(() => setOpen(false), []);
  const layer = useFloatingLayerAnchor<HTMLDivElement>({ open: visible, anchorRef: trigger, minWidth: 285, maxHeight: 360, preferAbove: true, gap: 8 });
  usePresetDismiss(visible, trigger, layer.ref, close, true);
  useEffect(() => { if (!active || !preset?.options.length) setOpen(false); }, [active, preset]);
  useLayoutEffect(() => { if (visible) layer.ref.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true }); }, [visible, layer.ref]);
  if (!config.imagePreset) return null;
  const values = preset ? imagePresetOptionValues(preset, config.imagePreset.options) : {};
  return <div className="canvas-image-preset-badge">
    <span className="canvas-image-preset-badge__icon"><CanvasChromeIcon name={preset?.icon ?? "grid2plus"} size={14} /></span>
    <span>{preset?.label ?? "预设已失效"}</span>
    <button ref={trigger} type="button" aria-label={preset?.options.length ? `调整${preset.label}` : "重新选择图片预设"}
      data-tooltip={preset?.options.length ? `调整${preset.label}` : "重新选择图片预设"} aria-haspopup={preset?.options.length ? "dialog" : "menu"}
      aria-expanded={preset?.options.length ? visible : undefined} aria-controls={visible ? id : undefined}
      onClick={() => preset?.options.length ? setOpen(value => !value) : onReopen()}><CanvasChromeIcon name="adjust" size={14} /></button>
    <button type="button" aria-label="清除图片预设" data-tooltip="清除图片预设" onClick={() => { close(); onClear(); }}><CanvasChromeIcon name="close" size={12} /></button>
    {visible && preset ? createPortal(<div ref={layer.ref} id={id} className="canvas-image-preset-options nodrag nopan" role="dialog" aria-label={preset.label}
      onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
      onKeyDown={event => {
        if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); trigger.current?.focus({ preventScroll: true }); }
      }}>
      <strong>{preset.label}</strong>
      {preset.options.map(option => <label key={option.key}><span>{option.label}</span><CanvasSelect ariaLabel={option.label} value={values[option.key] ?? option.default}
        options={option.values.map(value => ({ value: value.value, label: value.label }))} onChange={value => {
          if (config.imagePreset) onChange({ ...config, imagePreset: { ...config.imagePreset, options: { ...values, [option.key]: value } } });
        }} /></label>)}
      <button type="button" onClick={() => { close(); onReopen(); }}>更换预设</button>
    </div>, document.body) : null}
  </div>;
}
