import { useEffect, useId, useRef, useState } from "react";
import { CanvasSelect } from "../../components/CanvasSelect";
import { LibTVMediaIcon } from "./LibTVMediaIcon";
import { parseDirectorLayout, type DirectorImageModel, type DirectorImageRequest, type DirectorImportMode } from "./directorSceneImport";
import type { DirectorScene } from "./directorScene";

export interface DirectorReference {
  readonly key: string;
  readonly name: string;
  readonly previewUrl: string | null;
}

type ModelOption = DirectorImageModel & { readonly label: string };
const modelValue = (model: DirectorImageModel) => JSON.stringify([model.providerId, model.modelDefinitionId]);

export function CanvasDirectorImport({ initialTab, references, models, defaultModel, busy, generationError, onPick, onRecognize, onImport, onClose }: {
  readonly initialTab: "image" | "json";
  readonly references: readonly DirectorReference[];
  readonly models: readonly ModelOption[];
  readonly defaultModel: DirectorImageModel;
  readonly busy: boolean;
  readonly generationError: string | null;
  readonly onPick: () => void;
  readonly onRecognize: (request: DirectorImageRequest) => void;
  readonly onImport: (scene: DirectorScene, mode: DirectorImportMode) => void;
  readonly onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const [tab, setTab] = useState(initialTab);
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<DirectorImportMode>("insert");
  const [charactersOnly, setCharactersOnly] = useState(false);
  const [json, setJson] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [modelKey, setModelKey] = useState(modelValue(defaultModel));
  const reference = references.find(item => item.key === selected) ?? references[0];
  const model = models.find(item => modelValue(item) === modelKey) ?? models[0];

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  function applyJson() {
    try {
      onImport(parseDirectorLayout(json, "json"), mode);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "无法导入场景。");
    }
  }

  async function readJson(file: File) {
    if (file.size > 400000) { setError("请选择小于 400 KB 的场景 JSON。"); return; }
    try { setJson(await file.text()); setError(null); }
    catch { setError("JSON 文件读取失败，请重试。"); }
  }

  return <dialog ref={dialog} className="canvas-director-import" aria-labelledby={title} onCancel={event => {
    event.preventDefault();
    event.stopPropagation();
    onClose();
  }}>
    <header>
      <h2 id={title}>AI 识图导入</h2>
      <button type="button" aria-label="关闭识图导入" onClick={onClose}><LibTVMediaIcon name="close" size={17} /></button>
    </header>
    <div className="canvas-director-import__body">
      <div className="canvas-director-editor__tabs" aria-label="导入来源">
        <button type="button" aria-pressed={tab === "image"} disabled={busy} onClick={() => { setTab("image"); setError(null); }}>AI 识图</button>
        <button type="button" aria-pressed={tab === "json"} disabled={busy} onClick={() => { setTab("json"); setError(null); }}>粘贴 JSON</button>
      </div>
      {tab === "image" ? <>
        <button type="button" className="canvas-director-import__preview" disabled={busy} onClick={onPick}
          aria-label={reference ? "更换参考图" : "选择参考图"}>
          {reference?.previewUrl ? <img src={reference.previewUrl} alt={reference.name} />
            : <><LibTVMediaIcon name="plus-s" size={20} />{reference?.name ?? "选择参考图"}</>}
        </button>
        <div className="canvas-director-editor__row">
          <button type="button" disabled={busy} onClick={onPick}>
            <LibTVMediaIcon name="plus-s" size={14} />{reference ? "添加或更换参考图" : "上传或从素材库选择"}
          </button>
        </div>
        {references.length > 1 ? <div className="canvas-director-import__references" aria-label="画布已连接的参考图">
          {references.map(item => <button type="button" key={item.key} disabled={busy} aria-pressed={reference?.key === item.key}
            aria-label={`选择 ${item.name}`} data-tooltip={item.name} onClick={() => setSelected(item.key)}>
            {item.previewUrl ? <img src={item.previewUrl} alt="" /> : <LibTVMediaIcon name="plus-s" size={16} />}
          </button>)}
        </div> : null}
        <label className="canvas-director-editor__row">
          <input type="checkbox" disabled={busy} checked={charactersOnly} onChange={event => setCharactersOnly(event.target.checked)} />
          仅识别人物
        </label>
        {models.length ? <CanvasSelect ariaLabel="识图模型" value={model ? modelValue(model) : ""}
          options={models.map(item => ({ value: modelValue(item), label: item.label }))} disabled={busy} onChange={setModelKey} />
          : <small>请先在全局设置中配置支持图片输入的文本模型。</small>}
        <small>识别结果为可编辑的站位和素体姿势。请选择支持图片输入的模型，费用按所选供应商计算。</small>
      </> : <>
        <textarea aria-label="场景 JSON" placeholder="粘贴包含 characters、props、cameras 的场景 JSON"
          value={json} maxLength={400000} onChange={event => { setJson(event.target.value); setError(null); }} />
        <label className="canvas-director-editor__file">选择 JSON 文件
          <input type="file" className="sr-only" accept=".json,application/json" aria-label="选择 JSON 文件" onChange={event => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file) void readJson(file);
          }} />
        </label>
      </>}
      <fieldset className="canvas-director-import__choices" disabled={busy}>
        <legend>导入方式</legend>
        <label><input type="radio" name={title} checked={mode === "insert"} onChange={() => setMode("insert")} />
          <span>插入当前导演台<small>保留现有对象和时间轴</small></span></label>
        <label><input type="radio" name={title} checked={mode === "replace"} onChange={() => setMode("replace")} />
          <span>覆盖当前导演台<small>以导入的场景替换当前布局</small></span></label>
      </fieldset>
      {error || (tab === "image" && generationError) ? <p role="alert">{error ?? generationError}</p> : null}
    </div>
    <footer>
      <button type="button" onClick={onClose}>{busy ? "返回场景" : "取消"}</button>
      {tab === "json" ? <button className="canvas-director-import__primary" type="button" disabled={!json.trim()} onClick={applyJson}>导入 JSON</button>
        : <button className="canvas-director-import__primary" type="button" disabled={!reference || !model || busy} onClick={() => {
          if (reference && model) onRecognize({ referenceKey: reference.key, mode, charactersOnly, model });
        }}>{busy ? "识图中…" : "识图导入场景"}</button>}
    </footer>
  </dialog>;
}
