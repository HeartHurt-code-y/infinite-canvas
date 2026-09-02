/**
 * 提示词「自动识别素材引用」：把用户粘贴/输入到生成节点提示词里的已连线素材名
 * （完整文件名，或去扩展名后的词干）原位转换成与手动 @ 完全一致的 mention chip。
 *
 * 这是提示内容 module 的 DOM implementation：转换产物与手动 @ 共用同一瞬态
 * 投影（span.mention-chip + data-* dataset），外部调用方只读取 canonical document。
 */

/** @ 引用候选的最小结构（App.tsx 的 MentionCandidate 与之结构兼容）。 */
export interface PromptAutoMentionCandidate {
  readonly canvasNodeKey: string;
  readonly assetId: string;
  readonly providerConnectionId: string;
  readonly source?: "cloud" | "local";
  /**
   * 媒体引用的后端类型。旧候选未保存该字段时仍按 asset/local_asset 解释；
   * 生成产物使用 local_result，并额外携带任务与结果下标。
   */
  readonly referenceKind?: "asset" | "local_asset" | "local_result";
  readonly generationTaskId?: string;
  readonly resultIndex?: number;
  readonly kind: "image" | "video" | "audio";
  readonly name: string;
  /** @ 下拉候选缩略图源（可选，UI 用于候选与同名选择器预览）。 */
  readonly previewUrl?: string | null;
}

/** 一条可自动匹配的模式文本（已归一化）及其归属候选下标。 */
export interface AutoMentionPattern {
  readonly text: string;
  readonly candidateIndex: number;
}

/** 自动解析时使用的完整模式：同一文本可指向一个或多个候选实例。 */
export interface AutoMentionResolutionPattern {
  readonly text: string;
  readonly candidateIndexes: readonly number[];
}

/** 每个连线实例的稳定、可见别名（按当前生成节点的同类连线顺序编号）。 */
export interface AutoMentionAlias {
  readonly candidateIndex: number;
  readonly label: string;
}

export interface AutoMentionResolutionResult {
  /** 已精确转换成真实引用的数量。 */
  readonly converted: number;
  /** 本轮新建的待确认引用数量。 */
  readonly ambiguous: number;
  /** 编辑器内仍待确认的引用总数。 */
  readonly pending: number;
}

/** 手输场景的防抖等待毫秒数：足够避开连续键入，又能在停顿后快速给出反馈。 */
export const AUTO_DETECT_DEBOUNCE_MS = 420;

/** 新转换 chip 高亮动画的展示时长毫秒数。 */
export const AUTO_MENTION_FRESH_MS = 2200;

const WORDISH_PATTERN = /[a-z0-9._-]/i;

export function normalizeAutoMentionText(value: string): string {
  return value.trim().toLowerCase().replaceAll(/\s+/g, " ");
}

/** 去掉最后一个扩展名的词干；无名干或过短时返回 null。 */
export function assetNameStem(name: string): string | null {
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex <= 0) return null;
  const stem = normalizeAutoMentionText(name.slice(0, dotIndex));
  return stem.length >= 2 ? stem : null;
}

function naturalOwnersByText(
  candidates: readonly PromptAutoMentionCandidate[],
): Map<string, Set<number>> {
  const ownersByText = new Map<string, Set<number>>();
  const register = (value: string, candidateIndex: number) => {
    const normalized = normalizeAutoMentionText(value);
    if (!normalized) return;
    const owners = ownersByText.get(normalized) ?? new Set<number>();
    owners.add(candidateIndex);
    ownersByText.set(normalized, owners);
  };
  candidates.forEach((candidate, index) => {
    register(candidate.name, index);
    const stem = assetNameStem(candidate.name);
    if (stem != null) register(stem, index);
  });
  return ownersByText;
}

const AUTO_ALIAS_KIND_LABEL: Readonly<Record<string, string>> = {
  image: "图片",
  video: "视频",
  audio: "音频",
};

