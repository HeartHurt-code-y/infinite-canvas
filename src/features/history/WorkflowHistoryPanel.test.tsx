import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { GenerationTaskClient } from "../../lib/backend";
import type {
  WorkflowHistoryClient,
  WorkflowHistoryDetail,
  WorkflowHistoryRecord,
} from "../../lib/workflowHistory";
import { completedTask, node } from "../../test/videoWorkflowFixtures";
import { HistoryDialog } from "./HistoryDialog";
import { WorkflowHistoryPanel } from "./WorkflowHistoryPanel";
import {
  createReverseVideoCheckpoint,
  createReverseVideoOptions,
} from "../workspace/reverseVideoWorkflowModel";

function record(
  status: WorkflowHistoryRecord["status"] = "failed",
  id = "workflow-history-1",
): WorkflowHistoryRecord {
  const snapshot = node();
  return {
    id,
    canvasId: "canvas-1",
    sourceNodeId: snapshot.key,
    workflowKind: "knowledge",
    title: `RAG 知识视频 ${id}`,
    status,
    progress: 42,
    message: "镜头 3 已生成，等待质检",
    error: status === "failed" ? "供应商请求超时，镜头 1、2 已保存。" : null,
    nodeSnapshot: {
      ...snapshot,
      config: {
        ...snapshot.config,
        checkpoint: {
          ...snapshot.config.checkpoint,
          phase: status,
          script: "## 已保存脚本\n\n第一段：什么是 RAG",
          shotRuns: {
            "01": {
              shotId: "01",
              clipPath: "C:\\output\\shot-01.mp4",
              retryCount: 0,
              qcStatus: "passed",
            },
          },
        },
      },
    },
    models: [
      {
        role: "text",
        providerId: "provider-1",
        providerName: "项目文本供应商",
        modelDefinitionId: "text-model",
        modelName: "策划模型",
      },
    ],
    attemptCount: 2,
    revision: 5,
    createdAt: 1_788_000_000_000,
    updatedAt: 1_788_000_003_000,
  };
}

function details(item = record()): WorkflowHistoryDetail {
  return {
    record: item,
    events: [
      {
        id: "event-1",
        phase: "generating",
        progress: 42,
        message: "保存镜头 2 的视频",
        error: null,
        createdAt: item.updatedAt,
      },
    ],
    tasks: [completedTask("image-linked").summary],
  };
}

function createClient(detail = details()) {
  return {
    list: vi.fn<WorkflowHistoryClient["list"]>(() =>
      Promise.resolve({ items: [detail.record], nextCursor: null }),
    ),
    get: vi.fn<WorkflowHistoryClient["get"]>(() => Promise.resolve(detail)),
    save: vi.fn<WorkflowHistoryClient["save"]>((command) => Promise.resolve(command.record)),
    recover: vi.fn<WorkflowHistoryClient["recover"]>(() => Promise.resolve(0)),
  };
}

