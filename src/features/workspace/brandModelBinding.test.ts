import { describe, expect, it, vi } from "vitest";
import type { BrandModelSelection, BrandModelVersion } from "../../lib/brandModels";
import { brandModelIdentityPrompt, validateBoundBrandModel } from "./brandModelBinding";

const selection: BrandModelSelection = {
  profileId: "model-one",
  versionId: "v1",
  name: "品牌模特",
  signature: "a".repeat(64),
  description: "原创成年模特，自然肤质",
  invariants: "灰眼、下颌轮廓、左颊雀斑",
  references: [
    {
      id: "front",
      label: "正面",
      role: "front",
      path: "C:/managed/front.png",
      contentHash: "b".repeat(64),
      width: 1200,
      height: 1600,
      taskId: "original-task",
      resultIndex: 0,
    },
  ],
};
const version: BrandModelVersion = {
  id: "v1",
  version: 1,
  status: "approved",
  createdAt: 1,
  description: selection.description,
  invariants: selection.invariants,
  references: selection.references,
  signature: selection.signature,
};

describe("frozen brand model binding", () => {
  it("uses exactly the selected approved version rather than the profile's newest identity", async () => {
    const validate = vi.fn(() => Promise.resolve(version));
    expect(await validateBoundBrandModel(selection, validate)).toEqual(version);
    expect(validate).toHaveBeenCalledWith({
      profileId: "model-one",
      versionId: "v1",
      expectedSignature: selection.signature,
    });
    expect(brandModelIdentityPrompt(selection)).toContain("frozen version v1");
  });
  it("rejects altered identity snapshots, different versions and unapproved drafts", async () => {
    for (const changed of [
      { ...selection, invariants: "另一张脸" },
      {
        ...selection,
        references: selection.references.map((ref) => ({ ...ref, path: "C:/other.png" })),
      },
    ])
      await expect(
        validateBoundBrandModel(changed, () => Promise.resolve(version)),
      ).rejects.toThrow("定稿版本不一致");
    for (const changed of [
      { ...version, status: "draft" as const },
      { ...version, id: "v2" },
    ])
      await expect(
        validateBoundBrandModel(selection, () => Promise.resolve(changed)),
      ).rejects.toThrow("定稿版本不一致");
  });
  it("propagates missing or modified managed-file failure before using identity media", async () => {
    await expect(
      validateBoundBrandModel(selection, () => Promise.reject(new Error("托管参考图已改变"))),
    ).rejects.toThrow("托管参考图已改变");
  });
});
