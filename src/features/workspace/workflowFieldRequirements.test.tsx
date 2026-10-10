import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

/* 第 3 条用例断言的是**标签的 DOM 结构契约**（星号必须与标签文字同处一个元素，
 * 且该元素是标签容器的直接子元素），没有等价的 getByRole 写法。 */
/* eslint-disable testing-library/no-container -- 见上 */

import {
  OptionalMark,
  RequiredMark,
  WorkflowRequirementsHint,
  requirementsMet,
  workflowRequirementsSummary,
} from "./workflowFieldRequirements";

describe("workflow field requirement markers", () => {
  it("marks a required field with a red asterisk and nothing else", () => {
    render(
      <label>
        <RequiredMark>供应商</RequiredMark>
        <select defaultValue="project">
          <option value="project">项目供应商</option>
        </select>
      </label>,
    );

    expect(screen.getByText("*")).toHaveClass("workflow-required-mark__asterisk");
    // 卡片高度优先：不再附带「（必填）」文字，界面上只有星号。
    expect(screen.queryByText("（必填）")).not.toBeInTheDocument();
    // 必填语义不靠颜色单独承载：挂在控件上的 aria-required 才是 AT 的读法。
    expect(screen.getByRole("combobox")).toBeRequired();
  });

  it("renders no marker at all for optional fields", () => {
    render(
      <label>
        <OptionalMark>封面风格</OptionalMark>
        <select defaultValue="auto">
          <option value="auto">自动匹配</option>
        </select>
      </label>,
    );

    expect(screen.queryByText("*")).not.toBeInTheDocument();
    expect(screen.queryByText("（可选）")).not.toBeInTheDocument();
    expect(screen.getByRole("combobox")).not.toBeRequired();
  });

  it("keeps the star inside the label text element so grid labels stay on one row", () => {
    const { container } = render(
      <div className="canvas-prompt-node__field">
        <RequiredMark>目标时长（秒）</RequiredMark>
      </div>,
    );

    // 关键结构约束：星号与标签文字必须在**同一个**子元素里。标签容器是
    // `display: grid`，一旦拆成两个子元素，网格会把它们排成两行，卡片被撑长。
    const field = container.querySelector(".canvas-prompt-node__field")!;
    expect(field.childElementCount).toBe(1);
    expect(field.firstChild).toHaveTextContent("目标时长（秒）*");
    expect(
      (field.firstChild as HTMLElement).querySelector(".workflow-required-mark__asterisk"),
    ).not.toBeNull();
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
    for (const text of ["封面内容", "粘贴选题或文章", "人物参考图", "添加 1–3 张同一人物照片"])
      expect(hint).toHaveTextContent(text);
    expect(within(hint).getAllByRole("listitem")).toHaveLength(2);
    // 卡片高度优先：清单只有标题与逐项补法，不再追加收尾说明。
    expect(hint.querySelector(".workflow-required-hint__foot")).toBeNull();
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
