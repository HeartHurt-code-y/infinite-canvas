import { useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CanvasSelect } from "../../components/CanvasSelect";
import { ErrorAlert } from "../../components/ErrorAlert";
import { useModalFocusTrap } from "../../components/useModalFocusTrap";
import { localBase64AssetClient, pickLocalMediaFiles, toMediaSrc } from "../../lib/backend";
import { saveVideoEditFrame } from "../../lib/videoLocalEdit";
import {
  approveBrandModelVersion, archiveBrandModel, listBrandModels, saveBrandModelVersion,
  selectBrandModelVersion, validateBrandModelVersion, type BrandModelProfile, type BrandModelSelection,
  type BrandModelVersion,
} from "../../lib/brandModels";
import { CanvasFeatureAssetPicker, type ListFeatureAssets } from "./CanvasFeatureAssetPicker";
import { CharacterMannequin, CharacterStudioPreview } from "./CharacterStudioPreview";
import type { CanvasFeatureTarget } from "./canvasFeatureCatalog";
import { LibTVMediaIcon } from "./LibTVMediaIcon";
import {
  CHARACTER_ADJUSTMENTS, CHARACTER_BRAND, CHARACTER_FIELDS, CHARACTER_IMAGE_DRAFTS, CHARACTER_MARKS,
  CHARACTER_REFERENCE_LIMIT, CHARACTER_REF_ROLES, EMPTY_CHARACTER_VISUAL,
  characterPrompt, characterReferenceVersion, characterSourceFromAsset, characterVersionInfo,
  encodeCharacterVersion, withCharacterSourcePaths,
  type CharacterAdjustment, type CharacterField, type CharacterImageDraft, type CharacterLook,
  type CharacterMark, type CharacterMediaSource, type CharacterVisual,
} from "./characterStudioModel";
import "./CanvasCharacterStudio.css";

const CHARACTER_QUERY = ["canvas-character-studio"] as const;
const FILTERS = ["gender", "age", "region"] as const;
const EDIT_SECTIONS = [
  { label: "基本信息", icon: "asset-character", fields: ["gender", "age", "region", "era"] },
  { label: "脸部", icon: "character-studio-view-face", fields: [] },
  { label: "特征", icon: "character-design", fields: ["features"] },
  { label: "身材", icon: "character-studio-view-body", fields: ["body"] },
  { label: "服饰造型", icon: "character-related", fields: ["outfit", "hair", "hairColor", "makeup", "lipColor", "styling"] },
  { label: "音色", icon: "library-q4-voice", fields: ["voice"] },
] as const;
const FACE_SECTIONS = [
  { label: "皮肤", key: "complexion" },
  { label: "眉眼", key: "eyeSize", field: "eyes" },
  { label: "鼻子", key: "noseWidth", field: "nose" },
  { label: "嘴唇", key: "lipWidth", field: "lips" },
  { label: "脸型", key: "faceWidth", field: "face" },
  { label: "妆容", key: "makeup", field: "makeup" },
] as const;

function carouselPosition(track: HTMLDivElement) {
  const [first, second] = track.querySelectorAll<HTMLElement>("button[data-slide]");
  return first && second ? Math.round(track.scrollLeft / (second.offsetLeft - first.offsetLeft)) : 0;
}

export interface CharacterStudioTarget extends CanvasFeatureTarget, CharacterMediaSource {}

export interface CharacterGenerationDraft {
  readonly kind: "image" | "audio";
  readonly name: string;
  readonly prompt: string;
  readonly sources: readonly CharacterMediaSource[];
}

interface CharacterEditorState {
  readonly profile?: BrandModelProfile;
  readonly name: string;
  readonly lookName: string;
  readonly description: string;
  readonly invariants: string;
  readonly look: CharacterLook;
  readonly visual: CharacterVisual;
  readonly references: readonly CharacterImageDraft[];
  readonly voiceAssetId: string | null;
  readonly voiceSource?: CharacterMediaSource | undefined;
}

function newEditor(): CharacterEditorState {
  return { name: "", lookName: "", description: "", invariants: "", look: {}, visual: EMPTY_CHARACTER_VISUAL,
    references: [], voiceAssetId: null };
}

function editorFromVersion(profile: BrandModelProfile, version: BrandModelVersion, copy: boolean): CharacterEditorState {
  const info = characterVersionInfo(version.description);
  return {
    ...info, ...(copy ? {} : { profile }), name: copy ? profile.name + " 副本" : profile.name,
    invariants: version.invariants,
    references: version.references.map((ref) => ({
      id: ref.id, role: ref.role, source: { label: ref.label, path: ref.path, src: toMediaSrc(ref.path) },
    })),
  };
}

