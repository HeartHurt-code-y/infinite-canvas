import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { open } from "@tauri-apps/plugin-dialog";
import { stat } from "@tauri-apps/plugin-fs";
import { ErrorAlert } from "../../components/ErrorAlert";
import { useModalFocusTrap } from "../../components/useModalFocusTrap";
import { localBase64AssetClient, type LocalBase64AssetRecord } from "../../lib/backend";
import { videoPreparationClient } from "../../lib/videoPreparation";
import { VIDEO_CAMERA_NAME_LIMIT, VIDEO_CAMERA_PROMPT_LIMIT, VIDEO_CAMERA_PREVIEW_MAX_BYTES, VIDEO_CAMERA_PREVIEW_MAX_SECONDS, videoCameraPresetIssue, type VideoCameraPreset, type VideoCameraPreviewAsset } from "../../lib/videoCameraPresets";
import { LibTVMediaIcon, LibTVCameraPreviewEmpty } from "./LibTVMediaIcon";

function previewOf(asset: LocalBase64AssetRecord): VideoCameraPreviewAsset {
  if (asset.mediaType !== "image" && asset.mediaType !== "video") throw new Error("运镜预览仅支持图片或视频。");
  return { assetId: asset.id, url: asset.previewUrl, mediaType: asset.mediaType };
}

export function VideoCameraPreview({ preset, playing = false }: {
  readonly preset: Pick<VideoCameraPreset, "image" | "preview">;
  readonly playing?: boolean;
}) {
  const url = preset.preview?.url || preset.image;
  const videoRef = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [url]);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (playing) void video.play().catch(() => {});
    else video.pause();
  }, [playing, url, failed]);
  if (!url || failed) return <span className="video-camera-library__custom" aria-label={failed ? "预览素材不可用" : undefined}><LibTVCameraPreviewEmpty /></span>;
  return preset.preview?.mediaType === "video"
    ? <video ref={videoRef} src={url} muted playsInline loop preload="metadata" onError={() => setFailed(true)} />
    : <img src={url} alt="" loading="lazy" onError={() => setFailed(true)} />;
}

function CameraPreviewLibrary({ onClose, onSelect }: {
  readonly onClose: () => void;
  readonly onSelect: (asset: LocalBase64AssetRecord) => void;
}) {
  const trap = useModalFocusTrap({ active: true, onEscape: onClose });
  const [kind, setKind] = useState<"image" | "video">("image");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const assets = useQuery({
    queryKey: ["video-camera-preview-assets", kind, search, page],
    queryFn: () => localBase64AssetClient.listAssets({ mediaType: kind, name: search.trim() || null, page, pageSize: 24 }),
  });
  return createPortal(<div className="canvas-video-modal-scrim" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={trap.ref} {...trap.containerProps} className="video-camera-library video-camera-library--assets" role="dialog" aria-modal="true" aria-label="素材库" tabIndex={-1}>
      <header><strong>素材库</strong><button type="button" aria-label="关闭素材库" onClick={onClose}><LibTVMediaIcon name="close" /></button></header>
      <div className="video-camera-library__search"><input aria-label="搜索素材" placeholder="搜索素材名称" value={search} onChange={event => { setSearch(event.target.value); setPage(1); }} />
        <button type="button" aria-pressed={kind === "image"} onClick={() => { setKind("image"); setPage(1); }}>图片</button>
        <button type="button" aria-pressed={kind === "video"} onClick={() => { setKind("video"); setPage(1); }}>视频</button>
      </div>
      <div className="video-camera-library__grid" aria-busy={assets.isFetching}>
        {assets.data?.items.map(asset => <button key={asset.id} type="button" className="video-camera-library__use" onClick={() => onSelect(asset)}>
          <VideoCameraPreview preset={{ preview: previewOf(asset) }} /><span>{asset.name}</span>
        </button>)}
        {assets.isPending ? <p role="status">加载中…</p> : !assets.error && !assets.data?.items.length ? <p>暂无素材</p> : null}
      </div>
      {assets.error ? <ErrorAlert error={assets.error} action={<button type="button" onClick={() => { void assets.refetch(); }}>重试</button>} /> : null}
      <footer className="video-camera-library__pagination"><button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button><span>{page}</span><button type="button" disabled={!assets.data || page * assets.data.pageSize >= assets.data.total} onClick={() => setPage(page + 1)}>下一页</button></footer>
    </section>
  </div>, document.body);
}

