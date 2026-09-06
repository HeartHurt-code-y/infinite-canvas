import { CaretLeft } from "@phosphor-icons/react/CaretLeft";
import { CaretRight } from "@phosphor-icons/react/CaretRight";
import { CheckCircle } from "@phosphor-icons/react/CheckCircle";
import { CircleNotch } from "@phosphor-icons/react/CircleNotch";
import { Clock } from "@phosphor-icons/react/Clock";
import { FolderOpen } from "@phosphor-icons/react/FolderOpen";
import { MagnifyingGlass } from "@phosphor-icons/react/MagnifyingGlass";
import { WarningCircle } from "@phosphor-icons/react/WarningCircle";
import { X } from "@phosphor-icons/react/X";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  formatBytes,
  formatRawBackendError,
  generationClient,
  isDesktopRuntime,
  toMediaSrc,
  type GenerationResultRecord,
  type GenerationTaskClient,
  type GenerationTaskDetail,
  type GenerationTaskStatus,
  type GenerationTaskSummary,
  type PromptSegment,
} from "../../lib/backend";
import { textResultFromSource } from "../workspace/workspaceModel";
import type { WorkflowHistoryClient, WorkflowHistoryRecord } from "../../lib/workflowHistory";
import { WorkflowHistoryPanel } from "./WorkflowHistoryPanel";
import { RemoteVideoHistoryPanel } from "./RemoteVideoHistoryPanel";
import { HistoryDateRangeFilter } from "./HistoryDateRangeFilter";
import type { HistoryDateRange } from "./historyDateRange";

async function revealDesktopItem(path: string): Promise<void> {
  const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
  await revealItemInDir(path);
}

/** 历史记录列表的状态筛选。 */
type HistoryStatusFilter = "all" | "running" | "succeeded" | "failed";

const HISTORY_FILTERS: readonly {
  readonly id: HistoryStatusFilter;
  readonly label: string;
}[] = [
  { id: "all", label: "全部" },
  { id: "running", label: "进行中" },
  { id: "succeeded", label: "已成功" },
  { id: "failed", label: "失败" },
];

const HISTORY_PAGE_SIZE = 30;

const OPERATION_LABELS: Record<string, string> = {
  text_to_image: "文生图",
  image_to_image: "图片参考生成",
  video_generation: "视频生成",
  text_generation: "文本生成",
};

const TASK_STATUS_LABELS: Record<string, string> = {
  created: "已创建",
  submitting: "提交中",
  retry_wait: "重试等待",
  queued: "排队中",
  running: "生成中",
  succeeded: "已成功",
  failed: "失败",
  unknown: "结果未知",
  interrupted: "已中断",
};

const SAVE_STATUS_LABELS: Record<string, string> = {
  pending: "等待保存",
  writing: "正在写入",
  succeeded: "已保存到本机",
  failed: "保存失败",
  interrupted: "保存已中断",
  local_missing: "本地文件缺失",
  conflict: "文件冲突",
};

const ATTEMPT_PHASE_LABELS: Record<string, string> = {
  resolve: "素材解析",
  submit: "提交",
  observe: "状态查询",
  text_generation: "文本生成",
};

const ATTEMPT_OUTCOME_LABELS: Record<string, string> = {
  succeeded: "成功",
  failed: "失败",
  interrupted: "已中断",
};

const ERROR_KIND_LABELS: Record<string, string> = {
  validation: "输入校验",
  database: "数据库",
  credential: "访问凭据",
  transport: "网络传输",
  io: "文件读写",
  json: "数据解析",
  url: "请求地址",
  desktop: "桌面运行时",
  protocol: "供应商协议",
  not_found: "资源未找到",
  conflict: "状态冲突",
  http: "HTTP 请求",
};

/** 后端 GenerationAttemptRecord 的前端镜像（backend.ts 中以 unknown 透传）。 */
interface HistoryAttemptRecord {
  readonly id: string;
  readonly attemptNumber: number;
  readonly phase: string;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
  readonly backoffMs: number | null;
  readonly outcome: string;
  readonly error: unknown;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/**
 * 供应商常把 JSON 响应体再次塞进错误对象的字符串字段中。展示前把这类字符串
 * 恢复成结构化对象，避免界面里充满转义引号与 `\\n`。
 */
function normalizeEmbeddedJson(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (depth > 10) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        return normalizeEmbeddedJson(JSON.parse(trimmed), depth + 1, seen);
      } catch {
        return value;
      }
    }
    return value;
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  if (value == null || typeof value !== "object") return value;
  if (seen.has(value)) return "[循环引用]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => normalizeEmbeddedJson(item, depth + 1, seen));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, normalizeEmbeddedJson(item, depth + 1, seen)]),
  );
}

