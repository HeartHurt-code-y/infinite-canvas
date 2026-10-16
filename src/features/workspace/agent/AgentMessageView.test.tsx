import { act, fireEvent, render, screen } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CanvasStoreProvider,
  useCanvasCommands,
  type CanvasCommands,
} from "../../canvas/canvasStore";
import { AgentMessageView, AgentNodeKeyText } from "./AgentMessageView";

/**
 * 芯片是「客户看不懂节点代号」的直接解法：识别口径（形状 ∧ 当前画布存在）
 * 在 agentNodeKeyRefs.test.ts 钉住，这里钉渲染行为——已知代号出芯片、点击
 * 回调定位、删除后代号退回纯文本、链接里的候选不误切、画布后到时补识别。
 */

const DOWNLOADER_KEY = "downloader-ab12cd34";
const COMPOSER_KEY = "composer-ef56ab78";

function seedCanvas(commands: CanvasCommands) {
  commands.addNode("videoDownloader", {
    key: DOWNLOADER_KEY,
    kind: "video_downloader",
    x: 0,
    y: 0,
    config: { url: "" },
  });
  commands.addNode("videoComposer", {
    key: COMPOSER_KEY,
    kind: "video_composer",
    x: 100,
    y: 0,
    config: { outputName: "成片A", inputOrder: [] },
  });
}

/** Seed 只记录 commands；何时种节点由用例决定，覆盖水合前后的两种时序。 */
function renderWithCanvas(ui: ReactNode) {
  const ref: { commands: CanvasCommands | null } = { commands: null };
  function Seed() {
    const canvasCommands = useCanvasCommands();
    useEffect(() => {
      ref.commands = canvasCommands;
    }, [canvasCommands]);
    return null;
  }
  const view = render(
    <CanvasStoreProvider initialZoom={100}>
      <Seed />
      {ui}
    </CanvasStoreProvider>,
  );
  return {
    ...view,
    commands: () => ref.commands!,
    seed: () =>
      act(() => {
        seedCanvas(ref.commands!);
      }),
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("AgentMessageView 节点代号芯片", () => {
  it("行内代码与纯文本里的已知代号都渲染为芯片，显示类型与名称", () => {
    const view = renderWithCanvas(
      <AgentMessageView
        content={`已连接 \`${COMPOSER_KEY}\`，同时参考 ${DOWNLOADER_KEY} 的产物。`}
      />,
    );
    view.seed();
    const composerChip = screen.getByRole("button", { name: /视频合成「成片A」/ });
    expect(composerChip).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /视频下载节点/ })).toBeInTheDocument();
    expect(composerChip).toHaveAttribute("title", expect.stringContaining(COMPOSER_KEY));
  });

  it("点击芯片回调定位目标节点", () => {
    const onFocusNodeKey = vi.fn();
    const view = renderWithCanvas(
      <AgentMessageView content={`见 ${COMPOSER_KEY}。`} onFocusNodeKey={onFocusNodeKey} />,
    );
    view.seed();
    fireEvent.click(screen.getByRole("button", { name: /视频合成「成片A」/ }));
    expect(onFocusNodeKey).toHaveBeenCalledWith(COMPOSER_KEY);
  });

  it("形状像代号但不在当前画布的文本保持原样，不出可点击控件", () => {
    const view = renderWithCanvas(
      <AgentMessageView content="候选 gen-zzzz9999 与 asset-photo.png 都不是节点。" />,
    );
    view.seed();
    expect(document.querySelector("button.canvas-node-chip")).toBeNull();
    expect(screen.getByText(/gen-zzzz9999/)).toBeInTheDocument();
  });

  it("链接里的代号不切成芯片，链接保持原行为", () => {
    const view = renderWithCanvas(
      <AgentMessageView
        content={`[查看 ${DOWNLOADER_KEY}](https://example.com/downloader-ab12cd34)`}
      />,
    );
    view.seed();
    expect(document.querySelector("button.canvas-node-chip")).toBeNull();
    const anchor = document.querySelector(".markdown-view a");
    expect(anchor).toHaveAttribute("href", "https://example.com/downloader-ab12cd34");
  });

  it("节点删除后芯片随重新解析退回纯文本，不再渲染按钮", () => {
    const view = renderWithCanvas(
      <AgentMessageView content={`已连接 ${COMPOSER_KEY} 作为输入。`} />,
    );
    view.seed();
    expect(screen.getByRole("button", { name: /视频合成「成片A」/ })).toBeInTheDocument();
    act(() => {
      view.commands().removeNode(COMPOSER_KEY);
    });
    // 成员变化触发整条消息重解析：目标已不存在，代号诚实退回纯文本。
    expect(document.querySelector("button.canvas-node-chip")).toBeNull();
    expect(screen.getByText(/已连接 composer-ef56ab78 作为输入。/)).toBeInTheDocument();
  });

  it("画布就绪前渲染的消息在节点落卡后被重新识别", () => {
    const view = renderWithCanvas(<AgentMessageView content={`见 ${COMPOSER_KEY}。`} />);
    expect(document.querySelector("button.canvas-node-chip")).toBeNull();
    view.seed();
    expect(screen.getByRole("button", { name: /视频合成「成片A」/ })).toBeInTheDocument();
  });
});

describe("AgentNodeKeyText 纯文本代号", () => {
  it("计划参数摘要里的已知代号渲染为芯片，未知候选保持原文", () => {
    const view = renderWithCanvas(
      <p>
        <AgentNodeKeyText text={`目标节点：${DOWNLOADER_KEY}；其余 gen-zzzz9999 忽略。`} />
      </p>,
    );
    view.seed();
    expect(screen.getByRole("button", { name: /视频下载节点/ })).toBeInTheDocument();
    expect(screen.getByText(/目标节点：/)).toBeInTheDocument();
    expect(screen.getByText(/gen-zzzz9999 忽略。/)).toBeInTheDocument();
  });
});
