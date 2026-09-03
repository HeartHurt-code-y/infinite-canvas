import { Editor } from "@tiptap/core";
import type { ExplicitMediaInput, MediaReferenceTarget, MediaType, PromptSegment } from "./backend";
import {
  AUTO_DETECT_DEBOUNCE_MS,
  AUTO_MENTION_FRESH_MS,
  ambiguousCandidatesForPattern,
  autoMentionAliasForCandidate,
  buildAutoMentionAliases,
  confirmAmbiguousMentionChips,
  countAmbiguousAutoMentionPatterns,
  createMentionChipElement,
  markStaleMentionChips,
  normalizeAutoMentionText,
  resolvePromptAutoMentions,
  type AutoMentionResolutionResult,
  type PromptAutoMentionCandidate,
} from "./promptAutoMention";
import {
  createPromptTiptapExtensions,
  plainTextToTiptapContent,
  promptDocumentFromTiptapJson,
  promptDocumentToTiptapJson,
  promptReferenceToTiptapNode,
} from "./promptTiptap";

export const PROMPT_AUTO_DETECT_DEBOUNCE_MS = AUTO_DETECT_DEBOUNCE_MS;

export function describePromptContentCandidates(
  candidates: readonly PromptAutoMentionCandidate[],
  ambiguousPattern?: string,
): {
  readonly aliases: readonly { readonly candidateIndex: number; readonly label: string }[];
  readonly ambiguousPatternCount: number;
  readonly ambiguityOptions: ReturnType<typeof ambiguousCandidatesForPattern>;
} {
  return {
    aliases: buildAutoMentionAliases(candidates),
    ambiguousPatternCount: countAmbiguousAutoMentionPatterns(candidates),
    ambiguityOptions:
      ambiguousPattern == null ? [] : ambiguousCandidatesForPattern(candidates, ambiguousPattern),
  };
}

/**
 * 提示内容的持久化真相。DOM、dataset、chip class 与零宽光标锚点只属于 adapter。
 */
export interface PromptContentDocumentV1 {
  readonly schema: "prompt-content";
  readonly version: 1;
  readonly items: readonly PromptContentItem[];
}

export type PromptContentItem =
  PromptContentTextItem | PromptContentMediaReferenceItem | PromptContentPendingReferenceItem;

export interface PromptContentTextItem {
  readonly kind: "text";
  readonly text: string;
}

export interface PromptContentMediaReferenceItem {
  readonly kind: "media_reference";
  readonly mentionId: string;
  /** 画布实例身份独立于来源身份存在，避免相同来源的重复节点被错误合并。 */
  readonly canvasNodeKey: string;
  readonly target: MediaReferenceTarget;
  readonly displayNameSnapshot: string;
  readonly learnedPattern?: string;
  readonly aliasSnapshot?: string;
}

export interface PromptContentPendingReferenceItem {
  readonly kind: "pending_reference";
  readonly normalizedPattern: string;
  readonly displayText: string;
  readonly candidateCount: number;
}

export interface PromptContentConnection {
  readonly key: string;
  readonly name: string;
  readonly kind: MediaType;
  readonly target: MediaReferenceTarget;
}

export type PromptContentIssue =
  | {
      readonly kind: "pending_reference";
      readonly normalizedPattern: string;
      readonly displayText: string;
      readonly candidateCount: number;
    }
  | {
      readonly kind: "disconnected_reference";
      readonly mentionId: string;
      readonly canvasNodeKey: string;
      readonly displayName: string;
    }
  | {
      readonly kind: "reference_identity_changed";
      readonly mentionId: string;
      readonly canvasNodeKey: string;
      readonly displayName: string;
    }
  | { readonly kind: "empty_prompt" };

export interface PromptContentView {
  readonly document: PromptContentDocumentV1;
  readonly segments: readonly PromptSegment[];
  readonly plainText: string;
  readonly characterCount: number;
  readonly referenceCount: number;
  readonly pendingCount: number;
  readonly issues: readonly PromptContentIssue[];
}

export type PromptGenerationPreparation =
  | {
      readonly ok: true;
      readonly frozen: {
        readonly segments: readonly PromptSegment[];
        readonly explicitMedia: readonly ExplicitMediaInput[];
        readonly mentionedCanvasNodeKeys: ReadonlySet<string>;
        readonly plainText: string;
      };
    }
  | { readonly ok: false; readonly issues: readonly PromptContentIssue[] };

export type PromptPlainTextPreparation =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly issues: readonly PromptContentIssue[] };

export interface PromptContentEditorSession {
  attach(element: HTMLDivElement | null, attributes?: Readonly<Record<string, string>>): void;
  updateConnections(candidates: readonly PromptAutoMentionCandidate[]): void;
  acceptNativeInput(): PromptContentView;
  insertReference(candidate: PromptAutoMentionCandidate): PromptContentView;
  pastePlainText(text: string): AutoMentionResolutionResult;
  autoResolve(options?: { readonly fresh?: boolean }): AutoMentionResolutionResult;
  confirmPending(pattern: string, candidate: PromptAutoMentionCandidate, alias: string): number;
  reconcileConnections(): number;
  replaceText(text: string): AutoMentionResolutionResult;
  aliases(): readonly { readonly candidateIndex: number; readonly label: string }[];
  ambiguityCount(): number;
  ambiguityOptions(pattern: string): ReturnType<typeof ambiguousCandidatesForPattern>;
  mentionQueryAtCaret(): string | null;
  removeMentionQueryAtCaret(): boolean;
  pendingAt(target: EventTarget | null): {
    readonly normalizedPattern: string;
    readonly displayText: string;
  } | null;
  firstPending(): {
    readonly normalizedPattern: string;
    readonly displayText: string;
  } | null;
  freshResolvedNames(): readonly string[];
  read(): PromptContentView;
  snapshot(): PromptContentDocumentV1;
  restore(persisted: unknown): PromptContentView;
  preparePlainText(): PromptPlainTextPreparation;
  prepareGeneration(context: {
    readonly connections: readonly PromptContentConnection[];
    readonly allowMediaOnly: boolean;
  }): PromptGenerationPreparation;
  focusIssue(issue: PromptContentIssue): boolean;
}

