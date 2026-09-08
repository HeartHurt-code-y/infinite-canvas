import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  GenerationTaskClient,
  GenerationTaskDetail,
  GenerationTaskPage,
  GenerationTaskSummary,
} from "../../lib/backend";
import { HistoryDialog } from "./HistoryDialog";

const SUMMARY: GenerationTaskSummary = {
  id: "task-failed-1",
  canvasId: "canvas-1",
  sourceNodeId: "node-1",
  operation: "text_to_image",
  status: "failed",
  queryHealth: "healthy",
  providerConnectionId: "provider-1",
  providerDisplayNameSnapshot: "测试供应商",
  modelDefinitionId: "remote::provider-1::image-model",
  remoteModelIdSnapshot: "image-model",
  remoteTaskId: null,
  progress: null,
  tokens: null,
  createdAt: 1_777_000_000_000,
  updatedAt: 1_777_000_002_000,
  completedAt: 1_777_000_002_000,
};

const DETAIL: GenerationTaskDetail = {
  summary: SUMMARY,
  logicalRequest: { prompt: [{ kind: "text", text: "测试提示词" }] },
  resolvedRequest: {},
  attempts: [
    {
      id: "attempt-1",
      attemptNumber: 1,
      phase: "submit",
      startedAt: 1_777_000_000_000,
      finishedAt: 1_777_000_002_000,
      backoffMs: 2_000,
      outcome: "failed",
      error: {
        kind: "protocol",
        message: "protocol error: provider refused request",
        details: {
          rawResponse: '{"code":"UPSTREAM_FAILED","message":"图像尺寸无效"}',
        },
        backtrace: "stack line 1\nstack line 2",
      },
    },
  ],
  calls: [
    {
      id: "call-failed",
      taskId: SUMMARY.id,
      attemptId: "attempt-1",
      phase: "submit",
      request: { model: "image-model", size: "invalid" },
      sentAt: 1_777_000_000_000,
      responseReceivedAt: 1_777_000_002_000,
      durationMs: 2_000,
      httpStatus: 422,
      responseHeaders: {},
      rawResponse: '{"code":"UPSTREAM_FAILED","message":"图像尺寸无效"}',
      runtimeError: null,
    },
    {
      id: "call-succeeded",
      taskId: SUMMARY.id,
      attemptId: "attempt-1",
      phase: "observe",
      request: { taskId: "remote-1" },
      sentAt: 1_777_000_003_000,
      responseReceivedAt: 1_777_000_003_100,
      durationMs: 100,
      httpStatus: 200,
      responseHeaders: {},
      rawResponse: '{"status":"done"}',
      runtimeError: null,
    },
  ],
  events: [],
  results: [],
  textOutput: null,
  finalError: null,
};

function createClient(detail: GenerationTaskDetail = DETAIL): GenerationTaskClient {
  return {
    start: vi.fn(() => Promise.resolve(detail.summary.id)),
    list: vi.fn(() => Promise.resolve({ items: [detail.summary], nextCursorCreatedBefore: null })),
    get: vi.fn(() => Promise.resolve(detail)),
    queryVideoTaskNow: vi.fn(() => Promise.resolve()),
  };
}

