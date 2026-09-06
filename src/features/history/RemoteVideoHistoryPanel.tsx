import { ArrowClockwise } from "@phosphor-icons/react/ArrowClockwise";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  formatRawBackendError,
  generationClient,
  providerSettingsClient,
  remoteVideoTaskClient,
  type GenerationTaskClient,
  type ProviderConnection,
  type ProviderSettingsClient,
  type ProviderTokenGroup,
  type RemoteVideoTaskClient,
  type RemoteVideoTaskPage,
  type RemoteVideoTaskQuery,
  type RemoteVideoTaskStatus,
} from "../../lib/backend";
import { copyTextToDesktopClipboard, openExternalUrl } from "../workspace/desktopActions";
import { parseHistoryDateRange } from "./historyDateRange";
import "./RemoteVideoHistoryPanel.css";

const STATUS_LABELS: Record<RemoteVideoTaskStatus, string> = {
  NOT_START: "尚未提交",
  SUBMITTED: "已提交",
  QUEUED: "排队中",
  IN_PROGRESS: "生成中",
  SUCCESS: "已成功",
  FAILURE: "失败",
  UNKNOWN: "状态未知",
};
const PAGE_SIZE = 20;

function todayRange() {
  const date = new Date();
  const day = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
  return { from: `${day}T00:00:00`, to: `${day}T23:59:59` };
}

function dateTime(seconds: number) {
  return seconds > 0 ? new Date(seconds * 1_000).toLocaleString() : "未上报";
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : formatRawBackendError(error);
}

type SettingsClient = Pick<
  ProviderSettingsClient,
  "listProviderConnections" | "listProviderTokenGroups"
>;

