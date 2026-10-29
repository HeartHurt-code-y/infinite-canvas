import { useCallback, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ErrorAlert } from "../../components/ErrorAlert";
import { CanvasSelect } from "../../components/CanvasSelect";
import { useModalFocusTrap } from "../../components/useModalFocusTrap";
import { backendErrorMessage, type ProviderCatalogEntry } from "../../lib/backend";
import { canvasImageClient, type CanvasImagePreset } from "../../lib/canvasImage";
import { modelParameterCapabilities, resolvedParameterValue } from "../../lib/modelCapabilities";
import type { PromptContentEditorSession } from "../../lib/promptContent";
import { CanvasChromeIcon } from "./CanvasChromeIcons";
import { CanvasReferenceTools } from "./CanvasReferenceTools";
import { CanvasReferenceMark } from "./CanvasVideoTools";
import { CanvasImageTranslation } from "./CanvasImageTranslation";
import { CanvasImagePresetMenu } from "./CanvasImagePresetMenu";
import { CanvasCameraControl } from "./CanvasCameraControl";
import type { ConnectedAssetInput, GenNodeData, ImageNodeConfig, InheritedAssetInput } from "./workspaceModel";
import "./CanvasImageEditor.css";

type ImageNode = Extract<GenNodeData, { kind: "image" }>;
const PRESET_QUERY_KEY = ["canvas-image-presets"] as const;

export function CanvasImageTools({ canvasId, node, active, inputs, sessionRef, presetTriggerRef, cameraTriggerRef, cameraOpenRequestId, providerCatalog, onChange }: {
  readonly canvasId: string;
  readonly node: ImageNode;
  readonly active: boolean;
  readonly inputs: readonly (ConnectedAssetInput | InheritedAssetInput)[];
  readonly sessionRef: RefObject<PromptContentEditorSession | null>;
  readonly presetTriggerRef: RefObject<HTMLButtonElement | null>;
  readonly cameraTriggerRef: RefObject<HTMLButtonElement | null>;
  readonly cameraOpenRequestId: number;
  readonly providerCatalog: readonly ProviderCatalogEntry[];
  readonly onChange: (config: ImageNodeConfig) => void;
}) {
  const [marking, setMarking] = useState(false);
  const [library, setLibrary] = useState<"style" | "prompt" | null>(null);
  const [translating, setTranslating] = useState(false);
  const [footer, setFooter] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => { setFooter(document.getElementById(`image-tools-${node.key}`)); }, [node.key]);
  const closeMark = useCallback(() => setMarking(false), []);
  const closeLibrary = useCallback(() => setLibrary(null), []);
  const closeTranslation = useCallback(() => setTranslating(false), []);
  const getPresetCapabilities = () => {
    const selectedModel = providerCatalog.find(entry => entry.provider.id === node.config.modelSelection.providerId)?.models.find(model => model.definitionId === node.config.modelSelection.modelDefinitionId);
    const hasPromptImage = sessionRef.current?.snapshot().items.some(item => item.kind === "media_reference"
      ? item.target.mediaType === "image" : item.kind === "attachment" && item.mediaType === "image") ?? false;
    return selectedModel ? modelParameterCapabilities(selectedModel.operationSchema,
      hasPromptImage || inputs.some(input => input.kind === "image" || input.kind === "video") ? "image_to_image" : "text_to_image", selectedModel.remoteModelId) : [];
  };
  return <>
    <CanvasReferenceTools node={node} active={active} />
    <button type="button" className="canvas-gen-node__tool-chip" onClick={() => setMarking(true)}><CanvasChromeIcon name="crosshair" size={12} /><span>标记</span></button>
    <button type="button" className="canvas-gen-node__tool-chip" aria-pressed={Boolean(node.config.style)} data-tooltip={node.config.style ? `当前风格：${node.config.style.name}` : "选择图片风格"} onClick={() => setLibrary("style")}><CanvasChromeIcon name="titlecard" size={12} /><span>风格</span></button>
    {footer ? createPortal(<>
      <CanvasImagePresetMenu config={node.config} active={active} getCapabilities={getPresetCapabilities} triggerRef={presetTriggerRef} onChange={onChange} />
      <CanvasCameraControl config={node.config} active={active} triggerRef={cameraTriggerRef} openRequestId={cameraOpenRequestId} onChange={onChange} />
      <button type="button" aria-label="翻译提示词" data-tooltip="翻译提示词" onClick={() => setTranslating(true)}><span aria-hidden="true">文A</span></button>
    </>, footer) : null}
    {active && marking ? <CanvasReferenceMark inputs={inputs} sessionRef={sessionRef} onClose={closeMark} /> : null}
    {active && library ? <ImagePresetLibrary key={library} kind={library} onKindChange={setLibrary} node={node} inputs={inputs} sessionRef={sessionRef} providerCatalog={providerCatalog} onChange={onChange} onClose={closeLibrary} /> : null}
    {active && translating ? <CanvasImageTranslation canvasId={canvasId} node={node} sessionRef={sessionRef} providerCatalog={providerCatalog} onChange={onChange} onClose={closeTranslation} /> : null}
  </>;
}

