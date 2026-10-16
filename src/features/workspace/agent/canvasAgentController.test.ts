import { describe, expect, it, vi } from "vitest";
import type { NodeModelSelection } from "../workspaceModel";
import type { AgentAction, AgentTool, AgentToolContext } from "./agentTypes";
import { CanvasAgentController, type CanvasAgentHost } from "./canvasAgentController";

const model: NodeModelSelection = { providerId: "provider", modelDefinitionId: "text-model" };
const createAction = (patch: Partial<AgentAction> = {}): AgentAction => ({
  id: "create-1",
  tool: "canvas.create",
  args: { label: "小人白模" },
  dependsOn: [],
  ...patch,
});
const reply = (actions: readonly AgentAction[]) => JSON.stringify({ message: "制作计划", actions });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function harness() {
  let revision = 1;
  let available = true;
  const writes = vi.fn();
  const read = vi.fn(() => Promise.resolve({ nodes: [] }));
  const execute = vi.fn((_args: unknown, context: AgentToolContext) => {
    const nodeKey = context.mutate(() => {
      revision++;
      writes();
      return `node-${revision}`;
    });
    return Promise.resolve({ nodeKey });
  });
  const save = vi.fn(() => Promise.resolve());
  const ask = vi.fn<CanvasAgentHost["ask"]>(() => Promise.resolve(reply([createAction()])));
  const host: CanvasAgentHost = {
    signature: () => `canvas-a:${revision}`,
    context: () => ({ canvasId: "canvas-a", revision }),
    available: () => available,
    save,
    ask,
    tools: [
      {
        name: "canvas.create",
        title: "创建节点",
        description: "创建可编辑白模节点",
        effect: "write",
        inputSchema: { type: "object" },
        validate(args) {
          if (
            !args ||
            typeof args !== "object" ||
            !("label" in args) ||
            typeof args.label !== "string"
          ) {
            throw new Error("label 必须为字符串");
          }
        },
        execute,
      },
      {
        name: "canvas.read",
        title: "读取画布",
        description: "读取当前节点",
        effect: "read",
        inputSchema: { type: "object" },
        validate() {},
        execute: read,
      },
    ],
  };
  const controller = new CanvasAgentController();
  controller.configure(host);
  controller.restore({ version: 1, expanded: true, model, messages: [], status: "idle" });
  return {
    controller,
    host,
    writes,
    execute,
    read,
    ask,
    save,
    edit: () => {
      revision++;
    },
    switchCanvas: () => {
      available = false;
    },
  };
}