export interface PromptContentModule {
  adoptEditor(nodeKey: string, session: PromptContentEditorSession | null): void;
  remove(nodeKey: string): PromptContentDocumentV1 | null;
  replaceText(
    nodeKey: string,
    text: string,
    candidates: readonly PromptAutoMentionCandidate[],
  ): AutoMentionResolutionResult | null;
  preparePlainText(nodeKey: string): PromptPlainTextPreparation | null;
  prepareGeneration(
    nodeKey: string,
    context: {
      readonly connections: readonly PromptContentConnection[];
      readonly allowMediaOnly: boolean;
    },
  ): PromptGenerationPreparation | null;
  focusIssue(nodeKey: string, issue: PromptContentIssue): boolean;
  read(nodeKey: string): PromptContentView | null;
  snapshotAll(nodeKeys?: ReadonlySet<string>): Readonly<Record<string, PromptContentDocumentV1>>;
  restoreAll(
    persisted: Readonly<Record<string, PromptContentDocumentV1 | string>>,
  ): { readonly ok: true } | { readonly ok: false; readonly invalidNodeKeys: readonly string[] };
}

const EMPTY_DOCUMENT: PromptContentDocumentV1 = {
  schema: "prompt-content",
  version: 1,
  items: [],
};

const BLOCK_ELEMENTS = new Set(["DIV", "P", "LI"]);

interface MentionQueryContext {
  readonly query: string;
  readonly range: Range;
}

function domMentionQueryAtCaret(input: HTMLDivElement): MentionQueryContext | null {
  const selection = input.ownerDocument.defaultView?.getSelection() ?? null;
  if (selection == null || selection.rangeCount === 0) return null;
  const caret = selection.getRangeAt(0);
  if (!input.contains(caret.endContainer)) return null;

  const prefix = input.ownerDocument.createRange();
  prefix.selectNodeContents(input);
  prefix.setEnd(caret.endContainer, caret.endOffset);
  const textNodes: { node: Text; start: number; end: number }[] = [];
  const walker = input.ownerDocument.createTreeWalker(input, NodeFilter.SHOW_TEXT);
  let text = "";
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (node.parentElement?.closest("[data-mention-id], [data-ambiguous-pattern]") != null) {
      continue;
    }
    let includedLength = node.data.length;
    if (node === caret.endContainer) {
      includedLength = Math.min(caret.endOffset, node.data.length);
    } else {
      const nodeRange = input.ownerDocument.createRange();
      nodeRange.selectNodeContents(node);
      if (nodeRange.compareBoundaryPoints(Range.END_TO_END, prefix) > 0) continue;
    }
    if (includedLength === 0) continue;
    const start = text.length;
    text += node.data.slice(0, includedLength);
    textNodes.push({ node, start, end: text.length });
  }
  const atIndex = text.lastIndexOf("@");
  if (atIndex < 0) return null;
  const startNode = textNodes.find((entry) => atIndex >= entry.start && atIndex < entry.end);
  if (startNode == null) return null;
  const queryRange = input.ownerDocument.createRange();
  queryRange.setStart(startNode.node, atIndex - startNode.start);
  queryRange.setEnd(caret.endContainer, caret.endOffset);
  if (
    queryRange.cloneContents().querySelector("[data-mention-id], [data-ambiguous-pattern]") != null
  ) {
    return null;
  }
  return { query: text.slice(atIndex + 1).replaceAll("\u200b", ""), range: queryRange };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function mediaTargetFromDataset(element: HTMLElement): MediaReferenceTarget | null {
  const mediaType = element.dataset["mediaKind"] as MediaType | undefined;
  const canvasNodeKey = element.dataset["canvasNodeKey"] ?? "";
  if (mediaType !== "image" && mediaType !== "video" && mediaType !== "audio") return null;
  if (!canvasNodeKey) return null;
  const referenceKind = element.dataset["referenceKind"];
  if (referenceKind === "local_result") {
    const generationTaskId = element.dataset["generationTaskId"] ?? "";
    const resultIndex = Number.parseInt(element.dataset["resultIndex"] ?? "", 10);
    if (!generationTaskId || !Number.isInteger(resultIndex) || resultIndex < 0) return null;
    return { kind: "local_result", generationTaskId, resultIndex, canvasNodeKey, mediaType };
  }
  if (referenceKind === "local_asset" || element.dataset["assetSource"] === "local") {
    const stagingJobId = element.dataset["assetId"] ?? "";
    return stagingJobId ? { kind: "local_asset", stagingJobId, canvasNodeKey, mediaType } : null;
  }
  const providerConnectionId = element.dataset["providerId"] ?? "";
  const assetId = element.dataset["assetId"] ?? "";
  return providerConnectionId && assetId
    ? { kind: "asset", providerConnectionId, assetId, canvasNodeKey, mediaType }
    : null;
}

function appendText(items: PromptContentItem[], text: string): void {
  const clean = text.replaceAll("\u200b", "").replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  if (!clean) return;
  const previous = items.at(-1);
  if (previous?.kind === "text") {
    items[items.length - 1] = { kind: "text", text: previous.text + clean };
  } else {
    items.push({ kind: "text", text: clean });
  }
}

function endsWithNewline(items: readonly PromptContentItem[]): boolean {
  const last = items.at(-1);
  return last?.kind === "text" && last.text.endsWith("\n");
}

