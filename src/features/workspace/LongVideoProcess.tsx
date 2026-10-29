import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ErrorAlert } from "../../components/ErrorAlert";
import { useModalFocusTrap } from "../../components/useModalFocusTrap";
import {
  backendErrorMessage,
  frontendLog,
  generationClient,
  resumeGenerationResult,
  toMediaSrc,
} from "../../lib/backend";
import { formatTaskClock } from "./workspaceModel";
import {
  longVideoClient,
  longVideoRunning,
  LONG_VIDEO_RESULTS_REQUEST_EVENT,
  LONG_VIDEO_STATUS,
  LONG_VIDEO_SHOT_STATUS,
  LONG_VIDEO_BLOCKED_SHOT_STATUSES,
  LONG_VIDEO_RETRYABLE_SHOT_STATUSES,
  LONG_VIDEO_UNCERTAIN_SHOT_STATUSES,
  type LongVideoAction,
  type LongVideoJob,
  type LongVideoShot,
  type LongVideoShotStatus,
} from "../../lib/longVideo";
import { useLongVideoJobs } from "./useLongVideoJobs";
import "./LongVideoProcess.css";

/*
 * 创作过程弹窗的归属。
 *
 * 同一个画布节点会同时存在两个 LongVideoProcess 实例：画布上的卡片一份，
 * 展开的节点编辑区又克隆了一份（编辑区打开过一次后会常驻）。两边各有一份
 * open 状态的话，用户可以在两个地方各开一个弹窗——两层面板、两个焦点陷阱互相抢焦点。
 *
 * 这里把「哪个实例拥有弹窗」放进模块级状态：谁点的「查看创作过程」，谁就是拥有者，
 * 另一个实例自动收起。
 */
const dialogOwners = new Map<string, string>();
const dialogListeners = new Set<() => void>();

function subscribeDialog(listener: () => void): () => void {
  dialogListeners.add(listener);
  return () => {
    dialogListeners.delete(listener);
  };
}
function notifyDialog(): void {
  for (const listener of dialogListeners) listener();
}
function openDialog(nodeKey: string, owner: string): void {
  if (dialogOwners.get(nodeKey) === owner) return;
  dialogOwners.set(nodeKey, owner);
  notifyDialog();
}
function closeDialog(nodeKey: string, owner: string): void {
  if (dialogOwners.get(nodeKey) !== owner) return;
  dialogOwners.delete(nodeKey);
  notifyDialog();
}

/**
 * 镜头清单与连续性约束的本地草稿。
 *
 * 草稿按「任务 + 规划批次」存放，而不是放在弹窗组件里：
 * 弹窗会随当前任务重新挂载，草稿放在组件里的话，用户在「历史创作过程」里
 * 翻看别的任务再切回来，自己改过的提示词就没了。
 */
interface LongVideoDraft {
  readonly shots: readonly { id: string; title: string; prompt: string }[];
  readonly continuity: string;
}

