import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CanvasSelect } from "../../components/CanvasSelect";
import { ErrorAlert } from "../../components/ErrorAlert";
import { useModalFocusTrap } from "../../components/useModalFocusTrap";
import type { MediaReferenceTarget, ProviderCatalogEntry } from "../../lib/backend";
import { prepareCanvasMediaSource } from "../../lib/videoLocalEdit";
import { toMediaProxyUrl } from "../../lib/mediaProxy";
import type { CanvasFeatureAction } from "./canvasFeatureCatalog";
import { atlasLayerProviders, CanvasLayerSeparation } from "./CanvasLayerSeparation";
import { LibTVMediaIcon } from "./LibTVMediaIcon";
import { refreshLocalAssetPreviewUrl } from "./localAssetMedia";

export interface CanvasAtlasToolSession {
  readonly action: Extract<CanvasFeatureAction, { kind: "atlas-tool" }>;
  readonly label: string;
  readonly nodeKey: string;
  readonly sourceLabel: string;
  readonly previewSrc?: string;
  readonly target: MediaReferenceTarget;
}

export interface CanvasAtlasToolOptions {
  readonly providerId: string;
  readonly prompt: string;
  readonly parameters: Record<string, string>;
}

export function CanvasAtlasToolDialog({ session, providers, onSubmit, onClose }: {
  readonly session: CanvasAtlasToolSession;
  readonly providers: readonly ProviderCatalogEntry[];
  readonly onSubmit: (options: CanvasAtlasToolOptions) => Promise<void>;
  readonly onClose: () => void;
}) {
  const title = useId();
  const submitting = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [selectedProvider, setSelectedProvider] = useState("");
  const [resolution, setResolution] = useState("1080p");
  const [sourceImage, setSourceImage] = useState<string | null>(null);
  const atlas = atlasLayerProviders(providers);
  const provider = atlas.find(entry => entry.provider.id === selectedProvider) ?? atlas[0];
  const mode = session.action.mode;
  const trap = useModalFocusTrap({ active: true, onEscape: () => { if (!submitting.current) onClose(); } });
  useEffect(() => {
    if (mode !== "image_layers") return;
    let closed = false;
    let release: (() => Promise<void>) | undefined;
    void prepareCanvasMediaSource(session.target).then(prepared => {
      if (closed) { void prepared.release(); return; }
      release = prepared.release;
      setSourceImage(toMediaProxyUrl(prepared.src) ?? prepared.src);
    }, async failure => {
      if (closed) return;
      const target = session.target;
      const localId = target.kind === "local_base64_asset" ? target.assetId : target.kind === "local_asset" ? target.stagingJobId : null;
      const fallback = session.previewSrc ?? (localId ? await refreshLocalAssetPreviewUrl(localId, "image") : null);
      if (closed) return;
      if (fallback) setSourceImage(toMediaProxyUrl(fallback) ?? fallback);
      else setError(failure);
    });
    return () => { closed = true; void release?.(); };
  }, [mode, session.previewSrc, session.target]);
  async function submit(options: CanvasAtlasToolOptions) {
    if (submitting.current) return;
    submitting.current = true;
    setPending(true);
    setError(null);
    try {
      await onSubmit(options);
      onClose();
    } catch (failure) {
      setError(failure);
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  if (mode === "image_layers") return createPortal(
    <div className="canvas-all-features-scrim">
      <section ref={trap.ref} {...trap.containerProps} className="canvas-feature-layer-dialog" role="dialog" aria-modal="true" aria-labelledby={title}>
        <h2 id={title} className="sr-only">{session.label}</h2>
        {sourceImage ? <CanvasLayerSeparation src={sourceImage} providers={providers} pending={pending} error={error} onClose={onClose}
          onSubmit={(id, prompt) => void submit({ providerId: id, prompt, parameters: {} })} /> : <>
          {error ? <ErrorAlert error={error} /> : <p role="status">正在读取原图…</p>}
          <button type="button" onClick={onClose}>关闭</button>
        </>}
      </section>
    </div>, document.body,
  );
  return createPortal(
    <div className="canvas-all-features-scrim">
      <section ref={trap.ref} {...trap.containerProps} className="canvas-feature-edit"
        role="dialog" aria-modal="true" aria-labelledby={title}>
        <header>
          <h2 id={title}>{session.label}</h2>
          <button type="button" aria-label="关闭" onClick={onClose} disabled={pending}><LibTVMediaIcon name="feature-close" size={16} /></button>
        </header>
        <p>{session.sourceLabel}</p>
        {provider ? <CanvasSelect ariaLabel="供应商" value={provider.provider.id} disabled={pending}
          options={atlas.map(entry => ({ value: entry.provider.id, label: entry.provider.displayName }))}
          onChange={setSelectedProvider} /> : <p>请先在全局设置启用 Atlas Cloud。</p>}
        {mode === "video_upscale" ? <>
          <CanvasSelect ariaLabel="输出分辨率" value={resolution} disabled={pending}
            options={[{ value: "1080p", label: "1080P" }, { value: "2k", label: "2K" }]} onChange={setResolution} />
          <p>1080P 最长 53 秒，2K 最长 23 秒，源视频帧率需在 30 FPS 以内。</p>
        </> : null}
        {error ? <ErrorAlert error={error} /> : null}
        <footer>
          <small>提交后由所选供应商计费。</small>
          <button type="button" disabled={!provider || pending} onClick={() => {
            if (provider) void submit({ providerId: provider.provider.id, prompt: "",
              parameters: mode === "video_upscale" ? { target_resolution: resolution } : {} });
          }}>{pending ? "正在提交…" : "确认生成"}</button>
        </footer>
      </section>
    </div>, document.body,
  );
}
