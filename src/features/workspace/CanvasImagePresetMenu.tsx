import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useEscapeHandler } from "../../components/escapeArbiter";
import { useFloatingLayerAnchor } from "../create/useFloatingLayerAnchor";
import {
  CANVAS_IMAGE_PRESET_GROUPS,
  CANVAS_IMAGE_PRESET_VERSION,
  canvasImagePreset,
  canvasImagePresetLabel,
  imagePresetOptionValues,
  selectCanvasImagePreset,
} from "../../lib/canvasImagePresets";
import type { ModelParameterCapability } from "../../lib/modelCapabilities";
import { LibTVMediaIcon } from "./LibTVMediaIcon";
import type { ImageNodeConfig } from "./workspaceModel";

/** 让 body portal 与编辑层各自的关闭手势互不抢占。 */
function usePresetDismiss(open: boolean, anchor: RefObject<HTMLElement | null>, layer: RefObject<HTMLElement | null>, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const outside = (target: EventTarget | null) => target instanceof Node
      && !anchor.current?.contains(target) && !layer.current?.contains(target);
    const pointer = (event: PointerEvent) => { if (outside(event.target)) close(); };
    const focus = (event: FocusEvent) => { if (outside(event.target)) close(); };
    document.addEventListener("pointerdown", pointer, true);
    document.addEventListener("focusin", focus);
    return () => {
      document.removeEventListener("pointerdown", pointer, true);
      document.removeEventListener("focusin", focus);
    };
  }, [open, anchor, layer, close]);
  useEscapeHandler({
    canHandle: () => open,
    handle: () => { close(); anchor.current?.focus({ preventScroll: true }); },
  }, open);
}

