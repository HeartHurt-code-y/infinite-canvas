import { describe, expect, it, vi } from "vitest";
import type { AssetStatusObservation, CloudAsset } from "../../lib/backend";
import { settlementForCloudAsset, settleUnreadyCloudAsset } from "./cloudAssetSettlement";

function observation(overrides: Partial<AssetStatusObservation> = {}): AssetStatusObservation {
  return {
    status: "processing",
    rawStatus: "Processing",
    failureReason: null,
    missing: false,
    previewUrl: null,
    coverUrl: null,
    ...overrides,
  };
}

const processingAsset: CloudAsset = {
  providerConnectionId: "provider-1",
  id: "asset-1",
  name: "封面",
  kind: "image",
  status: "processing",
  rawStatus: "Processing",
  previewUrl: null,
  assetUrl: null,
  coverUrl: null,
  groupId: null,
};

describe("settlementForCloudAsset", () => {
  it("云端仍返回处理中时保留素材", () => {
    expect(settlementForCloudAsset("processing", observation())).toEqual({ kind: "keep" });
  });

  it("复核暂时失败时，不删除仍显示为处理中的素材", () => {
    expect(settlementForCloudAsset("processing", "unavailable")).toEqual({ kind: "keep" });
  });

  it("列表已经是失败、复核又连不上时仍然删除", () => {
    expect(settlementForCloudAsset("failed", "unavailable")).toEqual({
      kind: "removed",
      reason: "云端导入失败，没有返回可用结果",
    });
  });

  it("处理中的记录带上云端错误时删除，并带上原因", () => {
    expect(
      settlementForCloudAsset(
        "processing",
        observation({ status: "failed", failureReason: "FaceMismatch" }),
      ),
    ).toEqual({
      kind: "removed",
      reason: "云端没有返回可用结果：FaceMismatch",
    });
  });

  it("云端明确没有这条素材时删除", () => {
    expect(
      settlementForCloudAsset(
        "processing",
        observation({
          status: "deleted",
          missing: true,
          failureReason: "云端没有返回该素材",
        }),
      ),
    ).toEqual({ kind: "removed", reason: "云端没有返回该素材" });
  });

  it("复核变为就绪时升级，不删除", () => {
    expect(
      settlementForCloudAsset(
        "processing",
        observation({
          status: "ready",
          rawStatus: "Active",
          previewUrl: "https://cdn.example/a.png",
        }),
      ),
    ).toEqual({
      kind: "ready",
      rawStatus: "Active",
      previewUrl: "https://cdn.example/a.png",
      coverUrl: null,
    });
  });
});

describe("settleUnreadyCloudAsset", () => {
  it("云端报错时删除素材", async () => {
    const deleteAsset = vi.fn(() => Promise.resolve("asset-1"));
    const outcome = await settleUnreadyCloudAsset(processingAsset, {
      observeAssetStatus: vi.fn(() =>
        Promise.resolve(observation({ status: "failed", failureReason: "审核未通过" })),
      ),
      deleteAsset,
    });
    expect(deleteAsset).toHaveBeenCalledWith({
      providerConnectionId: "provider-1",
      id: "asset-1",
    });
    expect(outcome).toEqual({
      kind: "removed",
      reason: "云端没有返回可用结果：审核未通过",
    });
  });

  it("删除请求失败时不假装已经移除", async () => {
    const outcome = await settleUnreadyCloudAsset(
      { ...processingAsset, status: "failed" },
      {
        observeAssetStatus: vi.fn(() => Promise.reject(new Error("offline"))),
        deleteAsset: vi.fn(() => Promise.reject(new Error("delete failed"))),
      },
    );
    expect(outcome).toEqual({ kind: "keep" });
  });

  it("云端仍在处理时不调用删除", async () => {
    const deleteAsset = vi.fn(() => Promise.resolve("asset-1"));
    const outcome = await settleUnreadyCloudAsset(processingAsset, {
      observeAssetStatus: vi.fn(() => Promise.resolve(observation())),
      deleteAsset,
    });
    expect(deleteAsset).not.toHaveBeenCalled();
    expect(outcome).toEqual({ kind: "keep" });
  });
});
