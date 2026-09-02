import { ArrowDown } from "@phosphor-icons/react/ArrowDown";
import { ArrowUp } from "@phosphor-icons/react/ArrowUp";
import { Check } from "@phosphor-icons/react/Check";
import { CheckCircle } from "@phosphor-icons/react/CheckCircle";
import { CircleNotch } from "@phosphor-icons/react/CircleNotch";
import { CopySimple } from "@phosphor-icons/react/CopySimple";
import { DownloadSimple } from "@phosphor-icons/react/DownloadSimple";
import { FilmStrip } from "@phosphor-icons/react/FilmStrip";
import { FolderOpen } from "@phosphor-icons/react/FolderOpen";
import { Play } from "@phosphor-icons/react/Play";
import { Sparkle } from "@phosphor-icons/react/Sparkle";
import { WarningCircle } from "@phosphor-icons/react/WarningCircle";
import { X } from "@phosphor-icons/react/X";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import {
  formatBytes,
  formatRawBackendError,
  frontendLog,
  isDesktopRuntime,
  toMediaSrc,
  type GenerationResultRecord,
  type GenerationTaskSummary,
  type ProviderCatalogEntry,
  type VideoDownloaderEngineStatus,
} from "../../lib/backend";
import type { PromptContentEditorSession } from "../../lib/promptContent";

import { AssetMediaState } from "./AssetLibraryViews";
import { copyTextToDesktopClipboard, revealDesktopItem } from "./desktopActions";
import {
  AssetKindIcon,
  ImageNodeSettings,
  NodeTypeIcon,
  PromptMentionInput,
  PromptOptimizationPanel,
  VideoNodeSettings,
} from "./PromptNodeViews";
import type {
  AssetNodeData,
  CanvasNodeDimensions,
  ConnectedAssetInput,
  GenNodeData,
  ImageNodeConfig,
  InheritedAssetInput,
  MentionCandidate,
  OutputNodeData,
  PromptOptimizationPanelState,
  ResultNodeData,
  RetryInfo,
  StaticNodeDescriptor,
  VideoComposerInput,
  VideoComposerNodeConfig,
  VideoComposerNodeData,
  VideoComposerRunState,
  VideoDownloaderNodeConfig,
  VideoDownloaderNodeData,
  VideoDownloaderRunState,
  VideoNodeConfig,
} from "./workspaceModel";
import {
  ASSET_KIND_LABELS,
  SAVE_STATUS_LABELS,
  TASK_STATUS_LABELS,
  assetNodeDimensions,
  fileBaseName,
  fileNameFromPath,
  formatTaskClock,
  isRunningTaskStatus,
  measuredAspectRatio,
  outputNodeDimensions,
  outputNodeReferenceTarget,
  shortenTaskId,
} from "./workspaceModel";

