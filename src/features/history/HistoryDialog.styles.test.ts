// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appCss = readFileSync(new URL("../../App.css", import.meta.url), "utf8");
const tokensCss = readFileSync(new URL("../../../tokens.css", import.meta.url), "utf8");

function cssRule(source: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`${escapedSelector}\\s*\\{([^}]+)\\}`));
  expect(match, `Missing CSS rule for ${selector}`).not.toBeNull();
  return match?.[1] ?? "";
}

describe("HistoryDialog visual contracts", () => {
  it("uses chrome text tokens throughout the dark task list", () => {
    expect(cssRule(appCss, ".history-list")).toMatch(/color:\s*var\(--color-chrome-ink\)/);
    expect(cssRule(appCss, ".history-item__tokens")).toMatch(
      /color:\s*var\(--color-chrome-muted\)/,
    );
    expect(cssRule(appCss, ".history-item__meta")).toMatch(/color:\s*var\(--color-chrome-muted\)/);
  });

  it("keeps the compact reveal action in the result card footer", () => {
    expect(tokensCss).toMatch(/--size-control-compact:\s*1\.5rem/);

    const revealRule = cssRule(appCss, ".history-result__reveal");
    expect(revealRule).not.toMatch(/\btop:/);
    expect(revealRule).toMatch(/\bbottom:/);
    expect(revealRule).toMatch(/width:\s*var\(--size-control-compact\)/);
    expect(revealRule).toMatch(/height:\s*var\(--size-control-compact\)/);
  });

  it("fits preview media inside the visible viewport", () => {
    const mediaRule = cssRule(appCss, ".history-lightbox__media");

    expect(mediaRule).toMatch(/max-width:\s*calc\(100vw\s*-\s*[^)]+\)/);
    expect(mediaRule).toMatch(/max-height:\s*calc\(100dvh\s*-\s*[^)]+\)/);
    expect(mediaRule).toMatch(/object-fit:\s*contain/);
  });

  it("keeps the cross-canvas scope switch and canvas chip readable on dark chrome", () => {
    expect(cssRule(appCss, ".history-scope__option")).toMatch(
      /color:\s*var\(--color-chrome-subtle\)/,
    );
    expect(cssRule(appCss, ".history-scope__option.is-active")).toMatch(
      /color:\s*var\(--color-chrome-ink\)/,
    );

    // 归属画布是行内小徽标：必须自带墨色与底色，否则落回继承色在深色列表里读不出来。
    const canvasChip = cssRule(appCss, ".history-item__canvas");
    expect(canvasChip).toMatch(/color:\s*var\(--color-chrome-ink\)/);
    expect(canvasChip).toMatch(/background:\s*var\(--color-chrome-3\)/);
    expect(canvasChip).toMatch(/text-overflow:\s*ellipsis/);
  });
});
