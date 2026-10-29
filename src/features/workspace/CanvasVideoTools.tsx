import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { ErrorAlert } from "../../components/ErrorAlert";
import { CanvasSelect } from "../../components/CanvasSelect";
import { useModalFocusTrap } from "../../components/useModalFocusTrap";
import { backendErrorMessage, pickLocalMediaFiles, toMediaSrc } from "../../lib/backend";
import { listBrandModels, saveBrandModelVersion, approveBrandModelVersion, validateBrandModelVersion, selectBrandModelVersion, type BrandModelProfile, type BrandModelVersion } from "../../lib/brandModels";
import type { PromptContentEditorSession } from "../../lib/promptContent";
import { useFloatingLayerAnchor } from "../create/useFloatingLayerAnchor";
import { generationInputMentionCandidate, type ConnectedAssetInput, type GenNodeData, type InheritedAssetInput } from "./workspaceModel";
import { CanvasChromeIcon } from "./CanvasChromeIcons";
import { CanvasReferenceTools, type CanvasReferenceToolsHandle } from "./CanvasReferenceTools";

type VideoNode = Extract<GenNodeData, { kind: "video" }>;
type MediaInput = ConnectedAssetInput | InheritedAssetInput;

/**
 * 视频节点编辑层的创作工具。
 *
 * 「参考素材」（上传 / 画布参考）与图片节点共用 `CanvasReferenceTools`：
 * 那条链路不需要后端，图片节点曾经只有一个死路按钮，两类节点不该有差别。
 */
export function CanvasVideoTools({ node, active, inputs, sessionRef, onAnnotateVideo }: {
  readonly node: VideoNode;
  readonly active: boolean;
  readonly inputs: readonly MediaInput[];
  readonly sessionRef: RefObject<PromptContentEditorSession | null>;
  readonly onAnnotateVideo?: ((nodeKey: string, input: MediaInput) => void) | undefined;
}) {
  const [characters, setCharacters] = useState(false);
  const [marking, setMarking] = useState(false);
  const [more, setMore] = useState(false);
  const moreTriggerRef = useRef<HTMLButtonElement>(null);
  const moreLayer = useFloatingLayerAnchor<HTMLDivElement>({ open: active && more, anchorRef: moreTriggerRef, minWidth: 220, maxHeight: 240, gap: 8, leftOffset: 0, preferAbove: true });
  const referenceRef = useRef<CanvasReferenceToolsHandle>(null);
  const closeCharacters = useCallback(() => setCharacters(false), []);
  const closeMarking = useCallback(() => setMarking(false), []);

  useEffect(() => {
    if (!active || !more) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !moreTriggerRef.current?.contains(event.target) && !moreLayer.ref.current?.contains(event.target)) setMore(false);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [active, more, moreLayer.ref]);

  const useCharacter = async (profile: BrandModelProfile, version: BrandModelVersion) => {
    const checked = await validateBrandModelVersion({ profileId: profile.id, versionId: version.id, expectedSignature: version.signature });
    const selection = selectBrandModelVersion(profile, checked);
    const added = await referenceRef.current?.addFiles(selection.references.map(reference => reference.path));
    if (!added) throw new Error("角色参考图没有完整接入，请检查素材后重新选择角色。");
    sessionRef.current?.pastePlainText(`\n角色「${selection.name}」：${selection.description}。保持一致：${selection.invariants}。`);
    setCharacters(false);
  };

  return <>
    <CanvasReferenceTools ref={referenceRef} node={node} active={active} />
    <button type="button" className="canvas-gen-node__tool-chip" onClick={() => setMarking(true)}><CanvasChromeIcon name="crosshair" size={12} /><span>标记</span></button>
    <button type="button" className="canvas-gen-node__tool-chip" onClick={() => setCharacters(true)}><CanvasChromeIcon name="member" size={12} /><span>角色库</span></button>
    <button ref={moreTriggerRef} type="button" className="canvas-gen-node__tool-chip" aria-expanded={more} onClick={() => setMore(value => !value)}><span>⋯ 更多</span></button>
    {active && more ? createPortal(<div ref={moreLayer.ref} className="canvas-video-tool-menu" role="dialog" aria-label="更多创作工具" onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setMore(false); moreTriggerRef.current?.focus(); } }}>
      <button type="button" onClick={() => { setMore(false); setMarking(true); }}>标记</button>
      <button type="button" onClick={() => { setMore(false); setCharacters(true); }}>角色库</button>
      <button type="button" disabled title="后端暂未接入">特效 <small>后端暂未接入</small></button>
      <button type="button" disabled title="后端暂未接入">运镜 <small>后端暂未接入</small></button>
    </div>, document.body) : null}
    {active && characters ? <CharacterLibrary onClose={closeCharacters} onUse={useCharacter} /> : null}
    {active && marking ? <CanvasReferenceMark inputs={inputs} sessionRef={sessionRef} onClose={closeMarking} onVideo={onAnnotateVideo ? input => { setMarking(false); onAnnotateVideo(node.key, input); } : undefined} /> : null}
  </>;
}