export function CanvasGenNode({
  node,
  descriptor,
  selected,
  dragging,
  starting,
  activeTask,
  connectedInputs,
  inheritedInputs,
  mentionCandidates,
  promptSourceName,
  registerPromptInput,
  providerCatalog,
  promptOptimization,
  onPromptOptimize,
  onAdoptOptimizedPrompt,
  onDiscardOptimizedPrompt,
  onSelect,
  onNodeDragStart,
  onRemove,
  onUnlink,
  onSizeChange,
  onImageConfigChange,
  onVideoConfigChange,
  onStartGeneration,
  startError,
}: {
  readonly node: Extract<GenNodeData, { kind: "image" | "video" }>;
  readonly descriptor: StaticNodeDescriptor;
  readonly selected: boolean;
  readonly dragging: boolean;
  readonly starting: boolean;
  readonly startError: string | null;
  readonly activeTask: GenerationTaskSummary | null;
  readonly connectedInputs: readonly ConnectedAssetInput[];
  readonly inheritedInputs: readonly InheritedAssetInput[];
  readonly mentionCandidates: readonly MentionCandidate[];
  readonly promptSourceName?: string | undefined;
  readonly registerPromptInput: (
    nodeKey: string,
    session: PromptContentEditorSession | null,
  ) => void;
  readonly providerCatalog: readonly ProviderCatalogEntry[];
  readonly promptOptimization: PromptOptimizationPanelState | undefined;
  readonly onPromptOptimize: (key: string, detailReview: boolean) => void;
  readonly onAdoptOptimizedPrompt: (key: string) => void;
  readonly onDiscardOptimizedPrompt: (key: string) => void;
  readonly onSelect: (key: string) => void;
  readonly onNodeDragStart: (
    key: string,
    x: number,
    y: number,
    clientX: number,
    clientY: number,
  ) => void;
  readonly onRemove: (key: string) => void;
  readonly onUnlink: (edgeId: string) => void;
  readonly onSizeChange: (key: string, dimensions: CanvasNodeDimensions) => void;
  readonly onImageConfigChange: (key: string, config: ImageNodeConfig) => void;
  readonly onVideoConfigChange: (key: string, config: VideoNodeConfig) => void;
  readonly onStartGeneration: (key: string) => void;
}) {
  const isVideo = node.kind === "video";
  const nodeElementRef = useRef<HTMLDivElement>(null);
  const optimizationEnabled = node.config.promptOptimization?.enabled === true;
  const optimizationRunning = optimizationEnabled && promptOptimization?.status === "running";
  const effectiveInputs = [...connectedInputs, ...inheritedInputs];
  const referenceInputCount = effectiveInputs.length;
  const promptLabelId = `${node.kind}-prompt-label-${node.key}`;
  const promptHintId = `${node.kind}-prompt-hint-${node.key}`;
  const selectionReady = Boolean(
    node.config.modelSelection.providerId && node.config.modelSelection.modelDefinitionId,
  );
  const statusLabel = activeTask
    ? (TASK_STATUS_LABELS[activeTask.status] ?? "正在生成")
    : starting
      ? "提交中…"
      : "空闲 · 可发起生成";

  useEffect(() => {
    const element = nodeElementRef.current;
    if (element == null) return;
    const reportSize = () => {
      const width = element.offsetWidth;
      const height = element.offsetHeight;
      if (width > 0 && height > 0) onSizeChange(node.key, { width, height });
    };
    reportSize();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(reportSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, [node.key, onSizeChange]);

  return (
    <div
      ref={nodeElementRef}
      className={`canvas-gen-node canvas-gen-node--${node.kind}${selected ? " is-selected" : ""}${dragging ? " is-dragging" : ""}`}
      data-connection-target={node.key}
      aria-busy={starting || activeTask != null}
      onMouseDown={(event) => {
        const target = event.target as HTMLElement;
        if (target.closest(".canvas-gen-node__settings")) {
          onSelect(node.key);
          return;
        }
        // 提示词输入框、优化面板、按钮内部按下不触发节点拖动。
        if (
          target.closest(
            ".prompt-mention, .prompt-opt-panel, .canvas-gen-node__actions, .node-media-chip__unlink",
          )
        ) {
          return;
        }
        onSelect(node.key);
        onNodeDragStart(node.key, node.x, node.y, event.clientX, event.clientY);
      }}
    >
      <div className="canvas-gen-node__header">
        <span className={`canvas-gen-node__type canvas-gen-node__type--${node.kind}`}>
          <span className="canvas-gen-node__type-icon" aria-hidden="true">
            <NodeTypeIcon kind={node.kind} size={16} />
          </span>
          <span className="canvas-gen-node__type-copy">
            <strong>{descriptor.kindLabel}</strong>
            <small>
              {isVideo
                ? referenceInputCount > 0
                  ? `参考素材 ${referenceInputCount}`
                  : "视频任务"
                : referenceInputCount > 0
                  ? `参考媒体 ${referenceInputCount}`
                  : "图片任务"}
            </small>
          </span>
        </span>
        <span className="canvas-gen-node__actions">
          <button
            type="button"
            className={`canvas-gen-node__start canvas-gen-node__start--labeled${starting || optimizationRunning ? " is-busy" : ""}`}
            aria-label={isVideo ? "开始视频生成" : "开始图片生成"}
            data-state={starting || optimizationRunning ? "loading" : undefined}
            title={
              !selectionReady
                ? `请先选择可用的供应商和${isVideo ? "视频" : "图片"}模型`
                : optimizationRunning
                  ? `提示词优化完成后再开始${isVideo ? "视频" : "图片"}生成`
                  : isVideo
                    ? "点击开始视频生成"
                    : "点击开始图片生成"
            }
            disabled={starting || optimizationRunning || !selectionReady}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onSelect(node.key);
              onStartGeneration(node.key);
            }}
          >
            {starting || optimizationRunning ? (
              <CircleNotch size={15} weight="bold" aria-hidden="true" className="spin-icon" />
            ) : isVideo ? (
              <Play size={15} weight="fill" aria-hidden="true" />
            ) : (
              <Sparkle size={15} weight="fill" aria-hidden="true" />
            )}
            <span>{starting ? "提交中" : optimizationRunning ? "优化中" : "生成"}</span>
          </button>
          <button
            type="button"
            className="canvas-gen-node__remove"
            aria-label={`移除${descriptor.kindLabel}节点`}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onRemove(node.key);
            }}
          >
            <X size={12} weight="bold" aria-hidden="true" />
          </button>
        </span>
      </div>

      <div className="canvas-gen-node__prompt-section">
        <div className="canvas-gen-node__section-heading">
          <span id={promptLabelId}>
            <span aria-hidden="true">提示词</span>
            <span className="sr-only">提示词输入框，输入 @ 引用素材</span>
          </span>
          <small id={promptHintId}>
            {promptSourceName
              ? inheritedInputs.length > 0
                ? `已接入提示词输出 · 自动继承 ${inheritedInputs.length} 张参考图`
                : `已接入 ${promptSourceName} 的输出`
              : referenceInputCount > 0
                ? `${referenceInputCount} 个参考素材已连接`
                : "输入 @ 引用素材"}
          </small>
        </div>
        <PromptMentionInput
          nodeKey={node.key}
          candidates={mentionCandidates}
          registerInput={registerPromptInput}
          labelledBy={promptLabelId}
          describedBy={promptHintId}
          expandable
        />
        <GenerationInputChips inputs={effectiveInputs} onUnlink={onUnlink} />
      </div>

      {node.kind === "video" ? (
        <VideoNodeSettings
          config={node.config}
          providerCatalog={providerCatalog}
          hasMediaInputs={effectiveInputs.length > 0}
          onChange={(config) => onVideoConfigChange(node.key, config)}
        />
      ) : (
        <ImageNodeSettings
          config={node.config}
          providerCatalog={providerCatalog}
          hasMediaInputs={connectedInputs.some(
            (input) => input.kind === "image" || input.kind === "video",
          )}
          onChange={(config) => onImageConfigChange(node.key, config)}
        />
      )}
      {optimizationEnabled ? (
        <PromptOptimizationPanel
          state={promptOptimization}
          onStart={(detailReview) => onPromptOptimize(node.key, detailReview)}
          onAdopt={() => onAdoptOptimizedPrompt(node.key)}
          onDiscard={() => onDiscardOptimizedPrompt(node.key)}
        />
      ) : null}

      {startError ? (
        <div className="canvas-gen-node__error" role="alert">
          {!isVideo ? (
            <strong>
              <WarningCircle size={14} weight="fill" aria-hidden="true" />
              未能开始生成 · 检查配置后重试
            </strong>
          ) : null}
          <pre
            className="raw-error canvas-gen-node__start-error"
            aria-label="发起任务失败"
            tabIndex={0}
          >
            {startError}
          </pre>
        </div>
      ) : null}

      {isVideo ? (
        <div className="canvas-gen-node__video-status" role="status" aria-live="polite">
          <span className="canvas-gen-node__video-status-copy">
            <span
              className={`canvas-gen-node__video-status-icon${activeTask || starting ? " is-active" : ""}`}
              aria-hidden="true"
            >
              {activeTask || starting ? (
                <CircleNotch size={15} weight="bold" className="spin-icon" />
              ) : (
                <CheckCircle size={15} weight="fill" />
              )}
            </span>
            <span>
              <strong>{activeTask || starting ? statusLabel : "就绪"}</strong>
              <small>{activeTask ? "结果将作为新节点落在右侧" : "配置完成后点击生成"}</small>
            </span>
          </span>
          {activeTask?.progress != null ? (
            <strong className="canvas-gen-node__video-progress-value">
              {Math.round(activeTask.progress)}%
            </strong>
          ) : null}
          {activeTask ? (
            <span
              className="canvas-gen-node__video-progress"
              role="progressbar"
              aria-label="视频节点生成进度"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={
                activeTask.progress != null
                  ? Math.min(100, Math.max(0, Math.round(activeTask.progress)))
                  : undefined
              }
            >
              <i
                style={{
                  width: `${activeTask.progress != null ? Math.min(100, Math.max(0, Math.round(activeTask.progress))) : 18}%`,
                }}
              />
            </span>
          ) : null}
        </div>
      ) : (
        <div className="canvas-gen-node__image-status" role="status" aria-live="polite">
          <span className="canvas-gen-node__image-status-copy">
            <span
              className={`canvas-gen-node__image-status-icon${activeTask || starting ? " is-active" : ""}`}
              aria-hidden="true"
            >
              {activeTask || starting ? (
                <CircleNotch size={15} weight="bold" className="spin-icon" />
              ) : (
                <CheckCircle size={15} weight="fill" />
              )}
            </span>
            <span>
              <strong>{activeTask || starting ? statusLabel : "就绪"}</strong>
              <small>{activeTask ? "结果将作为新节点落在右侧" : "配置完成后点击生成"}</small>
            </span>
          </span>
          {activeTask?.progress != null ? (
            <strong className="canvas-gen-node__image-progress-value">
              {Math.round(activeTask.progress)}%
            </strong>
          ) : null}
          {activeTask ? (
            <span
              className="canvas-gen-node__image-progress"
              role="progressbar"
              aria-label="图片生成进度"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={
                activeTask.progress != null
                  ? Math.min(100, Math.max(0, Math.round(activeTask.progress)))
                  : undefined
              }
            >
              <i
                style={{
                  width: `${activeTask.progress != null ? Math.min(100, Math.max(0, Math.round(activeTask.progress))) : 18}%`,
                }}
              />
            </span>
          ) : null}
        </div>
      )}
      <span
        className={`node-port node-port--left node-port--${isVideo ? "video" : "image"}`}
        aria-hidden="true"
      />
      <span
        className={`node-port node-port--right node-port--${isVideo ? "video" : "image"}`}
        aria-hidden="true"
      />
    </div>
  );
}

