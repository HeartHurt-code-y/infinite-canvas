import { CheckCircle } from "@phosphor-icons/react/CheckCircle";
import { CircleNotch } from "@phosphor-icons/react/CircleNotch";
import { WarningCircle } from "@phosphor-icons/react/WarningCircle";
import { X } from "@phosphor-icons/react/X";
import { memo, useEffect, useRef, useState, type CSSProperties } from "react";
import { formatBytes } from "../../lib/backend";
import { toMediaProxyUrl } from "../../lib/mediaProxy";
import { AssetKindIcon, NodeTypeIcon } from "./PromptNodeViews";
import type { AssetItem, AssetKind, AssetUploadEntry, RepositoryNodeKind } from "./workspaceModel";
import {
  ASSET_CLOUD_STATUS_LABELS,
  ASSET_KIND_LABELS,
  STAGING_STATUS_LABELS,
  UPLOAD_PHASE_NAMES,
  assetErrorPresentation,
  isStallTrackedStatus,
  isTerminalAssetUpload,
  measuredAspectRatio,
  stagingErrorFullText,
  stagingErrorSummary,
} from "./workspaceModel";

function startVideoPreview(video: HTMLVideoElement | null, fromStart = true) {
  if (video == null || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  if (fromStart) video.currentTime = 0;
  void video.play().catch(() => undefined);
}

function resetVideoPreview(video: HTMLVideoElement | null, resetTo = 0) {
  if (video == null) return;
  video.pause();
  video.currentTime = resetTo;
}

export function AssetMediaState({
  kind,
  state,
}: {
  readonly kind: AssetKind;
  readonly state: "loading" | "unavailable";
}) {
  const label = state === "loading" ? "正在加载预览" : "预览不可用";
  return (
    <span className="asset-card__media-state" data-state={state}>
      <AssetKindIcon kind={kind} size={22} />
      <span>{label}</span>
    </span>
  );
}

function AssetCardVideoVisual({
  asset,
  previewing,
}: {
  readonly asset: AssetItem;
  readonly previewing: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const wasPreviewingRef = useRef(false);
  const videoSrc = toMediaProxyUrl(asset.videoUrl ?? asset.previewUrl ?? null);
  const [loadedVideoSrc, setLoadedVideoSrc] = useState<string | null>(null);
  const videoReady = loadedVideoSrc === videoSrc;
  const [failedVideoSrc, setFailedVideoSrc] = useState<string | null>(null);
  const videoFailed = videoSrc == null || failedVideoSrc === videoSrc;
  const [loadedCoverUrl, setLoadedCoverUrl] = useState<string | null>(null);
  const [failedCoverUrl, setFailedCoverUrl] = useState<string | null>(null);
  const effectiveCoverUrl =
    asset.coverUrl != null && failedCoverUrl !== asset.coverUrl ? asset.coverUrl : null;
  const coverReady = effectiveCoverUrl != null && loadedCoverUrl === effectiveCoverUrl;
  // 供应商封面缺失或加载失败时，抽取视频中间帧作静止封面（与画布素材节点一致）。
  const useVideoCover = effectiveCoverUrl == null && videoSrc != null;
  const coverTimeRef = useRef(0);
  const [videoCoverReady, setVideoCoverReady] = useState(false);
  // 瀑布流布局：量取关键帧封面或视频本身的原始宽高比，贴合卡片视觉区。
  const [intrinsicRatio, setIntrinsicRatio] = useState<number | null>(null);
  const videoClassName = `asset-card__video${videoReady ? " is-ready" : ""}${
    useVideoCover && videoCoverReady ? " is-cover" : ""
  }`;
  const isRealAsset = asset.source != null;
  const mediaReady = coverReady || videoCoverReady;

  useEffect(() => {
    if (previewing) {
      wasPreviewingRef.current = true;
      // 有供应商封面时从头播放；中间帧封面模式下从当前（封面）位置续播。
      startVideoPreview(videoRef.current, !useVideoCover);
    } else if (wasPreviewingRef.current) {
      wasPreviewingRef.current = false;
      resetVideoPreview(videoRef.current, useVideoCover ? coverTimeRef.current : 0);
    }
  }, [previewing, videoSrc, useVideoCover]);

  return (
    <span
      className={`asset-card__visual asset-card__visual--video${previewing ? " is-playing" : ""}`}
      style={intrinsicRatio != null ? { aspectRatio: String(intrinsicRatio) } : undefined}
    >
      {isRealAsset && !mediaReady ? (
        <AssetMediaState
          kind="video"
          state={effectiveCoverUrl == null && videoFailed ? "unavailable" : "loading"}
        />
      ) : null}
      {effectiveCoverUrl ? (
        <img
          className="asset-card__preview"
          src={effectiveCoverUrl}
          alt=""
          loading="lazy"
          onLoad={(event) => {
            const image = event.currentTarget;
            const ratio = measuredAspectRatio(image.naturalWidth, image.naturalHeight);
            if (ratio != null) setIntrinsicRatio(ratio);
            setLoadedCoverUrl(effectiveCoverUrl);
          }}
          onError={() => {
            setLoadedCoverUrl(null);
            setFailedCoverUrl(effectiveCoverUrl);
            const video = videoRef.current;
            if (video != null && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
              setVideoCoverReady(true);
            }
          }}
        />
      ) : null}
      {videoSrc ? (
        <video
          ref={videoRef}
          className={videoClassName}
          src={videoSrc}
          poster={effectiveCoverUrl ?? undefined}
          muted
          loop
          playsInline
          preload={effectiveCoverUrl ? "metadata" : "auto"}
          aria-hidden="true"
          tabIndex={-1}
          onLoadedData={() => {
            setLoadedVideoSrc(videoSrc);
            setFailedVideoSrc(null);
            if (useVideoCover) setVideoCoverReady(true);
          }}
          onError={() => {
            setLoadedVideoSrc(null);
            setFailedVideoSrc(videoSrc);
            setVideoCoverReady(false);
          }}
          onLoadedMetadata={(event) => {
            const video = event.currentTarget;
            const ratio = measuredAspectRatio(video.videoWidth, video.videoHeight);
            if (ratio != null) setIntrinsicRatio(ratio);
            if (!useVideoCover) return;
            if (Number.isFinite(video.duration) && video.duration > 0) {
              coverTimeRef.current = video.duration / 2;
            }
            if (!previewing) video.currentTime = coverTimeRef.current;
          }}
          onSeeked={() => {
            if (useVideoCover) setVideoCoverReady(true);
          }}
        />
      ) : null}
    </span>
  );
}

/** 素材库卡片的全屏源媒体浏览器：保留完整信息，不在窄卡片内截断。 */

function AssetCard({
  asset,
  onPreview,
  onDropToCanvas,
}: {
  readonly asset: AssetItem;
  readonly onPreview: () => void;
  readonly onDropToCanvas: (clientX: number, clientY: number) => void;
}) {
  const typeLabel = ASSET_KIND_LABELS[asset.kind];
  const showCloudBadge = asset.cloudStatus != null && asset.cloudStatus !== "ready";
  const dragged = useRef(false);
  const pointerDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    active: boolean;
  } | null>(null);
  const [pointerDragging, setPointerDragging] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const previewing = asset.kind === "video" && (hovered || focused);
  const [loadedImagePreviewUrl, setLoadedImagePreviewUrl] = useState<string | null>(null);
  const [failedImagePreviewUrl, setFailedImagePreviewUrl] = useState<string | null>(null);
  const imagePreviewReady = asset.previewUrl != null && loadedImagePreviewUrl === asset.previewUrl;
  const imagePreviewFailed = asset.previewUrl == null || failedImagePreviewUrl === asset.previewUrl;
  const isRealAsset = asset.source != null;
  // 瀑布流布局：媒体加载后量取原始宽高比，覆盖视觉区的 4:3 占位比例。
  const [intrinsicRatio, setIntrinsicRatio] = useState<number | null>(null);
  const visualStyle = intrinsicRatio != null ? { aspectRatio: String(intrinsicRatio) } : undefined;

  useEffect(() => {
    const finishPointerDrag = (event: PointerEvent, cancelled: boolean) => {
      const drag = pointerDragRef.current;
      if (drag == null || event.pointerId !== drag.pointerId) return;
      pointerDragRef.current = null;
      setPointerDragging(false);
      if (!drag.active) return;
      event.preventDefault();
      if (!cancelled) onDropToCanvas(event.clientX, event.clientY);
      window.requestAnimationFrame(() => {
        dragged.current = false;
      });
    };
    const handlePointerMove = (event: PointerEvent) => {
      const drag = pointerDragRef.current;
      if (drag == null || event.pointerId !== drag.pointerId) return;
      if (
        !drag.active &&
        Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) >= 6
      ) {
        drag.active = true;
        dragged.current = true;
        setPointerDragging(true);
      }
      if (drag.active) event.preventDefault();
    };
    const handlePointerUp = (event: PointerEvent) => finishPointerDrag(event, false);
    const handlePointerCancel = (event: PointerEvent) => finishPointerDrag(event, true);

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerCancel);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
    };
  }, [onDropToCanvas]);

  return (
    <div
      className={`asset-card${pointerDragging ? " is-dragging" : ""}`}
      role="button"
      tabIndex={0}
      aria-label={`预览${typeLabel}素材详情：${asset.name}`}
      onPointerDown={(event) => {
        if (!event.isPrimary || event.button !== 0) return;
        pointerDragRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          active: false,
        };
      }}
      onClick={() => {
        if (dragged.current) {
          dragged.current = false;
          return;
        }
        setHovered(false);
        onPreview();
      }}
      onMouseEnter={() => {
        if (asset.kind === "video") setHovered(true);
      }}
      onMouseLeave={() => {
        if (asset.kind === "video") setHovered(false);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onPreview();
      }}
      onFocus={() => {
        if (asset.kind === "video") {
          setFocused(true);
        }
      }}
      onBlur={() => {
        if (asset.kind === "video") {
          setFocused(false);
        }
      }}
    >
      {asset.kind === "video" ? (
        <AssetCardVideoVisual asset={asset} previewing={previewing} />
      ) : (
        <span
          className={`asset-card__visual asset-card__visual--${asset.visual}`}
          style={visualStyle}
        >
          {asset.kind === "image" ? (
            <>
              {isRealAsset && !imagePreviewReady ? (
                <AssetMediaState
                  kind="image"
                  state={imagePreviewFailed ? "unavailable" : "loading"}
                />
              ) : null}
              {asset.previewUrl && !imagePreviewFailed ? (
                <img
                  className="asset-card__preview"
                  src={asset.previewUrl}
                  alt=""
                  loading="lazy"
                  onLoad={(event) => {
                    const image = event.currentTarget;
                    const ratio = measuredAspectRatio(image.naturalWidth, image.naturalHeight);
                    if (ratio != null) setIntrinsicRatio(ratio);
                    setLoadedImagePreviewUrl(asset.previewUrl ?? null);
                    setFailedImagePreviewUrl(null);
                  }}
                  onError={() => {
                    setLoadedImagePreviewUrl(null);
                    setFailedImagePreviewUrl(asset.previewUrl ?? null);
                  }}
                />
              ) : null}
            </>
          ) : asset.kind === "audio" ? (
            <span className="waveform" aria-hidden="true">
              {Array.from({ length: 18 }, (_, index) => (
                <i key={index} style={{ "--bar": (index % 5) + 2 } as CSSProperties} />
              ))}
            </span>
          ) : null}
          {showCloudBadge ? (
            <span className="asset-card__status" data-state={asset.cloudStatus}>
              {ASSET_CLOUD_STATUS_LABELS[asset.cloudStatus ?? "unknown"]}
            </span>
          ) : null}
        </span>
      )}
    </div>
  );
}

