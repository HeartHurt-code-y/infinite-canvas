import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PickedPromptMaterial } from "../../lib/backend";
import { node } from "../../test/videoWorkflowFixtures";
import { XhsCoverConfiguration, XhsCoverDeliverables } from "./XhsCoverWorkflowSections";
import {
  createXhsCoverCheckpoint,
  createXhsCoverOptions,
  type XhsCoverWorkflowOptions,
} from "./xhsCoverWorkflowModel";
import type { KnowledgeVideoWorkflowCheckpoint } from "./workspaceModel";

const portrait: PickedPromptMaterial = {
  localPath: "C:\\covers\\portrait.png",
  displayName: "人物参考.png",
  kind: "image",
  mimeType: "image/png",
  byteSize: 100_000,
};

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
afterEach(() => {
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
});

function completedCheckpoint(): KnowledgeVideoWorkflowCheckpoint {
  return {
    ...node().config.checkpoint,
    phase: "done",
    xhsCover: {
      ...createXhsCoverCheckpoint(),
      plan: {
        schemaVersion: "xhs-cover-plan.v1",
        style: "checklist",
        title: "零基础做封面",
        subtitle: "3 步上手",
        titleCandidates: ["零基础做封面", "封面全流程", "小白也能学会"],
        rationale: "用清单突出教程步骤。",
        prompt: "3:4竖版小红书封面，保持参考图1人物一致性。",
      },
      review: { result: "PASS", report: "标题清晰，人物一致，画幅通过。" },
      imagePath: "C:\\covers\\draft.png",
      finalPath: "C:\\covers\\final.png",
    },
  };
}

describe("XhsCoverConfiguration", () => {
  it("requires user portraits, supports image picking/removal and preserves automatic defaults", async () => {
    const onPick = vi
      .fn<(role: "portrait" | "material") => Promise<void>>()
      .mockResolvedValue(undefined);
    function Harness() {
      const [options, setOptions] = useState(createXhsCoverOptions());
      return (
        <XhsCoverConfiguration
          options={options}
          disabled={false}
          onChange={setOptions}
          onPickImages={async (role) => {
            await onPick(role);
            setOptions((current) => ({
              ...current,
              [role === "portrait" ? "portraits" : "materials"]: [portrait],
            }));
          }}
          onRemoveImage={(role, path) =>
            setOptions((current) => ({
              ...current,
              [role === "portrait" ? "portraits" : "materials"]: (role === "portrait"
                ? current.portraits
                : current.materials
              ).filter((image) => image.localPath !== path),
            }))
          }
        />
      );
    }
    render(<Harness />);
    expect(screen.getByText("请添加人物参考图后开始制作，人物身份将沿用参考图。")).toBeVisible();
    expect(screen.getByText("封面偏好").closest("details")).not.toHaveAttribute("open");
    fireEvent.click(screen.getByRole("button", { name: "添加人物参考图" }));
    expect(await screen.findByRole("img", { name: portrait.displayName })).toBeInTheDocument();
    expect(onPick).toHaveBeenCalledWith("portrait");
    expect(
      screen.queryByText("请添加人物参考图后开始制作，人物身份将沿用参考图。"),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: `移除人物参考图 ${portrait.displayName}` }));
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("封面偏好"));
    expect(screen.getByLabelText("封面风格")).toHaveValue("auto");
    expect(screen.getByLabelText("封面字体风格")).toHaveValue("bold");
    expect(screen.getByLabelText("封面标题颜色")).toHaveValue("yellow");
    expect(screen.getByLabelText("封面交付方式")).toHaveValue("image");
    fireEvent.change(screen.getByLabelText("封面风格"), { target: { value: "ranking" } });
    fireEvent.change(screen.getByLabelText("封面交付方式"), { target: { value: "prompt" } });
    expect(screen.getByLabelText("封面风格")).toHaveValue("ranking");
    expect(screen.getByLabelText("封面交付方式")).toHaveValue("prompt");
  });

  it("publishes a composed Chinese title once without persisting phonetic drafts", () => {
    const onChange = vi.fn<(options: XhsCoverWorkflowOptions) => void>();
    render(
      <XhsCoverConfiguration
        options={createXhsCoverOptions()}
        disabled={false}
        onChange={onChange}
        onPickImages={vi.fn(async () => {})}
        onRemoveImage={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("封面偏好"));
    const title = screen.getByRole("textbox", { name: "封面标题" });
    fireEvent.compositionStart(title);
    fireEvent.change(title, { target: { value: "ri'ben" } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(title, { target: { value: "日本" } });
    fireEvent.compositionEnd(title, { data: "日本" });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ title: "日本" }));
  });

  it("reports picker errors and prevents editing locked or full portrait inputs", async () => {
    const options = { ...createXhsCoverOptions(), portraits: [portrait] };
    const props = {
      options,
      disabled: false,
      onChange: vi.fn(),
      onPickImages: vi.fn(() => Promise.reject(new Error("图片合计超过 14 MB。"))),
      onRemoveImage: vi.fn(),
    };
    const { rerender } = render(<XhsCoverConfiguration {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "添加补充素材" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("图片合计超过 14 MB。");
    expect(screen.getByRole("img", { name: portrait.displayName })).toBeInTheDocument();
    rerender(<XhsCoverConfiguration {...props} disabled />);
    expect(screen.getByRole("button", { name: "添加人物参考图" })).toBeDisabled();
    expect(screen.getByLabelText("封面标题")).toBeDisabled();
    rerender(
      <XhsCoverConfiguration
        {...props}
        options={{
          ...options,
          portraits: [
            portrait,
            { ...portrait, localPath: "second.png" },
            { ...portrait, localPath: "third.png" },
          ],
        }}
      />,
    );
    expect(screen.getByRole("button", { name: "添加人物参考图" })).toBeDisabled();
  });
});

