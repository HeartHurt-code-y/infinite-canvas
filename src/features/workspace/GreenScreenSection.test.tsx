import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { createGreenScreenConfig, type GreenScreenConfig } from "../../lib/greenScreen";
import type { PromptContentConnection } from "../../lib/promptContent";
import { GreenScreenSection, type GreenScreenSectionProps } from "./GreenScreenSection";

const MODEL = "doubao-seedance-2-5-260628";
function media(key: string, kind: "image" | "video", name: string): PromptContentConnection {
  return {
    key,
    kind,
    name,
    target: {
      kind: "local_file",
      canvasNodeKey: key,
      mediaType: kind,
      path: `C:/fixtures/${key}.${kind === "video" ? "mp4" : "png"}`,
    },
  };
}
const green = media("green", "video", "绿幕角色");
const second = media("second", "video", "绿幕道具");
const background = media("background", "image", "夜晚街道");
const inputs = [green, second, background];

function Harness({
  initial = { ...createGreenScreenConfig(), enabled: true },
  connections = inputs,
  changed = vi.fn(),
  ...props
}: Omit<GreenScreenSectionProps, "inputs" | "onChange" | "modelId" | "config"> & {
  readonly initial?: GreenScreenConfig;
  readonly connections?: readonly PromptContentConnection[];
  readonly changed?: (config: GreenScreenConfig) => void;
}) {
  const [config, setConfig] = useState(initial);
  return (
    <GreenScreenSection
      {...props}
      config={config}
      inputs={connections}
      modelId={MODEL}
      onChange={(next) => {
        changed(next);
        setConfig(next);
      }}
    />
  );
}

async function select(user: ReturnType<typeof userEvent.setup>, label: string, option: string) {
  const field = screen.getByLabelText(label);
  await user.selectOptions(field, within(field).getByRole("option", { name: option }));
}

