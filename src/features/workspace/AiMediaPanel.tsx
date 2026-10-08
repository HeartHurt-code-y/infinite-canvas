import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  aiMediaClient,
  isAiMediaActive,
  type AiMediaDepthMaxSide,
  type AiMediaDevice,
  type AiMediaJob,
  type AiMediaMode,
  type AiMediaOperation,
  type AiMediaOutput,
  type AiMediaRuntimeStatus,
} from "../../lib/aiMedia";
import { formatRawBackendError, isDesktopRuntime, toMediaSrc } from "../../lib/backend";
import {
  ensureRuntimeFeatureInstalled,
  requestRuntimeComponents,
  subscribeRuntimeComponentsChanged,
} from "../../lib/runtimeComponents";
import { sameMediaSourceIdentity } from "../../lib/promptReferenceTarget";
import type { VideoPreparationProbe } from "../../lib/videoPreparation";
import type { VideoPreparationSource } from "./VideoPreparationDialog";
import { NodeNameEditor } from "./NodeNameEditor";
import { artifactFileName, validateArtifactName } from "./artifactNames";
import {
  artifactNameChangeMatches,
  currentArtifactDisplayName,
  publishArtifactNameChange,
  subscribeArtifactNameChanges,
} from "./artifactNameSync";
import { exportArtifactToDesktop } from "./desktopActions";
import "./AiMediaPanel.css";

export interface AiMediaPanelProps {
  readonly source: VideoPreparationSource;
  readonly startSeconds: number;
  readonly endSeconds: number | undefined;
  readonly audioStreamIndex?: number | undefined;
  readonly audioStreams?: VideoPreparationProbe["audioStreams"] | undefined;
  readonly sourceIdentity?: string | undefined;
  readonly onUseOutput: (output: AiMediaOutput, job: AiMediaJob) => void | Promise<void>;
}

const OPERATION_LABELS: Record<AiMediaOperation, string> = {
  video_depth: "连续视频深度",
  audio_separation: "AI 人声／伴奏分离",
};
const MODE_LABELS: Record<AiMediaMode, string> = { lite: "轻量本地", quality: "高质量本地" };
const ROLE_LABELS: Record<AiMediaOutput["role"], string> = {
  depth_video: "深度视频",
  depth_data: "原始深度数据",
  manifest: "时间与处理信息",
  vocals: "人声",
  accompaniment: "伴奏",
};
const STATUS_LABELS: Record<AiMediaJob["status"], string> = {
  preparing: "准备中",
  processing: "正在处理",
  paused: "已暂停",
  completed: "已完成",
  failed: "处理失败",
  cancelled: "已取消",
};

function mergeJob(items: readonly AiMediaJob[], next: AiMediaJob): AiMediaJob[] {
  const previous = items.find((item) => item.jobId === next.jobId);
  if (
    previous &&
    (previous.updatedAt > next.updatedAt ||
      (previous.updatedAt === next.updatedAt &&
        !isAiMediaActive(previous) &&
        isAiMediaActive(next)))
  )
    return [...items];
  const outputs = next.outputs.map((output) => {
    const name = currentArtifactDisplayName(next.jobId, output.path);
    return name && name !== output.name ? { ...output, name } : output;
  });
  return [...items.filter((item) => item.jobId !== next.jobId), { ...next, outputs }].sort(
    (a, b) => b.createdAt - a.createdAt,
  );
}

function outputKey(job: AiMediaJob, output: AiMediaOutput): string {
  return JSON.stringify([job.jobId, output.resultIndex, output.path]);
}

function AiMediaPreview({ output }: { readonly output: AiMediaOutput }) {
  const mediaRef = useRef<HTMLMediaElement>(null);
  useEffect(() => {
    const media = mediaRef.current;
    return () => {
      media?.pause();
      media?.removeAttribute("src");
      media?.load();
    };
  }, []);
  if (output.kind === "data")
    return <p className="ai-media__hint">保存此附件可在后期工具中使用。</p>;
  const shared = {
    ref: (media: HTMLMediaElement | null) => {
      mediaRef.current = media;
    },
    src: toMediaSrc(output.path),
    controls: true,
    preload: "metadata",
    "aria-label": `${ROLE_LABELS[output.role]}预览：${output.name}`,
  };
  return output.kind === "video" ? <video {...shared} playsInline /> : <audio {...shared} />;
}

