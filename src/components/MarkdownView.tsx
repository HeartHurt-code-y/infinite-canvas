import { memo, type ComponentPropsWithoutRef, type MouseEvent } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { isExternalHttpUrl, openExternalLink, resolveMarkdownLinkHref } from "../lib/externalLinks";

/**
 * 安全的只读 Markdown 渲染组件。
 *
 * 用 react-markdown（remark 生态）替代原先以 `white-space: pre-wrap` 原样展示
 * Markdown 源码的做法：标题、列表、代码块、表格（GFM）等语法会被真正渲染，
 * 默认不执行原始 HTML，避免 XSS；文本本身仍保留换行与行内格式。
 *
 * 外链必须经过 MarkdownLink：Tauri 主窗口没有返回键，站外链接原地导航会把
 * 整个应用顶掉。这里自带 target/rel/onClick，即使 document 级守卫（main.tsx
 * 的 installExternalLinkGuard）被父级 stopPropagation 挡住也能兜住；
 * onClick 里尊重 defaultPrevented，避免与全局守卫各开一次浏览器。
 */
/** 导出给创作助手消息等需要同样外链安全语义的 Markdown 渲染方复用。 */
export function MarkdownLink({
  node,
  href,
  onClick,
  ...rest
}: ComponentPropsWithoutRef<"a"> & { readonly node?: unknown }) {
  void node; // react-markdown 附带的 hast 节点对象，剥离后不落进 DOM 属性。
  const resolved = resolveMarkdownLinkHref(href);
  if (!resolved || !isExternalHttpUrl(resolved)) {
    return <a href={href} onClick={onClick} {...rest} />;
  }
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented) return;
    event.preventDefault();
    void openExternalLink(new URL(resolved, window.location.href).href);
  };
  return (
    <a href={resolved} target="_blank" rel="noopener noreferrer" onClick={handleClick} {...rest} />
  );
}

const MARKDOWN_COMPONENTS: Components = { a: MarkdownLink };

function MarkdownViewBase({ content }: { readonly content: string }) {
  return (
    <div className="markdown-view">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
        {content}
      </ReactMarkdown>
    </div>
  );
}

export const MarkdownView = memo(MarkdownViewBase);
