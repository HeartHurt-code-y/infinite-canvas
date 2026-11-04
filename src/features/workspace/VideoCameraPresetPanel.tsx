import { useId, useState } from "react";
import { createPortal } from "react-dom";
import { useModalFocusTrap } from "../../components/useModalFocusTrap";
import { ErrorAlert } from "../../components/ErrorAlert";
import { VIDEO_CAMERA_PRESETS, MAX_CUSTOM_VIDEO_CAMERAS, readVideoCameraLibrary, saveVideoCameraLibrary, type VideoCameraLibrary, type VideoCameraPreset } from "../../lib/videoCameraPresets";
import { LibTVMediaIcon } from "./LibTVMediaIcon";
import { VideoCameraPresetEditor, VideoCameraPreview } from "./VideoCameraPresetEditor";
import "./VideoCameraPresetPanel.css";

type CameraTab = "official" | "favorite" | "custom";
const TABS = [["official", "运镜广场"], ["favorite", "我的收藏"], ["custom", "我的运镜"]] as const;

function DeleteCameraPreset({ preset, onClose, onDelete }: {
  readonly preset: VideoCameraPreset;
  readonly onClose: () => void;
  readonly onDelete: () => void;
}) {
  const trap = useModalFocusTrap({ active: true, onEscape: onClose });
  return createPortal(<div className="canvas-video-modal-scrim" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={trap.ref} {...trap.containerProps} className="video-camera-library video-camera-delete" role="alertdialog" aria-modal="true" aria-label="删除运镜" tabIndex={-1}>
      <header><strong>删除运镜</strong><button type="button" aria-label="关闭删除确认" onClick={onClose}><LibTVMediaIcon name="close" size={14} /></button></header>
      <p>确认删除“{preset.name}”？</p><footer><button type="button" onClick={onClose}>取消</button><button type="button" onClick={onDelete}>删除</button></footer>
    </section>
  </div>, document.body);
}

