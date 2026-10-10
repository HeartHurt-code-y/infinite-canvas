import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { exportBrandDesignBundle, readBrandDesignImage } from "./brandDesignClient";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("./backend", () => ({ isDesktopRuntime: () => true }));

describe("brand design desktop delivery", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(open).mockReset();
  });

  it("reads an unchanged local source through native image normalization and validates its identity", async () => {
    const result = {
      dataUrl: "data:image/png;base64,YWJj",
      width: 32,
      height: 16,
      contentHash: "a".repeat(64),
    };
    vi.mocked(invoke).mockResolvedValue(result);
    await expect(readBrandDesignImage("C:/brand/original.jpg")).resolves.toEqual(result);
    expect(invoke).toHaveBeenCalledWith("read_brand_design_image", {
      command: { path: "C:/brand/original.jpg" },
    });
    vi.mocked(invoke).mockResolvedValue({ ...result, contentHash: "temporary-url" });
    await expect(readBrandDesignImage("C:/brand/original.jpg")).rejects.toThrow();
  });

  it("does not write when directory selection is cancelled", async () => {
    vi.mocked(open).mockResolvedValue(null);
    await expect(
      exportBrandDesignBundle([{ name: "MAIN.png", base64: "YWJj" }], "{}"),
    ).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("exports all encoded deliverables and manifest into the explicitly chosen directory", async () => {
    const files = [
      { name: "MAIN.png", base64: "YWJj" },
      { name: "design.json", base64: "e30=" },
    ];
    const manifest = JSON.stringify({ source: { taskId: "stable-task", resultIndex: 1 } });
    vi.mocked(open).mockResolvedValue("C:/brand/deliveries");
    vi.mocked(invoke).mockResolvedValue({
      directory: "C:/brand/deliveries/品牌设计-unique",
      count: 2,
    });
    await expect(exportBrandDesignBundle(files, manifest)).resolves.toEqual({
      directory: "C:/brand/deliveries/品牌设计-unique",
      count: 2,
    });
    expect(invoke).toHaveBeenCalledWith("export_brand_design_bundle", {
      command: { directory: "C:/brand/deliveries", files, manifest },
    });
    vi.mocked(invoke).mockResolvedValue({ directory: "C:/brand/partial", count: 1 });
    await expect(exportBrandDesignBundle(files, manifest)).rejects.toThrow("数量不匹配");
  });
});
