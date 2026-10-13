import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  approveBrandModelVersion,
  brandModelVersionRequirements,
  archiveBrandModel,
  listBrandModels,
  parseBrandModelSelection,
  saveBrandModelVersion,
  selectBrandModelVersion,
  validateBrandModelVersion,
  type BrandModelProfile,
  type BrandModelVersion,
} from "./brandModels";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./backend", () => ({ isDesktopRuntime: vi.fn(() => true) }));

function fixture(status: "draft" | "approved" = "approved"): BrandModelProfile {
  const version: BrandModelVersion = {
    id: "version-one",
    version: 1,
    createdAt: 100,
    status,
    description: "成年短发模特",
    invariants: "脸型与眼型固定",
    signature: "a".repeat(64),
    references: [
      {
        id: "ref-one",
        label: "正面",
        role: "front",
        path: "C:/app/brand-models/one/ref.png",
        contentHash: "b".repeat(64),
        width: 10,
        height: 12,
        taskId: "real-task",
        resultIndex: 0,
        sourceNodeId: "real-node",
      },
    ],
  };
  return {
    id: "profile-one",
    brandName: "品牌",
    name: "模特 A",
    archived: false,
    currentVersionId: status === "approved" ? version.id : null,
    createdAt: 100,
    updatedAt: 100,
    versions: [version],
  };
}

describe("durable brand model client", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  });

  it("reports every missing save requirement and prevents incomplete native submissions", async () => {
    const command = { brandName: "  ", name: "", description: "", invariants: "", references: [] };
    expect(brandModelVersionRequirements(command).map((entry) => entry.field)).toEqual([
      "brandName",
      "name",
      "description",
      "invariants",
      "references",
    ]);
    await expect(saveBrandModelVersion(command)).rejects.toThrow("请至少添加一张");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("lists cross-canvas native profiles and rejects temporary-url identity bodies", async () => {
    const profile = fixture();
    vi.mocked(invoke).mockResolvedValue([profile]);
    await expect(listBrandModels()).resolves.toEqual([profile]);
    expect(invoke).toHaveBeenCalledWith("list_brand_models");
    vi.mocked(invoke).mockResolvedValue([
      {
        ...profile,
        versions: [
          {
            ...profile.versions[0],
            references: [
              { ...profile.versions[0]!.references[0], path: "https://temporary/model.png" },
            ],
          },
        ],
      },
    ]);
    await expect(listBrandModels()).rejects.toThrow();
  });

  it("saves source/provenance and optimistic approved baseline without inline media or tokens", async () => {
    const profile = fixture("draft");
    const command = {
      profileId: "profile-one",
      expectedCurrentVersionId: null,
      brandName: "品牌",
      name: "模特 A",
      description: "成年短发模特",
      invariants: "脸型与眼型固定",
      references: [
        {
          sourcePath: "C:/saved/model.png",
          label: "正面",
          role: "front" as const,
          taskId: "real-task",
          resultIndex: 0,
          sourceNodeId: "real-node",
        },
      ],
    };
    vi.mocked(invoke).mockResolvedValue(profile);
    await expect(saveBrandModelVersion(command)).resolves.toEqual(profile);
    expect(invoke).toHaveBeenCalledWith("save_brand_model_version", { command });
    vi.mocked(invoke).mockClear();
    await expect(
      saveBrandModelVersion({
        ...command,
        references: [{ sourcePath: "data:image/png;base64,YQ==", label: "正面", role: "front" }],
      }),
    ).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("native approval and execution validation bind exact version and signature", async () => {
    const profile = fixture();
    const command = {
      profileId: profile.id,
      versionId: profile.versions[0]!.id,
      expectedSignature: profile.versions[0]!.signature,
    };
    vi.mocked(invoke).mockResolvedValue(profile);
    await expect(approveBrandModelVersion(command)).resolves.toEqual(profile);
    expect(invoke).toHaveBeenLastCalledWith("approve_brand_model_version", { command });
    vi.mocked(invoke).mockResolvedValue(profile.versions[0]);
    await expect(validateBrandModelVersion(command)).resolves.toEqual(profile.versions[0]);
    expect(invoke).toHaveBeenLastCalledWith("validate_brand_model_version", { command });
    vi.mocked(invoke).mockResolvedValue({ ...profile.versions[0], id: "latest-unselected" });
    await expect(validateBrandModelVersion(command)).rejects.toThrow("不匹配");
    vi.mocked(invoke).mockResolvedValue({ ...profile.versions[0], status: "draft" });
    await expect(validateBrandModelVersion(command)).rejects.toThrow("不匹配");
  });

  it("creates a detached approved snapshot that never follows a later current identity", () => {
    const profile = fixture();
    const selected = selectBrandModelVersion(profile, profile.versions[0]!);
    expect(selected).toEqual({
      profileId: "profile-one",
      versionId: "version-one",
      signature: "a".repeat(64),
      name: "模特 A",
      description: "成年短发模特",
      invariants: "脸型与眼型固定",
      references: profile.versions[0]!.references,
    });
    expect(selected.references[0]).not.toBe(profile.versions[0]!.references[0]);
    expect(
      selectBrandModelVersion(
        { ...profile, currentVersionId: "newer-approved" },
        profile.versions[0]!,
      ),
    ).toEqual(selected);
    expect(() =>
      selectBrandModelVersion({ ...profile, archived: true }, profile.versions[0]!),
    ).toThrow("已归档");
    const draft = fixture("draft");
    expect(() => selectBrandModelVersion(draft, draft.versions[0]!)).toThrow("尚未批准");
    expect(() => parseBrandModelSelection({ ...selected, apiKey: "must-not-persist" })).toThrow();
  });

  it("archives or restores native profile identity without a destructive delete command", async () => {
    const profile = fixture();
    const command = { profileId: profile.id, archived: true };
    vi.mocked(invoke).mockResolvedValue({ ...profile, archived: true });
    await expect(archiveBrandModel(command)).resolves.toMatchObject({
      id: profile.id,
      archived: true,
      versions: profile.versions,
    });
    expect(invoke).toHaveBeenCalledWith("archive_brand_model", { command });
    vi.mocked(invoke).mockResolvedValue(profile);
    await expect(archiveBrandModel(command)).rejects.toThrow("不匹配");
  });
});