/** 白名单读取 DOM；未知标签只递归提取文字，不保留 HTML、style 或事件属性。 */
function documentFromDom(root: HTMLElement): PromptContentDocumentV1 {
  const items: PromptContentItem[] = [];
  const walk = (parent: Node) => {
    const children = Array.from(parent.childNodes);
    children.forEach((child, index) => {
      if (child.nodeType === Node.TEXT_NODE) {
        appendText(items, child.textContent ?? "");
        return;
      }
      if (!(child instanceof HTMLElement)) return;
      if (child.tagName === "SCRIPT" || child.tagName === "STYLE") return;
      if (child.tagName === "BR") {
        appendText(items, "\n");
        return;
      }
      const mentionId = child.dataset["mentionId"];
      if (mentionId != null) {
        const target = mediaTargetFromDataset(child);
        const canvasNodeKey = child.dataset["canvasNodeKey"] ?? "";
        if (mentionId && target && canvasNodeKey) {
          const learnedPattern = child.dataset["autoPattern"];
          items.push({
            kind: "media_reference",
            mentionId,
            canvasNodeKey,
            target,
            displayNameSnapshot: child.dataset["displayName"] ?? "",
            ...(learnedPattern ? { learnedPattern: normalizeAutoMentionText(learnedPattern) } : {}),
            ...(child.dataset["autoAlias"] ? { aliasSnapshot: child.dataset["autoAlias"] } : {}),
          });
        } else {
          appendText(items, child.dataset["displayName"] ?? child.textContent ?? "");
        }
        return;
      }
      const ambiguousPattern = child.dataset["ambiguousPattern"];
      if (ambiguousPattern != null) {
        items.push({
          kind: "pending_reference",
          normalizedPattern: normalizeAutoMentionText(ambiguousPattern),
          displayText: child.dataset["displayName"] ?? ambiguousPattern,
          candidateCount: Math.max(2, Number.parseInt(child.dataset["candidateCount"] ?? "2", 10)),
        });
        return;
      }
      const isBlock = BLOCK_ELEMENTS.has(child.tagName);
      if (isBlock && items.length > 0 && !endsWithNewline(items)) appendText(items, "\n");
      walk(child);
      if (isBlock && index < children.length - 1 && !endsWithNewline(items))
        appendText(items, "\n");
    });
  };
  walk(root);
  return { schema: "prompt-content", version: 1, items };
}

function candidateFromItem(item: PromptContentMediaReferenceItem): PromptAutoMentionCandidate {
  if (item.target.kind === "local_result") {
    return {
      canvasNodeKey: item.canvasNodeKey,
      assetId: `${item.target.generationTaskId}#${item.target.resultIndex}`,
      providerConnectionId: "",
      referenceKind: "local_result",
      generationTaskId: item.target.generationTaskId,
      resultIndex: item.target.resultIndex,
      kind: item.target.mediaType,
      name: item.displayNameSnapshot,
    };
  }
  if (item.target.kind === "local_asset") {
    return {
      canvasNodeKey: item.canvasNodeKey,
      assetId: item.target.stagingJobId,
      providerConnectionId: "",
      source: "local",
      referenceKind: "local_asset",
      kind: item.target.mediaType,
      name: item.displayNameSnapshot,
    };
  }
  if (item.target.kind === "local_file") {
    return {
      canvasNodeKey: item.target.canvasNodeKey ?? item.canvasNodeKey,
      assetId: item.target.path,
      providerConnectionId: "",
      source: "local",
      referenceKind: "local_file",
      kind: item.target.mediaType,
      name: item.displayNameSnapshot,
    };
  }
  return {
    canvasNodeKey: item.canvasNodeKey,
    assetId: item.target.assetId,
    providerConnectionId: item.target.providerConnectionId,
    source: "cloud",
    referenceKind: "asset",
    kind: item.target.mediaType,
    name: item.displayNameSnapshot,
  };
}

function renderDocument(root: HTMLElement, value: PromptContentDocumentV1): void {
  root.replaceChildren();
  const doc = root.ownerDocument;
  for (const item of value.items) {
    if (item.kind === "text") {
      const lines = item.text.split("\n");
      lines.forEach((line, index) => {
        if (line) root.append(doc.createTextNode(line));
        if (index < lines.length - 1) root.append(doc.createElement("br"));
      });
      continue;
    }
    if (item.kind === "pending_reference") {
      const pending = doc.createElement("span");
      pending.contentEditable = "false";
      pending.className = "mention-chip mention-chip--ambiguous";
      pending.dataset["ambiguousPattern"] = item.normalizedPattern;
      pending.dataset["displayName"] = item.displayText;
      pending.dataset["candidateCount"] = String(item.candidateCount);
      pending.setAttribute("role", "button");
      pending.tabIndex = 0;
      pending.textContent = `@${item.displayText} · 待确认`;
      pending.title = `找到 ${item.candidateCount} 个同名素材，点击选择具体对象`;
      root.append(pending);
      continue;
    }
    const chip = createMentionChipElement(candidateFromItem(item), {
      ...(item.learnedPattern ? { learnedPattern: item.learnedPattern } : {}),
      ...(item.aliasSnapshot ? { alias: item.aliasSnapshot } : {}),
    });
    chip.dataset["mentionId"] = item.mentionId;
    root.append(chip, doc.createTextNode("\u200b"));
  }
}

function decodePersistedPromptContent(value: unknown): PromptContentDocumentV1 | null {
  const structured = decodePromptContentDocument(value);
  if (structured != null) return structured;
  if (typeof value !== "string") return null;
  const template = document.createElement("template");
  template.innerHTML = value;
  const root = document.createElement("div");
  root.append(template.content.cloneNode(true));
  return documentFromDom(root);
}

function isMediaType(value: unknown): value is MediaType {
  return value === "image" || value === "video" || value === "audio";
}

