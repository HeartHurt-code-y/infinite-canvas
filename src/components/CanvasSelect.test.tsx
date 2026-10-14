import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { CanvasSelect } from "./CanvasSelect";

function Harness({
  options,
  initial,
  onChange,
  disabled = false,
}: {
  readonly options: readonly { value: string; label: string }[];
  readonly initial: string;
  readonly onChange?: (value: string) => void;
  readonly disabled?: boolean;
}) {
  const [value, setValue] = useState(initial);
  return (
    <CanvasSelect
      ariaLabel="测试下拉"
      value={value}
      options={options}
      disabled={disabled}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
    />
  );
}

const SIZES = [
  { value: "1:1", label: "1:1 · 2048 × 2048" },
  { value: "3:4", label: "3:4 · 1536 × 2048" },
  { value: "9:16", label: "9:16 · 1152 × 2048" },
];

describe("CanvasSelect", () => {
  it("opens the menu, commits the picked option and shows the new value", () => {
    const onChange = vi.fn();
    render(<Harness options={SIZES} initial="3:4" onChange={onChange} />);
    const trigger = screen.getByRole("combobox", { name: "测试下拉" });
    expect(trigger).toHaveTextContent("3:4 · 1536 × 2048");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const listbox = screen.getByRole("listbox", { name: "测试下拉" });
    expect(listbox).toHaveAttribute("aria-activedescendant");
    // 当前值高亮为已选中
    expect(screen.getByRole("option", { name: "3:4 · 1536 × 2048" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    fireEvent.click(screen.getByRole("option", { name: "9:16 · 1152 × 2048" }));
    expect(onChange).toHaveBeenCalledWith("9:16");
    // 选中后菜单关闭、焦点回到触发按钮
    expect(screen.queryByRole("listbox", { name: "测试下拉" })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "测试下拉" })).toHaveTextContent(
      "9:16 · 1152 × 2048",
    );
  });

  it("picks the active option with keyboard and closes on Escape without committing", () => {
    const onChange = vi.fn();
    render(<Harness options={SIZES} initial="1:1" onChange={onChange} />);
    const trigger = screen.getByRole("combobox", { name: "测试下拉" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("listbox", { name: "测试下拉" }), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("listbox", { name: "测试下拉" }), { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("3:4");

    fireEvent.keyDown(trigger, { key: "ArrowUp" });
    fireEvent.keyDown(screen.getByRole("listbox", { name: "测试下拉" }), { key: "Escape" });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("listbox", { name: "测试下拉" })).not.toBeInTheDocument();
  });

  it("closes when clicking outside and ignores picking the same value", () => {
    const onChange = vi.fn();
    render(
      <div>
        <button type="button">外部按钮</button>
        <Harness options={SIZES} initial="1:1" onChange={onChange} />
      </div>,
    );
    fireEvent.click(screen.getByRole("combobox", { name: "测试下拉" }));
    // portal 菜单挂在 body；点击菜单外（外部按钮）触发关闭
    fireEvent.mouseDown(screen.getByRole("button", { name: "外部按钮" }));
    expect(screen.queryByRole("listbox", { name: "测试下拉" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("combobox", { name: "测试下拉" }));
    fireEvent.click(screen.getByRole("option", { name: "1:1 · 2048 × 2048" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not open when disabled", () => {
    render(<Harness options={SIZES} initial="1:1" disabled />);
    expect(screen.getByRole("combobox", { name: "测试下拉" })).toBeDisabled();
    fireEvent.click(screen.getByRole("combobox", { name: "测试下拉" }));
    expect(screen.queryByRole("listbox", { name: "测试下拉" })).not.toBeInTheDocument();
  });

  it("shows an empty hint when there are no options", () => {
    render(<Harness options={[]} initial="" />);
    fireEvent.click(screen.getByRole("combobox", { name: "测试下拉" }));
    expect(screen.getByText("没有可选项")).toBeInTheDocument();
  });
});