function ProcessDialog({
  job,
  draft,
  onDraftChange,
  history,
  onSelectJob,
  readError,
  onClose,
  onChange,
}: {
  readonly job: LongVideoJob;
  readonly draft: LongVideoDraft;
  readonly onDraftChange: (draft: LongVideoDraft) => void;
  readonly history: readonly LongVideoJob[];
  readonly onSelectJob: (id: string) => void;
  readonly readError: unknown;
  readonly onClose: () => void;
  readonly onChange: () => Promise<unknown>;
}) {
  const trap = useModalFocusTrap({ active: true, onEscape: onClose });
  const [busy, setBusy] = useState(false);
  const actionGuard = useRef(false);
  const [error, setError] = useState<unknown>(null);
  const [budget, setBudget] = useState(job.submissionBudget);
  const shots = draft.shots;
  const continuity = draft.continuity;
  const [planText, setPlanText] = useState<string | null>(null);
  const [planTextError, setPlanTextError] = useState<unknown>(null);
  useEffect(() => setBudget(job.submissionBudget), [job.submissionBudget]);
  const run = (action: LongVideoAction) => {
    if (actionGuard.current) return;
    actionGuard.current = true;
    setBusy(true);
    setError(null);
    void (async () => {
      // 确认镜头带乐观锁。后端每次写入都会推进 revision，轮询间隔里的任何一次写操作
      // （例如「查询原任务」）都会让界面上的 revision 过期，用户点确认反而被挡回去。
      // 这里先回读一次最新 revision 再提交。
      const revision =
        action === "approve"
          ? (await longVideoClient.get(job.id).catch(() => null))?.revision
          : undefined;
      await longVideoClient.control({
        jobId: job.id,
        action,
        // exactOptionalPropertyTypes 下 `revision?: number` 不接受 undefined：
        // 只有真的读到版本号才带上这个键。
        ...(action === "approve"
          ? { ...(revision != null ? { revision } : {}), shots, continuity }
          : {}),
        ...(action === "set_budget" ? { submissionBudget: budget } : {}),
      });
      await onChange();
    })()
      .catch(setError)
      .finally(() => {
        actionGuard.current = false;
        setBusy(false);
      });
  };
  const restoreDownloads = () => {
    if (actionGuard.current) return;
    actionGuard.current = true;
    setBusy(true);
    setError(null);
    void (async () => {
      const failures: string[] = [];
      for (const shot of job.shots) {
        const taskId = shot.attempts.at(-1);
        if (!taskId || shot.finalPath) continue;
        // 每个片段各自兜底：某个子任务已被清理不能让后面的片段都不恢复。
        try {
          const detail = await generationClient.get(taskId);
          for (const result of detail.results) {
            if (
              ["failed", "interrupted", "local_missing", "conflict"].includes(result.saveStatus)
            ) {
              await resumeGenerationResult({ taskId, resultIndex: result.resultIndex });
            }
          }
        } catch (failure) {
          failures.push(
            `第 ${job.shots.indexOf(shot) + 1} 个片段：${backendErrorMessage(failure)}`,
          );
        }
      }
      if (failures.length > 0)
        setError(new Error(`部分片段无法恢复原产物下载：${failures.join("；")}`));
      await onChange();
    })()
      .catch(setError)
      .finally(() => {
        actionGuard.current = false;
        setBusy(false);
      });
  };
  const recover = (kind: "segments" | "output") => {
    window.dispatchEvent(
      new CustomEvent(LONG_VIDEO_RESULTS_REQUEST_EVENT, { detail: { jobId: job.id, kind } }),
    );
  };
  const done = job.shots.filter((shot) => shot.finalPath).length;
  const coverage = job.shots.reduce((total, shot) => total + shot.durationSeconds, 0);
  const editable = job.status === "awaiting_approval";
  const ended = job.status === "completed" || job.status === "cancelled";
  // 与后端的「原请求可能还在供应商那边跑」判定保持一致：回执不明 / 被中断 / 被取消。
  const uncertain = job.shots.filter(
    (shot) => LONG_VIDEO_UNCERTAIN_SHOT_STATUSES.includes(shot.status) && shot.finalPath == null,
  ).length;
  // 终态且没落盘的片段：继续原任务会被同一处检测挡回来（后端会重新判定「有片段未完成」），
  // 这时该给的是「重试该片段」或「只用成功片段合成」，不是「继续」。
  const blocked = job.shots.some(
    (shot) => shot.finalPath == null && LONG_VIDEO_BLOCKED_SHOT_STATUSES.includes(shot.status),
  );
  // 规划失败（一个镜头都没产出）时「继续原任务」只会把同一个失败的规划任务再读一遍，
  // 真正的出口是「重新规划」。
  const planningFailed = job.shots.length === 0 && job.status === "needs_attention";
  // 「继续原任务」在什么状态下是真出口：
  // - 额度用尽时是空操作（额度没变，提交上去还是会被挡），出口是「保存额度」（保存后自动继续）；
  // - 有终态未落盘的片段时会被后端同一处检测挡回来，出口是「重试该片段」或「只用成功片段合成」。
  const canResume =
    !ended &&
    !editable &&
    !planningFailed &&
    job.status !== "awaiting_budget" &&
    (job.status !== "needs_attention" || !blocked);
  // 两条互斥的提示合成一条（live region 常驻，见下方渲染处）。
  const statusMessage =
    job.status === "awaiting_budget"
      ? "已达到片段任务额度。请在下方填写新的额度并点「保存额度」，保存后会自动继续。额度按新建片段任务次数计算，包含重试；文本规划费用另由供应商结算。"
      : uncertain > 0 && !ended
        ? `有 ${uncertain} 个片段的回执不明或已被中断/取消：原请求可能已到达供应商、甚至还在供应商那边跑着，结果不一定拿得回来。确认不要这些片段后可用「重试失败片段」重新提交（会新建任务、可能产生重复费用）；也可以「仅用成功片段合成」先把已有片段拼起来。`
        : "";
  return createPortal(
    <div
      className="canvas-video-modal-scrim"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="long-video-process"
        ref={trap.ref}
        {...trap.containerProps}
        role="dialog"
        aria-modal="true"
        aria-label="长视频创作过程"
      >
        <header>
          <div>
            <strong>{job.title}</strong>
            <span role="status">
              {LONG_VIDEO_STATUS[job.status]} · {done} / {job.shots.length || "—"} 个片段已保存
            </span>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭创作过程">
            ×
          </button>
        </header>
        {history.length > 1 ? (
          <details>
            <summary>历史创作过程</summary>
            <div className="long-video-history">
              {history.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  aria-pressed={job.id === item.id}
                  onClick={() => onSelectJob(item.id)}
                >
                  {item.title} · {formatTaskClock(item.createdAt)}
                </button>
              ))}
            </div>
          </details>
        ) : null}
        <div className="long-video-process__summary">
          <span>目标 {job.targetSeconds}s</span>
          <span>单片段请求 {job.segmentSeconds}s</span>
          {job.shots.length ? <span>镜头覆盖 {coverage}s</span> : null}
          <span>
            已预留 {job.reservedSubmissions} / {job.submissionBudget} 次任务
          </span>
        </div>
        <progress
          aria-label="长视频进度"
          max={100}
          value={
            job.status === "composing"
              ? 90 + job.compositionProgress / 10
              : job.status === "completed"
                ? 100
                : job.shots.length
                  ? (done / job.shots.length) * 90
                  : 0
          }
        />
        <p>
          暂停会阻止后续片段提交；已受理的远端任务仍会执行。恢复时读取原任务，回执不明的片段不会自动重新提交。
        </p>
        {/*
        状态提示用**常驻**的 live region：条件渲染的 `role="status"` 元素是在内容出现的
        同一刻才插入 DOM 的，读屏软件多半不会朗读它——新建的 live region 不会自动播报。
        所以这里始终渲染这一个区域，只换里面的文字。
      */}
        <p className="long-video-process__status" role="status">
          {statusMessage}
        </p>
        {error || job.error ? (
          <ErrorAlert
            error={error ?? job.error}
            hint="「查询原任务」只对还在排队或生成的片段有效；已失败的片段可单独重试，已成功片段会保留。"
          />
        ) : null}
        {planTextError ? (
          <ErrorAlert
            error={planTextError}
            hint="规划原文只是参考：镜头清单以下方列表为准；列表不对时直接改，或用「重新规划」重来一次。"
          />
        ) : null}
        {readError ? (
          <ErrorAlert
            error={readError}
            hint="重试读取只查询创作过程，不会重新提交生成。"
            action={
              <button
                type="button"
                onClick={() => {
                  void onChange();
                }}
              >
                重试读取
              </button>
            }
          />
        ) : null}
        <div className="long-video-process__actions" aria-busy={busy}>
          {editable ? (
            <button type="button" disabled={busy} onClick={() => run("approve")}>
              确认镜头并开始生成
            </button>
          ) : null}
          {longVideoRunning(job) ? (
            <button type="button" disabled={busy} onClick={() => run("pause")}>
              暂停后续处理
            </button>
          ) : canResume ? (
            <button type="button" disabled={busy} onClick={() => run("resume")}>
              继续原任务
            </button>
          ) : null}
          <button type="button" disabled={busy} onClick={() => run("query")}>
            查询原任务
          </button>
          <button type="button" disabled={busy} onClick={restoreDownloads}>
            恢复片段下载
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setPlanTextError(null);
              void generationClient
                .get(job.plannerTaskId)
                .then((detail) =>
                  setPlanText(detail.textOutput?.rawModelOutput ?? "规划模型尚无完整输出。"),
                )
                .catch((failure: unknown) => {
                  // 原始报错只进日志：它长这样（英文 + 一串 UUID）——「not found: generation task 3f2c…」
                  // 对用户没有任何意义。界面上给一句人话，并说清这条原文只是参考。
                  frontendLog(
                    "warn",
                    `[long-video] 读取规划原文失败：${backendErrorMessage(failure)}`,
                  );
                  setPlanTextError(
                    new Error("读不到规划任务的原文：规划任务可能还没创建，或者已经被清理。"),
                  );
                });
            }}
          >
            查看规划原文
          </button>
          {!ended &&
          !longVideoRunning(job) &&
          job.shots.some((shot) => LONG_VIDEO_RETRYABLE_SHOT_STATUSES.includes(shot.status)) ? (
            <button type="button" disabled={busy} onClick={() => run("retry_failed")}>
              重试失败片段（新增任务）
            </button>
          ) : null}
          {!ended && !longVideoRunning(job) && job.reservedSubmissions === 0 ? (
            <button type="button" disabled={busy} onClick={() => run("replan")}>
              重新规划（新增文本请求）
            </button>
          ) : null}
          {done > 0 ? (
            <button type="button" disabled={busy} onClick={() => recover("segments")}>
              展开成功片段
            </button>
          ) : null}
          {!ended && !longVideoRunning(job) && done > 0 ? (
            <button type="button" disabled={busy} onClick={() => run("compose_partial")}>
              {done < job.shots.length ? "仅用成功片段合成（并结束本次编排）" : "重新合成成片"}
            </button>
          ) : null}
          {job.output ? (
            <button type="button" disabled={busy} onClick={() => recover("output")}>
              将成片放回画布
            </button>
          ) : null}
          {!ended ? (
            <button type="button" disabled={busy} onClick={() => run("cancel")}>
              结束编排
            </button>
          ) : null}
        </div>
        {!ended ? (
          <div className="long-video-process__budget">
            <label>
              最多新建片段任务
              <input
                type="number"
                min={Math.max(1, job.reservedSubmissions)}
                step={1}
                value={budget}
                onChange={(event) => setBudget(Number(event.target.value))}
              />
            </label>
            <button
              type="button"
              data-tooltip={
                !Number.isInteger(budget)
                  ? "额度必须是整数"
                  : budget < Math.max(1, job.reservedSubmissions)
                    ? `额度不能少于已经预留的 ${job.reservedSubmissions} 次`
                    : "保存后会自动继续生成"
              }
              disabled={busy}
              onClick={() => run("set_budget")}
            >
              保存额度
            </button>
          </div>
        ) : null}
        {job.output ? (
          <section className="long-video-process__output">
            <video src={toMediaSrc(job.output.path)} controls preload="metadata" />
            <p>
              {job.output.partial ? "部分成片" : "成片"} · 实际{" "}
              {job.output.durationSeconds.toFixed(2)} 秒。实际时长随片段内容可能略有差异。
            </p>
          </section>
        ) : null}
        {job.continuity || editable ? (
          <label className="long-video-process__continuity">
            全片连续性约束
            <textarea
              readOnly={!editable}
              value={editable ? continuity : job.continuity}
              onChange={(event) => onDraftChange({ ...draft, continuity: event.target.value })}
            />
          </label>
        ) : null}
        {planText != null ? (
          <details open>
            <summary>规划模型原文</summary>
            <textarea aria-label="规划模型原文" readOnly value={planText} />
          </details>
        ) : null}
        <ol className="long-video-process__shots">
          {job.shots.map((shot, index) => (
            <Shot
              key={shot.id}
              shot={shot}
              index={index}
              editable={editable}
              draft={shots.find((item) => item.id === shot.id)?.prompt ?? shot.prompt}
              onChange={(prompt) =>
                onDraftChange({
                  ...draft,
                  shots: draft.shots.map((item) =>
                    item.id === shot.id ? { ...item, prompt } : item,
                  ),
                })
              }
            />
          ))}
        </ol>
        <details>
          <summary>过程记录 · {job.events.length} 条</summary>
          <ol className="long-video-process__events">
            {job.events.map((item, index) => (
              <li key={`${item.at}:${index}`}>
                <time>{formatTaskClock(item.at)}</time>
                <span>{item.message}</span>
              </li>
            ))}
          </ol>
        </details>
      </div>
    </div>,
    document.body,
  );
}

