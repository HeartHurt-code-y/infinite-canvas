import { beforeEach, describe, expect, it, vi } from "vitest";

import type { StartStagingCommand } from "../../lib/backend";
import type { PromptContentDocumentV1 } from "../../lib/promptContent";
import type { AssetItem } from "./workspaceModel";
import {
  isCloudPreviewConfirmedDead,
  repairUnavailableCloudAsset,
  replaceCloudAssetIdInPromptDocument,
  resetUnavailableAssetRepairs,
  type UnavailableAssetRepairClient,
} from "./unavailableAssetRepair";

function cloudImage(overrides: Partial<AssetItem> = {}): AssetItem {
  return {
    id: "asset-1",
    kind: "image",
    name: "封面",
    meta: "",
    visual: "portrait",
    source: "cloud",
    providerConnectionId: "provider-1",
    cloudStatus: "ready",
    groupId: "16",
    previewUrl: "https://cdn.example/old.png",
    ...overrides,
  };
}

function client(
  overrides: Partial<UnavailableAssetRepairClient> = {},
): UnavailableAssetRepairClient & {
  readonly order: string[];
} {
  const order: string[] = [];
  return {
    order,
    resolveImportedAsset: vi.fn(() =>
      Promise.resolve({
        localPath: "C:\\library\\cover.png",
        mediaType: "image" as const,
        groupId: "9",
        name: "导入名",
      }),
    ),
    deleteAsset: vi.fn(() => {
      order.push("delete");
      return Promise.resolve("asset-1");
    }),
    startUpload: vi.fn((command: StartStagingCommand) => {
      order.push("upload");
      void command;
      return Promise.resolve("job-1");
    }),
    ...overrides,
  };
}

describe("isCloudPreviewConfirmedDead", () => {
  const ready = {
    source: "cloud" as const,
    kind: "image" as const,
    cloudStatus: "ready" as const,
    mediaReady: false,
    fromCache: false,
    hasCandidateUrl: true,
    mediaFailed: true,
    recoverySettled: true,
    refreshSettled: false,
  };

  it("续签还没结束时不算确认失败", () => {
    expect(isCloudPreviewConfirmedDead(ready)).toBe(false);
    expect(isCloudPreviewConfirmedDead({ ...ready, refreshSettled: true })).toBe(true);
  });

  it("没有地址时要等补取结束", () => {
    expect(
      isCloudPreviewConfirmedDead({
        ...ready,
        hasCandidateUrl: false,
        recoverySettled: false,
        refreshSettled: true,
      }),
    ).toBe(false);
    expect(
      isCloudPreviewConfirmedDead({
        ...ready,
        hasCandidateUrl: false,
        recoverySettled: true,
      }),
    ).toBe(true);
  });

  it("缓存、已显示、处理中和本地素材都不替换", () => {
    expect(isCloudPreviewConfirmedDead({ ...ready, refreshSettled: true, fromCache: true })).toBe(
      false,
    );
    expect(isCloudPreviewConfirmedDead({ ...ready, refreshSettled: true, mediaReady: true })).toBe(
      false,
    );
    expect(
      isCloudPreviewConfirmedDead({ ...ready, refreshSettled: true, cloudStatus: "processing" }),
    ).toBe(false);
    expect(isCloudPreviewConfirmedDead({ ...ready, refreshSettled: true, source: "local" })).toBe(
      false,
    );
  });
});

