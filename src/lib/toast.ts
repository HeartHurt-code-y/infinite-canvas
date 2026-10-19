import type { ReactNode } from "react";
import { toast as sonnerToast, type ExternalToast } from "sonner";

import { copyErrorTextToClipboard } from "./clipboard";
import {
  captureApplicationError,
  errorDiagnostic,
  openFeedback,
  feedbackOccurrence,
} from "./errorReporting";

/*
 * sonner 的错误通知包装：`toast.error` 一律自带「复制报错」动作。
 *
 * toast 转瞬即逝，里面的报错用户往往来不及看清就得贴出去求助；只把文字
 * 印在气泡里没法选中复制（4 秒后整个消失）。所以错误 toast 统一带一个
 * 「复制报错」动作按钮，点一下把完整内容写进剪贴板，再用一条短 success
 * toast 确认。调用方用法与 sonner 完全一致，只是从 `sonner` 换成这里导入。
 */

/** 从 toast 的 message / description 里抠出可复制的纯文本。 */
function extractToastText(node: unknown): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) {
    return node
      .map((child) => extractToastText(child))
      .filter(Boolean)
      .join("\n");
  }
  // React 元素、渲染函数等富内容不进剪贴板：界面里点得到的内容留给界面组件负责。
  return "";
}

function withCopyAction(message: ReactNode, data?: ExternalToast): ExternalToast | undefined {
  // 调用方自己带了动作按钮就不覆盖：那通常是跳转/重试等更重要的出口。
  if (data?.action) return data;
  const text = [extractToastText(message), extractToastText(data?.description)]
    .filter(Boolean)
    .join("\n");
  if (!text) return data;
  return {
    ...data,
    action: {
      label: "复制报错",
      onClick: () => {
        void copyErrorTextToClipboard(text).then(
          () => {
            sonnerToast.success("报错已复制到剪贴板", { duration: 2000 });
          },
          (copyError: unknown) => {
            sonnerToast.error("复制报错失败", {
              duration: 4000,
              description: copyError instanceof Error ? copyError.message : String(copyError),
            });
          },
        );
      },
    },
  };
}

function errorToast(message: ReactNode, data?: ExternalToast): string | number {
  const error = extractToastText(data?.description) || extractToastText(message);
  captureApplicationError(error, "toast");
  const options = withCopyAction(message, data);
  return sonnerToast.error(message, {
    ...options,
    cancel: data?.cancel ?? {
      label: "反馈问题",
      onClick: () => {
        const occurrence = feedbackOccurrence(error);
        openFeedback(errorDiagnostic(error, occurrence.operation), occurrence);
      },
    },
  });
}

/** 与 sonner 的 `toast` 同一个 API；只有 `error` 会被注入复制动作。 */
export const toast: typeof sonnerToast = Object.assign(
  (...args: Parameters<typeof sonnerToast>) => sonnerToast(...args),
  sonnerToast,
  { error: errorToast },
);
