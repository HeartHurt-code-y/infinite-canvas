import { useEffect, useRef, useState } from "react";
import {
  backendErrorMessage,
  generationClient,
  toMediaSrc,
  type GenerationTaskCursor,
} from "../../lib/backend";
import { toMediaProxyUrl } from "../../lib/mediaProxy";
import type { CanvasFeatureTarget } from "./canvasFeatureCatalog";
import { LibTVMediaIcon } from "./LibTVMediaIcon";
import { ASSET_KIND_LABELS, type AssetItem } from "./workspaceModel";

export type FeatureLibrarySource = "local" | "objects" | "cloud";
export type ListFeatureAssets = (source: FeatureLibrarySource, kind: AssetItem["kind"], query: string, page: number) =>
  Promise<{ items: readonly AssetItem[]; hasNext: boolean }>;

type Section = "history" | "saved" | "uploads" | "canvas";
const SECTIONS = [
  { id: "history", label: "生成历史", icon: "library-q4-history" },
  { id: "saved", label: "我保存的", icon: "library-q4-saved" },
  { id: "uploads", label: "我上传的", icon: "library-q4-upload" },
  { id: "canvas", label: "当前画布", icon: "library-q4-grid" },
] as const;

interface PickerItem {
  readonly key: string;
  readonly name: string;
  readonly src?: string | null | undefined;
  readonly poster?: string | null | undefined;
  readonly select: () => void;
}

interface PickerPage {
  readonly items: readonly PickerItem[];
  readonly hasNext: boolean;
  readonly cursor?: GenerationTaskCursor | null;
}

