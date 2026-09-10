// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dialogCss = readFileSync(new URL("./VideoLocalEditDialog.css", import.meta.url), "utf8");

function cssRule(selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = dialogCss.match(new RegExp(`${escapedSelector}\\s*\\{([^}]+)\\}`));
  expect(match, `Missing CSS rule for ${selector}`).not.toBeNull();
  return match?.[1] ?? "";
}

describe("视频局部编辑弹窗的样式作用域", () => {
  it("嵌入的 @ 引用编辑器显式声明 paper 墨色，不继承弹窗的浅色 chrome 墨色", () => {
    // 编辑面与候选菜单是浅色 paper 底，而 `.prompt-mention__input` / `__option`
    // 只继承祖先 color；不显式改回 paper 墨色，正文与候选名会完全看不见。
    expect(cssRule(".video-local-edit-dialog__reference-editor")).toMatch(
      /color:\s*var\(--color-ink\)/,
    );
    // 弹窗自身的浅色墨色保持不变：修的是作用域，不是整体换色。
    expect(cssRule(".video-local-edit-dialog")).toMatch(/color:\s*var\(--color-chrome-ink\)/);
  });

  it("弹窗按钮皮肤按容器限定，不覆盖共享编辑器的 @ 触发按钮与候选行", () => {
    // 广域 `.video-local-edit-dialog button` 的 specificity 会压过 `.prompt-mention__*`，
    // 把 @ 触发按钮和候选行改成弹窗的深色胶囊。
    expect(dialogCss).not.toMatch(/\.video-local-edit-dialog\s+button\s*\{/);
    for (const container of [
      "header",
      "timeline",
      "toolbar",
      "operation",
      "keyboard-region",
      "footer",
    ]) {
      expect(dialogCss).toContain(`.video-local-edit-dialog__${container} button`);
    }
    expect(dialogCss).toContain(".video-local-edit-dialog__body > button");
  });

  it("fieldset[disabled] 在提交期间冻结 contenteditable 编辑要求", () => {
    expect(
      cssRule(
        ".video-local-edit-dialog fieldset:disabled .video-local-edit-dialog__reference-editor",
      ),
    ).toMatch(/pointer-events:\s*none/);
  });
});
