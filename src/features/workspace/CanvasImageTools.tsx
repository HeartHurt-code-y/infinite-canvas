import { useCallback, useContext, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { ProviderCatalogEntry } from "../../lib/backend";
import { modelParameterCapabilities } from "../../lib/modelCapabilities";
import type { PromptContentEditorSession } from "../../lib/promptContent";
import { LibTVMediaIcon } from "./LibTVMediaIcon";
import { CanvasReferenceTools } from "./CanvasReferenceTools";
import { CanvasImageStyleMarket } from "./CanvasImageStyleMarket";
import { CanvasImageTranslation } from "./CanvasImageTranslation";
import { CanvasImagePresetMenu } from "./CanvasImagePresetMenu";
import { CanvasCameraControl } from "./CanvasCameraControl";
import { CanvasImageMarkingContext } from "./CanvasImageMarking";
import type { ConnectedAssetInput, GenNodeData, ImageNodeConfig, InheritedAssetInput } from "./workspaceModel";
import "./CanvasImageEditor.css";

type ImageNode = Extract<GenNodeData, { kind: "image" }>;

export function CanvasImageTools({ canvasId, node, active, inputs, sessionRef, presetTriggerRef, cameraTriggerRef, cameraOpenRequestId, providerCatalog, onChange, linkedStyle }: {
  readonly canvasId: string;
  readonly node: ImageNode;
  readonly active: boolean;
  readonly inputs: readonly (ConnectedAssetInput | InheritedAssetInput)[];
  readonly linkedStyle: boolean;
  readonly sessionRef: RefObject<PromptContentEditorSession | null>;
  readonly presetTriggerRef: RefObject<HTMLButtonElement | null>;
  readonly cameraTriggerRef: RefObject<HTMLButtonElement | null>;
  readonly cameraOpenRequestId: number;
  readonly providerCatalog: readonly ProviderCatalogEntry[];
  readonly onChange: (config: ImageNodeConfig) => void;
}) {
  const [stylesOpen, setStylesOpen] = useState(false);
  const marking = useContext(CanvasImageMarkingContext);
  const markButton = useRef<HTMLButtonElement>(null);
  const upscale = node.config.imageMode === "upscale";
  const closeStyles = useCallback(() => setStylesOpen(false), []);
  const [translating, setTranslating] = useState(false);
  const [footer, setFooter] = useState<HTMLElement | null>(null);
  const [translationHost, setTranslationHost] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => { setFooter(document.getElementById(`image-tools-${node.key}`)); }, [node.key]);
  useLayoutEffect(() => { setTranslationHost(document.getElementById(`image-translation-${node.key}`)); }, [node.key]);
  const closeTranslation = useCallback(() => setTranslating(false), []);
  const getPresetCapabilities = () => {
    const selectedModel = providerCatalog.find(entry => entry.provider.id === node.config.modelSelection.providerId)?.models.find(model => model.definitionId === node.config.modelSelection.modelDefinitionId);
    const hasPromptImage = sessionRef.current?.snapshot().items.some(item => item.kind === "media_reference"
      ? item.target.mediaType === "image" : item.kind === "attachment" && item.mediaType === "image") ?? false;
    return selectedModel ? modelParameterCapabilities(selectedModel.operationSchema,
      linkedStyle || node.config.styleReference != null || hasPromptImage || inputs.some(input => input.kind === "image" || input.kind === "video") ? "image_to_image" : "text_to_image", selectedModel.remoteModelId) : [];
  };
  useLayoutEffect(() => {
    if (!active || upscale || !marking) return;
    marking.register({ targetKey: node.key, sessionRef, restoreFocus: () => markButton.current?.focus({ preventScroll: true }) });
    return () => marking.register(null);
  }, [active, upscale, node.key, sessionRef, marking?.register]);
  return <>
    <CanvasReferenceTools node={node} active={active} />
    {!upscale ? <>
      <button ref={markButton} type="button" className="canvas-gen-node__tool-chip" aria-label="标记" aria-pressed={marking?.targetKey === node.key}
        onClick={() => { if (marking?.targetKey === node.key) marking.stop(); else marking?.start(); }}><LibTVMediaIcon name="mark" size={12} /><span>标记</span></button>
      <button type="button" className="canvas-gen-node__tool-chip" aria-pressed={linkedStyle || node.config.styleReference != null}
        disabled={linkedStyle} data-tooltip={linkedStyle ? "通过画布上的风格素材卡更换风格" : undefined}
        onClick={() => setStylesOpen(true)}><LibTVMediaIcon name="style" size={12} /><span>风格</span></button>
    </> : null}
    {footer && !upscale ? createPortal(<>
      <CanvasImagePresetMenu config={node.config} active={active} getCapabilities={getPresetCapabilities} triggerRef={presetTriggerRef} onChange={onChange} />
      <CanvasCameraControl config={node.config} active={active} triggerRef={cameraTriggerRef} openRequestId={cameraOpenRequestId} onChange={onChange} />
    </>, footer) : null}
    {translationHost && !upscale ? createPortal(<button type="button" aria-label="翻译提示词" data-tooltip="翻译提示词" onClick={() => setTranslating(true)}><LibTVMediaIcon name="translate" size={16} /></button>, translationHost) : null}
    {active && !upscale && stylesOpen ? <CanvasImageStyleMarket selected={node.config.styleReference} onSelect={styleReference => onChange({ ...node.config, styleReference })} onClose={closeStyles} /> : null}
    {active && !upscale && translating ? <CanvasImageTranslation canvasId={canvasId} node={node} sessionRef={sessionRef} providerCatalog={providerCatalog} onChange={onChange} onClose={closeTranslation} /> : null}
  </>;
}