function MediaTile({ item, kind, disabled }: {
  readonly item: PickerItem;
  readonly kind: AssetItem["kind"];
  readonly disabled: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const thumbnail = item.poster || (kind === "image" ? item.src : null);
  const media = kind === "video" ? item.src : null;
  return (
    <button type="button" className="canvas-feature-picker__tile" disabled={disabled}
      data-tooltip={item.name} onClick={item.select}>
      <span className="canvas-feature-picker__tile-media">
        {thumbnail && !failed ? (
          <img src={toMediaProxyUrl(thumbnail) ?? thumbnail} alt="" loading="lazy" onError={() => setFailed(true)} />
        ) : media && !failed ? (
          <video src={toMediaProxyUrl(media) ?? media} muted playsInline preload="metadata" aria-hidden="true"
            onError={() => setFailed(true)} />
        ) : <LibTVMediaIcon name={kind === "audio" ? "library-q4-voice" : kind === "video" ? "icon-video-gen" : "library-q4-grid"} size={34} />}
        {kind === "video" && !failed && (thumbnail || media) ? (
          <span className="canvas-feature-picker__video-badge"><LibTVMediaIcon name="icon-video-gen" size={14} /></span>
        ) : null}
      </span>
      <span className="canvas-feature-picker__tile-name">{item.name}</span>
    </button>
  );
}

interface AssetPickerProps {
  readonly listAssets: ListFeatureAssets;
  readonly onChooseAsset: (asset: AssetItem) => void;
  readonly onBack: () => void;
  readonly hasCloud: boolean;
  readonly titleId: string;
}

interface FeaturePickerOptions {
  readonly kind: AssetItem["kind"];
  readonly targets: readonly CanvasFeatureTarget[];
  readonly onChoose: (key: string) => void;
  readonly onChooseFile: (path: string | null, signal: AbortSignal) => Promise<void>;
}

interface ReferencePickerOptions {
  readonly referenceKinds: readonly [AssetItem["kind"], ...AssetItem["kind"][]];
  readonly selectionError: string | null;
}

export function CanvasFeatureAssetPicker(props: AssetPickerProps & FeaturePickerOptions) {
  return <CanvasAssetPicker {...props} />;
}

export function CanvasReferenceAssetPicker(props: AssetPickerProps & ReferencePickerOptions) {
  return <CanvasAssetPicker {...props} />;
}

function CanvasAssetPicker(props: AssetPickerProps & (FeaturePickerOptions | ReferencePickerOptions)) {
  const { listAssets, onChooseAsset, onBack, hasCloud, titleId } = props;
  const referenceMode = "referenceKinds" in props;
  const onChooseFile = referenceMode ? undefined : props.onChooseFile;
  const [referenceKind, setReferenceKind] = useState<AssetItem["kind"]>("image");
  const kind = referenceMode
    ? (props.referenceKinds.find(item => item === referenceKind) ?? props.referenceKinds[0])
    : props.kind;
  const [section, setSection] = useState<Section>(referenceMode ? "saved" : "history");
  const [library, setLibrary] = useState<FeatureLibrarySource>("local");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [historyCursors, setHistoryCursors] = useState<readonly (GenerationTaskCursor | null)[]>([null]);
  const [result, setResult] = useState<PickerPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const pendingFile = useRef<AbortController | null>(null);
  const latestActions = useRef({ onChooseAsset, onChooseFile });
  useEffect(() => {
    latestActions.current = { onChooseAsset, onChooseFile };
  }, [onChooseAsset, onChooseFile]);
  useEffect(() => () => pendingFile.current?.abort(), []);

  async function chooseFile(path: string | null) {
    if (pendingFile.current || !latestActions.current.onChooseFile) return;
    const controller = new AbortController();
    pendingFile.current = controller;
    setPending(true);
    setError(null);
    try {
      await latestActions.current.onChooseFile(path, controller.signal);
    } catch (failure) {
      if (!controller.signal.aborted) setError(backendErrorMessage(failure));
    } finally {
      pendingFile.current = null;
      if (!controller.signal.aborted) setPending(false);
    }
  }

  const historyCursor = historyCursors[page - 1] ?? null;
  useEffect(() => {
    if (section === "canvas") return;
    let disposed = false;
    const load = async (): Promise<PickerPage> => {
      if (section !== "history") {
        const data = await listAssets(section === "uploads" ? "objects" : library, kind, search.trim(), page);
        return { hasNext: data.hasNext, items: data.items.map(asset => ({
          key: String(asset.dbId ?? asset.id), name: asset.name, src: asset.videoUrl ?? asset.previewUrl,
          poster: asset.coverUrl,
          select: () => latestActions.current.onChooseAsset(asset),
        })) };
      }
      const data = await generationClient.list({ statuses: ["succeeded"], search: search.trim(), cursor: historyCursor, limit: 16 });
      if (disposed) return { items: [], hasNext: false };
      const matching = data.items.filter(task => kind === "video" ? task.operation === "video_generation"
        : kind === "audio" ? task.operation === "speech_generation"
          : task.operation === "text_to_image" || task.operation === "image_to_image");
      const details = await Promise.allSettled(matching.map(task => generationClient.getProgress(task.id)));
      if (matching.length && details.every(detail => detail.status === "rejected")) {
        throw new Error("读取生成历史失败，请重试。");
      }
      const items = details.flatMap(detail => detail.status === "fulfilled" ? detail.value.results.flatMap(output => {
        const path = output.finalPath;
        if (!path || output.mediaType !== kind || output.saveStatus !== "succeeded") return [];
        return [{
          key: output.taskId + "#" + output.resultIndex,
          name: detail.value.summary.outputName?.trim() || path.split(/[\\/]/).pop() || "生成结果",
          src: toMediaSrc(path),
          select: () => { void chooseFile(path); },
        }];
      }) : []);
      return { items, hasNext: data.nextCursor != null, cursor: data.nextCursor };
    };
    const timer = window.setTimeout(() => {
      void load().then(
        data => { if (!disposed) setResult(data); },
        failure => { if (!disposed) setError(backendErrorMessage(failure)); },
      );
    }, 220);
    return () => { disposed = true; window.clearTimeout(timer); };
  }, [section, library, kind, search, page, historyCursor, listAssets]);

  const resetPage = () => {
    setPage(1);
    setHistoryCursors([null]);
    setResult(null);
    setError(null);
  };
  const items = !referenceMode && section === "canvas" ? props.targets.filter(target =>
    target.label.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())).map(target => ({
    key: target.key, name: target.label, src: target.previewSrc, select: () => props.onChoose(target.key),
  })) : result?.items;
  const currentSection = SECTIONS.find(item => item.id === section)!;
  return (
    <div className="canvas-feature-picker">
      {!referenceMode ? <aside className="canvas-feature-picker__sidebar">
        <h2 id={titleId}>资产库</h2>
        <nav aria-label="素材来源">
          {SECTIONS.map(item => (
            <button key={item.id} type="button" aria-pressed={section === item.id} disabled={pending} onClick={() => {
              if (item.id === section) return;
              setSection(item.id);
              resetPage();
            }}>
              <span><LibTVMediaIcon name={item.icon} size={16} /></span>{item.label}
            </button>
          ))}
        </nav>
      </aside> : null}
      <div className="canvas-feature-picker__main">
        <header>
          {referenceMode ? <h3 id={titleId}>从素材库选择参考素材</h3>
            : <h3>{section === "saved" ? "个人资产" : currentSection.label}</h3>}
          <div className="canvas-all-features__search">
            <LibTVMediaIcon name="feature-search" size={16} />
            <input aria-label="搜索素材" placeholder="搜索素材" value={search} disabled={pending} onChange={event => {
              if (search !== event.target.value) resetPage();
              setSearch(event.target.value);
            }} />
            {search ? <button type="button" aria-label="清空搜索" disabled={pending}
              onClick={() => { setSearch(""); resetPage(); }}><LibTVMediaIcon name="library-q4-close" size={14} /></button> : null}
          </div>
          <button type="button" className="canvas-all-features__close"
            aria-label={referenceMode ? "关闭素材库" : "关闭资产库"} onClick={onBack}>
            <LibTVMediaIcon name="library-q4-close" size={16} />
          </button>
        </header>
        {section === "saved" ? (
          <div className="canvas-feature-picker__filters" aria-label="素材库">
            {([
              { id: "local", label: "本地素材库" }, { id: "objects", label: "对象存储" },
              ...(hasCloud ? [{ id: "cloud", label: "云端素材库" } as const] : []),
            ] as const).map(item => (
              <button key={item.id} type="button" aria-pressed={library === item.id} disabled={pending} onClick={() => {
                if (item.id === library) return;
                setLibrary(item.id);
                resetPage();
              }}>{item.label}</button>
            ))}
          </div>
        ) : null}
        {referenceMode && props.referenceKinds.length > 1 ? (
          <div className="canvas-feature-picker__filters" role="group" aria-label="媒体类型">
            {props.referenceKinds.map(item => (
              <button key={item} type="button" aria-pressed={kind === item} onClick={() => {
                if (kind === item) return;
                setReferenceKind(item);
                resetPage();
              }}>{ASSET_KIND_LABELS[item]}</button>
            ))}
          </div>
        ) : null}
        {section === "uploads" ? <div className="canvas-feature-picker__filters">
          <button type="button" disabled={pending} onClick={() => void chooseFile(null)}>
            <LibTVMediaIcon name="library-q4-upload" size={16} />上传素材
          </button>
        </div> : null}
        <div className="canvas-feature-picker__scroll" aria-busy={pending || (!error && !items)}>
          {referenceMode && props.selectionError ? <p role="alert" className="canvas-feature-picker__empty">
            {props.selectionError}
          </p> : null}
          {error ? <p role="alert" className="canvas-feature-picker__empty">{error}</p> : null}
          {items?.length ? (
            <div className="canvas-feature-picker__grid" data-history={section === "history" || undefined}>
              {items.map(item => <MediaTile key={item.key + ":" + (item.src ?? "")} item={item} kind={kind} disabled={pending} />)}
            </div>
          ) : !error ? <p role="status" className="canvas-feature-picker__empty">
            {items ? "暂无素材" : "正在读取素材…"}
          </p> : null}
        </div>
        {section !== "canvas" && (page > 1 || result?.hasNext) ? (
          <footer>
            <button type="button" disabled={pending || page === 1 || !result} onClick={() => {
              setError(null);
              setResult(null);
              setPage(page - 1);
            }}>上一页</button>
            <span>第 {page} 页</span>
            <button type="button" disabled={pending || !result?.hasNext} onClick={() => {
              if (section === "history" && result?.cursor) setHistoryCursors([...historyCursors.slice(0, page), result.cursor]);
              setError(null);
              setResult(null);
              setPage(page + 1);
            }}>下一页</button>
          </footer>
        ) : null}
      </div>
    </div>
  );
}