export function VideoCameraPresetEditor({ preset, onClose, onSave }: {
  readonly preset: VideoCameraPreset;
  readonly onClose: () => void;
  readonly onSave: (preset: VideoCameraPreset) => void;
}) {
  const [name, setName] = useState(preset.name);
  const [prompt, setPrompt] = useState(preset.prompt);
  const [preview, setPreview] = useState(preset.preview);
  const [menu, setMenu] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const active = useRef(true);
  const busy = useRef(false);
  const previewButton = useRef<HTMLButtonElement>(null);
  const previewArea = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const trap = useModalFocusTrap({ active: true, onEscape: () => { if (menu) { setMenu(false); previewButton.current?.focus(); } else onClose(); } });
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !previewArea.current?.contains(event.target)) setMenu(false); };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [menu]);
  const upload = async () => {
    if (busy.current) return;
    busy.current = true;
    setUploading(true); setError(null); setMenu(false);
    try {
      const path = await open({ multiple: false, title: "选择运镜预览", filters: [{ name: "图片或视频", extensions: ["png", "jpg", "jpeg", "mp4"] }] });
      if (!active.current || typeof path !== "string") return;
      if (!/\.(png|jpe?g|mp4)$/i.test(path)) throw new Error("预览仅支持 PNG、JPG、JPEG 或 MP4。");
      const file = await stat(path);
      if (file.size > VIDEO_CAMERA_PREVIEW_MAX_BYTES) throw new Error("预览文件不能超过 20MB。");
      if (/\.mp4$/i.test(path)) {
        const info = await videoPreparationClient.probe({ kind: "local_file", path, mediaType: "video" });
        if (!Number.isFinite(info.durationSeconds) || info.durationSeconds <= 0) throw new Error("无法读取视频时长，请换一个 MP4 文件。");
        if (info.durationSeconds > VIDEO_CAMERA_PREVIEW_MAX_SECONDS) throw new Error("预览视频不能超过 10 秒。");
      }
      if (!active.current) return;
      const imported = await localBase64AssetClient.importAsset({ localPath: path });
      if (active.current) setPreview(previewOf(imported));
    } catch (failure) { if (active.current) setError(failure); }
    finally { busy.current = false; if (active.current) setUploading(false); }
  };
  const nameLength = [...name].length;
  const promptLength = [...prompt].length;
  return createPortal(<div className="canvas-video-modal-scrim" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={trap.ref} {...trap.containerProps} className="video-camera-library video-camera-editor" role="dialog" aria-modal="true" aria-label="自定义运镜" tabIndex={-1}>
      <header><strong>自定义</strong><button type="button" aria-label="关闭自定义运镜" onClick={onClose}><LibTVMediaIcon name="close" size={14} /></button></header>
      <form onSubmit={event => {
        event.preventDefault();
        if (busy.current) return;
        const issue = videoCameraPresetIssue(name, prompt);
        if (issue) { setError(issue); return; }
        try { onSave({ ...preset, name: name.trim(), tagLabel: name.trim(), prompt: prompt.trim(), ...(preview ? { preview } : {}) }); }
        catch (failure) { setError(failure); }
      }}>
        <div className="video-camera-editor__body">
          <div className="video-camera-editor__preview-field"><span id={id + "-preview"}>预览图</span><div ref={previewArea} className="video-camera-editor__preview-area">
            <button ref={previewButton} type="button" className="video-camera-editor__preview" aria-labelledby={id + "-preview"} aria-describedby={id + "-formats"} aria-expanded={menu} disabled={uploading} onClick={() => setMenu(!menu)}>
              <VideoCameraPreview preset={{ ...preset, ...(preview ? { preview } : {}) }} playing />
              {uploading ? <span className="video-camera-editor__uploading" role="status">上传中…</span> : preview?.url || preset.image ? <span className="video-camera-editor__replace"><LibTVMediaIcon name="swap" size={14} />更换预览</span> : null}
            </button>
            {menu ? <div ref={menuRef} className="video-camera-editor__preview-menu"><button type="button" onClick={() => { void upload(); }}>本地上传</button><button type="button" onClick={() => { setMenu(false); setLibraryOpen(true); }}>素材库</button></div> : null}
          </div><span id={id + "-formats"} className="sr-only">支持 PNG、JPG、JPEG 或 MP4，文件不超过 20MB，视频不超过 10 秒。</span></div>
          <div className="video-camera-editor__fields">
            <label>运镜名称<div className="video-camera-editor__input"><input required placeholder="请输入名称" aria-describedby={id + "-name-count"} aria-invalid={nameLength > VIDEO_CAMERA_NAME_LIMIT} value={name} onChange={event => { setName(event.target.value); setError(null); }} /><small id={id + "-name-count"} data-invalid={nameLength > VIDEO_CAMERA_NAME_LIMIT || undefined}>{nameLength}/{VIDEO_CAMERA_NAME_LIMIT}</small></div></label>
            <label>运镜提示词<div className="video-camera-editor__input"><textarea required placeholder="请输入运镜提示词" aria-describedby={id + "-prompt-count"} aria-invalid={promptLength > VIDEO_CAMERA_PROMPT_LIMIT} value={prompt} onChange={event => { setPrompt(event.target.value); setError(null); }} /><small id={id + "-prompt-count"} data-invalid={promptLength > VIDEO_CAMERA_PROMPT_LIMIT || undefined}>{promptLength}/{VIDEO_CAMERA_PROMPT_LIMIT}</small></div></label>
          </div>
        </div>
        {error ? <ErrorAlert error={error} hint="预览选择失败时仍保留原素材；检查内容后重试。" /> : null}
        <footer><button type="submit" className="video-camera-editor__save" disabled={uploading || !!videoCameraPresetIssue(name, prompt)}>保存</button></footer>
      </form>
    </section>
    {libraryOpen ? <CameraPreviewLibrary onClose={() => setLibraryOpen(false)} onSelect={asset => { setPreview(previewOf(asset)); setError(null); setLibraryOpen(false); }} /> : null}
  </div>, document.body);
}