describe("画布智能体执行边界", () => {
  it.each([
    ["未知工具", [createAction({ tool: "shell.run" })], "未注册"],
    ["非法参数", [createAction({ args: { label: 42 } })], "label 必须为字符串"],
    [
      "未声明节点依赖",
      [createAction({ args: { label: "有效", nodeKey: "$missing" } })],
      "前序依赖",
    ],
    [
      "循环依赖",
      [
        createAction({ dependsOn: ["create-2"] }),
        createAction({ id: "create-2", dependsOn: ["create-1"] }),
      ],
      "循环依赖",
    ],
  ] as const)("%s 使整份计划在执行前被拒绝", async (_label, invalidActions, errorText) => {
    const view = harness();
    view.ask.mockResolvedValue(
      reply([
        { id: "read-first", tool: "canvas.read", args: {}, dependsOn: [] },
        ...invalidActions,
      ]),
    );
    await view.controller.send("请制作白模");

    expect(view.ask).toHaveBeenCalledTimes(2);
    expect(view.read).not.toHaveBeenCalled();
    expect(view.execute).not.toHaveBeenCalled();
    expect(view.controller.getState()).toMatchObject({ status: "idle", pending: null });
    expect(view.controller.getState().error).toContain(errorText);
  });

  it("模型省略 args/dependsOn 或显式置 null 时计划照常成立，不消耗修正轮", async () => {
    const view = harness();
    view.ask.mockResolvedValue(
      JSON.stringify({
        message: "制作计划",
        actions: [
          { id: "read-1", tool: "canvas.read" },
          { id: "create-1", tool: "canvas.create", args: { label: "小人白模" }, dependsOn: null },
        ],
      }),
    );
    await view.controller.send("请创建白模");

    expect(view.ask).toHaveBeenCalledTimes(1);
    expect(view.controller.getState().pending?.actions).toEqual([
      { id: "read-1", tool: "canvas.read", args: {}, dependsOn: [] },
      { id: "create-1", tool: "canvas.create", args: { label: "小人白模" }, dependsOn: [] },
    ]);
    expect(view.controller.getState().error).toBeNull();
  });

  it("模型省略 actions 键时按纯文字答复收尾，不消耗修正轮", async () => {
    const view = harness();
    view.ask.mockResolvedValue(
      JSON.stringify({ message: "下载引擎已就绪，本轮无需执行步骤。" }),
    );
    await view.controller.send("查询下载引擎");

    expect(view.ask).toHaveBeenCalledTimes(1);
    expect(view.controller.getState()).toMatchObject({ status: "idle", pending: null, error: null });
    expect(view.controller.getState().messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "下载引擎已就绪，本轮无需执行步骤。",
    });
  });

  it("写入必须先批准，批准按钮并发点击和完成后再点都不会重复执行", async () => {
    const view = harness();
    await view.controller.send("请创建小人白模");
    expect(view.controller.getState().pending?.actions).toEqual([createAction()]);
    expect(view.execute).not.toHaveBeenCalled();
    const gate = deferred<{ nodeKey: string }>();
    view.execute.mockImplementationOnce((_args, context) => {
      context.mutate(view.writes);
      return gate.promise;
    });

    const firstClick = view.controller.approve();
    const secondClick = view.controller.approve();
    await vi.waitFor(() => expect(view.execute).toHaveBeenCalledTimes(1));
    expect(view.writes).toHaveBeenCalledTimes(1);
    gate.resolve({ nodeKey: "node-a" });
    await Promise.all([firstClick, secondClick]);
    await view.controller.approve();

    expect(view.execute).toHaveBeenCalledTimes(1);
    expect(view.ask).toHaveBeenCalledTimes(1);
    expect(view.controller.getState()).toMatchObject({
      status: "idle",
      pending: null,
      error: null,
    });
  });

  it("用户在批准前改变画布会使旧计划失效", async () => {
    const view = harness();
    await view.controller.send("创建白模");
    view.edit();
    await view.controller.approve();

    expect(view.execute).not.toHaveBeenCalled();
    expect(view.controller.getState().pending).toBeNull();
    expect(view.controller.getState().error).toContain("确认已失效");
  });

  it.each(["stop", "switch"] as const)(
    "%s 后模型晚返回也不会查询、写入或留下可批准计划",
    async (action) => {
      const view = harness();
      const gate = deferred<string>();
      view.ask.mockReturnValueOnce(gate.promise);
      const running = view.controller.send("制作白模");
      await vi.waitFor(() => expect(view.ask).toHaveBeenCalledTimes(1));
      if (action === "stop") view.controller.stop();
      else view.switchCanvas();
      gate.resolve(reply([{ id: "read", tool: "canvas.read", args: {}, dependsOn: [] }]));
      await running;

      expect(view.read).not.toHaveBeenCalled();
      expect(view.execute).not.toHaveBeenCalled();
      expect(view.controller.getState()).toMatchObject({ status: "idle", pending: null });
      expect(view.controller.getState().error).toContain(action === "stop" ? "停止" : "当前画布");
    },
  );

  it("已批准工具的异步等待跨过画布切换后不能写入新画布", async () => {
    const view = harness();
    await view.controller.send("创建白模");
    const gate = deferred<void>();
    view.execute.mockImplementationOnce(async (_args, context) => {
      await gate.promise;
      context.mutate(view.writes);
      return { nodeKey: "wrong-canvas-node" };
    });
    const running = view.controller.approve();
    await vi.waitFor(() => expect(view.execute).toHaveBeenCalledTimes(1));
    view.switchCanvas();
    gate.resolve();
    await running;

    expect(view.writes).not.toHaveBeenCalled();
    expect(view.controller.getState().error).toContain("当前画布");
    expect(
      view.controller
        .getState()
        .messages.some((item) => item.role === "tool" && item.content.startsWith("创建节点：")),
    ).toBe(false);
    expect(
      view.controller
        .getState()
        .messages.some((item) => item.content.startsWith("本轮未全部完成：")),
    ).toBe(true);
  });

  it("download 效果需要批准，且同一计划允许多个下载步骤", async () => {
    const view = harness();
    const runs = vi.fn(() => Promise.resolve({ downloaded: true }));
    (view.host.tools as AgentTool[]).push({
      name: "video_download.start",
      title: "下载链接视频",
      description: "从链接下载视频",
      effect: "download",
      inputSchema: { type: "object" },
      validate() {},
      execute: runs,
    });
    view.ask.mockResolvedValue(
      reply([
        {
          id: "dl-1",
          tool: "video_download.start",
          args: { url: "https://a.example/x" },
          dependsOn: [],
        },
        {
          id: "dl-2",
          tool: "video_download.start",
          args: { url: "https://b.example/y" },
          dependsOn: [],
        },
      ]),
    );
    await view.controller.send("下载两个视频");

    expect(view.controller.getState().pending?.actions).toHaveLength(2);
    expect(runs).not.toHaveBeenCalled();
    await view.controller.approve();

    expect(runs).toHaveBeenCalledTimes(2);
    expect(view.controller.getState()).toMatchObject({
      status: "idle",
      pending: null,
      error: null,
    });
  });

  it("首次存档失败不会调用模型", async () => {
    const view = harness();
    view.save.mockRejectedValueOnce(new Error("磁盘不可写"));
    await view.controller.send("制作白模");

    expect(view.ask).not.toHaveBeenCalled();
    expect(view.execute).not.toHaveBeenCalled();
    expect(view.controller.getState().error).toContain("磁盘不可写");
  });

  it("批准记录保存失败不会调用工具", async () => {
    const view = harness();
    await view.controller.send("制作白模");
    view.save.mockRejectedValueOnce(new Error("保存批准记录失败"));
    await view.controller.approve();

    expect(view.execute).not.toHaveBeenCalled();
    expect(view.controller.getState().pending).toBeNull();
    expect(view.controller.getState().error).toContain("保存批准记录失败");
  });

  it("重启恢复聊天和模型，但运行状态与旧批准计划不会自动重放", async () => {
    const view = harness();
    await view.controller.send("创建白模");
    const saved = structuredClone({ ...view.controller.getState(), status: "executing" });
    const restarted = new CanvasAgentController();
    restarted.configure(view.host);
    view.ask.mockClear();
    view.save.mockClear();
    restarted.restore(saved);
    await restarted.approve();

    expect(restarted.getState()).toMatchObject({
      model,
      expanded: true,
      status: "idle",
      pending: null,
    });
    expect(restarted.getState().messages[0]?.content).toBe("创建白模");
    expect(restarted.getState().messages.at(-1)?.content).toContain("旧计划的确认已失效");
    expect(view.ask).not.toHaveBeenCalled();
    expect(view.execute).not.toHaveBeenCalled();
    expect(view.save).not.toHaveBeenCalled();
  });
});

