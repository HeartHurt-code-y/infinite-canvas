import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { PromptContentConnection } from "../../lib/promptContent";
import type { SeedanceTaskMode } from "../../lib/seedanceTasks";
import {
  createWhiteModelControlConfig,
  type WhiteModelControlConfig,
} from "../../lib/whiteModelControl";
import { WhiteModelControlSection } from "./WhiteModelControlSection";

const MODEL = "doubao-seedance-2-5-260628";

function media(
  key: string,
  kind: "image" | "video",
  name = key,
  path = `C:/fixtures/${key}.${kind === "video" ? "mp4" : "png"}`,
): PromptContentConnection {
  return {
    key,
    kind,
    name,
    target: { kind: "local_file", canvasNodeKey: key, mediaType: kind, path },
  };
}

const source = media("white-model", "video", "走位预演");
const character = media("character", "image", "角色设定");
const scene = media("scene", "image", "场景设定");
const inputs = [source, character, scene];

function configured(): WhiteModelControlConfig {
  return {
    ...createWhiteModelControlConfig(),
    enabled: true,
    source: { key: source.key, name: source.name, target: source.target },
    timeline: "0–3 秒：角色向门口走去。",
  };
}

function Harness({
  initial = createWhiteModelControlConfig(),
  connections = inputs,
  modelId = MODEL,
  taskMode = "reference",
  changed,
}: {
  readonly initial?: WhiteModelControlConfig;
  readonly connections?: readonly PromptContentConnection[];
  readonly modelId?: string;
  readonly taskMode?: SeedanceTaskMode;
  readonly changed: (next: WhiteModelControlConfig) => void;
}) {
  const [config, setConfig] = useState(initial);
  return (
    <WhiteModelControlSection
      config={config}
      inputs={connections}
      modelId={modelId}
      taskMode={taskMode}
      onChange={(next) => {
        changed(next);
        setConfig(next);
      }}
    />
  );
}

async function selectOption(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  option: string,
) {
  const select = screen.getByLabelText(label);
  await user.selectOptions(select, within(select).getByRole("option", { name: option }));
}

