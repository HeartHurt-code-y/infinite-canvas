import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { GenerationTaskClient, GenerationTaskDetail } from "../../lib/backend";
import { SEEDANCE_DRAFT_MODEL_ID } from "../../lib/seedanceDraft";
import { HistoryDialog } from "./HistoryDialog";

const DRAFT: GenerationTaskDetail = {
  summary: {
    id: "draft-local-1",
    canvasId: "canvas-1",
    sourceNodeId: "video-node-1",
    operation: "video_generation",
    status: "succeeded",
    queryHealth: "healthy",
    providerConnectionId: "provider-1",
    providerDisplayNameSnapshot: "草稿供应商",
    modelDefinitionId: `remote::provider-1::${SEEDANCE_DRAFT_MODEL_ID}`,
    remoteModelIdSnapshot: SEEDANCE_DRAFT_MODEL_ID,
    remoteTaskId: "draft-remote-1",
    progress: 100,
    tokens: null,
    createdAt: 1,
    updatedAt: 2,
    completedAt: 2,
  },
  logicalRequest: {
    canvasId: "canvas-1",
    sourceNodeId: "video-node-1",
    operation: "video_generation",
    providerConnectionId: "provider-1",
    modelDefinitionId: `remote::provider-1::${SEEDANCE_DRAFT_MODEL_ID}`,
    prompt: [{ kind: "text", text: "海边日出" }],
    parameters: { draft: true, resolution: "480p", duration: 5, ratio: "16:9" },
  },
  resolvedRequest: null,
  attempts: [],
  events: [],
  results: [],
  textOutput: null,
  finalError: null,
  calls: [
    {
      id: "call-1",
      taskId: "draft-local-1",
      attemptId: "attempt-1",
      phase: "submit",
      request: {
        adapterId: "moyu_v1",
        body: { model: SEEDANCE_DRAFT_MODEL_ID, metadata: { draft: true } },
      },
      sentAt: 1,
      responseReceivedAt: 2,
      durationMs: 1,
      httpStatus: 200,
      responseHeaders: {},
      rawResponse: null,
      runtimeError: null,
    },
  ],
};

function clientFor(detail = DRAFT): GenerationTaskClient {
  return {
    start: vi.fn(() => Promise.resolve("ordinary-task")),
    list: vi.fn(() => Promise.resolve({ items: [detail.summary], nextCursor: null })),
    get: vi.fn(() => Promise.resolve(detail)),
    getProgress: vi.fn(() =>
      Promise.resolve({ summary: detail.summary, results: [], finalError: null }),
    ),
    queryVideoTaskNow: vi.fn(() => Promise.resolve()),
  };
}

function draftForModel(modelId: string): GenerationTaskDetail {
  const modelDefinitionId = `remote::provider-1::${modelId}`;
  return {
    ...DRAFT,
    summary: { ...DRAFT.summary, modelDefinitionId, remoteModelIdSnapshot: modelId },
    logicalRequest: {
      ...(DRAFT.logicalRequest as Record<string, unknown>),
      modelDefinitionId,
    },
    calls: DRAFT.calls.map((call) => ({
      ...call,
      request: {
        adapterId: "moyu_v1",
        body: { model: modelId, metadata: { draft: true } },
      },
    })),
  };
}

