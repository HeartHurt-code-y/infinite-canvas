import { ArrowCounterClockwise } from "@phosphor-icons/react/ArrowCounterClockwise";
import { Check } from "@phosphor-icons/react/Check";
import { Pause } from "@phosphor-icons/react/Pause";
import { PencilSimple } from "@phosphor-icons/react/PencilSimple";
import { Play } from "@phosphor-icons/react/Play";
import { Rectangle } from "@phosphor-icons/react/Rectangle";
import { Trash } from "@phosphor-icons/react/Trash";
import { X } from "@phosphor-icons/react/X";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { isDesktopRuntime, type ExplicitMediaTarget } from "../../lib/backend";
import {
  createPromptContentModule,
  type PromptContentDocumentV1,
  type PromptContentEditorSession,
} from "../../lib/promptContent";
import type { PromptReferenceCandidate } from "../../lib/promptReferences";
import { prepareVideoEditSource, type PreparedVideoEditSource } from "../../lib/videoLocalEdit";

import { PromptMentionInput } from "./PromptNodeViews";
import {
  VIDEO_EDIT_COLORS,
  exportVideoLocalEditFrame,
  formatVideoEditTime,
  isVisibleVideoEditMark,
  videoEditPointFromClient,
  videoEditStrokeWidth,
  type VideoEditMark,
} from "./videoLocalEditDrawing";
import "./VideoLocalEditDialog.css";

export interface VideoLocalEditSource {
  readonly key: string;
  readonly label: string;
  readonly src: string;
  readonly target?: ExplicitMediaTarget;
}

export interface VideoLocalEditResult {
  readonly imageDataUrl: string;
  readonly timeSeconds: number;
  /**
   * 编辑要求沿用提示内容的引用文档：正文与 @ 素材引用同构，
   * 由调用方并入生成节点提示词，保留引用身份而不是退化成素材名文本。
   */
  readonly instructionDocument: PromptContentDocumentV1;
  readonly operation: "remove" | "replace";
  readonly sourceKey: string;
  readonly timeRange: { readonly startSeconds: number; readonly endSeconds: number } | null;
}

export interface VideoLocalEditDialogProps {
  readonly source: VideoLocalEditSource;
  /** 当前生成节点已连接的媒体素材，供编辑要求 @ 引用（替换素材即来自这里）。 */
  readonly candidates: readonly PromptReferenceCandidate[];
  readonly onClose: () => void;
  readonly onApply: (result: VideoLocalEditResult) => Promise<void>;
}

/** 编辑要求编辑器在弹窗私有提示内容模块中的固定键；与画布节点提示词互不干扰。 */
const INSTRUCTION_EDITOR_KEY = "video-local-edit-instruction";

export function VideoLocalEditDialog(props: VideoLocalEditDialogProps) {
  // A changed source must never inherit another video's frame or marks.
  return (
    <VideoLocalEditDialogContent
      key={`${props.source.key}:${props.source.src}:${JSON.stringify(props.source.target)}`}
      {...props}
    />
  );
}