/** 参考语义别名：与主别名（图片1…）并列的「参考图N」等写法，同样可直接绑定素材。 */
const AUTO_ALIAS_REFERENCE_KIND_LABEL: Readonly<Record<string, string>> = {
  image: "参考图",
  video: "参考视频",
  audio: "参考音频",
};

/** 单个候选构建出的全部别名：主别名（图片1…）+ 参考变体（参考图1…）。 */
interface AutoMentionAliasRecord {
  readonly candidateIndex: number;
  readonly label: string;
  readonly referenceLabel: string;
}

function buildAutoMentionAliasRecords(
  candidates: readonly PromptAutoMentionCandidate[],
): AutoMentionAliasRecord[] {
  const counts = new Map<string, number>();
  const naturalOwners = naturalOwnersByText(candidates);
  const usedAliases = new Set<string>();
  const uniqueLabel = (base: string, candidateIndex: number): string => {
    let label = base;
    let suffix = 1;
    // 别名是用户可以手写的语法，不能与另一素材的真实名称或其他别名冲突。
    // 常规情况仍保持简洁的“图片1”；只有撞名时才追加可读后缀。
    while (
      usedAliases.has(normalizeAutoMentionText(label)) ||
      [...(naturalOwners.get(normalizeAutoMentionText(label)) ?? [])].some(
        (owner) => owner !== candidateIndex,
      )
    ) {
      suffix += 1;
      label = `${base}·实例${suffix}`;
    }
    usedAliases.add(normalizeAutoMentionText(label));
    return label;
  };
  return candidates.map((candidate, candidateIndex) => {
    const ordinal = (counts.get(candidate.kind) ?? 0) + 1;
    counts.set(candidate.kind, ordinal);
    const label = uniqueLabel(
      `${AUTO_ALIAS_KIND_LABEL[candidate.kind] ?? "素材"}${ordinal}`,
      candidateIndex,
    );
    const referenceLabel = uniqueLabel(
      `${AUTO_ALIAS_REFERENCE_KIND_LABEL[candidate.kind] ?? "参考素材"}${ordinal}`,
      candidateIndex,
    );
    return { candidateIndex, label, referenceLabel };
  });
}

/**
 * 为候选生成「图片1 / 视频2」形式的确定性别名。
 * 编号只取决于当前生成节点同类连线顺序，和候选实例 key 一一对应。
 */
export function buildAutoMentionAliases(
  candidates: readonly PromptAutoMentionCandidate[],
): AutoMentionAlias[] {
  return buildAutoMentionAliasRecords(candidates).map(({ candidateIndex, label }) => ({
    candidateIndex,
    label,
  }));
}

/** 返回候选在当前连线集合里的稳定别名。 */
export function autoMentionAliasForCandidate(
  candidates: readonly PromptAutoMentionCandidate[],
  candidateIndex: number,
): string {
  return buildAutoMentionAliases(candidates)[candidateIndex]?.label ?? `素材${candidateIndex + 1}`;
}

/**
 * 把稳定别名（图片1 / 视频2…）与参考变体（参考图1…）注册进模式集合。
 * 别名对所有候选都生效，与 UI「可识别名称」提示保持一致：
 * 输入别名即可直接绑定素材，而不只是同名冲突时的消歧工具。
 * buildAutoMentionAliasRecords 已保证别名不与真实名称或其他别名冲突。
 */
function registerAutoMentionAliases(
  ownersByText: Map<string, Set<number>>,
  candidates: readonly PromptAutoMentionCandidate[],
): void {
  for (const record of buildAutoMentionAliasRecords(candidates)) {
    for (const label of [record.label, record.referenceLabel]) {
      const normalized = normalizeAutoMentionText(label);
      const owners = ownersByText.get(normalized) ?? new Set<number>();
      owners.add(record.candidateIndex);
      ownersByText.set(normalized, owners);
    }
  }
}

