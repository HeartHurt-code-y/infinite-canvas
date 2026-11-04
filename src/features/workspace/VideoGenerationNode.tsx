import { useCallback, useEffect, useRef, useState } from "react";
import { ErrorAlert } from "../../components/ErrorAlert";
import { CanvasImageIcon } from "./CanvasImageIcons";
import { LibTVMediaIcon } from "./LibTVMediaIcon";
import { CanvasVideoResultActions } from "./CanvasVideoResultActions";
import { CanvasSeedanceDraftAction } from "./CanvasSeedanceDraftAction";
import { CanvasVideoFrameCrop } from "./CanvasVideoFrameCrop";
import type { CanvasInlineFeatureRequest } from "./canvasFeatureCatalog";
import { CanvasImageResultActions } from "./CanvasImageResultActions";
import { CanvasImageInlineEditor, type CanvasImageTransform } from "./CanvasImageInlineEditor";
import { CanvasImageRegionEditor, type StartImageRegionEdit } from "./CanvasImageRegionEditor";
import { isDesktopRuntime, toMediaSrc, type GenerationTaskSummary } from "../../lib/backend";
import { toMediaProxyUrl } from "../../lib/mediaProxy";
import type { PromptContentModule } from "../../lib/promptContent";
import { validateArtifactName } from "./artifactNames";
import { VideoMiddleFrame } from "./VideoMiddleFrame";
import { useNodeInView } from "./mediaPreview";
import { useLocalVideoPoster } from "./localVideoPoster";
import { imageGenerationSlots } from "./imageNodeResults";
import {
  TASK_STATUS_LABELS,
  isRunningTaskStatus,
  type CanvasNodeDimensions,
  type ConnectedAssetInput,
  type GenNodeData,
  type InheritedAssetInput,
  type OutputNodeData,
} from "./workspaceModel";
import "./VideoGenerationNode.css";

/**
 * 标题条上的节点标题（可改名）。
 *
 * 原站 liblib 的标题文字本身就是可改的：`text-[13px] cursor-text pointer-events-auto`，
 * 点一下就地编辑，没有单独的「改名」按钮。这里照抄那个交互——点标题变成输入框，
 * 回车保存、Esc 取消。
 */
export function CanvasNodeTitle({
  title,
  onRename,
}: {
  readonly title: string;
  readonly onRename: ((name: string) => void) | undefined;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [error, setError] = useState<string | null>(null);
  if (!onRename) {
    return (
      <span className="canvas-node-toolbar__label" title={title}>
        {title}
      </span>
    );
  }
  if (!editing) {
    return (
      <button
        type="button"
        className="canvas-node-toolbar__label canvas-node-toolbar__label--editable"
        aria-label="修改生成节点名称"
        title={title}
        onClick={(event) => {
          event.stopPropagation();
          setDraft(title);
          setError(null);
          setEditing(true);
        }}
      >
        {title}
      </button>
    );
  }
  const save = () => {
    const validation = validateArtifactName(draft);
    if (validation) {
      setError(validation);
      return;
    }
    onRename(draft.trim());
    setEditing(false);
    setError(null);
  };
  return (
    <span className="canvas-node-toolbar__editor nodrag nopan nowheel">
      <input
        autoFocus
        aria-label="修改生成节点名称"
        value={draft}
        maxLength={80}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "Enter") {
            event.preventDefault();
            save();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            setEditing(false);
            setError(null);
          }
        }}
      />
      <button type="button" onClick={save}>
        保存名称
      </button>
      <button
        type="button"
        onClick={() => {
          setEditing(false);
          setError(null);
        }}
      >
        取消
      </button>
      {error ? (
        <ErrorAlert error={error} variant="inline" hint="改好名称后再保存。" />
      ) : null}
    </span>
  );
}

export function CanvasMediaNodeTitle({ kind, title, pixelSize, onRename, processing = false }: {
  readonly kind: "image" | "video";
  readonly title: string;
  readonly pixelSize?: { readonly width: number; readonly height: number } | null;
  readonly onRename?: ((name: string) => void) | undefined;
  readonly processing?: boolean;
}) {
  const dimensions = pixelSize ? `${pixelSize.width} × ${pixelSize.height}` : null;
  return <div className="canvas-node-toolbar canvas-node-toolbar--media">
    <span className="canvas-node-toolbar__type">
      <LibTVMediaIcon name={kind === "video" ? "icon-play-filled-small" : "icon-image-filled"}
        className="canvas-node-toolbar__icon" size={14} />
      <CanvasNodeTitle title={title} onRename={onRename} />
    </span>
    {processing ? <span className="canvas-node-toolbar__size">云端处理中</span> :
      dimensions ? <span className="canvas-node-toolbar__size">{dimensions}</span> : null}
  </div>;
}