function CharacterLibrary({ onClose, onUse }: { readonly onClose: () => void; readonly onUse: (profile: BrandModelProfile, version: BrandModelVersion) => Promise<void> }) {
  const trap = useModalFocusTrap({ active: true, onEscape: onClose });
  const query = useQuery({ queryKey: ["canvas-video-characters"], queryFn: listBrandModels });
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [invariants, setInvariants] = useState("");
  const [referencePath, setReferencePath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const perform = async (action: () => Promise<void>) => { if (busy) return; setBusy(true); setError(null); try { await action(); } catch (failure) { setError(backendErrorMessage(failure)); } finally { setBusy(false); } };
  return createPortal(<div className="canvas-video-modal-scrim"><div ref={trap.ref} className="canvas-video-modal" role="dialog" aria-modal="true" aria-label="角色库" tabIndex={-1}>
    <header><strong>角色库</strong><button type="button" onClick={onClose}>关闭</button></header>
    {query.isPending ? <p role="status">正在读取角色库…</p> : null}
    {query.error ? <ErrorAlert error={query.error} hint="检查本地角色库后重新读取。" /> : null}
    <div className="canvas-video-characters">{query.data?.filter(profile => !profile.archived).map(profile => { const version = profile.versions.find(item => item.id === profile.currentVersionId && item.status === "approved"); return <article key={profile.id}>
      {version?.references[0] ? <img alt={profile.name} src={toMediaSrc(version.references[0].path)} /> : null}<div><strong>{profile.name}</strong><p>{version?.description ?? "尚无已确认版本"}</p></div><button type="button" disabled={!version || busy} onClick={() => { if (version) void perform(() => onUse(profile, version)); }}>使用角色</button>
    </article>; })}</div>
    {query.data?.length === 0 ? <p>还没有角色。创建角色后，可在不同视频中复用同一版本的参考图与身份特征。</p> : null}
    <button type="button" onClick={() => setCreating(value => !value)}>创建角色</button>
    {creating ? <form className="canvas-video-character-form" onSubmit={event => { event.preventDefault(); void perform(async () => {
      const profile = await saveBrandModelVersion({ brandName: "画布角色库", name, description, invariants, references: [{ sourcePath: referencePath, label: name, role: "front" }] });
      const version = profile.versions.at(-1);
      if (!version) throw new Error("角色保存后没有返回版本，请重新读取角色库。");
      await approveBrandModelVersion({ profileId: profile.id, versionId: version.id, expectedSignature: version.signature });
      await query.refetch(); setCreating(false);
    }); }}>
      <label>角色名称<input required value={name} onChange={event => setName(event.target.value)} /></label>
      <label>外观描述<textarea required value={description} onChange={event => setDescription(event.target.value)} /></label>
      <label>应保持一致的特征<textarea required value={invariants} onChange={event => setInvariants(event.target.value)} /></label>
      <button type="button" onClick={() => { void perform(async () => { const paths = await pickLocalMediaFiles(); if (paths[0]) setReferencePath(paths[0]); }); }}>选择角色参考图</button><small>{referencePath || "选择一张已保存到本机的图片"}</small>
      <button type="submit" disabled={busy || !referencePath}>创建并确认版本</button>
    </form> : null}
    {error ? <ErrorAlert error={error} hint="检查角色资料或参考图后重试。" /> : null}
  </div></div>, document.body);
}

export function CanvasReferenceMark({ inputs, sessionRef, onClose, onVideo }: { readonly inputs: readonly MediaInput[]; readonly sessionRef: RefObject<PromptContentEditorSession | null>; readonly onClose: () => void; readonly onVideo?: ((input: MediaInput) => void) | undefined }) {
  const trap = useModalFocusTrap({ active: true, onEscape: onClose });
  const [key, setKey] = useState(inputs.find(input => input.kind === "image")?.key ?? inputs[0]?.key ?? "");
  const selected = inputs.find(input => input.key === key);
  const [start, setStart] = useState<{ x: number; y: number } | null>(null);
  const [end, setEnd] = useState<{ x: number; y: number } | null>(null);
  const [label, setLabel] = useState("");
  const hasBox = start && end && Math.abs(start.x - end.x) > .01 && Math.abs(start.y - end.y) > .01;
  const point = (event: React.PointerEvent<HTMLElement>) => { const rect = event.currentTarget.getBoundingClientRect(); return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) }; };
  return createPortal(<div className="canvas-video-modal-scrim"><div ref={trap.ref} className="canvas-video-modal" role="dialog" aria-modal="true" aria-label="标记参考素材" tabIndex={-1}>
    <header><strong>标记</strong><button type="button" onClick={onClose}>关闭</button></header>
    {inputs.length ? <><CanvasSelect ariaLabel="选择标记素材" value={key} options={inputs.filter(input => input.kind === "image" || input.kind === "video").map(input => ({ value: input.key, label: input.name }))} onChange={value => { setKey(value); setStart(null); setEnd(null); }} />
      {selected?.kind === "video" ? <button type="button" disabled={!onVideo} onClick={() => onVideo?.(selected)}>打开视频逐帧标记</button> : selected?.previewUrl ? <div className="canvas-video-mark-image" onPointerDown={event => { if (event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); setStart(point(event)); setEnd(point(event)); }} onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) setEnd(point(event)); }} onPointerUp={event => { if (!event.currentTarget.hasPointerCapture(event.pointerId)) return; setEnd(point(event)); event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { setStart(null); setEnd(null); }}>
        <img alt={selected.name} draggable={false} src={selected.previewUrl} /><svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">{start && end ? <rect x={Math.min(start.x, end.x) * 100} y={Math.min(start.y, end.y) * 100} width={Math.abs(start.x - end.x) * 100} height={Math.abs(start.y - end.y) * 100} /> : null}</svg>
      </div> : <p>这份素材没有可读取的图片预览，请更换素材。</p>}
      {selected?.kind === "image" ? <fieldset className="canvas-image-mark-fields"><legend>标记区域（百分比，可拖动画框或用键盘输入）</legend>{(["left", "top", "width", "height"] as const).map((field, index) => {
        const left = Math.min(start?.x ?? 0, end?.x ?? 1);
        const top = Math.min(start?.y ?? 0, end?.y ?? 1);
        const width = Math.abs((end?.x ?? 1) - (start?.x ?? 0));
        const height = Math.abs((end?.y ?? 1) - (start?.y ?? 0));
        const value = { left, top, width, height }[field];
        return <label key={field}>{["左", "上", "宽", "高"][index]}<input type="number" min={0} max={100} step={1} value={Math.round(value * 100)} onChange={event => {
          if (!event.target.value.trim()) return;
          const next = Number(event.target.value) / 100;
          if (!Number.isFinite(next)) return;
          const rect = { left, top, width, height, [field]: Math.max(0, Math.min(1, next)) };
          setStart({ x: rect.left, y: rect.top });
          setEnd({ x: Math.min(1, rect.left + rect.width), y: Math.min(1, rect.top + rect.height) });
        }} /></label>;
      })}</fieldset> : null}
      <label>标记内容<input value={label} placeholder="例如：左边人物的外套" onChange={event => setLabel(event.target.value)} /></label>
      <button type="button" disabled={!hasBox || !label.trim() || !selected?.target} onClick={() => {
        if (!selected?.target || !start || !end) return;
        const session = sessionRef.current;
        if (!session) return;
        session.insertReference(generationInputMentionCandidate({ key: selected.key, name: selected.name, kind: selected.kind, target: selected.target, previewUrl: selected.previewUrl }));
        session.insertMarkReference({ markId: crypto.randomUUID(), label: label.trim(), description: `参考图归一化区域：左 ${Math.round(Math.min(start.x, end.x) * 100)}%、上 ${Math.round(Math.min(start.y, end.y) * 100)}%、宽 ${Math.round(Math.abs(start.x - end.x) * 100)}%、高 ${Math.round(Math.abs(start.y - end.y) * 100)}%`, color: "#09caf5" });
        onClose();
      }}>插入标记引用</button>
    </> : <p>先通过「上传」或「画布参考」添加图片、视频，再标记其中的内容。</p>}
  </div></div>, document.body);
}
