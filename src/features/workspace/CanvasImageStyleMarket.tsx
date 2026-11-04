import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useModalFocusTrap } from "../../components/useModalFocusTrap";
import { ErrorAlert } from "../../components/ErrorAlert";
import { backendErrorMessage } from "../../lib/backend";
import { imageStyleMarket, readStyleLibrary, saveStyleLibrary, type ImageStyleReference } from "../../lib/imageStyleMarket";
import { LibTVMediaIcon } from "./LibTVMediaIcon";
import { CanvasLibraryItemDetail, type CanvasLibraryAction } from "./CanvasLibraryItemDetail";
import "./CanvasImageStyleMarket.css";

export function CanvasImageStyleMarket({ selected, onSelect, onClose, canvasAction }: {
  readonly selected?: ImageStyleReference | undefined;
  readonly onSelect: (style: ImageStyleReference) => void;
  readonly onClose: () => void;
  readonly canvasAction?: CanvasLibraryAction;
}) {
  const trap = useModalFocusTrap({ active: true, onEscape: onClose });
  const [tab, setTab] = useState<"market" | "favorites" | "recent">("market");
  const [detail, setDetail] = useState<ImageStyleReference | null>(null);
  const [library, setLibrary] = useState(readStyleLibrary);
  const [categories, setCategories] = useState<Awaited<ReturnType<typeof imageStyleMarket.categories>>>([]);
  const [category, setCategory] = useState("");
  const [search, setSearch] = useState("");
  const [keyword, setKeyword] = useState("");
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<ImageStyleReference[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const request = useRef(0);
  const feedRequestId = useRef(crypto.randomUUID());
  useEffect(() => { let alive = true; void imageStyleMarket.categories().then(value => { if (alive) setCategories(value); }).catch(() => {}); return () => { alive = false; }; }, []);
  useEffect(() => {
    const id = ++request.current;
    if (tab !== "market") { setBusy(false); return; }
    setBusy(true); setError(null);
    if (page === 1) { setItems([]); feedRequestId.current = crypto.randomUUID(); }
    void imageStyleMarket.browse({ page, requestId: feedRequestId.current, keyword, tagIds: categories.find(item => item.name === category)?.ids ?? [] })
      .then(result => { if (request.current !== id) return; setItems(previous => page === 1 ? result.items : [...previous, ...result.items.filter(item => !previous.some(saved => saved.id === item.id))]); setHasMore(result.hasMore); })
      .catch((reason: unknown) => { if (request.current === id) setError(backendErrorMessage(reason)); })
      .finally(() => { if (request.current === id) setBusy(false); });
    return () => { if (request.current === id) request.current++; };
  }, [tab, page, keyword, category, categories, reload]);
  const persist = (next: typeof library) => { saveStyleLibrary(next); setLibrary(next); };
  const choose = (style: ImageStyleReference) => {
    try { onSelect(style); }
    catch (reason) { setError(backendErrorMessage(reason)); return; }
    try { persist({ ...library, recent: [style, ...library.recent.filter(item => item.id !== style.id)].slice(0, 100) }); }
    catch { /* 本机历史写入失败不应影响已应用的风格。 */ }
    onClose();
  };
  const toggleFavorite = (style: ImageStyleReference) => {
    try { persist({ ...library, favorites: library.favorites.some(item => item.id === style.id) ? library.favorites.filter(item => item.id !== style.id) : [style, ...library.favorites] }); }
    catch (reason) { setError(backendErrorMessage(reason)); }
  };
  const visible = tab === "market" ? items : library[tab].filter(item => `${item.name} ${item.author}`.toLowerCase().includes(keyword.toLowerCase()));
  return createPortal(<div className="canvas-video-modal-scrim image-style-market-scrim" onPointerDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={trap.ref} {...trap.containerProps} tabIndex={-1} role="dialog" aria-modal="true" aria-label="风格广场" className="image-style-market">
      <header><div className="image-style-market__tabs">{([["market", "风格广场"], ["favorites", "我的收藏"], ["recent", "最近使用"]] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={tab === value} onClick={() => { setTab(value); setDetail(null); setPage(1); setError(null); }}>{label}</button>)}</div>
        <form onSubmit={event => { event.preventDefault(); setDetail(null); setPage(1); setKeyword(search.trim()); setReload(value => value + 1); }}><input aria-label="搜索风格名称、作者" placeholder="搜索风格名称、作者" value={search} onChange={event => setSearch(event.target.value)} /><button type="submit" aria-label="搜索风格"><LibTVMediaIcon name="search-c" size={16} /></button></form>
        <button type="button" className="image-style-market__close" aria-label="关闭风格广场" onClick={onClose}><LibTVMediaIcon name="close" size={18} /></button></header>
      {!detail && tab === "market" ? <nav aria-label="风格分类">{["", ...categories.map(item => item.name)].map(name => <button type="button" key={name} aria-pressed={category === name} onClick={() => { setCategory(name); setPage(1); }}>{name || "推荐"}</button>)}</nav> : null}
      <p className="image-style-market__hint">{tab === "market" ? "当前图片模型使用公开样图作为风格参考。" : "收藏与最近使用保存在本机。"}</p>
      {error ? <div className="image-style-market__error"><ErrorAlert error={error} /><button type="button" onClick={() => setReload(value => value + 1)}>重试</button></div> : null}
      {detail && canvasAction ? <CanvasLibraryItemDetail title={detail.name} cover={detail.imageUrl} author={detail.author}
        description="连接到图片节点后，当前模型会把这张公开样图作为风格参考。" action={canvasAction}
        onBack={() => setDetail(null)} onApply={() => choose(detail)} /> :
      <div className="image-style-market__scroll" aria-busy={busy}><div className="image-style-market__grid">{visible.map(style => <article key={style.id} className={selected?.id === style.id ? "is-selected" : ""}>
        <button type="button" className="image-style-market__select" aria-label={`${canvasAction ? "查看风格" : "使用风格参考"}：${style.name}`} onClick={() => canvasAction ? setDetail(style) : choose(style)}><img src={style.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" /><strong>{style.name}</strong><span>{style.author}</span></button>
        <button type="button" className="image-style-market__favorite" aria-label={`${library.favorites.some(item => item.id === style.id) ? "取消收藏" : "收藏"}：${style.name}`} aria-pressed={library.favorites.some(item => item.id === style.id)} onClick={() => toggleFavorite(style)}><LibTVMediaIcon name={library.favorites.some(item => item.id === style.id) ? "start-f" : "start-l"} size={16} /></button>
      </article>)}</div>{!busy && !error && visible.length === 0 ? <p className="image-style-market__empty">{tab === "market" ? "没有找到风格" : tab === "favorites" ? "还没有收藏风格" : "还没有使用过风格"}</p> : null}
      {tab === "market" && (busy || hasMore) ? <button type="button" className="image-style-market__more" disabled={busy} onClick={() => setPage(value => value + 1)}>{busy ? "加载中…" : "加载更多"}</button> : null}</div>}
    </section>
  </div>, document.body);
}
