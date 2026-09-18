import { Icon } from "../../components/Icon";
import { memo, useEffect, useRef, useState, type CSSProperties } from "react";
import {
  formatBytes,
  refreshAssetItemCoverUrl,
  refreshMediaUrlWithStagingFallback,
} from "../../lib/backend";
import { toMediaProxyUrl } from "../../lib/mediaProxy";
import { AssetKindIcon } from "./PromptNodeViews";
import { copyTextToDesktopClipboard } from "./desktopActions";
import { useRecoveredPreviewUrl } from "./assetPreviewRecovery";
import { assetMediaByteIdentity, useMediaByteSource, type MediaByteSource } from "./mediaByteCache";
import type { AssetItem, AssetKind, AssetUploadEntry } from "./workspaceModel";
import {
  ASSET_CLOUD_STATUS_LABELS,
  ASSET_KIND_LABELS,
  STAGING_STATUS_LABELS,
  UPLOAD_ABANDONED_TICK_MS,
  UPLOAD_PHASE_NAMES,
  abandonedUploadError,
  assetErrorPresentation,
  isAbandonedAssetUpload,
  isStallTrackedStatus,
  isTerminalAssetUpload,
  measuredAspectRatio,
  stagingErrorFullText,
  stagingErrorSummary,
  stagingImportReachedLibrary,
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
      <AssetKindIcon kind={kind} size="xl" />
      <span>{label}</span>
    </span>
  );
}

/**
 * 按素材身份取用会话内已下载的预览字节。
 *
 * 两份用途独立缓存：图片正文与视频封面是两份不同内容（同一素材 ID、不同 `kind`）。
 * 没有素材身份（占位条目）时直接沿用远端地址，不进入缓存。
 */
