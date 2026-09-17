import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { ConnectionQuickAddMenu, type ConnectionQuickAddMenuProps } from "./ConnectionQuickAddMenu";

function Harness({ onSelect }: Pick<ConnectionQuickAddMenuProps, "onSelect">) {
  const [open, setOpen] = useState(false);
  const [triggerElement, setTriggerElement] = useState<HTMLButtonElement | null>(null);
  return (
    <>
      <button ref={setTriggerElement} type="button" onClick={() => setOpen((current) => !current)}>
        <span>打开添加节点菜单</span>
      </button>
      <button type="button">画布后续操作</button>
      {open ? (
        <ConnectionQuickAddMenu
          position={{ x: 100, y: 100 }}
          triggerElement={triggerElement}
          onSelect={onSelect}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

describe("ConnectionQuickAddMenu", () => {
  it("toggles from the trigger without reopening and still dismisses on outside clicks", async () => {
    const user = userEvent.setup();
    render(<Harness onSelect={vi.fn()} />);
    const triggerLabel = screen.getByText("打开添加节点菜单");
    await user.click(triggerLabel);
    expect(screen.getByRole("menu", { name: "添加节点" })).toBeInTheDocument();
    await user.click(triggerLabel);
    expect(screen.queryByRole("menu", { name: "添加节点" })).not.toBeInTheDocument();
    await user.click(triggerLabel);
    expect(screen.getByRole("menu", { name: "添加节点" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "画布后续操作" }));
    expect(screen.queryByRole("menu", { name: "添加节点" })).not.toBeInTheDocument();
  });

  it("offers upload plus all nine node templates for creation in both menu modes", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const props = { position: { x: 100, y: 100 }, onSelect, onClose: vi.fn() };
    const { rerender } = render(<ConnectionQuickAddMenu {...props} />);
    const expectedChoices = [
      ["上传素材", "asset_upload"],
      ["图片生成", "image"],
      ["视频生成", "video"],
      ["视频拼接与合成", "video_composer"],
      ["网络爆款视频下载", "video_downloader"],
      ["视频抽帧", "frame_extractor"],
      ["爆款视频复刻", "viral_remix"],
      ["提示词生成与优化", "prompt"],
      ["剧本创作与优化", "screenplay"],
      ["剧本转工业级分镜脚本", "storyboard"],
    ] as const;

    expect(screen.getByRole("menu", { name: "添加节点" })).toHaveAccessibleDescription(
      "选择后在画布创建节点",
    );
    expect(screen.getAllByRole("menuitem")).toHaveLength(expectedChoices.length);

    rerender(<ConnectionQuickAddMenu {...props} connectionMode />);
    expect(screen.getByRole("menu", { name: "添加节点" })).toHaveAccessibleDescription(
      "选择后创建并自动连线",
    );
    for (const [label, kind] of expectedChoices) {
      const item = screen.getByRole("menuitem", { name: label });
      expect(item).toBeEnabled();
      await user.click(item);
      expect(onSelect).toHaveBeenLastCalledWith(kind);
    }
    expect(onSelect).toHaveBeenCalledTimes(expectedChoices.length);
  });

  it("reaches every end of the expanded menu with arrow, Home and End keys", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    await user.click(screen.getByRole("button", { name: "打开添加节点菜单" }));
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("menuitem", { name: "剧本转工业级分镜脚本" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "上传素材" })).toHaveFocus();
    await user.keyboard("{End}");
    expect(screen.getByRole("menuitem", { name: "剧本转工业级分镜脚本" })).toHaveFocus();
    await user.keyboard("{Home}{ArrowDown}{ArrowDown}{Enter}");
    expect(onSelect).toHaveBeenCalledWith("video");
  });

  it("keeps focus outside the menu when Shift+Tab follows arrow navigation", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    await user.click(screen.getByRole("button", { name: "打开添加节点菜单" }));
    expect(screen.getByRole("menuitem", { name: "上传素材" })).toHaveFocus();

    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "图片生成" })).toHaveFocus();
    await user.tab({ shift: true });

    await waitFor(() => {
      expect(screen.queryByRole("menu", { name: "添加节点" })).not.toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "画布后续操作" })).toHaveFocus();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("restores the previous focus on Escape without creating a node", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    const opener = screen.getByRole("button", { name: "打开添加节点菜单" });
    await user.click(opener);
    await user.keyboard("{ArrowDown}{Escape}");

    expect(screen.queryByRole("menu", { name: "添加节点" })).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