export function VideoCameraPresetPanel({ onClose, onInsert }: {
  readonly onClose: () => void;
  readonly onInsert: (preset: VideoCameraPreset) => void;
}) {
  const trap = useModalFocusTrap({ active: true, onEscape: onClose });
  const [library, setLibrary] = useState(readVideoCameraLibrary);
  const [tab, setTab] = useState<CameraTab>("official");
  const [queries, setQueries] = useState<Record<CameraTab, { draft: string; applied: string }>>({ official: { draft: "", applied: "" }, favorite: { draft: "", applied: "" }, custom: { draft: "", applied: "" } });
  const [editing, setEditing] = useState<VideoCameraPreset | null>(null);
  const [deleting, setDeleting] = useState<VideoCameraPreset | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const panelId = useId();
  const persist = (next: VideoCameraLibrary) => { saveVideoCameraLibrary(next); setLibrary(next); setError(null); };
  const save = (next: VideoCameraLibrary) => { try { persist(next); } catch (failure) { setError(failure); } };
  const query = queries[tab];
  const all = [...VIDEO_CAMERA_PRESETS, ...library.custom];
  const items = (tab === "official" ? VIDEO_CAMERA_PRESETS : tab === "custom" ? library.custom : all.filter(item => library.favorites.includes(item.id)))
    .filter(item => item.name.toLocaleLowerCase().includes(query.applied.trim().toLocaleLowerCase()));
  const canCreate = library.custom.length < MAX_CUSTOM_VIDEO_CAMERAS;
  return createPortal(<div className="canvas-video-modal-scrim" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={trap.ref} {...trap.containerProps} className="video-camera-library video-camera-library--presets" role="dialog" aria-modal="true" aria-label="运镜" tabIndex={-1}>
      <header><div role="tablist" aria-label="运镜目录">{TABS.map(([key, label]) =>
        <button key={key} id={panelId + "-" + key} type="button" role="tab" aria-controls={panelId} aria-selected={tab === key} onClick={() => { setTab(key); setHovered(null); }}>{label}</button>)}</div>
        <form className="video-camera-library__search video-camera-library__search--inline" onSubmit={event => { event.preventDefault(); setQueries(current => ({ ...current, [tab]: { ...current[tab], applied: current[tab].draft.trim() } })); }}>
          <LibTVMediaIcon name="search-c" size={16} /><input aria-label="搜索运镜名称" placeholder="搜索运镜名称" value={query.draft} onChange={event => { const draft = event.target.value; setQueries(current => ({ ...current, [tab]: { draft, applied: draft ? current[tab].applied : "" } })); }} />
          {query.draft || query.applied ? <button type="button" aria-label="清空运镜搜索" onClick={() => setQueries(current => ({ ...current, [tab]: { draft: "", applied: "" } }))}><LibTVMediaIcon name="close" size={12} /></button> : null}
        </form>
        <button type="button" aria-label="关闭运镜" onClick={onClose}><LibTVMediaIcon name="close" size={16} /></button>
      </header>
      <div id={panelId} role="tabpanel" aria-labelledby={panelId + "-" + tab} className="video-camera-library__grid">
        {tab === "custom" && !query.applied ? <button type="button" className="video-camera-library__new" disabled={!canCreate} data-tooltip={!canCreate ? "最多创建 " + MAX_CUSTOM_VIDEO_CAMERAS + " 个自定义运镜" : undefined} onClick={() => { setError(null); setEditing({ id: crypto.randomUUID(), name: "", tagLabel: "", prompt: "" }); }}><LibTVMediaIcon name="plus-s" size={24} /><span>新建运镜</span></button> : null}
        {items.map(item => <article key={item.id} onMouseEnter={() => setHovered(item.id)} onMouseLeave={() => setHovered(null)} onFocus={() => setHovered(item.id)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setHovered(null); }}>
          <button type="button" className="video-camera-library__use" aria-label={"使用运镜：" + item.name} onClick={() => { try { onInsert(item); } catch (failure) { setError(failure); } }}>
            <VideoCameraPreview preset={item} playing={hovered === item.id} /><span>{item.name}</span>
          </button>
          <button type="button" className="video-camera-library__favorite" aria-label={(library.favorites.includes(item.id) ? "取消收藏：" : "收藏：") + item.name} aria-pressed={library.favorites.includes(item.id)} onClick={() => save({ ...library, favorites: library.favorites.includes(item.id) ? library.favorites.filter(id => id !== item.id) : [...library.favorites, item.id] })}><LibTVMediaIcon name={library.favorites.includes(item.id) ? "start-f" : "start-l"} size={16} /></button>
          {tab === "custom" ? <div className="video-camera-library__manage"><button type="button" aria-label={"编辑运镜：" + item.name} data-tooltip="编辑" onClick={() => setEditing(item)}><LibTVMediaIcon name="pencil" size={12} /></button><button type="button" aria-label={"删除运镜：" + item.name} data-tooltip="删除" onClick={() => setDeleting(item)}><LibTVMediaIcon name="trash" size={12} /></button></div> : null}
        </article>)}
        {items.length === 0 && (tab !== "custom" || query.applied) ? <p className="video-camera-library__empty">暂无运镜</p> : null}
      </div>
      {error ? <ErrorAlert error={error} hint="检查运镜内容或本机存储后重试。" /> : null}
    </section>
    {editing ? <VideoCameraPresetEditor key={editing.id} preset={editing} onClose={() => setEditing(null)} onSave={item => {
      const existing = library.custom.some(value => value.id === item.id);
      if (!existing && !canCreate) throw new Error("最多创建 " + MAX_CUSTOM_VIDEO_CAMERAS + " 个自定义运镜。");
      persist({ ...library, custom: existing ? library.custom.map(value => value.id === item.id ? item : value) : [...library.custom, item] });
      setEditing(null);
    }} /> : null}
    {deleting ? <DeleteCameraPreset preset={deleting} onClose={() => setDeleting(null)} onDelete={() => { save({ ...library, custom: library.custom.filter(value => value.id !== deleting.id), favorites: library.favorites.filter(id => id !== deleting.id) }); setDeleting(null); }} /> : null}
  </div>, document.body);
}
