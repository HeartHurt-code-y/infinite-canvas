import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { SearchableMultiSelect } from "./SearchableMultiSelect";
import "./SearchableMultiSelect.css";

const OPTIONS = [
  { value: "alpha", label: "阿尔法" },
  { value: "beta", label: "贝塔" },
] as const;

describe("可搜索多选（真实叠层）", () => {
  it("chip 移除按钮叠在展开按钮之上，点击不会打开下拉", async () => {
    const onChange = vi.fn();
    await render(
      <SearchableMultiSelect
        options={OPTIONS}
        value={["alpha"]}
        onChange={onChange}
        ariaLabel="选择令牌分组"
      />,
    );

    const toggle = page.getByRole("button", { name: "选择令牌分组" });
    const remove = page.getByRole("button", { name: "移除 阿尔法" });
    await expect.element(toggle).toBeVisible();
    expect(remove.element().parentElement?.closest("button")).toBeNull();

    await remove.click();
    expect(onChange).toHaveBeenCalledWith([]);
    await expect.poll(() => page.getByRole("listbox").query()).toBeNull();
  });
});
