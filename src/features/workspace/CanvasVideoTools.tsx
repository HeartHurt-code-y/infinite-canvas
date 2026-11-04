import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { CanvasSelect } from "../../components/CanvasSelect";
import { useModalFocusTrap } from "../../components/useModalFocusTrap";
import type { PromptContentEditorSession } from "../../lib/promptContent";
import { useFloatingLayerAnchor } from "../create/useFloatingLayerAnchor";
import { type ConnectedAssetInput, type GenNodeData, type InheritedAssetInput } from "./workspaceModel";
import { LibTVMediaIcon } from "./LibTVMediaIcon";
import { CanvasReferenceTools } from "./CanvasReferenceTools";
import { VideoCameraPresetPanel } from "./VideoCameraPresetPanel";
import { CAMERA_PRESET_MARK_PREFIX, MAX_VIDEO_CAMERA_PRESETS, videoCameraPresetsMuted, hasVideoCameraPreset, VIDEO_CAMERA_EFFECT_CONFLICT } from "../../lib/videoCameraPresets";
import { VideoEffectTemplatePanel } from "./VideoEffectTemplatePanel";
import { MAX_VIDEO_EFFECTS, VIDEO_EFFECT_TEMPLATES } from "../../lib/videoEffectTemplates";

type VideoNode = Extract<GenNodeData, { kind: "video" }>;
type MediaInput = ConnectedAssetInput | InheritedAssetInput;

/**
 * 视频节点编辑层的创作工具。
 *
 * 「参考素材」（上传 / 画布参考）与图片节点共用 `CanvasReferenceTools`：
 * 那条链路不需要后端，图片节点曾经只有一个死路按钮，两类节点不该有差别。
 */
