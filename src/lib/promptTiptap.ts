import { Node, type Extensions, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Placeholder, UndoRedo } from "@tiptap/extensions";
import type { MediaReferenceTarget, MediaType } from "./backend";
import { normalizePromptReferenceText } from "./promptReferences";
import { decodeMediaReferenceTarget } from "./promptReferenceTarget";
import {
  appendStyledText,
  promptMarkFromTiptapName,
  type PromptInlineMark,
  type PromptTextStyle,
} from "./promptRichText";
import type {
  PromptContentDocumentV1,
  PromptContentItem,
  PromptContentMarkReferenceItem,
  PromptContentMediaReferenceItem,
} from "./promptContent";

export const PROMPT_TIPTAP_MEDIA_REFERENCE_NODE = "mediaReference";
export const PROMPT_TIPTAP_PENDING_REFERENCE_NODE = "pendingReference";
export const PROMPT_TIPTAP_MARK_REFERENCE_NODE = "markReference";

/** 标注引用的展示信息：编号与所属帧只影响渲染，文档里保存的是插入时的快照。 */
export interface PromptMarkReferencePresentation {
  readonly label: string;
  /** 所属画面的时间读数，让 chip 能自己说明属于哪一帧。 */
  readonly frameLabel?: string;
  /** 属于其它时间点：本次提交不包含它，chip 用降级样式提示。 */
  readonly offFrame?: boolean;
}

export interface PromptTiptapPresentation {
  readonly connectedCanvasNodeKeys?: ReadonlySet<string>;
  readonly freshMentionIds?: ReadonlySet<string>;
  readonly invalidMentionIds?: ReadonlySet<string>;
  readonly referenceLabelsByKey?: ReadonlyMap<string, string>;
  readonly markReferencesByMarkId?: ReadonlyMap<string, PromptMarkReferencePresentation>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function jsonContentAttributes(node: JSONContent): Record<string, unknown> {
  const value: unknown = node.attrs;
  return isRecord(value) ? value : {};
}

function isMediaType(value: unknown): value is MediaType {
  return value === "image" || value === "video" || value === "audio";
}

function datasetForTarget(target: MediaReferenceTarget): Record<string, string> {
  if (target.kind === "asset") {
    return {
      "data-asset-id": target.assetId,
      "data-provider-id": target.providerConnectionId,
      "data-asset-source": "cloud",
      "data-reference-kind": "asset",
      "data-media-kind": target.mediaType,
    };
  }
  if (target.kind === "local_asset") {
    return {
      "data-asset-id": target.stagingJobId,
      "data-provider-id": "",
      "data-asset-source": "local",
      "data-reference-kind": "local_asset",
      "data-media-kind": target.mediaType,
    };
  }
  if (target.kind === "local_base64_asset") {
    return {
      "data-asset-id": target.assetId,
      "data-provider-id": "",
      "data-asset-source": "local",
      "data-reference-kind": "local_base64_asset",
      "data-media-kind": target.mediaType,
    };
  }
  if (target.kind === "local_file") {
    return {
      "data-asset-id": target.path,
      "data-provider-id": "",
      "data-asset-source": "local",
      "data-reference-kind": "local_file",
      "data-file-path": target.path,
      "data-media-kind": target.mediaType,
    };
  }
  return {
    "data-asset-id": `${target.generationTaskId}#${target.resultIndex}`,
    "data-provider-id": "",
    "data-asset-source": "cloud",
    "data-reference-kind": "local_result",
    "data-generation-task-id": target.generationTaskId,
    "data-result-index": String(target.resultIndex),
    "data-media-kind": target.mediaType,
  };
}

export function promptReferenceTargetFromElement(
  element: HTMLElement,
): MediaReferenceTarget | null {
  const canvasNodeKey = element.dataset["canvasNodeKey"] ?? "";
  const mediaType = element.dataset["mediaKind"];
  if (!canvasNodeKey || !isMediaType(mediaType)) return null;
  if (element.dataset["referenceKind"] === "local_file") {
    const path = element.dataset["filePath"] ?? element.dataset["assetId"] ?? "";
    return path ? { kind: "local_file", path, canvasNodeKey, mediaType } : null;
  }
  if (element.dataset["referenceKind"] === "local_result") {
    const generationTaskId = element.dataset["generationTaskId"] ?? "";
    const resultIndex = Number.parseInt(element.dataset["resultIndex"] ?? "", 10);
    return generationTaskId && Number.isInteger(resultIndex) && resultIndex >= 0
      ? { kind: "local_result", generationTaskId, resultIndex, canvasNodeKey, mediaType }
      : null;
  }
  if (element.dataset["referenceKind"] === "local_base64_asset") {
    const assetId = element.dataset["assetId"] ?? "";
    return assetId ? { kind: "local_base64_asset", assetId, canvasNodeKey, mediaType } : null;
  }
  if (
    element.dataset["referenceKind"] === "local_asset" ||
    element.dataset["assetSource"] === "local"
  ) {
    const stagingJobId = element.dataset["assetId"] ?? "";
    return stagingJobId ? { kind: "local_asset", stagingJobId, canvasNodeKey, mediaType } : null;
  }
  const providerConnectionId = element.dataset["providerId"] ?? "";
  const assetId = element.dataset["assetId"] ?? "";
  return providerConnectionId && assetId
    ? { kind: "asset", providerConnectionId, assetId, canvasNodeKey, mediaType }
    : null;
}

const MediaReference = Node.create({
  name: PROMPT_TIPTAP_MEDIA_REFERENCE_NODE,
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      mentionId: { default: "" },
      canvasNodeKey: { default: "" },
      target: { default: null, rendered: false },
      displayNameSnapshot: { default: "" },
      learnedPattern: { default: null },
      aliasSnapshot: { default: null },
      slotSnapshot: { default: null },
      referenceLabel: { default: null, rendered: false },
      fresh: { default: false, rendered: false },
      stale: { default: false, rendered: false },
    };
  },

