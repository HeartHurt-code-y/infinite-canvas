import { useState } from "react";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { describe, expect, it } from "vitest";
import { errorDiagnostic, FeedbackReporter } from "../../lib/errorReporting";
import { FeedbackDialog } from "./FeedbackHub";
import "../../App.css";
import "../../styles/studio.css";

function Fixture() {
  const [description, setDescription] = useState("");
  const [contact, setContact] = useState("");
  const [receipt, setReceipt] = useState<{ reportId: string; sent: boolean } | null>(null);
  const [reporter] = useState(
    () =>
      new FeedbackReporter({
        storage: null,
        send: (report) =>
          Promise.resolve({
            reportId: report.reportId,
            groupId: "a".repeat(64),
            received: true,
          }),
        prepareDiagnostics: (_occurrence, consent) =>
          Promise.resolve({
            reportId: crypto.randomUUID(),
            diagnostics: {
              schemaVersion: 1,
              ...consent,
              tokenHash: "b".repeat(64),
              byteLength: 1000,
              sha256: "c".repeat(64),
            },
            preview: "资料预览：提示词、模型完整响应、画布与素材；Key test…key。",
          }),
      }),
  );
  return (
    <FeedbackDialog
      reporter={reporter}
      diagnostic={errorDiagnostic(new TypeError("hidden"))}
      description={description}
      contact={contact}
      receipt={receipt}
      onReceipt={setReceipt}
      onDescription={setDescription}
      onContact={setContact}
      onClose={() => {}}
    />
  );
}
describe("feedback dialog browser interaction", () => {
  it("keeps the form, preview and send controls accessible at desktop and narrow widths", async () => {
    await render(<Fixture />);
    await expect.element(page.getByRole("dialog", { name: "反馈与错误诊断" })).toBeVisible();
    await page.getByLabelText("问题描述（选填）").fill("点击保存后没有结果，预期保存成功");
    for (const name of [
      "完整 API Key",
      "提示词与对话上下文",
      "模型原始响应与完整报错",
      "对应画布的当前内容",
      "对应素材文件与云端引用",
    ])
      await page.getByRole("checkbox", { name, exact: true }).click();
    await page.getByRole("checkbox", { name: /我确认允许开发者读取所选资料/ }).click();
    await page.getByRole("button", { name: "准备诊断并预览" }).click();
    await expect.element(page.getByText(/诊断资料已准备/)).toBeVisible();
    await page.getByText("查看将发送的诊断和反馈内容").click();
    for (const width of [1000, 390]) {
      await page.viewport(width, 700);
      const dialog = document.querySelector<HTMLDialogElement>(".feedback-dialog")!;
      expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth + 1);
      expect(dialog.getBoundingClientRect().right).toBeLessThanOrEqual(width);
      expect(getComputedStyle(dialog).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
      await page.screenshot({ path: `../../../.screenshots/feedback-client-${width}.png` });
    }
    await page.getByRole("button", { name: "发送反馈" }).click();
    await expect.element(page.getByText(/反馈已送达开发者/)).toBeVisible();
    await page.getByRole("button", { name: "填写新反馈" }).click();
    await userEvent.keyboard("{Tab}");
    expect(document.querySelector(".feedback-dialog")!.contains(document.activeElement)).toBe(true);
  });
});
