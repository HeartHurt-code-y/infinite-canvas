import { page } from "vitest/browser";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { ConnectionQuickAddMenu } from "./ConnectionQuickAddMenu";
import "./ConnectionQuickAddMenu.css";

describe("ConnectionQuickAddMenu（真实视口）", () => {
  it("把菜单钳在视口内，不会落到屏幕外", async () => {
    await page.viewport(480, 320);
    await render(
      <ConnectionQuickAddMenu
        position={{ x: 10_000, y: 10_000 }}
        onSelect={() => undefined}
        onClose={() => undefined}
      />,
    );

    const menu = page.getByRole("menu", { name: "添加节点" });
    await expect.element(menu).toBeVisible();

    const box = menu.element().getBoundingClientRect();
    expect(box.left).toBeGreaterThanOrEqual(8);
    expect(box.top).toBeGreaterThanOrEqual(8);
    expect(box.right).toBeLessThanOrEqual(window.innerWidth - 7.5);
    expect(box.bottom).toBeLessThanOrEqual(window.innerHeight - 7.5);
  });
});
