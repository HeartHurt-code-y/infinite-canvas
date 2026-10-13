import { describe, expect, it, vi } from "vitest";

import { WorkflowSessionRegistry } from "./workflowSessionRegistry";

describe("WorkflowSessionRegistry", () => {
  it("begin 在空闲 key 上发牌，并在 end 后允许再次启动", () => {
    const registry = new WorkflowSessionRegistry();
    const token = registry.begin("node-1");
    expect(token).not.toBeNull();
    expect(registry.isRunning("node-1")).toBe(true);
    expect(registry.runningCount).toBe(1);

    token!.end();
    expect(registry.isRunning("node-1")).toBe(false);
    expect(registry.begin("node-1")).not.toBeNull();
  });

  it("同一 key 的第二次 begin 被拒（启动守卫）", () => {
    const registry = new WorkflowSessionRegistry();
    expect(registry.begin("node-1")).not.toBeNull();
    expect(registry.begin("node-1")).toBeNull();
    expect(registry.runningCount).toBe(1);
  });

  it("end 只注销自己的会话：陈旧完成回调不能误删新会话", () => {
    const registry = new WorkflowSessionRegistry();
    const stale = registry.begin("node-1");
    stale!.end();
    const fresh = registry.begin("node-1");

    // 陈旧 token 的 end 不能注销继任会话。
    stale!.end();
    expect(registry.isRunning("node-1")).toBe(true);

    fresh!.end();
    expect(registry.isRunning("node-1")).toBe(false);
  });

  it("abort 发出中止信号但保留会话，注销仍归 end", () => {
    const registry = new WorkflowSessionRegistry();
    const token = registry.begin("node-1")!;
    const onAbort = vi.fn();
    token.signal.addEventListener("abort", onAbort);

    registry.abort("node-1");
    expect(token.signal.aborted).toBe(true);
    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(registry.isRunning("node-1")).toBe(true);

    // 取消后由会话本人的 finally 注销。
    token.end();
    expect(registry.isRunning("node-1")).toBe(false);
  });

  it("abortAll 中止每个会话并清空注册表", () => {
    const registry = new WorkflowSessionRegistry();
    const first = registry.begin("node-1")!;
    const second = registry.begin("node-2")!;

    registry.abortAll();

    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(registry.runningCount).toBe(0);
    expect(registry.isRunning("node-1")).toBe(false);
  });

  it("历史 run 与历史动作各自互斥、计数独立", () => {
    const registry = new WorkflowSessionRegistry();
    expect(registry.beginHistoryRun("run-1")).toBe(true);
    expect(registry.beginHistoryRun("run-1")).toBe(false);
    expect(registry.isHistoryRunActive("run-1")).toBe(true);
    expect(registry.historyRunCount).toBe(1);

    expect(registry.beginHistoryAction("run-1")).toBe(true);
    expect(registry.beginHistoryAction("run-1")).toBe(false);
    expect(registry.historyActionCount).toBe(1);

    registry.endHistoryRun("run-1");
    registry.endHistoryAction("run-1");
    expect(registry.historyRunCount).toBe(0);
    expect(registry.historyActionCount).toBe(0);

    // 不存在的 id 重复注销是安全的。
    registry.endHistoryRun("run-1");
    registry.endHistoryAction("run-1");
  });
});