export function CanvasVideoComposerNode({
  node,
  inputs,
  selected,
  dragging,
  runState,
  recordingFormat,
  onSelect,
  onNodeDragStart,
  onRemove,
  onUnlink,
  onConfigChange,
  onMoveInput,
  onCompose,
}: {
  readonly node: VideoComposerNodeData;
  readonly inputs: readonly VideoComposerInput[];
  readonly selected: boolean;
  readonly dragging: boolean;
  readonly runState: VideoComposerRunState | undefined;
  readonly recordingFormat: string | null;
  readonly onSelect: (key: string) => void;
  readonly onNodeDragStart: (
    key: string,
    x: number,
    y: number,
    clientX: number,
    clientY: number,
  ) => void;
  readonly onRemove: (key: string) => void;
  readonly onUnlink: (edgeId: string) => void;
  readonly onConfigChange: (key: string, config: VideoComposerNodeConfig) => void;
  readonly onMoveInput: (nodeKey: string, inputKey: string, direction: -1 | 1) => void;
  readonly onCompose: (key: string) => void;
}) {
  const running = runState?.status === "running";
  const canCompose = inputs.length >= 2 && recordingFormat != null && !running;
  const statusText = running
    ? `正在合成 · ${runState.progress}%`
    : runState?.status === "done"
      ? "合成完成 · 产物已落在右侧"
      : runState?.status === "error"
        ? "合成失败 · 请查看错误"
        : inputs.length < 2
          ? `还需 ${2 - inputs.length} 段视频`
          : recordingFormat == null
            ? "当前系统不支持视频录制"
            : "顺序已就绪";
  return (
    <div
      className={`canvas-video-composer${selected ? " is-selected" : ""}${dragging ? " is-dragging" : ""}`}
      data-connection-target={node.key}
      aria-busy={running || undefined}
      onMouseDown={(event) => {
        if (
          (event.target as HTMLElement).closest("button, input, .canvas-video-composer__inputs")
        ) {
          onSelect(node.key);
          return;
        }
        onSelect(node.key);
        onNodeDragStart(node.key, node.x, node.y, event.clientX, event.clientY);
      }}
    >
      <div className="canvas-video-composer__header">
        <span className="canvas-video-composer__type">
          <span className="canvas-video-composer__type-icon" aria-hidden="true">
            <FilmStrip size={16} weight="bold" />
          </span>
          <span>
            <strong>视频拼接与合成</strong>
            <small>{inputs.length > 0 ? `${inputs.length} 段 · 按序拼接` : "本地工具"}</small>
          </span>
        </span>
        <span className="canvas-video-composer__actions">
          <button
            type="button"
            className="canvas-video-composer__compose"
            disabled={!canCompose}
            aria-label="开始视频拼接与合成"
            title={
              inputs.length < 2
                ? "至少连接 2 段视频"
                : recordingFormat == null
                  ? "当前系统 WebView 不支持视频录制"
                  : "按列表顺序合成为完整视频"
            }
            data-state={running ? "loading" : undefined}
            onClick={(event) => {
              event.stopPropagation();
              onCompose(node.key);
            }}
          >
            {running ? (
              <CircleNotch size={15} weight="bold" className="spin-icon" aria-hidden="true" />
            ) : (
              <Play size={15} weight="fill" aria-hidden="true" />
            )}
            <span>{running ? "合成中" : "合成"}</span>
          </button>
          <button
            type="button"
            className="canvas-video-composer__remove"
            disabled={running}
            aria-label="移除视频拼接与合成节点"
            onClick={(event) => {
              event.stopPropagation();
              onRemove(node.key);
            }}
          >
            <X size={12} weight="bold" aria-hidden="true" />
          </button>
        </span>
      </div>

      <div className="canvas-video-composer__section-heading">
        <span>视频片段</span>
        <small>连接顺序可在此调整</small>
      </div>
      {inputs.length > 0 ? (
        <ol className="canvas-video-composer__inputs" aria-label="视频合成顺序">
          {inputs.map((input, index) => (
            <li key={input.key}>
              <span className="canvas-video-composer__index" aria-hidden="true">
                {index + 1}
              </span>
              <span className="canvas-video-composer__input-copy">
                <strong title={input.name}>{input.name}</strong>
                <small>{input.sourceLabel}视频</small>
              </span>
              <span className="canvas-video-composer__input-actions">
                <button
                  type="button"
                  disabled={index === 0 || running}
                  aria-label={`上移第 ${index + 1} 段：${input.name}`}
                  onClick={() => onMoveInput(node.key, input.key, -1)}
                >
                  <ArrowUp size={14} weight="bold" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  disabled={index === inputs.length - 1 || running}
                  aria-label={`下移第 ${index + 1} 段：${input.name}`}
                  onClick={() => onMoveInput(node.key, input.key, 1)}
                >
                  <ArrowDown size={14} weight="bold" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  disabled={running}
                  aria-label={`移除第 ${index + 1} 段：${input.name}`}
                  onClick={() => onUnlink(input.edgeId)}
                >
                  <X size={13} weight="bold" aria-hidden="true" />
                </button>
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <div className="canvas-video-composer__empty">
          <FilmStrip size={20} weight="bold" aria-hidden="true" />
          <span>从视频素材或视频产物的右侧端口拖入连线</span>
        </div>
      )}

      <label className="canvas-video-composer__name-field">
        <span>输出名称</span>
        <input
          value={node.config.outputName}
          maxLength={80}
          disabled={running}
          aria-label="合成视频输出名称"
          onChange={(event) =>
            onConfigChange(node.key, { ...node.config, outputName: event.target.value })
          }
        />
      </label>
      <div className="canvas-video-composer__summary">
        <span>
          <strong>画面</strong>
          <small>跟随首段 · 完整适配</small>
        </span>
        <span>
          <strong>格式</strong>
          <small>{recordingFormat ?? "不可用"}</small>
        </span>
        <span>
          <strong>转场</strong>
          <small>无 · 顺序直切</small>
        </span>
      </div>
      <div
        className={`canvas-video-composer__status${runState?.status ? ` is-${runState.status}` : ""}`}
        role="status"
        aria-live="polite"
      >
        <span>
          {running ? (
            <CircleNotch size={15} weight="bold" className="spin-icon" aria-hidden="true" />
          ) : runState?.status === "error" ? (
            <WarningCircle size={15} weight="fill" aria-hidden="true" />
          ) : (
            <CheckCircle size={15} weight="fill" aria-hidden="true" />
          )}
          <strong>{statusText}</strong>
        </span>
        {running ? (
          <span
            className="canvas-video-composer__progress"
            role="progressbar"
            aria-label="视频合成进度"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={runState.progress}
          >
            <i style={{ width: `${runState.progress}%` }} />
          </span>
        ) : null}
      </div>
      {runState?.status === "error" && runState.error ? (
        <pre className="canvas-video-composer__error" role="alert" tabIndex={0}>
          {runState.error}
        </pre>
      ) : null}
      <span className="node-port node-port--left node-port--video" aria-hidden="true" />
      <span className="node-port node-port--right node-port--video" aria-hidden="true" />
    </div>
  );
}

/**
 * 画布网络爆款视频下载节点：内置 yt-dlp 引擎，粘贴抖音等站点链接下载为
 * 本地视频文件。不接收媒体连线；成功后右侧自动落一张可连入视频拼接与
 * 合成节点的产物卡片。
 */
export function CanvasVideoDownloaderNode({
  node,
  selected,
  dragging,
  runState,
  engineStatus,
  enginePreparing,
  onSelect,
  onNodeDragStart,
  onRemove,
  onConfigChange,
  onStartDownload,
  onCancelDownload,
  onPrepareEngine,
  onUpdateEngine,
  onImportCookies,
  onClearCookies,
  onRevealResult,
  onConnectionStart,
}: {
  readonly node: VideoDownloaderNodeData;
  readonly selected: boolean;
  readonly dragging: boolean;
  readonly runState: VideoDownloaderRunState | undefined;
  readonly engineStatus: VideoDownloaderEngineStatus | null;
  readonly enginePreparing: boolean;
  readonly onSelect: (key: string) => void;
  readonly onNodeDragStart: (
    key: string,
    x: number,
    y: number,
    clientX: number,
    clientY: number,
  ) => void;
  readonly onRemove: (key: string) => void;
  readonly onConfigChange: (key: string, config: VideoDownloaderNodeConfig) => void;
  readonly onStartDownload: (key: string) => void;
  readonly onCancelDownload: (key: string) => void;
  readonly onPrepareEngine: () => void;
  readonly onUpdateEngine: () => void;
  readonly onImportCookies: () => void;
  readonly onClearCookies: () => void;
  readonly onRevealResult: (key: string) => void;
  readonly onConnectionStart: (key: string) => void;
}) {
  const running = runState?.status === "running";
  const url = node.config.url;
  const canStart = url.trim().length > 0 && !running;
  const engineReady = engineStatus?.state === "ready";
  const engineStateLabel =
    enginePreparing || engineStatus?.state === "installing"
      ? "引擎准备中…"
      : engineStatus == null
        ? "引擎状态检测中…"
        : engineStatus.state === "ready"
          ? `yt-dlp ${engineStatus.version ?? ""} · 就绪`
          : engineStatus.state === "failed"
            ? "引擎获取失败"
            : "尚未安装 · 首次下载时自动获取";
  const statusText = running
    ? runState?.preparingEngine
      ? "正在准备下载引擎…"
      : `正在下载 · ${runState?.progress != null ? Math.round(runState.progress) : 0}%`
    : runState?.status === "done"
      ? "下载完成 · 产物已落在右侧"
      : runState?.status === "cancelled"
        ? "已取消"
        : runState?.status === "error"
          ? "下载失败 · 请查看错误"
          : url.trim().length > 0
            ? "粘贴链接后即可下载"
            : "粘贴抖音等站点的视频链接";
  return (
    <div
      className={`canvas-video-downloader${selected ? " is-selected" : ""}${dragging ? " is-dragging" : ""}`}
      aria-busy={running || undefined}
      onMouseDown={(event) => {
        if ((event.target as HTMLElement).closest("button, input")) {
          onSelect(node.key);
          return;
        }
        onSelect(node.key);
        onNodeDragStart(node.key, node.x, node.y, event.clientX, event.clientY);
      }}
    >
      <div className="canvas-video-downloader__header">
        <span className="canvas-video-downloader__type">
          <span className="canvas-video-downloader__type-icon" aria-hidden="true">
            <DownloadSimple size={16} weight="bold" />
          </span>
          <span>
            <strong>网络爆款视频下载</strong>
            <small>{engineStateLabel}</small>
          </span>
        </span>
        <span className="canvas-video-downloader__actions">
          {runState?.status === "done" && !running ? (
            <button
              type="button"
              className="canvas-video-downloader__reveal"
              aria-label="在文件夹中显示下载结果"
              title="在文件夹中显示"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onRevealResult(node.key);
              }}
            >
              <FolderOpen size={15} weight="bold" aria-hidden="true" />
            </button>
          ) : null}
          {running ? (
            <button
              type="button"
              className="canvas-video-downloader__cancel"
              aria-label="取消视频下载"
              title="取消下载"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onCancelDownload(node.key);
              }}
            >
              <X size={15} weight="bold" aria-hidden="true" />
              <span>取消</span>
            </button>
          ) : (
            <button
              type="button"
              className="canvas-video-downloader__start"
              disabled={!canStart}
              aria-label="开始下载视频"
              title={url.trim().length > 0 ? "用内置 yt-dlp 引擎下载该链接" : "请先粘贴视频链接"}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onStartDownload(node.key);
              }}
            >
              <DownloadSimple size={15} weight="bold" aria-hidden="true" />
              <span>下载</span>
            </button>
          )}
          <button
            type="button"
            className="canvas-video-downloader__remove"
            disabled={running}
            aria-label="移除网络爆款视频下载节点"
            onClick={(event) => {
              event.stopPropagation();
              onRemove(node.key);
            }}
          >
            <X size={12} weight="bold" aria-hidden="true" />
          </button>
        </span>
      </div>

      <div className="canvas-video-downloader__section-heading">
        <span>视频链接</span>
        <small>支持抖音分享口令整段粘贴</small>
      </div>
      <input
        type="text"
        className="canvas-video-downloader__url"
        value={url}
        onChange={(event) => {
          onConfigChange(node.key, { url: event.target.value });
        }}
        placeholder="https://v.douyin.com/… 或直接粘贴分享口令"
        aria-label="视频链接"
        spellCheck={false}
        autoComplete="off"
        disabled={running}
      />

      <div className="canvas-video-downloader__engine-row">
        <span
          className="canvas-video-downloader__engine-chip"
          data-state={engineStatus?.state ?? "unknown"}
        >
          {engineReady ? <CheckCircle size={12} weight="fill" aria-hidden="true" /> : null}
          {engineStatus?.state === "failed" ? (
            <WarningCircle size={12} weight="fill" aria-hidden="true" />
          ) : null}
          <span>{engineStateLabel}</span>
        </span>
        {engineStatus?.state === "ready" ? (
          <button
            type="button"
            className="canvas-video-downloader__engine-action"
            aria-label="更新下载引擎到最新版本"
            title="更新引擎（抖音等站点的提取器修复随新版本发布）"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onUpdateEngine();
            }}
          >
            更新引擎
          </button>
        ) : engineStatus?.state !== "installing" && !enginePreparing ? (
          <button
            type="button"
            className="canvas-video-downloader__engine-action"
            aria-label="立即准备下载引擎"
            title="立即下载内置 yt-dlp 引擎"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onPrepareEngine();
            }}
          >
            立即准备
          </button>
        ) : null}
      </div>

      <div className="canvas-video-downloader__cookie-row">
        <span className="canvas-video-downloader__cookie-label">
          {engineStatus?.cookiesInstalled
            ? "已导入浏览器 Cookies"
            : "未导入 Cookies · 抖音可能需要"}
        </span>
        <button
          type="button"
          className="canvas-video-downloader__engine-action"
          aria-label="导入浏览器导出的 cookies 文件"
          title="导入浏览器扩展导出的 cookies.txt（抖音要求较新的匿名 Cookies，无需登录）"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onImportCookies();
          }}
        >
          导入 Cookies
        </button>
        {engineStatus?.cookiesInstalled ? (
          <button
            type="button"
            className="canvas-video-downloader__engine-action"
            aria-label="清除已导入的 Cookies"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onClearCookies();
            }}
          >
            清除
          </button>
        ) : null}
      </div>

      <div
        className={`canvas-video-downloader__status${runState?.status ? ` is-${runState.status}` : ""}`}
        role="status"
        aria-live="polite"
      >
        <span>
          {running ? (
            <CircleNotch size={15} weight="bold" className="spin-icon" aria-hidden="true" />
          ) : runState?.status === "error" ? (
            <WarningCircle size={15} weight="fill" aria-hidden="true" />
          ) : runState?.status === "done" ? (
            <CheckCircle size={15} weight="fill" aria-hidden="true" />
          ) : null}
          <strong>{statusText}</strong>
        </span>
        {running && !runState?.preparingEngine ? (
          <span
            className="canvas-video-downloader__progress"
            role="progressbar"
            aria-label="视频下载进度"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={runState?.progress != null ? Math.round(runState.progress) : undefined}
          >
            <i
              style={{
                width: `${runState?.progress != null ? Math.min(100, Math.max(0, Math.round(runState.progress))) : 0}%`,
              }}
            />
          </span>
        ) : null}
      </div>
      {runState?.status === "error" && runState.error ? (
        <pre className="canvas-video-downloader__error" role="alert" tabIndex={0}>
          {runState.error}
        </pre>
      ) : null}
      {engineStatus?.state === "failed" && engineStatus.lastError ? (
        <pre className="canvas-video-downloader__error" role="alert" tabIndex={0}>
          {engineStatus.lastError}
        </pre>
      ) : null}
      <button
        type="button"
        className="node-port node-port--right node-port--video canvas-video-downloader__output-port"
        aria-label="从网络爆款视频下载节点拖出连线"
        title="连接到爆款视频复刻节点；下载完成后自动作为输入"
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onConnectionStart(node.key);
        }}
        onClick={(event) => event.stopPropagation()}
      />
    </div>
  );
}

