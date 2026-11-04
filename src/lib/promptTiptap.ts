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
export const PROMPT_TIPTAP_ATTACHMENT_NODE = "attachment";

/** 附件 chip 的类型图标；纯字形渲染，不依赖图标库。 */
const ATTACHMENT_KIND_GLYPH: Record<string, string> = {
  image: "🖼",
  video: "🎞",
  audio: "🎧",
  document: "📄",
};

function attachmentDataset(target: MediaReferenceTarget): Record<string, string> {
  if (target.kind === "local_base64_asset")
    return { "data-attachment-target": "local_base64_asset", "data-asset-id": target.assetId };
  if (target.kind === "local_asset")
    return { "data-attachment-target": "local_asset", "data-staging-job-id": target.stagingJobId };
  if (target.kind === "local_file")
    return { "data-attachment-target": "local_file", "data-file-path": target.path };
  return {};
}

function attachmentTargetFromElement(element: HTMLElement): MediaReferenceTarget | null {
  const kind = element.dataset["attachmentTarget"];
  const mediaKind = element.dataset["mediaKind"];
  if (!kind || !isMediaType(mediaKind)) return null;
  if (kind === "local_base64_asset") {
    const assetId = element.dataset["assetId"] ?? "";
    return assetId ? { kind: "local_base64_asset", assetId, mediaType: mediaKind } : null;
  }
  if (kind === "local_asset") {
    const stagingJobId = element.dataset["stagingJobId"] ?? "";
    return stagingJobId ? { kind: "local_asset", stagingJobId, mediaType: mediaKind } : null;
  }
  const path = element.dataset["filePath"] ?? "";
  return path ? { kind: "local_file", path, mediaType: mediaKind } : null;
}

const Attachment = Node.create({
  name: PROMPT_TIPTAP_ATTACHMENT_NODE,
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      attachmentId: { default: "" },
      name: { default: "" },
      mediaType: { default: "image" },
      target: { default: null, rendered: false },
    };
  },

  parseHTML() {
    return [
      {
        tag: "span[data-attachment-id]",
        getAttrs: (node) => {
          if (!(node instanceof HTMLElement)) return false;
          const target = attachmentTargetFromElement(node);
          const attachmentId = node.dataset["attachmentId"] ?? "";
          const name = node.dataset["attachmentName"] ?? "";
          if (!target || !attachmentId || !name) return false;
          return {
            attachmentId,
            name,
            mediaType: target.mediaType,
            target,
          };
        },
      },
    ];
  },

  renderHTML({ node }) {
    const target = decodeMediaReferenceTarget(node.attrs["target"]);
    const name = String(node.attrs["name"] ?? "");
    const mediaType = String(node.attrs["mediaType"] ?? "image");
    const attrs: Record<string, string> = {
      class: "prompt-attachment",
      contenteditable: "false",
      "data-attachment-id": String(node.attrs["attachmentId"] ?? ""),
      "data-attachment-name": name,
      "data-media-kind": mediaType,
      title: `${name} · 直接附加的${ATTACHMENT_KIND_GLYPH[mediaType] ? "媒体文件" : "文件"}`,
    };
    if (target) Object.assign(attrs, attachmentDataset(target));
    return ["span", attrs, `${ATTACHMENT_KIND_GLYPH[mediaType] ?? "📄"} ${name}`];
  },

  renderText({ node }) {
    return `[附件:${String(node.attrs["name"] ?? "")}]`;
  },
});

export function promptAttachmentToTiptapNode(item: {
  readonly attachmentId: string;
  readonly target: MediaReferenceTarget;
  readonly name: string;
  readonly mediaType: string;
}): JSONContent {
  return {
    type: PROMPT_TIPTAP_ATTACHMENT_NODE,
    attrs: {
      attachmentId: item.attachmentId,
      name: item.name,
      mediaType: item.mediaType,
      target: structuredClone(item.target),
    },
  };
}

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
        ...(markId.startsWith("image-mark-") ? { role: "button", tabindex: "0", "aria-haspopup": "menu", "aria-label": `局部元素：${label}` } : {}),
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

