import { useState } from "react";
import { ImeTextarea } from "../../components/ImeTextField";
import {
  formatRawBackendError,
  toMediaSrc,
  type VideoDownloaderCookieBrowser,
  type VideoDownloaderEngineStatus,
} from "../../lib/backend";
import { DownloadCookieSourceControls } from "./DownloadCookieSourceControls";
import { revealDesktopItem } from "./desktopActions";
import {
  REELBENCH_CAMERAS,
  REELBENCH_CATEGORIES,
  REELBENCH_RHYTHMS,
  REELBENCH_SIZES,
  REELBENCH_TRANSITIONS,
  reelbenchDraftSignature,
  reelbenchRegisterSubjects,
  reelbenchShotIsAnnotated,
  type ReelbenchCamera,
  type ReelbenchCategory,
  type ReelbenchRhythm,
  type ReelbenchSize,
  type ReelbenchTransition,
  type ReelbenchShot,
  type ReelbenchWorkflowOptions,
} from "./reelbenchWorkflowModel";
import type { KnowledgeVideoWorkflowCheckpoint } from "./workspaceModel";
import "./ReelbenchWorkflowSections.css";

const SIZE_LABELS: Record<ReelbenchSize, string> = {
  none: "无景别",
  "extreme-wide": "大远景",
  wide: "全景",
  "medium-wide": "中远景",
  medium: "中景",
  "medium-close": "中近景",
  close: "特写",
  "extreme-close": "大特写",
};
const CATEGORY_LABELS: Record<ReelbenchCategory, string> = {
  establishing: "定场",
  subject: "主体",
  dialogue: "对话",
  reaction: "反应",
  insert: "插入特写",
  pov: "主观",
  empty: "空镜",
  product: "产品展示",
  "text-card": "字卡",
  transition: "转场镜头",
  archive: "引用素材",
};
const CAMERA_LABELS: Record<ReelbenchCamera, string> = {
  static: "固定",
  "push-in": "推",
  "pull-out": "拉",
  "zoom-in": "变焦推",
  "zoom-out": "变焦拉",
  "pan-left": "左摇",
  "pan-right": "右摇",
  "tilt-up": "上摇",
  "tilt-down": "下摇",
  "truck-left": "左移",
  "truck-right": "右移",
  "pedestal-up": "升",
  "pedestal-down": "降",
  tracking: "跟拍",
  arc: "环绕",
  "whip-pan": "甩镜",
  handheld: "手持微晃",
  shake: "剧烈晃动",
  "rack-focus": "变焦点",
  "micro-push": "微推",
  roll: "旋转",
  drone: "航拍移动",
};
const TRANSITION_LABELS: Record<ReelbenchTransition, string> = {
  cut: "硬切",
  dissolve: "叠化",
  "fade-in": "淡入",
  "fade-out": "淡出",
  whip: "甩切",
  "match-cut": "匹配剪辑",
  wipe: "划像",
  morph: "特效转场",
};
const RHYTHM_LABELS: Record<ReelbenchRhythm, string> = {
  hook: "钩子",
  setup: "铺垫",
  build: "递进",
  beat: "重音",
  turn: "转折",
  payoff: "兑现",
  breath: "换气",
  close: "收口",
};

interface ReelbenchConfigurationProps {
  readonly options: ReelbenchWorkflowOptions;
  readonly brief: string;
  readonly disabled: boolean;
  readonly onChange: (options: ReelbenchWorkflowOptions) => void;
  readonly onBriefChange: (brief: string) => void;
  readonly onPickVideo?: () => Promise<void> | void;
  readonly onRemoveVideo?: () => void;
  readonly onOpenDownloadSettings?: () => void;
  readonly cookieStatus?: VideoDownloaderEngineStatus | null;
  readonly cookieBusy?: boolean | undefined;
  readonly onSelectCookieBrowser?: ((browser: VideoDownloaderCookieBrowser | null) => void) | undefined;
  readonly onClearCookies?: (() => void) | undefined;
}