/**
 * 画布视频素材节点的可视化区域：
 * - 元数据加载后把视频 seek 到中点，用中间帧作为静止封面；
 * - 悬浮时从封面位置静音循环播放，移开后暂停并回到中间帧。
 */
function CanvasAssetNodeVideoVisual({
  videoUrl,
  previewing,
  isRealAsset,
  onAspectRatioChange,
}: {
  readonly videoUrl: string;
  readonly previewing: boolean;
  readonly isRealAsset: boolean;
  readonly onAspectRatioChange: (aspectRatio: number) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const wasPreviewingRef = useRef(false);
  /** 中间帧时间戳（loadedmetadata 后记录），作为封面帧与悬浮复播/复位位置。 */
  const coverTimeRef = useRef(0);
  const [coverReady, setCoverReady] = useState(false);
  const [failedVideoUrl, setFailedVideoUrl] = useState<string | null>(null);
  const videoFailed = failedVideoUrl === videoUrl;

  const seekToCover = (video: HTMLVideoElement) => {
    video.currentTime = coverTimeRef.current;
  };

  useEffect(() => {
    const video = videoRef.current;
    if (video == null) return;
    if (previewing) {
      wasPreviewingRef.current = true;
      if (!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
        // 从当前（封面）位置续播，循环播放避免悬浮时播完黑屏。
        void video.play().catch(() => undefined);
      }
    } else if (wasPreviewingRef.current) {
      wasPreviewingRef.current = false;
      video.pause();
      seekToCover(video);
    }
  }, [previewing]);

  return (
    <>
      {!coverReady && isRealAsset ? (
        <AssetMediaState kind="video" state={videoFailed ? "unavailable" : "loading"} />
      ) : null}
      {!videoFailed ? (
        <video
          ref={videoRef}
          className={`canvas-asset-node__video${coverReady ? " is-ready" : ""}`}
          src={videoUrl}
          muted
          loop
          playsInline
          preload="metadata"
          aria-hidden="true"
          tabIndex={-1}
          onLoadedMetadata={(event) => {
            const video = event.currentTarget;
            const aspectRatio = measuredAspectRatio(video.videoWidth, video.videoHeight);
            if (aspectRatio != null) onAspectRatioChange(aspectRatio);
            if (Number.isFinite(video.duration) && video.duration > 0) {
              coverTimeRef.current = video.duration / 2;
            }
            if (!previewing) seekToCover(video);
          }}
          onSeeked={() => setCoverReady(true)}
          onLoadedData={() => {
            setFailedVideoUrl(null);
            setCoverReady(true);
          }}
          onError={() => {
            setCoverReady(false);
            setFailedVideoUrl(videoUrl);
          }}
        />
      ) : null}
    </>
  );
}

/** 画布上的素材节点：展示素材预览，输出端口可拖出连线到生成节点或其他素材节点。 */
export function CanvasAssetNode({
  node,
  edgeCount,
  dragging,
  onNodeDragStart,
  onConnectionStart,
  onRemove,
  onAspectRatioChange,
}: {
  readonly node: AssetNodeData;
  readonly edgeCount: number;
  /** 该节点正在被拖动（视觉反馈）。 */
  readonly dragging: boolean;
  /** 节点主体按下：开始拖动节点（端口与移除按钮已阻止冒泡）。 */
  readonly onNodeDragStart: (
    key: string,
    x: number,
    y: number,
    clientX: number,
    clientY: number,
  ) => void;
  readonly onConnectionStart: (key: string) => void;
  readonly onRemove: (key: string) => void;
  readonly onAspectRatioChange: (key: string, aspectRatio: number) => void;
}) {
  const typeLabel = ASSET_KIND_LABELS[node.kind];
  const isVideo = node.kind === "video";
  const [previewing, setPreviewing] = useState(false);
  const [loadedImageUrl, setLoadedImageUrl] = useState<string | null>(null);
  const [failedImageUrl, setFailedImageUrl] = useState<string | null>(null);
  const imageReady = node.previewUrl != null && loadedImageUrl === node.previewUrl;
  const imageFailed = node.previewUrl == null || failedImageUrl === node.previewUrl;
  const isRealAsset = node.source != null || isDesktopRuntime();
  const dimensions = assetNodeDimensions(node);
  return (
    <div
      className={`canvas-asset-node${node.kind === "image" || node.kind === "video" ? " canvas-asset-node--media" : ""}${dragging ? " is-dragging" : ""}`}
      style={{ ...dimensions }}
      data-connection-target={node.key}
      onMouseDown={(event) =>
        onNodeDragStart(node.key, node.x, node.y, event.clientX, event.clientY)
      }
      onMouseEnter={() => {
        if (isVideo) setPreviewing(true);
      }}
      onMouseLeave={() => {
        if (isVideo) setPreviewing(false);
      }}
    >
      <span className="canvas-asset-node__visual">
        {isVideo && node.videoUrl ? (
          <CanvasAssetNodeVideoVisual
            videoUrl={node.videoUrl}
            previewing={previewing}
            isRealAsset={isRealAsset}
            onAspectRatioChange={(aspectRatio) => onAspectRatioChange(node.key, aspectRatio)}
          />
        ) : node.kind === "image" ? (
          <>
            {isRealAsset && !imageReady ? (
              <AssetMediaState kind="image" state={imageFailed ? "unavailable" : "loading"} />
            ) : null}
            {node.previewUrl && !imageFailed ? (
              <img
                src={node.previewUrl}
                alt=""
                draggable={false}
                decoding="async"
                onLoad={(event) => {
                  const image = event.currentTarget;
                  const aspectRatio = measuredAspectRatio(image.naturalWidth, image.naturalHeight);
                  if (aspectRatio != null) onAspectRatioChange(node.key, aspectRatio);
                  setLoadedImageUrl(node.previewUrl);
                  setFailedImageUrl(null);
                }}
                onError={() => {
                  setLoadedImageUrl(null);
                  setFailedImageUrl(node.previewUrl);
                }}
              />
            ) : null}
          </>
        ) : node.kind === "audio" ? (
          <span className="waveform waveform--node" aria-hidden="true">
            {Array.from({ length: 14 }, (_, index) => (
              <i key={index} style={{ "--bar": (index % 5) + 2 } as CSSProperties} />
            ))}
          </span>
        ) : null}
      </span>
      <span className="canvas-asset-node__identity">
        <AssetKindIcon kind={node.kind} />
        <span className="canvas-asset-node__name" title={node.name}>
          {node.name}
        </span>
      </span>
      <span className="canvas-asset-node__meta">
        {typeLabel} · {edgeCount > 0 ? `${edgeCount} 条连线` : "未连接"}
      </span>
      <button
        type="button"
        className="canvas-asset-node__remove"
        aria-label={`移除素材节点：${node.name}`}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onRemove(node.key);
        }}
      >
        <X size={11} weight="bold" aria-hidden="true" />
      </button>
      <button
        type="button"
        className="canvas-asset-node__port"
        aria-label={`从 ${node.name} 拖出连线`}
        title="拖到生成节点或其他素材节点建立连线"
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onConnectionStart(node.key);
        }}
      />
    </div>
  );
}

