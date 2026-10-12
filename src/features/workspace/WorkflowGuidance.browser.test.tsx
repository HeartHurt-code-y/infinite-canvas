import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";

import { ReelbenchConfiguration } from "./ReelbenchWorkflowSections";
import { createReelbenchOptions } from "./reelbenchWorkflowModel";
import { WorkflowFieldHelp, WorkflowGuide } from "./WorkflowGuidance";
import { RequiredMark } from "./workflowFieldRequirements";
import "../../App.css";
import "../../styles/studio.css";

function element(selector: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(selector);
  expect(found, selector).not.toBeNull();
  return found!;
}

function assertContainedLayout() {
  const node = element('[data-testid="workflow"]');
  expect(node.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth + 1);
  for (const selector of [
    '[data-testid="workflow"]',
    ".canvas-knowledge-workflow__body",
    ".workflow-guide",
    ".workflow-guide__content",
    '[data-testid="brief"]',
  ]) {
    const container = element(selector);
    expect(container.scrollWidth, selector).toBeLessThanOrEqual(container.clientWidth + 1);
  }
  const guideBounds = element(".workflow-guide").getBoundingClientRect();
  for (const child of document.querySelectorAll<HTMLElement>(
    ".workflow-guide__content > div, .workflow-guide blockquote, .workflow-guide summary",
  )) {
    const bounds = child.getBoundingClientRect();
    expect(bounds.left).toBeGreaterThanOrEqual(guideBounds.left - 1);
    expect(bounds.right).toBeLessThanOrEqual(guideBounds.right + 1);
  }
  expect(element('[data-testid="brief"]').getBoundingClientRect().top).toBeGreaterThanOrEqual(
    guideBounds.bottom,
  );
  const controlBounds = element("textarea").getBoundingClientRect();
  const helpBounds = element(".workflow-field-help").getBoundingClientRect();
  expect(helpBounds.top).toBeGreaterThanOrEqual(controlBounds.bottom);
  expect(helpBounds.right).toBeLessThanOrEqual(node.getBoundingClientRect().right + 1);
}