/**
 * 由候选素材构建自动匹配模式库：
 * - 每个候选产出「完整名 + 词干」两条模式，另加稳定别名（图片1…）；
 * - 归一化后重复出现的模式视为歧义（同素材重名/词干与他素材同名），剔除，
 *   避免自动引用插错对象（手动 @ 下拉仍可用）；
 * - 返回按长度降序排列的模式列表，供最长优先扫描。
 */
export function buildAutoMentionPatterns(
  candidates: readonly PromptAutoMentionCandidate[],
): AutoMentionPattern[] {
  const ownersByText = naturalOwnersByText(candidates);
  registerAutoMentionAliases(ownersByText, candidates);
  const patterns: AutoMentionPattern[] = [];
  for (const [text, owners] of ownersByText) {
    if (owners.size !== 1) continue;
    patterns.push({ text, candidateIndex: owners.values().next().value! });
  }
  return patterns.sort((a, b) => b.text.length - a.text.length);
}

/**
 * 统计无法安全自动绑定的歧义名称数量。
 * 同一个名称/词干只要同时属于多个画布实例，就必须留给用户通过 @ 候选明确选择。
 */
export function countAmbiguousAutoMentionPatterns(
  candidates: readonly PromptAutoMentionCandidate[],
): number {
  const ownersByText = naturalOwnersByText(candidates);
  return [...ownersByText.values()].filter((owners) => owners.size > 1).length;
}

/**
 * 构建完整自动解析模式：
 * - 自然名称/词干保留全部 owner，同名时进入待确认态；
 * - 所有候选都注册「图片1」等唯一别名，输入别名可直接绑定对应实例；
 * - 已确认映射优先把歧义自然名称收敛到一个仍在线的实例。
 */
export function buildAutoMentionResolutionPatterns(
  candidates: readonly PromptAutoMentionCandidate[],
  learnedMappings: ReadonlyMap<string, string> = new Map(),
): AutoMentionResolutionPattern[] {
  const ownersByText = naturalOwnersByText(candidates);
  registerAutoMentionAliases(ownersByText, candidates);

  const candidateIndexByKey = new Map(
    candidates.map((candidate, index) => [candidate.canvasNodeKey, index] as const),
  );
  const patterns: AutoMentionResolutionPattern[] = [];
  ownersByText.forEach((owners, text) => {
    const learnedKey = learnedMappings.get(text);
    const learnedIndex = learnedKey == null ? undefined : candidateIndexByKey.get(learnedKey);
    patterns.push({
      text,
      candidateIndexes:
        learnedIndex != null && owners.has(learnedIndex) ? [learnedIndex] : [...owners],
    });
  });
  return patterns.sort((a, b) => b.text.length - a.text.length);
}

/** 从已确认 chip 中恢复该输入框的同名选择记忆；冲突记忆会被安全忽略。 */
export function readLearnedAutoMentionMappings(
  input: HTMLElement,
  candidates: readonly PromptAutoMentionCandidate[],
): Map<string, string> {
  const connectedKeys = new Set(candidates.map((candidate) => candidate.canvasNodeKey));
  const values = new Map<string, Set<string>>();
  input.querySelectorAll<HTMLElement>("[data-mention-id][data-auto-pattern]").forEach((chip) => {
    const pattern = normalizeAutoMentionText(chip.dataset["autoPattern"] ?? "");
    const key = chip.dataset["canvasNodeKey"] ?? "";
    if (!pattern || !connectedKeys.has(key)) return;
    const keys = values.get(pattern) ?? new Set<string>();
    keys.add(key);
    values.set(pattern, keys);
  });
  const mappings = new Map<string, string>();
  values.forEach((keys, pattern) => {
    if (keys.size === 1) mappings.set(pattern, keys.values().next().value!);
  });
  return mappings;
}

