import { useEffect, useRef } from "react";

import type { CloudAssetStatus, MediaType, StartStagingCommand } from "../../lib/backend";
import type { PromptContentDocumentV1 } from "../../lib/promptContent";
import type { AssetItem, AssetKind, AssetLibrarySource } from "./workspaceModel";

/**
 * 云端素材预览确认失败后的替换。
 *
 * 「预览不可用」在续签和补地址结束之前只是加载中的一帧，这时删除会把还能修好的素材删掉。
 * 确认失败之后也只替换本机还留着原件的那一份：没有原件就删不回来。替换先把重新上传排进
 * 队列，再调用素材删除接口；上传没能启动时旧记录留在原处。同一条素材、同一份原件在一次
 * 会话里只替换一次，避免新素材的预览还没就绪时又被删掉重传。
 */

const repairedAssetIds = new Set<string>();
const repairedLocalPaths = new Set<string>();
const inFlightAssetIds = new Set<string>();
let repairQueue: Promise<void> = Promise.resolve();

export function resetUnavailableAssetRepairs(): void {
  repairedAssetIds.clear();
  repairedLocalPaths.clear();
  inFlightAssetIds.clear();
}

export interface ImportedAssetRepairSource {
  readonly localPath: string;
  readonly mediaType: MediaType;
  readonly groupId: string | null;
  readonly name: string | null;
}

export interface UnavailableAssetRepairClient {
  resolveImportedAsset(this: void, assetId: string): Promise<ImportedAssetRepairSource | null>;
  deleteAsset(
    this: void,
    command: { readonly providerConnectionId: string; readonly id: string },
  ): Promise<string>;
  startUpload(this: void, command: StartStagingCommand): Promise<string>;
}

export type UnavailableAssetRepairResult =
  | {
      readonly status: "skipped";
      readonly reason: "ineligible" | "already-attempted" | "no-local-file" | "type-mismatch";
    }
  | { readonly status: "failed"; readonly reason: "lookup" | "upload"; readonly error: unknown }
  | {
      readonly status: "replaced";
      readonly jobId: string;
      readonly localPath: string;
      readonly deleted: boolean;
      readonly deleteError: unknown;
    };

export function canRepairUnavailableCloudAsset(asset: AssetItem): boolean {
  const providerConnectionId = asset.providerConnectionId?.trim() ?? "";
  if (asset.source !== "cloud" || providerConnectionId === "" || asset.id.trim() === "")
    return false;
  if (asset.kind !== "image" && asset.kind !== "video") return false;
  return (
    asset.cloudStatus == null || asset.cloudStatus === "ready" || asset.cloudStatus === "unknown"
  );
}

/**
 * 卡片上的「预览不可用」要等补地址和续签都结束，才算确认失败。
 * 缓存字节、仍在加载、处理中或已被结算剔除的素材都不算。
 */
export function isCloudPreviewConfirmedDead(input: {
  readonly source: AssetLibrarySource | undefined;
  readonly kind: AssetKind;
  readonly cloudStatus: CloudAssetStatus | undefined;
  readonly mediaReady: boolean;
  readonly fromCache: boolean;
  readonly hasCandidateUrl: boolean;
  readonly mediaFailed: boolean;
  readonly recoverySettled: boolean;
  readonly refreshSettled: boolean;
}): boolean {
  if (input.source !== "cloud") return false;
  if (input.kind !== "image" && input.kind !== "video") return false;
  if (
    input.cloudStatus != null &&
    input.cloudStatus !== "ready" &&
    input.cloudStatus !== "unknown"
  ) {
    return false;
  }
  if (input.mediaReady || input.fromCache || !input.mediaFailed) return false;
  if (!input.hasCandidateUrl) return input.recoverySettled;
  return input.refreshSettled;
}

