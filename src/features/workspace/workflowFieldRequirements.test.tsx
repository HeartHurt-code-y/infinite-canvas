import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

/* 第 3 条用例断言的是**标签的 DOM 结构契约**（标签文字必须是独立文本节点、
 * 星号只能是它的同级兄弟），没有等价的 getByRole 写法。 */
/* eslint-disable testing-library/no-container -- 见上 */

import {
  OptionalMark,
  RequiredMark,
  WorkflowRequirementsHint,
  requirementsMet,
  workflowRequirementsSummary,
} from "./workflowFieldRequirements";

describe("workflow field requirement markers", () => {
  it("marks required fields with an accessible star that does not disturb the label text", () => {
    render(
      <label>
        <RequiredMark>供应商</RequiredMark>
        <select defaultValue="project">
          <option value="project">项目供应商</option>
        </select>
      </label>,
    );

    expect(screen.getByText("*")).toHaveClass("workflow-required-mark__asterisk");
    // 「（必填）」对辅助技术可见：可访问名与可见文本一致，屏幕阅读器也听得到必填。
    const select = screen.getByRole("combobox");
    expect(select).toHaveAccessibleName(/供应商/);
    expect(select).toHaveAccessibleName(/必填/);
  });

  it("marks optional fields without an asterisk", () => {
    render(
      <label>
        <OptionalMark>封面风格</OptionalMark>
        <select defaultValue="auto">
          <option value="auto">自动匹配</option>
        </select>
      </label>,
    );

    expect(screen.queryByText("*")).not.toBeInTheDocument();
    expect(screen.getByText("（可选）")).toHaveClass("workflow-required-mark__optional");
    expect(screen.getByRole("combobox")).toHaveAccessibleName(/封面风格/);
  });

  it("keeps the label text a direct text node so existing label typography selectors still match", () => {
    const { container } = render(
      <div className="canvas-prompt-node__field">
        <RequiredMark>目标时长（秒）</RequiredMark>
      </div>,
    );

    // 关键结构约束：标签文字是独立文本节点，星号只是它的同级兄弟。多包一层元素
    // 会让 `.canvas-prompt-node__field > span` 这类排版选择器失配。
    const field = container.querySelector(".canvas-prompt-node__field")!;
    expect(field.firstChild).toHaveTextContent("目标时长（秒）");
    expect(field.firstElementChild).toHaveClass("workflow-required-mark__asterisk");
    expect(field).toHaveTextContent("目标时长（秒）*（必填）");
  });

  it("lists every missing requirement at once instead of only the first", () => {
    render(
      <WorkflowRequirementsHint
        requirements={[
          { field: "封面内容", hint: "粘贴选题或文章" },
          { field: "人物参考图", hint: "添加 1–3 张同一人物照片" },
        ]}
      />,
    );

    const hint = screen.getByRole("status");
    expect(hint).toHaveTextContent("还差 2 项必填内容");
    for (const text of [
      "封面内容",
      "粘贴选题或文章",
      "人物参考图",
      "添加 1–3 张同一人物照片",
      "其余参数已按推荐值预置，可以不改直接开始。",
    ])
      expect(hint).toHaveTextContent(text);
    expect(within(hint).getAllByRole("listitem")).toHaveLength(2);
  });

  it("renders nothing when the input is ready", () => {
    render(<WorkflowRequirementsHint requirements={[]} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("derives readiness and the blocking summary from the same list", () => {
    expect(requirementsMet([])).toBe(true);
    expect(requirementsMet([{ field: "歌曲文件", hint: "选择一首完整歌曲" }])).toBe(false);
    expect(
      workflowRequirementsSummary([
        { field: "封面内容", hint: "粘贴选题或文章" },
        { field: "人物参考图", hint: "添加 1–3 张同一人物照片" },
      ]),
    ).toBe("还差 2 项必填内容：封面内容、人物参考图");
    expect(workflowRequirementsSummary([])).toBe("");
  });
});
