import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * 安全的只读 Markdown 渲染组件。
 *
 * 用 react-markdown（remark 生态）替代原先以 `white-space: pre-wrap` 原样展示
 * Markdown 源码的做法：标题、列表、代码块、表格（GFM）等语法会被真正渲染，
 * 默认不执行原始 HTML，避免 XSS；文本本身仍保留换行与行内格式。
 */
function MarkdownViewBase({ content }: { readonly content: string }) {
  return (
    <div className="markdown-view">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}

export const MarkdownView = memo(MarkdownViewBase);
