import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { ErrorAlert } from "../../components/ErrorAlert";
import { Icon } from "../../components/Icon";
import {
  FEEDBACK_OPEN_EVENT,
  errorDiagnostic,
  getFeedbackReporter,
  scrubFeedbackText,
  type ClientDiagnostic,
  type FeedbackReporter,
} from "../../lib/errorReporting";
import {
  DIAGNOSTIC_CATEGORIES,
  type DiagnosticCategory,
  type DiagnosticOccurrence,
  type PreparedDiagnostics,
} from "../../lib/diagnosticAttachments";
import "./FeedbackHub.css";

const categoryLabels: Record<DiagnosticCategory, string> = {
  apiKeys: "完整 API Key",
  prompts: "提示词与对话上下文",
  rawResponse: "模型原始响应与完整报错",
  canvas: "对应画布的当前内容",
  assets: "对应素材文件与云端引用",
};
interface DiagnosticDraft {
  categories: DiagnosticCategory[];
  confirmed: boolean;
  prepared: PreparedDiagnostics | null;
}
const emptyDraft = (): DiagnosticDraft => ({ categories: [], confirmed: false, prepared: null });

export function FeedbackHub() {
  const [open, setOpen] = useState(false);
  const [diagnostic, setDiagnostic] = useState(() => errorDiagnostic(null, "user_feedback"));
  const [description, setDescription] = useState("");
  const [contact, setContact] = useState("");
  const [receipt, setReceipt] = useState<{ reportId: string; sent: boolean } | null>(null);
  const [occurrence, setOccurrence] = useState<DiagnosticOccurrence>({ error: null });
  const [draft, setDraft] = useState(emptyDraft);
  const requested = useRef({ diagnostic, occurrence });
  useEffect(() => {
    const show = (event: Event) => {
      const detail = (
        event as CustomEvent<
          | ClientDiagnostic
          | { diagnostic?: ClientDiagnostic; occurrence?: DiagnosticOccurrence }
          | undefined
        >
      ).detail;
      const context = detail && "category" in detail ? { diagnostic: detail } : detail;
      requested.current = {
        diagnostic: context?.diagnostic ?? errorDiagnostic(null, "user_feedback"),
        occurrence: context?.occurrence ?? { error: null },
      };
      if (!open && !receipt && !draft.prepared) {
        setDiagnostic(requested.current.diagnostic);
        setOccurrence(requested.current.occurrence);
      }
      setOpen(true);
    };
    window.addEventListener(FEEDBACK_OPEN_EVENT, show);
    return () => window.removeEventListener(FEEDBACK_OPEN_EVENT, show);
  }, [open, receipt, draft.prepared]);
  if (!open) return null;
  return (
    <FeedbackDialog
      reporter={getFeedbackReporter()}
      diagnostic={diagnostic}
      occurrence={occurrence}
      diagnosticDraft={draft}
      onDiagnosticDraft={setDraft}
      description={description}
      contact={contact}
      receipt={receipt}
      onReceipt={setReceipt}
      onDescription={setDescription}
      onContact={setContact}
      onClose={() => setOpen(false)}
      canSend={"__TAURI_INTERNALS__" in window}
      onStartNew={() => {
        setReceipt(null);
        setDescription("");
        setContact("");
        setDiagnostic(requested.current.diagnostic);
        setOccurrence(requested.current.occurrence);
        setDraft(emptyDraft());
      }}
    />
  );
}

