import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { productSceneImageClient } from "./productSceneImages";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("./backend", () => ({ isDesktopRuntime: () => true }));

const hash = "a".repeat(64);
const command = {
  backgroundPath: "C:/background.png",
  productPath: "C:/approved-photo.png",
  productHash: hash,
  outputId: "protected-sample",
  aspectRatio: "3:4" as const,
  placement: { centerX: 0.5, baselineY: 0.77, widthFraction: 0.48 },
  region: { x: 0.1, y: 0.2, width: 0.7, height: 0.6 },
  feather: 0.025,
};
const result = {
  path: "C:/protected-result.png",
  width: 1536,
  height: 2048,
  backgroundHash: "b".repeat(16),
  foregroundHash: hash,
  protection: {
    region: command.region,
    feather: command.feather,
    sourceWidth: 600,
    sourceHeight: 800,
    corePixelCount: 200000,
    verified: true,
    outputHash: "c".repeat(64),
  },
};

describe("protected product photograph IPC", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(open).mockReset();
  });

  it("prepares a complete source photograph through the native preservePhoto operation", async () => {
    vi.mocked(invoke).mockResolvedValue({
      path: "C:/approved-photo.png",
      width: 600,
      height: 800,
      contentHash: hash,
      photoPreserved: true,
    });
    await productSceneImageClient.prepare({ sourcePath: "C:/wrist.jpg", preservePhoto: true });
    expect(invoke).toHaveBeenCalledWith("prepare_product_scene_view", {
      command: { sourcePath: "C:/wrist.jpg", preservePhoto: true },
    });
  });

  it("blocks an older native host that ignores photograph protection before any paid generation", async () => {
    vi.mocked(invoke).mockResolvedValue({
      path: "C:/legacy-cutout.png",
      width: 600,
      height: 800,
      contentHash: hash,
    });
    await expect(
      productSceneImageClient.prepare({ sourcePath: "C:/wrist.jpg", preservePhoto: true }),
    ).rejects.toThrow("未确认整张原片保留");
    vi.mocked(invoke).mockResolvedValue(undefined);
    await expect(
      productSceneImageClient.validateViews({
        views: [
          {
            path: command.productPath,
            contentHash: hash,
            region: command.region,
            feather: command.feather,
          },
        ],
      }),
    ).rejects.toThrow("未确认原片保护检查");
    vi.mocked(invoke).mockResolvedValue(true);
    await expect(
      productSceneImageClient.validateViews({
        views: [
          {
            path: command.productPath,
            contentHash: hash,
            region: command.region,
            feather: command.feather,
          },
        ],
      }),
    ).resolves.toBeUndefined();
  });

  it("accepts changed source and protection records as native diagnostic information", async () => {
    vi.mocked(invoke).mockResolvedValue(result);
    await expect(productSceneImageClient.composeProtected!(command)).resolves.toEqual(result);
    expect(invoke).toHaveBeenCalledWith("compose_product_scene_protected", { command });
    vi.mocked(invoke).mockResolvedValue({ ...result, foregroundHash: "d".repeat(64) });
    await expect(productSceneImageClient.composeProtected!(command)).resolves.toMatchObject({
      foregroundHash: "d".repeat(64),
    });
    vi.mocked(invoke).mockResolvedValue({
      ...result,
      protection: { ...result.protection, region: { ...command.region, x: 0.2 } },
    });
    await expect(productSceneImageClient.composeProtected!(command)).resolves.toMatchObject({
      protection: { region: { ...command.region, x: 0.2 } },
    });
  });

  it("retains unverified receipts, missing historical hashes and native warnings without blocking the image", async () => {
    vi.mocked(invoke).mockResolvedValue({
      ...result,
      protection: { ...result.protection, verified: false, warnings: ["母版内容已变化"] },
    });
    await expect(productSceneImageClient.composeProtected!(command)).resolves.toMatchObject({
      protection: { verified: false, warnings: ["母版内容已变化"] },
    });
    vi.mocked(invoke).mockResolvedValue({
      ...result,
      protection: { ...result.protection, outputHash: "", corePixelCount: 0 },
    });
    await expect(productSceneImageClient.composeProtected!(command)).resolves.toMatchObject({
      protection: { outputHash: "", corePixelCount: 0 },
    });
  });

  it("rejects an out-of-photo or nonfinite protected rectangle before native work", async () => {
    for (const region of [
      { ...command.region, width: 1 },
      { ...command.region, x: Number.NaN },
      { ...command.region, height: 0 },
    ]) {
      await expect(
        productSceneImageClient.composeProtected!({ ...command, region }),
      ).rejects.toThrow("保护范围无效");
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it("keeps output size validation while allowing changed receipts", async () => {
    vi.mocked(invoke).mockResolvedValue({ ...result, width: 1200 });
    await expect(productSceneImageClient.composeProtected!(command)).rejects.toThrow("输出尺寸");
  });

  it("accepts native square output and rejects a legacy portrait returned for a square request", async () => {
    const square = { ...command, aspectRatio: "1:1" as const };
    vi.mocked(invoke).mockResolvedValue({ ...result, width: 2048 });
    await expect(productSceneImageClient.composeProtected!(square)).resolves.toMatchObject({
      width: 2048,
      height: 2048,
    });
    expect(invoke).toHaveBeenCalledWith("compose_product_scene_protected", { command: square });
    vi.mocked(invoke).mockResolvedValue(result);
    await expect(productSceneImageClient.composeProtected!(square)).rejects.toThrow("输出尺寸");
  });

  it("exports existing images with unreviewed or historical metadata without a frontend evidence gate", async () => {
    vi.mocked(open).mockResolvedValue("C:/delivery");
    vi.mocked(invoke).mockResolvedValue({ directory: "C:/delivery/export", count: 1 });
    const exportCommand = {
      paths: ["C:/edited-result.png"],
      manifest: JSON.stringify({
        generationMode: "protected",
        rows: [
          {
            outputPath: "C:/edited-result.png",
            status: "needs_review",
            protection: { verified: false },
            jewelryReview: { outputPath: "C:/older-result.png" },
          },
        ],
      }),
    };
    await expect(productSceneImageClient.export(exportCommand)).resolves.toEqual({
      directory: "C:/delivery/export",
      count: 1,
    });
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith("export_product_scenes", {
      command: { ...exportCommand, directory: "C:/delivery" },
    });
  });
});
