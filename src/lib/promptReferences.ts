import type { MediaReferenceTarget } from "./backend";
import type {
  PromptContentDocumentV1,
  PromptContentItem,
  PromptContentMediaReferenceItem,
} from "./promptContent";

/** 引用规则只处理候选和 canonical document，不读取编辑器 DOM。 */
export interface PromptReferenceCandidate {
  readonly canvasNodeKey: string;
  readonly assetId: string;
  readonly providerConnectionId: string;
  readonly source?: "cloud" | "local";
  readonly referenceKind?: "asset" | "local_asset" | "local_result" | "local_file";
  readonly generationTaskId?: string;
  readonly resultIndex?: number;
  readonly kind: "image" | "video" | "audio";
  readonly name: string;
  readonly previewUrl?: string | null;
}

export interface PromptReferencePattern {
  readonly text: string;
  readonly candidateIndexes: readonly number[];
}

export interface PromptReferenceAlias {
  readonly candidateIndex: number;
  readonly label: string;
}

export interface PromptReferenceOption<TCandidate extends PromptReferenceCandidate> {
  readonly candidate: TCandidate;
  readonly candidateIndex: number;
  readonly alias: string;
}

export interface PromptReferenceCatalog<TCandidate extends PromptReferenceCandidate> {
  readonly aliases: readonly PromptReferenceAlias[];
  readonly patterns: readonly PromptReferencePattern[];
  readonly ambiguousPatternCount: number;
  options(pattern: string): readonly PromptReferenceOption<TCandidate>[];
  search(query: string): readonly TCandidate[];
}

export interface PromptReferenceResolutionResult {
  readonly document: PromptContentDocumentV1;
  readonly converted: number;
  readonly ambiguous: number;
  readonly pending: number;
  readonly freshMentionIds: readonly string[];
}

const LABELS = {
  image: ["图片", "参考图", "图"],
  video: ["视频", "参考视频", "视"],
  audio: ["音频", "参考音频", "音"],
} as const;
const LINE_BREAK = /[\r\n\u2028\u2029]/u;
const HORIZONTAL_SPACE = /[^\S\r\n\u2028\u2029]/u;
const WORDISH = /[a-z0-9._%+@-]/iu;
const TOKEN_SEPARATOR = /[\s\ufffc<>"'()[\]{},;，。！？；（）【】、]/u;

interface NormalizedText {
  readonly text: string;
  /** 每个归一化 UTF-16 单元对应的原文范围，大小写扩展与空白折叠均不会改错偏移。 */
  readonly starts: readonly number[];
  readonly ends: readonly number[];
}

function normalizedText(value: string): NormalizedText {
  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    const start = cursor;
    const codePoint = value.codePointAt(cursor)!;
    const character = String.fromCodePoint(codePoint);
    cursor += character.length;
    let normalized = character.toLowerCase();
    if (HORIZONTAL_SPACE.test(character)) {
      while (cursor < value.length && HORIZONTAL_SPACE.test(value[cursor]!)) cursor += 1;
      normalized = " ";
    }
    text += normalized;
    for (let index = 0; index < normalized.length; index += 1) {
      starts.push(start);
      ends.push(cursor);
    }
  }
  return { text, starts, ends };
}

/** 词典、搜索和正文使用相同归一化；换行始终是引用的边界。 */
export function normalizePromptReferenceText(value: string): string {
  return normalizedText(value.trim()).text;
}

function nameStem(name: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  const stem = normalizePromptReferenceText(name.slice(0, dot));
  return stem.length >= 2 ? stem : null;
}

