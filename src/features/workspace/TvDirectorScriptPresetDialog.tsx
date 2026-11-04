import { useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useModalFocusTrap } from "../../components/useModalFocusTrap";
import { backendErrorMessage, pickPromptMultimodalFiles, type PickedPromptMaterial } from "../../lib/backend";
import { LibTVMediaIcon } from "./LibTVMediaIcon";
import {
  DIRECTOR_SCRIPT_CATALOG as catalog, type DirectorHotPreset, type DirectorPresetOption, type DirectorScriptSettings,
} from "./tvDirector";
import "./TvDirectorScriptPresetDialog.css";

export interface DirectorPresetDraft {
  readonly presetKey: string | null;
  readonly genreKey: string;
  readonly fusionKey: string;
  readonly customGenre: string;
  readonly customFusion: string;
  readonly fields: Readonly<Record<string, readonly string[]>>;
  readonly episodes: string;
  readonly structure: string;
  readonly customStyle: string;
  readonly styleImage: PickedPromptMaterial | null;
}

const emptyPreset: DirectorPresetDraft = {
  presetKey: null, genreKey: catalog.genres[0]!.key, fusionKey: "", customGenre: "", customFusion: "",
  fields: {}, episodes: String(catalog.episodes.default), structure: "", customStyle: "", styleImage: null,
};

function fromHotPreset(preset: DirectorHotPreset): DirectorPresetDraft {
  return {
    ...emptyPreset, presetKey: preset.key, genreKey: preset.genreKey, fusionKey: preset.fusionGenreKey ?? "",
    fields: Object.fromEntries(catalog.fields.map(field => [
      field.fieldKey, (preset.fields[field.fieldKey] ?? []).slice(0, field.maxSelect),
    ])),
    episodes: preset.episodes == null ? "" : String(preset.episodes),
    structure: preset.structure ?? "",
  };
}

function coverStyle(option?: DirectorPresetOption) {
  return option?.coverUrl ? { backgroundImage: `linear-gradient(0deg, #141414dc, #14141410 72%), url("${option.coverUrl}")` } : undefined;
}