/** 画布产物的全屏源媒体浏览器：优先使用本地最终文件，否则使用会话内预览地址。 */
export function CanvasOutputLightbox({
  node,
  onClose,
}: {
  readonly node: OutputNodeData;
  readonly onClose: () => void;
}) {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const finalPath = node.finalPath;

  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };

    window.addEventListener("keydown", handleKeyDown, true);
    closeButtonRef.current?.focus();
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [onClose]);

  const mediaSrc = finalPath != null ? toMediaSrc(finalPath) : (node.previewSrc ?? null);
  if (mediaSrc == null) return null;
  const mediaName =
    node.name ??
    (finalPath != null ? fileNameFromPath(finalPath) : null) ??
    (node.mediaType === "video" ? "生成视频" : "生成图片");

  return createPortal(
    <div className="history-lightbox" role="dialog" aria-modal="true" aria-label="媒体预览">
      <button
        ref={closeButtonRef}
        type="button"
        className="history-lightbox__close"
        aria-label="关闭媒体预览"
        onClick={onClose}
      >
        <X size={22} weight="bold" aria-hidden="true" />
      </button>
      <div
        className="history-lightbox__stage"
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        {node.mediaType === "video" ? (
          <video
            className="history-lightbox__media"
            src={mediaSrc}
            aria-label={mediaName}
            controls
            autoPlay
            playsInline
          />
        ) : (
          <img
            className="history-lightbox__media"
            src={mediaSrc}
            alt={mediaName}
            draggable={false}
          />
        )}
      </div>
    </div>,
    document.body,
  );
}

