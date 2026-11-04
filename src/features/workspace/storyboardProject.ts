import { toMediaSrc, type MediaReferenceTarget, type PromptReferenceInput } from "../../lib/backend";
import type { CanvasReadModel } from "../canvas/canvasStore";
import type { ArtifactDeliveryOutput } from "./artifactDelivery";
import { scriptDocument } from "./scriptGeneratorModel";
import { assetNodeReferenceTarget, outputNodeReferenceTarget, type OutputNodeData } from "./workspaceModel";

export const STORYBOARD_ASSET_DRAG_TYPE = "application/x-canvas-storyboard-asset";
export const STORYBOARD_KINDS = ["image", "video", "audio", "text"] as const;
export type StoryboardAssetKind = typeof STORYBOARD_KINDS[number];
export type StoryboardImageCategory = "character" | "scene" | "prop" | "other";

export interface StoryboardFilmSource {
  readonly key: string;
  readonly name: string;
  readonly target: MediaReferenceTarget;
}

export function storyboardFilmSource(asset: StoryboardAsset): StoryboardFilmSource | null {
  return asset.kind === "video" && asset.reference
    ? { key: asset.key, name: asset.label, target: asset.reference.target } : null;
}

export interface StoryboardAsset {
  readonly key: string;
  readonly kind: StoryboardAssetKind;
  readonly label: string;
  readonly src?: string | undefined;
  readonly poster?: string | undefined;
  readonly text?: string | undefined;
  readonly script?: boolean | undefined;
  readonly shots?: number | undefined;
  readonly category?: StoryboardImageCategory | undefined;
  readonly finalFilm?: boolean | undefined;
  readonly clipEditorKey?: string | undefined;
  readonly reference?: PromptReferenceInput | undefined;
  readonly delivery?: ArtifactDeliveryOutput | undefined;
}

export interface StoryboardLayout {
  readonly enabled: boolean;
  readonly chatSide: "left" | "right";
  readonly showAssets: boolean;
  readonly width: number;
}

export function readStoryboardLayout(key: string): StoryboardLayout {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "{}");
    return {
      enabled: value?.enabled === true,
      chatSide: value?.chatSide === "right" ? "right" : "left",
      showAssets: value?.showAssets !== false,
      width: typeof value?.width === "number" && Number.isFinite(value.width) ? Math.max(260, Math.min(740, value.width)) : 360,
    };
  } catch {
    return { enabled: false, chatSide: "left", showAssets: true, width: 360 };
  }
}

export function storyboardProjectAssets(state: CanvasReadModel,
  latestPreview: (state: CanvasReadModel, key: string) => OutputNodeData | null,
  embeddedOutputOwners: Readonly<Record<string, string>>) {
  const assets: StoryboardAsset[] = [];
  const labels: Record<StoryboardAssetKind, string> = { image: "图片", video: "视频", audio: "音频", text: "文本" };
  const counts = { image: 0, video: 0, audio: 0, text: 0 };
  const outputFor = (output: OutputNodeData | null, label: string, key: string) => {
    if (!output) return {};
    const target = output.finalPath ? outputNodeReferenceTarget(output) : null;
    return {
      src: output.finalPath ? toMediaSrc(output.finalPath) : output.previewSrc ?? undefined,
      reference: target ? { target, displayName: label } : undefined,
      delivery: output.finalPath ? {
        key, sourceNodeId: output.sourceNodeId, taskId: output.taskId, resultKey: output.resultKey,
        origin: output.origin ?? "generation", mediaType: output.mediaType, finalPath: output.finalPath, name: label,
      } : undefined,
      finalFilm: output.origin === "composition" || output.origin === "long_video",
    };
  };

  for (const node of state.nodes.gen) {
    const kind = node.kind === "prompt" ? "text" : node.kind;
    const label = node.name?.trim() || `${labels[kind]}节点 ${++counts[kind]}`;
    assets.push(node.kind === "prompt" ? {
      key: node.key, kind, label, text: node.config.generatedPrompt || node.config.sourcePrompt,
    } : {
      key: node.key, kind, label, ...outputFor(latestPreview(state, node.key), label, node.key),
      category: node.assetGroupId && state.groups[node.assetGroupId]?.purpose === "character" ? "character" : undefined,
    });
  }
  for (const node of state.nodes.asset) {
    if (node.libraryResource) continue;
    const target = node.assetId && (node.source === "local" || node.providerConnectionId)
      ? assetNodeReferenceTarget(node) : null;
    assets.push({
      key: node.key, kind: node.kind, label: node.name, src: node.videoUrl ?? node.previewUrl ?? undefined,
      poster: node.videoUrl && node.videoUrl !== node.previewUrl ? node.previewUrl ?? undefined : undefined,
      reference: target ? { target, displayName: node.name } : undefined,
      category: node.assetGroupId && state.groups[node.assetGroupId]?.purpose === "character" ? "character" : undefined,
    });
  }
  for (const node of state.nodes.output) {
    if (embeddedOutputOwners[node.key]) continue;
    const label = node.name ?? labels[node.mediaType] + "产物";
    assets.push({ key: node.key, kind: node.mediaType, label, text: node.textContent ?? undefined,
      clipEditorKey: node.origin === "composition" && state.nodeByKey.videoClip.has(node.sourceNodeId) ? node.sourceNodeId : undefined,
      ...outputFor(node, label, node.key) });
  }
  for (const node of state.nodes.screenplay) {
    const text = node.config.currentDocument || (node.config.scriptGenerator ? scriptDocument(node.config.scriptGenerator) : "");
    assets.push({ key: node.key, kind: "text", script: true, label: text.trim().split(/\r?\n/, 1)[0]?.replace(/^#+\s*/, "").slice(0, 48) ||
      (node.config.scriptGenerator ? "分镜脚本" : "剧本节点"), text, shots: node.config.scriptGenerator?.shots.length });
  }
  for (const node of state.nodes.videoClip) {
    const label = node.name || node.config.outputName || "智能剪辑";
    const output = latestPreview(state, node.key);
    if (output && assets.some(asset => asset.key === output.key)) continue;
    assets.push({ key: node.key, kind: "video", label, ...outputFor(output, label, node.key), finalFilm: true, clipEditorKey: node.key });
  }
  return assets.reverse();
}