export const AssetFlow = memo(function AssetFlow({
  assets,
  onPreview,
  onDropToCanvas,
}: {
  readonly assets: readonly AssetItem[];
  readonly onPreview: (asset: AssetItem) => void;
  readonly onDropToCanvas: (asset: AssetItem, clientX: number, clientY: number) => void;
}) {
  return (
    <div className="asset-flow">
      {assets.map((asset) => (
        <AssetCard
          key={asset.id}
          asset={asset}
          onPreview={() => onPreview(asset)}
          onDropToCanvas={(clientX, clientY) => onDropToCanvas(asset, clientX, clientY)}
        />
      ))}
    </div>
  );
});

/**
 * 节点仓库卡片：按指针事件实现拖拽（与素材卡片一致）。
 * Tauri WebView 下 HTML5 原生拖拽会被系统拖放处理器拦截，因此不能依赖
 * draggable + dataTransfer；指针拖拽在桌面与浏览器环境都可靠。
 * 单击（未发生拖动）等价于在画布中心创建节点。
 */
export function RepositoryCard({
  nodeType,
  label,
  onAddToCanvas,
  onDropToCanvas,
}: {
  readonly nodeType: RepositoryNodeKind;
  readonly label: string;
  readonly onAddToCanvas: () => void;
  readonly onDropToCanvas: (clientX: number, clientY: number) => void;
}) {
  const dragged = useRef(false);
  const pointerDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    active: boolean;
  } | null>(null);
  const [pointerDragging, setPointerDragging] = useState(false);

  useEffect(() => {
    const finishPointerDrag = (event: PointerEvent, cancelled: boolean) => {
      const drag = pointerDragRef.current;
      if (drag == null || event.pointerId !== drag.pointerId) return;
      pointerDragRef.current = null;
      setPointerDragging(false);
      if (!drag.active) return;
      event.preventDefault();
      if (!cancelled) onDropToCanvas(event.clientX, event.clientY);
      window.requestAnimationFrame(() => {
        dragged.current = false;
      });
    };
    const handlePointerMove = (event: PointerEvent) => {
      const drag = pointerDragRef.current;
      if (drag == null || event.pointerId !== drag.pointerId) return;
      if (
        !drag.active &&
        Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) >= 6
      ) {
        drag.active = true;
        dragged.current = true;
        setPointerDragging(true);
      }
      if (drag.active) event.preventDefault();
    };
    const handlePointerUp = (event: PointerEvent) => finishPointerDrag(event, false);
    const handlePointerCancel = (event: PointerEvent) => finishPointerDrag(event, true);

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerCancel);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
    };
  }, [onDropToCanvas]);

  return (
    <div
      className={`repository-card repository-card--${nodeType}${pointerDragging ? " is-dragging" : ""}`}
      role="button"
      tabIndex={0}
      aria-label={`拖拽创建${label}节点`}
      onPointerDown={(event) => {
        if (!event.isPrimary || event.button !== 0) return;
        pointerDragRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          active: false,
        };
      }}
      onClick={() => {
        if (dragged.current) {
          dragged.current = false;
          return;
        }
        onAddToCanvas();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onAddToCanvas();
      }}
    >
      <span className="repository-card__icon">
        <NodeTypeIcon kind={nodeType} size={18} />
      </span>
      <span className="repository-card__body">
        <span className="repository-card__label">{label}</span>
      </span>
    </div>
  );
}