export function ReelbenchConfiguration({
  options,
  brief,
  disabled,
  onChange,
  onBriefChange,
  onPickVideo,
  onRemoveVideo,
  onOpenDownloadSettings,
  cookieStatus = null,
  cookieBusy = false,
  onSelectCookieBrowser,
  onClearCookies,
}: ReelbenchConfigurationProps) {
  const [picking, setPicking] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
  const localSelected = Boolean(options.localVideoPath);

  async function pickVideo() {
    if (!onPickVideo || picking) return;
    setPicking(true);
    setPickError(null);
    try {
      await onPickVideo();
    } catch (error) {
      setPickError(formatRawBackendError(error));
    } finally {
      setPicking(false);
    }
  }

  return (
    <fieldset className="reelbench__configuration" disabled={disabled || picking}>
      <legend>原片与拉片设置</legend>
      {localSelected ? (
        <div className="reelbench__source">
          <strong>{options.localVideoName || "已选择本地视频"}</strong>
          <button type="button" onClick={onRemoveVideo} disabled={!onRemoveVideo}>
            移除
          </button>
        </div>
      ) : (
        <label>
          <span>视频分享链接或分享文案</span>
          <ImeTextarea
            aria-label="拉片视频分享链接"
            rows={2}
            value={options.sourceUrl}
            placeholder="粘贴一条视频链接，或改用本地视频。"
            onValueChange={(sourceUrl) => onChange({ ...options, sourceUrl })}
          />
        </label>
      )}
      <div className="reelbench__actions">
        <button type="button" onClick={() => void pickVideo()} disabled={!onPickVideo || picking}>
          {picking ? "正在选择…" : localSelected ? "更换本地视频" : "选择本地视频"}
        </button>
      </div>
      {!localSelected && options.sourceUrl.trim() && onOpenDownloadSettings ? (
        <DownloadCookieSourceControls
          status={cookieStatus}
          busy={cookieBusy}
          onSelectBrowser={onSelectCookieBrowser}
          onImportCookies={onOpenDownloadSettings}
          onClearCookies={onClearCookies}
          importLabel="导入下载登录凭据"
        />
      ) : null}
      {pickError ? <p role="alert">{pickError}</p> : null}
      <label>
        <span>分析用途</span>
        <select
          aria-label="拉片分析用途"
          value={options.purpose}
          onChange={(event) =>
            onChange({
              ...options,
              purpose: event.target.value as ReelbenchWorkflowOptions["purpose"],
            })
          }
        >
          <option value="remake">仿写参考</option>
          <option value="editing">剪辑节奏</option>
          <option value="inventory">投放素材盘点</option>
        </select>
      </label>
      <label>
        <span>重点要求（可选）</span>
        <ImeTextarea
          aria-label="拉片重点要求"
          rows={2}
          value={brief}
          placeholder="例如：重点记录产品出镜、字卡和开头节奏。"
          onValueChange={onBriefChange}
        />
      </label>
      <div className="reelbench__settings">
        <label>
          <span>切点敏感度</span>
          <input
            aria-label="切点敏感度"
            type="number"
            min="0.05"
            max="0.9"
            step="0.05"
            value={options.sceneThreshold}
            onChange={(event) =>
              onChange({ ...options, sceneThreshold: event.currentTarget.valueAsNumber })
            }
          />
          <small>较小数值会检出更多镜头。</small>
        </label>
        <label>
          <span>最短镜头（秒）</span>
          <input
            aria-label="最短镜头秒数"
            type="number"
            min="0.1"
            max="5"
            step="0.05"
            value={options.minShotSeconds}
            onChange={(event) =>
              onChange({ ...options, minShotSeconds: event.currentTarget.valueAsNumber })
            }
          />
        </label>
        <label>
          <span>报告语言</span>
          <select
            aria-label="拉片报告语言"
            value={options.language}
            onChange={(event) =>
              onChange({ ...options, language: event.target.value as "zh" | "en" })
            }
          >
            <option value="zh">中文</option>
            <option value="en">English</option>
          </select>
        </label>
      </div>
      <label className="reelbench__checkbox">
        <input
          type="checkbox"
          checked={options.includeSyncVideo}
          onChange={(event) =>
            onChange({ ...options, includeSyncVideo: event.currentTarget.checked })
          }
        />
        同时导出画面与镜头信息同步的视频
      </label>
      {options.includeSyncVideo ? (
        <label>
          <span>同步视频画面倍率</span>
          <select
            aria-label="同步视频画面倍率"
            value={options.syncScale}
            onChange={(event) =>
              onChange({ ...options, syncScale: Number(event.currentTarget.value) })
            }
          >
            <option value={1}>1×</option>
            <option value={2}>2×</option>
            <option value={3}>3×</option>
          </select>
        </label>
      ) : null}
      <small>切点、时长和本地文件由项目内 FFmpeg 测量；文本模型只分析实际抽出的画面。</small>
    </fieldset>
  );
}

