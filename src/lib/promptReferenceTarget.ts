import type { ExplicitMediaTarget, MediaReferenceTarget, MediaType } from "./backend";

/** One identity decoder for saved documents and editor projections. */
export function decodeMediaReferenceTarget(
  value: unknown,
  instanceKey?: string,
): MediaReferenceTarget | null {
  if (typeof value !== "object" || value == null || Array.isArray(value)) return null;
  const target = value as Record<string, unknown>;
  const mediaType = target["mediaType"];
  if (mediaType !== "image" && mediaType !== "video" && mediaType !== "audio") return null;
  const canvasNodeKey = instanceKey ?? target["canvasNodeKey"];
  if (typeof canvasNodeKey !== "string" || !canvasNodeKey) return null;
  if (target["canvasNodeKey"] != null && target["canvasNodeKey"] !== canvasNodeKey) return null;
  const base: { canvasNodeKey: string; mediaType: MediaType } = { canvasNodeKey, mediaType };
  switch (target["kind"]) {
    case "asset":
      return typeof target["providerConnectionId"] === "string" &&
        target["providerConnectionId"] &&
        typeof target["assetId"] === "string" &&
        target["assetId"]
        ? {
            kind: "asset",
            providerConnectionId: target["providerConnectionId"],
            assetId: target["assetId"],
            ...base,
          }
        : null;
    case "local_asset":
      return typeof target["stagingJobId"] === "string" && target["stagingJobId"]
        ? { kind: "local_asset", stagingJobId: target["stagingJobId"], ...base }
        : null;
    case "local_file":
      return typeof target["path"] === "string" && target["path"].trim()
        ? { kind: "local_file", path: target["path"], ...base }
        : null;
    case "local_result":
      return typeof target["generationTaskId"] === "string" &&
        target["generationTaskId"] &&
        typeof target["resultIndex"] === "number" &&
        Number.isInteger(target["resultIndex"]) &&
        target["resultIndex"] >= 0
        ? {
            kind: "local_result",
            generationTaskId: target["generationTaskId"],
            resultIndex: target["resultIndex"],
            ...base,
          }
        : null;
    default:
      return null;
  }
}

/**
 * 只比较来源身份，忽略画布实例 key：同一份素材被重新投放到画布上（新节点）之后，
 * 来源身份不变而实例身份变了，用它可以判断「还是同一份素材」。
 */
export function sameMediaSourceIdentity(
  first: MediaReferenceTarget,
  second: MediaReferenceTarget,
): boolean {
  if (first.kind !== second.kind || first.mediaType !== second.mediaType) return false;
  if (first.kind === "asset" && second.kind === "asset")
    return (
      first.providerConnectionId === second.providerConnectionId && first.assetId === second.assetId
    );
  if (first.kind === "local_asset" && second.kind === "local_asset")
    return first.stagingJobId === second.stagingJobId;
  if (first.kind === "local_result" && second.kind === "local_result")
    return (
      first.generationTaskId === second.generationTaskId && first.resultIndex === second.resultIndex
    );
  return first.kind === "local_file" && second.kind === "local_file" && first.path === second.path;
}

export function sameMediaReferenceTarget(
  first: MediaReferenceTarget,
  second: ExplicitMediaTarget,
): boolean {
  // URL 目标不参与提示词 @ 引用，来源身份比较也不接受它。
  if (second.kind === "url") return false;
  if (first.canvasNodeKey !== second.canvasNodeKey) return false;
  return sameMediaSourceIdentity(first, second);
}
