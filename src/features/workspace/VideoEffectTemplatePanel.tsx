import { useState } from "react";
import { createPortal } from "react-dom";
import { useModalFocusTrap } from "../../components/useModalFocusTrap";
import { ErrorAlert } from "../../components/ErrorAlert";
import {
  VIDEO_EFFECT_TEMPLATES,
  readVideoEffectFavorites,
  readRecentVideoEffects,
  rememberVideoEffect,
  saveVideoEffectFavorites,
  type VideoEffectTemplate,
} from "../../lib/videoEffectTemplates";
import { CanvasLibraryItemDetail, type CanvasLibraryAction } from "./CanvasLibraryItemDetail";
import { LibTVMediaIcon } from "./LibTVMediaIcon";
import "./VideoCameraPresetPanel.css";

const TABS = [
  { id: "all", label: "特效广场" },
  { id: "favorite", label: "我的收藏" },
  { id: "recent", label: "最近使用" },
] as const;

export function VideoEffectTemplatePanel({ onClose, onSelect, canvasAction, selectedId }: {
  readonly onClose: () => void;
  readonly onSelect: (template: VideoEffectTemplate) => void;
  readonly canvasAction?: CanvasLibraryAction;
  readonly selectedId?: number | undefined;
}) {
  const trap = useModalFocusTrap({ active: true, onEscape: onClose });
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("all");
  const [favorites, setFavorites] = useState(readVideoEffectFavorites);
  const [recent] = useState(readRecentVideoEffects);
  const [search, setSearch] = useState("");
  const [detail, setDetail] = useState<VideoEffectTemplate | null>(null);
  const [error, setError] = useState<unknown>(null);
  const ids = tab === "favorite" ? favorites : recent;
  const catalog = tab === "all" ? VIDEO_EFFECT_TEMPLATES : ids.flatMap(id =>
    VIDEO_EFFECT_TEMPLATES.filter(template => template.versionId === id));
  const items = catalog.filter(item => item.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const choose = (template: VideoEffectTemplate) => {
    try { onSelect(template); }
    catch (failure) { setError(failure); return; }
    rememberVideoEffect(template.versionId);
    onClose();
  };
  const toggleFavorite = (id: number) => {
    const next = favorites.includes(id) ? favorites.filter(value => value !== id) : [...favorites, id];
    try {
      saveVideoEffectFavorites(next);
      setFavorites(next);
      setError(null);
    } catch (failure) { setError(failure); }
  };
  return createPortal(
    <div className="canvas-video-modal-scrim" onPointerDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section ref={trap.ref} {...trap.containerProps}
        className={`video-camera-library${canvasAction ? " video-camera-library--presets" : ""}`}
        role="dialog" aria-modal="true" aria-label="特效广场" tabIndex={-1}>
        <header>
          <div role="tablist" aria-label="特效目录">
            {TABS.map(({ id, label }) => <button type="button" key={id} role="tab" aria-selected={tab === id}
              onClick={() => { setTab(id); setDetail(null); setError(null); }}>{label}</button>)}
          </div>
          <button type="button" aria-label="关闭特效库" onClick={onClose}><LibTVMediaIcon name="close" size={16} /></button>
        </header>
        {error ? <ErrorAlert error={error} hint="检查所选特效或本机存储后重试。" /> : null}
        {detail && canvasAction ? (
          <CanvasLibraryItemDetail title={detail.name} cover={detail.image} action={canvasAction}
            description="连接到视频节点后，特效模板会与该节点的提示词和参考素材一起参与生成。"
            onBack={() => { setDetail(null); setError(null); }} onApply={() => choose(detail)} />
        ) : (
          <>
            <div className="video-camera-library__search">
              <LibTVMediaIcon name="icon-search" size={16} />
              <input type="search" aria-label="搜索特效名称" placeholder="搜索特效名称"
                value={search} onChange={event => setSearch(event.target.value)} />
            </div>
            <div className="video-camera-library__grid">
              {items.map(item => {
                const favorite = favorites.includes(item.versionId);
                return (
                  <article key={item.versionId}>
                    <button type="button" className="video-camera-library__use"
                      aria-current={item.versionId === selectedId ? "true" : undefined}
                      aria-label={`${canvasAction ? "查看特效" : "使用特效"}：${item.name}`}
                      onClick={() => canvasAction ? setDetail(item) : choose(item)}>
                      <img src={item.image} alt="" loading="lazy" />
                      <span>{item.name}</span>
                    </button>
                    <button type="button" className="video-camera-library__favorite"
                      aria-label={`${favorite ? "取消收藏" : "收藏"}：${item.name}`}
                      aria-pressed={favorite} onClick={() => toggleFavorite(item.versionId)}>
                      <LibTVMediaIcon name={favorite ? "start-f" : "start-l"} size={16} />
                    </button>
                  </article>
                );
              })}
              {items.length === 0 ? <p className="video-camera-library__empty">
                {search.trim() ? "没有匹配的特效" : tab === "favorite" ? "还没有收藏特效" : "还没有使用过特效"}
              </p> : null}
            </div>
          </>
        )}
      </section>
    </div>, document.body,
  );
}
