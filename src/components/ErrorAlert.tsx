import { Icon } from "./Icon";
import { ErrorCopyButton } from "./ErrorCopyButton";
import { errorCopyText } from "../lib/clipboard";
import { backendErrorDetails, backendErrorMessage, formatRawBackendError } from "../lib/backend";
import { useCallback, type ReactNode, type Ref } from "react";
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
  /** 默认展开完整诊断；摘要始终使用可读文案。 */
  readonly raw?: boolean;
  /** 人话前缀：说明是哪一步失败（「保存连接时」），与错误摘要分开。 */
  readonly label?: string | undefined;
  /**
   * 色调：`error` 是红色高亮（默认），`warning` 是琥珀色。
   *
   * 有些提示不是「操作失败」而是「这里还差一步」（例如素材角色与模型要求不符、
   * 白模控制项待完善）。它们过去是各写各的 `<p role="alert">`，样式散在好几处
   * CSS 里。收敛到这里后仍要保留「警告 ≠ 错误」的视觉区分 —— 否则用户会把
   * 黄色提示当成红色失败，白白改掉本来正确的东西。
   */
  readonly tone?: "error" | "warning";
  /**
   * 额外的补救动作（如「重试」按钮），渲染在 alert live region **之外**。
   *
   * `role="alert"` 元素里不能放可交互内容：读屏软件会把按钮文案一起念进
   * live region，用户听到的是一串没有上下文的文字。动作按钮放在这里，
   * 用户既能点到，也不会污染朗读。
   */
  readonly action?: ReactNode;
  /**
   * 指向报错摘要元素的 ref。
   *
   * 有些面板靠「把焦点移到报错上」告诉用户出错了（键盘用户看不到红色高亮）。
   * 收敛到本组件后，那个可聚焦的元素是内部的 `role="alert"` 摘要块，
   * 调用方需要能拿到它 —— React 19 允许函数组件把 `ref` 当普通 prop 收，
   * 这里显式声明为 `Ref<HTMLElement>` 并挂到摘要块上（panel 版式是 div、
   * inline 版式是 span，所以用 HTMLElement 而不是更窄的类型）。
   */
  readonly ref?: Ref<HTMLElement>;
  /**
   * 版式：`panel` 是带底色描边的面板（默认），`inline` 是紧贴文字的一行。
   *
   * 有些报错出现在本来就该紧凑的地方 —— 画布节点工具栏、素材上传列表的一行、
   * 历史面板的错误行。这些位置套上带底色的面板会撑破布局（节点卡会被顶高、
   * 列表行会多出半屏空白），而把红色面板硬塞进 `<span>` 父元素里还会产出
   * 非法的 HTML（span 里不能放 div）。
   *
   * `inline` 版式因此用 `<span>` 渲染、去掉底色描边，只保留图标 + 文字 +
   * 复制按钮：既保住「红色 + 图标」的双重编码，也不改布局。
   */
  readonly variant?: "panel" | "inline";
  /**
   * 已经算好的摘要；给了就用它，不再走 `backendErrorMessage`。
   *
   * 有些调用点有自己的、更贴合场景的错误解析（例如素材库面板会把
   * 「HTTP 429（限流）：rate limited」拆成状态码 + 原因两段）。强行让
   * 它们退回通用解析会丢信息，而自己再手写一套红色面板又违背「错误提示
   * 只有一个实现」的约定。这里让调用点只负责**解析**，呈现仍由本组件负责。
   */
  readonly summaryText?: string | undefined;
  /**
   * 已经算好的完整诊断文本；给了就用它作为「展开完整报错」的内容。
   * 原始 payload 依然只出现在这里与复制文本里，不进摘要与朗读。
   */
  readonly detailsText?: string | undefined;
}

/**
 * 一次失败的展示单元：人话前缀 + 原始错误。
 *
 * 前缀说明「哪一步失败了」，原始错误交给 ErrorAlert 去摘要、去展开、去复制。
 * 两者分开存，原始 payload 就不会被人话前缀带着一起糊在界面上——调用点
 * 只管把原始错误对象递进来，摘要与诊断文本由 ErrorAlert 统一负责。
 */
export interface ErrorAlertNotice {
  /** 人话前缀；不传表示不需要额外前缀。 */
  readonly label?: string | undefined;
  /** 原始错误对象：payload、Error 或字符串都接受。 */
  readonly error: unknown;
}