function parseTarget(value: unknown, canvasNodeKey: string): MediaReferenceTarget | null {
  if (!isRecord(value) || !isMediaType(value["mediaType"])) return null;
  const mediaType = value["mediaType"];
  if (
    value["kind"] === "asset" &&
    typeof value["providerConnectionId"] === "string" &&
    typeof value["assetId"] === "string" &&
    value["providerConnectionId"] &&
    value["assetId"]
  ) {
    return {
      kind: "asset",
      providerConnectionId: value["providerConnectionId"],
      assetId: value["assetId"],
      canvasNodeKey,
      mediaType,
    };
  }
  if (
    value["kind"] === "local_asset" &&
    typeof value["stagingJobId"] === "string" &&
    value["stagingJobId"]
  ) {
    return { kind: "local_asset", stagingJobId: value["stagingJobId"], canvasNodeKey, mediaType };
  }
  if (
    value["kind"] === "local_result" &&
    typeof value["generationTaskId"] === "string" &&
    value["generationTaskId"] &&
    typeof value["resultIndex"] === "number" &&
    Number.isInteger(value["resultIndex"]) &&
    value["resultIndex"] >= 0
  ) {
    return {
      kind: "local_result",
      generationTaskId: value["generationTaskId"],
      resultIndex: value["resultIndex"],
      canvasNodeKey,
      mediaType,
    };
  }
  return null;
}

export function decodePromptContentDocument(value: unknown): PromptContentDocumentV1 | null {
  if (
    !isRecord(value) ||
    value["schema"] !== "prompt-content" ||
    value["version"] !== 1 ||
    !Array.isArray(value["items"])
  ) {
    return null;
  }
  const items: PromptContentItem[] = [];
  const mentionIds = new Set<string>();
  for (const raw of value["items"]) {
    if (!isRecord(raw)) return null;
    if (raw["kind"] === "text" && typeof raw["text"] === "string") {
      appendText(items, raw["text"]);
      continue;
    }
    if (
      raw["kind"] === "pending_reference" &&
      typeof raw["normalizedPattern"] === "string" &&
      typeof raw["displayText"] === "string" &&
      typeof raw["candidateCount"] === "number"
    ) {
      items.push({
        kind: "pending_reference",
        normalizedPattern: normalizeAutoMentionText(raw["normalizedPattern"]),
        displayText: raw["displayText"],
        candidateCount: Math.max(2, Math.floor(raw["candidateCount"])),
      });
      continue;
    }
    if (
      raw["kind"] === "media_reference" &&
      typeof raw["mentionId"] === "string" &&
      raw["mentionId"] &&
      typeof raw["canvasNodeKey"] === "string" &&
      raw["canvasNodeKey"] &&
      typeof raw["displayNameSnapshot"] === "string"
    ) {
      if (mentionIds.has(raw["mentionId"])) return null;
      const target = parseTarget(raw["target"], raw["canvasNodeKey"]);
      if (target == null) return null;
      mentionIds.add(raw["mentionId"]);
      items.push({
        kind: "media_reference",
        mentionId: raw["mentionId"],
        canvasNodeKey: raw["canvasNodeKey"],
        target,
        displayNameSnapshot: raw["displayNameSnapshot"],
        ...(typeof raw["learnedPattern"] === "string"
          ? { learnedPattern: normalizeAutoMentionText(raw["learnedPattern"]) }
          : {}),
        ...(typeof raw["aliasSnapshot"] === "string"
          ? { aliasSnapshot: raw["aliasSnapshot"] }
          : {}),
      });
      continue;
    }
    return null;
  }
  return { schema: "prompt-content", version: 1, items };
}

export function isPromptContentDocument(value: unknown): value is PromptContentDocumentV1 {
  return decodePromptContentDocument(value) != null;
}

function sameTarget(first: MediaReferenceTarget, second: MediaReferenceTarget): boolean {
  if (first.kind !== second.kind || first.mediaType !== second.mediaType) return false;
  if (first.kind === "asset" && second.kind === "asset") {
    return (
      first.providerConnectionId === second.providerConnectionId &&
      first.assetId === second.assetId &&
      first.canvasNodeKey === second.canvasNodeKey
    );
  }
  if (first.kind === "local_asset" && second.kind === "local_asset") {
    return (
      first.stagingJobId === second.stagingJobId && first.canvasNodeKey === second.canvasNodeKey
    );
  }
  if (first.kind === "local_result" && second.kind === "local_result") {
    return (
      first.generationTaskId === second.generationTaskId &&
      first.resultIndex === second.resultIndex &&
      first.canvasNodeKey === second.canvasNodeKey
    );
  }
  return false;
}

function promptContentItemEqual(first: PromptContentItem, second: PromptContentItem): boolean {
  if (first.kind !== second.kind) return false;
  if (first.kind === "text") {
    return second.kind === "text" && first.text === second.text;
  }
  if (first.kind === "pending_reference") {
    return (
      second.kind === "pending_reference" &&
      first.normalizedPattern === second.normalizedPattern &&
      first.displayText === second.displayText &&
      first.candidateCount === second.candidateCount
    );
  }
  if (second.kind !== "media_reference") return false;
  return (
    first.mentionId === second.mentionId &&
    first.canvasNodeKey === second.canvasNodeKey &&
    first.displayNameSnapshot === second.displayNameSnapshot &&
    (first.learnedPattern ?? "") === (second.learnedPattern ?? "") &&
    (first.aliasSnapshot ?? "") === (second.aliasSnapshot ?? "") &&
    sameTarget(first.target, second.target)
  );
}

/** 结构化比较两份 canonical document 是否等价，用于判断自动识别是否真正改动了内容。 */
function promptDocumentsEqual(
  first: PromptContentDocumentV1,
  second: PromptContentDocumentV1,
): boolean {
  if (first.items.length !== second.items.length) return false;
  return first.items.every((item, index) => promptContentItemEqual(item, second.items[index]!));
}