/**
 * 画布上的生成产物卡片：任务启动时自动创建，承担原任务状态栏的职责：
 * - 进行中：展示任务状态（排队/生成中/重试等待）与进度；
 * - 成功：先展示供应商预览，保存完成后展示本地产物（图片直接显示，视频中间帧封面 + 悬浮播放）；
 * - 失败：展示完整原始返回（rawResponse），以虚线连回来源生成节点。
 */
export function CanvasOutputNode({
  node,
  dragging,
  onNodeDragStart,
  onRemove,
  onAspectRatioChange,
  onPreview,
  onConnectionStart,
  task,
  retryInfo,
  results,
  rawResponse,
  modelLabel,
}: {
  readonly node: OutputNodeData;
  /** 该节点正在被拖动（视觉反馈）。 */
  readonly dragging: boolean;
  /** 节点主体按下：开始拖动节点（移除/复制按钮已阻止冒泡）。
   * activateOnTap 可选：按在媒体区域上且未拖动的抬起触发（全屏预览）。 */
  readonly onNodeDragStart: (
    key: string,
    x: number,
    y: number,
    clientX: number,
    clientY: number,
    activateOnTap?: () => void,
  ) => void;
  readonly onRemove: (key: string) => void;
  readonly onAspectRatioChange: (key: string, aspectRatio: number) => void;
  readonly onPreview: (key: string) => void;
  readonly onConnectionStart: (key: string) => void;
  /** 卡片对应任务的最新摘要（任务列表查不到时为 null）。 */
  readonly task: GenerationTaskSummary | null;
  /** 重试等待信息（generation:retry 事件驱动）。 */
  readonly retryInfo: RetryInfo | null;
  /** 该任务的全部结果记录（判断保存失败等边缘状态）。 */
  readonly results: readonly GenerationResultRecord[];
  /** 失败任务的完整原始返回（按需加载）。 */
  readonly rawResponse: string | null;
  /** 模型展示名（进行中/失败态展示）。 */
  readonly modelLabel: string | null;
}) {
  const isVideo = node.mediaType === "video";
  const [previewing, setPreviewing] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyResetTimerRef = useRef<number | undefined>(undefined);
  const mediaSrc = node.finalPath != null ? toMediaSrc(node.finalPath) : (node.previewSrc ?? null);

  // 供应商结果已返回 → 立即展示媒体；本地 finalPath 到达后再切换为长期引用。
  const hasArtifact = mediaSrc != null;
  const hasLocalArtifact = node.finalPath != null;
  const isPreviewOnly = !hasLocalArtifact && hasArtifact;
  const canUseAsGenerationReference = outputNodeReferenceTarget(node) != null;
  const canConnectToComposer = isVideo && hasArtifact;
  const dimensions = outputNodeDimensions(node);

  // 未落卡时按任务状态派生展示阶段。
  const progress =
    task?.progress != null ? Math.min(100, Math.max(0, Math.round(task.progress))) : null;
  const statusText = (() => {
    // 任务记录尚未出现在任务列表（提交后瞬时/列表刷新延迟）：视为进行中。
    if (task == null) return "任务记录同步中";
    if (task.status === "retry_wait") {
      if (retryInfo) {
        return `${Math.max(1, Math.round(retryInfo.delayMs / 1000))} 秒后第 ${retryInfo.retry} 次请求`;
      }
      return "重试等待中";
    }
    if (task.status === "running" && progress != null) {
      return `生成中 · ${progress}%`;
    }
    return TASK_STATUS_LABELS[task.status] ?? task.status;
  })();
  const failedSaveResult = results.find((result) =>
    ["failed", "interrupted", "local_missing", "conflict"].includes(result.saveStatus),
  );
  // 展示阶段：running = 任务进行中（含任务记录同步中）；failed = 任务失败/保存失败；saving = 任务成功但结果尚未落卡。
  const phase: "running" | "failed" | "saving" = (() => {
    if (task == null) return "running";
    if (isRunningTaskStatus(task.status) || task.status === "retry_wait") return "running";
    if (task.status === "succeeded") return failedSaveResult ? "failed" : "saving";
    return "failed";
  })();
  const isRunning = !hasArtifact && phase === "running";
  const isSaving = !hasLocalArtifact && phase === "saving";
  const isFailed = !hasArtifact && phase === "failed";
  const failedTitle = (() => {
    if (task != null && task.status === "succeeded" && failedSaveResult) {
      return SAVE_STATUS_LABELS[failedSaveResult.saveStatus] ?? "结果保存失败";
    }
    return statusText;
  })();
  const failedDetail = (() => {
    if (task != null && task.status === "succeeded" && failedSaveResult) {
      const saveError =
        failedSaveResult.error == null ? null : JSON.stringify(failedSaveResult.error, null, 2);
      return saveError ?? rawResponse;
    }
    return rawResponse;
  })();

  // 一键复制完整错误信息：桌面端走系统剪贴板插件，复制成功后短暂反馈「已复制」。
  const copyFailedDetail = useCallback(async () => {
    if (failedDetail == null) return;
    try {
      if (isDesktopRuntime()) {
        await copyTextToDesktopClipboard(failedDetail);
      } else if (navigator.clipboard != null) {
        await navigator.clipboard.writeText(failedDetail);
      } else {
        throw new Error("当前环境不支持剪贴板写入。");
      }
      setCopied(true);
      toast.success("错误信息已复制");
      window.clearTimeout(copyResetTimerRef.current);
      copyResetTimerRef.current = window.setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      const message = formatRawBackendError(error);
      toast.error("复制失败", { description: message });
      frontendLog("error", `[canvas] 复制错误信息失败: ${message}`);
    }
  }, [failedDetail]);

  // 卸载时清理「已复制」回退计时器，避免对已卸载组件 setState。
  useEffect(() => {
    return () => window.clearTimeout(copyResetTimerRef.current);
  }, []);
  const metaLine =
    node.origin === "composition"
      ? "视频拼接与合成 · 本地结果"
      : node.origin === "download"
        ? "网络爆款视频下载 · 本地结果"
        : task
          ? `${isVideo ? "视频生成" : "图片生成"} · ${modelLabel ?? ""} · ${
              isFailed
                ? formatTaskClock(task.completedAt ?? task.updatedAt)
                : formatTaskClock(task.createdAt)
            }`
          : `${isVideo ? "视频生成" : "图片生成"} · ${shortenTaskId(node.taskId)}`;

  return (
    <div
      className={`canvas-asset-node canvas-asset-node--output canvas-asset-node--output--${node.mediaType}${hasArtifact ? " canvas-asset-node--media" : ""}${isFailed ? " canvas-asset-node--output--failed" : ""}${dragging ? " is-dragging" : ""}`}
      style={{ ...dimensions }}
      aria-busy={isRunning || isSaving ? "true" : undefined}
      onMouseDown={(event) => {
        // 整卡任意位置可自由拖动；按在媒体区域上且未发生位移的抬起视为点按，
        // React Flow 负责整卡拖动；媒体按钮自身的 click 负责打开全屏预览。
        const activateOnTap =
          (event.target as HTMLElement).closest(".canvas-asset-node__preview-button") != null
            ? () => onPreview(node.key)
            : undefined;
        onNodeDragStart(node.key, node.x, node.y, event.clientX, event.clientY, activateOnTap);
      }}
      onMouseEnter={() => {
        if (isVideo && hasArtifact) setPreviewing(true);
      }}
      onMouseLeave={() => {
        if (isVideo && hasArtifact) setPreviewing(false);
      }}
    >
      {mediaSrc != null ? (
        <>
          <button
            type="button"
            className="canvas-asset-node__visual canvas-asset-node__preview-button"
            aria-label={`全屏浏览产物：${node.name ?? (isVideo ? "视频" : "图片")}`}
            title="拖动移动卡片 · 点击全屏浏览源媒体"
            onClick={(event) => {
              // 指针点按由拖动结束的激活回调处理（捕获层接管了 mouseup）；
              // 这里保留键盘 Enter/Space 激活路径。
              event.stopPropagation();
              onPreview(node.key);
            }}
          >
            {isVideo ? (
              <CanvasAssetNodeVideoVisual
                videoUrl={mediaSrc}
                previewing={previewing}
                isRealAsset
                onAspectRatioChange={(aspectRatio) => onAspectRatioChange(node.key, aspectRatio)}
              />
            ) : (
              <img
                src={mediaSrc}
                alt=""
                draggable={false}
                decoding="async"
                onLoad={(event) => {
                  const image = event.currentTarget;
                  const aspectRatio = measuredAspectRatio(image.naturalWidth, image.naturalHeight);
                  if (aspectRatio != null) onAspectRatioChange(node.key, aspectRatio);
                }}
              />
            )}
          </button>
          <span className="canvas-asset-node__identity">
            <AssetKindIcon kind={node.mediaType} />
            <span className="canvas-asset-node__name" title={node.name ?? undefined}>
              {node.name ?? (isPreviewOnly ? "生成结果（正在保存）" : "")}
            </span>
          </span>
          <span className="canvas-asset-node__meta">
            {node.origin === "composition"
              ? `合成视频 · ${isPreviewOnly ? "已导出浏览器下载" : "已保存到本机"}`
              : `${isVideo ? "视频" : "图片"}产物 · ${
                  isPreviewOnly
                    ? failedSaveResult
                      ? "本地保存失败"
                      : "正在保存本地副本"
                    : "已连线来源节点 · 可作为参考输入"
                }`}
          </span>
        </>
      ) : isFailed ? (
        <>
          <span className="canvas-output-node__state canvas-output-node__state--failed">
            <WarningCircle size={14} weight="fill" aria-hidden="true" />
            <span className="canvas-output-node__state-title">{failedTitle}</span>
            <button
              type="button"
              className="canvas-output-node__copy"
              aria-label="复制错误信息"
              disabled={failedDetail == null}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                void copyFailedDetail();
              }}
            >
              {copied ? (
                <Check size={13} weight="bold" aria-hidden="true" />
              ) : (
                <CopySimple size={13} weight="bold" aria-hidden="true" />
              )}
              {copied ? "已复制" : "复制错误"}
            </button>
          </span>
          <pre className="canvas-output-node__error" aria-label="完整原始返回" tabIndex={0}>
            {failedDetail ?? "正在读取原始返回…"}
          </pre>
          <span className="canvas-asset-node__meta">{metaLine}</span>
        </>
      ) : (
        <>
          <span className="canvas-output-node__state">
            <span className={isRunning ? "spin-icon" : undefined}>
              {phase === "saving" ? (
                <CheckCircle size={16} weight="fill" aria-hidden="true" />
              ) : (
                <CircleNotch size={16} weight="bold" aria-hidden="true" />
              )}
            </span>
            <span className="canvas-output-node__status">
              {phase === "saving" ? "已成功 · 等待结果保存" : statusText}
            </span>
            {isRunning && progress != null ? (
              <span
                className="canvas-output-node__progress"
                role="progressbar"
                aria-label={`${isVideo ? "视频生成" : "图片生成"}进度`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progress}
              >
                <i style={{ width: `${progress}%` }} />
              </span>
            ) : null}
          </span>
          <span className="canvas-asset-node__identity">
            <AssetKindIcon kind={node.mediaType} />
            <span className="canvas-asset-node__name" title={modelLabel ?? undefined}>
              {modelLabel ?? shortenTaskId(node.taskId)}
            </span>
          </span>
          <span className="canvas-asset-node__meta">{metaLine}</span>
        </>
      )}
      <button
        type="button"
        className="canvas-asset-node__remove"
        aria-label={`移除产物卡片：${node.name ?? statusText}`}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onRemove(node.key);
        }}
      >
        <X size={11} weight="bold" aria-hidden="true" />
      </button>
      {canUseAsGenerationReference || canConnectToComposer ? (
        <button
          type="button"
          className="canvas-asset-node__port"
          aria-label={`从${isVideo ? "视频" : "图片"}产物 ${node.name ?? "未命名"} 拖出连线`}
          title={
            canUseAsGenerationReference
              ? isVideo
                ? "拖到图片/视频生成节点作为参考视频，或拖到视频拼接与合成、爆款视频复刻节点"
                : "拖到图片/视频生成节点作为参考图片"
              : "拖到视频拼接与合成或爆款视频复刻节点"
          }
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onConnectionStart(node.key);
          }}
        />
      ) : null}
    </div>
  );
}