describe("Seedance draft review in history", () => {
  it.each([SEEDANCE_DRAFT_MODEL_ID, "doubao-seedance-2.5"])(
    "waits for review and starts one separate final task without replaying %s",
    async (modelId) => {
      const draft = draftForModel(modelId);
      const client = clientFor(draft);
      let finish: (id: string) => void = () => undefined;
      const promote = vi.fn(
        () =>
          new Promise<string>((resolve) => {
            finish = resolve;
          }),
      );
      render(
        <HistoryDialog open onClose={vi.fn()} client={client} onPromoteSeedanceDraft={promote} />,
      );
      const button = await screen.findByRole("button", { name: "样片已审核，生成 1080p 正片" });
      expect(promote).not.toHaveBeenCalled();
      expect(screen.getByText(/正片固定 1080p/)).toHaveTextContent("独立付费任务");
      fireEvent.click(button);
      expect(button).toBeDisabled();
      fireEvent.click(button);
      expect(promote).toHaveBeenCalledTimes(1);
      expect(promote).toHaveBeenCalledWith(draft);
      finish("final-local-1");
      await waitFor(() => expect(client.get).toHaveBeenCalledWith("final-local-1"));
      expect(client.start).not.toHaveBeenCalled();
    },
  );

  it("preserves the draft and displays a failed final submission for deliberate retry", async () => {
    const promote = vi.fn(() => Promise.reject(new Error("服务暂时不可用")));
    const client = clientFor();
    render(
      <HistoryDialog open onClose={vi.fn()} client={client} onPromoteSeedanceDraft={promote} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "样片已审核，生成 1080p 正片" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("服务暂时不可用");
    expect(screen.getByRole("button", { name: "样片已审核，生成 1080p 正片" })).toBeEnabled();
    expect(client.start).not.toHaveBeenCalled();
  });

  it("directly shows the complete promotion error payload and links it to the submit button", async () => {
    const error = {
      kind: "validation",
      message: "validation error: 该样片尚未完成，请稍后查询状态。",
      details: { remoteTaskId: "draft-remote-1", providerStatus: "IN_PROGRESS" },
    };
    const promote = vi.fn<() => Promise<string>>().mockRejectedValue(error);
    const client = clientFor();
    render(
      <HistoryDialog open onClose={vi.fn()} client={client} onPromoteSeedanceDraft={promote} />,
    );
    const button = await screen.findByRole("button", { name: "样片已审核，生成 1080p 正片" });
    fireEvent.click(button);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("该样片尚未完成，请稍后查询状态。");
    expect(alert).toHaveTextContent("validation error:");
    expect(alert).toHaveTextContent('"providerStatus": "IN_PROGRESS"');
    expect(alert).toHaveTextContent('"remoteTaskId": "draft-remote-1"');
    expect(alert).toHaveTextContent('"kind": "validation"');
    expect(button).toHaveAttribute("aria-describedby", alert.id);
    expect(screen.queryByText("展开完整报错")).not.toBeInTheDocument();
    expect(promote).toHaveBeenCalledTimes(1);
    expect(client.start).not.toHaveBeenCalled();
  });

  it("preserves a multiline raw promotion error string without summarizing or folding it", async () => {
    const error = 'HTTP 429\n{"error":{"message":"provider rate limit","request_id":"req-raw-1"}}';
    const promote = vi.fn<() => Promise<string>>().mockRejectedValue(error);
    render(
      <HistoryDialog
        open
        onClose={vi.fn()}
        client={clientFor()}
        onPromoteSeedanceDraft={promote}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "样片已审核，生成 1080p 正片" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("HTTP 429");
    expect(alert).toHaveTextContent('"request_id":"req-raw-1"');
    expect(alert.querySelector("span")?.textContent).toBe(error);
    expect(alert.querySelector("span")).toHaveStyle({ whiteSpace: "pre-wrap" });
    expect(screen.queryByText("展开完整报错")).not.toBeInTheDocument();
    expect(promote).toHaveBeenCalledTimes(1);
  });

  it.each(["running", "failed"] as const)(
    "keeps a %s draft from creating a final task",
    async (status) => {
      const detail = { ...DRAFT, summary: { ...DRAFT.summary, status } };
      const promote = vi.fn();
      render(
        <HistoryDialog
          open
          onClose={vi.fn()}
          client={clientFor(detail)}
          onPromoteSeedanceDraft={promote}
        />,
      );
      expect(
        await screen.findByRole("button", { name: "样片已审核，生成 1080p 正片" }),
      ).toBeDisabled();
      expect(promote).not.toHaveBeenCalled();
    },
  );

  it("uses the archived adapter and does not offer Moyu promotion for Ark tasks", async () => {
    const detail = {
      ...DRAFT,
      calls: DRAFT.calls.map((call) => ({
        ...call,
        request: { adapterId: "volcengine_ark_v1", body: { draft: true } },
      })),
    };
    render(<HistoryDialog open onClose={vi.fn()} client={clientFor(detail)} />);
    await screen.findByText("任务概要");
    expect(
      screen.queryByRole("button", { name: "样片已审核，生成 1080p 正片" }),
    ).not.toBeInTheDocument();
  });

  it("links a final task to its local parent and hides incompatible ordinary regeneration", async () => {
    const detail = {
      ...DRAFT,
      summary: { ...DRAFT.summary, id: "final-local-1", remoteTaskId: "final-remote-1" },
      logicalRequest: {
        ...(DRAFT.logicalRequest as Record<string, unknown>),
        prompt: [],
        parameters: { draft_task_id: "draft-remote-1" },
        seedanceDraftSourceTaskId: "draft-local-1",
      },
      calls: [],
    };
    const client = clientFor(detail);
    render(<HistoryDialog open onClose={vi.fn()} client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "查看原草稿样片" }));
    await waitFor(() => expect(client.get).toHaveBeenCalledWith("draft-local-1"));
    expect(screen.queryByRole("button", { name: "直接重新生成" })).not.toBeInTheDocument();
    expect(client.start).not.toHaveBeenCalled();
  });
});
