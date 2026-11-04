import type { ImageStyleReference } from "../../lib/imageStyleMarket";
import { MAX_VIDEO_EFFECTS, VIDEO_EFFECT_TEMPLATES } from "../../lib/videoEffectTemplates";
import type { GenNodeData } from "./workspaceModel";

export type CanvasLibraryKind = "style" | "effect";

export type CanvasLibraryResource =
  | { readonly kind: "style"; readonly style: ImageStyleReference }
  | { readonly kind: "effect"; readonly versionId: number };

export interface ConnectedLibraryResource {
  readonly edgeId: string;
  readonly name: string;
  readonly resource: CanvasLibraryResource;
}

export function canvasLibraryResourcePreview(resource: CanvasLibraryResource) {
  if (resource.kind === "style") {
    return { name: resource.style.name, src: resource.style.imageUrl };
  }
  const template = VIDEO_EFFECT_TEMPLATES.find((item) => item.versionId === resource.versionId);
  return { name: template?.name ?? "特效版本不可用", src: template?.image ?? null };
}

/** 只在执行快照中合并连线，解绑或替换后自动使用新配置。 */
export function generationWithLibraryResources(node: GenNodeData, inputs: readonly ConnectedLibraryResource[]) {
  if (node.kind === "image" && node.config.imageMode !== "upscale") {
    const resource = inputs.find((input) => input.resource.kind === "style")?.resource;
    if (resource?.kind === "style") {
      return { ...node, config: { ...node.config, styleReference: resource.style } };
    }
  }
  if (node.kind === "video") {
    const effectVersionIds = new Set(node.config.effectVersionIds);
    for (const { resource } of inputs) {
      if (resource.kind === "effect") effectVersionIds.add(resource.versionId);
    }
    if (effectVersionIds.size !== (node.config.effectVersionIds?.length ?? 0)) {
      return { ...node, config: { ...node.config, effectVersionIds: [...effectVersionIds] } };
    }
  }
  return node;
}

export function libraryResourceConnectionIssue(
  resource: CanvasLibraryResource,
  target: GenNodeData,
  linked: readonly ConnectedLibraryResource[],
): string | null {
  if (resource.kind === "style") {
    if (target.kind !== "image" || target.config.imageMode === "upscale") return "风格素材只能连到普通图片生成节点。";
    if (linked.some((input) => input.resource.kind === "style")) return "图片节点只能连接一个风格素材，请先断开原风格。";
  } else {
    if (target.kind !== "video") return "特效素材只能连到视频生成节点。";
    const configured = generationWithLibraryResources(target, linked);
    if (configured.kind === "video") {
      const ids = new Set(configured.config.effectVersionIds);
      ids.add(resource.versionId);
      if (ids.size > MAX_VIDEO_EFFECTS) return `最多使用 ${MAX_VIDEO_EFFECTS} 个视频特效。`;
    }
  }
  return null;
}
