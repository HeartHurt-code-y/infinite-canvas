import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { catalog, node } from "./videoWorkflowFixtures";
import { CanvasStoreProvider, useCanvasCommands } from "../features/canvas/canvasStore";
import {
  approveWorkflowExecutionPlan,
  createWorkflowExecutionPlan,
} from "../features/workspace/workflowExecutionPlan";
import { useWorkflowSessions } from "../features/workspace/useWorkflowSessions";
import { WorkflowSessionRegistry } from "../features/workspace/workflowSessionRegistry";
import type { KnowledgeVideoWorkflowNodeData } from "../features/workspace/workspaceModel";

/**
 * 会话控制器级单测：不渲染 WorkspaceApp，直接驱动 useWorkflowSessions 的
 * run 生命周期——启动守卫、注册表发牌/注销、历史 run 互斥、失败收敛、
 * 取消信号与 remove/clear 的注册表清理。
 */

const runnerState = vi.hoisted(() => ({
  run: vi.fn<(request: unknown) => Promise<unknown>>(),
}));

vi.mock("../features/workspace/workflowHistoryExecution", () => ({
  createRecordedWorkflowRunner: () => ({ run: runnerState.run }),
}));

vi.mock("../lib/backend", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isDesktopRuntime: () => true,
}));

const recordedRunnerRequests: Array<Record<string, unknown> & { signal: AbortSignal }> = [];
let settleRun: ((checkpoint: unknown) => void) | null = null;
let failRun: ((error: unknown) => void) | null = null;

function approvedNode(): KnowledgeVideoWorkflowNodeData {
  const source = node();
  const plan = approveWorkflowExecutionPlan(createWorkflowExecutionPlan(source, "restart"), source);
  return { ...source, config: { ...source.config, executionPlan: plan } };
}

function setupSessions(seed: KnowledgeVideoWorkflowNodeData) {
  const activeRef = { current: true };
  const registry = new WorkflowSessionRegistry();
  let latest: ReturnType<typeof useWorkflowSessions> | null = null;

  const seedRef = { current: seed };
  function Seed() {
    const { addNode } = useCanvasCommands();
    useEffect(() => {
      addNode("knowledgeVideoWorkflow", seedRef.current, {});
    }, [addNode]);
    return null;
  }

  function Probe({ children }: { readonly children: ReactNode }) {
    const sessions = useWorkflowSessions({
      canvasId: "canvas-test",
      active: true,
      activeRef,
      registry,
      recoverWorkflowHistory: () => Promise.resolve(0),
      providerCatalog: catalog,
      scheduleCanvasSave: () => {},
      showHistoryPanel: () => {},
      closeHistoryPanel: () => {},
      centerView: () => {},
      viewportCenterBoardCoordinates: () => ({ x: 0, y: 0 }),
      occupiedNodeRects: [],
    });
    latest = sessions;
    return (
      <>
        <Seed />
        {children}
      </>
    );
  }

  renderHook(() => null, {
    wrapper: ({ children }: { readonly children: ReactNode }) => (
      <CanvasStoreProvider initialZoom={100}>
        <Probe>{children}</Probe>
      </CanvasStoreProvider>
    ),
  });

  // getter：每次访问取最新渲染的控制器对象，断言永远读到当前 runs 快照。
  return {
    registry,
    get sessions() {
      return latest!;
    },
  };
}

beforeEach(() => {
  runnerState.run.mockReset();
  recordedRunnerRequests.length = 0;
  settleRun = null;
  failRun = null;
  runnerState.run.mockImplementation((request: unknown) => {
    recordedRunnerRequests.push(request as Record<string, unknown> & { signal: AbortSignal });
    return new Promise((resolve, reject) => {
      settleRun = resolve;
      failRun = reject;
    });
  });
});

