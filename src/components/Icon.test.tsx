import { render, screen } from "@testing-library/react";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import { Icon, isIconName, type IconSize } from "./Icon";

/*
 * 说明：尺寸断言检查的是 SVG 的 width/height 属性字符串，而不是 getComputedStyle
 * 的解析结果。jsdom 的 CSSOM 不解析 var()，计算值会恒为空；属性形式在浏览器里
 * 同样正确生效（scripts/audit-icons.mjs 在真实 Chromium 中核对过渲染尺寸），
 * 并且在测试与服务端渲染中都可见，因此以属性为准。
 *
 * 图标默认 aria-hidden="true"，会被 getByRole 从无障碍树里排除，
 * 因此统一用 testid 定位被测元素。
 */
describe("图标层", () => {
  it("把尺寸档位映射到 tokens.css 的 --icon-* 变量，而不是写死像素", () => {
    render(<Icon name="caret-down" size="md" data-testid="probe" />);
    expect(screen.getByTestId("probe")).toHaveAttribute("width", "var(--icon-md)");
    expect(screen.getByTestId("probe")).toHaveAttribute("height", "var(--icon-md)");
  });

  it("默认尺寸为 md", () => {
    render(<Icon name="plus" data-testid="probe" />);
    expect(screen.getByTestId("probe")).toHaveAttribute("width", "var(--icon-md)");
  });

  it("每个档位都绑定到各自的令牌，且不产生像素字面量", () => {
    const SIZES: readonly IconSize[] = ["2xs", "xs", "sm", "md", "lg", "xl", "2xl", "3xl"];
    for (const size of SIZES) {
      const view = render(<Icon name="x" size={size} data-testid="probe" />);
      expect(screen.getByTestId("probe"), `档位 ${size} 未绑定到 --icon-${size}`).toHaveAttribute(
        "width",
        `var(--icon-${size})`,
      );
      view.unmount();
    }
  });

  it("行内尺寸使用 regular 字重，展示级尺寸使用 bold", () => {
    /* 阈值 24px：小尺寸用细字重避免笔画糊在一起，展示级用粗字重保持分量。
     *
     * Phosphor 的字重是「换一套路径数据」，不会在 SVG 上留下 data-weight，
     * 因此用路径数据是否相同来判断字重是否真的生效。 */
    const pathOf = (size: IconSize) => {
      const view = render(<Icon name="x" size={size} data-testid="probe" />);
      const d = screen.getByTestId("probe").querySelector("path")?.getAttribute("d") ?? "";
      view.unmount();
      return d;
    };

    const inline = pathOf("sm");
    const display = pathOf("3xl");
    expect(inline).not.toBe("");
    expect(display).not.toBe("");
    /* 同一侧的档位必须落到同一字重 */
    expect(pathOf("sm")).toBe(inline);
    expect(pathOf("2xl")).toBe(display);
    /* 行内与展示级必须是不同字重 */
    expect(inline).not.toBe(display);
  });

  it("默认对屏幕阅读器隐藏装饰性图标", () => {
    render(<Icon name="check" data-testid="probe" />);
    expect(screen.getByTestId("probe")).toHaveAttribute("aria-hidden", "true");
  });

  it("明确要求可见时才进入无障碍树", () => {
    render(<Icon name="check" aria-hidden={false} data-testid="probe" />);
    expect(screen.getByTestId("probe")).toHaveAttribute("aria-hidden", "false");
  });

  it('把字符串 "true" 归一化为隐藏', () => {
    render(<Icon name="check" aria-hidden="true" data-testid="probe" />);
    expect(screen.getByTestId("probe")).toHaveAttribute("aria-hidden", "true");
  });

  it('把字符串 "false" 归一化为可见，而不是当成隐藏', () => {
    render(<Icon name="check" aria-hidden="false" data-testid="probe" />);
    expect(screen.getByTestId("probe")).toHaveAttribute("aria-hidden", "false");
  });

  it("不把键盘焦点停在装饰图标上", () => {
    render(<Icon name="play" data-testid="probe" />);
    expect(screen.getByTestId("probe")).toHaveAttribute("focusable", "false");
  });

  it("保留调用点传入的 className 与 data-spin（既有 CSS 选择器依赖它们）", () => {
    render(<Icon name="circle-notch" className="spin-icon" data-spin="true" data-testid="probe" />);
    expect(screen.getByTestId("probe")).toHaveClass("spin-icon", { exact: true });
    expect(screen.getByTestId("probe")).toHaveAttribute("data-spin", "true");
  });

  it("识别合法的图标名", () => {
    expect(isIconName("caret-down")).toBe(true);
    expect(isIconName("not-an-icon")).toBe(false);
  });
});

/* ── 仓库级不变量 ─────────────────────────────────────────────────────
 * 上一版的失败方式不是「某个图标画得不好」，而是 335 个调用点各自决定
 * 尺寸与字重、并放任 43 处漏掉字重。下面三条断言把这个决定权锁回图标层。
 */

function walkTsx(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkTsx(full, out);
    else if (entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

const SRC = join(process.cwd(), "src");
const ICON_MODULE = "src/components/Icon.tsx";

describe("图标层不变量", () => {
  it("除图标层自身外，没有文件直接导入 Phosphor", () => {
    const offenders: string[] = [];
    for (const file of walkTsx(SRC)) {
      const rel = relative(process.cwd(), file).replace(/\\/g, "/");
      if (rel === ICON_MODULE) continue; // 图标层是唯一允许深导入的地方
      if (/@phosphor-icons\/react/.test(readFileSync(file, "utf8"))) offenders.push(rel);
    }
    expect(offenders, `这些文件绕过了图标层，直接依赖 Phosphor：\n${offenders.join("\n")}`).toEqual(
      [],
    );
  });

  it("没有调用点再手写像素尺寸或字重", () => {
    const offenders: string[] = [];
    for (const file of walkTsx(SRC)) {
      const rel = relative(process.cwd(), file).replace(/\\/g, "/");
      if (rel === ICON_MODULE) continue;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (!/<Icon\b/.test(line)) return;
          /* 只拦数值字面量；透传变量（size={size}）由下一条断言校验档位合法性。 */
          if (/size=\{\s*\d/.test(line)) offenders.push(`${rel}:${index + 1} 用了数值 size`);
          if (/weight=/.test(line)) offenders.push(`${rel}:${index + 1} 手写了 weight`);
        });
    }
    expect(
      offenders,
      `尺寸与字重必须由图标层决定，调用点只说档位：\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("只使用在图标层登记过的尺寸档位", () => {
    const VALID: readonly IconSize[] = ["2xs", "xs", "sm", "md", "lg", "xl", "2xl", "3xl"];
    const offenders: string[] = [];
    for (const file of walkTsx(SRC)) {
      const rel = relative(process.cwd(), file).replace(/\\/g, "/");
      if (rel === ICON_MODULE) continue;
      for (const match of readFileSync(file, "utf8").matchAll(/<Icon\b[^>]*?size="([^"]+)"/gs)) {
        if (!VALID.includes(match[1] as IconSize)) offenders.push(`${rel} size="${match[1]}"`);
      }
    }
    expect(offenders, `未知尺寸档位：\n${offenders.join("\n")}`).toEqual([]);
  });
});
