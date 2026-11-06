import { useId, useLayoutEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CanvasSelect } from "../../components/CanvasSelect";
import type { ProviderCatalogEntry } from "../../lib/backend";
import { resolvedParameterValue, type ModelParameterCapability } from "../../lib/modelCapabilities";
import { seedreamProSummary } from "../../lib/seedreamPro";
import { gptImage25Size } from "../../lib/gptImage25";
import type { ImageNodeConfig } from "./workspaceModel";
import { LibTVMediaIcon } from "./LibTVMediaIcon";
import { VideoNodeSettingsControls } from "./VideoNodeSettingsControls";
import "./CanvasImageEditor.css";
import "./CanvasVideoEditor.css";

const SUMMARY_KEYS = new Set(["aspect_ratio", "ratio", "size", "image_size", "quality", "resolution"]);

/** 只把模型真正声明的枚举显示为选项；保存过的自定义值继续可见。 */
export function CanvasImageParameterOptions({ capability, value, onChange, ratioOptions = false }: {
  readonly capability: ModelParameterCapability;
  readonly value: string | number | boolean;
  readonly onChange: (value: string | number | boolean) => void;
  readonly ratioOptions?: boolean;
}) {
  return <div className="canvas-video-parameter" data-tooltip={capability.description}><span>{capability.label}</span><div className={`canvas-video-options${ratioOptions ? " canvas-image-ratio-options" : ""}`} role="group" aria-label={capability.label}>
    {capability.optional ? <button type="button" aria-pressed={value === ""} onClick={() => onChange("")}>默认</button> : null}
    {capability.options.map(option => {
      const ratio = ratioOptions && typeof option.value === "string" && /^\d+:\d+$/.test(option.value) ? option.value.split(":").map(Number) : null;
      return <button type="button" key={`${typeof option.value}:${String(option.value)}`} aria-pressed={value === option.value} onClick={() => onChange(option.value)}>
        {ratio ? <i className="canvas-video-ratio-shape" aria-hidden="true" style={{width:20*Math.min(1,ratio[0]!/ratio[1]!),height:20*Math.min(1,ratio[1]!/ratio[0]!)}} /> : null}{option.label}
      </button>;
    })}
    {!capability.options.some(option => option.value === value) && !(capability.optional && value === "") ? <button type="button" aria-pressed="true" onClick={() => onChange(value)}>{String(value) || "默认"}</button> : null}
  </div></div>;
}

export function canvasImageHasOptionButtons(capability: ModelParameterCapability): boolean {
  return capability.options.length > 0;
}