describe("useWorkflowSessions run lifecycle", () => {
  it("execute 在计划未批时生成执行计划并停在待审批", () => {
    const h = setupSessions(node());

    act(() => h.sessions.execute("workflow-1"));

    expect(h.sessions.runs["workflow-1"]).toMatchObject({
      phase: "awaiting_approval",
      message: "请检查执行计划并确认后开始。",
    });
    expect(h.registry.isRunning("workflow-1")).toBe(false);
    expect(runnerState.run).not.toHaveBeenCalled();
  });

  it("run 通过已批计划启动会话：发牌、历史互斥、完成后注销", async () => {
    const h = setupSessions(approvedNode());

    // run 的 runner 调用在 recover→run 微任务链之后，act 异步冲刷后断言。
    await act(async () => {
      h.sessions.run("workflow-1", false);
      await Promise.resolve();
    });

    expect(h.sessions.runs["workflow-1"]).toMatchObject({
      phase: "planning",
      message: "正在启动自动工作流…",
    });
    expect(h.registry.isRunning("workflow-1")).toBe(true);
    expect(h.registry.historyRunCount).toBe(1);
    expect(h.sessions.activeHistoryRunIds).toHaveLength(1);
    expect(runnerState.run).toHaveBeenCalledTimes(1);

    // 同 key 二次启动与并发动作都被守卫挡下。
    act(() => h.sessions.run("workflow-1", false));
    act(() => h.sessions.execute("workflow-1"));
    expect(runnerState.run).toHaveBeenCalledTimes(1);

    await act(async () => {
      settleRun?.({ phase: "done" });
      await Promise.resolve();
    });

    await waitFor(() => expect(h.registry.isRunning("workflow-1")).toBe(false));
    expect(h.registry.historyRunCount).toBe(0);
    expect(h.sessions.activeHistoryRunIds).toHaveLength(0);
  });

  it("runner 失败时收敛为 failed 记录并释放会话", async () => {
    const h = setupSessions(approvedNode());

    await act(async () => {
      h.sessions.run("workflow-1", true);
      await Promise.resolve();
    });

    await act(async () => {
      failRun?.(new Error("供应商连接失败"));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(h.registry.isRunning("workflow-1")).toBe(false);
    });
    const failed = h.sessions.runs["workflow-1"];
    expect(failed?.phase).toBe("failed");
    expect(failed?.error ?? "").toContain("供应商连接失败");
    expect(h.registry.historyRunCount).toBe(0);
  });

  it("cancel 发出中止信号但不注销，注销仍归会话本人的 finally", async () => {
    const h = setupSessions(approvedNode());

    await act(async () => {
      h.sessions.run("workflow-1", false);
      await Promise.resolve();
    });
    const request = recordedRunnerRequests[0]!;
    const signal = request.signal;
    expect(signal.aborted).toBe(false);

    act(() => h.sessions.cancel("workflow-1"));
    expect(signal.aborted).toBe(true);
    expect(h.registry.isRunning("workflow-1")).toBe(true);

    await act(async () => {
      failRun?.(new Error("aborted"));
      await Promise.resolve();
    });
    await waitFor(() => expect(h.registry.isRunning("workflow-1")).toBe(false));
  });

  it("remove 中止并丢弃会话、清理运行记录并移除节点", async () => {
    const h = setupSessions(approvedNode());

    await act(async () => {
      h.sessions.run("workflow-1", false);
      await Promise.resolve();
    });
    expect(h.registry.runningCount).toBe(1);

    act(() => h.sessions.remove("workflow-1"));

    expect(h.registry.runningCount).toBe(0);
    // 历史 run id 归在跑的 runner 所有，其 finally 尚未执行，保持占位。
    expect(h.registry.historyRunCount).toBe(1);
    expect(h.sessions.runs["workflow-1"]).toBeUndefined();
  });

  it("clearRun 与 clearAllRuns 只清理进度记录，不影响注册表", () => {
    const h = setupSessions(node());
    act(() => h.sessions.execute("workflow-1"));
    expect(Object.keys(h.sessions.runs)).toEqual(["workflow-1"]);

    act(() => h.sessions.clearRun("workflow-1"));
    expect(h.sessions.runs["workflow-1"]).toBeUndefined();

    act(() => h.sessions.execute("workflow-1"));
    act(() => h.sessions.clearAllRuns());
    expect(h.sessions.runs).toEqual({});
    expect(h.registry.runningCount).toBe(0);
  });

  it("approvePlan 确认当前计划后立即启动 run", async () => {
    const source = node();
    const planned = {
      ...source,
      config: { ...source.config, executionPlan: createWorkflowExecutionPlan(source, "restart") },
    };
    const h = setupSessions(planned);

    await act(async () => {
      h.sessions.approvePlan("workflow-1");
      await Promise.resolve();
    });

    expect(runnerState.run).toHaveBeenCalledTimes(1);
    expect(h.registry.isRunning("workflow-1")).toBe(true);
    expect(h.sessions.runs["workflow-1"]).toMatchObject({ phase: "planning" });
  });
});
