import { useCallback, useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../../components/Icon";
import {
  formatRawBackendError,
  isDesktopRuntime,
  toMediaSrc,
  type MediaReferenceTarget,
} from "../../lib/backend";
import { sameMediaSourceIdentity } from "../../lib/promptReferenceTarget";
import type { AiMediaJob, AiMediaOutput } from "../../lib/aiMedia";
import { prepareVideoEditSource, type PreparedVideoEditSource } from "../../lib/videoLocalEdit";
import {
  isVideoPreparationActive,
  validateVideoPreparationRange,
  videoPreparationClient,
  type VideoPreparationAudioFormat,
  type VideoPreparationJob,
  type VideoPreparationOperation,
  type VideoPreparationOutput,
  type VideoPreparationProbe,
} from "../../lib/videoPreparation";
import { artifactFileName, validateArtifactName } from "./artifactNames";
import { AiMediaPanel } from "./AiMediaPanel";
import { exportArtifactToDesktop } from "./desktopActions";
import "./VideoPreparationDialog.css";
import {
  subscribeArtifactNameChanges,
  artifactNameChangeMatches,
  currentArtifactDisplayName,
} from "./artifactNameSync";

export interface VideoPreparationSource {
  readonly target: MediaReferenceTarget;
  readonly name: string;
}

interface VideoPreparationDialogProps {
  readonly source: VideoPreparationSource;
  readonly onClose: () => void;
  readonly onUseOutput: (
    output: VideoPreparationOutput,
    job: VideoPreparationJob,
  ) => void | Promise<void>;
  readonly onUseAiOutput?: (output: AiMediaOutput, job: AiMediaJob) => void | Promise<void>;
}

const OPERATION_LABELS: Record<VideoPreparationOperation, string> = {
  extract_audio: "提取音轨",
  silent_video: "导出无声视频",
  clip_video: "准确裁切片段",
};
const STATUS_LABELS: Record<VideoPreparationJob["status"], string> = {
  preparing: "读取原视频",
  processing: "正在处理",
  paused: "已暂停 · 可继续",
  completed: "已完成",
  failed: "处理失败",
  cancelled: "已取消",
};

function timeLabel(seconds: number): string {
  const value = Math.max(0, seconds);
  const minutes = Math.floor(value / 60);
  return `${minutes.toString().padStart(2, "0")}:${(value % 60).toFixed(3).padStart(6, "0")}`;
}

function mergeJob(
  items: readonly VideoPreparationJob[],
  next: VideoPreparationJob,
): VideoPreparationJob[] {
  const syncedName = next.output ? currentArtifactDisplayName(next.jobId, next.output.path) : null;
  if (syncedName && next.output && next.output.name !== syncedName)
    next = { ...next, output: { ...next.output, name: syncedName } };
  const previous = items.find((item) => item.jobId === next.jobId);
  // An older in-flight progress read must not undo cancellation or successful completion.
  if (
    previous &&
    (previous.updatedAt > next.updatedAt ||
      (previous.updatedAt === next.updatedAt &&
        !isVideoPreparationActive(previous) &&
        isVideoPreparationActive(next)))
  )
    return [...items];
  return [...items.filter((item) => item.jobId !== next.jobId), next].sort(
    (a, b) => b.createdAt - a.createdAt,
  );
}

export function VideoPreparationDialog({
  source,
  onClose,
  onUseOutput,
  onUseAiOutput,
}: VideoPreparationDialogProps) {
  const headingId = useId();
  const desktop = isDesktopRuntime();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const sourceKey = JSON.stringify(source.target);
  const [measured, setMeasured] = useState<{
    sourceKey: string;
    info: VideoPreparationProbe;
  } | null>(null);
  const probe = measured?.sourceKey === sourceKey ? measured.info : null;
  const [preview, setPreview] = useState<{ sourceKey: string; src: string } | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [sourceAttempt, setSourceAttempt] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [startSeconds, setStartSeconds] = useState(0);
  const [endSeconds, setEndSeconds] = useState(0);
  const [operation, setOperation] = useState<VideoPreparationOperation>("clip_video");
  const [audioStreamIndex, setAudioStreamIndex] = useState<number | null>(null);
  const [format, setFormat] = useState<VideoPreparationAudioFormat>("wav");
  const [name, setName] = useState(() =>
    source.name
      .replace(/\.[^.]+$/, "")
      .replace(/[\\/:*?"<>|]/g, "_")
      .slice(0, 60),
  );
  const [jobs, setJobs] = useState<VideoPreparationJob[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [listLoaded, setListLoaded] = useState(false);
  const [usedIds, setUsedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [exportedPath, setExportedPath] = useState<string | null>(null);
  const selectedJob = jobs.find((item) => item.jobId === selectedId) ?? null;
  const activeIds = JSON.stringify(jobs.filter(isVideoPreparationActive).map((item) => item.jobId));
  const updateJob = useCallback(
    (job: VideoPreparationJob) => setJobs((items) => mergeJob(items, job)),
    [],
  );
  useEffect(
    () =>
      subscribeArtifactNameChanges((change) => {
        setJobs((previous) =>
          previous.map((job) => {
            if (
              !job.output ||
              !artifactNameChangeMatches({ taskId: job.jobId, finalPath: job.output.path }, change)
            )
              return job;
            return { ...job, output: { ...job.output, name: change.name } };
          }),
        );
      }),
    [],
  );

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

  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    void videoPreparationClient.probe(source.target).then(
      (info) => {
        if (disposed) return;
        setMeasured({ sourceKey, info });
        setStartSeconds(0);
        setEndSeconds(info.durationSeconds);
        setAudioStreamIndex(info.audioStreams[0]?.index ?? null);
        setSourceError(null);
      },
      (reason: unknown) => {
        if (!disposed) setSourceError(formatRawBackendError(reason));
      },
    );
    return () => {
      disposed = true;
    };
  }, [desktop, source.target, sourceKey, sourceAttempt]);

  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    let prepared: PreparedVideoEditSource | null = null;
    const video = videoRef.current;
    void prepareVideoEditSource(source.target, "").then(
      (result) => {
        if (disposed) {
          void result.release();
          return;
        }
        prepared = result;
        setPreview({ sourceKey, src: result.src });
        setPreviewError(null);
      },
      (reason: unknown) => {
        if (!disposed) setPreviewError(formatRawBackendError(reason));
      },
    );
    return () => {
      disposed = true;
      // Release WebView file handles before deleting the owned Windows preview lease.
      video?.pause();
      video?.removeAttribute("src");
      video?.load();
      if (prepared) void prepared.release();
    };
  }, [desktop, source.target, sourceKey, sourceAttempt]);

  const refreshJobs = useCallback(async () => {
    const records = await videoPreparationClient.list();
    setJobs((previous) => records.reduce(mergeJob, previous));
    setListLoaded(true);
    setPollError(null);
    const matching = records.find((job) => sameMediaSourceIdentity(job.source, source.target));
    if (matching) setSelectedId((previous) => previous ?? matching.jobId);
  }, [source.target]);

  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    void videoPreparationClient.list().then(
      (records) => {
        if (disposed) return;
        setJobs((previous) => records.reduce(mergeJob, previous));
        setListLoaded(true);
        const matching = records.find((job) => sameMediaSourceIdentity(job.source, source.target));
        if (matching) setSelectedId((previous) => previous ?? matching.jobId);
      },
      (reason: unknown) => {
        if (!disposed) setPollError(formatRawBackendError(reason));
      },
    );
    return () => {
      disposed = true;
    };
  }, [desktop, source.target]);

  useEffect(() => {
    const ids: string[] = JSON.parse(activeIds) as string[];
    if (!ids.length) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const results = await Promise.allSettled(ids.map((id) => videoPreparationClient.get(id)));
      if (disposed) return;
      let failed: unknown = null;
      for (const result of results) {
        if (result.status === "fulfilled") updateJob(result.value);
        else failed = result.reason;
      }
      setPollError(failed == null ? null : formatRawBackendError(failed));
      timer = setTimeout(() => {
        void poll();
      }, 1500);
    };
    timer = setTimeout(() => {
      void poll();
    }, 1000);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [activeIds, updateJob]);

  const rangeError = probe
    ? validateVideoPreparationRange(startSeconds, endSeconds, probe.durationSeconds)
    : null;
  const nameError = validateArtifactName(name);
  const lacksAudio = operation === "extract_audio" && audioStreamIndex == null;
  const canStart =
    desktop &&
    probe != null &&
    rangeError == null &&
    nameError == null &&
    !lacksAudio &&
    busy == null;

  function seek(time: number) {
    if (!probe) return;
    const clamped = Math.max(0, Math.min(time, probe.durationSeconds));
    if (videoRef.current) videoRef.current.currentTime = clamped;
    setCurrentTime(clamped);
  }

  async function startJob() {
    if (!canStart || !probe) return;
    setBusy("start");
    setError(null);
    setExportedPath(null);
    try {
      const job = await videoPreparationClient.start({
        source: source.target,
        sourceIdentity: probe.sourceIdentity,
        name: name.trim(),
        operation,
        startSeconds,
        endSeconds,
        format,
        ...(operation === "extract_audio" && audioStreamIndex != null ? { audioStreamIndex } : {}),
      });
      updateJob(job);
      setSelectedId(job.jobId);
    } catch (reason) {
      setError(formatRawBackendError(reason));
    } finally {
      setBusy(null);
    }
  }

  async function changeJob(job: VideoPreparationJob, action: "retry" | "cancel") {
    if (busy) return;
    setBusy(job.jobId);
    setError(null);
    try {
      updateJob(await videoPreparationClient[action](job.jobId));
    } catch (reason) {
      setError(formatRawBackendError(reason));
    } finally {
      setBusy(null);
    }
  }

  async function addOutput(job: VideoPreparationJob) {
    if (!job.output || job.status !== "completed" || busy || usedIds.has(job.jobId)) return;
    setBusy(job.jobId);
    setError(null);
    try {
      await onUseOutput(job.output, job);
      setUsedIds((previous) => new Set([...previous, job.jobId]));
    } catch (reason) {
      setError(formatRawBackendError(reason));
    } finally {
      setBusy(null);
    }
  }

  async function exportOutput(job: VideoPreparationJob) {
    if (!job.output || busy) return;
    setBusy(job.jobId);
    setError(null);
    setExportedPath(null);
    try {
      setExportedPath(
        await exportArtifactToDesktop(
          job.output.path,
          artifactFileName(job.output.name, job.output.path),
        ),
      );
    } catch (reason) {
      setError(formatRawBackendError(reason));
    } finally {
      setBusy(null);
    }
  }

  const duration = probe?.durationSeconds ?? 0;
  const selectionStyle = {
    "--selection-start": `${duration ? (startSeconds / duration) * 100 : 0}%`,
    "--selection-width": `${duration ? (Math.max(0, endSeconds - startSeconds) / duration) * 100 : 0}%`,
  } as CSSProperties;

  return createPortal(
    <dialog
      className="video-preparation"
      ref={dialogRef}
      aria-labelledby={headingId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="video-preparation__header">
        <div>
          <h2 id={headingId}>视频准备</h2>
          <p>{source.name}</p>
        </div>
        <button type="button" ref={closeRef} onClick={onClose} aria-label="关闭视频准备">
          <Icon name="x" size="sm" />
        </button>
      </header>
      {!desktop ? (
        <p className="video-preparation__message" role="status">
          视频准备需要在桌面应用中运行。
        </p>
      ) : (
        <div className="video-preparation__body">
          <section className="video-preparation__source" aria-label="原视频与选区">
            <div className="video-preparation__viewport">
              <video
                ref={videoRef}
                src={preview?.sourceKey === sourceKey ? preview.src : undefined}
                preload="metadata"
                playsInline
                aria-label={`原视频：${source.name}`}
                onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onError={() => setPreviewError("预览暂不可用，仍可按时间选区处理原视频。")}
              />
              {previewError ? (
                <p role="status">{previewError}</p>
              ) : preview?.sourceKey !== sourceKey ? (
                <p role="status">正在读取视频预览…</p>
              ) : null}
            </div>
            <div className="video-preparation__playback">
              <button
                type="button"
                disabled={preview?.sourceKey !== sourceKey}
                onClick={() => {
                  const video = videoRef.current;
                  if (!video) return;
                  if (playing) video.pause();
                  else
                    void video
                      .play()
                      .catch((reason: unknown) => setPreviewError(formatRawBackendError(reason)));
                }}
                aria-label={playing ? "暂停原视频" : "播放原视频"}
              >
                <Icon name={playing ? "pause" : "play"} size="sm" />
              </button>
              <button
                type="button"
                disabled={!probe || probe.fps <= 0}
                onClick={() => seek(currentTime - 1 / (probe?.fps ?? 1))}
                aria-label="前一帧"
              >
                <Icon name="caret-left" size="sm" />
              </button>
              <button
                type="button"
                disabled={!probe || probe.fps <= 0}
                onClick={() => seek(currentTime + 1 / (probe?.fps ?? 1))}
                aria-label="后一帧"
              >
                <Icon name="caret-right" size="sm" />
              </button>
              <output aria-label="当前播放时间">
                {timeLabel(currentTime)} / {timeLabel(duration)}
              </output>
            </div>
            <div className="video-preparation__timeline" style={selectionStyle}>
              <span className="video-preparation__selection" aria-hidden="true" />
              <input
                type="range"
                aria-label="视频时间轴"
                min={0}
                max={duration}
                step={0.001}
                value={Math.min(currentTime, duration)}
                disabled={!probe}
                onChange={(event) => seek(Number(event.target.value))}
              />
            </div>
            <div className="video-preparation__range">
              <label>
                开始（秒）
                <input
                  type="number"
                  aria-label="选区开始时间"
                  min={0}
                  max={duration}
                  step={0.001}
                  value={Number.isNaN(startSeconds) ? "" : startSeconds}
                  disabled={!probe}
                  onChange={(event) => setStartSeconds(event.target.valueAsNumber)}
                />
              </label>
              <button type="button" disabled={!probe} onClick={() => setStartSeconds(currentTime)}>
                当前时间设为开始
              </button>
              <label>
                结束（秒）
                <input
                  type="number"
                  aria-label="选区结束时间"
                  min={0}
                  max={duration}
                  step={0.001}
                  value={Number.isNaN(endSeconds) ? "" : endSeconds}
                  disabled={!probe}
                  onChange={(event) => setEndSeconds(event.target.valueAsNumber)}
                />
              </label>
              <button type="button" disabled={!probe} onClick={() => setEndSeconds(currentTime)}>
                当前时间设为结束
              </button>
              <button
                type="button"
                disabled={!probe}
                onClick={() => {
                  setStartSeconds(0);
                  setEndSeconds(duration);
                }}
              >
                全片
              </button>
            </div>
            {rangeError ? (
              <p className="video-preparation__error" role="alert">
                {rangeError}
              </p>
            ) : (
              <p className="video-preparation__hint">
                所有操作共用当前选区
                {probe
                  ? ` · ${Math.max(0, endSeconds - startSeconds).toFixed(3)} 秒 · ${probe.width} × ${probe.height}`
                  : " · 正在测量原视频…"}
              </p>
            )}
            {sourceError ? (
              <p className="video-preparation__error" role="alert">
                读取原视频失败：{sourceError}
              </p>
            ) : null}
            {sourceError || previewError ? (
              <button type="button" onClick={() => setSourceAttempt((attempt) => attempt + 1)}>
                重试读取视频
              </button>
            ) : null}
          </section>
          <form
            className="video-preparation__form"
            onSubmit={(event) => {
              event.preventDefault();
              void startJob();
            }}
          >
            <label>
              处理方式
              <select
                aria-label="处理方式"
                value={operation}
                onChange={(event) => setOperation(event.target.value as VideoPreparationOperation)}
              >
                <option value="clip_video">准确裁切片段</option>
                <option
                  value="extract_audio"
                  disabled={probe != null && probe.audioStreams.length === 0}
                >
                  提取音轨
                </option>
                <option value="silent_video">导出无声视频</option>
              </select>
            </label>
            <label>
              产物名称
              <input
                aria-label="产物名称"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={80}
              />
            </label>
            {operation === "extract_audio" ? (
              <>
                <label>
                  音轨
                  <select
                    aria-label="提取音轨"
                    value={audioStreamIndex ?? ""}
                    disabled={!probe?.audioStreams.length}
                    onChange={(event) => setAudioStreamIndex(Number(event.target.value))}
                  >
                    {!probe?.audioStreams.length ? (
                      <option value="">没有可提取的音轨</option>
                    ) : (
                      probe.audioStreams.map((stream) => (
                        <option key={stream.index} value={stream.index}>
                          音轨 {stream.index} · {stream.language ? `${stream.language} · ` : ""}
                          {stream.codec} · {stream.channels} 声道 · {stream.sampleRate} Hz
                        </option>
                      ))
                    )}
                  </select>
                </label>
                <label>
                  音频格式
                  <select
                    aria-label="音频格式"
                    value={format}
                    onChange={(event) =>
                      setFormat(event.target.value as VideoPreparationAudioFormat)
                    }
                  >
                    <option value="wav">WAV · 适合后期处理</option>
                    <option value="original">保留原编码 · 不重新编码</option>
                  </select>
                </label>
                <p className="video-preparation__hint">
                  提取原音轨保留选区的声音，后续可试听并作为配音或剪辑参考。保留原编码按编码包裁切；需要准确切口请选
                  WAV。
                </p>
              </>
            ) : (
              <p className="video-preparation__hint">
                {operation === "clip_video"
                  ? "按选区重新编码，准确裁切并保留音频。"
                  : "移除声音并保留视频画面；输出沿用当前选区。"}
              </p>
            )}
            {probe?.audioStreams.length === 0 ? (
              <p className="video-preparation__hint">原视频没有音轨，仍可裁切或导出无声视频。</p>
            ) : null}
            {nameError ? (
              <p className="video-preparation__error" role="alert">
                {nameError}
              </p>
            ) : null}
            <button className="video-preparation__primary" type="submit" disabled={!canStart}>
              <Icon name={operation === "extract_audio" ? "waveform" : "film-strip"} size="sm" />
              {busy === "start" ? "正在创建任务…" : OPERATION_LABELS[operation]}
            </button>
          </form>
          {onUseAiOutput ? (
            <AiMediaPanel
              source={source}
              startSeconds={startSeconds}
              endSeconds={endSeconds}
              {...(audioStreamIndex == null ? {} : { audioStreamIndex })}
              {...(probe == null || rangeError != null
                ? {}
                : { sourceIdentity: probe.sourceIdentity, audioStreams: probe.audioStreams })}
              onUseOutput={onUseAiOutput}
            />
          ) : null}
          <section className="video-preparation__jobs" aria-label="视频准备任务">
            <div className="video-preparation__section-heading">
              <h3>本机任务与结果</h3>
              <button
                type="button"
                disabled={busy != null}
                onClick={() => {
                  void refreshJobs().catch((reason: unknown) =>
                    setPollError(formatRawBackendError(reason)),
                  );
                }}
              >
                <Icon name="arrow-clockwise" size="xs" />
                刷新
              </button>
            </div>
            <p className="video-preparation__hint">
              关闭窗口后任务继续处理，重新打开可恢复查看。重启中断的任务可以继续。
            </p>
            {pollError ? (
              <p className="video-preparation__error" role="alert">
                读取任务失败：{pollError}，任务状态未被修改。
              </p>
            ) : null}
            {!jobs.length ? (
              <p className="video-preparation__hint">
                {listLoaded ? "暂无视频准备任务" : "正在恢复本机任务…"}
              </p>
            ) : (
              <ul className="video-preparation__job-list">
                {jobs.map((job) => (
                  <li key={job.jobId}>
                    <button
                      type="button"
                      className={selectedId === job.jobId ? "is-selected" : undefined}
                      aria-pressed={selectedId === job.jobId}
                      onClick={() => {
                        setSelectedId(job.jobId);
                        setExportedPath(null);
                      }}
                    >
                      <span>{job.name}</span>
                      <small>
                        {OPERATION_LABELS[job.operation]} · {STATUS_LABELS[job.status]}
                        {job.progress != null && isVideoPreparationActive(job)
                          ? ` · ${job.progress.toFixed(0)}%`
                          : ""}
                      </small>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {selectedJob ? (
              <div className="video-preparation__job-detail" aria-label="所选任务详情">
                <p>
                  {OPERATION_LABELS[selectedJob.operation]} · {timeLabel(selectedJob.startSeconds)}{" "}
                  — {timeLabel(selectedJob.endSeconds)} ·{" "}
                  <span role="status">{STATUS_LABELS[selectedJob.status]}</span>
                </p>
                {isVideoPreparationActive(selectedJob) ? (
                  <>
                    <progress
                      aria-label="视频准备进度"
                      max={100}
                      value={selectedJob.progress ?? undefined}
                    />
                    <button
                      type="button"
                      disabled={busy != null}
                      onClick={() => {
                        void changeJob(selectedJob, "cancel");
                      }}
                    >
                      取消任务
                    </button>
                  </>
                ) : selectedJob.status === "paused" ||
                  selectedJob.status === "failed" ||
                  selectedJob.status === "cancelled" ? (
                  <button
                    type="button"
                    disabled={busy != null}
                    onClick={() => {
                      void changeJob(selectedJob, "retry");
                    }}
                  >
                    {selectedJob.status === "paused" ? "继续任务" : "重试任务"}
                  </button>
                ) : null}
                {selectedJob.error ? (
                  <p className="video-preparation__error" role="alert">
                    {selectedJob.error}
                  </p>
                ) : null}
                {selectedJob.status === "completed" && selectedJob.output ? (
                  <>
                    {selectedJob.output.kind === "audio" ? (
                      <audio
                        controls
                        preload="metadata"
                        aria-label={`音频结果：${selectedJob.output.name}`}
                        src={toMediaSrc(selectedJob.output.path)}
                      />
                    ) : (
                      <video
                        controls
                        playsInline
                        preload="metadata"
                        aria-label={`视频结果：${selectedJob.output.name}`}
                        src={toMediaSrc(selectedJob.output.path)}
                      />
                    )}
                    <p className="video-preparation__hint">
                      {selectedJob.output.name} · {selectedJob.output.durationSeconds.toFixed(3)} 秒
                    </p>
                    <div className="video-preparation__result-actions">
                      <button
                        type="button"
                        disabled={busy != null || usedIds.has(selectedJob.jobId)}
                        onClick={() => {
                          void addOutput(selectedJob);
                        }}
                      >
                        <Icon name="plus" size="sm" />
                        {usedIds.has(selectedJob.jobId) ? "已加入画布" : "加入画布"}
                      </button>
                      <button
                        type="button"
                        disabled={busy != null}
                        onClick={() => {
                          void exportOutput(selectedJob);
                        }}
                      >
                        <Icon name="download-simple" size="sm" />
                        按名称导出
                      </button>
                    </div>
                  </>
                ) : null}
                {exportedPath ? (
                  <p className="video-preparation__hint" role="status">
                    已导出到 {exportedPath}
                  </p>
                ) : null}
              </div>
            ) : null}
          </section>
          {error ? (
            <p className="video-preparation__error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      )}
    </dialog>,
    document.body,
  );
}
