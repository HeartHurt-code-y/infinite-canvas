import { page, userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { GenerationInputChips } from "./MediaNodeViews";
import "../../App.css";

describe("生成参考素材排序（真实浏览器）", () => {
  it("拖动素材行改变顺序，不启动外层节点拖动", async () => {
    const onReorder = vi.fn();
    const onNodeMouseDown = vi.fn();
    const onNodePointerDown = vi.fn();
    const inputs = ["a", "b", "c"].map((name) => ({
      key: `asset-${name}`,
      name: name.toUpperCase(),
      kind: "image" as const,
      edgeId: `asset-${name}->gen`,
      sourceLabel: "素材" as const,
      previewUrl: null,
    }));
    await render(
      <div onMouseDown={onNodeMouseDown} onPointerDown={onNodePointerDown}>
        <GenerationInputChips inputs={inputs} onUnlink={() => undefined} onReorder={onReorder} />
      </div>,
    );

    const rows = page
      .getByRole("list", { name: "生成参考素材，按传入顺序排列" })
      .element()
      .querySelectorAll("li");
    expect(rows).toHaveLength(3);
    await userEvent.dragAndDrop(rows[2]!, rows[0]!);
    expect(onReorder).toHaveBeenCalledWith("asset-c", "asset-a");
    expect(onNodeMouseDown).not.toHaveBeenCalled();
    expect(onNodePointerDown).not.toHaveBeenCalled();
  });
});