export function MediaNodeTaskStatus({
  task,
  starting,
  tasks,
  onOpenTask,
  hasResult = false,
  kind = "video",
}: {
  readonly kind?: "image" | "video" | "audio";
  readonly task: GenerationTaskSummary | null;
  readonly starting: boolean;
  readonly hasResult?: boolean;
  readonly tasks?: readonly GenerationTaskSummary[] | undefined;
  readonly onOpenTask?: ((taskId: string) => void) | undefined;
}) {
  const items = tasks?.length ? tasks : task ? [task] : [];
  const running = items.filter(item => isRunningTaskStatus(item.status) && item.queryHealth !== "degraded");
  const failed = items.filter(generationTaskNeedsAttention);
  const succeeded = items.filter(item => item.status === "succeeded").length;
  const cancelled = items.filter(item => item.status === "cancelled").length;
  const busy = starting || running.length > 0;
  const displayTask = task ?? running[0] ?? failed[0] ?? items[0];
  const progress =
    displayTask?.progress == null || items.length > 1 ? null : Math.min(100, Math.max(0, Math.round(displayTask.progress)));
  const label = items.length > 1
    ? [running.length ? `${running.length} 个进行中` : "", succeeded ? `${succeeded} 个已完成` : "", failed.length ? `${failed.length} 个需处理` : "", cancelled ? `${cancelled} 个已取消` : ""].filter(Boolean).join(" · ")
    : starting ? "提交中…" : displayTask ? generationTaskStateText(displayTask) : hasResult ? "已生成" : "待生成";
  return (
    <div className="video-node-status" role="status" aria-live="polite">
      <LibTVMediaIcon name={busy ? "icon-loading" : failed.length ? "warning-circle-filled" : "check"}
        className={busy ? "spin-icon" : ""} size={12} />
      <span>
        {label}
      </span>
      {progress != null ? <strong>{progress}%</strong> : null}
      {displayTask && busy ? (
        <span
          className="video-node-status__progress"
          role="progressbar"
          aria-label={`${kind === "image" ? "图片" : kind === "audio" ? "音频" : "视频"}节点生成进度`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress ?? undefined}
        >
          <i className={progress == null ? "is-indeterminate" : undefined} style={progress == null ? undefined : { width: `${progress}%` }} />
        </span>
      ) : null}
      {displayTask && onOpenTask ? <button type="button" className="video-node-status__details nodrag nopan" aria-label="查看生成任务"
        onMouseDown={event => event.stopPropagation()}
        onClick={event => { event.stopPropagation(); onOpenTask(failed[0]?.id ?? displayTask.id); }}>查看任务</button> : null}
    </div>
  );
}

export function generationTaskStateText(task: GenerationTaskSummary | null): string {
  if (!task) return "正在读取任务…";
  if (task.queryHealth === "degraded") return "查询已停止";
  return TASK_STATUS_LABELS[task.status] ?? "正在生成";
}

export function generationTaskNeedsAttention(task: GenerationTaskSummary): boolean {
  return task.status === "failed" || task.status === "interrupted" || task.status === "unknown" || task.queryHealth === "degraded";
}

export function nodeStatusTasks(
  tasks: readonly GenerationTaskSummary[],
  latestTask: GenerationTaskSummary | null | undefined,
): readonly GenerationTaskSummary[] {
  return tasks.filter(task => isRunningTaskStatus(task.status) ||
    (task.id === latestTask?.id && generationTaskNeedsAttention(task)));
}