function VoicePlayer({ assetId, preview }: { readonly assetId: string | null; readonly preview?: string | null | undefined }) {
  const voice = useQuery({
    queryKey: ["character-studio-voice", assetId],
    enabled: !!assetId && !preview,
    queryFn: () => localBase64AssetClient.refreshMedia({ assetId: assetId!, mediaType: "audio" }),
  });
  const src = preview || voice.data;
  return src ? <audio controls src={src} preload="metadata" /> :
    voice.error ? <ErrorAlert error={voice.error} hint="请重新选择角色音色参考。" /> :
    assetId ? <span role="status">正在读取音色…</span> : null;
}

export function CanvasCharacterStudio({
  open, targetName, onClose, onSuspend, getSources, listAssets, hasCloud, onUse, onDraft,
}: {
  readonly open: boolean;
  readonly targetName: string | null;
  readonly onClose: () => void;
  readonly onSuspend: () => void;
  readonly getSources: (kind: "image" | "audio") => readonly CharacterStudioTarget[];
  readonly listAssets: ListFeatureAssets;
  readonly hasCloud: boolean;
  readonly onUse: (role: BrandModelSelection) => Promise<void>;
  readonly onDraft: (draft: CharacterGenerationDraft) => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: CHARACTER_QUERY, queryFn: listBrandModels, enabled: open, retry: false });
  const [tab, setTab] = useState<"mine" | "official">("mine");
  const [layout, setLayout] = useState<"carousel" | "grid">("carousel");
  const [screen, setScreen] = useState<"library" | "create" | "detail" | "editor">("library");
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<CharacterLook>({});
  const [archived, setArchived] = useState(false);
  const [selection, setSelection] = useState<{ profileId: string; versionId: string } | null>(null);
  const [editor, setEditor] = useState<CharacterEditorState>(newEditor);
  const [editSection, setEditSection] = useState(0);
  const [faceSection, setFaceSection] = useState(0);
  const [previewMode, setPreviewMode] = useState<"body" | "face">("body");
  const [mark, setMark] = useState<CharacterMark | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [carouselIndex, setCarouselIndex] = useState(0);
  const [createMenu, setCreateMenu] = useState(false);
  const [picker, setPicker] = useState<"image" | "audio" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [status, setStatus] = useState("");
  const [line, setLine] = useState("你好，很高兴认识你。");
  const busyRef = useRef(false);
  const rail = useRef<HTMLDivElement>(null);
  const carouselDrag = useRef<{ pointer: number; x: number; scroll: number; moved: boolean } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const trap = useModalFocusTrap({
    active: open,
    onEscape: () => { if (!busyRef.current) picker ? setPicker(null) : onClose(); },
  });
  const profiles = query.data ?? [];
  const currentProfile = profiles.find((profile) => profile.id === selection?.profileId);
  const currentVersion = currentProfile?.versions.find((version) => version.id === selection?.versionId);
  const info = currentVersion ? characterVersionInfo(currentVersion.description) : null;
  const visible = profiles.filter((profile) => {
    if (profile.archived !== archived) return false;
    const version = characterReferenceVersion(profile.versions, profile.currentVersionId);
    const data = characterVersionInfo(version?.description ?? "");
    if (!FILTERS.every((key) => !filters[key] || data.look[key] === filters[key])) return false;
    return [profile.name, data.description, data.lookName, version?.invariants ?? "", ...Object.values(data.look)]
      .join(" ").toLocaleLowerCase().includes(search.trim().toLocaleLowerCase());
  });
  const hasFilters = search.trim().length > 0 || FILTERS.some(key => filters[key]);
  const showCreateCard = !archived && !hasFilters;
  const carouselCount = visible.length + Number(showCreateCard);
  const activeSlide = Math.min(carouselIndex, Math.max(0, carouselCount - 1));
  const preview = currentVersion?.references.find((ref) => ref.role === "front") ?? currentVersion?.references[0];
  const editorPreview = editor.references.find(ref => ref.id === previewId) ?? editor.references[0];
  const faceControl = FACE_SECTIONS[faceSection] ?? FACE_SECTIONS[0];
  const go = (view: typeof screen) => { setScreen(view); setError(null); setStatus(""); setCreateMenu(false); };
  const moveCarousel = (index: number) => {
    const track = rail.current;
    if (!track) return;
    const items = track.querySelectorAll<HTMLElement>("button[data-slide]");
    const item = items[Math.min(items.length - 1, Math.max(0, index))];
    if (item) track.scrollTo({
      left: item.offsetLeft + (item.offsetWidth - track.clientWidth) / 2,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
    });
  };
  const openDetail = (profile: BrandModelProfile, version = characterReferenceVersion(profile.versions, profile.currentVersionId)) => {
    if (!version) return;
    setSelection({ profileId: profile.id, versionId: version.id });
    go("detail");
  };
  const openEditor = (draft = newEditor(), sourcePicker: typeof picker = null) => {
    setEditor(draft);
    setEditSection(0);
    setFaceSection(0);
    setPreviewMode("body");
    setPreviewId(null);
    setMark(null);
    go("editor");
    setPicker(sourcePicker);
  };
  const run = async (action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true); setError(null); setStatus("");
    try { await action(); }
    catch (failure) { setError(failure); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const saveProfile = (profile: BrandModelProfile) => {
    queryClient.setQueryData<readonly BrandModelProfile[]>(CHARACTER_QUERY, (before = []) =>
      [profile, ...before.filter((item) => item.id !== profile.id)]);
  };
  const saveDraft = () => run(async () => {
    if (!editor.name.trim() || !editor.description.trim() || !editor.invariants.trim()) {
      throw new Error("请填写角色名称、外观描述和应保持一致的身份特征。");
    }
    if (!editor.references.length) throw new Error("请导入至少一张角色参考图。");
    let voiceAssetId = editor.voiceAssetId;
    if (editor.voiceSource) {
      voiceAssetId = await withCharacterSourcePaths([editor.voiceSource], async ([path]) => {
        const asset = await localBase64AssetClient.importAsset({ localPath: path!, name: editor.name + " · 音色" });
        if (asset.mediaType !== "audio") throw new Error("请选择音频文件作为角色音色。");
        return asset.id;
      });
    }
    const profile = await withCharacterSourcePaths(editor.references.map(ref => ref.source), (paths) =>
      saveBrandModelVersion({
        ...(editor.profile ? { profileId: editor.profile.id, expectedCurrentVersionId: editor.profile.currentVersionId } : {}),
        brandName: editor.profile?.brandName ?? CHARACTER_BRAND, name: editor.name.trim(),
        description: encodeCharacterVersion({ ...editor, voiceAssetId }),
        invariants: editor.invariants.trim(),
        references: editor.references.map((ref, index) => ({ role: ref.role, label: ref.source.label, sourcePath: paths[index]! })),
      }));
    saveProfile(profile);
    openDetail(profile, profile.versions[0]);
    setStatus("已保存草稿，可检查参考图后批准使用。");
  });
  const apply = () => {
    if (!currentProfile || !currentVersion) return;
    void run(async () => {
      const checked = await validateBrandModelVersion({
        profileId: currentProfile.id, versionId: currentVersion.id, expectedSignature: currentVersion.signature,
      });
      await onUse(selectBrandModelVersion(currentProfile, checked));
      onClose();
    });
  };
  const addPicked = (source: CharacterMediaSource, purpose?: CharacterImageDraft["role"]) => {
    if (picker === "audio") {
      setEditor((before) => ({ ...before, voiceSource: source, voiceAssetId: null }));
    } else {
      const id = crypto.randomUUID();
      setEditor((before) => {
        if (before.references.length >= CHARACTER_REFERENCE_LIMIT) return before;
        const role = purpose ?? CHARACTER_REF_ROLES.find((item) => !before.references.some((ref) => ref.role === item.value))?.value ?? "detail";
        return { ...before, references: [...before.references, { id, role, source }] };
      });
      if (editor.references.length === 0) setPreviewId(id);
    }
    setPicker(null);
  };
  const createCharacter = () => { setEditor(newEditor()); go("create"); };
  const savePreview = (png: string) => void run(async () => {
    if (editor.references.length >= CHARACTER_REFERENCE_LIMIT) throw new Error("参考图已达到上限，请先移除一张。");
    const frame = await saveVideoEditFrame(png);
    addPicked({ path: frame.path, src: toMediaSrc(frame.path), label: "造型预览.png" }, "detail");
    setStatus("已将本地预览添加为参考图。");
  });
  const changeVisual = (visual: CharacterVisual) => setEditor(before => ({ ...before, visual }));
  const adjustment = (key: CharacterAdjustment) => {
    const value = editor.visual.adjustments[key] ?? 0;
    return <label className="character-studio__slider">
      <span>{CHARACTER_ADJUSTMENTS[key]}<output>{value}</output></span>
      <input type="range" min={-100} max={100} value={value} onChange={(event) => {
        const amount = event.currentTarget.valueAsNumber;
        setEditor(before => ({ ...before, visual: {
          ...before.visual, adjustments: { ...before.visual.adjustments, [key]: amount },
        } }));
      }} />
    </label>;
  };
  const lookField = (key: CharacterField) => {
    const field = CHARACTER_FIELDS[key];
    const change = (value: string) => setEditor(before => ({ ...before, look: { ...before.look, [key]: value } }));
    return field.options.length ? <label key={key}>{field.label}<CanvasSelect ariaLabel={field.label} value={editor.look[key] ?? ""}
      options={[{ value: "", label: "未指定" }, ...field.options.map(label => ({ label, value: label }))]} onChange={change} /></label>
      : <label key={key}>{field.label}<textarea value={editor.look[key] ?? ""} onChange={(event) => change(event.target.value)} /></label>;
  };
  const imageDraft = (template: typeof CHARACTER_IMAGE_DRAFTS[number], fromDetail: boolean) => {
    const name = fromDetail ? currentProfile?.name ?? "" : editor.name;
    const data = fromDetail ? info : editor;
    if (!data || !data.description.trim()) { setError(new Error("请先描述角色的外观与造型。")); return; }
    void run(async () => {
      await onDraft({
        kind: "image", name: (name.trim() || "新角色") + " · " + template.label,
        prompt: characterPrompt(name.trim() || "新角色", data, fromDetail ? currentVersion?.invariants ?? "" : editor.invariants)
          + "\n" + template.instruction,
        sources: fromDetail ? (currentVersion?.references.slice(0, 2).map((ref) => ({ label: ref.label, path: ref.path })) ?? [])
          : editor.references.slice(0, 2).map((ref) => ref.source),
      });
      onSuspend();
    });
  };
  const audioDraft = (fromDetail: boolean) => {
    const assetId = fromDetail ? info?.voiceAssetId : editor.voiceAssetId;
    const source = fromDetail ? undefined : editor.voiceSource;
    const recorded: CharacterMediaSource | undefined = assetId
      ? { label: "角色音色参考", target: { kind: "local_base64_asset", mediaType: "audio", assetId } } : undefined;
    if (!line.trim()) { setError(new Error("请先填写试听台词。")); return; }
    void run(async () => {
      await onDraft({
        kind: "audio", name: (fromDetail ? currentProfile?.name : editor.name.trim()) || "角色音色",
        prompt: line.trim(), sources: source ? [source] : recorded ? [recorded] : [],
      });
      onSuspend();
    });
  };
  const toolbar = (
    <div className="character-studio__toolbar">
      {FILTERS.map((key) => <CanvasSelect key={key} ariaLabel={CHARACTER_FIELDS[key].label}
        value={filters[key] ?? ""} options={[{ value: "", label: CHARACTER_FIELDS[key].label },
          ...CHARACTER_FIELDS[key].options.map((label) => ({ value: label, label }))]}
        onChange={(value) => setFilters(before => ({ ...before, [key]: value }))}
        chevronIcon={<LibTVMediaIcon name="icon-chevron-down-small" size={12} />} />)}
      {searchOpen ? <input ref={searchRef} type="search" placeholder="搜索角色名称、描述" aria-label="搜索角色"
        value={search} onChange={(event) => setSearch(event.target.value)} /> :
        <button type="button" aria-label="搜索角色" data-tooltip="搜索角色" onClick={() => {
          setSearchOpen(true); window.requestAnimationFrame(() => searchRef.current?.focus());
        }}><LibTVMediaIcon name="icon-search" size={18} /></button>}
      <div className="character-studio__view-controls">
        <button type="button" aria-pressed={archived} aria-label="已归档角色" data-tooltip="已归档角色"
          onClick={() => setArchived(value => !value)}><LibTVMediaIcon name="icon-filter" size={17} /></button>
        <div role="group" aria-label="角色显示方式">
          <button type="button" aria-label="轮播" aria-pressed={layout === "carousel"} onClick={() => setLayout("carousel")}>
            <LibTVMediaIcon name="character-layout-carousel" size={18} /></button>
          <button type="button" aria-label="网格" aria-pressed={layout === "grid"} onClick={() => setLayout("grid")}>
            <LibTVMediaIcon name="character-layout-grid" size={18} /></button>
        </div>
      </div>
    </div>
  );
  const voiceFields = (fromDetail: boolean) => (
    <div className="character-studio__voice">
      <VoicePlayer assetId={fromDetail ? info?.voiceAssetId ?? null : editor.voiceAssetId}
        preview={fromDetail ? undefined : editor.voiceSource?.src} />
      {!fromDetail ? <div className="character-studio__actions">
        <button type="button" onClick={() => setPicker("audio")}><LibTVMediaIcon name="library-q4-voice" size={16} />
          {editor.voiceSource?.label || (editor.voiceAssetId ? "更换音色参考" : "选择音色参考")}</button>
        {editor.voiceAssetId || editor.voiceSource ? <button type="button" onClick={() => setEditor(before => ({
          ...before, voiceAssetId: null, voiceSource: undefined,
        }))}>移除音色参考</button> : null}
      </div> : null}
      <label>试听台词<input value={line} onChange={(event) => setLine(event.target.value)} /></label>
      <button type="button" onClick={() => audioDraft(fromDetail)}>创建音频试听节点</button>
    </div>
  );
  if (!open) return null;
  return createPortal(
    <div className="character-studio-scrim" onPointerDown={(event) => {
      if (event.target === event.currentTarget && !busy) onClose();
    }}>
      <section ref={trap.ref} {...trap.containerProps} className="character-studio" role="dialog"
        aria-modal="true" aria-label="角色造型室" tabIndex={-1}>
        <header className="character-studio__header">
          {screen === "library" ? <div className="character-studio__tabs" role="group" aria-label="角色库">
            <button type="button" aria-pressed={tab === "mine"} onClick={() => setTab("mine")}>我的角色库</button>
            <button type="button" aria-pressed={tab === "official"} onClick={() => setTab("official")}>官方角色库</button>
          </div> : <div className="character-studio__heading">
            <button type="button" disabled={busy} aria-label="返回角色库" onClick={() => {
              if (picker) { setPicker(null); return; }
              go(screen === "editor" && editor.profile ? "detail" : "library");
            }}><LibTVMediaIcon name="icon-chevron-left" size={17} /></button>
            <h2>{screen === "create" ? "创建新角色" : screen === "detail" ? currentProfile?.name : editor.profile ? "编辑角色造型" : "创建新角色"}</h2>
          </div>}
          <button type="button" className="character-studio__close" aria-label="关闭角色造型室" disabled={busy} onClick={onClose}>
            <LibTVMediaIcon name="close" size={18} /></button>
        </header>
        {error ? <div className="character-studio__error"><ErrorAlert error={error} /></div> : null}
        {status ? <p className="character-studio__status" role="status">{status}</p> : null}
        {busy ? <p className="character-studio__status" role="status">正在处理角色素材…</p> : null}
        {screen === "library" && tab === "official" ? (
          <div className="character-studio__empty">
            <LibTVMediaIcon name="asset-character" size={56} />
            <h3>官方角色库需要 LibTV 账户授权</h3>
            <button type="button" onClick={() => setTab("mine")}>返回我的角色库</button>
          </div>
        ) : null}
        {screen === "library" && tab === "mine" ? <>
          {toolbar}
          {query.isPending ? <p className="character-studio__status" role="status">正在读取本机角色…</p> : null}
          {query.error ? <div className="character-studio__error"><ErrorAlert error={query.error} />
            <button type="button" onClick={() => { void query.refetch(); }}>重新读取角色库</button></div> : null}
          <div ref={rail} className="character-studio__gallery" data-layout={layout}
            onPointerDown={(event) => {
              carouselDrag.current = null;
              if (layout !== "carousel" || event.button !== 0 || event.pointerType === "touch") return;
              carouselDrag.current = {
                pointer: event.pointerId, x: event.clientX, scroll: event.currentTarget.scrollLeft, moved: false,
              };
            }} onPointerMove={(event) => {
              const drag = carouselDrag.current;
              if (!drag || drag.pointer !== event.pointerId) return;
              if ((event.buttons & 1) === 0) {
                if (!drag.moved) carouselDrag.current = null;
                return;
              }
              const distance = event.clientX - drag.x;
              if (!drag.moved && Math.abs(distance) < 8) return;
              const track = event.currentTarget;
              if (!drag.moved) {
                drag.moved = true;
                track.setPointerCapture(event.pointerId);
                track.dataset["dragging"] = "true";
              }
              track.scrollLeft = drag.scroll - distance;
            }} onLostPointerCapture={(event) => {
              delete event.currentTarget.dataset["dragging"];
              moveCarousel(carouselPosition(event.currentTarget));
            }} onClickCapture={(event) => {
              const moved = carouselDrag.current?.moved;
              carouselDrag.current = null;
              if (moved && event.detail > 0) event.stopPropagation();
            }} onDragStart={(event) => event.preventDefault()}
            onScroll={(event) => {
              if (layout === "carousel") setCarouselIndex(carouselPosition(event.currentTarget));
            }} onKeyDown={(event) => {
              if (layout !== "carousel" || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
              event.preventDefault();
              moveCarousel(activeSlide + (event.key === "ArrowLeft" ? -1 : 1));
            }}>
            {showCreateCard ? <button className="character-studio__new-card" type="button" data-slide
              data-active={layout === "carousel" && activeSlide === 0} aria-label="创建新角色" onClick={createCharacter}>
              <CharacterMannequin /><span>创建新角色</span>
            </button> : null}
            {visible.map((profile, index) => {
              const version = characterReferenceVersion(profile.versions, profile.currentVersionId);
              const cover = version?.references.find((ref) => ref.role === "full_body") ?? version?.references[0];
              return <button className="character-studio__card" key={profile.id} type="button" data-slide
                data-active={layout === "carousel" && index + Number(showCreateCard) === activeSlide}
                onClick={() => openDetail(profile, version)}>
                {cover ? <img src={toMediaSrc(cover.path)} alt="" loading="lazy" /> : <LibTVMediaIcon name="asset-character" size={64} />}
                <span>{profile.name}</span><small>{profile.archived ? "已归档" : version?.status === "approved" ? "已批准" : "草稿"}</small>
              </button>;
            })}
            {!visible.length && (hasFilters || archived) ? <p className="character-studio__status">没有匹配的角色</p> : null}
          </div>
          {layout === "carousel" && carouselCount > 1 ? <><div className="character-studio__arrows">
            <button type="button" aria-label="向前浏览" disabled={activeSlide === 0} onClick={() => moveCarousel(activeSlide - 1)}>
              <LibTVMediaIcon name="icon-chevron-left" size={14} /></button>
            <button type="button" aria-label="向后浏览" disabled={activeSlide >= carouselCount - 1} onClick={() => moveCarousel(activeSlide + 1)}>
              <LibTVMediaIcon name="icon-chevron-right-small" size={14} /></button>
          </div><input className="character-studio__scrollbar" type="range" aria-label="浏览角色"
            min={0} max={carouselCount - 1} value={activeSlide}
            onChange={(event) => moveCarousel(event.currentTarget.valueAsNumber)} /></> : null}
          <footer className="character-studio__footer"><button type="button" className="character-studio__primary" onClick={createCharacter}>
            <LibTVMediaIcon name="character-create" size={19} />创建新角色</button></footer>
        </> : null}
        {screen === "create" ? <>
          <div className="character-studio__creation-stage"><CharacterMannequin /><h2>创建你的新角色</h2></div>
          <footer className="character-studio__composer">
            <div className="character-studio__reference-menu">
              <button type="button" aria-label="选择角色参考" aria-expanded={createMenu} data-tooltip="选择角色参考"
                onClick={() => setCreateMenu(value => !value)}><LibTVMediaIcon name="character-asset-import" size={20} /></button>
              {createMenu ? <div className="character-studio__reference-popover">
                <button type="button" disabled={busy} onClick={() => void run(async () => {
                  const path = (await pickLocalMediaFiles(["image"], { multiple: false }))[0];
                  if (!path) return;
                  const label = path.split(/[\\/]/).at(-1) || "角色参考";
                  openEditor({ ...editor, references: [{
                    id: crypto.randomUUID(), role: "front", source: { path, label, src: toMediaSrc(path) },
                  }] });
                })}><LibTVMediaIcon name="character-import" size={18} />本地上传</button>
                <button type="button" onClick={() => openEditor(editor, "image")}>
                  <LibTVMediaIcon name="asset-character" size={18} />从我的资产选择</button>
              </div> : null}
            </div>
            <textarea aria-label="描述你想创建的角色" placeholder="描述你想创建的角色…"
              value={editor.description} onChange={(event) => setEditor(before => ({ ...before, description: event.target.value }))} />
            <button type="button" aria-label="准备生成角色节点" className="character-studio__primary"
              disabled={busy || !editor.description.trim()} onClick={() => imageDraft(CHARACTER_IMAGE_DRAFTS[1], false)}>
              <LibTVMediaIcon name="character-create" size={18} />
            </button>
            <button type="button" onClick={() => openEditor(editor)}>编辑造型</button>
          </footer>
        </> : null}
        {screen === "detail" && currentProfile && currentVersion && info ? (
          <>
            <div className="character-studio__detail">
              <div className="character-studio__portrait">{preview ? <img src={toMediaSrc(preview.path)} alt={currentProfile.name} /> : null}</div>
              <div className="character-studio__details">
                <CanvasSelect ariaLabel="角色版本" value={currentVersion.id}
                  options={currentProfile.versions.map(version => ({
                    value: version.id, label: `版本 ${version.version} · ${version.status === "approved" ? "已批准" : "草稿"}`,
                  }))} onChange={(versionId) => setSelection({ profileId: currentProfile.id, versionId })} />
                {info.lookName ? <h3>{info.lookName}</h3> : null}
                <p>{info.description}</p><p>{currentVersion.invariants}</p>
                <div className="character-studio__tags">{Object.values(info.look).map((value, index) => <span key={index}>{value}</span>)}</div>
                <div className="character-studio__refs">{currentVersion.references.map((ref) => (
                  <figure key={ref.id}><img src={toMediaSrc(ref.path)} alt={ref.label} loading="lazy" />
                    <figcaption>{CHARACTER_REF_ROLES.find(item => item.value === ref.role)?.label}</figcaption></figure>
                ))}</div>
                {!currentProfile.archived ? <>
                  <h3>生成角色资产</h3>
                  <div className="character-studio__actions">{CHARACTER_IMAGE_DRAFTS.map(template =>
                    <button key={template.id} type="button" disabled={busy} onClick={() => imageDraft(template, true)}>{template.label}</button>)}</div>
                  {voiceFields(true)}
                </> : null}
              </div>
            </div>
            <footer className="character-studio__footer">
              <button type="button" disabled={busy} onClick={() => void run(async () => {
                const updated = await archiveBrandModel({ profileId: currentProfile.id, archived: !currentProfile.archived });
                saveProfile(updated);
                setStatus(updated.archived ? "角色已归档。" : "角色已恢复。");
              })}>{currentProfile.archived ? "恢复角色" : "归档角色"}</button>
              {!currentProfile.archived ? <>
                <button type="button" disabled={busy} onClick={() => openEditor(editorFromVersion(currentProfile, currentVersion, true))}>另存为新角色</button>
                <button type="button" disabled={busy} onClick={() => openEditor(editorFromVersion(currentProfile, currentVersion, false))}>编辑为新版本</button>
                {currentVersion.status === "draft" ? <button type="button" className="character-studio__primary" disabled={busy}
                  onClick={() => void run(async () => {
                    saveProfile(await approveBrandModelVersion({
                      profileId: currentProfile.id, versionId: currentVersion.id, expectedSignature: currentVersion.signature,
                    }));
                    setStatus("当前版本已批准。");
                  })}>批准这个版本</button> :
                  <button type="button" className="character-studio__primary" disabled={busy} onClick={apply}>
                    {targetName ? "应用到" + targetName : "添加到画布"}</button>}
              </> : null}
            </footer>
          </>
        ) : null}
        {screen === "editor" && picker ? (
          <div className="character-studio__picker">
            <CanvasFeatureAssetPicker key={picker} kind={picker} targets={getSources(picker)} titleId={titleId}
              listAssets={listAssets} hasCloud={hasCloud} onBack={() => setPicker(null)}
              onChoose={(key) => {
                const source = getSources(picker).find(item => item.key === key);
                if (source) addPicked({ ...source, src: source.previewSrc });
                else setError(new Error("画布素材已变化，请重新选择。"));
              }}
              onChooseAsset={(asset) => addPicked(characterSourceFromAsset(asset))}
              onChooseFile={async (path, signal) => {
                const selected = path ?? (await pickLocalMediaFiles([picker], { multiple: false }))[0];
                if (selected && !signal.aborted) addPicked({
                  path: selected, src: toMediaSrc(selected), label: selected.split(/[\\/]/).at(-1) || "角色参考",
                });
              }} />
          </div>
        ) : null}
        {screen === "editor" && !picker ? <>
          <div className="character-studio__editor">
            <nav className="character-studio__sections" aria-label="角色造型设置">
              {EDIT_SECTIONS.map((item, index) => <button key={item.label} type="button" aria-pressed={editSection === index}
                onClick={() => {
                  setEditSection(index);
                  setMark(null);
                  if (index === 1 || index === 2) setPreviewMode("face");
                  if (index === 3 || index === 4) setPreviewMode("body");
                }}><LibTVMediaIcon name={item.icon} size={18} />{item.label}</button>)}
            </nav>
            <section className="character-studio__editor-media">
              <div className="character-studio__preview-mode" role="group" aria-label="预览模式">
                <button type="button" aria-label="全身预览" aria-pressed={previewMode === "body"} data-tooltip="全身预览"
                  onClick={() => { setPreviewMode("body"); setMark(null); }}><LibTVMediaIcon name="character-studio-view-body" size={18} /></button>
                <button type="button" aria-label="脸部预览" aria-pressed={previewMode === "face"} data-tooltip="脸部预览"
                  onClick={() => setPreviewMode("face")}><LibTVMediaIcon name="character-studio-view-face" size={18} /></button>
              </div>
              <CharacterStudioPreview key={editorPreview?.id ?? "empty"} src={editorPreview?.source.src}
                visual={editor.visual} mode={previewMode} mark={mark} onChange={changeVisual}
                onPick={() => setPicker("image")} onSavePreview={savePreview} disabled={busy} />
              <div className="character-studio__refs">
                {editor.references.map((ref) => <figure key={ref.id}>
                  <button type="button" className="character-studio__reference-thumb" aria-label={"预览 " + ref.source.label}
                    aria-pressed={editorPreview?.id === ref.id} onClick={() => setPreviewId(ref.id)}>
                    {ref.source.src ? <img src={ref.source.src} alt="" /> : <LibTVMediaIcon name="asset-character" size={32} />}
                  </button>
                  <CanvasSelect ariaLabel={ref.source.label + "用途"} value={ref.role} options={CHARACTER_REF_ROLES}
                    onChange={(role) => setEditor(before => ({ ...before, references: before.references.map(item =>
                      item.id === ref.id ? { ...item, role: role as CharacterImageDraft["role"] } : item) }))} />
                  <button type="button" aria-label={"移除参考 " + ref.source.label} onClick={() => setEditor(before => ({
                    ...before, references: before.references.filter(item => item.id !== ref.id),
                  }))}><LibTVMediaIcon name="close" size={12} /></button>
                </figure>)}
              </div>
              <button type="button" disabled={busy || editor.references.length >= CHARACTER_REFERENCE_LIMIT} onClick={() => setPicker("image")}>
                <LibTVMediaIcon name="character-import" size={16} />添加参考图</button>
            </section>
            <section className="character-studio__editor-fields">
              <h3>{EDIT_SECTIONS[editSection]?.label}</h3>
              {editSection === 0 ? <>
                <label>角色名称<input value={editor.name} onChange={(event) => setEditor(before => ({ ...before, name: event.target.value }))} /></label>
                <label>造型名称<input value={editor.lookName} onChange={(event) => setEditor(before => ({ ...before, lookName: event.target.value }))} /></label>
                <label>外观描述<textarea value={editor.description} onChange={(event) => setEditor(before => ({ ...before, description: event.target.value }))} /></label>
                <label>保持一致的身份特征<textarea value={editor.invariants} onChange={(event) => setEditor(before => ({ ...before, invariants: event.target.value }))} /></label>
              </> : null}
              {editSection === 1 ? <>
                <div className="character-studio__face-categories" role="group" aria-label="脸部调整类别">
                  {FACE_SECTIONS.map((section, index) => <button key={section.key} type="button" aria-pressed={faceSection === index}
                    onClick={() => setFaceSection(index)}>{section.label}</button>)}
                </div>
                {faceControl.key === "makeup" ? <>
                  {lookField("makeup")}
                  {lookField("lipColor")}
                  <p>妆容和唇色会进入角色生成提示词。</p>
                </> : <>
                  {adjustment(faceControl.key)}
                  {"field" in faceControl ? lookField(faceControl.field) : null}
                  <button type="button" onClick={() => changeVisual({ ...editor.visual, adjustments: {
                    ...editor.visual.adjustments, [faceControl.key]: 0,
                  } })}>重置当前调整</button>
                </>}
              </> : null}
              {editSection === 2 ? <>
                <div className="character-studio__feature-tiles">
                  {(Object.keys(CHARACTER_MARKS) as CharacterMark[]).map(key =>
                    <button key={key} type="button" disabled={!editorPreview || busy} aria-pressed={mark === key}
                      onClick={() => { setMark(mark === key ? null : key); setPreviewMode("face"); }}>
                      <span className="character-studio__feature-sample" data-mark={key} />{CHARACTER_MARKS[key]}
                    </button>)}
                </div>
                <button type="button" disabled={!editor.visual.marks.length || busy} onClick={() =>
                  changeVisual({ ...editor.visual, marks: editor.visual.marks.slice(0, -1) })}>
                  <LibTVMediaIcon name="character-studio-undo" size={16} />撤销上一个特征
                </button>
              </> : null}
              {editSection === 3 ? adjustment("bodyWidth") : null}
              {EDIT_SECTIONS[editSection]?.fields.map(lookField)}
              {editSection === 4 ? <p>服饰和发型会进入角色生成提示词。</p> : null}
              {editSection === 5 ? voiceFields(false) : null}
            </section>
          </div>
          <footer className="character-studio__footer">
            <div className="character-studio__actions" aria-label="生成角色资产">{CHARACTER_IMAGE_DRAFTS.map(template =>
              <button key={template.id} type="button" disabled={busy} onClick={() => imageDraft(template, false)}>{template.label}</button>)}</div>
            <button type="button" className="character-studio__primary" disabled={busy}
            onClick={() => { void saveDraft(); }}>保存角色草稿</button></footer>
        </> : null}
      </section>
    </div>, document.body,
  );
}
