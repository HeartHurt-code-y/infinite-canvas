import type { MediaType } from "./backend";
import { createPromptReference, type PromptReferenceCandidate } from "./promptReferences";
// 文档形状只做类型引用；运行时依赖保持单向（promptContent → promptOrdinalMentions）。
import type { PromptContentDocumentV1, PromptContentItem } from "./promptContent";

/**
 * 位置序号引用的识别。
 *
 * 生成节点的参考素材清单逐行标出提交序号（即请求体里的「图片N」），用户因此天然用
 * 「图2」「参考图2」「第二张」这样的位置词写提示词，而不是素材文件名——云端素材名常常是
 * 「微信图片_2026091712222_746_208」这类随机串，正文里根本不会出现。
 *
 * 这里按候选顺序把位置词解析回具体候选：序号与清单行号、@ 别名、请求体编号同源。
 * 用户主动重扫时，能确定序号的位置词替换成一条绑定到该素材的引用（素材以后被换掉也不会
 * 让这处指代漂移）；读不出序号的（「以第一张为准」）与超出已连接数量的（正文写「图3」
 * 但只连了 2 张）保持原样，只作为提示回报给用户，不做静默改写。
 */

/** 关键词 → 序号标签词。左列写在正文里，右列是展示标签："图2" 与 "素材2" 指同一份输入。 */
const KEYWORD_LABELS: readonly (readonly [readonly string[], string])[] = [
  [["参考图", "图片", "图"], "图"],
  [["参考视频", "视频"], "视频"],
  [["参考音频", "音频"], "音频"],
  [["参考素材", "素材"], "素材"],
];
const KEYWORDS = KEYWORD_LABELS.flatMap(([words]) => words).sort(
  (first, second) => second.length - first.length,
);
const KEYWORD_PATTERN = KEYWORDS.join("|");
/**
 * 序号后面跟着的关键词，长写法优先（「第2张参考图」是参考图，不是「图」）：
 * 锚定式与相对式都用它把类型读出来，否则「第2张」只能猜类型。
 */
const TRAILING_KEYWORD_PATTERN = [...KEYWORDS, "帧"].join("|");

const CN_DIGITS: Readonly<Record<string, number>> = {
  〇: 0,
  零: 0,
  一: 1,
  壹: 1,
  二: 2,
  两: 2,
  贰: 2,
  三: 3,
  叁: 3,
  四: 4,
  肆: 4,
  五: 5,
  伍: 5,
  六: 6,
  陆: 6,
  七: 7,
  柒: 7,
  八: 8,
  捌: 8,
  九: 9,
  玖: 9,
};
const CN_DIGIT_CLASS = Object.keys(CN_DIGITS).join("");
const NUMBER = `\\d{1,2}|[${CN_DIGIT_CLASS}十]{1,3}`;
const COUNTER = "位|个|张|幅|帧|条|段|份|号";

/** 相对位置词：读得出排序意图，读不出确定序号。 */
const RELATIVE_ORDINALS: Readonly<Record<string, "first" | "last">> = {
  第一: "first",
  首个: "first",
  首张: "first",
  最后: "last",
  末尾: "last",
  倒数第一: "last",
};
const RELATIVE_PATTERN = Object.keys(RELATIVE_ORDINALS)
  .sort((first, second) => second.length - first.length)
  .join("|");
/**
 * 相对位置词自带量词才能定出唯一指代：「最后一张图」「第一段视频」。
 * 量词只认这些——「最后一个镜头」的「镜头」不是素材关键词，不能算位置词。
 */
const RELATIVE_QUANTIFIER = "一张|一幅|一帧|一段|一条|一份|一个";

/**
 * 完整语法，三分支合成一条正则（锚定式在前，同一位置只可能命中一个分支）：
 *   锚定式：「第」+ 序号 +（量词）+（关键词）——「第2张图」「第2个参考视频」「第二帧」
 *   关键词式：关键词 + 序号 +（量词）——「图2」「参考图2」「素材2」
 *   相对式：相对位置词 +（量词）+（关键词）——「第一张图」「最后一张参考图」
 * 相对式后面没跟关键词时，紧邻的关键词单独补一次（「以第一张图为准」里的「图」），
 * 补不到就按未绑定提示，不猜指的是哪一类素材。
 */
