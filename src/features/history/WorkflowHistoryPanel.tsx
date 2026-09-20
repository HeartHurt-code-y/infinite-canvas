import { Icon } from "../../components/Icon";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { ImeTextarea } from "../../components/ImeTextField";
import { MarkdownView } from "../../components/MarkdownView";
import { formatRawBackendError, toMediaSrc } from "../../lib/backend";
import {
  workflowHistoryClient,
  type WorkflowHistoryClient,
  type WorkflowHistoryDetail,
  type WorkflowHistoryRecord,
} from "../../lib/workflowHistory";
import { aiFilmDeliveryMarkdown } from "../workspace/aiFilmWorkflowModel";
import { comicDramaDeliveryMarkdown } from "../workspace/comicDramaWorkflowModel";
import { commerceDeliveryMarkdown } from "../workspace/commerceWorkflowModel";
import { revealDesktopItem, saveMarkdownDocumentToDesktop } from "../workspace/desktopActions";
import { remotionDeliveryMarkdown } from "../workspace/remotionWorkflowModel";
import type {
  KnowledgeVideoWorkflowCheckpoint,
  KnowledgeVideoWorkflowPhase,
} from "../workspace/workspaceModel";
import { xhsCoverDeliveryMarkdown } from "../workspace/xhsCoverWorkflowModel";
import { reverseVideoDeliveryMarkdown } from "../workspace/reverseVideoWorkflowModel";
import "./WorkflowHistoryPanel.css";
import { HistoryDateRangeFilter } from "./HistoryDateRangeFilter";
import type { HistoryDateRange } from "./historyDateRange";

const PHASE_LABELS: Record<KnowledgeVideoWorkflowPhase, string> = {
  idle: "等待开始",
  planning: "策划中",
  generating: "生成中",
  qc: "质检中",
  composing: "合成中",
  awaiting_approval: "等待确认",
  done: "已完成",
  failed: "失败",
  paused: "已暂停",
};
const KIND_LABELS: Record<string, string> = {
  knowledge: "知识视频",
  film: "AI 影视",
  comicDrama: "漫剧自动",
  commerce: "剧情带货",
  remotion: "动画逻辑图",
  xhsCover: "小红书封面",
  reverseVideo: "短视频反推",
};
const ACTIVE_PHASES: readonly KnowledgeVideoWorkflowPhase[] = [
  "planning",
  "generating",
  "qc",
  "composing",
];
const FILTERS: readonly {
  id: string;
  label: string;
  statuses?: readonly KnowledgeVideoWorkflowPhase[];
}[] = [
  { id: "all", label: "全部" },
  { id: "running", label: "进行中", statuses: ACTIVE_PHASES },
  { id: "attention", label: "待处理", statuses: ["paused", "awaiting_approval"] },
  { id: "failed", label: "失败", statuses: ["failed"] },
  { id: "done", label: "已完成", statuses: ["done"] },
];
const EMPTY_ACTIVE_IDS: readonly string[] = [];

interface WorkflowHistoryPanelProps {
  readonly client?: WorkflowHistoryClient | undefined;
  readonly canvasId?: string | undefined;
  /** 跨画布浏览时的归属标注（返回 null 表示不标注，即当前画布范围）。 */
  readonly canvasLabel?: ((canvasId: string) => string | null) | undefined;
  readonly initialWorkflowId?: string | null | undefined;
  readonly activeWorkflowIds?: readonly string[] | undefined;
  readonly onResumeWorkflow?: (
    record: WorkflowHistoryRecord,
    decisionResolution?: string,
  ) => Promise<void> | void;
  readonly onRestartWorkflow?: (record: WorkflowHistoryRecord) => Promise<void> | void;
  readonly onLocateWorkflow?: (record: WorkflowHistoryRecord) => void;
  readonly onSelectGenerationTask: (taskId: string) => void;
}

function dateTime(timestamp: number) {
  return new Date(timestamp).toLocaleString();
}

function readableError(error: unknown) {
  return error instanceof Error ? error.message : formatRawBackendError(error);
}