export function CanvasImageSettings({ config, active, advancedHostId, triggerHostId, modelLabel, capabilities, model, parameters, providerCatalog, seedreamPro = false, gptImage25 = false, onChange }: {
  readonly config: ImageNodeConfig;
  readonly active: boolean;
  readonly advancedHostId: string;
  readonly triggerHostId: string;
  readonly modelLabel: string;
  readonly capabilities: readonly ModelParameterCapability[];
  readonly seedreamPro?: boolean;
  readonly gptImage25?: boolean;
  readonly providerCatalog: readonly ProviderCatalogEntry[];
  readonly model: ReactNode;
  readonly parameters: ReactNode;
  readonly onChange: (config: ImageNodeConfig) => void;
}) {
  const id = useId();
  const upscale = config.imageMode === "upscale";
  const upscaleProviders = providerCatalog.filter(entry => entry.provider.enabled && entry.provider.adapterId === "atlascloud_v1");
  const markModels = providerCatalog.filter(entry => entry.provider.enabled).flatMap(entry => entry.models
    .filter(model => model.operations.includes("text_generation"))
    .map(model => ({ value: JSON.stringify([entry.provider.id, model.definitionId]), label: `${entry.provider.displayName} · ${model.displayName}` })));
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [triggerHost, setTriggerHost] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => { setHost(document.getElementById(advancedHostId)); }, [advancedHostId]);
  useLayoutEffect(() => { setTriggerHost(document.getElementById(triggerHostId)); }, [triggerHostId]);
  const summary = seedreamPro ? [seedreamProSummary(config.parameterValues)] : capabilities.filter(capability => SUMMARY_KEYS.has(capability.key)).flatMap(capability => {
    const value = resolvedParameterValue(capability, config.parameterValues);
    if (value === "" || value == null) return [];
    return [capability.options.find(option => option.value === value)?.label ?? String(value)];
  });
  if (gptImage25) { const size = gptImage25Size(config.parameterValues); summary.unshift(size === "auto" ? "自动尺寸" : size.replace("x", " × ")); }
  const controls = <section className="canvas-video-advanced canvas-image-advanced" hidden={!active || upscale || !config.advancedOpen} aria-label="高级设置">
    <strong>高级设置</strong>
    <label className="canvas-video-switch" data-tooltip="自动匹配已连接素材的名称，并绑定成带素材身份的 @ 引用。">
      <span>智能引用 AutoLink <LibTVMediaIcon name="help" size={12} /></span>
      <input id={`${id}-autolink`} type="checkbox" role="switch" checked={config.autoLink !== false} onChange={event => onChange({ ...config, autoLink: event.target.checked })} />
      <i aria-hidden="true" />
    </label>
    <div className="canvas-video-parameter canvas-image-mark-model" data-tooltip="选择支持图片理解的文本模型。点击图片标记时调用，费用按供应商实际计费。">
      <span>元素识别模型</span>
      <CanvasSelect ariaLabel="元素识别模型" value={config.markModelSelection ? JSON.stringify([config.markModelSelection.providerId, config.markModelSelection.modelDefinitionId]) : ""}
        options={[{ value: "", label: "工作区默认文本模型" }, ...markModels]} onChange={value => {
          if (!value) { const next = { ...config }; delete next.markModelSelection; onChange(next); return; }
          const [providerId, modelDefinitionId] = JSON.parse(value) as [string, string];
          onChange({ ...config, markModelSelection: { providerId, modelDefinitionId } });
        }} />
    </div>
  </section>;
  const trigger = <button type="button" className="canvas-video-advanced-trigger" aria-label="高级设置" aria-expanded={config.advancedOpen === true} aria-controls={`${id}-advanced`} data-tooltip="高级设置" onClick={() => onChange({ ...config, advancedOpen: !config.advancedOpen })}><LibTVMediaIcon name="icon-generate-settings1" size={16} /></button>;
  return <>
    <VideoNodeSettingsControls kind="image" active={active} modelLabel={upscale ? "图片高清" : modelLabel} parameterLabel={upscale ? `${config.upscaleScale ?? 2}× · PNG` : [...summary, `${config.generationCount}张`].join(" · ")} model={upscale ? <div className="canvas-image-parameters"><label>高清服务</label><CanvasSelect ariaLabel="高清服务供应商" value={config.upscaleProviderId ?? upscaleProviders[0]?.provider.id ?? ""} options={upscaleProviders.map(entry => ({value:entry.provider.id,label:entry.provider.displayName}))} onChange={upscaleProviderId => onChange({...config,upscaleProviderId})} /><small>Atlas Cloud · Image Upscaler</small>{upscaleProviders.length === 0 ? <p>请在全局设置中配置 Atlas Cloud 连接。</p> : null}</div> : model} parameters={<div className="canvas-image-parameters">{upscale ? <div className="canvas-video-parameter"><span>放大倍数</span><div className="canvas-video-options" role="group" aria-label="放大倍数">{([2,4] as const).map(scale => <button key={scale} type="button" aria-pressed={(config.upscaleScale ?? 2) === scale} onClick={() => onChange({...config,upscaleScale:scale})}>{scale}×</button>)}</div></div> : parameters}</div>} modeControl={false} />
    {triggerHost && !upscale ? createPortal(trigger, triggerHost) : null}
    {host ? createPortal(<div id={`${id}-advanced`}>{controls}</div>, host) : null}
  </>;
}