/** 画布上的结果展示节点：预览最近一次生成结果，可打开所在文件夹。 */
export function CanvasResultNode({
  node,
  descriptor,
  selected,
  dragging,
  latestResult,
  onSelect,
  onNodeDragStart,
  onRemove,
}: {
  readonly node: ResultNodeData;
  readonly descriptor: StaticNodeDescriptor;
  readonly selected: boolean;
  readonly dragging: boolean;
  readonly latestResult: GenerationResultRecord | null;
  readonly onSelect: (key: string) => void;
  readonly onNodeDragStart: (
    key: string,
    x: number,
    y: number,
    clientX: number,
    clientY: number,
  ) => void;
  readonly onRemove: (key: string) => void;
}) {
  return (
    <div
      className={`canvas-result-node${selected ? " is-selected" : ""}${dragging ? " is-dragging" : ""}`}
      onMouseDown={(event) => {
        if ((event.target as HTMLElement).closest(".canvas-result-node__actions")) return;
        onSelect(node.key);
        onNodeDragStart(node.key, node.x, node.y, event.clientX, event.clientY);
      }}
    >
      <div className="canvas-result-node__header">
        <span className="canvas-result-node__type">
          <NodeTypeIcon kind="result" />
          {descriptor.kindLabel}
        </span>
        <span className="canvas-result-node__title" title={descriptor.description}>
          {descriptor.title}
        </span>
        <span className="canvas-result-node__actions">
          {latestResult?.finalPath && isDesktopRuntime() ? (
            <button
              type="button"
              className="canvas-result-node__reveal"
              aria-label="在文件夹中显示生成结果"
              title="在文件夹中显示"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                if (latestResult.finalPath) {
                  void revealDesktopItem(latestResult.finalPath).catch(() => undefined);
                }
              }}
            >
              <FolderOpen size={13} weight="bold" aria-hidden="true" />
            </button>
          ) : null}
          <button
            type="button"
            className="canvas-result-node__remove"
            aria-label={`移除${descriptor.title}节点`}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onRemove(node.key);
            }}
          >
            <X size={12} weight="bold" aria-hidden="true" />
          </button>
        </span>
      </div>
      <span className="keyframe-preview keyframe-preview--large" aria-hidden="true">
        {latestResult?.finalPath && isDesktopRuntime() ? (
          latestResult.mediaType === "video" ? (
            <video src={toMediaSrc(latestResult.finalPath)} muted playsInline preload="metadata" />
          ) : (
            <img
              src={toMediaSrc(latestResult.finalPath)}
              alt=""
              draggable={false}
              decoding="async"
            />
          )
        ) : null}
      </span>
      <span className="result-facts">
        <span>
          {latestResult
            ? `${ASSET_KIND_LABELS[latestResult.mediaType]}结果 · ${fileBaseName(latestResult.finalPath) ?? "路径未记录"}${
                formatBytes(latestResult.byteSize) ? ` · ${formatBytes(latestResult.byteSize)}` : ""
              }`
            : "暂无结果 · 发起生成后显示"}
        </span>
        <span className="result-saved">
          {latestResult ? (SAVE_STATUS_LABELS[latestResult.saveStatus] ?? "已保存") : "等待生成"}
        </span>
      </span>
    </div>
  );
}

