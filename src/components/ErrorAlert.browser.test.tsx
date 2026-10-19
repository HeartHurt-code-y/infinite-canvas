import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { describe, expect, it } from "vitest";

import { ErrorAlert } from "./ErrorAlert";
import { formatWorkflowFailure, modelWorkflowError } from "../lib/workflowErrors";
import "../App.css";

describe("workflow error readability in the browser", () => {
  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])("keeps saved API errors readable with raw=%s and legacyHTTP=%s", async (raw, legacyHTTP) => {
    const summary = legacyHTTP
      ? "供应商返回了网页而不是接口数据（HTTP 200）。请核对 API 地址，并向供应商确认当前接口是否已开通。"
      : "供应商返回了网页而不是接口数据（HTTP 200）。请核对 API 地址。";
    const html = `<!doctype html><html>${"魔芋AI".repeat(400)}</html>`;
    const error = legacyHTTP
      ? `HTTP 200\n${html}`
      : JSON.stringify({
          kind: "protocol",
          message: `protocol error: ${summary}`,
          details: {
            httpStatus: 200,
            rawResponse: html,
          },
        });
    await render(
      <section data-testid="saved-error-card" style={{ width: 280 }}>
        <ErrorAlert raw={raw} error={error} hint="确认供应商已开放当前接口后，再刷新素材列表。" />
      </section>,
    );
    await expect.element(page.getByText(summary, { exact: true })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "复制完整报错", exact: true }))
      .toBeVisible();
    const card = document.querySelector<HTMLElement>('[data-testid="saved-error-card"]')!;
    expect(card.querySelector('[role="alert"]')).not.toHaveTextContent("<!doctype");
    const details = card.querySelector("details")!;
    if (raw) expect(details).toHaveAttribute("open");
    else expect(details).not.toHaveAttribute("open");
    expect(details.querySelector("pre")).toHaveTextContent(error, {
      normalizeWhitespace: false,
    });
    if (!raw) await page.getByText("展开完整报错", { exact: true }).click();
    expect(details).toHaveAttribute("open");
    expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth + 1);
  });

  it("keeps guidance and full model responses readable within a narrow workflow card", async () => {
    const original = {
      kind: "protocol",
      message: "prompt model chat completion failed",
      details: {
        httpStatus: 429,
        rawResponse: {
          error: { message: "provider detail".repeat(300), requestId: "request-layout" },
        },
      },
    };
    await render(
      <section data-testid="card" style={{ width: 280 }}>
        <ErrorAlert
          workflow
          id="workflow-usage-error"
          error="工作流参考素材已修改，请按当前资料重新制作。"
        />
        <ErrorAlert workflow error={formatWorkflowFailure(modelWorkflowError(original))} />
      </section>,
    );
    await expect.element(page.getByText("为什么发生")).toBeVisible();
    await expect.element(page.getByText("如何避免")).toBeVisible();
    await expect.element(page.getByText("模型调用完整原始报错")).toBeVisible();
    const card = document.querySelector<HTMLElement>('[data-testid="card"]')!;
    const raw = card.querySelector<HTMLElement>(".error-alert__raw")!;
    expect(raw.closest("details")).toHaveAttribute("open");
    expect(raw.closest('[role="alert"]')).toBeNull();
    expect(JSON.parse(raw.textContent)).toEqual(original);
    expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth + 1);
    expect(raw.scrollHeight).toBeGreaterThan(raw.clientHeight);
    const cardBox = card.getBoundingClientRect();
    for (const element of card.querySelectorAll<HTMLElement>(
      ".error-alert__summary, .error-alert__details",
    )) {
      const box = element.getBoundingClientRect();
      expect(box.right).toBeLessThanOrEqual(cardBox.right + 1);
      expect(box.width).toBeGreaterThan(0);
    }
  });
});