const MENTION_PATTERN = new RegExp(
  [
    `第(?<anchor>${NUMBER})(?:${COUNTER})?(?<anchorKeyword>${TRAILING_KEYWORD_PATTERN})?`,
    `(?<keyword>${KEYWORD_PATTERN})(?<suffix>${NUMBER})(?:${COUNTER})?`,
    `(?<relative>(?:${RELATIVE_PATTERN})(?:${RELATIVE_QUANTIFIER})?)(?<relativeKeyword>${TRAILING_KEYWORD_PATTERN})?`,
  ].join("|"),
  "gu",
);
/** 紧邻命中区间的关键词（「图」「参考图」）；命中不到说明这段位置词没落到素材上。 */
const TRAILING_KEYWORD_MATCHER = new RegExp(`^(?:${KEYWORD_PATTERN})`);
const TRAILING_KEYWORD_AT = (text: string, at: number): string | undefined =>
  TRAILING_KEYWORD_MATCHER.exec(text.slice(at))?.[0];

/** 识别到但没能绑定的一段位置词。 */
interface RawMatch {
  readonly from: number;
  readonly to: number;
  readonly text: string;
  readonly keyword?: string | undefined;
  readonly kind: MediaType | null;
  /** 1 起；-1 表示「最后一张」这类由候选总数决定的相对位置。 */
  readonly position: number;
}

/** 一段文本里被认定成素材位置词的区间（原文偏移，半开区间）。 */
export interface PromptOrdinalMatch {
  readonly from: number;
  readonly to: number;
  readonly text: string;
  /** 命中的关键词（「图」「参考图」「素材」）；纯相对位置词为空。 */
  readonly keyword?: string | undefined;
  /** 展示标签，与 @ 别名一致：「图2」。 */
  readonly label: string;
  /** 同类序号（1 起）。 */
  readonly position: number;
  readonly candidateIndex: number;
  readonly candidate: PromptReferenceCandidate;
}

/** 正文写了位置词、但读不出确定序号的情形。 */
export interface PromptUnboundMention {
  readonly text: string;
  readonly reason: "relative" | "out-of-range";
  /** 该类型已连接的素材数，用于说明「图3」为什么落空。 */
  readonly candidateCount: number;
}

export interface PromptOrdinalScan {
  readonly matched: readonly PromptOrdinalMatch[];
  readonly unbound: readonly PromptUnboundMention[];
}

export interface PromptOrdinalResolution {
  readonly document: PromptContentDocumentV1;
  readonly freshMentionIds: readonly string[];
  readonly converted: number;
  readonly unbound: readonly PromptUnboundMention[];
}

/** 中文数字（「二十」「十二」「二」）；非数字返回 null。 */
export function chineseNumber(value: string): number | null {
  if (!value || !/^[\u4e00-\u9fff]+$/u.test(value)) return null;
  const ten = value.indexOf("十");
  if (ten < 0) {
    let total = 0;
    for (const character of value) {
      const digit = CN_DIGITS[character];
      if (digit == null) return null;
      total = total * 10 + digit;
    }
    return total > 0 ? total : null;
  }
  const head = ten === 0 ? 1 : (CN_DIGITS[value.slice(0, ten)] ?? 0);
  const tailText = value.slice(ten + 1);
  const tail = tailText ? (CN_DIGITS[tailText] ?? 0) : 0;
  const total = head * 10 + tail;
  return total > 0 ? total : null;
}

/** 序号文本 → 数字：阿拉伯数字直接读，中文数字换算，不合法返回 null。 */
export function ordinalValue(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (/^\d{1,2}$/u.test(trimmed)) {
    const value = Number.parseInt(trimmed, 10);
    return value >= 1 ? value : null;
  }
  return chineseNumber(trimmed);
}

/** 类型标签词：图片类统一说「图」，与 UI 的「图片N」编号同一套。 */
export function labelKeywordFor(kind: MediaType): string {
  return kind === "image" ? "图" : kind === "video" ? "视频" : "音频";
}

function keywordLabel(keyword: string): string {
  return keyword === "参考图" || keyword === "图片" ? "图" : keyword;
}

function kindOfKeyword(keyword: string | undefined): MediaType | null {
  if (keyword == null) return null;
  if (keyword.includes("视频")) return "video";
  if (keyword.includes("音频")) return "audio";
  return "image";
}

