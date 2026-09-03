import { Node, type Extensions, type JSONContent } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import HardBreak from "@tiptap/extension-hard-break";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { Placeholder, UndoRedo } from "@tiptap/extensions";
import type { MediaReferenceTarget, MediaType } from "./backend";
import { normalizeAutoMentionText } from "./promptAutoMention";
import type {
  PromptContentDocumentV1,
  PromptContentItem,
  PromptContentMediaReferenceItem,
} from "./promptContent";

export const PROMPT_TIPTAP_MEDIA_REFERENCE_NODE = "mediaReference";
export const PROMPT_TIPTAP_PENDING_REFERENCE_NODE = "pendingReference";

export interface PromptTiptapPresentation {
  readonly connectedCanvasNodeKeys?: ReadonlySet<string>;
  readonly freshMentionIds?: ReadonlySet<string>;
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

function parseMediaReferenceTarget(value: unknown): MediaReferenceTarget | null {
  if (!isRecord(value) || !isMediaType(value["mediaType"])) return null;
  const canvasNodeKey = value["canvasNodeKey"];
  if (typeof canvasNodeKey !== "string" || !canvasNodeKey) return null;
  if (
    value["kind"] === "asset" &&
    typeof value["providerConnectionId"] === "string" &&
    value["providerConnectionId"] &&
    typeof value["assetId"] === "string" &&
    value["assetId"]
  ) {
    return {
      kind: "asset",
      providerConnectionId: value["providerConnectionId"],
      assetId: value["assetId"],
      canvasNodeKey,
      mediaType: value["mediaType"],
    };
  }
  if (
    value["kind"] === "local_asset" &&
    typeof value["stagingJobId"] === "string" &&
    value["stagingJobId"]
  ) {
    return {
      kind: "local_asset",
      stagingJobId: value["stagingJobId"],
      canvasNodeKey,
      mediaType: value["mediaType"],
    };
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
      mediaType: value["mediaType"],
    };
  }
  return null;
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

function targetFromElement(element: HTMLElement): MediaReferenceTarget | null {
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
          const target = targetFromElement(node);
          const mentionId = node.dataset["mentionId"] ?? "";
          const canvasNodeKey = node.dataset["canvasNodeKey"] ?? "";
          if (!target || !mentionId || !canvasNodeKey) return false;
          return {
            mentionId,
            canvasNodeKey,
            target,
            displayNameSnapshot: node.dataset["displayName"] ?? "",
            learnedPattern: node.dataset["autoPattern"] ?? null,
            aliasSnapshot: node.dataset["autoAlias"] ?? null,
            fresh: node.dataset["auto"] === "true",
            stale: node.classList.contains("is-stale"),
          };
        },
      },
    ];
  },

  renderHTML({ node }) {
    const target = parseMediaReferenceTarget(node.attrs["target"]);
    const displayName = String(node.attrs["displayNameSnapshot"] ?? "");
    const alias =
      typeof node.attrs["aliasSnapshot"] === "string" ? node.attrs["aliasSnapshot"] : "";
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
    if (alias) attrs["data-auto-alias"] = alias;
    return ["span", attrs, `@${displayName}${alias ? ` · ${alias}` : ""}`];
  },

  renderText({ node }) {
    const displayName = String(node.attrs["displayNameSnapshot"] ?? "");
    const alias =
      typeof node.attrs["aliasSnapshot"] === "string" ? node.attrs["aliasSnapshot"] : "";
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

export function createPromptTiptapExtensions(placeholder: string): Extensions {
  return [
    Document,
    Paragraph,
    Text,
    HardBreak,
    MediaReference,
    PendingReference,
    Placeholder.configure({ placeholder }),
    UndoRedo,
  ];
}

function appendText(items: PromptContentItem[], text: string): void {
  const clean = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  if (!clean) return;
  const previous = items.at(-1);
  if (previous?.kind === "text") {
    items[items.length - 1] = { kind: "text", text: previous.text + clean };
  } else {
    items.push({ kind: "text", text: clean });
  }
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
      fresh: presentation.freshMentionIds?.has(item.mentionId) ?? false,
      stale: presentation.connectedCanvasNodeKeys
        ? !presentation.connectedCanvasNodeKeys.has(item.canvasNodeKey)
        : false,
    },
  };
}

