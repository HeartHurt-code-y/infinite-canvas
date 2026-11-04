import { useEffect, useId, useRef } from "react";
import { useCanvas, useCanvasNodeEntry } from "../canvas/canvasStore";
import { LibTVMediaIcon } from "./LibTVMediaIcon";
import { CanvasNodeTitle } from "./VideoGenerationNode";
import "./CanvasDirectorNode.css";

export function CanvasDirectorNode({ nodeKey, selected, running, error, onOpen, onReference, onPrompt, onGenerate, onRename }: {
  readonly nodeKey: string;
  readonly selected: boolean;
  readonly running: boolean;
  readonly error: string | null;
  readonly onOpen: (key: string) => void;
  readonly onReference: (key: string) => void;
  readonly onPrompt: (key: string, prompt: string) => void;
  readonly onGenerate: (key: string) => void;
  readonly onRename: (key: string, name: string) => void;
}) {
  const entry = useCanvasNodeEntry(nodeKey);
  const references = useCanvas(state => Boolean(state.graph.byTarget.get(nodeKey)?.length));
  const composer = useRef<HTMLFormElement>(null);
  const promptId = useId();
  useEffect(() => {
    const el = composer.current;
    const stage = el?.closest(".canvas-stage");
    if (!selected || !el || !stage) return;
    const viewport = el.closest(".react-flow__viewport");
    const dock = stage.querySelector(".canvas-bottom-dock-row");
    const place = () => {
      const anchor = el.parentElement?.getBoundingClientRect();
      if (!anchor) return;
      const bottom = dock?.getBoundingClientRect().top ?? stage.getBoundingClientRect().bottom;
      const top = stage.getBoundingClientRect().top;
      const height = el.getBoundingClientRect().height;
      el.toggleAttribute("data-above", anchor.bottom + height + 12 > bottom && anchor.top - height - 36 > top);
    };
    const observer = new ResizeObserver(place);
    observer.observe(el);
    observer.observe(stage);
    const movement = new MutationObserver(place);
    if (viewport) movement.observe(viewport, { attributes: true, attributeFilter: ["style"] });
    const wrapper = el.closest(".react-flow__node");
    if (wrapper) movement.observe(wrapper, { attributes: true, attributeFilter: ["style"] });
    place();
    return () => { observer.disconnect(); movement.disconnect(); };
  }, [selected]);
  if (entry?.type !== "director") return null;
  const { data } = entry;
  return <div className="canvas-director-node" data-connection-target={nodeKey} data-node-kind="director" data-selected={selected}>
    <header className="canvas-director-node__title">
      <LibTVMediaIcon name="menu-q4-director" size={14} />
      <CanvasNodeTitle title={data.name} onRename={name => onRename(nodeKey, name)} />
    </header>
    <div className="canvas-director-node__body" aria-busy={running} onDoubleClick={() => onOpen(nodeKey)}>
      {data.previewUrl ? <img src={data.previewUrl} alt="导演台构图预览" draggable={false} /> :
        <div className="canvas-director-node__empty">
          <LibTVMediaIcon name="menu-q4-director" size={48} />
          <p>{running ? "正在生成场景…" : data.scene.objects.length ? `场景中有 ${data.scene.objects.length} 个对象` : "在3D空间中搭建场景并进行多视角截图"}</p>
        </div>}
      <button className="canvas-director-node__open nodrag" type="button" onClick={() => onOpen(nodeKey)}>
        打开导演台
      </button>
    </div>
    {selected ? <form className="canvas-director-node__composer nodrag nopan nowheel" ref={composer}
      onSubmit={event => { event.preventDefault(); onGenerate(nodeKey); }}>
      <label htmlFor={promptId} className="sr-only">场景描述</label>
      <textarea id={promptId} value={data.prompt} maxLength={8000} disabled={running}
        placeholder="描述想要搭建的场景，支持通过参考图创建"
        onChange={event => onPrompt(nodeKey, event.target.value)} />
      {error ? <p role="alert">{error}</p> : null}
      <div className="canvas-director-node__composer-actions">
        <button type="button" aria-label="添加参考图" data-tooltip="添加参考图" disabled={running} onClick={() => onReference(nodeKey)}>
          <LibTVMediaIcon name="plus-s" size={20} />
        </button>
        {references ? <span>已连接参考图</span> : null}
        <button type="submit" data-canvas-generate="" aria-label="生成3D场景"
          data-tooltip="使用当前文本模型生成场景 · 按供应商计费"
          disabled={running || (!data.prompt.trim() && !references)}>
          <LibTVMediaIcon name="up-arrow" size={15} />
        </button>
      </div>
    </form> : null}
  </div>;
}