/** 每类素材按候选顺序编号，与清单行号、@ 别名编号同源。 */
export function kindOrdinals(
  candidates: readonly PromptReferenceCandidate[],
): ReadonlyMap<MediaType, readonly number[]> {
  const counters = new Map<MediaType, number>();
  const byKind = new Map<MediaType, number[]>();
  candidates.forEach((candidate, index) => {
    const ordinal = (counters.get(candidate.kind) ?? 0) + 1;
    counters.set(candidate.kind, ordinal);
    const indexes = byKind.get(candidate.kind) ?? [];
    indexes.push(index);
    byKind.set(candidate.kind, indexes);
  });
  return byKind;
}

/**
 * 候选在正文里的首选写法：与清单行号和 @ 别名同一套编号（图片1 / 视频2），
 * 因此「文本里写什么」与「请求体里第几个」永远对得上。
 */
export function referenceTokenFor(
  candidates: readonly PromptReferenceCandidate[],
  index: number,
): string {
  const candidate = candidates[index]!;
  const indexes = kindOrdinals(candidates).get(candidate.kind) ?? [];
  const ordinal = indexes.indexOf(index) + 1;
  return `${labelKeywordFor(candidate.kind)}${ordinal > 0 ? ordinal : index + 1}`;
}

/** 序号的右边界：后面紧跟字母数字说明这是另一串编号（「图2026」），不是位置词。 */
function boundaryAfter(text: string, end: number): boolean {
  const after = text[end];
  if (after == null) return true;
  return !/[a-z0-9._%+@\\/-]/iu.test(after);
}

/**
 * 单字关键词（「图」）前紧挨汉字时不成立：那多半是词的一部分，
 * 「图片1」里的「片」不能再被当成关键词。
 */
function boundaryBefore(text: string, start: number, length: number): boolean {
  if (length > 1) return true;
  const before = text[start - 1];
  if (before == null) return true;
  return !/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u.test(before);
}

/** 相对位置词（「最后一张」）→ 排序意图：量词已并入命中区间，这里按前缀查表。 */
function relativeIntentOf(text: string): "first" | "last" | null {
  for (const [word, intent] of Object.entries(RELATIVE_ORDINALS)) {
    if (text.startsWith(word)) return intent;
  }
  return null;
}

function rawMatches(text: string): readonly RawMatch[] {
  const found: RawMatch[] = [];
  MENTION_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MENTION_PATTERN.exec(text)) != null) {
    const groups = match.groups ?? {};
    const from = match.index;
    let to = from + match[0].length;
    const keyword = groups["keyword"] ?? groups["anchorKeyword"] ?? groups["relativeKeyword"];
    if (groups["anchor"] != null) {
      const position = ordinalValue(groups["anchor"]);
      if (position != null) {
        // 「第2张图」：锚定式里的关键词是可选的，命中不到时把紧邻的关键词补进来。
        const trailing = keyword == null ? TRAILING_KEYWORD_AT(text, to) : undefined;
        if (trailing != null) to += trailing.length;
        found.push({
          from,
          to,
          text: text.slice(from, to),
          keyword: keyword ?? trailing ?? undefined,
          kind: kindOfKeyword(keyword ?? trailing ?? undefined),
          position,
        });
      }
      continue;
    }
    if (groups["suffix"] != null && keyword != null) {
      const position = ordinalValue(groups["suffix"]);
      if (position != null)
        found.push({ from, to, text: match[0], keyword, kind: kindOfKeyword(keyword), position });
      continue;
    }
    const relative = groups["relative"];
    if (relative == null) continue;
    const intent = relativeIntentOf(relative);
    if (intent == null) continue;
    // 「以第一张图为准」：相对式没吃下后面的关键词时补进来，用它决定指的是哪类素材。
    const trailing = keyword ?? TRAILING_KEYWORD_AT(text, to);
    if (trailing != null) to += trailing.length;
    // 相对位置词没落到素材上时不猜：交给未绑定提示，由用户决定。
    found.push({
      from,
      to,
      text: text.slice(from, to),
      keyword: trailing,
      kind: kindOfKeyword(trailing),
      position: intent === "first" ? 1 : -1,
    });
  }
  return found;
}

/**
 * 同一位置命中更长的写法时保留长的（「第一张图」胜过「第一张」），
 * 落在已保留区间内部的命中丢弃（「图片1」里的「片」）。
 */
function dropOverlaps(matches: readonly RawMatch[]): readonly RawMatch[] {
  const kept: RawMatch[] = [];
  for (const match of matches) {
    const previous = kept.at(-1);
    if (previous != null && previous.from === match.from) kept[kept.length - 1] = match;
    else if (previous == null || previous.to <= match.from) kept.push(match);
  }
  return kept;
}