function ImagePresetLibrary({ kind, onKindChange, node, inputs, sessionRef, providerCatalog, onChange, onClose }: {
  readonly kind: "style" | "prompt";
  readonly onKindChange: (kind: "style" | "prompt") => void;
  readonly node: ImageNode;
  readonly inputs: readonly (ConnectedAssetInput | InheritedAssetInput)[];
  readonly sessionRef: RefObject<PromptContentEditorSession | null>;
  readonly providerCatalog: readonly ProviderCatalogEntry[];
  readonly onChange: (config: ImageNodeConfig) => void;
  readonly onClose: () => void;
}) {
  const trap = useModalFocusTrap({ active: true, onEscape: onClose });
  const id = useId();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: PRESET_QUERY_KEY, queryFn: canvasImageClient.listPresets });
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<CanvasImagePreset | null>(null);
  const [name, setName] = useState(kind === "style" ? node.config.style?.name ?? "" : "");
  const [text, setText] = useState(kind === "style" ? node.config.style?.prompt ?? "" : sessionRef.current?.read().plainText ?? "");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<unknown>(null);
  const selectedModel = providerCatalog.find(entry => entry.provider.id === node.config.modelSelection.providerId)?.models.find(model => model.definitionId === node.config.modelSelection.modelDefinitionId);
  const capabilities = selectedModel ? modelParameterCapabilities(selectedModel.operationSchema, inputs.some(input => input.kind === "image" || input.kind === "video") || (node.config.imageMode && node.config.imageMode !== "auto") ? "image_to_image" : "text_to_image", selectedModel.remoteModelId) : [];
  const styleCapability = capabilities.find(capability => /^(style|style_preset|image_style)$/u.test(capability.key) && capability.options.length > 0);
  const perform = async (action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try { await action(); } catch (failure) { setError(failure); } finally { busyRef.current = false; setBusy(false); }
  };
  const apply = (presetName: string, presetText: string) => {
    if (kind === "style") onChange({ ...node.config, style: { name: presetName, prompt: presetText } });
    else {
      const session = sessionRef.current;
      if (!session) { setError("提示词编辑器尚未就绪，请关闭面板后重新打开。"); return; }
      session.pastePlainText(`${session.read().plainText ? "\n" : ""}${presetText}`);
    }
    onClose();
  };
  return createPortal(<div className="canvas-video-modal-scrim"><div ref={trap.ref} {...trap.containerProps} className="canvas-video-modal" role="dialog" aria-modal="true" aria-label={kind === "style" ? "图片风格" : "图片提示词预设"} tabIndex={-1}>
    <header><strong>{kind === "style" ? "风格" : "预设"}</strong><button type="button" onClick={onClose}>关闭</button></header>
    <div className="canvas-image-library-tabs" role="group" aria-label="个人预设类型"><button type="button" aria-pressed={kind === "style"} onClick={() => onKindChange("style")}>图片风格</button><button type="button" aria-pressed={kind === "prompt"} onClick={() => onKindChange("prompt")}>个人文字预设</button></div>
    {kind === "style" ? <>
      {styleCapability ? <label>模型风格<CanvasSelect ariaLabel="模型风格" value={String(resolvedParameterValue(styleCapability, node.config.parameterValues))} options={styleCapability.options.map(option => ({ value: String(option.value), label: option.label }))} onChange={value => {
        const option = styleCapability.options.find(option => String(option.value) === value);
        if (option) onChange({ ...node.config, parameterValues: { ...node.config.parameterValues, [styleCapability.key]: option.value } });
      }} /></label> : <p>当前模型未声明风格参数，可以使用下方的个人风格描述。</p>}
      {node.config.style ? <div><span>已选择：{node.config.style.name}</span><button type="button" onClick={() => onChange({ ...node.config, style: undefined })}>清除个人风格</button></div> : null}
      <small>个人风格会在提交时追加到提示词，随任务冻结。模型风格通过供应商的实际参数提交。</small>
    </> : <small>预设保存文字内容；插入时保留当前提示词、附件和 @ 引用。</small>}
    <label>搜索<input value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索个人预设" /></label>
    {query.isPending ? <p role="status">正在读取预设…</p> : null}
    {query.error ? <><ErrorAlert error={query.error} hint="个人预设保存在本机，请重新读取。" /><button type="button" onClick={() => { void query.refetch(); }}>重新读取</button></> : null}
    <div className="canvas-image-preset-grid">{query.data?.filter(preset => preset.kind === kind && `${preset.name}\n${preset.text}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map(preset => <article key={preset.id}>
      <strong>{preset.name}</strong><p>{preset.text}</p><footer>
        <button type="button" onClick={() => apply(preset.name, preset.text)}>使用</button>
        <button type="button" onClick={() => { setEditing(preset); setName(preset.name); setText(preset.text); }}>编辑</button>
        <button type="button" disabled={busy} onClick={() => { void perform(async () => {
          await canvasImageClient.deletePreset(preset.id);
          await queryClient.invalidateQueries({ queryKey: PRESET_QUERY_KEY });
          if (editing?.id === preset.id) { setEditing(null); setName(""); setText(""); }
        }); }}>删除</button>
      </footer>
    </article>)}</div>
    {query.data && !query.data.some(preset => preset.kind === kind) ? <p>还没有个人{kind === "style" ? "风格" : "预设"}，在下方保存一份即可复用。</p> : null}
    <form className="canvas-image-preset-form" onSubmit={event => { event.preventDefault(); void perform(async () => {
      const saved = await canvasImageClient.savePreset({ ...(editing ? { id: editing.id } : {}), kind, name, text });
      await queryClient.invalidateQueries({ queryKey: PRESET_QUERY_KEY });
      setEditing(saved);
    }); }}>
      <strong>{editing ? "编辑个人预设" : "新建个人预设"}</strong>
      <label>名称<input maxLength={100} required value={name} onChange={event => setName(event.target.value)} /></label>
      <label>内容<textarea maxLength={10000} required value={text} onChange={event => setText(event.target.value)} aria-describedby={error ? `${id}-error` : undefined} /></label>
      <div><button type="submit" disabled={busy || !name.trim() || !text.trim()}>{busy ? "保存中…" : "保存到个人预设"}</button>
        <button type="button" disabled={!name.trim() || !text.trim()} onClick={() => apply(name.trim(), text.trim())}>使用当前内容</button>
        {editing ? <button type="button" onClick={() => { setEditing(null); setName(""); setText(""); }}>取消编辑</button> : null}
      </div>
    </form>
    {error ? <ErrorAlert id={`${id}-error`} error={error} hint={`检查名称、内容与本机存储后重试。${backendErrorMessage(error).includes("不存在") ? "请重新读取预设。" : ""}`} /> : null}
  </div></div>, document.body);
}