function formatHistoryPayload(value: unknown, emptyText = "（无内容）"): string {
  if (value == null || value === "") return emptyText;
  const normalized = normalizeEmbeddedJson(value);
  if (typeof normalized === "string") return normalized;
  try {
    return JSON.stringify(normalized, null, 2) ?? String(normalized);
  } catch {
    return formatRawBackendError(value);
  }
}

function findDiagnosticMessage(value: unknown, depth = 0): string | null {
  if (depth > 5 || value == null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (!isUnknownRecord(value)) return null;

  for (const key of ["message", "msg", "error_description", "reason", "source"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  for (const key of ["error", "details", "detail", "response", "body", "rawResponse"]) {
    const candidate = findDiagnosticMessage(value[key], depth + 1);
    if (candidate) return candidate;
  }
  return null;
}

function diagnosticKind(value: unknown): string | null {
  if (!isUnknownRecord(value)) return null;
  for (const key of ["kind", "code", "type"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

function payloadFormat(value: unknown): string {
  if (value == null || value === "") return "EMPTY";
  const normalized = normalizeEmbeddedJson(value);
  return normalized != null && typeof normalized === "object" ? "JSON" : "TEXT";
}

function providerCallFailed(call: GenerationTaskDetail["calls"][number]): boolean {
  return call.runtimeError != null || (call.httpStatus != null && call.httpStatus >= 400);
}

function providerCallStatus(call: GenerationTaskDetail["calls"][number]): string {
  if (call.runtimeError != null) return "调用异常";
  if (call.httpStatus == null) return "未收到状态";
  return `HTTP ${call.httpStatus}`;
}

/** 先展示人能读懂的失败原因，完整错误记录按需展开，兼顾扫描效率与排障信息完整性。 */
function HistoryDiagnostic({ label, value }: { readonly label: string; readonly value: unknown }) {
  const normalized = normalizeEmbeddedJson(value);
  const message =
    findDiagnosticMessage(normalized) ?? "没有可用的错误摘要，请展开查看完整技术详情。";
  const kind = diagnosticKind(normalized);
  return (
    <div className="history-diagnostic" role="group" aria-label={label}>
      <div className="history-diagnostic__summary">
        <WarningCircle size={18} weight="fill" aria-hidden="true" />
        <div>
          <span className="history-diagnostic__label">
            {label}
            {kind ? ` · ${ERROR_KIND_LABELS[kind] ?? kind}` : ""}
          </span>
          <p>{message}</p>
        </div>
      </div>
      <details className="history-diagnostic__details">
        <summary>
          <CaretRight
            size={14}
            weight="bold"
            className="history-disclosure__caret"
            aria-hidden="true"
          />
          完整技术详情
        </summary>
        <pre className="history-raw" tabIndex={0}>
          {formatHistoryPayload(normalized)}
        </pre>
      </details>
    </div>
  );
}

function HistoryPayload({
  label,
  value,
  emptyText,
  open = false,
}: {
  readonly label: string;
  readonly value: unknown;
  readonly emptyText?: string;
  readonly open?: boolean;
}) {
  return (
    <details className="history-payload" open={open}>
      <summary>
        <CaretRight
          size={14}
          weight="bold"
          className="history-disclosure__caret"
          aria-hidden="true"
        />
        <span>{label}</span>
        <span className="history-payload__format">{payloadFormat(value)}</span>
      </summary>
      <pre className="history-raw" tabIndex={0}>
        {formatHistoryPayload(value, emptyText)}
      </pre>
    </details>
  );
}

function formatDateTime(timestamp: number | null): string {
  if (timestamp == null) return "--";
  return new Date(timestamp).toLocaleString([], {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatDuration(fromMs: number | null, toMs: number | null): string | null {
  if (fromMs == null || toMs == null || toMs < fromMs) return null;
  const seconds = Math.round((toMs - fromMs) / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${minutes} 分 ${rest} 秒`;
  return `${Math.floor(minutes / 60)} 时 ${minutes % 60} 分 ${rest} 秒`;
}

function formatTokens(value: number | null): string {
  return value == null ? "--" : value.toLocaleString();
}

function statusFilterToStatuses(filter: HistoryStatusFilter): GenerationTaskStatus[] | null {
  if (filter === "all") return null;
  if (filter === "running") return ["created", "submitting", "retry_wait", "queued", "running"];
  if (filter === "succeeded") return ["succeeded"];
  return ["failed", "unknown", "interrupted"];
}

/** 从任务的逻辑请求（StartGenerationCommand）中提取提示词段。 */
function promptSegmentsFromDetail(detail: GenerationTaskDetail): PromptSegment[] {
  const request = detail.logicalRequest as { prompt?: unknown; userPrompt?: unknown } | null;
  if (detail.summary.operation === "text_generation" && typeof request?.userPrompt === "string") {
    return [{ kind: "text", text: request.userPrompt }];
  }
  if (request == null || !Array.isArray(request.prompt)) return [];
  return request.prompt as PromptSegment[];
}

/** 渲染提示词段：文本原样，@引用显示为只读 chip。 */
function HistoryPromptSegments({ segments }: { readonly segments: readonly PromptSegment[] }) {
  if (segments.length === 0) {
    return <p className="history-empty-note">该任务没有记录提示词。</p>;
  }
  return (
    <p className="history-prompt-text">
      {segments.map((segment, index) =>
        segment.kind === "text" ? (
          <span key={index}>{segment.text}</span>
        ) : (
          <span key={index} className="history-prompt-chip" title={segment.displayNameSnapshot}>
            @{segment.displayNameSnapshot}
          </span>
        ),
      )}
    </p>
  );
}

/** 全屏媒体浏览：图片完整展示、视频带播放控件，可在任务的多个结果间切换。 */
function HistoryLightbox({
  results,
  index,
  onIndexChange,
  onClose,
}: {
  readonly results: readonly GenerationResultRecord[];
  readonly index: number;
  readonly onIndexChange: (index: number) => void;
  readonly onClose: () => void;
}) {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const result = results[index];

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

  if (result == null) return null;
  const hasPrev = index > 0;
  const hasNext = index < results.length - 1;
  return (
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
        {hasPrev ? (
          <button
            type="button"
            className="history-lightbox__nav history-lightbox__nav--prev"
            aria-label="上一个结果"
            onClick={() => onIndexChange(index - 1)}
          >
            <CaretLeft size={22} weight="bold" aria-hidden="true" />
          </button>
        ) : null}
        {result.mediaType === "text" ? (
          <pre
            key={result.finalPath ?? result.resultIndex}
            className="history-lightbox__text"
            tabIndex={0}
            aria-label={`任务结果 ${index + 1} 的扩写文本`}
          >
            {textResultFromSource(result.source) ?? "（扩写文本未内联）"}
          </pre>
        ) : result.mediaType === "video" ? (
          <video
            key={result.finalPath ?? result.resultIndex}
            className="history-lightbox__media"
            src={result.finalPath ? toMediaSrc(result.finalPath) : undefined}
            controls
            autoPlay
            playsInline
          />
        ) : (
          <img
            key={result.finalPath ?? result.resultIndex}
            className="history-lightbox__media"
            src={result.finalPath ? toMediaSrc(result.finalPath) : undefined}
            alt={`任务结果 ${index + 1}`}
            role="button"
            tabIndex={0}
            aria-label={`任务结果 ${index + 1}，关闭媒体预览`}
            draggable={false}
            onClick={onClose}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              onClose();
            }}
          />
        )}
        {hasNext ? (
          <button
            type="button"
            className="history-lightbox__nav history-lightbox__nav--next"
            aria-label="下一个结果"
            onClick={() => onIndexChange(index + 1)}
          >
            <CaretRight size={22} weight="bold" aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

type HistoryTab = "generation" | "workflow" | "remoteVideo";

const HISTORY_TABS: readonly { readonly id: HistoryTab; readonly label: string }[] = [
  { id: "generation", label: "生成任务" },
  { id: "workflow", label: "工作流" },
  { id: "remoteVideo", label: "远程视频" },
];

export function HistoryDialog({
  open,
  onClose,
  client = generationClient,
  workflowClient,
  canvasId,
  initialTab = "generation",
  initialWorkflowId,
  onResumeWorkflow,
  onRestartWorkflow,
  onLocateWorkflow,
  activeWorkflowIds,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly client?: GenerationTaskClient;
  readonly workflowClient?: WorkflowHistoryClient;
  readonly canvasId?: string;
  readonly initialTab?: HistoryTab;
  readonly initialWorkflowId?: string | null;
  readonly onResumeWorkflow?: (
    record: WorkflowHistoryRecord,
    decisionResolution?: string,
  ) => Promise<void> | void;
  readonly onRestartWorkflow?: (record: WorkflowHistoryRecord) => Promise<void> | void;
  readonly onLocateWorkflow?: (record: WorkflowHistoryRecord) => void;
  readonly activeWorkflowIds?: readonly string[];
}) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const [activeTab, setActiveTab] = useState<HistoryTab>(initialTab ?? "generation");
  const [workflowVisited, setWorkflowVisited] = useState(initialTab === "workflow");
  const [remoteVideoVisited, setRemoteVideoVisited] = useState(initialTab === "remoteVideo");
  const linkedTaskIdRef = useRef<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<HistoryStatusFilter>("all");
  const [dateRange, setDateRange] = useState<HistoryDateRange>({});
  const [tasks, setTasks] = useState<readonly GenerationTaskSummary[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  // 首页是否已请求完成（含失败）：区分「加载中」与「确实没有任务」。
  const [listLoaded, setListLoaded] = useState(false);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [detail, setDetail] = useState<GenerationTaskDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const listRequestRef = useRef(0);
  const detailRequestRef = useRef(0);

  // 打开对话框时加载第一页；筛选切换时重新加载（旧列表保留到新页返回，避免闪烁）。
  useEffect(() => {
    if (!open || activeTab !== "generation") return;
    const requestId = ++listRequestRef.current;
    let cancelled = false;
    void client
      .list({
        ...dateRange,
        statuses: statusFilterToStatuses(statusFilter),
        limit: HISTORY_PAGE_SIZE,
      })
      .then((page) => {
        if (cancelled || requestId !== listRequestRef.current) return;
        setTasks(page.items);
        setCursor(page.nextCursorCreatedBefore);
        setListError(null);
        setListLoaded(true);
        // 默认选中第一项，打开即可看详情。
        const first = page.items[0];
        setSelectedTaskId(linkedTaskIdRef.current ?? first?.id ?? null);
      })
      .catch((error: unknown) => {
        if (cancelled || requestId !== listRequestRef.current) return;
        setTasks([]);
        setCursor(null);
        if (!linkedTaskIdRef.current) setSelectedTaskId(null);
        setListError(formatRawBackendError(error));
        setListLoaded(true);
      });
    return () => {
      cancelled = true;
      // 本实例的作废已由 cancelled 覆盖；listRequestRef 由 resetList 与下次请求递增，
      // 避免在 effect 清理阶段读写 ref（react-hooks/exhaustive-deps）。
    };
  }, [open, activeTab, statusFilter, dateRange, client]);

  const resetList = () => {
    ++listRequestRef.current;
    linkedTaskIdRef.current = null;
    setTasks([]);
    setCursor(null);
    setListLoaded(false);
    setListLoading(false);
    setListError(null);
    setSelectedTaskId(null);
    setDetail(null);
    setDetailError(null);
    setLightboxIndex(null);
  };

  // 关闭时清空详情与浏览状态，避免下次打开闪现上一次的内容。
  // 清理放在关闭事件（而非 effect）中执行：setState 必须由事件驱动。
  const handleClose = useCallback(() => {
    setDetail(null);
    setDetailError(null);
    setLightboxIndex(null);
    onClose();
  }, [onClose]);
  const handleLightboxClose = useCallback(() => {
    setLightboxIndex(null);
  }, []);

  const loadMore = useCallback(async () => {
    if (cursor == null || listLoading || !listLoaded) return;
    const requestId = ++listRequestRef.current;
    setListLoading(true);
    try {
      const page = await client.list({
        ...dateRange,
        statuses: statusFilterToStatuses(statusFilter),
        cursorCreatedBefore: cursor,
        limit: HISTORY_PAGE_SIZE,
      });
      if (requestId !== listRequestRef.current) return;
      setTasks((current) => [...current, ...page.items]);
      setCursor(page.nextCursorCreatedBefore);
    } catch (error: unknown) {
      if (requestId !== listRequestRef.current) return;
      setListError(formatRawBackendError(error));
    } finally {
      if (requestId === listRequestRef.current) setListLoading(false);
    }
  }, [client, cursor, listLoading, listLoaded, statusFilter, dateRange]);

  // 选中任务后加载完整详情（含尝试、供应商调用、结果与最终错误）。
  // 请求期间保留旧详情（标准主从布局），响应到达后整体替换。
  useEffect(() => {
    if (!open || activeTab !== "generation" || selectedTaskId == null) return;
    const requestId = ++detailRequestRef.current;
    let cancelled = false;
    void client
      .get(selectedTaskId)
      .then((record) => {
        if (cancelled || requestId !== detailRequestRef.current) return;
        setDetail(record);
        setDetailError(null);
      })
      .catch((error: unknown) => {
        if (cancelled || requestId !== detailRequestRef.current) return;
        setDetail(null);
        setDetailError(formatRawBackendError(error));
      });
    return () => {
      cancelled = true;
    };
  }, [open, activeTab, client, selectedTaskId]);

  const selectHistoryTab = (tab: HistoryTab) => {
    setActiveTab(tab);
    setLightboxIndex(null);
    if (tab === "workflow") setWorkflowVisited(true);
    if (tab === "remoteVideo") setRemoteVideoVisited(true);
  };

  const selectLinkedGenerationTask = (taskId: string) => {
    linkedTaskIdRef.current = taskId;
    setDetail(null);
    setDetailError(null);
    setSelectedTaskId(taskId);
    selectHistoryTab("generation");
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    // lightbox 打开时优先关闭 lightbox，其次关闭整个对话框。
    if (lightboxIndex != null) {
      setLightboxIndex(null);
      return;
    }
    handleClose();
  };

  const summary = detail?.summary ?? null;
  const promptSegments = useMemo(() => (detail ? promptSegmentsFromDetail(detail) : []), [detail]);
  const resultErrorsExist = detail?.results.some((result) => result.error != null) === true;
  const attempts = useMemo(
    () => (detail ? (detail.attempts as readonly HistoryAttemptRecord[]) : []),
    [detail],
  );
  const viewableResults = useMemo(
    () =>
      detail
        ? detail.results.filter(
            (result) => result.finalPath != null && result.saveStatus === "succeeded",
          )
        : [],
    [detail],
  );

  if (!open) return null;

  return (
    <div className="history-layer">
      <button
        type="button"
        className="history-backdrop"
        aria-label="关闭历史记录"
        onClick={handleClose}
      />
      <section
        ref={dialogRef}
        id="generation-history-dialog"
        className="history-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="generation-history-title"
        onKeyDown={handleKeyDown}
      >
        <header className="history-dialog__header">
          <span className="history-dialog__eyebrow">
            <Clock size={14} weight="bold" aria-hidden="true" />
            历史记录
          </span>
          <h2 id="generation-history-title">
            {activeTab === "workflow"
              ? "工作流历史"
              : activeTab === "remoteVideo"
                ? "远程任务历史"
                : "生成任务历史"}
          </h2>
          <p>
            {activeTab === "workflow"
              ? "查看每次工作流的输入、执行过程、交付物，从保存的步骤重试或继续。"
              : activeTab === "remoteVideo"
                ? "查询视频任务历史，并为应用异常关闭导致的任务续约远程查询。"
                : "所有媒体与文本生成任务的调用、token 用量、完整产物与报错。"}
          </p>
          <div className="history-tabs" role="tablist" aria-label="历史记录类型">
            {HISTORY_TABS.map((tab) => (
              <button
                type="button"
                role="tab"
                key={tab.id}
                id={`${tab.id}-history-tab`}
                aria-controls={`${tab.id}-history-panel`}
                aria-selected={activeTab === tab.id}
                tabIndex={activeTab === tab.id ? 0 : -1}
                className={`history-tab${activeTab === tab.id ? " is-active" : ""}`}
                onClick={() => selectHistoryTab(tab.id)}
                onKeyDown={(event) => {
                  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                  event.preventDefault();
                  const index = HISTORY_TABS.findIndex((entry) => entry.id === tab.id);
                  const nextIndex =
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? HISTORY_TABS.length - 1
                        : event.key === "ArrowLeft"
                          ? (index - 1 + HISTORY_TABS.length) % HISTORY_TABS.length
                          : (index + 1) % HISTORY_TABS.length;
                  const next = HISTORY_TABS[nextIndex]?.id ?? "generation";
                  selectHistoryTab(next);
                  document.getElementById(`${next}-history-tab`)?.focus();
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="history-dialog__close"
            aria-label="关闭历史记录"
            onClick={handleClose}
          >
            <X size={18} weight="bold" aria-hidden="true" />
          </button>
        </header>

        {workflowVisited && open ? (
          <div className="workflow-history__container" hidden={activeTab !== "workflow"}>
            <div id="workflow-history-panel" role="tabpanel" aria-labelledby="workflow-history-tab">
              <WorkflowHistoryPanel
                client={workflowClient}
                canvasId={canvasId}
                initialWorkflowId={initialWorkflowId}
                activeWorkflowIds={activeWorkflowIds}
                {...(onResumeWorkflow ? { onResumeWorkflow } : {})}
                {...(onRestartWorkflow ? { onRestartWorkflow } : {})}
                {...(onLocateWorkflow ? { onLocateWorkflow } : {})}
                onSelectGenerationTask={selectLinkedGenerationTask}
              />
            </div>
          </div>
        ) : null}
        {remoteVideoVisited && open ? (
          <div
            className="history-dialog__body history-dialog__body--single"
            id="remoteVideo-history-panel"
            role="tabpanel"
            aria-labelledby="remoteVideo-history-tab"
            hidden={activeTab !== "remoteVideo"}
          >
            <RemoteVideoHistoryPanel onSelectGenerationTask={selectLinkedGenerationTask} />
          </div>
        ) : null}
        <div
          className="history-dialog__body"
          hidden={activeTab !== "generation"}
          role="tabpanel"
          id="generation-history-panel"
          aria-labelledby="generation-history-tab"
        >
          <aside className="history-list" aria-label="任务列表">
            <div className="history-list__toolbar">
              <div className="history-filters" role="tablist" aria-label="状态筛选">
                {HISTORY_FILTERS.map((filter) => (
                  <button
                    key={filter.id}
                    type="button"
                    role="tab"
                    aria-selected={statusFilter === filter.id}
                    className={`history-filter${statusFilter === filter.id ? " is-active" : ""}`}
                    onClick={() => {
                      if (filter.id === statusFilter) return;
                      resetList();
                      setStatusFilter(filter.id);
                    }}
                  >
                    {filter.label}
                  </button>
                ))}
              </div>
              <HistoryDateRangeFilter
                onApply={(range) => {
                  resetList();
                  setDateRange(range);
                }}
              />
            </div>
            <div className="history-list__scroll">
              {listError ? <p className="history-list__error">{listError}</p> : null}
              {!listError && !listLoaded ? (
                <p className="history-list__empty">正在加载任务记录…</p>
              ) : null}
              {!listError && listLoaded && tasks.length === 0 ? (
                <p className="history-list__empty">没有符合条件的任务。</p>
              ) : null}
              <ul className="history-items">
                {tasks.map((task) => {
                  const operationTitle = OPERATION_LABELS[task.operation] ?? task.operation;
                  const modelTitle = task.remoteModelIdSnapshot ?? task.modelDefinitionId;
                  const listItemTitle = `${operationTitle} · ${modelTitle}（${TASK_STATUS_LABELS[task.status] ?? task.status}）`;
                  return (
                    <li key={task.id}>
                      <button
                        type="button"
                        className={`history-item${selectedTaskId === task.id ? " is-selected" : ""}`}
                        title={listItemTitle}
                        onClick={() => {
                          linkedTaskIdRef.current = null;
                          setSelectedTaskId(task.id);
                        }}
                        aria-current={selectedTaskId === task.id ? "true" : undefined}
                      >
                        <span className="history-item__top">
                          <span
                            className={`history-item__status history-item__status--${task.status}`}
                          >
                            {task.status === "succeeded" ? (
                              <CheckCircle size={14} weight="fill" aria-hidden="true" />
                            ) : task.status === "failed" ||
                              task.status === "unknown" ||
                              task.status === "interrupted" ? (
                              <WarningCircle size={14} weight="fill" aria-hidden="true" />
                            ) : (
                              <CircleNotch size={14} weight="bold" aria-hidden="true" />
                            )}
                            {TASK_STATUS_LABELS[task.status] ?? task.status}
                          </span>
                          {task.tokens?.totalTokens != null ? (
                            <span className="history-item__tokens">
                              {task.tokens.totalTokens.toLocaleString()} tokens
                            </span>
                          ) : null}
                        </span>
                        <span className="history-item__title">
                          {operationTitle} · {modelTitle}
                        </span>
                        <span className="history-item__meta">
                          {formatDateTime(task.createdAt)}
                          {task.completedAt != null && task.completedAt > task.createdAt
                            ? ` · 耗时 ${formatDuration(task.createdAt, task.completedAt) ?? "--"}`
                            : ""}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              {cursor != null ? (
                <button
                  type="button"
                  className="history-list__more"
                  disabled={listLoading}
                  onClick={() => {
                    void loadMore();
                  }}
                >
                  {listLoading ? "加载中…" : "加载更多"}
                </button>
              ) : null}
            </div>
          </aside>

          <div className="history-detail" aria-label="任务详情">
            {selectedTaskId == null ? (
              <p className="history-detail__placeholder">
                <MagnifyingGlass size={20} weight="bold" aria-hidden="true" />
                在左侧选择一个任务查看详情。
              </p>
            ) : detailError != null && detail == null ? (
              <p className="history-detail__error">{detailError}</p>
            ) : detail == null || summary == null ? (
              <p className="history-detail__placeholder">正在读取任务详情…</p>
            ) : (
              <div className="history-detail__scroll">
                <section className="history-section">
                  <h3>任务概要</h3>
                  <dl className="history-facts">
                    <div>
                      <dt>任务 ID</dt>
                      <dd className="history-mono">{summary.id}</dd>
                    </div>
                    <div>
                      <dt>状态</dt>
                      <dd>{TASK_STATUS_LABELS[summary.status] ?? summary.status}</dd>
                    </div>
                    <div>
                      <dt>操作类型</dt>
                      <dd>{OPERATION_LABELS[summary.operation] ?? summary.operation}</dd>
                    </div>
                    <div>
                      <dt>供应商</dt>
                      <dd>{summary.providerDisplayNameSnapshot}</dd>
                    </div>
                    <div>
                      <dt>模型</dt>
                      <dd>{summary.remoteModelIdSnapshot ?? summary.modelDefinitionId}</dd>
                    </div>
                    <div>
                      <dt>远程任务 ID</dt>
                      <dd className="history-mono">{summary.remoteTaskId ?? "--"}</dd>
                    </div>
                    <div>
                      <dt>创建时间</dt>
                      <dd>{formatDateTime(summary.createdAt)}</dd>
                    </div>
                    <div>
                      <dt>完成时间</dt>
                      <dd>{formatDateTime(summary.completedAt)}</dd>
                    </div>
                    <div>
                      <dt>耗时</dt>
                      <dd>{formatDuration(summary.createdAt, summary.completedAt) ?? "--"}</dd>
                    </div>
                  </dl>
                </section>

                <section className="history-section">
                  <h3>Token 用量</h3>
                  {summary.tokens == null ? (
                    <p className="history-empty-note">
                      该任务的供应商响应未携带 usage 字段（或响应未成功返回）。
                    </p>
                  ) : (
                    <dl className="history-facts history-facts--tokens">
                      <div>
                        <dt>Prompt tokens</dt>
                        <dd className="history-mono">
                          {formatTokens(summary.tokens.promptTokens)}
                        </dd>
                      </div>
                      <div>
                        <dt>Completion tokens</dt>
                        <dd className="history-mono">
                          {formatTokens(summary.tokens.completionTokens)}
                        </dd>
                      </div>
                      <div>
                        <dt>Total tokens</dt>
                        <dd className="history-mono">{formatTokens(summary.tokens.totalTokens)}</dd>
                      </div>
                    </dl>
                  )}
                </section>

                <section className="history-section">
                  <h3>提示词</h3>
                  <HistoryPromptSegments segments={promptSegments} />
                </section>

                {summary.operation === "text_generation" ? (
                  <section className="history-section">
                    <h3>文本产物</h3>
                    {detail.textOutput == null ? (
                      <p className="history-empty-note">
                        该文本任务没有可展示的产物，可能在模型返回前已经失败。
                      </p>
                    ) : (
                      <div className="history-call__payloads">
                        <HistoryPayload
                          label="节点采用的提示词"
                          value={detail.textOutput.optimizedPrompt}
                          open
                        />
                        <HistoryPayload
                          label="模型原始文本"
                          value={detail.textOutput.rawModelOutput}
                          open
                        />
                      </div>
                    )}
                  </section>
                ) : null}

                {summary.operation !== "text_generation" || detail.results.length > 0 ? (
                  <section
                    className={`history-section${resultErrorsExist ? " history-section--with-inline-error" : ""}`}
                  >
                    <h3>生成结果（{detail.results.length}）</h3>
                    {detail.results.length === 0 ? (
                      <p className="history-empty-note">该任务没有生成结果。</p>
                    ) : (
                      <div className="history-results">
                        {detail.results.map((result, index) => {
                          const isViewable =
                            result.finalPath != null && result.saveStatus === "succeeded";
                          return (
                            <article
                              key={`${result.resultIndex}-${result.finalPath ?? index}`}
                              className={`history-result${isViewable ? " history-result--viewable" : ""}`}
                            >
                              <button
                                type="button"
                                className="history-result__preview"
                                disabled={!isViewable}
                                onClick={() => {
                                  const viewIndex = viewableResults.indexOf(result);
                                  if (viewIndex >= 0) setLightboxIndex(viewIndex);
                                }}
                              >
                                <span className="history-result__visual">
                                  {isViewable && isDesktopRuntime() ? (
                                    result.mediaType === "video" ? (
                                      <video
                                        src={toMediaSrc(result.finalPath)}
                                        muted
                                        playsInline
                                        preload="metadata"
                                      />
                                    ) : (
                                      <img
                                        src={toMediaSrc(result.finalPath)}
                                        alt={`结果 ${result.resultIndex + 1}`}
                                        loading="lazy"
                                        draggable={false}
                                      />
                                    )
                                  ) : (
                                    <span className="history-result__missing">
                                      {SAVE_STATUS_LABELS[result.saveStatus] ?? result.saveStatus}
                                    </span>
                                  )}
                                </span>
                                <span className="history-result__facts">
                                  <span>
                                    结果 {result.resultIndex + 1} ·{" "}
                                    {result.mediaType === "text"
                                      ? "文本"
                                      : result.mediaType === "video"
                                        ? "视频"
                                        : "图片"}
                                    {formatBytes(result.byteSize)
                                      ? ` · ${formatBytes(result.byteSize)}`
                                      : ""}
                                  </span>
                                  <span>
                                    {SAVE_STATUS_LABELS[result.saveStatus] ?? result.saveStatus}
                                  </span>
                                </span>
                              </button>
                              {isViewable ? (
                                <button
                                  type="button"
                                  className="history-result__reveal"
                                  aria-label="在文件夹中显示该结果"
                                  title="在文件夹中显示"
                                  onClick={() => {
                                    void revealDesktopItem(result.finalPath!).catch(
                                      () => undefined,
                                    );
                                  }}
                                >
                                  <FolderOpen size={13} weight="bold" aria-hidden="true" />
                                </button>
                              ) : null}
                            </article>
                          );
                        })}
                      </div>
                    )}
                    {detail.results.some((result) => result.error != null) ? (
                      <div className="history-error-block">
                        <h4>结果保存错误</h4>
                        {detail.results
                          .filter((result) => result.error != null)
                          .map((result) => (
                            <HistoryDiagnostic
                              key={result.resultIndex}
                              label={`结果 ${result.resultIndex + 1} 保存失败`}
                              value={result.error}
                            />
                          ))}
                      </div>
                    ) : null}
                  </section>
                ) : null}

                {detail.finalError != null ? (
                  <section className="history-section history-section--error">
                    <h3>最终错误</h3>
                    <HistoryDiagnostic label="任务失败原因" value={detail.finalError} />
                  </section>
                ) : null}

                {attempts.length > 0 ? (
                  <section className="history-section">
                    <h3>执行过程（{attempts.length} 次尝试）</h3>
                    <ol className="history-attempts">
                      {attempts.map((attempt) => (
                        <li key={attempt.id} className={`history-attempt is-${attempt.outcome}`}>
                          <div className="history-attempt__head">
                            <span className="history-attempt__number">
                              #{attempt.attemptNumber}
                            </span>
                            <span className="history-attempt__phase">
                              {ATTEMPT_PHASE_LABELS[attempt.phase] ?? attempt.phase}
                            </span>
                            <span className={`history-attempt__outcome is-${attempt.outcome}`}>
                              {ATTEMPT_OUTCOME_LABELS[attempt.outcome] ?? attempt.outcome}
                            </span>
                          </div>
                          <span className="history-attempt__meta">
                            {formatDateTime(attempt.startedAt)}
                            {attempt.finishedAt != null && attempt.startedAt != null
                              ? ` · 用时 ${formatDuration(attempt.startedAt, attempt.finishedAt) ?? "--"}`
                              : ""}
                            {attempt.backoffMs != null
                              ? ` · 退避 ${Math.round(attempt.backoffMs / 1000)} 秒`
                              : ""}
                          </span>
                          {attempt.error != null ? (
                            <HistoryDiagnostic
                              label={`第 ${attempt.attemptNumber} 次尝试失败`}
                              value={attempt.error}
                            />
                          ) : null}
                        </li>
                      ))}
                    </ol>
                  </section>
                ) : null}

                {detail.calls.length > 0 ? (
                  <section className="history-section">
                    <h3>供应商调用（{detail.calls.length} 次）</h3>
                    <ul className="history-calls">
                      {detail.calls.map((call, index) => {
                        const failed = providerCallFailed(call);
                        const diagnosticValue =
                          call.runtimeError ??
                          call.rawResponse ??
                          (failed
                            ? {
                                kind: "http",
                                message: `供应商返回 HTTP ${call.httpStatus ?? "未知状态"}，但没有响应体。`,
                              }
                            : null);
                        return (
                          <li
                            key={call.id}
                            className={`history-call${failed ? " is-error" : " is-success"}`}
                          >
                            <details open={failed}>
                              <summary>
                                <CaretRight
                                  size={15}
                                  weight="bold"
                                  className="history-disclosure__caret"
                                  aria-hidden="true"
                                />
                                <span className="history-call__index">调用 {index + 1}</span>
                                <span className="history-call__phase">
                                  {ATTEMPT_PHASE_LABELS[call.phase] ?? call.phase}
                                </span>
                                <span
                                  className={`history-call__status${failed ? " is-error" : " is-success"}`}
                                >
                                  {providerCallStatus(call)}
                                </span>
                                <span className="history-call__meta">
                                  {call.sentAt != null ? formatDateTime(call.sentAt) : "--"}
                                  {call.durationMs != null ? ` · ${call.durationMs} ms` : ""}
                                </span>
                              </summary>
                              <div className="history-call__body">
                                {failed && diagnosticValue != null ? (
                                  <HistoryDiagnostic
                                    label="供应商调用失败"
                                    value={diagnosticValue}
                                  />
                                ) : null}
                                <div className="history-call__payloads">
                                  <HistoryPayload label="请求参数" value={call.request} />
                                  <HistoryPayload
                                    label="响应头"
                                    value={call.responseHeaders}
                                    emptyText="（无响应头）"
                                  />
                                  <HistoryPayload
                                    label="供应商响应"
                                    value={call.rawResponse}
                                    emptyText="（无响应体）"
                                    open={failed && call.rawResponse != null}
                                  />
                                </div>
                              </div>
                            </details>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                ) : null}
              </div>
            )}
          </div>
        </div>
      </section>

      {lightboxIndex != null && viewableResults.length > 0 ? (
        <HistoryLightbox
          results={viewableResults}
          index={Math.min(lightboxIndex, viewableResults.length - 1)}
          onIndexChange={setLightboxIndex}
          onClose={handleLightboxClose}
        />
      ) : null}
    </div>
  );
}