describe("XhsCoverDeliverables", () => {
  it("previews the final cover and exposes document and prompt delivery", async () => {
    const onRevealResult = vi.fn();
    const onExportDocuments = vi.fn();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(
      <XhsCoverDeliverables
        checkpoint={completedCheckpoint()}
        onRevealResult={onRevealResult}
        onExportDocuments={onExportDocuments}
      />,
    );
    const delivery = screen.getByRole("region", { name: "封面交付物" });
    expect(within(delivery).getByRole("img", { name: "封面：零基础做封面" })).toHaveAttribute(
      "src",
      expect.stringContaining("final.png"),
    );
    expect(screen.getByText("封面交付物已就绪")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "打开封面文件" }));
    fireEvent.click(screen.getByRole("button", { name: "导出封面制作文档" }));
    expect(onRevealResult).toHaveBeenCalledOnce();
    expect(onExportDocuments).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByText(/封面方案 ·/));
    fireEvent.click(screen.getByText("完整图片提示词"));
    fireEvent.click(screen.getByRole("button", { name: "复制封面提示词" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("提示词已复制"));
    expect(writeText).toHaveBeenCalledWith(completedCheckpoint().xhsCover!.plan!.prompt);
  });

  it("keeps previous artwork and review records available after a revision", () => {
    const checkpoint = completedCheckpoint();
    const state = checkpoint.xhsCover!;
    render(
      <XhsCoverDeliverables
        checkpoint={{
          ...checkpoint,
          xhsCover: {
            ...state,
            history: [
              {
                plan: state.plan!,
                review: { result: "REVISE", report: "调整人物位置。" },
                imagePath: "C:\\covers\\old.png",
                finalPath: null,
              },
            ],
          },
        }}
      />,
    );
    fireEvent.click(screen.getByText("历史版本（1）"));
    fireEvent.click(screen.getByText("版本 1 · 零基础做封面"));
    expect(screen.getByRole("img", { name: "历史封面 1：零基础做封面" })).toHaveAttribute(
      "src",
      expect.stringContaining("old.png"),
    );
    expect(screen.getByText("调整人物位置。")).toBeInTheDocument();
  });
});