function useAssetMediaBytes(
  asset: AssetItem,
  kind: AssetKind,
  mediaUrl: string | null,
): MediaByteSource {
  const identity = assetMediaByteIdentity(asset);
  return useMediaByteSource(identity?.assetId ?? "", kind, mediaUrl);
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
  // 播放地址签名过期时向后端续签一次得到的新地址；未刷新时用列表原始地址。
  const [refreshedVideoUrl, setRefreshedVideoUrl] = useState<string | null>(null);
  const playbackRefreshAttemptedRef = useRef(false);
  // 列表没给播放地址时按素材身份补取一次（同一素材整个会话只补一次）。
  const recoveredVideoUrl = useRecoveredPreviewUrl(
    asset,
    "video",
    asset.videoUrl ?? asset.previewUrl,
  );
  const candidateVideoUrl =
    refreshedVideoUrl ?? recoveredVideoUrl ?? asset.videoUrl ?? asset.previewUrl ?? null;
  const videoSrc = toMediaProxyUrl(candidateVideoUrl, { assetId: asset.id });
  const [loadedVideoSrc, setLoadedVideoSrc] = useState<string | null>(null);
  const videoReady = loadedVideoSrc === videoSrc;
  const [failedVideoSrc, setFailedVideoSrc] = useState<string | null>(null);
  const videoFailed = videoSrc == null || failedVideoSrc === videoSrc;
  const [loadedCoverUrl, setLoadedCoverUrl] = useState<string | null>(null);
  const [failedCoverUrl, setFailedCoverUrl] = useState<string | null>(null);
  // 供应商封面签名过期时向后端续签一次得到的新封面地址；未刷新时保持原始封面。
  const [refreshedCoverUrl, setRefreshedCoverUrl] = useState<string | null>(null);
  // 每个卡片实例只尝试续签一次，新封面仍失败时直接回退视频中间帧，避免反复请求。
  const coverRefreshAttemptedRef = useRef(false);
  const candidateCoverUrl = refreshedCoverUrl ?? asset.coverUrl;
  const effectiveCoverUrl =
    candidateCoverUrl != null && failedCoverUrl !== candidateCoverUrl ? candidateCoverUrl : null;
  // 封面与海报帧同样走媒体代理，避免 WebView 对跨域签名地址的 CORS/混合内容限制；
  // 封面字节按素材身份缓存在本地，重开面板不再重复下载（签名过期也不影响已经下载过的封面）。
  const coverBytes = useAssetMediaBytes(asset, "video", effectiveCoverUrl);
  const coverSrc = coverBytes.url;
  const coverLoaded = effectiveCoverUrl != null && loadedCoverUrl === effectiveCoverUrl;
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
  const mediaReady = coverLoaded || videoCoverReady;

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
      {coverSrc != null ? (
        <img
          className="asset-card__preview"
          src={coverSrc}
          alt=""
          loading="lazy"
          onLoad={(event) => {
            const image = event.currentTarget;
            const ratio = measuredAspectRatio(image.naturalWidth, image.naturalHeight);
            if (ratio != null) setIntrinsicRatio(ratio);
            setLoadedCoverUrl(effectiveCoverUrl);
          }}
          onError={() => {
            const failedUrl = effectiveCoverUrl;
            setLoadedCoverUrl(null);
            setFailedCoverUrl(failedUrl);
            // 当前地址加载失败：本地副本坏了就重下一次，远端地址失败则先在本地字节里找一次。
            coverBytes.retry();
            if (coverBytes.fromCache) return;
            // 封面签名过期：首次失败时向后端续签一次新封面（云端回读供应商记录、
            // 本地重签对象存储地址）；续签失败或新封面仍无法加载时回退视频中间帧
            // （与画布素材节点一致）。
            if (failedUrl != null && !coverRefreshAttemptedRef.current) {
              coverRefreshAttemptedRef.current = true;
              void refreshAssetItemCoverUrl(asset).then((freshUrl) => {
                if (freshUrl != null && freshUrl !== "" && freshUrl !== failedUrl) {
                  setRefreshedCoverUrl(freshUrl);
                  setFailedCoverUrl(null);
                }
              });
            }
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
          poster={coverSrc ?? undefined}
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
            // 播放地址签名过期：每个卡片实例续签一次（云端回读供应商记录、本地重签
            // 对象存储地址，与封面续签相互独立），拿到新地址后重新加载；
            // 上游把导入时的暂存租约地址当预览地址回放时续签不会换地址，共享入口会继续
            // 按对象键重签暂存副本（暂存对象已被清理时由媒体代理用导入的原始文件接管）。
            // 续签失败保持置灰，不反复请求。视频正文不落字节缓存，按需播放。
            if (candidateVideoUrl != null && !playbackRefreshAttemptedRef.current) {
              playbackRefreshAttemptedRef.current = true;
              void refreshMediaUrlWithStagingFallback(asset, "video", candidateVideoUrl).then(
                (freshUrl) => {
                  if (freshUrl != null && freshUrl !== "" && freshUrl !== candidateVideoUrl) {
                    setRefreshedVideoUrl(freshUrl);
                    setFailedVideoSrc(null);
                  }
                },
              );
            }
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
  // 图片预览签名过期时向后端续签一次得到的新地址；每个卡片实例只尝试一次。
  const [refreshedImagePreviewUrl, setRefreshedImagePreviewUrl] = useState<string | null>(null);
  const imageRefreshAttemptedRef = useRef(false);
  // 列表没给预览地址时按素材身份补取一次（同一素材整个会话只补一次）。
  const recoveredImagePreviewUrl = useRecoveredPreviewUrl(
    asset,
    "image",
    refreshedImagePreviewUrl ?? asset.previewUrl,
  );
  const candidateImagePreviewUrl =
    refreshedImagePreviewUrl ?? recoveredImagePreviewUrl ?? asset.previewUrl;
  // 已下载过的预览字节直接复用：重开面板、切换类型/翻页回来后不再重复下载，
  // 签名过期也不影响已经下载过的那份内容。
  const imageBytes = useAssetMediaBytes(asset, "image", candidateImagePreviewUrl ?? null);
  const imagePreviewSrc = imageBytes.url;
  const imagePreviewReady = imagePreviewSrc != null && loadedImagePreviewUrl === imagePreviewSrc;
  // 失败记账跟「正在渲染的 src」走，而不是跟列表里的签名地址走：字节缓存把 src 从代理
  // 地址换成 blob 后，旧地址的 onError 不能把已经到手的预览打成「预览不可用」。
  // 列表没给预览地址时只要素材身份还能拼出代理地址，也不再立刻显示不可用。
  const imagePreviewFailed = imagePreviewSrc == null || failedImagePreviewUrl === imagePreviewSrc;
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
                  state={imagePreviewFailed && !imageBytes.fromCache ? "unavailable" : "loading"}
                />
              ) : null}
              {imagePreviewSrc != null && (!imagePreviewFailed || imageBytes.fromCache) ? (
                <img
                  className="asset-card__preview"
                  src={imagePreviewSrc}
                  alt=""
                  loading="lazy"
                  onLoad={(event) => {
                    const image = event.currentTarget;
                    const ratio = measuredAspectRatio(image.naturalWidth, image.naturalHeight);
                    if (ratio != null) setIntrinsicRatio(ratio);
                    setLoadedImagePreviewUrl(imagePreviewSrc);
                    setFailedImagePreviewUrl(null);
                  }}
                  onError={() => {
                    setLoadedImagePreviewUrl(null);
                    setFailedImagePreviewUrl(imagePreviewSrc);
                    // 当前地址加载失败：本地副本坏了就重下一次，远端地址失败则先在本地字节里找一次。
                    imageBytes.retry();
                    if (imageBytes.fromCache) return;
                    // 预览签名过期：每个卡片实例续签一次（云端回读供应商记录、
                    // 本地重签对象存储地址）。上游把导入时的暂存租约地址当预览地址回放时
                    // 续签不会换地址，共享入口会继续按对象键重签暂存副本；暂存对象已被清理
                    // 时由媒体代理用导入时留存的原始文件接管，预览不再永久停在「不可用」。
                    if (!imageRefreshAttemptedRef.current) {
                      imageRefreshAttemptedRef.current = true;
                      void refreshMediaUrlWithStagingFallback(
                        asset,
                        "image",
                        candidateImagePreviewUrl,
                      ).then((freshUrl) => {
                        if (
                          freshUrl != null &&
                          freshUrl !== "" &&
                          freshUrl !== candidateImagePreviewUrl
                        ) {
                          setRefreshedImagePreviewUrl(freshUrl);
                          setFailedImagePreviewUrl(null);
                        }
                      });
                    }
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

export function AssetUploadRow({
  entry,
  onDismiss,
}: {
  readonly entry: AssetUploadEntry;
  readonly onDismiss: () => void;
}) {
  /**
   * 僵尸判定：非终态但长时间完全没有推进的上传（执行它的后端进程已经不在了，
   * 例如应用重启、导入途中退出）。真机反馈：这种行会一直转圈，而且非终态行不给
   * 移除按钮，用户「想关也关不掉」。
   *
   * 判定放在行内部、用自己的计时器重算，而不是只依赖轮询把状态改成 interrupted：
   * 轮询数据可能因为查询键/观察者变化停止更新，行内的时钟不会。判定窗口由
   * `UPLOAD_ABANDONED_MS` 给出（默认两分钟），到点后这一行自动变成可移除的已中断行。
   */
  const [now, setNow] = useState(() => Date.now());
  const abandoned = isAbandonedAssetUpload(entry, now);
  // 依赖里只放"阶段"而不是整个 entry：轮询每秒都会产出新对象，
  // 若按 entry 重注册计时器，等于每秒重启一次自检，永远等不到判定窗口。
  const entryStatus = entry.status;
  useEffect(() => {
    const timer = window.setInterval(() => {
      // 只在时间真的变了才 setState：避免同值更新触发无意义重渲染（也让测试里
      // 同步触发的计时器不会陷入"更新→重渲染→再更新"的循环）。
      setNow((previous) => {
        const current = Date.now();
        return current === previous ? previous : current;
      });
    }, UPLOAD_ABANDONED_TICK_MS);
    return () => window.clearInterval(timer);
  }, [entryStatus]);
  // 僵尸行按「已中断」呈现并给出移除入口：不改后端事实，只把这一行落地为终态。
  const status = abandoned ? ("interrupted" as const) : entry.status;
  const isTerminal = isTerminalAssetUpload({ ...entry, status });
  const progressLabel =
    entry.bytesTotal != null
      ? `${formatBytes(entry.bytesUploaded) ?? "0 B"} / ${formatBytes(entry.bytesTotal) ?? "?"}`
      : (formatBytes(entry.bytesUploaded) ?? "准备中…");
  const progressPercent =
    entry.bytesTotal != null && entry.bytesTotal > 0
      ? Math.min(100, Math.round((entry.bytesUploaded / entry.bytesTotal) * 100))
      : null;
  const isStalled = !abandoned && entry.stalled && isStallTrackedStatus(status);
  // 两段进度：① 对象存储直传（preparing/validating/authorizing/uploading，有字节进度）；
  // ② 素材库导入（staged/importing → active/cleaned，仅云端素材）。
  const isObjectStoragePhase =
    status === "preparing" ||
    status === "validating" ||
    status === "authorizing" ||
    status === "uploading";
  const hasFailed = status === "failed" || status === "interrupted";
  const objectStorageValue = hasFailed
    ? "失败"
    : status === "preparing"
      ? "准备中…"
      : isObjectStoragePhase
        ? `${STAGING_STATUS_LABELS[status]}${progressPercent != null ? ` ${progressPercent}%` : ""} · ${progressLabel}`
        : "已完成";
  const showAssetImportPhase = entry.destination === "cloud";
  const assetImportInProgress = status === "staged" || status === "importing";
  // 入库是否成功看素材身份而不是状态：后端给出素材身份后还会清理暂存对象
  // （active → cleaning → cleaned），清理没走完的记录同样是成功。
  const assetImportDone = stagingImportReachedLibrary(entry);
  // 素材库导入字节进度：海外路径在 importing 期间由后端推进（bytesTotal = 2×文件大小，
  // 下载 + 上传）；国内路径（/v1/assets/async 平台侧拉取）无字节进度，bytes 保持对象
  // 存储阶段的值（bytesUploaded ≥ bytesTotal），因此走"平台处理中"。
  const assetImportHasByteProgress =
    status === "importing" &&
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
        : status === "importing"
          ? "平台处理中…"
          : "上传中…"
      : assetImportDone
        ? "已完成"
        : "等待中";
  // 折叠态展示人类可读摘要；展开态展示后端返回的完整原始错误（JSON，含
  // message/kind/details/rawResponse/httpStatus 等全部诊断字段）。
  const errorSummary = hasFailed
    ? stagingErrorSummary(abandoned ? abandonedUploadError(entry.status) : entry.error)
    : null;
  const errorDetail = hasFailed
    ? stagingErrorFullText(abandoned ? abandonedUploadError(entry.status) : entry.error)
    : null;
  const [errorExpanded, setErrorExpanded] = useState(false);
  const [errorCopied, setErrorCopied] = useState(false);
  // 完整原始错误过长才提供折叠/展开；摘要本身也可能被 -webkit-line-clamp 收成两行。
  const showErrorToggle = errorDetail != null && errorDetail.length > 80;

  return (
    <li className="asset-upload" data-state={status}>
      <span className="asset-upload__icon" aria-hidden="true">
        {isTerminal ? (
          assetImportDone || status === "staged" ? (
            <Icon name="check-circle" size="md" />
          ) : (
            <Icon name="warning-circle" size="md" />
          )
        ) : (
          <Icon name="circle-notch" size="md" />
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
        {entry.adjustment != null ? (
          <span className="asset-upload__adjustment" role="status">
            {entry.adjustment}
          </span>
        ) : null}
        {errorExpanded && errorDetail != null ? (
          <span className="asset-upload__error-detail-wrapper">
            <span className="asset-upload__error asset-upload__error-detail" role="alert">
              {errorDetail}
            </span>
            <button
              type="button"
              className="asset-upload__error-copy"
              aria-label={errorCopied ? "已复制报错" : "复制完整报错"}
              title={errorCopied ? "已复制" : "复制完整报错"}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                void (async () => {
                  try {
                    await copyTextToDesktopClipboard(errorDetail);
                    setErrorCopied(true);
                    window.setTimeout(() => setErrorCopied(false), 2000);
                  } catch {
                    // 剪贴板不可用时静默失败
                  }
                })();
              }}
            >
              {errorCopied ? (
                <Icon name="check" aria-hidden="true" size="xs" />
              ) : (
                <Icon name="copy-simple" aria-hidden="true" size="xs" />
              )}
              {errorCopied ? "已复制" : "复制"}
            </button>
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
            <span className="asset-upload__bar asset-upload__bar--indeterminate" aria-hidden="true">
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
          <Icon name="x" aria-hidden="true" size="sm" />
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
        <Icon name="warning-circle" aria-hidden="true" size="lg" />
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