/** 根据待确认 chip 的归一化模式，返回当前仍在线的候选实例及其下标。 */
export function ambiguousCandidatesForPattern<TCandidate extends PromptAutoMentionCandidate>(
  candidates: readonly TCandidate[],
  pattern: string,
): Array<{ candidate: TCandidate; candidateIndex: number; alias: string }> {
  const normalized = normalizeAutoMentionText(pattern);
  const naturalOwners = naturalOwnersByText(candidates).get(normalized);
  if (naturalOwners == null || naturalOwners.size === 0) return [];
  const aliases = buildAutoMentionAliases(candidates);
  return [...naturalOwners].map((candidateIndex) => ({
    candidate: candidates[candidateIndex]!,
    candidateIndex,
    alias: aliases[candidateIndex]?.label ?? `素材${candidateIndex + 1}`,
  }));
}

/** 模式是否可落在 text[index..]：左右两侧不得紧邻会拼成更长英文词/文件名的字符。 */
function hasWordBoundaries(text: string, start: number, length: number): boolean {
  if (start > 0 && WORDISH_PATTERN.test(text[start - 1]!)) return false;
  const after = start + length;
  if (after < text.length && WORDISH_PATTERN.test(text[after]!)) return false;
  return true;
}

/**
 * 在单段纯文本中寻找不重叠匹配：从左到右扫描，位置命中时取最长可用模式
 * （中文、标点、首尾都算合法边界，防止 "black cat.png" 内误配 "cat.png"）。
 */
export function findMatchesInText(
  text: string,
  patterns: readonly AutoMentionPattern[],
): Array<{ start: number; end: number; patternIndex: number }> {
  if (patterns.length === 0 || !text) return [];
  const lower = text.toLowerCase();
  // 按长度降序扫描取最长命中；patternIndex 始终映射回调用方的原数组下标。
  const sorted = patterns
    .map((pattern, index) => ({ ...pattern, index }))
    .sort((a, b) => b.text.length - a.text.length);
  const matches: Array<{ start: number; end: number; patternIndex: number }> = [];
  let cursor = 0;
  while (cursor < lower.length) {
    let matched = false;
    for (const entry of sorted) {
      if (!lower.startsWith(entry.text, cursor)) continue;
      if (!hasWordBoundaries(lower, cursor, entry.text.length)) continue;
      matches.push({
        start: cursor,
        end: cursor + entry.text.length,
        patternIndex: entry.index,
      });
      cursor += entry.text.length;
      matched = true;
      break;
    }
    if (!matched) cursor += 1;
  }
  return matches;
}

/**
 * 创建与手动 @ 插入完全一致的引用 chip 元素。
 * `fresh` 为 true 时附加一次性高亮动画类并标记 data-auto，提示这是自动识别结果。
 */
export function createMentionChipElement(
  candidate: PromptAutoMentionCandidate,
  options?: { fresh?: boolean; learnedPattern?: string; alias?: string },
): HTMLSpanElement {
  const chip = document.createElement("span");
  chip.contentEditable = "false";
  chip.className = options?.fresh ? "mention-chip is-fresh" : "mention-chip";
  // 与 App.tsx 的 mentionId() 同格式：提交后作为 mentionId 冻结进任务。
  chip.dataset["mentionId"] = `mention-${globalThis.crypto.randomUUID()}`;
  chip.dataset["assetId"] = candidate.assetId;
  chip.dataset["providerId"] = candidate.providerConnectionId;
  chip.dataset["assetSource"] = candidate.source ?? "cloud";
  if (candidate.referenceKind) chip.dataset["referenceKind"] = candidate.referenceKind;
  if (candidate.generationTaskId) {
    chip.dataset["generationTaskId"] = candidate.generationTaskId;
  }
  if (candidate.resultIndex != null) chip.dataset["resultIndex"] = String(candidate.resultIndex);
  chip.dataset["mediaKind"] = candidate.kind;
  chip.dataset["displayName"] = candidate.name;
  chip.dataset["canvasNodeKey"] = candidate.canvasNodeKey;
  if (options?.fresh) chip.dataset["auto"] = "true";
  if (options?.learnedPattern) {
    chip.dataset["autoPattern"] = normalizeAutoMentionText(options.learnedPattern);
  }
  if (options?.alias) chip.dataset["autoAlias"] = options.alias;
  chip.textContent = `@${candidate.name}${options?.alias ? ` · ${options.alias}` : ""}`;
  chip.title = `${candidate.name}${options?.alias ? ` · ${options.alias}` : ""} · ${candidate.assetId} · ${candidate.canvasNodeKey}`;
  return chip;
}

