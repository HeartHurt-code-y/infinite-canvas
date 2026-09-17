import { render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it } from "vitest";

import { PromptFloatingMenu } from "./promptFloatingMenu";

describe("PromptFloatingMenu", () => {
  it("把菜单挂到 document.body，并按锚点放到视口内", () => {
    const anchorRef = createRef<HTMLButtonElement>();
    render(
      <div>
        <button
          ref={anchorRef}
          type="button"
          style={{ position: "fixed", top: 80, left: 40, width: 240, height: 40 }}
        >
          锚点
        </button>
        <PromptFloatingMenu
          anchorRef={anchorRef}
          className="prompt-mention__menu prompt-mention__menu--floating"
          role="listbox"
          aria-label="素材引用候选"
        >
          角色.png
        </PromptFloatingMenu>
      </div>,
    );

    const menu = screen.getByRole("listbox", { name: "素材引用候选" });
    expect(menu.parentElement).toBe(document.body);
    expect(menu.style.position === "" || menu.style.top !== "").toBe(true);
    expect(Number.parseFloat(menu.style.top)).toBeGreaterThanOrEqual(0);
    expect(Number.parseFloat(menu.style.left)).toBeGreaterThanOrEqual(0);
  });
});