describe("画布智能体新聊天与历史会话", () => {
  it("新聊天把当前对话归档并回到空聊天", async () => {
    const view = harness();
    await view.controller.send("创建小人白模");
    view.save.mockClear();
    view.controller.newChat();

    const state = view.controller.getState();
    expect(state.messages).toEqual([]);
    expect(state.activeSessionId).toBeNull();
    expect(state.pending).toBeNull();
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0]).toMatchObject({ title: "创建小人白模" });
    expect(state.sessions[0]?.messages.some((item) => item.content === "创建小人白模")).toBe(true);
    expect(view.save).toHaveBeenCalled();
  });

  it("空聊天点新聊天不产生归档", () => {
    const view = harness();
    view.controller.newChat();

    expect(view.controller.getState().sessions).toEqual([]);
  });

  it("从历史打开会话会把当前聊天交换归档并沿用原会话 id", async () => {
    const view = harness();
    await view.controller.send("第一个需求");
    view.controller.newChat();
    const first = view.controller.getState().sessions[0]!;
    await view.controller.send("第二个需求");
    view.controller.openSession(first.id);

    let state = view.controller.getState();
    expect(state.activeSessionId).toBe(first.id);
    expect(state.messages.some((item) => item.content === "第一个需求")).toBe(true);
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0]?.title).toBe("第二个需求");

    view.controller.newChat();
    state = view.controller.getState();
    expect(state.sessions[0]).toMatchObject({ id: first.id, title: "第一个需求" });
  });

  it("删除历史会话只移除被选中的那一条", async () => {
    const view = harness();
    await view.controller.send("第一个需求");
    view.controller.newChat();
    await view.controller.send("第二个需求");
    view.controller.newChat();

    const sessions = view.controller.getState().sessions;
    expect(sessions.map((session) => session.title)).toEqual(["第二个需求", "第一个需求"]);
    view.controller.deleteSession(sessions[1]!.id);
    expect(view.controller.getState().sessions.map((session) => session.title)).toEqual([
      "第二个需求",
    ]);
  });

  it("忙碌时新聊天、切换与删除一律不生效", async () => {
    const view = harness();
    const gate = deferred<string>();
    view.ask.mockReturnValueOnce(gate.promise);
    const running = view.controller.send("制作白模");
    await vi.waitFor(() => expect(view.ask).toHaveBeenCalledTimes(1));
    view.controller.newChat();
    view.controller.openSession("missing");
    view.controller.deleteSession("missing");
    gate.resolve(reply([]));
    await running;

    const state = view.controller.getState();
    expect(state.messages.some((item) => item.role === "user")).toBe(true);
    expect(state.sessions).toEqual([]);
  });

  it("归档超过上限时丢弃最旧的会话", async () => {
    const view = harness();
    for (let index = 0; index < 21; index++) {
      await view.controller.send(`第 ${index} 个需求`);
      view.controller.newChat();
    }

    const sessions = view.controller.getState().sessions;
    expect(sessions).toHaveLength(20);
    expect(sessions[0]?.title).toBe("第 20 个需求");
    expect(sessions.at(-1)?.title).toBe("第 1 个需求");
  });

  it("v2 存档连同历史会话一起恢复，v1 存档迁移为无历史", () => {
    const view = harness();
    const saved = {
      ...view.controller.getState(),
      expanded: true,
      model,
      messages: [{ id: "m1", role: "user" as const, content: "恢复我" }],
      sessions: [
        { id: "s1", title: "旧聊天", messages: [{ id: "m0", role: "user" as const, content: "旧消息" }] },
      ],
      activeSessionId: "s1",
    };
    const restarted = new CanvasAgentController();
    restarted.configure(view.host);
    restarted.restore(structuredClone(saved));
    expect(restarted.getState()).toMatchObject({
      version: 2,
      activeSessionId: "s1",
      messages: [{ id: "m1" }],
      sessions: [{ id: "s1", title: "旧聊天" }],
      status: "idle",
    });

    const legacy = new CanvasAgentController();
    legacy.configure(view.host);
    legacy.restore({ version: 1, expanded: false, model, messages: [], status: "idle" });
    expect(legacy.getState()).toMatchObject({
      version: 2,
      sessions: [],
      activeSessionId: null,
      status: "idle",
    });
  });
});

