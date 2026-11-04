import { CanvasSelect } from "../../components/CanvasSelect";
import { LibTVMediaIcon } from "./LibTVMediaIcon";
import type { OpeningLayer } from "./openingLayers";

const FONTS = [
  { value: "sans-serif", label: "黑体" },
  { value: "serif", label: "衬线体" },
  { value: "KaiTi, serif", label: "楷体" },
  { value: "STKaiti, cursive", label: "手写体" },
  { value: "monospace", label: "等宽" },
  { value: "Georgia, serif", label: "哥特衬线" },
];

export function CanvasOpeningLayerEditor({ layers, selectedId, onSelect, onChange, onRemove, onReorder, onClose, onMerge }: {
  readonly layers: readonly OpeningLayer[];
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  readonly onChange: (layer: OpeningLayer) => void;
  readonly onRemove: (id: string) => void;
  readonly onReorder: (id: string, direction: -1 | 1) => void;
  readonly onClose: () => void;
  readonly onMerge: () => void;
}) {
  const selected = layers.find(layer => layer.id === selectedId);
  const index = layers.findIndex(layer => layer.id === selectedId);
  return <div className="canvas-opening-layer-editor">
    <header>
      <button type="button" aria-label="返回片头设计" data-tooltip="返回片头设计" onClick={onClose}>
        <LibTVMediaIcon name="back" size={18} />
      </button>
      <h3>图层编辑</h3>
    </header>
    <ul aria-label="片头图层">
      {[...layers].reverse().map(layer => {
        const label = layer.kind === "text" ? layer.text.trim() || "文字图层" : layer.name;
        return <li key={layer.id} data-selected={selectedId === layer.id || undefined}>
          <button type="button" aria-label={label} aria-pressed={selectedId === layer.id} onClick={() => onSelect(layer.id)}>
            <LibTVMediaIcon name={layer.kind === "text" ? "text-edit" : "icon-element"} size={16} />
            <span>{label}</span>
          </button>
          <button type="button" aria-label={(layer.visible ? "隐藏 " : "显示 ") + label}
            onClick={() => onChange({ ...layer, visible: !layer.visible })}>
            <LibTVMediaIcon name={layer.visible ? "eye" : "eye-closed"} size={16} />
          </button>
        </li>;
      })}
    </ul>
    {selected ? <>
      {selected.kind === "text" ? <div className="canvas-feature-edit__title-controls">
        <label>文字<input aria-label="图层文字" maxLength={120} value={selected.text}
          onChange={event => onChange({ ...selected, text: event.target.value })} /></label>
        <CanvasSelect ariaLabel="图层字体" value={selected.font} options={FONTS} onChange={font => onChange({ ...selected, font })} />
        <label>填充<input type="color" value={selected.color} aria-label="图层填充色"
          onChange={event => onChange({ ...selected, color: event.target.value })} /></label>
        <label>字号<input type="range" aria-label="图层字号" min={3} max={32} value={selected.size}
          onChange={event => onChange({ ...selected, size: event.target.valueAsNumber })} /></label>
        <label><input type="checkbox" checked={selected.italic} onChange={event => onChange({ ...selected, italic: event.target.checked })} />斜体</label>
      </div> : <label className="canvas-opening-layer-editor__scale">缩放
        <input aria-label="图层缩放" type="range" min={.05} max={Math.min(1, selected.width / selected.height)} step={.01}
          value={selected.width} onChange={event => {
            const width = event.target.valueAsNumber;
            const height = width * selected.height / selected.width;
            onChange({ ...selected, width, height, x: Math.min(selected.x, 1 - width), y: Math.min(selected.y, 1 - height) });
          }} />
      </label>}
      <div className="canvas-opening-layer-editor__order">
        <button type="button" disabled={index >= layers.length - 1} onClick={() => onReorder(selected.id, 1)}>上移</button>
        <button type="button" disabled={index <= 0} onClick={() => onReorder(selected.id, -1)}>下移</button>
        <button type="button" aria-label="删除所选图层" data-tooltip="删除图层" onClick={() => onRemove(selected.id)}>
          <LibTVMediaIcon name="trash-l" size={16} />
        </button>
      </div>
    </> : <p>选择一个图层进行编辑</p>}
    <button type="button" className="canvas-opening-templates__primary" disabled={!layers.some(layer => layer.visible)} onClick={onMerge}>
      <LibTVMediaIcon name="merge" size={16} />合并图层
    </button>
  </div>;
}
