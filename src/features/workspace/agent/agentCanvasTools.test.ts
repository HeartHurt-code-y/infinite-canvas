import { describe, expect, it, vi } from "vitest";
import type { GenerationTaskSummary } from "../../../lib/backend";
import { createAgentCanvasTools, type AgentCanvasHost } from "./agentCanvasTools";
import type { AgentToolContext } from "./agentTypes";

function taskSummary(patch: Partial<GenerationTaskSummary> = {}): GenerationTaskSummary {
  return {
    id: "task-1",
    canvasId: "canvas-a",
    sourceNodeId: "node-1",
    operation: "video_generation",
    status: "running",
    queryHealth: "healthy",
    providerConnectionId: "provider",
    providerDisplayNameSnapshot: "创作供应商",
    modelDefinitionId: "video-model",
    remoteModelIdSnapshot: null,
    remoteTaskId: null,
    progress: 40,
    tokens: null,
    createdAt: 100,
    updatedAt: 200,
    completedAt: null,
    ...patch,
  };
}

function harness(history: readonly GenerationTaskSummary[] = []) {
  const disconnect = vi.fn();
  const removeNode = vi.fn(() => ({ removedEdges: 2 }));
  const setGenerationCount = vi.fn();
  const setParameters = vi.fn();
  const historyList = vi.fn(() => Promise.resolve(history));
  const host: AgentCanvasHost = {
    context: () => ({}),
    createNode: () => "created",
    setPrompt: () => {},
    setModel: () => {},
    setParameters,
    connect: () => {},
    disconnect,
    removeNode,
    setGenerationCount,
    history: historyList,
    move: () => {},
    generate: () => Promise.resolve({}),
  };
  const tools = createAgentCanvasTools(host);
  const context: AgentToolContext = {
    signal: new AbortController().signal,
    callId: "step-1",
    report: vi.fn(),
    resolveNodeKey: (key) => (key === "$n1" ? "node-1" : key),
    assertCurrent: () => {},
    mutate: (change) => change(),
  };
  return {
    tools,
    context,
    disconnect,
    removeNode,
    setGenerationCount,
    setParameters,
    historyList,
    tool: (name: string) => tools.find((item) => item.name === name)!,
  };
}

describe("智能体画布增删工具", () => {
  it("删除节点前解析引用并回传移除的连线数", async () => {
    const view = harness();
    const result = await view.tool("canvas.delete_node").execute({ nodeKey: "$n1" }, view.context);

    expect(view.removeNode).toHaveBeenCalledWith("node-1");
    expect(result).toEqual({ nodeKey: "node-1", deleted: true, removedEdges: 2 });
  });

  it("断开连线解析两端引用后交给宿主", async () => {
    const view = harness();
    const result = await view
      .tool("canvas.disconnect")
      .execute({ fromKey: "$n1", toKey: "node-2" }, view.context);

    expect(view.disconnect).toHaveBeenCalledWith("node-1", "node-2");
    expect(result).toMatchObject({ fromKey: "node-1", toKey: "node-2", disconnected: true });
  });

  it("生成数量只接受 1~4 的整数", async () => {
    const view = harness();
    await view
      .tool("canvas.set_generation_count")
      .execute({ nodeKey: "node-1", count: 4 }, view.context);
    expect(view.setGenerationCount).toHaveBeenCalledWith("node-1", 4);

    for (const count of [0, 5, 2.5]) {
      expect(() =>
        view.tool("canvas.set_generation_count").validate({ nodeKey: "node-1", count }),
      ).toThrow();
      expect(view.setGenerationCount).toHaveBeenCalledTimes(1);
    }
  });
});

describe("智能体生成参数工具", () => {
  it("解析节点引用后把参数表交给宿主", async () => {
    const view = harness();
    const result = await view
      .tool("canvas.set_parameters")
      .execute({ nodeKey: "$n1", parameters: { ratio: "16:9", duration: 5 } }, view.context);

    expect(view.setParameters).toHaveBeenCalledWith("node-1", { ratio: "16:9", duration: 5 });
    expect(result).toEqual({
      nodeKey: "node-1",
      parameters: { ratio: "16:9", duration: 5 },
      updated: true,
    });
  });

  it("空参数表、非原始值与未知字段在校验期拒绝", () => {
    const view = harness();
    const validate = (args: unknown) =>
      view.tool("canvas.set_parameters").validate(args);

    expect(() => validate({ nodeKey: "node-1", parameters: {} })).toThrow();
    expect(() => validate({ nodeKey: "node-1", parameters: { duration: [5] } })).toThrow();
    expect(() =>
      validate({ nodeKey: "node-1", parameters: { duration: "5" }, extra: 1 }),
    ).toThrow();
    expect(() => validate({ nodeKey: "node-1", parameters: { ratio: "16:9" } })).not.toThrow();
  });

  it("create_node 接受剧本、分镜、合成与抽帧新种类，未知种类拒绝", () => {
    const view = harness();
    for (const kind of [
      "screenplay",
      "storyboard",
      "video_composer",
      "frame_extractor",
      "image",
      "video",
      "prompt",
    ]) {
      expect(() => view.tool("canvas.create_node").validate({ kind })).not.toThrow();
    }
    expect(() => view.tool("canvas.create_node").validate({ kind: "white_model" })).toThrow();
    expect(() => view.tool("canvas.create_node").validate({ kind: "knowledge" })).toThrow();
  });
});

describe("智能体生成任务查询", () => {
  it("默认查询 8 条并带出可读状态；可按节点筛选", async () => {
    const view = harness([
      taskSummary({ status: "succeeded", progress: 100, completedAt: 300 }),
      taskSummary({ id: "task-2", sourceNodeId: "node-2", status: "interrupted" }),
    ]);
    const result = (await view.tool("generation.history").execute({}, view.context)) as {
      tasks: ReadonlyArray<Record<string, unknown>>;
    };

    expect(view.historyList).toHaveBeenCalledWith(null, 8);
    expect(result.tasks[0]).toMatchObject({
      taskId: "task-1",
      nodeKey: "node-1",
      status: "succeeded",
      statusText: "已完成",
    });
    expect(result.tasks[1]).toMatchObject({
      status: "interrupted",
      statusText: "已中断，可在任务历史中恢复",
    });
  });

  it("节点引用解析成稳定身份后查询，条数上限 20", async () => {
    const view = harness();
    await view.tool("generation.history").execute({ nodeKey: "$n1", limit: 20 }, view.context);

    expect(view.historyList).toHaveBeenCalledWith("node-1", 20);
    expect(() => view.tool("generation.history").validate({ limit: 21 })).toThrow();
  });
});
