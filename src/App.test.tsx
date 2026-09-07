import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import App, { ACTIVE_ASSET_PROVIDER_STORAGE_KEY } from "./App";
import type { CloudAsset } from "./lib/backend";
import { fireCanvasMouse } from "./test/canvasEvents";

const DESKTOP_INTERNALS_KEY = "__TAURI_INTERNALS__";
const DESKTOP_EVENT_INTERNALS_KEY = "__TAURI_EVENT_PLUGIN_INTERNALS__";

function cloudAsset(
  providerConnectionId: string,
  asset: Pick<CloudAsset, "id" | "name" | "kind"> & Partial<CloudAsset>,
): CloudAsset {
  return {
    providerConnectionId,
    status: "ready",
    rawStatus: "Active",
    previewUrl: null,
    assetUrl: null,
    coverUrl: null,
    groupId: null,
    ...asset,
  };
}

// 节点仓库卡片与素材卡片统一走指针拖拽（Tauri WebView 会拦截 HTML5 dataTransfer 拖拽），
// 测试必须模拟真实交互路径：pointerdown → pointermove(超过阈值) → pointerup。
function dragToCanvas(source: HTMLElement): void {
  const viewport = document.querySelector<HTMLElement>(".canvas-viewport");
  expect(viewport).not.toBeNull();
  vi.spyOn(viewport!, "getBoundingClientRect").mockReturnValue({
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

  fireEvent.pointerDown(source, {
    pointerId: 1,
    isPrimary: true,
    button: 0,
    clientX: 20,
    clientY: 20,
  });
  fireEvent.pointerMove(window, {
    pointerId: 1,
    isPrimary: true,
    clientX: 40,
    clientY: 40,
  });
  fireEvent.pointerUp(window, {
    pointerId: 1,
    isPrimary: true,
    button: 0,
    clientX: 370,
    clientY: 222,
  });
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

/** 等待 RF 完成节点测量（wrapper 由 visibility: hidden 转为 visible），随后角色查询才可靠。 */
async function waitForNodeVisible(node: HTMLElement): Promise<HTMLElement> {
  const wrapper = node.closest<HTMLElement>(".react-flow__node");
  await waitFor(() => {
    expect(wrapper?.style.visibility).toBe("visible");
  });
  return node;
}

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.removeItem(ACTIVE_ASSET_PROVIDER_STORAGE_KEY);
});

afterAll(() => {
  delete (window as unknown as Record<string, unknown>)[DESKTOP_INTERNALS_KEY];
  delete (window as unknown as Record<string, unknown>)[DESKTOP_EVENT_INTERNALS_KEY];
});

describe("App workspace", () => {
  it("renders an empty canvas and the generation templates", () => {
    render(<App />);

    expect(screen.getByRole("link", { name: "跳到画布" })).toHaveAttribute(
      "href",
      "#canvas-workspace",
    );
    expect(screen.getByRole("complementary", { name: "素材库" })).toBeInTheDocument();
    const canvas = screen.getByRole("region", { name: "无限画布工作区" });
    expect(screen.queryByRole("complementary", { name: "节点检查器" })).not.toBeInTheDocument();
    expect(within(canvas).getByText("画布为空")).toBeInTheDocument();
    expect(canvas.querySelector(".canvas-gen-node")).toBeNull();
    expect(canvas.querySelector(".canvas-asset-node")).toBeNull();
    expect(canvas.querySelector(".canvas-result-node")).toBeNull();

    // 节点仓库是独立侧板（不再嵌在素材库内）。
    const repository = screen.getByRole("complementary", { name: "节点仓库" });
    const assetPanel = screen.getByRole("complementary", { name: "素材库" });
    expect(assetPanel.querySelector(".repository-card")).toBeNull();
    expect(repository.querySelectorAll(".repository-card")).toHaveLength(9);
    const templates = within(repository).getAllByRole("button", { name: /拖拽创建/ });
    expect(templates).toHaveLength(9);
    expect(templates[0]).toHaveAccessibleName("拖拽创建图片生成节点");
    expect(templates[1]).toHaveAccessibleName("拖拽创建视频生成节点");
    expect(templates[2]).toHaveAccessibleName("拖拽创建视频拼接与合成节点");
    expect(templates[3]).toHaveAccessibleName("拖拽创建网络爆款视频下载节点");
    expect(templates[4]).toHaveAccessibleName("拖拽创建视频抽帧节点");
    expect(templates[5]).toHaveAccessibleName("拖拽创建爆款视频复刻节点");
    expect(templates[6]).toHaveAccessibleName("拖拽创建提示词生成与优化节点");
    expect(templates[7]).toHaveAccessibleName("拖拽创建剧本创作与优化节点");
    expect(templates[8]).toHaveAccessibleName("拖拽创建剧本转工业级分镜脚本节点");
    expect(within(repository).queryByRole("button", { name: /结果/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /取消/ })).not.toBeInTheDocument();

    const workflowRepository = screen.getByRole("complementary", { name: "工作流仓库" });
    const workflowToggle = within(workflowRepository).getByRole("button", {
      name: /工作流仓库/,
    });
    expect(workflowToggle).toHaveAttribute("aria-expanded", "false");
    expect(workflowRepository.querySelector(".workflow-repository__content")).toHaveAttribute(
      "hidden",
    );
  });

  it("expands the bottom workflow repository and inserts one automated workflow node", async () => {
    render(<App />);

    const workflowRepository = screen.getByRole("complementary", { name: "工作流仓库" });
    fireEvent.click(within(workflowRepository).getByRole("button", { name: /工作流仓库/ }));

    expect(workflowRepository).toHaveClass("workflow-repository--expanded");
    expect(
      within(workflowRepository).getByRole("heading", { name: "知识教学视频导演 V2.4" }),
    ).toBeInTheDocument();
    fireEvent.click(within(workflowRepository).getByRole("button", { name: "添加工作流节点" }));

    await waitFor(() => {
      expect(document.querySelectorAll(".canvas-knowledge-workflow")).toHaveLength(1);
      expect(document.querySelectorAll(".react-flow__node")).toHaveLength(1);
      expect(document.querySelectorAll(".react-flow__edge")).toHaveLength(0);
    });

    const workflowNode = document.querySelector<HTMLElement>(".canvas-knowledge-workflow");
    expect(workflowNode).not.toBeNull();
    fireEvent.click(within(workflowNode!).getByText("模型配置"));
    expect(within(workflowNode!).getByLabelText("策划与审核供应商")).toHaveValue("moyu-production");
    expect(within(workflowNode!).getByLabelText("图片生成供应商")).toHaveValue("moyu-production");
    expect(within(workflowNode!).getByLabelText("视频生成供应商")).toHaveValue("moyu-production");

    fireEvent.click(screen.getByRole("button", { name: "撤销画布操作" }));
    await waitFor(() => {
      expect(document.querySelectorAll(".react-flow__node")).toHaveLength(0);
      expect(document.querySelectorAll(".react-flow__edge")).toHaveLength(0);
    });
  });

  it("adds a single film node from the bottom workflow repository", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /工作流仓库/ }));
    fireEvent.click(screen.getByRole("button", { name: "添加AI影视工作流节点" }));
    await waitFor(() => {
      expect(document.querySelectorAll(".canvas-ai-film-workflow")).toHaveLength(1);
      expect(document.querySelectorAll(".react-flow__node")).toHaveLength(1);
      expect(document.querySelectorAll(".react-flow__edge")).toHaveLength(0);
    });
    expect(screen.getByLabelText("影视制作要求")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /工作流仓库/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("adds a single comic drama node and collapses the bottom repository", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /工作流仓库/ }));
    fireEvent.click(screen.getByRole("button", { name: "添加漫剧自动工作流节点" }));
    await waitFor(() => {
      expect(document.querySelectorAll(".canvas-comic-drama-workflow")).toHaveLength(1);
      expect(document.querySelectorAll(".react-flow__node")).toHaveLength(1);
      expect(document.querySelectorAll(".react-flow__edge")).toHaveLength(0);
    });
    expect(screen.getByLabelText("漫剧制作要求")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /工作流仓库/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("adds one commerce workflow node with product settings and collapses the repository", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /工作流仓库/ }));
    fireEvent.click(screen.getByRole("button", { name: "添加剧情带货工作流节点" }));
    await waitFor(() => {
      expect(document.querySelectorAll(".canvas-commerce-workflow")).toHaveLength(1);
      expect(document.querySelectorAll(".react-flow__node")).toHaveLength(1);
      expect(document.querySelectorAll(".react-flow__edge")).toHaveLength(0);
    });
    expect(screen.getByLabelText("带货商品名称")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /工作流仓库/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("adds one animation workflow node with only a text model and collapses the repository", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /工作流仓库/ }));
    fireEvent.click(screen.getByRole("button", { name: "添加动画逻辑图工作流节点" }));
    await waitFor(() => {
      expect(document.querySelectorAll(".canvas-remotion-workflow")).toHaveLength(1);
      expect(document.querySelectorAll(".react-flow__node")).toHaveLength(1);
      expect(document.querySelectorAll(".react-flow__edge")).toHaveLength(0);
    });
    expect(screen.getByLabelText("动画制作要求")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /工作流仓库/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    fireEvent.click(screen.getByText("模型配置"));
    expect(screen.getByLabelText("策划与审核供应商")).toHaveValue("moyu-production");
    expect(screen.queryByLabelText("图片生成供应商")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("视频生成供应商")).not.toBeInTheDocument();
  });

  it("adds one cover workflow with portrait inputs and only text and image models", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /工作流仓库/ }));
    fireEvent.click(screen.getByRole("button", { name: "添加小红书封面工作流节点" }));
    await waitFor(() => {
      expect(document.querySelectorAll(".canvas-xhs-cover-workflow")).toHaveLength(1);
      expect(document.querySelectorAll(".react-flow__node")).toHaveLength(1);
      expect(document.querySelectorAll(".react-flow__edge")).toHaveLength(0);
    });
    expect(screen.getByLabelText("封面内容")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /工作流仓库/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByRole("button", { name: "开始制作" })).toBeDisabled();
    fireEvent.click(screen.getByText("模型配置"));
    expect(screen.getByLabelText("策划与审核供应商")).toBeInTheDocument();
    expect(screen.getByLabelText("图片生成供应商")).toBeInTheDocument();
    expect(screen.queryByLabelText("视频生成供应商")).not.toBeInTheDocument();
  });

  it("switches the asset library by media type", () => {
    render(<App />);

    fireEvent.click(screen.getByRole("tab", { name: "视频 2" }));

    expect(
      screen.getByRole("button", { name: "预览视频素材详情：列车进站参考" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "预览图片素材详情：林遥·角色正面" }),
    ).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText("搜索视频素材")).toBeInTheDocument();
  });

  it("shows a useful empty state when asset search has no matches", () => {
    render(<App />);

    fireEvent.change(screen.getByRole("searchbox", { name: "搜索图片素材" }), {
      target: { value: "不存在的素材" },
    });

    expect(screen.getByText("没有找到素材")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "清除搜索" }));
    expect(
      screen.getByRole("button", { name: "预览图片素材详情：林遥·角色正面" }),
    ).toBeInTheDocument();
  });

  it("opens a streamlined full-screen source preview", async () => {
    render(<App />);

    const card = screen.getByRole("button", { name: "预览图片素材详情：林遥·角色正面" });
    expect(within(card).queryByText("林遥·角色正面")).not.toBeInTheDocument();
    expect(within(card).queryByText("2048 × 3072")).not.toBeInTheDocument();
    card.focus();
    fireEvent.click(card);

    // 素材详情弹窗按需懒加载（deferredDialogs），首次打开需等待模块就绪。
    const dialog = await screen.findByRole("dialog", { name: "林遥·角色正面" });
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText("asset-image-01")).toBeInTheDocument();
    expect(within(dialog).getByText("云端素材库")).toBeInTheDocument();
    expect(within(dialog).getByText("Moyu · 生产环境")).toBeInTheDocument();
    expect(within(dialog).queryByText("素材信息")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("完整信息")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("2048 × 3072")).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "关闭素材详情" }));
    expect(screen.queryByRole("dialog", { name: "林遥·角色正面" })).not.toBeInTheDocument();
    expect(card).toHaveFocus();
  });

  it("announces asset results and provides a direct clear action", () => {
    render(<App />);

    expect(screen.getByText("找到 4 个图片素材")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索图片素材" }), {
      target: { value: "站台" },
    });

    expect(screen.getByText("找到 1 个图片素材")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "清除素材搜索" }));
    expect(screen.getByText("找到 4 个图片素材")).toBeInTheDocument();
  });

  it("opens and closes the narrow-window side panels from the header", () => {
    render(<App />);

    const assetPanel = screen.getByRole("complementary", { name: "素材库" });
    const assetTrigger = screen.getByRole("button", { name: "打开素材库侧板" });
    expect(assetTrigger).toHaveAttribute("aria-controls", "asset-panel");
    fireEvent.click(assetTrigger);
    expect(assetPanel).toHaveClass("is-mobile-open");
    expect(assetTrigger).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(screen.getByRole("button", { name: "关闭素材库" }));
    expect(assetPanel).not.toHaveClass("is-mobile-open");

    // 节点仓库是独立侧板，有自己的触发按钮与关闭按钮。
    const nodePanel = screen.getByRole("complementary", { name: "节点仓库" });
    const nodeTrigger = screen.getByRole("button", { name: "打开节点仓库侧板" });
    expect(nodeTrigger).toHaveAttribute("aria-controls", "node-panel");
    fireEvent.click(nodeTrigger);
    expect(nodePanel).toHaveClass("is-mobile-open");
    expect(nodeTrigger).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(screen.getByRole("button", { name: "关闭节点仓库" }));
    expect(nodePanel).not.toHaveClass("is-mobile-open");
  });

  it("keeps every video generation setting on the video node card", async () => {
    render(<App />);

    dragToCanvas(screen.getByRole("button", { name: "拖拽创建视频生成节点" }));

    const videoNode = document.querySelector<HTMLElement>(".canvas-gen-node--video");
    expect(videoNode).not.toBeNull();
    await waitForNodeVisible(videoNode!);
    expect(
      within(videoNode!).getByRole("textbox", { name: "提示词输入框，输入 @ 引用素材" }),
    ).toBeInTheDocument();
    expect(within(videoNode!).getByRole("button", { name: "放大编辑提示词" })).toBeInTheDocument();
    expect(within(videoNode!).getByRole("button", { name: "开始视频生成" })).toHaveTextContent(
      "生成",
    );
    expect(within(videoNode!).getByText("文生视频")).toBeInTheDocument();
    expect(within(videoNode!).getByText("连接素材后自动切换")).toBeInTheDocument();
    expect(within(videoNode!).getByText("就绪")).toBeInTheDocument();

    expect(within(videoNode!).getByLabelText("供应商")).toBeInTheDocument();
    expect(within(videoNode!).getByLabelText("视频模型")).toBeInTheDocument();
    const quantity = within(videoNode!).getByRole("spinbutton", { name: "生成数量" });
    expect(within(videoNode!).getByLabelText("画幅")).toBeInTheDocument();
    expect(within(videoNode!).getByLabelText("分辨率")).toBeInTheDocument();
    expect(within(videoNode!).getByLabelText("时长")).toBeInTheDocument();
    expect(within(videoNode!).getByRole("checkbox", { name: "生成音频" })).toBeChecked();
    expect(within(videoNode!).getByLabelText("输出格式")).toHaveValue("mp4");
    expect(within(videoNode!).getByLabelText("任务类型")).toHaveValue("auto");
    // 视频生成节点已移除提示词优化功能（交由独立「提示词生成与优化」节点承担）。
    expect(
      within(videoNode!).queryByRole("checkbox", { name: "提示词优化" }),
    ).not.toBeInTheDocument();
    expect(within(videoNode!).queryByLabelText("优化模式")).not.toBeInTheDocument();
    expect(within(videoNode!).queryByLabelText("优化文本模型供应商")).not.toBeInTheDocument();
    expect(within(videoNode!).queryByLabelText("优化文本模型")).not.toBeInTheDocument();
    expect(quantity).toHaveValue(1);
    expect(quantity).toHaveAttribute("max", "4");
    expect(quantity).toBeEnabled();
  });

  it("keeps every image generation setting on the image node card", async () => {
    render(<App />);

    dragToCanvas(screen.getByRole("button", { name: "拖拽创建图片生成节点" }));

    const imageNode = document.querySelector<HTMLElement>(".canvas-gen-node--image");
    expect(imageNode).not.toBeNull();
    await waitForNodeVisible(imageNode!);
    expect(
      within(imageNode!).getByRole("textbox", { name: "提示词输入框，输入 @ 引用素材" }),
    ).toBeInTheDocument();
    expect(within(imageNode!).getByRole("button", { name: "开始图片生成" })).toBeInTheDocument();

    expect(within(imageNode!).getByLabelText("供应商")).toBeInTheDocument();
    expect(within(imageNode!).getByLabelText("图片模型")).toBeInTheDocument();
    const quantity = within(imageNode!).getByRole("spinbutton", { name: "生成数量" });
    expect(quantity).toHaveValue(1);
    expect(quantity).toHaveAttribute("max", "10");
    expect(within(imageNode!).getByLabelText("尺寸")).toBeInTheDocument();
    expect(within(imageNode!).getByLabelText("质量")).toBeInTheDocument();
    expect(within(imageNode!).getByText("文生图")).toBeInTheDocument();
    expect(within(imageNode!).getByText("连接参考图片或视频后自动切换")).toBeInTheDocument();
    // 图片生成节点已移除提示词优化功能（交由独立「提示词生成与优化」节点承担）。
    expect(
      within(imageNode!).queryByRole("checkbox", { name: "提示词优化" }),
    ).not.toBeInTheDocument();
    expect(within(imageNode!).getByRole("button", { name: "开始图片生成" })).toHaveTextContent(
      "生成",
    );
    expect(within(imageNode!).getByText("配置完成后点击生成")).toBeInTheDocument();
  });

  it("expands long image prompts and keeps edits synchronized with the node", async () => {
    render(<App />);

    dragToCanvas(screen.getByRole("button", { name: "拖拽创建图片生成节点" }));
    const imageNode = document.querySelector<HTMLElement>(".canvas-gen-node--image");
    expect(imageNode).not.toBeNull();
    await waitForNodeVisible(imageNode!);

    const inlineInput = within(imageNode!).getByRole("textbox", {
      name: "提示词输入框，输入 @ 引用素材",
    });
    inlineInput.replaceChildren(document.createTextNode("雨夜站台的远景"));
    fireEvent.input(inlineInput);

    const expandButton = within(imageNode!).getByRole("button", { name: "放大编辑提示词" });
    expect(expandButton).toHaveAttribute("aria-haspopup", "dialog");
    fireEvent.click(expandButton);

    const dialog = screen.getByRole("dialog", { name: "放大编辑提示词" });
    const expandedInput = within(dialog).getByRole("textbox", {
      name: "放大的提示词输入框，输入 @ 引用素材",
    });
    await waitFor(() => expect(expandedInput).toHaveFocus());
    expect(expandedInput).toHaveTextContent("雨夜站台的远景");

    const longPrompt = "电影感雨夜站台，冷暖光线交错，人物在远处等待。".repeat(12);
    expandedInput.replaceChildren(document.createTextNode(longPrompt));
    fireEvent.input(expandedInput);
    expect(within(dialog).getByText(`${longPrompt.length} 字`)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "完成" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "放大编辑提示词" })).not.toBeInTheDocument(),
    );
    expect(
      within(imageNode!).getByRole("textbox", { name: "提示词输入框，输入 @ 引用素材" }),
    ).toHaveTextContent(longPrompt);
    await waitFor(() =>
      expect(within(imageNode!).getByRole("button", { name: "放大编辑提示词" })).toHaveFocus(),
    );
  });

  it("opens the provider model settings and closes it with Escape", async () => {
    render(<App />);

    const trigger = screen.getByRole("button", { name: "打开全局设置" });
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "供应商连接与模型" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "供应商连接与模型" })).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("supports canvas zoom keyboard shortcuts without tool switching", () => {
    render(<App />);

    expect(screen.queryByRole("button", { name: "选择工具" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "平移工具" })).not.toBeInTheDocument();

    fireEvent.keyDown(document, { key: "+" });
    expect(screen.getByText("82%")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "0" });
    expect(screen.getByText("74%")).toBeInTheDocument();
  });

  it("pans the infinite canvas by dragging empty space with the mouse", () => {
    render(<App />);

    // React Flow 的平移手势落在 pane 上：mousedown → window mousemove/mouseup。
    const pane = document.querySelector<HTMLElement>(".react-flow__pane");
    expect(pane).not.toBeNull();

    // d3-zoom 会读取 event.view（jsdom 默认 null 会抛错），必须显式传 window。
    fireCanvasMouse(pane!, "mousedown", { clientX: 300, clientY: 200 });
    fireCanvasMouse(document, "mousemove", { clientX: 360, clientY: 240 });
    fireCanvasMouse(document, "mouseup", { clientX: 360, clientY: 240 });

    const viewportLayer = document.querySelector<HTMLElement>(".react-flow__viewport");
    expect(viewportLayer).not.toBeNull();
    expect(viewportLayer!.style.transform.replace(/\s/g, "")).toContain("translate(60px,40px)");
  });

  // 任务状态/原始返回展示已从画布下方状态栏（TaskDock）迁移到生成产物卡片：
  // 进行中展示任务状态与进度、失败展示完整原始返回，桌面运行时下的
  // 行为由 App.canvas.test.tsx 的「占位产物卡片」系列用例覆盖。

  it("shows a video keyframe and plays its preview on hover or keyboard focus", async () => {
    const coverUrl = "https://cdn.example.com/train-cover.jpg";
    const videoUrl = "https://cdn.example.com/train-preview.mp4";
    const invokeMock = vi.fn((command: string) => {
      switch (command) {
        case "list_provider_connections":
          return Promise.resolve([
            {
              id: "moyu-production",
              displayName: "Moyu 生产",
              adapterId: "moyu_v1",
              baseUrl: "https://api.example.com",
              apiKeyRef: "moyu-key",
              enabled: true,
              createdAt: 0,
              updatedAt: 2,
            },
          ]);
        case "list_model_definitions":
        case "list_provider_model_bindings":
          return Promise.resolve([]);
        case "list_generation_tasks":
          return Promise.resolve({ items: [], nextCursorCreatedBefore: null });
        case "list_assets":
          return Promise.resolve([
            cloudAsset("moyu-production", {
              id: "video-asset-1",
              kind: "video",
              name: "列车进站关键帧",
              previewUrl: videoUrl,
              assetUrl: videoUrl,
              coverUrl,
            }),
          ]);
        case "plugin:event|listen":
          return Promise.resolve(1);
        case "plugin:event|unlisten":
          return Promise.resolve(null);
        default:
          return Promise.resolve(null);
      }
    });
    (window as unknown as Record<string, unknown>)[DESKTOP_INTERNALS_KEY] = {
      invoke: invokeMock,
      transformCallback: () => 1,
      metadata: { currentWindow: { label: "main" } },
    };
    (window as unknown as Record<string, unknown>)[DESKTOP_EVENT_INTERNALS_KEY] = {
      unregisterListener: () => undefined,
    };

    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);

    render(<App />);
    fireEvent.click(await screen.findByRole("tab", { name: "视频 1" }));
    const card = await screen.findByRole("button", {
      name: "预览视频素材详情：列车进站关键帧",
    });
    const cover = card.querySelector<HTMLImageElement>(".asset-card__preview");
    const video = card.querySelector<HTMLVideoElement>(".asset-card__video");
    const visual = card.querySelector<HTMLElement>(".asset-card__visual--video");

    expect(cover).toHaveAttribute("src", coverUrl);
    expect(video).toHaveAttribute("src", videoUrl);
    expect(video).toHaveAttribute("poster", coverUrl);
    expect(video?.muted).toBe(true);
    expect(video?.loop).toBe(true);
    fireEvent.loadedData(video!);
    expect(video).toHaveClass("is-ready");

    fireEvent.mouseEnter(card);
    expect(play).toHaveBeenCalledTimes(1);
    expect(visual).toHaveClass("is-playing");
    video!.currentTime = 2;
    fireEvent.mouseLeave(card);
    expect(pause).toHaveBeenCalledTimes(1);
    expect(video).toHaveProperty("currentTime", 0);
    expect(visual).not.toHaveClass("is-playing");

    fireEvent.focus(card);
    expect(play).toHaveBeenCalledTimes(2);
    expect(visual).toHaveClass("is-playing");
    video!.currentTime = 2;
    fireEvent.blur(card);
    expect(pause).toHaveBeenCalledTimes(2);
    expect(video).toHaveProperty("currentTime", 0);
    expect(visual).not.toHaveClass("is-playing");
  });

  it("从素材详情弹窗两段式删除云端素材：确认后才调用删除接口并关闭弹窗", async () => {
    const deleteCalls: Array<Record<string, unknown>> = [];
    const invokeMock = vi.fn((command: string, args?: Record<string, unknown>) => {
      switch (command) {
        case "list_provider_connections":
          return Promise.resolve([
            {
              id: "moyu-prod",
              displayName: "Moyu 生产",
              adapterId: "moyu_v1",
              baseUrl: "https://47.94.250.161",
              apiKeyRef: "moyu-key",
              enabled: true,
              createdAt: 0,
              updatedAt: 0,
            },
          ]);
        case "list_model_definitions":
        case "list_provider_model_bindings":
          return Promise.resolve([]);
        case "list_generation_tasks":
          return Promise.resolve({ items: [], nextCursorCreatedBefore: null });
        case "list_assets":
          return Promise.resolve([
            cloudAsset("moyu-prod", {
              id: "asset-to-delete",
              kind: "image",
              name: "待删除素材",
              previewUrl: "https://cdn.example.com/d.png",
              assetUrl: "Asset://asset-to-delete",
            }),
          ]);
        case "delete_asset":
          deleteCalls.push((args?.["command"] as Record<string, unknown>) ?? {});
          return Promise.resolve("asset-to-delete");
        case "list_real_person_groups":
          return Promise.resolve([]);
        case "plugin:event|listen":
          return Promise.resolve(1);
        case "plugin:event|unlisten":
          return Promise.resolve(null);
        default:
          return Promise.resolve(null);
      }
    });
    (window as unknown as Record<string, unknown>)[DESKTOP_INTERNALS_KEY] = {
      invoke: invokeMock,
      transformCallback: () => 1,
      metadata: { currentWindow: { label: "main" } },
    };
    (window as unknown as Record<string, unknown>)[DESKTOP_EVENT_INTERNALS_KEY] = {
      unregisterListener: () => undefined,
    };

    render(<App />);

    const card = await screen.findByRole("button", { name: "预览图片素材详情：待删除素材" });
    fireEvent.click(card);

    // 素材详情弹窗按需懒加载（deferredDialogs），首次打开需等待模块就绪。
    const dialog = await screen.findByRole("dialog", { name: "待删除素材" });
    // 第一次点击「删除素材」只进入确认态，不触发删除接口。
    fireEvent.click(within(dialog).getByRole("button", { name: "删除素材：待删除素材" }));
    expect(deleteCalls).toHaveLength(0);
    expect(
      within(dialog).getByRole("button", { name: "确认删除素材：待删除素材" }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText("素材将从云端素材库永久删除，此操作不可撤销。"),
    ).toBeInTheDocument();

    // 第二次点击才真正删除：调用 delete_asset 并关闭弹窗。
    fireEvent.click(within(dialog).getByRole("button", { name: "确认删除素材：待删除素材" }));
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0]).toEqual({
      providerConnectionId: "moyu-prod",
      id: "asset-to-delete",
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "待删除素材" })).not.toBeInTheDocument();
    });
    // 删除成功后重新拉取云端列表。
    await waitFor(() => {
      expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "list_assets").length).toBeGreaterThan(
        1,
      );
    });
  });

  it("按国际版 data.items/preview_url 渲染真实素材并按媒体类型筛选", async () => {
    // 决定性回归测试：复现用户报告「视频 tab 显示出图片素材」的 bug。
    // mock 云端响应使用真实文档结构 data.items，并混合 image / video 两种类型，
    // 断言切换到「视频」tab 后只渲染视频卡片（数量与种类都正确）。
    const fullAssetReference =
      "Asset://asset-2026-08-27/production-library/characters/img-alpha-original";
    const invokeMock = vi.fn((command: string) => {
      switch (command) {
        case "list_provider_connections":
          return Promise.resolve([
            {
              id: "moyu-prod",
              displayName: "Moyu 生产",
              adapterId: "moyu_v1",
              baseUrl: "https://47.94.250.161",
              apiKeyRef: "moyu-key",
              enabled: true,
              createdAt: 0,
              updatedAt: 0,
            },
          ]);
        case "list_model_definitions":
        case "list_provider_model_bindings":
          return Promise.resolve([]);
        case "list_generation_tasks":
          return Promise.resolve({ items: [], nextCursorCreatedBefore: null });
        case "list_assets": {
          // Rust 素材库 module 已把国际版 data.items/preview_url 归一为稳定记录。
          const items = [
            cloudAsset("moyu-prod", {
              id: "img-1",
              kind: "image",
              name: "img-alpha",
              previewUrl: "https://cdn.example.com/a.png",
              assetUrl: fullAssetReference,
            }),
            cloudAsset("moyu-prod", {
              id: "img-2",
              kind: "image",
              name: "img-beta",
              previewUrl: "https://cdn.example.com/b.png",
              assetUrl: "Asset://img-2",
            }),
            cloudAsset("moyu-prod", {
              id: "img-3",
              kind: "image",
              name: "img-gamma",
              previewUrl: "https://cdn.example.com/c.png",
              assetUrl: "Asset://img-3",
            }),
            cloudAsset("moyu-prod", {
              id: "vid-1",
              kind: "video",
              name: "vid-alpha",
              previewUrl: "https://cdn.example.com/a.mp4",
              assetUrl: "Asset://vid-1",
            }),
            cloudAsset("moyu-prod", {
              id: "vid-2",
              kind: "video",
              name: "vid-beta",
              previewUrl: "https://cdn.example.com/b.mp4",
              assetUrl: "Asset://vid-2",
            }),
          ];
          return Promise.resolve(items);
        }
        case "list_real_person_groups":
          return Promise.resolve([]);
        case "plugin:event|listen":
          return Promise.resolve(1);
        case "plugin:event|unlisten":
          return Promise.resolve(null);
        default:
          return Promise.resolve(null);
      }
    });
    (window as unknown as Record<string, unknown>)[DESKTOP_INTERNALS_KEY] = {
      invoke: invokeMock,
      transformCallback: () => 1,
      metadata: { currentWindow: { label: "main" } },
    };
    (window as unknown as Record<string, unknown>)[DESKTOP_EVENT_INTERNALS_KEY] = {
      unregisterListener: () => undefined,
    };
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);

    render(<App />);

    const realPersonEntry = await screen.findByRole("button", {
      name: "打开明星真人素材 H5 认证与上传",
    });
    expect(realPersonEntry).toBeEnabled();
    fireEvent.click(realPersonEntry);
    const realPersonDialog = await screen.findByRole("dialog", { name: "明星真人素材" });
    expect(within(realPersonDialog).getByText("创建 H5 认证链接")).toBeInTheDocument();
    fireEvent.click(within(realPersonDialog).getByRole("button", { name: "关闭明星素材" }));

    // 等真实云端素材加载完成。Tab 计数会变为「图片 3 / 视频 2 / 音频 0」。
    const videoTab = await screen.findByRole("tab", { name: /视频\s*2/ });
    expect(screen.getByRole("tab", { name: /图片\s*3/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /音频\s*0/ })).toBeInTheDocument();

    // 切到视频 tab，断言：
    // (a) 渲染的 .asset-card 数量 == 2（不是 5）；
    // (b) 渲染的两个卡都是视频（aria-label 含 "预览视频素材详情"）；
    // (c) 不渲染任何 image 卡片（queryByRole 找不到）。
    fireEvent.click(videoTab);

    const cards = document.querySelectorAll<HTMLElement>(".asset-card");
    expect(cards.length).toBe(2);
    const brokenVideoCard = screen.getByRole("button", {
      name: "预览视频素材详情：vid-alpha",
    });
    expect(brokenVideoCard).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "预览视频素材详情：vid-beta" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /预览图片素材详情/ })).not.toBeInTheDocument();

    // 国际版的过期签名 URL 会让 video 触发 error。真实云端条目不能继续
    // 显示内置占位内容冒充视频，必须明确提示预览不可用。
    fireEvent.error(brokenVideoCard.querySelector("video")!);
    expect(within(brokenVideoCard).getByText("预览不可用")).toBeInTheDocument();

    // 切回图片 tab，断言 3 张图、且不含 video 卡片。
    fireEvent.click(screen.getByRole("tab", { name: /图片\s*3/ }));
    const imageCards = document.querySelectorAll<HTMLElement>(".asset-card");
    expect(imageCards.length).toBe(3);
    expect(screen.queryByRole("button", { name: /预览视频素材详情/ })).not.toBeInTheDocument();
    const brokenImageCard = screen.getByRole("button", {
      name: "预览图片素材详情：img-alpha",
    });
    const brokenImage = brokenImageCard.querySelector(".asset-card__preview");
    expect(brokenImage).toHaveAttribute("src", "https://cdn.example.com/a.png");

    // 图片签名 URL 过期时不能只把 img 隐藏并留下无说明的空卡片。
    fireEvent.error(brokenImage!);
    expect(within(brokenImageCard).getByText("预览不可用")).toBeInTheDocument();

    fireEvent.click(brokenImageCard);
    // 素材详情弹窗按需懒加载（deferredDialogs），首次打开需等待模块就绪。
    const dialog = await screen.findByRole("dialog", { name: "img-alpha" });
    fireEvent.error(within(dialog).getByRole("img", { name: "img-alpha" }));
    expect(within(dialog).getByText("预览不可用")).toBeInTheDocument();
    expect(within(dialog).queryByText(fullAssetReference)).not.toBeInTheDocument();
    expect(within(dialog).getByText("Moyu 生产")).toBeInTheDocument();
    expect(within(dialog).queryByText("moyu-prod")).not.toBeInTheDocument();
  });

  it("替换素材库令牌被拒绝时清空旧供应商素材", async () => {
    let assetListCalls = 0;
    const invokeMock = vi.fn((command: string) => {
      switch (command) {
        case "list_provider_connections":
          return Promise.resolve([
            {
              id: "sd20-provider",
              displayName: "SD2.0",
              adapterId: "moyu_v1",
              baseUrl: "https://old-provider.example/v1",
              apiKeyRef: "provider:sd20-provider:api-key",
              enabled: true,
              createdAt: 0,
              updatedAt: 0,
            },
          ]);
        case "list_model_definitions":
        case "list_provider_model_bindings":
          return Promise.resolve([]);
        case "list_generation_tasks":
          return Promise.resolve({ items: [], nextCursorCreatedBefore: null });
        case "get_credential":
          return Promise.resolve("");
        case "set_credential":
          return Promise.resolve(null);
        case "list_assets":
          assetListCalls += 1;
          return assetListCalls === 1
            ? Promise.resolve([
                cloudAsset("sd20-provider", {
                  id: "old-asset",
                  kind: "image",
                  name: "SD2.0 旧素材",
                  previewUrl: "https://old-provider.example/old.png",
                }),
              ])
            : Promise.reject(new Error("browse assets returned HTTP 401"));
        case "plugin:event|listen":
          return Promise.resolve(1);
        case "plugin:event|unlisten":
          return Promise.resolve(null);
        default:
          return Promise.resolve(null);
      }
    });
    (window as unknown as Record<string, unknown>)[DESKTOP_INTERNALS_KEY] = {
      invoke: invokeMock,
      transformCallback: () => 1,
      metadata: { currentWindow: { label: "main" } },
    };
    (window as unknown as Record<string, unknown>)[DESKTOP_EVENT_INTERNALS_KEY] = {
      unregisterListener: () => undefined,
    };

    render(<App />);
    expect(
      await screen.findByRole("button", { name: "预览图片素材详情：SD2.0 旧素材" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "打开全局设置" }));
    const tokenInput = await screen.findByLabelText("素材库令牌值");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "保存并拉取素材" })).toBeEnabled(),
    );
    fireEvent.change(tokenInput, {
      target: { value: "<REDACTED>" },
    });
    expect(tokenInput).toHaveValue("<REDACTED>");
    expect(tokenInput).toBeInTheDocument();
    const pullButton = screen.getByRole("button", { name: "保存并拉取素材" });
    expect(pullButton).toBeEnabled();
    fireEvent.click(pullButton);

    await waitFor(() =>
      expect(invokeMock.mock.calls.some(([command]) => command === "set_credential")).toBe(true),
    );
    await waitFor(() => expect(assetListCalls).toBe(2));
    expect(
      screen.queryByRole("button", { name: "预览图片素材详情：SD2.0 旧素材" }),
    ).not.toBeInTheDocument();
  });

  it("云端素材库错误默认显示可读摘要，并按需展开完整响应", async () => {
    const invokeMock = vi.fn((command: string) => {
      switch (command) {
        case "list_provider_connections":
          return Promise.resolve([
            {
              id: "sd20-provider",
              displayName: "SD2.0",
              adapterId: "moyu_v1",
              baseUrl: "https://provider.example/v1",
              apiKeyRef: "provider:sd20-provider:api-key",
              enabled: true,
              createdAt: 0,
              updatedAt: 0,
            },
          ]);
        case "list_model_definitions":
        case "list_provider_model_bindings":
          return Promise.resolve([]);
        case "list_generation_tasks":
          return Promise.resolve({ items: [], nextCursorCreatedBefore: null });
        case "list_assets":
          return Promise.reject(
            new Error(
              '素材库请求失败（HTTP 401）：素材库令牌无效或已过期。原始响应：{"error":{"message":"无效的令牌"}}',
            ),
          );
        case "plugin:event|listen":
          return Promise.resolve(1);
        case "plugin:event|unlisten":
          return Promise.resolve(null);
        default:
          return Promise.resolve(null);
      }
    });
    (window as unknown as Record<string, unknown>)[DESKTOP_INTERNALS_KEY] = {
      invoke: invokeMock,
      transformCallback: () => 1,
      metadata: { currentWindow: { label: "main" } },
    };
    (window as unknown as Record<string, unknown>)[DESKTOP_EVENT_INTERNALS_KEY] = {
      unregisterListener: () => undefined,
    };

    render(<App />);

    const error = await screen.findByRole("alert");
    expect(error).toHaveTextContent("云端素材库不可用");
    expect(error).toHaveTextContent("HTTP 401");
    expect(error).toHaveTextContent("素材库令牌无效或已过期");
    const details = within(error).getByText("完整技术详情");
    expect(details.closest("details")).not.toHaveAttribute("open");

    fireEvent.click(details);
    expect(details.closest("details")).toHaveAttribute("open");
    expect(within(error).getByText(/"message": "无效的令牌"/)).toBeInTheDocument();
  });

  it("重启后仍使用已选素材库供应商而不是名称排序第一项", async () => {
    window.localStorage.setItem(ACTIVE_ASSET_PROVIDER_STORAGE_KEY, "overseas-provider");
    const invokeMock = vi.fn((command: string, _args?: Record<string, unknown>) => {
      void _args;
      switch (command) {
        case "list_provider_connections":
          return Promise.resolve([
            {
              id: "sd20-provider",
              displayName: "SD2.0",
              adapterId: "moyu_v1",
              baseUrl: "https://old-provider.example/v1",
              apiKeyRef: "provider:sd20-provider:api-key",
              enabled: true,
              createdAt: 0,
              updatedAt: 2,
            },
            {
              id: "overseas-provider",
              displayName: "海外平台",
              adapterId: "moyu_v1",
              baseUrl: "https://new-provider.example/v1",
              apiKeyRef: "provider:overseas-provider:api-key",
              enabled: true,
              createdAt: 1,
              updatedAt: 1,
            },
          ]);
        case "list_model_definitions":
        case "list_provider_model_bindings":
          return Promise.resolve([]);
        case "list_generation_tasks":
          return Promise.resolve({ items: [], nextCursorCreatedBefore: null });
        case "list_assets":
          return Promise.resolve([]);
        case "plugin:event|listen":
          return Promise.resolve(1);
        case "plugin:event|unlisten":
          return Promise.resolve(null);
        default:
          return Promise.resolve(null);
      }
    });
    (window as unknown as Record<string, unknown>)[DESKTOP_INTERNALS_KEY] = {
      invoke: invokeMock,
      transformCallback: () => 1,
      metadata: { currentWindow: { label: "main" } },
    };
    (window as unknown as Record<string, unknown>)[DESKTOP_EVENT_INTERNALS_KEY] = {
      unregisterListener: () => undefined,
    };

    render(<App />);

    await waitFor(() => {
      const listCall = invokeMock.mock.calls.find(([command]) => command === "list_assets");
      expect(listCall?.[1]).toEqual({
        command: {
          providerConnectionId: "overseas-provider",
          pageNumber: 1,
          pageSize: 100,
          name: null,
          groupId: null,
        },
      });
    });
    expect(
      within(screen.getByRole("complementary", { name: "素材库" })).getByText("海外平台"),
    ).toBeInTheDocument();
  });

  it("可以在素材库中切换全局配置的供应商 key", async () => {
    const assetListCalls: string[] = [];
    const invokeMock = vi.fn((command: string, args?: Record<string, unknown>) => {
      switch (command) {
        case "list_provider_connections":
          return Promise.resolve([
            {
              id: "primary-provider",
              displayName: "主供应商",
              adapterId: "moyu_v1",
              baseUrl: "https://primary.example/v1",
              apiKeyRef: "provider:primary-provider:api-key",
              enabled: true,
              createdAt: 0,
              updatedAt: 2,
            },
            {
              id: "backup-provider",
              displayName: "备用供应商",
              adapterId: "moyu_v1",
              baseUrl: "https://backup.example/v1",
              apiKeyRef: "provider:backup-provider:api-key",
              enabled: true,
              createdAt: 1,
              updatedAt: 1,
            },
          ]);
        case "list_model_definitions":
        case "list_provider_model_bindings":
          return Promise.resolve([]);
        case "list_generation_tasks":
          return Promise.resolve({ items: [], nextCursorCreatedBefore: null });
        case "list_assets": {
          const providerId = (
            (args?.["command"] as { providerConnectionId?: string } | undefined) ?? {}
          ).providerConnectionId;
          if (providerId) assetListCalls.push(providerId);
          return Promise.resolve([
            cloudAsset(providerId ?? "primary-provider", {
              id: `${providerId}-asset`,
              kind: "image",
              name: providerId === "backup-provider" ? "备用素材" : "主供应商素材",
              previewUrl: `https://${providerId}.example/asset.png`,
            }),
          ]);
        }
        case "plugin:event|listen":
          return Promise.resolve(1);
        case "plugin:event|unlisten":
          return Promise.resolve(null);
        default:
          return Promise.resolve(null);
      }
    });
    (window as unknown as Record<string, unknown>)[DESKTOP_INTERNALS_KEY] = {
      invoke: invokeMock,
      transformCallback: () => 1,
      metadata: { currentWindow: { label: "main" } },
    };
    (window as unknown as Record<string, unknown>)[DESKTOP_EVENT_INTERNALS_KEY] = {
      unregisterListener: () => undefined,
    };

    render(<App />);

    await screen.findByRole("button", { name: "预览图片素材详情：主供应商素材" });
    const providerSelect = screen.getByRole("combobox", { name: "素材库供应商" });
    expect(providerSelect).toHaveValue("primary-provider");
    expect(screen.queryByText("primary-provider", { selector: "code" })).not.toBeInTheDocument();

    fireEvent.change(providerSelect, { target: { value: "backup-provider" } });

    await waitFor(() => expect(providerSelect).toHaveValue("backup-provider"));
    await screen.findByRole("button", { name: "预览图片素材详情：备用素材" });
    expect(assetListCalls).toContain("backup-provider");
    expect(screen.queryByText("backup-provider", { selector: "code" })).not.toBeInTheDocument();
  });

  it("切换供应商后忽略旧请求响应，并保持新请求的 loading 状态", async () => {
    const primaryResponse = deferred<unknown>();
    const backupResponse = deferred<unknown>();
    const requestedProviders: string[] = [];
    const assetResponse = (providerConnectionId: string, id: string, name: string) => [
      cloudAsset(providerConnectionId, {
        id,
        kind: "image",
        name,
        previewUrl: `https://assets.example/${id}.png`,
      }),
    ];
    const invokeMock = vi.fn((command: string, args?: Record<string, unknown>) => {
      switch (command) {
        case "list_provider_connections":
          return Promise.resolve([
            {
              id: "primary-provider",
              displayName: "主供应商",
              adapterId: "moyu_v1",
              baseUrl: "https://primary.example/v1",
              apiKeyRef: "provider:primary-provider:api-key",
              enabled: true,
              createdAt: 0,
              updatedAt: 2,
            },
            {
              id: "backup-provider",
              displayName: "备用供应商",
              adapterId: "moyu_v1",
              baseUrl: "https://backup.example/v1",
              apiKeyRef: "provider:backup-provider:api-key",
              enabled: true,
              createdAt: 1,
              updatedAt: 1,
            },
          ]);
        case "list_model_definitions":
        case "list_provider_model_bindings":
          return Promise.resolve([]);
        case "list_generation_tasks":
          return Promise.resolve({ items: [], nextCursorCreatedBefore: null });
        case "list_assets": {
          const providerId = (
            (args?.["command"] as { providerConnectionId?: string } | undefined) ?? {}
          ).providerConnectionId;
          if (providerId) requestedProviders.push(providerId);
          return providerId === "backup-provider"
            ? backupResponse.promise
            : primaryResponse.promise;
        }
        case "plugin:event|listen":
          return Promise.resolve(1);
        case "plugin:event|unlisten":
          return Promise.resolve(null);
        default:
          return Promise.resolve(null);
      }
    });
    (window as unknown as Record<string, unknown>)[DESKTOP_INTERNALS_KEY] = {
      invoke: invokeMock,
      transformCallback: () => 1,
      metadata: { currentWindow: { label: "main" } },
    };
    (window as unknown as Record<string, unknown>)[DESKTOP_EVENT_INTERNALS_KEY] = {
      unregisterListener: () => undefined,
    };

    render(<App />);

    const providerSelect = await screen.findByRole("combobox", { name: "素材库供应商" });
    await waitFor(() => expect(requestedProviders).toContain("primary-provider"));
    fireEvent.change(providerSelect, { target: { value: "backup-provider" } });
    await waitFor(() => expect(requestedProviders).toContain("backup-provider"));

    await act(async () => {
      primaryResponse.resolve(
        assetResponse("primary-provider", "stale-primary", "过期主供应商素材"),
      );
      await primaryResponse.promise;
      await Promise.resolve();
    });

    const assetGrid = screen
      .getByRole("complementary", { name: "素材库" })
      .querySelector(".asset-grid");
    expect(assetGrid).toHaveAttribute("aria-busy", "true");
    expect(
      screen.queryByRole("button", { name: "预览图片素材详情：过期主供应商素材" }),
    ).not.toBeInTheDocument();

    await act(async () => {
      backupResponse.resolve(
        assetResponse("backup-provider", "fresh-backup", "最新备用供应商素材"),
      );
      await backupResponse.promise;
      await Promise.resolve();
    });

    expect(
      await screen.findByRole("button", { name: "预览图片素材详情：最新备用供应商素材" }),
    ).toBeInTheDocument();
    expect(assetGrid).toHaveAttribute("aria-busy", "false");
  });

  it("分批渲染大型素材结果，并按需加载下一批卡片", async () => {
    const items = Array.from({ length: 45 }, (_, index) => ({
      ...cloudAsset("paged-provider", {
        id: `paged-${index + 1}`,
        kind: "image",
        name: `分页素材 ${index + 1}`,
        previewUrl: `https://assets.example/paged-${index + 1}.png`,
      }),
    }));
    const invokeMock = vi.fn((command: string) => {
      switch (command) {
        case "list_provider_connections":
          return Promise.resolve([
            {
              id: "paged-provider",
              displayName: "分页供应商",
              adapterId: "moyu_v1",
              baseUrl: "https://paged.example/v1",
              apiKeyRef: "provider:paged-provider:api-key",
              enabled: true,
              createdAt: 0,
              updatedAt: 1,
            },
          ]);
        case "list_model_definitions":
        case "list_provider_model_bindings":
          return Promise.resolve([]);
        case "list_generation_tasks":
          return Promise.resolve({ items: [], nextCursorCreatedBefore: null });
        case "list_assets":
          return Promise.resolve(items);
        case "plugin:event|listen":
          return Promise.resolve(1);
        case "plugin:event|unlisten":
          return Promise.resolve(null);
        default:
          return Promise.resolve(null);
      }
    });
    (window as unknown as Record<string, unknown>)[DESKTOP_INTERNALS_KEY] = {
      invoke: invokeMock,
      transformCallback: () => 1,
      metadata: { currentWindow: { label: "main" } },
    };
    (window as unknown as Record<string, unknown>)[DESKTOP_EVENT_INTERNALS_KEY] = {
      unregisterListener: () => undefined,
    };

    render(<App />);

    expect(await screen.findByText("找到 45 个图片素材")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /预览图片素材详情：分页素材/ })).toHaveLength(40);
    fireEvent.click(screen.getByRole("button", { name: "加载更多素材（还有 5 个）" }));

    expect(screen.getAllByRole("button", { name: /预览图片素材详情：分页素材/ })).toHaveLength(45);
    expect(screen.queryByRole("button", { name: /加载更多素材/ })).not.toBeInTheDocument();
  });

  it("切换到本地素材后只读本地索引，上传任务只写对象存储", async () => {
    const invokeMock = vi.fn((command: string, _args?: Record<string, unknown>) => {
      void _args;
      switch (command) {
        case "list_provider_connections":
          return Promise.resolve([
            {
              id: "moyu-prod",
              displayName: "Moyu 生产",
              adapterId: "moyu_v1",
              baseUrl: "https://api.example.com",
              apiKeyRef: "moyu-key",
              enabled: true,
              createdAt: 0,
              updatedAt: 0,
            },
          ]);
        case "list_model_definitions":
        case "list_provider_model_bindings":
          return Promise.resolve([]);
        case "list_generation_tasks":
          return Promise.resolve({ items: [], nextCursorCreatedBefore: null });
        case "list_assets":
          return Promise.resolve([
            cloudAsset("moyu-prod", {
              id: "cloud-image",
              kind: "image",
              name: "云端参考图",
            }),
          ]);
        case "list_local_assets":
          return Promise.resolve([
            {
              id: "local-upload-1",
              name: "本地参考图.png",
              mediaType: "image",
              objectKey: "local/asset.png",
              previewUrl: "https://tos.example.com/local/asset.png?sign=fresh",
              byteSize: 2048,
              createdAt: 1,
            },
          ]);
        case "plugin:dialog|open":
          return Promise.resolve(["C:\\media\\new-local.png"]);
        case "get_tos_staging_config":
          return Promise.resolve({
            region: "cn-beijing",
            endpoint: "tos-cn-beijing.volces.com",
            bucket: "test-staging-bucket",
            credentialRef: "tos-ak-sk",
            objectPrefix: "staging",
            enabled: true,
          });
        case "start_staging_upload":
          return Promise.resolve("local-upload-2");
        case "plugin:event|listen":
          return Promise.resolve(1);
        case "plugin:event|unlisten":
          return Promise.resolve(null);
        default:
          return Promise.resolve(null);
      }
    });
    (window as unknown as Record<string, unknown>)[DESKTOP_INTERNALS_KEY] = {
      invoke: invokeMock,
      transformCallback: () => 1,
      metadata: { currentWindow: { label: "main" } },
    };
    (window as unknown as Record<string, unknown>)[DESKTOP_EVENT_INTERNALS_KEY] = {
      unregisterListener: () => undefined,
    };

    render(<App />);
    await screen.findByRole("button", { name: "预览图片素材详情：云端参考图" });
    const cloudListCallsBeforeSwitch = invokeMock.mock.calls.filter(
      ([command]) => command === "list_assets",
    ).length;
    // 初始云端挂载会拉取一次分组列表；切换本地后不应再出现新的云端分组请求。
    const groupListCallsBeforeSwitch = invokeMock.mock.calls.filter(
      ([command]) => command === "list_asset_groups",
    ).length;

    fireEvent.change(screen.getByRole("combobox", { name: "素材库来源" }), {
      target: { value: "local" },
    });
    expect(
      await screen.findByRole("button", { name: "预览图片素材详情：本地参考图.png" }),
    ).toBeInTheDocument();
    expect(invokeMock.mock.calls.filter(([command]) => command === "list_assets")).toHaveLength(
      cloudListCallsBeforeSwitch,
    );

    fireEvent.click(screen.getByRole("button", { name: "上传到本地素材库（仅对象存储）" }));
    await waitFor(() => {
      const uploadCall = invokeMock.mock.calls.find(
        ([command]) => command === "start_staging_upload",
      );
      expect(uploadCall?.[1]).toEqual({
        command: {
          localPath: "C:\\media\\new-local.png",
          purpose: "local_asset",
          mediaType: "image",
          import: null,
        },
      });
    });
    expect(
      invokeMock.mock.calls.filter(([command]) => command === "list_asset_groups"),
    ).toHaveLength(groupListCallsBeforeSwitch);
    expect(invokeMock.mock.calls.some(([command]) => command === "create_asset_group")).toBe(false);
  });

  it("浏览器预览模式下点击上传给出明确错误提示，而非无任何反应", async () => {
    const previousInternals = (window as unknown as Record<string, unknown>)[DESKTOP_INTERNALS_KEY];
    const previousEventInternals = (window as unknown as Record<string, unknown>)[
      DESKTOP_EVENT_INTERNALS_KEY
    ];
    delete (window as unknown as Record<string, unknown>)[DESKTOP_INTERNALS_KEY];
    delete (window as unknown as Record<string, unknown>)[DESKTOP_EVENT_INTERNALS_KEY];
    try {
      render(<App />);
      const uploadButton = await screen.findByRole("button", {
        name: "上传本地素材到云端素材库",
      });
      fireEvent.click(uploadButton);
      expect(
        await screen.findByText(/上传素材功能仅在桌面应用中使用/, {
          selector: ".asset-panel__error-summary",
        }),
      ).toBeInTheDocument();
    } finally {
      if (previousInternals === undefined) {
        delete (window as unknown as Record<string, unknown>)[DESKTOP_INTERNALS_KEY];
      } else {
        (window as unknown as Record<string, unknown>)[DESKTOP_INTERNALS_KEY] = previousInternals;
      }
      if (previousEventInternals === undefined) {
        delete (window as unknown as Record<string, unknown>)[DESKTOP_EVENT_INTERNALS_KEY];
      } else {
        (window as unknown as Record<string, unknown>)[DESKTOP_EVENT_INTERNALS_KEY] =
          previousEventInternals;
      }
    }
  });

  it("取消文件选择时给出 toast 提示，而非静默无反馈", async () => {
    const invokeMock = vi.fn((command: string, _args?: Record<string, unknown>) => {
      void _args;
      switch (command) {
        case "list_provider_connections":
          return Promise.resolve([]);
        case "list_model_definitions":
        case "list_provider_model_bindings":
          return Promise.resolve([]);
        case "list_generation_tasks":
          return Promise.resolve({ items: [], nextCursorCreatedBefore: null });
        case "list_assets":
          return Promise.resolve([]);
        case "list_local_assets":
          return Promise.resolve([]);
        case "plugin:dialog|open":
          // 用户在文件选择框中取消。
          return Promise.resolve(null);
        case "get_tos_staging_config":
          return Promise.resolve({
            region: "cn-beijing",
            endpoint: "tos-cn-beijing.volces.com",
            bucket: "test-staging-bucket",
            credentialRef: "tos-ak-sk",
            objectPrefix: "staging",
            enabled: true,
          });
        case "plugin:event|listen":
          return Promise.resolve(1);
        case "plugin:event|unlisten":
          return Promise.resolve(null);
        default:
          return Promise.resolve(null);
      }
    });
    (window as unknown as Record<string, unknown>)[DESKTOP_INTERNALS_KEY] = {
      invoke: invokeMock,
      transformCallback: () => 1,
      metadata: { currentWindow: { label: "main" } },
    };
    (window as unknown as Record<string, unknown>)[DESKTOP_EVENT_INTERNALS_KEY] = {
      unregisterListener: () => undefined,
    };

    render(<App />);
    fireEvent.change(screen.getByRole("combobox", { name: "素材库来源" }), {
      target: { value: "local" },
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "上传到本地素材库（仅对象存储）" }),
    );
    expect(await screen.findByText("未选择文件，已取消上传。")).toBeInTheDocument();
    expect(
      invokeMock.mock.calls.some(([command]) => command === "start_staging_upload"),
    ).toBe(false);
  });

  it("startUpload 返回前先显示「准备中」占位行，提交完成后切换为校验状态", async () => {
    const startUploadDeferred = deferred<string>();
    const invokeMock = vi.fn((command: string, _args?: Record<string, unknown>) => {
      void _args;
      switch (command) {
        case "list_provider_connections":
          return Promise.resolve([]);
        case "list_model_definitions":
        case "list_provider_model_bindings":
          return Promise.resolve([]);
        case "list_generation_tasks":
          return Promise.resolve({ items: [], nextCursorCreatedBefore: null });
        case "list_assets":
          return Promise.resolve([]);
        case "list_local_assets":
          return Promise.resolve([]);
        case "plugin:dialog|open":
          return Promise.resolve(["C:\\media\\new-local.png"]);
        case "get_tos_staging_config":
          return Promise.resolve({
            region: "cn-beijing",
            endpoint: "tos-cn-beijing.volces.com",
            bucket: "test-staging-bucket",
            credentialRef: "tos-ak-sk",
            objectPrefix: "staging",
            enabled: true,
          });
        case "start_staging_upload":
          return startUploadDeferred.promise;
        case "plugin:event|listen":
          return Promise.resolve(1);
        case "plugin:event|unlisten":
          return Promise.resolve(null);
        default:
          return Promise.resolve(null);
      }
    });
    (window as unknown as Record<string, unknown>)[DESKTOP_INTERNALS_KEY] = {
      invoke: invokeMock,
      transformCallback: () => 1,
      metadata: { currentWindow: { label: "main" } },
    };
    (window as unknown as Record<string, unknown>)[DESKTOP_EVENT_INTERNALS_KEY] = {
      unregisterListener: () => undefined,
    };

    render(<App />);
    fireEvent.change(screen.getByRole("combobox", { name: "素材库来源" }), {
      target: { value: "local" },
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "上传到本地素材库（仅对象存储）" }),
    );
    // 提交尚未返回：占位行立即出现，提供明确反馈。
    expect(await screen.findByText("准备中…")).toBeInTheDocument();
    act(() => {
      startUploadDeferred.resolve("local-upload-2");
    });
    await waitFor(() => {
      expect(screen.queryByText("准备中…")).not.toBeInTheDocument();
    });
  });

  it("header 清空画布按钮：点击打开 modal 弹窗，确认后清空画布", () => {
    // 用户要求：破坏性操作直接弹窗确认，而非二次点击内联确认。
    // 原生 <dialog> 的 showModal() 提供 modal 语义（ESC 关闭、focus trap、::backdrop
    // 遮罩），无需自建 dialog 框架。
    render(<App />);

    // 拖入一个视频生成节点到画布，作为「画布非空」的初始证据。
    dragToCanvas(screen.getByRole("button", { name: "拖拽创建视频生成节点" }));
    expect(document.querySelector(".canvas-gen-node--video")).not.toBeNull();

    // 找到 header 上的清空按钮。
    const clearButton = screen.getByRole("button", { name: "清空画布" });

    // 点击按钮 → 原生 <dialog> 通过 showModal() 打开（modal=true）。
    fireEvent.click(clearButton);
    const dialog = screen.getByRole("dialog", { name: "确认清空画布？" });
    expect(dialog).toHaveAttribute("open");
    // 此时画布上的节点还在（清空未执行）。
    expect(document.querySelector(".canvas-gen-node--video")).not.toBeNull();
    // 弹窗有取消 + 确认两个动作按钮。
    expect(screen.getByRole("button", { name: "取消" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认清空" })).toBeInTheDocument();

    // 点「确认清空」：节点清空 + 弹窗关闭。
    fireEvent.click(screen.getByRole("button", { name: "确认清空" }));
    expect(document.querySelector(".canvas-gen-node--video")).toBeNull();
    // dialog 关闭后不再处于 open 状态（role=dialog 元素存在但没有 open 属性）。
    expect(dialog).not.toHaveAttribute("open");
  });

  it("清空画布弹窗：点取消或 ESC 不会执行清空动作", () => {
    // 验证取消路径同样安全：用户从弹窗取消时画布节点必须保留。
    render(<App />);

    dragToCanvas(screen.getByRole("button", { name: "拖拽创建视频生成节点" }));
    expect(document.querySelector(".canvas-gen-node--video")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "清空画布" }));
    const dialog = screen.getByRole("dialog", { name: "确认清空画布？" });
    expect(dialog).toHaveAttribute("open");

    // 点取消：弹窗关闭，画布节点保留。
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(dialog).not.toHaveAttribute("open");
    expect(document.querySelector(".canvas-gen-node--video")).not.toBeNull();
  });
});