export interface FeedbackDialogProps {
  readonly reporter: FeedbackReporter;
  readonly diagnostic: ClientDiagnostic;
  readonly description: string;
  readonly contact: string;
  readonly receipt: { reportId: string; sent: boolean } | null;
  readonly onReceipt: (receipt: { reportId: string; sent: boolean } | null) => void;
  readonly onDescription: (value: string) => void;
  readonly onContact: (value: string) => void;
  readonly onClose: () => void;
  readonly onStartNew?: () => void;
  readonly canSend?: boolean;
  readonly occurrence?: DiagnosticOccurrence;
  readonly diagnosticDraft?: DiagnosticDraft;
  readonly onDiagnosticDraft?: (draft: DiagnosticDraft) => void;
}
export function FeedbackDialog({
  reporter,
  diagnostic,
  description,
  contact,
  receipt,
  onReceipt,
  onDescription,
  onContact,
  onClose,
  onStartNew,
  canSend = true,
  occurrence,
  diagnosticDraft,
  onDiagnosticDraft,
}: FeedbackDialogProps) {
  const snapshot = useSyncExternalStore(reporter.subscribe, reporter.getSnapshot);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const privacyId = useId();
  const errorId = useId();
  const deliveryErrorId = `${errorId}-delivery`;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [preparing, setPreparing] = useState(false);
  const [localDraft, setLocalDraft] = useState(emptyDraft);
  const draft = diagnosticDraft ?? localDraft;
  const updateDraft = onDiagnosticDraft ?? setLocalDraft;
  const locked = busy || preparing || !!receipt;
  function resetPrepared(categories: DiagnosticCategory[]) {
    if (draft.prepared) reporter.discardDiagnostics(draft.prepared.reportId);
    updateDraft({ categories, confirmed: false, prepared: null });
    setError(null);
  }
  const safeDescription = scrubFeedbackText(description);
  const safeContact = scrubFeedbackText(contact);
  const sent = receipt && (receipt.sent || reporter.isDelivered(receipt.reportId));
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement;
    try {
      dialog.showModal();
    } catch {
      dialog.setAttribute("open", "");
    }
    closeRef.current?.focus();
    return () => {
      if (dialog.open && typeof dialog.close === "function") dialog.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);
  async function submit() {
    setBusy(true);
    setError(null);
    try {
      if (receipt) {
        await reporter.retryPending();
        onReceipt({ ...receipt, sent: reporter.isDelivered(receipt.reportId) });
      } else {
        if (draft.categories.length && (!draft.confirmed || !draft.prepared))
          throw new Error("请确认诊断资料授权，再点击“准备诊断并预览”，检查内容后发送。");
        onReceipt(
          await reporter.submitManual(
            diagnostic,
            description,
            contact,
            draft.prepared ?? undefined,
            onReceipt,
          ),
        );
      }
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }
  async function prepare() {
    setError(null);
    if (!draft.confirmed || !draft.categories.length) {
      setError(new Error("请先选择资料，并确认允许开发者读取所选内容。"));
      return;
    }
    setPreparing(true);
    try {
      const prepared = await reporter.prepareDiagnostics(occurrence ?? { error: null }, {
        consentedAt: new Date().toISOString(),
        consentConfirmed: true,
        categories: draft.categories,
      });
      if (draft.prepared) reporter.discardDiagnostics(draft.prepared.reportId);
      updateDraft({ ...draft, prepared });
    } catch (cause) {
      setError(cause);
    } finally {
      setPreparing(false);
    }
  }
  return createPortal(
    <dialog
      ref={dialogRef}
      className="feedback-dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={privacyId}
      onCancel={(event) => {
        event.preventDefault();
        if (!preparing && (!busy || receipt)) onClose();
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <header className="feedback-dialog__header">
        <h2 id={titleId}>反馈与错误诊断</h2>
        <button
          ref={closeRef}
          type="button"
          className="feedback-button"
          disabled={preparing || (busy && !receipt)}
          onClick={onClose}
          aria-label="关闭反馈窗口"
        >
          <Icon name="x" aria-hidden="true" />
          关闭
        </button>
      </header>
      <p id={privacyId}>
        反馈发送给「饭众烟 AI」的开发者。自动诊断默认收集完整 API
        Key、提示词、模型原始响应、报错堆栈、对应画布和素材，在后台自动上传。资料会加密保存，仅管理后台可读取。
      </p>
      <label className="feedback-dialog__toggle">
        <input
          type="checkbox"
          checked={snapshot.automaticEnabled}
          onChange={(event) => reporter.setAutomaticEnabled(event.target.checked)}
        />
        <span>
          自动收集并上传完整报错
          <small>
            默认开启，无需首次确认或逐次发送。关闭后停止自动收集，并清除本机待发送的自动诊断。
          </small>
        </span>
      </label>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        aria-busy={busy}
      >
        <label className="feedback-dialog__field">
          问题描述（选填）
          <textarea
            value={description}
            maxLength={2000}
            rows={4}
            disabled={locked}
            aria-describedby={privacyId}
            placeholder="例如：点击生成后没有结果。写下操作步骤和预期效果，便于复现。"
            onChange={(event) => onDescription(event.target.value)}
          />
        </label>
        <label className="feedback-dialog__field">
          联系方式（选填）
          <input
            value={contact}
            maxLength={160}
            disabled={locked}
            placeholder="需要回复时，填写邮箱或微信"
            onChange={(event) => onContact(event.target.value)}
          />
        </label>
        <fieldset
          className="feedback-dialog__diagnostics"
          disabled={locked}
          aria-describedby={error ? errorId : privacyId}
        >
          <legend>本次手动反馈附带资料（逐项选择）</legend>
          <p>下列选项仅控制这一次手动反馈。上方自动诊断开启时，发生报错会自动收集全部五类资料。</p>
          <p>
            完整 Key 可用于调用和消费 API
            额度。提示词、响应、画布或素材可能包含私人及商业内容。仅提交你有权提供的资料。
          </p>
          {DIAGNOSTIC_CATEGORIES.map((category) => (
            <label className="feedback-dialog__toggle" key={category}>
              <input
                type="checkbox"
                checked={draft.categories.includes(category)}
                onChange={(event) =>
                  resetPrepared(
                    event.target.checked
                      ? [...draft.categories, category]
                      : draft.categories.filter((item) => item !== category),
                  )
                }
              />
              <span>{categoryLabels[category]}</span>
            </label>
          ))}
          <p>
            本地素材附文件字节，云端素材附原始地址引用。单份诊断最多 64
            MiB，其中素材原始文件合计最多 47 MiB；超出时会提示调整。
          </p>
          <label className="feedback-dialog__toggle">
            <input
              type="checkbox"
              checked={draft.confirmed}
              disabled={!draft.categories.length}
              onChange={(event) => {
                if (!event.target.checked && draft.prepared)
                  reporter.discardDiagnostics(draft.prepared.reportId);
                updateDraft({
                  ...draft,
                  confirmed: event.target.checked,
                  prepared: event.target.checked ? draft.prepared : null,
                });
              }}
            />
            <span>我确认允许开发者读取所选资料，包含勾选的完整 API Key 或私人内容</span>
          </label>
          <div className="feedback-dialog__actions">
            <button
              type="button"
              className="feedback-button"
              disabled={!canSend || !draft.confirmed}
              onClick={() => void prepare()}
              aria-describedby={error ? errorId : privacyId}
            >
              {preparing ? "正在准备诊断…" : "准备诊断并预览"}
            </button>
          </div>
          {draft.prepared ? (
            <p role="status">
              诊断资料已准备：{(draft.prepared.diagnostics.byteLength / 1024 / 1024).toFixed(2)}{" "}
              MiB。检查下方预览后发送；API Key 在预览中隐藏中间字符，上传包含完整值。
            </p>
          ) : null}
        </fieldset>
        <p role="status">
          {snapshot.automaticEnabled
            ? "自动完整诊断已开启，后续报错会自动上传全部五类资料。"
            : "自动诊断已关闭，仍可手动发送反馈。"}{" "}
          已上传的完整资料在后台最多保留 7 天，开发者可提前删除。
        </p>
        <details className="feedback-dialog__preview">
          <summary>查看将发送的诊断和反馈内容</summary>
          <pre>
            {JSON.stringify(
              { diagnostic, description: safeDescription, contact: safeContact },
              null,
              2,
            )}
          </pre>
          {draft.prepared ? <pre>{draft.prepared.preview}</pre> : null}
        </details>
        {safeDescription !== description || safeContact !== contact ? (
          <p className="feedback-dialog__notice">
            已从发送内容中移除识别出的密钥、链接或本机路径，请在预览中检查。
          </p>
        ) : null}
        {error ? (
          <ErrorAlert
            id={errorId}
            error={error}
            hint="反馈内容已保留。检查网络后重试，或复制报错联系开发者。"
            reportable={false}
          />
        ) : null}
        {receipt && !sent && !busy && !snapshot.sending ? (
          <ErrorAlert
            id={deliveryErrorId}
            error={reporter.deliveryError(receipt.reportId)}
            hint={
              snapshot.storageAvailable
                ? "反馈已保留在此设备。检查网络后可重试，也可以填写一份新反馈。"
                : "当前设备无法保存反馈，请保持窗口打开并重试。"
            }
            reportable={false}
          />
        ) : null}
        {!canSend ? <p role="status">请在桌面应用中发送反馈。</p> : null}
        {receipt ? (
          <p role="status" className="feedback-dialog__notice">
            {busy || snapshot.sending
              ? "反馈正在后台发送，完整资料分片上传完成后才会确认送达。可以关闭此窗口继续使用软件。"
              : sent
                ? "反馈已送达开发者。"
                : reporter.isBlocked(receipt.reportId)
                  ? "接收端没有接受这份反馈，已停止自动重发。可重试或清除待发送记录后修改。"
                  : snapshot.storageAvailable
                    ? "反馈暂未送达，已保存在此设备，恢复连接后会自动重发。"
                    : "反馈暂未送达，当前设备无法保存记录，请保持窗口打开并重试。"}
            <br />
            反馈编号：<code>{receipt.reportId}</code>
          </p>
        ) : null}
        <div className="feedback-dialog__actions">
          <button
            className="feedback-button feedback-button--primary"
            type="submit"
            disabled={!canSend || busy || preparing || !!sent}
            aria-describedby={error ? errorId : receipt && !sent ? deliveryErrorId : privacyId}
          >
            <Icon name="paper-plane-right" aria-hidden="true" />
            {busy ? "正在发送…" : sent ? "已送达" : receipt ? "重试这份反馈" : "发送反馈"}
          </button>
          {receipt || draft.prepared ? (
            <button
              className="feedback-button"
              type="button"
              disabled={busy}
              onClick={() => {
                if (draft.prepared && !receipt)
                  reporter.discardDiagnostics(draft.prepared.reportId);
                if (onStartNew) {
                  onStartNew();
                  return;
                }
                onReceipt(null);
                onDescription("");
                onContact("");
                updateDraft(emptyDraft());
              }}
            >
              填写新反馈
            </button>
          ) : null}
        </div>
      </form>
      <section className="feedback-dialog__queue" aria-label="待发送反馈">
        {snapshot.preparing ? <p role="status">正在准备 {snapshot.preparing} 份诊断资料…</p> : null}
        {snapshot.collectionError ? (
          <ErrorAlert
            error={snapshot.collectionError}
            hint="完整资料暂存失败，本次报告已标记资料缺失。请检查设备空间和展开的完整报错，再重新发送反馈。"
            reportable={false}
          />
        ) : null}
        <p>
          待发送：{snapshot.pending} 份
          {snapshot.blocked ? `（${snapshot.blocked} 份被接收端拒绝）` : ""}
          。同类自动错误会合并，离线记录最多保留 7 天。
        </p>
        {!snapshot.storageAvailable ? (
          <p role="status">当前设备无法保存反馈记录，关闭软件前请完成发送。</p>
        ) : null}
        <div className="feedback-dialog__actions">
          <button
            className="feedback-button"
            type="button"
            disabled={!snapshot.pending || preparing}
            onClick={() => {
              void reporter.retryPending();
            }}
          >
            重试待发送反馈
          </button>
          <button
            className="feedback-button"
            type="button"
            disabled={!snapshot.pending || snapshot.sending || busy}
            onClick={() => {
              reporter.clearPending();
              if (receipt && !sent) {
                onReceipt(null);
                updateDraft(emptyDraft());
              }
            }}
          >
            清除待发送记录
          </button>
        </div>
      </section>
    </dialog>,
    document.body,
  );
}