describe("画布智能体计划解析兜底", () => {
  const writePlan = reply([createAction()]);

  it("JSON 前后的说明正文不再使计划失败，也不消耗修正轮", async () => {
    const view = harness();
    view.ask.mockResolvedValueOnce(
      `好的，超过 30 秒有两条轨道建议分开管理：\n${writePlan}\n以上计划请确认。`,
    );
    await view.controller.send("请创建白模");

    expect(view.ask).toHaveBeenCalledTimes(1);
    expect(view.controller.getState().pending?.actions).toEqual([createAction()]);
    expect(view.controller.getState()).toMatchObject({ status: "idle", error: null });
    expect(
      view.controller.getState().messages.some((item) => item.content.startsWith("计划未执行")),
    ).toBe(false);
  });

  it("思考块与代码围栏混合包裹时，取末尾的计划对象而不是思考草稿", async () => {
    const view = harness();
    view.ask.mockResolvedValueOnce(
      `[think]草稿：${reply([])}[/think]\n好的：\n\`\`\`json\n${writePlan}\n\`\`\`\n请确认。`,
    );
    await view.controller.send("请创建白模");

    expect(view.ask).toHaveBeenCalledTimes(1);
    expect(view.controller.getState().pending?.actions).toEqual([createAction()]);
    expect(view.controller.getState()).toMatchObject({ status: "idle", error: null });
  });

  it("整段正文没有 JSON 时进入修正轮，并把输出协议回传给模型", async () => {
    const view = harness();
    view.ask
      .mockResolvedValueOnce("超过 30 秒有两条轨道，建议您分开管理。")
      .mockResolvedValueOnce(writePlan);
    await view.controller.send("请创建白模");

    expect(view.ask).toHaveBeenCalledTimes(2);
    expect(view.controller.getState().pending?.actions).toEqual([createAction()]);
    expect(view.controller.getState()).toMatchObject({ status: "idle", error: null });
    expect(
      view.controller
        .getState()
        .messages.some(
          (item) => item.role === "tool" && item.content.includes("不是有效的 JSON 计划"),
        ),
    ).toBe(true);
    expect(view.ask.mock.calls[1]?.[1]).toContain("只返回一个 JSON 对象");
  });

  it("连续两轮都无法解析时停机并给出可读原因", async () => {
    const view = harness();
    view.ask.mockResolvedValue("超过 30 秒有两条轨道，建议您分开管理。");
    await view.controller.send("请创建白模");

    expect(view.ask).toHaveBeenCalledTimes(2);
    expect(view.controller.getState().pending).toBeNull();
    expect(view.controller.getState().error).toContain("连续两次");
    expect(view.controller.getState().error).toContain("不是有效的 JSON 计划");
  });
});