/** 创建不可提交、可聚焦的同名待确认 chip。 */
export function createAmbiguousMentionChipElement(
  matchedText: string,
  normalizedPattern: string,
  candidateCount: number,
): HTMLSpanElement {
  const chip = document.createElement("span");
  chip.contentEditable = "false";
  chip.className = "mention-chip mention-chip--ambiguous";
  chip.dataset["ambiguousPattern"] = normalizeAutoMentionText(normalizedPattern);
  chip.dataset["displayName"] = matchedText;
  chip.dataset["candidateCount"] = String(candidateCount);
  chip.setAttribute("role", "button");
  chip.tabIndex = 0;
  chip.setAttribute(
    "aria-label",
    `${matchedText} 有 ${candidateCount} 个同名素材，按回车选择具体对象`,
  );
  chip.textContent = `@${matchedText} · 待确认`;
  chip.title = `找到 ${candidateCount} 个同名素材，点击选择具体对象`;
  return chip;
}

/** 在既有 chip 上解除新转换高亮（配合 CSS 动画使用）。 */
export function clearFreshMark(chip: HTMLElement): void {
  chip.classList.remove("is-fresh");
  delete chip.dataset["auto"];
}

/** 断线灰化态的样式类（CSS：.mention-chip.is-stale）。 */
export const MENTION_STALE_CLASS = "is-stale";

/**
 * 依据当前已连线实例 key 集合同步引用 chip 的断线灰化态：
 * 不在连线集合中的 chip 加 is-stale 并更新 title 提示，恢复连线后还原。
 * 只切换展示态——引用数据保留，提交校验仍走既有「已断开」报错路径。
 */
export function markStaleMentionChips(
  input: HTMLElement,
  connectedKeys: ReadonlySet<string>,
): void {
  const chips = input.querySelectorAll<HTMLElement>("[data-mention-id]");
  chips.forEach((chip) => {
    const key = chip.dataset["canvasNodeKey"] ?? "";
    if (!connectedKeys.has(key)) {
      if (chip.classList.contains(MENTION_STALE_CLASS)) return;
      chip.classList.add(MENTION_STALE_CLASS);
      chip.title = `已断开连线 · ${chip.dataset["displayName"] ?? ""} · ${chip.dataset["assetId"] ?? ""} · ${key}`;
      return;
    }
    if (!chip.classList.contains(MENTION_STALE_CLASS)) return;
    // 还原为 createMentionChipElement 的标准 title 格式。
    chip.classList.remove(MENTION_STALE_CLASS);
    chip.title = `${chip.dataset["displayName"] ?? ""} · ${chip.dataset["assetId"] ?? ""} · ${key}`;
  });
}

interface ReplaceTextOptions {
  readonly fresh?: boolean;
  readonly createAmbiguous?: boolean;
  readonly learnedMappings?: ReadonlyMap<string, string>;
}

