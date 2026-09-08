import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { CanvasDeleteDialog } from "./CanvasDeleteDialog";

describe("CanvasDeleteDialog", () => {
  it("names the canvas, explains the removal scope and initially focuses cancel", () => {
    render(
      <CanvasDeleteDialog
        canvasName="夏季产品摄影"
        busy={false}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByRole("dialog", { name: "删除画布？" })).toHaveAccessibleDescription(
      "将删除画布“夏季产品摄影”，以及其中的所有节点、连线和提示内容。此操作无法撤销。 已保存的媒体文件和任务历史会保留。",
    );
    expect(screen.getByRole("button", { name: "取消" })).toHaveFocus();
  });

  it("keeps keyboard focus in the dialog and Escape only requests cancellation", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onConfirm = vi.fn();
    const hotkey = vi.fn();
    render(
      <div onKeyDown={hotkey}>
        <CanvasDeleteDialog
          canvasName="画布 1"
          busy={false}
          onClose={onClose}
          onConfirm={onConfirm}
        />
      </div>,
    );
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "确认删除" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "取消" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "确认删除" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(hotkey).not.toHaveBeenCalled();
  });

  it("cancel restores focus to the delete trigger without confirming", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>删除画布 产品摄影</button>
          {open && (
            <CanvasDeleteDialog
              canvasName="产品摄影"
              busy={false}
              onClose={() => setOpen(false)}
              onConfirm={onConfirm}
            />
          )}
        </>
      );
    }
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "删除画布 产品摄影" }));
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "删除画布 产品摄影" })).toHaveFocus();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("blocks repeated confirmation and cancellation while deleting, then allows retry after error", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onConfirm = vi.fn();
    const props = { canvasName: "产品摄影", onClose, onConfirm };
    const { rerender } = render(<CanvasDeleteDialog {...props} busy={false} />);
    await user.click(screen.getByRole("button", { name: "确认删除" }));
    expect(onConfirm).toHaveBeenCalledOnce();

    rerender(<CanvasDeleteDialog {...props} busy />);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveFocus();
    expect(screen.getByRole("button", { name: "正在删除…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "正在删除…" }));
    await user.click(screen.getByRole("button", { name: "取消" }));
    await user.keyboard("{Escape}{Tab}{Enter}");
    fireEvent(dialog, new Event("cancel", { cancelable: true, bubbles: true }));
    expect(onClose).not.toHaveBeenCalled();
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(dialog).toHaveFocus();

    rerender(<CanvasDeleteDialog {...props} busy={false} error="画布删除失败，请重试。" />);
    expect(screen.getByRole("alert")).toHaveTextContent("画布删除失败，请重试。");
    expect(screen.getByRole("button", { name: "取消" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "确认删除" }));
    expect(onConfirm).toHaveBeenCalledTimes(2);
  });

  it("handles the native dialog cancel event without deleting", () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn();
    render(
      <CanvasDeleteDialog
        canvasName="画布 1"
        busy={false}
        onClose={onClose}
        onConfirm={onConfirm}
      />,
    );
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true, bubbles: true }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