export function AssetUploadRow({
  entry,
  onDismiss,
}: {
  readonly entry: AssetUploadEntry;
  readonly onDismiss: () => void;
}) {
  const isTerminal = isTerminalAssetUpload(entry);
  const progressLabel =
    entry.bytesTotal != null
      ? `${formatBytes(entry.bytesUploaded) ?? "0 B"} / ${formatBytes(entry.bytesTotal) ?? "?"}`
      : (formatBytes(entry.bytesUploaded) ?? "准备中…");
  const progressPercent =
    entry.bytesTotal != null && entry.bytesTotal > 0
      ? Math.min(100, Math.round((entry.bytesUploaded / entry.bytesTotal) * 100))
      : null;
  const isStalled = entry.stalled && isStallTrackedStatus(entry.status);
  // 两段进度：① 对象存储直传（preparing/validating/authorizing/uploading，有字节进度）；
  // ② 素材库导入（staged/importing → active/cleaned，仅云端素材）。
  const isObjectStoragePhase =
    entry.status === "preparing" ||
    entry.status === "validating" ||
    entry.status === "authorizing" ||
    entry.status === "uploading";
  const hasFailed = entry.status === "failed" || entry.status === "interrupted";
  const objectStorageValue = hasFailed
    ? "失败"
    : entry.status === "preparing"
      ? "准备中…"
      : isObjectStoragePhase
        ? `${STAGING_STATUS_LABELS[entry.status]}${progressPercent != null ? ` ${progressPercent}%` : ""} · ${progressLabel}`
        : "已完成";
  const showAssetImportPhase = entry.destination === "cloud";
  const assetImportInProgress = entry.status === "staged" || entry.status === "importing";
  const assetImportDone = entry.status === "active" || entry.status === "cleaned";
  // 素材库导入字节进度：海外路径在 importing 期间由后端推进（bytesTotal = 2×文件大小，
  // 下载 + 上传）；国内路径（/v1/assets/async 平台侧拉取）无字节进度，bytes 保持对象
  // 存储阶段的值（bytesUploaded ≥ bytesTotal），因此走"平台处理中"。
  const assetImportHasByteProgress =
    entry.status === "importing" &&
    entry.bytesTotal != null &&
    entry.bytesTotal > 0 &&
    entry.bytesUploaded < entry.bytesTotal;
  const assetImportPercent =
    assetImportHasByteProgress && entry.bytesTotal != null
      ? Math.min(100, Math.round((entry.bytesUploaded / entry.bytesTotal) * 100))
      : null;
  const assetImportValue = hasFailed
    ? "失败"
    : assetImportInProgress
      ? assetImportHasByteProgress
        ? `上传中 ${assetImportPercent}%`
        : entry.status === "importing"
          ? "平台处理中…"
          : "上传中…"
      : assetImportDone
        ? "已完成"
        : "等待中";
  // 折叠态展示人类可读摘要；展开态展示后端返回的完整原始错误（JSON，含
  // message/kind/details/rawResponse/httpStatus 等全部诊断字段）。
  const errorSummary =
    entry.status === "failed" || entry.status === "interrupted"
      ? stagingErrorSummary(entry.error)
      : null;
  const errorDetail =
    entry.status === "failed" || entry.status === "interrupted"
      ? stagingErrorFullText(entry.error)
      : null;
  const [errorExpanded, setErrorExpanded] = useState(false);
  // 完整原始错误过长才提供折叠/展开；摘要本身也可能被 -webkit-line-clamp 收成两行。
  const showErrorToggle = errorDetail != null && errorDetail.length > 80;

  return (
    <li className="asset-upload" data-state={entry.status}>
      <span className="asset-upload__icon" aria-hidden="true">
        {isTerminal ? (
          entry.status === "active" || entry.status === "cleaned" || entry.status === "staged" ? (
            <CheckCircle size={15} weight="fill" />
          ) : (
            <WarningCircle size={15} weight="fill" />
          )
        ) : (
          <CircleNotch size={15} weight="bold" />
        )}
      </span>
      <span className="asset-upload__body">
        <span className="asset-upload__name">{entry.name}</span>
        <span className="asset-upload__status">
          <span className="asset-upload__phase">
            <span className="asset-upload__phase-name">{UPLOAD_PHASE_NAMES.objectStorage}</span>
            <span className="asset-upload__phase-value">{objectStorageValue}</span>
          </span>
          {showAssetImportPhase ? (
            <span className="asset-upload__phase">
              <span className="asset-upload__phase-name">{UPLOAD_PHASE_NAMES.assetImport}</span>
              <span className="asset-upload__phase-value">{assetImportValue}</span>
            </span>
          ) : null}
        </span>
        {isStalled ? (
          <span className="asset-upload__stalled" role="status">
            上传长时间无进展，疑似网络中断或后端无响应，等待超时判定…
          </span>
        ) : null}
        {errorExpanded && errorDetail != null ? (
          <span className="asset-upload__error asset-upload__error-detail" role="alert">
            {errorDetail}
          </span>
        ) : errorSummary != null ? (
          <span className="asset-upload__error" role="alert">
            {errorSummary}
          </span>
        ) : null}
        {showErrorToggle ? (
          <button
            type="button"
            className="asset-upload__error-toggle"
            aria-expanded={errorExpanded}
            onClick={() => setErrorExpanded((value) => !value)}
          >
            {errorExpanded ? "收起" : "展开完整报错"}
          </button>
        ) : null}
        {progressPercent != null && !isTerminal && isObjectStoragePhase ? (
          <span className="asset-upload__bar" aria-hidden="true">
            <i style={{ width: `${progressPercent}%` }} />
          </span>
        ) : null}
        {showAssetImportPhase && assetImportInProgress ? (
          assetImportHasByteProgress ? (
            <span className="asset-upload__bar" aria-hidden="true">
              <i style={{ width: `${assetImportPercent ?? 0}%` }} />
            </span>
          ) : (
            <span
              className="asset-upload__bar asset-upload__bar--indeterminate"
              aria-hidden="true"
            >
              <i />
            </span>
          )
        ) : null}
      </span>
      {isTerminal ? (
        <button
          type="button"
          className="asset-upload__dismiss"
          aria-label={`移除上传记录：${entry.name}`}
          onClick={onDismiss}
        >
          <X size={13} weight="bold" aria-hidden="true" />
        </button>
      ) : null}
    </li>
  );
}

export function AssetPanelError({
  title,
  error,
  actionLabel,
  onAction,
}: {
  readonly title: string;
  readonly error: string;
  readonly actionLabel?: string | undefined;
  readonly onAction?: (() => void) | undefined;
}) {
  const presentation = assetErrorPresentation(error);
  return (
    <div className="asset-panel__error" role="alert">
      <div className="asset-panel__error-heading">
        <WarningCircle size={18} weight="fill" aria-hidden="true" />
        <strong>{title}</strong>
      </div>
      <p className="asset-panel__error-summary">{presentation.summary}</p>
      <details className="asset-panel__error-details">
        <summary>完整技术详情</summary>
        <pre tabIndex={0}>{presentation.details}</pre>
      </details>
      {actionLabel && onAction ? (
        <button type="button" onClick={onAction}>
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}
