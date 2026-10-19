import { Icon } from "./Icon";
import { ErrorCopyButton } from "./ErrorCopyButton";
import { errorCopyText } from "../lib/clipboard";
import { backendErrorDetails, backendErrorMessage, formatRawBackendError } from "../lib/backend";
import { workflowErrorPresentation } from "../lib/workflowErrors";
import "./ErrorAlert.css";

/*
 * 错误提示：全产品唯一的「红色高亮报错」实现。
 *
 * 为什么必须收敛到一个组件
 * ------------------------
 * 改之前各处自己写 `<p role="alert">{error}</p>`，于是同一个错误在同一个面板里
 * 有三种死法：没有样式（白底黑字，用户根本看不出这是报错）、直接印后端 payload
 * 的 JSON（`{"details":null,"kind":"validation",…}`）、或者把调试堆栈塞进 live
 * region 让读屏软件整段朗读。报错是产品里用户最需要读懂的一段文字，不能每个
 * 调用点各写一遍。
 *
 * 这里一次性做对的五件事
 * ---------------------
 *   1. 只显示人能读的摘要：原始 payload / 堆栈交给 `backendErrorMessage` 剥掉，
 *      只留「发生了什么」（详见 `backend.ts`）。`raw` 仅默认展开诊断详情，
 *      模型调用同样不能把完整 payload 放入摘要和读屏提示。
 *   2. 不靠颜色单独传达（WCAG 1.4.1）：红色之外同时有警告图标与文字，
 *      色弱用户和灰度打印都还能认出这是错误。
 *   3. 语义与朗读：`role="alert"` 让错误出现时立刻被朗读；控件用
 *      `aria-describedby` 指向这里的 `id`，键盘用户走到控件就知道错在哪
 *      （WCAG 3.3.1 错误识别）。`role="alert"` 元素里不放可交互内容，
 *      因此「展开完整报错」在 alert 之外——否则用户每次展开都会被强制听一遍原始 JSON。
 *   4. 补救建议是报错的一部分：`hint` 说明「接下来怎么办」。
 *      只说「图片不合格」不说「换什么图」的错误，用户只能靠猜。
 *   5. 一键复制完整报错：报错是用户拿去求助的第一手材料，摘要旁边
 *      常驻「复制报错」按钮（见 `ErrorCopyButton`），连展开的原始
 *      payload 一起进剪贴板；按钮同样放在 alert 之外。
 */
export interface ErrorAlertProps {
  /** 原始错误：Tauri payload、Error 或已经格式化好的字符串都接受。 */
  readonly error: unknown;
  /** 用于触发控件的 aria-describedby；不传表示这个错误不挂在具体控件上。 */
  readonly id?: string;
  /** 补救建议：错误只说明「发生了什么」，这里说「接下来怎么办」。 */
  readonly hint?: string | undefined;
  /** Workflow usage errors include guidance; marked model failures retain their complete response. */
  readonly workflow?: boolean;
  /** 默认展开完整诊断；摘要始终使用可读文案。 */
  readonly raw?: boolean;
  /** 反馈发送自身的错误不再触发新一轮上报。 */
  readonly reportable?: boolean;
}

export function ErrorAlert({
  error,
  id,
  hint,
  workflow = false,
  raw = false,
  reportable = true,
}: ErrorAlertProps) {
  const presentation = workflow ? workflowErrorPresentation(error) : null;
  const details = presentation
    ? presentation.details
    : raw
      ? formatRawBackendError(error)
      : backendErrorDetails(error);
  const summary = presentation ? presentation.summary : backendErrorMessage(error);
  return (
    <div className="error-alert">
      <div className="error-alert__summary" id={id} role="alert">
        <Icon name="warning-circle" aria-hidden="true" size="sm" />
        <div className="error-alert__text">
          <span>{summary}</span>
          {presentation?.origin === "workflow" ? (
            <dl className="error-alert__guidance">
              <div>
                <dt>为什么发生</dt>
                <dd>{presentation.cause}</dd>
              </div>
              <div>
                <dt>现在怎么处理</dt>
                <dd>{presentation.action}</dd>
              </div>
              <div>
                <dt>正确流程</dt>
                <dd>
                  <ol>
                    {presentation.steps.map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                  </ol>
                </dd>
              </div>
              <div>
                <dt>如何避免</dt>
                <dd>{presentation.prevention}</dd>
              </div>
            </dl>
          ) : null}
          {hint && presentation?.origin !== "model" ? (
            <small className="error-alert__hint">{hint}</small>
          ) : null}
        </div>
      </div>
      <div className="error-alert__actions">
        <ErrorCopyButton
          text={errorCopyText(summary, details)}
          feedbackError={error}
          feedback={reportable}
        />
        {details ? (
          <details className="error-alert__details" open={raw || presentation?.origin === "model"}>
            <summary>
              {presentation?.origin === "model" ? "模型调用完整原始报错" : "展开完整报错"}
            </summary>
            <pre className="error-alert__raw">{details}</pre>
          </details>
        ) : null}
      </div>
    </div>
  );
}