describe("WhiteModelControlSection", () => {
  it("requires explicit source selection and edits both prompt formulas without losing mappings", async () => {
    const user = userEvent.setup();
    const changed = vi.fn<(next: WhiteModelControlConfig) => void>();
    render(<Harness changed={changed} />);

    await user.click(screen.getByText("专业级白模控制"));
    await user.click(screen.getByRole("checkbox", { name: "启用白模控制" }));
    expect(screen.getByLabelText("白模参考视频")).toHaveValue("");
    expect(changed.mock.lastCall?.[0].source).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("请选择白模参考视频");

    await selectOption(user, "白模参考视频", "视频 1 · 走位预演");
    await user.click(screen.getByRole("button", { name: "添加对应关系" }));
    await user.type(screen.getByLabelText("模型特征 1"), "红色圆柱体");
    await selectOption(user, "角色 / 道具参考图 1", "图片 1 · 角色设定");
    await user.type(screen.getByLabelText("角色 / 道具设定 1"), "银色机甲战士");
    await user.type(screen.getByLabelText("时间线与剧情"), "0–3 秒：朝门口跑去。");
    await selectOption(user, "场景参考图", "图片 2 · 场景设定");
    await user.type(screen.getByLabelText("场景处理"), "使用场景图中的仓库。");
    await user.type(screen.getByLabelText("材质、风格与整体收束"), "保持金属材质，加入脚步声。");
    await user.click(screen.getByRole("checkbox", { name: "音乐音效" }));

    const coarse = changed.mock.lastCall?.[0];
    expect(coarse).toMatchObject({
      source: { key: source.key, target: source.target },
      sceneReference: { key: scene.key, target: scene.target },
      mappings: [
        {
          modelPart: "红色圆柱体",
          description: "银色机甲战士",
          reference: { key: character.key, target: character.target },
        },
      ],
    });
    expect(coarse?.controls).toContain("audio");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.click(screen.getByText("查看将提交的白模提示词"));
    const preview = screen.getByRole("textbox", { name: "白模提示词预览" });
    expect(preview).toHaveAttribute("readonly");
    expect(preview).toHaveDisplayValue(/【对应关系映射】/);
    expect(preview).toHaveDisplayValue(/红色圆柱体/);
    expect(preview).toHaveDisplayValue(/加入脚步声/);

    await selectOption(user, "白模颗粒度", "细颗粒度 · 成片渲染");
    expect(screen.getByLabelText("分段渲染描述")).toHaveValue("0–3 秒：朝门口跑去。");
    expect(screen.getByLabelText("模型特征 1")).toHaveValue("红色圆柱体");
    expect(preview).toHaveDisplayValue(/【渲染指令】/);
    expect(preview).toHaveDisplayValue(/【模型渲染要求】/);
    expect(screen.getByText(/导出前请去除轨迹线/)).toBeInTheDocument();
    await selectOption(user, "白模颗粒度", "粗颗粒度 · 动态骨架");
    expect(changed.mock.lastCall?.[0].mappings).toEqual(coarse?.mappings);
    await user.click(screen.getByRole("button", { name: "移除对应关系 1" }));
    expect(changed.mock.lastCall?.[0].mappings).toEqual([]);
  });

  it("preserves source identity when its connection changes and only rebinds on explicit selection", async () => {
    const user = userEvent.setup();
    const changed = vi.fn<(next: WhiteModelControlConfig) => void>();
    const view = render(<Harness changed={changed} initial={configured()} />);
    const replacement = media(source.key, "video", source.name, "C:/fixtures/replaced.mp4");
    view.rerender(<Harness changed={changed} connections={[replacement, character, scene]} />);

    const sourceSelect = screen.getByLabelText("白模参考视频");
    expect(sourceSelect).toHaveValue("unavailable");
    expect(sourceSelect).toHaveAttribute("aria-invalid", "true");
    expect(within(sourceSelect).getByRole("option", { name: /已断开\/来源已变化/ })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("来源已变化");
    expect(changed).not.toHaveBeenCalled();
    fireEvent.change(sourceSelect, { target: { value: "unavailable" } });
    expect(changed).not.toHaveBeenCalled();

    await selectOption(user, "白模参考视频", "视频 1 · 走位预演");
    expect(changed.mock.lastCall?.[0].source?.target).toEqual(replacement.target);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    view.rerender(<Harness changed={changed} connections={[character, scene]} />);
    expect(screen.getByLabelText("白模参考视频")).toHaveValue("unavailable");
    expect(screen.getByRole("alert")).toHaveTextContent("已断开连接");
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("retains missing character and scene bindings despite same-name replacement inputs", () => {
    const changed = vi.fn<(next: WhiteModelControlConfig) => void>();
    const config: WhiteModelControlConfig = {
      ...configured(),
      mappings: [{ id: "red", modelPart: "红色方块", description: "角色", reference: character }],
      sceneReference: scene,
    };
    const view = render(<Harness changed={changed} initial={config} />);
    view.rerender(
      <Harness
        changed={changed}
        connections={[
          source,
          media("other-character", "image", character.name),
          media(scene.key, "image", scene.name, "C:/fixtures/new-scene.png"),
        ]}
      />,
    );
    expect(screen.getByLabelText("角色 / 道具参考图 1")).toHaveValue("unavailable");
    expect(screen.getByLabelText("场景参考图")).toHaveValue("unavailable");
    expect(screen.getByRole("alert")).toHaveTextContent("已断开连接");
    expect(changed).not.toHaveBeenCalled();
  });

  it("distinguishes same-name options by media position", () => {
    render(
      <Harness
        changed={vi.fn()}
        initial={configured()}
        connections={[source, character, media("other-video", "video", source.name)]}
      />,
    );
    const select = screen.getByLabelText("白模参考视频");
    expect(within(select).getByRole("option", { name: "视频 1 · 走位预演" })).toBeInTheDocument();
    expect(within(select).getByRole("option", { name: "视频 2 · 走位预演" })).toBeInTheDocument();
  });

  it.each([
    ["wan3.0-video", "reference", "Seedance 2.5"],
    [MODEL, "edit", "请先切换任务类型"],
  ] as const)(
    "allows disabling retained settings on incompatible %s / %s",
    async (modelId, taskMode, issue) => {
      const user = userEvent.setup();
      const changed = vi.fn<(next: WhiteModelControlConfig) => void>();
      const config = configured();
      render(<Harness changed={changed} initial={config} modelId={modelId} taskMode={taskMode} />);
      expect(screen.getByRole("alert")).toHaveTextContent(issue);
      await user.click(screen.getByRole("checkbox", { name: "启用白模控制" }));
      expect(changed.mock.lastCall?.[0]).toEqual({ ...config, enabled: false });
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    },
  );
});
