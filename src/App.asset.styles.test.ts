// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appCss = readFileSync(new URL("./App.css", import.meta.url), "utf8");

function cssRule(selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = appCss.match(new RegExp(`(?:^|})\\s*${escapedSelector}\\s*\\{([^}]+)\\}`));
  expect(match, `Missing CSS rule for ${selector}`).not.toBeNull();
  return match?.[1] ?? "";
}

describe("素材库卡片视觉契约", () => {
  it("让图片和视频缩略图按原始比例完整缩放进卡片，不裁剪", () => {
    expect(cssRule(".asset-card__visual")).toMatch(/border:\s*0/);
    expect(cssRule(".asset-card__preview")).toMatch(/object-fit:\s*contain/);
    expect(cssRule(".asset-card__video")).toMatch(/object-fit:\s*contain/);
  });

  it("让素材库错误摘要在浅红背景上保持高对比度并支持完整详情展开", () => {
    expect(cssRule(".asset-panel__error-summary")).toMatch(/color:\s*var\(--color-ink\)/);
    expect(cssRule(".asset-panel__error-summary")).toMatch(/line-height:\s*1\.55/);
    expect(cssRule(".asset-panel__error-details pre")).toMatch(/color:\s*var\(--color-ink\)/);
    expect(cssRule(".asset-panel__error-details pre")).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it("素材库卡片只展示媒体，不渲染名称、Asset 信息或底部渐变", () => {
    expect(appCss).not.toMatch(/\.asset-card__identity\s*{/);
    expect(appCss).not.toMatch(/\.asset-card__name\s*{/);
    expect(appCss).not.toMatch(/\.asset-card__meta\s*{/);
    expect(appCss).not.toMatch(/\.asset-card::after\s*{/);
  });

  it("素材网格占满面板剩余高度，并以两列瀑布流排布不等高卡片", () => {
    expect(cssRule(".asset-panel")).toMatch(/flex-direction:\s*column/);
    expect(cssRule(".asset-grid")).toMatch(/flex:\s*1 1 auto/);
    expect(cssRule(".asset-grid")).toMatch(/min-height:\s*0/);
    expect(cssRule(".asset-flow")).toMatch(/columns:\s*2/);
    expect(cssRule(".asset-card")).toMatch(/break-inside:\s*avoid/);
    expect(cssRule(".asset-card__visual")).toMatch(/aspect-ratio:\s*4\s*\/\s*3/);
  });

  it("跳过视口外素材卡片的布局与绘制，并保留稳定的占位高度", () => {
    expect(cssRule(".asset-card")).toMatch(/content-visibility:\s*auto/);
    expect(cssRule(".asset-card")).toMatch(/contain-intrinsic-size:\s*auto\s+180px/);
  });

  it("分组行在窄面板下换行而不是把「新建分组」挤出面板", () => {
    // 该规则前面有一段说明注释，cssRule 的 `(?:^|})` 前缀匹配不到，这里直接取规则体。
    const row = appCss.match(/\.asset-groups__select-row\s*\{([^}]+)\}/)?.[1] ?? "";
    // 单行 flex 的固有最小宽度 = 下拉最长分组名 + 操作按钮；面板比它窄时整行溢出内容盒，
    // 被 .asset-panel 的 overflow:hidden 裁掉（新建分组右半截被遮蔽）。允许换行才治根。
    expect(row).toMatch(/display:\s*flex/);
    expect(row).toMatch(/flex-wrap:\s*wrap/);
    // 按钮按内容取宽：width:100% 会撑满整行，窄面板下把内容顶出面板。
    const buttons = appCss.match(
      /\.asset-groups__actions \.asset-groups__create,[^}]*\.asset-groups__delete\s*\{([^}]+)\}/,
    );
    expect(buttons, "Missing CSS rule for .asset-groups__actions buttons").not.toBeNull();
    expect(buttons?.[1]).toMatch(/white-space:\s*nowrap/);
    expect(buttons?.[1]).not.toMatch(/width:\s*100%/);
  });

  it("以无顶栏的全屏布局展示源媒体和精简信息", () => {
    expect(appCss).toMatch(/\.asset-source-dialog\s*{[^}]*width:\s*100vw/);
    expect(appCss).toMatch(/\.asset-source-dialog\s*{[^}]*height:\s*100dvh/);
    expect(cssRule(".asset-source-dialog__stage")).toMatch(/padding:\s*0/);
    expect(cssRule(".asset-source-dialog__media")).toMatch(/width:\s*100%/);
    expect(cssRule(".asset-source-dialog__media")).toMatch(/height:\s*100%/);
    expect(cssRule(".asset-source-dialog__media")).toMatch(/object-fit:\s*contain/);
    expect(cssRule(".asset-source-dialog__details dd")).toMatch(/overflow-wrap:\s*anywhere/);
    expect(cssRule(".asset-source-dialog__details dd")).toMatch(/user-select:\s*text/);
    expect(cssRule(".asset-source-dialog__layout")).not.toMatch(/header/);
    expect(appCss).not.toMatch(/\.asset-source-dialog__header\s*{/);
    expect(appCss).not.toMatch(/\.asset-source-dialog__details-heading\s*{/);
  });
});