/** 候选数量决定「最后一张」指向谁；超出范围时返回 null。 */
function indexAt(
  indexes: readonly number[] | undefined,
  position: number,
): number | null {
  if (indexes == null || indexes.length === 0) return null;
  const ordinal = position === -1 ? indexes.length : position;
  if (ordinal < 1 || ordinal > indexes.length) return null;
  return indexes[ordinal - 1]!;
}

/** 正文里所有可解析的位置词：能绑定的与读不出序号的（未绑定）分开回报。 */
export function scanOrdinalMentions(
  text: string,
  candidates: readonly PromptReferenceCandidate[],
): PromptOrdinalScan {
  const matched: PromptOrdinalMatch[] = [];
  const unbound: PromptUnboundMention[] = [];
  if (text && candidates.length > 0) {
    const byKind = kindOrdinals(candidates);
    for (const raw of dropOverlaps(rawMatches(text))) {
      if (!boundaryBefore(text, raw.from, raw.text.length)) continue;
      if (!boundaryAfter(text, raw.to)) continue;
      if (raw.kind == null) {
        // 「第一张」：读不出类型，归到图片类之外——按当前候选说明它为什么没被绑定。
        unbound.push({ text: raw.text, reason: "relative", candidateCount: candidates.length });
        continue;
      }
      const indexes = byKind.get(raw.kind);
      const candidateIndex = indexAt(indexes, raw.position);
      if (candidateIndex == null) {
        const count = indexes?.length ?? 0;
        unbound.push({
          text: raw.text,
          reason: count === 0 ? "relative" : "out-of-range",
          candidateCount: count,
        });
        continue;
      }
      matched.push({
        from: raw.from,
        to: raw.to,
        text: raw.text,
        ...(raw.keyword != null ? { keyword: raw.keyword } : {}),
        label: `${raw.keyword != null ? keywordLabel(raw.keyword) : labelKeywordFor(raw.kind)}${
          raw.position === -1 ? (indexes?.length ?? 1) : raw.position
        }`,
        position: raw.position === -1 ? (indexes?.length ?? 1) : raw.position,
        candidateIndex,
        candidate: candidates[candidateIndex]!,
      });
    }
  }
  return { matched, unbound: dedupeUnbound(unbound) };
}

/** 同一处写法只提示一次，按出现顺序。 */
function dedupeUnbound(unbound: readonly PromptUnboundMention[]): readonly PromptUnboundMention[] {
  const seen = new Set<string>();
  return unbound.filter((entry) => {
    if (seen.has(entry.text)) return false;
    seen.add(entry.text);
    return true;
  });
}

/** 只取会真正改写正文的位置词（能确定序号的那些）。 */
export function bindableOrdinalMentions(
  text: string,
  candidates: readonly PromptReferenceCandidate[],
): readonly PromptOrdinalMatch[] {
  return scanOrdinalMentions(text, candidates).matched;
}

/**
 * 把正文里能确定序号的位置词替换成引用 chip。
 * 未绑定的位置词原样保留，连同原因一起回报给调用方，由它决定怎么提示。
 * 顺序由扫描结果天然保证：每个位置词的区间互不重叠，替换不会二次扫描到刚插入的引用。
 */
export function resolveOrdinalMentions(
  document: PromptContentDocumentV1,
  candidates: readonly PromptReferenceCandidate[],
): PromptOrdinalResolution {
  if (candidates.length === 0)
    return { document, freshMentionIds: [], converted: 0, unbound: [] };
  const items: PromptContentItem[] = [];
  const freshMentionIds: string[] = [];
  const unbound: PromptUnboundMention[] = [];
  for (const item of document.items) {
    if (item.kind !== "text") {
      items.push(item);
      continue;
    }
    const scan = scanOrdinalMentions(item.text, candidates);
    unbound.push(...scan.unbound);
    let cursor = 0;
    for (const match of scan.matched) {
      if (match.from > cursor) items.push({ kind: "text", text: item.text.slice(cursor, match.from) });
      const reference = createPromptReference(match.candidate, { alias: match.label });
      items.push(reference);
      freshMentionIds.push(reference.mentionId);
      cursor = match.to;
    }
    if (cursor < item.text.length)
      items.push({ kind: "text", text: item.text.slice(cursor) });
  }
  return {
    document: { schema: "prompt-content", version: 1, items },
    freshMentionIds,
    converted: freshMentionIds.length,
    unbound: dedupeUnbound(unbound),
  };
}