function viewFromDocument(
  document: PromptContentDocumentV1,
  connections: readonly PromptContentConnection[] = [],
): PromptContentView {
  const segments: PromptSegment[] = [];
  const plain: string[] = [];
  const issues: PromptContentIssue[] = [];
  const byKey = new Map(connections.map((connection) => [connection.key, connection] as const));
  let referenceCount = 0;
  let pendingCount = 0;
  for (const item of document.items) {
    if (item.kind === "text") {
      segments.push({ kind: "text", text: item.text });
      plain.push(item.text);
      continue;
    }
    if (item.kind === "pending_reference") {
      pendingCount += 1;
      plain.push(item.displayText);
      issues.push({
        kind: "pending_reference",
        normalizedPattern: item.normalizedPattern,
        displayText: item.displayText,
        candidateCount: item.candidateCount,
      });
      continue;
    }
    referenceCount += 1;
    plain.push(`@${item.displayNameSnapshot}`);
    segments.push({
      kind: "media_reference",
      mentionId: item.mentionId,
      target: item.target,
      displayNameSnapshot: item.displayNameSnapshot,
    });
    const connection = byKey.get(item.canvasNodeKey);
    if (connection == null) {
      issues.push({
        kind: "disconnected_reference",
        mentionId: item.mentionId,
        canvasNodeKey: item.canvasNodeKey,
        displayName: item.displayNameSnapshot,
      });
    } else if (!sameTarget(item.target, connection.target)) {
      issues.push({
        kind: "reference_identity_changed",
        mentionId: item.mentionId,
        canvasNodeKey: item.canvasNodeKey,
        displayName: item.displayNameSnapshot,
      });
    }
  }
  const plainText = plain.join("").replaceAll("\u200b", "");
  return {
    document,
    segments,
    plainText,
    characterCount: plainText.length,
    referenceCount,
    pendingCount,
    issues,
  };
}

function candidateTarget(candidate: PromptAutoMentionCandidate): MediaReferenceTarget {
  const mediaType = candidate.kind;
  if (candidate.referenceKind === "local_result") {
    return {
      kind: "local_result",
      generationTaskId: candidate.generationTaskId ?? "",
      resultIndex: candidate.resultIndex ?? 0,
      canvasNodeKey: candidate.canvasNodeKey,
      mediaType,
    };
  }
  if (candidate.referenceKind === "local_asset" || candidate.source === "local") {
    return {
      kind: "local_asset",
      stagingJobId: candidate.assetId,
      canvasNodeKey: candidate.canvasNodeKey,
      mediaType,
    };
  }
  return {
    kind: "asset",
    providerConnectionId: candidate.providerConnectionId,
    assetId: candidate.assetId,
    canvasNodeKey: candidate.canvasNodeKey,
    mediaType,
  };
}

class PromptContentEditorSessionImplementation implements PromptContentEditorSession {
  private host: HTMLDivElement | null = null;
  private editor: Editor | null = null;
  private candidates: readonly PromptAutoMentionCandidate[] = [];
  private document: PromptContentDocumentV1 = EMPTY_DOCUMENT;
  private readonly freshMentionIds = new Set<string>();
  private readonly freshTimers = new Map<string, number>();
  private readonly handlePaste = () => true;

  attach(element: HTMLDivElement | null, attributes: Readonly<Record<string, string>> = {}): void {
    if (this.host === element && this.editor != null) {
      this.editor.setOptions({
        editorProps: {
          attributes: this.editorAttributes(attributes),
          handlePaste: this.handlePaste,
        },
      });
      return;
    }
    if (this.editor != null) {
      this.syncFromEditor();
      this.editor.destroy();
      this.editor = null;
    }
    this.host = element;
    if (element == null) return;
    this.editor = new Editor({
      element,
      extensions: createPromptTiptapExtensions("描述画面…输入 @ 或直接写素材名，自动引用素材"),
      content: promptDocumentToTiptapJson(this.document, this.presentation()),
      injectCSS: false,
      editorProps: {
        attributes: this.editorAttributes(attributes),
        // 富文本粘贴由 React 外层统一转成 text/plain，再走素材自动识别。
        handlePaste: this.handlePaste,
      },
      onUpdate: ({ editor }) => {
        this.document = promptDocumentFromTiptapJson(editor.getJSON());
      },
    });
  }

  updateConnections(candidates: readonly PromptAutoMentionCandidate[]): void {
    this.candidates = candidates;
    this.reconcileConnections();
  }

  acceptNativeInput(): PromptContentView {
    this.syncFromEditor();
    return this.read();
  }

  private editorAttributes(attributes: Readonly<Record<string, string>>): Record<string, string> {
    return {
      class: "prompt-mention__input nodrag nowheel",
      role: "textbox",
      "aria-multiline": "true",
      spellcheck: "true",
      ...attributes,
    };
  }

  private presentation() {
    return {
      connectedCanvasNodeKeys: new Set(this.candidates.map((candidate) => candidate.canvasNodeKey)),
      freshMentionIds: this.freshMentionIds,
    };
  }

  /**
   * ProseMirror 的 DOMObserver 在真实输入中会先于外层 React onInput 完成；测试里的
   * 直接 DOM 写入没有 beforeinput，因此在读取前显式 flush，确保兼容既有测试工具。
   */
  private flushDomObserver(): void {
    const view = this.editor?.view as
      (Editor["view"] & { domObserver?: { flush(): void } }) | undefined;
    view?.domObserver?.flush();
  }

  private syncFromEditor(): void {
    if (this.editor == null) return;
    // IME 组合期间不读取/不强制同步 DOM：候选拼音尚未提交，提前 flush 会被
    // ProseMirror 当作已完成文本提交，破坏输入法组合状态。组合结束后的 input
    // 事件会再次触发同步。
    if (this.editor.view.composing) return;
    this.flushDomObserver();
    this.document = promptDocumentFromTiptapJson(this.editor.getJSON());
  }