describe("HistoryDialog diagnostics", () => {
  it("keeps generation history scoped to the canvas across pagination and canvas changes", async () => {
    const client = createClient();
    const list = vi.mocked(client.list);
    list.mockResolvedValueOnce({ items: [SUMMARY], nextCursorCreatedBefore: SUMMARY.createdAt });
    const onClose = vi.fn();
    const { rerender } = render(
      <HistoryDialog open onClose={onClose} client={client} canvasId="canvas-1" />,
    );

    const loadMore = await screen.findByRole("button", { name: "加载更多" });
    expect(list).toHaveBeenLastCalledWith({ canvasId: "canvas-1", statuses: null, limit: 30 });
    list.mockResolvedValueOnce({ items: [], nextCursorCreatedBefore: null });
    fireEvent.click(loadMore);
    await waitFor(() =>
      expect(list).toHaveBeenLastCalledWith({
        canvasId: "canvas-1",
        statuses: null,
        limit: 30,
        cursorCreatedBefore: SUMMARY.createdAt,
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "加载更多" })).not.toBeInTheDocument(),
    );

    list.mockResolvedValueOnce({ items: [], nextCursorCreatedBefore: null });
    rerender(<HistoryDialog open onClose={onClose} client={client} canvasId="canvas-2" />);
    await screen.findByText("没有符合条件的任务。");
    expect(list).toHaveBeenLastCalledWith({ canvasId: "canvas-2", statuses: null, limit: 30 });
    expect(screen.queryByText("文生图 · image-model")).not.toBeInTheDocument();
  });

  it("queries creation time in local time, carries the range into pagination, and resets it", async () => {
    const client = createClient();
    const list = vi.mocked(client.list);
    list.mockResolvedValueOnce({ items: [SUMMARY], nextCursorCreatedBefore: null });
    render(<HistoryDialog open onClose={vi.fn()} client={client} />);
    await screen.findByText("文生图 · image-model");
    fireEvent.change(screen.getByLabelText("开始时间"), {
      target: { value: "2026-09-01T12:34:56" },
    });
    fireEvent.change(screen.getByLabelText("结束时间"), {
      target: { value: "2026-09-05T23:59:59" },
    });
    expect(list).toHaveBeenCalledTimes(1);
    list.mockResolvedValueOnce({ items: [SUMMARY], nextCursorCreatedBefore: SUMMARY.createdAt });
    fireEvent.click(screen.getByRole("button", { name: /^查询$/ }));
    const range = {
      createdFrom: new Date(2026, 8, 1, 12, 34, 56).getTime(),
      createdTo: new Date(2026, 8, 5, 23, 59, 59, 999).getTime(),
    };
    await waitFor(() =>
      expect(list).toHaveBeenLastCalledWith({ ...range, statuses: null, limit: 30 }),
    );
    list.mockResolvedValueOnce({ items: [], nextCursorCreatedBefore: null });
    fireEvent.click(await screen.findByRole("button", { name: "加载更多" }));
    await waitFor(() =>
      expect(list).toHaveBeenLastCalledWith({
        ...range,
        statuses: null,
        limit: 30,
        cursorCreatedBefore: SUMMARY.createdAt,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /^重置$/ }));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith({ statuses: null, limit: 30 }));
    expect(screen.getByLabelText("开始时间")).toHaveValue("");
    expect(screen.getByLabelText("结束时间")).toHaveValue("");
  });

  it("rejects inverted ranges without requesting and ignores an older page after a new search", async () => {
    const client = createClient();
    const list = vi.mocked(client.list);
    list.mockResolvedValueOnce({ items: [SUMMARY], nextCursorCreatedBefore: SUMMARY.createdAt });
    render(<HistoryDialog open onClose={vi.fn()} client={client} />);
    await screen.findByRole("button", { name: "加载更多" });
    fireEvent.change(screen.getByLabelText("开始时间"), { target: { value: "2026-09-06T00:00" } });
    fireEvent.change(screen.getByLabelText("结束时间"), {
      target: { value: "2026-09-05T23:59:59" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^查询$/ }));
    expect(screen.getByRole("alert")).toHaveTextContent("开始时间不能晚于结束时间");
    expect(list).toHaveBeenCalledTimes(1);
    let finishOldPage!: (page: GenerationTaskPage) => void;
    list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOldPage = resolve;
        }),
    );
    fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
    list.mockResolvedValueOnce({ items: [], nextCursorCreatedBefore: null });
    fireEvent.change(screen.getByLabelText("开始时间"), { target: { value: "2026-09-01T00:00" } });
    fireEvent.click(screen.getByRole("button", { name: /^查询$/ }));
    await screen.findByText("没有符合条件的任务。");
    act(() => {
      finishOldPage({ items: [{ ...SUMMARY, id: "obsolete" }], nextCursorCreatedBefore: 1 });
    });
    expect(screen.queryByText("文生图 · image-model")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "加载更多" })).not.toBeInTheDocument();
  });

  it("shows the complete text-model product and archived provider payloads", async () => {
    const textSummary: GenerationTaskSummary = {
      ...SUMMARY,
      id: "task-text-1",
      operation: "text_generation",
      status: "succeeded",
      remoteModelIdSnapshot: "claude-sonnet",
    };
    const textDetail: GenerationTaskDetail = {
      ...DETAIL,
      summary: textSummary,
      logicalRequest: { userPrompt: "把雨夜站台扩写为电影镜头" },
      calls: [
        {
          ...DETAIL.calls[0]!,
          id: "call-text-1",
          taskId: textSummary.id,
          phase: "text_generation",
          httpStatus: 200,
          runtimeError: null,
          request: {
            body: { model: "claude-sonnet", messages: [{ role: "user", content: "完整输入" }] },
          },
          rawResponse: '{"content":[{"type":"text","text":"完整原始输出"}]}',
        },
      ],
      attempts: [],
      textOutput: {
        optimizedPrompt: "雨夜站台，电影级侧逆光。",
        rawModelOutput: "分析内容\n\n雨夜站台，电影级侧逆光。",
      },
      finalError: null,
    };

    render(<HistoryDialog open onClose={vi.fn()} client={createClient(textDetail)} />);

    expect(await screen.findByText("文本生成 · claude-sonnet")).toBeInTheDocument();
    expect(await screen.findByText("把雨夜站台扩写为电影镜头")).toBeInTheDocument();
    expect(screen.getByText("节点采用的提示词")).toBeInTheDocument();
    expect(screen.getByText("雨夜站台，电影级侧逆光。")).toBeInTheDocument();
    expect(screen.getByText("模型原始文本")).toBeInTheDocument();
    expect(screen.getByText(/分析内容/)).toBeInTheDocument();
    expect(screen.getByText("文本生成", { selector: ".history-call__phase" })).toBeInTheDocument();
    expect(screen.getByText("供应商响应")).toBeInTheDocument();
  });

  it("surfaces readable error summaries and expands failed provider calls", async () => {
    render(<HistoryDialog open onClose={vi.fn()} client={createClient()} />);

    const attemptError = await screen.findByRole("group", { name: "第 1 次尝试失败" });
    expect(attemptError).toHaveTextContent("第 1 次尝试失败 · 供应商协议");
    expect(attemptError).toHaveTextContent("protocol error: provider refused request");
    expect(within(attemptError).getByText("完整技术详情")).toBeInTheDocument();

    const failedCallLabel = screen.getByText("调用 1");
    const failedCallDetails = failedCallLabel.closest("details");
    expect(failedCallDetails).not.toBeNull();
    expect(failedCallDetails).toHaveProperty("open", true);

    const providerError = screen.getByRole("group", { name: "供应商调用失败" });
    expect(providerError).toHaveTextContent("供应商调用失败 · UPSTREAM_FAILED");
    expect(providerError).toHaveTextContent("图像尺寸无效");

    const openResponse = document.querySelector(".history-payload[open] .history-raw");
    expect(openResponse).toHaveTextContent('"message": "图像尺寸无效"');
    expect(openResponse).not.toHaveTextContent('\\"message\\"');

    const succeededCallDetails = screen.getByText("调用 2").closest("details");
    expect(succeededCallDetails).not.toBeNull();
    expect(succeededCallDetails).toHaveProperty("open", false);
  });

  it("provides an explicit close control and still closes when the image is clicked", async () => {
    const detailWithResult: GenerationTaskDetail = {
      ...DETAIL,
      results: [
        {
          taskId: SUMMARY.id,
          resultIndex: 0,
          mediaType: "image",
          remoteTaskId: "remote-1",
          source: null,
          saveStatus: "succeeded",
          finalPath: "C:\\results\\image.png",
          relativePath: "image.png",
          byteSize: 2_097_152,
          mimeType: "image/png",
          sha256: null,
          savedAt: 1_777_000_003_000,
          error: null,
        },
      ],
    };

    render(<HistoryDialog open onClose={vi.fn()} client={createClient(detailWithResult)} />);

    const resultLabel = await screen.findByText(/\u7ed3\u679c 1 · \u56fe\u7247/);
    const resultButton = resultLabel.closest("button");
    const resultCard = resultLabel.closest(".history-result");
    expect(resultButton).not.toBeNull();
    expect(resultCard).not.toBeNull();
    expect(resultButton).not.toContainElement(
      within(resultCard as HTMLElement).getByRole("button", {
        name: "在文件夹中显示该结果",
      }),
    );
    fireEvent.click(resultButton!);

    const preview = screen.getByRole("dialog", { name: "媒体预览" });
    expect(preview.querySelector(".history-lightbox__bar")).not.toBeInTheDocument();
    expect(within(preview).getByRole("button", { name: "关闭媒体预览" })).toBeInTheDocument();

    fireEvent.click(within(preview).getByRole("button", { name: "任务结果 1，关闭媒体预览" }));
    expect(screen.queryByRole("dialog", { name: "媒体预览" })).not.toBeInTheDocument();
  });

  it("keeps a video preview dismissible with Escape and a backdrop click", async () => {
    const detailWithVideo: GenerationTaskDetail = {
      ...DETAIL,
      results: [
        {
          taskId: SUMMARY.id,
          resultIndex: 0,
          mediaType: "video",
          remoteTaskId: "remote-1",
          source: null,
          saveStatus: "succeeded",
          finalPath: "C:\\results\\portrait-video.mp4",
          relativePath: "portrait-video.mp4",
          byteSize: 4_194_304,
          mimeType: "video/mp4",
          sha256: null,
          savedAt: 1_777_000_003_000,
          error: null,
        },
      ],
    };
    const onClose = vi.fn();

    render(<HistoryDialog open onClose={onClose} client={createClient(detailWithVideo)} />);

    const resultLabel = await screen.findByText(/结果 1 · 视频/);
    const resultButton = resultLabel.closest("button");
    expect(resultButton).not.toBeNull();

    fireEvent.click(resultButton!);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "媒体预览" })).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(resultButton!);
    const preview = screen.getByRole("dialog", { name: "媒体预览" });
    const stage = preview.querySelector(".history-lightbox__stage");
    const video = preview.querySelector("video");
    expect(stage).not.toBeNull();
    expect(video).not.toBeNull();
    fireEvent.click(video!);
    expect(screen.getByRole("dialog", { name: "媒体预览" })).toBeInTheDocument();
    fireEvent.click(stage!);
    expect(screen.queryByRole("dialog", { name: "媒体预览" })).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});