export function CanvasVideoTools({ node, active, inputs, sessionRef, onAnnotateVideo, onPromptChange, onEffectsChange, linkedEffects, onOpenCharacterStudio }: {
  readonly node: VideoNode;
  readonly active: boolean;
  readonly inputs: readonly MediaInput[];
  readonly sessionRef: RefObject<PromptContentEditorSession | null>;
  readonly onAnnotateVideo?: ((nodeKey: string, input: MediaInput) => void) | undefined;
  readonly onPromptChange: () => void;
  readonly onEffectsChange: (ids: readonly number[]) => void;
  readonly linkedEffects: readonly number[];
  readonly onOpenCharacterStudio: () => void;
}) {
  const [marking, setMarking] = useState(false);
  const [more, setMore] = useState(false);
  const [camera, setCamera] = useState(false);
  const [effects, setEffects] = useState(false);
  const [replacingEffect, setReplacingEffect] = useState<number | null>(null);
  const [effectHost, setEffectHost] = useState<HTMLElement | null>(null);
  const mode = node.config.videoMode ?? node.config.seedanceTaskMode;
  // LibTV 的 frames2video / videoEdit2video 不提供运镜、特效新入口。
  const cameraAvailable = !videoCameraPresetsMuted(mode);
  const hasCameraPreset = hasVideoCameraPreset(sessionRef.current?.snapshot());
  const selectedEffects = node.config.effectVersionIds ?? [];
  const usedEffects = new Set([...selectedEffects, ...linkedEffects]);
  const cameraUnavailable = usedEffects.size > 0 ? VIDEO_CAMERA_EFFECT_CONFLICT : null;
  const effectUnavailable = hasCameraPreset ? VIDEO_CAMERA_EFFECT_CONFLICT : !cameraAvailable ? "当前生成模式不支持添加特效"
    : mode === "longVideo2video" ? "超长视频暂不支持特效模板"
    : node.config.storyboard?.enabled ? "请先关闭智能分镜，再选择特效"
    : null;
  const closeEffects = useCallback(() => { setEffects(false); setReplacingEffect(null); }, []);
  const closeCamera = useCallback(() => setCamera(false), []);
  const moreTriggerRef = useRef<HTMLButtonElement>(null);
  const moreLayer = useFloatingLayerAnchor<HTMLDivElement>({ open: active && more, anchorRef: moreTriggerRef, minWidth: 220, maxHeight: 240, gap: 8, leftOffset: 0, preferAbove: true });
  const closeMarking = useCallback(() => setMarking(false), []);

  useEffect(() => {
    if (!cameraAvailable) { setCamera(false); setMore(false); }
    if (effectUnavailable) { setEffects(false); setReplacingEffect(null); }
    if (cameraUnavailable) setCamera(false);
  }, [cameraAvailable, effectUnavailable, cameraUnavailable]);

  useLayoutEffect(() => { setEffectHost(document.getElementById(`video-effects-${node.key}`)); }, [node.key]);

  useLayoutEffect(() => {
    if (active && more) moreLayer.ref.current?.focus({ preventScroll: true });
  }, [active, more, moreLayer.ref]);

  useEffect(() => {
    if (!active || !more) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !moreTriggerRef.current?.contains(event.target) && !moreLayer.ref.current?.contains(event.target)) setMore(false);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [active, more, moreLayer.ref]);

  return <>
    <CanvasReferenceTools node={node} active={active} />
    {onAnnotateVideo && inputs.some(input => input.kind === "video") ? <button type="button" className="canvas-gen-node__tool-chip" data-tooltip="标记参考视频中的区域" onClick={() => setMarking(true)}><LibTVMediaIcon name="mark" size={12} /><span>标记</span></button> : null}
    <button type="button" className="canvas-gen-node__tool-chip" aria-haspopup="dialog"
      onClick={onOpenCharacterStudio}><LibTVMediaIcon name="asset-character" size={13} /><span>角色库</span></button>
    {cameraAvailable ? <button ref={moreTriggerRef} type="button" className="canvas-gen-node__tool-chip" aria-expanded={more} onClick={() => setMore(value => !value)}><LibTVMediaIcon name="more-s" size={12} /><span>更多</span></button> : null}
    {active && more && cameraAvailable ? createPortal(<div ref={moreLayer.ref} className="canvas-video-tool-menu" role="dialog" aria-label="更多创作工具" tabIndex={-1} onKeyDown={event => { if (event.key === "Escape" && !event.defaultPrevented && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); event.stopPropagation(); setMore(false); moreTriggerRef.current?.focus(); } }}>
      {usedEffects.size < MAX_VIDEO_EFFECTS ? <button type="button" disabled={!!effectUnavailable} data-tooltip={effectUnavailable ?? undefined} onClick={() => { setMore(false); setReplacingEffect(null); setEffects(true); }}><LibTVMediaIcon name="camera" size={12} /><span>特效</span></button> : null}
      <button type="button" disabled={!!cameraUnavailable} data-tooltip={cameraUnavailable ?? undefined} onClick={() => { setMore(false); setCamera(true); }}><LibTVMediaIcon name="camera-video" size={12} /><span>运镜</span></button>
    </div>, document.body) : null}
    {effectHost ? createPortal(selectedEffects.map(id => {
      const template = VIDEO_EFFECT_TEMPLATES.find(item => item.versionId === id);
      const name = template?.name ?? "特效版本不可用";
      return <div key={id} className="canvas-video-effect-reference">
        <button type="button" className="canvas-video-effect-reference__preview" aria-label={`更换特效：${name}`} disabled={!!effectUnavailable} data-tooltip={effectUnavailable ?? name} onClick={() => { setReplacingEffect(id); setEffects(true); }}>
          {template ? <img src={template.image} alt="" /> : <LibTVMediaIcon name="video-gen" size={20} />}<span>特效</span>
        </button>
        <button type="button" className="canvas-video-effect-reference__remove" aria-label={`移除特效：${name}`} data-tooltip="移除特效" onClick={() => onEffectsChange(selectedEffects.filter(value => value !== id))}><LibTVMediaIcon name="close" size={12} /></button>
      </div>;
    }), effectHost) : null}
    {active && effects ? <VideoEffectTemplatePanel onClose={closeEffects} onSelect={template => {
      if (hasVideoCameraPreset(sessionRef.current?.snapshot())) throw new Error(VIDEO_CAMERA_EFFECT_CONFLICT);
      if (effectUnavailable) throw new Error(effectUnavailable);
      if (template.versionId === replacingEffect) { closeEffects(); return; }
      if (usedEffects.has(template.versionId)) throw new Error("这个特效已在当前节点中。");
      if (replacingEffect != null && selectedEffects.includes(replacingEffect)) {
        onEffectsChange(selectedEffects.map(id => id === replacingEffect ? template.versionId : id));
      } else {
        if (usedEffects.size >= MAX_VIDEO_EFFECTS) throw new Error("最多选择 6 个特效，请先移除不需要的特效。");
        onEffectsChange([...selectedEffects, template.versionId]);
      }
      closeEffects();
    }} /> : null}
    {active && camera && cameraAvailable && !cameraUnavailable ? <VideoCameraPresetPanel onClose={closeCamera} onInsert={preset => {
      if (usedEffects.size > 0) throw new Error(VIDEO_CAMERA_EFFECT_CONFLICT);
      const session = sessionRef.current;
      if (!session) throw new Error("提示词编辑器尚未就绪，请重新打开节点。");
      if (session.snapshot().items.filter(item => item.kind === "mark_reference" && item.markId.startsWith(CAMERA_PRESET_MARK_PREFIX)).length >= MAX_VIDEO_CAMERA_PRESETS) throw new Error("最多插入 6 个运镜，请先移除不需要的运镜。");
      session.insertMarkReference({ markId: `${CAMERA_PRESET_MARK_PREFIX}${crypto.randomUUID()}`, label: preset.tagLabel || preset.name, description: preset.prompt, color: "#09caf5" });
      onPromptChange();
      setCamera(false);
    }} /> : null}
    {active && marking && onAnnotateVideo ? <VideoReferenceMark inputs={inputs} onClose={closeMarking} onVideo={input => { setMarking(false); onAnnotateVideo(node.key, input); }} /> : null}
  </>;
}

/** 原站智能点选识别没有可调用的本地服务；仅保留已接入的视频逐帧编辑入口。 */
function VideoReferenceMark({ inputs, onClose, onVideo }: {
  readonly inputs: readonly MediaInput[];
  readonly onClose: () => void;
  readonly onVideo: (input: MediaInput) => void;
}) {
  const trap = useModalFocusTrap({ active: true, onEscape: onClose });
  const videos = inputs.filter(input => input.kind === "video");
  const [key, setKey] = useState(videos[0]?.key ?? "");
  const selected = videos.find(input => input.key === key) ?? videos[0];
  return createPortal(<div className="canvas-video-modal-scrim" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={trap.ref} {...trap.containerProps} className="canvas-video-modal" role="dialog" aria-modal="true" aria-label="标记参考视频" tabIndex={-1}>
      <header><strong>标记参考视频</strong><button type="button" aria-label="关闭视频标记" onClick={onClose}><LibTVMediaIcon name="close" size={16} /></button></header>
      {selected ? <><CanvasSelect ariaLabel="选择参考视频" value={selected.key} options={videos.map(input => ({ value: input.key, label: input.name }))} onChange={setKey} chevronIcon={<LibTVMediaIcon name="icon-chevron-down-small" size={12} />} selectedIcon={<LibTVMediaIcon name="check" size={12} />} />
        <button type="button" onClick={() => onVideo(selected)}>打开视频逐帧标记</button></> : <p>请先连接参考视频。</p>}
    </div>
  </div>, document.body);
}