/** 生成节点的有效参考素材列表：直连素材可解绑，随提示词继承的素材标明来源。 */
function GenerationInputChips({
  inputs,
  onUnlink,
}: {
  readonly inputs: readonly (ConnectedAssetInput | InheritedAssetInput)[];
  readonly onUnlink: (edgeId: string) => void;
}) {
  if (inputs.length === 0) return null;
  return (
    <ol className="node-media-inputs" aria-label="生成参考素材，按传入顺序排列">
      {inputs.map((input, index) => {
        const inherited = "promptNodeKey" in input;
        const isOutput = !inherited && input.sourceLabel === "产物";
        return (
          <li
            key={inherited ? `inherited:${input.promptNodeKey}:${input.key}` : input.edgeId}
            className={`node-media-chip${inherited ? " is-inherited" : ""}${isOutput ? " is-output" : ""}`}
          >
            <span
              className="node-media-chip__order"
              aria-label={`参考素材传入顺序 ${index + 1}`}
              title={`第 ${index + 1} 个传入生成请求的参考素材`}
            >
              {index + 1}
            </span>
            <span className="node-media-chip__name" title={input.name}>
              {input.name}
            </span>
            {inherited ? (
              <span
                className="node-media-chip__origin"
                title="由上游提示词节点的视觉理解素材自动继承"
              >
                随提示词
              </span>
            ) : (
              <>
                {isOutput ? (
                  <span className="node-media-chip__origin" title="来自上游生成节点的已保存产物">
                    产物
                  </span>
                ) : null}
                <button
                  type="button"
                  className="node-media-chip__unlink"
                  aria-label={`解除连线：${input.name}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onUnlink(input.edgeId);
                  }}
                >
                  <X size={10} weight="bold" aria-hidden="true" />
                </button>
              </>
            )}
          </li>
        );
      })}
    </ol>
  );
}