  private applyDocument(preserveSelection = true): void {
    if (this.editor == null) return;
    const selection = this.editor.state.selection;
    this.editor.commands.setContent(
      promptDocumentToTiptapJson(this.document, this.presentation()),
      { emitUpdate: false, errorOnInvalidContent: true },
    );
    this.document = promptDocumentFromTiptapJson(this.editor.getJSON());
    if (!preserveSelection) return;
    const max = Math.max(1, this.editor.state.doc.content.size - 1);
    const from = Math.min(selection.from, max);
    const to = Math.min(Math.max(selection.to, from), max);
    this.editor.commands.setTextSelection({ from, to });
  }

  private notify(): void {
    this.editor?.view.dom.dispatchEvent(new Event("input", { bubbles: true }));
  }

  private rememberFreshMentions(element: HTMLElement): void {
    const ids = Array.from(
      element.querySelectorAll<HTMLElement>("[data-mention-id][data-auto='true']"),
    )
      .map((chip) => chip.dataset["mentionId"] ?? "")
      .filter(Boolean);
    for (const id of ids) {
      this.freshMentionIds.add(id);
      const previous = this.freshTimers.get(id);
      if (previous != null) window.clearTimeout(previous);
      const timer = window.setTimeout(() => {
        this.freshTimers.delete(id);
        this.freshMentionIds.delete(id);
        const selector = `[data-mention-id="${CSS.escape(id)}"]`;
        const chip = this.editor?.view.dom.querySelector<HTMLElement>(selector);
        chip?.classList.remove("is-fresh");
        if (chip) delete chip.dataset["auto"];
      }, AUTO_MENTION_FRESH_MS);
      this.freshTimers.set(id, timer);
    }
  }

  private transformDocumentWithDom<T>(
    change: (element: HTMLDivElement) => T,
    syncFromEditor = true,
    options?: { readonly forceApply?: boolean },
  ): T {
    if (syncFromEditor) this.syncFromEditor();
    const element = document.createElement("div");
    renderDocument(element, this.document);
    const result = change(element);
    this.rememberFreshMentions(element);
    const next = documentFromDom(element);
    // 没有实际内容变化时不要重建编辑器 DOM：重建（setContent）会打断 IME 组合，
    // 把未完成的拼音候选提前提交成错乱字符，并重置光标位置导致删除方向错乱。
    const changed = !promptDocumentsEqual(next, this.document);
    if (changed || options?.forceApply) {
      this.document = next;
      this.applyDocument();
    }
    return result;
  }

  insertReference(candidate: PromptAutoMentionCandidate): PromptContentView {
    const candidateIndex = this.candidates.findIndex(
      (entry) => entry.canvasNodeKey === candidate.canvasNodeKey,
    );
    const hasSameName =
      ambiguousCandidatesForPattern(this.candidates, normalizeAutoMentionText(candidate.name))
        .length > 1;
    const reference: PromptContentMediaReferenceItem = {
      kind: "media_reference",
      mentionId: `mention-${globalThis.crypto.randomUUID()}`,
      canvasNodeKey: candidate.canvasNodeKey,
      target: candidateTarget(candidate),
      displayNameSnapshot: candidate.name,
      ...(hasSameName && candidateIndex >= 0
        ? { aliasSnapshot: autoMentionAliasForCandidate(this.candidates, candidateIndex) }
        : {}),
    };
    if (this.editor != null) {
      this.editor.chain().focus().insertContent(promptReferenceToTiptapNode(reference)).run();
      this.syncFromEditor();
    } else {
      this.document = {
        schema: "prompt-content",
        version: 1,
        items: [...this.document.items, reference],
      };
    }
    this.notify();
    this.editor?.commands.focus();
    return this.read();
  }

  pastePlainText(text: string): AutoMentionResolutionResult {
    if (this.editor != null) {
      const content = plainTextToTiptapContent(text);
      if (content.length > 0) this.editor.commands.insertContent(content);
      this.syncFromEditor();
    } else {
      const items = [...this.document.items];
      appendText(items, text);
      this.document = { schema: "prompt-content", version: 1, items };
    }
    const pending = this.document.items.filter((item) => item.kind === "pending_reference").length;
    this.notify();
    return { converted: 0, ambiguous: 0, pending };
  }

  autoResolve(options?: { readonly fresh?: boolean }): AutoMentionResolutionResult {
    const result = this.transformDocumentWithDom((element) =>
      resolvePromptAutoMentions(element, this.candidates, {
        fresh: options?.fresh ?? true,
      }),
    );
    if (result.converted > 0 || result.ambiguous > 0) this.notify();
    return result;
  }

  confirmPending(pattern: string, candidate: PromptAutoMentionCandidate, alias: string): number {
    const confirmed = this.transformDocumentWithDom((element) =>
      confirmAmbiguousMentionChips(element, pattern, candidate, alias),
    );
    if (confirmed > 0) this.notify();
    return confirmed;
  }

  reconcileConnections(): number {
    this.syncFromEditor();
    const element = document.createElement("div");
    renderDocument(element, this.document);
    let reconciled = 0;
    for (const pending of element.querySelectorAll<HTMLElement>("[data-ambiguous-pattern]")) {
      const pattern = pending.dataset["ambiguousPattern"] ?? "";
      const options = ambiguousCandidatesForPattern(this.candidates, pattern);
      if (options.length !== 1) continue;
      const only = options[0]!;
      reconciled += confirmAmbiguousMentionChips(element, pattern, only.candidate, only.alias);
    }
    if (reconciled > 0) {
      this.rememberFreshMentions(element);
      this.document = documentFromDom(element);
      this.applyDocument();
    } else if (this.editor != null) {
      // 只改变断线展示时直接更新 node DOM，避免替换 atom 节点和打断当前选区。
      markStaleMentionChips(
        this.editor.view.dom,
        new Set(this.candidates.map((candidate) => candidate.canvasNodeKey)),
      );
    }
    if (reconciled > 0) this.notify();
    return reconciled;
  }

