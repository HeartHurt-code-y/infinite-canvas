import type {
  AssetLibraryClient,
  AssetStatusObservation,
  CloudAsset,
  CloudAssetStatus,
} from "../../lib/backend";

export type CloudAssetSettlement =
  | { readonly kind: "keep" }
  | {
      readonly kind: "ready";
      readonly rawStatus: string;
      readonly previewUrl: string | null;
      readonly coverUrl: string | null;
    }
  | { readonly kind: "removed"; readonly reason: string };

type ListedCloudAsset = Pick<CloudAsset, "id" | "providerConnectionId" | "status">;

/**
 * 列表上的「云端处理中」只是上次拉到的 `processing`。
 * 复核结果决定去留：云端报错或明确没有这条素材就删除；仍在处理或暂时连不上就留下。
 */
export function settlementForCloudAsset(
  listedStatus: CloudAssetStatus,
  observation: AssetStatusObservation | "unavailable",
): CloudAssetSettlement {
  if (observation === "unavailable") {
    if (listedStatus === "failed" || listedStatus === "deleted") {
      return {
        kind: "removed",
        reason: listedStatus === "deleted" ? "云端已删除该素材" : "云端导入失败，没有返回可用结果",
      };
    }
    return { kind: "keep" };
  }
  if (
    observation.missing ||
    observation.status === "failed" ||
    observation.status === "deleted" ||
    observation.failureReason != null
  ) {
    const detail =
      observation.failureReason ??
      (observation.missing ? "云端没有返回该素材" : `云端状态：${observation.rawStatus}`);
    return { kind: "removed", reason: removalReason(detail) };
  }
  if (observation.status === "ready") {
    return {
      kind: "ready",
      rawStatus: observation.rawStatus,
      previewUrl: observation.previewUrl,
      coverUrl: observation.coverUrl,
    };
  }
  if (listedStatus === "failed" || listedStatus === "deleted") {
    return {
      kind: "removed",
      reason: listedStatus === "deleted" ? "云端已删除该素材" : "云端导入失败，没有返回可用结果",
    };
  }
  return { kind: "keep" };
}

function removalReason(detail: string): string {
  const trimmed = detail.trim();
  const text = trimmed.length > 240 ? `${trimmed.slice(0, 240)}…` : trimmed;
  if (text.startsWith("云端")) return text;
  return `云端没有返回可用结果：${text}`;
}

export async function settleUnreadyCloudAsset(
  asset: ListedCloudAsset,
  client: Pick<AssetLibraryClient, "deleteAsset" | "observeAssetStatus">,
): Promise<CloudAssetSettlement> {
  if (asset.status === "ready") return { kind: "keep" };
  let observation: AssetStatusObservation | "unavailable";
  try {
    observation = await client.observeAssetStatus({
      providerConnectionId: asset.providerConnectionId,
      id: asset.id,
    });
  } catch {
    observation = "unavailable";
  }
  const decision = settlementForCloudAsset(asset.status, observation);
  if (decision.kind !== "removed") return decision;
  try {
    await client.deleteAsset({
      providerConnectionId: asset.providerConnectionId,
      id: asset.id,
    });
  } catch {
    return { kind: "keep" };
  }
  return decision;
}
