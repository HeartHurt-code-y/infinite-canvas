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
    list: vi.fn(() => Promise.resolve({ items: [detail.summary], nextCursorCreatedBefore: null })),
    get: vi.fn(() => Promise.resolve(detail)),
    getProgress: vi.fn(() =>
      Promise.resolve({ summary: detail.summary, results: [], finalError: null }),
    ),
    queryVideoTaskNow: vi.fn(() => Promise.resolve()),
  };
}

describe("Seedance draft review in history", () => {
  it("waits for manual review and starts one separate final task without replaying prompt or parameters", async () => {
    const client = clientFor();
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
    expect(promote).toHaveBeenCalledWith(DRAFT);
    finish("final-local-1");
    await waitFor(() => expect(client.get).toHaveBeenCalledWith("final-local-1"));
    expect(client.start).not.toHaveBeenCalled();
  });

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