export function MediaGenerationPreview({
  node,
  selected,
  editing,
  starting,
  activeTask,
  latestTask,
  tasks,
  onOpenTask,
  inputs,
  onPromoteSeedanceDraft,
  output,
  startError,
  onSelect,
  onEdit,
  onNodeDragStart,
  onSizeChange,
  onRename,
  onVideoPreset,
  onImagePreset,
  onSelectImageResult,
  onPreviewResult,
  onEnhanceImage,
  onEditImageRegion,
  providerCatalog,
  onCloseEditor,
  featureRequest,
}: {
  readonly featureRequest?: CanvasInlineFeatureRequest | undefined;
  readonly node: Extract<GenNodeData, { kind: "image" | "video" }>;
  readonly selected: boolean;
  readonly editing: boolean;
  readonly starting: boolean;
  readonly activeTask: GenerationTaskSummary | null;
  readonly latestTask?: GenerationTaskSummary | null | undefined;
  readonly tasks: readonly GenerationTaskSummary[];
  readonly onOpenTask: (taskId: string) => void;
  readonly onPromoteSeedanceDraft: (taskId: string) => Promise<string>;
  readonly inputs: readonly (ConnectedAssetInput | InheritedAssetInput)[];
  readonly output?: OutputNodeData | null | undefined;
  readonly promptContents?: PromptContentModule | undefined;
  readonly startError: string | null;
  readonly onSelect: (key: string) => void;
  readonly onEdit?: ((key: string) => void) | undefined;
  readonly onNodeDragStart: (
    key: string,
    x: number,
    y: number,
    clientX: number,
    clientY: number,
  ) => void;
  readonly onSizeChange: (key: string, size: CanvasNodeDimensions) => void;
  readonly onRemove: (key: string) => void;
  readonly onRename?: ((key: string, name: string) => void) | undefined;
  readonly onVideoPreset?: ((preset: "long" | "frames" | "first") => void) | undefined;
  readonly onImagePreset?: ((mode: "image_to_image" | "upscale") => void) | undefined;
  readonly onSelectImageResult?: ((key: string, resultKey: string) => void) | undefined;
  readonly onPreviewResult: (key: string) => void;
  readonly onEnhanceImage: (key: string, preview: OutputNodeData) => void;
  readonly onEditImageRegion: StartImageRegionEdit;
  readonly providerCatalog: readonly import("../../lib/backend").ProviderCatalogEntry[];
  readonly onCloseEditor?: (() => void) | undefined;
}) {
  const elementRef = useRef<HTMLDivElement>(null);
  /**
   * 产物的**真实像素尺寸**（原站节点头上显示的就是它，例如 1728 × 2304）。
   * 媒体加载完成后从 naturalWidth/Height、videoWidth/Height 读真实值；
   * 读不到就不显示这一段，不编造尺寸。
   */
  const [pixelSize, setPixelSize] = useState<{ width: number; height: number } | null>(null);
  const { containerRef: mediaRef, inView } = useNodeInView<HTMLDivElement>({
    heavy: Boolean(output?.finalPath ?? output?.previewSrc),
  });
  const [imagesExpanded, setImagesExpanded] = useState(false);
  const [imageEdit, setImageEdit] = useState<{ mode: CanvasImageTransform; source: OutputNodeData } | null>(null);
  const [mediaHost, setMediaHost] = useState<HTMLDivElement | null>(null);
  const setMediaRef = useCallback((element: HTMLDivElement | null) => {
    mediaRef(element);
    setMediaHost(element);
  }, [mediaRef]);
  const activeImageEdit = imageEdit && imageEdit.source.key === output?.key &&
    imageEdit.source.taskId === output.taskId && imageEdit.source.resultKey === output.resultKey &&
    imageEdit.source.finalPath === output.finalPath ? imageEdit : null;
  useEffect(() => {
    if (imageEdit && !activeImageEdit) setImageEdit(null);
  }, [activeImageEdit, imageEdit]);
  const openImageEdit = useCallback((mode: CanvasImageTransform, source: OutputNodeData) => {
    onCloseEditor?.();
    setImagesExpanded(false);
    setImageEdit({ mode, source });
  }, [onCloseEditor]);
  useEffect(() => {
    if (featureRequest?.action.kind !== "image") return;
    featureRequest.onHandled();
    if (output?.finalPath === featureRequest.sourcePath) openImageEdit(featureRequest.action.mode, output);
  }, [featureRequest, openImageEdit, output]);
  const imageResults = node.kind === "image" ? (node.imageGeneration?.results ?? []).filter(result => result.finalPath || result.previewSrc) : [];
  const imageSlots = node.kind === "image" ? imageGenerationSlots(node, tasks) : [];
  const showGallery = imagesExpanded && imageSlots.length > 1;
  const orderedSlots = [...imageSlots].sort((a, b) => Number(b.result?.resultKey === output?.resultKey) - Number(a.result?.resultKey === output?.resultKey));
  const currentTasks = node.kind === "image" && node.imageGeneration
    ? tasks.filter(task => node.imageGeneration?.taskIds.includes(task.id))
    : nodeStatusTasks(tasks, latestTask);
  const isVideo = node.kind === "video";
  const kindLabel = isVideo ? "视频生成" : "图片生成";
  /** 原站标题条上的类型名：图片节点 / 视频节点。 */
  const typeName = isVideo ? "视频节点" : "图片节点";
  /** 节点自身的命名（无自定义名时沿用项目既有的「图片生成 / 视频生成」）。 */
  const nodeName = node.name ?? kindLabel;
  /** 标题条显示：默认是原站的类型名，改过名就显示节点自己的名字。 */
  const titleText = node.name ?? typeName;
  const poster = useLocalVideoPoster(isVideo ? (output?.finalPath ?? null) : null, inView);
  const reference = inputs.find(
    (input) => input.previewUrl && (input.kind === "image" || input.kind === "video"),
  );
  const outputSrc = output?.finalPath ? toMediaSrc(output.finalPath) : output?.previewSrc;
  const mediaSrc = outputSrc ? (toMediaProxyUrl(outputSrc) ?? outputSrc) : null;
  const name = nodeName;
  const playerRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    const report = () => {
      if (element.offsetWidth > 0 && element.offsetHeight > 0)
        onSizeChange(node.key, { width: element.offsetWidth, height: element.offsetHeight });
    };
    report();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => observer.disconnect();
  }, [node.key, onSizeChange]);

  return (
    <div
      ref={elementRef}
      id={`node-preview-${node.key}`}
      className={`canvas-gen-node canvas-gen-node--${node.kind} canvas-node-preview ${isVideo ? "video-generation-preview" : "image-generation-preview"}${selected ? " is-selected" : ""}`}
      data-connection-target={node.key}
      data-video-node-key={isVideo ? node.key : undefined}
      aria-busy={starting || activeTask != null}
      data-image-crop-active={activeImageEdit && activeImageEdit.mode !== "rotate" ? "" : undefined}
      onMouseDown={(event) => {
        if (event.button !== 0) return;
        if ((activeImageEdit && activeImageEdit.mode !== "rotate") ||
            (event.target as Element).closest("button, input, video[controls], details, summary, [data-canvas-image-tool]"))
          return;
        onSelect(node.key);
        onNodeDragStart(node.key, node.x, node.y, event.clientX, event.clientY);
      }}
    >
      {/*
        节点上方的标题条。
        这里不用 React Flow 的 NodeToolbar：卡片组件在独立渲染（测试、单测预览）
        时不在 ReactFlowProvider 里，NodeToolbar 会直接抛错。普通绝对定位头
        视觉等价，且任何上下文都安全。
      */}
      <CanvasMediaNodeTitle kind={node.kind} title={titleText} pixelSize={pixelSize}
        onRename={onRename ? value => onRename(node.key, value) : undefined} />

      <div
        ref={setMediaRef}
        className={`canvas-node-preview__media ${isVideo ? "video-generation-preview__media" : "image-generation-preview__media"}${showGallery ? " canvas-node-preview__media--gallery" : ""}`}
        style={
          showGallery ? { height: "auto" } : pixelSize
            ? { aspectRatio: `${pixelSize.width} / ${pixelSize.height}`, height: "auto" }
            : undefined
        }
        aria-label={`${name}的媒体预览`}
      >
        {mediaSrc && output?.origin === "generation" ? <span className="canvas-media-ai-badge">AI 生成</span> : null}
        {/*
          点击节点即可编辑；仅在键盘聚焦时显示编辑入口，供键盘操作与焦点恢复使用。
        */}
        {node.kind === "image" && !activeImageEdit ? (
          <CanvasImageResultActions node={node} output={output} onPreview={onPreviewResult} onEnhance={onEnhanceImage}
            onTransform={openImageEdit} />
        ) : null}
        {isVideo ? <CanvasVideoFrameCrop nodeKey={node.key} /> : null}
        {isVideo && output?.finalPath && mediaSrc ? (
          <CanvasVideoResultActions key={output.finalPath} nodeKey={node.key} output={output} src={mediaSrc} playerRef={playerRef}
            onPreview={onPreviewResult} featureRequest={featureRequest} />
        ) : null}
        {!activeImageEdit && imageSlots.length > 1 ? <button type="button" className="canvas-image-count nodrag nopan"
          aria-label={showGallery ? "收起图片" : `展开 ${imageSlots.length} 张图片及生成进度`}
          aria-expanded={showGallery} aria-controls={showGallery ? `image-results-${node.key}` : undefined}
          onClick={event => { event.stopPropagation(); setImagesExpanded(!showGallery); }}>
          <LibTVMediaIcon name="imageset" size={14} />{showGallery ? "收起" : `${imageResults.length}/${imageSlots.length}`}
        </button> : null}
        {!activeImageEdit && (onEdit || onSelect) ? (
          <button
            type="button"
            className="canvas-node-preview__edit canvas-node-preview__edit--keyboard"
            data-open-video-editor={isVideo ? node.key : undefined}
            data-open-node-editor={node.key}
            aria-label={`编辑${kindLabel}：${name}`}
            aria-controls={`node-editor-${node.key}`}
            aria-expanded={editing}
            aria-describedby={startError ? `node-preview-error-${node.key}` : undefined}
            onClick={(event) => {
              event.stopPropagation();
              (onEdit ?? onSelect)(node.key);
            }}
          >
            <LibTVMediaIcon name="pencil" size={14} />
          </button>
        ) : null}
        {showGallery ? (
          <div id={`image-results-${node.key}`} className="canvas-image-results nodrag nopan">
            {orderedSlots.map(slot => {
              const result = slot.result;
              const src = result?.finalPath ? toMediaSrc(result.finalPath) : result?.previewSrc;
              const primary = result?.resultKey === output?.resultKey;
              const label = `图片 ${imageSlots.findIndex(item => item.key === slot.key) + 1}`;
              const slotStatus = slot.task?.status === "succeeded" ? "正在保存结果…" : generationTaskStateText(slot.task);
              if (!src || !result) return <button key={slot.key} type="button"
                className="canvas-image-results__tile canvas-image-results__pending"
                aria-label={`${label} · ${slotStatus}`}
                data-failed={slot.task ? generationTaskNeedsAttention(slot.task) || undefined : undefined}
                onClick={event => { event.stopPropagation(); if (slot.task) onOpenTask(slot.task.id); }}>
                <LibTVMediaIcon name={slot.task && generationTaskNeedsAttention(slot.task) ? "warning-circle-filled" : "icon-loading"} size={20}
                  className={slot.task && isRunningTaskStatus(slot.task.status) && slot.task.queryHealth !== "degraded" ? "spin-icon" : ""} />
                <span>{slotStatus}</span>
                {slot.task?.progress != null && isRunningTaskStatus(slot.task.status) ? <small>{Math.min(100, Math.max(0, Math.round(slot.task.progress)))}%</small> : null}
              </button>;
              return <button key={slot.key} type="button" className="canvas-image-results__tile"
                aria-pressed={primary} aria-label={`${primary ? "当前主图" : "设为主图"}：${label}`} onClick={event => {
                  event.stopPropagation();
                  if (!primary) onSelectImageResult?.(node.key, result.resultKey);
                }}>
                <img src={inView ? (toMediaProxyUrl(src) ?? src) : undefined} alt={label} draggable={false} decoding="async"
                  onLoad={primary ? event => {
                    const image = event.currentTarget;
                    if (image.naturalWidth > 0 && image.naturalHeight > 0)
                      setPixelSize({ width: image.naturalWidth, height: image.naturalHeight });
                  } : undefined} />
                {!primary ? <span className="canvas-image-results__choose">设为主图</span> : null}
              </button>;
            })}
          </div>
        ) : mediaSrc && isVideo ? (
          <video
            ref={playerRef}
            key={output?.key}
            src={inView ? mediaSrc : undefined}
            poster={poster.src ?? undefined}
            controls={!output?.finalPath || !isDesktopRuntime()}
            playsInline
            preload="metadata"
            aria-label={`${name}的生成结果`}
            onLoadedMetadata={(event) => {
              const element = event.currentTarget;
              if (element.videoWidth > 0 && element.videoHeight > 0) {
                setPixelSize({ width: element.videoWidth, height: element.videoHeight });
              }
            }}
          />
        ) : mediaSrc ? (
          <img
            src={inView ? mediaSrc : undefined}
            alt={`${name}的生成结果`}
            draggable={false}
            decoding="async"
            onLoad={(event) => {
              const element = event.currentTarget;
              if (element.naturalWidth > 0 && element.naturalHeight > 0) {
                setPixelSize({ width: element.naturalWidth, height: element.naturalHeight });
              }
            }}
          />
        ) : reference?.previewUrl ? (
          reference.kind === "video" ? (
            <VideoMiddleFrame src={reference.previewUrl} />
          ) : (
            <img src={reference.previewUrl} alt={`参考素材：${reference.name}`} draggable={false} />
          )
        ) : isVideo && !starting && !activeTask ? (
          <div className="canvas-video-empty">
            <LibTVMediaIcon name="icon-play-filled-large" size={78} />
            <span>尝试：</span>
            <button type="button" onClick={() => onVideoPreset?.("long")} data-tooltip="规划镜头、分段生成并合成成片"><LibTVMediaIcon name="mode-long-video2video" size={16} /><span>5分钟超长视频</span></button>
            <button type="button" onClick={() => onVideoPreset?.("frames")}><LibTVMediaIcon name="layers-f" size={14} /><span>首尾帧生成视频</span></button>
            <button type="button" onClick={() => onVideoPreset?.("first")}><LibTVMediaIcon name="sparkle-f" size={14} /><span>首帧生成视频</span></button>
          </div>
        ) : !isVideo && !starting && !activeTask ? (
          <div className="canvas-image-empty">
            <CanvasImageIcon name="empty" size={90} />
            <span>尝试：</span>
            <div className="canvas-image-empty__actions">
              <button type="button" onClick={() => onImagePreset?.("image_to_image")}><CanvasImageIcon name="upload" size={14} /><span>图生图</span></button>
              <button type="button" onClick={() => onImagePreset?.("upscale")}><LibTVMediaIcon name="hd" size={16} /><span>图片高清</span></button>
            </div>
          </div>
        ) : (
          <span
            className={`canvas-node-preview__empty ${isVideo ? "video-generation-preview__empty" : "image-generation-preview__empty"}`}
          >
            <LibTVMediaIcon name={isVideo ? "icon-play-filled-large" : "icon-image-filled"} size={28} />
            <span>
              {starting || activeTask
                ? isVideo
                  ? "正在制作这个镜头"
                  : "正在生成图片"
                : isVideo
                  ? "这个镜头尚未生成"
                  : "尚未生成图片"}
            </span>
            <small>选中节点，编辑提示词与生成设置</small>
          </span>
        )}
      </div>

      {isVideo && output?.taskId && output.finalPath ? (
        <CanvasSeedanceDraftAction key={output.taskId} taskId={output.taskId}
          tasks={tasks}
          onPromote={onPromoteSeedanceDraft} onOpenTask={onOpenTask} />
      ) : null}

      {activeImageEdit?.mode === "outpaint" || activeImageEdit?.mode === "repaint" ? (
        <CanvasImageRegionEditor mode={activeImageEdit.mode} mediaHost={mediaHost} pixelSize={pixelSize}
          nodeKey={node.key} source={activeImageEdit.source} providers={providerCatalog} onStart={onEditImageRegion}
          onClose={() => setImageEdit(null)} />
      ) : activeImageEdit ? (
        <CanvasImageInlineEditor mode={activeImageEdit.mode} nodeKey={node.key} output={activeImageEdit.source}
          mediaHost={mediaHost} onClose={() => setImageEdit(null)} />
      ) : null}

      {/*
        生成状态：原站的节点卡上没有常驻状态条（状态在编辑层里），所以这里只在
        有任务在跑时叠一块浮层，静止状态的卡片就是「媒体 + 标题条」。
      */}
      {starting || activeTask != null || currentTasks.some(generationTaskNeedsAttention) ? (
        <MediaNodeTaskStatus
          kind={node.kind}
          task={activeTask ?? latestTask ?? null}
          tasks={currentTasks}
          onOpenTask={onOpenTask}
          starting={starting}
          hasResult={Boolean(mediaSrc)}
        />
      ) : null}
      {startError ? (
        <ErrorAlert
          id={`node-preview-error-${node.key}`}
          error={startError}
          hint="打开编辑区查看请求设置；提交回执不明确时请在历史中核对原任务。"
        />
      ) : null}
      {node.kind === "image" && (!node.imageGeneration || node.imageGeneration.taskIds.includes(latestTask?.id ?? "")) && !startError && !starting && !activeTask && latestTask &&
        (latestTask.status === "failed" || latestTask.status === "interrupted" || latestTask.queryHealth === "degraded") ? (
        <ErrorAlert error={latestTask.queryHealth === "degraded" ? "图片任务已停止自动查询" : "本次图片生成未完成"}
          hint="在生成历史中查看错误、继续查询或取消任务。" />
      ) : null}
      {/*
        节点卡片本体不再放装饰端口、卡片头与「编辑」按钮：原站的连线端口是
        React Flow 手柄（见 CanvasFlowViews），编辑区在选中节点后展开在节点下方，
        删除节点走键盘 Delete 与节点右键菜单。
      */}
    </div>
  );
}