function Shot({
  shot,
  index,
  editable,
  draft,
  onChange,
}: {
  readonly shot: LongVideoShot;
  readonly index: number;
  readonly editable: boolean;
  readonly draft: string;
  readonly onChange: (value: string) => void;
}) {
  const status = shot.finalPath
    ? "已保存"
    : (LONG_VIDEO_SHOT_STATUS[shot.status as LongVideoShotStatus] ?? shot.status);
  return (
    <li>
      <header>
        <strong>
          {index + 1}. {shot.title}
        </strong>
        <span>
          {shot.durationSeconds}s · {status}
          {shot.progress != null && !shot.finalPath ? ` ${Math.round(shot.progress)}%` : ""}
        </span>
      </header>
      {shot.finalPath ? <video src={toMediaSrc(shot.finalPath)} controls preload="none" /> : null}
      <label>
        镜头 {index + 1} 提示词
        <textarea
          aria-label={`镜头 ${index + 1} 提示词`}
          readOnly={!editable}
          value={editable ? draft : shot.prompt}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      {shot.error ? (
        <ErrorAlert
          error={shot.error}
          hint="明确失败的片段可在下方「重试失败片段」里重做（会新建任务并占用额度）；回执不明、被中断或已取消的片段，查询原任务可能已无结果。"
        />
      ) : null}
    </li>
  );
}