/** 编号只取决于同类连线顺序；自然名撞上编号也保留歧义，不另造隐藏优先级。 */
export function buildReferenceCatalog<TCandidate extends PromptReferenceCandidate>(
  candidates: readonly TCandidate[],
): PromptReferenceCatalog<TCandidate> {
  const owners = new Map<string, Set<number>>();
  const counts = new Map<PromptReferenceCandidate["kind"], number>();
  const aliases: PromptReferenceAlias[] = [];
  const register = (value: string, index: number) => {
    const text = normalizePromptReferenceText(value);
    if (!text || LINE_BREAK.test(text)) return;
    const indexes = owners.get(text) ?? new Set<number>();
    indexes.add(index);
    owners.set(text, indexes);
  };
  candidates.forEach((candidate, candidateIndex) => {
    register(candidate.name, candidateIndex);
    const stem = nameStem(candidate.name);
    if (stem != null) register(stem, candidateIndex);
    const ordinal = (counts.get(candidate.kind) ?? 0) + 1;
    counts.set(candidate.kind, ordinal);
    const labels = LABELS[candidate.kind];
    aliases.push({ candidateIndex, label: `${labels[0]}${ordinal}` });
    for (const label of labels) register(`${label}${ordinal}`, candidateIndex);
  });
  const patterns: PromptReferencePattern[] = [...owners].map(([text, indexes]) => ({
    text,
    candidateIndexes: [...indexes],
  }));
  patterns.sort((first, second) => second.text.length - first.text.length);
  return {
    aliases,
    patterns,
    ambiguousPatternCount: patterns.filter((pattern) => pattern.candidateIndexes.length > 1).length,
    options(pattern) {
      const indexes = owners.get(normalizePromptReferenceText(pattern)) ?? [];
      return [...indexes].map((candidateIndex) => ({
        candidate: candidates[candidateIndex]!,
        candidateIndex,
        alias: aliases[candidateIndex]!.label,
      }));
    },
    search(query) {
      const normalized = normalizePromptReferenceText(query).replace(/^@/u, "");
      if (!normalized) return [...candidates];
      const indexes = new Set(
        patterns
          .filter((pattern) => pattern.text.includes(normalized))
          .flatMap((pattern) => pattern.candidateIndexes),
      );
      return candidates.filter(
        (candidate, index) =>
          indexes.has(index) ||
          normalizePromptReferenceText(candidate.assetId).includes(normalized) ||
          normalizePromptReferenceText(candidate.canvasNodeKey).includes(normalized),
      );
    },
  };
}

/** 手动选择与文字识别均通过这个工厂生成同一来源身份。 */
export function candidateTarget(candidate: PromptReferenceCandidate): MediaReferenceTarget {
  const identity = { canvasNodeKey: candidate.canvasNodeKey, mediaType: candidate.kind };
  const kind = candidate.referenceKind ?? (candidate.source === "local" ? "local_asset" : "asset");
  switch (kind) {
    case "local_file":
      return { kind, path: candidate.assetId, ...identity };
    case "local_result":
      return {
        kind,
        generationTaskId: candidate.generationTaskId ?? "",
        resultIndex: candidate.resultIndex ?? 0,
        ...identity,
      };
    case "local_asset":
      return { kind, stagingJobId: candidate.assetId, ...identity };
    case "asset":
      return {
        kind,
        providerConnectionId: candidate.providerConnectionId,
        assetId: candidate.assetId,
        ...identity,
      };
  }
}

/** 将业务连线转换成统一候选；来源身份来自 target，画布实例来自调用方的连接 key。 */
export function referenceCandidateFromTarget(input: {
  readonly canvasNodeKey: string;
  readonly target: MediaReferenceTarget;
  readonly name: string;
  readonly previewUrl?: string | null;
}): PromptReferenceCandidate {
  const { target } = input;
  const shared = {
    canvasNodeKey: input.canvasNodeKey,
    name: input.name,
    kind: target.mediaType,
    referenceKind: target.kind,
    source: target.kind === "asset" ? ("cloud" as const) : ("local" as const),
    providerConnectionId: target.kind === "asset" ? target.providerConnectionId : "",
    ...(input.previewUrl !== undefined ? { previewUrl: input.previewUrl } : {}),
  };
  switch (target.kind) {
    case "asset":
      return { ...shared, assetId: target.assetId };
    case "local_asset":
      return { ...shared, assetId: target.stagingJobId };
    case "local_file":
      return { ...shared, assetId: target.path };
    case "local_result":
      return {
        ...shared,
        assetId: `${target.generationTaskId}#${target.resultIndex}`,
        generationTaskId: target.generationTaskId,
        resultIndex: target.resultIndex,
      };
  }
}

export function createPromptReference(
  candidate: PromptReferenceCandidate,
  options?: { readonly alias?: string },
): PromptContentMediaReferenceItem {
  return {
    kind: "media_reference",
    mentionId: `mention-${globalThis.crypto.randomUUID()}`,
    canvasNodeKey: candidate.canvasNodeKey,
    target: candidateTarget(candidate),
    displayNameSnapshot: candidate.name,
    ...(options?.alias ? { aliasSnapshot: options.alias } : {}),
  };
}

function appendText(items: PromptContentItem[], text: string): void {
  if (!text) return;
  const previous = items.at(-1);
  if (previous?.kind === "text")
    items[items.length - 1] = { kind: "text", text: previous.text + text };
  else items.push({ kind: "text", text });
}