  replaceText(text: string): AutoMentionResolutionResult {
    this.document = {
      schema: "prompt-content",
      version: 1,
      items: text ? [{ kind: "text", text }] : [],
    };
    const result = this.transformDocumentWithDom(
      (element) => resolvePromptAutoMentions(element, this.candidates, { fresh: true }),
      false,
      { forceApply: true },
    );
    this.notify();
    return result;
  }

  aliases() {
    return buildAutoMentionAliases(this.candidates);
  }

  ambiguityCount(): number {
    return countAmbiguousAutoMentionPatterns(this.candidates);
  }

  ambiguityOptions(pattern: string) {
    return ambiguousCandidatesForPattern(this.candidates, pattern);
  }

  mentionQueryAtCaret(): string | null {
    if (this.editor == null) return null;
    this.flushDomObserver();
    return domMentionQueryAtCaret(this.editor.view.dom as HTMLDivElement)?.query ?? null;
  }

  removeMentionQueryAtCaret(): boolean {
    if (this.editor == null) return false;
    const context = domMentionQueryAtCaret(this.editor.view.dom as HTMLDivElement);
    if (context == null) return false;
    const view = this.editor.view;
    const from = view.posAtDOM(context.range.startContainer, context.range.startOffset, -1);
    const to = view.posAtDOM(context.range.endContainer, context.range.endOffset, 1);
    if (from >= to) return false;
    this.editor.chain().focus().deleteRange({ from, to }).run();
    this.syncFromEditor();
    return true;
  }

  pendingAt(target: EventTarget | null) {
    if (!(target instanceof HTMLElement) || this.host == null) return null;
    const pending = target.closest<HTMLElement>("[data-ambiguous-pattern]");
    if (pending == null || !this.host.contains(pending)) return null;
    const normalizedPattern = pending.dataset["ambiguousPattern"];
    if (!normalizedPattern) return null;
    return {
      normalizedPattern,
      displayText: pending.dataset["displayName"] ?? normalizedPattern,
    };
  }

  firstPending() {
    const pending = this.host?.querySelector<HTMLElement>("[data-ambiguous-pattern]");
    return pending == null ? null : this.pendingAt(pending);
  }

  freshResolvedNames(): readonly string[] {
    if (this.host == null) return [];
    return Array.from(
      new Set(
        Array.from(this.host.querySelectorAll<HTMLElement>("[data-mention-id][data-auto='true']"))
          .map((chip) => chip.dataset["displayName"] ?? "")
          .filter(Boolean),
      ),
    );
  }

  read(): PromptContentView {
    const connections: PromptContentConnection[] = this.candidates.map((candidate) => ({
      key: candidate.canvasNodeKey,
      name: candidate.name,
      kind: candidate.kind,
      target: candidateTarget(candidate),
    }));
    return viewFromDocument(this.document, connections);
  }

  snapshot(): PromptContentDocumentV1 {
    this.acceptNativeInput();
    return structuredClone(this.document);
  }

  restore(persisted: unknown): PromptContentView {
    const decoded = decodePersistedPromptContent(persisted);
    if (decoded == null) return this.read();
    this.document = decoded;
    this.freshMentionIds.clear();
    if (this.editor != null) {
      this.applyDocument(false);
      this.notify();
    }
    return this.read();
  }

  preparePlainText(): PromptPlainTextPreparation {
    const view = this.acceptNativeInput();
    const issues = view.issues.filter((issue) => issue.kind === "pending_reference");
    if (issues.length > 0) return { ok: false, issues };
    const text = view.plainText.trim();
    return text ? { ok: true, text } : { ok: false, issues: [{ kind: "empty_prompt" }] };
  }

  prepareGeneration(context: {
    readonly connections: readonly PromptContentConnection[];
    readonly allowMediaOnly: boolean;
  }): PromptGenerationPreparation {
    this.acceptNativeInput();
    const view = viewFromDocument(this.document, context.connections);
    const blocking = view.issues;
    if (blocking.length > 0) return { ok: false, issues: blocking };
    const hasContent =
      view.segments.some((segment) => segment.kind === "text" && Boolean(segment.text.trim())) ||
      view.referenceCount > 0 ||
      (context.connections.length > 0 && context.allowMediaOnly);
    if (!hasContent) return { ok: false, issues: [{ kind: "empty_prompt" }] };

    // 统一媒体编号来源：按输入（连线）顺序，为每个连接分配
    //   typePosition = 同类序号（图片N 的 N，与 UI「图片1/图片2」提示完全一致）；
    //   contentIndex = 全局序号（决定请求体 metadata.content 数组顺序）。
    // 这样即使提示词书写顺序与连线顺序不同，UI 显示的编号与请求体中的
    // 「图片N」标签、content 数组位置三者始终一一对应，杜绝引用错位。
    const positionByKey = new Map<string, { typePosition: number; contentIndex: number }>();
    const kindCounts = new Map<MediaType, number>();
    context.connections.forEach((connection, index) => {
      const typePosition = (kindCounts.get(connection.kind) ?? 0) + 1;
      kindCounts.set(connection.kind, typePosition);
      positionByKey.set(connection.key, { typePosition, contentIndex: index + 1 });
    });

    const segments = view.segments.map((segment) => {
      if (segment.kind !== "media_reference") return segment;
      const canvasNodeKey = segment.target.canvasNodeKey;
      const position = canvasNodeKey != null ? positionByKey.get(canvasNodeKey) : undefined;
      if (position == null) return segment;
      return {
        ...segment,
        typePosition: position.typePosition,
        contentIndex: position.contentIndex,
      };
    });

    const mentionedCanvasNodeKeys = new Set(
      this.document.items.flatMap((item) =>
        item.kind === "media_reference" ? [item.canvasNodeKey] : [],
      ),
    );
    const explicitMedia: ExplicitMediaInput[] = context.connections
      .filter((connection) => !mentionedCanvasNodeKeys.has(connection.key))
      .map((connection) => {
        const position = positionByKey.get(connection.key);
        return {
          target: structuredClone(connection.target),
          role: "",
          displayNameSnapshot: connection.name,
          ...(position
            ? { typePosition: position.typePosition, contentIndex: position.contentIndex }
            : {}),
        };
      });
    return {
      ok: true,
      frozen: {
        segments,
        explicitMedia,
        mentionedCanvasNodeKeys,
        plainText: view.plainText,
      },
    };
  }

