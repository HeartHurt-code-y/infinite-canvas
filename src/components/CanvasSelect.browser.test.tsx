import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import { describe, expect, it } from "vitest";
import { useState } from "react";

import { CanvasSelect } from "./CanvasSelect";

/*
 * CanvasSelect 是为画布节点准备的自绘下拉，交互必须过真实浏览器：
 * 这里验证点击展开、点选生效与键盘操作（jsdom 单测已覆盖状态逻辑）。
 * 组件是受控的，包装一个有状态的 Harness 才能反映选中结果。
 */
const OPTIONS = [
  { value: "a", label: "甲方案" },
  { value: "b", label: "乙方案" },
];

function Harness({ ariaLabel }: { readonly ariaLabel: string }) {
  const [value, setValue] = useState("a");
  return <CanvasSelect ariaLabel={ariaLabel} value={value} options={OPTIONS} onChange={setValue} />;
}

describe("CanvasSelect in a real browser", () => {
  it("opens on click, picks an option and reflects the new value", async () => {
    const { container } = await render(<Harness ariaLabel="真实浏览器下拉" />);
    const trigger = container.querySelector<HTMLButtonElement>(".canvas-select")!;
    expect(trigger).toHaveTextContent("甲方案");
    await page.getByRole("combobox", { name: "真实浏览器下拉" }).click();
    expect(container.ownerDocument.querySelector(".canvas-select__menu")).not.toBeNull();
    await page.getByRole("option", { name: "乙方案" }).click();
    await expect.poll(() => trigger.textContent, { timeout: 2000 }).toBe("乙方案");
    expect(container.ownerDocument.querySelector(".canvas-select__menu")).toBeNull();
  });

  it("supports keyboard: open with ArrowDown, commit with Enter", async () => {
    const { container } = await render(<Harness ariaLabel="键盘下拉" />);
    await page.getByRole("combobox", { name: "键盘下拉" }).click();
    // 展开后焦点在 listbox 上，键盘事件直接进菜单
    await userEvent.keyboard("{ArrowDown}");
    await userEvent.keyboard("{Enter}");
    await expect
      .poll(() => container.querySelector(".canvas-select")?.textContent, { timeout: 2000 })
      .toBe("乙方案");
  });
});
