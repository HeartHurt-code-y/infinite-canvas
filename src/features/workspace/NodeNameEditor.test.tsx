import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NodeNameEditor } from "./NodeNameEditor";

describe("node name editor", () => {
  it("does not drag the canvas or submit Chinese composition and saves with Enter", async () => {
    const save = vi.fn();
    const drag = vi.fn();
    const keyboard = vi.fn();
    render(
      <div onMouseDown={drag} onKeyDown={keyboard}>
        <NodeNameEditor name="旧镜头" label="修改产物名称" onSave={save} />
      </div>,
    );
    const trigger = screen.getByRole("button", { name: "修改产物名称" });
    fireEvent.mouseDown(trigger);
    fireEvent.click(trigger);
    const input = screen.getByRole("textbox", { name: "修改产物名称" });
    fireEvent.change(input, { target: { value: "  第01集_镜头003  " } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(save).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(save).toHaveBeenCalledExactlyOnceWith("第01集_镜头003"));
    expect(drag).not.toHaveBeenCalled();
    expect(keyboard).not.toHaveBeenCalled();
  });
  it("keeps the old name on validation or persistence failure and allows cancellation", async () => {
    const save = vi.fn().mockRejectedValue(new Error("保存失败"));
    render(<NodeNameEditor name="旧镜头" label="修改产物名称" onSave={save} />);
    fireEvent.click(screen.getByRole("button", { name: "修改产物名称" }));
    const input = screen.getByRole("textbox", { name: "修改产物名称" });
    fireEvent.change(input, { target: { value: "../镜头" } });
    fireEvent.click(screen.getByRole("button", { name: "保存名称" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("名称不能包含");
    expect(save).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "新镜头" } });
    fireEvent.click(screen.getByRole("button", { name: "保存名称" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("保存失败"));
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
});
