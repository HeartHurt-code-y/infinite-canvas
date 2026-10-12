import { useEffect, useState } from "react";
import type { PromptContentEditorSession } from "../../lib/promptContent";
import type { PromptBlockKind, PromptInlineMark } from "../../lib/promptRichText";
import "./PromptRichTextToolbar.css";

interface InlineControl {
  readonly kind: "inline";
  readonly mark: PromptInlineMark;
  readonly label: string;
  readonly title: string;
}

interface BlockControl {
  readonly kind: "block";
  readonly block: PromptBlockKind | "paragraph";
  readonly label: string;
  readonly title: string;
}

const CONTROLS: readonly (InlineControl | BlockControl)[] = [
  { kind: "inline", mark: "bold", label: "B", title: "加粗" },
  { kind: "inline", mark: "italic", label: "I", title: "斜体" },
  { kind: "inline", mark: "underline", label: "U", title: "下划线" },
  { kind: "inline", mark: "strike", label: "S", title: "删除线" },
  { kind: "inline", mark: "code", label: "</>", title: "行内代码" },
  { kind: "block", block: "heading1", label: "H1", title: "一级标题" },
  { kind: "block", block: "heading2", label: "H2", title: "二级标题" },
  { kind: "block", block: "heading3", label: "H3", title: "三级标题" },
  { kind: "block", block: "bullet", label: "•", title: "无序列表" },
  { kind: "block", block: "ordered", label: "1.", title: "有序列表" },
  { kind: "block", block: "blockquote", label: "❝", title: "引用" },
  { kind: "block", block: "code", label: "▤", title: "代码块" },
  { kind: "block", block: "hr", label: "—", title: "插入分隔线" },
  { kind: "block", block: "paragraph", label: "¶", title: "退回普通段落" },
];

/**
 * 提示词编辑器的富格式工具栏。
 *
 * 仅在编辑器获得焦点时出现（CSS :focus-within），不占用节点卡的常驻空间；
 * 按钮用 onMouseDown preventDefault 保住编辑器选区，点击不会丢失光标位置。
 */
export function PromptRichTextToolbar({
  session,
  onPickFiles,
}: {
  readonly session: PromptContentEditorSession;
  /** 提供时渲染「插入媒体文件」按钮（粘贴/拖拽之外的第三个入口）。 */
  readonly onPickFiles?: () => void;
}) {
  const [formats, setFormats] = useState(() => session.activeFormats());
  useEffect(
    () => session.subscribeFormatChanges(() => setFormats(session.activeFormats())),
    [session],
  );
  return (
    <div className="prompt-rich-toolbar" role="toolbar" aria-label="提示词格式">
      {onPickFiles != null && (
        <button
          type="button"
          className="prompt-rich-toolbar__button"
          aria-label="插入媒体文件"
          title="插入图片 / 视频 / 音频（也可直接粘贴或拖入）"
          onMouseDown={(event) => event.preventDefault()}
          onClick={onPickFiles}
        >
          📎
        </button>
      )}
      {CONTROLS.map((control) => {
        const active =
          control.kind === "inline"
            ? formats.marks.includes(control.mark)
            : formats.block === control.block;
        return (
          <button
            key={control.kind === "inline" ? `inline-${control.mark}` : `block-${control.block}`}
            type="button"
            className={`prompt-rich-toolbar__button${active ? " is-active" : ""}`}
            aria-label={control.title}
            aria-pressed={active}
            title={control.title}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              if (control.kind === "inline") session.toggleInlineMark(control.mark);
              else session.toggleBlockFormat(control.block);
            }}
          >
            {control.label}
          </button>
        );
      })}
    </div>
  );
}
