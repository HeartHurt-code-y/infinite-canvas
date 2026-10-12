/**
 * 提示词编辑器的富文本样式模型。
 *
 * canonical 文档（prompt-content v1）保持「扁平条目」不变：富格式作为 text 条目上的
 * 可选字段存活（marks = 行内格式；block/indent = 块级结构），因此不需要迁移存档版本
 * ——旧的读方会忽略这些字段并自然退化为纯文本。提交给模型/历史展示的纯文本由
 * serializePromptTextMarkdown 投影为 markdown，结构与可读性同时保留。
 *
 * 约束：未应用任何格式的文本必须与旧版本逐字节一致（不转义字面 `*` 等），
 * 保证存量文档与既有测试零漂移。
 */

export const PROMPT_INLINE_MARKS = ["bold", "italic", "underline", "strike", "code"] as const;
export type PromptInlineMark = (typeof PROMPT_INLINE_MARKS)[number];

export const PROMPT_BLOCK_KINDS = [
  "heading1",
  "heading2",
  "heading3",
  "bullet",
  "ordered",
  "blockquote",
  "code",
  "hr",
] as const;
export type PromptBlockKind = (typeof PROMPT_BLOCK_KINDS)[number];

/** 普通段落（无块级结构）的显式取值，供工具栏状态判断使用。 */
export type PromptParagraphKind = "paragraph";

/** text 条目上的富格式字段；全部可选，缺省即普通段落纯文本。 */
export interface PromptTextStyle {
  readonly marks?: readonly PromptInlineMark[];
  readonly block?: PromptBlockKind;
  /** 列表嵌套深度（0 起）；仅 bullet / ordered 有意义。 */
  readonly indent?: number;
}

const MAX_INDENT = 4;
const BLOCK_KIND_SET: ReadonlySet<string> = new Set(PROMPT_BLOCK_KINDS);
const INLINE_MARK_SET: ReadonlySet<string> = new Set(PROMPT_INLINE_MARKS);

/** 校验并裁剪来自存档/编辑器的样式字段；非法值一律丢弃而不是拒绝整份文档。 */
export function normalizePromptTextStyle(style: PromptTextStyle): PromptTextStyle {
  const marks = style.marks?.filter((mark) => INLINE_MARK_SET.has(mark));
  const block = style.block != null && BLOCK_KIND_SET.has(style.block) ? style.block : undefined;
  const indent =
    style.indent != null && Number.isInteger(style.indent) && style.indent > 0
      ? Math.min(style.indent, MAX_INDENT)
      : undefined;
  return {
    ...(marks != null && marks.length > 0 ? { marks: [...marks] } : {}),
    ...(block != null ? { block } : {}),
    ...(indent != null ? { indent } : {}),
  };
}

export function samePromptTextStyle(first: PromptTextStyle, second: PromptTextStyle): boolean {
  const firstMarks = first.marks ?? [];
  const secondMarks = second.marks ?? [];
  if (firstMarks.length !== secondMarks.length) return false;
  for (let index = 0; index < firstMarks.length; index += 1) {
    if (firstMarks[index] !== secondMarks[index]) return false;
  }
  return (
    (first.block ?? "") === (second.block ?? "") && (first.indent ?? 0) === (second.indent ?? 0)
  );
}

/** 只摘出样式字段；解析器 split 文本条目时用它把格式带到切出的新条目上。 */
export function pickPromptTextStyle<T extends PromptTextStyle>(item: T): PromptTextStyle {
  return {
    ...(item.marks != null && item.marks.length > 0 ? { marks: [...item.marks] } : {}),
    ...(item.block != null ? { block: item.block } : {}),
    ...(item.indent != null ? { indent: item.indent } : {}),
  };
}

/**
 * 追加带样式的文本；只有样式完全相同的相邻片段才会合并成一个条目。
 * promptContent / promptTiptap / 两个引用解析器共享这一份合并逻辑，
 * 保证任何一条「重建文档」的路径都不会把不同格式的文本焊在一起。
 * 泛型刻意放宽到 object：调用方传的是 PromptContentItem[] 这类联合数组，
 * 运行时只关心尾部是否为同样式 text 条目。
 */
export function appendStyledText<T extends object>(
  items: T[],
  text: string,
  style: PromptTextStyle = {},
): void {
  if (!text) return;
  const previous = items.at(-1) as ({ kind: "text"; text: string } & PromptTextStyle) | undefined;
  if (previous?.kind === "text" && samePromptTextStyle(previous, style)) {
    items[items.length - 1] = { ...previous, text: previous.text + text } as T;
    return;
  }
  items.push({ ...style, kind: "text", text } as T);
}

const UNDERLINE_OPEN = "<u>";
const UNDERLINE_CLOSE = "</u>";

/**
 * 把带样式的文本投影为 markdown 纯文本。这是模型、历史与字数统计看到的样子：
 * 结构保留（标题/列表/引用/分隔线），行内格式用 markdown/HTML 惯例表达。
 * code 块按原文输出（不包围栏——模型需要的是代码本体）；hr 投影为水平线。
 */
export function serializePromptTextMarkdown(
  text: string,
  style: PromptTextStyle,
  orderedNumber?: number,
): string {
  const inline = applyInlineMarkdown(text, style.marks ?? []);
  const block = style.block;
  if (block == null || block === "code") return inline;
  if (block === "hr") return "---";
  const indent = "  ".repeat(style.indent ?? 0);
  return inline
    .split("\n")
    .map((line) => {
      if (block === "heading1") return `${indent}# ${line}`;
      if (block === "heading2") return `${indent}## ${line}`;
      if (block === "heading3") return `${indent}### ${line}`;
      if (block === "bullet") return `${indent}- ${line}`;
      if (block === "ordered") return `${indent}${orderedNumber ?? 1}. ${line}`;
      return `${indent}> ${line}`;
    })
    .join("\n");
}

function applyInlineMarkdown(text: string, marks: readonly PromptInlineMark[]): string {
  let result = text;
  if (marks.includes("underline")) result = `${UNDERLINE_OPEN}${result}${UNDERLINE_CLOSE}`;
  if (marks.includes("strike")) result = `~~${result}~~`;
  if (marks.includes("code")) result = `\`${result}\``;
  if (marks.includes("italic")) result = `*${result}*`;
  if (marks.includes("bold")) result = `**${result}**`;
  return result;
}

/** tiptap 的 mark 名称与本模型的映射；未识别的 mark（如 link）在扁平化时丢弃。 */
export function promptMarkFromTiptapName(name: string): PromptInlineMark | null {
  return INLINE_MARK_SET.has(name) ? (name as PromptInlineMark) : null;
}
