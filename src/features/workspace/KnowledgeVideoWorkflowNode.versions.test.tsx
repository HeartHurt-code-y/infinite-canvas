import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { catalog, node } from "../../test/videoWorkflowFixtures";
import { KnowledgeVideoWorkflowNode } from "./KnowledgeVideoWorkflowNode";
import { workflowVersionState } from "./workflowVersionHistory";

vi.mock("./workflowVersionHistory", () => ({ workflowVersionState: vi.fn() }));

function view(prefix: string) {
  return {
    currentVersionId: `${prefix}-2`,
    versions: [
      { id: `${prefix}-1`, parentId: null, createdAt: 1, label: "初始方案" },
      { id: `${prefix}-2`, parentId: `${prefix}-1`, createdAt: 2, label: "修改剧本" },
      { id: `${prefix}-3`, parentId: `${prefix}-2`, createdAt: 3, label: "修改分镜" },
    ],
    redoVersionIds: [`${prefix}-3`],
    canUndo: true,
    canRedo: true,
    pastCount: 1,
    futureCount: 1,
  };
}

function propsFor(key: string) {
  const source = node();
  return {
    node: { ...source, key, config: { ...source.config, brief: key } },
    providerCatalog: catalog,
    onChange: vi.fn(),
    onExecute: vi.fn(),
    onContinue: vi.fn(),
    onCancel: vi.fn(),
    onRemove: vi.fn(),
    onRevealResult: vi.fn(),
    onUndoVersion: vi.fn(),
    onRedoVersion: vi.fn(),
    onRestoreVersion: vi.fn(),
  };
}

beforeEach(() => {
  vi.mocked(workflowVersionState).mockImplementation((config) => view(config.brief));
});

describe("workflow-local version controls", () => {
  it("binds undo, redo and arbitrary version restore to the selected workflow only", () => {
    const first = propsFor("workflow-one");
    const second = propsFor("workflow-two");
    render(
      <>
        <KnowledgeVideoWorkflowNode {...first} />
        <KnowledgeVideoWorkflowNode {...second} />
      </>,
    );
    const controls = screen.getAllByRole("group", { name: "当前工作流版本控制" });
    fireEvent.click(within(controls[0]!).getByRole("button", { name: "撤销当前工作流编辑" }));
    fireEvent.click(within(controls[0]!).getByRole("button", { name: "重做当前工作流编辑" }));
    expect(first.onUndoVersion).toHaveBeenCalledWith("workflow-one");
    expect(first.onRedoVersion).toHaveBeenCalledWith("workflow-one");
    expect(second.onUndoVersion).not.toHaveBeenCalled();
    expect(second.onRedoVersion).not.toHaveBeenCalled();

    fireEvent.click(within(controls[0]!).getByRole("button", { name: "查看当前工作流版本历史" }));
    const dialog = screen.getByRole("dialog", { name: "知识视频工作流 · 版本历史" });
    expect(within(dialog).getByText("版本 2 · 修改剧本 · 当前")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "回到版本 1" }));
    expect(first.onRestoreVersion).toHaveBeenCalledWith("workflow-one", "workflow-one-1");
    fireEvent.click(within(dialog).getByRole("button", { name: "重做至此版本" }));
    expect(first.onRedoVersion).toHaveBeenLastCalledWith("workflow-one", "workflow-one-3");
    expect(second.onRestoreVersion).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "关闭工作流版本历史" }));

    fireEvent.click(within(controls[1]!).getByRole("button", { name: "查看当前工作流版本历史" }));
    fireEvent.click(screen.getByRole("button", { name: "回到版本 1" }));
    expect(second.onRestoreVersion).toHaveBeenCalledWith("workflow-two", "workflow-two-1");
    expect(first.onRestoreVersion).toHaveBeenCalledTimes(1);
  });

  it("disables version actions when this workflow starts running, including an already-open dialog", () => {
    const props = propsFor("workflow-one");
    const { rerender } = render(<KnowledgeVideoWorkflowNode {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "查看当前工作流版本历史" }));
    rerender(
      <KnowledgeVideoWorkflowNode
        {...props}
        runState={{ phase: "generating", progress: 45, message: "正在制作", error: null }}
      />,
    );
    for (const name of [
      "撤销当前工作流编辑",
      "重做当前工作流编辑",
      "查看当前工作流版本历史",
      "回到版本 1",
      "重做至此版本",
    ]) {
      const button = screen.getByRole("button", { name, hidden: true });
      expect(button).toBeDisabled();
      fireEvent.click(button);
    }
    expect(props.onUndoVersion).not.toHaveBeenCalled();
    expect(props.onRedoVersion).not.toHaveBeenCalled();
    expect(props.onRestoreVersion).not.toHaveBeenCalled();
    expect(
      screen.getByText("制作任务运行中，请先暂停或等待完成，再切换版本。"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "关闭工作流版本历史" })).toBeEnabled();
  });

  it("keeps version controls unavailable before a workflow has recorded versions", () => {
    vi.mocked(workflowVersionState).mockReturnValue({
      currentVersionId: "",
      versions: [],
      redoVersionIds: [],
      canUndo: false,
      canRedo: false,
      pastCount: 0,
      futureCount: 0,
    });
    render(<KnowledgeVideoWorkflowNode {...propsFor("empty-workflow")} />);
    const controls = screen.getByRole("group", { name: "当前工作流版本控制" });
    for (const button of within(controls).getAllByRole("button")) expect(button).toBeDisabled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
