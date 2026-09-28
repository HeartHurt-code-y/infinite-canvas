import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { describe, expect, it } from "vitest";
import { CanvasAgentController } from "./canvasAgentController";
import { CanvasAgentPanel } from "./CanvasAgentPanel";
import "../../../App.css";
import "../../../styles/studio.css";

function bounds(selector: string): DOMRect {
  const element = document.querySelector<HTMLElement>(selector);
  expect(element).not.toBeNull();
  return element!.getBoundingClientRect();
}

function expectNoHorizontalOverflow() {
  for (const selector of [
    ".canvas-agent",
    ".canvas-agent__transcript",
    ".canvas-agent__examples",
    ".canvas-agent__examples button",
  ]) {
    for (const element of document.querySelectorAll<HTMLElement>(selector)) {
      expect(element.scrollWidth, selector).toBeLessThanOrEqual(element.clientWidth + 1);
    }
  }
}

describe("CanvasAgentPanel workspace layout", () => {
  it("reserves sidebar space without covering controls and keeps a compact edge toggle on narrow screens", async () => {
    await page.viewport(1280, 900);
    const controller = new CanvasAgentController();
    await render(
      <main className="workspace-shell">
        <CanvasAgentPanel controller={controller} catalog={[]} />
        <div className="workspace-content">
          <header className="workspace-header">无限画布</header>
          <aside className="asset-panel">素材库</aside>
          <section className="canvas-stage">
            <div className="canvas-viewport" />
            <div className="canvas-viewport-dock">
              <div className="canvas-history-control">
                <button type="button">撤销</button>
                <button type="button">重做</button>
              </div>
              <div className="zoom-control">
                <button type="button">减小</button>
                <output>50%</output>
                <button type="button">放大</button>
              </div>
            </div>
          </section>
        </div>
      </main>,
    );
    const originalHeader = bounds(".workspace-header");
    const originalAssets = bounds(".asset-panel");
    const originalCanvas = bounds(".canvas-stage");
    const closedToggle = bounds(".canvas-agent-toggle");
    expect(closedToggle.width).toBeLessThanOrEqual(28);
    expect(closedToggle.right).toBeCloseTo(originalCanvas.right, 0);
    expect(closedToggle.top + closedToggle.height / 2).toBeCloseTo(
      originalCanvas.top + originalCanvas.height / 2,
      0,
    );
    await page.getByRole("button", { name: "打开创作助手" }).click();
    await expect.element(page.getByRole("complementary", { name: "创作助手" })).toBeVisible();
    const sidebar = bounds(".canvas-agent");
    const canvas = bounds(".canvas-stage");
    const dock = bounds(".canvas-viewport-dock");
    expect(canvas.right).toBeCloseTo(sidebar.left, 0);
    expect(sidebar.right).toBeCloseTo(window.innerWidth, 0);
    expect(dock.right).toBeLessThanOrEqual(canvas.right);
    expect(dock.bottom).toBeLessThanOrEqual(canvas.bottom);
    expect(bounds(".workspace-header").width).toBe(originalHeader.width);
    expect(bounds(".asset-panel").width).toBe(originalAssets.width);
    expect(bounds(".asset-panel").left).toBe(originalAssets.left);
    expect(bounds(".canvas-agent-toggle").right).toBeCloseTo(canvas.right, 0);
    expectNoHorizontalOverflow();

    await page.viewport(1079, 900);
    expectNoHorizontalOverflow();
    const firstExample = document.querySelector<HTMLElement>(".canvas-agent__examples button")!;
    expect(getComputedStyle(firstExample).whiteSpace).toBe("normal");
    const exampleText = document.createRange();
    exampleText.selectNodeContents(firstExample.firstChild!);
    expect(exampleText.getBoundingClientRect().height).toBeGreaterThan(
      Number.parseFloat(getComputedStyle(firstExample).lineHeight) * 1.5,
    );

    await page.viewport(390, 844);
    await expect
      .poll(() => bounds(".canvas-agent").top)
      .toBeGreaterThanOrEqual(bounds(".canvas-stage").bottom);
    const narrowCanvas = bounds(".canvas-stage");
    const narrowSidebar = bounds(".canvas-agent");
    const narrowDock = bounds(".canvas-viewport-dock");
    expect(narrowDock.bottom).toBeLessThanOrEqual(narrowCanvas.bottom);
    expect(narrowDock.right).toBeLessThanOrEqual(narrowCanvas.right);
    expect(narrowSidebar.right).toBeLessThanOrEqual(window.innerWidth);
    expect(bounds(".canvas-agent__composer").bottom).toBeLessThanOrEqual(narrowSidebar.bottom);
    expectNoHorizontalOverflow();
    await page.getByRole("button", { name: "收起创作助手" }).click();
    await expect
      .element(page.getByRole("button", { name: "打开创作助手" }))
      .toHaveAttribute("aria-expanded", "false");
    expect(document.querySelector(".canvas-agent")).toBeNull();
    expect(bounds(".canvas-stage").height).toBeGreaterThan(narrowCanvas.height);
  });
});