export function RemoteVideoHistoryPanel({
  client = remoteVideoTaskClient,
  settingsClient = providerSettingsClient,
  taskClient = generationClient,
  onSelectGenerationTask,
}: {
  readonly client?: RemoteVideoTaskClient | undefined;
  readonly settingsClient?: SettingsClient | undefined;
  readonly taskClient?: GenerationTaskClient | undefined;
  readonly onSelectGenerationTask: (taskId: string) => void;
}) {
  const [providers, setProviders] = useState<readonly ProviderConnection[]>([]);
  const [providersLoaded, setProvidersLoaded] = useState(false);
  const [providerId, setProviderId] = useState("");
  const [groups, setGroups] = useState<{
    providerId: string;
    items: readonly ProviderTokenGroup[];
  } | null>(null);
  const [tokenGroup, setTokenGroup] = useState("");
  const [range, setRange] = useState(todayRange);
  const [status, setStatus] = useState<RemoteVideoTaskStatus | "">("");
  const [page, setPage] = useState<RemoteVideoTaskPage | null>(null);
  const [appliedQuery, setAppliedQuery] = useState<RemoteVideoTaskQuery | null>(null);
  const [loading, setLoading] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [settingsRevision, setSettingsRevision] = useState(0);
  const [resumingTaskId, setResumingTaskId] = useState<string | null>(null);
  const requestRef = useRef(0);
  const mountedRef = useRef(true);
  const errorRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void settingsClient
      .listProviderConnections()
      .then((items) => {
        if (cancelled) return;
        const enabled = items.filter((item) => item.enabled);
        setProviders(enabled);
        setProviderId((current) =>
          enabled.some((item) => item.id === current) ? current : (enabled[0]?.id ?? ""),
        );
        setProvidersLoaded(true);
        setSettingsError(null);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setSettingsError(errorText(reason));
        setProvidersLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [settingsClient, settingsRevision]);

  useEffect(() => {
    if (!providerId) return;
    let cancelled = false;
    void settingsClient
      .listProviderTokenGroups(providerId)
      .then((items) => {
        if (cancelled) return;
        setGroups({ providerId, items: items.filter((item) => item.enabled) });
        setSettingsError(null);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setSettingsError(errorText(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [providerId, settingsClient, settingsRevision]);

  const invalidateQuery = () => {
    requestRef.current += 1;
    setLoading(false);
    setPage(null);
    setAppliedQuery(null);
    setError(null);
    setNotice(null);
  };

  const loadPage = async (query: RemoteVideoTaskQuery) => {
    const requestId = ++requestRef.current;
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const result = await client.list(query);
      if (requestId !== requestRef.current) return;
      setPage(result);
      setAppliedQuery(query);
    } catch (reason: unknown) {
      if (requestId !== requestRef.current) return;
      setPage(null);
      setError(errorText(reason));
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      const parsed = parseHistoryDateRange(range.from, range.to);
      void loadPage({
        providerConnectionId: providerId,
        tokenGroup: tokenGroup || null,
        // An empty range means all history, rather than the server's implicit today.
        startTimestamp:
          parsed.createdFrom == null
            ? parsed.createdTo == null
              ? 0
              : null
            : Math.floor(parsed.createdFrom / 1_000),
        endTimestamp: parsed.createdTo == null ? null : Math.floor(parsed.createdTo / 1_000),
        status: status || null,
        page: 1,
        pageSize: PAGE_SIZE,
      });
    } catch (reason: unknown) {
      setError(errorText(reason));
      requestAnimationFrame(() => errorRef.current?.focus());
    }
  };

  const resumePolling = async (taskId: string) => {
    setResumingTaskId(taskId);
    setError(null);
    const requestId = requestRef.current;
    try {
      await taskClient.queryVideoTaskNow(taskId);
      if (mountedRef.current && requestId === requestRef.current) {
        setNotice(
          "已请求继续查询，本地任务会在后台更新；生成完成后自动保存视频。可查看本地记录或刷新列表。",
        );
      }
    } catch (reason: unknown) {
      if (mountedRef.current && requestId === requestRef.current) setError(errorText(reason));
    } finally {
      if (mountedRef.current) setResumingTaskId(null);
    }
  };

  const handleVideoUrl = async (url: string, copy: boolean) => {
    const requestId = requestRef.current;
    try {
      if (copy) await copyTextToDesktopClipboard(url);
      else await openExternalUrl(url);
      if (mountedRef.current && requestId === requestRef.current)
        setNotice(copy ? "视频地址已复制。" : "已打开视频地址。");
    } catch (reason: unknown) {
      if (mountedRef.current && requestId === requestRef.current) setError(errorText(reason));
    }
  };

  const availableGroups = groups?.providerId === providerId ? groups.items : [];
  const canQuery = Boolean(providerId && groups?.providerId === providerId && !settingsError);
  const totalPages = page ? Math.max(1, Math.ceil(page.total / page.pageSize)) : 1;

  return (
    <div
      className="remote-video-history"
      role="tabpanel"
      id="remoteVideo-history-panel"
      aria-labelledby="remoteVideo-history-tab"
    >
      <form className="remote-video-history__filters" onSubmit={submit}>
        <label>
          供应商
          <select
            value={providerId}
            onChange={(event) => {
              invalidateQuery();
              setProviderId(event.target.value);
              setTokenGroup("");
              setGroups(null);
              setSettingsError(null);
            }}
          >
            {!providers.length ? (
              <option value="">{providersLoaded ? "暂无启用的供应商" : "正在加载供应商…"}</option>
            ) : null}
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.displayName}
              </option>
            ))}
          </select>
        </label>
        <label>
          令牌分组
          <select
            value={tokenGroup}
            disabled={!canQuery}
            onChange={(event) => {
              invalidateQuery();
              setTokenGroup(event.target.value);
            }}
          >
            <option value="">默认令牌</option>
            {availableGroups.map((group) => (
              <option key={group.id} value={group.groupName}>
                {group.groupName}
              </option>
            ))}
          </select>
        </label>
        <label>
          提交开始时间
          <input
            type="datetime-local"
            step="1"
            value={range.from}
            onChange={(event) => {
              invalidateQuery();
              setRange({ ...range, from: event.target.value });
            }}
          />
        </label>
        <label>
          提交结束时间
          <input
            type="datetime-local"
            step="1"
            value={range.to}
            onChange={(event) => {
              invalidateQuery();
              setRange({ ...range, to: event.target.value });
            }}
          />
        </label>
        <label>
          远程状态
          <select
            value={status}
            onChange={(event) => {
              invalidateQuery();
              setStatus(event.target.value as RemoteVideoTaskStatus | "");
            }}
          >
            <option value="">全部状态</option>
            {Object.entries(STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <div className="remote-video-history__actions">
          <button
            type="submit"
            className="remote-video-history__primary"
            disabled={!canQuery || loading}
          >
            {loading ? "查询中…" : "查询远程任务"}
          </button>
          <button
            type="button"
            onClick={() => {
              invalidateQuery();
              setRange(todayRange());
              setStatus("");
            }}
          >
            今天
          </button>
          <button
            type="button"
            onClick={() => {
              invalidateQuery();
              setRange({ from: "", to: "" });
            }}
          >
            全部时间
          </button>
        </div>
      </form>
      <p className="remote-video-history__hint">
        按提交时间查询，使用本机时区。应用关闭期间的任务仍可在这里查询；选择提交时使用的供应商和令牌。仅查询视频任务。
      </p>
      {settingsError ? (
        <div className="remote-video-history__error" role="alert">
          {settingsError}{" "}
          <button
            type="button"
            onClick={() => {
              setSettingsError(null);
              setGroups(null);
              setSettingsRevision((value) => value + 1);
            }}
          >
            重试加载配置
          </button>
        </div>
      ) : null}
      {providersLoaded && !providers.length && !settingsError ? (
        <p className="remote-video-history__hint">请先在供应商设置中配置并启用连接。</p>
      ) : null}
      {error ? (
        <p ref={errorRef} tabIndex={-1} className="remote-video-history__error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="remote-video-history__notice" role="status">
          {notice}
        </p>
      ) : null}
      <div className="remote-video-history__results" aria-busy={loading}>
        {!page && !loading && !error ? (
          <p className="history-list__empty">选择查询条件后，点击“查询远程任务”。</p>
        ) : null}
        {loading ? <p role="status">正在查询远程任务…</p> : null}
        {page ? (
          <>
            <div className="remote-video-history__pagination">
              <span role="status">
                共 {page.total} 条 · 第 {page.page} / {totalPages} 页
              </span>
              <div className="remote-video-history__actions">
                <button
                  type="button"
                  disabled={loading || !appliedQuery}
                  onClick={() => appliedQuery && void loadPage(appliedQuery)}
                >
                  <ArrowClockwise size={14} aria-hidden="true" /> 刷新
                </button>
                <button
                  type="button"
                  disabled={loading || page.page <= 1 || !appliedQuery}
                  onClick={() =>
                    appliedQuery && void loadPage({ ...appliedQuery, page: page.page - 1 })
                  }
                >
                  上一页
                </button>
                <button
                  type="button"
                  disabled={loading || page.page >= totalPages || !appliedQuery}
                  onClick={() =>
                    appliedQuery && void loadPage({ ...appliedQuery, page: page.page + 1 })
                  }
                >
                  下一页
                </button>
              </div>
            </div>
            {!page.items.length ? (
              <p className="history-list__empty">该时间范围和状态下没有视频任务。</p>
            ) : null}
            <ul className="remote-video-history__list">
              {page.items.map((task, index) => (
                <li
                  key={`${task.taskId}:${task.submitTime}:${index}`}
                  className="remote-video-history__item"
                >
                  <div className="remote-video-history__task-title">
                    <strong>{task.taskId || "尚未取得远程任务 ID"}</strong>
                    <span>
                      {STATUS_LABELS[task.status as RemoteVideoTaskStatus] ?? task.status}
                      {task.progress ? ` · ${task.progress}` : ""}
                    </span>
                  </div>
                  <dl>
                    <div>
                      <dt>提交</dt>
                      <dd>{dateTime(task.submitTime)}</dd>
                    </div>
                    <div>
                      <dt>开始</dt>
                      <dd>{dateTime(task.startTime)}</dd>
                    </div>
                    <div>
                      <dt>完成</dt>
                      <dd>{dateTime(task.finishTime)}</dd>
                    </div>
                    <div>
                      <dt>Token</dt>
                      <dd>
                        输入 {task.promptTokens} · 输出 {task.completionTokens}
                      </dd>
                    </div>
                  </dl>
                  {task.failureReason ? (
                    <p className="remote-video-history__error">{task.failureReason}</p>
                  ) : null}
                  {task.videoUrl ? (
                    <p className="remote-video-history__url">{task.videoUrl}</p>
                  ) : null}
                  <div className="remote-video-history__actions">
                    {task.videoUrl ? (
                      <>
                        <button
                          type="button"
                          onClick={() => void handleVideoUrl(task.videoUrl!, false)}
                        >
                          打开视频
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleVideoUrl(task.videoUrl!, true)}
                        >
                          复制视频地址
                        </button>
                      </>
                    ) : null}
                    {task.localTaskId ? (
                      <button
                        type="button"
                        onClick={() => onSelectGenerationTask(task.localTaskId!)}
                      >
                        查看本地记录
                      </button>
                    ) : (
                      <span className="remote-video-history__hint">未关联本机记录</span>
                    )}
                    {task.canResumePolling && task.localTaskId ? (
                      <button
                        type="button"
                        disabled={resumingTaskId != null}
                        onClick={() => void resumePolling(task.localTaskId!)}
                      >
                        {resumingTaskId === task.localTaskId ? "正在恢复查询…" : "继续本地查询"}
                      </button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
    </div>
  );
}
