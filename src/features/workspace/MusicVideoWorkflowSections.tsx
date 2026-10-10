import { useRef, useState } from "react";
import { ImeTextarea } from "../../components/ImeTextField";
import { toMediaSrc } from "../../lib/backend";
import type { ProviderCatalogEntry } from "../../lib/backend";
import { mvMediaClient } from "../../lib/mvMedia";
import {
  MUSIC_VIDEO_STAGES,
  MUSIC_VIDEO_STAGE_LABELS,
  isMusicVideoStageApproved,
  musicVideoSpeechAnalysisMode,
  musicVideoLipReviewSignature,
  type MusicVideoArtifact,
  type MusicVideoStage,
  type MusicVideoWorkflowOptions,
} from "./musicVideoWorkflowModel";
import { RequiredMark } from "./workflowFieldRequirements";
import type { KnowledgeVideoWorkflowCheckpoint } from "./workspaceModel";
import "./MusicVideoWorkflowSections.css";

export function MusicVideoConfiguration({
  options,
  disabled,
  onChange,
  onPick,
  providerCatalog,
}: {
  readonly options: MusicVideoWorkflowOptions;
  readonly disabled: boolean;
  readonly onChange: (options: MusicVideoWorkflowOptions) => void;
  readonly onPick?: (role: "song" | "character") => void;
  readonly providerCatalog: readonly ProviderCatalogEntry[];
}) {
  const voiceProviders = providerCatalog.filter(
    (entry) => entry.provider.enabled && entry.provider.adapterId === "doubao_voice_v1",
  );
  return (
    <details open className="canvas-knowledge-workflow__models canvas-music-video__settings">
      <summary>
        <span className="canvas-knowledge-workflow__models-title">歌曲与 MV 制作设置</span>
      </summary>
      <fieldset disabled={disabled}>
        <div className="canvas-music-video__file">
          <strong>{options.songName || "先选择一首完整歌曲"}</strong>
          <span className="canvas-music-video__file-label">
            <RequiredMark>歌曲文件</RequiredMark>
          </span>
          <button type="button" disabled={!onPick} onClick={() => onPick?.("song")}>
            {options.songPath ? "更换歌曲" : "选择歌曲"}
          </button>
          {options.songPath ? (
            <>
              <button
                type="button"
                onClick={() => onChange({ ...options, songPath: "", songName: "" })}
              >
                移除歌曲
              </button>
              <audio
                controls
                preload="metadata"
                src={toMediaSrc(options.songPath)}
                aria-label="原曲试听"
              />
            </>
          ) : null}
        </div>
        <p>使用原曲作为最终音轨。歌词时间线和每段画面均由你确认后继续。</p>
        <label>
          官方歌词
          <ImeTextarea
            aria-label="MV 官方歌词"
            rows={4}
            value={options.officialLyrics}
            onValueChange={(officialLyrics) => onChange({ ...options, officialLyrics })}
            placeholder="粘贴准确歌词，供听辨与唱词校正。"
          />
        </label>
        <label>
          带时间戳的 LRC 歌词
          <ImeTextarea
            aria-label="MV 时间戳歌词"
            rows={4}
            value={options.lrc}
            onValueChange={(lrc) => onChange({ ...options, lrc })}
            placeholder={"[00:00.00][Instrumental]\n[00:08.20]第一句歌词\n[00:14.50]第二句歌词"}
          />
        </label>
        <label>
          歌曲声学分析
          <select
            aria-label="MV 歌曲声学分析"
            value={musicVideoSpeechAnalysisMode(options)}
            onChange={(event) =>
              onChange({
                ...options,
                speechAnalysisMode: event.target.value as "automatic" | "manual",
              })
            }
          >
            <option value="automatic">专用 ASR 与歌词强制对齐</option>
            <option value="manual" disabled={options.deliverable === "video"}>
              手工时间线（仅制作文档）
            </option>
          </select>
        </label>
        {musicVideoSpeechAnalysisMode(options) === "automatic" ? (
          <label>
            {/* 成片模式下运行器要求已启用的豆包语音连接，缺了会直接阻断，所以标必填；
                它是项目凭据配置而非内容输入，因此不进缺口清单。 */}
            <RequiredMark>豆包语音连接</RequiredMark>
            <select
              aria-label="MV 豆包语音连接"
              value={options.speechProviderConnectionId ?? ""}
              onChange={(event) =>
                onChange({ ...options, speechProviderConnectionId: event.target.value })
              }
            >
              <option value="">请选择已启用的豆包语音连接</option>
              {voiceProviders.map((entry) => (
                <option key={entry.provider.id} value={entry.provider.id}>
                  {entry.provider.displayName}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <small>
          成片模式要求已配置豆包语音识别连接和独立火山歌词对齐凭据；缺少或不可用时会阻断。
          当前歌词对齐按中文配置；纯英文、日文歌曲不能走这条自动对齐链路。 LRC
          可提供歌词边界作参考，自动模式以声学测量时间为准并等待试听确认。
          历史手工文档模式不标记为已自动验证。
        </small>
        <label>
          视觉风格
          <ImeTextarea
            aria-label="MV 视觉风格"
            rows={2}
            value={options.visualStyle}
            onValueChange={(visualStyle) => onChange({ ...options, visualStyle })}
            placeholder="例如：冷色城市夜景、胶片质感、克制叙事。留空由模型提案。"
          />
        </label>
        <div className="canvas-music-video__row">
          <label>
            人物模式
            <select
              aria-label="MV 人物模式"
              value={options.characterMode}
              onChange={(e) =>
                onChange({
                  ...options,
                  characterMode: e.target.value as MusicVideoWorkflowOptions["characterMode"],
                })
              }
            >
              <option value="none">无固定人物</option>
              <option value="reference">使用人物参考图</option>
              <option value="generate">生成固定人物</option>
            </select>
          </label>
          <label>
            画幅
            <select
              aria-label="MV 画幅"
              value={options.aspectRatio}
              onChange={(e) => onChange({ ...options, aspectRatio: e.target.value })}
            >
              <option>16:9</option>
              <option>9:16</option>
              <option>1:1</option>
            </select>
          </label>
          <label>
            交付
            <select
              aria-label="MV 交付方式"
              value={options.deliverable}
              onChange={(e) =>
                onChange({ ...options, deliverable: e.target.value as "video" | "documents" })
              }
            >
              <option value="video">文档与完整 MV</option>
              <option value="documents">仅制作文档</option>
            </select>
          </label>
        </div>
        {options.characterMode === "reference" ? (
          <div className="canvas-music-video__file">
            <span className="canvas-music-video__file-label">
              <RequiredMark>人物参考图</RequiredMark>
            </span>
            <button type="button" disabled={!onPick} onClick={() => onPick?.("character")}>
              添加人物参考图
            </button>
            {options.characterReferences.map((item) => (
              <figure key={item.localPath}>
                <img src={toMediaSrc(item.localPath)} alt={item.displayName} loading="lazy" />
                <figcaption>{item.displayName}</figcaption>
                <button
                  type="button"
                  aria-label={`移除人物图 ${item.displayName}`}
                  onClick={() =>
                    onChange({
                      ...options,
                      characterReferences: options.characterReferences.filter(
                        (ref) => ref.localPath !== item.localPath,
                      ),
                    })
                  }
                >
                  移除
                </button>
              </figure>
            ))}
          </div>
        ) : null}
        {options.characterMode !== "none" ? (
          <label>
            正面演唱目标占比（%）
            <input
              aria-label="MV 正面演唱占比"
              type="number"
              min={0}
              max={100}
              step={5}
              value={Math.round(options.syncRatio * 100)}
              onChange={(e) => {
                const percent = e.currentTarget.valueAsNumber;
                if (!Number.isFinite(percent)) return;
                onChange({
                  ...options,
                  syncRatio: Math.min(1, Math.max(0, percent / 100)),
                });
              }}
            />
          </label>
        ) : null}
        <small>
          正面演唱需要视频模型支持音频参考；当前逐镜试听、预览并人工确认，自动口型偏移检测尚未接入。
          无固定人物时使用环境与非演唱镜头。
        </small>
      </fieldset>
    </details>
  );
}

function ArtifactEditor({
  artifact,
  stage,
  onSave,
  onCancel,
}: {
  readonly artifact: MusicVideoArtifact;
  readonly stage: MusicVideoStage;
  readonly onSave: (patch: Partial<MusicVideoArtifact>) => void;
  readonly onCancel: () => void;
}) {
  const [draft, setDraft] = useState(artifact);
  const updateShot = (id: string, patch: object) =>
    setDraft({
      ...draft,
      shots: (draft.shots ?? []).map((shot) => (shot.id === id ? { ...shot, ...patch } : shot)),
    });
  return (
    <div className="canvas-music-video__editor">
      <p>保存将创建工作流新版本，并重新审核本阶段及后续内容。</p>
      {draft.timeline?.map((segment, index) => (
        <fieldset key={segment.id}>
          <legend>
            第 {index + 1} 段 · {segment.section}
          </legend>
          <div className="canvas-music-video__row">
            {(["startSeconds", "endSeconds"] as const).map((field) => (
              <label key={field}>
                {field === "startSeconds" ? "开始（秒）" : "结束（秒）"}
                <input
                  type="number"
                  step="0.01"
                  min={0}
                  value={segment[field]}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      timeline: draft.timeline!.map((item) =>
                        item.id === segment.id
                          ? { ...item, [field]: Number(e.target.value) }
                          : item,
                      ),
                    })
                  }
                />
              </label>
            ))}
            <label>
              类型
              <select
                value={segment.kind}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    timeline: draft.timeline!.map((item) =>
                      item.id === segment.id
                        ? {
                            ...item,
                            kind: e.target.value as "vocal" | "instrumental",
                            text: e.target.value === "instrumental" ? "" : item.text,
                          }
                        : item,
                    ),
                  })
                }
              >
                <option value="vocal">演唱</option>
                <option value="instrumental">纯音乐</option>
              </select>
            </label>
          </div>
          <label>
            歌词
            <ImeTextarea
              rows={2}
              value={segment.text}
              disabled={segment.kind === "instrumental"}
              onValueChange={(text) =>
                setDraft({
                  ...draft,
                  timeline: draft.timeline!.map((item) =>
                    item.id === segment.id ? { ...item, text } : item,
                  ),
                })
              }
            />
          </label>
        </fieldset>
      ))}
      {draft.style ? (
        <label>
          视觉与人物风格
          <ImeTextarea
            rows={6}
            value={draft.style.description}
            onValueChange={(description) =>
              setDraft({ ...draft, style: { ...draft.style!, description } })
            }
          />
        </label>
      ) : null}
      {draft.style?.assets.map((asset) => (
        <label key={asset.id}>
          {asset.name}
          <ImeTextarea
            rows={3}
            value={asset.prompt}
            onValueChange={(prompt) =>
              setDraft({
                ...draft,
                style: {
                  ...draft.style!,
                  assets: draft.style!.assets.map((item) =>
                    item.id === asset.id ? { ...item, prompt } : item,
                  ),
                },
              })
            }
          />
        </label>
      ))}
      {draft.shots?.map((shot) => (
        <fieldset key={shot.id}>
          <legend>
            {shot.title} · {shot.startSeconds}–{shot.endSeconds} 秒
          </legend>
          <label>
            画面
            <ImeTextarea
              rows={3}
              value={shot.visual}
              disabled={stage === "prompts"}
              onValueChange={(visual) => updateShot(shot.id, { visual })}
            />
          </label>
          <label>
            视频提示词
            <ImeTextarea
              rows={5}
              value={shot.videoPrompt}
              onValueChange={(videoPrompt) => updateShot(shot.id, { videoPrompt })}
            />
          </label>
          <div className="canvas-music-video__row">
            <label>
              景别
              <select
                value={shot.framing}
                disabled={stage === "prompts"}
                onChange={(e) => updateShot(shot.id, { framing: e.target.value })}
              >
                <option value="close">近景</option>
                <option value="medium">中景</option>
                <option value="wide">远景</option>
              </select>
            </label>
            <label>
              演唱策略
              <select
                value={shot.lipSync}
                disabled={stage === "prompts"}
                onChange={(e) => updateShot(shot.id, { lipSync: e.target.value })}
              >
                <option value="sync">正面演唱</option>
                <option value="offscreen">画外演唱</option>
                <option value="none">无演唱动作</option>
              </select>
            </label>
          </div>
        </fieldset>
      ))}
      <div className="canvas-music-video__row">
        <button
          type="button"
          onClick={() =>
            onSave({
              ...draft,
              content: JSON.stringify(
                stage === "timeline"
                  ? draft.timeline
                  : stage === "style"
                    ? draft.style
                    : draft.shots,
                null,
                2,
              ),
            })
          }
        >
          保存阶段新版本
        </button>
        <button type="button" onClick={onCancel}>
          取消编辑
        </button>
      </div>
    </div>
  );
}