  parseHTML() {
    return [
      {
        tag: "span[data-mention-id]",
        getAttrs: (node) => {
          if (!(node instanceof HTMLElement)) return false;
          const target = promptReferenceTargetFromElement(node);
          const mentionId = node.dataset["mentionId"] ?? "";
          const canvasNodeKey = node.dataset["canvasNodeKey"] ?? "";
          if (!target || !mentionId || !canvasNodeKey) return false;
          const slotSnapshot = Number.parseInt(node.dataset["slotSnapshot"] ?? "", 10);
          return {
            mentionId,
            canvasNodeKey,
            target,
            displayNameSnapshot: node.dataset["displayName"] ?? "",
            learnedPattern: node.dataset["autoPattern"] ?? null,
            aliasSnapshot: node.dataset["autoAlias"] ?? null,
            slotSnapshot: Number.isInteger(slotSnapshot) ? slotSnapshot : null,
            referenceLabel: node.dataset["referenceLabel"] ?? null,
            fresh: node.dataset["auto"] === "true",
            stale: node.classList.contains("is-stale"),
          };
        },
      },
    ];
  },

  renderHTML({ node }) {
    const target = decodeMediaReferenceTarget(node.attrs["target"]);
    const displayName = String(node.attrs["displayNameSnapshot"] ?? "");
    const alias = String(node.attrs["referenceLabel"] ?? node.attrs["aliasSnapshot"] ?? "");
    const attrs: Record<string, string> = {
      class: `mention-chip${node.attrs["fresh"] ? " is-fresh" : ""}${node.attrs["stale"] ? " is-stale" : ""}`,
      contenteditable: "false",
      "data-mention-id": String(node.attrs["mentionId"] ?? ""),
      "data-canvas-node-key": String(node.attrs["canvasNodeKey"] ?? ""),
      "data-display-name": displayName,
      title: `${displayName}${alias ? ` · ${alias}` : ""} · ${
        target?.kind === "asset"
          ? target.assetId
          : target?.kind === "local_asset"
            ? target.stagingJobId
            : target?.kind === "local_base64_asset"
              ? target.assetId
              : target?.kind === "local_file"
                ? target.path
                : target
                  ? `${target.generationTaskId}#${target.resultIndex}`
                  : ""
      } · ${String(node.attrs["canvasNodeKey"] ?? "")}`,
    };
    if (target) Object.assign(attrs, datasetForTarget(target));
    if (node.attrs["fresh"]) attrs["data-auto"] = "true";
    if (typeof node.attrs["learnedPattern"] === "string" && node.attrs["learnedPattern"])
      attrs["data-auto-pattern"] = node.attrs["learnedPattern"];
    if (typeof node.attrs["aliasSnapshot"] === "string" && node.attrs["aliasSnapshot"])
      attrs["data-auto-alias"] = node.attrs["aliasSnapshot"];
    if (typeof node.attrs["slotSnapshot"] === "number")
      attrs["data-slot-snapshot"] = String(node.attrs["slotSnapshot"]);
    if (alias) attrs["data-reference-label"] = alias;
    return ["span", attrs, `@${displayName}${alias ? ` · ${alias}` : ""}`];
  },

  renderText({ node }) {
    const displayName = String(node.attrs["displayNameSnapshot"] ?? "");
    const alias = String(node.attrs["referenceLabel"] ?? node.attrs["aliasSnapshot"] ?? "");
    return `@${displayName}${alias ? ` · ${alias}` : ""}`;
  },
});

const PendingReference = Node.create({
  name: PROMPT_TIPTAP_PENDING_REFERENCE_NODE,
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      normalizedPattern: { default: "" },
      displayText: { default: "" },
      candidateCount: { default: 2 },
    };
  },

  parseHTML() {
    return [
      {
        tag: "span[data-ambiguous-pattern]",
        getAttrs: (node) => {
          if (!(node instanceof HTMLElement)) return false;
          return {
            normalizedPattern: node.dataset["ambiguousPattern"] ?? "",
            displayText: node.dataset["displayName"] ?? "",
            candidateCount: Math.max(2, Number.parseInt(node.dataset["candidateCount"] ?? "2", 10)),
          };
        },
      },
    ];
  },

  renderHTML({ node }) {
    const displayText = String(node.attrs["displayText"] ?? "");
    const candidateCount = Math.max(2, Number(node.attrs["candidateCount"] ?? 2));
    return [
      "span",
      {
        class: "mention-chip mention-chip--ambiguous",
        contenteditable: "false",
        role: "button",
        tabindex: "0",
        "aria-label": `${displayText} 有 ${candidateCount} 个同名素材，按回车选择具体对象`,
        "data-ambiguous-pattern": String(node.attrs["normalizedPattern"] ?? ""),
        "data-display-name": displayText,
        "data-candidate-count": String(candidateCount),
        title: `找到 ${candidateCount} 个同名素材，点击选择具体对象`,
      },
      `@${displayText} · 待确认`,
    ];
  },

  renderText({ node }) {
    return `@${String(node.attrs["displayText"] ?? "")} · 待确认`;
  },
});

/**
 * 标注引用 chip：引用的是画面上的区域标记，而不是可下载的素材。
 *
 * 它没有后端可解析的来源身份，导出提示词时按「编号（颜色工具，画面范围）」展开为正文，
 * 因此不需要后端 PromptSegment 支持新类型；`labelSnapshot` 只是插入当时的编号快照，
 * 展示用的编号与所属帧由 presentation 提供，保证与标记清单、画面上的序号一致。
 */
const MarkReference = Node.create({
  name: PROMPT_TIPTAP_MARK_REFERENCE_NODE,
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      mentionId: { default: "" },
      markId: { default: "" },
      labelSnapshot: { default: "" },
      descriptionSnapshot: { default: "" },
      color: { default: "" },
      label: { default: null, rendered: false },
      frameLabel: { default: null, rendered: false },
      offFrame: { default: false, rendered: false },
    };
  },

  parseHTML() {
    return [
      {
        tag: "span[data-mark-id]",
        getAttrs: (node) => {
          if (!(node instanceof HTMLElement)) return false;
          const markId = node.dataset["markId"] ?? "";
          const labelSnapshot = node.dataset["displayName"] ?? "";
          const descriptionSnapshot = node.dataset["markDescription"] ?? "";
          if (!markId || !labelSnapshot) return false;
          return {
            mentionId: node.dataset["markMentionId"] ?? "",
            markId,
            labelSnapshot,
            descriptionSnapshot,
            color: node.dataset["markColor"] ?? "",
            label: null,
            frameLabel: null,
            offFrame: false,
          };
        },
      },
    ];
  },

  renderHTML({ node }) {
    const markId = String(node.attrs["markId"] ?? "");
    const description = String(node.attrs["descriptionSnapshot"] ?? "");
    const color = String(node.attrs["color"] ?? "");
    const label = String(node.attrs["label"] ?? node.attrs["labelSnapshot"] ?? "");
    const frameLabel = String(node.attrs["frameLabel"] ?? "");
    const offFrame = node.attrs["offFrame"] === true;
    const title = [label, frameLabel, description, offFrame ? "属于其它时间点，本次不提交" : ""]
      .filter(Boolean)
      .join(" · ");
    return [
      "span",
      {
        class: `mention-chip mention-chip--mark${offFrame ? " is-off-frame" : ""}`,
        contenteditable: "false",
        "data-mark-id": markId,
        "data-mark-mention-id": String(node.attrs["mentionId"] ?? ""),
        "data-mark-color": color,
        "data-mark-description": description,
        "data-display-name": label,
        title,
        style: `--annotation-color: ${color}`,
      },
      `@${label}`,
    ];
  },

  renderText({ node }) {
    const label = String(node.attrs["label"] ?? node.attrs["labelSnapshot"] ?? "");
    return `${label}（${String(node.attrs["descriptionSnapshot"] ?? "")}）`;
  },
});

export function createPromptTiptapExtensions(placeholder: string): Extensions {
  return [
    // StarterKit 覆盖段落/文本/硬换行与全部富格式标记（标题、列表、引用、代码块、
    // 粗斜下划删除线等）；undoRedo 关闭——会话统一使用 @tiptap/extensions 的 UndoRedo。
    StarterKit.configure({ undoRedo: false }),
    MediaReference,
    PendingReference,
    MarkReference,
    Placeholder.configure({ placeholder }),
    UndoRedo,
  ];
}

function appendText(items: PromptContentItem[], text: string): void {
  appendStyledText(items, text);
}

export function plainTextToTiptapContent(text: string): JSONContent[] {
  const nodes: JSONContent[] = [];
  const lines = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  lines.forEach((line, index) => {
    if (line) nodes.push({ type: "text", text: line });
    if (index < lines.length - 1) nodes.push({ type: "hardBreak" });
  });
  return nodes;
}

export function promptReferenceToTiptapNode(
  item: PromptContentMediaReferenceItem,
  presentation: PromptTiptapPresentation = {},
): JSONContent {
  return {
    type: PROMPT_TIPTAP_MEDIA_REFERENCE_NODE,
    attrs: {
      mentionId: item.mentionId,
      canvasNodeKey: item.canvasNodeKey,
      target: structuredClone(item.target),
      displayNameSnapshot: item.displayNameSnapshot,
      learnedPattern: item.learnedPattern ?? null,
      aliasSnapshot: item.aliasSnapshot ?? null,
      slotSnapshot: item.slotSnapshot ?? null,
      referenceLabel: presentation.referenceLabelsByKey?.get(item.canvasNodeKey) ?? null,
      fresh: presentation.freshMentionIds?.has(item.mentionId) ?? false,
      stale:
        presentation.invalidMentionIds?.has(item.mentionId) ??
        (presentation.connectedCanvasNodeKeys
          ? !presentation.connectedCanvasNodeKeys.has(item.canvasNodeKey)
          : false),
    },
  };
}

export function promptMarkReferenceToTiptapNode(
  item: PromptContentMarkReferenceItem,
  presentation: PromptTiptapPresentation = {},
): JSONContent {
  const shown = presentation.markReferencesByMarkId?.get(item.markId);
  return {
    type: PROMPT_TIPTAP_MARK_REFERENCE_NODE,
    attrs: {
      mentionId: item.mentionId,
      markId: item.markId,
      labelSnapshot: item.labelSnapshot,
      descriptionSnapshot: item.descriptionSnapshot,
      color: item.color,
      label: shown?.label ?? null,
      frameLabel: shown?.frameLabel ?? null,
      offFrame: shown?.offFrame ?? false,
    },
  };
}

const HEADING_LEVELS = { heading1: 1, heading2: 2, heading3: 3 } as const;

/**
 * 把一个块内的条目流转换成 tiptap 行内节点：连续同格式的 text 条目并成一个
 * text 节点（行内格式挂在 marks 上），文本内的 "\n" 拆成 hardBreak，引用 chip 原样落位。
 */
function inlineItemsToTiptapContent(
  items: readonly PromptContentItem[],
  presentation: PromptTiptapPresentation,
): JSONContent[] {
  const content: JSONContent[] = [];
  const pushRun = (text: string, marks: readonly PromptInlineMark[]) => {
    const lines = text.split("\n");
    lines.forEach((line, index) => {
      if (line)
        content.push({
          type: "text",
          text: line,
          ...(marks.length > 0 ? { marks: marks.map((mark) => ({ type: mark })) } : {}),
        });
      if (index < lines.length - 1) content.push({ type: "hardBreak" });
    });
  };
  let runText = "";
  let runMarks: readonly PromptInlineMark[] = [];
  let runOpen = false;
  const flushRun = () => {
    if (!runOpen) return;
    pushRun(runText, runMarks);
    runText = "";
    runOpen = false;
  };
  for (const item of items) {
    if (item.kind === "text") {
      const marks = item.marks ?? [];
      if (runOpen && marks.join("\u0000") !== runMarks.join("\u0000")) flushRun();
      if (!runOpen) {
        runMarks = marks;
        runOpen = true;
      }
      runText += item.text;
      continue;
    }
    flushRun();
    if (item.kind === "media_reference") {
      content.push(promptReferenceToTiptapNode(item, presentation));
    } else if (item.kind === "mark_reference") {
      content.push(promptMarkReferenceToTiptapNode(item, presentation));
    } else {
      content.push({
        type: PROMPT_TIPTAP_PENDING_REFERENCE_NODE,
        attrs: {
          normalizedPattern: item.normalizedPattern,
          displayText: item.displayText,
          candidateCount: item.candidateCount,
        },
      });
    }
  }
  flushRun();
  return content;
}

interface PromptListFrame {
  readonly kind: "bullet" | "ordered";
  readonly indent: number;
  readonly listNode: JSONContent;
  lastListItem: JSONContent | null;
}

export function promptDocumentToTiptapJson(
  document: PromptContentDocumentV1,
  presentation: PromptTiptapPresentation = {},
): JSONContent {
  const blocks: JSONContent[] = [];
  let paragraphItems: PromptContentItem[] = [];
  const listStack: PromptListFrame[] = [];
  // 最近一个可承接行内内容的结构化块（标题/引用/列表项段落）的内容数组。
  // 标题里的引用 chip 在 canonical 里不带块上下文，重建时靠它回到标题内。
  let lastInlineHost: JSONContent[] | null = null;

  const flushParagraph = () => {
    if (paragraphItems.length === 0) return;
    const content = inlineItemsToTiptapContent(paragraphItems, presentation);
    paragraphItems = [];
    if (content.length > 0) blocks.push({ type: "paragraph", content });
    // 普通段落落位后，尾随 chip 属于这个段落而不是更早的结构化块。
    lastInlineHost = null;
  };

  for (const item of document.items) {
    if (item.kind === "text" && (item.block == null || item.block === "code")) {
      if (item.block === "code") {
        flushParagraph();
        blocks.push({
          type: "codeBlock",
          ...(item.text ? { content: [{ type: "text", text: item.text }] } : {}),
        });
        continue;
      }
      paragraphItems.push(item);
      continue;
    }
    if (item.kind === "text" && item.block === "hr") {
      flushParagraph();
      blocks.push({ type: "horizontalRule" });
      continue;
    }
    if (item.kind === "text" && (item.block === "bullet" || item.block === "ordered")) {
      let depth = item.indent ?? 0;
      // 弹掉更深的层级；同深度但类型不同的列表也闭合（同级切换 bullet↔ordered）。
      while (listStack.length > 0) {
        const topFrame = listStack.at(-1)!;
        if (topFrame.indent > depth || (topFrame.indent === depth && topFrame.kind !== item.block))
          listStack.pop();
        else break;
      }
      const top = listStack.at(-1);
      let frame: PromptListFrame;
      if (top != null && top.kind === item.block && top.indent === depth) {
        frame = top;
      } else {
        // 新建嵌套层：深度至少比父层深一级，避免存档里的跳级缩进生成悬空层级。
        if (top != null) depth = Math.max(depth, top.indent + 1);
        const listNode = {
          type: item.block === "bullet" ? "bulletList" : "orderedList",
          content: [] as JSONContent[],
        };
        if (top == null) {
          flushParagraph();
          blocks.push(listNode);
        } else {
          top.lastListItem?.content?.push(listNode);
        }
        frame = { kind: item.block, indent: depth, listNode, lastListItem: null };
        listStack.push(frame);
      }
      const content = inlineItemsToTiptapContent([item], presentation);
      const listItem: JSONContent = {
        type: "listItem",
        content: [{ type: "paragraph", content }],
      };
      frame.listNode.content!.push(listItem);
      frame.lastListItem = listItem;
      lastInlineHost = content;
      continue;
    }
    if (item.kind === "text" && item.block === "blockquote") {
      flushParagraph();
      const content = inlineItemsToTiptapContent([item], presentation);
      blocks.push({ type: "blockquote", content: [{ type: "paragraph", content }] });
      lastInlineHost = content;
      continue;
    }
    if (item.kind === "text") {
      const level = HEADING_LEVELS[item.block as keyof typeof HEADING_LEVELS];
      if (level != null) {
        flushParagraph();
        const content = inlineItemsToTiptapContent([item], presentation);
        blocks.push({ type: "heading", attrs: { level }, content });
        lastInlineHost = content;
        continue;
      }
    }
    if (paragraphItems.length === 0 && lastInlineHost != null) {
      // 纯 chip 跟在结构化块后面：回流到那个块里，避免被拆成独立段落。
      lastInlineHost.push(...inlineItemsToTiptapContent([item], presentation));
      continue;
    }
    // 引用等行内条目落到当前段落缓冲，与相邻文本同块。
    paragraphItems.push(item);
  }
  // 列表帧在创建时已挂进文档；这里只需闭合段落缓冲。
  flushParagraph();
  const content = blocks.length > 0 ? blocks : [{ type: "paragraph" }];
  return { type: "doc", content };
}

export function promptDocumentFromTiptapJson(value: JSONContent): PromptContentDocumentV1 {
  const items: PromptContentItem[] = [];
  const mentionIds = new Set<string>();
  let previousPlainParagraph = false;

  // 跨块的行内内容默认合流；结构化块（标题/引用/列表项）传入独立 sink，
  // 避免相邻同格式块的文本被 appendStyledText 焊成一个条目、丢失块边界。
  const walkInline = (
    nodes: JSONContent[],
    style: PromptTextStyle,
    sink: PromptContentItem[] = items,
  ) => {
    for (const node of nodes) {
      if (node.type === "text") {
        const marks = (node.marks ?? [])
          .map((mark) => promptMarkFromTiptapName(String(mark.type ?? "")))
          .filter((mark): mark is PromptInlineMark => mark != null);
        appendStyledText(sink, node.text ?? "", {
          ...style,
          ...(marks.length > 0 ? { marks } : {}),
        });
        continue;
      }
      if (node.type === "hardBreak") {
        appendStyledText(sink, "\n", style);
        continue;
      }
      if (node.type === PROMPT_TIPTAP_MEDIA_REFERENCE_NODE) {
        const attrs = jsonContentAttributes(node);
        const target = decodeMediaReferenceTarget(attrs["target"]);
        const canvasNodeKey = attrs["canvasNodeKey"];
        const displayNameSnapshot = attrs["displayNameSnapshot"];
        if (
          !target ||
          typeof canvasNodeKey !== "string" ||
          !canvasNodeKey ||
          typeof displayNameSnapshot !== "string"
        ) {
          appendText(sink, typeof displayNameSnapshot === "string" ? displayNameSnapshot : "");
          continue;
        }
        const rawMentionId = attrs["mentionId"];
        const mentionId =
          typeof rawMentionId === "string" && rawMentionId && !mentionIds.has(rawMentionId)
            ? rawMentionId
            : `mention-${globalThis.crypto.randomUUID()}`;
        mentionIds.add(mentionId);
        const learnedPattern = attrs["learnedPattern"];
        const aliasSnapshot = attrs["aliasSnapshot"];
        const slotSnapshot = attrs["slotSnapshot"];
        sink.push({
          kind: "media_reference",
          mentionId,
          canvasNodeKey,
          target,
          displayNameSnapshot,
          ...(typeof learnedPattern === "string" && learnedPattern
            ? { learnedPattern: normalizePromptReferenceText(learnedPattern) }
            : {}),
          ...(typeof aliasSnapshot === "string" && aliasSnapshot ? { aliasSnapshot } : {}),
          ...(typeof slotSnapshot === "number" &&
          Number.isInteger(slotSnapshot) &&
          slotSnapshot >= 0
            ? { slotSnapshot }
            : {}),
        });
        continue;
      }
      if (node.type === PROMPT_TIPTAP_MARK_REFERENCE_NODE) {
        const attrs = jsonContentAttributes(node);
        const markId = attrs["markId"];
        const labelSnapshot = attrs["labelSnapshot"];
        const descriptionSnapshot = attrs["descriptionSnapshot"];
        const color = attrs["color"];
        if (typeof markId !== "string" || !markId || typeof labelSnapshot !== "string") {
          appendText(sink, typeof labelSnapshot === "string" ? labelSnapshot : "");
          continue;
        }
        const rawMentionId = attrs["mentionId"];
        const mentionId =
          typeof rawMentionId === "string" && rawMentionId && !mentionIds.has(rawMentionId)
            ? rawMentionId
            : `mark-${globalThis.crypto.randomUUID()}`;
        mentionIds.add(mentionId);
        sink.push({
          kind: "mark_reference",
          mentionId,
          markId,
          labelSnapshot,
          descriptionSnapshot: typeof descriptionSnapshot === "string" ? descriptionSnapshot : "",
          color: typeof color === "string" ? color : "",
        });
        continue;
      }
      if (node.type === PROMPT_TIPTAP_PENDING_REFERENCE_NODE) {
        const attrs = jsonContentAttributes(node);
        const normalizedPattern = attrs["normalizedPattern"];
        const displayText = attrs["displayText"];
        const candidateCount = attrs["candidateCount"];
        if (typeof normalizedPattern === "string" && typeof displayText === "string") {
          sink.push({
            kind: "pending_reference",
            normalizedPattern: normalizePromptReferenceText(normalizedPattern),
            displayText,
            candidateCount:
              typeof candidateCount === "number" && Number.isFinite(candidateCount)
                ? Math.max(2, Math.floor(candidateCount))
                : 2,
          });
        }
        continue;
      }
      walkInline(node.content ?? [], style, sink);
    }
  };

  const walkList = (listNode: JSONContent, kind: "bullet" | "ordered", indent: number) => {
    for (const listItem of listNode.content ?? []) {
      for (const child of listItem.content ?? []) {
        if (child.type === "bulletList") walkList(child, "bullet", indent + 1);
        else if (child.type === "orderedList") walkList(child, "ordered", indent + 1);
        else {
          // 每个列表项独立成条：相邻同格式列表项不能在 canonical 里被合并。
          const sink: PromptContentItem[] = [];
          walkInline(child.content ?? [], { block: kind, ...(indent > 0 ? { indent } : {}) }, sink);
          items.push(...sink);
        }
      }
    }
  };

  const blocks = value.content ?? [];
  blocks.forEach((block) => {
    switch (block.type) {
      case "heading": {
        const level = Number(jsonContentAttributes(block)["level"] ?? 1);
        const heading =
          level === 1 ? "heading1" : level === 2 ? "heading2" : level === 3 ? "heading3" : null;
        if (heading == null) break;
        {
          const sink: PromptContentItem[] = [];
          walkInline(block.content ?? [], { block: heading }, sink);
          items.push(...sink);
        }
        previousPlainParagraph = false;
        return;
      }
      case "blockquote": {
        for (const child of block.content ?? []) {
          const sink: PromptContentItem[] = [];
          walkInline(child.content ?? [], { block: "blockquote" }, sink);
          items.push(...sink);
        }
        previousPlainParagraph = false;
        return;
      }
      case "bulletList":
        walkList(block, "bullet", 0);
        previousPlainParagraph = false;
        return;
      case "orderedList":
        walkList(block, "ordered", 0);
        previousPlainParagraph = false;
        return;
      case "codeBlock": {
        const code = (block.content ?? []).map((child) => child.text ?? "").join("");
        items.push({ kind: "text", text: code, block: "code" });
        previousPlainParagraph = false;
        return;
      }
      case "horizontalRule":
        items.push({ kind: "text", text: "", block: "hr" });
        previousPlainParagraph = false;
        return;
      case undefined:
      default:
        break;
    }
    // 普通段落：仅在「上一块也是普通段落」时补换行，结构化块自定界。
    if (previousPlainParagraph) appendText(items, "\n");
    walkInline(block.content ?? [], {});
    previousPlainParagraph = true;
  });
  return { schema: "prompt-content", version: 1, items };
}