export function TvDirectorScriptPresetDialog({ initial, onClose, onConfirm }: {
  readonly initial: DirectorPresetDraft | null;
  readonly onClose: () => void;
  readonly onConfirm: (value: DirectorPresetDraft, settings: DirectorScriptSettings, prefill: string | undefined) => void;
}) {
  const titleId = useId();
  const closeButton = useRef<HTMLButtonElement>(null);
  const [value, setValue] = useState(() => initial ?? emptyPreset);
  const [showHot, setShowHot] = useState(true);
  const [fusionOpen, setFusionOpen] = useState(Boolean(value.fusionKey));
  const [fieldOpen, setFieldOpen] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [prefill, setPrefill] = useState<string>();
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState("");
  const trap = useModalFocusTrap({ active: true, onEscape: onClose, initialFocusRef: closeButton });
  const genre = catalog.genres.find(option => option.key === value.genreKey);
  const fusion = catalog.genres.find(option => option.key === value.fusionKey);

  function patch(next: Partial<DirectorPresetDraft>) {
    setValue(previous => ({ ...previous, ...next }));
  }

  function choosePreset(preset: DirectorHotPreset) {
    const next = fromHotPreset(preset);
    setValue(next);
    setFusionOpen(Boolean(next.fusionKey));
    setFieldOpen(null);
    setPrefill(preset.prompt);
    setError("");
  }

  async function pickStyleImage() {
    setPicking(true);
    setError("");
    try {
      const [image] = await pickPromptMultimodalFiles({ kinds: ["image"], title: "上传风格参考图" });
      if (image) patch({ styleImage: image });
    } catch (failure) {
      setError(backendErrorMessage(failure));
    } finally {
      setPicking(false);
    }
  }

  function confirm() {
    const genreName = genre?.freeInput ? value.customGenre.trim() : genre?.name;
    const fusionName = fusion?.freeInput ? value.customFusion.trim() : fusion?.name;
    const episodes = value.episodes === "" ? null : Number(value.episodes);
    if (!genreName || (fusion && !fusionName)) {
      setError("请输入自定义题材。");
      return;
    }
    if (episodes != null && (!Number.isInteger(episodes) || episodes < catalog.episodes.min || episodes > catalog.episodes.max)) {
      setError(`集数应为 ${catalog.episodes.min} 至 ${catalog.episodes.max} 的整数。`);
      return;
    }
    const useStyleImage = value.fields["visualStyle"]?.includes("custom") && value.styleImage;
    const fields = catalog.fields.flatMap(field => {
      const selected = field.options.filter(option => value.fields[field.fieldKey]?.includes(option.key))
        .map(option => option.freeInput ? value.customStyle.trim() || (useStyleImage ? "参考附件中的风格图" : "") : option.name)
        .filter(Boolean);
      return selected.length ? [{ name: field.name, value: selected.join("、") }] : [];
    });
    onConfirm({ ...value, styleImage: useStyleImage || null }, {
      genre: fusionName ? genreName + " + " + fusionName : genreName,
      fields,
      episodes,
      structure: catalog.structure.options.find(option => option.key === value.structure)?.name ?? null,
    }, prefill);
  }

  const field = catalog.fields.find(item => item.fieldKey === fieldOpen);
  const visibleOptions = field?.options.filter(option => option.name.toLowerCase().includes(query.trim().toLowerCase())) ?? [];
  return createPortal(
    <div className="director-preset-backdrop" onPointerDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={trap.ref} {...trap.containerProps} role="dialog" aria-modal="true" aria-labelledby={titleId}
        className="director-preset">
        {showHot ? <section className="director-preset__hot" aria-label="爆款预设">
          <h3>爆款预设 Top {catalog.hotPresets.length}</h3>
          <div className="director-preset__ranking">
            {catalog.hotPresets.map((preset, index) => {
              const option = catalog.genres.find(item => item.key === preset.genreKey);
              const style = index < 3 ? coverStyle(preset.coverUrl ? { ...preset, coverUrl: preset.coverUrl } : option) : undefined;
              return <button key={preset.key} type="button" style={style} aria-pressed={preset.key === value.presetKey}
                onClick={() => choosePreset(preset)}><span>{index + 1}</span>{preset.name}</button>;
            })}
          </div>
        </section> : null}
        <section className="director-preset__settings">
          <header>
            <h2 id={titleId}>剧本设定器</h2>
            <button ref={closeButton} type="button" className="director-preset__close"
              aria-label="关闭剧本设定器" data-tooltip="关闭剧本设定器" onClick={onClose}>
              <LibTVMediaIcon name="close" size={20} />
            </button>
          </header>
          <div className="director-preset__body">
            <div className="director-preset__line">
              <strong>题材类型</strong>
              <button type="button" aria-pressed={fusionOpen} onClick={() => {
                setFusionOpen(!fusionOpen);
                if (fusionOpen) patch({ fusionKey: "", customFusion: "" });
              }}><LibTVMediaIcon name="plus-s" size={14} />{fusionOpen ? "移除融合题材" : "融合题材"}</button>
            </div>
            <div className="director-preset__genres" role="group" aria-label="主类型">
              {catalog.genres.map(option => <button key={option.key} type="button" style={coverStyle(option)}
                aria-pressed={option.key === value.genreKey} onClick={() => patch({
                  genreKey: option.key, ...(option.key === value.fusionKey ? { fusionKey: "" } : {}),
                })}>{option.name}</button>)}
            </div>
            {genre?.freeInput ? <input aria-label="自定义主类型" value={value.customGenre}
              placeholder="输入其他题材类型…" onChange={event => patch({ customGenre: event.target.value })} /> : null}
            {fusionOpen ? <div className="director-preset__genres" role="group" aria-label="融合题材">
              {catalog.genres.filter(option => option.key !== value.genreKey).map(option => (
                <button key={option.key} type="button" style={coverStyle(option)} aria-pressed={option.key === value.fusionKey}
                  onClick={() => patch({ fusionKey: option.key })}>{option.name}</button>
              ))}
            </div> : null}
            {fusion?.freeInput ? <input aria-label="自定义融合题材" value={value.customFusion}
              placeholder="输入其他题材类型…" onChange={event => patch({ customFusion: event.target.value })} /> : null}
            <div className="director-preset__fields">
              {catalog.fields.map(item => {
                const names = item.options.filter(option => value.fields[item.fieldKey]?.includes(option.key))
                  .map(option => option.freeInput ? value.customStyle.trim() || option.name : option.name);
                return <button type="button" key={item.fieldKey} aria-expanded={item.fieldKey === fieldOpen}
                  onClick={() => { setFieldOpen(fieldOpen === item.fieldKey ? null : item.fieldKey); setQuery(""); }}>
                  <span>{item.name}</span><strong>{names.join("、") || "自动"}</strong>
                  <LibTVMediaIcon name="icon-chevron-down-small" size={14} />
                </button>;
              })}
            </div>
            {field ? <div className="director-preset__options">
              <div className="director-preset__line"><strong>{field.name}</strong><small>{field.maxSelect === 1 ? "单选" : `至多 ${field.maxSelect} 项`}</small></div>
              {field.options.length > 8 ? <input aria-label={`搜索${field.name}`} value={query}
                placeholder={`搜索${field.name}…`} onChange={event => setQuery(event.target.value)} /> : null}
              <div role="group" aria-label={field.name} className={field.variant === "image" ? "director-preset__style-options" : ""}>
                {visibleOptions.map(option => {
                  const selected = value.fields[field.fieldKey] ?? [];
                  const pressed = selected.includes(option.key);
                  return <button key={option.key} type="button" aria-pressed={pressed}
                    style={field.variant === "image" ? coverStyle(option) : undefined}
                    disabled={!pressed && field.maxSelect > 1 && selected.length >= field.maxSelect}
                    onClick={() => patch({ fields: { ...value.fields, [field.fieldKey]:
                      pressed ? selected.filter(key => key !== option.key) : field.maxSelect === 1 ? [option.key] : [...selected, option.key],
                    } })}>{option.name}</button>;
                })}
                {!visibleOptions.length ? <small>没有匹配的选项</small> : null}
              </div>
              {field.fieldKey === "visualStyle" && value.fields["visualStyle"]?.includes("custom") ? <div className="director-preset__custom">
                <input aria-label="自定义画风" placeholder="请输入你的想法…" value={value.customStyle}
                  onChange={event => patch({ customStyle: event.target.value })} />
                <button type="button" disabled={picking} onClick={() => void pickStyleImage()}>
                  <LibTVMediaIcon name="upload" size={16} />{value.styleImage?.displayName ?? "上传风格参考图"}
                </button>
                {value.styleImage ? <button type="button" onClick={() => patch({ styleImage: null })}>移除参考图</button> : null}
              </div> : null}
            </div> : null}
            <div className="director-preset__line">
              <label>集数 <input type="number" min={catalog.episodes.min} max={catalog.episodes.max} step={catalog.episodes.step}
                value={value.episodes} placeholder="自动" onChange={event => patch({ episodes: event.target.value })} /></label>
              <button type="button" aria-pressed={value.episodes === ""} onClick={() => patch({ episodes: "" })}>自动</button>
            </div>
            <div className="director-preset__structures" role="group" aria-label="剧本结构">
              <strong>{catalog.structure.name}</strong>
              <button type="button" aria-pressed={!value.structure} onClick={() => patch({ structure: "" })}>自动</button>
              {catalog.structure.options.map(option => <button key={option.key} type="button"
                aria-pressed={value.structure === option.key} onClick={() => patch({ structure: option.key })}>{option.name}</button>)}
            </div>
          </div>
          {error ? <p role="alert" className="director-preset__error">{error}</p> : null}
          <footer>
            <button type="button" role="switch" aria-checked={showHot} onClick={() => setShowHot(!showHot)}>展示爆款预设</button>
            <button type="button" className="director-preset__confirm" disabled={picking} onClick={confirm}>确定</button>
          </footer>
        </section>
      </div>
    </div>,
    document.body,
  );
}