describe("WorkflowHistoryPanel", () => {
  it("跨画布范围不按画布过滤，并在行上标注归属画布", async () => {
    const client = createClient();
    render(
      <WorkflowHistoryPanel
        client={client}
        canvasLabel={(id) => (id === "canvas-1" ? "画布甲" : null)}
        onSelectGenerationTask={vi.fn()}
      />,
    );

    await screen.findByText("RAG 知识视频 workflow-history-1", {
      selector: ".history-item__title",
    });
    // 不传 canvasId 即全部画布：查询里不带画布过滤，后端 (?1 IS NULL OR canvas_id=?1) 不过滤。
    expect(client.list).toHaveBeenCalledWith({ limit: 30 });
    const chip = screen.getByText("画布甲");
    expect(chip).toHaveClass("history-item__canvas");
    expect(chip).toHaveAttribute("title", "画布：画布甲");
  });

  it("没有归属标注回调时行上不渲染画布名", async () => {
    const client = createClient();
    render(
      <WorkflowHistoryPanel client={client} canvasId="canvas-1" onSelectGenerationTask={vi.fn()} />,
    );

    await screen.findByText("RAG 知识视频 workflow-history-1", {
      selector: ".history-item__title",
    });
    expect(client.list).toHaveBeenCalledWith({ canvasId: "canvas-1", limit: 30 });
    expect(document.querySelector(".history-item__canvas")).toBeNull();
  });

  it("combines creation-time bounds with canvas and status filters and keeps them on later pages", async () => {
    const client = createClient();
    render(
      <WorkflowHistoryPanel client={client} canvasId="canvas-1" onSelectGenerationTask={vi.fn()} />,
    );
    await screen.findByText("RAG 知识视频 workflow-history-1", {
      selector: ".history-item__title",
    });
    fireEvent.change(screen.getByLabelText("开始时间"), {
      target: { value: "2026-09-01T01:02:03" },
    });
    fireEvent.change(screen.getByLabelText("结束时间"), {
      target: { value: "2026-09-06T04:05:06" },
    });
    client.list.mockResolvedValueOnce({ items: [record()], nextCursor: "30" });
    fireEvent.click(screen.getByRole("button", { name: /^查询$/ }));
    const range = {
      createdFrom: new Date(2026, 8, 1, 1, 2, 3).getTime(),
      createdTo: new Date(2026, 8, 6, 4, 5, 6, 999).getTime(),
    };
    await waitFor(() =>
      expect(client.list).toHaveBeenLastCalledWith({ ...range, canvasId: "canvas-1", limit: 30 }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "加载更多工作流" }));
    await waitFor(() =>
      expect(client.list).toHaveBeenLastCalledWith({
        ...range,
        canvasId: "canvas-1",
        limit: 30,
        cursor: "30",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /^失败$/ }));
    await waitFor(() =>
      expect(client.list).toHaveBeenLastCalledWith({
        ...range,
        canvasId: "canvas-1",
        statuses: ["failed"],
        limit: 30,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /^重置$/ }));
    await waitFor(() =>
      expect(client.list).toHaveBeenLastCalledWith({
        canvasId: "canvas-1",
        statuses: ["failed"],
        limit: 30,
      }),
    );
  });

  it("keeps reverse workflow case and MD/TXT delivery available independently of its canvas node", async () => {
    const previous = record("done");
    const item: WorkflowHistoryRecord = {
      ...previous,
      workflowKind: "reverseVideo",
      title: "短视频反推案例",
      nodeSnapshot: {
        ...previous.nodeSnapshot,
        config: {
          ...previous.nodeSnapshot.config,
          reverseVideo: createReverseVideoOptions(),
          checkpoint: {
            ...previous.nodeSnapshot.config.checkpoint,
            reverseVideo: {
              ...createReverseVideoCheckpoint(),
              videoPath: "C:\\results\\original.mp4",
              step: "done",
              delivery: {
                caseId: "case-01",
                directory: "C:\\results",
                videoPath: "C:\\results\\original.mp4",
                markdownPath: "C:\\results\\prompt.md",
                textPath: "C:\\results\\prompt.txt",
                casePath: "C:\\results\\case.json",
                caseCount: 3,
              },
            },
          },
        },
      },
    };
    render(
      <WorkflowHistoryPanel
        client={createClient(details(item))}
        onSelectGenerationTask={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByText("查看已入库案例与交付文件"));
    expect(await screen.findByRole("button", { name: "打开纯文本提示词 TXT" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开反推文档 MD" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开案例档案" })).toBeInTheDocument();
    expect(screen.getByText(/案例 case-01 · 入库时共 3 条案例/)).toBeInTheDocument();
  });

  it("shows stored inputs, models, stage events and lazy documents/checkpoints", async () => {
    const client = createClient();
    render(
      <WorkflowHistoryPanel client={client} canvasId="canvas-1" onSelectGenerationTask={vi.fn()} />,
    );
    expect(
      await screen.findByRole("heading", { name: "RAG 知识视频 workflow-history-1" }),
    ).toBeInTheDocument();
    expect(client.list).toHaveBeenCalledWith({ canvasId: "canvas-1", limit: 30 });
    expect(screen.getByText("面向销售新人制作一条 RAG 入门视频")).toBeInTheDocument();
    expect(screen.getByText("项目文本供应商 · 策划模型")).toBeInTheDocument();
    expect(screen.getByText("保存镜头 2 的视频")).toBeInTheDocument();
    expect(screen.getByText("供应商请求超时，镜头 1、2 已保存。")).toBeInTheDocument();
    expect(screen.queryByText("第一段：什么是 RAG")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("查看制作文档"));
    expect(await screen.findByText("第一段：什么是 RAG")).toBeInTheDocument();
    fireEvent.click(screen.getByText("已保留媒体（1）"));
    expect(await screen.findByLabelText("镜头 01")).toHaveAttribute(
      "src",
      expect.stringContaining("shot-01.mp4"),
    );
    fireEvent.click(screen.getByText("查看完整断点与历史版本"));
    expect(await screen.findByText(/"clipPath":/)).toHaveTextContent("shot-01.mp4");
  });

  it("retries from the archived checkpoint once and reports failures without hiding saved results", async () => {
    let rejectAction!: (error: Error) => void;
    const onResumeWorkflow = vi.fn(
      () =>
        new Promise<void>((_, reject) => {
          rejectAction = reject;
        }),
    );
    const onRestartWorkflow = vi.fn();
    render(
      <WorkflowHistoryPanel
        client={createClient()}
        onResumeWorkflow={onResumeWorkflow}
        onRestartWorkflow={onRestartWorkflow}
        onSelectGenerationTask={vi.fn()}
      />,
    );
    const retry = await screen.findByRole("button", { name: "重试当前步骤" });
    fireEvent.click(retry);
    fireEvent.click(retry);
    expect(onResumeWorkflow).toHaveBeenCalledOnce();
    expect(onResumeWorkflow).toHaveBeenCalledWith(record(), undefined);
    expect(screen.getByRole("button", { name: "重新制作" })).toBeDisabled();
    await act(() => {
      rejectAction(new Error("无法恢复：缺少原始参考图"));
      return Promise.resolve();
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("无法恢复：缺少原始参考图");
    expect(screen.getByRole("button", { name: "重试当前步骤" })).toBeEnabled();
    expect(screen.getByText("已保留媒体（1）")).toBeInTheDocument();
  });

  it.each(["paused", "awaiting_approval"] as const)(
    "resumes %s with an IME-safe decision when required",
    async (status) => {
      const source = record(status);
      const item = {
        ...source,
        nodeSnapshot: {
          ...source.nodeSnapshot,
          config: {
            ...source.nodeSnapshot.config,
            checkpoint: {
              ...source.nodeSnapshot.config.checkpoint,
              decision: {
                kind: "planning" as const,
                question: "以哪个受众为准？",
                recommendation: "面向学生",
              },
            },
          },
        },
      };
      const onResumeWorkflow = vi.fn(() => Promise.resolve());
      render(
        <WorkflowHistoryPanel
          client={createClient(details(item))}
          onResumeWorkflow={onResumeWorkflow}
          onSelectGenerationTask={vi.fn()}
        />,
      );
      if (status === "awaiting_approval") {
        const input = await screen.findByRole("textbox", { name: "历史工作流决策" });
        fireEvent.compositionStart(input);
        fireEvent.change(input, { target: { value: "zhong'xue" } });
        expect(onResumeWorkflow).not.toHaveBeenCalled();
        fireEvent.change(input, { target: { value: "面向中学生" } });
        fireEvent.compositionEnd(input, { data: "面向中学生" });
        fireEvent.click(screen.getByRole("button", { name: "确认后续跑" }));
        expect(onResumeWorkflow).toHaveBeenCalledWith(item, "面向中学生");
      } else {
        fireEvent.click(await screen.findByRole("button", { name: "从断点继续" }));
        expect(onResumeWorkflow).toHaveBeenCalledWith(item, undefined);
      }
      await waitFor(() =>
        expect(screen.getByRole("status")).toHaveTextContent("已请求从保存的步骤继续。"),
      );
    },
  );

  it("starts a new run from completed history and hides mutating actions for active runs", async () => {
    const source = record("done");
    const onRestartWorkflow = vi.fn(() => Promise.resolve());
    const onLocateWorkflow = vi.fn();
    const props = {
      client: createClient(details(source)),
      onRestartWorkflow,
      onLocateWorkflow,
      onResumeWorkflow: vi.fn(),
      onSelectGenerationTask: vi.fn(),
    };
    const { rerender } = render(<WorkflowHistoryPanel {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "重新制作" }));
    expect(onRestartWorkflow).toHaveBeenCalledWith(source);
    await waitFor(() => expect(screen.getByRole("button", { name: "重新制作" })).toBeEnabled());
    rerender(<WorkflowHistoryPanel {...props} activeWorkflowIds={[source.id]} />);
    expect(screen.queryByRole("button", { name: "重新制作" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "从断点继续" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "定位到画布" }));
    expect(onLocateWorkflow).toHaveBeenCalledWith(source);
  });

  it("filters, paginates without duplicates and refreshes a selected run", async () => {
    const first = record();
    const second = record("paused", "workflow-history-2");
    const client = createClient();
    client.list = vi.fn<WorkflowHistoryClient["list"]>((query) =>
      Promise.resolve({
        items: query.statuses ? [second] : query.cursor ? [first, second] : [first],
        nextCursor: query.statuses || query.cursor ? null : "cursor-1",
      }),
    );
    client.get = vi.fn<WorkflowHistoryClient["get"]>((id) =>
      Promise.resolve(details(id === second.id ? second : first)),
    );
    render(<WorkflowHistoryPanel client={client} onSelectGenerationTask={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "加载更多工作流" }));
    const list = screen.getByRole("complementary", { name: "工作流历史列表" });
    expect(
      await within(list).findByRole("button", { name: /RAG 知识视频 workflow-history-2/ }),
    ).toBeInTheDocument();
    expect(
      within(list).getAllByRole("button", { name: /RAG 知识视频 workflow-history-1/ }),
    ).toHaveLength(1);
    expect(client.list).toHaveBeenCalledWith({ cursor: "cursor-1", limit: 30 });
    fireEvent.click(within(list).getByRole("button", { name: "待处理" }));
    expect(await screen.findByRole("heading", { name: second.title })).toBeInTheDocument();
    expect(client.list).toHaveBeenLastCalledWith({
      statuses: ["paused", "awaiting_approval"],
      limit: 30,
    });
    fireEvent.click(screen.getByRole("button", { name: "刷新详情" }));
    await waitFor(() => expect(client.get).toHaveBeenLastCalledWith(second.id));
    fireEvent.click(within(list).getByRole("button", { name: "待处理" }));
    expect(screen.queryByText("正在加载工作流历史…")).not.toBeInTheDocument();
  });

  it("recovers from list and detail read errors through explicit refresh", async () => {
    const client = createClient();
    client.list = vi
      .fn<WorkflowHistoryClient["list"]>()
      .mockRejectedValueOnce(new Error("历史读取失败"))
      .mockResolvedValue({ items: [record()], nextCursor: null });
    client.get = vi
      .fn<WorkflowHistoryClient["get"]>()
      .mockRejectedValueOnce(new Error("详情暂时不可用"))
      .mockResolvedValue(details());
    render(<WorkflowHistoryPanel client={client} onSelectGenerationTask={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("历史读取失败");
    fireEvent.click(screen.getByRole("button", { name: "刷新工作流历史" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("详情暂时不可用");
    fireEvent.click(screen.getByRole("button", { name: "重试读取详情" }));
    expect(await screen.findByRole("heading", { name: record().title })).toBeInTheDocument();
  });

  it("opens a linked generation task without the generation first page replacing its detail", async () => {
    const other = completedTask("video-unrelated");
    const linked = {
      ...completedTask("image-linked"),
      logicalRequest: { prompt: [{ kind: "text", text: "这是工作流关联图片的提示词" }] },
    };
    const generation: GenerationTaskClient = {
      start: vi.fn(),
      list: vi.fn(() => Promise.resolve({ items: [other.summary], nextCursorCreatedBefore: null })),
      get: vi.fn((id) => Promise.resolve(id === linked.summary.id ? linked : other)),
      queryVideoTaskNow: vi.fn(),
    };
    render(
      <HistoryDialog
        open
        initialTab="workflow"
        initialWorkflowId="workflow-history-1"
        client={generation}
        workflowClient={createClient()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /图片.*project-image.*image-linked/ }),
    );
    expect(await screen.findByText("这是工作流关联图片的提示词")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "生成任务", selected: true })).toBeInTheDocument();
    expect(generation.get).toHaveBeenLastCalledWith("image-linked");
    fireEvent.click(screen.getByRole("tab", { name: "工作流" }));
    expect(screen.getByRole("heading", { name: record().title })).toBeInTheDocument();
  });

  it("切到「全部画布」后工作流历史不再按画布过滤", async () => {
    const workflow = createClient();
    const generation: GenerationTaskClient = {
      start: vi.fn(),
      list: vi.fn(() => Promise.resolve({ items: [], nextCursorCreatedBefore: null })),
      get: vi.fn(),
      queryVideoTaskNow: vi.fn(),
    };
    render(
      <HistoryDialog
        open
        initialTab="workflow"
        canvasId="canvas-1"
        client={generation}
        workflowClient={workflow}
        onClose={vi.fn()}
      />,
    );

    await screen.findByText("RAG 知识视频 workflow-history-1", {
      selector: ".history-item__title",
    });
    expect(workflow.list).toHaveBeenLastCalledWith({ canvasId: "canvas-1", limit: 30 });

    // 范围切换在弹窗头部，作用到工作流历史；查询里不再带画布过滤。
    fireEvent.click(screen.getByRole("radio", { name: "全部画布" }));
    await waitFor(() => expect(workflow.list).toHaveBeenLastCalledWith({ limit: 30 }));
  });
});