/** Local AI tasks share the parent's measured source and timeline selection. */
export function AiMediaPanel({
  source,
  startSeconds,
  endSeconds,
  audioStreamIndex,
  audioStreams,
  sourceIdentity,
  onUseOutput,
}: AiMediaPanelProps) {
  const headingId = useId();
  const desktop = isDesktopRuntime();
  const sourceKey = JSON.stringify([source.target, sourceIdentity]);
  const defaultName = source.name
    .replace(/\.[^.]+$/, "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .slice(0, 50);
  const [draftName, setDraftName] = useState({ sourceKey, name: defaultName });
  const name = draftName.sourceKey === sourceKey ? draftName.name : defaultName;
  const [operation, setOperation] = useState<AiMediaOperation>("video_depth");
  const [mode, setMode] = useState<AiMediaMode>("lite");
  const modeRef = useRef<AiMediaMode>("lite");
  const runtimeRequestRef = useRef(0);
  const [depthMaxSide, setDepthMaxSide] = useState<AiMediaDepthMaxSide>(480);
  const [device, setDevice] = useState<AiMediaDevice>("auto");
  const [audioChoice, setAudioChoice] = useState<{ sourceKey: string; index: number } | null>(null);
  const chosenAudioIndex =
    audioChoice?.sourceKey === sourceKey
      ? audioChoice.index
      : (audioStreamIndex ?? audioStreams?.[0]?.index);
  const validAudioIndex =
    chosenAudioIndex != null &&
    (audioStreams == null || audioStreams.some((stream) => stream.index === chosenAudioIndex))
      ? chosenAudioIndex
      : undefined;
  const [runtimeSnapshot, setRuntimeSnapshot] = useState<{
    mode: AiMediaMode;
    status: AiMediaRuntimeStatus;
  } | null>(null);
  const runtime = runtimeSnapshot?.mode === mode ? runtimeSnapshot.status : null;
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [componentRevision, setComponentRevision] = useState(0);
  const [jobs, setJobs] = useState<AiMediaJob[]>([]);
  const [listLoaded, setListLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedResult, setSelectedResult] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [used, setUsed] = useState<ReadonlySet<string>>(() => new Set());
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const selectedJob = jobs.find((job) => job.jobId === selectedId) ?? null;
  const selectedOutput =
    selectedJob?.outputs.find((output) => output.resultIndex === selectedResult) ??
    selectedJob?.outputs[0] ??
    null;
  const activeIds = JSON.stringify(jobs.filter(isAiMediaActive).map((job) => job.jobId));
  const updateJob = useCallback((job: AiMediaJob) => setJobs((items) => mergeJob(items, job)), []);

  useEffect(
    () => subscribeRuntimeComponentsChanged(() => setComponentRevision((value) => value + 1)),
    [],
  );

  useEffect(
    () =>
      subscribeArtifactNameChanges((change) => {
        setJobs((previous) =>
          previous.map((job) => ({
            ...job,
            outputs: job.outputs.map((output) =>
              artifactNameChangeMatches({ taskId: job.jobId, finalPath: output.path }, change)
                ? { ...output, name: change.name }
                : output,
            ),
          })),
        );
      }),
    [],
  );

  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    const request = ++runtimeRequestRef.current;
    void aiMediaClient.runtimeStatus(mode).then(
      (next) => {
        if (!disposed && request === runtimeRequestRef.current && modeRef.current === mode) {
          setRuntimeSnapshot({ mode, status: next });
          setRuntimeError(null);
        }
      },
      (reason: unknown) => {
        if (!disposed && request === runtimeRequestRef.current && modeRef.current === mode) {
          setRuntimeSnapshot(null);
          setRuntimeError(formatRawBackendError(reason));
        }
      },
    );
    return () => {
      disposed = true;
    };
  }, [desktop, mode, componentRevision]);

  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    void aiMediaClient.list().then(
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
    const ids = JSON.parse(activeIds) as string[];
    if (!ids.length) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const records = await Promise.allSettled(ids.map((id) => aiMediaClient.get(id)));
      if (disposed) return;
      let failure: unknown = null;
      for (const record of records) {
        if (record.status === "fulfilled") updateJob(record.value);
        else failure = record.reason;
      }
      setPollError(failure == null ? null : formatRawBackendError(failure));
      timer = setTimeout(() => void poll(), 1500);
    };
    timer = setTimeout(() => void poll(), 1000);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [activeIds, updateJob]);

  const rangeValid =
    Number.isFinite(startSeconds) &&
    startSeconds >= 0 &&
    (endSeconds == null || (Number.isFinite(endSeconds) && endSeconds > startSeconds));
  const nameError = validateArtifactName(name);
  const operationReady =
    runtime?.ready &&
    (operation === "video_depth" ? runtime.videoDepthReady : runtime.audioSeparationReady);
  const canStart =
    desktop &&
    operationReady &&
    sourceIdentity != null &&
    sourceIdentity.length > 0 &&
    rangeValid &&
    nameError == null &&
    (operation === "video_depth" || validAudioIndex != null) &&
    busy == null;

  function chooseMode(nextMode: AiMediaMode) {
    if (nextMode === mode) return;
    // Clear readiness synchronously; a response for the old engine must never enable this one.
    modeRef.current = nextMode;
    runtimeRequestRef.current += 1;
    setRuntimeSnapshot(null);
    setRuntimeError(null);
    if (
      (nextMode === "lite" && !["auto", "cpu", "directml"].includes(device)) ||
      (nextMode === "quality" && device === "directml")
    )
      setDevice("auto");
    setMode(nextMode);
  }

  async function refresh() {
    const requestedMode = mode;
    const request = ++runtimeRequestRef.current;
    setBusy("refresh");
    setRuntimeSnapshot(null);
    try {
      const results = await Promise.allSettled([
        aiMediaClient.runtimeStatus(requestedMode),
        aiMediaClient.list(),
      ]);
      const [runtimeResult, jobsResult] = results;
      if (request === runtimeRequestRef.current && modeRef.current === requestedMode) {
        if (runtimeResult.status === "fulfilled") {
          setRuntimeSnapshot({ mode: requestedMode, status: runtimeResult.value });
          setRuntimeError(null);
        } else {
          setRuntimeSnapshot(null);
          setRuntimeError(formatRawBackendError(runtimeResult.reason));
        }
      }
      if (jobsResult.status === "fulfilled") {
        setJobs((previous) => jobsResult.value.reduce(mergeJob, previous));
        setListLoaded(true);
        setPollError(null);
      } else setPollError(formatRawBackendError(jobsResult.reason));
    } finally {
      setBusy(null);
    }
  }

  async function importRuntime() {
    const requestedMode = mode;
    let request = runtimeRequestRef.current;
    setBusy("import");
    setRuntimeError(null);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const rootPath = await open({
        title: `选择${MODE_LABELS[requestedMode]}离线包文件夹`,
        directory: true,
        multiple: false,
      });
      if (typeof rootPath !== "string" || !rootPath) return;
      if (modeRef.current !== requestedMode) return;
      request = ++runtimeRequestRef.current;
      const next = await aiMediaClient.importRuntime(rootPath, requestedMode);
      if (request === runtimeRequestRef.current && modeRef.current === requestedMode)
        setRuntimeSnapshot({ mode: requestedMode, status: next });
    } catch (reason) {
      if (request === runtimeRequestRef.current && modeRef.current === requestedMode)
        setRuntimeError(formatRawBackendError(reason));
    } finally {
      setBusy(null);
    }
  }

  async function startJob() {
    if (!canStart || !sourceIdentity) return;
    setBusy("start");
    setError(null);
    setSavedPath(null);
    try {
      if (
        !(await ensureRuntimeFeatureInstalled(
          mode === "lite" ? "ai-media-lite" : "ai-media-quality",
        ))
      ) {
        setError("AI 媒体处理所需组件尚未就绪，安装完成后请再次点击开始。当前选区与设置已保留。");
        return;
      }
      const job = await aiMediaClient.start({
        source: source.target,
        sourceIdentity,
        name: name.trim(),
        startSeconds,
        ...(endSeconds != null ? { endSeconds } : {}),
        operation,
        mode,
        depthMaxSide,
        device,
        ...(operation === "audio_separation" && validAudioIndex != null
          ? { audioStreamIndex: validAudioIndex }
          : {}),
      });
      updateJob(job);
      setSelectedId(job.jobId);
      setSelectedResult(null);
    } catch (reason) {
      setError(formatRawBackendError(reason));
    } finally {
      setBusy(null);
    }
  }

  async function changeJob(job: AiMediaJob, action: "retry" | "cancel") {
    if (busy) return;
    setBusy(job.jobId);
    setError(null);
    try {
      if (action === "retry") {
        const requiredRuntime = await aiMediaClient.runtimeStatus(job.mode);
        const requiredOperationReady =
          job.operation === "video_depth"
            ? requiredRuntime.videoDepthReady
            : requiredRuntime.audioSeparationReady;
        if (!requiredRuntime.ready || !requiredOperationReady)
          throw new Error(
            requiredRuntime.error ??
              `此任务使用${MODE_LABELS[job.mode]}引擎，请先安装该引擎的完整离线包。`,
          );
      }
      const next = await aiMediaClient[action](job.jobId);
      if (next.jobId !== job.jobId || next.mode !== job.mode)
        throw new Error("AI 任务身份或处理引擎已变化，请刷新任务后重试。");
      updateJob(next);
    } catch (reason) {
      setError(formatRawBackendError(reason));
    } finally {
      setBusy(null);
    }
  }

  async function addOutput(job: AiMediaJob, output: AiMediaOutput) {
    if (
      busy ||
      job.status !== "completed" ||
      output.kind === "data" ||
      used.has(outputKey(job, output))
    )
      return;
    setBusy(job.jobId);
    setError(null);
    try {
      await onUseOutput(output, job);
      setUsed((previous) => new Set([...previous, outputKey(job, output)]));
    } catch (reason) {
      setError(formatRawBackendError(reason));
    } finally {
      setBusy(null);
    }
  }

  async function saveOutput(job: AiMediaJob, output: AiMediaOutput) {
    if (busy || job.status !== "completed") return;
    setBusy(job.jobId);
    setError(null);
    setSavedPath(null);
    try {
      setSavedPath(
        await exportArtifactToDesktop(output.path, artifactFileName(output.name, output.path)),
      );
    } catch (reason) {
      setError(formatRawBackendError(reason));
    } finally {
      setBusy(null);
    }
  }

  async function renameOutput(job: AiMediaJob, output: AiMediaOutput, nextName: string) {
    const next = await aiMediaClient.rename(job.jobId, output.resultIndex, nextName);
    const renamed = next.outputs.find(
      (item) => item.resultIndex === output.resultIndex && item.path === output.path,
    );
    if (!renamed) throw new Error("产物身份已变化，请刷新任务后重试。");
    updateJob(next);
    publishArtifactNameChange({ taskId: job.jobId, finalPath: output.path, name: renamed.name });
  }

  return (
    <section className="ai-media" aria-labelledby={headingId}>
      <div className="ai-media__heading">
        <h3 id={headingId}>AI 媒体处理</h3>
        {desktop ? (
          <button type="button" disabled={busy != null} onClick={() => void refresh()}>
            刷新 AI 状态
          </button>
        ) : null}
      </div>
      {!desktop ? (
        <p className="ai-media__hint" role="status">
          AI 媒体处理需要在桌面应用中运行。
        </p>
      ) : (
        <>
          <div className="ai-media__runtime">
            <p role="status">
              {runtime?.ready
                ? `${MODE_LABELS[mode]}组件已就绪${runtime.version ? ` · ${runtime.version}` : ""}`
                : runtime == null && !runtimeError
                  ? `正在检查${MODE_LABELS[mode]}组件…`
                  : `${MODE_LABELS[mode]}组件尚未就绪`}
            </p>
            <button
              type="button"
              onClick={() =>
                requestRuntimeComponents(mode === "lite" ? "ai-media-lite" : "ai-media-quality")
              }
            >
              安装或导入 AI 组件
            </button>
            <button type="button" disabled={busy != null} onClick={() => void importRuntime()}>
              {busy === "import" ? "正在校验离线包…" : `导入${MODE_LABELS[mode]}离线包`}
            </button>
            {!runtime?.ready ? (
              <p className="ai-media__hint">
                {mode === "lite"
                  ? "在组件管理中安装或导入轻量组件，即可在本机处理视频和音频；也可继续导入已解压的离线包文件夹。"
                  : "高质量引擎可在组件管理中安装或导入，也支持已解压的离线包文件夹。"}
              </p>
            ) : null}
          </div>
          {runtimeError || runtime?.error ? (
            <p className="ai-media__error" role="alert">
              {runtimeError ?? runtime?.error}
            </p>
          ) : null}
          <div className="ai-media__controls">
            <label>
              处理引擎
              <select
                aria-label="处理引擎"
                value={mode}
                onChange={(event) => chooseMode(event.target.value as AiMediaMode)}
              >
                <option value="lite">轻量本地（默认）</option>
                <option value="quality">高质量本地（可选）</option>
              </select>
            </label>
            <label>
              AI 处理方式
              <select
                aria-label="AI 处理方式"
                value={operation}
                onChange={(event) => setOperation(event.target.value as AiMediaOperation)}
              >
                <option value="video_depth">连续视频深度</option>
                <option value="audio_separation">AI 人声／伴奏分离</option>
              </select>
            </label>
            <label>
              AI 产物名称
              <input
                aria-label="AI 产物名称"
                value={name}
                maxLength={80}
                onChange={(event) => setDraftName({ sourceKey, name: event.target.value })}
              />
            </label>
            {operation === "video_depth" ? (
              <label>
                深度视频尺寸
                <select
                  aria-label="深度视频尺寸"
                  value={depthMaxSide}
                  onChange={(event) =>
                    setDepthMaxSide(Number(event.target.value) as AiMediaDepthMaxSide)
                  }
                >
                  <option value={480}>480 · 长边</option>
                  <option value={720}>720 · 长边</option>
                </select>
              </label>
            ) : (
              <label>
                分离音轨
                <select
                  aria-label="分离音轨"
                  value={validAudioIndex ?? ""}
                  disabled={audioStreams != null && !audioStreams.length}
                  onChange={(event) =>
                    setAudioChoice({ sourceKey, index: Number(event.target.value) })
                  }
                >
                  {audioStreams?.length ? (
                    audioStreams.map((stream) => (
                      <option key={stream.index} value={stream.index}>
                        音轨 {stream.index} · {stream.language ? `${stream.language} · ` : ""}
                        {stream.channels} 声道 · {stream.sampleRate} Hz
                      </option>
                    ))
                  ) : validAudioIndex != null ? (
                    <option value={validAudioIndex}>音轨 {validAudioIndex}</option>
                  ) : (
                    <option value="">原视频没有可分离音轨</option>
                  )}
                </select>
              </label>
            )}
            <label>
              处理设备
              <select
                aria-label="AI 处理设备"
                value={device}
                onChange={(event) => setDevice(event.target.value as AiMediaDevice)}
              >
                <option value="auto">自动选择</option>
                <option value="cpu">CPU</option>
                {mode === "lite" ? (
                  <option value="directml">GPU（DirectML）</option>
                ) : (
                  <>
                    <option value="cuda">NVIDIA GPU</option>
                    <option value="mps">Apple GPU</option>
                  </>
                )}
              </select>
            </label>
          </div>
          <p className="ai-media__hint">
            {mode === "lite"
              ? "轻量组件体积较小，连续深度保留时序模型；人声分离效果与高质量引擎可能不同。显存需求仍取决于视频尺寸和设备。"
              : "高质量引擎提供另一种人声分离模型，运行组件较大。GPU 支持取决于所安装的离线包；任务会记录所选引擎。"}
          </p>
          <p className="ai-media__hint">
            {operation === "video_depth"
              ? "按当前选区生成连续的相对深度视频，并保存原始深度数据与逐帧时间信息。"
              : "按当前选区生成可分别试听、保存的人声与伴奏。复杂对白、环境声与特效声可能仍有残留。"}
          </p>
          {device === "cpu" ? <p className="ai-media__hint">CPU 处理可能耗时较长。</p> : null}
          {runtime?.ready && !operationReady ? (
            <p className="ai-media__error" role="alert">
              当前离线包尚不包含{OPERATION_LABELS[operation]}所需组件。
            </p>
          ) : null}
          {operation === "audio_separation" && validAudioIndex == null ? (
            <p className="ai-media__hint">没有可分离的音轨，请选择带有声音的视频。</p>
          ) : null}
          {nameError ? (
            <p className="ai-media__error" role="alert">
              {nameError}
            </p>
          ) : null}
          <button
            className="ai-media__primary"
            type="button"
            disabled={!canStart}
            onClick={() => void startJob()}
          >
            {busy === "start" ? "正在创建 AI 任务…" : `开始${OPERATION_LABELS[operation]}`}
          </button>
          <div className="ai-media__jobs" aria-label="AI 媒体任务">
            <h4>AI 任务与结果</h4>
            <p className="ai-media__hint">
              关闭窗口后任务继续处理。重启中断的任务可从头重新处理当前选区。
            </p>
            {pollError ? (
              <p className="ai-media__error" role="alert">
                读取 AI 任务失败：{pollError}
              </p>
            ) : null}
            {!jobs.length ? (
              <p className="ai-media__hint">
                {listLoaded ? "暂无 AI 媒体任务" : "正在恢复本机 AI 任务…"}
              </p>
            ) : (
              <ul className="ai-media__job-list">
                {jobs.map((job) => (
                  <li key={job.jobId}>
                    <button
                      type="button"
                      aria-pressed={selectedId === job.jobId}
                      onClick={() => {
                        setSelectedId(job.jobId);
                        setSelectedResult(null);
                        setSavedPath(null);
                      }}
                    >
                      <span>{job.name}</span>
                      <small>
                        {OPERATION_LABELS[job.operation]} · {MODE_LABELS[job.mode]} ·{" "}
                        {STATUS_LABELS[job.status]}
                        {isAiMediaActive(job) && job.progress != null
                          ? ` · ${job.progress.toFixed(0)}%`
                          : ""}
                      </small>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {selectedJob ? (
              <div className="ai-media__detail" aria-label="所选 AI 任务详情">
                <p>
                  {OPERATION_LABELS[selectedJob.operation]} · {MODE_LABELS[selectedJob.mode]} ·{" "}
                  {selectedJob.startSeconds.toFixed(3)} — {selectedJob.endSeconds.toFixed(3)} 秒 ·{" "}
                  <span role="status">{STATUS_LABELS[selectedJob.status]}</span>
                  {selectedJob.actualDevice ? ` · ${selectedJob.actualDevice}` : ""}
                </p>
                {selectedJob.message ? (
                  <p className="ai-media__hint" role="status">
                    {selectedJob.message}
                  </p>
                ) : null}
                {isAiMediaActive(selectedJob) ? (
                  <>
                    <progress
                      aria-label="AI 媒体处理进度"
                      max={100}
                      value={selectedJob.progress ?? undefined}
                    />
                    <button
                      type="button"
                      disabled={busy != null}
                      onClick={() => void changeJob(selectedJob, "cancel")}
                    >
                      取消 AI 任务
                    </button>
                  </>
                ) : ["paused", "failed", "cancelled"].includes(selectedJob.status) ? (
                  <button
                    type="button"
                    disabled={busy != null}
                    onClick={() => void changeJob(selectedJob, "retry")}
                  >
                    {selectedJob.status === "paused" ? "重新处理选区" : "重试 AI 任务"}
                  </button>
                ) : null}
                {selectedJob.error ? (
                  <p className="ai-media__error" role="alert">
                    {selectedJob.error}
                  </p>
                ) : null}
                {selectedJob.status === "completed" && selectedOutput ? (
                  <>
                    <div className="ai-media__output-tabs" aria-label="AI 产物列表">
                      {selectedJob.outputs.map((output) => (
                        <button
                          key={output.resultIndex}
                          type="button"
                          aria-pressed={selectedOutput.resultIndex === output.resultIndex}
                          onClick={() => {
                            setSelectedResult(output.resultIndex);
                            setSavedPath(null);
                          }}
                        >
                          {ROLE_LABELS[output.role]}
                        </button>
                      ))}
                    </div>
                    <p className="ai-media__output-name">{selectedOutput.name}</p>
                    <AiMediaPreview
                      key={outputKey(selectedJob, selectedOutput)}
                      output={selectedOutput}
                    />
                    <div className="ai-media__result-actions">
                      {selectedOutput.kind !== "data" ? (
                        <button
                          type="button"
                          disabled={
                            busy != null || used.has(outputKey(selectedJob, selectedOutput))
                          }
                          onClick={() => void addOutput(selectedJob, selectedOutput)}
                        >
                          {used.has(outputKey(selectedJob, selectedOutput))
                            ? "已加入画布"
                            : "加入画布"}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        disabled={busy != null}
                        onClick={() => void saveOutput(selectedJob, selectedOutput)}
                      >
                        保存{ROLE_LABELS[selectedOutput.role]}
                      </button>
                      <NodeNameEditor
                        key={outputKey(selectedJob, selectedOutput)}
                        name={selectedOutput.name}
                        label="修改 AI 产物名称"
                        onSave={(nextName) => renameOutput(selectedJob, selectedOutput, nextName)}
                      />
                    </div>
                  </>
                ) : null}
              </div>
            ) : null}
          </div>
          {savedPath ? (
            <p className="ai-media__hint" role="status">
              已保存：{savedPath}
            </p>
          ) : null}
          {error ? (
            <p className="ai-media__error" role="alert">
              {error}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
