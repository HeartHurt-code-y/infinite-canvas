import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { ConnectionQuickAddMenu, type ConnectionQuickAddMenuProps } from "./ConnectionQuickAddMenu";

function Harness({ onSelect }: Pick<ConnectionQuickAddMenuProps, "onSelect">) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        打开常用生成节点
      </button>
      <button type="button">画布后续操作</button>
      {open ? (
        <ConnectionQuickAddMenu
          position={{ x: 100, y: 100 }}
          onSelect={onSelect}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

describe("ConnectionQuickAddMenu", () => {
  it("keeps focus outside the menu when Shift+Tab follows arrow navigation", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    await user.click(screen.getByRole("button", { name: "打开常用生成节点" }));
    expect(screen.getByRole("menuitem", { name: "图片生成" })).toHaveFocus();

    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "视频生成" })).toHaveFocus();
    await user.tab({ shift: true });

    await waitFor(() => {
      expect(screen.queryByRole("menu", { name: "常用生成节点" })).not.toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "画布后续操作" })).toHaveFocus();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("restores the previous focus on Escape without creating a node", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    const opener = screen.getByRole("button", { name: "打开常用生成节点" });
    await user.click(opener);
    await user.keyboard("{ArrowDown}{Escape}");

    expect(screen.queryByRole("menu", { name: "常用生成节点" })).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