/** 把提示词里指向旧云端素材的 @ 引用改到替换后的新素材。 */
export function replaceCloudAssetIdInPromptDocument(
  document: PromptContentDocumentV1,
  oldAssetId: string,
  newAssetId: string,
): PromptContentDocumentV1 | null {
  if (oldAssetId === "" || oldAssetId === newAssetId) return null;
  let changed = false;
  const items = document.items.map((item) => {
    if (item.kind !== "media_reference" || item.target.kind !== "asset") return item;
    if (item.target.assetId !== oldAssetId) return item;
    changed = true;
    return { ...item, target: { ...item.target, assetId: newAssetId } };
  });
  return changed ? { ...document, items } : null;
}

export function repairUnavailableCloudAsset(
  asset: AssetItem,
  client: UnavailableAssetRepairClient,
  onReplacementQueued?: (jobId: string) => void,
): Promise<UnavailableAssetRepairResult> {
  return enqueueRepair(() => repairUnavailableCloudAssetNow(asset, client, onReplacementQueued));
}

/** 同一张卡片只上报一次确认失败，避免续签后的重渲染反复触发替换。 */
export function useReportConfirmedPreviewUnavailable(
  asset: AssetItem,
  confirmed: boolean,
  onUnavailable: ((asset: AssetItem) => void) | undefined,
): void {
  const reportedRef = useRef(false);
  useEffect(() => {
    if (!confirmed || reportedRef.current || onUnavailable == null) return;
    reportedRef.current = true;
    onUnavailable(asset);
  }, [asset, confirmed, onUnavailable]);
}

function enqueueRepair<T>(work: () => Promise<T>): Promise<T> {
  const run = repairQueue.then(work, work);
  repairQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function repairUnavailableCloudAssetNow(
  asset: AssetItem,
  client: UnavailableAssetRepairClient,
  onReplacementQueued?: (jobId: string) => void,
): Promise<UnavailableAssetRepairResult> {
  const providerConnectionId = asset.providerConnectionId?.trim() ?? "";
  const assetId = asset.id.trim();
  if (!canRepairUnavailableCloudAsset(asset) || providerConnectionId === "") {
    return { status: "skipped", reason: "ineligible" };
  }
  if (repairedAssetIds.has(assetId) || inFlightAssetIds.has(assetId)) {
    return { status: "skipped", reason: "already-attempted" };
  }
  inFlightAssetIds.add(assetId);
  try {
    let source: ImportedAssetRepairSource | null;
    try {
      source = await client.resolveImportedAsset(assetId);
    } catch (error) {
      return { status: "failed", reason: "lookup", error };
    }
    if (source == null || source.localPath.trim() === "") {
      repairedAssetIds.add(assetId);
      return { status: "skipped", reason: "no-local-file" };
    }
    if (source.mediaType !== asset.kind) {
      repairedAssetIds.add(assetId);
      return { status: "skipped", reason: "type-mismatch" };
    }
    const pathKey = localPathKey(source.localPath);
    if (repairedLocalPaths.has(pathKey)) {
      repairedAssetIds.add(assetId);
      return { status: "skipped", reason: "already-attempted" };
    }
    const groupId = nonempty(asset.groupId) ?? nonempty(source.groupId);
    const name = nonempty(asset.name) ?? nonempty(source.name);
    let jobId: string;
    try {
      jobId = await client.startUpload({
        localPath: source.localPath,
        purpose: "asset_import",
        mediaType: asset.kind,
        import: { providerConnectionId, name, groupId },
      });
    } catch (error) {
      return { status: "failed", reason: "upload", error };
    }
    repairedAssetIds.add(assetId);
    repairedLocalPaths.add(pathKey);
    onReplacementQueued?.(jobId);
    try {
      await client.deleteAsset({ providerConnectionId, id: assetId });
      return {
        status: "replaced",
        jobId,
        localPath: source.localPath,
        deleted: true,
        deleteError: null,
      };
    } catch (error) {
      return {
        status: "replaced",
        jobId,
        localPath: source.localPath,
        deleted: false,
        deleteError: error,
      };
    }
  } finally {
    inFlightAssetIds.delete(assetId);
  }
}

function nonempty(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

function localPathKey(path: string): string {
  return path.trim().replaceAll("/", "\\").toLowerCase();
}
