import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App";
import {
  ACTIVE_CANVAS_STORAGE_KEY,
  canvasDocumentRepository,
} from "./features/canvas/canvasDocumentRepository";
import { fireCanvasMouse } from "./test/canvasEvents";

const PROMPT_INPUT_LABEL = "提示词输入框，输入 @ 引用素材";

function activeCanvas(): HTMLElement {
  return screen.getByRole("region", { name: "无限画布工作区" });
}

async function waitForCanvasReady(): Promise<void> {
  await waitFor(() => expect(screen.getByRole("button", { name: "新建画布" })).toBeEnabled());
}

async function createCanvas(name: string): Promise<void> {
  await waitForCanvasReady();
  fireEvent.click(screen.getByRole("button", { name: "新建画布" }));
  await waitFor(() =>
    expect(screen.getByRole("tab", { name })).toHaveAttribute("aria-selected", "true"),
  );
  await waitForCanvasReady();
}

async function selectCanvas(name: string): Promise<void> {
  await waitForCanvasReady();
  fireEvent.click(screen.getByRole("tab", { name }));
  await waitFor(() =>
    expect(screen.getByRole("tab", { name })).toHaveAttribute("aria-selected", "true"),
  );
  await waitForCanvasReady();
}

async function renameCanvas(previousName: string, name: string): Promise<void> {
  await waitForCanvasReady();
  fireEvent.click(screen.getByRole("button", { name: `重命名画布 ${previousName}` }));
  const input = screen.getByRole("textbox", { name: "画布名称" });
  fireEvent.change(input, { target: { value: name } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() =>
    expect(screen.getByRole("tab", { name })).toHaveAttribute("aria-selected", "true"),
  );
  await waitForCanvasReady();
}

async function addNode(
  kind: "image" | "video" | "prompt",
  clientX = 260,
  clientY = 180,
): Promise<HTMLElement> {
  const labels = {
    image: "拖拽创建图片生成节点",
    video: "拖拽创建视频生成节点",
    prompt: "拖拽创建提示词生成与优化节点",
  };
  const canvas = activeCanvas();
  const selector = `.canvas-gen-node--${kind}`;
  const countBefore = canvas.querySelectorAll(selector).length;
  const viewport = canvas.querySelector<HTMLElement>(".canvas-viewport")!;
  vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 1280,
    bottom: 800,
    width: 1280,
    height: 800,
    toJSON: () => ({}),
  });
  const source = screen.getByRole("button", { name: labels[kind] });
  fireEvent.pointerDown(source, {
    pointerId: 1,
    isPrimary: true,
    button: 0,
    clientX: 20,
    clientY: 20,
  });
  fireEvent.pointerMove(window, { pointerId: 1, isPrimary: true, clientX: 40, clientY: 40 });
  fireEvent.pointerUp(window, { pointerId: 1, isPrimary: true, button: 0, clientX, clientY });
  await waitFor(() => expect(canvas.querySelectorAll(selector)).toHaveLength(countBefore + 1));
  const node = Array.from(canvas.querySelectorAll<HTMLElement>(selector)).at(-1)!;
  await waitFor(() =>
    expect(node.closest(".react-flow__node")).toHaveStyle({ visibility: "visible" }),
  );
  return node;
}

function setPromptText(node: HTMLElement, text: string): void {
  const input = within(node).getByRole("textbox", { name: PROMPT_INPUT_LABEL });
  const target = input.querySelector<HTMLElement>(":scope > p") ?? input;
  target.replaceChildren(document.createTextNode(text));
  const range = document.createRange();
  range.selectNodeContents(target);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  fireEvent.input(input);
}

function nodePosition(node: HTMLElement): { x: number; y: number } {
  const transform = node.closest<HTMLElement>(".react-flow__node")!.style.transform;
  const match = transform.match(/translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/);
  expect(match).not.toBeNull();
  return { x: Number.parseFloat(match![1]!), y: Number.parseFloat(match![2]!) };
}

function viewportTransform(): string {
  return activeCanvas().querySelector<HTMLElement>(".react-flow__viewport")!.style.transform;
}

function viewportValues(transform: string): number[] {
  const match = transform.match(/translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)\s*scale\(([\d.]+)\)/);
  expect(match).not.toBeNull();
  return match!.slice(1).map(Number);
}

function expectViewportToMatch(transform: string): void {
  const expected = viewportValues(transform);
  const actual = viewportValues(viewportTransform());
  expect(actual[0]).toBeCloseTo(expected[0]!, 1);
  expect(actual[1]).toBeCloseTo(expected[1]!, 1);
  // 画布视图以整数百分比保存；滚轮的连续缩放允许这一舍入误差。
  expect(actual[2]).toBeCloseTo(expected[2]!, 2);
}

