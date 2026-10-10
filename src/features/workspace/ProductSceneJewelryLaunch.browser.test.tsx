import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { ProductSceneJewelryLaunch } from "./ProductSceneJewelryLaunch";
import { generateJewelryLaunchDraft } from "./jewelryLaunchPlan";
import { createJewelrySceneOptions } from "./productSceneWorkflowModel";
import "../../App.css";

describe("jewelry launch plan geometry", () => {
  it("keeps long source names, controls and expanded prompts readable at narrow and wide sizes", async () => {
    const base = createJewelrySceneOptions();
    const options = {
      ...base,
      views: [
        {
          id: "source",
          label: "这是很长的客户实拍照片文件名_".repeat(9) + ".jpg",
          angle: "front45" as const,
          sourcePath: "C:/photos/source.jpg",
          preparedPath: "C:/master/source.png",
          contentHash: "a".repeat(64),
          approved: false,
        },
      ],
    };
    const draft = generateJewelryLaunchDraft(options);
    await render(
      <div data-testid="launch-node" style={{ width: 375 }}>
        <ProductSceneJewelryLaunch
          options={{ ...options, jewelry: { ...options.jewelry!, launch: { draft } } }}
          disabled={false}
          onChange={vi.fn()}
        />
      </div>,
    );
    const container = page.getByTestId("launch-node").element() as HTMLElement;
    for (const element of container.querySelectorAll("details")) element.open = true;
    for (const width of [375, 720]) {
      container.style.width = `${width}px`;
      expect(container.scrollWidth).toBeLessThanOrEqual(container.clientWidth + 1);
      const boundary = container.getBoundingClientRect().right;
      for (const control of container.querySelectorAll<HTMLElement>("textarea,button,summary,p,dd"))
        expect(control.getBoundingClientRect().right).toBeLessThanOrEqual(boundary + 1);
    }
    await expect.element(page.getByRole("button", { name: "导出十图方案" })).toBeVisible();
  });
});