const REGEN_SUMMARY: GenerationTaskSummary = {
  ...SUMMARY,
  id: "task-regen-1",
  status: "succeeded",
};

const REGEN_LOGICAL_REQUEST = {
  canvasId: "canvas-1",
  sourceNodeId: "node-1",
  operation: "text_to_image",
  providerConnectionId: "provider-1",
  modelDefinitionId: "remote::provider-1::image-model",
  prompt: [
    { kind: "text", text: "一个穿着" },
    {
      kind: "media_reference",
      mentionId: "mention-1",
      target: {
        kind: "asset",
        providerConnectionId: "provider-1",
        assetId: "asset-1",
        mediaType: "image",
      },
      displayNameSnapshot: "参考图A",
      typePosition: 1,
      contentIndex: 1,
    },
    { kind: "text", text: "的插画" },
  ],
  explicitMedia: [
    {
      target: {
        kind: "asset",
        providerConnectionId: "provider-1",
        assetId: "asset-1",
        mediaType: "image",
      },
      role: "",
      displayNameSnapshot: "参考图A",
      typePosition: 1,
      contentIndex: 1,
    },
  ],
  parameters: { size: "1:1" },
  generationCount: 1,
};

const REGEN_DETAIL: GenerationTaskDetail = {
  summary: REGEN_SUMMARY,
  logicalRequest: REGEN_LOGICAL_REQUEST,
  resolvedRequest: {},
  attempts: [],
  calls: [],
  events: [],
  results: [],
  textOutput: null,
  finalError: null,
};

