import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { CanvasTabs, type CanvasTabsProps } from "./CanvasTabs";

const canvases = [
  { id: "first", name: "产品摄影" },
  { id: "second", name: "故事分镜" },
  { id: "third", name: "灵感收集" },
];

function Harness(props: Partial<CanvasTabsProps>) {
  const [activeCanvasId, setActiveCanvasId] = useState("first");
  return (
    <CanvasTabs
      canvases={canvases}
      activeCanvasId={activeCanvasId}
      onSelect={setActiveCanvasId}
      onCreate={vi.fn()}
      onRename={vi.fn()}
      {...props}
    />
  );
}

describe("CanvasTabs", () => {
  it("switches between named canvases and provides a separate create action", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<Harness onCreate={onCreate} />);
    expect(screen.getByRole("tablist", { name: "创作画布" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "产品摄影" })).toHaveAttribute("aria-selected", "true");

    await user.click(screen.getByRole("tab", { name: "故事分镜" }));
    expect(screen.getByRole("tab", { name: "故事分镜" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "产品摄影" })).toHaveAttribute("aria-selected", "false");

    await user.click(screen.getByRole("button", { name: "新建画布" }));
    expect(onCreate).toHaveBeenCalledOnce();
  });

  it("supports keyboard tab navigation, wrapping, Home and End", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.tab();
    expect(screen.getByRole("tab", { name: "产品摄影" })).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "故事分镜" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "故事分镜" })).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{End}");
    expect(screen.getByRole("tab", { name: "灵感收集" })).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "产品摄影" })).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("tab", { name: "灵感收集" })).toHaveFocus();
    await user.keyboard("{Home}");
    expect(screen.getByRole("tab", { name: "产品摄影" })).toHaveFocus();
  });

  it("renames through the visible action, trims input and returns keyboard focus", async () => {
    const user = userEvent.setup();
    const onRename = vi.fn();
    render(<Harness onRename={onRename} />);
    await user.click(screen.getByRole("button", { name: "重命名画布 产品摄影" }));
    const input = screen.getByRole("textbox", { name: "画布名称" });
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: "  夏季商品  " } });
    await user.keyboard("{Enter}");
    expect(onRename).toHaveBeenCalledExactlyOnceWith("first", "夏季商品");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "产品摄影" })).toHaveFocus();
  });

  it("supports double-click and blur save, while rejecting empty names and Escape", async () => {
    const user = userEvent.setup();
    const onRename = vi.fn();
    render(<Harness onRename={onRename} />);
    await user.dblClick(screen.getByRole("tab", { name: "产品摄影" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "新的场景" } });
    await user.click(screen.getByRole("tab", { name: "故事分镜" }));
    expect(onRename).toHaveBeenCalledExactlyOnceWith("first", "新的场景");

    await user.dblClick(screen.getByRole("tab", { name: "故事分镜" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "   " } });
    await user.keyboard("{Enter}");
    expect(onRename).toHaveBeenCalledOnce();

    await user.dblClick(screen.getByRole("tab", { name: "故事分镜" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "未保存名称" } });
    await user.keyboard("{Escape}");
    expect(onRename).toHaveBeenCalledOnce();
    expect(screen.getByRole("tab", { name: "故事分镜" })).toHaveFocus();
  });

  it("does not commit Chinese input when Enter confirms an IME composition", () => {
    const onRename = vi.fn();
    render(<Harness onRename={onRename} />);
    fireEvent.doubleClick(screen.getByRole("tab", { name: "产品摄影" }));
    const input = screen.getByRole("textbox");
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: "中文场景" } });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229, isComposing: true });
    expect(onRename).not.toHaveBeenCalled();
    expect(input).toHaveFocus();
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRename).toHaveBeenCalledExactlyOnceWith("first", "中文场景");
  });

  it("disables actions while canvas state is being restored", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    const onSelect = vi.fn();
    render(<Harness busy onCreate={onCreate} onSelect={onSelect} />);
    expect(screen.getByRole("button", { name: "新建画布" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "重命名画布 产品摄影" })).toBeDisabled();
    await user.click(screen.getByRole("tab", { name: "故事分镜" }));
    await user.click(screen.getByRole("button", { name: "新建画布" }));
    expect(onSelect).not.toHaveBeenCalled();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("retains tab focus through a busy cycle and resumes keyboard switching afterward", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const { rerender } = render(<Harness />);
    await user.tab();
    await user.keyboard("{ArrowRight}");
    const second = screen.getByRole("tab", { name: "故事分镜" });
    expect(second).toHaveFocus();

    rerender(<Harness busy onSelect={onSelect} />);
    expect(second).toHaveAttribute("aria-disabled", "true");
    expect(second).toBeEnabled();
    expect(second).toHaveFocus();
    await user.keyboard("{ArrowRight}{Enter}{F2}");
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(second).toHaveFocus();

    rerender(<Harness />);
    expect(second).toHaveAttribute("aria-disabled", "false");
    expect(second).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "灵感收集" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "灵感收集" })).toHaveAttribute("aria-selected", "true");
  });
});
