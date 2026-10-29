import { useId, useLayoutEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CanvasSelect } from "../../components/CanvasSelect";
import { CANVAS_IMAGE_MODES } from "../../lib/canvasImage";
import { resolvedParameterValue, type ModelParameterCapability } from "../../lib/modelCapabilities";
import type { ImageNodeConfig } from "./workspaceModel";
import { CanvasChromeIcon } from "./CanvasChromeIcons";
import { VideoNodeSettingsControls } from "./VideoNodeSettingsControls";
import "./CanvasImageEditor.css";
import "./CanvasVideoEditor.css";

const SUMMARY_KEYS = new Set(["aspect_ratio", "ratio", "size", "image_size", "quality", "resolution"]);

/** 只把模型真正声明的枚举显示为选项；保存过的自定义值继续可见。 */
export function CanvasImageParameterOptions({ capability, value, onChange }: {
  readonly capability: ModelParameterCapability;
  readonly value: string | number | boolean;
  readonly onChange: (value: string | number | boolean) => void;
}) {
  return <div className="canvas-video-parameter" data-tooltip={capability.description}><span>{capability.label}</span><div className="canvas-video-options" role="group" aria-label={capability.label}>
    {capability.options.map(option => <button type="button" key={`${typeof option.value}:${String(option.value)}`} aria-pressed={value === option.value} onClick={() => onChange(option.value)}>{option.label}</button>)}
  </div>{!capability.options.some(option => option.value === value) ? <small>已保存：{String(value)}</small> : null}</div>;
}

export function canvasImageHasOptionButtons(capability: ModelParameterCapability): boolean {
  return SUMMARY_KEYS.has(capability.key) && capability.options.length > 0;
}

export function CanvasImageSettings({ config, active, advancedHostId, triggerHostId, modelLabel, capabilities, model, parameters, advanced, onChange }: {
  readonly config: ImageNodeConfig;
  readonly active: boolean;
  readonly advancedHostId: string;
  readonly triggerHostId: string;
  readonly modelLabel: string;
  readonly capabilities: readonly ModelParameterCapability[];
  readonly model: ReactNode;
  readonly parameters: ReactNode;
  readonly advanced: ReactNode;
  readonly onChange: (config: ImageNodeConfig) => void;
}) {
  const id = useId();
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [triggerHost, setTriggerHost] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => { setHost(document.getElementById(advancedHostId)); }, [advancedHostId]);
  useLayoutEffect(() => { setTriggerHost(document.getElementById(triggerHostId)); }, [triggerHostId]);
  const summary = capabilities.filter(capability => SUMMARY_KEYS.has(capability.key)).flatMap(capability => {
    const requestedResolution = config.imageMode === "upscale" && (capability.key === "resolution" || capability.key === "image_size")
      ? capability.options.find(option => String(option.value).toUpperCase() === (config.upscaleResolution ?? "2K"))?.value : undefined;
    const value = requestedResolution ?? resolvedParameterValue(capability, config.parameterValues);
    if (value === "" || value == null) return [];
    return [capability.options.find(option => option.value === value)?.label ?? String(value)];
  });
  const controls = <section className="canvas-video-advanced canvas-image-advanced" hidden={!active || !config.advancedOpen} aria-label="高级设置">
    <strong>高级设置</strong>
    <label className="canvas-video-switch" data-tooltip="自动匹配已连接素材的名称，并绑定成带素材身份的 @ 引用。">
      <span>智能引用 AutoLink <CanvasChromeIcon name="help" size={12} /></span>
      <input id={`${id}-autolink`} type="checkbox" role="switch" checked={config.autoLink !== false} onChange={event => onChange({ ...config, autoLink: event.target.checked })} />
      <i aria-hidden="true" />
    </label>
  </section>;
  const fields = <>
    <div className="canvas-gen-node__field"><span>生成方式</span><CanvasSelect ariaLabel="图片生成方式" value={config.imageMode ?? "auto"} options={CANVAS_IMAGE_MODES} onChange={value => {
      const mode = CANVAS_IMAGE_MODES.find(item => item.value === value)?.value;
      if (mode) onChange({ ...config, imageMode: mode, ...(mode === "upscale" ? { imagePreset: undefined } : {}) });
    }} /></div>
    {config.imageMode === "upscale" ? <div className="canvas-image-upscale-info">
      <span>高清目标</span><div className="canvas-video-options">{(["1K", "2K", "4K"] as const).map(value => <button key={value} type="button" aria-pressed={(config.upscaleResolution ?? "2K") === value} onClick={() => {
        const resolution = capabilities.find(capability => capability.key === "resolution" || capability.key === "image_size");
        const option = resolution?.options.find(option => String(option.value).toUpperCase() === value);
        onChange({ ...config, upscaleResolution: value, parameterValues: option && resolution ? { ...config.parameterValues, [resolution.key]: option.value } : config.parameterValues });
      }}>{value}</button>)}</div>
      <small>通过所选图片模型进行高清重建；实际输出尺寸以模型返回为准。</small>
    </div> : null}
    {parameters}
    <details className="canvas-video-extra"><summary>更多模型设置</summary><div className="canvas-gen-node__settings">{advanced}</div></details>
  </>;
  const trigger = <button type="button" className="canvas-video-advanced-trigger" aria-label="高级设置" aria-expanded={config.advancedOpen === true} aria-controls={`${id}-advanced`} data-tooltip="高级设置" onClick={() => onChange({ ...config, advancedOpen: !config.advancedOpen })}><CanvasChromeIcon name="adjust" size={16} /></button>;
  return <>
    <VideoNodeSettingsControls kind="image" active={active} modelLabel={modelLabel} parameterLabel={[...summary, `${config.generationCount}张`].join(" · ")} modeLabel="图片生成" model={model} parameters={fields} advanced={null} inlineAdvanced modeControl={false} />
    {triggerHost ? createPortal(trigger, triggerHost) : null}
    {host ? createPortal(<div id={`${id}-advanced`}>{controls}</div>, host) : null}
  </>;
}