function MusicVideoLipReviewPreview({
  clipPath,
  songPath,
  startSeconds,
  endSeconds,
  title,
}: {
  readonly clipPath: string;
  readonly songPath: string;
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly title: string;
}) {
  const clipRef = useRef<HTMLVideoElement>(null);
  const songRef = useRef<HTMLAudioElement>(null);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  function synchronize() {
    const clip = clipRef.current;
    const song = songRef.current;
    if (!clip || !song || song.readyState < HTMLMediaElement.HAVE_METADATA) return;
    const songTime = startSeconds + clip.currentTime;
    if (songTime >= endSeconds) {
      clip.pause();
      song.pause();
    } else if (Math.abs(song.currentTime - songTime) > 0.15) {
      song.currentTime = songTime;
    }
  }
  function playWithOriginalSong() {
    synchronize();
    void songRef.current?.play().then(
      () => setPlaybackError(null),
      () => setPlaybackError("原曲窗口未能播放；请手动试听后再决定是否选用此镜。"),
    );
  }
  return (
    <>
      <p>播放视频时自动同步原曲窗口；视频内音轨静音。</p>
      <video
        ref={clipRef}
        controls
        muted
        preload="metadata"
        src={toMediaSrc(clipPath)}
        aria-label={`${title} 片段预览`}
        onPlay={playWithOriginalSong}
        onPause={() => songRef.current?.pause()}
        onEnded={() => songRef.current?.pause()}
        onSeeked={synchronize}
        onTimeUpdate={synchronize}
      />
      <audio
        ref={songRef}
        controls
        preload="metadata"
        src={`${toMediaSrc(songPath)}#t=${startSeconds},${endSeconds}`}
        aria-label={`${title} 原曲窗口试听`}
        onLoadedMetadata={synchronize}
      />
      {playbackError ? <p role="alert">{playbackError}</p> : null}
    </>
  );
}