export function CanvasImagePresetMenu({ config, active, getCapabilities, triggerRef, onChange, onStoryboardSelect }: {
  readonly config: ImageNodeConfig;
  readonly active: boolean;
  readonly getCapabilities: () => readonly ModelParameterCapability[];
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  readonly onChange: (config: ImageNodeConfig) => void;
  readonly onStoryboardSelect: (scene: string) => void;
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
      data-tooltip={current ? `图片预设：${canvasImagePresetLabel(current, config.imagePreset?.options)}` : "图片预设"} data-selected={Boolean(config.imagePreset) || undefined}
      onClick={() => setOpen(value => !value)}>
      <LibTVMediaIcon name="preset-n" size={16} /><i className="canvas-image-preset-new-dot" aria-hidden="true" />
    </button>
    {visible ? createPortal(<div ref={layer.ref} id={id} className="canvas-image-preset-menu nodrag nopan" role="menu" aria-label="图片预设"
      onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onKeyDown={keydown}>
      {([0, 1] as const).map(column => <div className="canvas-image-preset-menu__column" key={column}>
        {CANVAS_IMAGE_PRESET_GROUPS.filter(group => group.column === column).map(group => <section key={group.id} role="group" aria-labelledby={`${id}-${group.id}`}>
          <h3 id={`${id}-${group.id}`}>{group.label}</h3>
          {group.presets.map(preset => <button type="button" key={preset.scene} role="menuitemradio" aria-checked={config.imagePreset?.scene === preset.scene}
            data-tooltip={preset.description} onClick={() => {
              close();
              triggerRef.current?.focus({ preventScroll: true });
              if (group.id === "storyboard") {
                onStoryboardSelect(preset.scene);
                return;
              }
              const selected = selectCanvasImagePreset(preset, getCapabilities(), config.parameterValues,
                `${config.modelSelection.providerId}:${config.modelSelection.modelDefinitionId}`, config.imagePreset);
              onChange({ ...config, imagePreset: selected.selection, parameterValues: selected.parameterValues, imageMode: "auto", panoramaEnabled: false });
            }}>
            <span className="canvas-image-preset-menu__icon"><LibTVMediaIcon name={preset.icon} size={20} />{preset.newFeature ? <i className="canvas-image-preset-new-dot" aria-hidden="true" /> : null}</span>
            <span>{canvasImagePresetLabel(preset, config.imagePreset?.scene === preset.scene ? config.imagePreset.options : undefined)}</span>
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
  const [previewFailed, setPreviewFailed] = useState(false);
  const switchPanel = Boolean(preset?.options.length && preset.options.every(option => option.control === "switch"));
  const visible = open && active && Boolean(preset?.options.length);
  const close = useCallback(() => setOpen(false), []);
  const layer = useFloatingLayerAnchor<HTMLDivElement>({ open: visible, anchorRef: trigger, minWidth: switchPanel ? 220 : 282, maxHeight: 560, preferAbove: switchPanel, gap: 4, followAnchor: true });
  usePresetDismiss(visible, trigger, layer.ref, close);
  useEffect(() => { if (!active || !preset?.options.length) setOpen(false); }, [active, preset]);
  useEffect(() => { setOpen(false); setPreviewFailed(false); }, [preset?.scene]);
  useLayoutEffect(() => {
    if (visible) layer.ref.current?.querySelector<HTMLButtonElement>('[role="switch"], [role="radio"][aria-checked="true"]')?.focus({ preventScroll: true });
  }, [visible, layer.ref]);
  if (!config.imagePreset) return null;
  const values = preset ? imagePresetOptionValues(preset, config.imagePreset.options) : {};
  const label = preset ? canvasImagePresetLabel(preset, config.imagePreset.options) : "预设已失效";
  const changeOption = (key: string, value: string) => {
    if (!config.imagePreset) return;
    onChange({ ...config, imagePreset: {
      ...config.imagePreset, version: CANVAS_IMAGE_PRESET_VERSION, options: { ...values, [key]: value },
    } });
  };
  return <div className="canvas-image-preset-badge">
    <button type="button" className="canvas-image-preset-badge__remove" aria-label="清除图片预设" data-tooltip="清除图片预设" onClick={() => { close(); onClear(); }}>
      <span className="canvas-image-preset-badge__icon" aria-hidden="true"><LibTVMediaIcon name={preset?.icon ?? "preset-n"} size={12} /></span>
      <span className="canvas-image-preset-badge__close" aria-hidden="true"><LibTVMediaIcon name="close" size={10} /></span>
    </button>
    <button type="button" className="canvas-image-preset-badge__label" aria-label={`重新选择图片预设：${label}`} aria-haspopup="menu"
      onClick={() => { close(); onReopen(); }}>{label}</button>
    {preset?.options.length ? <button ref={trigger} type="button" className="canvas-image-preset-badge__options" aria-label={`调整${preset.label}`}
      data-tooltip={`调整${preset.label}`} aria-haspopup="dialog" aria-expanded={visible} aria-controls={visible ? id : undefined}
      onClick={() => setOpen(value => !value)}><LibTVMediaIcon name="icon-generate-settings1" size={14} /></button> : null}
    {visible && preset ? createPortal(<div ref={layer.ref} id={id} className={`canvas-image-preset-options nodrag nopan${switchPanel ? " canvas-image-preset-options--switches" : ""}`} role="dialog" aria-label={preset.label}
      onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "Enter" || event.key === " ") event.stopPropagation();
      }}>
      {switchPanel ? <strong className="canvas-image-preset-options__heading">{preset.label}</strong> : null}
      {switchPanel && preset.optionsPreviewUrl && !previewFailed ? <video className="canvas-image-preset-options__preview" src={preset.optionsPreviewUrl}
        autoPlay loop muted playsInline preload="metadata" crossOrigin="anonymous" aria-label={`${preset.label}效果示意`} onError={() => setPreviewFailed(true)} /> : null}
      {preset.options.map(option => option.control === "switch" ? <div key={option.key} className="canvas-image-preset-options__switch-row">
        <span className="canvas-image-preset-options__switch-label"><span id={`${id}-${option.key}`}>{option.label}</span>
          {option.help ? <button type="button" className="canvas-image-preset-options__help" aria-label={`${option.label}说明`} data-tooltip={option.help}>
            <LibTVMediaIcon name="help" size={14} />
          </button> : null}
        </span>
        <button type="button" role="switch" className="canvas-image-preset-options__switch" aria-labelledby={`${id}-${option.key}`}
          aria-checked={values[option.key] === "1"} data-tooltip={option.help}
          onClick={() => changeOption(option.key, values[option.key] === "1" ? "0" : "1")}><i aria-hidden="true" /></button>
      </div> : <div key={option.key} className="canvas-image-preset-options__group" role="radiogroup" aria-labelledby={`${id}-${option.key}`}
        onKeyDown={event => {
          if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey) return;
          if (event.key === "Enter" || event.key === " ") { event.stopPropagation(); return; }
          const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
          const index = buttons.findIndex(button => button === document.activeElement);
          let next: HTMLButtonElement | undefined;
          if (event.key === "ArrowRight" || event.key === "ArrowDown") next = buttons[(index + 1) % buttons.length];
          if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = buttons[(index - 1 + buttons.length) % buttons.length];
          if (event.key === "Home") next = buttons[0];
          if (event.key === "End") next = buttons.at(-1);
          if (next) { event.preventDefault(); event.stopPropagation(); next.click(); next.focus({ preventScroll: true }); }
        }}>
        <span id={`${id}-${option.key}`} className="canvas-image-preset-options__title">{option.label}</span>
        <div className="canvas-image-preset-options__choices">
          {option.values.map(value => <button key={value.value} type="button" role="radio" aria-checked={values[option.key] === value.value}
            tabIndex={values[option.key] === value.value ? 0 : -1} data-tooltip={value.label}
            onClick={() => changeOption(option.key, value.value)}><span>{value.label}</span></button>)}
        </div>
      </div>)}
    </div>, document.body) : null}
  </div>;
}
