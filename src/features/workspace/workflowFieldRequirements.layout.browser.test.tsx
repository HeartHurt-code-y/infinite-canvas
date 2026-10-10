import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { describe, expect, it } from "vitest";

import { RequiredMark } from "./workflowFieldRequirements";
import "./ProductSceneWorkflowSections.css";
import "../../App.css";
import "../../styles/studio.css";

/*
 * 回归用例：必填星号必须与标签文字**留在同一行**。
 *
 * 真实事故：星号与标签文字、「（必填）」曾各自成为标签容器的一个子元素，而
 * `.product-scene__configuration` 是 `display: grid`，网格把三者排成三行，工作流
 * 卡片被撑得明显变长。这类问题只有真实排版能量出来（jsdom 没有布局引擎），所以
 * 放在 browser 项目里；「（可选）」文字也已整体删除，卡片高度优先。
 */
describe("required star layout in a real browser", () => {
  it("keeps the star on the label row and adds no extra rows for optional fields", async () => {
    await render(
      <div data-testid="node" style={{ width: 420 }}>
        <fieldset className="product-scene__configuration">
          <label data-testid="required-field">
            <RequiredMark>产品名称</RequiredMark>
            <input aria-label="产品名称" defaultValue="珠宝商品" />
          </label>
          <label data-testid="optional-field">
            生成方式
            <select aria-label="生成方式" defaultValue="reference">
              <option value="reference">AI 多机位</option>
            </select>
          </label>
        </fieldset>
      </div>,
    );
    await expect.element(page.getByTestId("required-field")).toBeVisible();

    const field = document.querySelector<HTMLElement>('[data-testid="required-field"]')!;
    expect(getComputedStyle(field).display).toBe("grid");
    // 标签行只有一个子元素（RequiredMark 的包裹 span），下一行才是控件。
    expect(field.children.length).toBe(2);
    expect(Math.round(field.children[0]!.getBoundingClientRect().top)).toBeLessThan(
      Math.round(field.children[1]!.getBoundingClientRect().top),
    );

    const star = field.querySelector<HTMLElement>(".workflow-required-mark__asterisk")!;
    const starBox = star.getBoundingClientRect();
    const textBox = (star.parentElement as HTMLElement).getBoundingClientRect();
    const controlBox = field.querySelector<HTMLElement>("input")!.getBoundingClientRect();
    expect(starBox.width).toBeGreaterThan(0);
    // 同一行：星号整体落在标签文字的垂直范围内（粗体小字号，顶端有 1–2px 偏移）。
    expect(starBox.top).toBeGreaterThanOrEqual(textBox.top - 2);
    expect(starBox.bottom).toBeLessThanOrEqual(textBox.bottom + 2);
    // 整行排在控件之上 —— 若星号掉到单独一行，上面两个条件都不成立。
    expect(textBox.bottom).toBeLessThanOrEqual(controlBox.top);
    // 必填语义挂在控件上，而不是靠名字里多一个星号。
    expect(field.querySelector("input")).toHaveAttribute("aria-required", "true");

    // 选填项不带任何标记，也不多占一行：标签文字仍在上、控件在下。
    const optional = document.querySelector<HTMLElement>('[data-testid="optional-field"]')!;
    expect(optional.querySelector(".workflow-required-mark__asterisk")).toBeNull();
    expect(optional).not.toHaveTextContent("可选");
    const labelText = Array.from(optional.childNodes).find(
      (node) => node.nodeType === Node.TEXT_NODE,
    )!;
    const textRange = document.createRange();
    textRange.selectNodeContents(labelText);
    const selectBox = optional.querySelector("select")!.getBoundingClientRect();
    expect(textRange.getBoundingClientRect().bottom).toBeLessThanOrEqual(selectBox.top);
  });
});
