import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { WorkflowRepository } from "./WorkflowRepository";

describe("WorkflowRepository", () => {
  it("inserts product scenes through its own single-node entry", () => {
    const insert = vi.fn();
    render(
      <WorkflowRepository
        expanded
        onToggle={vi.fn()}
        onInsertKnowledgeVideoWorkflow={vi.fn()}
        onInsertProductSceneWorkflow={insert}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "添加产品场景图工作流节点" }));
    expect(insert).toHaveBeenCalledOnce();
  });
  it("offers one reverse-video workflow using project downloads without external links", () => {
    const insertReverse = vi.fn();
    const insertKnowledge = vi.fn();
    render(
      <WorkflowRepository
        expanded
        onToggle={vi.fn()}
        onInsertKnowledgeVideoWorkflow={insertKnowledge}
        onInsertReverseVideoWorkflow={insertReverse}
      />,
    );
    expect(screen.getByRole("heading", { name: "短视频反推工作流" })).toBeInTheDocument();
    expect(screen.getByText(/由项目下载器获取原片/)).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "添加短视频反推工作流节点" }));
    expect(insertReverse).toHaveBeenCalledTimes(1);
    expect(insertKnowledge).not.toHaveBeenCalled();
  });
  it("offers the animation template with a separate insertion action", () => {
    const insertRemotion = vi.fn();
    const insertKnowledge = vi.fn();
    render(
      <WorkflowRepository
        expanded
        onToggle={vi.fn()}
        onInsertKnowledgeVideoWorkflow={insertKnowledge}
        onInsertRemotionWorkflow={insertRemotion}
      />,
    );
    expect(screen.getByRole("heading", { name: "动画逻辑图工作流" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "添加动画逻辑图工作流节点" }));
    expect(insertRemotion).toHaveBeenCalledTimes(1);
    expect(insertKnowledge).not.toHaveBeenCalled();
  });
  it("offers the commerce template with its own insertion action", () => {
    const insertCommerce = vi.fn();
    const insertKnowledge = vi.fn();
    render(
      <WorkflowRepository
        expanded
        onToggle={vi.fn()}
        onInsertKnowledgeVideoWorkflow={insertKnowledge}
        onInsertCommerceWorkflow={insertCommerce}
      />,
    );
    expect(screen.getByRole("heading", { name: "剧情带货工作流" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "添加剧情带货工作流节点" }));
    expect(insertCommerce).toHaveBeenCalledTimes(1);
    expect(insertKnowledge).not.toHaveBeenCalled();
  });
  it("offers the comic drama template with its own insertion action", () => {
    const insertDrama = vi.fn();
    const insertKnowledge = vi.fn();
    render(
      <WorkflowRepository
        expanded
        onToggle={vi.fn()}
        onInsertKnowledgeVideoWorkflow={insertKnowledge}
        onInsertComicDramaWorkflow={insertDrama}
      />,
    );
    expect(screen.getByRole("heading", { name: "动漫短剧工作流 V2.3" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "添加漫剧自动工作流节点" }));
    expect(insertDrama).toHaveBeenCalledTimes(1);
    expect(insertKnowledge).not.toHaveBeenCalled();
  });
  it("offers the film workflow beside the existing knowledge template", () => {
    const insertFilm = vi.fn();
    const insertKnowledge = vi.fn();
    render(
      <WorkflowRepository
        expanded
        onToggle={vi.fn()}
        onInsertAiFilmWorkflow={insertFilm}
        onInsertKnowledgeVideoWorkflow={insertKnowledge}
      />,
    );
    expect(screen.getByText("9 个自动工作流")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "AI影视工作流 V1.3" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "添加AI影视工作流节点" }));
    expect(insertFilm).toHaveBeenCalledTimes(1);
    expect(insertKnowledge).not.toHaveBeenCalled();
  });
  it("exposes a controlled, accessible expand and collapse interaction", () => {
    const onToggle = vi.fn();

    function Harness() {
      const [expanded, setExpanded] = useState(false);

      return (
        <WorkflowRepository
          expanded={expanded}
          onToggle={() => {
            onToggle();
            setExpanded((current) => !current);
          }}
          onInsertKnowledgeVideoWorkflow={vi.fn()}
        />
      );
    }

    render(<Harness />);

    const toggle = screen.getByRole("button", { name: /工作流仓库/ });
    const contentId = toggle.getAttribute("aria-controls");
    expect(contentId).toBeTruthy();

    const content = document.getElementById(contentId!);
    expect(content).not.toBeNull();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(content).toHaveAttribute("hidden");

    fireEvent.click(toggle);

    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(content).not.toHaveAttribute("hidden");
    expect(content).toHaveAttribute("role", "dialog");
    expect(content).toHaveAccessibleName("工作流仓库");

    fireEvent.click(toggle);

    expect(onToggle).toHaveBeenCalledTimes(2);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(content).toHaveAttribute("hidden");
  });

  it("opens all nine templates and restores focus when dismissed with Escape or close", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [expanded, setExpanded] = useState(false);
      return (
        <WorkflowRepository
          expanded={expanded}
          onToggle={() => setExpanded((current) => !current)}
          onInsertKnowledgeVideoWorkflow={vi.fn()}
          onInsertAiFilmWorkflow={vi.fn()}
          onInsertComicDramaWorkflow={vi.fn()}
          onInsertCommerceWorkflow={vi.fn()}
          onInsertRemotionWorkflow={vi.fn()}
          onInsertXhsCoverWorkflow={vi.fn()}
          onInsertReverseVideoWorkflow={vi.fn()}
        />
      );
    }
    render(<Harness />);
    const toggle = screen.getByRole("button", { name: "工作流仓库" });
    await user.click(toggle);
    const dialog = screen.getByRole("dialog", { name: "工作流仓库" });
    expect(within(dialog).getAllByRole("heading")).toHaveLength(9);
    expect(within(dialog).getByRole("button", { name: "添加短视频反推工作流节点" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(toggle).toHaveFocus();

    await user.click(toggle);
    await user.click(screen.getByRole("button", { name: "关闭工作流仓库" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(toggle).toHaveFocus();
  });

  it("dismisses on outside pointer or focus without swallowing the outside action", async () => {
    const user = userEvent.setup();
    const outsideAction = vi.fn();
    function Harness() {
      const [expanded, setExpanded] = useState(false);
      return (
        <>
          <WorkflowRepository
            expanded={expanded}
            onToggle={() => setExpanded((current) => !current)}
            onInsertKnowledgeVideoWorkflow={vi.fn()}
          />
          <button onClick={outsideAction}>画布外部操作</button>
        </>
      );
    }
    render(<Harness />);
    const toggle = screen.getByRole("button", { name: "工作流仓库" });
    const outside = screen.getByRole("button", { name: "画布外部操作" });
    await user.click(toggle);
    await user.click(outside);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(outsideAction).toHaveBeenCalledOnce();
    expect(outside).toHaveFocus();

    await user.click(toggle);
    await user.tab();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(outside).toHaveFocus();
  });

  it("presents the compact automatic stages and inserts one workflow node", () => {
    const onInsertKnowledgeVideoWorkflow = vi.fn();

    render(
      <WorkflowRepository
        expanded
        onToggle={vi.fn()}
        onInsertKnowledgeVideoWorkflow={onInsertKnowledgeVideoWorkflow}
      />,
    );

    expect(screen.getByRole("heading", { name: "知识教学视频导演 V2.4" })).toBeInTheDocument();
    expect(screen.getByText(/使用项目内已配置的模型/)).toBeInTheDocument();

    const stages = screen.getByRole("list", { name: "知识教学视频自动工作流能力" });
    expect(within(stages).getAllByRole("listitem")).toHaveLength(4);
    for (const stage of ["智能策划", "自动生成", "质量检查", "成片交付"]) {
      expect(within(stages).getByText(stage)).toBeInTheDocument();
    }

    fireEvent.click(screen.getByRole("button", { name: "添加工作流节点" }));
    expect(onInsertKnowledgeVideoWorkflow).toHaveBeenCalledTimes(1);
  });
});
