import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SearchableMultiSelect } from "./SearchableMultiSelect";

const OPTIONS = [
  { value: "alpha", label: "阿尔法" },
  { value: "beta", label: "贝塔" },
] as const;

describe("可搜索多选", () => {
  it("展开按钮与 chip 移除按钮互不嵌套，移除时不会连带开关下拉", () => {
    const onChange = vi.fn();
    render(
      <SearchableMultiSelect
        options={OPTIONS}
        value={["alpha"]}
        onChange={onChange}
        ariaLabel="选择令牌分组"
      />,
    );

    const toggle = screen.getByRole("button", { name: "选择令牌分组" });
    const remove = screen.getByRole("button", { name: "移除 阿尔法" });

    expect(remove.parentElement?.closest("button")).toBeNull();
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(remove);
    expect(onChange).toHaveBeenCalledWith([]);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });
});