interface ReelbenchDeliverablesProps {
  readonly checkpoint: KnowledgeVideoWorkflowCheckpoint;
  readonly disabled: boolean;
  readonly onChange: (checkpoint: KnowledgeVideoWorkflowCheckpoint) => void;
  readonly onContinue: () => void;
}

export function ReelbenchDeliverables({
  checkpoint,
  disabled,
  onChange,
  onContinue,
}: ReelbenchDeliverablesProps) {
  const state = checkpoint.reelbench;
  const [page, setPage] = useState(0);
  const [rawEditingId, setEditingId] = useState<string | null>(null);
  const [rawDraftShot, setDraftShot] = useState<ReelbenchShot | null>(null);
  const [editingDraft, setEditingDraft] =
    useState<NonNullable<KnowledgeVideoWorkflowCheckpoint["reelbench"]>["draft"]>(null);
  const [splitAt, setSplitAt] = useState("");
  const [mergeAt, setMergeAt] = useState("");
  const [openError, setOpenError] = useState<string | null>(null);
  const draft = state?.draft ?? null;
  const editingId = editingDraft === draft ? rawEditingId : null;
  const draftShot = editingDraft === draft ? rawDraftShot : null;
  if (!state || (!state.videoPath && !state.draft)) return null;
  const annotated = draft?.shots.filter(reelbenchShotIsAnnotated).length ?? 0;
  const pageCount = Math.max(1, Math.ceil((draft?.shots.length ?? 0) / 12));
  const safePage = Math.min(page, pageCount - 1);
  const visibleShots = draft?.shots.slice(safePage * 12, (safePage + 1) * 12) ?? [];
  const draftSignature = draft ? reelbenchDraftSignature(draft) : null;
  const approved = Boolean(
    draft &&
    state.validation?.ok &&
    state.validatedDraftSignature === draftSignature &&
    state.approvedDraftSignature === draftSignature,
  );
  const canReview =
    !disabled &&
    Boolean(
      draft &&
      state.validation?.ok &&
      state.validatedDraftSignature === draftSignature &&
      annotated === draft.shots.length,
    );

  function updateDraft(
    next: NonNullable<typeof draft>,
    step: NonNullable<typeof state>["step"] = "validate",
  ) {
    if (disabled) return;
    const registered = reelbenchRegisterSubjects(next);
    onChange({
      ...checkpoint,
      phase: "paused",
      error: null,
      finalPath: null,
      reelbench: {
        ...state!,
        manualRevision: state!.manualRevision + 1,
        draft: registered,
        completedDraftSignature: registered.shots.every(reelbenchShotIsAnnotated)
          ? reelbenchDraftSignature(registered)
          : state!.completedDraftSignature,
        step,
        validation: null,
        validatedDraftSignature: null,
        approvedDraftSignature: null,
        reportJsonPath: null,
        reportMarkdownPath: null,
        reportHtmlPath: null,
        syncVideoPath: null,
      },
    });
  }

  function saveShot() {
    if (disabled || !draft || !draftShot || !editingId) return;
    const original = draft.shots.find((shot) => shot.id === editingId);
    if (
      !original ||
      original.start !== draftShot.start ||
      original.end !== draftShot.end ||
      original.frameAPath !== draftShot.frameAPath ||
      original.frameBPath !== draftShot.frameBPath
    ) {
      setEditingId(null);
      setDraftShot(null);
      return;
    }
    updateDraft({
      ...draft,
      shots: draft.shots.map((shot) =>
        shot.id === editingId
          ? {
              ...draftShot,
              id: shot.id,
              start: shot.start,
              end: shot.end,
              seconds: shot.seconds,
              motion: shot.motion,
              frameAPath: shot.frameAPath,
              frameBPath: shot.frameBPath,
            }
          : shot,
      ),
    });
    setEditingId(null);
    setDraftShot(null);
  }

  function recut(kind: "split" | "merge") {
    if (!draft || disabled) return;
    const cut = Number(kind === "split" ? splitAt : mergeAt);
    if (!Number.isFinite(cut) || cut <= 0 || cut >= draft.meta.durationSeconds) return;
    const pending = state!.pendingRecut;
    const splitCuts = [...(pending?.splitCuts ?? [])];
    const mergeCuts = [...(pending?.mergeCuts ?? [])];
    const target = kind === "split" ? splitCuts : mergeCuts;
    if (target.some((entry) => Math.abs(entry - cut) < 0.005)) return;
    target.push(cut);
    onChange({
      ...checkpoint,
      phase: "paused",
      error: null,
      finalPath: null,
      reelbench: {
        ...state!,
        manualRevision: state!.manualRevision + 1,
        step: "seed",
        pendingRecut: {
          splitCuts,
          mergeCuts,
        },
        validation: null,
        validatedDraftSignature: null,
        approvedDraftSignature: null,
        reportJsonPath: null,
        reportMarkdownPath: null,
        reportHtmlPath: null,
        syncVideoPath: null,
      },
    });
    setSplitAt("");
    setMergeAt("");
  }

  async function reveal(path: string) {
    setOpenError(null);
    try {
      await revealDesktopItem(path);
    } catch (error) {
      setOpenError(formatRawBackendError(error));
    }
  }

  return (
    <section className="reelbench__deliverables" aria-label="拉片分析与审核">
      <div className="reelbench__summary">
        <strong>
          {draft ? `${draft.shots.length} 镜 · 已标注 ${annotated} 镜` : "正在准备原片"}
        </strong>
        {draft ? (
          <span>
            {draft.meta.durationSeconds.toFixed(2)} 秒 · {draft.meta.width} × {draft.meta.height} ·{" "}
            {draft.meta.fps.toFixed(2)} fps
          </span>
        ) : null}
      </div>
      {state.videoPath ? (
        <details>
          <summary>原片预览</summary>
          <video
            controls
            preload="metadata"
            src={toMediaSrc(state.videoPath)}
            aria-label="拉片原片预览"
          />
        </details>
      ) : null}
      {draft ? (
        <>
          <p>
            镜头时间来自本机逐帧检测。请核对首尾帧、漏切与多切；人工补刀会重新计算相关镜头并要求重审。
          </p>
          <div className="reelbench__recut">
            <label>
              在时间点补刀（秒）
              <input
                aria-label="补刀时间点"
                type="number"
                min={0}
                max={draft.meta.durationSeconds}
                step="0.01"
                value={splitAt}
                onChange={(event) => setSplitAt(event.currentTarget.value)}
              />
            </label>
            <button type="button" disabled={disabled || !splitAt} onClick={() => recut("split")}>
              记录补刀
            </button>
            <label>
              合并切点（秒）
              <select
                aria-label="合并切点"
                value={mergeAt}
                onChange={(event) => setMergeAt(event.currentTarget.value)}
              >
                <option value="">选择切点</option>
                {[...draft.seedCuts, ...draft.manualCuts]
                  .sort((a, b) => a - b)
                  .map((cut) => (
                    <option key={cut} value={cut}>
                      {cut.toFixed(2)} 秒
                    </option>
                  ))}
              </select>
            </label>
            <button type="button" disabled={disabled || !mergeAt} onClick={() => recut("merge")}>
              记录合并
            </button>
            {state.pendingRecut ? (
              <button type="button" disabled={disabled} onClick={onContinue}>
                应用切点修改并重新分析
              </button>
            ) : null}
          </div>
          {state.validation ? (
            <section className="reelbench__quality" aria-label="拉片质量检查">
              <strong>{state.validation.ok ? "质量门通过" : "质量门发现待修项目"}</strong>
              <p>
                {state.validation.gates.filter((gate) => gate.ok).length} /{" "}
                {state.validation.gates.length} 项通过
              </p>
              {state.validation.gates
                .filter((gate) => !gate.ok || gate.skipped)
                .map((gate) => (
                  <p key={gate.id}>
                    {gate.id}：{gate.skipped ? "未检查" : gate.issues.join("；")}
                  </p>
                ))}
              {state.validation.hints.map((hint, index) => (
                <p key={index}>提示：{hint}</p>
              ))}
            </section>
          ) : null}
          <div className="reelbench__actions">
            {!state.validation && !state.pendingRecut && annotated === draft.shots.length ? (
              <button type="button" disabled={disabled} onClick={onContinue}>
                运行确定性质量检查
              </button>
            ) : null}
            {canReview && !approved ? (
              <button
                type="button"
                onClick={() =>
                  onChange({
                    ...checkpoint,
                    phase: "paused",
                    error: null,
                    reelbench: { ...state, step: "report", approvedDraftSignature: draftSignature },
                  })
                }
              >
                已逐镜审阅，批量批准全部 {draft.shots.length} 镜
              </button>
            ) : null}
            {approved && !state.reportHtmlPath ? (
              <button type="button" disabled={disabled} onClick={onContinue}>
                继续导出报告{state.syncVideoPath ? "" : "与视频"}
              </button>
            ) : null}
          </div>
          <ol className="reelbench__shots">
            {visibleShots.map((shot) => (
              <li key={shot.id}>
                <div className="reelbench__shot-head">
                  <strong>
                    {shot.id} · {shot.start.toFixed(2)}–{shot.end.toFixed(2)} 秒
                  </strong>
                  <span>
                    {shot.seconds.toFixed(2)} 秒 ·{" "}
                    {reelbenchShotIsAnnotated(shot) ? "已标注" : "待标注"}
                  </span>
                </div>
                <div className="reelbench__frames">
                  <img src={toMediaSrc(shot.frameAPath)} alt={`${shot.id} 起手帧`} loading="lazy" />
                  <img src={toMediaSrc(shot.frameBPath)} alt={`${shot.id} 收尾帧`} loading="lazy" />
                </div>
                <p>{shot.frame || "等待模型依据首尾帧填写画面描述。"}</p>
                {shot.size || shot.category || shot.camera ? (
                  <small>
                    {shot.size ?? "未标景别"} · {shot.category ?? "未标类别"} ·{" "}
                    {shot.camera ?? "未标运镜"}
                  </small>
                ) : null}
                {shot.motion != null ? (
                  <small>实测帧间变化：{shot.motion.toFixed(3)}</small>
                ) : (
                  <small>运动量未测得，相关质量门会说明未检查。</small>
                )}
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    setEditingDraft(draft);
                    setEditingId(shot.id);
                    setDraftShot(shot);
                  }}
                >
                  编辑本镜
                </button>
                {editingId === shot.id && draftShot ? (
                  <fieldset className="reelbench__shot-editor" disabled={disabled}>
                    <label>
                      景别
                      <select
                        value={draftShot.size ?? ""}
                        onChange={(event) =>
                          setDraftShot({
                            ...draftShot,
                            size: event.currentTarget.value,
                          })
                        }
                      >
                        <option value="">请选择</option>
                        {REELBENCH_SIZES.map((value) => (
                          <option key={value} value={value}>
                            {SIZE_LABELS[value]}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      类别
                      <select
                        value={draftShot.category ?? ""}
                        onChange={(event) =>
                          setDraftShot({
                            ...draftShot,
                            category: event.currentTarget.value,
                          })
                        }
                      >
                        <option value="">请选择</option>
                        {REELBENCH_CATEGORIES.map((value) => (
                          <option key={value} value={value}>
                            {CATEGORY_LABELS[value]}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      运镜
                      <select
                        value={draftShot.camera ?? ""}
                        onChange={(event) =>
                          setDraftShot({
                            ...draftShot,
                            camera: event.currentTarget.value,
                          })
                        }
                      >
                        <option value="">请选择</option>
                        {REELBENCH_CAMERAS.map((value) => (
                          <option key={value} value={value}>
                            {CAMERA_LABELS[value]}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      转场
                      <select
                        value={draftShot.transitionIn ?? "cut"}
                        onChange={(event) =>
                          setDraftShot({
                            ...draftShot,
                            transitionIn: event.currentTarget.value,
                          })
                        }
                      >
                        {REELBENCH_TRANSITIONS.map((value) => (
                          <option key={value} value={value}>
                            {TRANSITION_LABELS[value]}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      画面描述
                      <textarea
                        value={draftShot.frame ?? ""}
                        rows={3}
                        onChange={(event) =>
                          setDraftShot({ ...draftShot, frame: event.currentTarget.value })
                        }
                      />
                    </label>
                    <label>
                      画面文字
                      <input
                        value={draftShot.onscreenText ?? ""}
                        onChange={(event) =>
                          setDraftShot({ ...draftShot, onscreenText: event.currentTarget.value })
                        }
                      />
                    </label>
                    <label>
                      可见字幕或可确认台词
                      <input
                        value={draftShot.audio ?? ""}
                        onChange={(event) =>
                          setDraftShot({ ...draftShot, audio: event.currentTarget.value })
                        }
                      />
                    </label>
                    <label>
                      主体（逗号分隔）
                      <input
                        value={draftShot.subjects?.join("，") ?? ""}
                        onChange={(event) =>
                          setDraftShot({
                            ...draftShot,
                            subjects: event.currentTarget.value
                              .split(/[，,]/)
                              .map((item) => item.trim())
                              .filter(Boolean),
                          })
                        }
                      />
                    </label>
                    <label>
                      节奏角色
                      <select
                        value={draftShot.rhythm ?? ""}
                        onChange={(event) => {
                          if (event.currentTarget.value)
                            setDraftShot({
                              ...draftShot,
                              rhythm: event.currentTarget.value,
                            });
                          else setDraftShot({ ...draftShot, rhythm: "", rhythmNote: "" });
                        }}
                      >
                        <option value="">不标节奏</option>
                        {REELBENCH_RHYTHMS.map((value) => (
                          <option key={value} value={value}>
                            {RHYTHM_LABELS[value]}
                          </option>
                        ))}
                      </select>
                    </label>
                    {draftShot.rhythm ? (
                      <label>
                        节奏理由
                        <input
                          value={draftShot.rhythmNote ?? ""}
                          onChange={(event) =>
                            setDraftShot({ ...draftShot, rhythmNote: event.currentTarget.value })
                          }
                        />
                      </label>
                    ) : null}
                    <label>
                      备注
                      <input
                        value={draftShot.note ?? ""}
                        onChange={(event) =>
                          setDraftShot({ ...draftShot, note: event.currentTarget.value })
                        }
                      />
                    </label>
                    <div className="reelbench__actions">
                      <button type="button" disabled={disabled} onClick={saveShot}>
                        保存本镜修改
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingId(null);
                          setDraftShot(null);
                        }}
                      >
                        取消
                      </button>
                    </div>
                  </fieldset>
                ) : null}
              </li>
            ))}
          </ol>
          <div className="reelbench__pagination">
            <button type="button" disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>
              上一页
            </button>
            <span>
              {safePage + 1} / {pageCount}
            </span>
            <button
              type="button"
              disabled={safePage >= pageCount - 1}
              onClick={() => setPage(safePage + 1)}
            >
              下一页
            </button>
          </div>
        </>
      ) : null}
      {state.reportHtmlPath ? (
        <div className="reelbench__delivery" role="status">
          <strong>拉片报告已导出</strong>
          <div className="reelbench__actions">
            <button type="button" onClick={() => void reveal(state.reportHtmlPath!)}>
              查看交互报告
            </button>
            {state.reportMarkdownPath ? (
              <button type="button" onClick={() => void reveal(state.reportMarkdownPath!)}>
                查看镜头表
              </button>
            ) : null}
            {state.reportJsonPath ? (
              <button type="button" onClick={() => void reveal(state.reportJsonPath!)}>
                查看数据
              </button>
            ) : null}
            {state.syncVideoPath ? (
              <button type="button" onClick={() => void reveal(state.syncVideoPath!)}>
                查看同步视频
              </button>
            ) : null}
          </div>
          {state.syncVideoPath ? (
            <video
              controls
              preload="metadata"
              src={toMediaSrc(state.syncVideoPath)}
              aria-label="同步分镜信息视频"
            />
          ) : null}
        </div>
      ) : null}
      {openError ? <p role="alert">{openError}</p> : null}
    </section>
  );
}