function replacePlainTextMatches(
  input: HTMLElement,
  candidates: readonly PromptAutoMentionCandidate[],
  patterns: readonly AutoMentionResolutionPattern[],
  options?: ReplaceTextOptions,
): AutoMentionResolutionResult {
  if (patterns.length === 0) {
    return {
      converted: 0,
      ambiguous: 0,
      pending: input.querySelectorAll("[data-ambiguous-pattern]").length,
    };
  }
  const doc = input.ownerDocument ?? document;
  input.normalize();
  const selection = doc.defaultView?.getSelection() ?? null;
  let caretMarker: HTMLSpanElement | null = null;

  if (selection != null && selection.rangeCount > 0) {
    const activeRange = selection.getRangeAt(0);
    if (activeRange.collapsed && input.contains(activeRange.startContainer)) {
      caretMarker = doc.createElement("span");
      caretMarker.dataset["autoMentionCaret"] = "true";
      caretMarker.setAttribute("aria-hidden", "true");
      activeRange.cloneRange().insertNode(caretMarker);
    }
  }

  const finderPatterns: AutoMentionPattern[] = patterns.map((pattern, index) => ({
    text: pattern.text,
    candidateIndex: index,
  }));
  const aliases = buildAutoMentionAliases(candidates);
  const walker = doc.createTreeWalker(input, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (node.parentElement?.closest("[data-mention-id], [data-ambiguous-pattern]") != null)
      continue;
    if (node.data) targets.push(node);
  }

  let converted = 0;
  let ambiguous = 0;
  for (const node of targets) {
    const matches = findMatchesInText(node.data, finderPatterns);
    for (let index = matches.length - 1; index >= 0; index -= 1) {
      const match = matches[index]!;
      const pattern = patterns[matches[index]!.patternIndex]!;
      const matchedText = node.data.slice(match.start, match.end);
      let rangeStartNode: Text = node;
      let rangeStartOffset = match.start;
      if (match.start > 0 && node.data[match.start - 1] === "@") {
        rangeStartOffset = match.start - 1;
      } else if (match.start === 0) {
        // 命中在独立文本节点开头时，@ 可能落在前一个兄弟文本节点里
        // （手打 @ 后 IME 输入中文、Tiptap 将两者拆成相邻文本节点的结构）。
        const previous = node.previousSibling;
        if (
          previous instanceof Text &&
          previous.data.length > 0 &&
          previous.data.endsWith("@") &&
          previous.parentElement?.closest("[data-mention-id], [data-ambiguous-pattern]") == null
        ) {
          rangeStartNode = previous;
          rangeStartOffset = previous.data.length - 1;
        }
      }
      const range = doc.createRange();
      range.setStart(rangeStartNode, rangeStartOffset);
      range.setEnd(node, match.end);

      let replacement: HTMLSpanElement | null = null;
      if (pattern.candidateIndexes.length === 1) {
        const candidateIndex = pattern.candidateIndexes[0]!;
        const learned = options?.learnedMappings?.has(pattern.text) ?? false;
        const aliasLabel = aliases[candidateIndex]?.label;
        const matchedAlias =
          aliasLabel != null && pattern.text === normalizeAutoMentionText(aliasLabel);
        replacement = createMentionChipElement(candidates[candidateIndex]!, {
          ...(options?.fresh != null ? { fresh: options.fresh } : {}),
          ...(learned ? { learnedPattern: pattern.text } : {}),
          ...(aliasLabel != null && (learned || matchedAlias) ? { alias: aliasLabel } : {}),
        });
        converted += 1;
      } else if (options?.createAmbiguous && pattern.candidateIndexes.length > 1) {
        replacement = createAmbiguousMentionChipElement(
          matchedText,
          pattern.text,
          pattern.candidateIndexes.length,
        );
        ambiguous += 1;
      }
      if (replacement == null) continue;

      range.deleteContents();
      range.insertNode(replacement);
      replacement.after(doc.createTextNode("\u200b"));
      if (options?.fresh && replacement.dataset["mentionId"]) {
        window.setTimeout(() => clearFreshMark(replacement), AUTO_MENTION_FRESH_MS);
      }
    }
  }

  if (caretMarker?.parentNode != null && selection != null) {
    const parent = caretMarker.parentNode;
    const markerIndex = Array.prototype.indexOf.call(parent.childNodes, caretMarker);
    caretMarker.remove();
    const restoredRange = doc.createRange();
    restoredRange.setStart(parent, Math.min(markerIndex, parent.childNodes.length));
    restoredRange.collapse(true);
    selection.removeAllRanges();
    selection.addRange(restoredRange);
  } else {
    caretMarker?.remove();
  }
  return {
    converted,
    ambiguous,
    pending: input.querySelectorAll("[data-ambiguous-pattern]").length,
  };
}