export function ErrorAlert({
  error,
  id,
  hint,
  raw = false,
  label,
  tone = "error",
  action,
  ref,
  variant = "panel",
  summaryText,
  detailsText,
}: ErrorAlertProps) {
  // 原始 payload 只出现在「展开完整报错」与复制文本里，永远不进摘要。
  const rawPayload = error == null ? null : formatRawBackendError(error);
  const details =
    detailsText != null ? detailsText : raw ? rawPayload : backendErrorDetails(error);
  const summary = summaryText ?? backendErrorMessage(error);
  /*
   * 摘要块在 panel 版式里是 `<div>`、inline 版式里是 `<span>`，而调用方拿到的
   * ref 类型是 `Ref<HTMLElement>`。直接把它挂上去过不了类型检查（`RefObject`
   * 的 current 是双向的，`HTMLElement` 不能赋给 `HTMLDivElement`），所以用
   * 回调 ref 手动转交 —— 运行时等价，且不需要任何类型断言。
   *
   * **必须用 useCallback 稳定身份**：回调 ref 的身份变了，React 会在每次渲染时
   * 先把旧回调以 `null` 调用一遍（detach）、再以节点调用新回调（attach）——
   * 也就是每次渲染都把 ref 拆装一次。对象 ref 侥幸没事（DOM 节点没被移除，
   * 焦点还在），但回调 ref 的持有者会在每次渲染收到一次 `null`，很容易写出
   * 「收到 null 就清理」的副作用。稳定身份后 React 只在节点真的变化时才转交。
   */
  const attachSummary = useCallback(
    (node: HTMLElement | null) => {
      if (typeof ref === "function") ref(node);
      else if (ref != null) (ref as { current: HTMLElement | null }).current = node;
    },
    [ref],
  );
  // 复制的是完整诊断文本，不是界面上被截断的那一句：
  // 普通 Error 的堆栈只在这里露面（详情面板不展开堆栈，用户不需要看它）。
  const copyPayload = details ?? (rawPayload && rawPayload !== summary ? rawPayload : null);
  if (variant === "inline") {
    // 紧凑版式：父元素常是 `<span>`（画布节点工具栏、上传列表行），
    // 这里必须用 span 渲染，不能产出 span 里套 div 的非法 HTML。
    //
    // 因此**不渲染「展开完整报错」**：`<details>` 与 `<pre>` 都是块级元素，
    // 放进 span 里不合 HTML 规范（浏览器解析与布局正常，但这是零容忍项）。
    // 完整诊断并没有丢 —— 复制按钮的内容本来就含原始 payload，
    // 用户复制即可拿到同样的信息。
    return (
      <span className="error-alert error-alert--inline" data-tone={tone}>
        <span
          className="error-alert__summary"
          id={id}
          role="alert"
          tabIndex={-1}
          ref={attachSummary}
        >
          <Icon name="warning-circle" aria-hidden="true" size="sm" />
          <span className="error-alert__text">
            {label ? <strong>{label}</strong> : null}
            <span>{summary}</span>
            {hint ? <small className="error-alert__hint">{hint}</small> : null}
          </span>
        </span>
        <span className="error-alert__actions">
          <ErrorCopyButton text={errorCopyText(summary, copyPayload)} />
          {action}
        </span>
      </span>
    );
  }
  return (
    <div className="error-alert" data-tone={tone}>
      {/*
       * 摘要块可编程聚焦（`tabIndex={-1}`）：键盘用户看不到红色高亮，
       * 有些面板靠「把焦点移到报错上」来告知出错。不进 Tab 顺序，不打扰键盘流。
       */}
      <div
        className="error-alert__summary"
        id={id}
        role="alert"
        tabIndex={-1}
        ref={attachSummary}
      >
        <Icon name="warning-circle" aria-hidden="true" size="sm" />
        <div className="error-alert__text">
          {label ? <strong>{label}</strong> : null}
          <span>{summary}</span>
          {hint ? <small className="error-alert__hint">{hint}</small> : null}
        </div>
      </div>
      <div className="error-alert__actions">
        <ErrorCopyButton text={errorCopyText(summary, copyPayload)} />
        {action}
        {details ? (
          <details className="error-alert__details" open={raw}>
            <summary>展开完整报错</summary>
            <pre className="error-alert__raw">{details}</pre>
          </details>
        ) : null}
      </div>
    </div>
  );
}