function safeMatchBoundary(text: string, start: number, end: number, explicit: boolean): boolean {
  const before = text[start - 1];
  const after = text[end];
  if (before != null && (WORDISH.test(before) || before === "/" || before === "\\")) return false;
  if (after != null && (WORDISH.test(after) || after === "/" || after === "\\")) return false;
  let tokenStart = start;
  let tokenEnd = end;
  while (tokenStart > 0 && !TOKEN_SEPARATOR.test(text[tokenStart - 1]!)) tokenStart -= 1;
  while (tokenEnd < text.length && !TOKEN_SEPARATOR.test(text[tokenEnd]!)) tokenEnd += 1;
  const token = text.slice(tokenStart, tokenEnd);
  // URL/path 中即使 @ 前是 ? 或 = 也不作为引用；未知 @ 的内部不再进行裸名称识别。
  if (/[\\/]/u.test(token) || /[a-z0-9._%+-]@/iu.test(token)) return false;
  if (!explicit && text.slice(tokenStart, start).includes("@")) return false;
  return true;
}

/** 编辑器将当前文字块传进来，使用与解析器相同的 @ 边界读取光标查询。 */
export function referenceQueryInText(
  prefix: string,
): { readonly query: string; readonly start: number } | null {
  const start = prefix.lastIndexOf("@");
  if (start < 0) return null;
  const query = prefix.slice(start + 1);
  if (LINE_BREAK.test(query) || query.includes("\ufffc")) return null;
  if (!safeMatchBoundary(prefix, start, prefix.length, true)) return null;
  return { query, start };
}

/**
 * explicit 是输入/粘贴默认模式；names 仅供用户主动要求批量识别裸名称时使用。
 * 已有 media/pending 项是明确的文档状态，不根据历史选择或连线变化重新猜测绑定。
 */
export function resolvePromptReferences(
  document: PromptContentDocumentV1,
  candidates: readonly PromptReferenceCandidate[],
  options: { readonly mode: "explicit" | "names" },
): PromptReferenceResolutionResult {
  const catalog = buildReferenceCatalog(candidates);
  const merged: PromptContentItem[] = [];
  for (const item of document.items) {
    if (item.kind === "text") appendText(merged, item.text);
    else merged.push(item);
  }
  const items: PromptContentItem[] = [];
  const freshMentionIds: string[] = [];
  let ambiguous = 0;
  for (const item of merged) {
    if (item.kind !== "text") {
      items.push(item);
      continue;
    }
    const normalized = normalizedText(item.text);
    let cursor = 0;
    let copiedUntil = 0;
    while (cursor < normalized.text.length) {
      const explicit = normalized.text[cursor] === "@";
      const patternStart = cursor + (explicit ? 1 : 0);
      const pattern =
        explicit || options.mode === "names"
          ? catalog.patterns.find((entry) => {
              const end = patternStart + entry.text.length;
              return (
                normalized.text.startsWith(entry.text, patternStart) &&
                // 不允许从一个扩展为多 UTF-16 单元的大小写字符中间截断。
                normalized.starts[cursor] !== normalized.starts[cursor - 1] &&
                normalized.ends[end - 1] !== normalized.ends[end] &&
                safeMatchBoundary(normalized.text, cursor, end, explicit)
              );
            })
          : undefined;
      if (pattern == null) {
        cursor += 1;
        continue;
      }
      const end = patternStart + pattern.text.length;
      const sourceStart = normalized.starts[cursor]!;
      const sourceEnd = normalized.ends[end - 1]!;
      appendText(items, item.text.slice(copiedUntil, sourceStart));
      if (pattern.candidateIndexes.length === 1) {
        const candidateIndex = pattern.candidateIndexes[0]!;
        const candidate = candidates[candidateIndex]!;
        const alias =
          catalog.options(candidate.name).length > 1
            ? catalog.aliases[candidateIndex]!.label
            : undefined;
        const reference = createPromptReference(candidate, alias ? { alias } : undefined);
        items.push(reference);
        freshMentionIds.push(reference.mentionId);
      } else {
        items.push({
          kind: "pending_reference",
          normalizedPattern: pattern.text,
          displayText: item.text.slice(normalized.starts[patternStart], sourceEnd),
          candidateCount: pattern.candidateIndexes.length,
        });
        ambiguous += 1;
      }
      copiedUntil = sourceEnd;
      cursor = end;
    }
    appendText(items, item.text.slice(copiedUntil));
  }
  return {
    document: { schema: "prompt-content", version: 1, items },
    converted: freshMentionIds.length,
    ambiguous,
    pending: items.filter((item) => item.kind === "pending_reference").length,
    freshMentionIds,
  };
}