function clientFromFlow({ x, y }: { x: number; y: number }): { clientX: number; clientY: number } {
  const match = viewportTransform().match(
    /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)\s*scale\(([\d.]+)\)/,
  );
  expect(match).not.toBeNull();
  const [panX, panY, zoom] = match!.slice(1).map(Number);
  return { clientX: x * zoom! + panX!, clientY: y * zoom! + panY! };
}

function connectNodes(source: HTMLElement, target: HTMLElement): void {
  const handle = source
    .closest(".react-flow__node")!
    .querySelector<HTMLElement>(".react-flow__handle.source");
  expect(handle).not.toBeNull();
  const from = nodePosition(source);
  fireCanvasMouse(handle!, "mousedown", clientFromFlow(from));
  fireCanvasMouse(document, "mousemove", clientFromFlow({ x: from.x + 2, y: from.y + 2 }));
  const destination = clientFromFlow(nodePosition(target));
  fireCanvasMouse(document, "mousemove", destination);
  fireCanvasMouse(document, "mouseup", destination);
}

beforeEach(() => {
  delete (window as unknown as Record<string, unknown>)["__TAURI_INTERNALS__"];
  delete (window as unknown as Record<string, unknown>)["__TAURI_EVENT_PLUGIN_INTERNALS__"];
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("App independent canvases", () => {
  it("keeps a requested rename when autosave runs while the rename response is pending", async () => {
    render(<App />);
    await waitForCanvasReady();
    const image = await addNode("image");
    setPromptText(image, "重命名前的提示词");
    const originalSave = canvasDocumentRepository.save;
    let releaseRename!: () => void;
    const renameResponse = new Promise<void>((resolve) => {
      releaseRename = resolve;
    });
    let renameBlocked = false;
    const save = vi.spyOn(canvasDocumentRepository, "save").mockImplementation(async (command) => {
      const record = await originalSave(command);
      if (!renameBlocked && command.title === "夏季商品摄影") {
        renameBlocked = true;
        await renameResponse;
      }
      return record;
    });
    fireEvent.click(screen.getByRole("button", { name: "重命名画布 未命名画布" }));
    fireEvent.change(screen.getByRole("textbox", { name: "画布名称" }), {
      target: { value: "夏季商品摄影" },
    });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "画布名称" }), { key: "Enter" });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "新建画布" })).toBeDisabled();
    setPromptText(image, "重命名等待期间继续补充的新提示词");
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2), { timeout: 2500 });
    expect(save.mock.calls[1]?.[0].title).toBe("夏季商品摄影");
    expect(JSON.stringify(save.mock.calls[1]?.[0].document)).toContain(
      "重命名等待期间继续补充的新提示词",
    );

    await act(async () => {
      releaseRename();
      await renameResponse;
    });
    await waitForCanvasReady();
    const saved = await canvasDocumentRepository.get(save.mock.calls[0]![0].id);
    expect(saved.title).toBe("夏季商品摄影");
    expect(JSON.stringify(saved.document)).toContain("重命名等待期间继续补充的新提示词");
  });

  it("keeps nodes, connected prompts, viewport and undo history independent across three canvases", async () => {
    render(<App />);
    await waitForCanvasReady();
    const prompt = await addNode("prompt");
    fireEvent.change(within(prompt).getByRole("textbox", { name: "生成提示词输出" }), {
      target: { value: "第一场景的暖色商品摄影" },
    });
    const image = await addNode("image", 920, 180);
    connectNodes(prompt, image);
    await waitFor(() =>
      expect(activeCanvas().querySelectorAll(".react-flow__edge")).toHaveLength(1),
    );
    await waitFor(() =>
      expect(within(image).getByRole("textbox", { name: PROMPT_INPUT_LABEL })).toHaveTextContent(
        "第一场景的暖色商品摄影",
      ),
    );
    setPromptText(image, "第一場景手工补充的商品细节");

    const pane = activeCanvas().querySelector<HTMLElement>(".react-flow__pane")!;
    fireCanvasMouse(pane, "mousedown", { clientX: 300, clientY: 200 });
    fireCanvasMouse(document, "mousemove", { clientX: 360, clientY: 240 });
    fireCanvasMouse(document, "mouseup", { clientX: 360, clientY: 240 });
    fireEvent.wheel(pane, {
      deltaY: -100,
      clientX: 500,
      clientY: 400,
    });
    await waitFor(() => expect(within(activeCanvas()).getByText("115%")).toBeInTheDocument());
    const firstView = viewportTransform();
    const firstPosition = image.closest<HTMLElement>(".react-flow__node")!.style.transform;

    await createCanvas("画布 2");
    expect(within(activeCanvas()).getByText("画布为空")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "撤销画布操作" })).toBeDisabled();
    const video = await addNode("video");
    setPromptText(video, "第二场景的太空追逐镜头");
    const secondView = viewportTransform();
    expect(secondView).not.toBe(firstView);

    await createCanvas("画布 3");
    expect(within(activeCanvas()).getByText("画布为空")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "撤销画布操作" })).toBeDisabled();
    await addNode("image");
    fireEvent.click(screen.getByRole("button", { name: "撤销画布操作" }));
    await waitFor(() =>
      expect(activeCanvas().querySelectorAll(".react-flow__node")).toHaveLength(0),
    );

    await selectCanvas("未命名画布");
    expect(activeCanvas().querySelectorAll(".react-flow__node")).toHaveLength(2);
    expect(activeCanvas().querySelectorAll(".react-flow__edge")).toHaveLength(1);
    expect(
      within(activeCanvas()).getByRole("textbox", { name: PROMPT_INPUT_LABEL }),
    ).toHaveTextContent("第一場景手工补充的商品细节");
    await waitFor(() => expectViewportToMatch(firstView));
    expect(
      activeCanvas().querySelector(".canvas-gen-node--image")!.closest(".react-flow__node"),
    ).toHaveStyle({ transform: firstPosition });

    await selectCanvas("画布 2");
    expect(activeCanvas().querySelectorAll(".react-flow__node")).toHaveLength(1);
    expect(activeCanvas().querySelectorAll(".react-flow__edge")).toHaveLength(0);
    expect(
      within(activeCanvas()).getByRole("textbox", { name: PROMPT_INPUT_LABEL }),
    ).toHaveTextContent("第二场景的太空追逐镜头");
    await waitFor(() => expectViewportToMatch(secondView));

    await selectCanvas("画布 3");
    expect(screen.getByRole("button", { name: "重做画布操作" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "重做画布操作" }));
    await waitFor(() =>
      expect(activeCanvas().querySelectorAll(".react-flow__node")).toHaveLength(1),
    );
  });

  it("restores all renamed tabs, the active canvas and each canvas's editor content after remount", async () => {
    const view = render(<App />);
    await waitForCanvasReady();
    setPromptText(await addNode("image"), "商品场景中独立保存的提示词");
    await renameCanvas("未命名画布", "商品摄影");

    await createCanvas("画布 2");
    setPromptText(await addNode("video"), "故事场景中独立保存的提示词");
    await renameCanvas("画布 2", "故事分镜");

    await createCanvas("画布 3");
    const prompt = await addNode("prompt");
    fireEvent.change(within(prompt).getByRole("textbox", { name: "创意或需求" }), {
      target: { value: "第三场景的创意草稿" },
    });
    await renameCanvas("画布 3", "实验场景");
    await selectCanvas("故事分镜");
    const activeId = window.localStorage.getItem(ACTIVE_CANVAS_STORAGE_KEY);
    expect(activeId).toBeTruthy();

    await act(async () => {
      view.unmount();
      await canvasDocumentRepository.list();
    });
    render(<App />);
    await waitForCanvasReady();
    expect(
      within(screen.getByRole("tablist", { name: "创作画布" })).getAllByRole("tab"),
    ).toHaveLength(3);
    expect(screen.getByRole("tab", { name: "故事分镜" })).toHaveAttribute("aria-selected", "true");
    expect(window.localStorage.getItem(ACTIVE_CANVAS_STORAGE_KEY)).toBe(activeId);
    await waitFor(() =>
      expect(
        within(activeCanvas()).getByRole("textbox", { name: PROMPT_INPUT_LABEL }),
      ).toHaveTextContent("故事场景中独立保存的提示词"),
    );
    expect(activeCanvas().querySelectorAll(".canvas-gen-node--video")).toHaveLength(1);
    expect(activeCanvas().querySelectorAll(".canvas-gen-node--image")).toHaveLength(0);

    await selectCanvas("商品摄影");
    await waitFor(() =>
      expect(
        within(activeCanvas()).getByRole("textbox", { name: PROMPT_INPUT_LABEL }),
      ).toHaveTextContent("商品场景中独立保存的提示词"),
    );
    expect(activeCanvas().querySelectorAll(".canvas-gen-node--image")).toHaveLength(1);
    expect(activeCanvas().querySelectorAll(".canvas-gen-node--video")).toHaveLength(0);

    await selectCanvas("实验场景");
    await waitFor(() =>
      expect(within(activeCanvas()).getByRole("textbox", { name: "创意或需求" })).toHaveValue(
        "第三场景的创意草稿",
      ),
    );
    expect(activeCanvas().querySelectorAll(".react-flow__node")).toHaveLength(1);
  });
});
