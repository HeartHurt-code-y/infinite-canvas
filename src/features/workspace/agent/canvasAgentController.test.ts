import { describe, expect, it, vi } from "vitest";
import type { NodeModelSelection } from "../workspaceModel";
import type { AgentAction, AgentToolContext } from "./agentTypes";
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
