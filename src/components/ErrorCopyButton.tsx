import { useCallback, useEffect, useRef, useState } from "react";

import { copyErrorTextToClipboard } from "../lib/clipboard";
import { toast } from "../lib/toast";
import { Icon } from "./Icon";
import { ErrorFeedbackButton } from "./ErrorFeedbackButton";
import "./ErrorCopyButton.css";

/*
 * 一键复制报错：全产品唯一的「复制这段报错」按钮实现。
 *
 * 报错是用户拿去求助、贴给客服或开发者的第一手排查材料，所以每个报错
 * （ErrorAlert、各面板的手写报错条、错误 toast）都要带这个按钮，复制的是
 * 完整诊断文本而不是界面上被截断的摘要。剪贴板策略与反馈状态都收敛在
 * 这里，调用方只负责给出要复制的文本。
 */

export interface ErrorCopyButtonProps {
  /** 复制进剪贴板的完整报错文本。 */
  readonly text: string;
  /** 挂到具体控件时用于 aria-describedby。 */
  readonly id?: string;
  readonly feedbackError?: unknown;
  readonly feedback?: boolean;
}

export function ErrorCopyButton({
  text,
  id,
  feedbackError,
  feedback = true,
}: ErrorCopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const copyResetTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (copyResetTimerRef.current != null) window.clearTimeout(copyResetTimerRef.current);
    },
    [],
  );

  const handleCopy = useCallback(() => {
    void (async () => {
      try {
        await copyErrorTextToClipboard(text);
        setCopied(true);
        if (copyResetTimerRef.current != null) window.clearTimeout(copyResetTimerRef.current);
        copyResetTimerRef.current = window.setTimeout(() => setCopied(false), 2000);
      } catch (copyError) {
        toast.error("复制报错失败", {
          description: copyError instanceof Error ? copyError.message : String(copyError),
        });
      }
    })();
  }, [text]);

  return (
    <span className="error-copy-actions">
      <button
        type="button"
        id={id}
        className="error-copy-button"
        data-state={copied ? "copied" : "idle"}
        aria-label={copied ? "报错已复制到剪贴板" : "复制完整报错"}
        title={copied ? "已复制" : "复制完整报错"}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          handleCopy();
        }}
      >
        <Icon name={copied ? "check" : "copy-simple"} aria-hidden="true" size="xs" />
        {copied ? "已复制" : "复制报错"}
      </button>
      {feedback ? <ErrorFeedbackButton error={feedbackError ?? text} /> : null}
    </span>
  );
}
