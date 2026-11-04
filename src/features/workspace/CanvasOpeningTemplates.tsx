import { useState } from "react";
import { CanvasSelect } from "../../components/CanvasSelect";
import { LibTVMediaIcon } from "./LibTVMediaIcon";

export type OpeningTab = "design" | "motion";
export type OpeningTextStyle = { font: string; color: string; outline: string; italic: boolean; size: number };
export const OPENING_DEFAULT_STYLE: OpeningTextStyle = { font: "sans-serif", color: "#ffffff", outline: "", italic: false, size: 11 };

interface Template {
  readonly id: string;
  readonly name: string;
  readonly style?: OpeningTextStyle;
  readonly motion?: string;
  readonly cover?: string;
  readonly custom?: true;
}

const design = [
  ["简约高级", "sans-serif", "#ffffff", "", false, 9],
  ["中式书法", "KaiTi, serif", "#fff0cf", "", false, 14],
  ["文艺手写", "STKaiti, cursive", "#f5dfaf", "", true, 11],
  ["热血动漫", "sans-serif", "#ffd35c", "#ba3416", true, 15],
  ["赛博科幻", "monospace", "#a7fbff", "#3150a1", false, 12],
  ["哥特玄幻", "Georgia, serif", "#ded1fa", "#32224c", false, 13],
] as const;
const motion = ["模糊渐入", "动态粒子", "故障闪现", "手写笔画", "动画拼合", "震击入场"] as const;
const presets: Record<OpeningTab, readonly Template[]> = {
  design: [
    { id: "default", name: "默认", cover: "/opening-presets/design-default.png", style: OPENING_DEFAULT_STYLE },
    ...design.map(([name, font, color, outline, italic, size], index) => ({
      id: "style-" + index, name, style: { font, color, outline, italic, size },
    })),
  ],
  motion: [
    { id: "default", name: "默认", cover: "/opening-presets/motion-default.png", motion: "文字缓慢清晰显现，背景自然过渡。" },
    ...motion.map((name, index) => ({ id: "motion-" + index, name, motion: `片名使用「${name}」动效。` })),
  ],
};

const STORAGE_KEY = "canvas-opening-templates";

function loadCustom(tab: OpeningTab): Template[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY + "-" + tab) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is Template => item && item.custom === true && typeof item.id === "string" &&
      typeof item.name === "string" && (tab === "design" ? typeof item.style?.font === "string" &&
        typeof item.style.color === "string" && typeof item.style.outline === "string" &&
        typeof item.style.italic === "boolean" && Number.isFinite(item.style.size) : typeof item.motion === "string"));
  } catch { return []; }
}

export function CanvasOpeningTemplates({ tab, selected, disabled, onSelect }: {
  readonly tab: OpeningTab;
  readonly selected: string;
  readonly disabled: boolean;
  readonly onSelect: (template: Template) => void;
}) {
  const [custom, setCustom] = useState(() => loadCustom(tab));
  const [draft, setDraft] = useState<{ id: string | null; name: string; base: string; description: string } | null>(null);
  const options = [...presets[tab], ...custom];
  const label = tab === "design" ? "片名风格" : "动效模板";
  function update(items: Template[]) {
    setCustom(items);
    try { localStorage.setItem(STORAGE_KEY + "-" + tab, JSON.stringify(items)); } catch { /* Session state remains usable. */ }
  }

  return <section className="canvas-opening-templates" aria-label={label}>
    <h3>{label}</h3>
    <div className="canvas-opening-templates__grid">
      {options.map(template => (
        <div className="canvas-opening-templates__item" key={template.id}>
          <button type="button" className="canvas-opening-templates__card" disabled={disabled}
            aria-pressed={selected === template.id} onClick={() => onSelect(template)}>
            <span className="canvas-opening-templates__cover" style={template.style ?
              { color: template.style.color, fontFamily: template.style.font, fontStyle: template.style.italic ? "italic" : "normal" } : undefined}>
              {template.cover ? <img src={template.cover} alt="" /> : tab === "design" ? "片名" :
                <LibTVMediaIcon name="animation" size={28} />}
            </span>
            <span>{template.name}</span>
          </button>
          {template.custom ? <div className="canvas-opening-templates__actions">
            <button type="button" aria-label={`编辑模板 ${template.name}`} data-tooltip="编辑模板" disabled={disabled}
              onClick={() => {
                const base = presets.design.find(candidate => JSON.stringify(candidate.style) === JSON.stringify(template.style));
                setDraft({ id: template.id, name: template.name, base: base?.id ?? "default", description: template.motion ?? "" });
              }}><LibTVMediaIcon name="pencil" size={14} /></button>
            <button type="button" aria-label={`删除模板 ${template.name}`} data-tooltip="删除模板" disabled={disabled}
              onClick={() => {
                update(custom.filter(item => item.id !== template.id));
                if (selected === template.id) onSelect(presets[tab][0]!);
                if (draft?.id === template.id) setDraft(null);
              }}><LibTVMediaIcon name="trash-l" size={14} /></button>
          </div> : null}
        </div>
      ))}
      <button type="button" className="canvas-opening-templates__card" disabled={disabled}
        onClick={() => setDraft({ id: null, name: "", base: "default", description: "" })}>
        <span className="canvas-opening-templates__cover"><LibTVMediaIcon name="plus-l" size={26} /></span>
        <span>{tab === "design" ? "自定义风格" : "自定义动效"}</span>
      </button>
    </div>
    {draft ? <form className="canvas-opening-templates__form" onSubmit={event => {
      event.preventDefault();
      const name = draft.name.trim();
      if (!name || disabled || (tab === "motion" && !draft.description.trim())) return;
      const template: Template = {
        id: draft.id ?? crypto.randomUUID(), name, custom: true,
        ...(tab === "design" ? { style: presets.design.find(item => item.id === draft.base)?.style ?? OPENING_DEFAULT_STYLE }
          : { motion: draft.description.trim() }),
      };
      update(draft.id ? custom.map(item => item.id === draft.id ? template : item) : [...custom, template]);
      onSelect(template);
      setDraft(null);
    }}>
      <input aria-label="模板名称" placeholder="模板名称" maxLength={30} value={draft.name}
        disabled={disabled} onChange={event => setDraft({ ...draft, name: event.target.value })} />
      {tab === "design" ? <CanvasSelect ariaLabel="基础片名风格" value={draft.base} disabled={disabled}
        options={presets.design.map(item => ({ value: item.id, label: item.name }))}
        onChange={base => setDraft({ ...draft, base })} /> : <textarea aria-label="动效描述" placeholder="描述想要的文字动效"
        maxLength={600} value={draft.description} disabled={disabled}
        onChange={event => setDraft({ ...draft, description: event.target.value })} />}
      <div>
        <button type="button" onClick={() => setDraft(null)}>取消</button>
        <button type="submit" disabled={disabled || !draft.name.trim() || (tab === "motion" && !draft.description.trim())}>保存模板</button>
      </div>
    </form> : null}
  </section>;
}
