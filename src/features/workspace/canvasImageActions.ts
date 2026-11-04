import { toMediaSrc } from "../../lib/backend";
import { copyImageToClipboard } from "../../lib/clipboard";
import type { CanvasDocumentV2, CanvasNodeEntry } from "../canvas/canvasStore";
import { artifactFileName } from "./artifactNames";
import { captureCanvasNodes, pasteCanvasNodes, type PastedCanvasNodes } from "./canvasNodeClipboard";
import { exportArtifactToDesktop } from "./desktopActions";
import { imageNodePreview } from "./imageNodeResults";

export interface CanvasImageActionTarget {
  readonly name: string;
  readonly localPath: string | null;
  readonly src: string | null;
}

/** Resolve the displayed image, never another result or an upstream reference. */
export function canvasImageActionTarget(entry: CanvasNodeEntry | undefined): CanvasImageActionTarget | null {
  if (entry?.type === "asset" && entry.data.kind === "image") {
    return { name: entry.data.name, localPath: null, src: entry.data.previewUrl };
  }
  const output = entry?.type === "gen" && entry.data.kind === "image"
    ? imageNodePreview(entry.data)
    : entry?.type === "output" && entry.data.mediaType === "image" ? entry.data : null;
  if (!output && !(entry?.type === "gen" && entry.data.kind === "image")) return null;
  const localPath = output?.finalPath ?? null;
  return {
    name: (entry?.type === "gen" ? entry.data.name : output?.name) ?? "图片",
    localPath,
    src: localPath ? toMediaSrc(localPath) : output?.previewSrc ?? null,
  };
}

export function copyCanvasImage(target: CanvasImageActionTarget): Promise<void> {
  return copyImageToClipboard(target);
}

export function downloadCanvasImage(target: CanvasImageActionTarget): Promise<string | null> {
  if (!target.localPath) return Promise.reject(new Error("图片尚未保存，请等待保存完成。"));
  return exportArtifactToDesktop(target.localPath, artifactFileName(target.name, target.localPath));
}

/** A same-canvas duplicate keeps upstream references without copying downstream consumers. */
export function duplicateCanvasImage(
  document: CanvasDocumentV2,
  key: string,
): PastedCanvasNodes | null {
  const captured = captureCanvasNodes(document, new Set([key]));
  if (captured.nodes.length !== 1) return null;
  const original = captured.nodes[0]!;
  const pasted = pasteCanvasNodes(captured, { x: 40, y: 40 }, entry => `${entry.type}-${crypto.randomUUID()}`);
  const duplicateKey = pasted.keys[0]!;
  const nodes = pasted.nodes.map(entry => entry.type === "gen" && entry.data.kind === "image"
    && original.type === "gen" && original.data.kind === "image" && original.data.config.inputSlots
    ? { ...entry, data: { ...entry.data, config: { ...entry.data.config, inputSlots: [...original.data.config.inputSlots] } } }
    : entry);
  return {
    ...pasted,
    nodes,
    edges: document.assetEdges.filter(edge => edge.toKey === key && edge.fromKey !== key)
      .map(edge => ({ id: `${edge.fromKey}->${duplicateKey}`, fromKey: edge.fromKey, toKey: duplicateKey })),
  };
}