export function LongVideoProcess({
  canvasId,
  nodeKey,
}: {
  readonly canvasId: string;
  readonly nodeKey: string;
}) {
  const jobs = useLongVideoJobs(canvasId);
  const client = useQueryClient();
  const instanceId = useId();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // 草稿按「任务 + 规划批次」存放：弹窗会随当前任务重新挂载，草稿放组件里就会在
  // 「历史创作过程」里翻看别的任务时丢失用户改过的提示词。
  const [drafts, setDrafts] = useState<Readonly<Record<string, LongVideoDraft>>>({});
  const nodeJobs = jobs.data?.filter((job) => job.sourceNodeId === nodeKey) ?? [];
  /*
   * 优先显示仍在跑的那条：被取消的旧任务可能因为它的在途片段后来落地而 updated_at 变高、
   * 排到了前面——那样节点上会显示「已结束」，而真正在按额度提交付费片段的那条
   * 被藏进「历史创作过程」下拉里，用户会以为没在跑。
   */
  const runningJob = nodeJobs.find(
    (item) => item.status !== "completed" && item.status !== "cancelled",
  );
  const job = nodeJobs.find((item) => item.id === selectedId) ?? runningJob ?? nodeJobs[0];
  // 草稿键带上规划批次：重新规划换了 plannerTaskId → 旧的编辑不再适用，自动回到服务端版本。
  const draftKey = job ? `${job.id}:${job.plannerTaskId}` : "";
  const draft: LongVideoDraft = job
    ? (drafts[draftKey] ?? {
        shots: job.shots.map(({ id, title, prompt }) => ({ id, title, prompt })),
        continuity: job.continuity,
      })
    : { shots: [], continuity: "" };
  // 只有「拥有者」实例渲染弹窗：卡片与编辑区两份实例不会同时开出两个弹窗。
  const open = useSyncExternalStore(
    subscribeDialog,
    () => dialogOwners.get(nodeKey) === instanceId,
    () => false,
  );
  const selectJob = (id: string | null) => setSelectedId(id);
  // 实例被卸载（节点删除、画布切换）时交还弹窗归属，否则这条记录会一直挂着。
  useEffect(
    () => () => {
      closeDialog(nodeKey, instanceId);
    },
    [nodeKey, instanceId],
  );
  // 任务没了（画布里删了节点 / 任务被清掉）也要交还归属：
  // 否则任务再出现时弹窗会自己弹回来，用户什么都没点。
  useEffect(() => {
    if (!job) closeDialog(nodeKey, instanceId);
  }, [job, nodeKey, instanceId]);
  if (!job) {
    // 读取失败时不能静默：否则「列表读不出来」看起来就像功能根本没启动。
    return jobs.error ? (
      <div className="long-video-status nodrag nopan">
        <ErrorAlert
          error={jobs.error}
          hint="重试读取只查询创作过程，不会重新提交生成。"
          action={
            <button
              type="button"
              onClick={() => {
                void jobs.refetch();
              }}
            >
              重试读取
            </button>
          }
        />
      </div>
    ) : null;
  }
  return (
    <div className="long-video-status nodrag nopan">
      <button type="button" onClick={() => openDialog(nodeKey, instanceId)}>
        {LONG_VIDEO_STATUS[job.status]} · {job.shots.filter((shot) => shot.finalPath).length}/
        {job.shots.length || "—"} · 查看创作过程
      </button>
      {open ? (
        <ProcessDialog
          key={job.id}
          job={job}
          draft={draft}
          onDraftChange={(next) => setDrafts((current) => ({ ...current, [draftKey]: next }))}
          history={nodeJobs}
          onSelectJob={selectJob}
          readError={jobs.error}
          onClose={() => closeDialog(nodeKey, instanceId)}
          onChange={() => client.invalidateQueries({ queryKey: ["long-video-jobs", canvasId] })}
        />
      ) : null}
    </div>
  );
}