describe("repairUnavailableCloudAsset", () => {
  beforeEach(() => {
    resetUnavailableAssetRepairs();
  });

  it("先排队重新上传到素材当前分组，再删除旧记录", async () => {
    const repairClient = client();
    const queued: string[] = [];
    const result = await repairUnavailableCloudAsset(cloudImage(), repairClient, (jobId) => {
      queued.push(jobId);
      repairClient.order.push("queued");
    });

    expect(result).toMatchObject({
      status: "replaced",
      jobId: "job-1",
      deleted: true,
      localPath: "C:\\library\\cover.png",
    });
    expect(repairClient.order).toEqual(["upload", "queued", "delete"]);
    expect(repairClient.startUpload).toHaveBeenCalledWith({
      localPath: "C:\\library\\cover.png",
      purpose: "asset_import",
      mediaType: "image",
      import: { providerConnectionId: "provider-1", name: "封面", groupId: "16" },
    });
    expect(repairClient.deleteAsset).toHaveBeenCalledWith({
      providerConnectionId: "provider-1",
      id: "asset-1",
    });
  });

  it("没有本机原件时不删除，同一条素材也不再查第二次", async () => {
    const repairClient = client({
      resolveImportedAsset: vi.fn(() => Promise.resolve(null)),
    });
    await expect(repairUnavailableCloudAsset(cloudImage(), repairClient)).resolves.toEqual({
      status: "skipped",
      reason: "no-local-file",
    });
    await expect(repairUnavailableCloudAsset(cloudImage(), repairClient)).resolves.toEqual({
      status: "skipped",
      reason: "already-attempted",
    });
    expect(repairClient.resolveImportedAsset).toHaveBeenCalledTimes(1);
    expect(repairClient.deleteAsset).not.toHaveBeenCalled();
    expect(repairClient.startUpload).not.toHaveBeenCalled();
  });

  it("上传没能启动时保留旧素材，之后还可以再试", async () => {
    const startUpload = vi
      .fn()
      .mockRejectedValueOnce(new Error("tos down"))
      .mockResolvedValueOnce("job-2");
    const repairClient = client({ startUpload });
    await expect(repairUnavailableCloudAsset(cloudImage(), repairClient)).resolves.toMatchObject({
      status: "failed",
      reason: "upload",
    });
    expect(repairClient.deleteAsset).not.toHaveBeenCalled();
    await expect(repairUnavailableCloudAsset(cloudImage(), repairClient)).resolves.toMatchObject({
      status: "replaced",
      jobId: "job-2",
      deleted: true,
    });
  });

  it("删除失败时新上传仍然保留", async () => {
    const repairClient = client({
      deleteAsset: vi.fn(() => Promise.reject(new Error("delete failed"))),
    });
    const result = await repairUnavailableCloudAsset(cloudImage(), repairClient);
    expect(result).toMatchObject({ status: "replaced", deleted: false, jobId: "job-1" });
    expect(repairClient.startUpload).toHaveBeenCalledTimes(1);
  });

  it("处理中、类型不符、同一原件都不删除", async () => {
    const repairClient = client();
    await expect(
      repairUnavailableCloudAsset(cloudImage({ cloudStatus: "processing" }), repairClient),
    ).resolves.toEqual({ status: "skipped", reason: "ineligible" });
    await expect(
      repairUnavailableCloudAsset(cloudImage({ source: "local" }), repairClient),
    ).resolves.toEqual({ status: "skipped", reason: "ineligible" });

    const mismatch = client({
      resolveImportedAsset: vi.fn(() =>
        Promise.resolve({
          localPath: "C:\\library\\clip.mp4",
          mediaType: "video" as const,
          groupId: null,
          name: null,
        }),
      ),
    });
    await expect(
      repairUnavailableCloudAsset(cloudImage({ id: "asset-2" }), mismatch),
    ).resolves.toEqual({ status: "skipped", reason: "type-mismatch" });
    expect(mismatch.deleteAsset).not.toHaveBeenCalled();

    const shared = client();
    await repairUnavailableCloudAsset(cloudImage({ id: "asset-3" }), shared);
    await expect(
      repairUnavailableCloudAsset(cloudImage({ id: "asset-4", name: "另一张" }), shared),
    ).resolves.toEqual({ status: "skipped", reason: "already-attempted" });
    expect(shared.deleteAsset).toHaveBeenCalledTimes(1);
    expect(shared.startUpload).toHaveBeenCalledTimes(1);
  });
});

describe("replaceCloudAssetIdInPromptDocument", () => {
  it("只改写指向旧云端素材的引用", () => {
    const document: PromptContentDocumentV1 = {
      schema: "prompt-content",
      version: 1,
      items: [
        { kind: "text", text: "看" },
        {
          kind: "media_reference",
          mentionId: "m1",
          canvasNodeKey: "node-1",
          displayNameSnapshot: "封面",
          target: {
            kind: "asset",
            providerConnectionId: "provider-1",
            assetId: "asset-old",
            mediaType: "image",
          },
        },
        {
          kind: "media_reference",
          mentionId: "m2",
          canvasNodeKey: "node-2",
          displayNameSnapshot: "别的",
          target: {
            kind: "asset",
            providerConnectionId: "provider-1",
            assetId: "asset-keep",
            mediaType: "image",
          },
        },
      ],
    };
    const next = replaceCloudAssetIdInPromptDocument(document, "asset-old", "asset-new");
    expect(next?.items[1]).toMatchObject({
      target: { kind: "asset", assetId: "asset-new" },
    });
    expect(next?.items[2]).toMatchObject({
      target: { kind: "asset", assetId: "asset-keep" },
    });
    expect(replaceCloudAssetIdInPromptDocument(document, "missing", "asset-new")).toBeNull();
  });
});