describe("workflow guidance in a real canvas node", () => {
  it("opens by pointer and keyboard, adapts columns, and keeps help accessible without enlarging the field name", async () => {
    await page.viewport(1200, 1100);
    await render(
      <div className="react-flow__node">
        <div className="canvas-flow-node">
          <article className="canvas-knowledge-workflow" data-testid="workflow">
            <header className="canvas-knowledge-workflow__header">知识教学视频</header>
            <div className="canvas-knowledge-workflow__body">
              <WorkflowGuide kind="knowledge" />
              <label className="canvas-knowledge-workflow__brief" data-testid="brief">
                <RequiredMark>制作要求</RequiredMark>
                <textarea rows={3} aria-describedby="brief-existing-description" />
                <WorkflowFieldHelp>
                  写清主题、受众和希望对方学会什么；不知道风格时可先保留默认设置。
                </WorkflowFieldHelp>
              </label>
              <p id="brief-existing-description">已有资料可以添加到参考素材中。</p>
            </div>
          </article>
        </div>
      </div>,
    );

    const summary = page.getByText("第一次使用？查看准备步骤与填写示例", { exact: true });
    await expect.element(page.getByText("先准备这些", { exact: true })).not.toBeVisible();
    await summary.click();
    await expect.element(page.getByText("先准备这些", { exact: true })).toBeVisible();
    await expect.element(page.getByText("制作要求可以这样写", { exact: true })).toBeVisible();
    expect(element(".workflow-guide__content ol").children).toHaveLength(3);
    expect(element(".workflow-guide blockquote").textContent?.trim().length).toBeGreaterThan(20);

    const field = page.getByRole("textbox", { name: "制作要求", exact: true });
    await expect.element(field).toHaveAccessibleName("制作要求");
    await expect.element(field).toHaveAttribute("aria-required", "true");
    await expect.element(field).toHaveAccessibleDescription(/已有资料可以添加到参考素材中/);
    await expect.element(field).toHaveAccessibleDescription(/写清主题、受众和希望对方学会什么/);

    const columns = document.querySelectorAll<HTMLElement>(".workflow-guide__content > div");
    expect(columns).toHaveLength(2);
    const firstWide = columns[0]!.getBoundingClientRect();
    const secondWide = columns[1]!.getBoundingClientRect();
    expect(firstWide.top).toBeCloseTo(secondWide.top, 0);
    expect(firstWide.right).toBeLessThanOrEqual(secondWide.left);
    assertContainedLayout();

    await summary.click();
    await expect.element(page.getByText("先准备这些", { exact: true })).not.toBeVisible();
    await page.viewport(480, 1100);
    (summary.element() as HTMLElement).focus();
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByText("先准备这些", { exact: true })).toBeVisible();

    const firstNarrow = columns[0]!.getBoundingClientRect();
    const secondNarrow = columns[1]!.getBoundingClientRect();
    expect(secondNarrow.left).toBeCloseTo(firstNarrow.left, 0);
    expect(secondNarrow.top).toBeGreaterThanOrEqual(firstNarrow.bottom);
    assertContainedLayout();
    await expect.element(field).toHaveAccessibleName("制作要求");
    await expect.element(field).toHaveAccessibleDescription(/写清主题、受众和希望对方学会什么/);
  });

  it("keeps real reelbench checkbox help below its caption and all settings inside wide and narrow nodes", async () => {
    await page.viewport(480, 1100);
    await render(
      <div className="react-flow__node">
        <div className="canvas-flow-node">
          <article className="canvas-knowledge-workflow" data-testid="reelbench-workflow">
            <header className="canvas-knowledge-workflow__header">视频拉片与分镜合成</header>
            <div className="canvas-knowledge-workflow__body">
              <ReelbenchConfiguration
                options={createReelbenchOptions()}
                brief=""
                disabled={false}
                onChange={vi.fn()}
                onBriefChange={vi.fn()}
              />
            </div>
          </article>
        </div>
      </div>,
    );

    const checkbox = page.getByRole("checkbox", {
      name: "同时导出画面与镜头信息同步的视频",
      exact: true,
    });
    await expect.element(checkbox).toHaveAccessibleName("同时导出画面与镜头信息同步的视频");
    await expect.element(checkbox).toHaveAccessibleDescription(/勾选后额外在本机生成/);
    await expect.element(checkbox).not.toBeChecked();

    for (const width of [480, 1200]) {
      await page.viewport(width, 1100);
      const node = element('[data-testid="reelbench-workflow"]');
      const nodeBounds = node.getBoundingClientRect();
      expect(nodeBounds.right).toBeLessThanOrEqual(window.innerWidth + 1);
      for (const container of node.querySelectorAll<HTMLElement>(
        ".canvas-knowledge-workflow__body, .reelbench__configuration, .reelbench__settings, label",
      )) {
        expect(container.scrollWidth).toBeLessThanOrEqual(container.clientWidth + 1);
      }
      for (const control of node.querySelectorAll<HTMLElement>(
        "input, select, textarea, button, .workflow-field-help",
      )) {
        const bounds = control.getBoundingClientRect();
        expect(bounds.left).toBeGreaterThanOrEqual(nodeBounds.left - 1);
        expect(bounds.right).toBeLessThanOrEqual(nodeBounds.right + 1);
      }

      const row = element(".reelbench__checkbox");
      const helpBounds = element(
        ".reelbench__checkbox .workflow-field-help",
      ).getBoundingClientRect();
      const caption = Array.from(row.childNodes).find(
        (child) => child.nodeType === Node.TEXT_NODE && child.textContent?.trim(),
      );
      expect(caption).toBeDefined();
      const captionRange = document.createRange();
      captionRange.selectNodeContents(caption!);
      expect(helpBounds.top).toBeGreaterThanOrEqual(captionRange.getBoundingClientRect().bottom);
      expect(helpBounds.top).toBeGreaterThanOrEqual(
        checkbox.element().getBoundingClientRect().bottom,
      );
      expect(helpBounds.width).toBeCloseTo(row.clientWidth, 0);
    }
  });
});