export function MusicVideoDeliverables({
  checkpoint,
  disabled,
  onEdit,
  onLipReview,
  onExport,
}: {
  readonly checkpoint: KnowledgeVideoWorkflowCheckpoint;
  readonly disabled: boolean;
  readonly onEdit: (stage: MusicVideoStage, patch: Partial<MusicVideoArtifact>) => void;
  readonly onLipReview: (
    shotId: string,
    decision: "approved" | "rejected",
    clipSignature: string,
    note: string,
  ) => Promise<void> | void;
  readonly onExport?: () => void;
}) {
  const [editing, setEditing] = useState<MusicVideoStage | null>(null);
  const [lipNotes, setLipNotes] = useState<Record<string, string>>({});
  const [lipBusy, setLipBusy] = useState<string | null>(null);
  const [lipError, setLipError] = useState<string | null>(null);
  const state = checkpoint.musicVideo;
  if (
    !state ||
    (!state.speech && !MUSIC_VIDEO_STAGES.some((stage) => state.stages[stage]?.artifact))
  )
    return null;
  const syncShots =
    state.stages.prompts?.artifact?.shots?.filter((shot) => shot.lipSync === "sync") ?? [];
  async function reviewLipShot(shotId: string, decision: "approved" | "rejected") {
    const clipPath = checkpoint.shotRuns[shotId]?.clipPath;
    if (!clipPath) return;
    setLipBusy(shotId);
    setLipError(null);
    try {
      const clipSignature = await mvMediaClient.clipSignature(clipPath);
      await onLipReview(shotId, decision, clipSignature, lipNotes[shotId] ?? "");
    } catch (error) {
      setLipError(error instanceof Error ? error.message : String(error));
    } finally {
      setLipBusy(null);
    }
  }
  return (
    <section className="canvas-ai-film-workflow__artifacts" aria-label="MV 阶段交付物">
      <strong>
        MV 制作成果 {state.song ? `· ${state.song.durationSeconds.toFixed(2)} 秒` : ""}
      </strong>
      {onExport ? (
        <button type="button" onClick={onExport}>
          导出 MV 制作四件套
        </button>
      ) : null}
      {state.speech ? (
        <details className="canvas-knowledge-workflow__deliverables" open>
          <summary>原曲 ASR 与强制对齐</summary>
          <p>
            ASR：
            {state.speech.asr
              ? `${state.speech.asr.engine} ${state.speech.asr.modelVersion} · ${state.speech.asr.segments.length} 段声学识别`
              : "未取得真实测量"}
          </p>
          {state.speech.asr ? <pre>{state.speech.asr.transcript || "未识别到唱词"}</pre> : null}
          <p>
            强制对齐：
            {state.speech.forcedAlignment
              ? `${state.speech.forcedAlignment.engine} ${state.speech.forcedAlignment.modelVersion} · ${state.speech.forcedAlignment.lines.length} 行`
              : "未取得真实测量"}
          </p>
          {state.speech.forcedAlignment?.lines.length ? (
            <ol>
              {state.speech.forcedAlignment.lines.map((line, index) => (
                <li key={`${index}-${line.startSeconds}`}>
                  {line.startSeconds.toFixed(3)}–{line.endSeconds.toFixed(3)} 秒 · {line.text}
                </li>
              ))}
            </ol>
          ) : null}
        </details>
      ) : null}
      {MUSIC_VIDEO_STAGES.map((stage) => {
        const run = state.stages[stage];
        if (!run?.artifact) return null;
        return (
          <details
            key={stage}
            className="canvas-knowledge-workflow__deliverables"
            open={state.pending?.stage === stage}
          >
            <summary>
              {MUSIC_VIDEO_STAGE_LABELS[stage]} · v{run.artifact.version} ·{" "}
              {isMusicVideoStageApproved(run) ? "已确认" : "待确认"}
            </summary>
            <div>
              <pre>{run.artifact.content}</pre>
              {run.artifact.timeline ? (
                <ol>
                  {run.artifact.timeline.map((segment) => (
                    <li key={segment.id}>
                      {segment.startSeconds.toFixed(2)}–{segment.endSeconds.toFixed(2)} 秒 ·{" "}
                      {segment.kind === "instrumental" ? "纯音乐" : segment.text}
                    </li>
                  ))}
                </ol>
              ) : null}
              {run.artifact.shots ? (
                <ol>
                  {run.artifact.shots.map((shot) => (
                    <li key={shot.id}>
                      {shot.title} · {shot.startSeconds}–{shot.endSeconds} 秒 ·{" "}
                      {shot.lipSync === "sync" ? "正面演唱（逐镜人工验收）" : "无正面演唱"}
                      <pre>{shot.videoPrompt}</pre>
                    </li>
                  ))}
                </ol>
              ) : null}
              <p>独立审核：{run.review?.report ?? "等待检查"}</p>
              {editing === stage && !disabled ? (
                <ArtifactEditor
                  key={`${stage}-${run.artifact.version}`}
                  artifact={run.artifact}
                  stage={stage}
                  onSave={(patch) => {
                    onEdit(stage, patch);
                    setEditing(null);
                  }}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                <button type="button" disabled={disabled} onClick={() => setEditing(stage)}>
                  编辑{MUSIC_VIDEO_STAGE_LABELS[stage]}
                </button>
              )}
              {run.history.length ? (
                <details>
                  <summary>{run.history.length} 份历史稿</summary>
                  {run.history.map((item) => (
                    <details key={`${item.version}-${item.createdAt}`}>
                      <summary>v{item.version}</summary>
                      <pre>{item.content}</pre>
                    </details>
                  ))}
                </details>
              ) : null}
            </div>
          </details>
        );
      })}
      {syncShots.length ? (
        <details className="canvas-knowledge-workflow__deliverables" open>
          <summary>正面演唱逐镜人工验收</summary>
          <p>
            当前未接入自动唇音偏移检测。请试听原曲窗口、预览实际片段，并逐镜选用或驳回；片段正文变化后审核自动失效。
          </p>
          {lipError ? <p role="alert">{lipError}</p> : null}
          {syncShots.map((shot) => {
            const clipPath = checkpoint.shotRuns[shot.id]?.clipPath;
            const review = state.lipReviews?.[shot.id];
            let current = false;
            if (review) {
              try {
                current =
                  review.signature ===
                  musicVideoLipReviewSignature(checkpoint, shot.id, review.clipSignature);
              } catch {
                current = false;
              }
            }
            const lyric = state.stages.timeline?.artifact?.timeline?.find(
              (item) => item.id === shot.segmentId,
            )?.text;
            return (
              <div key={shot.id} className="canvas-music-video__lip-review">
                <strong>
                  {shot.title} · {shot.startSeconds.toFixed(2)}–{shot.endSeconds.toFixed(2)} 秒
                </strong>
                {/* 空歌词行同样算「没有已确认歌词」，因此用真值判断而不是 ??。 */}
                <p>{lyric ? lyric : "该镜头没有已确认歌词"}</p>
                <p>
                  状态：
                  {!current
                    ? "待人工验收"
                    : review?.decision === "approved"
                      ? "人工选用"
                      : "人工驳回"}
                </p>
                {clipPath && state.song ? (
                  <MusicVideoLipReviewPreview
                    clipPath={clipPath}
                    songPath={state.song.sourcePath}
                    startSeconds={shot.startSeconds}
                    endSeconds={shot.endSeconds}
                    title={shot.title}
                  />
                ) : (
                  <p>片段或原曲尚未就绪。</p>
                )}
                <label>
                  验收备注
                  <ImeTextarea
                    rows={2}
                    value={lipNotes[shot.id] ?? review?.note ?? ""}
                    disabled={disabled || !clipPath}
                    onValueChange={(note) =>
                      setLipNotes((previous) => ({ ...previous, [shot.id]: note }))
                    }
                  />
                </label>
                <div className="canvas-music-video__row">
                  <button
                    type="button"
                    disabled={disabled || !clipPath || lipBusy !== null}
                    onClick={() => void reviewLipShot(shot.id, "approved")}
                  >
                    人工选用此镜
                  </button>
                  <button
                    type="button"
                    disabled={disabled || !clipPath || lipBusy !== null}
                    onClick={() => void reviewLipShot(shot.id, "rejected")}
                  >
                    驳回并返工
                  </button>
                </div>
              </div>
            );
          })}
        </details>
      ) : null}
      {state.alignment ? (
        <p>
          成片音视频时长检查：{state.alignment.aligned ? "通过" : "未通过"}
          。该项只测流时长。
        </p>
      ) : null}
    </section>
  );
}