describe("GreenScreenSection", () => {
  it("requires explicit reviewed foreground selection and supports multiple foregrounds before composition", async () => {
    const user = userEvent.setup();
    const changed = vi.fn<(config: GreenScreenConfig) => void>();
    const generate = vi.fn();
    render(<Harness changed={changed} onGenerate={generate} />);
    await user.click(screen.getByRole("button", { name: "3 · 融合成片" }));
    expect(screen.getByRole("button", { name: "生成融合成片" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("至少选择一段绿幕前景");
    expect(changed.mock.lastCall?.[0].foregrounds).toEqual([]);

    await select(user, "添加已连接的绿幕视频", "视频 · 绿幕角色");
    expect(changed.mock.lastCall?.[0].foregrounds).toEqual([]);
    await user.click(screen.getByRole("button", { name: "添加为绿幕前景" }));
    await select(user, "添加已连接的绿幕视频", "视频 · 绿幕道具");
    await user.click(screen.getByRole("button", { name: "添加为绿幕前景" }));
    await select(user, "背景场景参考", "图片 · 夜晚街道");
    expect(changed.mock.lastCall?.[0].foregrounds.map((binding) => binding.key)).toEqual([
      green.key,
      second.key,
    ]);
    expect(screen.getByRole("button", { name: "生成融合成片" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "生成融合成片" }));
    expect(generate).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "移除绿幕前景 1 绿幕角色" }));
    expect(changed.mock.lastCall?.[0].foregrounds.map((binding) => binding.key)).toEqual([
      second.key,
    ]);
  });

  it("prepares a green-screen conversion without submitting the selected composition background", async () => {
    const user = userEvent.setup();
    const generate = vi.fn();
    render(
      <Harness
        initial={{ ...createGreenScreenConfig(), enabled: true, background, scene: "夜晚街道" }}
        onGenerate={generate}
      />,
    );
    await select(user, "绿幕制作方式", "现有视频转绿幕");
    expect(screen.getByRole("button", { name: "将原视频转为绿幕" })).toBeDisabled();
    await select(user, "待转绿幕的原视频", "视频 · 绿幕角色");
    await user.click(screen.getByText("查看本步绿幕提示词"));
    const preview = screen.getByRole("textbox", { name: "绿幕提示词预览" });
    expect(preview).toHaveDisplayValue(/绿幕角色/);
    expect(preview).not.toHaveDisplayValue(/夜晚街道/);
    await user.click(screen.getByRole("button", { name: "将原视频转为绿幕" }));
    expect(generate).toHaveBeenCalledOnce();
  });

  it("shows preparation results for review and only uses a version after an explicit click", async () => {
    const user = userEvent.setup();
    const useResult = vi.fn();
    const changed = vi.fn();
    render(
      <Harness
        changed={changed}
        onUseResult={useResult}
        results={[
          {
            key: "take-1",
            name: "第 1 版",
            src: "/green.mp4",
            taskId: "task-1",
            finalPath: "C:/green.mp4",
          },
        ]}
      />,
    );
    expect(screen.getByLabelText("绿幕预览 第 1 版")).toHaveAttribute("controls");
    expect(useResult).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "使用这版绿幕进入合成" }));
    expect(useResult).toHaveBeenCalledExactlyOnceWith("take-1");
  });

  it("keeps changed media identity invalid until the user explicitly replaces it", async () => {
    const user = userEvent.setup();
    const changed = vi.fn<(config: GreenScreenConfig) => void>();
    const initial: GreenScreenConfig = {
      ...createGreenScreenConfig(),
      enabled: true,
      phase: "composite",
      foregrounds: [green],
      background,
    };
    const replacement: PromptContentConnection = {
      ...green,
      target: {
        kind: "local_file",
        canvasNodeKey: green.key,
        mediaType: "video",
        path: "C:/fixtures/replaced.mp4",
      },
    };
    const view = render(<Harness initial={initial} changed={changed} onGenerate={vi.fn()} />);
    view.rerender(
      <Harness
        initial={initial}
        changed={changed}
        connections={[replacement, background]}
        onGenerate={vi.fn()}
      />,
    );
    expect(changed).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("来源已变化");
    expect(screen.getByRole("button", { name: "生成融合成片" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "移除绿幕前景 1 绿幕角色" }));
    await select(user, "添加已连接的绿幕视频", "视频 · 绿幕角色");
    await user.click(screen.getByRole("button", { name: "添加为绿幕前景" }));
    expect(changed.mock.lastCall?.[0].foregrounds[0]?.target).toEqual(replacement.target);
    expect(screen.getByRole("button", { name: "生成融合成片" })).toBeEnabled();
  });

  it("enters composition from existing reviewed video and locks controls while a task runs", async () => {
    const user = userEvent.setup();
    const changed = vi.fn<(config: GreenScreenConfig) => void>();
    const initial: GreenScreenConfig = {
      ...createGreenScreenConfig(),
      enabled: true,
      preparationMode: "existing",
    };
    const view = render(<Harness initial={initial} changed={changed} onGenerate={vi.fn()} />);
    expect(screen.getByRole("button", { name: "确认绿幕并进入合成" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "生成绿幕视频" })).not.toBeInTheDocument();
    await select(user, "添加已连接的绿幕视频", "视频 · 绿幕角色");
    await user.click(screen.getByRole("button", { name: "添加为绿幕前景" }));
    await user.click(screen.getByRole("button", { name: "确认绿幕并进入合成" }));
    expect(changed.mock.lastCall?.[0].phase).toBe("composite");
    fireEvent.change(screen.getByLabelText("新场景描述"), { target: { value: "森林" } });
    view.rerender(<Harness initial={initial} changed={changed} onGenerate={vi.fn()} busy />);
    expect(screen.getByRole("checkbox", { name: "启用无缝绿幕编辑" })).toBeDisabled();
    expect(screen.getByLabelText("新场景描述")).toBeDisabled();
    expect(screen.getByRole("button", { name: "正在生成…" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("本步正在生成");
  });
});
