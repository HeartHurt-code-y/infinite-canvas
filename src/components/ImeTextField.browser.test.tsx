import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { describe, expect, it } from "vitest";

import { ImeTextarea } from "./ImeTextField";
import "../App.css";

/*
 * 自适应高度是布局行为：jsdom 没有 layout 引擎，量不出 scrollHeight，
 * 所以放在 browser 项目里用真实排版验证。
 *
 * 回归背景：提示词与工作流手输框曾被写死几行高度（提示词富文本框甚至只有
 * 92px），长内容只能在一条小缝里滚动。自适应的目标是——输入即长高、删除即
 * 收回、超过上限才内部滚动，且上限来自 CSS max-height（缺省兜底 384px）。
 */
describe("ImeTextarea auto resize in a real browser", () => {
  it("grows with content and clamps at the CSS max-height", async () => {
    const { container } = await render(
      <div style={{ width: 320 }}>
        <ImeTextarea
          aria-label="自适应输入框"
          rows={2}
          style={{ maxHeight: 160 }}
          value=""
          onValueChange={() => {}}
        />
      </div>,
    );
    const textarea = container.querySelector("textarea")!;
    const emptyHeight = textarea.getBoundingClientRect().height;
    // 空态保持 rows 驱动的高度，不塌成一行。
    expect(emptyHeight).toBeGreaterThan(30);

    const input = page.getByLabelText("自适应输入框");
    const longText = Array.from({ length: 40 }, (_, index) => `第${index}行提示词`).join("\n");
    await input.fill(longText);
    await expect
      .poll(() => textarea.getBoundingClientRect().height, { timeout: 2000 })
      .toBeGreaterThan(emptyHeight * 2);

    // 上限契约：封顶值来自 CSS max-height（内联样式即代表调用方的 CSS）。
    expect(Number.parseFloat(getComputedStyle(textarea).maxHeight)).toBe(160);
    await expect
      .poll(() => textarea.getBoundingClientRect().height, { timeout: 2000 })
      .toBeLessThanOrEqual(161);
    expect(textarea.scrollHeight).toBeGreaterThanOrEqual(textarea.clientHeight);
  });

  it("shrinks back when the content is removed", async () => {
    const { container } = await render(
      <div style={{ width: 320 }}>
        <ImeTextarea aria-label="可收缩输入框" rows={2} value="" onValueChange={() => {}} />
      </div>,
    );
    const textarea = container.querySelector("textarea")!;
    const emptyHeight = textarea.getBoundingClientRect().height;
    const input = page.getByLabelText("可收缩输入框");
    await input.fill("一行\n两行\n三行\n四行\n五行\n六行\n七行\n八行");
    await expect
      .poll(() => textarea.getBoundingClientRect().height, { timeout: 2000 })
      .toBeGreaterThan(emptyHeight * 1.5);
    await input.fill("");
    await expect
      .poll(() => textarea.getBoundingClientRect().height, { timeout: 2000 })
      .toBeLessThan(emptyHeight * 1.3);
  });

  it("keeps a fixed height when auto resize is off", async () => {
    const { container } = await render(
      <div style={{ width: 320 }}>
        <ImeTextarea
          aria-label="固定输入框"
          rows={3}
          autoResize={false}
          value=""
          onValueChange={() => {}}
        />
      </div>,
    );
    const textarea = container.querySelector("textarea")!;
    const height = textarea.getBoundingClientRect().height;
    await page
      .getByLabelText("固定输入框")
      .fill(Array.from({ length: 20 }, (_, index) => `第${index}行`).join("\n"));
    await expect
      .poll(() => textarea.getBoundingClientRect().height, { timeout: 2000 })
      .toBeCloseTo(height, 0);
  });
});

/*
 * 提示词富文本框（.prompt-mention__input）的回归：它曾被 max-height: 92px
 * 锁成一条小缝。这里验证 CSS 上限已经放宽到可读高度，contentEditable 在
 * 上限内自由生长、不出现内部滚动。
 */
describe("prompt rich input height budget", () => {
  it("allows the editor to grow well beyond the old 92px cap", async () => {
    const { container } = await render(
      <div style={{ width: 480 }}>
        <div className="prompt-mention__input" contentEditable suppressContentEditableWarning>
          {Array.from({ length: 12 }, (_, index) => `第${index}行画面描述`).join("\n")}
        </div>
      </div>,
    );
    const editor = container.querySelector<HTMLElement>(".prompt-mention__input")!;
    const maxHeight = Number.parseFloat(getComputedStyle(editor).maxHeight);
    expect(maxHeight).toBeGreaterThan(200);
    expect(editor.getBoundingClientRect().height).toBeLessThanOrEqual(maxHeight + 1);
  });
});
