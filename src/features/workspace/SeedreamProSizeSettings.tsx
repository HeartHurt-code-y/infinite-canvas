import { useId, useState } from "react";
import type { ModelParameterValue } from "../../lib/modelCapabilities";
import { SEEDREAM_PRO_RATIOS, SEEDREAM_PRO_RESOLUTIONS, seedreamProParameterIssue, seedreamProSize, seedreamProSizeInfo } from "../../lib/seedreamPro";

export function SeedreamProSizeSettings({ values, onChange }: {
  readonly values: Readonly<Record<string, ModelParameterValue>>;
  readonly onChange: (size: string) => void;
}) {
  const id = useId();
  const size = String(values["size"] ?? "2K");
  const info = seedreamProSizeInfo(size);
  const layers = values["layer_decomposition"] === true;
  const [editingCustom, setEditingCustom] = useState(false);
  const custom = !layers && (editingCustom || info.ratio === "custom");
  const issue = seedreamProParameterIssue(values);
  const dimensions = /^(\d*)x(\d*)$/.exec(size);
  const width = dimensions?.[1] ?? "", height = dimensions?.[2] ?? "";
  return <section className="seedream-pro-size" aria-label="Seedream Pro 尺寸与画幅">
    <div className="canvas-video-parameter">
      <span data-tooltip="分辨率是总像素档位。智能比例由提示词决定画幅，固定画幅按官方尺寸表提交。">分辨率</span>
      <div className="canvas-video-options" role="group" aria-label="分辨率">
        {layers ? <button type="button" aria-pressed={size === "auto"} onClick={() => onChange("auto")}>自动</button> : null}
        {SEEDREAM_PRO_RESOLUTIONS.map(resolution => <button type="button" key={resolution} aria-pressed={size !== "auto" && info.resolution === resolution} onClick={() => {
          setEditingCustom(false);
          onChange(layers || info.ratio === "adaptive" || info.ratio === "custom" ? resolution : seedreamProSize(resolution, info.ratio));
        }}>{resolution}</button>)}
      </div>
    </div>
    {layers ? <p className="seedream-pro-hint">拆分底图与各图层保持原图画幅；参考图仅限一张。自动档尽量保留原始尺寸。</p> : <>
      <div className="canvas-video-parameter">
        <span>画幅</span>
        <div className="canvas-video-options seedream-pro-ratios" role="group" aria-label="画幅">
          <button type="button" aria-pressed={!custom && info.ratio === "adaptive"} onClick={() => { setEditingCustom(false); onChange(info.resolution); }}>智能比例</button>
          {SEEDREAM_PRO_RATIOS.map(ratio => {
            const [w, h] = ratio.split(":").map(Number);
            return <button type="button" key={ratio} aria-pressed={!custom && info.ratio === ratio} onClick={() => { setEditingCustom(false); onChange(seedreamProSize(info.resolution, ratio)); }}>
              <i className="canvas-video-ratio-shape" aria-hidden="true" style={{ width: 20 * Math.min(1, w! / h!), height: 20 * Math.min(1, h! / w!) }} />{ratio}
            </button>;
          })}
          <button type="button" aria-pressed={custom} onClick={() => { setEditingCustom(true); if (!dimensions) onChange(seedreamProSize(info.resolution, "1:1")); }}>自定义</button>
        </div>
      </div>
      {custom ? <div className="seedream-pro-dimensions">
        <label htmlFor={`${id}-width`}>宽度 <span>px</span><input id={`${id}-width`} aria-invalid={issue != null} aria-describedby={`${id}-size-hint`} type="number" min={1} step={1} inputMode="numeric" value={width} onChange={event => onChange(`${event.target.value}x${height}`)} /></label>
        <span aria-hidden="true">×</span>
        <label htmlFor={`${id}-height`}>高度 <span>px</span><input id={`${id}-height`} aria-invalid={issue != null} aria-describedby={`${id}-size-hint`} type="number" min={1} step={1} inputMode="numeric" value={height} onChange={event => onChange(`${width}x${event.target.value}`)} /></label>
      </div> : null}
      <p id={`${id}-size-hint`} className="seedream-pro-hint">{info.ratio === "adaptive" && !custom ? "在提示词中描述横版、竖版或具体比例，由模型决定画幅。" : `${size.replace("x", " × ")} px · 总像素约 ${(Number(width) * Number(height) / 1_000_000).toFixed(2)} MP`}</p>
    </>}
    {values["background"] === "transparent" ? <p className="seedream-pro-hint">透明背景需要一张带透明通道的 PNG 参考图，输出已切换为 PNG。</p> : null}
    {issue ? <p className="seedream-pro-error" role="alert">{issue}</p> : null}
  </section>;
}
