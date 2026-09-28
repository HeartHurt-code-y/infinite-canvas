import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ProviderCatalogEntry } from "../../../lib/backend";
import { defaultModelOperationSchema } from "../../../lib/modelCapabilities";
import { createWhiteModelStudioDraft } from "../../../lib/whiteModelStudio";
import type { WhiteModelScenePlan } from "../../../lib/whiteModelScene";
import type { AgentState, AgentTool } from "./agentTypes";
import { CanvasAgentPanel } from "./CanvasAgentPanel";
import type { CanvasAgentController } from "./canvasAgentController";

vi.mock("../WhiteModelViewport", () => ({
  WhiteModelViewport: () => <div data-testid="scene-preview" />,
}));

const catalog: readonly ProviderCatalogEntry[] = [
  {
    provider: {
      id: "enabled-provider",
      displayName: "已启用供应商",
      adapterId: "moyu_v1",
      baseUrl: "https://example.test/v1",
      apiKeyRef: "test-key",
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    },
    models: [
      {
        definitionId: "text-model",
        remoteModelId: "text-model",
        displayName: "对话模型",
        operations: ["text_generation"],
        operationSchema: defaultModelOperationSchema("text-model", ["text_generation"]),
      },
      {
        definitionId: "image-model",
        remoteModelId: "image-model",
        displayName: "图片模型",
        operations: ["text_to_image"],
        operationSchema: defaultModelOperationSchema("image-model", ["text_to_image"]),
      },
    ],
  },
  {
    provider: {
      id: "disabled-provider",
      displayName: "停用供应商",
      adapterId: "moyu_v1",
      baseUrl: "https://example.test/v1",
      apiKeyRef: "disabled-key",
      enabled: false,
      createdAt: 1,
      updatedAt: 1,
    },
    models: [
      {
        definitionId: "disabled-model",
        remoteModelId: "disabled-model",
        displayName: "停用对话模型",
        operations: ["text_generation"],
        operationSchema: defaultModelOperationSchema("disabled-model", ["text_generation"]),
      },
    ],
  },
];

const tool: AgentTool = {
  name: "canvas.add",
  title: "添加画布节点",
  description: "添加画布节点",
  effect: "write",
  inputSchema: {},
  validate: () => undefined,
  execute: () => Promise.resolve(undefined),
};

function harness(patch: Partial<AgentState> = {}) {
  let state: AgentState = {
    version: 1,
    expanded: true,
    model: { providerId: "enabled-provider", modelDefinitionId: "text-model" },
    messages: [],
    pending: null,
    status: "idle",
    progress: "",
    error: null,
    ...patch,
  };
  const listeners = new Set<() => void>();
  const update = (next: Partial<AgentState>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };
  const methods = {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getTools: () => [tool],
    getScenePreviews: vi.fn((): ReadonlyMap<string, WhiteModelScenePlan> => new Map()),
    setExpanded: vi.fn((expanded: boolean) => update({ expanded })),
    setModel: vi.fn(),
    send: vi.fn(() => Promise.resolve()),
    approve: vi.fn(() => Promise.resolve()),
    reject: vi.fn(() => update({ pending: null })),
    stop: vi.fn(),
  };
  return { controller: methods as unknown as CanvasAgentController, methods, update };
}

describe("CanvasAgentPanel", () => {
  it("keeps the draft and messages when collapsed, and only offers enabled text models", () => {
    const { controller, methods } = harness({
      messages: [{ id: "hello", role: "assistant", content: "可以先制作白模。" }],
    });
    render(<CanvasAgentPanel controller={controller} catalog={catalog} />);
    expect(screen.getByRole("option", { name: "对话模型 · 已启用供应商" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /图片模型|停用/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "两个人在客厅走动" } });
    fireEvent.click(screen.getByRole("button", { name: "收起创作助手" }));
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(methods.stop).not.toHaveBeenCalled();
    const toggle = screen.getByRole("button", { name: "打开创作助手" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveFocus();
    expect(toggle).toHaveTextContent(/^$/);
    expect(toggle.querySelector(".canvas-agent-toggle__triangle")).not.toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "收起创作助手" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByRole("textbox")).toHaveValue("两个人在客厅走动");
    expect(screen.getByText("可以先制作白模。")).toBeInTheDocument();
  });

  it("does not submit IME confirmation or Shift+Enter, then sends committed Chinese text", () => {
    const { controller, methods } = harness();
    render(<CanvasAgentPanel controller={controller} catalog={catalog} />);
    const input = screen.getByRole("textbox");
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: "liang'ge'ren" } });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 13, isComposing: true });
    expect(methods.send).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input, { data: "两个人" });
    fireEvent.change(input, { target: { value: "两个人" } });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(methods.send).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter", keyCode: 13 });
    expect(methods.send).toHaveBeenCalledExactlyOnceWith("两个人");
    expect(input).toHaveValue("");
  });

  it("shows readable planned actions and routes approval and revision without automatic execution", () => {
    const { controller, methods } = harness({
      pending: {
        id: "plan-1",
        message: "先添加图片节点。",
        signature: "signed-input",
        actions: [
          {
            id: "first",
            tool: tool.name,
            args: { kind: "image", title: "客厅效果图" },
            dependsOn: [],
          },
        ],
      },
    });
    render(<CanvasAgentPanel controller={controller} catalog={catalog} />);
    expect(screen.getByText("添加画布节点")).toBeInTheDocument();
    expect(screen.getByText("节点类型：图片生成")).toBeInTheDocument();
    expect(screen.getByText("名称：客厅效果图")).toBeInTheDocument();
    expect(methods.approve).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认并执行" }));
    expect(methods.approve).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "修改计划" }));
    expect(methods.reject).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("textbox")).toHaveFocus();
  });

  it("shows progress and stop while running, and disables submissions when the canvas is unavailable", () => {
    const { controller, methods, update } = harness({
      status: "executing",
      progress: "正在渲染白模",
    });
    const { rerender } = render(<CanvasAgentPanel controller={controller} catalog={catalog} />);
    expect(screen.getByRole("status")).toHaveTextContent("正在渲染白模");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "接下来生成图片" } });
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "停止后续操作" }));
    expect(methods.stop).toHaveBeenCalledTimes(1);
    act(() => update({ status: "idle", progress: "" }));
    rerender(<CanvasAgentPanel controller={controller} catalog={catalog} disabled />);
    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  });

  it("previews a locally derived scene without adding scene data to the planned tool arguments", () => {
    const action = {
      id: "refine",
      tool: tool.name,
      args: { nodeKey: "existing-video" },
      dependsOn: [],
    };
    const { controller, methods } = harness({
      pending: {
        id: "refine-plan",
        message: "放慢抬手动作。",
        signature: "signed-scene",
        actions: [action],
      },
    });
    methods.getScenePreviews.mockReturnValue(
      new Map([[action.id, createWhiteModelStudioDraft().plan]]),
    );
    render(<CanvasAgentPanel controller={controller} catalog={catalog} />);
    expect(screen.getByTestId("scene-preview")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "播放预览" })).toBeInTheDocument();
    expect(action.args).toEqual({ nodeKey: "existing-video" });
    expect(methods.approve).not.toHaveBeenCalled();
  });
});