function VideoLocalEditDialogContent({
  source,
  candidates,
  onClose,
  onApply,
}: VideoLocalEditDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const draftRef = useRef<VideoEditMark | null>(null);
  const pointerRef = useRef<number | null>(null);
  const submittingRef = useRef(false);
  const titleId = useId();
  const hintId = useId();
  const instructionLabelId = useId();
  const instructionHintId = useId();
  // 编辑要求与画布提示词共用引用规则，但使用弹窗私有的内容模块，不写入节点提示词。
  const [instructionModule] = useState(() => createPromptContentModule());
  const registerInstructionInput = useCallback(
    (nodeKey: string, session: PromptContentEditorSession | null) => {
      instructionModule.adoptEditor(nodeKey, session);
    },
    [instructionModule],
  );
  const [dimensions, setDimensions] = useState({ width: 16, height: 9 });
  const [duration, setDuration] = useState(0);
  const [time, setTime] = useState(0);
  const [ready, setReady] = useState(false);
  const [seeking, setSeeking] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [tool, setTool] = useState<VideoEditMark["kind"]>("rectangle");
  const [color, setColor] = useState<string>(VIDEO_EDIT_COLORS[0].value);
  const [marks, setMarks] = useState<VideoEditMark[]>([]);
  const [draft, setDraft] = useState<VideoEditMark | null>(null);
  const [operation, setOperation] = useState<VideoLocalEditResult["operation"]>("remove");
  const [rangeEnabled, setRangeEnabled] = useState(false);
  const [rangeStart, setRangeStart] = useState(0);
  const [rangeEnd, setRangeEnd] = useState(0);
  const [instructionText, setInstructionText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sourceError, setSourceError] = useState(false);
  const needsPreparation = source.target != null || isDesktopRuntime();
  const [previewSrc, setPreviewSrc] = useState<string | null>(needsPreparation ? null : source.src);
  const [preparationAttempt, setPreparationAttempt] = useState(0);
  const [region, setRegion] = useState({ x: 25, y: 25, width: 50, height: 50 });
  const canDraw = ready && !seeking && !playing && !busy;
  const validRange =
    !rangeEnabled ||
    (Number.isFinite(rangeStart) &&
      Number.isFinite(rangeEnd) &&
      rangeStart >= 0 &&
      rangeEnd > rangeStart &&
      rangeEnd <= duration);
  // 编辑要求必须同时含正文：纯 @ 引用无法表达「改成什么、保持什么」，
  // 与原先的纯文本输入框保持同一道门槛。
  const canApply =
    canDraw &&
    marks.some(isVisibleVideoEditMark) &&
    instructionText.trim().length > 0 &&
    !draft &&
    validRange;

  useEffect(() => {
    if (!needsPreparation) return;
    let disposed = false;
    let prepared: PreparedVideoEditSource | null = null;
    const video = videoRef.current;
    void prepareVideoEditSource(source.target, source.src).then(
      (result) => {
        if (disposed) {
          void result.release();
          return;
        }
        prepared = result;
        setPreviewSrc(result.src);
      },
      (reason: unknown) => {
        if (disposed) return;
        const message =
          reason instanceof Error
            ? reason.message
            : typeof reason === "object" &&
                reason != null &&
                "message" in reason &&
                typeof reason.message === "string"
              ? reason.message
              : "读取原视频失败，请重试。";
        setError(message);
        setSourceError(true);
      },
    );
    return () => {
      disposed = true;
      // Close WebView's file handle before releasing the owned preview on Windows.
      video?.pause();
      video?.removeAttribute("src");
      video?.load();
      if (prepared) void prepared.release();
    };
  }, [needsPreparation, source.target, source.src, preparationAttempt]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement;
    if (typeof dialog.showModal === "function") {
      try {
        dialog.showModal();
      } catch {
        dialog.setAttribute("open", "");
      }
    } else dialog.setAttribute("open", "");
    closeRef.current?.focus();
    return () => {
      if (dialog.open) {
        if (typeof dialog.close === "function") dialog.close();
        else dialog.removeAttribute("open");
      }
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  function clearMarks() {
    draftRef.current = null;
    pointerRef.current = null;
    setDraft(null);
    setMarks([]);
  }

  function reloadSource() {
    clearMarks();
    setPreviewSrc(null);
    setError(null);
    setSourceError(false);
    setReady(false);
    setSeeking(false);
    setPlaying(false);
    setDuration(0);
    setTime(0);
    setPreparationAttempt((attempt) => attempt + 1);
  }

  function updateMetadata(video: HTMLVideoElement) {
    if (video.videoWidth > 0 && video.videoHeight > 0)
      setDimensions({ width: video.videoWidth, height: video.videoHeight });
    setDuration(Number.isFinite(video.duration) ? video.duration : 0);
    setTime(video.currentTime);
  }

  function pointerPoint(event: PointerEvent<SVGSVGElement>, clamp = false) {
    return videoEditPointFromClient(
      { x: event.clientX, y: event.clientY },
      event.currentTarget.getBoundingClientRect(),
      dimensions.width,
      dimensions.height,
      clamp,
    );
  }

  function beginMark(event: PointerEvent<SVGSVGElement>) {
    if (!canDraw || event.button !== 0 || pointerRef.current !== null) return;
    const point = pointerPoint(event);
    if (!point) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    pointerRef.current = event.pointerId;
    draftRef.current = { kind: tool, color, points: [point, point] };
    setDraft(draftRef.current);
    setError(null);
  }

  function updateMark(event: PointerEvent<SVGSVGElement>) {
    const current = draftRef.current;
    if (!current || pointerRef.current !== event.pointerId) return;
    const point = pointerPoint(event, true);
    const first = current.points[0];
    if (!point || !first) return;
    const next = {
      ...current,
      points: current.kind === "rectangle" ? [first, point] : [...current.points, point],
    };
    draftRef.current = next;
    setDraft(next);
  }

  function finishMark(event: PointerEvent<SVGSVGElement>) {
    if (pointerRef.current !== event.pointerId) return;
    updateMark(event);
    const current = draftRef.current;
    if (current && isVisibleVideoEditMark(current)) setMarks((previous) => [...previous, current]);
    draftRef.current = null;
    pointerRef.current = null;
    setDraft(null);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function seekTo(seconds: number) {
    const video = videoRef.current;
    if (!video || busy) return;
    video.pause();
    clearMarks();
    const next = Math.max(0, Math.min(duration, seconds));
    setPlaying(false);
    setTime(next);
    setSeeking(video.currentTime !== next);
    video.currentTime = next;
  }

  async function togglePlayback() {
    const video = videoRef.current;
    if (!video || busy) return;
    if (!video.paused) {
      video.pause();
      return;
    }
    clearMarks();
    try {
      await video.play();
    } catch {
      setError("视频播放失败，请重新选择视频或检查文件是否可用。");
    }
  }

  async function apply() {
    const video = videoRef.current;
    if (!video || !canApply || submittingRef.current) return;
    submittingRef.current = true;
    setBusy(true);
    setError(null);
    dialogRef.current?.focus();
    try {
      const imageDataUrl = exportVideoLocalEditFrame(video, marks);
      // 快照而非读取缓存视图：提交瞬间也要拿到编辑器里最新的引用文档。
      const instructionDocument = instructionModule.snapshotAll(new Set([INSTRUCTION_EDITOR_KEY]))[
        INSTRUCTION_EDITOR_KEY
      ];
      if (!instructionDocument) throw new Error("编辑要求无法读取，请重新填写。");
      await onApply({
        imageDataUrl,
        timeSeconds: video.currentTime,
        instructionDocument,
        operation,
        sourceKey: source.key,
        timeRange: rangeEnabled ? { startSeconds: rangeStart, endSeconds: rangeEnd } : null,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "添加标注帧失败，请重试。");
    } finally {
      submittingRef.current = false;
      setBusy(false);
    }
  }

  const displayedMarks = draft ? [...marks, draft] : marks;

  return createPortal(
    <dialog
      ref={dialogRef}
      className="video-local-edit-dialog"
      tabIndex={-1}
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={hintId}
      aria-busy={busy}
      onCancel={(event) => {
        event.preventDefault();
        if (!submittingRef.current) onClose();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          // 编辑要求编辑器已用 Escape 关闭自己的候选菜单或待确认项时，不连带关闭弹窗。
          if (event.defaultPrevented) return;
          event.preventDefault();
          if (!submittingRef.current) onClose();
        }
        if (event.key === "Tab") {
          const controls = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>(
              'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, [contenteditable="true"], [tabindex="0"]',
            ),
          ).filter(
            (element) =>
              !element.closest("fieldset:disabled") &&
              (!element.closest("details:not([open])") || element.tagName === "SUMMARY"),
          );
          const first = controls[0];
          const last = controls.at(-1);
          if (busy || !first) {
            event.preventDefault();
            return;
          }
          if (
            event.shiftKey &&
            (document.activeElement === first || document.activeElement === dialogRef.current)
          ) {
            event.preventDefault();
            last?.focus();
          } else if (
            !event.shiftKey &&
            (document.activeElement === last || document.activeElement === dialogRef.current)
          ) {
            event.preventDefault();
            first.focus();
          }
        }
      }}
    >
      <header className="video-local-edit-dialog__header">
        <div>
          <h2 id={titleId}>局部消除与编辑</h2>
          <p>{source.label}</p>
        </div>
        <button
          ref={closeRef}
          type="button"
          aria-label="关闭局部编辑"
          onClick={onClose}
          disabled={busy}
        >
          <X size={20} aria-hidden="true" />
        </button>
      </header>
      <div className="video-local-edit-dialog__body">
        <p id={hintId} className="video-local-edit-dialog__hint">
          暂停在需要修改的画面，框选或圈出对象，再填写编辑要求。播放或切换时间会清空当前标记。
        </p>
        <div className="video-local-edit-dialog__viewport">
          <video
            ref={videoRef}
            src={previewSrc ?? undefined}
            crossOrigin="anonymous"
            preload="auto"
            playsInline
            aria-label={`待编辑视频：${source.label}`}
            onLoadedMetadata={(event) => updateMetadata(event.currentTarget)}
            onLoadedData={(event) => {
              updateMetadata(event.currentTarget);
              setReady(true);
              setError(null);
              setSourceError(false);
            }}
            onDurationChange={(event) => updateMetadata(event.currentTarget)}
            onSeeking={() => setSeeking(true)}
            onSeeked={(event) => {
              setTime(event.currentTarget.currentTime);
              setSeeking(false);
              setReady(event.currentTarget.readyState >= 2);
            }}
            onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
            onError={() => {
              if (!previewSrc) return;
              setReady(false);
              setSeeking(false);
              setSourceError(true);
              setError(
                "无法加载此视频。请重试读取原视频；如仍失败，请检查源文件是否有效或当前设备是否支持该视频编码。",
              );
            }}
          />
          <svg
            className="video-local-edit-dialog__marks"
            viewBox={`0 0 ${dimensions.width} ${dimensions.height}`}
            preserveAspectRatio="xMidYMid meet"
            role="img"
            aria-label={`视频标注区域，已有 ${marks.length} 处标记`}
            aria-disabled={!canDraw}
            onPointerDown={beginMark}
            onPointerMove={updateMark}
            onPointerUp={finishMark}
            onPointerCancel={() => {
              draftRef.current = null;
              pointerRef.current = null;
              setDraft(null);
            }}
          >
            {displayedMarks.map((mark, index) => {
              const first = mark.points[0];
              const last = mark.points.at(-1);
              if (!first || !last) return null;
              const style = {
                fill: "none",
                stroke: mark.color,
                strokeWidth: videoEditStrokeWidth(dimensions.width, dimensions.height),
                strokeLinecap: "round" as const,
                strokeLinejoin: "round" as const,
              };
              return mark.kind === "rectangle" ? (
                <rect
                  key={index}
                  {...style}
                  x={Math.min(first.x, last.x) * dimensions.width}
                  y={Math.min(first.y, last.y) * dimensions.height}
                  width={Math.abs(last.x - first.x) * dimensions.width}
                  height={Math.abs(last.y - first.y) * dimensions.height}
                />
              ) : (
                <polyline
                  key={index}
                  {...style}
                  points={mark.points
                    .map((point) => `${point.x * dimensions.width},${point.y * dimensions.height}`)
                    .join(" ")}
                />
              );
            })}
          </svg>
          {(!ready || seeking) && !error && (
            <div className="video-local-edit-dialog__loading" role="status">
              {seeking ? "正在定位画面…" : previewSrc ? "正在加载视频…" : "正在读取原视频…"}
            </div>
          )}
        </div>
        <div className="video-local-edit-dialog__timeline">
          <button
            type="button"
            aria-label={playing ? "暂停视频" : "播放视频"}
            onClick={() => void togglePlayback()}
            disabled={!ready || busy || seeking || !!draft}
          >
            {playing ? (
              <Pause size={18} aria-hidden="true" />
            ) : (
              <Play size={18} aria-hidden="true" />
            )}
          </button>
          <input
            type="range"
            aria-label="视频时间"
            min={0}
            max={duration || 1}
            step={0.01}
            value={time}
            onChange={(event) => seekTo(Number(event.target.value))}
            disabled={!ready || duration <= 0 || busy || !!draft}
            aria-valuetext={`${formatVideoEditTime(time)} / ${formatVideoEditTime(duration)}`}
          />
          <output>
            {formatVideoEditTime(time)} / {formatVideoEditTime(duration)}
          </output>
        </div>
        <div className="video-local-edit-dialog__toolbar" role="group" aria-label="区域标注工具">
          <button
            type="button"
            aria-pressed={tool === "rectangle"}
            disabled={!canDraw || !!draft}
            onClick={() => setTool("rectangle")}
          >
            <Rectangle size={18} aria-hidden="true" />
            框选
          </button>
          <button
            type="button"
            aria-pressed={tool === "freehand"}
            disabled={!canDraw || !!draft}
            onClick={() => setTool("freehand")}
          >
            <PencilSimple size={18} aria-hidden="true" />
            画笔
          </button>
          <span className="video-local-edit-dialog__separator" />
          {VIDEO_EDIT_COLORS.map((entry) => (
            <button
              key={entry.value}
              className="video-local-edit-dialog__color"
              style={{ "--annotation-color": entry.value } as CSSProperties}
              type="button"
              aria-label={`${entry.label}标记`}
              aria-pressed={color === entry.value}
              disabled={!canDraw || !!draft}
              onClick={() => setColor(entry.value)}
            >
              {color === entry.value && <Check size={16} weight="bold" aria-hidden="true" />}
            </button>
          ))}
          <span className="video-local-edit-dialog__separator" />
          <button
            type="button"
            disabled={!canDraw || marks.length === 0 || !!draft}
            onClick={() => setMarks((previous) => previous.slice(0, -1))}
          >
            <ArrowCounterClockwise size={18} aria-hidden="true" />
            撤销
          </button>
          <button
            type="button"
            disabled={!canDraw || marks.length === 0 || !!draft}
            onClick={clearMarks}
          >
            <Trash size={18} aria-hidden="true" />
            清除
          </button>
          <span className="video-local-edit-dialog__count" role="status">
            {playing ? "暂停后可标注" : `已标记 ${marks.length} 处`}
          </span>
        </div>
        <details className="video-local-edit-dialog__keyboard-region">
          <summary>输入坐标框选</summary>
          <fieldset disabled={!canDraw || !!draft}>
            <legend>按画面百分比指定区域</legend>
            {(
              [
                { key: "x", label: "左侧位置" },
                { key: "y", label: "顶部位置" },
                { key: "width", label: "区域宽度" },
                { key: "height", label: "区域高度" },
              ] as const
            ).map(({ key, label }) => (
              <label key={key}>
                {label} (%)
                <input
                  type="number"
                  min={key === "x" || key === "y" ? 0 : 1}
                  max={100}
                  value={region[key]}
                  onChange={(event) =>
                    setRegion((previous) => ({
                      ...previous,
                      [key]: Math.max(0, Math.min(100, Number(event.target.value))),
                    }))
                  }
                />
              </label>
            ))}
            <button
              type="button"
              disabled={
                region.width <= 0 || region.height <= 0 || region.x >= 100 || region.y >= 100
              }
              onClick={() => {
                setMarks((previous) => [
                  ...previous,
                  {
                    kind: "rectangle",
                    color,
                    points: [
                      { x: region.x / 100, y: region.y / 100 },
                      {
                        x: Math.min(100, region.x + region.width) / 100,
                        y: Math.min(100, region.y + region.height) / 100,
                      },
                    ],
                  },
                ]);
                setError(null);
              }}
            >
              添加框选
            </button>
          </fieldset>
        </details>
        <fieldset className="video-local-edit-dialog__instruction" disabled={busy}>
          <legend>编辑要求</legend>
          <div
            className="video-local-edit-dialog__operation"
            role="group"
            aria-label="局部编辑方式"
          >
            <button
              type="button"
              aria-pressed={operation === "remove"}
              onClick={() => setOperation("remove")}
            >
              局部消除
            </button>
            <button
              type="button"
              aria-pressed={operation === "replace"}
              onClick={() => setOperation("replace")}
            >
              替换与编辑
            </button>
          </div>
          <span id={instructionLabelId}>
            {operation === "remove"
              ? "要消除什么，哪些内容需要保持？"
              : "替换成什么，哪些内容需要保持？"}
          </span>
          <div className="video-local-edit-dialog__reference-editor">
            <PromptMentionInput
              nodeKey={INSTRUCTION_EDITOR_KEY}
              candidates={candidates}
              registerInput={registerInstructionInput}
              labelledBy={instructionLabelId}
              describedBy={instructionHintId}
              onTextChange={setInstructionText}
              placeholder="例如：消除圈出的路人，或将水杯替换为红玫瑰，并说明哪些内容需要保持。"
            />
          </div>
          <div
            className="video-local-edit-dialog__operation"
            role="group"
            aria-label="编辑生效范围"
          >
            <button
              type="button"
              aria-pressed={!rangeEnabled}
              onClick={() => setRangeEnabled(false)}
            >
              全片生效
            </button>
            <button
              type="button"
              aria-pressed={rangeEnabled}
              onClick={() => {
                setRangeEnabled(true);
                if (rangeEnd === 0) setRangeEnd(duration);
              }}
            >
              指定时段
            </button>
          </div>
          {rangeEnabled && (
            <div className="video-local-edit-dialog__range">
              <label>
                开始时间（秒）
                <input
                  type="number"
                  min={0}
                  max={duration}
                  step={0.01}
                  value={rangeStart}
                  onChange={(event) => setRangeStart(Number(event.target.value))}
                />
              </label>
              <label>
                结束时间（秒）
                <input
                  type="number"
                  min={0}
                  max={duration}
                  step={0.01}
                  value={rangeEnd}
                  onChange={(event) => setRangeEnd(Number(event.target.value))}
                />
              </label>
              {!validRange && <p role="alert">结束时间须晚于开始时间，且范围须在视频时长内。</p>}
            </div>
          )}
          <p id={instructionHintId} className="video-local-edit-dialog__hint">
            当前帧用于定位对象；
            {rangeEnabled ? "只在指定时段执行修改。" : "将在全片中跟随该对象保持修改一致。"}
            输入 @ 可把当前节点已连接的素材引用为替换内容；未引用的连线素材仍会随请求传入。
          </p>
        </fieldset>
        {error && (
          <p className="video-local-edit-dialog__error" role="alert">
            {error}
          </p>
        )}
        {error && sourceError && needsPreparation && (
          <button type="button" onClick={reloadSource} disabled={busy}>
            重新读取视频
          </button>
        )}
      </div>
      <footer className="video-local-edit-dialog__footer">
        <p>标注帧与编辑要求将添加到当前视频生成节点。</p>
        <button type="button" onClick={onClose} disabled={busy}>
          取消
        </button>
        <button
          className="video-local-edit-dialog__apply"
          type="button"
          disabled={!canApply}
          onClick={() => void apply()}
        >
          {busy ? "正在添加标注帧…" : "添加到生成节点"}
        </button>
      </footer>
    </dialog>,
    document.body,
  );
}