function DeferredSection({
  title,
  children,
}: {
  readonly title: string;
  readonly children: () => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="history-payload workflow-history__disclosure"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{title}</summary>
      {open ? <div className="workflow-history__disclosure-content">{children()}</div> : null}
    </details>
  );
}

function deliveryMarkdown(checkpoint: KnowledgeVideoWorkflowCheckpoint): string {
  if (checkpoint.reverseVideo) return reverseVideoDeliveryMarkdown(checkpoint);
  if (checkpoint.xhsCover) return xhsCoverDeliveryMarkdown(checkpoint);
  if (checkpoint.remotion) return remotionDeliveryMarkdown(checkpoint);
  if (checkpoint.commerce) return commerceDeliveryMarkdown(checkpoint);
  if (checkpoint.comicDrama) return comicDramaDeliveryMarkdown(checkpoint);
  if (checkpoint.film) return aiFilmDeliveryMarkdown(checkpoint);
  return [
    checkpoint.script && `# 视频脚本\n\n${checkpoint.script}`,
    checkpoint.storyboard && `# 分镜\n\n${checkpoint.storyboard}`,
    checkpoint.manifest && `# 完整规划\n\n${checkpoint.manifest}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function retainedMedia(checkpoint: KnowledgeVideoWorkflowCheckpoint) {
  const media = new Map<string, { path: string; label: string; kind: "image" | "video" }>();
  const add = (path: string | null | undefined, label: string, kind: "image" | "video") => {
    if (path && !media.has(path)) media.set(path, { path, label, kind });
  };
  add(checkpoint.xhsCover?.finalPath ?? checkpoint.xhsCover?.imagePath, "封面图片", "image");
  add(
    checkpoint.finalPath,
    checkpoint.reverseVideo ? "原视频" : checkpoint.xhsCover ? "最终封面" : "最终成片",
    checkpoint.xhsCover ? "image" : "video",
  );
  add(checkpoint.coverImagePath, "封面", "image");
  add(checkpoint.reverseVideo?.videoPath, "下载原片", "video");
  for (const sheet of checkpoint.reverseVideo?.evidence?.sheets ?? [])
    add(sheet.localPath, sheet.displayName, "image");
  for (const frame of checkpoint.reverseVideo?.evidence?.representativeFrames ?? [])
    add(frame.localPath, frame.displayName, "image");
  add(checkpoint.remotion?.renderJob?.gifPath, "GIF 动画", "image");
  add(checkpoint.remotion?.renderJob?.videoPath, "MP4 动画", "video");
  add(checkpoint.remotion?.renderJob?.previewPath, "动画预览", "image");
  for (const [id, shot] of Object.entries(checkpoint.shotRuns)) {
    add(shot.clipPath, `镜头 ${id}`, "video");
    add(shot.referenceImagePath, `镜头 ${id} 参考图`, "image");
  }
  for (const asset of [
    ...(checkpoint.film?.assets ?? []),
    ...(checkpoint.comicDrama?.sharedAssets ?? []),
    ...(checkpoint.commerce?.sharedAssets ?? []),
  ])
    add(asset.path, asset.name, "image");
  return [...media.values()];
}

function WorkflowDetail({
  detail,
  active,
  onRefresh,
  onResumeWorkflow,
  onRestartWorkflow,
  onLocateWorkflow,
  onSelectGenerationTask,
}: Omit<
  WorkflowHistoryPanelProps,
  "client" | "canvasId" | "canvasLabel" | "initialWorkflowId" | "activeWorkflowIds"
> & {
  readonly detail: WorkflowHistoryDetail;
  readonly active: boolean;
  readonly onRefresh: () => void;
}) {
  const { record, events, tasks } = detail;
  const checkpoint = record.nodeSnapshot.config.checkpoint;
  const [resolution, setResolution] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState("");
  const busyRef = useRef(false);
  const running = active || ACTIVE_PHASES.includes(record.status);
  const resumable = ["failed", "paused", "awaiting_approval", "idle"].includes(record.status);
  const decision = checkpoint.decision;
  const requiresDecision = record.status === "awaiting_approval" && decision != null;
  const answer = resolution.trim() || (decision?.recommendation?.trim() ?? "");
  const media = retainedMedia(checkpoint);
  const reverseDelivery = checkpoint.reverseVideo?.delivery;

  async function runAction(
    action: () => Promise<void | boolean> | void | boolean,
    success: string,
    refresh = false,
  ) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setActionError(null);
    setActionMessage("");
    try {
      const result = await action();
      setActionMessage(result === false ? "" : success);
      if (refresh) onRefresh();
    } catch (error) {
      setActionError(readableError(error));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="history-detail__scroll workflow-history__detail">
      <section className="history-section">
        <h3>{record.title}</h3>
        <p className="workflow-history__message">{record.message || PHASE_LABELS[record.status]}</p>
        <progress aria-label="工作流进度" max={100} value={record.progress} />
        <dl className="history-facts">
          <div>
            <dt>工作流</dt>
            <dd>{KIND_LABELS[record.workflowKind] ?? record.workflowKind}</dd>
          </div>
          <div>
            <dt>状态</dt>
            <dd>
              {PHASE_LABELS[record.status]} · {Math.round(record.progress)}%
            </dd>
          </div>
          <div>
            <dt>创建时间</dt>
            <dd>{dateTime(record.createdAt)}</dd>
          </div>
          <div>
            <dt>更新时间</dt>
            <dd>{dateTime(record.updatedAt)}</dd>
          </div>
          <div>
            <dt>执行次数</dt>
            <dd>{record.attemptCount}</dd>
          </div>
          <div>
            <dt>历史 ID</dt>
            <dd className="history-mono">{record.id}</dd>
          </div>
        </dl>
        <div className="workflow-history__actions">
          {onLocateWorkflow ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void runAction(() => onLocateWorkflow(record), "已定位到工作流节点。")}
            >
              定位到画布
            </button>
          ) : null}
          <button type="button" disabled={busy} onClick={onRefresh}>
            刷新详情
          </button>
        </div>
      </section>
      {record.error ? (
        <section className="history-section history-section--error">
          <h3>失败原因</h3>
          <pre className="history-raw workflow-history__error">{record.error}</pre>
        </section>
      ) : null}
      {!running && requiresDecision ? (
        <section className="history-section workflow-history__decision">
          <h3>等待你的决定</h3>
          <p>{decision?.question ?? "请补充处理决定后继续当前步骤。"}</p>
          {decision?.recommendation ? <p>建议：{decision.recommendation}</p> : null}
          <label>
            你的决定（留空采用建议）
            <ImeTextarea
              aria-label="历史工作流决策"
              value={resolution}
              onValueChange={setResolution}
              disabled={busy}
              rows={3}
            />
          </label>
        </section>
      ) : null}
      {!running ? (
        <div className="workflow-history__actions">
          {resumable && onResumeWorkflow ? (
            <button
              type="button"
              className="workflow-history__primary"
              disabled={busy || (requiresDecision && !answer)}
              onClick={() =>
                void runAction(
                  () => onResumeWorkflow(record, requiresDecision ? answer : undefined),
                  "已请求从保存的步骤继续。",
                  true,
                )
              }
            >
              {busy
                ? "正在处理…"
                : record.status === "failed"
                  ? "重试当前步骤"
                  : requiresDecision
                    ? "确认后续跑"
                    : "从断点继续"}
            </button>
          ) : null}
          {onRestartWorkflow ? (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void runAction(
                  () => onRestartWorkflow(record),
                  "已恢复到画布，请检查并确认新的执行计划。",
                  true,
                )
              }
            >
              重新制作
            </button>
          ) : null}
        </div>
      ) : (
        <p className="history-empty-note">工作流正在执行，可刷新进度或定位到画布查看。</p>
      )}
      {actionError ? (
        <p role="alert" className="workflow-history__error">
          {actionError}
        </p>
      ) : null}
      {actionMessage ? <p role="status">{actionMessage}</p> : null}
      <section className="history-section">
        <h3>制作输入</h3>
        <p className="history-prompt-text">
          {record.nodeSnapshot.config.brief || "制作内容来自下方工作流配置。"}
        </p>
        <DeferredSection title="查看完整制作配置">
          {() => (
            <pre className="history-raw" tabIndex={0}>
              {JSON.stringify({ ...record.nodeSnapshot.config, checkpoint: undefined }, null, 2)}
            </pre>
          )}
        </DeferredSection>
      </section>
      <section className="history-section">
        <h3>项目模型</h3>
        <dl className="history-facts">
          {record.models.map((model) => (
            <div key={model.role}>
              <dt>
                {(
                  { text: "策划与审核", image: "图片生成", video: "视频生成" } as Record<
                    string,
                    string
                  >
                )[model.role] ?? model.role}
              </dt>
              <dd>
                {model.providerName || model.providerId} ·{" "}
                {model.modelName || model.modelDefinitionId}
              </dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="history-section">
        <h3>执行时间线</h3>
        {events.length ? (
          <ol className="workflow-history__timeline">
            {events.map((event) => (
              <li key={event.id}>
                <div>
                  <strong>{PHASE_LABELS[event.phase]}</strong>
                  <span>{Math.round(event.progress)}%</span>
                  <time>{dateTime(event.createdAt)}</time>
                </div>
                <p>{event.message}</p>
                {event.error ? <pre className="workflow-history__error">{event.error}</pre> : null}
              </li>
            ))}
          </ol>
        ) : (
          <p className="history-empty-note">暂无阶段记录。</p>
        )}
      </section>
      <section className="history-section">
        <h3>产物与文档</h3>
        {reverseDelivery ? (
          <DeferredSection title="查看已入库案例与交付文件">
            {() => (
              <>
                <p>
                  案例 {reverseDelivery.caseId} · 入库时共 {reverseDelivery.caseCount} 条案例
                </p>
                <div className="workflow-history__actions">
                  {[
                    ["交付目录", reverseDelivery.directory],
                    ["原视频", reverseDelivery.videoPath],
                    ["反推文档 MD", reverseDelivery.markdownPath],
                    ["纯文本提示词 TXT", reverseDelivery.textPath],
                    ["案例档案", reverseDelivery.casePath],
                  ].map(([label, path]) => (
                    <button
                      key={label}
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void runAction(() => revealDesktopItem(path!), "已打开文件所在位置。")
                      }
                    >
                      打开{label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </DeferredSection>
        ) : null}
        <DeferredSection title={`已保留媒体（${media.length}）`}>
          {() =>
            media.length ? (
              <div className="workflow-history__media">
                {media.map((item) => (
                  <figure key={item.path}>
                    {item.kind === "video" ? (
                      <video
                        aria-label={item.label}
                        controls
                        preload="metadata"
                        src={toMediaSrc(item.path)}
                      />
                    ) : (
                      <img src={toMediaSrc(item.path)} alt={item.label} loading="lazy" />
                    )}
                    <figcaption>{item.label}</figcaption>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void runAction(() => revealDesktopItem(item.path), "已打开文件所在位置。")
                      }
                    >
                      打开{item.label}文件
                    </button>
                  </figure>
                ))}
              </div>
            ) : (
              <p className="history-empty-note">尚未生成媒体文件。</p>
            )
          }
        </DeferredSection>
        <DeferredSection title="查看制作文档">
          {() => {
            const markdown = deliveryMarkdown(checkpoint);
            return markdown ? (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void runAction(async () => {
                      const path = await saveMarkdownDocumentToDesktop(
                        markdown,
                        `工作流-${record.id}.md`,
                        "工作流制作文档",
                      );
                      return Boolean(path);
                    }, "已完成导出操作。")
                  }
                >
                  导出制作文档
                </button>
                <MarkdownView content={markdown} />
              </>
            ) : (
              <p className="history-empty-note">尚未生成制作文档。</p>
            );
          }}
        </DeferredSection>
        <DeferredSection title="查看完整断点与历史版本">
          {() => (
            <pre className="history-raw" tabIndex={0}>
              {JSON.stringify(checkpoint, null, 2)}
            </pre>
          )}
        </DeferredSection>
      </section>
      <section className="history-section">
        <h3>关联生成任务</h3>
        {tasks.length ? (
          <ul className="workflow-history__tasks">
            {tasks.map((task) => (
              <li key={task.id}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void runAction(() => onSelectGenerationTask(task.id), "")}
                >
                  {task.operation === "text_generation"
                    ? "文本"
                    : task.operation === "video_generation"
                      ? "视频"
                      : "图片"}{" "}
                  · {task.remoteModelIdSnapshot ?? task.modelDefinitionId}
                  <span>{task.id}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="history-empty-note">暂无关联生成任务。</p>
        )}
      </section>
    </div>
  );
}

export function WorkflowHistoryPanel({
  client = workflowHistoryClient,
  canvasId,
  canvasLabel,
  initialWorkflowId = null,
  activeWorkflowIds = EMPTY_ACTIVE_IDS,
  ...actions
}: WorkflowHistoryPanelProps) {
  const [filterId, setFilterId] = useState("all");
  const [dateRange, setDateRange] = useState<HistoryDateRange>({});
  const [items, setItems] = useState<readonly WorkflowHistoryRecord[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState(initialWorkflowId);
  const [detail, setDetail] = useState<WorkflowHistoryDetail | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [moreLoading, setMoreLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const listRequestRef = useRef(0);
  const detailRequestRef = useRef(0);
  const moreLoadingRef = useRef(false);
  const filter = FILTERS.find((candidate) => candidate.id === filterId)!;
  const resetList = () => {
    ++listRequestRef.current;
    moreLoadingRef.current = false;
    setMoreLoading(false);
    setCursor(null);
    setItems([]);
    setSelectedId(null);
    setDetail(null);
    setDetailError(null);
    setListError(null);
    setLoaded(false);
  };
  const refresh = () => {
    setLoaded(false);
    setListError(null);
    setDetailError(null);
    setRevision((value) => value + 1);
  };

  useEffect(() => {
    const request = ++listRequestRef.current;
    let cancelled = false;
    void client
      .list({
        ...dateRange,
        ...(canvasId ? { canvasId } : {}),
        ...(filter.statuses ? { statuses: filter.statuses } : {}),
        limit: 30,
      })
      .then((page) => {
        if (cancelled || request !== listRequestRef.current) return;
        setItems(page.items);
        setCursor(page.nextCursor);
        setListError(null);
        setLoaded(true);
        setSelectedId((current) => current ?? page.items[0]?.id ?? null);
      })
      .catch((error) => {
        if (cancelled || request !== listRequestRef.current) return;
        setListError(readableError(error));
        setItems([]);
        setCursor(null);
        setLoaded(true);
      });
    return () => {
      cancelled = true;
      // 本实例的作废已由 cancelled 覆盖；listRequestRef 由 loadMore 与下次请求递增，
      // 避免在 effect 清理阶段读写 ref（react-hooks/exhaustive-deps）。
    };
  }, [client, canvasId, filter, revision, dateRange]);

  useEffect(() => {
    if (!selectedId) return;
    const request = ++detailRequestRef.current;
    let cancelled = false;
    void client
      .get(selectedId)
      .then((next) => {
        if (cancelled || request !== detailRequestRef.current) return;
        setDetail(next);
        setDetailError(null);
      })
      .catch((error) => {
        if (cancelled || request !== detailRequestRef.current) return;
        setDetailError(readableError(error));
      });
    return () => {
      cancelled = true;
    };
  }, [client, selectedId, revision]);

  async function loadMore() {
    if (!loaded || !cursor || moreLoadingRef.current) return;
    const request = ++listRequestRef.current;
    moreLoadingRef.current = true;
    setMoreLoading(true);
    try {
      const page = await client.list({
        ...dateRange,
        ...(canvasId ? { canvasId } : {}),
        ...(filter.statuses ? { statuses: filter.statuses } : {}),
        cursor,
        limit: 30,
      });
      if (request !== listRequestRef.current) return;
      setItems((current) => [
        ...new Map([...current, ...page.items].map((item) => [item.id, item])).values(),
      ]);
      setCursor(page.nextCursor);
      setListError(null);
    } catch (error) {
      if (request === listRequestRef.current) setListError(readableError(error));
    } finally {
      if (request === listRequestRef.current) {
        moreLoadingRef.current = false;
        setMoreLoading(false);
      }
    }
  }

  return (
    <div
      className="history-dialog__body workflow-history"
      role="tabpanel"
      id="workflow-history-panel"
      aria-labelledby="workflow-history-tab"
    >
      <aside className="history-list" aria-label="工作流历史列表">
        <div className="history-list__toolbar">
          <div className="history-filters workflow-history__filters">
            {FILTERS.map((candidate) => (
              <button
                type="button"
                key={candidate.id}
                aria-pressed={candidate.id === filterId}
                className={`history-filter${candidate.id === filterId ? " is-active" : ""}`}
                onClick={() => {
                  if (candidate.id === filterId) return;
                  resetList();
                  setFilterId(candidate.id);
                }}
              >
                {candidate.label}
              </button>
            ))}
            <button
              type="button"
              className="history-filter workflow-history__refresh"
              aria-label="刷新工作流历史"
              disabled={!loaded}
              onClick={refresh}
            >
              <Icon name="arrow-clockwise" aria-hidden="true" size="md" />
            </button>
          </div>
          <HistoryDateRangeFilter
            onApply={(range) => {
              resetList();
              setDateRange(range);
            }}
          />
        </div>
        <div className="history-list__scroll">
          {listError ? (
            <p className="history-list__error" role="alert">
              {listError}
            </p>
          ) : null}
          {!loaded ? (
            <p className="history-list__empty">正在加载工作流历史…</p>
          ) : items.length === 0 && !listError ? (
            <p className="history-list__empty">没有符合条件的工作流。</p>
          ) : null}
          <ul className="history-items">
            {items.map((item) => {
              const canvasName = canvasLabel?.(item.canvasId) ?? null;
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    className={`history-item${item.id === selectedId ? " is-selected" : ""}`}
                    aria-current={item.id === selectedId ? "true" : undefined}
                    onClick={() => {
                      setSelectedId(item.id);
                      setDetailError(null);
                    }}
                  >
                    <span className="history-item__top">
                      <span
                        className={`history-item__status history-item__status--${item.status === "done" ? "succeeded" : item.status === "failed" ? "failed" : "running"}`}
                      >
                        {PHASE_LABELS[item.status]}
                      </span>
                      <span className="history-item__tokens">{Math.round(item.progress)}%</span>
                    </span>
                    <span className="history-item__title">{item.title}</span>
                    <span className="history-item__meta">
                      {canvasName != null ? (
                        <span className="history-item__canvas" title={`画布：${canvasName}`}>
                          {canvasName}
                        </span>
                      ) : null}
                      {KIND_LABELS[item.workflowKind]} · {dateTime(item.updatedAt)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {cursor ? (
            <button
              type="button"
              className="history-list__more"
              disabled={moreLoading || !loaded}
              onClick={() => void loadMore()}
            >
              {moreLoading ? "加载中…" : "加载更多工作流"}
            </button>
          ) : null}
        </div>
      </aside>
      <div className="history-detail" aria-label="工作流详情">
        {detailError ? (
          <p role="alert" className="history-detail__error">
            {detailError}
            <button type="button" onClick={refresh}>
              重试读取详情
            </button>
          </p>
        ) : selectedId && detail?.record.id === selectedId ? (
          <WorkflowDetail
            key={detail.record.id}
            detail={detail}
            active={activeWorkflowIds.includes(detail.record.id)}
            onRefresh={refresh}
            {...actions}
          />
        ) : (
          <p className="history-detail__placeholder">
            {selectedId ? "正在读取工作流详情…" : "在左侧选择一个工作流查看详情。"}
          </p>
        )}
      </div>
    </div>
  );
}