describe("HistoryDialog regeneration", () => {
  it("regenerates the original task from its frozen request", async () => {
    const client = createClient(REGEN_DETAIL);
    render(<HistoryDialog open onClose={vi.fn()} client={client} />);

    await screen.findByText("任务概要");
    fireEvent.click(screen.getByRole("button", { name: /直接重新生成/ }));

    await waitFor(() => expect(client.start).toHaveBeenCalledTimes(1));
    expect(client.start).toHaveBeenCalledWith({
      canvasId: "canvas-1",
      sourceNodeId: "node-1",
      operation: "text_to_image",
      providerConnectionId: "provider-1",
      modelDefinitionId: "remote::provider-1::image-model",
      prompt: REGEN_LOGICAL_REQUEST.prompt,
      explicitMedia: REGEN_LOGICAL_REQUEST.explicitMedia,
      parameters: { size: "1:1" },
      generationCount: 1,
    });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("已创建新的生成任务"));
  });

  it("edits the prompt, drops a material, and regenerates with the updated request", async () => {
    const client = createClient(REGEN_DETAIL);
    render(<HistoryDialog open onClose={vi.fn()} client={client} />);

    await screen.findByText("任务概要");
    fireEvent.click(screen.getByRole("button", { name: /修改后重新生成/ }));
    const dialog = await screen.findByRole("dialog", { name: "修改后重新生成" });

    // 提示词以高亮引用 chip 呈现；素材列表行与编辑器 chip 各出现一次名称。
    const chip = await within(dialog).findByText(/@参考图A/);
    expect(chip).toBeInTheDocument();
    expect(within(dialog).getByText("参考图A")).toBeInTheDocument();

    // 把「的插画」改成「的旗袍插画」。
    const editor = within(dialog).getByRole("textbox", { name: "提示词" });
    const paragraph = editor.querySelector("p");
    const trailing = paragraph?.childNodes[2] as Text | undefined;
    expect(trailing?.data).toBe("的插画");
    await compositionMutation(editor, trailing!, "的旗袍插画");

    fireEvent.click(within(dialog).getByRole("button", { name: /移除素材/ }));
    expect(within(dialog).queryByText(/@参考图A/)).not.toBeInTheDocument();
    expect(within(dialog).queryByText("参考图A")).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "重新生成" }));

    await waitFor(() => expect(client.start).toHaveBeenCalledTimes(1));
    const command = vi.mocked(client.start).mock.calls[0]![0];
    expect(
      command.prompt
        .map((s) => (s.kind === "text" ? s.text : `@${s.displayNameSnapshot}`))
        .join(""),
    ).toBe("一个穿着的旗袍插画");
    expect(command.explicitMedia).toEqual([]);
    expect(command.canvasId).toBe("canvas-1");
    expect(command.sourceNodeId).toBe("node-1");
    expect(command.parameters).toEqual({ size: "1:1" });
  });

  it("keeps an added material as an explicit input without referencing it in the prompt", async () => {
    const client = createClient(REGEN_DETAIL);
    render(<HistoryDialog open onClose={vi.fn()} client={client} />);

    await screen.findByText("任务概要");
    fireEvent.click(screen.getByRole("button", { name: /修改后重新生成/ }));
    const dialog = await screen.findByRole("dialog", { name: "修改后重新生成" });
    await within(dialog).findByText(/@参考图A/);

    fireEvent.click(within(dialog).getByText("添加素材"));
    fireEvent.click(within(dialog).getByRole("tab", { name: "链接" }));
    fireEvent.change(within(dialog).getByLabelText("链接素材名称"), {
      target: { value: "参考网页" },
    });
    fireEvent.change(within(dialog).getByLabelText("链接素材地址"), {
      target: { value: "https://example.com/reference" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "添加链接素材" }));

    expect(within(dialog).getByText("参考网页")).toBeInTheDocument();
    expect(within(dialog).getByText("素材（2）")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "重新生成" }));

    await waitFor(() => expect(client.start).toHaveBeenCalledTimes(1));
    const command = vi.mocked(client.start).mock.calls[0]![0];
    expect(
      command.prompt
        .map((s) => (s.kind === "text" ? s.text : `@${s.displayNameSnapshot}`))
        .join(""),
    ).toBe("一个穿着@参考图A的插画");
    expect(command.explicitMedia).toHaveLength(2);
    expect(command.explicitMedia![0]!.target).toMatchObject({ kind: "asset", assetId: "asset-1" });
    expect(command.explicitMedia![1]!.target).toMatchObject({
      kind: "url",
      url: "https://example.com/reference",
      mediaType: "image",
    });
  });

  it("shows a snapshot warning for tasks without a usable frozen request", async () => {
    const client = createClient(DETAIL);
    render(<HistoryDialog open onClose={vi.fn()} client={client} />);

    await screen.findByText("任务概要");
    expect(screen.getByText("该任务缺少可用的请求快照，无法重新生成。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /重新生成/ })).not.toBeInTheDocument();
  });
});

/**
 * jsdom 没有操作系统 IME。保留真实 Tiptap 视图与 DOMObserver，只模拟浏览器的文本变更。
 * （与 PromptNodeViews.ime.test.tsx 共用同一套注入方式。）
 */
function setCaret(text: Text, offset: number) {
  const range = document.createRange();
  range.setStart(text, offset);
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

async function compositionMutation(input: HTMLElement, text: Text, value: string) {
  await act(async () => {
    text.data = value;
    setCaret(text, value.length);
    input.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertCompositionText",
        data: value,
        isComposing: true,
      }),
    );
    await Promise.resolve();
  });
}
