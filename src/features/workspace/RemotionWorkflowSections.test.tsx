import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { node } from "../../test/videoWorkflowFixtures";
import { RemotionConfiguration, RemotionDeliverables } from "./RemotionWorkflowSections";
import {
  createRemotionCheckpoint,
  createRemotionOptions,
  type AnimationPlan,
} from "./remotionWorkflowModel";

const plan: AnimationPlan = {
  schemaVersion: "animation-plan.v1",
  template: "cycle-flowchart",
  title: "学习循环",
  width: 800,
  height: 600,
  fps: 30,
  durationInFrames: 240,
  background: "#ffffff",
  palette: ["#3498db"],
  elements: [
    { id: "read", label: "阅读", detail: "理解问题" },
    { id: "practice", label: "练习", detail: "应用知识" },
  ],
  connections: [{ from: "read", to: "practice", label: "实践" }],
  staggerFrames: 30,
  holdFrames: 60,
  springDamping: 10,
};

describe("RemotionWorkflowSections", () => {
  it("edits template, theme, dimensions, duration and delivery without model controls", () => {
    function Harness() {
      const [options, setOptions] = useState(createRemotionOptions());
      return <RemotionConfiguration options={options} disabled={false} onChange={setOptions} />;
    }
    render(<Harness />);
    fireEvent.click(screen.getByText("动画与导出设置"));
    expect(screen.getByLabelText("动画模板").children).toHaveLength(12);
    fireEvent.change(screen.getByLabelText("动画模板"), { target: { value: "custom" } });
    fireEvent.change(screen.getByLabelText("动画视觉主题"), { target: { value: "dark" } });
    fireEvent.change(screen.getByLabelText("动画画面尺寸"), { target: { value: "720x1280" } });
    fireEvent.change(screen.getByLabelText("动画时长"), { target: { value: "12" } });
    fireEvent.change(screen.getByLabelText("动画导出格式"), { target: { value: "both" } });
    expect(screen.getByLabelText("动画模板")).toHaveValue("custom");
    expect(screen.getByLabelText("动画视觉主题")).toHaveValue("dark");
    expect(screen.getByLabelText("动画画面尺寸")).toHaveValue("720x1280");
    expect(screen.getByLabelText("动画时长")).toHaveValue(12);
    expect(screen.getByLabelText("动画导出格式")).toHaveValue("both");
    fireEvent.change(screen.getByLabelText("动画时长"), { target: { value: "31" } });
    expect(screen.getByLabelText("动画时长")).toHaveValue(12);
  });

  it("locks all animation settings during execution or decisions", () => {
    render(<RemotionConfiguration options={createRemotionOptions()} disabled onChange={vi.fn()} />);
    for (const label of ["动画模板", "动画视觉主题", "动画画面尺寸", "动画时长", "动画导出格式"]) {
      expect(screen.getByLabelText(label)).toBeDisabled();
    }
  });

  it("renders GIF as an image and MP4 as video with editable project and document actions", () => {
    const onExport = vi.fn();
    const onRevealProject = vi.fn();
    const onRevealResult = vi.fn();
    render(
      <RemotionDeliverables
        onExport={onExport}
        onRevealProject={onRevealProject}
        onRevealResult={onRevealResult}
        checkpoint={{
          ...node().config.checkpoint,
          remotion: {
            ...createRemotionCheckpoint(),
            plan,
            matchReason: "反馈回到起点，适合闭环",
            review: { result: "PASS", report: "文字与关系清晰" },
            history: [{ plan, review: { result: "REVISE", report: "补充关系说明" } }],
            renderJob: {
              id: "animation-job",
              status: "succeeded",
              progress: 100,
              message: "完成",
              gifPath: "C:\\animations\\cycle.gif",
              videoPath: "C:\\animations\\cycle.mp4",
              previewPath: "C:\\animations\\preview.png",
              projectPath: "C:\\animations\\project",
              createdAt: 1,
              updatedAt: 2,
            },
          },
        }}
      />,
    );
    expect(screen.getByAltText("学习循环 GIF 动图")).toHaveProperty("tagName", "IMG");
    expect(screen.getByLabelText("动画 MP4 视频")).toHaveProperty("tagName", "VIDEO");
    expect(screen.getByAltText("学习循环 静态预览")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看导出文件" }));
    fireEvent.click(screen.getByRole("button", { name: "导出动画制作文档" }));
    fireEvent.click(screen.getByRole("button", { name: "打开可编辑工程" }));
    expect(onRevealResult).toHaveBeenCalledOnce();
    expect(onExport).toHaveBeenCalledOnce();
    expect(onRevealProject).toHaveBeenCalledOnce();
    expect(screen.getByText("匹配依据：反馈回到起点，适合闭环")).toBeInTheDocument();
    expect(screen.getByText("文字与关系清晰")).toBeInTheDocument();
    expect(screen.getByText("历史版本（1）")).toBeInTheDocument();
  });

  it("keeps a checked plan visible when rendering has not completed", () => {
    render(
      <RemotionDeliverables
        checkpoint={{
          ...node().config.checkpoint,
          remotion: {
            ...createRemotionCheckpoint(),
            plan,
            review: { result: "REVISE", report: "缩短卡片说明" },
          },
        }}
        onRevealProject={vi.fn()}
      />,
    );
    expect(screen.getByText("内容与布局检查 · 需要修订")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "打开可编辑工程" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("动画 MP4 视频")).not.toBeInTheDocument();
  });
});
