import { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Selection } from "@tiptap/pm/state";
import { diffArrays } from "diff";
import type {
  ExplicitMediaInput,
  ExplicitMediaTarget,
  MediaReferenceTarget,
  MediaType,
  PromptSegment,
} from "./backend";
import {
  buildReferenceCatalog,
  candidateTarget,
  createPromptReference,
  normalizePromptReferenceText,
  resolvePromptReferences,
  referenceQueryInText,
  referenceCandidateFromTarget,
  type PromptReferenceCandidate,
} from "./promptReferences";
import { decodeMediaReferenceTarget, sameMediaReferenceTarget } from "./promptReferenceTarget";
import {
  createPromptTiptapExtensions,
  plainTextToTiptapContent,
  promptDocumentFromTiptapJson,
  promptDocumentToTiptapJson,
  promptReferenceToTiptapNode,
  promptReferenceTargetFromElement,
} from "./promptTiptap";

export const PROMPT_AUTO_DETECT_DEBOUNCE_MS = 420;
const PROMPT_REFERENCE_FRESH_MS = 2200;
export interface AutoMentionResolutionResult {
  readonly converted: number;
  readonly ambiguous: number;
  readonly pending: number;
}

export function describePromptContentCandidates<T extends PromptReferenceCandidate>(
  candidates: readonly T[],
  ambiguousPattern?: string,
) {
  const catalog = buildReferenceCatalog(candidates);
  return {
    aliases: catalog.aliases,
    ambiguousPatternCount: catalog.ambiguousPatternCount,
    ambiguityOptions: ambiguousPattern == null ? [] : catalog.options(ambiguousPattern),
    search: (query: string) => catalog.search(query),
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
  readonly target: ExplicitMediaTarget;
  /** 显式媒体输入的角色（如首帧/参考图/文档/网页）；缺省时由后端按素材类型推导。 */
  readonly role?: string;
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
  isComposing(): boolean;
  updateConnections(candidates: readonly PromptReferenceCandidate[]): void;
  acceptNativeInput(): PromptContentView;
  insertReference(candidate: PromptReferenceCandidate): PromptContentView;
  pastePlainText(text: string): AutoMentionResolutionResult;
  autoResolve(options?: {
    readonly fresh?: boolean;
    readonly mode?: "explicit" | "names";
  }): AutoMentionResolutionResult;
  confirmPending(pattern: string, candidate: PromptReferenceCandidate): number;
  reconcileConnections(): number;
  replaceText(text: string): AutoMentionResolutionResult;
  aliases(): readonly { readonly candidateIndex: number; readonly label: string }[];
  ambiguityCount(): number;
  ambiguityOptions(
    pattern: string,
  ): ReturnType<ReturnType<typeof buildReferenceCatalog>["options"]>;
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
    candidates: readonly PromptReferenceCandidate[],
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
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
        const target = promptReferenceTargetFromElement(child);
        const canvasNodeKey = child.dataset["canvasNodeKey"] ?? "";
        if (mentionId && target && canvasNodeKey) {
          const learnedPattern = child.dataset["autoPattern"];
          items.push({
            kind: "media_reference",
            mentionId,
            canvasNodeKey,
            target,
            displayNameSnapshot: child.dataset["displayName"] ?? "",
            ...(learnedPattern
              ? { learnedPattern: normalizePromptReferenceText(learnedPattern) }
              : {}),
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
          normalizedPattern: normalizePromptReferenceText(ambiguousPattern),
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
        normalizedPattern: normalizePromptReferenceText(raw["normalizedPattern"]),
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
      const target = decodeMediaReferenceTarget(raw["target"], raw["canvasNodeKey"]);
      if (target == null) return null;
      mentionIds.add(raw["mentionId"]);
      items.push({
        kind: "media_reference",
        mentionId: raw["mentionId"],
        canvasNodeKey: raw["canvasNodeKey"],
        target,
        displayNameSnapshot: raw["displayNameSnapshot"],
        ...(typeof raw["learnedPattern"] === "string"
          ? { learnedPattern: normalizePromptReferenceText(raw["learnedPattern"]) }
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
    sameMediaReferenceTarget(first.target, second.target)
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
    } else if (!sameMediaReferenceTarget(item.target, connection.target)) {
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

/** 单个文字、引用和段落边界各占一个比较单元，位置使用 ProseMirror 的 UTF-16 坐标。 */
function documentTokens(document: ProseMirrorNode) {
  const tokens: { key: string; size: number }[] = [];
  const visit = (node: ProseMirrorNode) => {
    if (node.isText) {
      const marks = JSON.stringify(node.marks.map((mark) => JSON.stringify(mark.toJSON())));
      for (const character of node.text ?? "")
        tokens.push({ key: `text:${marks}:${character}`, size: character.length });
    } else if (node.isLeaf) {
      tokens.push({ key: `leaf:${JSON.stringify(node.toJSON())}`, size: node.nodeSize });
    } else {
      tokens.push({ key: `open:${node.type.name}:${JSON.stringify(node.attrs)}`, size: 1 });
      node.forEach(visit);
      tokens.push({ key: `close:${node.type.name}`, size: 1 });
    }
  };
  document.forEach(visit);
  return tokens;
}

function documentChanges(current: ProseMirrorNode, next: ProseMirrorNode) {
  const changes = diffArrays(documentTokens(current), documentTokens(next), {
    comparator: (left, right) => left.key === right.key,
  });
  const ranges: { from: number; to: number; nextFrom: number; nextTo: number }[] = [];
  let oldPosition = 0;
  let newPosition = 0;
  let pending: (typeof ranges)[number] | null = null;
  for (const change of changes) {
    const size = change.value.reduce((sum, token) => sum + token.size, 0);
    if (!change.added && !change.removed) {
      if (pending) ranges.push(pending);
      pending = null;
      oldPosition += size;
      newPosition += size;
      continue;
    }
    pending ??= { from: oldPosition, to: oldPosition, nextFrom: newPosition, nextTo: newPosition };
    if (change.removed) oldPosition += size;
    if (change.added) newPosition += size;
    pending.to = oldPosition;
    pending.nextTo = newPosition;
  }
  if (pending) ranges.push(pending);
  return ranges;
}

class PromptContentEditorSessionImplementation implements PromptContentEditorSession {
  private host: HTMLDivElement | null = null;
  private editor: Editor | null = null;
  private candidates: readonly PromptReferenceCandidate[] = [];
  private document: PromptContentDocumentV1 = EMPTY_DOCUMENT;
  private readonly freshMentionIds = new Set<string>();
  private readonly freshTimers = new Map<string, number>();
  private readonly handlePaste = () => true;
  private composing = false;
  private compositionEndTimer: number | null = null;
  private pendingConnections = false;
  private pendingRestore: PromptContentDocumentV1 | null = null;
  private readonly handleCompositionStart = () => {
    if (this.compositionEndTimer != null) window.clearTimeout(this.compositionEndTimer);
    this.compositionEndTimer = null;
    this.composing = true;
    return false;
  };
  private readonly handleCompositionEnd = () => {
    // 等浏览器的最终 input 和 ProseMirror 的 compositionend 都结束，再读取提交值。
    if (this.compositionEndTimer != null) window.clearTimeout(this.compositionEndTimer);
    this.compositionEndTimer = window.setTimeout(() => {
      this.compositionEndTimer = null;
      this.composing = false;
      this.syncFromEditor();
      const pendingRestore = this.pendingRestore;
      this.pendingRestore = null;
      if (pendingRestore != null) this.restore(pendingRestore);
      if (this.pendingConnections) {
        this.pendingConnections = false;
        this.reconcileConnections();
      }
      this.notify();
    }, 0);
    return false;
  };
  private readonly handleDOMEvents = {
    compositionstart: this.handleCompositionStart,
    compositionend: this.handleCompositionEnd,
  };

  isComposing(): boolean {
    return this.composing || (this.editor?.view.composing ?? false);
  }

  attach(element: HTMLDivElement | null, attributes: Readonly<Record<string, string>> = {}): void {
    if (this.host === element && this.editor != null) {
      this.editor.setOptions({
        editorProps: {
          attributes: this.editorAttributes(attributes),
          handlePaste: this.handlePaste,
          handleDOMEvents: this.handleDOMEvents,
        },
      });
      return;
    }
    if (this.editor != null) {
      this.syncFromEditor();
      this.editor.destroy();
      this.editor = null;
    }
    if (this.compositionEndTimer != null) window.clearTimeout(this.compositionEndTimer);
    this.compositionEndTimer = null;
    this.composing = false;
    this.host = element;
    if (element == null) return;
    this.editor = new Editor({
      element,
      extensions: createPromptTiptapExtensions("描述画面…输入 @ 选择已连接素材"),
      content: promptDocumentToTiptapJson(this.document, this.presentation()),
      injectCSS: false,
      editorProps: {
        attributes: this.editorAttributes(attributes),
        // 富文本粘贴由 React 外层统一转成 text/plain，再走素材自动识别。
        handlePaste: this.handlePaste,
        handleDOMEvents: this.handleDOMEvents,
      },
      onUpdate: ({ editor }) => {
        if (this.isComposing()) return;
        this.document = promptDocumentFromTiptapJson(editor.getJSON());
      },
    });
  }

  updateConnections(candidates: readonly PromptReferenceCandidate[]): void {
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
    const view = this.read();
    const aliases = this.aliases();
    return {
      connectedCanvasNodeKeys: new Set(this.candidates.map((candidate) => candidate.canvasNodeKey)),
      invalidMentionIds: new Set(
        view.issues.flatMap((issue) => ("mentionId" in issue ? [issue.mentionId] : [])),
      ),
      referenceLabelsByKey: new Map(
        this.candidates.map((candidate, index) => [candidate.canvasNodeKey, aliases[index]!.label]),
      ),
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
    if (this.isComposing()) return;
    this.flushDomObserver();
    this.document = promptDocumentFromTiptapJson(this.editor.getJSON());
  }

  private applyDocument(preserveSelection = true, addToHistory = true): void {
    if (this.editor == null) return;
    const next = this.editor.schema.nodeFromJSON(
      promptDocumentToTiptapJson(this.document, this.presentation()),
    );
    next.check();
    const current = this.editor.state.doc;
    if (current.eq(next)) return;
    // 多处转换分别替换，保留它们之间未变化的正文及选区；从后向前应用以保持源坐标。
    const transaction = this.editor.state.tr;
    for (const change of documentChanges(current, next).reverse())
      transaction.replace(change.from, change.to, next.slice(change.nextFrom, change.nextTo));
    if (!preserveSelection) transaction.setSelection(Selection.atEnd(transaction.doc));
    this.editor.view.dispatch(
      transaction.setMeta("preventUpdate", true).setMeta("addToHistory", addToHistory),
    );
    this.document = promptDocumentFromTiptapJson(this.editor.getJSON());
  }

  private notify(): void {
    this.editor?.view.dom.dispatchEvent(new Event("input", { bubbles: true }));
  }

  private rememberFreshMentions(ids: readonly string[]): void {
    for (const id of ids) {
      this.freshMentionIds.add(id);
      const previous = this.freshTimers.get(id);
      if (previous != null) window.clearTimeout(previous);
      const timer = window.setTimeout(() => {
        this.freshTimers.delete(id);
        this.freshMentionIds.delete(id);
        const chip = this.editor?.view.dom.querySelector<HTMLElement>(
          `[data-mention-id="${CSS.escape(id)}"]`,
        );
        chip?.classList.remove("is-fresh");
        if (chip) delete chip.dataset["auto"];
      }, PROMPT_REFERENCE_FRESH_MS);
      this.freshTimers.set(id, timer);
    }
  }

  private resolveReferences(
    mode: "explicit" | "names",
    fresh = true,
    forceApply = false,
  ): AutoMentionResolutionResult {
    const result = resolvePromptReferences(this.document, this.candidates, { mode });
    if (fresh) this.rememberFreshMentions(result.freshMentionIds);
    const changed = !promptDocumentsEqual(result.document, this.document);
    this.document = result.document;
    if (changed || forceApply) this.applyDocument();
    return { converted: result.converted, ambiguous: result.ambiguous, pending: result.pending };
  }

  insertReference(candidate: PromptReferenceCandidate): PromptContentView {
    const connected = this.candidates.find(
      (entry) =>
        entry.canvasNodeKey === candidate.canvasNodeKey &&
        sameMediaReferenceTarget(candidateTarget(entry), candidateTarget(candidate)),
    );
    if (connected == null || this.isComposing()) return this.read();
    const index = this.candidates.indexOf(connected);
    const reference = createPromptReference(connected, { alias: this.aliases()[index]!.label });
    if (this.editor != null) {
      this.editor
        .chain()
        .focus()
        .insertContent(promptReferenceToTiptapNode(reference, this.presentation()))
        .run();
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
    const result = this.resolveReferences("explicit");
    this.notify();
    return result;
  }

  autoResolve(options?: {
    readonly fresh?: boolean;
    readonly mode?: "explicit" | "names";
  }): AutoMentionResolutionResult {
    if (this.isComposing())
      return { converted: 0, ambiguous: 0, pending: this.read().pendingCount };
    this.syncFromEditor();
    const result = this.resolveReferences(options?.mode ?? "explicit", options?.fresh ?? true);
    if (result.converted > 0 || result.ambiguous > 0) this.notify();
    return result;
  }

  confirmPending(pattern: string, candidate: PromptReferenceCandidate): number {
    if (this.isComposing()) return 0;
    this.syncFromEditor();
    const catalog = buildReferenceCatalog(this.candidates);
    const normalized = normalizePromptReferenceText(pattern);
    const option = catalog
      .options(normalized)
      .find((entry) =>
        sameMediaReferenceTarget(candidateTarget(entry.candidate), candidateTarget(candidate)),
      );
    if (option == null) return 0;
    const freshIds: string[] = [];
    this.document = {
      ...this.document,
      items: this.document.items.map((item) => {
        if (item.kind !== "pending_reference" || item.normalizedPattern !== normalized) return item;
        const reference = createPromptReference(option.candidate, { alias: option.alias });
        freshIds.push(reference.mentionId);
        return reference;
      }),
    };
    this.rememberFreshMentions(freshIds);
    this.applyDocument();
    if (freshIds.length > 0) this.notify();
    return freshIds.length;
  }

  reconcileConnections(): number {
    if (this.isComposing()) {
      this.pendingConnections = true;
      return 0;
    }
    this.syncFromEditor();
    // Presentation updates only touch atoms and never enter the user's undo history.
    if (this.editor != null) {
      const presentation = this.presentation();
      const references = new Map(
        this.document.items.flatMap((item) =>
          item.kind === "media_reference" ? [[item.mentionId, item] as const] : [],
        ),
      );
      const transaction = this.editor.state.tr;
      this.editor.state.doc.descendants((node, position) => {
        const item = references.get(String(node.attrs["mentionId"] ?? ""));
        if (item == null) return;
        const attrs = { ...node.attrs, ...promptReferenceToTiptapNode(item, presentation).attrs };
        if (!node.sameMarkup(node.type.create(attrs, null, node.marks)))
          transaction.setNodeMarkup(position, undefined, attrs, node.marks);
      });
      if (transaction.docChanged)
        this.editor.view.dispatch(
          transaction.setMeta("preventUpdate", true).setMeta("addToHistory", false),
        );
    }
    return 0;
  }

  replaceText(text: string): AutoMentionResolutionResult {
    const next: PromptContentDocumentV1 = {
      schema: "prompt-content",
      version: 1,
      items: text ? [{ kind: "text", text }] : [],
    };
    if (this.isComposing()) {
      this.pendingRestore = resolvePromptReferences(next, this.candidates, {
        mode: "explicit",
      }).document;
      return { converted: 0, ambiguous: 0, pending: this.read().pendingCount };
    }
    this.document = next;
    const result = this.resolveReferences("explicit", true, true);
    // 将解析后的文档应用到 tiptap 编辑器，否则 UI 不会更新（仅设置 this.document 不够）。
    // preserveSelection=false：完全替换后选区移到末尾；addToHistory=false：程序化替换不进入撤销历史。
    if (this.editor != null) {
      this.applyDocument(false, false);
    }
    this.notify();
    return result;
  }

  aliases() {
    return buildReferenceCatalog(this.candidates).aliases;
  }
  ambiguityCount(): number {
    return buildReferenceCatalog(this.candidates).ambiguousPatternCount;
  }
  ambiguityOptions(pattern: string) {
    return buildReferenceCatalog(this.candidates).options(pattern);
  }

  private mentionQueryContext(): { query: string; from: number; to: number } | null {
    if (this.editor == null || this.isComposing()) return null;
    this.flushDomObserver();
    const { $from, empty } = this.editor.state.selection;
    if (!empty) return null;
    // Atom nodes and hard breaks terminate a query, as does the current text block.
    const prefix = $from.parent.textBetween(0, $from.parentOffset, "\n", "\ufffc");
    const query = referenceQueryInText(prefix);
    return query == null
      ? null
      : { query: query.query, from: $from.pos - prefix.length + query.start, to: $from.pos };
  }

  mentionQueryAtCaret(): string | null {
    return this.mentionQueryContext()?.query ?? null;
  }

  removeMentionQueryAtCaret(): boolean {
    const context = this.mentionQueryContext();
    if (this.editor == null || context == null) return false;
    this.editor.chain().focus().deleteRange({ from: context.from, to: context.to }).run();
    this.syncFromEditor();
    return true;
  }

  pendingAt(target: EventTarget | null) {
    if (!(target instanceof HTMLElement) || this.host == null) return null;
    const pending = target.closest<HTMLElement>("[data-ambiguous-pattern]");
    if (pending == null || !this.host.contains(pending)) return null;
    const normalizedPattern = pending.dataset["ambiguousPattern"];
    if (!normalizedPattern) return null;
    return { normalizedPattern, displayText: pending.dataset["displayName"] ?? normalizedPattern };
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
    this.syncFromEditor();
    // 父层回传同一份快照时，不重建 DOM，也不把光标映射到整段文档的末尾。
    if (promptDocumentsEqual(decoded, this.document)) {
      this.pendingRestore = null;
      return this.read();
    }
    if (this.isComposing()) {
      this.pendingRestore = decoded;
      return this.read();
    }
    this.document = decoded;
    this.freshMentionIds.clear();
    if (this.editor != null) {
      this.applyDocument(false, false);
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
    this.updateConnections(
      context.connections.flatMap((connection) =>
        connection.target.kind === "url"
          ? []
          : [
              referenceCandidateFromTarget({
                canvasNodeKey: connection.key,
                name: connection.name,
                target: connection.target,
              }),
            ],
      ),
    );
    this.autoResolve({ fresh: false });
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

    const connectionByKey = new Map(
      context.connections.map((connection) => [connection.key, connection]),
    );
    const segments = view.segments.map((segment) => {
      if (segment.kind !== "media_reference") return segment;
      const canvasNodeKey = segment.target.canvasNodeKey;
      const position = canvasNodeKey != null ? positionByKey.get(canvasNodeKey) : undefined;
      if (position == null) return segment;
      return {
        ...segment,
        displayNameSnapshot:
          connectionByKey.get(canvasNodeKey!)?.name ?? segment.displayNameSnapshot,
        typePosition: position.typePosition,
        contentIndex: position.contentIndex,
      };
    });

    const mentionedCanvasNodeKeys = new Set(
      this.document.items.flatMap((item) =>
        item.kind === "media_reference" ? [item.canvasNodeKey] : [],
      ),
    );
    const explicitMedia: ExplicitMediaInput[] = context.connections.map((connection) => {
      const position = positionByKey.get(connection.key);
      return {
        target: structuredClone(connection.target),
        role: connection.role ?? "",
        displayNameSnapshot: connection.name,
        ...(position
          ? { typePosition: position.typePosition, contentIndex: position.contentIndex }
          : {}),
      };
    });
    return {
      ok: true,
      frozen: {
        segments: structuredClone(segments),
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
  candidates: readonly PromptReferenceCandidate[] = [],
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
    candidates: readonly PromptReferenceCandidate[],
  ): AutoMentionResolutionResult | null {
    let session = this.sessions.get(nodeKey);
    if (session == null) {
      // Source updates also apply to restored nodes that have never entered the viewport.
      session = createPromptContentEditorSession(candidates);
      this.sessions.set(nodeKey, session);
      this.pendingRestore.delete(nodeKey);
    }
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
