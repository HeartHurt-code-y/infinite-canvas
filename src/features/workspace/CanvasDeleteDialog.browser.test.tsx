import { page, userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { CanvasDeleteDialog } from "./CanvasDeleteDialog";
import "./CanvasDeleteDialog.css";

describe("CanvasDeleteDialog（原生 dialog）", () => {
  it("以 showModal 打开，Escape 只请求取消", async () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn();
    await render(
      <CanvasDeleteDialog
        canvasName="夏季产品摄影"
        busy={false}
        onClose={onClose}
        onConfirm={onConfirm}
      />,
    );

    const dialog = page.getByRole("dialog", { name: "删除画布？" });
    await expect.element(dialog).toBeVisible();
    expect(dialog.element()).toBeInstanceOf(HTMLDialogElement);
    expect((dialog.element() as HTMLDialogElement).open).toBe(true);

    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
