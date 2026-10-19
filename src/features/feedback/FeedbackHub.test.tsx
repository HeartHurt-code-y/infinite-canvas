import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ErrorAlert } from "../../components/ErrorAlert";
import {
  errorDiagnostic,
  FEEDBACK_OPEN_EVENT,
  FeedbackReporter,
  type ClientReport,
} from "../../lib/errorReporting";
import { FeedbackDialog, FeedbackHub } from "./FeedbackHub";
import type { DiagnosticCollection, DiagnosticOccurrence } from "../../lib/diagnosticAttachments";

function Fixture({ reporter }: { reporter: FeedbackReporter }) {
  const [description, setDescription] = useState("点击生成后失败，请帮忙排查");
  const [contact, setContact] = useState("user@example.test");
  const [receipt, setReceipt] = useState<{ reportId: string; sent: boolean } | null>(null);
  return (
    <FeedbackDialog
      reporter={reporter}
      diagnostic={errorDiagnostic({ kind: "transport" }, "submit_generation_task")}
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
describe("software feedback dialog", () => {
  it("enables complete automatic diagnostics immediately while retaining manual preview controls", async () => {
    const prepareDiagnostics = vi.fn(
      (_occurrence: DiagnosticOccurrence, consent: DiagnosticCollection) =>
        Promise.resolve({
          reportId: crypto.randomUUID(),
          diagnostics: {
            schemaVersion: 1 as const,
            ...consent,
            tokenHash: "b".repeat(64),
            byteLength: 1000,
            sha256: "c".repeat(64),
          },
          preview: "完整诊断预览（Key 仅显示前后字符）",
        }),
    );
    const send = vi.fn((report: ClientReport) =>
      Promise.resolve({
        reportId: report.reportId,
        groupId: "a".repeat(64),
        received: true as const,
      }),
    );
    const reporter = new FeedbackReporter({ storage: null, send, prepareDiagnostics });
    render(<Fixture reporter={reporter} />);
    expect(screen.getByRole("checkbox", { name: /自动收集并上传完整报错/ })).toBeChecked();
    expect(screen.queryByRole("button", { name: "保存后续自动上传授权" })).not.toBeInTheDocument();
    expect(screen.getByText(/自动完整诊断已开启/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "准备诊断并预览" })).toBeDisabled();
    for (const name of [
      "完整 API Key",
      "提示词与对话上下文",
      "模型原始响应与完整报错",
      "对应画布的当前内容",
      "对应素材文件与云端引用",
    ])
      fireEvent.click(screen.getByRole("checkbox", { name }));
    fireEvent.click(screen.getByRole("button", { name: "发送反馈" }));
    await screen.findByText(/请确认诊断资料授权/);
    expect(prepareDiagnostics).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox", { name: /我确认允许开发者读取所选资料/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /自动收集并上传完整报错/ }));
    expect(reporter.getSnapshot().automaticEnabled).toBe(false);
    fireEvent.click(screen.getByRole("checkbox", { name: /自动收集并上传完整报错/ }));
    expect(reporter.getSnapshot().automaticEnabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "准备诊断并预览" }));
    await screen.findByText(/诊断资料已准备/);
    expect(screen.getByText("完整诊断预览（Key 仅显示前后字符）")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "发送反馈" }));
    await screen.findByText(/反馈已送达开发者/);
    expect(send.mock.calls[0]![0].diagnostics?.categories).toHaveLength(5);
    expect(JSON.stringify(send.mock.calls[0]![0])).not.toContain("完整诊断预览");
  });
  it("retains a failed feedback draft and retries its original identity before confirming delivery", async () => {
    const send = vi.fn((report: ClientReport) =>
      Promise.resolve({
        reportId: report.reportId,
        groupId: "a".repeat(64),
        received: true as const,
      }),
    );
    send.mockRejectedValueOnce(new Error("offline"));
    const reporter = new FeedbackReporter({ storage: localStorage, send });
    reporter.clearPending();
    render(<Fixture reporter={reporter} />);
    fireEvent.click(screen.getByRole("button", { name: "发送反馈" }));
    await screen.findByText(/反馈暂未送达/);
    expect(screen.getByLabelText("问题描述（选填）")).toHaveValue("点击生成后失败，请帮忙排查");
    expect(screen.getByLabelText("联系方式（选填）")).toHaveValue("user@example.test");
    fireEvent.click(screen.getByRole("button", { name: "重试这份反馈" }));
    await screen.findByText(/反馈已送达开发者/);
    expect(send.mock.calls[1]![0]).toEqual(send.mock.calls[0]![0]);
    expect(screen.getByRole("button", { name: "已送达" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "填写新反馈" }));
    expect(screen.getByLabelText("问题描述（选填）")).toHaveValue("");
  });
  it("opens from the common error action, previews only metadata, and restores focus on close", async () => {
    render(
      <>
        <ErrorAlert error={{ kind: "transport", message: "private secret message" }} />
        <FeedbackHub />
      </>,
    );
    const trigger = screen.getByRole("button", { name: "反馈问题" });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "反馈与错误诊断" });
    expect(dialog).not.toHaveTextContent("private secret message");
    expect(screen.getByText("查看将发送的诊断和反馈内容")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭反馈窗口" }));
    await waitFor(() => expect(trigger).toHaveFocus());
  });
  it("retains the user's description when the dialog closes and reopens", async () => {
    render(<FeedbackHub />);
    window.dispatchEvent(new CustomEvent(FEEDBACK_OPEN_EVENT));
    const field = await screen.findByLabelText("问题描述（选填）");
    fireEvent.change(field, { target: { value: "请保留这份草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "关闭反馈窗口" }));
    window.dispatchEvent(new CustomEvent(FEEDBACK_OPEN_EVENT));
    expect(await screen.findByLabelText("问题描述（选填）")).toHaveValue("请保留这份草稿");
  });
});
