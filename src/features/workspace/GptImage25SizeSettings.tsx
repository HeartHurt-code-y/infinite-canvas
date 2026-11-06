import { useId, useState } from "react";
import { CanvasSelect } from "../../components/CanvasSelect";
import { GPT_IMAGE_25_SIZES, gptImage25Size, gptImage25SizeIssue } from "../../lib/gptImage25";
import type { ModelParameterValue } from "../../lib/modelCapabilities";

export function GptImage25SizeSettings({ values, onChange }: {
  readonly values: Readonly<Record<string, ModelParameterValue>>;
  readonly onChange: (size: string) => void;
}) {
  const id = useId();
  const size = gptImage25Size(values);
  const row = GPT_IMAGE_25_SIZES.find(entry => entry.sizes.some(value => value === size));
  const [editingCustom, setEditingCustom] = useState(false);
  const custom = editingCustom || (size !== "auto" && !row);
  const dimensions = /^(\d*)x(\d*)$/.exec(size);
  const width = dimensions?.[1] ?? "", height = dimensions?.[2] ?? "";
  const pixels = Number(width) * Number(height);
  const issue = gptImage25SizeIssue(size);
  const currentTier = row ? row.sizes.findIndex(value => value === size) : 0;
  return <section className="seedream-pro-size" aria-label="GPT Image 2.5 尺寸与画幅">
    <div className="canvas-video-parameter">
      <span>画幅</span>
      <div className="canvas-video-options seedream-pro-ratios" role="group" aria-label="画幅">
        <button type="button" aria-pressed={!custom && size === "auto"} onClick={() => { setEditingCustom(false); onChange("auto"); }}>自动</button>
        {GPT_IMAGE_25_SIZES.map(entry => {
          const [w, h] = entry.ratio.split(":").map(Number);
          return <button type="button" key={entry.ratio} aria-pressed={!custom && row === entry} onClick={() => { setEditingCustom(false); onChange(entry.sizes[currentTier] ?? entry.sizes[0]); }}>
            <i className="canvas-video-ratio-shape" aria-hidden="true" style={{ width: 20 * Math.min(1, w! / h!), height: 20 * Math.min(1, h! / w!) }} />{entry.ratio}
          </button>;
        })}
        <button type="button" aria-pressed={custom} onClick={() => { setEditingCustom(true); if (!dimensions) onChange("1024x1024"); }}>自定义</button>
      </div>
    </div>
    {row && !custom ? <div className="canvas-video-parameter"><span>像素尺寸</span>
      <CanvasSelect ariaLabel="像素尺寸" value={size} options={row.sizes.map(value => ({ value, label: `${value.replace("x", " × ")} px` }))} onChange={onChange} />
    </div> : null}
    {custom ? <div className="seedream-pro-dimensions">
      <label htmlFor={`${id}-width`}>宽度 <span>px</span><input id={`${id}-width`} aria-invalid={issue != null} aria-describedby={`${id}-hint${issue ? ` ${id}-error` : ""}`} type="number" min={16} max={3840} step={16} inputMode="numeric" value={width} onChange={event => onChange(`${event.target.value}x${height}`)} /></label>
      <span aria-hidden="true">×</span>
      <label htmlFor={`${id}-height`}>高度 <span>px</span><input id={`${id}-height`} aria-invalid={issue != null} aria-describedby={`${id}-hint${issue ? ` ${id}-error` : ""}`} type="number" min={16} max={3840} step={16} inputMode="numeric" value={height} onChange={event => onChange(`${width}x${event.target.value}`)} /></label>
    </div> : null}
    <p id={`${id}-hint`} className="seedream-pro-hint">{size === "auto" ? "由模型自动选择尺寸；也可选择画幅或输入像素尺寸。" : `${size.replace("x", " × ")} px · ${(pixels / 1_000_000).toFixed(2)} MP。宽高为 16 的倍数，单边 ≤ 3840 px。`}</p>
    {pixels > 3_686_400 ? <p className="seedream-pro-hint">超过 2560 × 1440 的总像素属于官方实验性大尺寸。</p> : null}
    {issue ? <p id={`${id}-error`} className="seedream-pro-error" role="alert">{issue}</p> : null}
  </section>;
}