export function promptDocumentToTiptapJson(
  document: PromptContentDocumentV1,
  presentation: PromptTiptapPresentation = {},
): JSONContent {
  const content: JSONContent[] = [];
  for (const item of document.items) {
    if (item.kind === "text") {
      content.push(...plainTextToTiptapContent(item.text));
    } else if (item.kind === "media_reference") {
      content.push(promptReferenceToTiptapNode(item, presentation));
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
  return {
    type: "doc",
    content: [{ type: "paragraph", ...(content.length > 0 ? { content } : {}) }],
  };
}

export function promptDocumentFromTiptapJson(value: JSONContent): PromptContentDocumentV1 {
  const items: PromptContentItem[] = [];
  const mentionIds = new Set<string>();
  const blocks = value.content ?? [];
  const walkInline = (node: JSONContent) => {
    if (node.type === "text") {
      appendText(items, node.text ?? "");
      return;
    }
    if (node.type === "hardBreak") {
      appendText(items, "\n");
      return;
    }
    if (node.type === PROMPT_TIPTAP_MEDIA_REFERENCE_NODE) {
      const attrs = jsonContentAttributes(node);
      const target = parseMediaReferenceTarget(attrs["target"]);
      const canvasNodeKey = attrs["canvasNodeKey"];
      const displayNameSnapshot = attrs["displayNameSnapshot"];
      if (
        !target ||
        typeof canvasNodeKey !== "string" ||
        !canvasNodeKey ||
        typeof displayNameSnapshot !== "string"
      ) {
        appendText(items, typeof displayNameSnapshot === "string" ? displayNameSnapshot : "");
        return;
      }
      const rawMentionId = attrs["mentionId"];
      const mentionId =
        typeof rawMentionId === "string" && rawMentionId && !mentionIds.has(rawMentionId)
          ? rawMentionId
          : `mention-${globalThis.crypto.randomUUID()}`;
      mentionIds.add(mentionId);
      const learnedPattern = attrs["learnedPattern"];
      const aliasSnapshot = attrs["aliasSnapshot"];
      items.push({
        kind: "media_reference",
        mentionId,
        canvasNodeKey,
        target,
        displayNameSnapshot,
        ...(typeof learnedPattern === "string" && learnedPattern
          ? { learnedPattern: normalizeAutoMentionText(learnedPattern) }
          : {}),
        ...(typeof aliasSnapshot === "string" && aliasSnapshot ? { aliasSnapshot } : {}),
      });
      return;
    }
    if (node.type === PROMPT_TIPTAP_PENDING_REFERENCE_NODE) {
      const attrs = jsonContentAttributes(node);
      const normalizedPattern = attrs["normalizedPattern"];
      const displayText = attrs["displayText"];
      const candidateCount = attrs["candidateCount"];
      if (typeof normalizedPattern === "string" && typeof displayText === "string") {
        items.push({
          kind: "pending_reference",
          normalizedPattern: normalizeAutoMentionText(normalizedPattern),
          displayText,
          candidateCount:
            typeof candidateCount === "number" && Number.isFinite(candidateCount)
              ? Math.max(2, Math.floor(candidateCount))
              : 2,
        });
      }
      return;
    }
    for (const child of node.content ?? []) walkInline(child);
  };

  blocks.forEach((block, index) => {
    for (const child of block.content ?? []) walkInline(child);
    if (index < blocks.length - 1) appendText(items, "\n");
  });
  return { schema: "prompt-content", version: 1, items };
}
