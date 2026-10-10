import { useState } from "react";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { BrandDesignStudio } from "./BrandDesignStudio";
import { createBrandDesignDocument, type BrandDesignDocument } from "./brandDesignModel";
import { generateJewelryLaunchDraft } from "./jewelryLaunchPlan";
import { createJewelrySceneOptions } from "./productSceneWorkflowModel";
import "../../App.css";

const path = "C:/outputs/earrings.png";

function Harness() {
  const draft = generateJewelryLaunchDraft(createJewelrySceneOptions());
  const base = createBrandDesignDocument(draft);
  const [design, setDesign] = useState<BrandDesignDocument>({
    ...base,
    brandName: "杉间珠宝",
    seriesTitle: "自然新作",
    slots: base.slots.map((slot) => ({
      ...slot,
      copy: { title: "自然新作", body: "金属与珍珠的对话。" },
      source: {
        path,
        label: "客户已保存的耳饰模特成图文件名".repeat(10),
        kind: "generated" as const,
        taskId: "task-stable",
        sourceNodeId: "node-stable",
      },
    })),
  });
  return (
    <div data-testid="brand-studio-node" style={{ width: 375 }}>
      <BrandDesignStudio
        draft={draft}
        design={design}
        candidates={[]}
        disabled={false}
        onChange={setDesign}
        onApplyAiStyle={vi.fn()}
      />
    </div>
  );
}

describe("brand design editor browser geometry", () => {
  it("keeps controls within a narrow node and displays a real decoded design preview", async () => {
    const raster = document.createElement("canvas");
    raster.width = 200;
    raster.height = 100;
    const context = raster.getContext("2d")!;
    context.fillStyle = "#00a000";
    context.fillRect(0, 0, 200, 100);
    context.fillStyle = "#e00000";
    context.fillRect(0, 0, 20, 100);
    context.fillStyle = "#0000e0";
    context.fillRect(180, 0, 20, 100);
    const image = {
      dataUrl: raster.toDataURL("image/png"),
      width: 200,
      height: 100,
      contentHash: "a".repeat(64),
    };
    const invoke = vi.fn((command: string) =>
      command === "read_brand_design_image"
        ? Promise.resolve(image)
        : Promise.reject(new Error(`Unexpected native command: ${command}`)),
    );
    vi.stubGlobal("__TAURI_INTERNALS__", { invoke });
    await render(<Harness />);
    const container = page.getByTestId("brand-studio-node").element() as HTMLElement;
    (container.querySelector("details") as HTMLDetailsElement).open = true;
    await page.getByRole("combobox", { name: "编辑图位" }).selectOptions("M01");
    await page.getByRole("button", { name: "更新设计预览" }).click();
    await expect.element(page.getByRole("img", { name: "M01 品牌设计预览" })).toBeVisible();
    const preview = page
      .getByRole("img", { name: "M01 品牌设计预览" })
      .element() as HTMLImageElement;
    await preview.decode();
    expect([preview.naturalWidth, preview.naturalHeight]).toEqual([614, 614]);
    expect(invoke).toHaveBeenCalledWith(
      "read_brand_design_image",
      { command: { path } },
      undefined,
    );
    const decoded = document.createElement("canvas");
    decoded.width = preview.naturalWidth;
    decoded.height = preview.naturalHeight;
    const decodedContext = decoded.getContext("2d")!;
    decodedContext.drawImage(preview, 0, 0);
    expect(Array.from(decodedContext.getImageData(36, 250, 1, 1).data)).toEqual([224, 0, 0, 255]);
    expect(Array.from(decodedContext.getImageData(578, 250, 1, 1).data)).toEqual([0, 0, 224, 255]);
    for (const width of [375, 720]) {
      container.style.width = `${width}px`;
      expect(container.scrollWidth).toBeLessThanOrEqual(container.clientWidth + 1);
      const boundary = container.getBoundingClientRect().right;
      for (const control of container.querySelectorAll<HTMLElement>(
        "input,select,textarea,button,summary,p,img",
      )) {
        expect(control.getBoundingClientRect().right).toBeLessThanOrEqual(boundary + 1);
        expect(control.getBoundingClientRect().left).toBeGreaterThanOrEqual(
          container.getBoundingClientRect().left - 1,
        );
      }
    }
  });
});