export function createPromptTiptapExtensions(placeholder: string | (() => string)): Extensions {
  return [
    // StarterKit 覆盖段落/文本/硬换行与全部富格式标记（标题、列表、引用、代码块、
    // 粗斜下划删除线等）；undoRedo 关闭——会话统一使用 @tiptap/extensions 的 UndoRedo。
    StarterKit.configure({ undoRedo: false }),
    MediaReference,
    PendingReference,
    MarkReference,
    Attachment,
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
    } else if (item.kind === "attachment") {
      content.push(promptAttachmentToTiptapNode(item));
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
  /*
   * 「块内夹 chip」的还原状态。
   *
   * canonical 把 chip 存成独立条目后，一个列表项/标题里写了 @引用会变成
   * 「文本 → chip → 文本」三条。少了 `lastChipTrailing` 就无法区分：
   *   - chip **不是**块末尾（trailing 不为 true）→ 它后面的同块文本与它属于
   *     **同一个**列表项，必须并回同一个 listItem；
   *   - chip 是块末尾（trailing=true）→ 它后面的同块文本属于**下一个**列表项。
   * 判错的后果是一个列表项裂成两个、有序列表编号错位（存盘后结构永久损坏）。
   *
   * `lastBlockInline` 记着上一个块的行内内容数组与它的块身份，
   * 合并时把当前文本追加进去（chip 已经通过 lastInlineHost 先进来了）。
   */
  let lastBlockInline: {
    readonly block: string;
    readonly indent: number;
    readonly content: JSONContent[];
  } | null = null;
  /** 上一个条目是不是 chip，以及它是否为本块末尾；null = 上一个条目不是 chip。 */
  let lastChipTrailing: boolean | null = null;

  const flushParagraph = () => {
    /*
     * 注意：即使没有待落位的段落，也必须清掉 `lastInlineHost`。
     *
     * `lastInlineHost` 是「最近一个可承接行内内容的结构化块」。它必须**只**指向
     * 紧邻上一个块：如果代码块 / 分割线 / 列表项之后还留着旧的引用块指针，
     * 后面出现的纯 chip 就会被塞回那个**更早**的引用块里 ——
     * 于是「引用块 → 代码块 → 分割线 → @引用」的文档还原后，@引用跑到了
     * 上方的引用块里，位置被重排。而 canonical 每次落盘都从编辑器 JSON 重新推导，
     * 这个重排会被**固化进存档**，重开画布就变样了。
     */
    lastInlineHost = null;
    /*
     * 段落是**块边界**：它把列表序列切断，列表栈必须在这里清空。
     *
     * 编辑器（ProseMirror）里被段落隔开的两段列表是**两个独立节点**，还原时
     * 也必须还原成两个。列表栈若不在边界处清空，后一段同类型同深度的列表会
     * 命中「复用同一 listNode」的分支，被焊进上一段列表 —— 有序编号连号而不是
     * 各自从 1 起算，而夹在中间的那段段落会被挪到整个列表**之后**（位置漂移）。
     * 这两条都是 AGENTS.md 明令禁止的「存盘后结构永久损坏」，而且 canonical
     * 每次落盘都从编辑器 JSON 重新推导，损坏会被固化进存档。
     */
    listStack.length = 0;
    if (paragraphItems.length === 0) return;
    const content = inlineItemsToTiptapContent(paragraphItems, presentation);
    paragraphItems = [];
    if (content.length > 0) blocks.push({ type: "paragraph", content });
  };

  /**
   * 尝试把当前块级文本**并回上一个块**。
   *
   * 成立条件：上一个条目是 chip、且它不是块末尾（trailing 不为 true）——
   * 说明 chip 后面还有同块文本，而当前这条就是那段文本，两者属于同一个块。
   * 合并失败返回 false（调用方走「新建块」的路径）。
   */
  const tryMergeIntoPreviousBlock = (
    block: string,
    indent: number,
    content: JSONContent[],
  ): boolean => {
    if (lastChipTrailing !== false) return false;
    const previous = lastBlockInline;
    if (previous == null) return false;
    if (previous.block !== block || previous.indent !== indent) return false;
    previous.content.push(...content);
    lastInlineHost = previous.content;
    lastChipTrailing = null;
    return true;
  };

  /**
   * 打开（或续用）一个列表块，返回它所属的帧与实际缩进层级。
   *
   * 文本条目与**带块上下文的 chip** 都要走这里 —— chip 自己知道属于哪个列表项，
   * 不必再靠 `trailing` 猜。
   */
  const openListFrame = (
    kind: "bullet" | "ordered",
    requestedDepth: number,
  ): { readonly frame: PromptListFrame; readonly depth: number } => {
    let depth = requestedDepth;
    // 弹掉更深的层级；同深度但类型不同的列表也闭合（同级切换 bullet↔ordered）。
    while (listStack.length > 0) {
      const topFrame = listStack.at(-1)!;
      if (topFrame.indent > depth || (topFrame.indent === depth && topFrame.kind !== kind))
        listStack.pop();
      else break;
    }
    const top = listStack.at(-1);
    if (top != null && top.kind === kind && top.indent === depth) {
      return { frame: top, depth };
    }
    // 新建嵌套层：深度至少比父层深一级，避免存档里的跳级缩进生成悬空层级。
    if (top != null) depth = Math.max(depth, top.indent + 1);
    const listNode = {
      type: kind === "bullet" ? "bulletList" : "orderedList",
      content: [] as JSONContent[],
    };
    if (top == null) {
      flushParagraph();
      blocks.push(listNode);
    } else {
      top.lastListItem?.content?.push(listNode);
    }
    const frame: PromptListFrame = { kind, indent: depth, listNode, lastListItem: null };
    listStack.push(frame);
    return { frame, depth };
  };

  for (const item of document.items) {
    if (item.kind === "text" && (item.block == null || item.block === "code")) {
      if (item.block === "code") {
        flushParagraph();
        blocks.push({
          type: "codeBlock",
          ...(item.text ? { content: [{ type: "text", text: item.text }] } : {}),
        });
        // 代码块是新的结构化边界：后面出现的纯 chip 不能回流到更早的块里。
        lastInlineHost = null;
        continue;
      }
      paragraphItems.push(item);
      /*
       * 普通段落是**块边界**：它把列表序列切开。
       *
       * 编辑器（ProseMirror）里被段落隔开的两段列表是两个独立节点，还原时
       * 也必须还原成两个。列表栈若不在这里断开，后一段同类型同深度的列表
       * 会命中「复用同一 listNode」的分支被焊进上一段（有序编号连号而不是
       * 各自从 1 起算），而夹在中间的那段段落会被挪到整个列表之后（位置漂移）。
       * 两条都是 AGENTS.md 明令禁止的「存盘后结构永久损坏」，而 canonical 每次
       * 落盘都从编辑器 JSON 重新推导，损坏会被固化进存档。
       *
       * 断开列表栈的同时也要断开「块内 chip 续接」的状态：上一个 chip 若不是
       * 块末尾（trailing 不为 true），后面的**同块**文本要并回上一个块。
       * 段落是另一个块，不能并回去 —— 否则后面新出现的列表项会被塞进
       * 段落之前那个早已结束的列表项里，列表凭空多出一项。
       */
      listStack.length = 0;
      lastChipTrailing = null;
      lastBlockInline = null;
      continue;
    }
    if (item.kind === "text" && item.block === "hr") {
      flushParagraph();
      blocks.push({ type: "horizontalRule" });
      // 分割线同理：它是边界，chip 不该越过分割线回到上方块里。
      lastInlineHost = null;
      continue;
    }
    if (item.kind === "text" && (item.block === "bullet" || item.block === "ordered")) {
      const { frame, depth } = openListFrame(item.block, item.indent ?? 0);
      const content = inlineItemsToTiptapContent([item], presentation);
      // 「列表项里夹了一个 @引用」：并回上一个列表项，而不是新建一个。
      // 合并后 listItem 本身没变（内容追加进它的段落），所以 frame.lastListItem 不动。
      if (tryMergeIntoPreviousBlock(item.block, depth, content)) {
        continue;
      }
      const listItem: JSONContent = {
        type: "listItem",
        content: [{ type: "paragraph", content }],
      };
      frame.listNode.content!.push(listItem);
      frame.lastListItem = listItem;
      lastInlineHost = content;
      lastBlockInline = { block: item.block, indent: depth, content };
      lastChipTrailing = null;
      continue;
    }
    if (item.kind === "text" && item.block === "blockquote") {
      flushParagraph();
      const content = inlineItemsToTiptapContent([item], presentation);
      // 引用块里夹了 @引用：并回上一个引用块，而不是新建一个。
      if (tryMergeIntoPreviousBlock("blockquote", 0, content)) {
        continue;
      }
      blocks.push({ type: "blockquote", content: [{ type: "paragraph", content }] });
      lastInlineHost = content;
      lastBlockInline = { block: "blockquote", indent: 0, content };
      lastChipTrailing = null;
      continue;
    }
    if (item.kind === "text") {
      const level = HEADING_LEVELS[item.block as keyof typeof HEADING_LEVELS];
      if (level != null) {
        flushParagraph();
        const content = inlineItemsToTiptapContent([item], presentation);
        // 标题里夹了 @引用：并回上一个标题，而不是新建一个。
        if (tryMergeIntoPreviousBlock(item.block as string, 0, content)) {
          continue;
        }
        blocks.push({ type: "heading", attrs: { level }, content });
        lastInlineHost = content;
        lastBlockInline = { block: item.block as string, indent: 0, content };
        lastChipTrailing = null;
        continue;
      }
    }
    /*
     * 带块上下文的 chip：按它**自己**的块精确重建。
     *
     * chip 自己知道属于哪个列表项 / 引用块 / 标题（正向转换时 `walkInline` 拿得到
     * 块上下文，已存进 `block` / `indent`）。所以这里不需要再靠 `trailing` 猜
     * 「它属于哪个块」—— 那正是「两个列表项被焊成一个」的根因：
     *
     *   - 上一块末尾的 chip（trailing=true）→ 上一块已结束；
     *   - 当前 chip 的 `trailing=false` → 它后面还有同块内容。
     *
     * 判据是「上一个块是否**未结束**且**同 block 同 indent**」：
     *   - 上一个条目是 chip 且 trailing=true → 上一块已结束 → 当前 chip **开新块**；
     *   - 否则若上一个块同 block 同 indent → 当前 chip **并入**它（它在那个块里）。
     */
    if (item.kind !== "text" && item.block != null) {
      const chipBlock = item.block;
      const chipIndent = item.indent ?? 0;
      const chipContent = inlineItemsToTiptapContent([item], presentation);
      const chipTrailing = item.trailing === true;
      // 上一个块是否还在进行中（没被 trailing=true 的 chip 收尾）。
      const previousBlockOpen = lastChipTrailing !== true;
      const mergesIntoPrevious =
        previousBlockOpen &&
        lastBlockInline != null &&
        lastBlockInline.block === chipBlock &&
        lastBlockInline.indent === chipIndent;
      if (mergesIntoPrevious && lastBlockInline != null) {
        lastBlockInline.content.push(...chipContent);
        lastInlineHost = lastBlockInline.content;
        lastChipTrailing = chipTrailing;
        continue;
      }
      if (chipBlock === "bullet" || chipBlock === "ordered") {
        const { frame, depth } = openListFrame(chipBlock, chipIndent);
        const listItem: JSONContent = {
          type: "listItem",
          content: [{ type: "paragraph", content: chipContent }],
        };
        frame.listNode.content!.push(listItem);
        frame.lastListItem = listItem;
        lastInlineHost = chipContent;
        lastBlockInline = { block: chipBlock, indent: depth, content: chipContent };
        lastChipTrailing = chipTrailing;
        continue;
      }
      if (chipBlock === "blockquote") {
        flushParagraph();
        blocks.push({ type: "blockquote", content: [{ type: "paragraph", content: chipContent }] });
        lastInlineHost = chipContent;
        lastBlockInline = { block: "blockquote", indent: 0, content: chipContent };
        lastChipTrailing = chipTrailing;
        continue;
      }
      const chipLevel = HEADING_LEVELS[chipBlock as keyof typeof HEADING_LEVELS];
      if (chipLevel != null) {
        flushParagraph();
        blocks.push({ type: "heading", attrs: { level: chipLevel }, content: chipContent });
        lastInlineHost = chipContent;
        lastBlockInline = { block: chipBlock, indent: 0, content: chipContent };
        lastChipTrailing = chipTrailing;
        continue;
      }
      // 块类型不认识（理论上不会发生）：退回段落缓冲，别把内容弄丢。
    }
    if (paragraphItems.length === 0 && lastInlineHost != null && lastChipTrailing !== true) {
      /*
       * 纯 chip 跟在结构化块后面：回流到那个块里，避免被拆成独立段落。
       *
       * **但上一个 chip 若是块末尾，就不能回流** —— 它意味着「这个块到此为止」，
       * 当前 chip 属于**下一个**块。回流的后果是：下一个块的 chip 被塞进上一个
       * 块，随后的同块文本又通过 `tryMergeIntoPreviousBlock` 并进同一个列表项 →
       * **两个列表项被焊成一个**（第二个列表项整条消失），而 canonical 每次落盘
       * 都从编辑器 JSON 重新推导 → 损坏被固化进存档。
       *
       * 「每条列表项都以 @引用开头或结尾」这种极常见的写法就会触发它。
       *
       * 不回流时当前 chip 落到段落缓冲：位置不精确（chip 跑到了段落里），但
       * **列表项不再丢失** —— 丢内容不可逆，位置不精确可以再修。
       */
      lastInlineHost.push(...inlineItemsToTiptapContent([item], presentation));
      /*
       * 记住它是不是本块末尾：块末尾的 chip 说明后面的同块文本属于**下一个**块。
       *
       * 四种 chip（media_reference / mark_reference / attachment / pending_reference）
       * 都要看自己的 `trailing`。早先只认前两种、其余一律当「块中间」→
       * 列表项末尾的待确认 chip 或附件会把**下一个列表项**并进来（列表项被吞掉）。
       */
      lastChipTrailing =
        item.kind === "media_reference" ||
        item.kind === "mark_reference" ||
        item.kind === "attachment" ||
        item.kind === "pending_reference"
          ? item.trailing === true
          : false;
      continue;
    }
    // 引用等行内条目落到当前段落缓冲，与相邻文本同块。
    paragraphItems.push(item);
    /*
     * 纯段落文本会切断块序列：上一个 chip 的「块末尾」状态不能跨过它，
     * 否则后面同 block/indent 的列表文本会与**上一个块**合并（跨块误合并）。
     */
    lastChipTrailing = null;
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
    for (const [nodeIndex, node] of nodes.entries()) {
      /*
       * 这个节点是不是本块的**最后一个**行内节点。
       *
       * chip 存成独立条目后，「列表项里夹了一个 @引用」与「列表项末尾放了个 @引用、
       * 下一行才是新列表项」在 canonical 里完全同形，反向转换没法判断该不该合并
       * —— 判错就会把一个列表项裂成两个、有序列表编号错位。
       * 靠这个标记区分：块内中间的 chip 后面还有同块文本（同一个列表项），
       * 块末尾的 chip 后面即使还有同块文本，那也是下一个列表项。
       */
      const isTrailing = nodeIndex === nodes.length - 1;
      if (node.type === "text") {
        const marks = (node.marks ?? [])
          .map((mark) => promptMarkFromTiptapName(String(mark.type ?? "")))
          .filter((mark): mark is PromptInlineMark => mark != null);
        appendStyledText(
          sink,
          node.text ?? "",
          {
            ...style,
            ...(marks.length > 0 ? { marks } : {}),
          },
          // 同一个块内部的行内片段必须并成一条：块内片段与「相邻两个块」在样式上
          // 完全相同，只能靠「这是块专属 sink」这个上下文区分。不传这个开关，
          // 「列表项里按 Shift+Enter」会被拆成多条，反向转换时一个列表项裂成三个。
          { mergeWithinBlock: true },
        );
        continue;
      }
      if (node.type === "hardBreak") {
        appendStyledText(sink, "\n", style, { mergeWithinBlock: true });
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
          // **总是显式写** trailing（true / false 都写）。
          //
          // 缺省值不能用来表达「块中间」：旧存档里没有这个字段，若把「缺失」当成
          // 「块中间」，旧存档的 chip 就被并进下一个列表项 → 列表项被吞掉、
          // 有序编号错位（旧行为是 chip 视为块末尾、不合并）。所以：
          //   · 新写出的文档：字段总是存在，语义明确；
          //   · 旧存档（字段缺失）：解码时补 true，复现旧行为。
          trailing: isTrailing,
          // 块上下文：chip 属于哪个列表项/标题，由它自己带。
          //
          // 不带的话，反向转换只能靠 `trailing` 猜「它属于哪个块」—— 而「上一块
          // 末尾的 chip」与「下一块开头的 chip」在条目序列上完全同形，猜错就把两个
          // 列表项焊成一个（第二个列表项整条消失，且每次落盘都从编辑器 JSON 重新
          // 推导 → 固化进存档）。这里正向已知块上下文，存下来即精确。
          ...(style.block != null ? { block: style.block } : {}),
          ...(style.indent != null && style.indent > 0 ? { indent: style.indent } : {}),
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
          // 同 media_reference：总是显式写，语义不靠缺省值表达。
          trailing: isTrailing,
          // 同上：块上下文让反向转换能精确知道这个 chip 属于哪个块。
          ...(style.block != null ? { block: style.block } : {}),
          ...(style.indent != null && style.indent > 0 ? { indent: style.indent } : {}),
        });
        continue;
      }
      if (node.type === PROMPT_TIPTAP_ATTACHMENT_NODE) {
        const attrs = jsonContentAttributes(node);
        const attachmentId = attrs["attachmentId"];
        const name = attrs["name"];
        const mediaType = attrs["mediaType"];
        const parsedTarget =
          typeof attachmentId === "string" && attachmentId
            ? decodeMediaReferenceTarget(attrs["target"], `attachment:${attachmentId}`)
            : null;
        if (
          typeof attachmentId === "string" &&
          attachmentId &&
          typeof name === "string" &&
          (mediaType === "image" ||
            mediaType === "video" ||
            mediaType === "audio" ||
            mediaType === "document") &&
          parsedTarget != null
        ) {
          sink.push({
            kind: "attachment",
            attachmentId,
            target: parsedTarget,
            name,
            mediaType,
            // 同上：总是显式写。
            trailing: isTrailing,
            // 同上：块上下文。
            ...(style.block != null ? { block: style.block } : {}),
            ...(style.indent != null && style.indent > 0 ? { indent: style.indent } : {}),
          });
        }
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
            // 同其它 chip：总是显式写，语义不靠缺省值表达。
            trailing: isTrailing,
            // 同上：块上下文。
            ...(style.block != null ? { block: style.block } : {}),
            ...(style.indent != null && style.indent > 0 ? { indent: style.indent } : {}),
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