  focusIssue(issue: PromptContentIssue): boolean {
    if (this.host == null) return false;
    const selector =
      issue.kind === "pending_reference"
        ? `[data-ambiguous-pattern="${CSS.escape(issue.normalizedPattern)}"]`
        : issue.kind === "disconnected_reference" || issue.kind === "reference_identity_changed"
          ? `[data-mention-id="${CSS.escape(issue.mentionId)}"]`
          : null;
    if (selector == null) return false;
    const target = this.host.querySelector<HTMLElement>(selector);
    if (target == null) return false;
    target.focus();
    target.click();
    return true;
  }
}

/** 每个生成节点只创建一个 handle；挂载、放大重挂与调用方共享同一 canonical document。 */
export function createPromptContentEditorSession(
  candidates: readonly PromptAutoMentionCandidate[] = [],
): PromptContentEditorSession {
  const session = new PromptContentEditorSessionImplementation();
  session.updateConnections(candidates);
  return session;
}

class PromptContentModuleImplementation implements PromptContentModule {
  private readonly sessions = new Map<string, PromptContentEditorSession>();
  private pendingRestore = new Map<string, PromptContentDocumentV1>();

  adoptEditor(nodeKey: string, session: PromptContentEditorSession | null): void {
    // DOM adapter 暂时卸载时保留原 handle；只有 remove 才删除 canonical content。
    if (session == null) return;
    const previous = this.sessions.get(nodeKey);
    if (previous != null && previous !== session) session.restore(previous.snapshot());
    const pending = this.pendingRestore.get(nodeKey);
    if (pending != null) {
      session.restore(pending);
      this.pendingRestore.delete(nodeKey);
    }
    this.sessions.set(nodeKey, session);
  }

  remove(nodeKey: string): PromptContentDocumentV1 | null {
    const session = this.sessions.get(nodeKey);
    const pending = this.pendingRestore.get(nodeKey);
    this.sessions.delete(nodeKey);
    this.pendingRestore.delete(nodeKey);
    return session?.snapshot() ?? pending ?? null;
  }

  replaceText(
    nodeKey: string,
    text: string,
    candidates: readonly PromptAutoMentionCandidate[],
  ): AutoMentionResolutionResult | null {
    const session = this.sessions.get(nodeKey);
    if (session == null) return null;
    session.updateConnections(candidates);
    return session.replaceText(text);
  }

  preparePlainText(nodeKey: string): PromptPlainTextPreparation | null {
    return this.sessions.get(nodeKey)?.preparePlainText() ?? null;
  }

  prepareGeneration(
    nodeKey: string,
    context: {
      readonly connections: readonly PromptContentConnection[];
      readonly allowMediaOnly: boolean;
    },
  ): PromptGenerationPreparation | null {
    return this.sessions.get(nodeKey)?.prepareGeneration(context) ?? null;
  }

  focusIssue(nodeKey: string, issue: PromptContentIssue): boolean {
    return this.sessions.get(nodeKey)?.focusIssue(issue) ?? false;
  }

  read(nodeKey: string): PromptContentView | null {
    return this.sessions.get(nodeKey)?.read() ?? null;
  }

  snapshotAll(nodeKeys?: ReadonlySet<string>): Readonly<Record<string, PromptContentDocumentV1>> {
    const keys = nodeKeys ?? new Set([...this.sessions.keys(), ...this.pendingRestore.keys()]);
    const snapshots: Record<string, PromptContentDocumentV1> = {};
    for (const nodeKey of keys) {
      const session = this.sessions.get(nodeKey);
      snapshots[nodeKey] =
        session?.snapshot() ?? this.pendingRestore.get(nodeKey) ?? EMPTY_DOCUMENT;
    }
    return snapshots;
  }

  restoreAll(
    persisted: Readonly<Record<string, PromptContentDocumentV1 | string>>,
  ): { readonly ok: true } | { readonly ok: false; readonly invalidNodeKeys: readonly string[] } {
    const plan = new Map<string, PromptContentDocumentV1>();
    const invalidNodeKeys: string[] = [];
    for (const [nodeKey, raw] of Object.entries(persisted)) {
      const decoded = decodePersistedPromptContent(raw);
      if (decoded == null) invalidNodeKeys.push(nodeKey);
      else plan.set(nodeKey, decoded);
    }
    if (invalidNodeKeys.length > 0) return { ok: false, invalidNodeKeys };

    // 完整计划验证后才改写；未出现在新文档中的旧节点内容一并清空。
    for (const [nodeKey, session] of this.sessions) {
      session.restore(plan.get(nodeKey) ?? EMPTY_DOCUMENT);
    }
    this.pendingRestore = new Map([...plan].filter(([nodeKey]) => !this.sessions.has(nodeKey)));
    return { ok: true };
  }
}

export function createPromptContentModule(): PromptContentModule {
  return new PromptContentModuleImplementation();
}