/**
 * 完整自动解析入口：唯一名称直接引用；同名名称变成待确认 chip；已确认映射自动沿用。
 */
export function resolvePromptAutoMentions(
  input: HTMLElement,
  candidates: readonly PromptAutoMentionCandidate[],
  options?: { fresh?: boolean },
): AutoMentionResolutionResult {
  const learnedMappings = readLearnedAutoMentionMappings(input, candidates);
  const patterns = buildAutoMentionResolutionPatterns(candidates, learnedMappings);
  return replacePlainTextMatches(input, candidates, patterns, {
    ...(options?.fresh != null ? { fresh: options.fresh } : {}),
    createAmbiguous: true,
    learnedMappings,
  });
}

/**
 * 确认一个同名对象，并一次性替换当前提示词中相同模式的全部待确认项。
 * chip 的 data-auto-pattern 会被提示内容 adapter 收回 canonical reference，
 * 因而可随结构化文档往返并指导后续自动解析。
 */
export function confirmAmbiguousMentionChips(
  input: HTMLElement,
  pattern: string,
  candidate: PromptAutoMentionCandidate,
  alias: string,
): number {
  const normalized = normalizeAutoMentionText(pattern);
  const pending = Array.from(
    input.querySelectorAll<HTMLElement>("[data-ambiguous-pattern]"),
  ).filter((chip) => chip.dataset["ambiguousPattern"] === normalized);
  pending.forEach((chip) => {
    const confirmed = createMentionChipElement(candidate, {
      fresh: true,
      learnedPattern: normalized,
      alias,
    });
    chip.replaceWith(confirmed);
    window.setTimeout(() => clearFreshMark(confirmed), AUTO_MENTION_FRESH_MS);
  });
  return pending.length;
}

/**
 * 把 input 子树中的纯文本命中段原地替换为引用 chip。
 * 已有 chip 内的文字天然跳过（TreeWalker 过滤 [data-mention-id] 子树）。
 * 返回转换数量。
 */
export function convertPlainTextToMentionChips(
  input: HTMLElement,
  candidates: readonly PromptAutoMentionCandidate[],
  options?: { fresh?: boolean },
): number {
  const patterns = buildAutoMentionPatterns(candidates);
  return replacePlainTextMatches(
    input,
    candidates,
    patterns.map((pattern) => ({ text: pattern.text, candidateIndexes: [pattern.candidateIndex] })),
    options,
  ).converted;
}

/**
 * 以纯文本形式把 text 插入光标处（无有效光标时追加到末尾），
 * 换行转 <br>。替代浏览器默认粘贴，避免富文本 HTML 混入提示词。
 */
export function insertPlainTextAtSelection(input: HTMLElement, text: string): void {
  const doc = input.ownerDocument ?? document;
  const selection = doc.defaultView?.getSelection() ?? null;
  let range: Range | null = null;
  if (selection != null && selection.rangeCount > 0) {
    const existing = selection.getRangeAt(0);
    if (input.contains(existing.startContainer)) range = existing.cloneRange();
  }
  if (range == null) {
    range = doc.createRange();
    range.selectNodeContents(input);
    range.collapse(false);
  } else {
    range.deleteContents();
  }

  const lines = text.split(/\r\n|\r|\n/);
  lines.forEach((line, lineIndex) => {
    if (lineIndex > 0) {
      const br = doc.createElement("br");
      range.insertNode(br);
      range.setStartAfter(br);
      range.collapse(true);
    }
    if (line) {
      const textNode = doc.createTextNode(line);
      range.insertNode(textNode);
      range.setStartAfter(textNode);
      range.collapse(true);
    }
  });

  selection?.removeAllRanges();
  selection?.addRange(range);
}
