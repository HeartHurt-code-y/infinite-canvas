import type { PromptContentDocumentV1, PromptContentItem, PromptContentMediaReferenceItem } from "./promptContent";

/** 将生成正文里的已知引用放回原位置；不让自动识别再追加一份旧引用。 */
export function rewriteVideoPrompt(source: PromptContentDocumentV1, text: string): PromptContentDocumentV1 {
  const references = source.items.filter((item): item is PromptContentMediaReferenceItem => item.kind === "media_reference");
  const identity = (item: PromptContentMediaReferenceItem) => JSON.stringify([item.canvasNodeKey, item.target]);
  const tokens = new Map<string, PromptContentMediaReferenceItem | null>();
  for (const item of references) {
    for (const name of [item.displayNameSnapshot, item.aliasSnapshot]) {
      if (!name) continue;
      const token = `@${name}`;
      const previous = tokens.get(token);
      tokens.set(token, previous === undefined || (previous && identity(previous) === identity(item)) ? previous ?? item : null);
    }
  }
  const names = [...tokens.keys()].sort((a, b) => b.length - a.length);
  const items: PromptContentItem[] = [];
  const used = new Set<string>();
  const usedIds = new Set<string>();
  let offset = 0;
  if (names.length) {
    const pattern = new RegExp(names.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
    for (const match of text.matchAll(pattern)) {
      const reference = tokens.get(match[0]);
      // 同名异物不猜身份；长文件名的前缀也不视为同一引用。
      if (!reference || /[\w./\\-]/.test(text[match.index + match[0].length] ?? "")) continue;
      if (match.index > offset) items.push({ kind: "text", text: text.slice(offset, match.index) });
      const key = identity(reference);
      const original = references.find(item => identity(item) === key && !usedIds.has(item.mentionId));
      const mentionId = original?.mentionId ?? `mention-${crypto.randomUUID()}`;
      const replacement = { ...reference, mentionId, trailing: false };
      delete replacement.block;
      delete replacement.indent;
      items.push(replacement);
      used.add(key);
      usedIds.add(mentionId);
      offset = match.index + match[0].length;
    }
  }
  if (offset < text.length) items.push({ kind: "text", text: text.slice(offset) });
  // 模型省略的引用、粘贴附件、区域标记仍保留原身份。
  for (const item of source.items) {
    if (item.kind === "media_reference") {
      const key = identity(item);
      if (used.has(key)) continue;
      used.add(key);
    } else if (item.kind !== "attachment" && item.kind !== "mark_reference") continue;
    items.push({ kind: "text", text: "\n" }, { ...item, trailing: true });
  }
  return { schema: "prompt-content", version: 1, items };
}
