import { useEffect, useRef, useState } from "react";
import { ErrorAlert } from "../../components/ErrorAlert";
import { CanvasNodeCardIcon } from "./CanvasNodeCardIcons";
import { CanvasChromeIcon } from "./CanvasChromeIcons";
import { toMediaSrc, type GenerationTaskSummary } from "../../lib/backend";
import { toMediaProxyUrl } from "../../lib/mediaProxy";
import type { PromptContentModule } from "../../lib/promptContent";
import { validateArtifactName } from "./artifactNames";
import { VideoMiddleFrame } from "./VideoMiddleFrame";
import { useNodeInView } from "./mediaPreview";
import { useLocalVideoPoster } from "./localVideoPoster";
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

export function MediaNodeTaskStatus({
  task,
  starting,
  hasResult = false,
  kind = "video",
}: {
  readonly kind?: "image" | "video";
  readonly task: GenerationTaskSummary | null;
  readonly starting: boolean;
  readonly hasResult?: boolean;
}) {
  const busy = starting || (task != null && isRunningTaskStatus(task.status));
  const progress =
    task?.progress == null ? null : Math.min(100, Math.max(0, Math.round(task.progress)));
  return (
    <div className="video-node-status" role="status" aria-live="polite">
      <CanvasNodeCardIcon
        name={busy ? "spinner" : task?.status === "failed" ? "warning" : "done"}
        className={busy ? "spin-icon" : ""}
        size={12}
      />
      <span>
        {starting
          ? "提交中…"
          : task
            ? (TASK_STATUS_LABELS[task.status] ?? "正在生成")
            : hasResult
              ? "已生成"
              : "待生成"}
      </span>
      {progress != null ? <strong>{progress}%</strong> : null}
      {task && busy ? (
        <span
          className="video-node-status__progress"
          role="progressbar"
          aria-label={kind === "image" ? "图片节点生成进度" : "视频节点生成进度"}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress ?? undefined}
        >
          <i style={{ width: `${progress ?? 18}%` }} />
        </span>
      ) : null}
    </div>
  );
}

export function MediaGenerationPreview({
  node,
  selected,
  editing,
  starting,
  activeTask,
  latestTask,
  inputs,
  output,
  startError,
  onSelect,
  onEdit,
  onNodeDragStart,
  onSizeChange,
  onRename,
  onVideoPreset,
  onImagePreset,
}: {
  readonly node: Extract<GenNodeData, { kind: "image" | "video" }>;
  readonly selected: boolean;
  readonly editing: boolean;
  readonly starting: boolean;
  readonly activeTask: GenerationTaskSummary | null;
  readonly latestTask?: GenerationTaskSummary | null | undefined;
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
  readonly onImagePreset?: ((preset: "image_to_image" | "upscale") => void) | undefined;
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
      onMouseDown={(event) => {
        if ((event.target as Element).closest("button, input, video[controls], details, summary"))
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
      <div className="canvas-node-toolbar">
        <span className="canvas-node-toolbar__type">
          <CanvasNodeCardIcon
            name={isVideo ? "video" : "image"}
            className="canvas-node-toolbar__icon"
            size={14}
          />
          <CanvasNodeTitle
            title={titleText}
            onRename={onRename ? (value) => onRename(node.key, value) : undefined}
          />
          {isVideo ? null : (
            <CanvasNodeCardIcon name="shield" className="canvas-node-toolbar__shield" size={14} />
          )}
        </span>
        {pixelSize ? (
          <span
            className="canvas-node-toolbar__size"
            title={`${pixelSize.width} × ${pixelSize.height}`}
          >
            {pixelSize.width} × {pixelSize.height}
          </span>
        ) : null}
      </div>

      <div
        ref={mediaRef}
        className={`canvas-node-preview__media ${isVideo ? "video-generation-preview__media" : "image-generation-preview__media"}`}
        style={
          pixelSize
            ? { aspectRatio: `${pixelSize.width} / ${pixelSize.height}`, height: "auto" }
            : undefined
        }
        aria-label={`${name}的媒体预览`}
      >
        {/*
          媒体右上角的唯一动作按钮。原站同一位置放的是「替换素材」
          （24×24、bg-black/40、backdrop-blur、圆角 6px、图标 14px），
          本项目把同一个位置给「编辑」，编辑区在选中节点后展开在节点下方。
        */}
        {onEdit || onSelect ? (
          <button
            type="button"
            className="canvas-node-preview__edit"
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
            <CanvasNodeCardIcon name="edit" size={14} />
          </button>
        ) : null}
        {mediaSrc && isVideo ? (
          <video
            key={output?.key}
            src={inView ? mediaSrc : undefined}
            poster={poster.src ?? undefined}
            controls
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
            <CanvasNodeCardIcon name="video" size={52} />
            <span>尝试：</span>
            <button type="button" onClick={() => onVideoPreset?.("long")} title="规划镜头、分段生成并合成成片">∞ <span>5分钟超长视频</span></button>
            <button type="button" onClick={() => onVideoPreset?.("frames")}><CanvasChromeIcon name="assets" size={16} /><span>首尾帧生成视频</span></button>
            <button type="button" onClick={() => onVideoPreset?.("first")}><CanvasChromeIcon name="universal" size={16} /><span>首帧生成视频</span></button>
          </div>
        ) : !isVideo && !starting && !activeTask ? (
          <div className="canvas-image-empty">
            <CanvasNodeCardIcon name="image" size={52} />
            <span>尝试：</span>
            <button type="button" onClick={() => onImagePreset?.("image_to_image")}><CanvasChromeIcon name="image" size={16} /><span>图生图</span></button>
            <button type="button" onClick={() => onImagePreset?.("upscale")}><CanvasChromeIcon name="upscale" size={16} /><span>图片高清</span></button>
          </div>
        ) : (
          <span
            className={`canvas-node-preview__empty ${isVideo ? "video-generation-preview__empty" : "image-generation-preview__empty"}`}
          >
            <CanvasNodeCardIcon name={isVideo ? "video" : "image"} size={28} />
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

      {/*
        生成状态：原站的节点卡上没有常驻状态条（状态在编辑层里），所以这里只在
        有任务在跑时叠一块浮层，静止状态的卡片就是「媒体 + 标题条」。
      */}
      {starting || activeTask != null ? (
        <MediaNodeTaskStatus
          kind={node.kind}
          task={activeTask ?? latestTask ?? null}
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
      {/*
        节点卡片本体不再放装饰端口、卡片头与「编辑」按钮：原站的连线端口是
        React Flow 手柄（见 CanvasFlowViews），编辑区在选中节点后展开在节点下方，
        删除节点走键盘 Delete 与节点右键菜单。
      */}
    </div>
  );
}
